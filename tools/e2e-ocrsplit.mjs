/**
 * 一张图里 5 道题：是否切成 5 个独立条目
 *   node tools/e2e-ocrsplit.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findBrowser } from './find-browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const CHROME = findBrowser();
const sleep = then => new Promise(r => setTimeout(r, then));

const results = [];
const check = (n, ok, d) => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

const DOCX = path.join(ROOT, 'demo', 'kb-5q.docx');
const b64 = fs.readFileSync(DOCX).toString('base64');

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 300000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 20000 });
  const worker = await swT.worker();
  const extId = new URL(swT.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'm', visionModel: '',
    ocrEngine: 'local', ocrDocImages: true,
    temperature: 0.2, maxTokens: 512, timeoutSec: 5, doubleCheck: false, autoFillAfterSolve: false,
    extraHeaders: '', systemPrompt: '', followMode: false, stealth: true, cacheEnabled: false,
    skipAnswered: false, concurrency: 1, kbEnabled: true, kbDirect: true, kbTopK: 8,
    kbStrict: false, flashOn: false, flashMs: 0, siteAllow: ''
  });

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  await sleep(600);

  const out = await opt.evaluate(async b64 => {
    const parse = await import(chrome.runtime.getURL('src/lib/parse.js'));
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();

    if (!window.mammoth) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = chrome.runtime.getURL('vendor/mammoth.browser.min.js');
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }

    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const file = new File([u8], 'kb-5q.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    const r = await parse.parseFile(file);
    const o = await parse.ocrDocImages(r.images || []);
    const merged = Object.assign({}, r, { text: (r.text || '') + '\n\n' + o.text });
    const res = await kb.addDocument(merged);
    const st = await kb.stats();

    const list = await kb.listEntries({ offset: 0, limit: 50 });
    // 逐题检索
    const probes = ['TCP 协议', '出去之前需要检查', '新法典', '项目移交', '质量红线'];
    const found = [];
    for (const kw of probes) {
      const hits = await kb.search(kw, { exactQuestion: kw, topK: 3 });
      found.push({ kw, n: hits.length, top: hits[0] ? String(hits[0].entry.question).slice(0, 30) : '' });
    }

    return {
      ocrQuestions: o.questions,
      ocrOk: o.ok,
      textLen: o.text.length,
      textHead: o.text.slice(0, 240),
      entries: res.entryCount,
      total: st.entries,
      rows: list.rows.map(x => ({ type: x.type, q: x.question.slice(0, 40) })),
      found
    };
  }, b64);

  console.log('OCR 切分出题数:', out.ocrQuestions, '（图片实际 5 道）');
  console.log('OCR 文本前 240 字:\n' + out.textHead);
  console.log('\n入库条目:', out.total, '条');
  console.log(JSON.stringify(out.rows, null, 1));
  console.log('\n逐题检索:', JSON.stringify(out.found, null, 1));

  check('OCR 切出至少 4 道题', out.ocrQuestions >= 4, String(out.ocrQuestions));
  check('入库条目数 ≥ 5', out.total >= 5, String(out.total));
  check('没有把整张图算成一个条目', out.total > 1, String(out.total));

  const distinct = new Set(out.found.map(f => f.top).filter(Boolean));
  check('5 个关键词命中不同的题', distinct.size >= 4, JSON.stringify([...distinct]));
  check('每个关键词都能检索到', out.found.every(f => f.n > 0), JSON.stringify(out.found.map(f => f.n)));

} catch (e) {
  check('运行未抛异常', false, e && e.message);
  console.error(e);
} finally {
  await browser.close();
  const bad = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
  process.exitCode = bad.length ? 1 : 0;
}
