/**
 * 知识库深度优化专项端到端测试：
 * 1. 讲义/手册（含标题 + 少量冒号行 + 无答案序号段）不丢正文，干扰项多的选择题照常进入 kb+ai 并传入原文
 * 2. 泛化题干（「以下关于规范的说法正确的有」）通过选项多路子查询召回各选项对应的知识库条目
 * 3. 反向提问（「以下哪项不属于四大纪律」）触发极性守护不盲抄原字母，且 formatHits 把原答案字母展开成选项文字交给 AI
 * 4. 中文无空格标点（「A、xxx」「A:xxx」）+ 题干内嵌答案（「（ AC ）」）+ 题型前缀（「【多选题】1.」）精确命中并支持乱序重映射
 * 5. CSV / JSON 题库导入保留选项列，乱序页面重映射正确
 * 6. 乱序判断题（页面 A=错误 B=正确，题库答案写「正确」）不发生 B→错 二次反转
 * 7. 技术名词答案（题库写「答案：B+树」，页面 D=B+树）不误提取字母 B，准确映射到 D
 * 8. 先走 AI 产生旧错答缓存，后导入知识库，自动绕过/清理旧 AI 缓存并采用知识库新结果
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findBrowser } from './find-browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const CHROME = findBrowser();
const WEB_PORT = 8891;
const API_PORT = 8892;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

let currentPageHtml = '<html><body>ready</body></html>';
const webServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(currentPageHtml);
});
await new Promise(r => webServer.listen(WEB_PORT, '127.0.0.1', r));

// 智能 Mock LLM：记录收到的最后一次提示词，且严格依赖【知识库参考】里给出的事实作答（若没收到知识库则故意答错！）
let lastPromptMessages = null;
let apiCallCount = 0;

const apiServer = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
    return res.end();
  }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    apiCallCount += 1;
    let parsed = {};
    try { parsed = JSON.parse(body); } catch (e) { }
    lastPromptMessages = parsed.messages || [];
    const fullUser = lastPromptMessages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
    const hasKbBlock = fullUser.includes('【知识库参考');

    let payload = { type: 'single', used_kb: false, reasoning: '未收到知识库参考，盲猜 A', answer: 'A', confidence: 0.3 };

    if (hasKbBlock) {
      // 场景 1：讲义段落 RAG（工单响应时限）
      if (fullUser.includes('工单响应时限') && fullUser.includes('30 分钟内主动联系客户') && fullUser.includes('马上联系客户')) {
        payload = {
          type: 'single',
          used_kb: true,
          reasoning: '依据知识库[1]：常规工单 30 分钟内联系，P1、P2 马上联系，对应选项 C。',
          answer: 'C',
          confidence: 0.96
        };
      }
      // 场景 2：泛化题干多路子查询（同时收到短裤凉鞋 + 涉密信息销毁两条依据）
      else if (fullUser.includes('下列说法符合内部要求的有') && fullUser.includes('短裤') && fullUser.includes('涉密信息')) {
        payload = {
          type: 'multi',
          used_kb: true,
          reasoning: '依据知识库条目核对各选项：B（禁止穿短裤凉鞋）与 D（被动接收非必需涉密信息立即删除销毁）均符合规范。',
          answer: 'BD',
          confidence: 0.95
        };
      }
      // 场景 3：反向设问（「不属于四大纪律」）且收到展开后的正确选项文字
      else if (fullUser.includes('不属于') && fullUser.includes('四大纪律') && fullUser.includes('正确内容为：「影响客户使用的事坚决不做」')) {
        payload = {
          type: 'single',
          used_kb: true,
          reasoning: '依据知识库[1]，四大纪律为影响客户使用、侵犯客户权益、引起客户反感、造成客户误解；本题问不属于的一项，对应 B（影响个人绩效的事坚决不做）。',
          answer: 'B',
          confidence: 0.97
        };
      }
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(payload) } }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise(r => apiServer.listen(API_PORT, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 180000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check'],
  defaultViewport: { width: 1200, height: 900 }
});

try {
  const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await swTarget.worker();
  const extId = new URL(swTarget.url()).host;

  await worker.evaluate(async s => { await chrome.storage.local.set({ settings: s }); }, {
    baseUrl: `http://127.0.0.1:${API_PORT}/v1`,
    apiKey: 'test-key',
    model: 'mock-grounded',
    visionModel: '',
    temperature: 0.1,
    maxTokens: 1024,
    timeoutSec: 30,
    doubleCheck: false,
    autoFillAfterSolve: true,
    extraHeaders: '',
    systemPrompt: '',
    kbEnabled: true,
    kbDirect: true,
    kbContext: true,
    kbTopK: 5,
    kbStrict: false,
    cacheEnabled: true,
    cacheTtlDays: 7,
    skipAnswered: false,
    followMode: false,
    stealth: true,
    flashMs: 0
  });

  const opt = await browser.newPage();
  await opt.goto(`chrome-extension://${extId}/src/options/options.html`, { waitUntil: 'domcontentloaded' });
  await sleep(300);

  const examPage = await browser.newPage();

  async function renderAndSolve(html) {
    currentPageHtml = html;
    await examPage.goto(`http://127.0.0.1:${WEB_PORT}/?t=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await sleep(350);
    const tabId = await worker.evaluate(async port => {
      const all = await chrome.tabs.query({});
      return (all.find(t => t.url && t.url.includes('127.0.0.1:' + port)) || {}).id;
    }, WEB_PORT);
    return worker.evaluate(async tid => {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: async () => {
          globalThis.__EXA_DEBUG__.clearResults();
          await globalThis.__EXA_DEBUG__.extract();
          await globalThis.__EXA_DEBUG__.solveAll();
          const res = globalThis.__EXA_DEBUG__.results();
          await globalThis.__EXA_DEBUG__.fillOne(0);
          return res[0] || null;
        }
      });
      return r[0].result;
    }, tabId);
  }

  /* =========================================================================
   * 测试 1 & 8：先在无知识库时作答（产生错误 AI 缓存 A），再导入「混合讲义手册」，
   * 验证：(a) 讲义不会因为含冒号行或无答案序号而丢弃正文段落；
   *       (b) 旧 AI 缓存自动失效，题目带着 3 个长干扰项仍进入 kb+ai 并依据讲义答对 C！
   * ========================================================================= */
  await opt.evaluate(async () => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
  });

  const q1Html = `<!DOCTYPE html><html><body><div class="q">
    <div class="qtext">1. 关于工单响应时限，以下做法符合规范的是（ ）</div>
    <label><input type="radio" name="q1" value="A"> A. 所有级别工单统一在 2 小时内通过邮件首次响应客户并排期上门</label><br>
    <label><input type="radio" name="q1" value="B"> B. 非工作时间分派的工单顺延至次日 9:00 后再电话联系客户说明情况</label><br>
    <label><input type="radio" name="q1" value="C"> C. 常规工单 30 分钟内主动联系客户，P1、P2 紧急问题必须马上联系</label><br>
    <label><input type="radio" name="q1" value="D"> D. P1 问题由二线专家直接接管，一线工程师无需主动联系客户</label>
  </div></body></html>`;

  const preKbRes = await renderAndSolve(q1Html);
  check('导入知识库前：无依据落入纯 AI（错答 A 并写入缓存）', preKbRes && preKbRes.answer === 'A' && preKbRes.source.kind === 'ai', JSON.stringify(preKbRes));

  // 导入一份真实形态的讲义手册（含文档版本冒号行、Markdown 章节标题、带数字序号但无答案的正文段落）
  const HANDBOOK_MD = `# 客户服务作业手册
版本：v2.0
适用范围：全体一线与二线服务工程师

## 一、五项服务要求
1. 接到服务要联系：接到报单或 CTI 分派工单后，应在 30 分钟内主动联系客户；如果是 P1、P2 级别问题要马上联系客户，同步处理进展。
2. 现场服务礼仪：服务工程师进入用户现场应衣着整洁大方，禁止穿休闲衫、短裤、凉鞋进入用户现场。

## 二、信息安全红线
1. 敏感信息处理：外部敏感信息原则上不向客户索取；被动接收到涉密信息，且该信息并非业务开展所必需时，应当立即删除或销毁。
`;

  const docRes = await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    const added = await kb.addDocument({ name: '服务作业手册.md', size: text.length, mime: 'text/markdown', text });
    await chrome.runtime.sendMessage({ type: 'kbChanged' });
    return { added, stats: await kb.stats() };
  }, HANDBOOK_MD);

  check('讲义手册切分策略为 chunk 且保留全部章节段落（不因冒号行或序号段丢正文）',
    docRes.added.strategy === 'chunk' && docRes.stats.entries >= 4,
    JSON.stringify(docRes));

  const postKbRes = await renderAndSolve(q1Html);
  check('导入讲义后自动绕过旧 AI 缓存，进入 kb+ai 并依据讲义选出 C',
    postKbRes && postKbRes.answer === 'C' && postKbRes.source.kind === 'kb+ai',
    JSON.stringify(postKbRes));

  /* =========================================================================
   * 测试 2：泛化题干多选题（「下列说法符合内部要求的有」）通过各选项子查询召回跨章节依据
   * ========================================================================= */
  const q2Html = `<!DOCTYPE html><html><body><div class="q">
    <div class="qmeta"><span class="badge multi">多选题</span></div>
    <div class="qtext">2. 下列说法符合内部要求的有（ ）</div>
    <label><input type="checkbox" name="q2" value="A"> A. 客户提出超出合同范围的需求时应无条件答应以免投诉</label><br>
    <label><input type="checkbox" name="q2" value="B"> B. 进入客户现场应衣着整洁大方，禁止穿短裤和凉鞋</label><br>
    <label><input type="checkbox" name="q2" value="C"> C. 周末可在非变更窗口直接升级客户核心数据库</label><br>
    <label><input type="checkbox" name="q2" value="D"> D. 被动接收到非业务必需的涉密信息时应当立即删除或销毁</label>
  </div></body></html>`;

  const multiRagRes = await renderAndSolve(q2Html);
  check('泛化题干多路子查询召回跨章节依据，模型准确选出 BD',
    multiRagRes && multiRagRes.answer === 'BD' && multiRagRes.source.kind === 'kb+ai',
    JSON.stringify(multiRagRes));

  /* =========================================================================
   * 测试 3：反向设问极性守护（「不属于四大纪律」）+ formatHits 展开原答案文字
   * ========================================================================= */
  const QA_BANK_MIXED = `
【多选题】1、“四大纪律”包括以下哪些内容？（ ABCD ）
A、影响客户使用的事坚决不做
B、侵犯客户权益的事坚决不做
C、引起客户反感的事坚决不做
D、造成客户误解的事坚决不做
E、影响个人绩效的事坚决不做
解析：四大纪律为影响客户使用、侵犯客户权益、引起客户反感、造成客户误解。
出处：PDF P10

2. 客户满意是服务人员最终价值体现。
答案：正确

3. 数据库索引常采用的数据结构是（ ）。
A. 红黑树
B. B+树
C. 跳表
D. 位图
答案：B+树
`;

  await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.addDocument({ name: '混合格式题库.txt', size: text.length, mime: 'text/plain', text });
    await chrome.runtime.sendMessage({ type: 'kbChanged' });
  }, QA_BANK_MIXED);

  const q3ReverseHtml = `<!DOCTYPE html><html><body><div class="q">
    <div class="qtext">3. “四大纪律”不包括以下哪项内容？</div>
    <label><input type="radio" name="q3" value="A"> A. 造成客户误解的事坚决不做</label><br>
    <label><input type="radio" name="q3" value="B"> B. 影响个人绩效的事坚决不做</label><br>
    <label><input type="radio" name="q3" value="C"> C. 侵犯客户权益的事坚决不做</label><br>
    <label><input type="radio" name="q3" value="D"> D. 影响客户使用的事坚决不做</label>
  </div></body></html>`;

  const revRes = await renderAndSolve(q3ReverseHtml);
  check('反向提问触发极性守护不盲抄 ABCD，展开原题选项文字交由 AI 选出 B',
    revRes && revRes.answer === 'B' && revRes.source.kind === 'kb+ai',
    JSON.stringify(revRes));

  /* =========================================================================
   * 测试 4：无空格顿号「A、xxx」+ 内嵌答案「（ ABCD ）」+ 页面乱序后 0 模型调用直答重映射
   * ========================================================================= */
  const callsBeforeDirect = apiCallCount;
  const q4ShuffledHtml = `<!DOCTYPE html><html><body><div class="q">
    <div class="qmeta"><span class="badge multi">多选题</span></div>
    <div class="qtext">4. “四大纪律”包括以下哪些内容？</div>
    <label><input type="checkbox" name="q4" value="A"> A. 影响个人绩效的事坚决不做</label><br>
    <label><input type="checkbox" name="q4" value="B"> B. 造成客户误解的事坚决不做</label><br>
    <label><input type="checkbox" name="q4" value="C"> C. 影响客户使用的事坚决不做</label><br>
    <label><input type="checkbox" name="q4" value="D"> D. 引起客户反感的事坚决不做</label><br>
    <label><input type="checkbox" name="q4" value="E"> E. 侵犯客户权益的事坚决不做</label>
  </div></body></html>`;

  const directRemap = await renderAndSolve(q4ShuffledHtml);
  check('无空格顿号 + 题干内嵌答案：乱序多选题免模型直答并映射为 BCDE',
    directRemap && directRemap.source.kind === 'kb' && directRemap.answer === 'BCDE' && apiCallCount === callsBeforeDirect,
    JSON.stringify(directRemap));

  /* =========================================================================
   * 测试 6：乱序判断题（页面 A=错误 B=正确，题库写「答案：正确」）绝不反转为「错」
   * ========================================================================= */
  const q6JudgeHtml = `<!DOCTYPE html><html><body><div class="q">
    <div class="qmeta"><span class="badge judge">判断题</span></div>
    <div class="qtext">6. 客户满意是服务人员最终价值体现。</div>
    <label><input type="radio" name="q6" value="A"> A. 错误</label><br>
    <label><input type="radio" name="q6" value="B"> B. 正确</label>
  </div></body></html>`;

  const judgeRes = await renderAndSolve(q6JudgeHtml);
  const pickedQ6 = await examPage.evaluate(() => (document.querySelector('input[name=q6]:checked') || {}).value || '');
  check('题库答案写「正确」且页面 A=错误/B=正确时，直答为「对」并准确选中 B',
    judgeRes && judgeRes.source.kind === 'kb' && judgeRes.answer === '对' && pickedQ6 === 'B',
    `answer=${judgeRes && judgeRes.answer} picked=${pickedQ6}`);

  /* =========================================================================
   * 测试 7：技术名词答案「B+树」（页面 D=B+树）绝不误提取字母 B，准确映射到 D
   * ========================================================================= */
  const q7TechHtml = `<!DOCTYPE html><html><body><div class="q">
    <div class="qtext">7. 数据库索引常采用的数据结构是____。</div>
    <label><input type="radio" name="q7" value="A"> A. 位图</label><br>
    <label><input type="radio" name="q7" value="B"> B. 红黑树</label><br>
    <label><input type="radio" name="q7" value="C"> C. 跳表</label><br>
    <label><input type="radio" name="q7" value="D"> D. B+树</label>
  </div></body></html>`;

  const techRes = await renderAndSolve(q7TechHtml);
  check('技术名词「答案：B+树」+ 下划线题干归一化：精确命中并按文本映射到 D（不误选 B）',
    techRes && techRes.source.kind === 'kb' && techRes.answer === 'D',
    JSON.stringify(techRes));

  /* =========================================================================
   * 测试 5：CSV 表格题库（含选项列 A~D）导入保留选项，页面打乱后重映射正确
   * ========================================================================= */
  const CSV_BANK = [
    '题型,题干,选项A,选项B,选项C,选项D,答案,解析',
    '单选题,HTTPS 默认使用的熟知端口号是多少？,80,443,8080,22,B,HTTPS 默认端口为 443'
  ].join('\n');

  await opt.evaluate(async csv => {
    const parse = await import(chrome.runtime.getURL('src/lib/parse.js'));
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    const f = new File([csv], 'network-bank.csv', { type: 'text/csv' });
    const parsed = await parse.parseFile(f);
    await kb.addDocument(parsed);
    await chrome.runtime.sendMessage({ type: 'kbChanged' });
  }, CSV_BANK);

  const q5CsvHtml = `<!DOCTYPE html><html><body><div class="q">
    <div class="qtext">5. HTTPS 默认使用的熟知端口号是多少？</div>
    <label><input type="radio" name="q5" value="A"> A. 22</label><br>
    <label><input type="radio" name="q5" value="B"> B. 80</label><br>
    <label><input type="radio" name="q5" value="C"> C. 8080</label><br>
    <label><input type="radio" name="q5" value="D"> D. 443</label>
  </div></body></html>`;

  const csvRes = await renderAndSolve(q5CsvHtml);
  check('CSV 题库保留选项列 A~D，乱序页面由 B(443) 准确重映射为 D(443)',
    csvRes && csvRes.source.kind === 'kb' && csvRes.answer === 'D',
    JSON.stringify(csvRes));

} catch (e) {
  check('运行未抛异常', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  console.error(e);
} finally {
  await browser.close();
  webServer.close();
  apiServer.close();
  const bad = results.filter(r => !r.ok);
  console.log(`\n===== 知识库深度专项 ${results.length - bad.length}/${results.length} 项通过 =====`);
  process.exit(bad.length ? 1 : 0);
}
