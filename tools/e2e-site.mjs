/**
 * 真实考试站点验证（深信服客户服务规范 2.0 模拟考试）
 *   node tools/e2e-site.mjs
 * 重点：题干是否干净、选项是否识别、填入是否生效
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockApi } from './mock-api.mjs';

const SITE = 'D:\\labs\\深信服服务2.0\\exam-site';
const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';
const WEB_PORT = 8803;
const API_PORT = 8804;

const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const file = path.join(SITE, url);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(WEB_PORT, '127.0.0.1', r));
const mock = await startMockApi(API_PORT);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const NOISE = ['答题卡', '第 1 / 25 题', '请选择', '请判断', '已答', '当前题'];

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: [`--disable-extensions-except=${ROOT}\\extension`, `--load-extension=${ROOT}\\extension`, '--no-first-run', '--no-default-browser-check'],
  defaultViewport: { width: 1320, height: 1000 }
});

try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await sw.worker();

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:' + API_PORT + '/v1',
    apiKey: 'mock-key', model: 'mock-model', visionModel: '',
    temperature: 0.2, maxTokens: 2048, timeoutSec: 60,
    doubleCheck: false, autoFillAfterSolve: false,
    extraHeaders: '', systemPrompt: '',
    kbEnabled: true, kbDirect: true, cacheEnabled: false, skipAnswered: true, followMode: false, stealth: false, concurrency: 1
  });
  await sleep(300);

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`, { waitUntil: 'domcontentloaded' });
  await sleep(700);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(x => /^开始考试$/.test(x.innerText.trim()));
    if (btn) btn.click();
  });
  await sleep(2000);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8803')) || {}).id;
  });
  check('页面已进入答题状态', !!tabId, 'tabId=' + tabId);

  const runExtract = async () => {
    const r = await worker.evaluate(async tid => {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: () => {
          const t0 = performance.now();
          const list = qxExtract.extractAll({});
          return { list, ms: Math.round(performance.now() - t0) };
        }
      });
      return res[0].result;
    }, tabId);
    return r;
  };

  const first = await runExtract();
  const q1 = (first.list || [])[0] || {};
  console.log('\n第 1 题识别：', JSON.stringify({
    kind: q1.kind, source: q1.source, stem: q1.stem && q1.stem.slice(0, 60),
    opts: (q1.options || []).map(o => o.label + ':' + o.text.slice(0, 12)), ms: first.ms
  }, null, 2));

  check('识别出且仅识别出 1 道题', (first.list || []).length === 1, '实际 ' + (first.list || []).length);
  check('题型正确（判断题）', q1.kind === 'judge', '实际 ' + q1.kind);
  check('选项数量正确（2 个）', (q1.options || []).length === 2, '实际 ' + (q1.options || []).length);
  check('选项文本正确', (q1.options || []).every(o => /正确|错误/.test(o.text)), JSON.stringify((q1.options || []).map(o => o.text)));
  const stemNoise = NOISE.filter(n => String(q1.stem || '').includes(n));
  check('题干不含答题卡/题号/提示语噪音', stemNoise.length === 0, stemNoise.length ? '含 ' + stemNoise.join(',') : '干净');
  check('题干长度合理', String(q1.stem || '').length >= 8 && String(q1.stem || '').length <= 300, '长度 ' + String(q1.stem || '').length);
  check('题干以中文内容开头（无「判断题」标签）', !/^(判断题|单选题|多选题)/.test(String(q1.stem || '')), String(q1.stem || '').slice(0, 12));
  check('识别耗时 < 800ms', first.ms < 800, first.ms + 'ms');

  // 解题 + 填涂
  const solveInfo = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        await globalThis.__EXA_DEBUG__.solveAll();
        const res = globalThis.__EXA_DEBUG__.results();
        return res;
      }
    });
    return r[0].result;
  }, tabId);
  await sleep(600);

  const filledState = await page.evaluate(() => {
    const on = document.querySelector('#qcard .option.on');
    return {
      selected: on ? on.innerText.replace(/\n/g, '').trim() : null,
      optionCount: document.querySelectorAll('#qcard .option').length
    };
  });
  console.log('\n解题来源：', JSON.stringify((solveInfo || []).map(r => ({ kind: r.kind, answer: r.answer, src: r.source && r.source.kind }))));
  console.log('页面选中状态：', JSON.stringify(filledState));

  check('解题返回结果', (solveInfo || []).length === 1, '实际 ' + (solveInfo || []).length);

  // 单题填涂
  const fillReport = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => globalThis.__EXA_DEBUG__.fillOne(0)
    });
    return r[0].result;
  }, tabId);
  await sleep(700);
  const afterFill = await page.evaluate(() => {
    const on = document.querySelector('#qcard .option.on');
    return {
      selected: on ? on.innerText.replace(/\n/g, '').trim() : null,
      pressed: on ? on.getAttribute('aria-pressed') : null
    };
  });
  console.log('填入后：', JSON.stringify(afterFill), ' fillOne 返回：', JSON.stringify(fillReport));
  check('页面上的选项被点中（.option.on 出现）', !!afterFill.selected, JSON.stringify(afterFill));
  await page.screenshot({ path: path.join(ROOT, 'docs', 'shot-site.png') }).catch(() => { });

  // 下一题：题干应变化且仍然干净
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(x => /^下一题$/.test(x.innerText.trim()));
    if (btn) btn.click();
  });
  await sleep(1200);
  const second = await runExtract();
  const q2 = (second.list || [])[0] || {};
  console.log('\n第 2 题识别：', JSON.stringify({
    kind: q2.kind, stem: q2.stem && q2.stem.slice(0, 60), opts: (q2.options || []).length
  }, null, 2));
  check('换题后仍只识别 1 道', (second.list || []).length === 1, '实际 ' + (second.list || []).length);
  check('换题后题干随之变化', String(q2.stem) !== String(q1.stem), String(q2.stem || '').slice(0, 24));
  check('换题后题干仍然干净', !NOISE.some(n => String(q2.stem || '').includes(n)), String(q2.stem || '').slice(0, 24));

  // 多选题专项：切到"练习模式"抽 100 题里含多选题
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(x => /^下一题$/.test(x.innerText.trim()));
    if (btn) btn.click();
  });
  await sleep(900);
  const third = await runExtract();
  const q3 = (third.list || [])[0] || {};
  check('第 3 题识别正常', (third.list || []).length === 1 && String(q3.stem || '').length >= 8,
    `${q3.kind} | ${String(q3.stem || '').slice(0, 30)} | 选项 ${(q3.options || []).length} 个`);

  /* ---------- 多选题：翻到多选题并验证能选多个 ---------- */
  let multiQ = null;
  for (let i = 0; i < 12; i++) {
    const cur = await runExtract();
    const q = (cur.list || [])[0] || {};
    if (q.kind === 'multi') { multiQ = q; break; }
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(x => /^下一题$/.test(x.innerText.trim()));
      if (btn) btn.click();
    });
    await sleep(800);
  }
  check('翻到多选题并被识别为 multi', !!multiQ, multiQ ? `选项 ${(multiQ.options || []).length} 个` : '12 次翻页内未遇到多选题');

  if (multiQ) {
    const reExtract = await worker.evaluate(async tid => {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: async () => {
          const list = await globalThis.__EXA_DEBUG__.extract();
          return { n: list.length, kind: list[0] && list[0].kind, stem: list[0] && String(list[0].stem).slice(0, 30) };
        }
      });
      return r[0].result;
    }, tabId);
    console.log('重新识别后：', JSON.stringify(reExtract));
    await sleep(300);
    const rep = await worker.evaluate(async tid => {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: async () => {
          await globalThis.__EXA_DEBUG__.solveAll();
          const res = globalThis.__EXA_DEBUG__.results();
          // 直接用底层 fillByIndex 拿详细日志
          const detail = qxFill.fillByIndex(0, { kind: 'multi', answer: (res[0] && res[0].answer) || 'AB' }, {});
          const cached = qxExtract.getCache()[0];
          return {
            res, detail,
            refs: cached ? { optCount: (cached.refs.options || []).length, hasEl: (cached.refs.options || []).every(o => !!o.el) } : null
          };
        }
      });
      return r[0].result;
    }, tabId);
    await sleep(700);
    const multiState = await page.evaluate(() => ({
      picked: [...document.querySelectorAll('#qcard .option.on')].map(el => el.innerText.replace(/\n/g, '').trim()),
      count: document.querySelectorAll('#qcard .option.on').length
    }));
    const repOne = (rep && rep.res) ? rep.res[0] : (rep && rep[0]) || {};
    console.log('多选题填涂：', JSON.stringify({ answer: repOne.answer, detail: rep && rep.detail, refs: rep && rep.refs, ...multiState }, null, 1));
    check('多选题识别为 multi 且答案为两个选项', repOne.kind === 'multi' && String(repOne.answer).length >= 2,
      `kind=${repOne.kind} answer=${repOne.answer}`);
    check('多选题页面确实选中了 2 个选项', multiState.count === 2, JSON.stringify(multiState.picked));
  }

} catch (e) {
  check('运行未抛异常', false, e && e.message);
  console.error(e);
} finally {
  await browser.close();
  server.close();
  mock.close();
  const bad = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
  process.exit(bad.length ? 1 : 0);
}
