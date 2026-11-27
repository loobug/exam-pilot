/**
 * 真实站点端到端自测：自动做完 25 题，再和站点自己的正确答案逐题核对
 *   node tools/e2e-realsite.mjs
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
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const SITE = 'D:\\labs\\深信服服务2.0\\exam-site';
const web = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const f = path.join(SITE, url);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => web.listen(8930, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 240000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  defaultViewport: { width: 1280, height: 900 }
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await swT.worker();
  const extId = new URL(swT.url()).host;

  /* 默认配置 + 真实知识库 */
  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', visionModel: '',
    temperature: 0.2, maxTokens: 512, timeoutSec: 3, doubleCheck: false, autoFillAfterSolve: false,
    extraHeaders: '', systemPrompt: '', followMode: false, stealth: true, cacheEnabled: false,
    skipAnswered: false, concurrency: 3, kbEnabled: true, kbDirect: true, kbTopK: 5,
    kbStrict: false, flashOn: false, flashMs: 1500, siteAllow: ''
  });

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const kbText = fs.readFileSync(path.join(ROOT, 'demo', 'kb-sangfor.txt'), 'utf8');
  const kbStat = await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'kb-sangfor.txt', size: text.length, mime: 'text/plain', text });
    await chrome.runtime.sendMessage({ type: 'kb-warm' });
    return await kb.stats();
  }, kbText);
  console.log('知识库已导入:', JSON.stringify(kbStat.stats || kbStat));

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8930/', { waitUntil: 'domcontentloaded' });
  await sleep(900);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^开始考试$/.test(x.innerText.trim()));
    if (b) b.click();
  });
  await sleep(800);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8930')) || {}).id;
  });

  /* 逐题：识别 → 解 → 填，全部走插件真实流程 */
  const total = 25;
  let filledCount = 0;
  const perQ = [];
  for (let i = 0; i < total; i++) {
    const r = await worker.evaluate(async tid => {
      const out = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: async () => {
          const d = globalThis.__EXA_DEBUG__;
          d.clearResults();
          const list = await d.extract();
          if (!list.length) return null;
          const q = list[0];
          const kb = await d.kbCheck();
          await d.solveAll();
          const res = d.results();
          await d.fillOne(0);
          await new Promise(r => setTimeout(r, 120));
          const on = [...document.querySelectorAll('.option.on')].map(b => Number(b.dataset.i));
          const optTexts = q.options.map(o => o.label + ':' + String(o.text).slice(0, 6));
          const onText = [...document.querySelectorAll('.option.on')].map(b => (b.querySelector('.otext') || {}).textContent || '');
          return {
            stem: String(q.stem || '').slice(0, 20),
            kind: q.kind,
            mode: kb && kb.mode,
            answer: res[0] && res[0].answer,
            src: res[0] && res[0].source && res[0].source.kind,
            on, optTexts, onText
          };
        }
      });
      return out[0].result;
    }, tabId);
    if (!r) break;
    perQ.push(r);
    if (r.on && r.on.length) filledCount++;

    const moved = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /下一题/.test(x.innerText));
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    });
    if (!moved) break;
    await sleep(260);
  }

  /* 从站点自己的数据里读正确答案，逐题核对 */
  const truth = await page.evaluate(() => {
    try {
      // 站点把题目和作答存在这两个变量里
      const qs = window.examQuestions || [];
      const ans = window.answers || [];
      return {
        n: qs.length,
        data: qs.map((q, i) => ({
          kind: q.type,
          correct: (q.answer || []).slice().sort((a, b) => a - b),
          picked: (ans[i] || []).slice().sort((a, b) => a - b)
        }))
      };
    } catch (e) { return { error: String(e.message) }; }
  });

  /* 答题面板截图 */
  await page.screenshot({ path: path.join(ROOT, 'docs', 'shot-realsite-exam.png') }).catch(() => { });

  console.log(`\n共处理 ${perQ.length} 题，其中填涂成功 ${filledCount} 题\n`);
  perQ.forEach((r, i) => {
    const okMark = r.kind === 'judge' ? (r.answer === '对' ? (r.onText[0] || '').includes('正确') : (r.onText[0] || '').includes('错误')) : true;
    console.log(`${okMark ? '  ' : '!!'} ${String(i + 1).padStart(2)} [${r.mode}] ${r.kind} 答案=${r.answer} 选中=${JSON.stringify(r.onText)} 选项=${JSON.stringify(r.optTexts)} | ${r.stem}`);
  });

  check('识别并处理了全部 25 题', perQ.length === total, `${perQ.length}/${total}`);
  check('每题都填涂成功', filledCount === perQ.length, `${filledCount}/${perQ.length}`);
  check('全部来自知识库', perQ.every(r => r.mode === 'kb'), perQ.filter(r => r.mode !== 'kb').length + ' 题非 kb');

  /* 与站点标准答案比对 */
  if (truth.data && truth.data.length) {
    let correct = 0;
    const wrong = [];
    truth.data.forEach((t, i) => {
      const same = t.correct.length === t.picked.length && t.correct.every((v, k) => v === t.picked[k]);
      if (same) correct++; else wrong.push({ i: i + 1, kind: t.kind, correct: t.correct, picked: t.picked });
    });
    console.log(`\n站点判卷：${correct}/${truth.data.length} 题正确`);
    if (wrong.length) console.log('错题:', JSON.stringify(wrong, null, 1));
    check('站点判卷全部正确', correct === truth.data.length, `${correct}/${truth.data.length}`);
  } else {
    console.log('\n（未能读到站点标准答案，跳过判卷）', JSON.stringify(truth).slice(0, 120));
  }

  /* 面板截图 */
  await log1();
  async function log1() {
    await worker.evaluate(async tid => {
      await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: () => { try { globalThis.__EXA_DEBUG__ && document; } catch (e) { } }
      });
    }, tabId).catch(() => { });
  }

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
