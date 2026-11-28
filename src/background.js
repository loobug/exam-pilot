import {
  optionsFingerprint,
  normalizeQuestion,
  normalizeAnswerText,
  parseOptionsFromText,
  normOptionText,
  tokenize,
  uniqTokens
} from './lib/tokenize.js';
import {search as kbSearch, stats as kbStats, addEntries as kbAddEntries, formatHits, pendingEnrich as kbPendingEnrich, writeEnrich as kbWriteEnrich, enrichStats as kbEnrichStats, clearEnrich as kbClearEnrich} from './lib/kb.js';

/* 考试辅助 · 后台服务（MV3 service worker）
 * 职责：设置读写 / 本地知识库多路检索与答案重映射 / 大模型流式调用 / 跨 frame 采集与回填 / 截图
 */

const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  visionModel: '',
  temperature: 0.2,
  maxTokens: 2048,
  timeoutSec: 90,
  doubleCheck: false,
  autoFillAfterSolve: false,
  extraHeaders: '',
  systemPrompt: '',
  // 知识库
  kbEnabled: true,
  kbDirect: true,        // 高置信命中直接采用知识库答案，不调模型
  kbContext: true,       // 相关命中作为上下文交给模型推理
  kbTopK: 5,
  kbMinCoverage: 0.65,
  // 答案缓存与填涂策略
  cacheEnabled: true,
  cacheTtlDays: 7,
  skipAnswered: true,
  concurrency: 2,
  // 默认形态：隐式（不显示面板）+ 跟随（翻页自动答当前题）+ 不自动翻页
  stealth: true,
  followMode: true,
  kbStrict: false,
  flashOn: false,
  kbAiExpand: false,
  ocrEngine: 'auto',
  ocrDocImages: true,
  autoSaveAnswers: true,
  siteAllow: "",
  flashMs: 1500,
  autoInterval: 10,
  autoLimit: 30,
  autoNext: false,
  fillHoldMs: 1200
};

const SETTINGS_KEY = 'settings';

async function getSettings() {
  const raw = await chrome.storage.local.get(SETTINGS_KEY);
  return Object.assign({}, DEFAULTS, raw[SETTINGS_KEY] || {});
}

async function saveSettings(patch) {
  const cur = await getSettings();
  const next = Object.assign({}, cur, patch || {});
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/* ---------------- 提示词 ---------------- */

const KIND_TEXT = {
  single: '单项选择', multi: '多项选择', judge: '判断', fill: '填空',
  short: '简答/问答', calc: '计算', page: '整页试卷', auto: '未标注题型'
};

const SYSTEM_PROMPT = `你是严谨的考试解题专家，擅长依据给定知识库、教材规范或学科原理准确作答客观题与主观题。工作方式严格分两段：

【第一段 · 思考】真正动笔前先把题吃透：
1. 若提供了【知识库参考】，必须第一时间逐条核对知识库原文、标准答案内容与解析依据；凡知识库已规定的定义、数字时限、分类要点、操作规范或原题结论，一律以知识库为准，严禁用通用常识推翻知识库规定！
2. 提取题干里的约束条件、否定词（不正确/不属于/除外/错误的是/最），识别正反问法陷阱；
3. 选择题逐项将本题 A/B/C/D 选项文字与知识库事实核对，判断为何对、为何错（严禁盲抄知识库原题的选项字母）；计算题列公式与代入过程；简答题列得分点。

【第二段 · 作答】再输出最终答案。

只输出一个 JSON 对象，不要代码块、不要前后解释：
{"type":"single|multi|judge|fill|short|calc","used_kb":true或false,"reasoning":"第一段思考，若依据了知识库须在开头写明『依据知识库[序号]：…』","answer":"最终答案","confidence":0.0到1.0,"notes":"可选的提醒或假设"}

answer 字段的硬性格式：
- 单选：只给选项字母，如 "B"
- 多选/不定项：按字母升序拼接，如 "ACD"
- 判断：只给 "对" 或 "错"
- 填空：按空格顺序用 " | " 分隔，如 "牛顿 | 1687"
- 简答/计算：给出可以直接抄写的完整答案正文，分点用 1. 2. 3.，不要 Markdown 标题`;

const KB_SYSTEM_ADDON = `

【知识库优先铁律（当前已检出本地知识库条目，最高优先级）】
1. 凡知识库条目中涉及的规则、数值、时限、阶段动作、并列要点（如「四大纪律」「三种形象」「五项要求」等），必须 100% 采信知识库口径，禁止用外部常识臆断！
2. 注意选项打乱与正反设问：知识库原题若问「包括哪些」而本题问「不包括/错误的是」，或选项顺序已打乱，必须按「选项文字语义」逐项比对，绝不可照搬原题字母。
3. 多选题务必把本题选项中符合知识库要点的项全部选齐，不漏选、不多选。
4. 只要知识库条目对解题提供了依据（含直接命中、同考点变形、排除错误项），置 "used_kb": true；仅当所有条目与本题完全无关时置 "used_kb": false 并在 reasoning 注明「知识库未覆盖，独立作答」。`;

function buildUserText(q, pageTitle, kbText) {
  const parts = [];
  const kindDesc = (!q.kind || q.kind === 'auto')
    ? '未标注题型（若选项为对/错、正确/错误则为判断题；否则请自行判断是单选还是多选，多选题务必在 type 填 "multi" 并给出全部正确字母）'
    : (KIND_TEXT[q.kind] || q.kind);
  parts.push('【题型】' + kindDesc);
  if (q.blanks > 1) parts.push('【空格数】' + q.blanks);
  parts.push('【题干】\n' + String(q.stem || '').trim());
  if (q.options && q.options.length) {
    parts.push('【本题选项】\n' + q.options.map(o => `${o.label}. ${o.text}`).join('\n'));
  }
  if (pageTitle) parts.push('【页面标题】' + pageTitle);
  if (kbText) {
    parts.push(
      '【知识库参考（请严格基于以下本地知识库资料推理作答）】\n' + kbText + '\n\n' +
      '作答核对清单：\n' +
      '1. 先在 reasoning 开头指明命中了哪条知识库条目（如「依据知识库[1]…」），提取其核心事实或标准答案对应的文字内容；\n' +
      '2. 核对本题题干是正向提问（正确/属于/包括）还是反向提问（错误/不属于/不包括）；\n' +
      '3. 将知识库结论逐一对应到【本题选项】的文字上，输出本题对应的选项字母（或判断「对/错」）；\n' +
      '4. 仅当以上知识库条目与本题考点完全无关时，才置 "used_kb": false 并独立作答。');
  }
  parts.push('按 JSON 格式输出最终结果。');
  return parts.join('\n\n');
}

function buildMessages(q, settings, opts) {
  opts = opts || {};
  const baseSys = (settings.systemPrompt && settings.systemPrompt.trim()) || SYSTEM_PROMPT;
  const sys = opts.kbText ? (baseSys + KB_SYSTEM_ADDON) : baseSys;
  const userText = buildUserText(q, q.pageTitle, opts.kbText);
  const messages = [{ role: 'system', content: sys }];
  if (q.imageDataUrl) {
    const useVision = (settings.visionModel || settings.model);
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: userText + '\n\n题目内容在上传的截图中，请先从图中完整识别题干与选项再作答。' },
        { type: 'image_url', image_url: { url: q.imageDataUrl } }
      ]
    });
    messages.__model = useVision;
  } else {
    messages.push({ role: 'user', content: userText });
    messages.__model = settings.model;
  }
  if (opts.verifyNote) messages.push({ role: 'user', content: opts.verifyNote });
  return messages;
}

/* ---------------- 网络层：OpenAI 兼容 + SSE 流式 ---------------- */

function normalizeEndpoint(baseUrl) {
  let base = String(baseUrl || DEFAULTS.baseUrl).trim().replace(/\s/g, '');
  base = base.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v\d+$/.test(base)) return base + '/chat/completions';
  return base + '/chat/completions';
}

function parseExtraHeaders(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    const obj = JSON.parse(raw);
    const out = {};
    Object.keys(obj).forEach(k => { if (typeof obj[k] === 'string') out[k] = obj[k]; });
    return out;
  } catch (e) {
    return {};
  }
}

async function streamChat({ settings, messages, jsonMode, stream, onDelta, signal }) {
  const url = normalizeEndpoint(settings.baseUrl);
  const headers = Object.assign(
    { 'Content-Type': 'application/json' },
    settings.apiKey ? { Authorization: 'Bearer ' + settings.apiKey } : {},
    parseExtraHeaders(settings.extraHeaders)
  );
  const body = {
    model: messages.__model || settings.model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    temperature: Number(settings.temperature) || 0.2,
    max_tokens: Number(settings.maxTokens) || 2048,
    stream: stream !== false
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('请求超时')), (Number(settings.timeoutSec) || 90) * 1000);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(new Error('已取消')));

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    throw new Error('网络请求失败：' + (e && e.message ? e.message : e) + '\n接口：' + url);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    clearTimeout(timer);
    // 部分第三方接口不支持 response_format，去掉重试一次
    if (jsonMode && res.status >= 400 && res.status < 500 && /response_format|json_object|unsupported/i.test(text)) {
      return streamChat({ settings, messages, jsonMode: false, onDelta, signal });
    }
    if (res.status === 401 || res.status === 403) throw new Error('鉴权失败（' + res.status + '）：请检查 API Key。' + text.slice(0, 200));
    if (res.status === 404) throw new Error('接口不存在（404）：请检查 Base URL，应形如 https://api.xxx.com/v1。' + text.slice(0, 200));
    throw new Error('接口返回 ' + res.status + '：' + text.slice(0, 400));
  }

  const ctype = (res.headers.get('content-type') || '').toLowerCase();

  // 非流式响应
  if (!/event-stream/.test(ctype)) {
    let data;
    try { data = await res.json(); } catch (e) { data = null; }
    clearTimeout(timer);
    let content = '';
    if (data) {
      content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content)
        || (data.message && data.message.content) || data.response || '';
    }
    if (!content) throw new Error('接口返回为空或格式不可识别');
    onDelta && onDelta(content);
    return content;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  let full = '';
  let thinkAcc = '';
  let finishReason = '';
  try {
    for (; ;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line || line.startsWith(':')) continue;
        const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
        if (payload === '[DONE]') continue;
        let json;
        try { json = JSON.parse(payload); } catch (e) { continue; }
        if (json.error) {
          const msg = (json.error && (json.error.message || json.error.msg)) || JSON.stringify(json.error);
          throw new Error('接口流式错误：' + String(msg).slice(0, 240));
        }
        const ch = json.choices && json.choices[0];
        if (ch && ch.finish_reason) finishReason = ch.finish_reason;
        const delta = ch && ch.delta && ch.delta.content;
        const rDelta = ch && ch.delta && (ch.delta.reasoning_content || ch.delta.reasoning);
        if (rDelta) {
          thinkAcc += rDelta;
          if (!full && onDelta) onDelta('');
        }
        if (delta) { full += delta; onDelta && onDelta(delta); }
        else if (ch && ch.message && ch.message.content) {
          full = ch.message.content;
          onDelta && onDelta(full);
        }
      }
    }
  } finally {
    clearTimeout(timer);
    try { reader.releaseLock(); } catch (e) { }
  }
  if (!String(full || '').trim()) {
    if (finishReason === 'length' && thinkAcc) {
      throw new Error('模型思考内容过长达到 max_tokens 上限，未输出最终答案');
    }
    throw new Error('模型没有返回内容');
  }
  return full;
}

