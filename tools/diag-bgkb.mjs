/** 在 background 上下文直接诊断知识库检索 */
import puppeteer from 'puppeteer-core';
import { findBrowser } from './find-browser.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const CHROME = findBrowser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});
try {
  const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await swTarget.worker();
  const extId = new URL(swTarget.url()).host;

  // 1) 在 options 页导入讲义
  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const KB = `一、服务响应时限
工单响应时限（SLA）规定：
常规工单：30 分钟内主动联系客户。
P1、P2 紧急工单：必须马上联系客户，不得等待。
超时未联系将计入考核。

二、着装规范
工作时间禁止穿短裤、凉鞋进入办公区。
`;
  const addRes = await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    const a = await kb.addDocument({ name: 'manual.txt', size: text.length, mime: 'text/plain', text });
    const st = await kb.stats();
    const rows = await kb.search('常规工单多少时间内主动联系客户 A. 一小时 B. 两小时 C. 30 分钟 D. 一天', {
      exactQuestion: '常规工单多少时间内主动联系客户', topK: 5
    });
    return { a, st, hits: rows.map(r => ({ s: Math.round(r.score), cov: +r.coverage.toFixed(2), exact: r.exact, q: String(r.entry.question).slice(0, 40), type: r.entry.type })) };
  }, KB);
  console.log('options 页导入/检索:', JSON.stringify(addRes, null, 1));

  // 2) 在 background 上下文检索同一份库
  const bg = await worker.evaluate(async () => {
    const kb = await import('./lib/kb.js');
    const st = await kb.stats();
    const rows = await kb.search('常规工单多少时间内主动联系客户 A. 一小时 B. 两小时 C. 30 分钟 D. 一天', {
      exactQuestion: '常规工单多少时间内主动联系客户', topK: 5
    });
    return { st, hits: rows.map(r => ({ s: Math.round(r.score), cov: +r.coverage.toFixed(2), exact: r.exact, q: String(r.entry.question).slice(0, 40), type: r.entry.type })) };
  });
  console.log('background 检索:', JSON.stringify(bg, null, 1));

} catch (e) { console.error(e); }
finally { await browser.close(); }
