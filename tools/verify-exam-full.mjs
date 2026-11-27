/**
 * 真实考试页整卷验证：25 题逐题作答，用题库做裁判核对
 *   node tools/verify-exam-full.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockApi } from './mock-api.mjs';
import { findBrowser } from './find-browser.mjs';

const SITE = 'D:\\labs\\深信服服务2.0\\exam-site';
const ROOT = 'D:\\labs\\0exam';
const CHROME = findBrowser();
const WEB_PORT = 8830;
const API_PORT = 8831;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 题库作裁判 ---------- */
function parseBank(text) {
  const blocks = text.split(/\n(?=\d+\.\s)/);
  const out = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter(Boolean);
    if (!lines.length) continue;
    const first = lines[0].match(/^(\d+)\.\s+(.*)$/);
    if (!first) continue;
    const options = {};
    let answer = null;
    for (const line of lines.slice(1)) {
      const om = line.match(/^([A-H])\.\s+(.*)$/);
      if (om) { options[om[1]] = om[2].trim(); continue; }
      const am = line.match(/^答案：\s*([A-H]+)/);
      if (am) answer = am[1];
    }
    if (answer) out.push({ no: Number(first[1]), stem: first[2].trim(), options, answer });
  }
  return out;
}
const norm = s => String(s || '').replace(/[\s，,。.、；;：:（）()\[\]【】"'“”‘’·\-—_/]/g, '').toLowerCase();

const bank = parseBank(fs.readFileSync(ROOT + '\\demo\\kb-sangfor.txt', 'utf8'));

/** 找到与页面题干对应的题库条目（同题干可能多条，用选项集合选最匹配的） */
function matchBank(stem, optTexts) {
  const key = norm(stem).replace(/^\d+/, '');
  const cands = bank.filter(b => norm(b.stem) === key || norm(b.stem) === norm(stem));
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0];
  const pageSet = new Set(optTexts.map(norm));
  let best = cands[0], bestHit = -1;
  cands.forEach(c => {
    const vals = Object.values(c.options).map(norm);
    let hit = 0;
    vals.forEach(v => { if (pageSet.has(v)) hit++; });
    if (hit > bestHit) { bestHit = hit; best = c; }
  });
  return best;
}

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

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 300000,
  args: [`--disable-extensions-except=${ROOT}\\extension`, `--load-extension=${ROOT}\\extension`, '--no-first-run'],
  defaultViewport: { width: 1320, height: 1000 }
});

