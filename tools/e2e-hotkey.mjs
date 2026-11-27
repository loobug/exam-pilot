/**
 * 快捷键只作用于当前题 + 面板内设置不漏存
 *   node tools/e2e-hotkey.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockApi } from './mock-api.mjs';

const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const WEB_PORT = 8852;
const API_PORT = 8853;
const MIME = { '.html': 'text/html; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, 'demo', url === '/' ? '/exam-demo.html' : url);
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
  defaultViewport: { width: 1200, height: 1000 }
});

try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await sw.worker();
  const extId = new URL(sw.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:' + API_PORT + '/v1', apiKey: 'k', model: 'mock-model',
    visionModel: '', temperature: 0.2, maxTokens: 2048, timeoutSec: 30,
    doubleCheck: false, autoFillAfterSolve: false, extraHeaders: '', systemPrompt: '',
    followMode: false, stealth: false, cacheEnabled: false, skipAnswered: false, concurrency: 1,
    kbEnabled: false, flashMs: 0
  });

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'domcontentloaded' });
  await sleep(700);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8852')) || {}).id;
  });

  // 先识别出 6 题，但不解题
  const count = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        const list = await globalThis.__EXA_DEBUG__.extract();
        globalThis.__EXA_DEBUG__.clearResults();
        return list.length;
      }
    });
    return r[0].result;
  }, tabId);
  console.log('\n识别题数:', count);
  check('测试页识别出多题', count >= 4, count + ' 题');

  /* 按 Alt+Shift+S：应只解一题 */
  await page.bringToFront();
  await page.keyboard.down('Alt');
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyS');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Alt');
  await sleep(2500);

  const afterHotkey = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => ({ solved: globalThis.__EXA_DEBUG__.results().length, total: globalThis.__EXA_DEBUG__.questions().length })
    });
    return r[0].result;
  }, tabId);
  console.log('按 Alt+Shift+S 后:', JSON.stringify(afterHotkey));

  check('快捷键只解当前这一题（不是全部）', afterHotkey.solved === 1, JSON.stringify(afterHotkey));
  check('没有把整卷都解掉', afterHotkey.solved < afterHotkey.total, `${afterHotkey.solved}/${afterHotkey.total}`);

  /* 面板内设置：followMode 是否会被保存 */
  const optPage = await browser.newPage();
  await optPage.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  await sleep(300);
  const drawerFields = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => {
        // 模拟面板抽屉提交（含 followMode）
        return globalThis.__EXA_DEBUG__.saveSettings({
          model: 'mock-model', baseUrl: 'http://127.0.0.1:' + 8853 + '/v1',
          autoInterval: 8, autoLimit: 20, followMode: false, autoNext: true, stealth: false
        });
      }
    });
    return r[0].result;
  }, tabId);
  await sleep(600);
  const saved = await optPage.evaluate(async () => {
    const cur = await chrome.storage.local.get('settings');
    return cur.settings || {};
  });
  console.log('面板保存后:', JSON.stringify({
    followMode: saved.followMode, autoNext: saved.autoNext, autoInterval: saved.autoInterval, autoLimit: saved.autoLimit
  }));
  check('面板内 followMode 会被保存（之前漏了）', saved.followMode === false, 'followMode=' + saved.followMode);
  check('面板内其它开关同步保存', saved.autoNext === true && Number(saved.autoInterval) === 8, `${saved.autoNext}/${saved.autoInterval}`);

  await optPage.close();

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
