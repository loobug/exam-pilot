/** 诊断真实考试页：dump DOM 结构与识别结果 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const SITE = 'D:\\labs\\深信服服务2.0\\exam-site';
const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const PORT = 8801;

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
await new Promise(r => setTimeout(r, 800));

// 首页按钮
const buttons = await p.evaluate(() => [...document.querySelectorAll('button')].map(x => x.innerText.trim()).slice(0, 12));
console.log('首页按钮：', JSON.stringify(buttons));

// 点"开始"类按钮进入答题
const clicked = await p.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(x => /^开始考试$/.test(x.innerText.trim()));
  if (btn) { btn.click(); return btn.innerText.trim(); }
  return null;
});
console.log('已点击：', clicked);
await new Promise(r => setTimeout(r, 2500));

const dom = await p.evaluate(() => {
  const qcard = document.querySelector('#qcard') || document.querySelector('.qcard');
  if (!qcard) return { error: 'no qcard', body: document.body.innerText.slice(0, 300) };
  const opt = qcard.querySelector('.option');
  return {
    qcardClass: qcard.className,
    qcardText: qcard.innerText.slice(0, 400),
    html: qcard.innerHTML.slice(0, 900),
    optionHTML: opt ? opt.outerHTML : null,
    optionInnerText: opt ? JSON.stringify(opt.innerText) : null,
    letterText: qcard.querySelector('.letter') ? qcard.querySelector('.letter').innerText : null,
    otextText: qcard.querySelector('.otext') ? qcard.querySelector('.otext').innerText : null,
    qtext: qcard.querySelector('.qtext') ? qcard.querySelector('.qtext').innerText : null,
    qnum: qcard.querySelector('.qnum') ? qcard.querySelector('.qnum').innerText : null,
    qmeta: qcard.querySelector('.qmeta') ? qcard.querySelector('.qmeta').innerText : null
  };
});
console.log('\n---- qcard DOM ----');
console.log(JSON.stringify(dom, null, 2).slice(0, 2200));

const tabId = await w.evaluate(async () => {
  const all = await chrome.tabs.query({});
  return (all.find(t => t.url && t.url.includes('127.0.0.1:8801')) || {}).id;
});
const info = await w.evaluate(async tid => {
  const r = await chrome.scripting.executeScript({
    target: { tabId: tid },
    func: () => {
      const out = { debug: qxExtract.debugInfo() };
      try { out.extract = qxExtract.extractAll({}); } catch (e) { out.err = String(e); }
      return out;
    }
  });
  return r[0].result;
}, tabId);

console.log('\n---- 识别结果 ----');
console.log(JSON.stringify(info.debug, null, 2).slice(0, 1500));
console.log('\n---- debug.error ----');
console.log(info.debug && info.debug.error ? info.debug.error : '(no error)');
console.log('\n---- probe（逐容器） ----');
console.log(JSON.stringify((info.debug && info.debug.probe) || [], null, 2).slice(0, 3000));
console.log('\n---- extractAll ----');
console.log(JSON.stringify((info.extract || []).map(q => ({ kind: q.kind, source: q.source, stem: String(q.stem).slice(0, 60), opts: (q.options || []).map(o => o.label + ':' + o.text.slice(0, 8)) })), null, 2));

await b.close();
server.close();
