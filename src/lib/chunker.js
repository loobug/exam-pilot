import { optionsFingerprint, normalizeQuestion } from './tokenize.js';
/* 范式化：把任意文档切成统一的知识条目
 * 输出 {type:'qa'|'term'|'chunk', question, answer, explain, raw, optFp}
 */

const SECTION_HEAD_RE = /^\s*(?:[一二三四五六七八九十百]+[、.．]\s*\S|第[一二三四五六七八九十百\d]+[部分章节篇单元]\s*\S)/;
const BANNER_LINE_RE = /^(?:练习题目(?:\s*共\s*\d+\s*题)?|模拟(?:考试|练习)(?:\s*共\s*\d+\s*题)?|共\s*\d+\s*题(?:\s*\/\s*共?\s*\d+\s*题)?|第\s*\d+\s*[\/／]\s*\d+\s*题)$/;
const TAG_STEM_START = /^\s*(?:\[[A-Za-z0-9\u4e00-\u9fa5]{1,12}\]|【(?:单选|多选|判断|填空|简答|不定项)[^】]*】)\s*\S/;
const Q_START = /^\s*(?:[（(【\[]\s*(?:单项选择|多项选择|不定项选择|不定项|单选|多选|判断正误|判断|填空|简答|问答|论述|名词解释|计算|案例分析|选择)题?\s*(?:[,，、\s]*\d+(?:\.\d+)?\s*分)?\s*[)）】\]]\s*)?(?:第\s*\d{1,5}\s*[题小道]\s*|[（(\[]\s*\d{1,5}\s*[)）\]]\s*|\d{1,5}\s*[.、)）．:：。]|\d{1,4}\s+(?=\[[A-Za-z\u4e00-\u9fa5]+\]|【)|[Qq]\s*\d{1,5}\s*[.、:：]|(?:题目|问题)\s*\d{1,5}\s*[:：.]|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s*(.*)$/;
const ANS_START = /^\s*(?:【\s*(?:参考|标准|正确)?答案\s*】\s*[:：]?|\[\s*(?:参考|标准|正确)?答案\s*\]\s*[:：]?|(?:参考答案|正确答案|标准答案|选项答案|答案|解答|答)\s*(?:[:：]|(?:是|为)\s*(?=[A-Ha-h]|对|错|正确|错误|√|×|✓|✗|✔|✘)))\s*(.*)$/;
const EXPL_START = /^\s*(?:【\s*(?:答案)?解析\s*】\s*[:：]?|\[\s*(?:答案)?解析\s*\]\s*[:：]?|(?:答案解析|试题解析|解析|分析|说明|考点|点评|难度|分类|出处|来源|章节|知识点|分值)\s*[:：])\s*(.*)$/;
const OPTION_LINE = /^\s*(?:[（(\[]\s*[A-Ha-h]\s*[)）\]]|[A-Ha-h]\s*[.、,，:：)）．]|[A-Ha-h]\s+)\s*\S/;
const TERM_DENY = /^(答案|参考答案|正确答案|标准答案|解析|答案解析|分析|说明|考点|点评|难度|分类|出处|来源|章节|知识点|题型|分值|题干|题目|问题|问|答|答语|选项|[A-Ha-h])$/;
const TERM_LINE = /^\s*(?:[-*•]\s*)?([^\s:：#*]{2,32})\s*[:：]\s*(\S.{2,})$|^\s*(?:[-*•]\s*)?\*\*([^*]{2,32})\*\*\s*[:：]?\s*(\S.{2,})$/;
const HEADING = /^\s*(#{1,6})\s+(.*)$/;

const MAX_ANSWER = 1400;
const MAX_RAW = 2000;
const MAX_CHUNK = 750;
const CHUNK_OVERLAP = 110;

function clean(s) {
  return String(s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function cleanMultiline(lines) {
  return (lines || [])
    .map(l => String(l || '').replace(/\u00a0/g, ' ').replace(/[ \t]{2,}/g, ' ').trim())
    .filter((l, i, arr) => l || (i > 0 && arr[i - 1]))
    .join('\n')
    .trim();
}

/**
 * 从题干中提取内嵌答案（如「（ A ）」「(ABC)」「（对）」「（√）」「【答案：B】」），
 * 同时将题干里的答案还原为空括号「（ ）」，确保与考试页空白题干精确对齐。
 */
function extractInlineAnswer(stemText) {
  let q = String(stemText || '');
  let ans = '';

  // 1) 行尾显式标注：【答案：B】 / 答案：AC
  const tailExplicit = q.match(/(?:[【\[]\s*(?:参考|标准|正确)?答案\s*[:：]?\s*([^】\]]+)\s*[】\]]|(?:^|\s)(?:参考答案|正确答案|标准答案|答案)\s*[:：]\s*(\S+))\s*$/);
  if (tailExplicit) {
    ans = clean(tailExplicit[1] || tailExplicit[2] || '');
    q = q.slice(0, tailExplicit.index).trim();
  }

  // 2) 题干末尾括号内填好的单选/多选/判断答案：如「…合外力（ C ）。」「…正确的是（ABC）」「…（对）」
  if (!ans) {
    const endParen = q.match(/[（(]\s*([A-H]{1,8}|对|错|正确|错误|√|×|✓|✗|True|False)\s*[)）](\s*[。.？?！!;；]?\s*)$/i);
    if (endParen) {
      ans = endParen[1].trim();
      q = q.slice(0, endParen.index) + '（ ）' + (endParen[2] || '');
    }
  }

  // 3) 题干中段带空格或多字母的括号填空答案：如「属于（ AC ）的是」「它是（ A ）协议」
  if (!ans) {
    const midParen = q.match(/[（(](?:\s+([A-H]{1,8})\s*|([A-H]{1,8})\s+|([A-H]{2,8})|\s*(正确|错误|√|×|✓|✗)\s*)[)）]/);
    if (midParen) {
      ans = (midParen[1] || midParen[2] || midParen[3] || midParen[4] || '').trim();
      q = q.slice(0, midParen.index) + '（ ）' + q.slice(midParen.index + midParen[0].length);
    }
  }

  return { question: clean(q), inlineAnswer: ans };
}

function cleanParsedAnswer(raw) {
  let a = clean(raw);
  a = a.replace(/^(?:(?:参考|标准|正确|选项)?答案\s*(?:是|为)?\s*[:：]?\s*)/, '');
  a = a.replace(/(?:[,，、;；\s]*(?:回答(?:正确|错误)|恭喜答对|您的答案.*|我的答案.*)|[（(]\s*回答(?:正确|错误)\s*[)）]).*$/, '');
  return clean(a);
}

/** 题号式题库：题干 + 选项 + 答案 + 解析 */
function parseQA(lines) {
  const entries = [];
  const usedLines = new Set();
  let cur = null;
  let mode = 'question';

  const flush = () => {
    if (!cur) return;
    const rawJoined = cleanMultiline(cur.raw);
    const rawQuestion = clean(cur.question.join(' '));
    const { question, inlineAnswer } = extractInlineAnswer(rawQuestion);
    const explicitAns = cleanParsedAnswer(cur.answer.join(' '));
    const answer = (explicitAns || cleanParsedAnswer(inlineAnswer)).slice(0, MAX_ANSWER);
    const explain = clean(cur.explain.join(' ')).slice(0, 900);

    // 必须真正解析出答案才算有效题库条目（防止普通带序号的讲义段落变成空答案废题）
    if (question.length >= 3 && answer.length >= 1) {
      cur.lineIdx.forEach(idx => usedLines.add(idx));
      const fullRaw = explicitAns
        ? rawJoined
        : (rawJoined + `\n答案：${answer}`);
      entries.push({
        type: 'qa',
        question: question.slice(0, 600),
        answer,
        explain,
        raw: (fullRaw || question).slice(0, MAX_RAW),
        optFp: optionsFingerprint(fullRaw || question)
      });
    }
    cur = null;
  };

  const isShortDoneAnswer = arr => {
    if (!arr || !arr.length) return false;
    const cleaned = cleanParsedAnswer(arr.join(' '));
    return /^[A-Ha-h]{1,8}$/.test(cleaned) || /^(?:对|错|正确|错误|是|否|√|×|✓|✗|✔|✘)$/.test(cleaned);
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx].trimEnd();
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (cur) cur.raw.push('');
      continue;
    }

    // 章节大标题或练习页横幅（如「一、单选题」「练习题目 共7题」）先结束上一题，不并入上一题答案
    if (SECTION_HEAD_RE.test(trimmed) || HEADING.test(trimmed) || BANNER_LINE_RE.test(trimmed)) {
      flush();
      continue;
    }

    const qm = Q_START.exec(rawLine);
    const am = ANS_START.exec(rawLine);
    const em = EXPL_START.exec(rawLine);

    if (qm && !am) {
      flush();
      cur = { question: [qm[1] || ''], answer: [], explain: [], raw: [trimmed], lineIdx: [idx], seenOptA: false };
      mode = 'question';
      continue;
    }

    // 已有选项或答案时，若出现「[AF]题干…」或上一题已得出选择/判断单行答案且当前不是解析/答案行，
    // 立即结束上一题，避免把下一题（题号被 OCR 漏掉或格式异常）吞进上一题的答案或选项里！
    if (cur && !am && !em) {
      const hasOptsOrAns = cur.seenOptA || mode === 'options' || mode === 'answer' || mode === 'explain';
      const newTagStem = hasOptsOrAns && TAG_STEM_START.test(rawLine);
      const afterShortAns = mode === 'answer' && isShortDoneAnswer(cur.answer);
      const dupOptBlock = (mode === 'answer' || mode === 'explain' || (cur.seenOptA && mode === 'options')) &&
        /^\s*(?:[（(\[]\s*[Aa]\s*[)）\]]|[Aa]\s*[.、,，:：)）．\s])\s*\S/.test(rawLine);
      if (newTagStem || afterShortAns || dupOptBlock) {
        flush();
      }
    }

    if (!cur) {
      // 无题号起始：仅当不是选项/答案/解析行时暂存为候选首题
      if (!OPTION_LINE.test(rawLine) && !am && !em) {
        cur = { question: [trimmed], answer: [], explain: [], raw: [trimmed], lineIdx: [idx], seenOptA: false };
        mode = 'question';
      }
      continue;
    }

    cur.raw.push(trimmed);
    cur.lineIdx.push(idx);

    if (am) {
      mode = 'answer';
      if (am[1]) cur.answer.push(am[1]);
      continue;
    }
    if (em) {
      mode = 'explain';
      if (em[1]) cur.explain.push(em[1]);
      continue;
    }
    if (OPTION_LINE.test(rawLine)) {
      // 选项行只留在 raw 里供解析映射，不污染题干与答案
      if (/^\s*(?:[（(\[]\s*[Aa]\s*[)）\]]|[Aa]\s*[.、,，:：)）．\s])/.test(rawLine)) cur.seenOptA = true;
      if (mode === 'question') mode = 'options';
      continue;
    }
    if (mode === 'question') cur.question.push(trimmed);
    else if (mode === 'answer') cur.answer.push(trimmed);
    else if (mode === 'explain') cur.explain.push(trimmed);
  }
  flush();
  return { entries, usedLines };
}

