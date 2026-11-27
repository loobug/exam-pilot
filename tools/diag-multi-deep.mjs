/**
 * 多选题专项：真实站点全部多选题逐一实测
 *   node tools/diag-multi-deep.mjs
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findBrowser } from './find-browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const CHROME = findBrowser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (n, ok, d) => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

const SITE = 'D:\\labs\\深信服服务2.0\\exam-site';
const web = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const f = path.join(SITE, url);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => web.listen(8971, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 240000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  defaultViewport: { width: 1280, height: 900 }
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
    kbStrict: false, flashOn: false, flashMs: 0, siteAllow: ''
  });

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const kbText = fs.readFileSync(path.join(ROOT, 'demo', 'kb-site-full.txt'), 'utf8');
  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'kb-site-full.txt', size: text.length, mime: 'text/plain', text });
    await chrome.runtime.sendMessage({ type: 'kb-warm' });
  }, kbText);

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8971/', { waitUntil: 'domcontentloaded' });
  await sleep(900);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^开始考试$/.test(x.innerText.trim()));
    if (b) b.click();
  });
  await sleep(700);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8971')) || {}).id;
  });

  const rows = [];
  for (let i = 0; i < 25; i++) {
    const pageType = await page.evaluate(() => {
      const b = document.querySelector('.qmeta .badge');
      return b ? b.textContent.trim() : '';
    });

    if (pageType === '多选题') {
      const r = await worker.evaluate(async tid => {
        const out = await chrome.scripting.executeScript({
          target: { tabId: tid },
          func: async () => {
            const d = globalThis.__EXA_DEBUG__;
            d.clearResults();
            const list = await d.extract();
            if (!list.length) return { error: '未识别到题目' };
            const q = list[0];
            const kb = await d.kbCheck();
            await d.solveAll();
            const res = d.results();
            const before = [...document.querySelectorAll('.option.on')].map(b => Number(b.dataset.i));
            await d.fillOne(0);
            await new Promise(r => setTimeout(r, 260));
            const after = [...document.querySelectorAll('.option.on')].map(b => Number(b.dataset.i));
            return {
              kind: q.kind,
              optCount: (q.options || []).length,
              opts: (q.options || []).map(o => o.label + ':' + String(o.text).slice(0, 8)),
              mode: kb && kb.mode,
              kbAnswer: kb && kb.answer,
              answer: res[0] && res[0].answer,
              src: res[0] && res[0].source && res[0].source.kind,
              warn: res[0] && res[0].warn,
              before, after,
              afterText: [...document.querySelectorAll('.option.on')].map(b => (b.querySelector('.otext') || {}).textContent || '')
            };
          }
        });
        return out[0].result;
      }, tabId);

      rows.push({ pageType, ...r });
    }

    const moved = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /下一题/.test(x.innerText));
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    });
    if (!moved) break;
    await sleep(260);
  }

  console.log(`\n本轮多选题: ${rows.length} 道\n`);
  let multiOk = 0;
  rows.forEach((r, i) => {
    if (r.error) { console.log(`!! ${i + 1} ${r.error}`); return; }
    const n = (r.after || []).length;
    const ansLen = String(r.answer || '').length;
    const ok = n >= 2 && n === ansLen;
    if (ok) multiOk++;
    console.log(`${ok ? '  ' : '!!'} ${i + 1}. kind=${r.kind} 选项=${r.optCount} 库答案=${r.kbAnswer} 最终=${r.answer} 选中=${n} 个 ${JSON.stringify(r.after)}`);
    if (!ok) {
      console.log(`     选项文本: ${JSON.stringify(r.opts)}`);
      console.log(`     选中文本: ${JSON.stringify(r.afterText)}`);
      console.log(`     mode=${r.mode} src=${r.src} warn=${r.warn || '无'}`);
    }
  });
  console.log(`\n多选题正确: ${multiOk}/${rows.length}`);
  check('多选题全部正确选中', multiOk === rows.length && rows.length > 0, `${multiOk}/${rows.length}`);

} catch (e) {
  check('运行未抛异常', false, e && e.message);
  console.error(e);
} finally {
  await browser.close();
  web.close();
  const bad = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
}
