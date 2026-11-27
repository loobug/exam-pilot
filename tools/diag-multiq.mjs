/** 诊断一页多题为什么只识别出 1 题 */
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

const N = 6;
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>一页多题</title>
<style>.q{margin:10px 0;padding:10px;border:1px solid #eee;border-radius:8px}.qtext{font-weight:700}
.option{display:inline-block;margin:4px 8px}</style></head><body>
${Array.from({ length: N }, (_, i) => `
<div class="q">
  <div class="qtext">第 ${i + 1} 题 ${["接到工单后多长时间内要主动联系客户？","进入客户现场对着装有什么要求？","四大纪律包括哪些内容？","信息安全红线有哪些？","服务完成后需要做什么？","客户投诉如何处理？"][i]}</div>
  <label class="option"><input type="radio" name="q${i}" value="A"><span>A. 一小时</span></label>
  <label class="option"><input type="radio" name="q${i}" value="B"><span>B. 两小时</span></label>
  <label class="option"><input type="radio" name="q${i}" value="C"><span>C. 30 分钟</span></label>
</div>`).join('')}
<script>window.__READY=true;</script></body></html>`;

const web = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise(r => web.listen(8902, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8902/', { waitUntil: 'domcontentloaded' });
  await sleep(800);

  const tabId = await (await swT.worker()).evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8902')) || {}).id;
  });
  const out = await (await swT.worker()).evaluate(async tid => {
    const r = await chrome.scripting.executeScript({ target: { tabId: tid }, func: () => {
    if (typeof qxExtract === 'undefined') return { error: 'qxExtract 未注入' };
    const withFb = qxExtract.extractAll({ fallback: true });
    const noFb = qxExtract.extractAll({});
    return {
      radios: document.querySelectorAll('input[type=radio]').length,
      qContainers: document.querySelectorAll('.q').length,
      withFallback: withFb.length,
      noFallback: noFb.length,
      detail: withFb.map(q => ({
        kind: q.kind,
        src: q.source,
        stem: String(q.stem).slice(0, 26),
        opts: (q.options || []).length
      })),
      probe: qxExtract.probeStructure()
    };
    }});
    return r[0].result;
  }, tabId);
  console.log(JSON.stringify(out, null, 1));

} catch (e) { console.error(e); }
finally { await browser.close(); web.close(); }