/* ---------------- 结果解析 ---------------- */

function safeJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  const slice = t.slice(s, e + 1);
  try { return JSON.parse(slice); } catch (err) { }
  try { return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1')); } catch (err) { }
  return null;
}

/**
 * 严格提取「纯选项字母答案」（如 "B"、"ACD"、"A, C"、"A（正确）"），
 * 绝不把技术名词里的字母（如 "B+树"、"C语言"、"TCP"、"AD域"）误当成选项字母。
 */
function pureAnswerLetters(answer) {
  const s = String(answer || '')
    .trim()
    .replace(/^(?:(?:参考|标准|正确|选项)?答案\s*(?:是|为)?\s*[:：]?\s*)/, '')
    .replace(/(?:[,，、;；\s]*(?:回答(?:正确|错误)|恭喜答对|您的答案.*|我的答案.*)|[（(]\s*回答(?:正确|错误)\s*[)）]).*$/, '')
    .trim();
  if (!s) return [];
  const m = s.match(/^(?:选|选项|答案\s*[:：]?)?\s*([A-Ha-h](?:[\s,，、;；\/·和与+]*[A-Ha-h]){0,7})\s*(?:[（(][^）)]{1,16}[)）])?[。.!！]?$/);
  if (!m) return [];
  const letters = (m[1].toUpperCase().match(/[A-H]/g) || []);
  return Array.from(new Set(letters)).sort();
}

function lettersOf(answer) {
  const pure = pureAnswerLetters(answer);
  if (pure.length) return pure;

  const raw = String(answer || '').trim();
  // 仅允许明确以「选 A / 答案：AC」描述的句子，避免把「B+树」「C语言」里的字母抠出来
  const explicit = raw.match(/(?:选|选择|应选|答案(?:为|是)?)\s*[:：]?\s*([A-Ha-h](?:[\s,，、;；\/·和与+]*[A-Ha-h]){0,7})(?![A-Za-z0-9\u4e00-\u9fa5+])/);
  if (explicit) {
    return Array.from(new Set((explicit[1].toUpperCase().match(/[A-H]/g) || []))).sort();
  }
  const upper = raw.toUpperCase();
  if (/^[\sA-H,，、;；\/]+$/.test(upper)) {
    return Array.from(new Set((upper.match(/[A-H]/g) || []).slice(0, 8))).sort();
  }
  return [];
}

function normalizeResult(raw, q) {
  const obj = safeJson(raw) || {};
  let answer = obj.answer;
  let reasoning = obj.reasoning || obj.analysis || obj.think || '';
  let confidence = typeof obj.confidence === 'number' ? obj.confidence
    : (typeof obj.confidence === 'string' && obj.confidence.trim() ? parseFloat(obj.confidence) : null);
  let modelKind = obj.type || '';
  const kindMap = { 单选: 'single', 多选: 'multi', 判断: 'judge', 填空: 'fill', 简答: 'short', 选择: 'single' };
  if (kindMap[modelKind]) modelKind = kindMap[modelKind];
  // 页面识别出的题型可信度高于模型自报（模型常把判断题答成 single）
  const pageKind = q.kind && q.kind !== 'auto' && q.kind !== 'page' ? q.kind : null;
  let kind = pageKind || modelKind || q.kind;

  if (answer == null || answer === '') {
    const text = String(raw || '').trim();
    if (!text) throw new Error('模型没有返回内容');
    answer = text.length > 400 ? text.slice(0, 400) : text;
    if (!reasoning) reasoning = text;
    confidence = null;
  }
  if (Array.isArray(answer)) {
    const arr = answer.map(x => String(x == null ? '' : x).trim()).filter(Boolean);
    answer = kind === 'fill' ? arr.join(' | ') : arr.join('');
  }
  answer = typeof answer === 'string' ? answer.trim() : JSON.stringify(answer);
  if (!Number.isFinite(confidence)) confidence = null;

  if (!kind || kind === 'auto') {
    const t = answer.replace(/[。.\s，,（）()]/g, '');
    if (/^(对|正确|是|真|√|✓|✔|错|错误|否|假|×|✗|✘)$/i.test(t)) kind = 'judge';
    else {
      const ls = lettersOf(answer);
      if (ls.length > 1) kind = 'multi';
      else if (ls.length === 1) kind = 'single';
    }
  }

  answer = normalizeAnswer(answer, kind, q);

  const reasonStr = String(reasoning || '').trim();
  const usedKb = obj.used_kb === false ? false
    : (obj.used_kb === true ? true : !/知识库未覆盖/.test(reasonStr));

  return {
    kind: kind || q.kind,
    answer,
    reasoning: reasonStr,
    confidence,
    notes: obj.notes || '',
    usedKb
  };
}

function normalizeAnswer(answer, kind, q) {
  let a = String(answer == null ? '' : answer).trim();
  if (!a) return a;
  if (kind === 'single' || kind === 'multi') {
    const ls = lettersOf(a);
    if (ls.length) return kind === 'single' ? ls[0] : ls.join('');
    return a;
  }
  if (kind === 'judge') {
    const paren = a.match(/[（(]\s*(对|错|正确|错误|是|否|真|假|√|×|✓|✗|✔|✘|True|False|T|F)\s*[)）]/i);
    if (paren) {
      const v = normalizeAnswerText(paren[1]);
      if (v === '对' || v === '错') return v;
    }
    const t = a.replace(/[。.\s，,（）()]/g, '');
    if (/^(对|正确|是|真|√|✓|✔|T|True|Yes|Y|正确选项)$/i.test(t)) return "对";
    if (/^(错|错误|否|假|×|✗|✘|X|F|False|No|N|错误选项)$/i.test(t)) return "错";
    const ls = pureAnswerLetters(a);
    if (ls.length) {
      const opts = (q && q.options) || [];
      const hit = opts.find(o => o.label === ls[0]);
      if (hit) {
        const mapped = normalizeAnswerText(hit.text);
        if (mapped === '对' || mapped === '错') return mapped;
      }
      return ls[0] === 'A' ? '对' : '错';
    }
  }
  return a;
}

/* ---------------- 答案缓存（同题不重复问模型，知识库更新自动失效旧 AI 缓存） ---------------- */

const CACHE_PREFIX = "qc:";

function hashStr(str) {
  let h = 2166136261;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * 预热知识库索引（幂等）：把 entries/postings 读进内存，
 * 让用户第一次点解题时不再等首次加载。
 */
let _kbWarmed = false;
let _kbWarmState = { ok: false, at: 0, ms: 0, entries: 0, error: '' };

async function warmupKb(force) {
  if (_kbWarmed && !force) return _kbWarmState;
  _kbWarmed = true;
  const t0 = Date.now();
  try {
    const st = await kbStats();
    if (st.entries > 0) await kbSearch('预热索引', { topK: 1 });
    _kbWarmState = { ok: true, at: Date.now(), ms: Date.now() - t0, entries: st.entries, error: '' };
    console.info('[exa] 知识库索引已预热：' + st.entries + ' 条，用时 ' + (Date.now() - t0) + 'ms');
  } catch (e) {
    _kbWarmed = false;
    _kbWarmState = { ok: false, at: Date.now(), ms: Date.now() - t0, entries: 0, error: String(e && e.message || e) };
  }
  return _kbWarmState;
}

function cacheKeyOf(q) {
  const stemKey = normalizeQuestion(q.stem || "");
  const optKey = (q.options || []).map(o => String(o.text || "").slice(0, 80)).join("|");
  return hashStr(stemKey + "##" + optKey + "##" + (q.kind || ""));
}

async function cacheGetBox(key, ttlDays) {
  const k = CACHE_PREFIX + key;
  let box;
  try { box = await chrome.storage.local.get(k); } catch (e) { return null; }
  const v = box && box[k];
  if (!v || !v.data) return null;
  const ttl = (ttlDays || 7) * 86400000;
  if (v.ts && Date.now() - v.ts > ttl) {
    try { await chrome.storage.local.remove(k); } catch (e) { }
    return null;
  }
  return v;
}

async function cachePut(key, data, ttlDays) {
  const k = CACHE_PREFIX + key;
  try {
    await chrome.storage.local.set({ [k]: { ts: Date.now(), ttlDays: ttlDays || 7, data } });
  } catch (e) { }
}

async function cacheStats() {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(k => k.startsWith(CACHE_PREFIX));
    return { count: keys.length };
  } catch (e) { return { count: 0 }; }
}

async function cacheClear() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(CACHE_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}

/** 知识库变更时，清理非知识库直答的旧缓存，避免旧 AI 错答拦截新导入的知识库 */
async function cacheInvalidateAiOnly() {
  try {
    const all = await chrome.storage.local.get(null);
    const removeKeys = Object.keys(all).filter(k => {
      if (!k.startsWith(CACHE_PREFIX)) return false;
      const item = all[k];
      const srcKind = item && item.data && item.data.source && item.data.source.kind;
      return srcKind !== 'kb';
    });
    if (removeKeys.length) await chrome.storage.local.remove(removeKeys);
    return removeKeys.length;
  } catch (e) { return 0; }
}

/* ---------------- 答案合法性校验 ---------------- */

