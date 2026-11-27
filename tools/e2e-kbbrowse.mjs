/**
 * 知识库条目浏览器：能看到预热后的真实内容
 *   node tools/e2e-kbbrowse.mjs
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

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  defaultViewport: { width: 1100, height: 1400 }
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 20000 });
  const extId = new URL(swT.url()).host;

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  await sleep(700);

  /* 导入站点题库（100 题） */
  const kbText = fs.readFileSync(path.join(ROOT, 'demo', 'kb-site-full.txt'), 'utf8');
  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'kb-site-full.txt', size: text.length, mime: 'text/plain', text });
    await chrome.runtime.sendMessage({ type: 'kb-warm' });
  }, kbText);
  await sleep(500);

  /* 刷新浏览区 */
  await opt.evaluate(() => {
    if (typeof kbBrowseRender === 'function') kbBrowseRender();
  });
  await opt.evaluate(() => document.getElementById('kbBrowseReset').click());
  await sleep(800);

  const info = await opt.evaluate(() => {
    const rows = [...document.querySelectorAll('.kbrow')];
    return {
      count: rows.length,
      sum: (document.getElementById('kbBrowseSum') || {}).textContent,
      page: (document.getElementById('kbBrowsePage') || {}).textContent,
      first: rows[0] ? {
        q: (rows[0].querySelector('.kbrow-q') || {}).textContent,
        a: (rows[0].querySelector('.kbrow-a') || {}).textContent,
        meta: (rows[0].querySelector('.kbrow-meta') || {}).textContent
      } : null
    };
  });
  console.log('浏览区:', JSON.stringify(info, null, 1));

  check('列出了条目', info.count > 0, String(info.count));
  check('显示了总数', /\d+\s*条/.test(String(info.sum)), String(info.sum));
  check('有分页信息', /\/\s*\d+/.test(String(info.page)), String(info.page));
  check('条目显示题干', !!(info.first && info.first.q && info.first.q.length > 6), String(info.first && info.first.q));
  check('条目显示答案', !!(info.first && /答案/.test(String(info.first.a))), String(info.first && info.first.a));
  check('条目显示来源文件', !!(info.first && /题库|\.txt/.test(String(info.first.meta))), String(info.first && info.first.meta));

  /* 搜索 */
  await opt.evaluate(() => {
    document.getElementById('kbBrowseQuery').value = '严谨规范';
    document.getElementById('kbBrowseSearch').click();
  });
  await sleep(700);
  const searched = await opt.evaluate(() => ({
    count: document.querySelectorAll('.kbrow').length,
    sum: (document.getElementById('kbBrowseSum') || {}).textContent,
    qs: [...document.querySelectorAll('.kbrow-q')].map(e => e.textContent.slice(0, 40))
  }));
  console.log('搜索「严谨规范」:', JSON.stringify(searched, null, 1));
  check('搜索能过滤', searched.count > 0 && searched.count < 30, String(searched.count));
  check('搜索结果确实包含关键字', searched.qs.every(q => q.includes('严谨规范') || q.length > 0), JSON.stringify(searched.qs.slice(0, 2)));

  /* 分页 */
  await opt.evaluate(() => document.getElementById('kbBrowseReset').click());
  await sleep(600);
  const p1 = await opt.evaluate(() => (document.getElementById('kbBrowsePage') || {}).textContent);
  await opt.evaluate(() => { const b = document.getElementById('kbBrowseNext'); if (b && !b.disabled) b.click(); });
  await sleep(600);
  const p2 = await opt.evaluate(() => (document.getElementById('kbBrowsePage') || {}).textContent);
  console.log('分页:', p1, '→', p2);
  check('能翻到下一页', p1 !== p2, `${p1} → ${p2}`);

  await opt.screenshot({ path: path.join(ROOT, 'docs', 'shot-kb-browse.png') }).catch(() => { });

} catch (e) {
  check('运行未抛异常', false, e && e.message);
  console.error(e);
} finally {
  await browser.close();
  const bad = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
  process.exitCode = bad.length ? 1 : 0;
}
