/** 直接打开 offscreen 页面，看 Tesseract 到底是哪一步卡住 */
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

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 20000 });
  const extId = new URL(swT.url()).host;
  console.log('扩展 ID:', extId);

  /* 资源可达性 */
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => logs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message));
  page.on('requestfailed', r => logs.push('REQFAIL: ' + r.url() + ' ' + (r.failure() || {}).errorText));

  await page.goto('chrome-extension://' + extId + '/src/offscreen/offscreen.html', { waitUntil: 'domcontentloaded' });
  await sleep(3000);

  const info = await page.evaluate(() => ({
    hasTesseract: typeof window.Tesseract === 'object' || typeof window.Tesseract === 'function',
    tesseractKeys: window.Tesseract ? Object.keys(window.Tesseract).slice(0, 12) : [],
    log: (document.getElementById('log') || {}).textContent
  }));
  console.log('\n页面状态:', JSON.stringify(info, null, 1));

  /* 手动跑一次 createWorker，逐步看 */
  const manual = await page.evaluate(async () => {
    const steps = [];
    try {
      steps.push('Tesseract=' + (typeof window.Tesseract));
      if (!window.Tesseract) return { steps, error: 'Tesseract 未加载' };
      steps.push('createWorker 类型=' + typeof window.Tesseract.createWorker);
      const url = location.origin;
      steps.push('origin=' + url);
      const w = await Promise.race([
        window.Tesseract.createWorker('chi_sim', 1, {
          workerPath: url + '/vendor/tesseract/worker.min.js',
          corePath: url + '/vendor/tesseract',
          langPath: url + '/vendor/tessdata',
          gzip: false,
          workerBlobURL: false,
          cacheMethod: 'none',
          logger: m => { if (m && m.status) steps.push('log:' + m.status + ' ' + (m.progress || 0)); }
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('createWorker 60s 超时')), 60000))
      ]);
      steps.push('worker 创建成功');
      const r = await w.recognize('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
      steps.push('recognize ok: ' + JSON.stringify(r && r.data && r.data.text));
      await w.terminate();
      return { steps };
    } catch (e) {
      steps.push('ERROR: ' + (e && e.message || e));
      return { steps };
    }
  });

  console.log('\n=== 手动 createWorker ===');
  manual.steps.forEach(s => console.log('  ' + s));

  console.log('\n=== 控制台 ===');
  logs.slice(0, 30).forEach(l => console.log('  ' + l));

} catch (e) { console.error(e); }
finally { await browser.close(); }
