/**
 * 深度优化项验证：页面已有答案 / 答案缓存 / 不覆盖已作答 / 撤销填涂 / 存入知识库 / 导出
 *   node tools/e2e-opt.mjs
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
const WEB_PORT = 8796;
const API_PORT = 8797;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function mockStats() {
  const res = await fetch(`http://127.0.0.1:${API_PORT}/stats`);
  return res.json();
}

(async () => {
  const mockServer = await startMockApi(API_PORT);
  const staticServer = await startStatic(path.join(ROOT, 'demo'), WEB_PORT);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 180000,
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-first-run', '--no-default-browser-check'
    ],
    defaultViewport: { width: 1300, height: 1000 }
  });

  try {
    const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
    const worker = await swTarget.worker();
    check('扩展启动', !!worker);

    await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
      baseUrl: 'http://127.0.0.1:' + API_PORT + '/v1',
      apiKey: 'mock-key', model: 'mock-model', visionModel: 'mock-vision',
      temperature: 0.2, maxTokens: 2048, timeoutSec: 60,
      doubleCheck: false, autoFillAfterSolve: true,
      extraHeaders: '', systemPrompt: '',
      kbEnabled: true, kbDirect: true, cacheEnabled: true, cacheTtlDays: 7, skipAnswered: true,
      followMode: false, stealth: false
    });
    await sleep(400);

    const debug = async (page, action, arg) => {
      const tabId = await worker.evaluate(async url => {
        const all = await chrome.tabs.query({});
        return (all.find(t => t.url && t.url.includes(url)) || {}).id;
      }, page.__mark);
      const r = await worker.evaluate(async (tid, act, a) => {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tid },
          func: (action, arg) => {
            const d = globalThis.__EXA_DEBUG__;
            if (!d) return { error: 'no-debug' };
            switch (action) {
              case 'results': return d.results();
              case 'questions': return d.questions();
              case 'solveAll': return d.solveAll();
              case 'solve': return d.solve(arg);
              case 'solveForce': return d.solveForce(arg);
              case 'clearResults': return d.clearResults();
              case 'saveToKb': return d.saveToKb(arg);
              case 'exportText': return d.exportText();
              case 'undo': return d.undo();
              case 'fillOne': return d.fillOne(arg);
              default: return { error: 'unknown-action ' + action };
            }
          },
          args: [act, a === undefined ? null : a]
        });
        return (res && res[0] && res[0].result);
      }, tabId, action, arg);
      return r;
    };

    /* ---------------- 1. 页面已有答案 ---------------- */
    const pAns = await browser.newPage();
    pAns.__mark = 'exam-answers';
    await pAns.goto(`http://127.0.0.1:${WEB_PORT}/exam-answers.html`, { waitUntil: 'domcontentloaded' });
    await sleep(800);

    let stats0 = await mockStats();
    await debug(pAns, 'solveAll');
    await sleep(2500);
    const ansResults = await debug(pAns, 'results');
    const ansQs = await debug(pAns, 'questions');
    console.log('\n页面答案页结果：');
    (ansResults || []).sort((a, b) => a.index - b.index).forEach(r => {
      console.log(`  [${r.index}] ${r.kind} → ${r.answer}  source=${r.source && r.source.kind}`);
    });
    console.log('  识别到的 pageAnswer：', JSON.stringify((ansQs || []).map(q => q.pageAnswer && q.pageAnswer.answer)));

    const byI = (list, i) => (list || []).find(x => x.index === i) || {};
    check('页面答案页识别出 4 题', (ansQs || []).length === 4, '实际 ' + (ansQs || []).length);
    check('4 题都识别到页面答案', (ansQs || []).every(q => q.pageAnswer && q.pageAnswer.answer), JSON.stringify((ansQs || []).map(q => q.pageAnswer && q.pageAnswer.answer)));
    check('文本标注的答案正确（1=C）', String(byI(ansResults, 0).answer || '') === 'C', String(byI(ansResults, 0).answer));
    check('class 高亮的答案正确（2=AC）', String(byI(ansResults, 1).answer || '') === 'AC', String(byI(ansResults, 1).answer));
    check('判断题答案正确（3=对）', String(byI(ansResults, 2).answer || '') === '对', String(byI(ansResults, 2).answer));
    check('第 4 题答案正确（B）', String(byI(ansResults, 3).answer || '') === 'B', String(byI(ansResults, 3).answer));
    check('全部来源标为「页面已有答案」', (ansResults || []).every(r => r.source && r.source.kind === 'page'),
      JSON.stringify((ansResults || []).map(r => r.source && r.source.kind)));
    let stats1 = await mockStats();
    check('页面已有答案时不调用模型', stats1.requests === stats0.requests, `请求数 ${stats0.requests} → ${stats1.requests}`);

    /* ---------------- 2. 不覆盖已有作答 ---------------- */
    const pMain = await browser.newPage();
    pMain.__mark = 'exam-demo';
    await pMain.goto(`http://127.0.0.1:${WEB_PORT}/exam-demo.html`, { waitUntil: 'domcontentloaded' });
    await sleep(800);
    // 模拟用户自己先答了 q1 = A（错误答案）
    await pMain.evaluate(() => document.querySelector('input[name=q1][value=A]').click());

    await debug(pMain, 'solveAll');
    await sleep(6000);

    const afterFill = await pMain.evaluate(() => ({
      q1: (document.querySelector('input[name=q1]:checked') || {}).value || null,
      q2: Array.from(document.querySelectorAll('input[name=q2]:checked')).map(x => x.value).sort().join(''),
      q3: (document.querySelector('input[name=q3]:checked') || {}).value || null,
      q4a: document.querySelector('[name=q4a]').value
    }));
    console.log('\n填入后（skipAnswered=true）：', JSON.stringify(afterFill));
    check('用户已答的 q1 未被覆盖', afterFill.q1 === 'A', '实际 ' + afterFill.q1);
    check('其余题目正常填入', afterFill.q2 === 'AC' && afterFill.q3 === 'B' && !!afterFill.q4a,
      JSON.stringify({ q2: afterFill.q2, q3: afterFill.q3, q4a: afterFill.q4a }));

    /* ---------------- 3. 撤销填涂 ---------------- */
    await debug(pMain, 'undo');
    await sleep(1200);
    const afterUndo = await pMain.evaluate(() => ({
      q1: (document.querySelector('input[name=q1]:checked') || {}).value || null,
      q2: Array.from(document.querySelectorAll('input[name=q2]:checked')).map(x => x.value).sort().join(''),
      q3: (document.querySelector('input[name=q3]:checked') || {}).value || null,
      q4a: document.querySelector('[name=q4a]').value
    }));
    console.log('撤销后：', JSON.stringify(afterUndo));
    check('撤销后 q2/q3 恢复为空', afterUndo.q2 === '' && afterUndo.q3 === null, JSON.stringify(afterUndo));
    check('撤销保留用户原来的 q1=A', afterUndo.q1 === 'A', '实际 ' + afterUndo.q1);

    /* ---------------- 4. 答案缓存 ---------------- */
    stats1 = await mockStats();
    await debug(pMain, 'clearResults');
    await debug(pMain, 'solveAll');
    await sleep(4000);
    const cached = await debug(pMain, 'results');
    const stats2 = await mockStats();
    console.log('\n二次解题来源：', JSON.stringify((cached || []).map(r => r.source && r.source.kind)));
    check('二次解题全部命中缓存', (cached || []).length >= 6 && (cached || []).every(r => r.source && r.source.kind === 'cache'),
      JSON.stringify((cached || []).map(r => r.source && r.source.kind)));
    check('命中缓存不再请求模型', stats2.requests === stats1.requests, `请求数 ${stats1.requests} → ${stats2.requests}`);

    // 面板上点「重解」必须绕过缓存，否则用户会以为重解无效
    const statsBeforeForce = await mockStats();
    await debug(pMain, 'solveForce', 0);
    await sleep(2000);
    const forced = await debug(pMain, 'results');
    const statsAfterForce = await mockStats();
    const forcedOne = (forced || []).find(r => r.index === 0) || {};
    check('重解绕过缓存并重新请求模型',
      statsAfterForce.requests > statsBeforeForce.requests && forcedOne.source && forcedOne.source.kind !== 'cache',
      `请求数 ${statsBeforeForce.requests} → ${statsAfterForce.requests}，来源 ${forcedOne.source && forcedOne.source.kind}`);

    /* ---------------- 5. 存入知识库 ---------------- */
    const extId = new URL(swTarget.url()).host;
    const optPage = await browser.newPage();
    await optPage.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
    await sleep(500);
    const beforeKb = await optPage.evaluate(async () => {
      const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
      return (await kb.stats()).entries;
    });
    await debug(pMain, 'saveToKb', 0);
    await sleep(1200);
    const afterKb = await optPage.evaluate(async () => {
      const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
      const st = await kb.stats();
      const hits = await kb.search('一个物体在水平面上做匀速直线运动 合外力', { topK: 3, exactQuestion: '一个物体在水平面上做匀速直线运动，则它受到的合外力（ ）。' });
      return { entries: st.entries, exact: hits[0] ? hits[0].exact : null, answer: hits[0] ? hits[0].entry.answer : null };
    });
    console.log('\n存库后知识库：', JSON.stringify(afterKb));
    check('存入知识库后条目 +1', afterKb.entries === beforeKb + 1, `${beforeKb} → ${afterKb.entries}`);
    check('新条目可被精确命中', afterKb.exact === true && String(afterKb.answer) === 'C', JSON.stringify(afterKb));

    const statsBeforeKb = await mockStats();
    await debug(pMain, 'clearResults');
    await debug(pMain, 'solve', 0);
    await sleep(1500);
    const kbRes = await debug(pMain, 'results');
    const statsAfterKb = await mockStats();
    const first = (kbRes || []).find(r => r.index === 0) || {};
    check('存库后同题改走知识库', first.source && first.source.kind === 'kb', JSON.stringify(first.source && first.source.kind));
    check('走知识库不再请求模型', statsAfterKb.requests === statsBeforeKb.requests, `请求数 ${statsBeforeKb.requests} → ${statsAfterKb.requests}`);

    /* ---------------- 6. 导出 ---------------- */
    const text = await debug(pMain, 'exportText');
    const preview = String(text || '').slice(0, 160).replace(/\n/g, ' | ');
    console.log('\n导出预览：', preview, '…');
    check('导出内容包含题号与答案', String(text).includes('## 1.') && String(text).includes('**答案：**'), preview);
    check('导出内容标注来源', /来源：(知识库|AI|缓存|页面答案)/.test(String(text)), '');
    check('导出内容标记知识库来源', /来源：知识库/.test(String(text)), '');

    await pMain.screenshot({ path: path.join(ROOT, 'docs', 'shot-opt-panel.png') }).catch(() => { });

  } catch (e) {
    check('运行未抛异常', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
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
