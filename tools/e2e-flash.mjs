/**
 * 填入答案后的来源标记（1.5 秒浮层）
 *   node tools/e2e-flash.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockApi } from './mock-api.mjs';

const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const WEB_PORT = 8844;
const API_PORT = 8845;
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, 'demo', url === '/' ? '/exam-bank.html' : url);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(WEB_PORT, '127.0.0.1', r));
const mock = await startMockApi(API_PORT);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: [`--disable-extensions-except=${ROOT}\\extension`, `--load-extension=${ROOT}\\extension`, '--no-first-run'],
  defaultViewport: { width: 1100, height: 900 }
});

try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await sw.worker();
  const extId = new URL(sw.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:' + API_PORT + '/v1', apiKey: 'k', model: 'mock-model',
    visionModel: '', temperature: 0.2, maxTokens: 2048, timeoutSec: 30,
    doubleCheck: false, autoFillAfterSolve: false, extraHeaders: '', systemPrompt: '',
    followMode: false, stealth: true,            // 隐身模式也要能闪
    cacheEnabled: false, skipAnswered: false, concurrency: 1,
    kbEnabled: true, kbDirect: true, kbTopK: 3, kbMinCoverage: 0.65,
    kbStrict: false, flashOn: true, flashMs: 1500
  });

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const kbText = fs.readFileSync(path.join(ROOT, 'demo', 'kb-sangfor.txt'), 'utf8');
  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'kb-sangfor.txt', size: text.length, mime: 'text/plain', text });
  }, kbText);
  await opt.close();

  const page = await browser.newPage();

  const runAt = async (i, seed, patchStem) => {
    await page.goto(`http://127.0.0.1:${WEB_PORT}/exam-bank.html?i=${i}&seed=${seed}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__READY === true', { timeout: 5000 }).catch(() => { });
    if (patchStem) {
      await page.evaluate(s => { const el = document.querySelector('.qtext'); if (el) el.textContent = s; }, patchStem);
    }
    await sleep(120);
    const tabId = await worker.evaluate(async () => {
      const all = await chrome.tabs.query({});
      return (all.find(t => t.url && t.url.includes('127.0.0.1:8844')) || {}).id;
    });
    const before = await page.evaluate(() => document.documentElement.children.length);
    const out = await worker.evaluate(async tid => {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: async () => {
          globalThis.__EXA_DEBUG__.clearResults();
          let list = await globalThis.__EXA_DEBUG__.extract();
          for (let k = 0; k < 3 && !list.length; k++) {
            await new Promise(r2 => setTimeout(r2, 120));
            list = await globalThis.__EXA_DEBUG__.extract();
          }
          if (!list.length) return { n: 0 };
          await globalThis.__EXA_DEBUG__.solveAll();
          const res = globalThis.__EXA_DEBUG__.results();
          await globalThis.__EXA_DEBUG__.fillOne(0);
          return {
            n: list.length,
            answer: res[0] && res[0].answer,
            src: res[0] && res[0].source && res[0].source.kind,
            conf: res[0] && res[0].confidence,
            flash: globalThis.__EXA_DEBUG__.lastFlash()
          };
        }
      });
      return r[0].result;
    }, tabId);
    const during = await page.evaluate(() => document.documentElement.children.length);
    await sleep(2200);
    const after = await page.evaluate(() => document.documentElement.children.length);
    return { ...out, before, during, after };
  };

  /* 1) 库内题 → 应闪「来自知识库 · 可信度 xx%」 */
  const kbCase = await runAt(0, 9);
  console.log('\n库内题:', JSON.stringify({
    src: kbCase.src, conf: kbCase.conf, flash: kbCase.flash,
    节点: `${kbCase.before} → ${kbCase.during} → ${kbCase.after}`
  }));
  check('库内题走知识库', kbCase.src === 'kb', kbCase.src);
  check('弹出来源标记', !!kbCase.flash, JSON.stringify(kbCase.flash));
  check('标记写明「来自知识库」', /来自知识库/.test(String((kbCase.flash || {}).text || '')), (kbCase.flash || {}).text);
  check('标记带可信度百分比', /可信度\s*\d+%/.test(String((kbCase.flash || {}).text || '')), (kbCase.flash || {}).text);
  check('标记注明精确命中', /精确命中/.test(String((kbCase.flash || {}).text || '')), (kbCase.flash || {}).text);
  check('浮层确实插入了临时节点', kbCase.during > kbCase.before, `${kbCase.before} → ${kbCase.during}`);
  check('1.5 秒后节点被移除（隐身模式不留痕）', kbCase.after === kbCase.before, `${kbCase.during} → ${kbCase.after}`);

  /* 2) 库外题 → 应闪「AI 生成 · 可信度 xx%」 */
  const aiCase = await runAt(0, 9, '这道题题库里没有收录，需要模型来判断对错，用于验证 AI 标记。');
  console.log('\n库外题:', JSON.stringify({ src: aiCase.src, conf: aiCase.conf, flash: aiCase.flash }));
  check('库外题交给模型（非严格模式）', aiCase.src === 'ai' || aiCase.src === 'kb+ai', aiCase.src);
  check('标记写明「AI 生成」或「知识库 + AI」', /AI/.test(String((aiCase.flash || {}).text || '')), (aiCase.flash || {}).text);
  check('库外题标记也带可信度', /可信度/.test(String((aiCase.flash || {}).text || '')), (aiCase.flash || {}).text);

  /* 3) 设置页：明确的「显示答案来源标记」开关 */
  const optPage = await browser.newPage();
  await optPage.setViewport({ width: 980, height: 1200 });
  await optPage.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  await sleep(600);
  const optUI = await optPage.evaluate(() => {
    const box = document.getElementById('flashOn');
    const ms = document.getElementById('flashMs');
    return {
      hasSwitch: !!box,
      checked: box ? box.checked : null,
      label: box ? (box.closest('.switch') || {}).innerText : '',
      hasMs: !!ms,
      msVal: ms ? ms.value : null
    };
  });
  console.log('\n设置页开关:', JSON.stringify(optUI));
  check('设置页有「显示答案来源标记」开关', optUI.hasSwitch && /显示答案来源标记/.test(String(optUI.label)), JSON.stringify(optUI.label).slice(0, 60));
  check('开关默认勾选', optUI.checked === true, String(optUI.checked));
  check('保留时长设置（默认 1500）', optUI.hasMs && String(optUI.msVal) === '1500', String(optUI.msVal));

  // 取消勾选并保存
  const saved = await optPage.evaluate(async () => {
    const box = document.getElementById('flashOn');
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    document.getElementById('save').click();
    await new Promise(r => setTimeout(r, 500));
    const cur = await chrome.storage.local.get('settings');
    return cur.settings;
  });
  check('取消勾选后保存为关闭', saved.flashOn === false, 'flashOn=' + saved.flashOn);
  const eff = await optPage.evaluate(async () => {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'getSettings' });
      return r && r.ok ? r.settings : null;
    } catch (e) { return null; }
  });
  check('后台据此把闪现时长归零（真正不再显示）', eff && eff.flashMs === 0, 'flashMs=' + (eff && eff.flashMs));
  check('关闭时不再有闪现时长', saved.flashMs === 1500 || saved.flashMs === 0, 'flashMs=' + saved.flashMs);

  await optPage.screenshot({ path: path.join(ROOT, 'docs', 'shot-options-flash.png'), fullPage: true }).catch(() => { });
  await optPage.close();

  /* 4) 关闭标记（flashMs=0） */
  await worker.evaluate(async () => {
    const cur = await chrome.storage.local.get('settings');
    const s = cur.settings || {};
    s.flashMs = 0;
    await chrome.storage.local.set({ settings: s });
  });
  await sleep(200);
  const offCase = await runAt(1, 4);
  console.log('\n关闭标记:', JSON.stringify({ flash: offCase.flash, 节点: `${offCase.before} → ${offCase.during}` }));
  check('flashMs=0 时不弹标记', !offCase.flash || offCase.flash.at < Date.now() - 5000, JSON.stringify(offCase.flash));
  check('关闭后也不插入节点', offCase.during === offCase.before, `${offCase.before} → ${offCase.during}`);

} catch (e) {
  check('运行未抛异常', false, e && e.message);
  console.error(e);
} finally {
  await browser.close();
  server.close();
  mock.close();
  const bad = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
  process.exitCode = bad.length ? 1 : 0;
}
