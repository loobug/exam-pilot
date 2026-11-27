/**
 * 脏题干鲁棒性：库里有的题，页面上带题号/题型标签/空格/括号时还能不能命中
 *   node tools/e2e-kbrobust.mjs
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
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

let PAGE = '<html><body>ready</body></html>';
const web = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise(r => web.listen(8894, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await swT.worker();
  const extId = new URL(swT.url()).host;

  // 用户真实题库
  const kbText = fs.readFileSync(path.join(ROOT, 'demo', 'kb-sangfor.txt'), 'utf8');

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const st = await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    const a = await kb.addDocument({ name: 'kb-sangfor.txt', size: text.length, mime: 'text/plain', text });
    return { a, st: await kb.stats() };
  }, kbText);
  console.log('题库:', JSON.stringify(st.a), JSON.stringify(st.st));

  // 抽出前 N 条题干做"脏化"测试
  const cases = await opt.evaluate(async () => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    // 用一条全命中查询把条目取出来
    const all = await kb.search('客户 服务 规范 工单 现场 纪律', { topK: 40 });
    return all.map(h => ({
      q: String(h.entry.question || '').slice(0, 120),
      a: String(h.entry.answer || '').slice(0, 40),
      type: h.entry.type
    })).filter(x => x.q.length >= 8).slice(0, 12);
  });
  console.log('取到条目:', cases.length);

  // 三种"脏化"方式
  const dirty = {
    '原样': q => q,
    '加题号+题型标签': q => '1. 【单选题】' + q,
    '加空格/换行/全角括号': q => q.replace(/（/g, '（ ').replace(/）/g, ' ）') + '\n请选择一项'
  };

  let total = 0, hit = 0;
  const detail = [];
  for (const c of cases) {
    for (const [label, fn] of Object.entries(dirty)) {
      const stem = fn(c.q);
      const r = await opt.evaluate(async s => {
        const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
        const rows = await kb.search(s, { exactQuestion: s, topK: 3 });
        return rows.map(x => ({ exact: x.exact, cov: +x.coverage.toFixed(2), score: Math.round(x.score), q: String(x.entry.question).slice(0, 50) }));
      }, stem);
      total += 1;
      const ok = r.length > 0 && (r[0].exact || r[0].cov >= 0.8);
      if (ok) hit += 1;
      else detail.push({ label, stem: stem.slice(0, 42), top: r[0] || null });
    }
  }
  console.log(`\n命中率: ${hit}/${total} = ${Math.round(hit / total * 100)}%`);
  if (detail.length) {
    console.log('未命中样本:');
    detail.slice(0, 8).forEach(d => console.log('  [' + d.label + '] ' + d.stem + '  →  ' + JSON.stringify(d.top)));
  }
  check('脏题干命中率 ≥ 90%', hit / total >= 0.9, `${hit}/${total}`);

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
