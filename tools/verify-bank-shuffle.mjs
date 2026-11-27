/**
 * 知识库通用性压力验证：全题库 × 选项随机打乱
 *   100 题 × N 个随机种子，逐题核对「插件填的选项文本」是否等于「题库标准答案的选项文本」
 *   node tools/verify-bank-shuffle.mjs [seeds]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { findBrowser } from './find-browser.mjs';

const ROOT = 'D:\\labs\\0exam';
const CHROME = findBrowser();
const WEB_PORT = 8840;
const API_PORT = 8841;
const SEEDS = Number(process.argv[2] || 2);
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const bank = JSON.parse(fs.readFileSync(path.join(ROOT, 'demo', 'bank.json'), 'utf8'));
const norm = s => String(s || '').replace(/[\s，,。.、；;：:（）()\[\]【】"'“”‘’·\-—_/？！?!]/g, '').toLowerCase();

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, 'demo', url === '/' ? '/exam-bank.html' : url);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(WEB_PORT, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 600000,
  args: [`--disable-extensions-except=${ROOT}\\extension`, `--load-extension=${ROOT}\\extension`, '--no-first-run'],
  defaultViewport: { width: 1100, height: 900 }
});

const results = [];
const fails = [];

try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await sw.worker();
  const extId = new URL(sw.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:' + API_PORT + '/v1', apiKey: 'k', model: 'mock-model',
    visionModel: '', temperature: 0.2, maxTokens: 2048, timeoutSec: 30,
    doubleCheck: false, autoFillAfterSolve: false, extraHeaders: '', systemPrompt: '',
    followMode: false, stealth: true, cacheEnabled: false, skipAnswered: false, concurrency: 1,
    kbEnabled: true, kbDirect: true, kbTopK: 3, kbMinCoverage: 0.65
  });

  // 导入题库
  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const kbText = fs.readFileSync(path.join(ROOT, 'demo', 'kb-sangfor.txt'), 'utf8');
  const kbStats = await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'kb-sangfor.txt', size: text.length, mime: 'text/plain', text });
    return kb.stats();
  }, kbText);
  await opt.close();
  console.log('知识库条目:', kbStats.entries, ' 题库题目:', bank.length, ' 随机种子数:', SEEDS, '\n');

  const page = await browser.newPage();
  let tabId = null;

  for (let seed = 1; seed <= SEEDS; seed++) {
    for (let i = 0; i < bank.length; i++) {
      const q = bank[i];
      await page.goto(`http://127.0.0.1:${WEB_PORT}/exam-bank.html?i=${i}&seed=${seed}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction('window.__READY === true', { timeout: 5000 }).catch(() => { });
      await sleep(80);

      if (!tabId) {
        tabId = await worker.evaluate(async () => {
          const all = await chrome.tabs.query({});
          return (all.find(t => t.url && t.url.includes('127.0.0.1:8840')) || {}).id;
        });
      }

      const out = await worker.evaluate(async tid => {
        const r = await chrome.scripting.executeScript({
          target: { tabId: tid },
          func: async () => {
            let list = await globalThis.__EXA_DEBUG__.extract();
            for (let k = 0; k < 3 && !list.length; k++) {
              await new Promise(r2 => setTimeout(r2, 120));
              list = await globalThis.__EXA_DEBUG__.extract();
            }
            if (!list.length) return { n: 0 };
            await globalThis.__EXA_DEBUG__.solveAll();
            const res = globalThis.__EXA_DEBUG__.results();
            const filled = await globalThis.__EXA_DEBUG__.fillOne(0);
            return {
              n: list.length,
              kind: res[0] && res[0].kind,
              answer: res[0] && res[0].answer,
              src: res[0] && res[0].source && res[0].source.kind,
              filled
            };
          }
        });
        return r[0].result;
      }, tabId);

      const pageState = await page.evaluate(() => ({
        picked: [...document.querySelectorAll('.option.on')].map(e => e.querySelector('.otext').textContent),
        q: window.__Q ? { no: window.__Q.no, pageOptions: window.__Q.pageOptions } : null
      }));

      // 裁判：题库标准答案对应的选项文本
      const expectTexts = q.answer.split('').map(L => {
        const o = q.options.find(x => x.letter === L);
        return o ? norm(o.text) : '';
      }).filter(Boolean).sort();
      const gotTexts = pageState.picked.map(norm).filter(Boolean).sort();
      const ok = expectTexts.length > 0 && expectTexts.length === gotTexts.length &&
        expectTexts.every((t, k) => t === gotTexts[k]);

      results.push({ seed, i, kind: out.kind, src: out.src, ok });
      if (!ok) {
        fails.push({
          seed, i, no: q.no, stem: q.stem.slice(0, 30), type: q.type,
          expectAnswer: q.answer,
          pluginAnswer: out.answer, src: out.src, filled: out.filled, n: out.n,
          expectTexts, gotTexts
        });
      }
    }
    const done = results.filter(r => r.seed === seed);
    const bad = done.filter(r => !r.ok);
    console.log(`种子 ${seed}: ${done.length - bad.length}/${done.length} 正确` + (bad.length ? ` （失败 ${bad.length}）` : ''));
  }

  const total = results.length;
  const good = results.filter(r => r.ok).length;
  const fromKb = results.filter(r => r.src === 'kb').length;

  console.log('\n=== 汇总 ===');
  console.log('  作答次数      :', total);
  console.log('  正确          :', good, `(${Math.round(good / total * 100)}%)`);
  console.log('  来自知识库    :', fromKb, `(${Math.round(fromKb / total * 100)}%)`);
  console.log('  失败          :', fails.length);

  if (fails.length) {
    console.log('\n失败明细（前 15 条）：');
    fails.slice(0, 15).forEach(f => {
      console.log(`  seed=${f.seed} #${f.i} 题库#${f.no} [${f.type}] ${f.stem}…`);
      console.log(`    插件: answer=${f.pluginAnswer} src=${f.src} filled=${f.filled} 识别=${f.n}`);
      console.log(`    期望: ${JSON.stringify(f.expectTexts)}`);
      console.log(`    实际: ${JSON.stringify(f.gotTexts)}`);
    });
  }

  process.exitCode = fails.length ? 1 : 0;

} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
