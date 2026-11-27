/**
 * 知识库链路端到端验证：
 *   导入文件 → 范式化 → BM25 检索 → 解题时命中直答 → 来源标注 → 填涂
 *   node tools/e2e-kb.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { startMockApi } from './mock-api.mjs';
import { findBrowser } from './find-browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHROME = findBrowser();
const WEB_PORT = 8794;
const API_PORT = 8795;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };

function startStatic(dir, port) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(dir, url === '/' ? '/exam-demo.html' : url);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('404');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)));
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const mockServer = await startMockApi(API_PORT);
  const staticServer = await startStatic(path.join(ROOT, 'demo'), WEB_PORT);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-first-run', '--no-default-browser-check'
    ],
    protocolTimeout: 180000,
    defaultViewport: { width: 1300, height: 1000 }
  });

  try {
    const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
    const worker = await swTarget.worker();
    const extId = new URL(swTarget.url()).host;
    check('扩展启动', !!worker, 'id=' + extId);

    await worker.evaluate(async settings => {
      await chrome.storage.local.set({ settings });
    }, {
      baseUrl: 'http://127.0.0.1:' + API_PORT + '/v1',
      apiKey: 'mock-key', model: 'mock-model', visionModel: 'mock-vision',
      temperature: 0.2, maxTokens: 2048, timeoutSec: 60,
      doubleCheck: false, autoFillAfterSolve: true,
      extraHeaders: '', systemPrompt: '',
      kbEnabled: true, kbDirect: true, followMode: false, stealth: false
    });

    /* ---------- 1. 导入知识库 ---------- */
    const opt = await browser.newPage();
    await opt.setViewport({ width: 1000, height: 1400 });
    await opt.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: 'networkidle0' });

    const files = [
      { name: 'kb-sample.txt', text: fs.readFileSync(path.join(ROOT, 'demo', 'kb-sample.txt'), 'utf8') },
      { name: 'kb-notes.md', text: fs.readFileSync(path.join(ROOT, 'demo', 'kb-notes.md'), 'utf8') }
    ];

    const imported = await opt.evaluate(async fs_ => {
      const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
      await kb.clearAll();
      const added = [];
      for (const f of fs_) {
        added.push(await kb.addDocument({ name: f.name, size: f.text.length, mime: 'text/plain', text: f.text }));
      }
      if (typeof refreshKB === 'function') await refreshKB();
      return { added, stats: await kb.stats(), docs: await kb.listDocs() };
    }, files);

    console.log('\n导入结果：', JSON.stringify(imported.stats), imported.added.map(a => a.strategy + ':' + a.entryCount).join(' / '), '\n');
    check('两个文件都建成索引', imported.docs.length === 2, imported.docs.map(d => `${d.name}(${d.strategy},${d.entryCount})`).join(' '));
    check('题库文件按「题目-答案」切分', imported.added[0].strategy === 'qa' && imported.added[0].entryCount >= 5, 'strategy=' + imported.added[0].strategy + ' 条目=' + imported.added[0].entryCount);
    check('笔记文件解析出术语条目', imported.added[1].entryCount >= 5, '条目=' + imported.added[1].entryCount);
    check('总条目数 ≥ 10', imported.stats.entries >= 10, '实际 ' + imported.stats.entries);

    /* ---------- 2. 检索质量 ---------- */
    const searchRes = await opt.evaluate(async () => {
      const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
      const a = await kb.search('一个物体在水平面上做匀速直线运动，则它受到的合外力（ ） A 方向与速度相同 B 方向与速度相反 C 等于零 D 大小恒定但方向不断改变',
        { topK: 3, exactQuestion: '一个物体在水平面上做匀速直线运动，则它受到的合外力（ ）。' });
      const b = await kb.search('HTTPS 相比 HTTP 有哪些安全改进', { topK: 3, exactQuestion: '' });
      const c = await kb.search('今天天气怎么样', { topK: 3, exactQuestion: '' });
      const fmt = arr => arr.map(h => ({ q: h.entry.question.slice(0, 28), a: h.entry.answer.slice(0, 20), exact: h.exact, cov: Math.round(h.coverage * 100), score: Math.round(h.score), doc: h.entry.docName }));
      return { exact: fmt(a), related: fmt(b), noise: fmt(c) };
    });

    console.log('\n检索示例：\n  精确题 →', JSON.stringify(searchRes.exact[0]), '\n  HTTPS →', JSON.stringify(searchRes.related[0]), '\n  无关词 →', JSON.stringify(searchRes.noise[0] || null), '\n');
    check('原题检索精确命中', searchRes.exact[0] && searchRes.exact[0].exact === true && /^C\b/.test(searchRes.exact[0].a), JSON.stringify(searchRes.exact[0]));
    check('术语检索能命中 HTTPS 条目', searchRes.related.length > 0 && /HTTPS/i.test(searchRes.related[0].q), JSON.stringify(searchRes.related[0]));
    check('无关查询不误报精确命中', !searchRes.noise[0] || searchRes.noise[0].exact === false, JSON.stringify(searchRes.noise[0] || null));

    /* ---------- 3. 解题时命中知识库 ---------- */
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${WEB_PORT}/exam-demo.html`, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 800));

    const tabId = await worker.evaluate(async () => {
      const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1:' + location.port + '/*' }).catch(() => []);
      if (t) return t.id;
      const all = await chrome.tabs.query({});
      return (all.find(x => x.url && x.url.includes('exam-demo')) || {}).id;
    });
    check('拿到标签页', !!tabId, 'tabId=' + tabId);

    await worker.evaluate(async tid => {
      await chrome.tabs.sendMessage(tid, { type: 'cmd-solve-all' });
    }, tabId);

    let solved = [];
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 900));
      solved = await worker.evaluate(async tid => {
        const r = await chrome.scripting.executeScript({
          target: { tabId: tid },
          func: () => (globalThis.__EXA_DEBUG__ ? globalThis.__EXA_DEBUG__.results() : [])
        });
        return (r && r[0] && r[0].result) || [];
      }, tabId);
      const filled = await page.evaluate(() => ({
        q1: (document.querySelector('input[name=q1]:checked') || {}).value || null,
        q2: Array.from(document.querySelectorAll('input[name=q2]:checked')).map(x => x.value).sort().join(''),
        q3: (document.querySelector('input[name=q3]:checked') || {}).value || null,
        q6: (document.querySelector('#q6 .opt2.on') || {}).textContent || null
      }));
      if (solved.length >= 6 && filled.q1 && filled.q2 && filled.q3 && filled.q6) break;
    }

    console.log('\n解题结果（含来源）：');
    solved.sort((a, b) => a.index - b.index).forEach(r => {
      console.log(`  [${r.index}] ${String(r.kind).padEnd(7)} ${String(r.answer).slice(0, 22).padEnd(24)} source=${r.source ? r.source.kind : 'n/a'}${r.source && r.source.hits && r.source.hits.length ? ' ← ' + r.source.hits[0].docName : ''}`);
    });
    console.log('');

    const byIdx = i => solved.find(r => r.index === i) || {};
    check('识别并完成 6 题', solved.length === 6, '实际 ' + solved.length);

    [0, 1, 2, 5].forEach(i => {
      const r = byIdx(i);
      check(`第 ${i + 1} 题由知识库直答`, r.source && r.source.kind === 'kb',
        r.source ? r.source.kind + (r.source.hits && r.source.hits[0] ? ' · ' + r.source.hits[0].docName : '') : 'missing');
    });

    check('知识库答案正确（合外力=C）', String(byIdx(0).answer || '').trim() === 'C', String(byIdx(0).answer));
    check('知识库答案正确（多选=AC）', String(byIdx(1).answer || '').trim() === 'AC', String(byIdx(1).answer));
    check('知识库答案正确（判断=错）', String(byIdx(2).answer || '').trim() === '错', String(byIdx(2).answer));
    check('知识库答案正确（主键=B）', String(byIdx(5).answer || '').trim() === 'B', String(byIdx(5).answer));

    const aiOrMixed = ['ai', 'kb+ai'];
    check('题库外的题走模型（第 4 题）', aiOrMixed.includes(byIdx(3).source && byIdx(3).source.kind), String(byIdx(3).source && byIdx(3).source.kind));

    const filled = await page.evaluate(() => ({
      q1: (document.querySelector('input[name=q1]:checked') || {}).value || null,
      q2: Array.from(document.querySelectorAll('input[name=q2]:checked')).map(x => x.value).sort().join(''),
      q3: (document.querySelector('input[name=q3]:checked') || {}).value || null,
      q4a: document.querySelector('[name=q4a]').value,
      q5: document.querySelector('[name=q5]').value,
      q6: (document.querySelector('#q6 .opt2.on') || {}).textContent || null
    }));
    console.log('页面实际填涂：', JSON.stringify(filled), '\n');
    check('填涂结果正确', filled.q1 === 'C' && filled.q2 === 'AC' && filled.q3 === 'B' && !!filled.q4a && filled.q5.length > 10 && /主键/.test(filled.q6), JSON.stringify(filled));

    // 截图仅用于留档，超时不影响功能判定
    await new Promise(r => setTimeout(r, 1500));
    let shotOk = false;
    try {
      await page.screenshot({ path: path.join(ROOT, 'docs', 'shot-kb-panel.png'), timeout: 30000 });
      shotOk = fs.existsSync(path.join(ROOT, 'docs', 'shot-kb-panel.png'));
    } catch (e) {
      console.log('  [提示] 面板截图失败：' + e.message);
    }
    try {
      await opt.screenshot({ path: path.join(ROOT, 'docs', 'shot-kb-options.png'), fullPage: true, timeout: 30000 });
    } catch (e) {
      console.log('  [提示] 设置页截图失败：' + e.message);
    }
    if (shotOk) check('面板截图已保存', true, 'docs/shot-kb-panel.png');
    else console.log('  [提示] 面板截图跳过（仅留档用，不影响功能）');

  } catch (e) {
    check('运行未抛异常', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
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

