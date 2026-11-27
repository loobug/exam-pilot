/**
 * docx 带图片：导入时是否把图片内容 OCR 进知识库
 *   node tools/e2e-docximg.mjs
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (n, ok, d) => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

const DOCX = path.join(ROOT, 'demo', 'kb-with-image.docx');

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
  const logs = [];
  opt.on('console', m => logs.push(m.text()));
  opt.on('pageerror', e => logs.push('ERR: ' + e.message));
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  await sleep(600);

  /* 清空知识库 */
  await opt.evaluate(async () => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
  });

  /* 1) 先直接看 parseFile 能不能拿到图片 */
  const parsed = await opt.evaluate(async b64 => {
    const parse = await import(chrome.runtime.getURL('src/lib/parse.js'));
    // 需要确保 mammoth 已加载
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
    const file = new File([u8], 'kb-with-image.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const r = await parse.parseFile(file);
    return {
      textLen: (r.text || '').length,
      textHead: String(r.text || '').slice(0, 60),
      images: (r.images || []).length,
      firstImgLen: r.images && r.images[0] ? r.images[0].length : 0
    };
  }, fs.readFileSync(DOCX).toString('base64'));

  console.log('解析结果:', JSON.stringify(parsed, null, 1));
  check('docx 正文解析出来了', parsed.textLen > 20, String(parsed.textLen));
  check('提取到文档内图片', parsed.images > 0, String(parsed.images));
  check('图片转成了 dataURL', parsed.firstImgLen > 2000, String(parsed.firstImgLen));

  /* 2) 对图片做本地 OCR */
  const t0 = Date.now();
  const ocr = await opt.evaluate(async b64 => {
    const parse = await import(chrome.runtime.getURL('src/lib/parse.js'));
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const file = new File([u8], 'x.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const r = await parse.parseFile(file);
    const o = await parse.ocrDocImages(r.images || []);
    return { ok: o.ok, failed: o.failed, text: o.text.slice(0, 300) };
  }, fs.readFileSync(DOCX).toString('base64'));
  const ocrMs = Date.now() - t0;

  console.log('\nOCR 结果（' + ocrMs + 'ms）:');
  console.log(ocr.text || '(空)');
  check('图片 OCR 成功', ocr.ok > 0, `ok=${ocr.ok} failed=${ocr.failed}`);
  check('OCR 出题干', /TCP/.test(ocr.text), ocr.text.slice(0, 50));
  check('OCR 出选项', /[A-D]\s*[.、]/.test(ocr.text), '');

  /* 3) 完整入库：正文 + 图片文字 */
  const full = await opt.evaluate(async b64 => {
    const parse = await import(chrome.runtime.getURL('src/lib/parse.js'));
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const file = new File([u8], 'kb-with-image.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    const r = await parse.parseFile(file);
    const o = await parse.ocrDocImages(r.images || []);
    const merged = Object.assign({}, r, { text: (r.text || '') + '\n\n' + o.text });
    const res = await kb.addDocument(merged);

    // 用图片里的题干去检索
    const hits = await kb.search('下列关于 TCP 协议的说法，正确的是', {
      exactQuestion: '下列关于 TCP 协议的说法，正确的是（ ）', topK: 5
    });
    const st = await kb.stats();
    return {
      entries: res.entryCount,
      total: st.entries,
      hits: hits.length,
      topQ: hits[0] ? String(hits[0].entry.question).slice(0, 50) : '',
      topText: hits[0] ? String(hits[0].entry.raw || '').slice(0, 120) : ''
    };
  }, fs.readFileSync(DOCX).toString('base64'));

  console.log('\n入库结果:', JSON.stringify(full, null, 1));
  check('文档已入库', full.total > 0, String(full.total));
  check('能从图片内容检索到题库条目', full.hits > 0, `hits=${full.hits}`);

  const errs = logs.filter(l => /ERR|error/i.test(l)).slice(0, 5);
  check('无页面报错', errs.length === 0, errs.join(' | '));

} catch (e) {
  check('运行未抛异常', false, e && e.message);
  console.error(e);
} finally {
  await browser.close();
  const bad = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
  process.exitCode = bad.length ? 1 : 0;
}