function validateAnswer(result, q) {
  const opts = q.options || [];
  if (!opts.length) return null;
  const labels = new Set(opts.map(o => o.label));
  if (result.kind === "single" || result.kind === "multi") {
    const ls = lettersOf(result.answer);
    if (!ls.length) return "答案不是选项字母";
    const bad = ls.filter(l => !labels.has(l));
    if (bad.length) return "答案含不存在的选项：" + bad.join("");
    // 多选题只给出一个选项时大概率是漏选（模型常见问题），提醒用户核对
    if (result.kind === "multi" && ls.length === 1) {
      return "多选题只答出一个选项（" + ls[0] + "），可能漏选，建议核对";
    }
    if (result.kind === "single" && ls.length > 1) return "单选题给了多个选项，已取第一个";
  }
  if (result.kind === "judge" && !/^(对|错)$/.test(String(result.answer || ""))) {
    return "判断题答案不是「对/错」";
  }
  return null;
}

/* ---------------- 知识库多路检索、极性守护与答案重映射 ---------------- */

function summarizeHits(hits) {
  return (hits || []).slice(0, 5).map(h => ({
    docName: h.entry.docName,
    type: h.entry.type,
    question: String(h.entry.question || '').slice(0, 160),
    answer: String(h.entry.answer || '').slice(0, 220),
    coverage: Math.round((h.coverage || 0) * 100) / 100,
    exact: !!h.exact
  }));
}

const NEGATION_RE = /不正确|不属于|不包括|不合理|不符合|不恰当|不当的是|不妥的是|错误的是|有误的是|无关的是|除外|以外|并非|不是/;

/** 检查题干肯定/否定极性是否一致，防止把「包括哪些」的答案直接套到「不包括哪项」 */
function samePolarity(stemA, stemB) {
  const negA = NEGATION_RE.test(String(stemA || ''));
  const negB = NEGATION_RE.test(String(stemB || ''));
  return negA === negB;
}

/** 获取知识库条目的「字母 → 选项文本」映射（优先读结构化 options 字段，否则从 raw 解析） */
function getEntryOptions(entry) {
  if (entry && entry.options && typeof entry.options === 'object' && Object.keys(entry.options).length) {
    return entry.options;
  }
  return parseOptionsFromText((entry && entry.raw) || (entry && entry.question) || '');
}

function parseKbOptions(raw) {
  return parseOptionsFromText(raw);
}

function optKey(t) {
  return normOptionText(t);
}

const OPT_NEG_RE = /(?:^|[^a-z])(不|非|无|未|禁止|不得|不能|不可|无需|无关|除外|以外|没有|不是|不属于|不包括)(?![a-z])/;
function extractNums(t) {
  return (String(t || '').match(/\d+(?:\.\d+)?/g) || []).join(',');
}

/** 计算两段选项文本的相似度（严防数字差异「15天↔5天」或正反极性「支持↔不支持」误匹配） */
function optionSimilarity(textA, textB) {
  const kA = optKey(textA);
  const kB = optKey(textB);
  if (!kA || !kB) return 0;
  if (kA === kB) return 1;

  // 数字或否定极性不一致时，禁止模糊/包含匹配把错误选项认成同一项
  if (OPT_NEG_RE.test(String(textA || '')) !== OPT_NEG_RE.test(String(textB || ''))) return 0;
  const nA = extractNums(textA), nB = extractNums(textB);
  if ((nA || nB) && nA !== nB) return 0;

  const minLen = Math.min(kA.length, kB.length);
  const maxLen = Math.max(kA.length, kB.length);
  if (minLen >= 3 && (kA.includes(kB) || kB.includes(kA))) {
    return 0.82 + 0.16 * (minLen / maxLen);
  }
  const tA = uniqTokens(tokenize(textA));
  const tB = new Set(uniqTokens(tokenize(textB)));
  if (!tA.length || !tB.size) return 0;
  let inter = 0;
  tA.forEach(t => { if (tB.has(t)) inter++; });
  return (2 * inter) / (tA.length + tB.size);
}

/** 在页面选项中寻找与目标文本最匹配的一项 */
function matchPageOption(targetText, pageOpts, usedLabels) {
  const k = optKey(targetText);
  if (!k || !pageOpts || !pageOpts.length) return null;

  // 1) 归一化完全相等
  const exactHit = pageOpts.find(o => (!usedLabels || !usedLabels.has(o.label)) && optKey(o.text) === k);
  if (exactHit) return exactHit;

  // 2) 判断题同义词相等（如「对」↔「正确」）
  const normAns = normalizeAnswerText(targetText);
  if (normAns === '对' || normAns === '错') {
    const judgeHit = pageOpts.find(o => (!usedLabels || !usedLabels.has(o.label)) && normalizeAnswerText(o.text) === normAns);
    if (judgeHit) return judgeHit;
  }

  // 3) 高相似度匹配（包含关系或词元相似度 ≥ 0.72）
  let best = null;
  let bestSim = 0;
  for (const o of pageOpts) {
    if (usedLabels && usedLabels.has(o.label)) continue;
    const sim = optionSimilarity(targetText, o.text);
    if (sim > bestSim) { bestSim = sim; best = o; }
  }
  return bestSim >= 0.72 ? best : null;
}

/** 知识库条目与当前页面选项的重合度（0~1） */
function optionOverlap(q, entry) {
  const kbVals = Object.values(getEntryOptions(entry)).filter(Boolean);
  const pageOpts = q.options || [];
  if (!kbVals.length || !pageOpts.length) return 0;
  const used = new Set();
  let hit = 0;
  for (const txt of kbVals) {
    const m = matchPageOption(txt, pageOpts, used);
    if (m) { hit++; used.add(m.label); }
  }
  return hit / Math.max(kbVals.length, pageOpts.length);
}

/**
 * 判断题语义解析：无论题库写「A / B」「对 / 错」「正确 / 错误」「A（正确）」，
 * 也无论页面把「正确 / 错误」排在 A 还是 B，统一解析为语义「对」或「错」。
 */
function resolveJudgeFromEntry(entry) {
  const rawAns = String(entry.answer || '').trim();
  if (!rawAns) return null;

  // 1) 括号内显式写了正误，如 "A（正确）" / "B(错误)"
  const paren = rawAns.match(/[（(]\s*(对|错|正确|错误|是|否|真|假|√|×|✓|✗|✔|✘|True|False)\s*[)）]/i);
  if (paren) {
    const v = normalizeAnswerText(paren[1]);
    if (v === '对' || v === '错') return v;
  }

  // 2) 答案本身就是正误词（含 "对（A）"、"正确。" 等情况）
  const direct = normalizeAnswerText(rawAns.replace(/[（(]\s*[A-Ha-h]\s*[)）]/g, ''));
  if (direct === '对' || direct === '错') return direct;

  // 3) 答案是选项字母（A/B），反查题库原题中该字母对应的文字
  const ls = pureAnswerLetters(rawAns);
  if (ls.length === 1) {
    const L = ls[0];
    const kbOpts = getEntryOptions(entry);
    if (kbOpts[L]) {
      const mapped = normalizeAnswerText(kbOpts[L]);
      if (mapped === '对' || mapped === '错') return mapped;
    }
    // 题库未写选项行时，按通用题库规范 A=对, B=错
    if (!Object.keys(kbOpts).length && (L === 'A' || L === 'B')) {
      return L === 'A' ? '对' : '错';
    }
  }
  return null;
}

/**
 * 题库答案重映射：
 * 1) 题库答案是字母（如 ABC）→ 查题库选项文本 → 匹配页面打乱后的选项字母；
 * 2) 题库答案直接是选项文字（如「主键」或「Linux、Windows Server」）→ 直接匹配页面选项字母。
 */
function remapKbAnswer(q, entry) {
  const rawAns = String(entry.answer || '').trim();
  const pageOpts = q.options || [];
  if (!rawAns || !pageOpts.length) return null;

  const letters = pureAnswerLetters(rawAns);
  const kbOpts = getEntryOptions(entry);
  const hasKbOpts = Object.keys(kbOpts).length > 0;

  // 路径 A：题库答案是选项字母且题库包含选项文本
  if (letters.length && hasKbOpts) {
    const used = new Set();
    const out = [];
    for (const L of letters) {
      const kbText = kbOpts[L];
      if (!kbText) return null;
      const hit = matchPageOption(kbText, pageOpts, used);
      if (!hit) return null;
      used.add(hit.label);
      out.push(hit.label);
    }
    const sorted = Array.from(new Set(out)).sort();
    return {
      letters: sorted.join(''),
      texts: sorted.map(L => (pageOpts.find(o => o.label === L) || {}).text || '').filter(Boolean),
      by: 'letter-remap'
    };
  }

  // 路径 B：题库答案写成选项内容文本（非字母）
  if (!letters.length) {
    const parts = rawAns.split(/[\n|；;、,，]+/).map(s => s.trim()).filter(Boolean);
    const candidates = parts.length > 1 ? parts : [rawAns];
    const used = new Set();
    const out = [];
    for (const part of candidates) {
      const hit = matchPageOption(part, pageOpts, used);
      if (!hit) return null;
      used.add(hit.label);
      out.push(hit.label);
    }
    if (out.length) {
      const sorted = Array.from(new Set(out)).sort();
      return {
        letters: sorted.join(''),
        texts: sorted.map(L => (pageOpts.find(o => o.label === L) || {}).text || '').filter(Boolean),
        by: 'text-match'
      };
    }
  }

  return null;
}

function inferEffectiveKind(q) {
  if (q.kind && q.kind !== 'auto' && q.kind !== 'page') return q.kind;
  const opts = q.options || [];
  if (opts.length >= 2 && opts.length <= 3 && opts.every(o => {
    const v = normalizeAnswerText(o.text);
    return v === '对' || v === '错';
  })) {
    return 'judge';
  }
  if (opts.length >= 2) return 'multi';
  return 'auto';
}

/**
 * 判定 top 命中能否安全地「免模型直答」：
 * - 只有题库条目（qa）且极性一致（同为正向或同为反向）才能直答客观题；
 * - 讲义段落（chunk）与非简答的术语定义（term）一律走 kb+ai 交由模型结合选项推理；
 * - 选择题必须成功将答案映射到当前页面选项（若题库有选项但与页面对不上，说明是变体题，转 kb+ai）。
 */
/**
 * 让模型把题干改写成几种"同义问法"，用于二次检索。
 * 目的：用户口语化/换问法时也能命中题库（AI 辅助的知识库召回）。
 */