/** 「术语：定义」式笔记 */
function parseTerms(lines, skipLines) {
  const entries = [];
  const termLines = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (skipLines && skipLines.has(i)) continue;
    const line = lines[i].trim();
    if (!line || line.length < 4 || line.length > 500) continue;
    if (HEADING.test(line) || SECTION_HEAD_RE.test(line) || OPTION_LINE.test(line) || Q_START.test(line)) continue;
    const m = TERM_LINE.exec(line);
    if (!m) continue;
    const term = clean(m[1] || m[3] || '');
    const def = clean(m[2] || m[4] || '');
    if (!term || !def || def.length < 3) continue;
    if (TERM_DENY.test(term)) continue;
    termLines.add(i);
    entries.push({
      type: 'term',
      question: term.slice(0, 120),
      answer: def.slice(0, MAX_ANSWER),
      explain: '',
      raw: (term + '：' + def).slice(0, MAX_RAW)
    });
  }
  return { entries, termLines };
}

/**
 * 保留章节上下文的段落切分（带滑动重叠 + 题目边界感知）：
 * 1) 讲义/规范/PDF 里的标题（如「## 四大纪律」「一、项目启动阶段」）会挂到下方段落块上；
 * 2) 若段落以题号（Q_START）开头或包含选项行（looksLikeQuestion），
 *    每道题独立成块，绝不与其他题目合并成单一索引。
 */
