/**
 * 结构陌生的页面：纯文本兜底是否生效
 *   node tools/e2e-weird.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const WEB_PORT = 8848;
const API_PORT = 8849;
const MIME = { '.html': 'text/html; charset=utf-8' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, 'demo', url === '/' ? '/exam-weird.html' : url);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(WEB_PORT, '127.0.0.1', r));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: [`--disable-extensions-except=${ROOT}\\extension`, `--load-extension=${ROOT}\\extension`, '--no-first-run'],
  defaultViewport: { width: 1100, height: 900 }
});

try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await sw.worker();
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      settings: {
        baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', visionModel: '',
        temperature: 0.2, maxTokens: 512, timeoutSec: 10, doubleCheck: false, autoFillAfterSolve: false,
        extraHeaders: '', systemPrompt: '', kbEnabled: false, cacheEnabled: false,
        followMode: false, stealth: true, skipAnswered: false, concurrency: 1, flashMs: 0
      }
    });
  });

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${WEB_PORT}/exam-weird.html`, { waitUntil: 'domcontentloaded' });
  await sleep(600);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8848')) || {}).id;
  });

  const out = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => {
        try {
        if (typeof qxExtract === "undefined") return { error: "qxExtract 未注入" };
        const viaStructured = qxExtract.extractAll({});
        const viaPlain = qxExtract.scanPlainText();
        return {
          structured: viaStructured.map(q => ({
            kind: q.kind, stem: String(q.stem).slice(0, 24),
            opts: (q.options || []).map(o => o.label + ':' + String(o.text).slice(0, 8))
          })),
          plain: viaPlain.map(q => ({
            kind: q.kind, stem: String(q.stem).slice(0, 24),
            opts: (q.options || []).map(o => o.label + ':' + String(o.text).slice(0, 8))
          }))
        };
        } catch (e) { return { error: String(e && e.message || e), stack: String(e && e.stack || "").slice(0, 500) }; }
      }
    });
    return r[0].result;
  }, tabId);

  console.log('\n原始返回:', JSON.stringify(out));
  console.log('\n结构化识别:', JSON.stringify(out.structured, null, 1));
  console.log('\n纯文本切分:', JSON.stringify(out.plain, null, 1));

  check('纯文本兜底切出 3 道题', out.plain.length === 3, out.plain.length + ' 题');
  check('每题都解析出 4 个选项', out.plain.every(q => q.opts.length === 4), JSON.stringify(out.plain.map(q => q.opts.length)));
  check('选项挤一行也能拆开', out.plain.length > 0 && out.plain[0].opts.length === 4, JSON.stringify(out.plain[0] && out.plain[0].opts));
  check('第 3 题识别为多选', out.plain[2] && out.plain[2].kind === 'multi', out.plain[2] && out.plain[2].kind);
  check('题干干净（去掉题号）', out.plain.length > 0 && !/^\d+[.、]/.test(out.plain[0].stem), out.plain[0] && out.plain[0].stem);

  const final = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => qxExtract.extractAll({}).map(q => ({ kind: q.kind, src: q.source, stem: String(q.stem).slice(0, 20) }))
    });
    return r[0].result;
  }, tabId);
  console.log('\nextractAll 最终结果:', JSON.stringify(final, null, 1));
  check('extractAll 能给出结果（结构或兜底）', final.length >= 3, final.length + ' 题');

} catch (e) {
  check('运行未抛异常', false, e && e.message);
  console.error(e);
} finally {
  await browser.close();
  server.close();
  const bad = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
  process.exitCode = bad.length ? 1 : 0;
}
