/** 题库 100 题全量命中率（每道题都要 exact 命中且答案一致） */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { findBrowser } from './find-browser.mjs';

const ROOT = 'D:\\labs\\0exam';
const CHROME = findBrowser();

/* 解析题库文件，得到标准数据集（与插件无关，作为裁判） */
function parseBank(text) {
  const blocks = text.split(/\n(?=\d+\.\s)/);
  const out = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter(Boolean);
    if (!lines.length) continue;
    const first = lines[0].match(/^(\d+)\.\s+(.*)$/);
    if (!first) continue;
    const no = Number(first[1]);
    const stem = first[2].trim();
    const options = {};
    let answer = null;
    for (const line of lines.slice(1)) {
      const om = line.match(/^([A-H])\.\s+(.*)$/);
      if (om) { options[om[1]] = om[2].trim(); continue; }
      const am = line.match(/^答案：\s*([A-H]+)/);
      if (am) answer = am[1];
    }
    if (answer) out.push({ no, stem, options, answer });
  }
  return out;
}

const bank = parseBank(fs.readFileSync(ROOT + '\\demo\\kb-site-full.txt', 'utf8'));
console.log('题库题目数：', bank.length);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 300000,
  args: [`--disable-extensions-except=${ROOT}\\extension`, `--load-extension=${ROOT}\\extension`, '--no-first-run']
});

try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await sw.worker();
  const extId = new URL(sw.url()).host;

  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      settings: {
        baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', visionModel: '',
        temperature: 0.2, maxTokens: 512, timeoutSec: 10, doubleCheck: false, autoFillAfterSolve: false,
        extraHeaders: '', systemPrompt: '', kbEnabled: true, kbDirect: true, kbTopK: 3,
        kbMinCoverage: 0.65, cacheEnabled: false, skipAnswered: true, concurrency: 1,
        followMode: false, stealth: false
      }
    });
  });

  const page = await browser.newPage();
  await page.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });

  const text = fs.readFileSync(ROOT + '\\demo\\kb-site-full.txt', 'utf8');
  const report = await page.evaluate(async args => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    const tk = await import(chrome.runtime.getURL('src/lib/tokenize.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'kb-site-full.txt', size: args.text.length, mime: 'text/plain', text: args.text });
    const st = await kb.stats();

    const rows = [];
    for (const q of args.bank) {
      // 模拟页面：按该题自己的选项构造指纹（真实链路里 background 会这样传）
      const pageText = Object.keys(q.options).sort()
        .map(k => k + '. ' + q.options[k]).join(' ');
      const pageFp = tk.optionsFingerprint(pageText);
      const r = await kb.search(q.stem, { topK: 12, exactQuestion: q.stem, pageFp });
      const top = (r || [])[0];
      rows.push({
        no: q.no,
        asked: q.stem.slice(0, 24),
        entries: (r || []).length,
        exact: !!(top && top.exact),
        got: top && top.entry ? String(top.entry.answer || '') : '',
        want: q.answer,
        cov: top && top.coverage != null ? Number(top.coverage.toFixed(2)) : null,
        exactAll: (r || []).filter(x => x.exact).map(x => ({
          a: String(x.entry.answer || ""),
          fp: String(x.entry.optFp || "").slice(0, 20),
          fpLen: String(x.entry.optFp || "").split("|").filter(Boolean).length
        })),
        pageFp: pageFp.slice(0, 20),
        pageFpLen: pageFp.split("|").filter(Boolean).length
      });
    }
    return { stats: st, rows };
  }, { text, bank });

  console.log('索引条目：', report.stats.entries, '\n');

  const rows = report.rows;
  const missExact = rows.filter(r => !r.exact);
  const wrongAnswer = rows.filter(r => r.exact && r.got.trim().toUpperCase() !== r.want);
  const noHit = rows.filter(r => r.entries === 0);

  console.log('=== 100 题全量检索 ===');
  console.log('  题目总数        :', rows.length);
  console.log('  精确命中        :', rows.filter(r => r.exact).length);
  console.log('  未精确命中      :', missExact.length);
  console.log('  命中但答案不一致:', wrongAnswer.length);
  console.log('  完全无结果      :', noHit.length);

  if (missExact.length) {
    console.log('\n未精确命中明细（前 8 条）：');
    missExact.slice(0, 8).forEach(r => console.log(`  #${r.no} ${r.asked}… entries=${r.entries} cov=${r.cov} got=${r.got}`));
  }
  if (wrongAnswer.length) {
    console.log('\n答案不一致明细：');
    wrongAnswer.slice(0, 8).forEach(r => {
      console.log(`  #${r.no} ${r.asked}… got=${r.got} want=${r.want}`);
      console.log('    页面选项数=' + r.pageFpLen + ' fp=' + r.pageFp);
      (r.exactAll || []).forEach((e, i) => console.log(`    条目${i + 1}: answer=${e.a} 选项数=${e.fpLen} fp=${e.fp}`));
    });
  }

  const pass = missExact.length === 0 && wrongAnswer.length === 0 && noHit.length === 0;
  console.log('\n结论：' + (pass ? '100% 命中，答案全部一致' : '存在缺口'));
  process.exitCode = pass ? 0 : 1;

} finally {
  await browser.close();
}