function parseChunks(lines, skipLines) {
  const sections = [];
  let headingStack = [];
  let paraBuf = [];
  let paraIsQ = false;

  const currentHeading = () => headingStack.filter(Boolean).join(' · ');

  const flushPara = () => {
    if (!paraBuf.length) { paraIsQ = false; return; }
    const text = clean(paraBuf.join('\n'));
    const isQuestion = paraIsQ;
    paraBuf = [];
    paraIsQ = false;
    if (text.length < 12) return;
    sections.push({ heading: currentHeading(), text, isQuestion });
  };

  for (let i = 0; i < lines.length; i++) {
    if (skipLines && skipLines.has(i)) { flushPara(); continue; }
    const raw = lines[i].trim();
    if (!raw) { flushPara(); continue; }

    const hm = HEADING.exec(raw);
    if (hm) {
      flushPara();
      const level = Math.min(hm[1].length, 3);
      const title = clean(hm[2].replace(/#+\s*$/, ''));
      headingStack = headingStack.slice(0, level - 1);
      headingStack[level - 1] = title;
      continue;
    }
    if (SECTION_HEAD_RE.test(raw) && raw.length <= 50) {
      flushPara();
      headingStack = [headingStack[0] || '', clean(raw)].filter(Boolean);
      continue;
    }
    // 遇到新题号开头且已有内容时，先结束上一道题/段落，避免一张图里的多道题混进同一块
    if (Q_START.test(raw)) {
      if (paraBuf.length) flushPara();
      paraIsQ = true;
    }
    paraBuf.push(raw);
  }
  flushPara();

  // 相邻同标题的短段落合并，提升上下文完整度。
  // 但题目块（isQuestion / looksLikeQuestion）绝不合并：一道题一段，合并后就搜不出具体某道题了。
  const looksLikeQuestion = t => {
    const head = String(t || '').trim().slice(0, 40);
    if (/^(?:第\s*)?\d{1,3}\s*[.、．)）]/.test(head)) return true;
    if (/^[（(]\s*\d{1,3}\s*[）)]/.test(head)) return true;
    if (/^Q\s*\d{1,3}/i.test(head)) return true;
    // 段落里成行出现 A. / B. 选项
    if (/^\s*[A-H]\s*[.、．)）]\s*\S/m.test(t)) return true;
    return false;
  };

  const merged = [];
  for (const sec of sections) {
    const prev = merged[merged.length - 1];
    const canMerge = prev
      && prev.heading === sec.heading
      && (prev.text.length + sec.text.length + 1) <= MAX_CHUNK
      && !prev.isQuestion
      && !sec.isQuestion
      && !looksLikeQuestion(prev.text)
      && !looksLikeQuestion(sec.text);
    if (canMerge) {
      prev.text += '\n' + sec.text;
    } else {
      merged.push({ heading: sec.heading, text: sec.text, isQuestion: !!sec.isQuestion || looksLikeQuestion(sec.text) });
    }
  }

  const out = [];
  const emitChunk = (heading, body, isQuestion) => {
    const cleanBody = clean(body);
    if (cleanBody.length < 12) return;
    const prefix = heading && !cleanBody.includes(heading) ? `【${heading}】` : '';
    const full = (prefix ? `${prefix}\n${cleanBody}` : cleanBody).slice(0, MAX_RAW);
    let title = '';
    if (isQuestion) {
      const firstLine = cleanBody.split('\n')[0] || cleanBody;
      const qm = Q_START.exec(firstLine);
      const stem = (qm && qm[1] ? qm[1] : firstLine).replace(/\s+/g, ' ').trim();
      title = (stem || cleanBody).slice(0, 160);
    } else {
      title = (heading ? `${heading}：${cleanBody}` : cleanBody).replace(/\s+/g, ' ').slice(0, 100);
    }
    out.push({
      type: 'chunk',
      question: title,
      answer: full,
      explain: '',
      raw: full,
      optFp: optionsFingerprint(cleanBody)
    });
  };

  for (const { heading, text, isQuestion } of merged) {
    if (text.length <= MAX_CHUNK) {
      emitChunk(heading, text, isQuestion);
      continue;
    }
    const sentences = text.split(/(?<=[。！？；\n.!?;])/);
    let buf = '';
    for (const s of sentences) {
      if ((buf + s).length > MAX_CHUNK && buf.trim().length >= 20) {
        emitChunk(heading, buf, isQuestion);
        const tail = buf.slice(-CHUNK_OVERLAP);
        const cut = tail.search(/[。！？；\n]/);
        buf = (cut >= 0 ? tail.slice(cut + 1) : tail) + s;
      } else {
        buf += s;
      }
    }
    if (buf.trim().length >= 12) emitChunk(heading, buf, isQuestion);
  }
  return out;
}

