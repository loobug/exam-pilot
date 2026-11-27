/* 题目识别引擎
 * 输出结构（序列化后交给 UI / AI）：
 *   { id, index, kind, stem, options:[{label,text}], blanks, source }
 * 内部缓存 __cache 保留 DOM 引用，供 fill.js 直接操作。
 */
var qxExtract = (function () {
  'use strict';
  const U = qxUtil;

  const QUESTION_RE = /(?:^|\n)\s*(?:第\s*)?(\d{1,3})\s*[.、,，)．）]\s*/;
  // 宽松版：题号前允许出现题型词、标签、空格（如「单选6.」「【多选】3.」）
  const STEM_NO_RE = /(?:^|[\s（(【\[])(?:第\s*)?(\d{1,3})\s*[.、,，)．）]\s*/;
  // 容器判定用：只要出现「数字 + 分隔符」就认为这里开始了一道题
  const NUM_NO_RE = /\d{1,3}\s*[.、,，)．）]\s*/;
  const TYPE_WORD = '(?:单选题?|多选题?|不定项(?:选择)?题?|单项选择|多项选择|判断题?|填空题?|简答题?|问答题?|论述题?|计算题?|名词解释|案例分析|材料题|选择题)';
  const TYPE_WORD_HEAD_RE = new RegExp('^' + TYPE_WORD + '\\s*');
  const TYPE_TAG_RE = /[（(【\[]\s*(单项选择|多项选择|不定项选择|不定项|单选|多选|判断题?|填空题?|简答题?|问答题?|论述题?|名词解释|计算题?|案例分析|材料题|选择)\s*[)）】\]]/g;
  const OPTION_RE = /^\s*([A-H])\s*[.、,，:：)）．]\s*(\S[\s\S]*)$/;
  // 字母独占一行、文本另起（如 <span class="letter">A</span><span>A选项</span>）
  const OPTION_MULTILINE_RE = /^\s*([A-H])\s*\n+\s*(\S[\s\S]*)$/;
  // 题号：支持「第 1 / 25 题」「第1题」「12.」「(3)」等
  const HAS_QTAG_RE = /(?:^|\s)\d{1,3}\s*[.、,，)．）]|第\s*\d{1,3}\s*(?:[\/／]\s*\d{1,3})?\s*题/;
  // 纯噪音行：题型标签、提示语、答题卡、纯数字页码
  const NOISE_LINE_RE = /^(?:单项选择|多项选择|不定项选择|单选题?|多选题?|判断题?|选择题?|填空题?|简答题?|问答题?)\s*题?$|^请选择(?:一项|正确答案|答案)?$|^请判断(?:正误)?$|^第\s*\d+\s*[\/／]\s*\d+\s*题$|^答题卡$|^已答$|^当前题$|^\d{1,3}$|^[（(]?\s*\d{1,3}\s*[）)]?$/;

  /** 解析一行选项：兼容「A. 文本」「A、文本」「A\n文本」「A」 */
  function parseOptionLine(raw) {
    const text = String(raw == null ? '' : raw);
    let m = U.oneLine(text).match(OPTION_RE);
    if (m && m[2] && m[2].trim()) return { label: m[1].toUpperCase(), text: U.norm(m[2]) };
    m = text.match(OPTION_MULTILINE_RE);
    if (m) return { label: m[1].toUpperCase(), text: U.norm(m[2]) };
    m = text.match(/^\s*([A-H])\s*$/);
    if (m) return { label: m[1].toUpperCase(), text: '' };
    return null;
  }

  /** 清洗题干里的噪音行 */
  function cleanStem(stem) {
    const lines = String(stem || '').split(/\n+/);
    const kept = lines.filter(l => {
      const t = l.trim();
      if (!t) return false;
      if (NOISE_LINE_RE.test(t)) return false;
      if (/^[\d\s.,，、]+$/.test(t)) return false;   // 纯数字行：答题卡页码、题号列表
      return true;
    });
    return U.norm(kept.join('\n')).slice(0, 1600);
  }

  /** 在容器里挑最像题干的文本块：选项之前、最长、且不像噪音 */
  function pickStem(container, optionEntries) {
    const optEls = (optionEntries || []).map(o => o.el).filter(Boolean);
    const firstOpt = optEls[0] || null;
    let best = '', bestScore = 0;

    const isBeforeFirstOption = el => {
      if (!firstOpt) return true;
      if (el === firstOpt) return false;
      if (el.contains(firstOpt)) return false;                       // 含选项的祖先（整题块）不算题干
      const rel = el.compareDocumentPosition(firstOpt);
      return !!(rel & Node.DOCUMENT_POSITION_FOLLOWING);             // el 位于选项之前
    };

    const cands = container.querySelectorAll('h1,h2,h3,h4,h5,h6,p,div,span,section,article,li,td,label,strong');
    for (const el of cands) {
      if (el === container) continue;                                 // 容器整体不作为题干
      if (!isBeforeFirstOption(el)) continue;
      if (optEls.some(o => o === el || o.contains(el))) continue;
      const t = U.oneLine(el.innerText || '');
      if (t.length < 8 || t.length > 1500) continue;
      if (NOISE_LINE_RE.test(t)) continue;
      if (/^[\d\s.,，、]+$/.test(t)) continue;
      if ((optionEntries || []).some(o => o.text && U.oneLine(o.text) === t)) continue;
      let score = t.length;

      // ---- 题干特征加权：光看长度会让页面标题/面包屑胜出 ----
      const cls = (el.className || "") + " " + (el.id || "");
      if (/stem|qtext|question|qtitle|timu|subject|q-content|q_content/i.test(cls)) score *= 2.2;
      if (/^h[1-6]$/i.test(el.tagName)) score *= 1.6;
      if (/[?？]\s*$/.test(t)) score *= 1.35;
      if (/(以下|下列|哪项|哪些|哪个|包括|属于|正确的是|错误的是|描述)/.test(t)) score *= 1.15;

      // ---- 页面标题 / 面包屑 / 说明文字降权 ----
      const docTitle = (document.title || "").replace(/\s+/g, "");
      if (docTitle && t.replace(/\s+/g, "").includes(docTitle.slice(0, Math.min(12, docTitle.length)))) score *= 0.12;
      if (/(模拟考试|在线考试|考试系统|试卷|答题卡|开始考试|交卷|剩余时间|倒计时|第\s*\d+\s*\/\s*\d+\s*题)/.test(t) && t.length < 40) score *= 0.25;
      if (/^(单选|多选|判断|填空|简答|论述)题?$/.test(t.trim())) score *= 0.2;

      // 含题型标签的块是元信息，压低权重
      if (/^(?:单项选择|多项选择|不定项选择|单选题?|多选题?|判断题?|选择题?)/.test(t)) score *= 0.3;
      if (/第\s*\d+\s*[\/／]\s*\d+\s*题/.test(t)) score *= 0.4;

      // 短于 8 个字且不像题干的直接忽略
      if (t.length < 10 && !/[?？]/.test(t)) score *= 0.5;

      if (score > bestScore) { bestScore = score; best = t; }
    }
    return best ? cleanStem(best) : '';
  }

