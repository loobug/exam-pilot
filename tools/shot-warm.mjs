/** 截图：设置页里的知识库预热状态 */
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
  executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  defaultViewport: { width: 980, height: 1400 }
});
try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const extId = new URL(swT.url()).host;

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  await sleep(400);

  // 先看未预热状态
  const s1 = await opt.evaluate(() => (document.getElementById('kbWarmState') || {}).textContent);
  console.log('初始：', s1);

  // 导入题库
  const kbText = fs.readFileSync(path.join(ROOT, 'demo', 'kb-sangfor.txt'), 'utf8');
  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'kb-sangfor.txt', size: text.length, mime: 'text/plain', text });
    await chrome.runtime.sendMessage({ type: 'kb-warm' });
  }, kbText);

  // 点"立即预热"按钮
  await opt.evaluate(() => {
    const b = document.getElementById('kbWarm');
    if (b) b.click();
  });
  await sleep(1200);

  const s2 = await opt.evaluate(() => (document.getElementById('kbWarmState') || {}).textContent);
  console.log('预热后：', s2);

  const el = await opt.$('#kbWarmState');
  const box = await el.boundingBox();
  await opt.screenshot({
    path: path.join(ROOT, 'docs', 'shot-kb-warm.png'),
    clip: { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 200), width: 940, height: 320 }
  }).catch(async () => { await opt.screenshot({ path: path.join(ROOT, 'docs', 'shot-kb-warm.png') }); });
  console.log('截图已存 docs/shot-kb-warm.png');

} catch (e) { console.error(e); }
finally { await browser.close(); }
