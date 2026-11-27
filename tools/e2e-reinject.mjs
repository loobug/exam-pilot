/**
 * 扩展更新后自动接管：不需要用户按 F5
 *   node tools/e2e-reinject.mjs
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findBrowser } from './find-browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const CHROME = findBrowser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

let page_html = '<html><body><div class="qtext">第 1 题 以下哪个是传输层协议？</div><div class="option">A. TCP</div><div class="option">B. IP</div></body></html>';
const web = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page_html);
});
await new Promise(r => web.listen(8893, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await swT.worker();

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8893/', { waitUntil: 'domcontentloaded' });
  await sleep(900);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8893')) || {}).id;
  });

  /* 1) 正常注入：booted 标记等于当前版本 */
  const v1 = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => ({ booted: globalThis.__EXA_BOOTED__, hasDebug: !!globalThis.__EXA_DEBUG__, hasDestroy: typeof globalThis.__EXA_DESTROY__ })
    });
    return r[0].result;
  }, tabId);
  const mine = await worker.evaluate(() => chrome.runtime.getManifest().version);
  console.log('初始:', JSON.stringify(v1), '扩展版本', mine);
  check('内容脚本已注入且带版本号', v1.booted === mine, `${v1.booted} vs ${mine}`);
  check('暴露了销毁钩子（便于接管）', v1.hasDestroy === 'function', v1.hasDestroy);

  /* 2) 模拟"旧版本脚本残留在页面里"：改版本号 + 挂一个假销毁钩子 */
  await worker.evaluate(async tid => {
    await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => {
        globalThis.__EXA_BOOTED__ = '0.0.1-old';
        globalThis.__DESTROY_CALLED__ = false;
        const prev = globalThis.__EXA_DESTROY__;
        globalThis.__EXA_DESTROY__ = () => { globalThis.__DESTROY_CALLED__ = true; try { prev && prev(); } catch (e) { } };
      }
    });
  }, tabId);

  const stale = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({ target: { tabId: tid }, func: () => globalThis.__EXA_BOOTED__ });
    return r[0].result;
  }, tabId);
  check('已模拟出"旧版本"状态', stale === '0.0.1-old', String(stale));

  /* 3) 触发重注入：应接管为当前版本，且旧实例被销毁 */
  const invoked = await worker.evaluate(async () => {
    if (typeof self.__exaReinjectAll !== 'function') return { error: 'no hook' };
    return await self.__exaReinjectAll('测试');
  });
  console.log('重注入:', JSON.stringify(invoked));
  await sleep(1500);

  const v2 = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => ({
        booted: globalThis.__EXA_BOOTED__,
        destroyed: globalThis.__DESTROY_CALLED__ === true,
        hasDebug: !!globalThis.__EXA_DEBUG__,
        canExtract: (() => { try { return globalThis.__EXA_DEBUG__.extract(); } catch (e) { return 'ERR:' + e.message; } })()
      })
    });
    return r[0].result;
  }, tabId);
  console.log('接管后:', JSON.stringify({ booted: v2.booted, destroyed: v2.destroyed, hasDebug: v2.hasDebug }));

  check('新版本已接管页面', v2.booted === mine, `${v2.booted} vs ${mine}`);
  check('旧实例被销毁（没有双份定时器）', v2.destroyed === true, String(v2.destroyed));
  check('接管后解题能力可用', v2.hasDebug === true, String(v2.hasDebug));

  /* 4) 接管后能真的识别题目 */
  const extract = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        const list = await globalThis.__EXA_DEBUG__.extract();
        return { n: list.length, q: list[0] && String(list[0].stem).slice(0, 30) };
      }
    });
    return r[0].result;
  }, tabId);
  console.log('识别:', JSON.stringify(extract));
  check('接管后能识别到题目', extract.n > 0, JSON.stringify(extract));

  /* 5) 全量重注入接口可用 */
  const all = await worker.evaluate(async () => {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'reinject-all' });
      return r;
    } catch (e) { return { error: String(e && e.message || e) }; }
  });
  console.log('reinject-all:', JSON.stringify(all));

} catch (e) {
  check('运行未抛异常', false, e && e.message);
  console.error(e);
} finally {
  await browser.close();
  web.close();
  const bad = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
  process.exitCode = bad.length ? 1 : 0;
}
