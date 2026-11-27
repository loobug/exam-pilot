/**
 * 选项指纹兜底：题干措辞不同、选项一致时也应命中
 *   node tools/e2e-optfp.mjs
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

/* 三种页面：题干同、题干改写、题干大改（选项都一致，且顺序与题库不同） */
const CASES = [
  {
    id: 'same',
    stem: '项目移交时必须包含以下哪项资料？',
    expect: 'A',
    desc: '题干一致'
  },
  {
    id: 'reword',
    stem: '在做项目移交的时候，必须包含下面哪一项资料？',
    expect: 'A',
    desc: '题干改写（同义）'
  },
  {
    id: 'far',
    stem: '移交项目时应当提供下列哪种材料？',
    expect: 'A',
    desc: '题干大改（仅选项一致）'
  }
];

const pageFor = c => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${c.id}</title>
<style>body{font:15px/1.7 system-ui;margin:20px}.qtext{font-weight:700;margin-bottom:10px}.option{display:block;margin:6px 0}</style>
</head><body><div class="q">
  <div class="qtext">${c.stem}</div>
  <label class="option"><input type="radio" name="q" value="A"><span>A. 项目设计方案（售前方案）</span></label>
  <label class="option"><input type="radio" name="q" value="B"><span>B. 项目经验总结</span></label>
  <label class="option"><input type="radio" name="q" value="C"><span>C. 项目初步验收报告</span></label>
  <label class="option"><input type="radio" name="q" value="D"><span>D. 客户评价结果</span></label>
</div></body></html>`;

let port = 8912;
const servers = [];
for (const c of CASES) {
  const html = pageFor(c);
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); });
  await new Promise(r => srv.listen(port, '127.0.0.1', r));
  c.port = port; c.url = `http://127.0.0.1:${port}/`;
  servers.push(srv);
  port++;
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await swT.worker();
  const extId = new URL(swT.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', visionModel: '',
    temperature: 0.2, maxTokens: 512, timeoutSec: 5, doubleCheck: false, autoFillAfterSolve: false,
    extraHeaders: '', systemPrompt: '', followMode: false, stealth: true, cacheEnabled: false,
    skipAnswered: false, concurrency: 1, kbEnabled: true, kbDirect: true, kbTopK: 5,
    kbStrict: false, flashMs: 0, siteAllow: ''
  });

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const kbText = fs.readFileSync(path.join(ROOT, 'demo', 'kb-sangfor.txt'), 'utf8');
  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'kb-sangfor.txt', size: text.length, mime: 'text/plain', text });
    await chrome.runtime.sendMessage({ type: 'kb-warm' });
  }, kbText);

  for (const c of CASES) {
    const page = await browser.newPage();
    await page.goto(c.url, { waitUntil: 'domcontentloaded' });
    await sleep(600);
    const tabId = await worker.evaluate(async u => {
      const all = await chrome.tabs.query({});
      return (all.find(t => t.url && t.url.startsWith(u)) || {}).id;
    }, c.url);

    const out = await worker.evaluate(async tid => {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: async () => {
          const d = globalThis.__EXA_DEBUG__;
          d.clearResults();
          const list = await d.extract();
          const kb = await d.kbCheck();
          await d.solveAll();
          const res = d.results();
          await d.fillOne(0);
          return {
            mode: kb && kb.mode,
            exact: kb && kb.exact,
            answer: kb && kb.answer,
            topQ: kb && kb.hits && kb.hits[0] && kb.hits[0].q,
            picked: [...document.querySelectorAll('input:checked')].map(i => i.value),
            src: res[0] && res[0].source && res[0].source.kind
          };
        }
      });
      return r[0].result;
    }, tabId);

    console.log(`\n[${c.desc}] ${c.stem}`);
    console.log('  ', JSON.stringify(out));
    check(`${c.desc}：命中知识库`, out.mode === 'kb', `mode=${out.mode}`);
    check(`${c.desc}：选对 ${c.expect}`, Array.isArray(out.picked) && out.picked.includes(c.expect), JSON.stringify(out.picked));
    await page.close();
  }

} catch (e) {
  check('运行未抛异常', false, e && e.message);
  console.error(e);
} finally {
  await browser.close();
  servers.forEach(s => s.close());
  const bad = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
  process.exitCode = bad.length ? 1 : 0;
}
