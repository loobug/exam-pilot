/* 轻量分词、题干归一化与选项解析：供知识库切分、BM25 检索与答案重映射共用（无外部依赖） */

const STOP_CN = new Set((
  '的 了 在 是 我 有 和 就 不 人 都 一 一个 上 也 很 到 说 要 去 你 会 着 没有 看 好 自己 这 那 ' +
  '什么 下列 以下 哪个 哪些 关于 对于 可以 属于 正确 错误 的是 题目 选项 答案 判断 选择 填空 ' +
  '简答 请 请问 试述 简述 论述 说明 描述 列举 分析 计算 已知 求 解 若 则 其 之 与 及 或 等 中 为 由 ' +
  '这个 那个 我们 他们 以及 因为 所以 但是 如果 已经 还是 不是 就是 主要 包括 如下 如图 下表 ' +
  '说法 表述 叙述 理解 做法 行为 各项'
).split(/\s+/).filter(Boolean));

const STOP_EN = new Set((
  'the a an of to in is are was were be been being and or for with on at by this that these those ' +
  'it its as from into about which what who whom whose when where why how not no yes do does did ' +
  'can could should would will shall may might must have has had you your we our they their he she him her'
).split(/\s+/).filter(Boolean));

const CJK_RE = /[\u4e00-\u9fa5]+/g;
const LATIN_RE = /[a-z][a-z0-9_+#.\-]*|\d+(?:\.\d+)?/g;

const TYPE_TAG_CLEAN_RE = /[（(【\[]\s*(?:单项选择|多项选择|不定项选择|不定项|单选|多选|判断正误|判断|填空|简答|问答|论述|名词解释|计算|案例分析|材料|选择)题?\s*(?:[,，、\s]*\d+(?:\.\d+)?\s*分)?\s*[)）】\]]/gi;
const SCORE_TAG_CLEAN_RE = /[（(【\[]\s*(?:共\s*)?\d+(?:\.\d+)?\s*分\s*[)）】\]]/g;
const TAIL_NOISE_RE = /(?:请选择一项|请选择答案|请选择正确答案|请选择正确选项|请选择|请作答|请判断|请填写|请选|选择一项|选择一个|单项选择|多项选择|不定项选择|单选|多选|判断正误|判断对错)$/;
const HEAD_TYPE_CLEAN_RE = /^\s*(?:单项选择|多项选择|不定项选择|不定项|单选|多选|判断正误|判断|填空|简答|问答|论述|名词解释|计算|案例分析|选择)题?\s*[:：、.\-]?\s*/;

function nfkc(s) {
  const raw = String(s == null ? '' : s);
  try { return raw.normalize('NFKC'); } catch (e) { return raw; }
}

/**
 * 剥离题干末尾附带的选项列表：
 * - 支持换行「\nA. xxx」「\n(A) xxx」「\nA: xxx」（冒号/顿号后有无空格均可）
 * - 支持同行「题干 A.选项1 B.选项2」（要求后面还出现 B 选项，避免误切「当 A、B 两台设备…」）
 */
export function stripOptions(text) {
  const s = nfkc(text);
  // 1) 换行后紧跟 A 选项标记
  const nl = s.match(/\n\s*(?:[（(\[]\s*A\s*[)）\]]|A\s*[.、,，:：)）．])\s*\S/);
  if (nl) return s.slice(0, nl.index);
  // 2) 同行出现 A 选项且后续出现 B 选项（A 与 B 之间必须有选项内容）
  const inline = s.match(/\s+(?:[（(\[]\s*A\s*[)）\]]|A\s*[.、:：)）．])\s*\S[\s\S]*?\s+(?:[（(\[]\s*B\s*[)）\]]|B\s*[.、:：)）．])\s*\S/);
  if (inline) return s.slice(0, inline.index);
  return s;
}

/** 归一化题干：去题号/题型标签/分值/括号空位/标点空白，用于精确命中判断 */
export function normalizeQuestion(text) {
  let s = stripOptions(text);
  s = s.split(/(?:^|[\s\n])(?:参考答案|正确答案|标准答案|答案|解答)\s*[:：]/)[0];
  // 连续剥离题首序号与题型标签（如「1. 【单选题】（2分）」或「【单选】1、」）
  for (let i = 0; i < 3; i++) {
    const prev = s;
    s = s
      .replace(/^\s*(?:第\s*\d{1,5}\s*(?:[\/／]\s*\d{1,5}\s*)?[题小道]?\s*|[（(\[]\s*\d{1,5}\s*[)）\]]\s*|\d{1,5}\s*[.、)）．,，:：]\s*|[Qq]\s*\d{1,5}\s*[.、:：]?\s*|问题?\s*\d{1,5}\s*[:：.]\s*)/, '')
      .replace(TYPE_TAG_CLEAN_RE, '')
      .replace(SCORE_TAG_CLEAN_RE, '')
      .replace(HEAD_TYPE_CLEAN_RE, '');
    if (s === prev) break;
  }
  // 尾部噪音：页面常带「请选择一项」「（多选）」这类提示，库里的题干没有，会白白对不上
  for (let i = 0; i < 4; i++) {
    const prev = s;
    s = s.replace(TAIL_NOISE_RE, '').replace(/[\s\u3000。，,、；;：:]+$/, '');
    if (s === prev) break;
  }
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5+=<>%]/g, '')
    .slice(0, 500);
}

