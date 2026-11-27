/**
 * 隐式自动作答 + 隐身 + 不切标签 验证
 *   node tools/e2e-auto.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockApi } from './mock-api.mjs';

const SITE = 'D:\\labs\\深信服服务2.0\\exam-site';
const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const WEB_PORT = 8805;
const API_PORT = 8806;

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

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:' + API_PORT + '/v1',
    apiKey: 'mock-key', model: 'mock-model', visionModel: '',
    temperature: 0.2, maxTokens: 2048, timeoutSec: 60,
    doubleCheck: false, autoFillAfterSolve: false,
    extraHeaders: '', systemPrompt: '',
    kbEnabled: true, kbDirect: true, cacheEnabled: false, skipAnswered: true, concurrency: 1,
    autoInterval: 2, autoLimit: 6, autoNext: true, stealth: true, followMode: false
  });
  await sleep(300);

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'domcontentloaded' });
  await sleep(700);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(x => /^开始考试$/.test(x.innerText.trim()));
    if (btn) btn.click();
  });
  await sleep(2000);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8805')) || {}).id;
  });
  const tabsBefore = await worker.evaluate(async () => (await chrome.tabs.query({})).length);

  const domBefore = await page.evaluate(() => ({
    nodes: document.documentElement.getElementsByTagName('*').length,
    qnum: (document.querySelector('.qnum, .qmeta') || {}).innerText || ''
  }));

  /* ---------- 结构探测 ---------- */
  const structure = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({ target: { tabId: tid }, func: () => qxExtract.probeStructure() });
    return r[0].result;
  }, tabId);
  console.log('\n页面结构：', JSON.stringify(structure));
  check('结构探测：识别为一屏一题', structure.mode === 'single', structure.mode);
  check('结构探测：总题数 25', structure.total === 25, String(structure.total));
  check('结构探测：选项类型 click', structure.optionKind === 'click', structure.optionKind);
  check('结构探测：找到「下一题」', /下一题/.test(structure.nextText || ''), structure.nextText);

  /* ---------- 启动隐式自动作答 ---------- */
  await worker.evaluate(async tid => {
    await chrome.scripting.executeScript({ target: { tabId: tid }, func: () => globalThis.__EXA_DEBUG__.auto() });
  }, tabId);

  // 观察 20 秒
  const samples = [];
  let badgeSeen = '';
  let mountedSeen = null;
  for (let i = 0; i < 22; i++) {
    await sleep(1000);
    const state = await page.evaluate(() => ({
      qnum: (document.querySelector('.qmeta') || {}).innerText.replace(/\n/g, ' ').slice(0, 30),
      picked: (document.querySelector('#qcard .option.on') || {}).innerText || null,
      nodes: document.documentElement.getElementsByTagName('*').length
    }));
    samples.push(state);
    if (i === 4) {
      badgeSeen = await worker.evaluate(async tid => chrome.action.getBadgeText({ tabId: tid }), tabId);
      mountedSeen = await worker.evaluate(async tid => {
        const r = await chrome.scripting.executeScript({ target: { tabId: tid }, func: () => globalThis.__EXA_DEBUG__.uiMounted() });
        return r[0].result;
      }, tabId);
    }
  }

  const uiState = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => ({
        mounted: globalThis.__EXA_DEBUG__.uiMounted(),
        uiOn: globalThis.__EXA_DEBUG__.uiOn(),
        results: globalThis.__EXA_DEBUG__.results().length
      })
    });
    return r[0].result;
  }, tabId);

  const badge = await worker.evaluate(async tid => chrome.action.getBadgeText({ tabId: tid }), tabId);
  const tabsAfter = await worker.evaluate(async () => (await chrome.tabs.query({})).length);
  const domAfter = await page.evaluate(() => ({
    nodes: document.documentElement.getElementsByTagName('*').length,
    qnum: (document.querySelector('.qmeta') || {}).innerText || ''
  }));

  const progressed = samples.filter((s, i) => i > 0 && s.qnum !== samples[i - 1].qnum).length;
  const pickedCount = samples.filter(s => s.picked).length;

  console.log('\n采样（每题 1s）：');
  samples.slice(0, 12).forEach((s, i) => console.log(`  ${String(i).padStart(2)}s qnum=${(s.qnum || '').padEnd(22)} picked=${s.picked ? s.picked.replace(/\n/g, '').slice(0, 12) : '—'}`));
  console.log('UI 状态：', JSON.stringify(uiState), ' 角标：', JSON.stringify(badge));

  const startQnum = String(domBefore.qnum || '');
  const endQnum = String(domAfter.qnum || '');
  check('自动作答跑起来了（题号发生推进）', startQnum !== endQnum && progressed >= 1,
    startQnum.replace(/\n/g, ' ').slice(0, 20) + ' → ' + endQnum.replace(/\n/g, ' ').slice(0, 20) + '（采样推进 ' + progressed + ' 次）');
  check('自动填涂生效（出现选中项）', pickedCount >= 2, '采样中选中 ' + pickedCount + ' 次');
  check('隐式模式：运行期间页面未挂载任何扩展 UI', mountedSeen === false, 'mounted=' + mountedSeen);
  check('隐式模式：UI 通道关闭', uiState.uiOn === false, 'uiOn=' + uiState.uiOn);
  check('扩展开关了角标进度', String(badgeSeen).length > 0, '运行时角标=' + JSON.stringify(badgeSeen) + '，结束后=' + JSON.stringify(badge));
  check('全程没有新开/切换标签', tabsBefore === tabsAfter, `${tabsBefore} → ${tabsAfter}`);
  check('页面 DOM 节点数基本不变（<+5）', Math.abs(domAfter.nodes - domBefore.nodes) < 5,
    `${domBefore.nodes} → ${domAfter.nodes}`);

  /* ---------- 显式模式：面板 + 面板内设置 ---------- */
  await worker.evaluate(async tid => {
    await chrome.scripting.executeScript({ target: { tabId: tid }, func: () => globalThis.__EXA_DEBUG__.stopAuto() });
  }, tabId);
  await sleep(600);

  const toggleRes = await worker.evaluate(async tid => {
    await chrome.tabs.update(tid, { active: true });
    try {
      return await chrome.tabs.sendMessage(tid, { type: 'cmd-toggle' });
    } catch (e) { return { error: String(e && e.message || e) }; }
  }, tabId);
  console.log('cmd-toggle 响应：', JSON.stringify(toggleRes));
  await sleep(800);

  const panel = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => ({ mounted: globalThis.__EXA_DEBUG__.uiMounted(), uiOn: globalThis.__EXA_DEBUG__.uiOn() })
    });
    return r[0].result;
  }, tabId);
  check('显式模式：面板可以正常挂载', panel.mounted === true, JSON.stringify(panel));

  const tabsBeforeSave = await worker.evaluate(async () => (await chrome.tabs.query({})).length);
  const saved = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => globalThis.__EXA_DEBUG__.saveSettings({ model: 'mock-model-2', autoInterval: 7, autoLimit: 12, autoNext: true, stealth: false })
    });
    await new Promise(r2 => setTimeout(r2, 600));
    const cur = await chrome.storage.local.get('settings');
    return { settings: cur.settings, applied: cur.settings && cur.settings.model };
  }, tabId);
  const tabsAfterSave = await worker.evaluate(async () => (await chrome.tabs.query({})).length);
  check('面板内保存设置生效（不跳转设置页）', saved.applied === 'mock-model-2', 'model=' + saved.applied);
  check('保存设置没有新开标签页', tabsBeforeSave === tabsAfterSave, `${tabsBeforeSave} → ${tabsAfterSave}`);
  check('间隔/上限写入成功', saved.settings.autoInterval === 7 && saved.settings.autoLimit === 12,
    `interval=${saved.settings.autoInterval} limit=${saved.settings.autoLimit}`);

  await page.screenshot({ path: path.join(ROOT, 'docs', 'shot-auto.png') }).catch(() => { });

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
