/* 内容脚本编排层：识别 → 解题队列 → 回填 → UI 联动 */
(function () {
  'use strict';
  // 版本化守卫：扩展更新后允许新脚本接管旧页面（无需用户按 F5）
  const SELF_VER = (() => { try { return chrome.runtime.getManifest().version; } catch (e) { return '0'; } })();
  if (globalThis.__EXA_BOOTED__ === SELF_VER) return;
  if (typeof globalThis.__EXA_DESTROY__ === 'function') {
    try { globalThis.__EXA_DESTROY__(); } catch (e) { }
  }
  globalThis.__EXA_BOOTED__ = SELF_VER;

  const IS_TOP = (() => { try { return window.top === window; } catch (e) { return false; } })();
  const DEFAULT_CONCURRENCY = 3;

  const state = {
    questions: [],
    results: new Map(),     // index -> {kind, answer, reasoning, confidence, notes}
    solving: new Set(),
    pageTitle: '',
    needOcr: false,
    structure: null,
    rawKey: '',
    uiOn: false,
    settings: { model: '未配置', hasKey: false, autoFillAfterSolve: false, doubleCheck: false },
    kbEntries: 0,
    reqSeq: 0
  };

  /* ---------------- UI 代理：隐身模式下完全不碰页面 DOM ---------------- */
  const UI_MUTATORS = [
    'ensure', 'show', 'hide', 'status', 'toast', 'meta', 'stat', 'clear', 'renderList',
    'setState', 'setCardClass', 'appendThinking', 'setThinkingText', 'setAnswer', 'setFilled',
    'markAll', 'setWarn', 'setEditing', 'setAuto', 'fillDrawer', 'closeDrawer', 'toggle'
  ];
  const UI_READERS = ['isVisible', 'isEditing', 'getEditValue', 'readDrawer', 'isMounted', 'unmount', 'on'];

  const ui = {};
  UI_MUTATORS.forEach(k => {
    ui[k] = (...args) => { if (!state.uiOn) return undefined; return qxOverlay[k](...args); };
  });
  UI_READERS.forEach(k => {
    ui[k] = (...args) => qxOverlay[k](...args);
  });

  function replayAnswers() {
    state.questions.forEach(q => {
      const r = state.results.get(q.index);
      if (r) ui.setAnswer(q.index, r);
    });
  }

  let watchTimer = 0;
  let lastSig = '';

  function qnumSignature() {
    try {
      const s = qxExtract.probeStructure();
      return s && s.total ? (s.current + '/' + s.total) : '';
    } catch (e) { return ''; }
  }

  function startWatcher() {
    stopWatcher();
    lastSig = qnumSignature();
    watchTimer = setInterval(async () => {
      if (!state.uiOn) return;
      const sig = qnumSignature();
      if (!sig || sig === lastSig) return;
      lastSig = sig;
      // 页面换题了：重新识别并把已有答案贴回卡片
      await doExtract({ force: true, silent: true });
      ui.renderList(state.questions);
      replayAnswers();
      updateProgress();
      ui.status('已同步当前题', 'ok');
    }, 1200);
  }

  function stopWatcher() {
    if (watchTimer) { clearInterval(watchTimer); watchTimer = 0; }
  }

  function openPanel() {
    state.uiOn = true;
    ui.show();
    if (!ui.isMounted()) return;
    updateMeta();
    ui.renderList(state.questions);
    replayAnswers();
    updateProgress();
    startWatcher();
  }

  /* ---------------- 与后台通信 ---------------- */

  function send(msg) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(msg, res => {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
          resolve(res || { ok: false, error: '空响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  async function loadSettings() {
    const r = await send({ type: 'getSettings' });
    if (r.ok && r.settings) {
      state.settings = r.settings;
      state.kbEntries = r.kbEntries || 0;
    }
    try {
      const raw = await chrome.storage.local.get('settings');
      state.rawKey = (raw.settings || {}).apiKey || '';
    } catch (e) { }
    updateMeta();
  }

  function updateMeta() {
    const s = state.settings;
    const kb = state.kbEntries ? ` · 知识库 ${state.kbEntries} 条` : '';
    ui.meta(`${s.model || '未配置模型'}${s.hasKey ? '' : ' · 缺 Key'}${s.doubleCheck ? ' · 双检' : ''}${kb}`);
  }

  /* ---------------- 阶段心跳：让"卡在哪一步"看得见 ---------------- */

  let stageTimer = 0;
  let stageAt = 0;
  let stageName = '';

  function startStageClock(name) {
    stageName = name;
    stageAt = Date.now();
    clearInterval(stageTimer);
    stageTimer = setInterval(() => {
      const sec = Math.round((Date.now() - stageAt) / 1000);
      if (sec >= 6 && stageName) ui.status(stageName + '…' + sec + 's', 'busy');
    }, 1000);
  }

  function stopStageClock(okText) {
    clearInterval(stageTimer);
    stageTimer = 0;
    stageName = '';
    if (okText) ui.status(okText, 'ok');
  }

  /* ---------------- 流式解题 ---------------- */

  /** 打开后台端口：service worker 可能正在休眠/唤醒，失败时重试几次 */
  async function openPort(tries) {
    const n = tries || 5;

    // 先用一条轻消息唤醒 service worker（connect 本身叫不醒正在冷启动的它）
    try {
      await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'exa-sw-ping' }, () => {
          void chrome.runtime.lastError;   // 忽略"没响应"，目的只是唤醒
          resolve();
        });
      });
    } catch (e) { }

    let last = '';
    for (let i = 0; i < n; i++) {
      try {
        return chrome.runtime.connect({ name: 'exa' });
      } catch (e) {
        last = String((e && e.message) || e);
        // 只有"扩展上下文失效"才是真没救（页面里还是旧版脚本）
        if (/context invalidated|Extension context/i.test(last)) {
          throw new Error('扩展刚更新，新版本正在自动接管，请再点一次（一般不用刷新页面）');
        }
        // "Receiving end does not exist" 多半是 service worker 还在启动，继续等
        await new Promise(r => setTimeout(r, 200 + 250 * i));
      }
    }
    throw new Error('后台正在启动，稍等一秒会自己重试（' + last + '）');
  }

  function analyze(q, onThinking, onStatus, opts) {
    opts = opts || {};
    return new Promise(async (resolve, reject) => {   // eslint-disable-line no-async-promise-executor
      let port;
      try {
        port = await openPort(3);
      } catch (e) {
        return reject(e);
      }
      const reqId = 'r' + (++state.reqSeq) + '_' + Date.now().toString(36);
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { port.postMessage({ type: 'cancel', reqId }); } catch (e) { }
        try { port.disconnect(); } catch (e) { }
        reject(new Error('请求超时（可在设置里调大超时时间）'));
      }, 180 * 1000);

      const cleanup = () => {
        clearTimeout(timer);
        try { port.onMessage.removeListener(onMessage); } catch (e) { }
        try { port.disconnect(); } catch (e) { }
      };

      const onMessage = msg => {
        if (!msg || msg.reqId !== reqId || settled) return;
        if (msg.type === 'thinking') { onThinking && onThinking(msg.text || ''); return; }
        if (msg.type === 'status') {
          if (/知识库/.test(msg.text || '')) startStageClock('检索知识库');
          onStatus && onStatus(msg.text || '');
          return;
        }
        if (msg.type === 'done') {
          settled = true; cleanup();
          resolve(msg.result);
          return;
        }
        if (msg.type === 'error') {
          settled = true; cleanup();
          reject(new Error(msg.message || '模型调用失败'));
        }
      };

      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const why = chrome.runtime.lastError && chrome.runtime.lastError.message;
        reject(new Error('后台连接断开（' + (why || 'service worker 被回收') + '），正在重连，请再点一次'));
      });

      try {
        port.postMessage({
          type: 'analyze',
          reqId,
          question: {
            index: q.index,
            kind: q.kind,
            stem: q.stem,
            options: q.options,
            blanks: q.blanks,
            pageTitle: state.pageTitle,
            imageDataUrl: q.imageDataUrl || null,
            noCache: !!opts.force
          }
        });
      } catch (e) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('发送失败：' + (e && e.message)));
      }
    });
  }

  /* ---------------- 自动作答（隐式模式：不挂页面） ---------------- */

  const auto = { running: false, timer: 0, count: 0, seen: new Set(), limit: 0, retry: 0, idle: 0, next: false };
  const autoTrace = [];
  function trace(o) { try { autoTrace.push(Object.assign({ t: Date.now() }, o)); if (autoTrace.length > 30) autoTrace.shift(); } catch (e) { } }

  function qKey(q) {
    return qxUtil.norm(q.stem || '').replace(/\s+/g, '').slice(0, 60);
  }

  function scheduleAuto(ms) {
    clearTimeout(auto.timer);
    auto.timer = setTimeout(runAutoStep, ms);
  }

  function clickNext() {
    const btn = qxExtract.findNextButton();
    if (!btn) return false;
    try { btn.click(); return true; } catch (e) { return false; }
  }

  function stopAuto(reason) {
    const was = auto.running;
    auto.running = false;
    clearTimeout(auto.timer);
    if (state.uiOn) {
      ui.setAuto(false);
      ui.status("就绪", "");
    }
    send({ type: "badge", text: "" });
    if (was && reason) console.info("[exa] 自动作答结束：" + reason);
    if (was && reason && state.uiOn) ui.toast("自动作答结束：" + reason);
  }

  async function startAuto() {
    if (auto.running) { stopAuto("手动停止"); return; }
    if (!isSiteAllowed()) {
      ui.show();
      ui.toast("当前网站不在启用列表里，先到设置里放开这个域名");
      return;
    }
    auto.running = true;
    auto.count = 0;
    auto.retry = 0;
    auto.idle = 0;
    auto.next = false;
    auto.seen.clear();
    auto.limit = Number(state.settings.autoLimit) || 0;
    // 只有面板本来就开着时才更新它的状态；隐式模式下完全不碰 DOM
    if (state.uiOn) ui.setAuto(true);
    send({ type: "badge", text: "·" });
    runAutoStep();
  }

  const AUTO_MAX_RETRY = 6;

  async function runAutoStep() {
    if (!auto.running) return;
    if (!isSiteAllowed()) {
      stopAuto("当前网站不在启用列表里（设置 → 只在匹配的网站启用）");
      return;
    }

    // 上一题作答完成后的延迟翻页
    if (auto.next) {
      auto.next = false;
      clickNext();
      scheduleAuto(1500);
      return;
    }

    try {
      const list = await doExtract({ force: true, silent: true });
      state.structure = qxExtract.probeStructure();

      // 识别为空：很可能页面正在重绘（尤其题型切换时），重试几次再判定结束
      if (!list || !list.length) {
        auto.retry += 1;
        if (auto.retry <= AUTO_MAX_RETRY) { scheduleAuto(1500); return; }
        stopAuto("页面连续没有识别到题目");
        return;
      }

      const next = list.find(x => !auto.seen.has(qKey(x)));
      if (!next) {
        // 本题已处理过：尝试翻页；翻页失败也可能是重绘中的瞬时状态，重试几次
        if (state.settings.autoNext !== false && clickNext()) {
          auto.retry = 0;
          scheduleAuto(1800);
          return;
        }
        auto.retry += 1;
        if (auto.retry <= AUTO_MAX_RETRY) { scheduleAuto(1500); return; }
        stopAuto("连续 " + AUTO_MAX_RETRY + " 次没有检测到新题");
        return;
      }

      auto.retry = 0;
      auto.seen.add(qKey(next));
      auto.count += 1;
      send({ type: "badge", text: String(auto.count) });
      trace({ step: "start", idx: next.index, qlen: state.questions.length, rsize: state.results.size });
      const solved = await solveIndex(next.index, {});
      trace({ step: "solved", ok: !!solved, rsize: state.results.size });
      const filled = await fillIndex(next.index, true);
      trace({ step: "filled", ok: filled });
      if (auto.limit && auto.count >= auto.limit) { stopAuto("达到上限 " + auto.limit + " 题"); return; }

      // 一屏一题：先停留一下让人看清填了什么，再翻页
      if (state.structure.mode === "single" && state.settings.autoNext !== false) {
        auto.next = true;
        scheduleAuto(Math.max(600, Number(state.settings.fillHoldMs) || 1200));
        return;
      }
      scheduleAuto(Math.max(3, Number(state.settings.autoInterval) || 10) * 1000);
    } catch (e) {
      stopAuto("出错：" + (e && e.message ? e.message : e));
    }
  }

  /* ---------------- 跟随模式（默认）：翻到新题就自动答这一题，但不翻页 ---------------- */

  const follow = { timer: 0, lastSig: "", busy: false, tries: 0, lastErr: "", lastAt: 0, lastCheck: 0, empty: 0, offUrl: "", lastUrl: "", fails: new Map(), paused: new Set() };

  function followSignature() {
    try {
      // 1) 有题号最可靠
      const s = qxExtract.probeStructure();
      if (s && s.total) return "q" + s.current + "/" + s.total;
      // 2) 退而求其次：明确的题干元素（避免误匹配页面静态 h1/h2/h3 标题导致切题后签名不变）
      const el = document.querySelector(".qtext,.stem,[class*=stem],[class*=qtext],.q-title,.question-title");
      const t = el ? qxUtil.oneLine(el.innerText || "") : "";
      const inpN = document.querySelectorAll('input[type=radio],input[type=checkbox],textarea').length;
      const body = qxUtil.oneLine((document.body && document.body.innerText) || "");
      if (t && t.length >= 4) return "t" + qxUtil.hash(t.slice(0, 80)) + ":" + inpN + ":" + body.length;
      // 3) 最后兜底：整页可见文本首尾 + 控件数（结构陌生或整卷异步加载都能感知变化）
      if (body.length >= 20) return "b" + qxUtil.hash(body.slice(0, 500) + "|" + body.slice(-300)) + ":" + inpN;
      return "";
    } catch (e) { return ""; }
  }

  /** 只在设置里允许的网站跑（留空 = 全部允许） */
  function isSiteAllowed() {
    const raw = String(state.settings.siteAllow || "").trim();
    if (!raw) return true;
    const host = location.hostname + (location.port ? ":" + location.port : "");
    const href = location.href;
    return raw.split(/\n+/).map(x => x.trim()).filter(Boolean).some(pat => {
      const p = pat.replace(/[.+?^${}()|[\]\\]/g, ch => "\\" + ch).replace(/\*/g, ".*");
      try {
        const re = new RegExp(p, "i");
        return re.test(host) || re.test(href);
      } catch (e) { return false; }
    });
  }

  /**
   * 这一页到底像不像考试页。
   * 配置页、网关后台也有 input 和文字，不能光凭"能解析出东西"就当成题。
   */
  function looksLikeExam() {
    try {
      const radios = document.querySelectorAll('input[type=radio],input[type=checkbox]').length;
      if (radios >= 2) return true;
      const text = String((document.body && document.body.innerText) || '');
      if (/第\s*\d+\s*[题\/／]|\d+\s*\/\s*\d+\s*题/.test(text)) return true;   // 有题号
      if (/[（(]\s*\d+\s*分\s*[)）]/.test(text)) return true;                      // 有分值
      const optMarks = (text.match(/(^|[\s\u3000])[A-D]\s*[.、．:：)）]/g) || []).length;
      if (optMarks >= 2) return true;                                                // 有 A. B. 选项
      if (/判断题|单选题|多选题|单项选择题|多项选择题/.test(text)) return true;         // 有题型字样
      return false;
    } catch (e) { return false; }
  }

  async function followTick() {
    if (auto.running) return;
    if (state.settings.followMode === false) return;
    if (follow.busy) return;
    if (!isSiteAllowed()) return;
    if (!looksLikeExam()) {
      follow.empty += 1;
      if (follow.empty === 6) {
        follow.offUrl = location.href;
        console.info('[exa] 这一页不像考试页（没有选项控件、题号或题型字样），已停止自动作答');
      }
      return;
    }
    if (follow.lastUrl && follow.lastUrl !== location.href) {
      follow.offUrl = "";
      follow.empty = 0;
      follow.tries = 0;
      follow.fails.clear();
      follow.paused.clear();
    }
    follow.lastUrl = location.href;

    // 这个页面已被判定"没有题"，且没换页 → 不再空转
    if (follow.offUrl && follow.offUrl === location.href) return;

    const sig = followSignature();
    const changed = !!sig && sig !== follow.lastSig;
    if (changed) {
      // 切到新题 / 新页面变化：清零连续失败计数，绝不把上一题的失败状态带给新题
      follow.tries = 0;
      follow.lastErr = "";
    }
    const slowDue = Date.now() - (follow.lastCheck || 0) > 2000;   // 签名失效/上次静默失败时的兜底
    if (!changed && !slowDue) return;

    follow.busy = true;
    follow.lastCheck = Date.now();
    try {
      const list = await doExtract({ force: true, silent: true });
      // 只认「结构化的题」：整页兜底（source=page）说明没抓到真正的题目
      const usable = (list || []).filter(q =>
        q && q.source !== 'page' && String(q.stem || '').trim().length >= 6
      );
      if (!usable.length) {
        // 连续多次识别不到真正的题目：多半这一页根本不是考试页（配置页、网关后台等）
        follow.empty += 1;
        follow.lastSig = "";
        if (follow.empty >= 6) {
          follow.offUrl = location.href;
          console.info('[exa] 本页连续 ' + follow.empty + ' 次没识别到题目，已停止在此页自动作答（换页或点「识别本页」会恢复）');
        }
        return;
      }
      follow.empty = 0;
      follow.lastSig = sig;

      const failBump = (q, reason) => {
        const k = qKey(q);
        const n = (follow.fails.get(k) || 0) + 1;
        follow.fails.set(k, n);
        follow.tries = n;
        follow.lastErr = reason;
        if (n <= 3) {
          follow.lastSig = "";
          console.info('[exa] 跟随作答未完成（' + reason + '），第 ' + n + ' 次重试');
        } else {
          follow.paused.add(k);
          const r = state.results.get(q.index);
          if (r) r.__fillState = 'paused';
          console.warn('[exa] 跟随作答连续失败，暂停这一题：' + reason);
        }
      };

      // 先补填「已解出但上次未填上」的题，不让漏填的题永久停留在空白
      const pendingFill = usable.filter(x => {
        const r = state.results.get(x.index);
        if (!r || !r.answer) return false;
        if (r.__fillState === 'ok' || r.__fillState === 'skipped' || r.__fillState === 'paused') return false;
        return !follow.paused.has(qKey(x));
      });
      for (const q of pendingFill) {
        await fillIndex(q.index, true);
        const r = state.results.get(q.index);
        if (r && (r.__fillState === 'ok' || r.__fillState === 'skipped')) {
          follow.fails.delete(qKey(q));
        } else {
          failBump(q, (r && r.__fillErr) || '填涂未成功');
        }
      }

      const pending = usable.filter(x => !state.results.has(x.index) && !follow.paused.has(qKey(x)));
      if (!pending.length) return;                                  // 当前未暂停的题都已处理完

      // 整卷场景：按并发度分批解完并逐题隔离失败，单题报错绝不阻断后续题目
      const conc = Math.max(1, Math.min(4, Number(state.settings.concurrency) || DEFAULT_CONCURRENCY));
      for (let at = 0; at < pending.length; at += conc) {
        const batch = pending.slice(at, at + conc);
        const solvedList = await Promise.all(batch.map(q => solveIndex(q.index, {}).catch(() => null)));
        for (let i = 0; i < batch.length; i++) {
          const q = batch[i];
          const k = qKey(q);
          const sr = solvedList[i];
          if (!sr) {
            failBump(q, '解题未返回结果');
            continue;
          }
          await fillIndex(q.index, true);
          const resObj = state.results.get(q.index) || sr;
          if (resObj.__fillState === 'ok' || resObj.__fillState === 'skipped') {
            follow.fails.delete(k);
            follow.tries = 0;
            follow.lastErr = "";
          } else {
            failBump(q, resObj.__fillErr || '填涂未成功');
          }
        }
      }
    } catch (e) {
      follow.tries += 1;
      follow.lastErr = String(e && e.message || e);
      if (follow.tries <= 3) follow.lastSig = "";
      console.warn("[exa] 跟随作答失败", follow.lastErr);
    } finally {
      follow.busy = false;
      follow.lastAt = Date.now();
    }
  }


  /* ---------------- 页面变化监听：翻页/换题立即响应 ---------------- */
  let pageObserver = null;
  let observeTimer = 0;

  function observePageChanges() {
    if (pageObserver || typeof MutationObserver === 'undefined' || !document.body) return;
    pageObserver = new MutationObserver(() => {
      // DOM 变化很密集，合并到 150ms 内只跑一次
      if (observeTimer) return;
      observeTimer = setTimeout(() => {
        observeTimer = 0;
        if (auto.running) return;              // 自动连做有自己的节奏
        if (state.settings.followMode === false) return;
        if (follow.busy) return;
        followTick();
      }, 150);
    });
    try {
      pageObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    } catch (e) { pageObserver = null; }
  }

  function startFollow() {
    if (follow.timer) return;
    observePageChanges();
    follow.timer = setInterval(followTick, 300);   // 兜底轮询（observer 失效时仍有反应）
    setTimeout(followTick, 120);
  }

  /**
   * 识别不到题目时，判断页面到底是什么形态，给针对性说明。
   * 图片/画布题：配了视觉模型就自动走截图识别。
   */
  function diagnoseNoQuestion() {
    // 1) 内嵌 PDF（embed/object）——扩展读不到里面的文字
    const pdfEmbed = document.querySelector('embed[type="application/pdf"],object[type="application/pdf"],iframe[src*=".pdf"]');
    if (pdfEmbed) {
      return {
        autoVision: false,
        message: "这一页是内嵌 PDF，扩展读不到里面的文字。把 PDF 下载到本地打开，或把题目导入知识库。"
      };
    }

    // 2) 图片 / canvas 渲染的题面
    const bigImgs = Array.from(document.images || []).filter(im => im.naturalWidth >= 240 && im.naturalHeight >= 100);
    const canvases = document.querySelectorAll('canvas');
    if (canvases.length || bigImgs.length) {
      const vision = String(state.settings.visionModel || '').trim();
      if (vision) {
        return {
          autoVision: true,
          message: "这页题目像是图片/画布渲染的，正在自动改用截图识别（视觉模型 " + vision + "）。"
        };
      }
      return {
        autoVision: false,
        message: "这页题目像是图片/画布渲染的，需要在设置里填一个「视觉模型」才能识别（如 gpt-4o、qwen-vl-plus）。"
      };
    }

    // 3) 题目在 iframe 里但没取到
    if (document.querySelectorAll('iframe').length) {
      return {
        autoVision: false,
        message: "页面里有 iframe，但没读到题目。等题目加载完再识别一次；跨域 iframe 可能需要刷新页面。"
      };
    }

    return {
      autoVision: false,
      message: "没抓到题目：可以选中题干文字后再识别，或确认这道题是不是需要先点「开始/进入考试」。"
    };
  }

  /** 页面几乎没有可读文字（canvas/图片试卷）时，自动改用视觉识别，同一页面只做一次 */
  let autoVisionKey = '';

  function maybeAutoVision() {
    if (!state.needOcr) return;
    const vision = String(state.settings.visionModel || '').trim();
    if (!vision) return;
    const key = location.href + '|' + document.querySelectorAll('canvas').length + '|' + (document.images || []).length;
    if (key === autoVisionKey) return;
    autoVisionKey = key;
    setTimeout(async () => {
      const done = await imageQuestionMode({ silent: true });
      if (!done) {
        ui.toast('已自动改用整屏截图识别（视觉模型 ' + vision + '）');
        screenshotMode();
      }
    }, 300);
  }

  /* ---------------- 识别 ---------------- */

  function updateProgress() {
    if (!state.questions.length) return;
    const done = state.questions.filter(q => state.results.has(q.index)).length;
    ui.stat(`已解 ${done}/${state.questions.length}`);
  }

  function pushQuestions(list) {
    const prevQuestions = state.questions || [];
    const prevResults = state.results || new Map();

    // 换题时按题干把仍然匹配的旧答案接回来，其余丢弃，避免把上一题的答案套到新题上
    const byKey = new Map();
    prevQuestions.forEach(q => {
      const r = prevResults.get(q.index);
      if (r) byKey.set(qKey(q), r);
    });

    state.questions = (list || []).map((q, i) => Object.assign({}, q, { index: i }));
    state.results = new Map();
    state.questions.forEach(q => {
      const r = byKey.get(qKey(q));
      if (r) state.results.set(q.index, r);
    });

    ui.renderList(state.questions);
  }

  async function doExtract(opts) {
    opts = opts || {};
    if (opts.force) {
      follow.offUrl = "";
      follow.empty = 0;
      if (!opts.silent) {
        follow.tries = 0;
        follow.fails.clear();
        follow.paused.clear();
      }
    }   // 手动识别 = 重置并重试
    ui.show();
    ui.status('识别中…', 'busy');

    // 1) 用户选中文字优先
    if (IS_TOP && !opts.force) {
      let selText = '';
      try { selText = String(window.getSelection ? window.getSelection() : ''); } catch (e) { }
      selText = qxUtil.norm(selText);
      if (selText.length >= 10) {
        const list = qxExtract.extractSelection();
        if (list.length) {
          pushQuestions(list.concat([]));
          ui.status('已用选中文本', 'ok');
          return state.questions;
        }
      }
    }

    // 2) 本地优先：当前 frame 能识别出来就不必跨进程全帧扫描（省一次 IPC）
    if (IS_TOP) {
      let localNow = [];
      // 注意：必须带 fallback，否则一页多题时只会命中第一个容器（曾因此只识别到 1 题）
      try { localNow = qxExtract.extractAll({ fallback: true }); } catch (e) { localNow = []; }
      if (localNow.length) {
        state.pageTitle = document.title;
        state.needOcr = qxExtract.needOcr();
        pushQuestions(localNow.map(q => Object.assign({}, q, { frameId: 0, frameIndex: q.index })));
        ui.status('识别完成', 'ok');
        maybeAutoVision();
        return state.questions;
      }
    }

    // 3) 本地没有 → 跨 frame 采集（题目可能在 iframe 里）
    const r = await send({ type: 'collect' });
    if (r && r.ok && Array.isArray(r.questions) && r.questions.length) {
      state.pageTitle = r.pageTitle || document.title;
      state.needOcr = !!r.needOcr;
      pushQuestions(r.questions);
      ui.status('识别完成', 'ok');
      maybeAutoVision();
      return state.questions;
    }

    // 4) 兜底
    if (IS_TOP) {
      const local = qxExtract.extractAll({ fallback: true });
      if (local.length) {
        state.pageTitle = document.title;
        state.needOcr = qxExtract.needOcr();
        pushQuestions(local.map(q => Object.assign({}, q, { frameId: 0, frameIndex: q.index })));
        ui.status('识别完成（仅主框架）', 'ok');
        maybeAutoVision();
        return state.questions;
      }
      ui.status('未识别到题目', 'err');
      const why = diagnoseNoQuestion();
      ui.toast(why.message);
      // 图片/画布渲染的题目：配了视觉模型就自动转截图识别，不需要额外按钮
      if (why.autoVision) {
        ui.status('改用截图识别…', 'busy');
        setTimeout(() => { screenshotMode(); }, 300);
      }
    }
    return [];
  }

  /* ---------------- 解题 ---------------- */

  async function solveIndex(index, opts) {
    opts = opts || {};
    const q = state.questions[index];
    if (!q || state.solving.has(index)) return null;

    // 页面已经给出答案（练习/查看答案模式）：直接抄，最准也最快
    if (!opts.force && q.pageAnswer && q.pageAnswer.answer) {
      const r = {
        kind: q.kind,
        answer: q.pageAnswer.answer,
        reasoning: '页面已标注答案，直接采用：' + (q.pageAnswer.evidence || ''),
        confidence: q.pageAnswer.confidence,
        source: { kind: 'page', hits: [] }
      };
      state.results.set(index, r);
      ui.setAnswer(index, r);
      ui.setState(index, '页面答案', 'ok');
      ui.setCardClass(index, 'done');
      updateProgress();
      stopStageClock('解题完成');
      if (state.settings.autoFillAfterSolve && q.frameId != null) await fillIndex(index, true);
      return r;
    }

    state.solving.add(index);
    ui.setState(index, '思考中', 'run');
    ui.setCardClass(index, 'working');
    ui.setThinkingText(index, '');
    ui.status('解题中…', 'busy');
    startStageClock('等待模型');

    try {
      const t0 = Date.now();
      const r = await analyze(
        q,
        text => ui.setThinkingText(index, text),
        text => ui.setState(index, text, 'run'),
        { force: !!opts.force }
      );
      r.__ms = Date.now() - t0;                     // 解题耗时，显示在来源标签上
      state.results.set(index, r);
      ui.setAnswer(index, r);
      ui.setState(index, '完成', 'ok');
      ui.setCardClass(index, 'done');
      updateProgress();
      if (state.settings.autoFillAfterSolve && q.frameId != null) await fillIndex(index, true);
      return r;
    } catch (e) {
      const msg = String((e && e.message) || e);
      // 连接类问题（service worker 刚休眠/唤醒）自动重试一次
      if (!(opts && opts.__retried) && /后台|连接|context|唤醒|断开|启动|Receiving end/i.test(msg)) {
        console.info('[exa] 连接异常，700ms 后自动重试 #' + index + '：' + msg);
        await new Promise(r => setTimeout(r, 700));
        return solveIndex(index, Object.assign({}, opts, { __retried: true }));
      }
      console.warn('[exa] 解题失败 #' + index + '：' + msg);
      stopStageClock();
      ui.setState(index, '失败', 'bad');
      ui.setCardClass(index, 'err');
      ui.setThinkingText(index, '❌ ' + msg + (opts && opts.__retried ? '（已自动重试 1 次）' : ''));
      ui.status('出错', 'err');
      return null;
    } finally {
      state.solving.delete(index);
      ui.status(state.solving.size ? '解题中…' : '就绪', state.solving.size ? 'busy' : '');
    }
  }

  /* 库体检：逐题检查知识库匹配，把结果直接写进面板 */
  async function runKbAudit() {
    try {
      ui.status('体检中…', 'run');
      const list = state.questions.length ? state.questions : await doExtract({ force: true, silent: true });
      if (!list.length) { ui.status('先识别题目', 'err'); return; }

      const rows = [];
      for (const q of list) {
        const r = await send({ type: 'kbTest', question: q.stem, options: q.options, kind: q.kind });
        const top = r && r.hits && r.hits[0];
        rows.push({
          stem: String(q.stem || '').replace(/\s+/g, ' ').slice(0, 30),
          mode: (r && r.mode) || '?',
          exact: !!(r && r.exact),
          answer: (r && r.answer) || '',
          topQ: top ? String(top.q || '').slice(0, 26) : '',
          topA: top ? String(top.a || '').slice(0, 8) : ''
        });
      }

      const hit = rows.filter(x => x.mode === 'kb').length;
      const kbai = rows.filter(x => x.mode === 'kb+ai').length;
      const miss = rows.length - hit - kbai;

      ui.renderAudit(rows, { total: rows.length, hit, kbai, miss });
      console.info('[exa] 库体检', rows);
      ui.status('体检完成：命中 ' + hit + '/' + rows.length, miss ? 'warn' : 'ok');
    } catch (e) {
      ui.status('体检失败：' + (e && e.message || e), 'err');
    }
  }

  async function solveAll(indices) {
    if (!state.questions.length) {
      await doExtract({ force: true });
    }
    if (!state.questions.length) return;
    const queue = (indices && indices.length ? indices : state.questions.map(q => q.index)).slice();
    ui.markAll(true);
    ui.status('批量解题中…', 'busy');

    const worker = async () => {
      while (queue.length) {
        const i = queue.shift();
        if (state.results.has(i)) continue;
        await solveIndex(i);
      }
    };
    const conc = Math.max(1, Math.min(4, Number(state.settings.concurrency) || DEFAULT_CONCURRENCY));
    await Promise.all(Array.from({ length: Math.min(conc, Math.max(1, queue.length)) }, worker));

    ui.markAll(false);
    ui.status('就绪', '');
    const done = state.questions.filter(q => state.results.has(q.index)).length;
    ui.toast(`完成 ${done}/${state.questions.length} 题`);
    // 每题解完已在 solveIndex 内自动填涂，这里不再整体重填（否则会把「已填入」改写成「已有作答」）
  }

  /* ---------------- 回填 ---------------- */

  async function fillIndex(index, silent) {
    const q = state.questions[index];
    const r = state.results.get(index);
    trace({ step: "fill-enter", index, hasQ: !!q, hasR: !!r, frameId: q && q.frameId });
    if (!q || !r) { if (!silent) ui.toast('这道题还没有答案'); return false; }
    if (q.frameId == null) { if (!silent) ui.toast('该题来自截图/选中文本，手动抄写吧'); return false; }

    const res = await send({
      type: 'fill',
      skipAnswered: state.settings.skipAnswered !== false,
      items: [{
        index,
        frameId: q.frameId,
        frameIndex: q.frameIndex != null ? q.frameIndex : q.index,
        kind: r.kind || q.kind,
        answer: r.answer
      }]
    });
    const rep = res && res.ok && res.reports && res.reports[0];
    if (rep && rep.stale) {
      r.__fillState = 'fail';
      r.__fillErr = rep.error || '题目已变化';
      ui.setWarn(index, rep.error || '题目已变化');
      ui.toast('题目已变化，已跳过填涂，请点「识别本页」重新来一次');
      return false;
    }
    if (rep && rep.ok) flashAnswer(state.results.get(index));
    trace({ step: "fillrep", ok: rep && rep.ok, detail: rep && rep.detail, sel: rep && rep.selected, skipped: rep && rep.skipped, err: (rep && rep.error) || (res && res.error) || null });
    if (rep && rep.skipped) {
      r.__fillState = 'skipped';
      ui.setState(index, '已有作答', 'run');
      ui.setWarn(index, '页面上已经有作答，已按设置跳过（可在设置里关闭「不覆盖已有作答」）');
      if (!silent) ui.toast('已有作答，已跳过');
      return false;
    }
    if (rep && rep.ok) {
      r.__fillState = 'ok';
      ui.setFilled(index, true, rep.detail || '');
      ui.setState(index, '已填入', 'ok');
      if (!silent) ui.toast(rep.detail || '已填入');
      return true;
    }
    const errMsg = (rep && (rep.error || rep.detail)) || (res && res.error) || '未知原因';
    r.__fillState = 'fail';
    r.__fillErr = errMsg;
    if (!silent) ui.toast('填入失败：' + errMsg);
    return false;
  }

  async function fillAllFlow(silent) {
    const items = [];
    state.questions.forEach(q => {
      const r = state.results.get(q.index);
      if (!r || q.frameId == null) return;
      items.push({
        index: q.index,
        frameId: q.frameId,
        frameIndex: q.frameIndex != null ? q.frameIndex : q.index,
        kind: r.kind || q.kind,
        answer: r.answer
      });
    });
    if (!items.length) { if (!silent) ui.toast('还没有可填入的答案'); return; }

    ui.status('填入中…', 'busy');
    const res = await send({ type: 'fill', items, skipAnswered: state.settings.skipAnswered !== false });
    const reports = (res && res.reports) || [];
    let ok = 0;
    reports.forEach(rep => {
      if (rep.ok) {
        ok++;
        ui.setFilled(rep.index, true, rep.detail || '');
        ui.setState(rep.index, '已填入', 'ok');
      } else if (rep.skipped) {
        ui.setState(rep.index, '已有作答', 'run');
      } else {
        ui.setFilled(rep.index, false, rep.error || '');
      }
    });
    ui.status('就绪', '');
    ui.toast(`已填入 ${ok}/${items.length} 题`);
  }


  /* ---------------- 图片题：识别图中的题目再走正常流程 ---------------- */

  /** 在页面里为 OCR 出来的选项找对应的可点击元素 */
  function matchOptionElements(options) {
    const refs = [];
    const dom = state.questions.length ? null : qxExtract.extractAll({ fallback: true });
    const domOpts = (dom && dom[0] && dom[0].options) || [];

    options.forEach((o, i) => {
      const want = U.norm(o.text);
      let hit = domOpts.find(d => U.norm(d.text) === want);
      if (!hit) hit = domOpts.find(d => {
        const t = U.norm(d.text);
        return want.length >= 4 && t.length >= 4 && (t.includes(want) || want.includes(t));
      });
      refs.push({
        label: o.label || String.fromCharCode(65 + i),
        text: o.text,
        el: hit ? hit.el : null,
        input: hit ? hit.input : null
      });
    });
    return refs;
  }

  async function imageQuestionMode(opts) {
    opts = opts || {};
    const vision = String(state.settings.visionModel || '').trim();
    const engine = String(state.settings.ocrEngine || 'auto');
    // 本地 OCR 不需要视觉模型；只有选了视觉引擎才要求配置
    if (engine === 'vision' && !vision) {
      ui.toast('当前是视觉模型模式，但没配置视觉模型（设置里填写，或改用本地 OCR）');
      ui.status('未配置视觉模型', 'err');
      return false;
    }
    if (engine === 'auto' && !vision) {
      // 没配视觉模型就自动走本地
    }

    ui.show();
    ui.status('查找题目图片…', 'run');
    const images = qxExtract.findQuestionImages(6);
    if (!images.length) {
      if (!opts.silent) ui.toast('没找到题目图片，改用整屏截图识别');
      return false;
    }

    ui.status('识别图片题（' + images.length + ' 张）…', 'run');
    const list = [];
    let failed = 0;
    const useLocal = engine === 'local' || (engine === 'auto' && !vision);

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      try {
        /* 本地模式：Tesseract 出文本，再用页面已有的纯文本解析器结构化（完全离线） */
        if (useLocal) {
          ui.status('本地 OCR 识别中…（' + (i + 1) + '/' + images.length + '）', 'run');
          const lr = await send({ type: 'ocr-local-text', dataUrl: img.dataUrl });
          if (!lr || !lr.ok) { failed++; continue; }
          const parsed = qxExtract.scanPlainText(lr.text);
          if (!parsed.length) { failed++; continue; }
          parsed.forEach(p => {
            const refs = matchOptionElements(p.options || []);
            list.push({
              index: list.length,
              kind: p.kind,
              stem: p.stem,
              options: (p.options || []).map(o => ({ label: o.label, text: o.text })),
              blanks: (p.blanks || []).length,
              source: 'image-local',
              score: 0.8,
              frameId: 0,
              frameIndex: i,
              refs: refs.length ? { options: refs, container: img.el, blanks: [] } : null,
              imageDataUrl: null
            });
          });
          continue;
        }

        const r = await send({ type: 'ocr-question', dataUrl: img.dataUrl });
        if (!r || !r.ok) { failed++; continue; }
        if (r.engine === 'local') {
          const parsed = qxExtract.scanPlainText(r.text);
          parsed.forEach(p => {
            const refs = matchOptionElements(p.options || []);
            list.push({
              index: list.length,
              kind: p.kind,
              stem: p.stem,
              options: (p.options || []).map(o => ({ label: o.label, text: o.text })),
              blanks: (p.blanks || []).length,
              source: 'image-local',
              score: 0.8,
              frameId: 0,
              frameIndex: i,
              refs: refs.length ? { options: refs, container: img.el, blanks: [] } : null,
              imageDataUrl: null
            });
          });
          continue;
        }
        const items = (Array.isArray(r.questions) && r.questions.length) ? r.questions : [r];
        items.forEach((item, qIdx) => {
          const refs = matchOptionElements(item.options || []);
          list.push({
            index: list.length,
            kind: item.kind,
            stem: item.stem,
            options: (item.options || []).map(o => ({ label: o.label, text: o.text })),
            blanks: 0,
            source: 'image',
            score: 0.9,
            frameId: 0,
            frameIndex: i * 100 + qIdx,
            refs: refs.length ? { options: refs, container: img.el, blanks: [] } : null,
            imageDataUrl: null
          });
        });
      } catch (e) {
        failed++;
        console.info('[exa] 图片题识别失败：' + (e && e.message || e));
      }
    }

    if (!list.length) {
      ui.status('图片识别失败，改用整屏截图', 'err');
      return false;
    }

    state.questions = list;
    state.results.clear();
    state.needOcr = false;
    ui.renderList(list.map(q => ({
      index: q.index, kind: q.kind, stem: q.stem, options: q.options,
      source: 'image', blanks: 0
    })));
    updateProgress();
    ui.status('图片题识别完成：' + list.length + ' 题' + (failed ? '（失败 ' + failed + '）' : ''), 'ok');
    ui.toast('从图片识别出 ' + list.length + ' 道题');
    return true;
  }

  /* ---------------- 截图模式（画布型试卷） ---------------- */

  async function screenshotMode() {
    ui.show();
    ui.status('截图中…', 'busy');
    const shot = await send({ type: 'screenshot' });
    if (!shot.ok || !shot.dataUrl) {
      ui.status('截图失败', 'err');
      ui.toast('截图失败：' + (shot.error || '请确认当前标签页处于激活状态'));
      return;
    }
    const q = {
      index: 0,
      kind: 'page',
      stem: '【截图模式】请识别截图里的全部题目，逐题给出答案（按 1. 2. 3. 编号）。',
      options: [],
      blanks: 0,
      source: 'screenshot',
      frameId: null,
      frameIndex: null,
      imageDataUrl: shot.dataUrl
    };
    state.questions = [q];
    state.results.clear();
    ui.renderList([{ index: 0, kind: 'page', stem: q.stem, options: [], source: 'screenshot', blanks: 0 }]);
    await solveIndex(0);
  }

  /* ---------------- 复制 ---------------- */

  async function copyAnswer(index) {
    const r = state.results.get(index);
    if (!r) return;
    const src = r.source && r.source.kind === 'kb'
      ? `（来源：知识库 ${(r.source.hits || []).map(h => h.docName).join('、') || ''}）`
      : r.source && r.source.kind === 'kb+ai' ? '（来源：知识库 + AI）' : '（来源：AI）';
    const text = `${r.answer}\n${src}${r.reasoning ? '\n\n— 思考过程 —\n' + r.reasoning : ''}`;
    try {
      await navigator.clipboard.writeText(text);
      ui.toast('已复制');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); ui.toast('已复制'); } catch (err) { ui.toast('复制失败'); }
      ta.remove();
    }
  }

  /* ---------------- 撤销填涂 ---------------- */

  async function undoFill() {
    const res = await send({ type: "fillUndo" });
    if (!res || !res.ok) { ui.toast("撤销失败：" + ((res && res.error) || "未知原因")); return; }
    if (!res.restored) { ui.toast("没有可撤销的填涂"); return; }
    state.questions.forEach(q => {
      if (state.results.has(q.index)) {
        ui.setFilled(q.index, false, "");
        ui.setState(q.index, "已撤销", "run");
      }
    });
    ui.toast("已撤销本次填涂（" + res.restored + " 处控件）");
  }

  /* ---------------- 存入知识库 ---------------- */

  async function saveToKb(index) {
    const q = state.questions[index];
    const r = state.results.get(index);
    if (!q || !r) { ui.toast("先解题再存库"); return; }
    const optsText = (q.options || []).map(o => o.label + ". " + o.text).join("\n");
    const optsMap = {};
    (q.options || []).forEach(o => { if (o && o.label && o.text) optsMap[o.label] = o.text; });
    const fullBlock = q.stem + (optsText ? "\n" + optsText : "");
    ui.status("存入知识库…", "busy");
    const res = await send({
      type: "kbAdd",
      entries: [{
        type: "qa",
        question: q.stem,
        options: optsMap,
        answer: String(r.answer || ""),
        raw: fullBlock + "\n答案：" + r.answer
      }]
    });
    ui.status("就绪", "");
    if (!res || !res.ok) { ui.toast("存入失败：" + ((res && res.error) || "未知原因")); return; }
    const added = res.added || {};
    if (added.duplicate) {
      ui.toast("知识库里已经有这道题了");
    } else {
      ui.toast("已存入知识库（" + (added.entryCount || 1) + " 条），下次直接命中");
    }
    loadSettings();
  }

  /* ---------------- 人工修正答案 ---------------- */

  function toggleEdit(index) {
    if (!ui.isEditing(index)) { ui.setEditing(index, true); return; }
    const value = ui.getEditValue(index);
    const r = state.results.get(index);
    if (!r) { ui.setEditing(index, false); return; }
    if (!value) { ui.toast("答案不能为空"); return; }
    r.answer = value;
    r.notes = (r.notes ? r.notes + "；" : "") + "人工修正";
    if (r.warn) delete r.warn;
    ui.setAnswer(index, r);
    ui.toast("已修正，可点「存库」沉淀进知识库");
  }

  /* ---------------- 导出 ---------------- */

  const SRC_TEXT = {
    kb: "知识库", "kb+ai": "知识库+AI", ai: "AI", cache: "缓存", page: "页面答案"
  };

  function answerWithOption(q, answer) {
    const opts = q.options || [];
    const letters = Array.from(new Set(String(answer || '').toUpperCase().match(/[A-H]/g) || []));
    if (!opts.length || !letters.length) return String(answer || '');
    const parts = letters.map(l => {
      const o = opts.find(x => x.label === l);
      return o ? (l + '. ' + o.text) : l;
    }).filter(Boolean);
    return parts.length ? (String(answer) + '（' + parts.join('；') + '）') : String(answer || '');
  }

  function buildExportText() {
    const lines = ["# 考试辅助 · 答案导出", ""];
    lines.push("- 页面：" + (document.title || location.href));
    lines.push("- 地址：" + location.href);
    lines.push("- 时间：" + new Date().toLocaleString());
    lines.push("- 题数：" + state.questions.length + "，已解：" + state.results.size);
    lines.push("");
    state.questions.forEach(q => {
      const r = state.results.get(q.index);
      lines.push("## " + (q.index + 1) + ". [" + q.kind + "] " + String(q.stem || "").replace(/\n/g, " ").slice(0, 200));
      if (q.options && q.options.length) {
        lines.push(q.options.map(o => o.label + ". " + o.text).join("  "));
      }
      if (r) {
        const src = r.source ? (SRC_TEXT[r.source.kind] || r.source.kind) : "—";
        const conf = typeof r.confidence === "number" ? "，置信 " + Math.round(r.confidence * 100) + "%" : "";
        lines.push("");
        lines.push("**答案：** " + answerWithOption(q, r.answer) + "  \n来源：" + src + conf);
        if (r.warn) lines.push("⚠ " + r.warn);
        if (r.notes) lines.push("备注：" + r.notes);
        if (r.reasoning) lines.push("\n> " + String(r.reasoning).replace(/\n/g, "\n> "));
      } else {
        lines.push("");
        lines.push("**答案：** （未解）");
      }
      lines.push("");
    });
    return lines.join("\n");
  }

  function exportAnswers(asJson) {
    if (!state.questions.length) { ui.toast("还没有可导出的内容"); return; }
    let blob, name;
    if (asJson) {
      const data = {
        url: location.href, title: document.title, at: new Date().toISOString(),
        items: state.questions.map(q => {
          const r = state.results.get(q.index) || {};
          return {
            index: q.index + 1, kind: q.kind, stem: q.stem, options: q.options,
            answer: r.answer || "", source: r.source ? r.source.kind : null,
            confidence: r.confidence == null ? null : r.confidence,
            reasoning: r.reasoning || "", warn: r.warn || ""
          };
        })
      };
      blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
      name = "答案_" + new Date().toISOString().slice(0, 10) + ".json";
    } else {
      blob = new Blob([buildExportText()], { type: "text/markdown;charset=utf-8" });
      name = "答案_" + new Date().toISOString().slice(0, 10) + ".md";
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) { } }, 4000);
    ui.toast("已导出 " + name);
  }

  /* ---------------- 面板事件 ---------------- */

  function bindOverlay() {
    ui.on(({ action, index, values }) => {
      switch (action) {
        case 'extract': doExtract({ force: true }); break;
        case 'solve-all': solveAll(); break;
        case 'fill-all': fillAllFlow(); break;
        case 'clear': state.results.clear(); ui.clear(); state.questions = []; updateProgress(); break;
        case 'undo': undoFill(); break;
        case 'image':
          imageQuestionMode().then(done => {
            if (!done) return;
            const pending = state.questions.filter(q => !state.results.has(q.index));
            if (pending.length) solveIndex(pending[0].index, {});
          }).catch(e => ui.status('图片识别出错：' + (e && e.message || e), 'err'));
          break;
        case 'audit': runKbAudit(); break;
        case 'export': exportAnswers(false); break;
        case 'save-kb': saveToKb(index); break;
        case 'edit': toggleEdit(index); break;
        case 'settings': openPanel(); break;
        case 'close':
          stopWatcher();
          if (state.settings.stealth) { qxOverlay.unmount(); state.uiOn = false; }
          else { ui.hide(); }
          break;
        case 'auto': startAuto(); break;
        case 'drawer-open':
          ui.fillDrawer(Object.assign({}, state.settings, { apiKey: state.rawKey }));
          break;
        case 'save-settings': savePanelSettings(values || {}); break;
        case 'open-options': send({ type: 'openOptions' }); break;
        case 'solve': solveIndex(index, { force: state.results.has(index) }); break;
        case 'fill': fillIndex(index); break;
        case 'copy': copyAnswer(index); break;
        default: break;
      }
    });
  }

  async function savePanelSettings(v) {
    const patch = {
      model: v.model, baseUrl: v.baseUrl,
      autoInterval: v.autoInterval, autoLimit: v.autoLimit,
      followMode: !!v.followMode,
      autoNext: !!v.autoNext, stealth: !!v.stealth
    };
    if (v.apiKey) patch.apiKey = v.apiKey;
    const res = await send({ type: 'saveSettings', settings: patch });
    if (res && res.ok) {
      await loadSettings();
      ui.closeDrawer();
      ui.toast('已保存（不跳转页面）');
    } else {
      ui.toast('保存失败：' + ((res && res.error) || '未知'));
    }
  }

  /** 把来源+可信度拼成一句话，闪 1.5 秒 */
  const SRC_LABEL = {
    kb: '来自知识库',
    'kb+ai': '知识库 + AI',
    ai: 'AI 生成',
    cache: '来自缓存',
    page: '来自页面答案',
    miss: '知识库未收录'
  };

  /** 当前题干的屏幕位置，用来把标记贴到题目上方 */
  function stemAnchorRect() {
    const sels = ['.qtext', '.stem', '[class*=qtext]', '[class*=stem]', 'h1', 'h2', 'h3'];
    for (const sel of sels) {
      let el = null;
      try { el = document.querySelector(sel); } catch (e) { continue; }
      if (!el) continue;
      const t = String(el.textContent || '').trim();
      if (t.length < 6) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 10) continue;
      if (r.bottom < 0 || r.top > (window.innerHeight || 0)) continue;   // 不在视口内就换下一个
      return { top: r.top, left: r.left, width: r.width };
    }
    return null;
  }

  function flashAnswer(r) {
    if (!r) return;
    const ms = state.settings.flashMs === 0 ? 0 : (Number(state.settings.flashMs) || 1500);
    if (!ms) return;
    const kind = (r.source && r.source.kind) || 'ai';
    const label = SRC_LABEL[kind] || kind;
    const conf = typeof r.confidence === 'number' ? Math.round(r.confidence * 100) + '%' : '';
    const exact = !!(r.source && r.source.hits && r.source.hits[0] && r.source.hits[0].exact);
    const tag = kind === 'kb' && exact ? '(精确命中)' : '';
    qxOverlay.flash(label + tag + (conf ? ' · 可信度 ' + conf : ''), kind, ms, stemAnchorRect());
  }

  /* ---------------- 消息（popup / 快捷键） ---------------- */

  function onRuntimeMessage(msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'cmd-toggle':
        if (!IS_TOP) { sendResponse({ ok: true }); return true; }
        if (qxOverlay.isVisible()) {
          stopWatcher();
          if (state.settings.stealth) { qxOverlay.unmount(); state.uiOn = false; }
          else { ui.hide(); }
        } else {
          openPanel();
        }
        sendResponse({ ok: true, visible: qxOverlay.isVisible() });
        return true;
      case 'cmd-solve-current':
        if (!IS_TOP) { sendResponse({ ok: true }); return true; }
        openPanel();
        (async () => {
          const list = await doExtract({ force: true });
          const q = list.find(x => !state.results.has(x.index)) || list[0];
          if (q) { await solveIndex(q.index, {}); await fillIndex(q.index, true); }
        })();
        sendResponse({ ok: true });
        return true;
      case 'cmd-fill-current':
        if (!IS_TOP) { sendResponse({ ok: true }); return true; }
        openPanel();
        (async () => {
          const list = state.questions.length ? state.questions : await doExtract({ force: true });
          const q = list.find(x => state.results.has(x.index));
          if (q) await fillIndex(q.index, false);
          else ui.toast('当前题还没有答案');
        })();
        sendResponse({ ok: true });
        return true;
      case 'cmd-solve-all':
        if (!IS_TOP) { sendResponse({ ok: true }); return true; }
        openPanel();
        solveAll();
        sendResponse({ ok: true });
        return true;
      case 'cmd-fill-all':
        if (!IS_TOP) { sendResponse({ ok: true }); return true; }
        openPanel();
        fillAllFlow();
        sendResponse({ ok: true });
        return true;
      case 'cmd-screenshot':
        if (!IS_TOP) { sendResponse({ ok: true }); return true; }
        screenshotMode();
        sendResponse({ ok: true });
        return true;
      case 'cmd-extract':
        if (!IS_TOP) { sendResponse({ ok: true }); return true; }
        doExtract({ force: true }).then(list => sendResponse({ ok: true, count: (list || []).length }));
        return true;
      case 'cmd-auto':
        if (!IS_TOP) { sendResponse({ ok: true }); return true; }
        startAuto();
        sendResponse({ ok: true });
        return true;
      case 'cmd-undo':
        if (!IS_TOP) { sendResponse({ ok: true }); return true; }
        undoFill().then(() => sendResponse({ ok: true }));
        return true;
      case 'cmd-export':
        if (!IS_TOP) { sendResponse({ ok: true }); return true; }
        exportAnswers(!!msg.json);
        sendResponse({ ok: true });
        return true;
      case 'exa-auto-ping':
        // 后台定时器打过来的心跳：即使页面 timer 被节流也能继续推进
        if (IS_TOP && auto.running) {
          clearTimeout(auto.timer);
          runAutoStep();
          sendResponse({ ok: true, running: true, mode: 'auto' });
          return true;
        }
        // 自动连做没开时，心跳顺手推一下跟随模式（后台标签页定时器会被节流）
        if (IS_TOP && !auto.running && state.settings.followMode !== false && !follow.busy) {
          followTick();
          sendResponse({ ok: true, running: false, mode: 'follow' });
          return true;
        }
        sendResponse({ ok: true, running: auto.running });
        return true;
      case 'settings-changed':
        loadSettings().then(() => {
          // 设置变了：清掉"本页已停用"，让新设置有机会生效
          follow.offUrl = "";
          follow.empty = 0;
          follow.lastSig = "";
        });
        sendResponse({ ok: true });
        return true;
      case 'kb-changed':
        // 知识库更新后：清掉本页非知识库直答的旧结果并允许重新触发，让新知识库立即生效
        state.results.forEach((r, idx) => {
          if (!r || !r.source || r.source.kind !== 'kb') state.results.delete(idx);
        });
        follow.offUrl = "";
        follow.empty = 0;
        follow.lastSig = "";
        loadSettings();
        sendResponse({ ok: true });
        return true;
      case 'exa-ping':
        sendResponse({ ok: true, top: IS_TOP, count: state.questions.length });
        return true;
      default:
        return;
    }
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  /* ---------------- 面板内快捷键兜底 ---------------- */

  if (IS_TOP) {
    window.addEventListener('keydown', e => {
      if (e.altKey && e.shiftKey) {
        const k = (e.key || '').toLowerCase();
        if (k === 'q') {
          e.preventDefault();
          if (qxOverlay.isVisible()) {
            stopWatcher();
            if (state.settings.stealth) { qxOverlay.unmount(); state.uiOn = false; }
            else { ui.hide(); }
          } else { openPanel(); }
        }
        else if (k === 's') {
          // 与「Alt+Shift+S = 解当前这道题」保持一致，不要一次解全部
          e.preventDefault();
          (async () => {
            const list = state.questions.length ? state.questions : await doExtract({ force: true });
            const q = list.find(x => !state.results.has(x.index)) || list[0];
            if (q) { await solveIndex(q.index, {}); await fillIndex(q.index, true); }
          })();
        }
        else if (k === 'f') {
          e.preventDefault();
          (async () => {
            const list = state.questions.length ? state.questions : await doExtract({ force: true });
            const q = list.find(x => state.results.has(x.index));
            if (q) await fillIndex(q.index, false);
            else ui.toast('当前题还没有答案');
          })();
        }
      }
    }, true);
  }

  /* ---------------- 启动 ---------------- */

  globalThis.__EXA_DEBUG__ = {
    results: () => Array.from(state.results.entries()).map(([i, r]) => ({
      index: i, kind: r.kind, answer: r.answer,
      confidence: r.confidence, source: r.source || null, warn: r.warn || null
    })),
    questions: () => state.questions.map(q => ({
      index: q.index, kind: q.kind, stem: String(q.stem || '').slice(0, 60),
      frameId: q.frameId, frameIndex: q.frameIndex,
      score: q.score, pageAnswer: q.pageAnswer || null
    })),
    kbEntries: () => state.kbEntries,
    settings: () => state.settings,
    solve: i => solveIndex(i),
    solveForce: i => solveIndex(i, { force: true }),
    solveAll: () => solveAll(),
    clearResults: () => { state.results.clear(); },
    saveToKb: i => saveToKb(i),
    exportText: () => buildExportText(),
    undo: () => undoFill(),
    fillOne: i => fillIndex(i, true),
    extract: () => doExtract({ force: true, silent: true }),
    auto: () => startAuto(),
    autoRunning: () => auto.running,
    autoTrace: () => autoTrace.slice(-20),
    siteAllowed: () => isSiteAllowed(),
    looksLikeExam: () => looksLikeExam(),
    selfCheck: () => {
      const s = state.settings || {};
      const list = state.questions || [];
      const res = state.results || new Map();
      let probe = null;
      try { probe = qxExtract.probeStructure(); } catch (e) { probe = { error: String(e && e.message || e) }; }
      let live = null;
      try { live = qxExtract.extractAll({}).map(q => ({ kind: q.kind, stem: String(q.stem).slice(0, 30) })); } catch (e) { live = { error: String(e && e.message || e) }; }
      return {
        settings: {
          model: s.model, hasKey: !!s.hasKey, followMode: s.followMode,
          stealth: s.stealth, kbEnabled: s.kbEnabled, flashMs: s.flashMs
        },
        已识别: list.length,
        已解: res.size,
        跟随: {
          mode: s.followMode !== false, busy: follow.busy, tries: follow.tries,
          lastErr: follow.lastErr, lastSig: follow.lastSig,
          最近检查: follow.lastCheck ? Math.round((Date.now() - follow.lastCheck) / 1000) + ' 秒前' : '还没跑过',
          白名单: isSiteAllowed() ? '允许' : '未允许（设置里加这个域名）',
          像考试页: looksLikeExam(),
          本页已停用: !!follow.offUrl,
          连续空识别: follow.empty
        },
        自动连做: { running: auto.running, count: auto.count, retry: auto.retry },
        页面结构: probe,
        当前页面题目: live,
        UI: { mounted: qxOverlay.isMounted(), uiOn: state.uiOn },
        提示: !list.length
          ? '没识别到题目：先看「当前页面题目」是不是空。空的话点「识别本页」或检查页面是否已进入考试。'
          : (res.size === 0
            ? '识别到了但还没解：如果是隐藏模式，等 2 秒它会自己答；也可以按 Alt+Shift+S 手动解当前题。'
            : '已经解出答案，若页面没填上，检查是不是「不覆盖已有作答」把它跳过了。')
      };
    },
    kbAudit: async () => {
      const list = state.questions.length ? state.questions : await doExtract({ force: true, silent: true });
      const items = [];
      for (const q of list) {
        const r = await send({ type: 'kbTest', question: q.stem, options: q.options, kind: q.kind });
        const top = r && r.hits && r.hits[0];
        items.push({
          stem: String(q.stem || '').replace(/\s+/g, ' ').slice(0, 34),
          mode: r && r.mode,
          exact: !!(r && r.exact),
          overlap: r && r.overlap,
          topQ: top ? String(top.q || '').slice(0, 30) : '',
          topA: top ? String(top.a || '').slice(0, 12) : ''
        });
      }
      const hit = items.filter(x => x.mode === 'kb').length;
      const kbai = items.filter(x => x.mode === 'kb+ai').length;
      return {
        题数: items.length,
        直接命中: hit,
        '知识库+AI': kbai,
        未命中: items.length - hit - kbai,
        命中率: items.length ? Math.round((hit / items.length) * 100) + '%' : '-',
        明细: items
      };
    },
    kbCheck: async () => {
      const list = state.questions.length ? state.questions : await doExtract({ force: true, silent: true });
      const q = list[0];
      if (!q) return { ok: false, error: "当前页没有识别到题目" };
      const r = await send({ type: "kbTest", question: q.stem, options: q.options, kind: q.kind });
      return Object.assign({ question: String(q.stem).slice(0, 40) }, r);
    },
    stopAuto: () => stopAuto("调试停止"),
    uiMounted: () => qxOverlay.isMounted(),
    toolbar: () => qxOverlay.toolbarLabels(),
    ansTag: (i) => qxOverlay.ansTagOf(i),
    lastFlash: () => qxOverlay.lastFlashInfo(),
    followSig: () => followSignature(),
    structure: () => state.structure || qxExtract.probeStructure(),
    saveSettings: v => savePanelSettings(v),
    uiOn: () => state.uiOn
  };

  if (IS_TOP) {
    bindOverlay();
    loadSettings().then(startFollow);
    // 监听设置变化，实时刷新模型显示并清掉停用标记
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings) {
          follow.offUrl = "";
          follow.empty = 0;
          loadSettings();
        }
      });
    } catch (e) { }
  }

  /* 扩展更新时由新实例调用，避免旧实例的定时器/监听器继续跑 */
  globalThis.__EXA_DESTROY__ = () => {
    try { clearInterval(follow.timer); follow.timer = 0; } catch (e) { }
    try { if (pageObserver) { pageObserver.disconnect(); pageObserver = null; } } catch (e) { }
    try { clearTimeout(auto.timer); auto.running = false; } catch (e) { }
    try { clearInterval(stageTimer); } catch (e) { }
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch (e) { }
    try { stopWatcher(); } catch (e) { }
    try { if (qxOverlay.isMounted && qxOverlay.isMounted()) qxOverlay.unmount(); } catch (e) { }
    globalThis.__EXA_BOOTED__ = null;
  };
})();
