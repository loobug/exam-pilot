/** 截图：移除目录卡片后的知识库区域 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findBrowser } from './find-browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const CHROME = findBrowser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  defaultViewport: { width: 980, height: 1300 }
});
try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const extId = new URL(swT.url()).host;
  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  await sleep(700);

  const check = await opt.evaluate(() => ({
    dirCard: !!document.querySelector('.kbdir'),
    bindBtn: !!document.getElementById('kbBindDir'),
    pickMain: !!document.getElementById('kbPickDirMain'),
    drop: !!document.getElementById('kbDrop'),
    fileInput: !!document.getElementById('kbFile'),
    warm: !!document.getElementById('kbWarm'),
    clear: !!document.getElementById('kbClear'),
    stats: (document.getElementById('kbStats') || {}).textContent
  }));
  console.log('知识库区域:', JSON.stringify(check, null, 1));

  const card = await opt.$('.card:nth-of-type(2)');
  await opt.screenshot({ path: path.join(ROOT, 'docs', 'shot-kb-clean.png'), fullPage: false }).catch(() => { });
  console.log('截图: docs/shot-kb-clean.png');
} catch (e) { console.error(e); }
finally { await browser.close(); }
