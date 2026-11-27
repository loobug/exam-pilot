/**
 * 默认行为验证：隐式 + 跟随（翻页自动答当前题、不自动翻页）
 *   node tools/e2e-follow.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockApi } from './mock-api.mjs';

const SITE = 'D:\\labs\\深信服服务2.0\\exam-site';
const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const WEB_PORT = 8808;
const API_PORT = 8809;

const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const file = path.join(SITE, url);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(WEB_PORT, '127.0.0.1', r));
const mock = await startMockApi(API_PORT);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: [`--disable-extensions-except=${ROOT}\\extension`, `--load-extension=${ROOT}\\extension`, '--no-first-run', '--no-default-browser-check'],
  defaultViewport: { width: 1320, height: 1000 }
});

try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await sw.worker();

  // 只写接口信息，其余全部用扩展默认值（验证默认行为）
  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:' + API_PORT + '/v1',
    apiKey: 'mock-key', model: 'mock-model', visionModel: '',
    temperature: 0.2, maxTokens: 2048, timeoutSec: 60,
    doubleCheck: false, autoFillAfterSolve: false,
    extraHeaders: '', systemPrompt: '',
    kbEnabled: true, kbDirect: true, cacheEnabled: false, skipAnswered: true, concurrency: 1
  });
  await sleep(300);

  const defaults = await worker.evaluate(async () => {
    const cur = await chrome.storage.local.get('settings');
    return cur.settings;
  });
  check('默认 leap：跟随模式开启', defaults.followMode === undefined || defaults.followMode !== false, 'followMode=' + defaults.followMode);
  check('默认值：自动翻页关闭', defaults.autoNext !== true, 'autoNext=' + defaults.autoNext);

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'domcontentloaded' });
  await sleep(700);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(x => /^开始考试$/.test(x.innerText.trim()));
    if (btn) btn.click();
  });
  await sleep(1000);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8808')) || {}).id;
  });

  const stateOf = async () => page.evaluate(() => ({
    qnum: (document.querySelector('.qmeta') || {}).innerText.replace(/\n/g, ' ').trim().slice(0, 26),
    picked: (document.querySelector('#qcard .option.on') || {}).innerText || null,
    pickedCount: document.querySelectorAll('#qcard .option.on').length
  }));

  const q0 = await stateOf();
  // 什么都不点，等跟随模式自己答第一题
  await sleep(7000);
  const q1 = await stateOf();
  console.log('\n首屏：', JSON.stringify(q0));
  console.log('等 7s：', JSON.stringify(q1));

  check('打开页面后自动答了当前题（无需任何点击）', !!q1.picked, q1.picked ? q1.picked.replace(/\n/g, '') : '未作答');
  check('没有自动翻页（题号未变）', q1.qnum === q0.qnum, `${q0.qnum} → ${q1.qnum}`);

  const ui1 = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => ({ mounted: globalThis.__EXA_DEBUG__.uiMounted(), uiOn: globalThis.__EXA_DEBUG__.uiOn() })
    });
    return r[0].result;
  }, tabId);
  check('默认隐式：页面上没有挂载面板', ui1.mounted === false, JSON.stringify(ui1));

  // 用户手动翻页 → 应该自动答新题，但仍不自动翻页
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(x => /^下一题$/.test(x.innerText.trim()));
    if (btn) btn.click();
  });
  await sleep(600);
  const q2 = await stateOf();
  await sleep(7000);
  const q3 = await stateOf();
  console.log('\n手动翻页后：', JSON.stringify(q2));
  console.log('再等 7s：', JSON.stringify(q3));

  check('手动翻页后题号确实变了', q2.qnum !== q1.qnum, `${q1.qnum} → ${q2.qnum}`);
  check('新题被自动作答并填上', !!q3.picked, q3.picked ? q3.picked.replace(/\n/g, '') : '未作答');
  check('作答后仍未自动翻页（停在当前题）', q3.qnum === q2.qnum, `${q2.qnum} → ${q3.qnum}`);

  // 面板按钮精简检查
  await worker.evaluate(async tid => {
    await chrome.tabs.sendMessage(tid, { type: 'cmd-toggle' });
  }, tabId);
  await sleep(800);
  const toolbar = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => globalThis.__EXA_DEBUG__.toolbar()
    });
    return r[0].result;
  }, tabId);
  console.log('\n面板工具条：', JSON.stringify(toolbar));
  check('面板已去掉「全部解题」', !toolbar.some(t => /全部解题|全部答题/.test(t)), JSON.stringify(toolbar));
  check('面板已去掉「填入全部」', !toolbar.some(t => /填入全部|填写全部/.test(t)), JSON.stringify(toolbar));
  check('保留了手动识别与连做入口', toolbar.some(t => /识别/.test(t)) && toolbar.some(t => /自动连做/.test(t)), JSON.stringify(toolbar));

  await page.screenshot({ path: path.join(ROOT, 'docs', 'shot-follow.png') }).catch(() => { });

} catch (e) {
  check('运行未抛异常', false, e && e.message);
  console.error(e);
} finally {
  await browser.close();
  server.close();
  mock.close();
  const bad = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
  process.exit(bad.length ? 1 : 0);
}