/** 轻量预处理 OCR/文本里的常见断词与同行粘连，提升多题切分召回 */
function normalizeTextForChunk(text) {
  let s = String(text || '').replace(/\r\n?/g, '\n');
  s = s
    .replace(/参\s*考\s*答\s*案/g, '参考答案')
    .replace(/正\s*确\s*答\s*案/g, '正确答案')
    .replace(/标\s*准\s*答\s*案/g, '标准答案')
    .replace(/答\s+案(?=\s*[:：】\]])/g, '答案')
    .replace(/解\s+析(?=\s*[:：】\]])/g, '解析');
  s = s
    .replace(/^(\s*\d{1,4})\s+([.、)）．:：])/gm, '$1$2')
    .replace(/^(\s*\d{1,4})\s*。(?=\s*\S)/gm, '$1.')
    .replace(/^(\s*\d{1,4})\s*\n+\s*(?=\[[A-Za-z0-9\u4e00-\u9fa5]{1,12}\]|【)/gm, '$1 ')
    .replace(/^(\s*[A-H])\s+([.、,，:：)）．])/gm, '$1$2');
  s = s.replace(/([。；;？?！!）)\s])(?=(?:【\s*(?:参考|标准|正确)?答案\s*】|(?:参考答案|正确答案|标准答案|答案)\s*(?:[:：]|(?:是|为)\s*(?=[A-Ha-h]|对|错|正确|错误|√|×))))/g, '$1\n');
  s = s.replace(/([。？?！!）)])[ \t]{1,}(?=(?:第\s*\d{1,4}\s*[题小道]|[（(\[]\d{1,4}[)）\]]|\d{1,4}[.、)）．。])\s*\S)/g, '$1\n');
  return s;
}

