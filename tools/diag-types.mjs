/** 题型判定诊断：逐题打印页面标签、class 与识别结果 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const SITE = 'D:\\labs\\深信服服务2.0\\exam-site';
const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const PORT = 8807;

const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const file = path.join(SITE, url);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const b = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: [`--disable-extensions-except=${ROOT}\\extension`, `--load-extension=${ROOT}\\extension`, '--no-first-run'],
  defaultViewport: { width: 1200, height: 1000 }
});
const sw = await b.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
const w = await sw.worker();

const p = await b.newPage();
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 700));
await p.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(x => /^开始考试$/.test(x.innerText.trim()));
  if (btn) btn.click();
});
await new Promise(r => setTimeout(r, 1800));

const tabId = await w.evaluate(async () => {
  const all = await chrome.tabs.query({});
  return (all.find(t => t.url && t.url.includes('127.0.0.1:8807')) || {}).id;
});

const rows = [];
for (let i = 0; i < 14; i++) {
  const info = await w.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => {
        const qcard = document.querySelector('#qcard') || document.querySelector('.qcard');
        const meta = qcard ? qcard.querySelector('.qmeta') : null;
        const badgeEls = meta ? [...meta.children].map(c => c.tagName.toLowerCase() + '.' + String(c.className).replace(/\s+/g, '.')) : [];
        const list = qxExtract.extractAll({});
        const q = list[0] || {};
        return {
          qnum: meta ? meta.innerText.replace(/\n/g, ' | ') : '(no meta)',
          metaChildren: badgeEls,
          qcardClass: qcard ? qcard.className : '',
          kind: q.kind,
          source: q.source,
          optCount: (q.options || []).length,
          stem: String(q.stem || '').slice(0, 40)
        };
      }
    });
    return r[0].result;
  }, tabId);
  rows.push(info);

  await p.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(x => /^下一题$/.test(x.innerText.trim()));
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 900));
}

console.log('题号 | 页面标签 | meta 子元素 class | 识别 kind | 选项数');
console.log('-'.repeat(110));
rows.forEach((r, i) => {
  console.log(`${String(i + 1).padStart(2)}  ${String(r.qnum).slice(0, 34).padEnd(36)} ${String(r.metaChildren.join(' ')).slice(0, 46).padEnd(48)} ${String(r.kind).padEnd(8)} ${r.optCount}`);
});

const expected = rows.map(r => {
  const t = String(r.qnum);
  if (/判断/.test(t)) return 'judge';
  if (/多选|多项/.test(t)) return 'multi';
  if (/单选|单项/.test(t)) return 'single';
  return '?';
});
const wrong = rows.map((r, i) => ({ i, exp: expected[i], got: r.kind })).filter(x => x.exp !== '?' && x.exp !== x.got);
console.log('\n期望 vs 实际：');
rows.forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}  期望 ${String(expected[i]).padEnd(7)} 实际 ${r.kind}  ${expected[i] === r.kind ? '✓' : '✗'}`));
console.log(`\n不一致 ${wrong.length} / ${rows.length}`);

await b.close();
server.close();
