/* 答案填充器：处理原生 input / 受控组件（React、Vue）/ 纯 DOM 选项 / 富文本编辑器 */
var qxFill = (function () {
  'use strict';
  const U = qxUtil;

  const JUDGE_TRUE = /^(对|正确|是|真|√|✓|✔|T|True|Y|Yes|正确选项)$/i;
  const JUDGE_FALSE = /^(错|错误|否|假|×|✗|X|F|False|N|No)$/i;

  /**
   * 宽容判断：先精确匹配；不中再看是否"包含"对/错字样。
   * 关键是要排除「不正确 / 不对 / 错误说法」这类否定，否则会把反义选项认成正解。
   */
  function judgePolarity(text) {
    const t = String(text || '')
      .replace(/^\s*[A-H]\s*[.、．)）:：]\s*/, '')   // 去掉选项字母
      .replace(/[\s。.，,、；;：:（）()\[\]【】"'"'']/g, '')
      .trim();
    if (!t) return 0;

    if (JUDGE_TRUE.test(t)) return 1;
    if (JUDGE_FALSE.test(t)) return -1;

    // 否定式：不正确 / 不对 / 不属于 / 错误说法 → 反向
    const negTrue = /(不正确|不对|不是|不属于|错误说法|错误的|不成立)/.test(t);
    if (negTrue) return -1;

    // 含"错"字样优先判错，避免 "错误" 里含 "对" 之类的拼读造成误判
    if (/错误|错的|×|✗|✘/.test(t)) return -1;
    if (/正确|对的|√|✓|✔/.test(t)) return 1;
    if (/^(是|真|T|True|Y|Yes)$/i.test(t)) return 1;
    if (/^(否|假|F|False|N|No)$/i.test(t)) return -1;
    return 0;
  }

  /* ---------- 解析 AI 给出的答案 ---------- */

  function parseLetters(answer, optCount) {
    const src = String(answer || '');
    const raw = src.toUpperCase()
      .replace(/[（(]\s*仅供[^）)]*[)）]/g, '')
      .trim();

    // 0) 「全选 / 以上都是 / 全部都选 / 全部正确」→ 所有选项
    if (/(全选|以上都(是|正确|选)|全部(都)?(选|正确|是)|都选|全对|以上皆是)/.test(src)) {
      const n = Math.max(1, Math.min(8, Number(optCount) || 6));
      return Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i));
    }

    // 1) 纯字母串：AC / A C / A,C / A、C
    const compact = raw.replace(/[\s,，、;；\/·和与+]/g, '').replace(/^.*?([A-H]{1,8})$/, '$1');
    if (/^[A-H]{1,8}$/.test(compact)) {
      return Array.from(new Set(compact.split(''))).sort();
    }
    // 2) 描述性文本里的孤立字母（避免把整段英文误当选项）
    const set = new Set();
    (raw.match(/\b[A-H]\b/g) || []).forEach(c => set.add(c));
    if (!set.size && /^[\sA-H,，、;；]+$/.test(raw)) {
      (raw.match(/[A-H]/g) || []).slice(0, 8).forEach(c => set.add(c));
    }
    return Array.from(set).filter(Boolean).sort();
  }

  function splitBlanks(answer, n) {
    let parts = String(answer || '').split(/\s*\|\s*|\n+/).map(s => s.trim()).filter(s => s.length);
    if (parts.length === 1 && n > 1) {
      const alt = parts[0].split(/[；;]/).map(s => s.trim()).filter(Boolean);
      if (alt.length === n) parts = alt;
    }
    if (!parts.length) parts = [''];
    while (parts.length < n) parts.push(parts[parts.length - 1] || '');
    return parts.slice(0, Math.max(n, 1));
  }

  /* ---------- 底层操作 ---------- */

  function fire(el, type, init) {
    const ev = type.startsWith('pointer') && window.PointerEvent
      ? new PointerEvent(type, init)
      : new MouseEvent(type, init);
    el.dispatchEvent(ev);
  }

  /** 只在元素不在可视区时才滚动，避免整卷页面来回跳 */
  function ensureVisible(el) {
    try {
      const r = el.getBoundingClientRect();
      const h = window.innerHeight || 0;
      if (r.top >= 0 && r.bottom <= h && r.height > 0) return;
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch (e) { }
  }

  /* ---------------- 鼠标移动轨迹 ---------------- */
  const mousePos = { x: null, y: null };

  /**
   * 把「指针」从上一个位置平滑移到元素中心。
   * 注意：这不能移动操作系统的鼠标指针（浏览器没有这个权限），
   * 但会按真实轨迹逐段派发 mousemove，页面上的悬停/轨迹逻辑都能被触发。
   */
  function moveMouseTo(el) {
    try {
      const r = el.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return;
      const tx = r.left + r.width / 2;
      const ty = r.top + r.height / 2;
      // 起点：上次位置；首次则从左上角外侧一点点开始
      const sx = (mousePos.x == null) ? Math.max(0, tx - 90) : mousePos.x;
      const sy = (mousePos.y == null) ? Math.max(0, ty - 70) : mousePos.y;

      const dist = Math.hypot(tx - sx, ty - sy);
      if (dist < 2) { mousePos.x = tx; mousePos.y = ty; return; }

      const steps = Math.max(6, Math.min(24, Math.round(dist / 18)));
      const base = {
        bubbles: true, cancelable: true, view: window, composed: true,
        button: 0, buttons: 0, pointerId: 1, isPrimary: true, pointerType: 'mouse'
      };

      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const e = 1 - Math.pow(1 - t, 3);          // ease-out，像手一样先快后慢
        const jx = (Math.random() - 0.5) * 1.6;    // 轻微抖动
        const jy = (Math.random() - 0.5) * 1.6;
        const x = sx + (tx - sx) * e + jx;
        const y = sy + (ty - sy) * e + jy;
        const init = Object.assign({}, base, { clientX: x, clientY: y, screenX: x, screenY: y });
        // 派发到该坐标下真实的元素上，页面的事件委托才能收到
        const target = (document.elementFromPoint(x, y) || el);
        try { target.dispatchEvent(new PointerEvent('pointermove', init)); } catch (err) { }
        target.dispatchEvent(new MouseEvent('mousemove', init));
        try { if (document !== target) document.dispatchEvent(new MouseEvent('mousemove', init)); } catch (err) { }
      }
      mousePos.x = tx;
      mousePos.y = ty;
    } catch (e) { }
  }

  /**
   * 模拟一次真实鼠标点击：按浏览器的实际顺序派发完整事件序列，
   * 带上元素中心的真实坐标。比起直接 el.click() 或直接改 checked，
   * 更接近人手操作，页面上的 hover/active 逻辑也会被触发。
   */
  function realClick(el) {
    if (!el) return false;
    ensureVisible(el);
    moveMouseTo(el);          // 先把指针移过去，再点
    const r = el.getBoundingClientRect();
    const cx = r.left + Math.max(1, r.width / 2);
    const cy = r.top + Math.max(1, r.height / 2);
    const base = {
      bubbles: true, cancelable: true, view: window, composed: true,
      clientX: cx, clientY: cy, screenX: cx, screenY: cy,
      button: 0, pointerId: 1, isPrimary: true, pointerType: 'mouse'
    };
    const down = Object.assign({}, base, { buttons: 1 });
    const up = Object.assign({}, base, { buttons: 0 });

    // 1) 指针移到目标上（悬停态）
    fire(el, 'pointerover', Object.assign({}, up, { bubbles: true }));
    fire(el, 'mouseover', up);
    fire(el, 'pointerenter', Object.assign({}, up, { bubbles: false }));
    fire(el, 'mouseenter', Object.assign({}, up, { bubbles: false }));
    fire(el, 'pointermove', up);
    fire(el, 'mousemove', up);
    // 2) 按下
    try { el.dispatchEvent(new PointerEvent('pointerdown', down)); } catch (e) { fire(el, 'pointerdown', down); }
    fire(el, 'mousedown', down);
    try { if (typeof el.focus === 'function') el.focus({ preventScroll: true }); } catch (e) { }
    // 3) 抬起 + 点击
    try { el.dispatchEvent(new PointerEvent('pointerup', up)); } catch (e) { fire(el, 'pointerup', up); }
    fire(el, 'mouseup', up);
    fire(el, 'click', up);

    return true;
  }

  function isChecked(input) {
    if (input.type === 'radio') return input.checked;
    return input.checked;
  }

  function nativeCheck(input, want) {
    if (!input) return false;
    if (isChecked(input) === want) return true;
    if (input._valueTracker && typeof input._valueTracker.setValue === 'function') {
      try { input._valueTracker.setValue(String(!want)); } catch (e) { }
    }
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
      if (desc && desc.set) desc.set.call(input, want); else input.checked = want;
    } catch (e) { input.checked = want; }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return isChecked(input) === want;
  }

  function selectOption(opt, want, kind) {
    const input = opt.input;
    const clickTarget = opt.el || input;
    if (kind === 'single' || kind === 'judge') {
      if (input && input.type === 'radio') {
        if (!input.checked) realClick(input);
        if (!input.checked) { realClick(clickTarget); if (!input.checked) nativeCheck(input, true); }
        return input.checked;
      }
      realClick(clickTarget);
      return true;
    }
    // multi
    if (input && input.type === 'checkbox') {
      if (!!input.checked !== want) {
        realClick(input);
        if (!!input.checked !== want) { realClick(clickTarget); if (!!input.checked !== want) nativeCheck(input, want); }
      }
      return !!input.checked === want;
    }
    const looksOn = /(^|\s)(on|active|selected|checked|is-checked|cur)(\s|$)/.test(String(clickTarget.className || '')) ||
      (clickTarget.parentElement && /(^|\s)(on|active|selected|checked|is-checked|cur)(\s|$)/.test(String(clickTarget.parentElement.className || '')));
    if (want) {
      if (!looksOn) realClick(clickTarget);
    } else if (looksOn) {
      realClick(clickTarget);   // 取消多余的勾选
    }
    return true;
  }

  function setValue(el, value) {
    if (!el) return false;
    ensureVisible(el);
    try { el.focus(); } catch (e) { }

    if (el.isContentEditable) {
      let ok = false;
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        ok = document.execCommand('insertText', false, value);
      } catch (e) { }
      if (!ok || !U.norm(el.innerText || el.textContent || '')) {
        el.innerHTML = '';
        el.textContent = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      return U.norm(el.innerText || '') === U.norm(value) || ok;
    }

    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    // 让 React 的 valueTracker 失效，避免受控组件把值写回旧值
    if (el._valueTracker && typeof el._valueTracker.setValue === 'function') {
      try { el._valueTracker.setValue(''); } catch (e) { }
    }
    try {
      if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    } catch (e) { el.value = value; }

    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Unidentified' }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
    try { el.blur(); } catch (e) { }
    return el.value === value;
  }


  /* ---------- 快照与撤销 ---------- */

  const __snapshots = new Map();

  function snapshot(q, index) {
    const snap = { index, at: Date.now(), options: [], blanks: [] };
    (q.refs.options || []).forEach(o => {
      if (o.input) snap.options.push({ input: o.input, checked: !!o.input.checked });
      else if (o.el) snap.options.push({ el: o.el, cls: String(o.el.className || "") });
    });
    (q.refs.blanks || q.refs.inputs || []).forEach(el => {
      if (!el) return;
      snap.blanks.push({ el, value: el.isContentEditable ? String(el.innerText || "") : String(el.value == null ? "" : el.value) });
    });
    __snapshots.set(index, snap);
    // 只保留最近 3 次批量操作，避免长期占用
  }

  const SELECTED_CLS = /(?:^|\s)(?:on|active|actived|is-active|selected|is-selected|checked|is-checked|cur|current|chosen|picked|ant-radio-checked|ant-checkbox-checked|ant-radio-wrapper-checked|ant-checkbox-wrapper-checked|el-radio--checked|radio-checked|checkbox-checked)(?:\s|$)/i;

  function isInputVisuallyHidden(inp) {
    try {
      const st = window.getComputedStyle(inp);
      if (st && (st.display === 'none' || st.visibility === 'hidden' || st.pointerEvents === 'none' || parseFloat(st.opacity) === 0)) return true;
      const r = inp.getBoundingClientRect();
      return r.width < 2 || r.height < 2;
    } catch (e) { return false; }
  }

  /**
   * 每次点击前重新从容器里取选项元素。
   * 很多考试系统点选后整卡重绘（innerHTML 重建），缓存里的元素会脱离文档，
   * 后续点击等于点在空气上——这是"多选题只勾上第一个"的常见原因。
   */
  /** 把某个选项设成目标状态；点不动时用事件序列兜底 */
  function setOptionState(o, want) {
    if (!o) return false;
    if (o.input) {
      if (!!o.input.checked === want) return true;
      // 隐藏的原生控件（如 display:none / 0x0）先点外层可见选项行，再点 input 自身
      if (isInputVisuallyHidden(o.input) && o.el && o.el !== o.input) {
        realClick(o.el);
        if (!!o.input.checked === want) return true;
      }
      // 先模拟真实鼠标点击：页面自己的 hover/active/校验逻辑都会跑一遍
      realClick(o.input);
      if (!!o.input.checked === want) return true;
      if (o.el && o.el !== o.input) realClick(o.el);
      if (!!o.input.checked === want) return true;
      // 实在点不动（被覆盖层挡住、disabled 等）才直接改属性兜底
      nativeCheck(o.input, want);
      return true;
    }
    if (!o.el) return false;
    if (isOptionOn(o) === want) return true;
    const prevCls = String(o.el.className || '');
    const prevStyle = String(o.el.getAttribute && o.el.getAttribute('style') || '');
    realClick(o.el);   // 只点一次；是否生效由外层回读判断
    const nextCls = String(o.el.className || '');
    const nextStyle = String(o.el.getAttribute && o.el.getAttribute('style') || '');
    try {
      if (want && (nextCls !== prevCls || nextStyle !== prevStyle)) o.el.__exaClickedOn = true;
      else if (!want) delete o.el.__exaClickedOn;
    } catch (e) { }
    return true;
  }

  /** 完整事件序列（用于 .click() 不生效的站点，只派发一次 click） */
  function dispatchClick(el) {
    if (!el) return false;
    try {
      fire(el, "pointerdown", {});
      fire(el, "mousedown", {});
      fire(el, "pointerup", { buttons: 0 });
      fire(el, "mouseup", { buttons: 0 });
      fire(el, "click", { buttons: 0 });
      return true;
    } catch (e) { return false; }
  }

  /**
   * 填涂前的动态校验：确认页面显示的仍然是识别时那道题。
   * 防止「答完题但页面已经翻到下一题」时把答案填到别人身上。
   */
  function verifyQuestionStillHere(q) {
    const c = q.refs && q.refs.container;
    if (!c || !c.isConnected) {
      return { ok: false, reason: '题目区域已从页面移除（可能已翻页）' };
    }
    const stemKey = U.norm(String(q.stem || '')).slice(0, 24);
    if (stemKey.length >= 6) {
      const containerText = U.norm(String(c.innerText || '') + String(c.textContent || ''));
      if (containerText.indexOf(stemKey) < 0) {
        return { ok: false, reason: '题干已变化（页面可能已换题）' };
      }
    }
    // 选项数量/文本也要对得上，避免选项被打乱或替换
    const opts = q.refs.options || [];
    if (opts.length) {
      const live = refreshOptionEls(q);
      if (live.length !== opts.length) {
        return { ok: false, reason: '选项数量已变化（' + opts.length + ' → ' + live.length + '）' };
      }
      const sameLabels = live.every((o, i) => o.label === opts[i].label);
      if (!sameLabels) {
        return { ok: false, reason: '选项结构已变化' };
      }
    }
    return { ok: true };
  }

  function refreshOptionEls(q) {
    const opts = q.refs.options || [];
    if (!opts.length) return opts;
    // 元素与原生 input 都仍在文档树里时直接复用，避免重查错位
    if (opts.every(o => o && o.el && o.el.isConnected && (!o.input || o.input.isConnected))) {
      return opts;
    }
    const container = q.refs.container;
    if (!container || !container.isConnected) return opts;

    // 原生 input 选项重绘：同时刷新 input 与外层选项元素
    if (opts.some(o => o.input)) {
      let liveInputs = [];
      try { liveInputs = Array.from(container.querySelectorAll('input[type=radio],input[type=checkbox]')); } catch (e) { }
      if (liveInputs.length === opts.length) {
        return opts.map((o, i) => {
          const inp = liveInputs[i];
          const el = (inp.closest && inp.closest('label')) || (o.el && o.el.isConnected ? o.el : inp.parentElement) || inp;
          return Object.assign({}, o, { input: inp, el });
        });
      }
    }

    const first = opts[0] && opts[0].el;
    if (!first) return opts;

    const bindLiveInput = (o, el) => {
      if (!el) return o.input && o.input.isConnected ? o.input : null;
      if (el.tagName === 'INPUT') return el;
      let inp = null;
      try { inp = el.querySelector('input[type=radio],input[type=checkbox]'); } catch (e) { }
      return inp || (o.input && o.input.isConnected ? o.input : null);
    };

    const tag = first.tagName;
    let all = [];
    try { all = Array.from(container.querySelectorAll(tag)); } catch (e) { return opts; }
    // 优先按归一化选项文本匹配（取最内层叶子节点，避开外层包裹容器），其次按 A-H 前缀过滤
    const byText = opts.map(o => {
      const want = U.norm(o.text || '');
      if (!want) return null;
      const hits = all.filter(e => {
        const t = U.norm(e.innerText || e.textContent || '');
        return t === want || t.endsWith(want) || (o.label && new RegExp('^' + o.label + '(\\s|\\n|\\.|、)').test(t));
      });
      if (!hits.length) return null;
      return hits.find(e => !hits.some(other => other !== e && e.contains(other))) || hits[hits.length - 1];
    });
    if (byText.every(Boolean)) {
      return opts.map((o, i) => Object.assign({}, o, { el: byText[i], input: bindLiveInput(o, byText[i]) }));
    }

    const filtered = all.filter(e => {
      const t = String(e.innerText || e.textContent || '').trim();
      return /^[A-H](\s|\n|\.|、|,|，|：|:)/.test(t) || /^[A-H]$/.test(t);
    });
    if (filtered.length !== opts.length) return opts;   // 数量对不上就保守不动
    return opts.map((o, i) => Object.assign({}, o, { el: filtered[i], input: bindLiveInput(o, filtered[i]) }));
  }

  function isOptionOn(o) {
    if (!o) return false;
    if (o.input) return !!o.input.checked;
    const el = o.el;
    if (!el) return false;
    if (el.__exaClickedOn) return true;
    const checkAttrs = node => {
      if (!node || !node.getAttribute) return false;
      if (SELECTED_CLS.test(String(node.className || ''))) return true;
      return node.getAttribute('aria-checked') === 'true' ||
        node.getAttribute('aria-selected') === 'true' ||
        node.getAttribute('aria-pressed') === 'true' ||
        node.getAttribute('data-checked') === 'true' ||
        node.getAttribute('data-selected') === 'true' ||
        node.getAttribute('data-active') === 'true';
    };
    if (checkAttrs(el)) return true;
    // 选中态常挂在父元素上（选项按钮包着字母 span）
    if (el.parentElement && checkAttrs(el.parentElement)) return true;
    // 子元素里也可能带选中态（如 <button><i class="checked"/></button>）
    try {
      const inner = el.querySelector('[class*=checked],[class*=selected],[class*=is-active],[aria-checked="true"]');
      if (inner) return true;
    } catch (e) { }
    return false;
  }

  function hasAnswer(q, kind) {
    const opts = q.refs.options || [];
    if (kind === "fill" || kind === "short" || kind === "calc") {
      return (q.refs.blanks || []).some(b => b && String(b.isContentEditable ? (b.innerText || "") : (b.value || "")).trim());
    }
    if (opts.some(isOptionOn)) return true;
    return false;
  }

  /** 撤销最近一次填涂 */
  function undo() {
    if (!__snapshots.size) return { ok: false, error: "没有可撤销的填涂记录" };
    let restored = 0;
    const count = __snapshots.size;
    const all = Array.from(__snapshots.values());
    __snapshots.clear();
    all.forEach(s => { restored += restoreOne(s); });
    return { ok: true, restored, count };
  }

  function restoreOne(s) {
    let restored = 0;
    // 先恢复应当选中的单选/多选
    s.options.forEach(o => {
      if (o.input && o.checked && !o.input.checked) {
        realClick(o.input);
        if (!o.input.checked) { realClick(o.input); if (!o.input.checked) nativeCheck(o.input, true); }
        restored++;
      }
    });
    // 再取消本不该选中的项（checkbox 靠点击，radio 只能用原生 setter 清掉）
    s.options.forEach(o => {
      if (!o.input || o.checked || !o.input.checked) return;
      if (o.input.type === "checkbox") realClick(o.input);
      if (o.input.checked) { realClick(o.input); if (o.input.checked) nativeCheck(o.input, false); }
      if (!o.input.checked) restored++;
    });
    // 纯 DOM 选项：还原 class
    s.options.forEach(o => {
      if (!o.input && o.el && o.cls != null) {
        o.el.className = o.cls;
        restored++;
      }
    });
    s.blanks.forEach(b => {
      if (!b.el) return;
      setValue(b.el, b.value || "");
      restored++;
    });
    return restored;
  }

  /* ---------- 对外 ---------- */

  function fillByIndex(index, payload, opts) {
    opts = opts || {};
    const cache = qxExtract.getCache();
    const q = cache[index];
    if (!q) return { ok: false, error: "题目索引已失效，请重新识别" };
    if (!q.refs) return { ok: false, error: "该题无可用 DOM 引用（可能来自截图/选中文本）" };

    let kind = payload.kind || q.kind;
    const answer = String(payload.answer == null ? "" : payload.answer).trim();
    if (!answer) return { ok: false, error: "答案为空" };

    const optsList0 = q.refs.options || [];
    if ((!kind || kind === "auto") && optsList0.length) {
      if (optsList0.length <= 3 && optsList0.every(o => judgePolarity(o.text) !== 0)) kind = "judge";
      else kind = parseLetters(answer, optsList0.length).length > 1 ? "multi" : "single";
    } else if ((!kind || kind === "auto") && (q.refs.blanks || q.refs.inputs || []).length) {
      kind = "fill";
    }
    if (kind !== "judge" && optsList0.length >= 2 && optsList0.length <= 3 &&
        judgePolarity(answer) !== 0 && optsList0.every(o => judgePolarity(o.text) !== 0)) {
      kind = "judge";
    }

    // 不覆盖已有作答
    if (opts.skipAnswered && hasAnswer(q, kind)) {
      return { ok: false, skipped: true, error: "页面上已有作答，已跳过" };
    }

    // 动态校验：页面题目变了就别填
    const still = verifyQuestionStillHere(q);
    if (!still.ok) {
      return { ok: false, error: '题目已变化，已取消填涂（' + still.reason + '）', stale: true };
    }

    snapshot(q, index);
    const log = [];

    if (kind === "single" || kind === "multi" || kind === "judge") {
      const optsList = optsList0;
      if (!optsList.length) return { ok: false, error: "未识别到选项" };

      let chosen = [];
      if (kind === "judge") {
        const wantPol = judgePolarity(answer);
        let target = null;
        if (wantPol !== 0) {
          target = optsList.find(o => judgePolarity(o.text) === wantPol);
        }
        if (!target) {
          const letters = parseLetters(answer, optsList.length);
          if (letters.length) chosen = letters;
          else if (wantPol === 1) target = optsList[0];
          else if (wantPol === -1) target = optsList[1] || optsList[0];
          else target = optsList[0];
        }
        if (target && target.label) chosen = [target.label];
      } else {
        chosen = parseLetters(answer, optsList.length);
        if (!chosen.length) {
          const an = U.norm(answer);
          let hit = optsList.find(o => U.norm(o.text) === an);
          if (!hit) hit = optsList.find(o => an.length >= 2 && (o.text.includes(an) || an.includes(o.text)) && o.text.length >= 2);
          if (hit) chosen = [hit.label];
        }
        if (!chosen.length) return { ok: false, error: "答案里没有可识别的选项字母：" + answer.slice(0, 40) };
      }

      // 答案本身给了多个字母时，即使识别成单选也按多选处理
      const effKind = (kind === "single" && chosen.length > 1) ? "multi" : kind;
      const wantSet = new Set(chosen);

      // 逐个设置：每次都用最新元素（页面常在点选后整卡重绘）
      for (let idx = 0; idx < optsList.length; idx++) {
        const base = optsList[idx];
        const want = wantSet.has(base.label);
        const live = (refreshOptionEls(q)[idx]) || base;
        setOptionState(live, want);
        log.push(base.label + "=" + (want ? 1 : 0));
      }

      // 回读校验 + 补齐：判断/单选/多选统一走这一套
      let finalOn = refreshOptionEls(q).filter(isOptionOn).map(o => o.label);
      let missing = chosen.filter(l => !finalOn.includes(l));
      for (let attempt = 0; attempt < 2 && missing.length; attempt++) {
        missing.forEach(l => {
          const o = refreshOptionEls(q).find(x => x.label === l);
          if (!o) return;
          if (o.input) { nativeCheck(o.input, true); if (!o.input.checked) dispatchClick(o.input); }
          else dispatchClick(o.el);   // 第二次尝试改用完整事件序列
        });
        log.push("补齐:" + missing.join(""));
        finalOn = refreshOptionEls(q).filter(isOptionOn).map(o => o.label);
        missing = chosen.filter(l => !finalOn.includes(l));
      }

      const okAll = chosen.every(l => finalOn.includes(l));
      const head = effKind === "judge" ? "判断 " : effKind === "multi" ? "已勾选 " : "已选择 ";
      return {
        ok: okAll,
        log,
        detail: head + (finalOn.join("") || "无") + (okAll ? "" : "（目标 " + chosen.join("") + "）"),
        selected: finalOn
      };
    }

    if (kind === "fill" || kind === "short" || kind === "calc") {
      const boxes = (q.refs.blanks || q.refs.inputs || []).filter(Boolean);
      if (!boxes.length) return { ok: false, error: "未找到可填写的输入框" };
      const parts = kind === "fill" ? splitBlanks(answer, boxes.length) : [answer];
      let okCount = 0;
      boxes.forEach((box, i) => {
        const val = kind === "fill" ? (parts[i] || "") : (i === 0 ? answer : "");
        if (setValue(box, val)) okCount++;
        log.push("#" + (i + 1) + ":" + val.slice(0, 24));
      });
      return { ok: okCount > 0, log, detail: "已填入 " + okCount + "/" + boxes.length };
    }

    return { ok: false, error: "该题型不支持自动填充（" + kind + "），请手动抄写" };
  }

  function fillAll(list, opts) {
    return (list || []).map(item => {
      try {
        return Object.assign({ index: item.index }, fillByIndex(item.index, item, opts));
      } catch (e) {
        return { index: item.index, ok: false, error: String(e && e.message || e) };
      }
    });
  }

  return { fillByIndex, fillAll, parseLetters, undo, hasAnswer };
})();
