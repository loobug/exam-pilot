/**
 * 端到端联调：真实 Chrome 加载扩展 → 打开测试页 → 全链路解题 → 校验填涂结果。
 *   node tools/e2e.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { startMockApi } from './mock-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const WEB_PORT = 8790;
const API_PORT = 8791;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png' };

function startStatic(dir, port) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(dir, url === '/' ? '/exam-demo.html' : url);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('404');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)));
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function summarise(list) {
  return list.map(q => `  [${q.index}] ${q.kind.padEnd(6)} ${q.source.padEnd(10)} ${String(q.stem).replace(/\s+/g, ' ').slice(0, 46)}${q.options && q.options.length ? ' | ' + q.options.map(o => o.label).join('') : ''}${q.blanks ? ' | 空x' + q.blanks : ''}`).join('\n');
}

(async () => {
  const mockServer = await startMockApi(API_PORT);
  const staticServer = await startStatic(path.join(ROOT, 'demo'), WEB_PORT);
  console.log('mock api  : http://127.0.0.1:' + API_PORT + '/v1');
  console.log('static web: http://127.0.0.1:' + WEB_PORT + '/');

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=DialMediaRouteProvider'
    ],
    defaultViewport: { width: 1300, height: 960 }
  });

  try {
    const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
    const worker = await swTarget.worker();
    check('扩展 service worker 启动', !!worker);

    // 写入测试配置
    await worker.evaluate(async settings => {
      await chrome.storage.local.set({ settings });
    }, {
      baseUrl: 'http://127.0.0.1:' + API_PORT + '/v1',
      apiKey: 'mock-key',
      model: 'mock-model',
      visionModel: 'mock-vision',
      temperature: 0.2,
      maxTokens: 2048,
      timeoutSec: 60,
      doubleCheck: false,
      autoFillAfterSolve: true,
      extraHeaders: '',
      systemPrompt: '',
      followMode: false,
      stealth: false
    });

    await new Promise(r => setTimeout(r, 600));
    const readBack = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
    check('测试配置已写入 storage', readBack && readBack.apiKey === 'mock-key', JSON.stringify(readBack && readBack.baseUrl));

    const page = await browser.newPage();
    page.on('console', m => {
      const txt = m.text();
      if (/\[exa\]/.test(txt)) console.log('  [页面日志] ' + txt);
    });
    page.on('pageerror', e => console.log('  [页面异常] ' + e.message));
    await page.goto('http://127.0.0.1:' + WEB_PORT + '/exam-demo.html', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 700));

    const tabId = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:8790/*' });
      return tab && tab.id;
    });
    check('拿到活动标签页', !!tabId, 'tabId=' + tabId);

    // ---- 识别 ----
    const collected = await worker.evaluate(async tid => {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tid, allFrames: true },
        func: () => {
          const list = qxExtract.extractAll({ fallback: true });
          return { isTop: window.top === window, list };
        }
      });
      const flat = [];
      for (const f of r) {
        if (!f.result || !f.result.isTop) continue;
        flat.push(...f.result.list);
      }
      return flat;
    }, tabId);

    console.log('\n识别结果：\n' + summarise(collected) + '\n');
    check('题目数量 = 6', collected.length === 6, '实际 ' + collected.length);

    const byKind = k => collected.filter(q => q.kind === k);
    check('单选识别 2 道（含点击型）', byKind('single').length === 2, '实际 ' + byKind('single').length);
    check('多选识别 1 道', byKind('multi').length === 1);
    check('判断识别 1 道', byKind('judge').length === 1);
    check('填空识别 1 道且 2 个空', byKind('fill').length === 1 && byKind('fill')[0].blanks === 2,
      byKind('fill')[0] ? 'blanks=' + byKind('fill')[0].blanks : 'missing');
    check('简答识别 1 道', byKind('short').length === 1);
    const q6 = collected.find(q => /主键|关系数据库/.test(q.stem));
    check('点击型选项（无 input）也识别到', !!q6 && q6.options.length === 4, q6 ? q6.options.map(o => o.label + o.text).join('/') : 'missing');

    // ---- 解题 + 自动填涂 ----
    await worker.evaluate(async tid => {
      await chrome.tabs.sendMessage(tid, { type: 'cmd-solve-all' });
    }, tabId);

    await new Promise(r => setTimeout(r, 1200));
    const deadline = Date.now() + 90000;
    let filled = null;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 800));
      filled = await page.evaluate(() => ({
        q1: (document.querySelector('input[name=q1]:checked') || {}).value || null,
        q2: Array.from(document.querySelectorAll('input[name=q2]:checked')).map(x => x.value).sort().join(''),
        q3: (document.querySelector('input[name=q3]:checked') || {}).value || null,
        q4a: document.querySelector('[name=q4a]').value,
        q4b: document.querySelector('[name=q4b]').value,
        q5: document.querySelector('[name=q5]').value,
        q6: (document.querySelector('#q6 .opt2.on') || {}).textContent || null
      }));
      if (filled.q1 && filled.q2 && filled.q3 && filled.q4a && filled.q4b && filled.q5 && filled.q6) break;
    }

    console.log('\n页面填涂状态：', JSON.stringify(filled, null, 0) + '\n');
    check('单选 q1 选中 C', filled.q1 === 'C', '实际 ' + filled.q1);
    check('多选 q2 勾选 A+C', filled.q2 === 'AC', '实际 ' + filled.q2);
    check('判断 q3 选中「错」(B)', filled.q3 === 'B', '实际 ' + filled.q3);
    check('填空 q4 两空分别填入', filled.q4a && filled.q4b && filled.q4b.includes('340'),
      filled.q4a + ' | ' + filled.q4b);
    check('简答 q5 写入正文', !!filled.q5 && filled.q5.length > 20, (filled.q5 || '').slice(0, 40));
    check('点击型 q6 选中「主键」', !!filled.q6 && /主键/.test(filled.q6), String(filled.q6));

    // ---- 界面截图 ----
    await page.screenshot({ path: path.join(ROOT, 'docs', 'shot-panel.png') });
    check('面板截图已保存', fs.existsSync(path.join(ROOT, 'docs', 'shot-panel.png')));

    // ---- 面板挂载状态（默认不挂载，打开后才有宿主；宿主不带可识别属性）----
    const mounted = await worker.evaluate(async tid => {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: () => globalThis.__EXA_DEBUG__ ? globalThis.__EXA_DEBUG__.uiMounted() : null
      });
      return r[0].result;
    }, tabId);
    check('面板已按需挂载', mounted === true, 'mounted=' + mounted);
    const hostAttrs = await page.evaluate(() => {
      const hosts = [...document.documentElement.children].filter(el => el.shadowRoot === null && el.tagName === 'DIV' && el.style.position === 'fixed');
      return hosts.map(el => [...el.attributes].map(a => a.name).join(','));
    });
    check('面板宿主不带可识别属性', hostAttrs.every(a => !/exa|helper|exam/i.test(a)), JSON.stringify(hostAttrs));

  } catch (e) {
    check('运行未抛异常', false, e && e.stack ? e.stack.split('\n')[0] : String(e));
    console.error(e);
  } finally {
    await browser.close();
    mockServer.close();
    staticServer.close();
    const bad = results.filter(r => !r.ok);
    console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
    process.exit(bad.length ? 1 : 0);
  }
})();

