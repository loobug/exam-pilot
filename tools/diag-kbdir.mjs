/** 用假目录句柄验证「选择目录并绑定」的完整流程 */
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
  defaultViewport: { width: 980, height: 1400 }
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const extId = new URL(swT.url()).host;

  const opt = await browser.newPage();
  const logs = [];
  opt.on('console', m => logs.push(m.type() + ': ' + m.text()));
  opt.on('pageerror', e => logs.push('PAGEERROR: ' + e.message));
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  await sleep(800);

  console.log('1) 初始状态:', await opt.evaluate(() => (document.getElementById('kbDirState') || {}).textContent));

  /* 注入假目录句柄：一个含 1 个 txt 文件的目录 */
  const injected = await opt.evaluate(() => {
    const kbText = '1. 测试题目内容是什么？\nA. 甲\nB. 乙\n答案：A\n\n2. 第二道测试题目？\nA. 丙\nB. 丁\n答案：B\n';
    const file = new File([kbText], 'demo.txt', { type: 'text/plain', lastModified: Date.now() });

    const fakeHandle = {
      kind: 'directory',
      name: '我的题库',
      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
      async isSameEntry(other) { return other && other.name === '我的题库'; },
      async *entries() {
        yield ['demo.txt', {
          kind: 'file',
          name: 'demo.txt',
          async getFile() { return file; }
        }];
      }
    };
    window.__FAKE_DIR__ = fakeHandle;
    window.showDirectoryPicker = async () => fakeHandle;
    return { hasPicker: typeof window.showDirectoryPicker === 'function' };
  });
  console.log('2) 已注入假句柄:', JSON.stringify(injected));

  /* 点击「选择目录并绑定」 */
  await opt.evaluate(() => document.getElementById('kbBindDir').click());
  await sleep(2500);

  const after = await opt.evaluate(() => ({
    dir: (document.getElementById('kbDirState') || {}).textContent,
    stats: (document.getElementById('kbStats') || {}).textContent,
    status: (document.querySelector('#status, .status') || {}).textContent
  }));
  console.log('3) 绑定后:', JSON.stringify(after, null, 1));

  /* 直接看 IndexedDB 里有没有存句柄 */
  const stored = await opt.evaluate(async () => {
    return await new Promise(resolve => {
      const req = indexedDB.open('exa-fs', 1);
      req.onerror = () => resolve({ error: 'open fail' });
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('handles')) return resolve({ error: 'no store' });
        const tx = db.transaction('handles', 'readonly');
        const g = tx.objectStore('handles').get('kbDir');
        g.onsuccess = () => resolve({ has: !!g.result, name: g.result && g.result.name });
        g.onerror = () => resolve({ error: String(g.error) });
      };
    });
  });
  console.log('4) IDB 中的句柄:', JSON.stringify(stored));

  /* 知识库条目数 */
  const kbStat = await opt.evaluate(async () => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    return await kb.stats();
  });
  console.log('5) 知识库:', JSON.stringify(kbStat));

  /* 页面控制台 */
  const errs = logs.filter(l => /ERROR|PAGEERROR|error/i.test(l));
  if (errs.length) {
    console.log('\n页面错误:');
    errs.slice(0, 8).forEach(l => console.log('  ' + l));
  } else {
    console.log('\n无页面错误');
  }

  await opt.screenshot({ path: path.join(ROOT, 'docs', 'shot-kbdir-debug.png') }).catch(() => { });

} catch (e) { console.error(e); }
finally { await browser.close(); }