async function expandQueries(stem, settings) {
  const text = String(stem || '').trim();
  if (text.length < 6) return [];
  try {
    const messages = [
      {
        role: 'system',
        content: '你是检索助手。把用户给的考试题干改写成 3 种不同的问法，保持考查的知识点完全相同。' +
          '只输出 JSON 数组，例如 ["问法1","问法2","问法3"]，不要解释。'
      },
      { role: 'user', content: text.slice(0, 400) }
    ];
    const raw = await streamChat({
      settings: Object.assign({}, settings, { maxTokens: Math.min(320, Number(settings.maxTokens) || 512), temperature: 0.2 }),
      messages,
      jsonMode: false,
      onDelta: () => { }
    });
    const m = String(raw || '').match(/\[[\s\S]*?\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    return (Array.isArray(arr) ? arr : [])
      .map(x => String(x || '').trim())
      .filter(x => x.length >= 6 && x !== text)
      .slice(0, 3);
  } catch (e) {
    console.info('[exa] 查询扩展失败：' + (e && e.message || e));
    return [];
  }
}

/**
 * 检索包装：先用原题干查；有候选但没到直答线时，用改写问法再试。
 * 真的库里没有相关内容时不做扩展，避免白花 token。
 */
async function kbLookupSmart(q, settings) {
  const first = await kbLookup(q, settings);
  if (first.mode === 'kb' || first.mode === 'miss') return first;
  if (settings.kbAiExpand === false) return first;
  if (!first.hits || !first.hits.length) return first;      // 库里完全没相关内容 → 不扩展
  if (settings.model && !settings.apiKey) return first;

  // 只有「非常接近但没到直答线」时才值得花一次模型调用去改写问法；
  // 完全无关的题直接走 AI 解题，否则每题都要多等一次模型往返。
  const topSim = (first.hits[0] && (first.hits[0].sim || first.hits[0].coverage || 0)) || 0;
  if (topSim < 0.75) return first;

  const variants = await expandQueries(q.stem, settings);
  for (const v of variants) {
    const alt = await kbLookup(Object.assign({}, q, { stem: v }), settings);
    if (alt.mode === 'kb') {
      alt.aiExpanded = v;
      return alt;
    }
  }
  return first;
}

/**
 * AI 预处理一批题库：为每条生成「同义问法 / 关键词 / 知识点」，
 * 写入 enrich 索引，让检索不再依赖字面完全一致。
 */
async function enrichKbBatch(settings, batchSize) {
  const size = Math.max(4, Math.min(24, Number(batchSize) || 12));
  const pending = await kbPendingEnrich(size);
  if (!pending.length) {
    const st = await kbEnrichStats();
    return { ok: true, done: true, ...st };
  }

  const lines = pending.map((e, i) =>
    (i + 1) + '. 题干：' + String(e.question || '').replace(/\s+/g, ' ').slice(0, 200) +
    ' | 答案：' + String(e.answer || '').replace(/\s+/g, ' ').slice(0, 60)
  ).join('\n');

  const messages = [
    {
      role: 'system',
      content: '你是题库检索索引生成器。对每道题生成用于模糊检索的索引，只输出 JSON 数组，不要任何解释。' +
        '格式：[{"i":1,"aliases":["同义问法1","同义问法2"],"keywords":["关键词1","关键词2"],"topic":"知识点"}]'
    },
    {
      role: 'user',
      content: '要求：aliases 是与原题考查同一知识点、但措辞不同的 2-3 个问法（要像考生可能问出的样子）；' +
        'keywords 是能唯一指向该题的 3-5 个关键短语；topic 是一句话知识点。不要复述原答案。\n\n' + lines
    }
  ];

  const raw = await streamChat({
    settings: Object.assign({}, settings, {
      maxTokens: Math.min(2000, Math.max(600, pending.length * 120)),
      temperature: 0.3
    }),
    messages,
    jsonMode: false,
    onDelta: () => { }
  });

  const m = String(raw || '').match(/\[[\s\S]*\]/);
  let arr = [];
  if (m) {
    try { arr = JSON.parse(m[0]); } catch (e) { arr = []; }
  }
  if (!Array.isArray(arr) || !arr.length) {
    return { ok: false, error: '模型没有返回可解析的索引', done: false };
  }

  const rows = [];
  arr.forEach((it, idx) => {
    const pos = Number(it && it.i) - 1;
    const target = pending[pos >= 0 ? pos : idx];
    if (!target) return;
    rows.push({
      id: target.id,
      aliases: it.aliases,
      keywords: it.keywords,
      topic: it.topic
    });
  });

  if (rows.length) await kbWriteEnrich(rows);
  // 索引变了，重建内存缓存
  try { await warmupKb(true); } catch (e) { }

  const st = await kbEnrichStats();
  return { ok: true, done: st.pending === 0, batch: rows.length, ...st };
}



/* ---------------- 本地 OCR（Tesseract，offline） ---------------- */
let offscreenCreating = null;

async function hasOffscreen() {
  try {
    if (chrome.runtime.getContexts) {
      const ctxs = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL('src/offscreen/offscreen.html')]
      });
      return ctxs && ctxs.length > 0;
    }
  } catch (e) { }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return true;
  if (offscreenCreating) { await offscreenCreating; return true; }
  offscreenCreating = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: 'src/offscreen/offscreen.html',
        reasons: ['DOM_PARSER'],
        justification: '在本地运行 Tesseract OCR 识别图片题，不联网'
      });
    } catch (e) {
      // 已存在时忽略
      if (!/already exist/i.test(String(e && e.message || e))) throw e;
    } finally {
      offscreenCreating = null;
    }
  })();
  await offscreenCreating;
  return true;
}

/** 把图片交给本地 Tesseract，返回识别出的纯文本 */
async function ocrLocalText(dataUrl) {
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({
    target: 'offscreen', type: 'ocr-text', dataUrl
  });
  if (!r || !r.ok) throw new Error((r && r.error) || '本地 OCR 失败');
  return { text: r.text || '', ms: r.ms || 0 };
}

const OCR_PROMPT = '这是考试题目的截图。请完整、逐字地识别图中的全部题目（图中可能包含一道或多道题），只输出一个 JSON 对象，不要解释、不要作答：\n' +
  '{"questions":[{"stem":"题干原文（含题号可省略）","kind":"single|multi|judge|fill","options":[{"label":"A","text":"选项原文"}]}]}\n' +
  '要求：\n' +
  '- 逐字识别每一道题，不要漏题，不要只识别第一道\n' +
  '- 不要改写、不要总结、不要给出答案\n' +
  '- 选项按图中顺序输出，label 用 A/B/C/D…\n' +
  '- 判断题的选项就是「正确 / 错误」';

const DOC_IMAGE_OCR_PROMPT = '这是题库或讲义文档中的图片，里面可能包含**多道题目**、表格题库或知识点。请完整、逐字地识别图中的全部内容，不要漏掉任何一题。\n' +
  '要求：\n' +
  '1. 如果是选择题/判断题/填空题/简答题，请严格按以下纯文本格式**逐题**输出，每道题之间空一行：\n' +
  '1. 题干原文\n' +
  'A. 选项原文\n' +
  'B. 选项原文\n' +
  '答案：B（如果图中有答案、勾选题标或解析请写出；若图底有「正确答案是 A，回答正确/错误」等练习反馈，只写「答案：A」并去掉「回答正确/错误」等反馈词；图中没有答案则不要编造，省略答案行）\n' +
  '解析：...（如有）\n' +
  '2. 如果是表格题库，请把每一行拆成上述独立题号格式输出。\n' +
  '3. 如果是纯知识点笔记/概念列表，请按原结构逐条清晰整理为纯文本。\n' +
  '4. 只输出整理后的纯文本内容，不要代码块围栏（```）或多余说明。';

