/** 通用诊断：node tools/diag-url.mjs <url> [staticDir] */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const URL_ARG = process.argv[2];
const DIR = process.argv[3] || null;
const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const PORT = 8802;

let server = null;
if (DIR) {
  server = http.createServer((req, res) => {
    let url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/') url = '/index.html';
    const file = path.join(DIR, url);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
}

const b = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: [`--disable-extensions-except=${ROOT}\\extension`, `--load-extension=${ROOT}\\extension`, '--no-first-run'],
  defaultViewport: { width: 1200, height: 1000 }
});
const sw = await b.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
const w = await sw.worker();

const p = await b.newPage();
await p.goto(URL_ARG, { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 1200));

const tabId = await w.evaluate(async u => {
  const all = await chrome.tabs.query({});
  return (all.find(t => t.url && t.url.includes(u.split('/').pop())) || all[0]).id;
}, URL_ARG);

const res = await w.evaluate(async tid => {
  const r = await chrome.scripting.executeScript({
    target: { tabId: tid },
    func: () => ({ debug: qxExtract.debugInfo(), out: qxExtract.extractAll({}) })
  });
  return r[0].result;
}, tabId);

console.log('---- byTextBlock ----');
console.log(JSON.stringify(res.debug.byTextBlock, null, 2));
console.log('---- probe ----');
console.log(JSON.stringify(res.debug.probe || [], null, 2).slice(0, 2600));
console.log('---- extractAll ----');
console.log(JSON.stringify((res.out || []).map(q => ({
  kind: q.kind, source: q.source, score: q.score,
  stem: String(q.stem).slice(0, 70),
  opts: (q.options || []).map(o => o.label + ':' + o.text.slice(0, 10))
})), null, 2));

await b.close();
if (server) server.close();