const JUDGE_WORDS = /^(对|错|正确|错误|是|否|真|假|√|×|✓|✗|T|F|True|False)$/i;

  /**
   * 判断某个选项文本是不是「对/错」类。
   * 真实考试里常写「正确（√）」「该说法错误」「对的」，
   * 用严格的 ^$ 会漏判，导致整题被当成单选题。
   */
  function isJudgeText(text) {
    const t = String(text || '')
      .replace(/^\s*(?:[（(\[]\s*[A-Ha-h]\s*[)）\]]|[A-Ha-h]\s*[.、,，:：)）．\s])\s*/, '')
      .replace(/[\s。.，,、；;：:（）()\[\]【】"'"'']/g, '')
      .trim();
    if (!t) return false;
    if (JUDGE_WORDS.test(t)) return true;
    if (t.length > 12) return false;                    // 太长多半是正常选项
    if (/(不正确|不对|不属于|错误说法|不成立|说法错误)/.test(t)) return true;  // 也算判断类
    if (/正确|错误|对的|错的|正确选项|错误选项|说法正确|√|×|✓|✗|✔|✘/.test(t)) return true;
    return false;
  }

  const TYPE_MAP = {
    单项选择: 'single', 单项选择题: 'single', 单选: 'single', 单选题: 'single',
    单项: 'single', 选择: 'single', 选择题: 'single', 单选题型: 'single',
    多项选择: 'multi', 多项选择题: 'multi', 多选: 'multi', 多选题: 'multi',
    多项: 'multi', 不定项选择: 'multi', 不定项: 'multi', 不定项选择题: 'multi',
    判断: 'judge', 判断题: 'judge', 判断正误: 'judge', 正误: 'judge',
    是非: 'judge', 是非题: 'judge', 对错: 'judge', 对错题: 'judge',
    填空: 'fill', 填空题: 'fill',
    简答: 'short', 简答题: 'short', 问答: 'short', 问答题: 'short',
    论述: 'short', 论述题: 'short', 名词解释: 'short', 材料题: 'short',
    案例分析: 'short', 案例: 'short',
    计算: 'calc', 计算题: 'calc'
  };

  /** 从 class 名读题型（很多考试系统把题型直接写在标签的 class 上，如 badge multi） */
  const CLS_KIND = [
    [/(^|[\s_-])(multi|multiple|multichoice|multi-choice|checkbox|duoxuan|is-multi|type-multi)([\s_-]|$)|multiChoice|qTypeMulti/i, 'multi'],
    [/(^|[\s_-])(single|radio|singlechoice|single-choice|danxuan|is-single|type-single)([\s_-]|$)|singleChoice|qTypeSingle/i, 'single'],
    [/(^|[\s_-])(judge|truefalse|true-or-false|true_or_false|panduan|bool|is-judge|type-judge)([\s_-]|$)/i, 'judge'],
    [/(^|[\s_-])(fill|blank|fillblank|tiankong)([\s_-]|$)/i, 'fill'],
    [/(^|[\s_-])(short|essay|subjective|jianda)([\s_-]|$)/i, 'short']
  ];

  const HINT_MULTI = /请选择(?:所有|多项|全部|至少两|多个)|可多选|多选题?|选择所有(?:正确|符合)|选出所有|至少选两/;
  const HINT_SINGLE = /请选择(?:一项|单项|一个|唯一)|单选题?|选择(?:一项|一个)/;

  function typeFromClass(container) {
    if (!container) return null;
    const els = [container];
    try { els.push(...container.querySelectorAll('[class]')); } catch (e) { }
    for (const el of els) {
      const cls = String(el.className || '');
      if (!cls || cls.length > 160) continue;
      for (const [re, kind] of CLS_KIND) {
        if (re.test(cls)) return kind;
      }
    }
    return null;
  }

  function typeFromAria(container, options) {
    const check = el => {
      if (!el || !el.getAttribute) return null;
      const role = String(el.getAttribute('role') || '').toLowerCase();
      if (role === 'checkbox' || role === 'checkboxgroup') return 'multi';
      if (role === 'radio' || role === 'radiogroup') return 'single';
      return null;
    };
    const r0 = check(container);
    if (r0) return r0;
    for (const o of (options || [])) {
      const r = check(o && o.el);
      if (r) return r;
    }
    try {
      if (container && container.querySelector('[role="checkbox"]')) return 'multi';
      if (container && container.querySelector('[role="radio"]')) return 'single';
    } catch (e) { }
    return null;
  }

  /** 读取紧邻题块外层的题型标签（常见于「头部题型条 + 题干体」或「二、多选题」小节头） */
  function contextTypeText(container) {
    if (!container) return '';
    const bits = [];
    try {
      const prev = container.previousElementSibling;
      if (prev) {
        const pt = U.oneLine(prev.innerText || '');
        if (pt && pt.length <= 80) bits.push(pt);
      }
      const p = container.parentElement;
      if (p && p !== document.body && p !== document.documentElement) {
        const pMeta = p.querySelector(':scope > .qtype,:scope > .question-type,:scope > .type,:scope > .badge,:scope > h2,:scope > h3,:scope > h4');
        if (pMeta && !pMeta.contains(container)) {
          const mt = U.oneLine(pMeta.innerText || '');
          if (mt && mt.length <= 80) bits.push(mt);
        }
      }
    } catch (e) { }
    return bits.join(' ');
  }

  function normalizeTypeKey(raw) {
    const key = String(raw || '').trim();
    if (!key) return null;
    if (TYPE_MAP[key]) return TYPE_MAP[key];
    const stripped = key.replace(/题$/, '');
    return TYPE_MAP[stripped] || null;
  }

  /**
   * 统一题型判定
   * 判定顺序：物理约束（对错选项 / 原生 input / ARIA role）> class 名 > 标签文字 > 提示语 > 无法确定返回 'auto'
   */
  function decideKind(container, text, options, inputs) {
    const opts = options || [];
    const ins = (inputs || []).filter(Boolean);

    // 1) 选项只有「对 / 错」→ 判断题（最硬的结构特征）
    const judgeLike = opts.length >= 2 && opts.length <= 3 &&
      opts.every(o => isJudgeText(o.text));
    if (judgeLike) return 'judge';

    // 2) 有原生 input：物理类型最可信
    if (ins.length) {
      const anyCheckbox = ins.some(i => i.type === 'checkbox');
      const anyRadio = ins.some(i => i.type === 'radio');
      if (anyCheckbox && !anyRadio) return 'multi';
      if (anyRadio && !anyCheckbox) return 'single';
    }

    // 2.5) ARIA role
    const byAria = typeFromAria(container, opts);
    if (byAria) return byAria;

    // 3) class 名（如 badge multi / question-type-judge）
    const byClass = typeFromClass(container);
    if (byClass) return byClass;

    // 4) 题型标签文字（含外层相邻题型条）
    const fullMeta = String(text || '') + ' ' + contextTypeText(container);
    const byTag = typeFromTag(fullMeta);
    if (byTag) return byTag;

    // 5) 操作提示语
    if (HINT_MULTI.test(fullMeta)) return 'multi';
    if (HINT_SINGLE.test(fullMeta)) return 'single';

    // 6) 纯 DOM 点击型且无任何显式题型标识时，交由模型/题库判断
    return 'auto';
  }

  let __cache = [];
  let __lastSummary = [];

  /* ---------- 基础取元素 ---------- */

  function allChoiceInputs() {
    let list = Array.from(document.querySelectorAll('input[type=radio],input[type=checkbox]'));
    if (!list.length) list = U.deepQueryAll('input[type=radio],input[type=checkbox]');
    return list.filter(el => {
      if (el.disabled) return false;
      if (U.visible(el)) return true;
      // 大量站点把原生控件视觉隐藏（opacity:0 / 1px / clip），靠 label 显示样式。
      // 只要它挂在可见的 label 或父容器里，就仍然是个可操作的选项。
      let host = null;
      try { host = el.closest('label') || el.parentElement; } catch (e) { }
      if (host && U.visible(host)) return true;
      const grand = host && host.parentElement;
      return !!(grand && U.visible(grand) && grand.querySelector('label'));
    });
  }

  function allTextInputs() {
    let list = Array.from(document.querySelectorAll(
      'textarea, input[type=text], input[type=""], input:not([type]), [contenteditable="true"], [contenteditable=""]'
    ));
    if (!list.length) list = U.deepQueryAll('textarea,[contenteditable="true"]');
    return list.filter(el => {
      if (el.disabled || el.readOnly) return false;
      if (el.tagName === 'INPUT' && el.type && el.type !== 'text') return false;
      if (el.closest('[contenteditable="false"]')) return false;
      return U.visible(el);
    });
  }

  /* 向上找到该选项 input 所属的"题块容器" */
  function choiceContainerOf(input) {
    let node = input.parentElement;
    let k = 0;
    let loose = null;
    while (node && k++ < 16 && node !== document.body && node !== document.documentElement) {
      const peers = node.querySelectorAll('input[type=radio],input[type=checkbox]');
      if (peers.length >= 2) {
        if (!loose) loose = node;
        // 判据：容器文本长度 减去 所有选项行文本长度，剩下的就是题干。
        // 只看"有文字"会把纯选项列表（div.opts）当成容器，题干随即丢失。
        const headLen = U.oneLine(U.ownText(node, 'script,style,noscript,svg')).length;
        let optLen = 0;
        peers.forEach(pp => {
          try { optLen += U.oneLine(rowOfInput(pp).textContent || '').length; } catch (e) { }
        });
        if (headLen - optLen >= 6) return node;
      }
      node = node.parentElement;
    }
    return (loose && loose !== document.body) ? loose : input.parentElement;
  }

  /* 选项行 + 文本 */
  function rowOfInput(input) {
    const lb = U.closestAcross(input, e => e.tagName === 'LABEL');
    if (lb) return lb;
    let p = input.parentElement;
    if (p && U.textLength(p) < 2 && p.parentElement) p = p.parentElement;
    return p || input;
  }

  function cleanOptionText(raw) {
    let t = U.oneLine(raw);
    const m = t.match(OPTION_RE);
    if (m) return { label: m[1].toUpperCase(), text: U.norm(m[2]) };
    return { label: '', text: t };
  }

  /* ---------- 题干抽取 ---------- */

  function cutStem(fullText, rawRowTexts) {
    let cut = fullText.length;
    rawRowTexts.forEach(raw => {
      const key = U.oneLine(raw).slice(0, 12);
      if (key.length < 3) return;
      const i = fullText.indexOf(key);
      if (i >= 0 && i < cut) cut = i;
    });
    let stem = fullText.slice(0, cut);
    // 起点对齐到题号，丢弃题号前的题型标签/章节标题
    const m = NUM_NO_RE.exec(stem);
    if (m && m.index > 0 && m.index < stem.length * 0.5) stem = stem.slice(m.index);
    stem = stem
      .replace(/[A-H]\s*[.、,，:：)）．]\s*$/, '')
      .replace(/\s+\n/g, '\n')
      .trim();
    if (stem.length > 1600) stem = stem.slice(0, 1600) + ' …';
    return stem;
  }

  function typeFromTag(text) {
    TYPE_TAG_RE.lastIndex = 0;
    let m, found = null;
    while ((m = TYPE_TAG_RE.exec(text))) {
      const k = normalizeTypeKey(m[1]);
      if (k) found = k;
    }
    if (found) return found;
    // 没有括号包裹时只看开头一小段，避免题干正文里的「判断」二字被误认
    const head = String(text || '').slice(0, 40);
    const plain = head.match(/(单项选择|多项选择|不定项选择|单项选择|单选题?|多选题?|判断题?|填空题?|简答题?|问答题?|论述题?|计算题?)/);
    return plain ? normalizeTypeKey(plain[1]) : null;
  }

  function stripTag(text) {
    let t = U.norm(text.replace(TYPE_TAG_RE, ''));
    t = t.replace(TYPE_WORD_HEAD_RE, '');
    return t.replace(/^[（(【\[]?\s*[)）】\]]?\s*/, '');
  }

  /* ---------- 路径一：带原生 input 的选择题 ---------- */

  function scanChoiceByInputs() {
    const inputs = allChoiceInputs();
    if (!inputs.length) return [];

    // 先按容器聚类，再按 name 细分（一个大题里多个小题时 name 不同）
    const byContainer = new Map();
    inputs.forEach(inp => {
      const c = choiceContainerOf(inp);
      if (!byContainer.has(c)) byContainer.set(c, []);
      byContainer.get(c).push(inp);
    });

    const groups = [];
    byContainer.forEach((list, container) => {
      const named = new Map();
      const unnamed = [];
      list.forEach(inp => {
        if (inp.name) {
          if (!named.has(inp.name)) named.set(inp.name, []);
          named.get(inp.name).push(inp);
        } else unnamed.push(inp);
      });
      if (named.size > 1) {
        // 只有当每个 name 组都像“一道完整的题”（至少 2 个选项）时才按 name 拆开。
        // 有些考试系统的多选题给每个 checkbox 起了不同 name（opt1/opt2/...），
        // 硬拆会把一道多选题变成好几道单选题。
        const groupsArr = [...named.values()];
        const allLookLikeQuestions = groupsArr.every(g => g.length >= 2);
        if (allLookLikeQuestions) {
          named.forEach(g => groups.push({ container, inputs: g }));
          if (unnamed.length) groups.push({ container, inputs: unnamed });
        } else {
          groups.push({ container, inputs: list });
        }
      } else {
        groups.push({ container, inputs: list });
      }
    });

    const out = [];
    groups.forEach(({ container, inputs: group }) => {
      if (!group.length) return;
      const rows = group.map(inp => ({ input: inp, el: rowOfInput(inp) }));
      const optionEntries = [];
      rows.forEach((r, i) => {
        const raw = U.oneLine(r.el.innerText || r.el.textContent || U.ownText(r.el));
        const parsed = cleanOptionText(raw);
        optionEntries.push({
          label: parsed.label || U.letter(i),
          text: parsed.text,
          el: r.el,
          input: r.input
        });
      });
      if (optionEntries.length < 2) return;

      const fullText = U.norm(container.innerText || container.textContent || '');
      const rawStem = cutStem(fullText, rows.map(r => r.el.innerText || r.el.textContent || ''));
      if (!rawStem || rawStem.length < 2) return;

      const kind = decideKind(container, rawStem + ' ' + U.oneLine(container.innerText || '').slice(0, 600), optionEntries, group);

      out.push(build({
        kind,
        stem: stripTag(rawStem) || rawStem,
        options: optionEntries.map(o => ({ label: o.label, text: o.text })),
        source: 'input',
        orderEl: container,
        refs: { container, options: optionEntries, inputs: group }
      }));
    });
    return out;
  }

  /* ---------- 路径二：无原生 input 的文本题块（点击型/画布旁文本） ---------- */

  /** 从容器里抽取无 A/B 前缀的纯文字/符号判断选项（如「正确 / 错误」「对 / 错」「√ / ×」） */
  function extractJudgePairRows(node) {
    const els = Array.from(node.querySelectorAll('button,a,label,[role=button],[role=radio],div,p,li,td,span,dd'));
    const cands = [];
    for (const r of els) {
      if (!U.visible(r)) continue;
      const rawText = U.oneLine(r.innerText || '');
      if (!rawText || rawText.length > 24) continue;
      if (!isJudgeText(rawText)) continue;
      const cleanT = rawText.replace(/[\s。.，,、；;：:（）()\[\]【】"'"'']/g, '');
      const pol = /(错误|错的|不对|不正确|不是|不属于|不成立|说法错误|^[错否假×✗✘xXfFnN]$|错误选项)/i.test(cleanT) ? '错' : '对';
      cands.push({ el: r, pol, text: U.norm(rawText) });
    }
    if (cands.length < 2) return [];
    const leafs = cands.filter(r => !cands.some(o => o !== r && r.el.contains(o.el)));
    const rows = [];
    const seenPol = new Set();
    for (const r of leafs) {
      let target = r.el;
      let p = target.parentElement;
      for (let k = 0; k < 2 && p && p !== node && p !== document.body; k++, p = p.parentElement) {
        const pt = U.oneLine(p.innerText || '');
        if (pt.length <= 24 && isJudgeText(pt)) target = p;
        else break;
      }
      if (seenPol.has(r.pol)) continue;
      if (rows.some(x => x.el === target || x.el.contains(target) || target.contains(x.el))) continue;
      seenPol.add(r.pol);
      rows.push({ el: target, label: U.letter(rows.length), text: r.text, pol: r.pol });
    }
    if (rows.length === 2 && seenPol.has('对') && seenPol.has('错')) {
      return rows.map(({ el, label, text }) => ({ el, label, text }));
    }
    return [];
  }

  function scanChoiceByText() {
    const out = [];
    const nodes = Array.from(document.querySelectorAll('div,section,article,li,dl,table,tbody,tr,td,p,form,fieldset'));
    const seenStem = new Map();
    let budget = 2500;

    for (const node of nodes) {
      if (budget-- <= 0) break;
      // 有原生选项 input 的容器交给路径一，避免重复
      if (node.querySelector('input[type=radio],input[type=checkbox]')) continue;
      if (node.closest('nav,header,footer,[role=navigation]')) continue;
      const raw = node.textContent || '';
      if (raw.length < 8 || raw.length > 4000) continue;
      const hasQTag = NUM_NO_RE.test(raw) || HAS_QTAG_RE.test(raw);
      const hasAbMarks = /(?:^|[\s\n])A\s*[.、,，:：)）．]\s*\S[\s\S]*?(?:^|[\s\n])B\s*[.、,，:：)）．]\s*\S/.test(raw);

      // 选项行：兼容「A. 文本」「A\n文本」「A」三种写法，只取最内层
      const own = Array.from(node.querySelectorAll('div,p,li,td,span,label,a,button,dd,tr'));
      const cands = [];
      for (const r of own) {
        const rawText = String(r.innerText || '');
        if (!rawText || rawText.length > 300) continue;
        const parsed = parseOptionLine(rawText);
        if (!parsed) continue;
        cands.push({ el: r, label: parsed.label, text: parsed.text, rawText });
      }
      const leafs = cands.filter(r => !cands.some(o => o !== r && r.el.contains(o.el)));

      let rows = [];
      for (const r of leafs) {
        let text = r.text;
        let target = r.el;
        if (!text) {
          // 只抓到字母（如 <span class="letter">A</span>），文本和点击区域都在父元素上
          const parentText = String((r.el.parentElement || r.el).innerText || '');
          const pm = parseOptionLine(parentText);
          if (pm && pm.text) text = pm.text;
        }
        // 选项元素自身只包含一个字母时，把点击目标上溯到整行容器（button/label/li）
        if (String(r.el.innerText || '').trim().length <= 2) {
          const p = r.el.parentElement;
          if (p && p !== document.body) {
            const pText = String(p.innerText || '').trim();
            const startsWithLabel = new RegExp('^' + r.label + '(\\s|\\n|$|\\.|、)').test(pText);
            const looksLikeList = Array.from(p.children || [])
              .some(c => /^\s*[B-H]\s*(\n|\.|、|,)/.test(String(c.innerText || '').trim()));
            if (startsWithLabel && !looksLikeList && pText.length < 300) target = p;
          }
        }
        if (!text) continue;
        if (rows.some(x => x.el === target || x.label === r.label)) continue;
        rows.push({ el: target, label: r.label, text });
      }
      if (rows.length < 2) {
        rows = extractJudgePairRows(node);
      }
      if (rows.length < 2 || rows.length > 10) continue;
      if (!hasQTag && !hasAbMarks && rows.length !== 2) continue;

      const letters = new Set(rows.map(r => r.label));
      if (letters.size !== rows.length) continue;

      // 题干：先按结构挑（最像题干的那块），挑不到再按选项位置截断
      let stem = pickStem(node, rows);
      if (!stem || stem.length < 4) {
        stem = cleanStem(cutStem(U.norm(node.innerText || ''), rows.map(r => r.el.innerText || '')));
      }
      if (!stem || stem.length < 4) continue;

      const rawStem = stem;
      stem = stripTag(rawStem) || rawStem;
      // 判题型：在 stripTag 前的原始题干 + 容器元信息基础上判断，避免题型标签被提前剥离
      const metaEl = node.querySelector('.qmeta,.qtype,.question-type,.qhead,.q-title,[class*=meta],[class*=type]');
      const metaText = U.oneLine((metaEl ? metaEl.innerText : '') || '') + ' ' + U.oneLine(node.innerText || '').slice(0, 600);
      const kind = decideKind(node, metaText + ' ' + rawStem, rows, []);

      const item = build({
        kind,
        stem,
        options: rows.map(r => ({ label: r.label, text: r.text })),
        source: 'text',
        orderEl: node,
        refs: { container: node, options: rows.map(r => ({ el: r.el, label: r.label, text: r.text, input: null })), inputs: [] }
      });

      const key = U.hash(U.oneLine(stem).slice(0, 120));
      if (seenStem.has(key)) {
        const prevIdx = seenStem.get(key);
        const prev = out[prevIdx];
        if (prev && prev.refs && prev.refs.container && prev.refs.container !== node &&
            prev.refs.container.contains(node) && rows.length >= prev.options.length) {
          out[prevIdx] = item;
        }
        continue;
      }
      seenStem.set(key, out.length);
      out.push(item);
    }
    return out;
  }

  /* ---------- 路径三：填空 / 简答 ---------- */

  function scanTextQuestions() {
    const inputs = allTextInputs();
    if (!inputs.length) return [];

    // 先按"题块容器"归并，同一题干下的多个填空合并成一题
    const buckets = new Map();
    inputs.forEach(inp => {
      if (inp.tagName === 'INPUT' && (inp.type === 'text' || !inp.type)) {
        const v = (inp.value || '').trim();
        // 搜索框、验证码一类噪音过滤
        if (/搜索|search|keyword|验证码|captcha|手机号|邮箱|email/i.test(
          [inp.name, inp.id, inp.placeholder, inp.className].filter(Boolean).join(' '))) return;
        if (!v && inp.closest('header,nav,[role=navigation]')) return;
      }

      let node = inp.parentElement, depth = 0, container = null;
      while (node && depth++ < 10 && node !== document.documentElement) {
        const t = U.oneLine(U.ownText(node, 'script,style,noscript,svg,textarea,input'));
        if (t.length >= 8) { container = node; break; }
        node = node.parentElement;
      }
      if (!container) return;
      if (!buckets.has(container)) buckets.set(container, []);
      buckets.get(container).push(inp);
    });

    const out = [];
    buckets.forEach((group, container) => {
      const head = U.oneLine(U.ownText(container, 'script,style,noscript,svg,textarea,input'));
      if (!head || head.length < 2) return;
      const kind = (group.some(i => i.tagName === 'TEXTAREA' || i.isContentEditable) ||
        /简答|问答|论述|名词解释|计算|案例|分析/.test(head)) ? 'short' : 'fill';
      const stem = stripTag(head).slice(0, 1600);
      if (stem.length < 2) return;

      out.push(build({
        kind,
        stem,
        options: [],
        source: 'input-text',
        orderEl: container,
        refs: { container, options: [], inputs: group, blanks: group, fullText: U.norm(container.innerText || '') }
      }));
    });
    return out;
  }

  /* ---------- 兜底：整页正文当一道题 ---------- */

  function scanPageFallback() {
    const main = document.querySelector('main,article,#app,.exam,.paper,.content,.container,form') || document.body;
    let text = U.norm(main.innerText || '');
    if (text.length < 20) return [];
    if (text.length > 12000) text = text.slice(0, 12000) + '\n…（已截断）';
    return [build({
      kind: 'page',
      stem: text,
      options: [],
      source: 'page',
      orderEl: main,
      refs: { container: main, options: [], inputs: [] }
    })];
  }

  /* ---------- 组装 / 排序 / 去重 ---------- */

  let seq = 0;

  const SOURCE_SCORE = {
    input: 0.95,        // 原生选项，最可靠
    'input-text': 0.9,  // 原生输入框
    text: 0.78,         // 只有文本选项，点击型
    page: 0.4,
    selection: 0.5
  };

  function build(q) {
    seq += 1;
    return Object.assign({
      id: 'q' + seq + '_' + U.hash(q.stem || '').slice(0, 6),
      kind: q.kind,
      stem: q.stem,
      options: q.options || [],
      blanks: (q.refs && q.refs.blanks ? q.refs.blanks.length : 0),
      source: q.source,
      score: q.score || SOURCE_SCORE[q.source] || 0.6
    }, q);
  }

  /* ---------- 页面已给出的答案（练习/查看答案模式） ---------- */

  const PAGE_ANSWER_RE = /(?:正确答案|参考答案|标准答案|答案)\s*[:：]\s*([A-H]{1,8}|对|错|正确|错误|√|×|✓|✗|✔|✘|T|F)(?![A-Za-z\u4e00-\u9fa5])/;
  const CORRECT_CLASS_RE = /(^|[\s_-])(correct|right|is-correct|correct-answer|answer-correct|success|dui|crt)([\s_-]|$)/i;

  function detectPageAnswer(q) {
    if (!q.refs || !q.refs.container) return null;
    const box = q.refs.container;

    // 1) 容器里显式写了「正确答案：X」
    let text = '';
    try { text = U.norm(box.innerText || ''); } catch (e) { text = ''; }
    const m = text.match(PAGE_ANSWER_RE);
    if (m) {
      return { answer: m[1], evidence: '页面标注「' + m[0].slice(0, 24) + '」', confidence: 0.96 };
    }

    const opts = (q.refs.options || []).filter(o => o && o.el);
    if (!opts.length) return null;

    // 2) 正确选项带 correct / right 之类 class
    const marked = opts.filter(o => {
      const own = String(o.el.className || '');
      const parent = o.el.parentElement ? String(o.el.parentElement.className || '') : '';
      if (!CORRECT_CLASS_RE.test(own) && !CORRECT_CLASS_RE.test(parent)) return false;
      return U.visible(o.el);
    });
    if (marked.length && marked.length < opts.length) {
      const labels = marked.map(o => o.label).join('');
      return { answer: labels, evidence: '页面标记了正确选项 ' + labels, confidence: 0.86 };
    }

    // 3) 选项文本里带对勾。
    // 关键：判断题的选项本来就写成「正确（√）」「错误（×）」，
    // 这里的 √ 属于选项文字，不是页面标注的答案——误判会直接把答案抄错。
    const allJudge = opts.every(o => isJudgeText(o.text));
    if (!allJudge) {
      const ticked = opts.filter(o => /[✓√✔]/.test(o.el.innerText || ''));
      if (ticked.length && ticked.length < opts.length) {
        const labels = ticked.map(o => o.label).join('');
        return { answer: labels, evidence: '选项含对勾标记', confidence: 0.72 };
      }
    }

    return null;
  }


  function docOrder(a, b) {
    if (!a.orderEl || !b.orderEl) return 0;
    if (a.orderEl === b.orderEl) return 0;
    const rel = a.orderEl.compareDocumentPosition(b.orderEl);
    if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function dedupe(list) {
    const out = [];
    const keys = [];
    list.forEach(q => {
      const key = U.oneLine(q.stem).replace(/\s/g, '').slice(0, 80);
      // 判重规则要小心：一页多题时，"整页当一题"的兜底题干会把每道小题的题干都包含进去，
      // 用简单的 includes 会把真实小题全部误判成重复。只在长度接近时才算同一题。
      const dup = keys.findIndex(k => {
        if (k === key) return true;
        if (key.length < 12 || k.length < 12) return false;
        const shorter = Math.min(k.length, key.length);
        const longer = Math.max(k.length, key.length);
        if (shorter / longer < 0.75) return false;      // 长度差太多 → 不是同一题
        return k.includes(key) || key.includes(k);
      });
      if (dup >= 0) {
        // 保留可操作性更强的（有 input 的优先）
        const prev = out[dup];
        const rank = x => (x.source === 'input' ? 3 : x.source === 'text' ? 2 : 1);
        if (rank(q) > rank(prev)) out[dup] = q;
        return;
      }
      keys.push(key);
      out.push(q);
    });
    return out;
  }

  /* ---------- 对外 ---------- */

  /**
   * 最后一道兜底：不管元素结构长什么样，直接按页面纯文本里的题号切块。
   * 用于结构陌生、class 全是随机名的考试页。
   */
  /** 一行里塞了多个选项时，按 A. B. C. 切开 */
  function splitInlineOptions(line) {
    const re = /(?:^|[\s\u3000])([A-H])\s*[.、,，:：)）．]\s*/g;
    const marks = [];
    let m;
    while ((m = re.exec(line))) marks.push({ label: m[1], start: m.index, textStart: re.lastIndex });
    if (marks.length < 2) return [];
    const out = [];
    marks.forEach((mk, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].start : line.length;
      const text = line.slice(mk.textStart, end).trim();
      if (text) out.push({ label: mk.label, text });
    });
    return out;
  }

  function scanPlainText(textOverride) {
    const bodyText = (typeof textOverride === 'string' && textOverride.trim())
      ? textOverride
      : (document.body ? String(document.body.innerText || '') : '');
    if (bodyText.length < 40) return [];

    const lines = bodyText.split(/\n/).map(l => l.replace(/\u00a0/g, ' ').trimRight());
    const Q_LINE = /^\s*(\d{1,3})\s*[.、,，)）．]\s*(\S.*)$/;
    const OPT_LINE = /^\s*([A-H])\s*[.、,，:：)）．]\s*(\S.*)$/;

    const blocks = [];
    let cur = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const qm = line.match(Q_LINE);
      if (qm && (!cur || cur.opts.length || cur.stem.join('').length > 6)) {
        if (cur) blocks.push(cur);
        cur = { no: qm[1], stem: [qm[2]], opts: [] };
        continue;
      }
      if (!cur) continue;
      const om = line.match(OPT_LINE);
      if (om) {
        // 同一行可能还有别的选项
        const inline = splitInlineOptions(line);
        if (inline.length >= 2) cur.opts.push(...inline);
        else cur.opts.push({ label: om[1], text: om[2].trim() });
        continue;
      }
      if (!cur.opts.length && cur.stem.length < 12) cur.stem.push(line);
    }
    if (cur) blocks.push(cur);

    const out = [];
    blocks.forEach(b => {
      const stem = cleanStem(U.oneLine(b.stem.join(' ')));
      if (!stem || stem.length < 6) return;
      const seen = new Set();
      const opts = [];
      b.opts.forEach(o => {
        if (seen.has(o.label)) return;
        seen.add(o.label);
        opts.push(o);
      });
      if (opts.length < 2 || opts.length > 10) return;
      const kind = decideKind(document.body, stem + ' ' + opts.map(o => o.text).join(' '), opts, []);
      out.push({
        kind,
        stem,
        options: opts,
        blanks: 0,
        score: 20,
        source: 'plaintext',
        refs: {
          container: document.body,
          options: opts.map(o => ({ label: o.label, text: o.text, el: null, input: null }))
        }
      });
    });
    return out;
  }

  function extractAll(opts) {
    opts = opts || {};
    seq = 0;
    let list = [];
    try {
      list = list.concat(scanChoiceByInputs());
    } catch (e) { /* 单个路径失败不影响整体 */ }
    try {
      list = list.concat(scanChoiceByText());
    } catch (e) {
      console.warn('[exa] 文本选项识别异常', e && e.message);
    }
    try {
      list = list.concat(scanTextQuestions());
    } catch (e) { }

    // 前面几条结构化路径都没抓到 → 退回纯文本切分
    if (!list.length) {
      try {
        const plain = scanPlainText();
        if (plain.length) {
          list = list.concat(plain.map((q, i) => Object.assign({}, q, { index: i })));
          console.info('[exa] 结构化识别失败，已改用纯文本切分，得到 ' + plain.length + ' 题');
        }
      } catch (e) { console.warn('[exa] 纯文本切分异常', e && e.message); }
    }
    list = dedupe(list);
    list.sort(docOrder);

    // 同一个题可能被多个祖先命中。规则：容器包含关系 + 具体度，
  // 丢弃「更笼统」的那一层（如把整页当一题的兜底结果），保留具体的小题。
  const srcRank = x => (x.source === 'input' ? 4 : x.source === 'text' ? 3 : x.source === 'input-text' ? 3 : x.source === 'plaintext' ? 2 : 1);
  list = list.filter(q => {
    const qc = q.refs && q.refs.container;
    if (!qc) return true;
    return !list.some(o => {
      if (o === q) return false;
      const oc = o.refs && o.refs.container;
      if (!oc || oc === qc) return false;
      // q 的容器包含 o 的容器 → q 更笼统
      if (!qc.contains(oc)) return false;
      // 只在 q 是「兜底型」（整页当一题）时才丢弃；结构化题之间不能互相吞并，
      // 否则一页多题里排在前面的题会把后面的题吃掉。
      if (srcRank(q) > 1) return false;
      if (srcRank(q) >= srcRank(o)) return false;
      // 如果 q 的题干确实把 o 的题干包进去了，说明是同一题的两种切法，保留具体的 o
      const qs = U.oneLine(q.stem), os = U.oneLine(o.stem).slice(0, 30);
      return os.length >= 6 && qs.includes(os) === false;
    });
  });

    if (!list.length && opts.fallback !== false) list = scanPageFallback();

    // 练习/查看答案模式：页面已经把答案写出来了，直接抄比问模型准
    list.forEach(q => {
      try {
        const pa = detectPageAnswer(q);
        if (pa) {
          q.pageAnswer = pa;
          q.score = Math.min(0.99, Math.max(q.score || 0, pa.confidence));
        }
      } catch (e) { }
    });

    list.forEach((q, i) => { q.index = i; });
    __cache = list;
    __lastSummary = list.map(toPublic);
    return __lastSummary;
  }

  function toPublic(q) {
    return {
      index: q.index,
      id: q.id,
      kind: q.kind,
      stem: q.stem,
      options: q.options,
      blanks: q.blanks,
      source: q.source,
      score: q.score,
      pageAnswer: q.pageAnswer || null
    };
  }

  function getCache() { return __cache; }
  function getPublic() { return __lastSummary; }

  /** 取当前用户选中的文本，作为一道临时题 */
  function extractSelection() {
    const sel = String(window.getSelection ? window.getSelection() : '');
    const t = U.norm(sel);
    if (t.length < 4) return [];
    const q = build({ kind: 'auto', stem: t.slice(0, 4000), options: [], source: 'selection', orderEl: null, refs: { container: null, options: [], inputs: [] } });
    q.index = 0;
    __cache = [q];
    __lastSummary = [toPublic(q)];
    return __lastSummary;
  }

  function pageInfo() {
    return {
      url: location.href,
      title: document.title,
      frameKey: location.href + '#' + (window.name || ''),
      isTop: window.top === window
    };
  }

  /* ---------- 页面结构探测 ---------- */

  const NEXT_TEXT_RE = /^(下一题|下一道|下一页|下一頁|next|Next|NEXT)$/;

  function findNextButton() {
    let all = [];
    try { all = Array.from(document.querySelectorAll('button,a,[role=button],input[type=button],input[type=submit]')); } catch (err) { return null; }
    for (const el of all) {
      if (el.disabled) continue;
      const t = U.oneLine(el.innerText || el.value || el.textContent || '').trim();
      if (!NEXT_TEXT_RE.test(t)) continue;
      if (!U.visible(el)) continue;
      return el;
    }
    return null;
  }

  /** 判读页面是「一屏一题（分页）」还是「一屏多题（整卷）」 */
  function probeStructure() {
    const info = {
      mode: 'list', current: 0, total: 0,
      optionKind: 'unknown', nextText: '', hasCanvas: false, hasIframe: false
    };
    try {
      const bodyText = document.body ? (document.body.innerText || '') : '';
      const m = bodyText.match(/第\s*(\d{1,3})\s*[\/／]\s*(\d{1,3})\s*题/);
      if (m) { info.mode = 'single'; info.current = Number(m[1]); info.total = Number(m[2]); }

      const nativeChoice = Array.from(document.querySelectorAll('input[type=radio],input[type=checkbox]')).some(el => U.visible(el));
      if (nativeChoice) info.optionKind = 'input';
      else if (document.querySelector('button[class*=option],[class*=option][role=button],.option')) info.optionKind = 'click';

      info.hasCanvas = document.querySelectorAll('canvas').length > 0;
      info.hasIframe = document.querySelectorAll('iframe').length > 0;

      const next = findNextButton();
      if (next) info.nextText = U.oneLine(next.innerText || next.textContent || '').slice(0, 12);
    } catch (err) { }
    return info;
  }

  /** 逐容器探针：看每条预筛/选项解析为什么失败 */
  function probeChoiceText(limit) {
    const out = [];
    const nodes = Array.from(document.querySelectorAll('div,section,article,li,dl,table,tbody,tr,td,p,form,fieldset'));
    let i = 0;
    for (const node of nodes) {
      if (i >= (limit || 6)) break;
      if (node.querySelector('input[type=radio],input[type=checkbox]')) continue;
      const raw = node.textContent || '';
      if (raw.length < 8 || raw.length > 4000) continue;
      if (!NUM_NO_RE.test(raw) && !HAS_QTAG_RE.test(raw)) continue;
      i++;
      const own = Array.from(node.querySelectorAll('div,p,li,td,span,label,a,button,dd,tr'));
      const cands = [];
      for (const r of own) {
        const rawText = String(r.innerText || '');
        if (!rawText || rawText.length > 300) continue;
        const parsed = parseOptionLine(rawText);
        if (parsed) cands.push({ cls: String(r.className).slice(0, 24), raw: rawText.slice(0, 24), label: parsed.label, text: parsed.text.slice(0, 18) });
      }
      out.push({
        node: node.tagName + '.' + String(node.className || '').split(' ')[0],
        rawLen: raw.length,
        candCount: cands.length,
        cands: cands.slice(0, 8)
      });
    }
    return out;
  }

  /** 识别诊断：返回各条扫描路径的原始产出，用于排查"识别不到/识别错" */
  function debugInfo() {
    const info = { url: location.href, extracted: __lastSummary.length };
    try {
      const ins = allChoiceInputs();
      info.choiceInputs = ins.length;
      info.containers = ins.map(i => {
        const c = choiceContainerOf(i);
        return c ? (c.tagName + (c.id ? '#' + c.id : '') + (c.className ? '.' + String(c.className).split(' ')[0] : '')) : null;
      });
      const g = scanChoiceByInputs();
      info.byInputs = { count: g.length, stems: g.map(q => q.kind + '|' + q.stem.replace(/\s+/g, ' ').slice(0, 26)) };
      const t = scanTextQuestions();
      info.byTextInputs = { count: t.length, stems: t.map(q => q.kind + '|' + q.stem.replace(/\s+/g, ' ').slice(0, 26)) };
      try {
        const x = scanChoiceByText();
        info.byTextBlock = { count: x.length, stems: x.map(q => q.kind + '|' + q.stem.replace(/\s+/g, ' ').slice(0, 26)) };
      } catch (e2) {
        info.byTextBlock = { count: 0, error: String(e2 && e2.stack || e2) };
      }
      info.probe = probeChoiceText();
    } catch (e) {
      info.error = String(e && e.stack || e);
    }
    return info;
  }

  /** 页面是否需要走截图 OCR（无文本可抓） */

  /**
   * 找出页面上"承载题目"的图片：canvas 或大尺寸 img。
   * 只返回能转成 dataURL 的（同源 / data: / 已绘制内容的 canvas）。
   */
  function findQuestionImages(max) {
    const limit = max || 6;
    const out = [];

    const toDataUrl = (el) => {
      try {
        if (el.tagName === 'CANVAS') {
          const w = el.width || el.clientWidth, h = el.height || el.clientHeight;
          if (w < 120 || h < 60) return null;
          return el.toDataURL('image/jpeg', 0.86);
        }
        const src = el.currentSrc || el.src || '';
        if (!src) return null;
        if (src.startsWith('data:')) return src;
        // 同源图片用 canvas 转；跨域会污染，直接放弃（交给截图兜底）
        const c = document.createElement('canvas');
        c.width = el.naturalWidth || el.width;
        c.height = el.naturalHeight || el.height;
        if (!c.width || !c.height) return null;
        const cx = c.getContext('2d');
        cx.drawImage(el, 0, 0);
        return c.toDataURL('image/jpeg', 0.86);
      } catch (err) {
        return null;
      }
    };

    const visibleBox = (el) => {
      try {
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, top: r.top };
      } catch (err) { return { w: 0, h: 0, top: 0 }; }
    };

    /* canvas 优先 */
    document.querySelectorAll('canvas').forEach(cv => {
      if (out.length >= limit) return;
      const box = visibleBox(cv);
      if (box.w < 160 || box.h < 60) return;
      const url = toDataUrl(cv);
      if (url && url.length > 800) {
        out.push({ el: cv, dataUrl: url, w: Math.round(box.w), h: Math.round(box.h), top: box.top, kind: 'canvas' });
      }
    });

    /* 大图其次：题目截图一般足够大，图标/logo 会被尺寸筛掉 */
    document.querySelectorAll('img').forEach(img => {
      if (out.length >= limit) return;
      const box = visibleBox(img);
      if (box.w < 200 || box.h < 70) return;
      const nat = { w: img.naturalWidth || 0, h: img.naturalHeight || 0 };
      if (nat.w && nat.h && (nat.w < 200 || nat.h < 70)) return;
      const url = toDataUrl(img);
      if (url && url.length > 1200) {
        out.push({ el: img, dataUrl: url, w: Math.round(box.w), h: Math.round(box.h), top: box.top, kind: 'img', src: img.src });
      }
    });

    return out;
  }

  function needOcr() {
    const textLen = U.norm(document.body ? document.body.innerText : '').length;
    const canvas = document.querySelectorAll('canvas').length;
    const imgs = document.querySelectorAll('img[src^="data:"], img[src*=".png"], img[src*=".jpg"]').length;
    return textLen < 60 || (canvas > 0 && textLen < 400) || (imgs > 6 && textLen < 200);
  }

  return { extractAll, extractSelection, getCache, getPublic, pageInfo, needOcr, findQuestionImages, debugInfo, probeStructure, findNextButton, scanPlainText, __cacheRef: () => __cache };
})();