/** 用视觉模型识别文档图片里的全部内容（支持一图多题） */
async function ocrDocImage(settings, dataUrl) {
  const vision = String(settings.visionModel || settings.model || '').trim();
  if (!vision) throw new Error('未配置视觉模型');
  const t0 = Date.now();
  const messages = [
    { role: 'system', content: '你是精准的题库与文档图像转录引擎，只忠实转录图中的全部题目和知识点，不漏题、不编造未出现的答案。' },
    {
      role: 'user',
      content: [
        { type: 'text', text: DOC_IMAGE_OCR_PROMPT },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }
  ];
  messages.__model = vision;

  const raw = await streamChat({
    settings: Object.assign({}, settings, {
      maxTokens: Math.min(4096, Math.max(1200, Number(settings.maxTokens) || 2400)),
      temperature: 0
    }),
    messages,
    jsonMode: false,
    onDelta: () => { }
  });

  const text = String(raw || '').replace(/^```(?:\w+)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!text || text.length < 4) throw new Error('视觉模型未返回有效文本');
  return { text, ms: Date.now() - t0, model: vision };
}

/** 把一张题目图片识别成 {questions:[{stem, kind, options}], stem, kind, options} */
async function ocrQuestionImage(settings, dataUrl) {
  const vision = String(settings.visionModel || settings.model || '').trim();
  if (!vision) throw new Error('未配置视觉模型，无法识别图片题');
  const messages = [
    { role: 'system', content: '你是精准的 OCR 引擎，只做识别不做解答。' },
    {
      role: 'user',
      content: [
        { type: 'text', text: OCR_PROMPT },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }
  ];
  messages.__model = vision;

  const raw = await streamChat({
    settings: Object.assign({}, settings, {
      maxTokens: Math.min(2400, Math.max(600, Number(settings.maxTokens) || 1600)),
      temperature: 0
    }),
    messages,
    jsonMode: false,
    onDelta: () => { }
  });

  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('模型没有返回可解析的题目结构');
  let obj;
  try { obj = JSON.parse(m[0]); } catch (err) { throw new Error('题目结构不是合法 JSON'); }

  const rawList = Array.isArray(obj.questions) && obj.questions.length ? obj.questions : [obj];
  const questions = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const stem = String(item.stem || '').replace(/\s+/g, ' ').trim();
    if (!stem || stem.length < 4) continue;
    const opts = (Array.isArray(item.options) ? item.options : [])
      .map((o, i) => ({
        label: String((o && o.label) || String.fromCharCode(65 + i)).toUpperCase().slice(0, 1),
        text: String((o && o.text) || '').trim()
      }))
      .filter(o => o.text);
    let kind = String(item.kind || '').trim();
    if (!['single', 'multi', 'judge', 'fill'].includes(kind)) {
      kind = opts.length === 2 ? 'judge' : (opts.length ? 'single' : 'short');
    }
    questions.push({ stem, kind, options: opts });
  }
  if (!questions.length) throw new Error('识别出的题干太短');
  const first = questions[0];
  return { questions, stem: first.stem, kind: first.kind, options: first.options, model: vision };
}


/** 「全选 / 以上都是 / 全部都选」这类答案 → 所有选项字母 */
const ALL_SELECT_RE = /(全选|以上都(是|正确|选)|全部(都)?(选|正确|是)|都选|全对|以上皆是)/;

function expandAllSelect(answer, optCount) {
  const a = String(answer || '');
  if (!ALL_SELECT_RE.test(a)) return null;
  const n = Math.max(1, Math.min(8, Number(optCount) || 6));
  return Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i)).join('');
}

function canDirectAnswerFromKb(q, top, settings, conflict) {
  // 题库里同一题干有多条且答案矛盾，又分不清是哪条 → 不直答，交给模型
  if (conflict) return { ok: false, reason: 'variant-conflict' };
  if (!top || !top.entry) return { ok: false };
  const e = top.entry;

  // 「全选」类答案先展开成字母，否则会被当成"不是选项字母"直接拒绝
  const optCount = (q.options || []).length;
  const expanded = expandAllSelect(e.answer, optCount);
  if (expanded) {
    e.answer = expanded;
  }
  const rawAns = String(e.answer || '').trim();
  if (!rawAns) return { ok: false };

  // 资料段落（chunk）不是现成题目答案，必须让 AI 基于该段落推理
  if (e.type === 'chunk') return { ok: false, reason: 'prose-chunk' };

  const effKind = inferEffectiveKind(q);
  if (e.type === 'term' && effKind !== 'short' && effKind !== 'auto') {
    return { ok: false, reason: 'term-needs-reasoning' };
  }

  if (!samePolarity(q.stem, e.question)) {
    return { ok: false, reason: 'polarity-flipped' };
  }

  // 近似精确：题干相似度高（库里就是这题，只是措辞/标点/尾巴不同）也算命中
  const nearExact = !top.exact && (
    top.near === true ||
    top.sim >= 0.9 ||
    (((top.stemCov || 0) >= 0.85 || (top.coverage || 0) >= 0.82) && top.score >= 14)
  );
  if (!top.exact && !nearExact) return { ok: false, reason: 'not-exact' };

  // 无选项场景（如设置页检索测试、填空题、简答题）
  const pageOpts = q.options || [];
  if (!pageOpts.length || effKind === 'fill' || effKind === 'short' || effKind === 'calc') {
    if (top.exact || (nearExact && (top.stemCov || 0) >= 0.9)) {
      return { ok: true, answer: rawAns };
    }
    return { ok: false };
  }

  // 判断题：解析出明确的「对 / 错」即可直答
  if (effKind === 'judge') {
    const jAns = resolveJudgeFromEntry(e);
    if (jAns) return { ok: true, answer: jAns };
    return { ok: false, reason: 'judge-unresolvable' };
  }

  const kbOpts = getEntryOptions(e);
  const kbOptCount = Object.keys(kbOpts).length;

  // 题库有选项文本时，必须先核对选项集合整体重合度 ≥ 0.5，防止只碰巧对上 1 个选项就套错变体题
  if (kbOptCount >= 2 && pageOpts.length >= 2) {
    const ov = optionOverlap(q, e);
    if (ov < 0.5) {
      return { ok: false, reason: 'options-low-overlap' };
    }
  }

  // 单选 / 多选题：必须基于选项内容重映射后才能直答，绝不盲信未核对的 A/B/C/D 字母
  const mapped = remapKbAnswer(q, e);
  if (mapped && mapped.letters) {
    const ans = effKind === 'single' ? mapped.letters[0] : mapped.letters;
    return { ok: true, answer: ans, mapped };
  }

  // 题库本身记录了选项，但与当前页面的选项无法映射 → 同题干不同选项的变体题，绝不盲填原字母
  if (kbOptCount > 0) {
    return { ok: false, reason: 'options-mismatch' };
  }

  // 题库未存选项文字且答案仅为 A/B/C/D 字母：选项顺序可能已打乱，禁止盲选字母，交由模型核对选项内容
  const pureLs = pureAnswerLetters(rawAns);
  if (pureLs.length) {
    return { ok: false, reason: 'kb-missing-options' };
  }

  return { ok: false, reason: 'unresolvable-choice' };
}

const GENERIC_OPT_RE = /^(对|错|正确|错误|是|否|以上都是|以上皆是|以上全对|以上都不对|以上都不是|全选|全不选)$/i;

/**
 * 多路知识库检索：
 * 1) 主查询（题干 + 全部选项）抓整体最相关的条目；
 * 2) 当未直接精确命中且存在实质性选项时，对每个选项并行做子查询，
 *    解决「以下说法正确的是/错误的是」等泛化题干及跨章节综合多选题漏检问题。
 */
function pruneTailNoise(sorted, maxCount) {
  if (!sorted || !sorted.length) return [];
  const topScore = sorted[0].score || 0;
  return sorted.filter((h, idx) => {
    if (idx === 0) return true;
    if (h.exact) return true;
    if (h.matchedOptions && h.matchedOptions.length > 0) return true;
    const minRelScore = topScore >= 500 ? 6.0 : Math.max(2.2, topScore * 0.22);
    return h.score >= minRelScore && (h.coverage || 0) >= 0.16;
  }).slice(0, maxCount);
}

async function retrieveKbHits(q, settings) {
  const topK = Math.max(5, Number(settings.kbTopK) || 5);
  const limit = Math.min(8, Math.max(topK, 6));
  const optTexts = (q.options || []).map(o => o.text).filter(Boolean);
  const fullQuery = [q.stem, ...optTexts].join(' ');
  const pageFp = optionsFingerprint(
    (q.options || []).map(o => o.label + '. ' + (o.text || '')).join(' ')
  );

  const primary = await kbSearch(fullQuery, {
    topK: Math.max(6, topK),
    exactQuestion: q.stem,
    pageFp
  });

  if (primary.length && canDirectAnswerFromKb(q, primary[0], settings).ok) {
    return pruneTailNoise(primary, limit);
  }

  const substOpts = (q.options || []).filter(o => {
    const clean = String(o.text || '').trim();
    return clean.length >= 4 && !GENERIC_OPT_RE.test(clean);
  }).slice(0, 6);

  if (!substOpts.length) return pruneTailNoise(primary, limit);

  const subResults = await Promise.all(
    substOpts.map(o => kbSearch(o.text, { topK: 2, exactQuestion: o.text }).catch(() => []))
  );

  const merged = new Map();
  primary.forEach(h => {
    merged.set(h.entry.id, Object.assign({}, h, { matchedOptions: [] }));
  });

  subResults.forEach((rows, idx) => {
    const optLabel = substOpts[idx].label;
    (rows || []).forEach(h => {
      const isStrongSub = h.exact || h.score >= 3.0 || ((h.entryCov || 0) >= 0.75 && h.score >= 1.8);
      if (!isStrongSub) return;
      const prev = merged.get(h.entry.id);
      if (prev) {
        if (!prev.matchedOptions.includes(optLabel)) {
          prev.matchedOptions.push(optLabel);
          prev.score += 0.85;
        }
        prev.coverage = Math.max(prev.coverage || 0, (h.coverage || 0) * 0.9);
      } else {
        merged.set(h.entry.id, Object.assign({}, h, {
          score: h.exact ? 30 : h.score * 0.92,
          exact: false,
          matchedOptions: [optLabel]
        }));
      }
    });
  });

  const sorted = Array.from(merged.values())
    .sort((a, b) => (b.exact - a.exact) || (b.score - a.score));

  return pruneTailNoise(sorted, limit);
}

async function kbLookup(q, settings) {
  if (settings.kbEnabled === false) return { mode: 'off', hits: [], kbUpdatedAt: 0 };
  try {
    const st = await kbStats();
    const kbUpdatedAt = st.updatedAt || 0;
    if (!st.entries) return { mode: 'ai', hits: [], empty: true, kbUpdatedAt };

    const hits = await retrieveKbHits(q, settings);
    if (!hits.length) {
      if (settings.kbStrict) return { mode: 'miss', hits: [], strict: true, kbUpdatedAt };
      return { mode: 'ai', hits: [], kbUpdatedAt };
    }

    const top = hits[0];
    const ov = optionOverlap(q, top.entry);
    const direct = canDirectAnswerFromKb(q, top, settings, (hits && hits.__conflict) || null);

    if (direct.ok && settings.kbDirect !== false) {
      return { mode: 'kb', hits,
      conflict: (hits && hits.__conflict) || null, overlap: ov, direct, kbUpdatedAt };
    }

    if (settings.kbStrict) {
      // 严格模式：即使关了 kbDirect，只要能由题库确定性解出也直接给答案；否则明确报未收录
      if (direct.ok) return { mode: 'kb', hits, overlap: ov, direct, kbUpdatedAt };
      return { mode: 'miss', hits, overlap: ov, strict: true, kbUpdatedAt };
    }

    // 只要检索到具有实质相关性的知识库条目（含讲义段落、术语、变形原题、选项关联依据），全部送入 kb+ai 供模型依据作答
    const hasRelevantContext = top.exact ||
      top.score >= 2.0 ||
      (top.stemCov || 0) >= 0.18 ||
      (top.coverage || 0) >= 0.22 ||
      hits.some(h => h.matchedOptions && h.matchedOptions.length > 0);

    if (hasRelevantContext && settings.kbContext !== false) {
      return { mode: 'kb+ai', hits, overlap: ov, kbUpdatedAt };
    }
    return { mode: 'ai', hits, overlap: ov, kbUpdatedAt };
  } catch (e) {
    console.warn('[exa] 知识库检索失败', e && e.message);
    return { mode: 'ai', hits: [], kbUpdatedAt: 0, error: String(e && e.message || e) };
  }
}

function fromKb(q, hits, directInfo) {
  const top = hits[0];
  const e = top.entry;
  const rawAnswer = String(e.answer || e.raw || '');
  const resolved = directInfo && directInfo.ok ? directInfo : canDirectAnswerFromKb(q, top, {});
  const mapped = (resolved && resolved.mapped) || remapKbAnswer(q, e);

  let effKind = (q.kind && q.kind !== 'auto' && q.kind !== 'page') ? q.kind : inferEffectiveKind(q);
  let answer;
  if (resolved && resolved.answer != null) {
    const rawResolved = String(resolved.answer).trim();
    if (effKind !== 'judge' && (rawResolved === '对' || rawResolved === '错')) effKind = 'judge';
    if ((!q.kind || q.kind === 'auto' || q.kind === 'page') && effKind === 'multi') {
      const ls = lettersOf(rawResolved);
      if (ls.length === 1) effKind = 'single';
    }
    answer = normalizeAnswer(rawResolved, effKind, q);
  } else if (effKind === 'judge') {
    answer = resolveJudgeFromEntry(e) || normalizeAnswer(rawAnswer, 'judge', q);
  } else {
    const candidate = mapped ? mapped.letters : rawAnswer;
    if ((!q.kind || q.kind === 'auto' || q.kind === 'page') && effKind === 'multi') {
      const ls = lettersOf(candidate);
      if (ls.length === 1) effKind = 'single';
    }
    answer = normalizeAnswer(candidate, effKind, q);
  }

  const origLetters = pureAnswerLetters(rawAnswer).join('');
  const mappedLine = mapped && mapped.letters
    ? (mapped.letters !== origLetters
      ? '选项重映射：' + rawAnswer.slice(0, 30) + ' → ' + mapped.letters + (mapped.texts.length ? '（' + mapped.texts.join('；') + '）' : '')
      : (mapped.texts && mapped.texts.length ? '选项内容已核对：' + mapped.letters + '（' + mapped.texts.join('；') + '）' : ''))
    : '';
  const reasoning = [
    '【知识库命中】' + e.docName + (e.type === 'term' ? '（术语条目）' : '（题库条目）'),
    top.exact ? '题干精确匹配' : ('相关度 ' + Math.round((top.coverage || 0) * 100) + '%（BM25 ' + Math.round(top.score) + '）'),
    '',
    '原条目：' + String(e.question || '').slice(0, 300),
    '条目答案：' + rawAnswer.slice(0, 300),
    e.explain ? ('原题解析：' + String(e.explain).slice(0, 260)) : '',
    mappedLine
  ].filter(Boolean).join('\n');

  let notes = top.exact ? '' : '非精确匹配，建议核对';
  if (resolved && resolved.unmappedNotice) {
    notes = (notes ? notes + '；' : '') + '题库未含选项文本，按原字母匹配';
  }

  return {
    kind: effKind || q.kind,
    answer,
    reasoning,
    confidence: top.exact ? 0.99 : 0.9,
    notes,
    source: { kind: 'kb', hits: summarizeHits(hits) }
  };
}

function partialReasoning(acc) {
  const m = String(acc).match(/"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (!m) return null;
  return m[1]
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/* ---------------- 解题主流程 ---------------- */

async function solveOne({ q, settings, emit }) {
  const ckey = cacheKeyOf(q);

  // 1) 知识库优先（本地确定性命中即免模型调用）
  const lookup = await kbLookupSmart(q, settings);
  if (lookup.mode === "kb") {
    emit({ type: "status", text: "知识库命中" });
    const kbResult = fromKb(q, lookup.hits, lookup.direct);
    emit({ type: "thinking", text: kbResult.reasoning });
    const w = validateAnswer(kbResult, q);
    if (w) kbResult.warn = w;
    return kbResult;
  }

  // 1.5) 严格模式：题库没收录就明确告知，不调用模型
  if (lookup.mode === "miss") {
    emit({ type: "status", text: "知识库未收录" });
    const msg = "严格模式开启：题库里没有精确匹配到这道题，已跳过模型调用，请人工作答或把题目存入知识库。";
    emit({ type: "thinking", text: msg });
    return {
      kind: q.kind,
      answer: "",
      reasoning: msg,
      confidence: 0,
      warn: "知识库未收录此题",
      source: { kind: "miss", hits: summarizeHits(lookup.hits || []) }
    };
  }

  // 2) 本地缓存（知识库有相关依据或知识库晚于旧 AI 缓存更新时，自动绕过旧缓存重新基于知识库作答）
  if (settings.cacheEnabled !== false && !q.noCache) {
    const cachedBox = await cacheGetBox(ckey, Number(settings.cacheTtlDays) || 7);
    const cached = cachedBox && cachedBox.data;
    const cachedTs = (cachedBox && cachedBox.ts) || 0;
    const cachedFromKb = !!(cached && cached.source && cached.source.kind === "kb");
    const staleBeforeKbUpdate = !cachedFromKb && lookup.kbUpdatedAt > 0 && cachedTs < lookup.kbUpdatedAt;
    const skipForKb = cached && !cachedFromKb && (lookup.mode === "kb+ai" || staleBeforeKbUpdate);
    if (cached && cached.answer && !skipForKb) {
      emit({ type: "status", text: "使用缓存答案" });
      return Object.assign({}, cached, {
        source: { kind: "cache", hits: [] },
        reasoning: cached.reasoning || "（本次来自本地缓存）"
      });
    }
  }

  const kbText = lookup.mode === "kb+ai" ? formatHits(lookup.hits) : "";
  if (kbText) emit({ type: "status", text: "基于知识库推理中…" });

  const messages = buildMessages(q, settings, { kbText });
  let acc = "";

  // 思考过程边生成边回传（全量文本 + 60ms 节流），UI 直接整段替换
  let lastAt = 0;
  const onDelta = chunk => {
    acc += chunk;
    const now = Date.now();
    if (now - lastAt < 60) return;
    lastAt = now;
    const think = partialReasoning(acc);
    emit({ type: "thinking", text: think || acc.slice(-1200) });
  };

  let raw = '';
  try {
    raw = await streamChat({ settings, messages, jsonMode: true, onDelta });
  } catch (e) {
    const em = String((e && e.message) || e);
    if (/没有返回内容|返回为空|max_tokens/.test(em)) {
      acc = '';
      const bumpTokens = /max_tokens/.test(em)
        ? Object.assign({}, settings, { maxTokens: Math.max(4096, Number(settings.maxTokens) || 2048) })
        : settings;
      raw = await streamChat({ settings: bumpTokens, messages, jsonMode: false, stream: false, onDelta });
    } else {
      throw e;
    }
  }
  let result = normalizeResult(raw, q);

  if (settings.doubleCheck) {
    emit({ type: "status", text: "复核中…" });
    const base = JSON.stringify({ answer: result.answer, reasoning: result.reasoning });
    const verifyNote = "【初答】" + base + "\n\n请独立复核：对照题干约束与知识库参考（如有）重新推演一遍，严禁照搬原题选项字母，若初答有误立即纠正。仍然只输出同一个 JSON 对象。";
    const verifyMessages = buildMessages(q, settings, { kbText, verifyNote });
    const raw2 = await streamChat({
      settings, messages: verifyMessages, jsonMode: true,
      onDelta: () => { }
    });
    const second = normalizeResult(raw2, q);
    if (second && second.answer && second.answer !== result.answer) {
      result = Object.assign({}, second, {
        notes: (second.notes ? second.notes + "；" : "") + "复核后修正（初答 " + result.answer + "）"
      });
    } else if (second && second.reasoning && second.reasoning.length > result.reasoning.length) {
      result.reasoning = second.reasoning;
    }
  }

  // 来源诚实标注：若模型明确判定知识库未覆盖（used_kb=false），标为纯 AI 生成
  const groundedInKb = lookup.mode === "kb+ai" && result.usedKb !== false;
  // 纯 AI 作答时，把「库里最像的那条有多像」也带回去，方便判断是题库缺题还是题干对不上
  const topHit = (lookup.hits && lookup.hits[0]) || null;
  const nearMiss = (!groundedInKb && topHit)
    ? {
      sim: Number(topHit.sim != null ? topHit.sim : (topHit.coverage || 0)),
      q: String((topHit.entry && topHit.entry.question) || '').slice(0, 60)
    }
    : null;
  result.source = groundedInKb
    ? { kind: "kb+ai", hits: summarizeHits(lookup.hits) }
    : { kind: "ai", hits: [], nearMiss };

  const warn = validateAnswer(result, q);
  if (warn) result.warn = warn;

  if (settings.cacheEnabled !== false && result.answer) {
    await cachePut(ckey, {
      kind: result.kind, answer: result.answer,
      reasoning: result.reasoning, confidence: result.confidence,
      notes: result.notes || "",
      source: { kind: result.source.kind }
    }, Number(settings.cacheTtlDays) || 7);
  }

  return result;
}


/* ---------------- 答题记录（排查用） ---------------- */
const SOLVE_LOG_KEY = '__exaSolveLog';

async function appendSolveLog(rec) {
  try {
    const cur = await chrome.storage.local.get(SOLVE_LOG_KEY);
    const list = Array.isArray(cur[SOLVE_LOG_KEY]) ? cur[SOLVE_LOG_KEY] : [];
    list.push(rec);
    while (list.length > 120) list.shift();
    await chrome.storage.local.set({ [SOLVE_LOG_KEY]: list });
  } catch (e) { }
}


/* ---------------- 答题记录自动写入本地文件 ---------------- */
const AL_FILE_KEY = '__exaAnswerFileLog';
let answerLogBuffer = [];
let answerLogTimer = null;

function ymd() {
  const d = new Date();
  const p2 = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

/** 把缓冲里的记录写成文件（JSONL：一行一条，方便追加和查看） */
async function flushAnswerLog(force) {
  if (!answerLogBuffer.length) return { ok: true, wrote: 0 };
  const buf = answerLogBuffer.slice();
  answerLogBuffer = [];
  try {
    const payload = buf.map(r => JSON.stringify(r)).join('\n') + '\n';
    const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(payload);
    const filename = 'exa-答题记录-' + ymd() + '.jsonl';
    await chrome.downloads.download({
      url,
      filename,
      conflictAction: 'uniquify',   // 同日追加会生成 (1)(2)，不覆盖
      saveAs: false
    });
    return { ok: true, wrote: buf.length, filename };
  } catch (e) {
    // 失败放回缓冲，下次再试
    answerLogBuffer = buf.concat(answerLogBuffer);
    return { ok: false, error: String(e && e.message || e), wrote: 0 };
  }
}

function scheduleAnswerLogFlush() {
  if (answerLogTimer) return;
  answerLogTimer = setTimeout(() => {
    answerLogTimer = null;
    flushAnswerLog().catch(() => { });
  }, 1500);
}


/**
 * 统一记录一次作答。
 * 必须放在 solveOne 之外调用：知识库直答 / 命中缓存 都会在 solveOne 内部提前返回，
 * 写在里面会漏掉大部分题目。
 */
async function recordSolved(q, result) {
  try {
    const top = result && result.source && result.source.hits && result.source.hits[0];
    const rec = {
      t: Date.now(),
      stem: String((q && (q.stem || q.question)) || '').replace(/\s+/g, ' ').slice(0, 200),
      kind: (q && q.kind) || (result && result.kind) || '',
      opts: ((q && q.options) || []).map(o => String(o.label) + ':' + String(o.text).slice(0, 40)),
      answer: String((result && result.answer) || '').slice(0, 60),
      src: (result && result.source && result.source.kind) || '',
      exact: !!(result && result.source && result.source.hits && result.source.hits[0] && result.source.hits[0].exact),
      topQ: top ? String(top.q || '').slice(0, 80) : '',
      topA: top ? String(top.a || '').slice(0, 20) : '',
      reasoning: String((result && result.reasoning) || '').slice(0, 300),
      warn: (result && result.warn) || ''
    };
    await appendSolveLog(rec);
    const st = await getSettings();
    if (st.autoSaveAnswers !== false) {
      answerLogBuffer.push(rec);
      if (answerLogBuffer.length >= 5) await flushAnswerLog();
      else scheduleAnswerLogFlush();
    }
  } catch (e) { }
}

function makeSolveLog(q, lookup, result) {
  const top = (lookup && lookup.hits && lookup.hits[0]) || null;
  return {
    t: Date.now(),
    stem: String((q && q.stem) || '').replace(/\s+/g, ' ').slice(0, 80),
    kind: (q && q.kind) || '',
    opts: ((q && q.options) || []).map(o => String(o.label) + ':' + String(o.text).slice(0, 20)),
    mode: (lookup && lookup.mode) || '',
    exact: !!(lookup && lookup.hits && lookup.hits[0] && lookup.hits[0].exact),
    kbAnswer: (lookup && lookup.direct && lookup.direct.answer) || '',
    topQ: top ? String(top.entry.question).replace(/\s+/g, ' ').slice(0, 60) : '',
    topA: top ? String(top.entry.answer).slice(0, 12) : '',
    topSim: top ? Number((top.sim != null ? top.sim : top.coverage || 0).toFixed(2)) : 0,
    answer: String((result && result.answer) || '').slice(0, 40),
    src: (result && result.source && result.source.kind) || '',
    warn: (result && result.warn) || ''
  };
}

/* ---------------- 跨 frame 采集 / 回填 ---------------- */

const CONTENT_FILES = [
  'src/content/util.js',
  'src/content/extract.js',
  'src/content/fill.js',
  'src/content/overlay.js',
  'src/content/content.js'
];

async function ensureInjected(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
  } catch (e) { /* 受限页面忽略 */ }
}

async function collectQuestions(tabId) {
  let frames = [];
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        try {
          if (typeof qxExtract === 'undefined') return { empty: true, reason: 'extractor-missing' };
          const info = qxExtract.pageInfo();
          const isTop = window.top === window;
          const bodyText = document.body ? (document.body.innerText || '') : '';
          const list = qxExtract.extractAll({ fallback: isTop });
          const filtered = isTop ? list : list.filter(q => q.kind !== 'page');
          return { info, isTop, questions: filtered, needOcr: qxExtract.needOcr(), textLen: bodyText.length };
        } catch (e) {
          return { error: String(e && e.message || e) };
        }
      }
    });
  } catch (e) {
    await ensureInjected(tabId);
    try {
      frames = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          try {
            const list = qxExtract.extractAll({});
            return { info: qxExtract.pageInfo(), isTop: window.top === window, questions: list, needOcr: qxExtract.needOcr() };
          } catch (err) { return { error: String(err) }; }
        }
      });
    } catch (err) {
      return { ok: false, error: '无法注入脚本：' + (err && err.message) };
    }
  }

  const merged = [];
  let needOcr = false;
  let pageTitle = '';
  frames.forEach(f => {
    const r = f && f.result;
    if (!r || r.error || r.empty) return;
    if (r.isTop && r.info) pageTitle = r.info.title || '';
    if (r.needOcr) needOcr = true;
    (r.questions || []).forEach(q => {
      merged.push(Object.assign({}, q, {
        frameId: f.frameId,
        frameIndex: q.index,
        imageDataUrl: null
      }));
    });
  });
  merged.forEach((q, i) => { q.index = i; });
  return { ok: true, questions: merged, needOcr, pageTitle, frameCount: frames.length };
}

async function undoFill(tabId) {
  let frames = [];
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        try {
          if (typeof qxFill === "undefined") return { ok: false, error: "fill-module-missing" };
          return qxFill.undo();
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      }
    });
  } catch (e) {
    return { ok: false, restored: 0, error: String(e && e.message || e) };
  }
  const results = frames.map(f => f.result).filter(Boolean);
  const restored = results.reduce((n, r) => n + (r.restored || 0), 0);
  const err = results.map(r => r.error).filter(Boolean)[0];
  if (restored > 0) return { ok: true, restored };
  return { ok: false, restored: 0, error: err || "没有可撤销的填涂记录" };
}

async function fillQuestions(tabId, items, opts) {
  opts = opts || {};
  const byFrame = new Map();
  items.forEach(it => {
    if (!byFrame.has(it.frameId)) byFrame.set(it.frameId, []);
    byFrame.get(it.frameId).push(it);
  });
  const reports = [];
  for (const [frameId, list] of byFrame) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [Number(frameId)] },
        func: (payload) => {
          try {
            return payload.items.map(it => Object.assign({ index: it.index }, qxFill.fillByIndex(it.frameIndex, it, payload.opts)));
          } catch (e) {
            return payload.items.map(it => ({ index: it.index, ok: false, error: String(e && e.message || e) }));
          }
        },
        args: [{ items: list, opts: opts }]
      });
      const out = res && res[0] && res[0].result;
      if (Array.isArray(out)) reports.push(...out);
      else reports.push(...list.map(it => ({ index: it.index, ok: false, error: '填充无返回' })));
    } catch (e) {
      reports.push(...list.map(it => ({ index: it.index, ok: false, error: '填充失败：' + (e && e.message) })));
    }
  }
  return reports;
}

/* ---------------- 自动连做心跳（对抗后台标签的 timer 节流） ---------------- */

const AUTO_ALARM = "exa-auto-tick";

function ensureAutoAlarm() {
  try {
    chrome.alarms.create(AUTO_ALARM, { periodInMinutes: 0.5 });
  } catch (e) { }
}

chrome.runtime.onInstalled.addListener(ensureAutoAlarm);
chrome.runtime.onStartup.addListener(ensureAutoAlarm);
ensureAutoAlarm();

chrome.alarms.onAlarm.addListener(async alarm => {
  if (!alarm || alarm.name !== AUTO_ALARM) return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (e) { return; }
  for (const t of tabs) {
    if (!t.id) continue;
    try {
      const res = await chrome.tabs.sendMessage(t.id, { type: "exa-auto-ping" });
      if (res && res.running) break;
    } catch (e) { }
  }
});

/* ---------------- 端口：流式解题 ---------------- */

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'exa') return;
  const controllers = new Map();

  port.onMessage.addListener(async msg => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'cancel') {
      const c = controllers.get(msg.reqId);
      if (c) c.abort();
      return;
    }

    if (msg.type === 'analyze') {
      const reqId = msg.reqId;
      const ctrl = new AbortController();
      controllers.set(reqId, ctrl);
      const emit = payload => {
        try { port.postMessage(Object.assign({ reqId }, payload)); } catch (e) { }
      };
      try {
        const settings = await getSettings();
        if (!settings.apiKey && !/localhost|127\.0\.0\.1|ollama/.test(settings.baseUrl)) {
          throw new Error('还没配置 API Key，点面板右上角 ⚙ 或扩展选项页填写');
        }
        emit({ type: 'status', text: '思考中…' });
        const result = await solveOne({ q: msg.question, settings, emit });
        recordSolved(msg.question, result);        // 不 await，别拖慢返回
        emit({ type: 'done', result });
      } catch (e) {
        emit({ type: 'error', message: String(e && e.message || e) });
      } finally {
        controllers.delete(reqId);
      }
      return;
    }

    if (msg.type === 'ping') {
      try { port.postMessage({ type: 'pong' }); } catch (e) { }
    }
  });

  port.onDisconnect.addListener(() => {
    controllers.forEach(c => { try { c.abort(); } catch (e) { } });
    controllers.clear();
  });
});

/* ---------------- 消息路由 ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  (async () => {
    try {
      switch (msg.type) {
        case 'exa-sw-ping': {
          sendResponse({ ok: true, at: Date.now() });
          break;
        }
        case 'getSettings': {
          const s = await getSettings();
          let kbEntries = 0;
          try { kbEntries = (await kbStats()).entries; } catch (e) { }
          sendResponse({
            ok: true,
            kbEntries,
            settings: {
              baseUrl: s.baseUrl, model: s.model, visionModel: s.visionModel,
              hasKey: !!s.apiKey, autoFillAfterSolve: s.autoFillAfterSolve,
              doubleCheck: s.doubleCheck,
              kbEnabled: s.kbEnabled !== false,
              kbDirect: s.kbDirect !== false,
              kbContext: s.kbContext !== false,
              kbTopK: s.kbTopK,
              kbMinCoverage: s.kbMinCoverage,
              cacheEnabled: s.cacheEnabled !== false,
              skipAnswered: s.skipAnswered !== false,
              concurrency: Number(s.concurrency) || 3,
              autoInterval: Number(s.autoInterval) || 10,
              autoLimit: Number(s.autoLimit) || 0,
              autoNext: s.autoNext === true,
              fillHoldMs: Number(s.fillHoldMs) || 1200,
              stealth: s.stealth !== false,
              followMode: s.followMode !== false,
              kbStrict: s.kbStrict === true,
              kbAiExpand: s.kbAiExpand !== false,
              siteAllow: String(s.siteAllow || ""),
              flashOn: s.flashOn !== false,
              flashMs: s.flashOn === false ? 0 : (Number(s.flashMs) || 1500)
            }
          });
          break;
        }
        case 'saveSettings': {
          const s = await saveSettings(msg.settings || {});
          // 通知所有已打开的页面，让新设置立即生效（免刷新）
          try {
            const tabs = await chrome.tabs.query({});
            for (const t of tabs) {
              if (t.id != null) {
                chrome.tabs.sendMessage(t.id, { type: 'settings-changed' }).catch(() => { });
              }
            }
          } catch (e) { }
          sendResponse({ ok: true, settings: s });
          break;
        }
        case 'collect': {
          const tabId = msg.tabId || (sender.tab && sender.tab.id);
          if (!tabId) { sendResponse({ ok: false, error: '无标签页' }); break; }
          const r = await collectQuestions(tabId);
          sendResponse(r);
          break;
        }
        case 'fill': {
          const tabId = msg.tabId || (sender.tab && sender.tab.id);
          if (!tabId) { sendResponse({ ok: false, error: '无标签页' }); break; }
          const reports = await fillQuestions(tabId, msg.items || [], { skipAnswered: !!msg.skipAnswered });
          sendResponse({ ok: true, reports });
          break;
        }
        case 'screenshot': {
          const tab = msg.tabId ? await chrome.tabs.get(msg.tabId) : (sender.tab || await chrome.tabs.getCurrent());
          const winId = tab && tab.windowId != null ? tab.windowId : (await chrome.windows.getCurrent()).id;
          const dataUrl = await chrome.tabs.captureVisibleTab(winId, { format: 'jpeg', quality: 72 });
          sendResponse({ ok: true, dataUrl });
          break;
        }
        case 'inject': {
          const tabId = msg.tabId || (sender.tab && sender.tab.id);
          if (!tabId) { sendResponse({ ok: false, error: '无标签页' }); break; }
          await ensureInjected(tabId);
          sendResponse({ ok: true });
          break;
        }
        case 'kb-enrich': {
          try {
            const r = await enrichKbBatch(await getSettings(), msg.batchSize);
            sendResponse(r);
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message || e) });
          }
          break;
        }
        case 'kb-enrich-stats': {
          try {
            sendResponse({ ok: true, ...(await kbEnrichStats()) });
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message || e) });
          }
          break;
        }
        case 'kb-enrich-clear': {
          try {
            await kbClearEnrich();
            await warmupKb(true);
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message || e) });
          }
          break;
        }
        case 'ocr-question': {
          try {
            const st = await getSettings();
            const engine = String(st.ocrEngine || 'auto');
            // 本地模式：Tesseract 出文本，交给页面用现有解析器结构化（完全离线）
            if (engine === 'local') {
              const r = await ocrLocalText(msg.dataUrl);
              sendResponse({ ok: true, engine: 'local', text: r.text, ms: r.ms });
              break;
            }
            const r = await ocrQuestionImage(st, msg.dataUrl);
            sendResponse({ ok: true, engine: 'vision', ...r });
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message || e) });
          }
          break;
        }
        case 'ocr-doc-image': {
          try {
            const st = await getSettings();
            const engine = String(st.ocrEngine || 'auto');
            const visionExplicit = String(st.visionModel || '').trim();
            const mainModel = String(st.model || '').trim();
            const looksMultimodal = /vl|vision|gpt-4o|gpt-4\.1|gpt-5|gemini|claude-3|claude-sonnet-4|claude-opus-4|glm-4v|step-1v/i.test(mainModel);
            const useVision = engine === 'vision' || (engine === 'auto' && (!!visionExplicit || looksMultimodal));
            let visionError = '';
            if (useVision) {
              try {
                const r = await ocrDocImage(st, msg.dataUrl);
                sendResponse({ ok: true, engine: 'vision', ...r });
                break;
              } catch (ve) {
                visionError = String(ve && ve.message || ve);
                if (engine === 'vision') {
                  sendResponse({ ok: false, allowFallback: false, error: visionError });
                  break;
                }
              }
            }
            const r = await ocrLocalText(msg.dataUrl);
            sendResponse({ ok: true, engine: 'local', visionError, ...r });
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message || e) });
          }
          break;
        }
        case 'ocr-local-text': {
          try {
            const r = await ocrLocalText(msg.dataUrl);
            sendResponse({ ok: true, ...r });
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message || e) });
          }
          break;
        }
        case 'ocr-engine-status': {
          try {
            await ensureOffscreen();
            const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ocr-status' });
            sendResponse({ ok: true, ready: !!(r && r.ready), error: (r && r.error) || '' });
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message || e) });
          }
          break;
        }
        case 'answer-log-flush': {
          try {
            const r = await flushAnswerLog(true);
            sendResponse(r);
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message || e) });
          }
          break;
        }
        case 'answer-log-status': {
          sendResponse({ ok: true, pending: answerLogBuffer.length });
          break;
        }
        case 'solve-log': {
          try {
            const cur = await chrome.storage.local.get(SOLVE_LOG_KEY);
            sendResponse({ ok: true, list: cur[SOLVE_LOG_KEY] || [] });
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message || e) });
          }
          break;
        }
        case 'solve-log-clear': {
          await chrome.storage.local.set({ [SOLVE_LOG_KEY]: [] });
          sendResponse({ ok: true });
          break;
        }
        case 'kb-warm': {
          // 导入题库后调用：重建后台内存索引，第一次检索就是 0ms
          try {
            const st = await warmupKb(true);
            sendResponse({ ok: true, entries: st.entries, ms: st.ms, at: st.at });
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message || e) });
          }
          break;
        }
        case 'kb-warm-status': {
          sendResponse({ ok: true, state: _kbWarmState });
          break;
        }
        case 'reinject-all': {
          const r = await reinjectAllTabs('手动重注入');
          sendResponse({ ok: true, injected: r.injected });
          break;
        }
        case 'kbTest': {
          try {
            const st = await kbStats();
            const r = await kbLookup({
              stem: msg.question || '',
              options: msg.options || [],
              kind: msg.kind || 'auto'
            }, await getSettings());
            const resolvedAns = r.direct && r.direct.answer
              ? r.direct.answer
              : (r.hits && r.hits[0] ? String(r.hits[0].entry.answer || '') : '');
            sendResponse({
              ok: true,
              entries: st.entries,
              mode: r.mode,
              overlap: r.overlap != null ? Number(r.overlap.toFixed(2)) : null,
              exact: !!(r.hits && r.hits[0] && r.hits[0].exact),
              answer: resolvedAns,
              hits: (r.hits || []).slice(0, 5).map(h => ({
                q: String(h.entry && h.entry.question || '').slice(0, 60),
                a: h.entry && h.entry.answer,
                type: h.entry && h.entry.type,
                doc: h.entry && h.entry.docName,
                exact: !!h.exact,
                score: h.score != null ? Number(h.score.toFixed(1)) : null,
                cov: h.coverage != null ? Number(h.coverage.toFixed(2)) : null
              }))
            });
          } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
          break;
        }
        case 'kbChanged': {
          const removed = await cacheInvalidateAiOnly();
          try {
            const tabs = await chrome.tabs.query({});
            for (const t of tabs) {
              if (t.id != null) {
                chrome.tabs.sendMessage(t.id, { type: 'kb-changed' }).catch(() => { });
              }
            }
          } catch (e) { }
          sendResponse({ ok: true, cacheInvalidated: removed });
          break;
        }
        case 'badge': {
          const tabId = msg.tabId || (sender.tab && sender.tab.id);
          try {
            if (tabId) {
              await chrome.action.setBadgeText({ text: msg.text || '', tabId });
              if (msg.text) await chrome.action.setBadgeBackgroundColor({ color: '#1f6feb', tabId });
            }
          } catch (e) { }
          sendResponse({ ok: true });
          break;
        }
        case 'fillUndo': {
          const tabId = msg.tabId || (sender.tab && sender.tab.id);
          if (!tabId) { sendResponse({ ok: false, error: '无标签页' }); break; }
          const r = await undoFill(tabId);
          sendResponse(r);
          break;
        }
        case 'kbAdd': {
          const list = Array.isArray(msg.entries) ? msg.entries : [];
          if (!list.length) { sendResponse({ ok: false, error: '没有可存入的条目' }); break; }
          const added = await kbAddEntries(list, msg.docName || '手动收录');
          sendResponse({ ok: true, added });
          break;
        }
        case 'cacheClear': {
          const n = await cacheClear();
          sendResponse({ ok: true, removed: n });
          break;
        }
        case 'stats': {
          let kbEntries = 0;
          try { kbEntries = (await kbStats()).entries; } catch (e) { }
          const cs = await cacheStats();
          sendResponse({ ok: true, kbEntries, cacheCount: cs.count });
          break;
        }
        case 'openOptions': {
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        }
        case 'activeTabInfo': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          sendResponse({ ok: true, tab: tab ? { id: tab.id, title: tab.title, url: tab.url } : null });
          break;
        }
        default:
          sendResponse({ ok: false, error: '未知消息类型：' + msg.type });
      }
    } catch (e) {
      try { sendResponse({ ok: false, error: String(e && e.message || e) }); } catch (err) { }
    }
  })();

  return true; // 异步响应
});

/* ---------------- 快捷键 ---------------- */

chrome.commands.onCommand.addListener(async cmd => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  const map = { 'toggle-panel': 'cmd-toggle', 'solve-all': 'cmd-solve-current', 'fill-all': 'cmd-fill-current' };
  const type = map[cmd];
  if (!type) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type, _fromCommand: true });
  } catch (e) {
    await ensureInjected(tab.id);
    try { await chrome.tabs.sendMessage(tab.id, { type, _fromCommand: true }); } catch (err) { }
  }
});

/* ---------------- 安装引导 ---------------- */

/**
 * 扩展更新后，已打开页面里的旧内容脚本会立刻失去上下文（Chrome 机制），
 * 用户以前必须 F5。现在主动重注入：先清掉旧实例的 booted 标记，再注入新脚本。
 */
async function reinjectAllTabs(reason) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (e) { return { injected: 0 }; }
  let injected = 0;
  for (const t of tabs) {
    if (t.id == null) continue;
    const url = String(t.url || '');
    if (!/^(https?|file):/i.test(url)) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: t.id, allFrames: true },
        func: () => {
          try {
            if (typeof globalThis.__EXA_DESTROY__ === 'function') globalThis.__EXA_DESTROY__();
            globalThis.__EXA_BOOTED__ = null;
          } catch (e) { }
        }
      });
      await chrome.scripting.executeScript({
        target: { tabId: t.id, allFrames: true },
        files: CONTENT_FILES
      });
      injected += 1;
    } catch (e) {
      // 受限页面（chrome://、商店、未授权 file://）忽略
    }
  }
  console.info('[exa] ' + (reason || '重注入') + '完成，已接管 ' + injected + ' 个标签页');
  return { injected };
}

try { self.__exaReinjectAll = reinjectAllTabs; } catch (e) { }
setTimeout(() => { warmupKb().catch(() => { }); }, 300);

chrome.runtime.onInstalled.addListener(async details => {
  if (details.reason === 'install') {
    // 不落盘写默认值：默认配置在 getSettings() 里内存合并，
    // 避免与用户/自动化写入的配置产生覆盖竞态。
    chrome.runtime.openOptionsPage();
  }
  if (details.reason === 'update') {
    // 更新：把新版本推进到所有已打开页面，用户不需要刷新
    setTimeout(() => { reinjectAllTabs('扩展更新').catch(() => { }); }, 800);
  }
});

self.addEventListener && self.addEventListener('unhandledrejection', e => {
  console.warn('[exa] unhandled', e.reason);
});
