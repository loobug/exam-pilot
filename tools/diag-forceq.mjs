/**
 * 真实站点：一次加载，翻遍整卷，实测用户报错的题
 *   node tools/diag-forceq.mjs
 */
import http from 'node:http';
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
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const SITE = 'D:\\labs\\深信服服务2.0\\exam-site';
const web = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const f = path.join(SITE, url);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => web.listen(8933, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 240000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  defaultViewport: { width: 1280, height: 900 }
});

const gotoQ = i => `(() => {
  const btns = [...document.querySelectorAll('button')];
  const target = btns.find(b => b.textContent.trim() === String(${i + 1}));
  if (target) { target.click(); return true; }
  return false;
})()`;

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await swT.worker();
  const extId = new URL(swT.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', whisperModel: '', visionModel: '',
    temperature: 0.2, maxTokens: 512, timeoutSec: 3, doubleCheck: false, autoFillAfterSolve: false,
    extraHeaders: '', systemPrompt: '', followMode: false, stealth: true, cacheEnabled: false,
    skipAnswered: false, concurrency: 3, kbEnabled: true, kbDirect: true, kbTopK: 5,
    kbStrict: false, flashOn: false, flashMs: 0, siteAllow: ''
  });

  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const kbText = fs.readFileSync(path.join(ROOT, 'demo', 'kb-sangfor.txt'), 'utf8');
  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'kb-sangfor.txt', size: text.length, mime: 'text/plain', text });
    await chrome.runtime.sendMessage({ type: 'kb-warm' });
  }, kbText);

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8933/', { waitUntil: 'domcontentloaded' });
  await sleep(700);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^开始考试$/.test(x.innerText.trim()));
    if (b) b.click();
  });
  await sleep(700);

  const tabId = await worker.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return (all.find(t => t.url && t.url.includes('127.0.0.1:8933')) || {}).id;
  });

  /* 翻遍整卷，记录每页题干（用答题卡按钮直接跳，不刷新页面） */
  const stems = [];
  for (let i = 0; i < 25; i++) {
    await page.evaluate(gotoQ(i));
    await sleep(150);
    const s = await page.evaluate(() => (document.querySelector('.qtext') || {}).textContent || '');
    stems.push(s);
  }
  console.log('本轮抽到', stems.length, '题');

  const TARGETS = [
    { key: '严谨规范', desc: '严谨规范·风险识别' },
    { key: '出发时间应提前', desc: '出发时间' },
    { key: '项目移交时必须包含', desc: '项目移交' }
  ].map(t => ({ ...t, idx: stems.findIndex(s => s.includes(t.key)) }))
    .filter(t => t.idx >= 0);

  console.log('命中的目标题:', TARGETS.map(t => `${t.desc}@第${t.idx + 1}题`).join('，') || '（本轮无）');

  for (const t of TARGETS) {
    await page.evaluate(gotoQ(t.idx));
    await sleep(220);
    /* 清掉站点里这题的作答，确保插件是唯一填涂者 */
    await page.evaluate(() => {
      document.querySelectorAll('.option.on').forEach(b => b.classList.remove('on'));
    });

    const r = await worker.evaluate(async tid => {
      const out = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: async () => {
          const d = globalThis.__EXA_DEBUG__;
          d.clearResults();
          const list = await d.extract();
          if (!list.length) return null;
          const q = list[0];
          const kb = await d.kbCheck();
          await d.solveAll();
          const res = d.results();
          await d.fillOne(0);
          await new Promise(r => setTimeout(r, 200));
          return {
            stem: String(q.stem || '').replace(/\s+/g, ' ').slice(0, 44),
            kind: q.kind,
            opts: (q.options || []).map(o => o.label + ':' + String(o.text).slice(0, 10)),
            mode: kb && kb.mode, exact: kb && kb.exact, kbAnswer: kb && kb.answer,
            topQ: kb && kb.hits && kb.hits[0] && String(kb.hits[0].q).slice(0, 34),
            topA: kb && kb.hits && kb.hits[0] && kb.hits[0].a,
            answer: res[0] && res[0].answer,
            src: res[0] && res[0].source && res[0].source.kind,
            on: [...document.querySelectorAll('.option.on')].map(b => Number(b.dataset.i)),
            onText: [...document.querySelectorAll('.option.on')].map(b => (b.querySelector('.otext') || {}).textContent || '')
          };
        }
      });
      return out[0].result;
    }, tabId);

    console.log(`\n=== ${t.desc}（第 ${t.idx + 1} 题）===`);
    console.log(JSON.stringify(r, null, 1));

    if (r) {
      check(`${t.desc}：走知识库`, r.mode === 'kb', `mode=${r.mode}`);
      check(`${t.desc}：填上了`, r.on.length > 0, JSON.stringify(r.on));
      if (r.kind === 'judge') {
        const want = r.answer === '对' ? '正确' : '错误';
        check(`${t.desc}：判断题答案一致`, (r.onText[0] || '').includes(want), `答=${r.answer} 选中=${JSON.stringify(r.onText)}`);
      } else if (r.kind === 'multi') {
        check(`${t.desc}：多选选满`, r.on.length >= 2, `${r.on.length} 个`);
      }
    }
    await page.screenshot({ path: path.join(ROOT, `docs/shot-q${t.idx + 1}.png`) }).catch(() => { });
  }

} catch (e) {
  check('运行未抛异常', false, e && e.message);
  console.error(e);
} finally {
  await browser.close();
  web.close();
  const bad = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
  process.exitCode = bad.length ? 1 : 0;
}
