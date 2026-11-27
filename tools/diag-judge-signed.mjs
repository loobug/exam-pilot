/** 定点诊断：选项带符号的判断题，后台到底返回什么 */
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

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title>
<style>body{font:15px/1.7 system-ui;margin:20px}.qtext{font-weight:700;margin-bottom:10px}.option{display:block;margin:6px 0}</style>
</head><body><div class="q">
  <div class="qtext">现场服务必须穿正装。</div>
  <label class="option"><input type="radio" name="q" value="A"><span>A. 正确（√）</span></label>
  <label class="option"><input type="radio" name="q" value="B"><span>B. 错误（×）</span></label>
</div></body></html>`;

const web = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise(r => web.listen(8970, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 20000 });
  const worker = await swT.worker();
  const extId = new URL(swT.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', visionModel: '',
    temperature: 0.2, maxTokens: 512, timeoutSec: 5, doubleCheck: false, autoFillAfterSolve: false,
    extraHeaders: '', systemPrompt: '', followMode: false, stealth: true, cacheEnabled: false,
    skipAnswered: false, concurrency: 1, kbEnabled: true, kbDirect: true, kbTopK: 5,
    kbStrict: true, flashOn: false, flashMs: 0, siteAllow: ''
  });

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const KB = `1. 现场服务必须穿正装。
A. 正确（√）
B. 错误（×）
答案：错误
`;
  const kbInfo = await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    const tk = await import(chrome.runtime.getURL('src/lib/tokenize.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 't.txt', size: text.length, mime: 'text/plain', text });
    await chrome.runtime.sendMessage({ type: 'kb-warm' });
    return {
      normalize错误: tk.normalizeAnswerText('错误'),
      normalize正确括号: tk.normalizeAnswerText('正确（√）'),
      normalize错误括号: tk.normalizeAnswerText('错误（×）'),
      stats: await kb.stats()
    };
  }, KB);
  console.log('tokenize 归一化:', JSON.stringify(kbInfo, null, 1));

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8970/', { waitUntil: 'domcontentloaded' });
  await sleep(600);
  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8970')) || {}).id;
  });

  const r = await worker.evaluate(async tid => {
    const out = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        const d = globalThis.__EXA_DEBUG__;
        d.clearResults();
        const list = await d.extract();
        const q = list[0];
        const kb = await d.kbCheck();
        await d.solveAll();
        const res = d.results();
        await d.fillOne(0);
        await new Promise(r => setTimeout(r, 120));
        return {
          extractKind: q.kind,
          options: (q.options || []).map(o => o.label + ':' + o.text),
          kbMode: kb.mode, kbAnswer: kb.answer, kbExact: kb.exact,
          solvedAnswer: res[0] && res[0].answer,
          solvedKind: res[0] && res[0].kind,
          solvedSrc: res[0] && res[0].source && res[0].source.kind,
          solvedWarn: res[0] && res[0].warn,
          picked: [...document.querySelectorAll('input:checked')].map(i => i.value)
        };
      }
    });
    return out[0].result;
  }, tabId);

  console.log('\n结果:', JSON.stringify(r, null, 1));

} catch (e) { console.error(e); }
finally { await browser.close(); web.close(); }
