/**
 * 装载目录冒烟测试：确认 extension/ 能被 Chrome 正常加载
 *   node tools/smoke.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findBrowser } from './find-browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const CHROME = findBrowser();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

/* 1. 静态检查 */
check('extension/manifest.json 存在', fs.existsSync(path.join(EXT, 'manifest.json')));
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
check('manifest 版本号合法', /^\d+\.\d+\.\d+$/.test(manifest.version), manifest.version);
check('manifest_version 为 3', manifest.manifest_version === 3);
const needFiles = [
  'src/background.js', 'src/content/content.js', 'src/content/extract.js',
  'src/options/options.html', 'src/popup/popup.html',
  'icons/icon16.png', 'icons/icon128.png',
  'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs',
  'vendor/mammoth.browser.min.js', 'vendor/xlsx.full.min.js'
];
const missing = needFiles.filter(f => !fs.existsSync(path.join(EXT, f)));
check('关键文件齐全', missing.length === 0, missing.length ? '缺 ' + missing.join(', ') : needFiles.length + ' 个文件');

/* 2. 真机加载 */
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, 'demo', url === '/' ? '/exam-demo.html' : url);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(8799, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 120000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check'],
  defaultViewport: { width: 1200, height: 900 }
});

try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 }).catch(() => null);
  check('Chrome 成功加载装载目录（service worker 启动）', !!sw, sw ? sw.url().slice(0, 80) : '未启动');
  if (!sw) throw new Error('扩展未加载');

  const extId = new URL(sw.url()).host;
  const worker = await sw.worker();

  const opt = await browser.newPage();
  await opt.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: 'domcontentloaded' });
  const optInfo = await opt.evaluate(() => ({
    title: document.title,
    hasKbPanel: !!document.getElementById('kbDrop'),
    hasCache: !!document.getElementById('cacheEnabled'),
    hasConcurrency: !!document.getElementById('concurrency'),
    hasSave: !!document.getElementById('save')
  }));
  check('设置页可打开且控件完整',
    optInfo.hasKbPanel && optInfo.hasCache && optInfo.hasConcurrency && optInfo.hasSave,
    JSON.stringify(optInfo));

  const p = await browser.newPage();
  await p.goto('http://127.0.0.1:8799/exam-demo.html', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 900));
  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('exam-demo')) || {}).id;
  });
  const injected = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => ({
        hasDebug: !!globalThis.__EXA_DEBUG__,
        hasExtract: typeof qxExtract !== 'undefined',
        hasFill: typeof qxFill !== 'undefined',
        hasOverlay: typeof qxOverlay !== 'undefined',
        count: globalThis.__EXA_DEBUG__ ? globalThis.__EXA_DEBUG__.questions().length : -1
      })
    });
    return r[0].result;
  }, tabId);
  check('内容脚本注入正常', injected.hasExtract && injected.hasFill && injected.hasOverlay && injected.hasDebug,
    JSON.stringify(injected));

  const identified = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({ target: { tabId: tid }, func: () => qxExtract.extractAll({}) });
    return (r[0].result || []).length;
  }, tabId);
  check('识别引擎可用（测试卷 6 题）', identified === 6, '实际 ' + identified);

  const perms = await worker.evaluate(async () => (await chrome.permissions.getAll()).permissions);
  check('权限声明正确', perms.includes('storage') && perms.includes('scripting') && perms.includes('unlimitedStorage'),
    perms.join(','));

} catch (e) {
  check('冒烟测试未抛异常', false, e && e.message);
} finally {
  await browser.close();
  server.close();
  const bad = checks.filter(c => !c.ok);
  console.log(`\n装载目录：${EXT}`);
  console.log(`===== ${checks.length - bad.length}/${checks.length} 项通过 =====`);
  process.exit(bad.length ? 1 : 0);
}
