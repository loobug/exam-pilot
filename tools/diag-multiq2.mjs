/** 深挖：一页多题时容器聚类与分组的中间结果 */
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

const QS = ['接到工单后多长时间内要主动联系客户？', '进入客户现场对着装有什么要求？', '四大纪律包括哪些内容？', '信息安全红线有哪些？', '服务完成后需要做什么？', '客户投诉如何处理？'];
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>多题</title>
<style>.q{margin:10px 0;padding:10px;border:1px solid #eee}.option{display:inline-block;margin:4px 8px}</style></head><body>
${QS.map((t, i) => `<div class="q"><div class="qtext">${i + 1}. ${t}</div>
<label class="option"><input type="radio" name="q${i}" value="A"><span>A. 甲</span></label>
<label class="option"><input type="radio" name="q${i}" value="B"><span>B. 乙</span></label>
<label class="option"><input type="radio" name="q${i}" value="C"><span>C. 丙</span></label></div>`).join('\n')}
<script>window.__READY=true;</script></body></html>`;

const web = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); });
await new Promise(r => web.listen(8903, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await swT.worker();
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8903/', { waitUntil: 'domcontentloaded' });
  await sleep(900);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8903')) || {}).id;
  });

  const out = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => {
        const res = qxExtract.extractAll({ fallback: true });
        // 手动复现容器聚类
        const inputs = [...document.querySelectorAll('input[type=radio],input[type=checkbox]')];
        const containers = new Set();
        inputs.forEach(inp => {
          let n = inp.parentElement, d = 0, fb = null;
          while (n && d++ < 16 && n !== document.documentElement) {
            const peers = n.querySelectorAll('input[type=radio],input[type=checkbox]');
            if (peers.length >= 2) { fb = n; break; }
            n = n.parentElement;
          }
          containers.add((fb || inp.parentElement).className || (fb || inp.parentElement).tagName);
        });
        return {
          radios: inputs.length,
          names: [...new Set(inputs.map(i => i.name))],
          containers: containers.size,
          extracted: res.length,
          stems: res.map(q => String(q.stem).slice(0, 24)),
          byInputs: (() => { try { const d = qxExtract.debugInfo(); return d.byInputs && d.byInputs.count; } catch (e) { return String(e.message); } })()
        };
      }
    });
    return r[0].result;
  }, tabId);

  console.log(JSON.stringify(out, null, 1));

} catch (e) { console.error(e); }
finally { await browser.close(); web.close(); }