/** 分词，返回可能含重复项的 token 数组（重复项用于词频 tf） */
export function tokenize(text) {
  const s = nfkc(text).toLowerCase();
  const out = [];

  const latin = s.match(LATIN_RE) || [];
  for (const w of latin) {
    if (w.length < 2 && !/\d/.test(w)) continue;
    if (STOP_EN.has(w) || STOP_CN.has(w)) continue;
    out.push(w);
  }

  const runs = s.match(CJK_RE) || [];
  for (const run of runs) {
    if (run.length === 1) {
      if (!STOP_CN.has(run)) out.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2);
      if (STOP_CN.has(bg)) continue;
      out.push(bg);
    }
  }
  return out;
}

/** 字符二元组 */
function bigramSet(str) {
  const out = new Set();
  const x = String(str || '');
  if (x.length <= 2) { if (x) out.add(x); return out; }
  for (let i = 0; i < x.length - 1; i++) out.add(x.slice(i, i + 2));
  return out;
}

/**
 * 题干相似度（0~1）：Dice 系数 + 子串加成。
 * 两者都应传 normalizeQuestion 之后的结果。
 */
export function stemSimilarity(a, b) {
  const sa = String(a || ''), sb = String(b || '');
  if (!sa || !sb) return 0;
  if (sa === sb) return 1;
  const A = bigramSet(sa), B = bigramSet(sb);
  let hit = 0;
  A.forEach(x => { if (B.has(x)) hit++; });
  const dice = (2 * hit) / (A.size + B.size);
  if (sa.length >= 8 && sb.length >= 8) {
    const short = sa.length <= sb.length ? sa : sb;
    const long = sa.length <= sb.length ? sb : sa;
    if (long.includes(short) && short.length / long.length >= 0.72) {
      return Math.max(dice, 0.93);
    }
  }
  return dice;
}

/** token 去重 */
export function uniqTokens(tokens) {
  return Array.from(new Set(tokens));
}

/** 词频表 */
export function termFreq(tokens) {
  const map = new Map();
  for (const t of tokens) map.set(t, (map.get(t) || 0) + 1);
  return map;
}

/* ---------------- 选项文本解析与指纹 ---------------- */

export function normOptionText(t) {
  return nfkc(t)
    .replace(/^\s*(?:[（(\[]\s*[A-Ha-h]\s*[)）\]]|[A-Ha-h]\s*[.、,，:：)）．])\s*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5+=<>%]/g, '')
    .slice(0, 80);
}

/** 归一化答案文本（含判断题同义词归一：对/正确/√/true → 对，错/错误/×/false → 错） */
export function normalizeAnswerText(t) {
  const base = nfkc(t).trim();
  const clean = base.replace(/[。.，,\s（）()【】\[\]]/g, '');

  // 先按原样（含 √ / × 之类符号）判断
  if (/^(对|正确|是|真|√|✓|✔|t|true|yes|y)$/i.test(clean)) return '对';
  if (/^(错|错误|否|假|×|✗|✘|x|f|false|no|n)$/i.test(clean)) return '错';

  // 再把 √ / × 这类符号剥掉重试：「正确（√）」「错误（×）」在真实题库里很常见
  const bare = clean.replace(/[√✓✔×✗✘]/g, '');
  if (bare && bare !== clean) {
    if (/^(对|正确|是|真|t|true|yes|y)$/i.test(bare)) return '对';
    if (/^(错|错误|否|假|x|f|false|no|n)$/i.test(bare)) return '错';
  }

  return normOptionText(t);
}

/**
 * 从知识库原文本中提取 { A: '选项文本', B: '...' }
 * 兼容换行与同行排布，兼容「A.文本」「A、文本」「A:文本」「(A)文本」「[A]文本」（分隔符后可无空格）
 */
export function parseOptionsFromText(raw) {
  const map = {};
  const text = nfkc(raw);
  const body = text.split(/(?:^|[\s\n])(?:参考答案|正确答案|标准答案|答案|解答|解析|分析|说明|分类|出处|来源)\s*[:：]/)[0] || text;

  const markRe = /(?:^|[\s\n。；;？?！!）】\]])(?:[（(\[]\s*([A-H])\s*[)）\]]\s*|([A-H])\s*[.、,，:：)）．]\s*)/g;
  const marks = [];
  let m;
  while ((m = markRe.exec(body))) {
    const label = m[1] || m[2];
    const leadLen = m[0].length - m[0].replace(/^[\s\n。；;？?！!）】\]]+/, '').length;
    marks.push({
      label,
      markerStart: m.index + leadLen,
      textStart: markRe.lastIndex
    });
  }
  if (marks.length < 2) return map;

  // 若出现 A 起始的连续选项组，从最后一个合理的 A 开始（避免题干里的偶发字母干扰）
  let startIdx = 0;
  for (let i = 0; i < marks.length; i++) {
    if (marks[i].label === 'A' && marks.slice(i).some(x => x.label === 'B')) {
      startIdx = i;
      break;
    }
  }

  const slice = marks.slice(startIdx);
  for (let i = 0; i < slice.length; i++) {
    const cur = slice[i];
    const end = i + 1 < slice.length ? slice[i + 1].markerStart : body.length;
    const val = body.slice(cur.textStart, end).replace(/\s+/g, ' ').trim();
    if (val && !map[cur.label]) map[cur.label] = val.slice(0, 160);
  }
  return map;
}

/** 把一段文本里的选项抽出来，按归一化文本排序拼成指纹（与字母顺序无关） */
export function optionsFingerprint(text) {
  const map = parseOptionsFromText(text);
  const parts = Object.values(map).map(normOptionText).filter(Boolean).sort();
  return parts.join('|');
}
