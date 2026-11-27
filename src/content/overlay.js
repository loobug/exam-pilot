/* 悬浮解题面板：closed shadow DOM，页面脚本拿不到内部结构 */
var qxOverlay = (function () {
  'use strict';
  let host = null;
  let root = null;
  let visible = false;
  let collapsed = false;
  const refs = {};
  const cards = new Map();      // index -> { el, state, ansWrap, ansVal, conf, think, thinkPre, fillBtn, copyBtn, solveBtn }
  const listeners = [];         // (action, payload) => void

  const KIND_TEXT = {
    single: '单选', multi: '多选', judge: '判断', fill: '填空',
    short: '简答', calc: '计算', page: '整页', auto: '未定'
  };

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box;font-family:-apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  .wrap{position:fixed;top:72px;right:18px;z-index:2147483600;width:420px;max-width:calc(100vw - 24px);
    display:flex;flex-direction:column;border-radius:14px;overflow:hidden;
    background:#0e1117f2;color:#e6edf3;border:1px solid #2b3546;
    box-shadow:0 18px 48px rgba(0,0,0,.5),0 2px 8px rgba(0,0,0,.4);
    backdrop-filter:blur(14px);font-size:13px;line-height:1.55}
  .wrap.off{display:none}
  header{display:flex;align-items:center;gap:8px;padding:9px 10px;background:linear-gradient(180deg,#182232,#131a26);
    border-bottom:1px solid #26303f;cursor:move;user-select:none}
  .dot{width:8px;height:8px;border-radius:50%;background:#3fb950;box-shadow:0 0 8px #3fb95099;flex:0 0 auto}
  .dot.busy{background:#d29922;box-shadow:0 0 8px #d2992299;animation:pulse 1s infinite}
  .dot.err{background:#f85149;box-shadow:0 0 8px #f8514999}
  @keyframes pulse{50%{opacity:.35}}
  .title{font-weight:700;font-size:13px;letter-spacing:.3px;white-space:nowrap}
  .stat{font-size:11px;color:#8b98a9;margin-left:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .grow{flex:1}
  .icon{width:24px;height:24px;border-radius:7px;border:1px solid #2c3646;background:#1b2431;
    color:#c9d4e2;cursor:pointer;display:grid;place-items:center;font-size:13px;line-height:1;padding:0}
  .icon:hover{background:#243040;border-color:#3a4657;color:#fff}
  .toolbar{display:flex;gap:5px;padding:9px 10px;border-bottom:1px solid #222b38;flex-wrap:wrap}
  .toolbar .btn{padding:6px 8px;font-size:11.5px}
  .btn{appearance:none;border:1px solid #2c3646;background:#1a2431;color:#d7e2ee;border-radius:8px;
    padding:6px 10px;font-size:12px;cursor:pointer;white-space:nowrap;transition:.12s}
  .btn:hover:not(:disabled){background:#233043;border-color:#3c4a5e;color:#fff}
  .btn.primary{background:#1f6feb;border-color:#2b7bf5;color:#fff;font-weight:600}
  .btn.primary:hover:not(:disabled){background:#2b7bf5}
  .btn.ghost{background:transparent}
  .btn:disabled{opacity:.45;cursor:not-allowed}
  .list{overflow:auto;max-height:min(62vh,620px);padding:8px;display:flex;flex-direction:column;gap:8px}
  .list::-webkit-scrollbar{width:8px}
  .list::-webkit-scrollbar-thumb{background:#2b3644;border-radius:8px}
  .empty{color:#75849a;text-align:center;padding:22px 8px;font-size:12px;line-height:1.8}
  .card{border:1px solid #243040;border-radius:10px;background:#121926;padding:9px 10px}
  .card.done{border-color:#1f4f33;background:#101c16}
  .card.err{border-color:#5a2320;background:#1b1313}
  .card.working{border-color:#4a3a12}
  .chead{display:flex;align-items:center;gap:6px;margin-bottom:5px;font-size:11px}
  .n{background:#22303f;color:#9fb2c8;border-radius:6px;padding:1px 6px;font-weight:700}
  .kind{background:#1b2b45;color:#79b8ff;border-radius:6px;padding:1px 6px}
  .kind.multi{color:#d2a8ff;background:#24193b}
  .kind.judge{color:#ffd479;background:#2a2213}
  .kind.fill,.kind.short,.kind.calc{color:#7ee787;background:#16281a}
  .src{color:#63788f}
  .state{margin-left:auto;color:#8b98a9}
  .state.ok{color:#3fb950}.state.bad{color:#f85149}.state.run{color:#d29922}
  .stem{font-size:13px;color:#e9f0f7;white-space:pre-wrap;word-break:break-word;max-height:150px;overflow:auto}
  .opts{margin-top:5px;display:flex;flex-direction:column;gap:2px}
  .opt{font-size:12px;color:#a8b7c8;display:flex;gap:6px}
  .opt b{color:#6f8dad;flex:0 0 auto;font-weight:600}
  .ans{margin-top:7px;display:flex;align-items:center;gap:7px;flex-wrap:wrap;
    background:#0c1a12;border:1px solid #1d4a2d;border-radius:8px;padding:6px 8px}
  .ans .lb{font-size:11px;color:#7ee787}
  .ans .val{font-size:14px;font-weight:700;color:#7ee787;word-break:break-word;white-space:pre-wrap;flex:1;min-width:0}
  .conf{font-size:11px;color:#8b98a9}
  .srcrow{display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap}
  .badge{font-size:10.5px;border-radius:5px;padding:1px 6px;border:1px solid #2c3646;color:#9aa9bb;background:#141c26}
  .badge.kb{color:#7ee787;border-color:#2c5c3a;background:#0f2417}
  .badge.mix{color:#79b8ff;border-color:#25486e;background:#0f1c2b}
  .badge.ai{color:#9aa9bb;border-color:#2c3646;background:#151d27}
  .badge.cache{color:#ffd479;border-color:#5c4a1e;background:#241d0f}
  .badge.page{color:#d2a8ff;border-color:#432c66;background:#1d1430}
  .badge.score-low{color:#f0883e;border-color:#4a3418;background:#241a10}
  .warnbox{margin-top:5px;font-size:11px;color:#f0883e;background:#241a10;border:1px solid #4a3418;
    border-radius:6px;padding:4px 7px;line-height:1.5}
  .anstag{font-size:10px;line-height:1.6;padding:1px 7px;border-radius:5px;margin-left:7px;
    vertical-align:middle;white-space:nowrap;font-weight:600;letter-spacing:.2px}
  .anstag.kb{background:#0f3320;color:#63dc95;border:1px solid #2c6b45}
  .anstag.kbai{background:#2b2410;color:#e6c463;border:1px solid #5f4c1c}
  .anstag.ai{background:#16213a;color:#8fb4ea;border:1px solid #2b3d5c}
  .anstag.cache{background:#22252b;color:#9aa6b4;border:1px solid #363b44}
  .anstag.page{background:#2a1f33;color:#c9a6e8;border:1px solid #4a3560}
  .anstag.miss{background:#3a2018;color:#f0a37a;border:1px solid #6b3a24}
  .anstext{margin-top:4px;font-size:11.5px;color:#9fb2c8;line-height:1.5;white-space:pre-wrap;display:none;
    border-left:2px solid #2c5c3a;padding-left:7px}
  .drawer{display:none;padding:10px 10px 12px;border-bottom:1px solid #222b38;background:#0d131b}
  .drawer.on{display:block}
  .drawer .frow{margin-bottom:7px}
  .drawer label{display:block;font-size:10.5px;color:#7d8ea3;margin-bottom:3px}
  .drawer input[type=text],.drawer input[type=password],.drawer input[type=number]{
    width:100%;background:#080d13;border:1px solid #232d3b;border-radius:6px;color:#e6edf3;
    padding:5px 8px;font:11.5px/1.5 inherit;outline:none;font-family:inherit}
  .drawer input:focus{border-color:#1f6feb}
  .drawer .two{display:flex;gap:8px}
  .drawer .two > div{flex:1}
  .chk{display:flex;align-items:center;gap:6px;font-size:11.5px;color:#a8b7c8;margin:5px 0;cursor:pointer}
  .chk input{accent-color:#1f6feb;width:13px;height:13px;margin:0}
  .drawer-acts{display:flex;gap:6px;margin-top:8px}
  .auto-badge{font-size:10.5px;color:#ffd479;border:1px solid #5c4a1e;background:#241d0f;
    border-radius:5px;padding:1px 6px;white-space:nowrap}
  .ansedit{flex:1;min-width:0;background:#0a0f16;border:1px solid #2b3646;border-radius:6px;
    color:#e6edf3;font:12.5px/1.5 inherit;padding:4px 7px;display:none;font-family:inherit}
  .srcmeta{font-size:10.5px;color:#6d7f95}
  .refs{margin-top:5px}
  .refs summary{cursor:pointer;font-size:10.5px;color:#6d7f95;outline:none}
  .refs summary:hover{color:#c9d4e2}
  .reflist{margin-top:5px;display:flex;flex-direction:column;gap:5px}
  .ref{border-left:2px solid #2c5c3a;padding:2px 0 2px 7px;font-size:11px;color:#a8b7c8}
  .ref .rq{color:#c9d4e2;display:block;margin-bottom:2px}
  .ref .ra{color:#7ee787;display:block}
  .ref .rd{color:#63788f;font-size:10px;display:block;margin-top:2px}
  .think{margin-top:6px;border-top:1px dashed #28323f;padding-top:5px}
  .think summary{cursor:pointer;font-size:11px;color:#8b98a9;outline:none}
  .think summary:hover{color:#c9d4e2}
  .think pre{margin:5px 0 0;white-space:pre-wrap;word-break:break-word;font-size:11px;color:#93a4b8;
    max-height:220px;overflow:auto;font-family:ui-monospace,Consolas,monospace;line-height:1.5}
  .acts{margin-top:7px;display:flex;gap:6px}
  .acts .btn{padding:4px 9px;font-size:11.5px}
  footer{display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border-top:1px solid #222b38;
    font-size:10.5px;color:#5f7086;background:#0b0f16}
  .fab{position:fixed;top:72px;right:18px;z-index:2147483600;width:46px;height:46px;border-radius:50%;
    background:#1f6feb;color:#fff;display:grid;place-items:center;cursor:pointer;font-size:18px;font-weight:700;
    box-shadow:0 8px 24px #1f6feb66;border:none}
  .fab:hover{background:#2b7bf5}
  .toast{position:fixed;bottom:26px;right:24px;z-index:2147483601;background:#16202c;color:#dfe8f2;
    border:1px solid #2b3644;border-radius:9px;padding:8px 12px;font-size:12px;opacity:0;transform:translateY(6px);
    transition:.2s;pointer-events:none;max-width:360px}
  .toast.show{opacity:1;transform:none}
  `;

  function ensure() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:' + (2147483600 + Math.floor(Math.random() * 500)) + '';
    root = host.attachShadow({ mode: 'closed' });

    const html = `
      <style>${CSS}    .audit-sum{padding:8px 10px;font-size:12px;color:#c9d4e2;border-bottom:1px solid #22303f}
    .audit-sum b{color:#3fb950}
    .audit-row{padding:7px 10px;border-bottom:1px solid #1b2430}
    .audit-head{display:flex;gap:7px;align-items:center;font-size:12px;color:#dbe6f2}
    .audit-i{color:#6b7688;min-width:16px}
    .audit-stem{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .audit-sub{font-size:11px;color:#7d8ea3;margin:3px 0 0 22px}
    .audit-sub.warn{color:#d29922}
</style>
      <div class="wrap off" part="wrap">
        <header>
          <span class="dot"></span>
          <span class="title">考试辅助</span>
          <span class="stat" data-ref="stat">未识别</span>
          <span class="auto-badge" data-ref="autoBadge" style="display:none">自动中</span>
          <span class="grow"></span>
          <button class="icon" data-act="settings" title="面板内设置（不跳转）">⚙</button>
          <button class="icon" data-act="minimize" title="收起">—</button>
          <button class="icon" data-act="close" title="关闭面板">✕</button>
        </header>
        <div class="drawer" data-ref="drawer">
          <div class="frow"><label>模型</label><input type="text" data-k="model" spellcheck="false" /></div>
          <div class="frow"><label>Base URL</label><input type="text" data-k="baseUrl" spellcheck="false" /></div>
          <div class="frow"><label>API Key</label><input type="password" data-k="apiKey" spellcheck="false" /></div>
          <div class="two">
            <div class="frow"><label>自动作答间隔（秒）</label><input type="number" data-k="autoInterval" min="3" max="120" step="1" /></div>
            <div class="frow"><label>每轮最多（题）</label><input type="number" data-k="autoLimit" min="1" max="200" step="1" /></div>
          </div>
          <label class="chk"><input type="checkbox" data-k="followMode" /> 跟随模式（翻到新题自动作答当前题）</label>
          <label class="chk"><input type="checkbox" data-k="autoNext" /> 自动连做时自动点「下一题」</label>
          <label class="chk"><input type="checkbox" data-k="stealth" /> 隐身模式（关闭面板时从页面彻底移除）</label>
          <div class="drawer-acts">
            <button class="btn primary" data-act="save-settings">保存</button>
            <button class="btn ghost" data-act="open-options">高级设置…</button>
          </div>
        </div>
        <div class="toolbar">
          <button class="btn primary" data-act="extract">识别本页</button>
          <button class="btn" data-act="auto">自动连做</button>
          <button class="btn ghost" data-act="undo">撤销填涂</button>
          <button class="btn ghost" data-act="image" title="题目是图片时用它：识别图中题干和选项">识别图片题</button>
          <button class="btn ghost" data-act="audit" title="逐题检查知识库匹配情况">库体检</button>
          <button class="btn ghost" data-act="export">导出</button>
          <button class="btn ghost" data-act="clear">清空</button>
        </div>
        <div class="list" data-ref="list">
          <div class="empty">点击「识别本页」抓取题目<br>快捷键 Alt+Shift+Q 开关面板</div>
        </div>
        <footer>
          <span data-ref="meta">未配置模型</span>
          <span data-ref="status">就绪</span>
        </footer>
      </div>
      <button class="fab" data-act="restore" style="display:none" title="展开面板">考</button>
      <div class="toast" data-ref="toast"></div>
    `;
    root.innerHTML = html;

    refs.wrap = root.querySelector('.wrap');
    refs.fab = root.querySelector('.fab');
    refs.list = root.querySelector('[data-ref="list"]');
    refs.stat = root.querySelector('[data-ref="stat"]');
    refs.meta = root.querySelector('[data-ref="meta"]');
    refs.status = root.querySelector('[data-ref="status"]');
    refs.toast = root.querySelector('[data-ref="toast"]');
    refs.drawer = root.querySelector('[data-ref="drawer"]');
    refs.autoBadge = root.querySelector('[data-ref="autoBadge"]');
    refs.dot = root.querySelector('.dot');

    root.addEventListener('click', onShadowClick, true);
    enableDrag(root.querySelector('header'));
    (document.documentElement || document.body).appendChild(host);
  }

  function onShadowClick(e) {
    const btn = e.target.closest && e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    const card = btn.closest('.card');
    const payload = { action: act, index: card ? Number(card.getAttribute('data-idx')) : null, el: btn };
    if (act === 'minimize') { collapsed = true; refs.wrap.classList.add('off'); refs.fab.style.display = 'grid'; return; }
    if (act === 'restore') { collapsed = false; refs.fab.style.display = 'none'; refs.wrap.classList.remove('off'); return; }
    if (act === 'close') { emit({ action: 'close' }); return; }
    if (act === 'settings') {
      refs.drawer.classList.toggle('on');
      if (refs.drawer.classList.contains('on')) emit({ action: 'drawer-open' });
      return;
    }
    if (act === 'save-settings') { emit({ action: 'save-settings', values: readDrawer() }); return; }
    if (act === 'open-options') { emit({ action: 'open-options' }); return; }
    emit(payload);
  }

  const DRAWER_KEYS = ['model', 'baseUrl', 'apiKey', 'autoInterval', 'autoLimit', 'followMode', 'autoNext', 'stealth'];

  function fillDrawer(values) {
    ensure();
    DRAWER_KEYS.forEach(k => {
      const el = root.querySelector('[data-k="' + k + '"]');
      if (!el) return;
      const v = values ? values[k] : undefined;
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v == null ? '' : v;
    });
  }

  function readDrawer() {
    const out = {};
    DRAWER_KEYS.forEach(k => {
      const el = root.querySelector('[data-k="' + k + '"]');
      if (!el) return;
      out[k] = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? Number(el.value) : el.value.trim());
    });
    return out;
  }

  function closeDrawer() { if (refs.drawer) refs.drawer.classList.remove('on'); }

  function setAuto(running, text) {
    ensure();
    if (refs.autoBadge) {
      refs.autoBadge.style.display = running ? 'inline-block' : 'none';
      if (text) refs.autoBadge.textContent = text;
    }
    const btn = root.querySelector('[data-act="auto"]');
    if (btn) btn.textContent = running ? '停止自动' : '自动作答';
  }

  /**
   * 填入答案后闪一个 1~2 秒的浮层，写明来源与可信度。
   * 用独立的临时宿主，用完立即移除——隐身模式下也不会在页面留下残留节点。
   */
  let lastFlash = null;

  function lastFlashInfo() { return lastFlash; }

  function flash(text, kind, ms, anchorRect) {
    const dur = ms == null ? 1500 : Number(ms);
    if (!dur || !text) return;
    lastFlash = { text: text, kind: kind, at: Date.now() };
    let hostEl = null;
    try {
      hostEl = document.createElement("div");
      hostEl.style.cssText = "all:initial;position:fixed;right:0;bottom:0;z-index:2147483647";
      const sh = hostEl.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = `
        .f{position:fixed;right:18px;bottom:22px;max-width:min(72vw,420px);
          padding:9px 15px;border-radius:10px;font:600 13px/1.45 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
          background:#0f3320;color:#63dc95;border:1px solid #2c6b45;
          box-shadow:0 8px 26px rgba(0,0,0,.30);opacity:0;transform:translateY(8px);
          transition:opacity .22s ease,transform .22s ease;pointer-events:none;white-space:nowrap}
        .f.on{opacity:1;transform:translateY(0)}
        .f.t-kbai{background:#2b2410;color:#e6c463;border-color:#5f4c1c}
        .f.t-ai{background:#16213a;color:#8fb4ea;border-color:#2b3d5c}
        .f.t-miss{background:#3a2018;color:#f0a37a;border-color:#6b3a24}
        .f.t-cache{background:#22252b;color:#9aa6b4;border-color:#363b44}
        .f.t-page{background:#2a1f33;color:#c9a6e8;border-color:#4a3560}
      `;
      const box = document.createElement("div");
      box.className = "f t-" + (kind || "kb");
      box.textContent = text;
      // 贴到题目上方居中显示；但题目滚出视口时标记会跑到屏幕外，必须夹回可视区域
      if (anchorRect && anchorRect.width > 0) {
        const vh = window.innerHeight || 800;
        const vw = window.innerWidth || 1200;
        const inView = anchorRect.top < vh - 40 && anchorRect.bottom > 40;
        if (inView) {
          const top = Math.min(vh - 56, Math.max(8, anchorRect.top - 46));
          const left = Math.min(vw - 20, Math.max(20, anchorRect.left + anchorRect.width / 2));
          box.style.top = top + "px";
          box.style.left = left + "px";
          box.style.right = "auto";
          box.style.bottom = "auto";
          box.style.transform = "translate(-50%, 8px)";
          box.style.transition = "opacity .2s ease, transform .2s ease";
          box.dataset.anchor = "1";
        }
        // 不在视口内：保持默认的右下角固定位置，保证一定看得见
      }
      sh.appendChild(style);
      sh.appendChild(box);
      document.documentElement.appendChild(hostEl);
      requestAnimationFrame(() => {
        box.classList.add("on");
        if (box.dataset.anchor) box.style.transform = "translate(-50%, 0)";
      });
      setTimeout(() => {
        box.classList.remove("on");
        if (box.dataset.anchor) box.style.transform = "translate(-50%, -6px)";
        setTimeout(() => { try { hostEl.remove(); } catch (e) { } }, 320);
      }, dur);
    } catch (e) {
      try { if (hostEl) hostEl.remove(); } catch (e2) { }
    }
  }

  function toolbarLabels() {
    if (!root) return [];
    return Array.from(root.querySelectorAll('.toolbar [data-act]')).map(b => (b.textContent || '').trim());
  }

  function ansTagOf(index) {
    const c = cards.get(index);
    if (!c || !c.ansTag) return null;
    return c.ansTag.style.display === 'none' ? '' : c.ansTag.textContent;
  }

  function isMounted() { return !!(host && host.isConnected); }

  function unmount() {
    if (host) { try { host.remove(); } catch (e) { } }
    host = null; root = null; visible = false;
  }

  function enableDrag(handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      dragging = true;
      const r = refs.wrap.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      handle.setPointerCapture && handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
      if (!dragging) return;
      const w = refs.wrap.offsetWidth, h = refs.wrap.offsetHeight;
      const nx = Math.min(Math.max(0, ox + e.clientX - sx), window.innerWidth - Math.min(w, window.innerWidth));
      const ny = Math.min(Math.max(0, oy + e.clientY - sy), window.innerHeight - 60);
      refs.wrap.style.left = nx + 'px';
      refs.wrap.style.top = ny + 'px';
      refs.wrap.style.right = 'auto';
    });
    handle.addEventListener('pointerup', () => { dragging = false; });
  }

  function emit(payload) {
    listeners.forEach(fn => { try { fn(payload); } catch (e) { } });
  }

  /* ---------- 对外 API ---------- */

  function on(fn) { listeners.push(fn); }

  function show() {
    ensure();
    visible = true;
    collapsed = false;
    refs.wrap.classList.remove('off');
    refs.fab.style.display = 'none';
  }

  function hide(removeHost) {
    visible = false;
    if (refs.wrap) refs.wrap.classList.add('off');
    if (refs.fab) refs.fab.style.display = 'none';
    if (removeHost && host) {
      try { host.remove(); } catch (e) { }
      host = null; root = null;   // 下次 show() 重新创建，页面上不留任何痕迹
    }
  }

  function toggle() {
    ensure();
    if (visible) hide(); else show();
  }

  function isVisible() { return visible; }

  function status(text, level) {
    ensure();
    if (refs.status) refs.status.textContent = text;
    if (refs.dot) {
      refs.dot.className = 'dot' + (level === 'busy' ? ' busy' : level === 'err' ? ' err' : '');
    }
  }

  function meta(text) { ensure(); if (refs.meta) refs.meta.textContent = text; }

  function stat(text) { ensure(); if (refs.stat) refs.stat.textContent = text; }

  let toastTimer = 0;
  function toast(text, ms) {
    ensure();
    refs.toast.textContent = text;
    refs.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => refs.toast.classList.remove('show'), ms || 2600);
  }

  function clear() {
    ensure();
    cards.clear();
    refs.list.innerHTML = '<div class="empty">点击「识别本页」抓取题目<br>选中页面文字后识别可只解选中内容</div>';
    stat('未识别');
  }


  /** 库体检结果：直接替换列表区，命中/未命中一目了然 */
  function renderAudit(rows, sum) {
    ensure();
    cards.clear();
    const badge = m => m === 'kb' ? '<span class="anstag kb">命中</span>'
      : m === 'kb+ai' ? '<span class="anstag kbai">库+AI</span>'
        : '<span class="anstag ai">未命中</span>';
    refs.list.innerHTML =
      '<div class="audit-sum">共 ' + sum.total + ' 题 · 直接命中 <b>' + sum.hit +
      '</b> · 库+AI ' + sum.kbai + ' · 未命中 <b>' + sum.miss + '</b></div>' +
      rows.map((r, i) =>
        '<div class="audit-row">' +
        '<div class="audit-head">' + badge(r.mode) +
        '<span class="audit-i">' + (i + 1) + '</span>' +
        '<span class="audit-stem">' + esc(r.stem) + '</span></div>' +
        (r.mode === 'kb'
          ? '<div class="audit-sub">库答案 ' + esc(r.answer || '-') + '</div>'
          : '<div class="audit-sub warn">库最像：' + esc(r.topQ || '无') +
          (r.topA ? ' → ' + esc(r.topA) : '') + '</div>') +
        '</div>'
      ).join('');
    stat('体检 ' + sum.total + ' 题');
  }

  function renderList(questions) {
    ensure();
    cards.clear();
    if (!questions || !questions.length) {
      clear();
      return;
    }
    const frag = document.createDocumentFragment();
    questions.forEach(q => frag.appendChild(createCard(q)));
    refs.list.innerHTML = '';
    refs.list.appendChild(frag);
    stat(questions.length + ' 题');
  }

  function createCard(q) {
    const el = document.createElement('div');
    el.className = 'card';
    el.setAttribute('data-idx', String(q.index));

    const head = document.createElement('div');
    head.className = 'chead';
    const lowConf = (typeof q.score === 'number' && q.score < 0.7)
      ? '<span class="badge score-low">识别存疑</span>' : '';
    head.innerHTML =
      `<span class="n">${q.index + 1}</span>` +
      `<span class="kind ${q.kind}">${KIND_TEXT[q.kind] || q.kind}</span>` +
      `<span class="src">${q.source || ''}${q.blanks ? ' · ' + q.blanks + '空' : ''}</span>` +
      lowConf +
      `<span class="state">待解</span>`;

    const stem = document.createElement('div');
    stem.className = 'stem';
    stem.textContent = q.stem.length > 600 ? q.stem.slice(0, 600) + ' …' : q.stem;

    el.appendChild(head);
    el.appendChild(stem);

    if (q.options && q.options.length) {
      const opts = document.createElement('div');
      opts.className = 'opts';
      q.options.forEach(o => {
        const d = document.createElement('div');
        d.className = 'opt';
        const b = document.createElement('b');
        b.textContent = o.label;
        const s = document.createElement('span');
        s.textContent = o.text;
        d.appendChild(b); d.appendChild(s);
        opts.appendChild(d);
      });
      el.appendChild(opts);
    }

    const ans = document.createElement('div');
    ans.className = 'ans';
    ans.style.display = 'none';
    ans.innerHTML = '<span class="lb">答案</span><span class="val"></span><span class="anstag" style="display:none"></span><span class="conf"></span>';
    const ansEdit = document.createElement('input');
    ansEdit.className = 'ansedit';
    ansEdit.setAttribute('spellcheck', 'false');
    ans.appendChild(ansEdit);
    el.appendChild(ans);

    const ansText = document.createElement('div');
    ansText.className = 'anstext';
    el.appendChild(ansText);

    const warnBox = document.createElement('div');
    warnBox.className = 'warnbox';
    warnBox.style.display = 'none';
    el.appendChild(warnBox);

    const srcRow = document.createElement('div');
    srcRow.className = 'srcrow';
    srcRow.style.display = 'none';
    el.appendChild(srcRow);

    const refsBox = document.createElement('details');
    refsBox.className = 'refs';
    refsBox.style.display = 'none';
    const refsSummary = document.createElement('summary');
    refsSummary.textContent = '知识库出处';
    const refsList = document.createElement('div');
    refsList.className = 'reflist';
    refsBox.appendChild(refsSummary);
    refsBox.appendChild(refsList);
    el.appendChild(refsBox);

    const think = document.createElement('details');
    think.className = 'think';
    think.style.display = 'none';
    think.innerHTML = '<summary>思考过程</summary><pre></pre>';
    el.appendChild(think);

    const acts = document.createElement('div');
    acts.className = 'acts';
    acts.innerHTML =
      '<button class="btn" data-act="solve">解题</button>' +
      '<button class="btn" data-act="fill" disabled>填入</button>' +
      '<button class="btn ghost" data-act="copy" disabled>复制</button>' +
      '<button class="btn ghost" data-act="save-kb" disabled>存库</button>' +
      '<button class="btn ghost" data-act="edit" disabled>改</button>';
    el.appendChild(acts);

    cards.set(q.index, {
      el,
      state: head.querySelector('.state'),
      ansWrap: ans,
      ansVal: ans.querySelector('.val'),
      ansEdit,
      ansText,
      ansTag: ans.querySelector('.anstag'),
      options: q.options || [],
      conf: ans.querySelector('.conf'),
      warnBox,
      editing: false,
      srcRow,
      refsBox,
      refsSummary,
      refsList,
      think,
      thinkPre: think.querySelector('pre'),
      solveBtn: acts.querySelector('[data-act="solve"]'),
      fillBtn: acts.querySelector('[data-act="fill"]'),
      copyBtn: acts.querySelector('[data-act="copy"]'),
      saveKbBtn: acts.querySelector('[data-act="save-kb"]'),
      editBtn: acts.querySelector('[data-act="edit"]')
    });
    return el;
  }

  function setState(index, text, cls) {
    const c = cards.get(index);
    if (!c) return;
    c.state.textContent = text;
    c.state.className = 'state' + (cls ? ' ' + cls : '');
  }

  function setCardClass(index, cls) {
    const c = cards.get(index);
    if (!c) return;
    c.el.classList.remove('done', 'err', 'working');
    if (cls) c.el.classList.add(cls);
  }

  function appendThinking(index, chunk) {
    const c = cards.get(index);
    if (!c || !chunk) return;
    c.think.style.display = 'block';
    if (!c.think.open) c.think.open = true;
    c.thinkPre.textContent = (c.thinkPre.textContent || '') + chunk;
    c.thinkPre.scrollTop = c.thinkPre.scrollHeight;
  }

  function setThinkingText(index, text) {
    const c = cards.get(index);
    if (!c) return;
    c.think.style.display = text ? 'block' : 'none';
    if (text != null) c.thinkPre.textContent = text;
  }

  const SRC_STYLE = {
    kb: { text: '知识库', cls: 'kb' },
    'kb+ai': { text: '知识库 + AI', cls: 'mix' },
    ai: { text: 'AI 生成', cls: 'ai' },
    cache: { text: '缓存答案', cls: 'cache' },
    page: { text: '页面已有答案', cls: 'page' }
  };

  const ANS_TAG = {
    kb: { cls: 'kb', text: '知识库' },
    'kb+ai': { cls: 'kbai', text: '知识库+AI' },
    ai: { cls: 'ai', text: 'AI 生成' },
    cache: { cls: 'cache', text: '缓存' },
    page: { cls: 'page', text: '页面答案' },
    manual: { cls: 'cache', text: '手动' },
    miss: { cls: 'miss', text: '知识库未收录' }
  };

  /** 答案右侧直接标出来源，一眼知道是不是题库 */
  function renderAnsTag(c, source, ms) {
    if (!c.ansTag) return;
    const kind = source && source.kind;
    const meta = ANS_TAG[kind];
    if (!meta) { c.ansTag.style.display = 'none'; return; }
    const hits = (source && Array.isArray(source.hits)) ? source.hits : [];
    const exact = hits.length && hits[0] && hits[0].exact;
    c.ansTag.className = 'anstag ' + meta.cls;
    let base = kind === 'kb' ? (exact ? '知识库 · 精确' : '知识库') : meta.text;
    // 纯 AI 且库里有相近条目时，直接标出相似度：一眼看出是"题库没有"还是"题干对不上"
    if (kind === 'ai' && source && source.nearMiss && source.nearMiss.sim != null) {
      base = 'AI 生成 · 库最像 ' + Math.round(source.nearMiss.sim * 100) + '%';
    } else if (kind === 'ai') {
      base = 'AI 生成 · 库无相近条目';
    }
    // 带上耗时：知识库命中通常是几十毫秒，AI 通常是几秒，一眼能分辨
    c.ansTag.textContent = base + (typeof ms === 'number' && ms >= 0 ? ' · ' + ms + ' ms' : '');
    c.ansTag.style.display = 'inline-block';
    c.ansTag.title = (kind === 'ai' && source && source.nearMiss && source.nearMiss.q)
      ? '知识库没有匹配上，由模型作答。库里最接近的是：' + source.nearMiss.q
      : kind === 'kb'
      ? '答案直接取自知识库条目，未经过模型'
      : kind === 'kb+ai'
        ? '知识库命中但不够确定，由模型结合条目作答'
        : '';
  }

  function renderSource(c, source) {
    if (!c.srcRow) return;
    if (!source || !source.kind) { c.srcRow.style.display = 'none'; c.refsBox.style.display = 'none'; return; }

    const meta = SRC_STYLE[source.kind] || { text: source.kind, cls: 'ai' };
    c.srcRow.textContent = '';
    c.srcRow.style.display = 'flex';

    const badge = document.createElement('span');
    badge.className = 'badge ' + meta.cls;
    badge.textContent = meta.text;
    c.srcRow.appendChild(badge);

    const hits = Array.isArray(source.hits) ? source.hits : [];
    if (hits.length) {
      const m = document.createElement('span');
      m.className = 'srcmeta';
      m.textContent = `${hits.length} 条命中` + (hits[0].exact ? ' · 题干精确' : ` · 相关度 ${Math.round((hits[0].coverage || 0) * 100)}%`);
      c.srcRow.appendChild(m);
    }

    if (!hits.length) { c.refsBox.style.display = 'none'; return; }

    c.refsBox.style.display = 'block';
    c.refsSummary.textContent = `知识库出处 · ${hits.length} 条（${hits[0].docName}${hits.length > 1 ? ' 等' : ''}）`;
    c.refsList.textContent = '';
    hits.forEach(h => {
      const box = document.createElement('div');
      box.className = 'ref';
      const q = document.createElement('span');
      q.className = 'rq';
      q.textContent = h.question || '';
      const a = document.createElement('span');
      a.className = 'ra';
      a.textContent = '答：' + (h.answer || '');
      const d = document.createElement('span');
      d.className = 'rd';
      d.textContent = `${h.docName}${h.exact ? ' · 精确匹配' : ' · 相关度 ' + Math.round((h.coverage || 0) * 100) + '%'}`;
      box.appendChild(q);
      box.appendChild(a);
      box.appendChild(d);
      c.refsList.appendChild(box);
    });
  }

  function setAnswer(index, data) {
    const c = cards.get(index);
    if (!c) return;
    if (data.reasoning) {
      c.think.style.display = 'block';
      c.thinkPre.textContent = data.reasoning;
    }
    if (c.editing) setEditing(index, false);
    c.ansWrap.style.display = 'flex';
    c.ansVal.textContent = data.answer || '（空）';
    renderAnsTag(c, data.source, data.__ms);
    const conf = typeof data.confidence === 'number' ? data.confidence : null;
    c.conf.textContent = conf == null ? '' : ('置信 ' + Math.round(conf * 100) + '%');
    renderAnswerText(c, data);
    renderSource(c, data.source);

    if (data.warn) {
      c.warnBox.style.display = 'block';
      c.warnBox.textContent = '⚠ ' + data.warn;
    } else {
      c.warnBox.style.display = 'none';
    }

    c.fillBtn.disabled = false;
    c.copyBtn.disabled = false;
    c.saveKbBtn.disabled = false;
    c.editBtn.disabled = false;
    c.solveBtn.textContent = '重解';
  }

  /** 在答案下面把选中的选项原文列出来，方便对着看 */
  function renderAnswerText(c, data) {
    if (!c.ansText) return;
    const opts = c.options || [];
    const answer = String(data.answer || '');
    if (!opts.length || !answer) { c.ansText.style.display = 'none'; return; }

    const isChoice = ['single', 'multi', 'judge'].includes(data.kind);
    if (!isChoice) { c.ansText.style.display = 'none'; return; }

    const letters = Array.from(new Set((answer.toUpperCase().match(/[A-H]/g) || [])));
    const lines = letters
      .map(l => {
        const o = opts.find(x => x.label === l);
        return o ? l + '. ' + o.text : '';
      })
      .filter(Boolean);

    // 判断题给的是「对/错」，按文本反查对应选项
    if (!lines.length) {
      const a = answer.replace(/[。.\s，,]/g, '');
      if (a) {
        const hit = opts.find(x => {
          const t = String(x.text || '').replace(/[。.\s，,]/g, '');
          return t && (t.includes(a) || a.includes(t));
        });
        if (hit) lines.push(hit.label + '. ' + hit.text);
      }
    }

    if (!lines.length) { c.ansText.style.display = 'none'; return; }
    c.ansText.textContent = lines.join('\n');
    c.ansText.style.display = 'block';
  }

  function setEditing(index, on) {
    const c = cards.get(index);
    if (!c) return false;
    c.editing = !!on;
    if (on) {
      c.ansEdit.value = c.ansVal.textContent === '（空）' ? '' : c.ansVal.textContent;
      c.ansEdit.style.display = 'block';
      c.ansVal.style.display = 'none';
      c.editBtn.textContent = '保存';
      try { c.ansEdit.focus(); c.ansEdit.select(); } catch (e) { }
    } else {
      c.ansEdit.style.display = 'none';
      c.ansVal.style.display = '';
      c.editBtn.textContent = '改';
    }
    return c.editing;
  }

  function isEditing(index) {
    const c = cards.get(index);
    return !!(c && c.editing);
  }

  function getEditValue(index) {
    const c = cards.get(index);
    return c && c.ansEdit ? c.ansEdit.value.trim() : '';
  }

  function setWarn(index, text) {
    const c = cards.get(index);
    if (!c) return;
    c.warnBox.style.display = text ? 'block' : 'none';
    c.warnBox.textContent = text ? '⚠ ' + text : '';
  }

  function setFilled(index, ok, detail) {
    const c = cards.get(index);
    if (!c) return;
    c.fillBtn.textContent = ok ? '已填' : '填入';
    if (ok) c.fillBtn.disabled = true;
    if (detail) c.fillBtn.title = detail;
  }

  function markAll(disabled) {
    cards.forEach(c => {
      c.solveBtn.disabled = disabled;
    });
  }

  return {
    ensure, show, hide, toggle, isVisible, status, meta, stat, toast,
    renderList, clear, on,
    setState, setCardClass, appendThinking, setThinkingText, setAnswer, setFilled, markAll,
    setEditing, isEditing, getEditValue, setWarn,
    renderAudit,
    fillDrawer, readDrawer, closeDrawer, setAuto, isMounted, unmount, toolbarLabels, ansTagOf, flash, lastFlashInfo
  };
})();
