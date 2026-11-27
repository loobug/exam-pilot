/**
 * 全题库逐条核对：把题库每一条当成"页面题"重新查询，看是否答成别的题
 *   node tools/diag-kbconflict.mjs
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

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 240000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await swT.worker();
  const extId = new URL(swT.url()).host;

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const kbText = fs.readFileSync(path.join(ROOT, 'demo', 'kb-sangfor.txt'), 'utf8');

  const out = await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'kb-sangfor.txt', size: text.length, mime: 'text/plain', text });

    // 取出全部条目
    const db = await new Promise((res, rej) => {
      const q = indexedDB.open('exa-kb', 2);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    const entries = await new Promise(res => {
      const tx = db.transaction('entries', 'readonly');
      const rq = tx.objectStore('entries').getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => res([]);
    });

    // 只看 qa 类（有题干+答案）
    const qa = entries.filter(e => e.type === 'qa' && e.question && e.answer);
    const rows = [];

    for (const e of qa) {
      // 用该条自己的题干 + 选项，模拟"页面上出现了这道题"
      const optsRaw = String(e.raw || '');
      const optMap = {};
      optsRaw.split('\n').forEach(line => {
        const m = line.match(/^\s*([A-H])\s*[.、．)）]\s*(.+)$/);
        if (m) optMap[m[1]] = m[2].trim();
      });
      const options = Object.keys(optMap).sort().map(k => ({ label: k, text: optMap[k] }));
      const pageFp = options.map(o => o.text).sort().join('|');

      const hits = await kb.search(e.question, { exactQuestion: e.question, pageFp, topK: 3 });
      const top = hits[0];
      rows.push({
        q: String(e.question).slice(0, 34),
        a: String(e.answer).slice(0, 8),
        hitQ: top ? String(top.entry.question).slice(0, 34) : '',
        hitA: top ? String(top.entry.answer).slice(0, 8) : '',
        exact: !!(top && top.exact),
        sim: top ? Number((top.sim != null ? top.sim : top.coverage || 0).toFixed(2)) : 0,
        selfHit: !!(top && top.entry.question === e.question),
        ansSame: !!(top && String(top.entry.answer).trim() === String(e.answer).trim())
      });
    }
    return rows;
  }, kbText);

  console.log(`共 ${out.length} 条问答\n`);
  const selfMiss = out.filter(r => !r.selfHit);
  const ansBad = out.filter(r => r.selfHit && !r.ansSame);

  console.log(`自命中（查到的是自己）: ${out.length - selfMiss.length}/${out.length}`);
  console.log(`查到别人: ${selfMiss.length}`);
  console.log(`答案不一致: ${ansBad.length}`);

  if (selfMiss.length) {
    console.log('\n=== 查到的不是自己（错配）===');
    selfMiss.forEach(r => {
      console.log(`  本题: ${r.q}  答案 ${r.a}`);
      console.log(`  错配: ${r.hitQ}  答案 ${r.hitA}  exact=${r.exact} sim=${r.sim}`);
    });
  }
  if (ansBad.length) {
    console.log('\n=== 命中自己但答案不同 ===');
    ansBad.forEach(r => console.log(`  ${r.q} 库=${r.a} 取到=${r.hitA}`));
  }

  /* 重点看严谨规范那两条 */
  const focus = out.filter(r => /严谨规范|风险识别/.test(r.q));
  console.log('\n=== 严谨规范相关条目 ===');
  focus.forEach(r => console.log(`  ${r.q} | 答案 ${r.a} → 查到 ${r.hitQ} (${r.hitA}) exact=${r.exact} sim=${r.sim}`));

  fs.writeFileSync(path.join(ROOT, 'docs', 'kb-conflict.json'), JSON.stringify(out, null, 1));

} catch (e) { console.error(e); }
finally { await browser.close(); }