try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await sw.worker();
  const extId = new URL(sw.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:' + API_PORT + '/v1', apiKey: 'k', model: 'mock-model',
    visionModel: '', temperature: 0.2, maxTokens: 2048, timeoutSec: 60,
    doubleCheck: false, autoFillAfterSolve: false, extraHeaders: '', systemPrompt: '',
    followMode: false, stealth: true, cacheEnabled: false, skipAnswered: false, concurrency: 1,
    kbEnabled: true, kbDirect: true, kbTopK: 3, kbMinCoverage: 0.65
  });

  // 导入题库
  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const kbText = fs.readFileSync(ROOT + '\\demo\\kb-sangfor.txt', 'utf8');
  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'kb-sangfor.txt', size: text.length, mime: 'text/plain', text });
  }, kbText);
  await opt.close();

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'domcontentloaded' });
  await sleep(700);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(x => /^开始考试$/.test(x.innerText.trim()));
    if (btn) btn.click();
  });
  await sleep(1500);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8830')) || {}).id;
  });

  const readQ = () => page.evaluate(() => {
    const meta = (document.querySelector('.qmeta') || {}).innerText || '';
    const m = meta.match(/第\s*(\d+)\s*\/\s*(\d+)\s*题/);
    return {
      cur: m ? Number(m[1]) : -1,
      stem: (document.querySelector('.qtext') || {}).innerText || '',
      opts: [...document.querySelectorAll('#qcard .option')].map(b => ({
        letter: (b.querySelector('.letter') || {}).textContent || '',
        text: (b.querySelector('.otext') || {}).textContent || ''
      })),
      picked: [...document.querySelectorAll('#qcard .option.on')].map(b => ({
        letter: (b.querySelector('.letter') || {}).textContent || '',
        text: (b.querySelector('.otext') || {}).textContent || ''
      }))
    };
  });

  const rows = [];
  let guard = 0;
  while (guard++ < 30) {
    const q = await readQ();
    if (q.cur < 0) break;
    if (rows.some(r => r.cur === q.cur)) {
      // 已经处理过这道题，翻页
      const moved = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(x => /^下一题$/.test(x.innerText.trim()));
        if (btn && !btn.disabled) { btn.click(); return true; }
        return false;
      });
      if (!moved) break;
      await sleep(900);
      continue;
    }

    const solved = await worker.evaluate(async tid => {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: async () => {
          let list = await globalThis.__EXA_DEBUG__.extract();
          for (let k = 0; k < 6 && !list.length; k++) {
            await new Promise(r2 => setTimeout(r2, 600));
            list = await globalThis.__EXA_DEBUG__.extract();
          }
          if (!list.length) return { n: 0, kind: "extract-failed" };
          await globalThis.__EXA_DEBUG__.solveAll();
          const res = globalThis.__EXA_DEBUG__.results();
          const filled = await globalThis.__EXA_DEBUG__.fillOne(0);
          let kb = null;
          try { kb = await globalThis.__EXA_DEBUG__.kbCheck(); } catch (e) { kb = { error: String(e && e.message || e) }; }
          return {
            n: list.length,
            kind: res[0] && res[0].kind, answer: res[0] && res[0].answer,
            src: res[0] && res[0].source && res[0].source.kind,
            filled, kbMode: kb && kb.mode, kbExact: kb && kb.exact, kbAns: kb && kb.answer
          };
        }
      });
      return r[0].result;
    }, tabId);
    await sleep(400);

    const after = await readQ();
    const std = matchBank(q.stem, q.opts.map(o => o.text));

    // 直接比较「选中的选项文本集合」与「题库答案对应的选项文本集合」
    let expectTexts = [];
    let gotTexts = [];
    let sameSet = false;
    if (std) {
      expectTexts = std.answer.split("").map(L => std.options[L]).filter(Boolean).map(norm).sort();
      gotTexts = after.picked.map(p => norm(p.text)).filter(Boolean).sort();
      sameSet = expectTexts.length > 0 && expectTexts.length === gotTexts.length &&
        expectTexts.every((t, i) => t === gotTexts[i]);
    }

    rows.push({
      cur: q.cur,
      stem: q.stem.slice(0, 26),
      kind: solved && solved.kind,
      pluginAnswer: solved && solved.answer,
      src: solved && solved.src,
      filled: solved && solved.filled,
      n: solved && solved.n,
      kbMode: solved && solved.kbMode,
      kbExact: solved && solved.kbExact,
      kbAns: solved && solved.kbAns,
      pagePicked: after.picked.map(p => p.letter).join(''),
      gotLetters: gotTexts.length,
      stdAnswer: std && std.answer,
      stdNo: std && std.no,
      ok: sameSet,
      matched: !!std,
      expectTexts,
      gotTexts,
      pickedRaw: after.picked.map(p => p.text)
    });

    const moved = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(x => /^下一题$/.test(x.innerText.trim()));
      if (btn && !btn.disabled) { btn.click(); return true; }
      return false;
    });
    if (!moved) break;
    await sleep(1500);
  }

  console.log('\n题号 | 题型 | 来源 | 插件答案 | 页面选中 | 题库答案 | 判定');
  console.log('-'.repeat(88));
  rows.forEach(r => {
    console.log(
      `${String(r.cur).padStart(3)} | ${String(r.kind).padEnd(6)} | ${String(r.src).padEnd(7)} | ${String(r.pluginAnswer).padEnd(8)} | ${String(r.pagePicked).padEnd(8)} | ${String(r.stdAnswer).padEnd(7)} | ${r.ok ? '✓' : '✗'}  ${r.stem}`
    );
  });

  const total = rows.length;
  const matched = rows.filter(r => r.matched).length;
  const correct = rows.filter(r => r.ok).length;
  const fromKb = rows.filter(r => r.src === 'kb').length;

  const badRows = rows.filter(r => !r.ok);
  if (badRows.length) {
    console.log('\n=== 不一致明细 ===');
    badRows.forEach(r => {
      console.log(`#${r.cur} ${r.stem}…`);
      console.log(`   插件: 识别${r.n}题 kind=${r.kind} answer=${r.pluginAnswer} src=${r.src} filled=${r.filled}`);
      console.log(`   kbCheck: mode=${r.kbMode} exact=${r.kbExact} answer=${r.kbAns}`);
      console.log(`   题库: #${r.stdNo} 答案=${r.stdAnswer}`);
      console.log(`   期望选项文本: ${JSON.stringify(r.expectTexts)}`);
      console.log(`   页面选中文本: ${JSON.stringify(r.gotTexts)}  字母=${JSON.stringify(r.pickedRaw)}`);
    });
  }

  console.log('\n=== 整卷结果 ===');
  console.log('  作答题数      :', total);
  console.log('  题库可对照    :', matched);
  console.log('  与题库一致    :', correct);
  console.log('  来源=知识库   :', fromKb);
  console.log('  准确率        :', matched ? Math.round(correct / matched * 100) + '%' : 'n/a');

  const recognized = rows.filter(r => r.n > 0).length;
  const filledRows = rows.filter(r => r.filled).length;
  const kbRows = rows.filter(r => r.src === 'kb');
  const kbCorrect = kbRows.filter(r => r.ok).length;

  check('整卷作答数量合理（≥20 题）', total >= 20, total + ' 题');
  check('每题都识别到题目', recognized === total, `${recognized}/${total}`);
  check('每题都完成填涂', filledRows === total, `${filledRows}/${total}`);
  check('每题都能在题库里找到对照', matched === total, `${matched}/${total}`);
  check('走知识库的题 100% 与题库一致', kbRows.length > 0 && kbCorrect === kbRows.length, `${kbCorrect}/${kbRows.length}`);
  check('绝大多数题直接由知识库作答（≥90%）', fromKb >= Math.ceil(total * 0.9), `${fromKb}/${total}`);
  check('整体与题库一致（含模型回退）', correct === matched, `${correct}/${matched}`);

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
