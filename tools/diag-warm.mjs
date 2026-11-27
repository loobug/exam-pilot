/** 验证知识库预热是否真的在跑，以及耗时 */
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
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});
try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await swT.worker();
  const extId = new URL(swT.url()).host;

  // 页面控制台日志
  const swLogs = [];
  worker.on('console', m => swLogs.push(m.text()));

  console.log('=== 1) SW 刚启动时（预热应已排程） ===');
  const boot = await worker.evaluate(async () => ({
    hasWarmupHook: typeof warmupKb === 'function',
    hasSelf: typeof self.__exaReinjectAll === 'function'
  })).catch(e => ({ error: String(e.message) }));
  console.log(JSON.stringify(boot));

  // 等预热窗口
  await sleep(1200);

  // 导入题库
  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const kbText = fs.readFileSync(path.join(ROOT, 'demo', 'kb-sangfor.txt'), 'utf8');

  const before = await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'k.txt', size: text.length, mime: 'text/plain', text });
    const t = performance.now();
    await kb.search('预热', { topK: 1 });
    return { st: await kb.stats(), coldMs: Math.round(performance.now() - t) };
  }, kbText);
  console.log('\n=== 2) 导入后首次检索（options 上下文，冷） ===');
  console.log(JSON.stringify(before));

  // 触发后台预热消息
  const warm = await opt.evaluate(async () => {
    const t = performance.now();
    const r = await chrome.runtime.sendMessage({ type: 'kb-warm' });
    return { res: r, ms: Math.round(performance.now() - t) };
  });
  console.log('\n=== 3) 发 kb-warm 后 ===');
  console.log(JSON.stringify(warm));

  // 再测 background 侧检索耗时
  const bgTiming = await opt.evaluate(async () => {
    // 通过 kbTest 消息走后台检索路径
    const t = performance.now();
    const r = await chrome.runtime.sendMessage({
      type: 'kbTest',
      question: '工单响应时限',
      options: [{ label: 'A', text: '30 分钟内' }, { label: 'B', text: '两小时' }]
    });
    return { ms: Math.round(performance.now() - t), mode: r && r.mode, hits: r && r.hits && r.hits.length };
  });
  console.log('\n=== 4) 后台检索路径耗时 ===');
  console.log(JSON.stringify(bgTiming));

  console.log('\n=== SW 控制台输出 ===');
  swLogs.filter(l => /exa|热|索引/.test(l)).slice(-10).forEach(l => console.log('  ' + l));

} catch (e) { console.error(e); }
finally { await browser.close(); }
