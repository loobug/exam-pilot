/**
 * 判断题 / 多选题 的判定健壮性
 *   node tools/e2e-judgemulti.mjs
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
const check = (n, ok, d) => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };

/* 每组：题干、选项文本、库答案、期望选中的索引 */
const CASES = [
  {
    id: 'j1', kind: 'judge',
    stem: '服务规范要求所有操作必须做风险识别。',
    opts: ['正确', '错误'], kb: '正确', want: [0],
    desc: '判断：标准「正确/错误」答对'
  },
  {
    id: 'j2', kind: 'judge',
    stem: '现场服务必须穿正装。',
    opts: ['正确（√）', '错误（×）'], kb: '错误', want: [1],
    desc: '判断：选项带符号仍认得出'
  },
  {
    id: 'j3', kind: 'judge',
    stem: '客户可以要求跳过变更审批。',
    opts: ['该说法正确', '该说法错误'], kb: '错误', want: [1],
    desc: '判断：选项带修饰语仍认得出'
  },
  {
    id: 'j4', kind: 'judge',
    stem: '任何情况下都可以不做验证直接离开。',
    opts: ['对', '错'], kb: '错', want: [1],
    desc: '判断：「对/错」写法'
  },
  {
    id: 'm1', kind: 'multi',
    stem: '四项要求包括哪些？',
    opts: ['服务之前要准备', '接到服务要联系', '服务过程要细致', '服务完成要确认'],
    kb: 'ABCD', want: [0, 1, 2, 3],
    desc: '多选：四个全选'
  },
  {
    id: 'm2', kind: 'multi',
    stem: '下列属于传输层协议的是？',
    opts: ['TCP', 'IP', 'UDP', 'ARP'], kb: 'AC', want: [0, 2],
    desc: '多选：跳选 AC'
  },
  {
    id: 'm3', kind: 'multi',
    stem: '以下说法正确的有哪些？',
    opts: ['甲说法', '乙说法', '丙说法', '丁说法'], kb: '全选', want: [0, 1, 2, 3],
    desc: '多选：答案写「全选」'
  },
  {
    id: 'm4', kind: 'multi',
    stem: '服务禁用语包括？',
    opts: ['不知道', '不关我事', '找别人', '好的'], kb: 'A、B、C', want: [0, 1, 2],
    desc: '多选：答案带顿号'
  }
];

const pages = {};
for (const c of CASES) {
  pages[c.id] = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${c.id}</title>
<style>body{font:15px/1.7 system-ui;margin:20px}.qtext{font-weight:700;margin-bottom:10px}.option{display:block;margin:6px 0}</style>
</head><body><div class="q">
  <div class="qtext">${c.stem}</div>
  ${c.opts.map((o, i) => `<label class="option"><input type="${c.kind === 'multi' ? 'checkbox' : 'radio'}" name="q" value="${String.fromCharCode(65 + i)}"><span>${String.fromCharCode(65 + i)}. ${o}</span></label>`).join('\n  ')}
</div></body></html>`;
}

const servers = [];
let port = 8960;
for (const c of CASES) {
  const html = pages[c.id];
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); });
  await new Promise(r => srv.listen(port, '127.0.0.1', r));
  c.port = port; c.url = `http://127.0.0.1:${port}/`;
  servers.push(srv);
  port++;
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 20000 });
  const worker = await swT.worker();
  const extId = new URL(swT.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', visionModel: '',
    temperature: 0.2, maxTokens: 512, timeoutSec: 5, doubleCheck: false, autoFillAfterSolve: false,
    extraHeaders: '', systemPrompt: '', followMode: false, stealth: true, cacheEnabled: false,
    skipAnswered: false, concurrency: 1, kbEnabled: true, kbDirect: true, kbTopK: 5,
    kbStrict: true, flashOn: false, flashMs: 0, siteAllow: ''
  });

  /* 每道题单独一个知识库文件，避免互相干扰 */
  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });

  for (const c of CASES) {
    const KB = `1. ${c.stem}\n${c.opts.map((o, i) => String.fromCharCode(65 + i) + '. ' + o).join('\n')}\n答案：${c.kb}\n`;
    await opt.evaluate(async text => {
      const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
      await kb.clearAll();
      await kb.addDocument({ name: 'c.txt', size: text.length, mime: 'text/plain', text });
      await chrome.runtime.sendMessage({ type: 'kb-warm' });
    }, KB);
    await sleep(150);

    const page = await browser.newPage();
    await page.goto(c.url, { waitUntil: 'domcontentloaded' });
    await sleep(500);
    const tabId = await worker.evaluate(async u => {
      const all = await chrome.tabs.query({});
      return (all.find(t => t.url && t.url.startsWith(u)) || {}).id;
    }, c.url);

    const r = await worker.evaluate(async tid => {
      const out = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: async () => {
          const d = globalThis.__EXA_DEBUG__;
          d.clearResults();
          const list = await d.extract();
          if (!list.length) return { error: 'no question' };
          const q = list[0];
          const kb = await d.kbCheck();
          await d.solveAll();
          const res = d.results();
          await d.fillOne(0);
          await new Promise(r => setTimeout(r, 120));
          return {
            kind: q.kind,
            srcKind: q.source,
            optCount: (q.options||[]).length,
            inputs: [...document.querySelectorAll('input')].map(i=>i.type),
            fullAnswer: res[0] ? JSON.parse(JSON.stringify(res[0])) : null,
            answer: res[0] && res[0].answer,
            mode: kb && kb.mode,
            kbAnswer: kb && kb.answer,
            topQ: kb && kb.hits && kb.hits[0] && String(kb.hits[0].q).slice(0, 26),
            topA: kb && kb.hits && kb.hits[0] && kb.hits[0].a,
            on: [...document.querySelectorAll('input:checked')].map(i => i.value),
            labels: ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, (q.options || []).length)
          };
        }
      });
      return out[0].result;
    }, tabId);

    const picked = (r && r.on) || [];
    const want = c.want.map(i => String.fromCharCode(65 + i));
    const ok = want.length === picked.length && want.every(v => picked.includes(v));
    console.log(`\n[${c.desc}] 库答案=${c.kb} → kbAnswer=${r && r.kbAnswer} answer=${r && r.answer} kind=${r && r.kind} mode=${r && r.mode}`);
    console.log(`   期望=${JSON.stringify(want)} 实得=${JSON.stringify(picked)} 库里最近=${r && r.topQ} (${r && r.topA})`);
    check(c.desc, ok, JSON.stringify(picked));
    await page.close();
  }

} catch (e) {
  check('运行未抛异常', false, e && e.message);
  console.error(e);
} finally {
  await browser.close();
  servers.forEach(s => s.close());
  const bad = results.filter(r => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 项通过 =====`);
  process.exitCode = bad.length ? 1 : 0;
}