/**
 * 主入口：把文档文本切成条目
 * @param {string} text 文档全文
 * @param {string} docName 文件名（仅用于诊断日志）
 * @returns {{entries: Array, strategy: string}}
 */
export function chunkDocument(text, docName) {
  const lines = normalizeTextForChunk(text).split('\n');

  const { entries: qaRaw, usedLines: qaLines } = parseQA(lines);
  const qa = qaRaw.filter(e => e.question.length >= 3 && e.answer.length >= 1);
  const { entries: terms, termLines } = parseTerms(lines, qaLines);

  const skipForChunks = new Set([...qaLines, ...termLines]);
  const chunks = parseChunks(lines, skipForChunks);

  let strategy = '';
  let entries = [];

  if (qa.length >= 1) {
    strategy = (qa.length >= 2 || !chunks.length) ? 'qa' : 'chunk';
    entries = qa.slice();
    if (terms.length) entries = entries.concat(terms);
    if (chunks.length) entries = entries.concat(chunks);
  } else if (terms.length >= 1 && chunks.length === 0) {
    strategy = 'term';
    entries = terms;
  } else if (chunks.length >= 1) {
    // 讲义/手册/PDF：绝不能因为出现几行冒号就丢弃整篇正文段落
    strategy = 'chunk';
    entries = terms.length ? terms.concat(chunks) : chunks;
  } else if (terms.length >= 1) {
    strategy = 'term';
    entries = terms;
  }

  // 兜底：任何策略都没产出但文本非空，整段切块
  if (!entries.length) {
    const rawClean = clean(lines.join(' '));
    if (rawClean.length >= 8) {
      entries = [{
        type: 'chunk',
        question: rawClean.slice(0, 80),
        answer: rawClean.slice(0, MAX_RAW),
        explain: '',
        raw: rawClean.slice(0, MAX_RAW)
      }];
      strategy = 'chunk';
    }
  }

  // 去重：兼顾选项指纹，避免「同题干、不同选项集合与答案」的变体题被误删
  const seen = new Set();
  const deduped = [];
  for (const e of entries) {
    const qKey = normalizeQuestion(e.question) || e.question.replace(/\s+/g, '').slice(0, 120);
    const aKey = String(e.answer || '').replace(/\s+/g, '').slice(0, 120);
    const key = `${e.type}|${qKey}|${e.optFp || ''}|${aKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
  }

  return { entries: deduped, strategy: strategy || 'chunk' };
}
