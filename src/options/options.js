/* 设置页逻辑 */
const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  ocrEngine: 'auto',
  ocrDocImages: true,
  autoSaveAnswers: true,
  visionModel: '',
  temperature: 0.2,
  maxTokens: 2048,
  timeoutSec: 90,
  doubleCheck: false,
  autoFillAfterSolve: false,
  extraHeaders: '',
  systemPrompt: '',
  kbEnabled: true,
  kbDirect: true,
  cacheEnabled: true,
  cacheTtlDays: 7,
  skipAnswered: true,
  concurrency: 2
};

const PRESETS = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', visionModel: 'gpt-4o' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', visionModel: '' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k', visionModel: 'moonshot-v1-8k-vision-preview' },
  dashscope: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', visionModel: 'qwen-vl-plus' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', visionModel: 'glm-4v-plus' },
  siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-72B-Instruct', visionModel: '' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:14b', visionModel: 'llava' },
  custom: {}
};

const $ = id => document.getElementById(id);

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + (cls || '');
}

function normalizeEndpoint(base) {
  let b = String(base || '').trim().replace(/\s/g, '').replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v\d+$/.test(b) || /\/api\/paas\/v\d+$/.test(b)) return b + '/chat/completions';
  return b + '/chat/completions';
}

function fill(s) {
  $('baseUrl').value = s.baseUrl || '';
  $('apiKey').value = s.apiKey || '';
  $('model').value = s.model || '';
  $('visionModel').value = s.visionModel || '';
  if ($('ocrEngine')) $('ocrEngine').value = s.ocrEngine || 'auto';
  if ($('ocrDocImages')) $('ocrDocImages').checked = s.ocrDocImages !== false;
  if ($('autoSaveAnswers')) $('autoSaveAnswers').checked = s.autoSaveAnswers !== false;
  $('temperature').value = s.temperature ?? 0.2;
  $('maxTokens').value = s.maxTokens ?? 2048;
  $('timeoutSec').value = s.timeoutSec ?? 90;
  $('doubleCheck').checked = !!s.doubleCheck;
  $('autoFillAfterSolve').checked = !!s.autoFillAfterSolve;
  $('extraHeaders').value = s.extraHeaders || '';
  $('systemPrompt').value = s.systemPrompt || '';
  $('kbEnabled').checked = s.kbEnabled !== false;
  $('kbDirect').checked = s.kbDirect !== false;
  $('cacheEnabled').checked = s.cacheEnabled !== false;
  $('skipAnswered').checked = s.skipAnswered !== false;
  $('followMode').checked = s.followMode !== false;
  $('kbStrict').checked = s.kbStrict === true;
  $('siteAllow').value = s.siteAllow || '';
  if ($('kbAiExpand')) $('kbAiExpand').checked = s.kbAiExpand !== false;
  $('flashOn').checked = s.flashOn !== false;
  $('flashMs').value = Number(s.flashMs) || 1500;
  $('flashMs').disabled = s.flashOn === false;
  $('stealth').checked = s.stealth !== false;
  $('autoNext').checked = s.autoNext === true;
  $('concurrency').value = s.concurrency || 2;
}

function collect() {
  return {
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    visionModel: $('visionModel').value.trim(),
    ocrEngine: $('ocrEngine') ? $('ocrEngine').value : 'auto',
    ocrDocImages: $('ocrDocImages') ? $('ocrDocImages').checked : true,
    autoSaveAnswers: $('autoSaveAnswers') ? $('autoSaveAnswers').checked : true,
    temperature: Number($('temperature').value) || 0.2,
    maxTokens: Number($('maxTokens').value) || 2048,
    timeoutSec: Number($('timeoutSec').value) || 90,
    doubleCheck: $('doubleCheck').checked,
    autoFillAfterSolve: $('autoFillAfterSolve').checked,
    extraHeaders: $('extraHeaders').value.trim(),
    systemPrompt: $('systemPrompt').value.trim(),
    kbEnabled: $('kbEnabled').checked,
    kbDirect: $('kbDirect').checked,
    cacheEnabled: $('cacheEnabled').checked,
    skipAnswered: $('skipAnswered').checked,
    followMode: $('followMode').checked,
    kbStrict: $('kbStrict').checked,
    siteAllow: ($('siteAllow').value || '').trim(),
    kbAiExpand: $('kbAiExpand') ? $('kbAiExpand').checked : true,
    flashOn: $('flashOn').checked,
    flashMs: Number($('flashMs').value) || 1500,
    stealth: $('stealth').checked,
    autoNext: $('autoNext').checked,
    concurrency: Math.max(1, Math.min(4, Number($('concurrency').value) || 2))
  };
}

function guessPreset(baseUrl) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  for (const [k, v] of Object.entries(PRESETS)) {
    if (v.baseUrl && v.baseUrl.replace(/\/+$/, '') === b) return k;
  }
  return b ? 'custom' : 'openai';
}

async function load() {
  const raw = await chrome.storage.local.get('settings');
  const s = Object.assign({}, DEFAULTS, raw.settings || {});
  fill(s);
  $('preset').value = guessPreset(s.baseUrl);
}

async function save() {
  const s = collect();
  if (!s.baseUrl) return setStatus('Base URL 不能为空', 'bad');
  if (!s.model) return setStatus('模型名不能为空', 'bad');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'saveSettings', settings: s });
    if (!res || !res.ok) await chrome.storage.local.set({ settings: s });
  } catch (e) {
    await chrome.storage.local.set({ settings: s });
  }
  setStatus('已保存 ✓ ' + new Date().toLocaleTimeString(), 'ok');
}

function parseHeaders(raw) {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    const out = {};
    Object.keys(o).forEach(k => { if (typeof o[k] === 'string') out[k] = o[k]; });
    return out;
  } catch (e) { return null; }
}

async function test() {
  const s = collect();
  if (!s.baseUrl) return setStatus('先填 Base URL', 'bad');
  const extra = parseHeaders(s.extraHeaders);
  if (extra === null) return setStatus('额外请求头不是合法 JSON', 'bad');
  setStatus('测试中…', 'warn');

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.min(45, s.timeoutSec) * 1000);
  const t0 = Date.now();
  try {
    const res = await fetch(normalizeEndpoint(s.baseUrl), {
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json'
      }, s.apiKey ? { Authorization: 'Bearer ' + s.apiKey } : {}, extra),
      body: JSON.stringify({
        model: s.model,
        messages: [
          { role: 'system', content: '你是连接测试助手，只输出 JSON。' },
          { role: 'user', content: '回复 {"ok":true,"msg":"pong"}' }
        ],
        temperature: 0,
        max_tokens: 64
      }),
      signal: ctrl.signal
    });
    const txt = await res.text();
    const ms = Date.now() - t0;
    if (!res.ok) {
      setStatus(`连接失败 ${res.status}（${ms}ms）：` + txt.slice(0, 220), 'bad');
      return;
    }
    let preview = txt.slice(0, 160);
    try {
      const j = JSON.parse(txt);
      preview = (j.choices && j.choices[0] && (j.choices[0].message || {}).content) || j.message || preview;
    } catch (e) { }
    setStatus(`连接正常 ✓ ${ms}ms｜${String(preview).replace(/\s+/g, ' ').slice(0, 90)}`, 'ok');
  } catch (e) {
    setStatus('连接异常：' + (e && e.name === 'AbortError' ? '请求超时' : (e.message || e)), 'bad');
  } finally {
    clearTimeout(t);
  }
}


/* ---------------- 知识库目录绑定（File System Access API） ---------------- */
/* 浏览器不允许扩展直接读绝对路径，必须先由用户手动选一次目录并授权；
   句柄存在 IndexedDB，之后打开设置页就能自动整理。 */
const FS_DB = 'exa-fs';
const FS_STORE = 'handles';

function openFsDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FS_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FS_STORE)) db.createObjectStore(FS_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function fsGet(key) {
  const db = await openFsDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FS_STORE, 'readonly');
    const rq = tx.objectStore(FS_STORE).get(key);
    rq.onsuccess = () => resolve(rq.result || null);
    rq.onerror = () => reject(rq.error);
  });
}

async function fsSet(key, val) {
  const db = await openFsDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FS_STORE, 'readwrite');
    tx.objectStore(FS_STORE).put(val, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function fsDel(key) {
  const db = await openFsDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FS_STORE, 'readwrite');
    tx.objectStore(FS_STORE).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

const SUPPORTED_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'html', 'htm', 'pdf', 'docx', 'xlsx', 'xls']);

async function ensureDirPermission(handle, interactive) {
  if (!handle) return false;
  const opts = { mode: 'read' };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (!interactive) return false;
    return (await handle.requestPermission(opts)) === 'granted';
  } catch (e) {
    return false;
  }
}

/** 状态行显示：当前绑定哪个目录、上次整理了多少 */
async function refreshKbDirLine(handle, switched) {
  const el = $('kbDirState');
  if (!el) return;
  const hd = handle || await fsGet('kbDir');
  if (!hd) { el.className = ''; el.textContent = '未绑定'; return; }
  const last = (await fsGet('kbLastSync')) || null;
  const parts = ['已绑定：' + hd.name];
  if (last && last.at) {
    const ago = Math.max(0, Math.round((Date.now() - last.at) / 1000));
    parts.push('上次整理 ' + (ago < 60 ? ago + ' 秒前' : Math.round(ago / 60) + ' 分钟前')
      + '（' + (last.addedFiles || 0) + ' 个文件 / ' + (last.addedEntries || 0) + ' 条）');
  } else {
    parts.push('尚未整理');
  }
  if (switched) parts.push('目录已更换');
  el.className = 'ok';
  el.textContent = parts.join(' · ');
}

/** 把一批 File 解析入库（兼容模式与目录绑定共用） */
async function importFileList(files, sourceLabel) {
  const el = $('kbDirState');
  const kb = await kbModule();
  const parse = await import(chrome.runtime.getURL('src/lib/parse.js'));
  const seen = (await fsGet('kbSeen')) || {};
  const nextSeen = Object.assign({}, seen);

  let okFiles = 0, entries = 0, failed = 0, skipped = 0;
  for (const f of files) {
    const name = f.name || 'file';
    const ext = String(name).split('.').pop().toLowerCase();
    if (!SUPPORTED_EXT.has(ext)) { skipped += 1; continue; }
    const sig = name + ':' + f.size + ':' + (f.lastModified || 0);
    if (!sourceLabel && seen[name] === sig) { skipped += 1; continue; }
    try {
      const parsed = await parseFileWithOcr(parse, f, (i, total) => {
        if (el) el.textContent = '正在识别「' + name + '」中的图片 ' + (i + 1) + '/' + total + '…';
      });
      if (!parsed.text || parsed.text.trim().length < 20) { failed += 1; continue; }
      const docs = await kb.listDocs();
      for (const d of docs) { if (d.name === name) await kb.removeDoc(d.docId); }
      const res = await kb.addDocument(parsed);
      okFiles += 1; entries += res.entryCount;
      nextSeen[name] = sig;
    } catch (e) { failed += 1; }
  }

  await fsSet('kbSeen', nextSeen);
  await fsSet('kbLastSync', { at: Date.now(), addedFiles: okFiles, addedEntries: entries, skipped, failed });
  if (okFiles > 0) {
    try { await chrome.runtime.sendMessage({ type: 'kb-warm' }); } catch (e) { }
    try { await notifyKbChanged(); } catch (e) { }
    try { if (typeof refreshKB === 'function') await refreshKB(); } catch (e) { }
    try { if (typeof refreshKbWarm === 'function') refreshKbWarm(); } catch (e) { }
  }
  return { okFiles, entries, failed, skipped };
}

async function onPickFiles(input) {
  const el = $('kbDirState');
  if (!input || !input.files || !input.files.length) return;
  if (el) { el.className = ''; el.textContent = '正在整理 ' + input.files.length + ' 个文件…'; }
  try {
    const r = await importFileList(Array.from(input.files), 'picker');
    const msg = '整理完成：' + r.okFiles + ' 个文件（' + r.entries + ' 条）'
      + (r.skipped ? '，跳过 ' + r.skipped : '') + (r.failed ? '，失败 ' + r.failed : '');
    if (el) { el.className = r.okFiles ? 'ok' : 'warn'; el.textContent = msg; }
    setStatus(msg, r.okFiles ? 'ok' : 'warn');
  } catch (e) {
    if (el) { el.className = 'warn'; el.textContent = '整理失败：' + (e && e.message || e); }
  } finally {
    input.value = '';
  }
}

async function bindDir() {
  const el = $('kbDirState');
  if (!window.showDirectoryPicker) {
    if (el) { el.className = 'warn'; el.textContent = '当前浏览器不支持目录绑定（需要 Chrome 86+）'; }
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ id: 'exa-kb', mode: 'read' });
    const prev = await fsGet('kbDir');
    let switched = false;
    if (prev) {
      try {
        switched = !(await prev.isSameEntry(handle));
      } catch (e) {
        switched = String(prev.name || '') !== String(handle.name || '');
      }
    }
    await fsSet('kbDir', handle);
    // 换了目录：清掉"已整理"记录，否则新目录里同名文件会被当成"没变过"而跳过
    if (switched) await fsDel('kbSeen');
    if (el) { el.className = 'ok'; el.textContent = '已绑定：' + handle.name; }
    setStatus(switched
      ? '已切换到新目录 ' + handle.name + '，重新整理中…'
      : '目录已绑定，开始整理…', 'ok');
    await syncDir(true);
    await refreshKbDirLine(handle, switched);
  } catch (e) {
    // 注意：在扩展页面里 AbortError 多半不是"用户取消"，而是浏览器不允许长期绑定目录。
    // 两种情况对用户来说结论一样：换成"选择题库文件夹"。
    const name = String((e && e.name) || '');
    const msg = String((e && e.message) || e || '');
    const likelyBlocked = /AbortError|SecurityError|NotAllowed/i.test(name + ' ' + msg);
    if (el) {
      el.className = 'warn';
      el.textContent = likelyBlocked
        ? '这个浏览器不允许扩展长期绑定目录，请点左边「选择题库文件夹」（每次选一下即可）'
        : '绑定失败：' + msg + '，请改用「选择题库文件夹」';
    }
    setStatus(likelyBlocked
      ? '绑定不被支持，用「选择题库文件夹」即可'
      : '绑定失败，改用「选择题库文件夹」', 'warn');
  }
}

/** 扫描目录，只处理新增/变化过的文件 */
async function syncDir(interactive) {
  const el = $('kbDirState');
  const btn = $('kbSyncDir');
  let handle = await fsGet('kbDir');
  if (!handle) {
    if (el) { el.className = ''; el.textContent = '还没导入题库（点「选择题库文件夹」）'; }
    return { ok: false, reason: 'no-binding' };
  }
  const granted = await ensureDirPermission(handle, interactive);
  if (!granted) {
    if (el) { el.className = 'warn'; el.textContent = '已绑定 ' + handle.name + '，但需要重新授权（点「立即整理」）'; }
    return { ok: false, reason: 'no-permission' };
  }

  if (btn) { btn.disabled = true; btn.textContent = '整理中…'; }
  if (el) { el.className = ''; el.textContent = '正在整理 ' + handle.name + ' …'; }

  try {
    const seen = (await fsGet('kbSeen')) || {};
    const nextSeen = Object.assign({}, seen);
    const kb = await kbModule();
    const parse = await import(chrome.runtime.getURL('src/lib/parse.js'));

    let addedFiles = 0, addedEntries = 0, skipped = 0, failed = 0;
    const changedDocs = [];

    for await (const [name, entry] of handle.entries()) {
      if (entry.kind !== 'file') continue;
      const ext = String(name).split('.').pop().toLowerCase();
      if (!SUPPORTED_EXT.has(ext)) continue;
      let file;
      try { file = await entry.getFile(); } catch (e) { failed += 1; continue; }

      const sig = name + ':' + file.size + ':' + (file.lastModified || 0);
      if (seen[name] === sig) { skipped += 1; continue; }

      try {
        const parsed = await parseFileWithOcr(parse, file, (i, total) => {
          if (el) el.textContent = '正在识别「' + name + '」中的图片 ' + (i + 1) + '/' + total + '…';
        });
        if (!parsed.text || parsed.text.trim().length < 20) { failed += 1; continue; }
        // 同一文件重新整理：先删旧条目，避免重复堆积
        if (seen[name]) {
          const docs = await kb.listDocs();
          for (const d of docs) {
            if (d.name === name) await kb.removeDoc(d.docId);
          }
        }
        const res = await kb.addDocument(parsed);
        addedFiles += 1;
        addedEntries += res.entryCount;
        nextSeen[name] = sig;
        changedDocs.push(name + '（' + res.entryCount + ' 条）');
      } catch (e) {
        failed += 1;
      }
    }

    await fsSet('kbSeen', nextSeen);
    await fsSet('kbLastSync', { at: Date.now(), addedFiles, addedEntries, skipped, failed });

    if (addedFiles > 0) {
      try { await chrome.runtime.sendMessage({ type: 'kb-warm' }); } catch (e) { }
      await notifyKbChanged();
      await refreshKB();
      refreshKbWarm();
    }

    const msg = '整理完成：新增/更新 ' + addedFiles + ' 个文件（' + addedEntries + ' 条）'
      + (skipped ? '，跳过未变 ' + skipped + ' 个' : '')
      + (failed ? '，失败 ' + failed + ' 个' : '');
    if (el) {
      el.className = addedFiles ? 'ok' : '';
      el.textContent = msg;
    }
    setStatus(msg, addedFiles ? 'ok' : 'warn');
    await refreshKbDirLine(handle, false);
    return { ok: true, addedFiles, addedEntries, skipped, failed, changedDocs };
  } catch (e) {
    if (el) { el.className = 'warn'; el.textContent = '整理失败：' + (e && e.message || e); }
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '立即整理'; }
  }
}

async function unbindDir() {
  await fsDel('kbDir');
  await fsDel('kbSeen');
  const el = $('kbDirState');
  if (el) { el.className = ''; el.textContent = '未绑定'; }
  setStatus('已解除目录绑定（已导入的知识条目保留）', 'warn');
}

/** 页面打开时：显示绑定状态，已授权就自动整理一次 */
async function bootDirSync() {
  const el = $('kbDirState');
  const handle = await fsGet('kbDir');
  if (!handle) {
    if (el) { el.className = ''; el.textContent = '还没导入题库（点「选择题库文件夹」）'; }
    return;
  }
  const granted = await ensureDirPermission(handle, false);
  if (el) {
    if (granted) {
      await refreshKbDirLine(handle, false);
    } else {
      el.className = 'warn';
      el.textContent = '已绑定：' + handle.name + '（需重新授权，点「立即整理」）';
    }
  }
  if (granted) await syncDir(false);
}


/* ---------------- AI 深度整理（预处理索引） ---------------- */
let enrichRunning = false;

async function refreshEnrichState() {
  const el = $('kbEnrichState');
  if (!el) return;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'kb-enrich-stats' });
    if (!r || !r.ok) { el.className = 'warn'; el.textContent = '读取失败'; return; }
    if (!r.total) { el.className = ''; el.textContent = '题库为空'; return; }
    const pct = Math.round((r.ratio || 0) * 100);
    el.className = r.done >= r.total ? 'ok' : '';
    el.textContent = r.done >= r.total
      ? '已全部整理 · ' + r.total + ' 条'
      : '已整理 ' + r.done + '/' + r.total + ' 条（' + pct + '%）';
  } catch (e) {
    el.className = 'warn';
    el.textContent = '读取失败';
  }
}

async function runEnrich() {
  const el = $('kbEnrichState');
  const btn = $('kbEnrichBtn');
  if (enrichRunning) return;
  enrichRunning = true;
  if (btn) { btn.disabled = true; btn.textContent = '整理中…'; }
  let guard = 0;
  try {
    for (;;) {
      if (guard++ > 200) break;                 // 防御性上限
      const r = await chrome.runtime.sendMessage({ type: 'kb-enrich', batchSize: 12 });
      if (!r || !r.ok) {
        if (el) { el.className = 'warn'; el.textContent = '整理失败：' + ((r && r.error) || '未知原因'); }
        break;
      }
      if (el) {
        el.className = 'ok';
        el.textContent = '整理中… ' + r.done + '/' + r.total + ' 条';
      }
      if (r.done) break;
    }
    await refreshEnrichState();
    setStatus('AI 整理完成', 'ok');
  } catch (e) {
    if (el) { el.className = 'warn'; el.textContent = '整理失败：' + (e && e.message || e); }
  } finally {
    enrichRunning = false;
    if (btn) { btn.disabled = false; btn.textContent = '开始 AI 整理'; }
  }
}

async function clearEnrichIndex() {
  const el = $('kbEnrichState');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'kb-enrich-clear' });
    if (r && r.ok) {
      if (el) { el.className = ''; el.textContent = '已清除整理结果'; }
      setStatus('已清除 AI 整理结果', 'warn');
      await refreshEnrichState();
    }
  } catch (e) { }
}


/* ---------------- 答题记录导出 ---------------- */
async function exportSolveLog() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'solve-log' });
    const list = (r && r.list) || [];
    if (!list.length) { setStatus('还没有答题记录', 'warn'); return; }
    const text = JSON.stringify(list, null, 1);
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'exa-solve-log-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { try { a.remove(); URL.revokeObjectURL(url); } catch (e) { } }, 800);
    setStatus('已导出 ' + list.length + ' 条答题记录', 'ok');
  } catch (e) {
    setStatus('导出失败：' + (e && e.message || e), 'warn');
  }
}


/**
 * 解析文件，并（可选）识别文档里的图片。
 * docx 里的题目/表格常常是图片，不 OCR 就等于丢内容。
 */
async function parseFileWithOcr(parse, file, onProgress) {
  const parsed = await parse.parseFile(file);
  const imgs = (parsed && parsed.images) || [];
  if (!imgs.length) return parsed;

  // 设置里可关掉，避免大文档导入太慢
  let enabled = true;
  try {
    const cur = await chrome.storage.local.get('settings');
    const st = (cur && cur.settings) || {};
    enabled = st.ocrDocImages !== false;
  } catch (e) { }
  if (!enabled) { parsed.ocrSkipped = imgs.length; return parsed; }

  try {
    const r = await parse.ocrDocImages(imgs, onProgress);
    if (r.text) {
      parsed.text = String(parsed.text || '') + '\n\n' + r.text;
      parsed.ocrImages = r.ok;
      parsed.ocrFailed = r.failed;
    }
  } catch (e) {
    parsed.ocrError = String(e && e.message || e);
  }
  return parsed;
}


/* ---------------- 知识库条目浏览 ---------------- */
const kbBrowseState = { offset: 0, limit: 30, query: '', total: 0 };

async function kbBrowseRender() {
  const list = $('kbBrowseList');
  const sum = $('kbBrowseSum');
  const pageEl = $('kbBrowsePage');
  if (!list) return;

  try {
    const kb = await kbModule();
    const r = await kb.listEntries({
      offset: kbBrowseState.offset,
      limit: kbBrowseState.limit,
      query: kbBrowseState.query
    });
    kbBrowseState.total = r.total;

    if (!r.total) {
      list.innerHTML = '<div class="kbbrowse-empty">'
        + (kbBrowseState.query ? '没有匹配的条目' : '知识库还是空的，先导入题库文件')
        + '</div>';
      if (sum) sum.textContent = '—';
      if (pageEl) pageEl.textContent = '—';
      return;
    }

    list.innerHTML = r.rows.map((e, i) => {
      const n = e.n || (kbBrowseState.offset + i + 1);
      const q = e.question || '(无题干)';
      const a = e.answer || '';
      const typeName = e.type === 'qa' ? '问答' : e.type === 'term' ? '术语' : '原文';
      return '<div class="kbrow">'
        + '<div class="kbrow-q">' + n + '. ' + escHtml(q) + '</div>'
        + (a ? '<div class="kbrow-a">答案：<b>' + escHtml(a) + '</b></div>' : '')
        + '<div class="kbrow-meta">' + typeName + ' · ' + escHtml(e.docName || '未知来源') + '</div>'
        + '</div>';
    }).join('');

    const from = kbBrowseState.offset + 1;
    const to = Math.min(kbBrowseState.offset + r.rows.length, r.total);
    if (sum) sum.textContent = (kbBrowseState.query ? '匹配 ' : '共 ') + r.total + ' 条'
      + (kbBrowseState.query ? '（全库 ' + r.all + ' 条）' : '');
    if (pageEl) pageEl.textContent = from + '–' + to + ' / ' + r.total;

    const prev = $('kbBrowsePrev'), next = $('kbBrowseNext');
    if (prev) prev.disabled = kbBrowseState.offset <= 0;
    if (next) next.disabled = kbBrowseState.offset + kbBrowseState.limit >= r.total;
  } catch (e) {
    list.innerHTML = '<div class="kbbrowse-empty">读取失败：' + escHtml(String(e && e.message || e)) + '</div>';
  }
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function kbBrowseBind() {
  if ($('kbBrowseSearch')) $('kbBrowseSearch').addEventListener('click', () => {
    kbBrowseState.query = ($('kbBrowseQuery').value || '').trim();
    kbBrowseState.offset = 0;
    kbBrowseRender();
  });
  if ($('kbBrowseQuery')) $('kbBrowseQuery').addEventListener('keydown', e => {
    if (e.key === 'Enter') { $('kbBrowseSearch').click(); }
  });
  if ($('kbBrowseReset')) $('kbBrowseReset').addEventListener('click', () => {
    if ($('kbBrowseQuery')) $('kbBrowseQuery').value = '';
    kbBrowseState.query = '';
    kbBrowseState.offset = 0;
    kbBrowseRender();
  });
  if ($('kbBrowsePrev')) $('kbBrowsePrev').addEventListener('click', () => {
    kbBrowseState.offset = Math.max(0, kbBrowseState.offset - kbBrowseState.limit);
    kbBrowseRender();
  });
  if ($('kbBrowseNext')) $('kbBrowseNext').addEventListener('click', () => {
    if (kbBrowseState.offset + kbBrowseState.limit < kbBrowseState.total) {
      kbBrowseState.offset += kbBrowseState.limit;
      kbBrowseRender();
    }
  });
  kbBrowseRender();
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  $('flashOn').addEventListener('change', () => {
    $('flashMs').disabled = !$('flashOn').checked;
  });
  $('save').addEventListener('click', save);
  $('test').addEventListener('click', test);
  $('reset').addEventListener('click', async () => {
    fill(DEFAULTS);
    await chrome.storage.local.set({ settings: DEFAULTS });
    setStatus('已恢复默认', 'warn');
  });
  $('toggleKey').addEventListener('click', () => {
    const el = $('apiKey');
    const show = el.type === 'password';
    el.type = show ? 'text' : 'password';
    $('toggleKey').textContent = show ? '隐藏' : '显示';
  });
  $('preset').addEventListener('change', e => {
    const p = PRESETS[e.target.value];
    if (!p || !p.baseUrl) return;
    $('baseUrl').value = p.baseUrl;
    $('model').value = p.model;
    $('visionModel').value = p.visionModel || '';
    setStatus('已套用预设，记得填 Key 再保存', 'warn');
  });
  // Ctrl/Cmd + S 保存
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  });

  /* ---- 缓存 ---- */
  refreshCacheStats();
  $('cacheClear').addEventListener('click', async () => {
    const n = await clearCache();
    await refreshCacheStats();
    setStatus('已清空 ' + n + ' 条答案缓存', 'warn');
  });

  /* ---- 知识库 ---- */
  refreshKB();
  const drop = $('kbDrop');
  const fileInput = $('kbFile');
  drop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    importFiles(fileInput.files);
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault();
    drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault();
    drop.classList.remove('over');
  }));
  drop.addEventListener('drop', e => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
  });
  $('kbTest').addEventListener('click', kbTest);
  $('kbQuery').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); kbTest(); }
  });
  async function refreshKbWarm() {
    const el = $('kbWarmState');
    if (!el) return;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'kb-warm-status' });
      const st = (r && r.state) || {};
      if (!st.at) {
        el.className = 'kbwarm';
        el.textContent = '索引状态：尚未预热（后台启动时会自动预热，或点「立即预热」）';
        return;
      }
      if (st.ok && st.entries > 0) {
        const ago = Math.max(0, Math.round((Date.now() - st.at) / 1000));
        el.className = 'kbwarm ok';
        el.textContent = '索引状态：已预热 · ' + st.entries + ' 条 · 用时 ' + st.ms + 'ms · ' + ago + ' 秒前';
      } else if (st.ok) {
        el.className = 'kbwarm';
        el.textContent = '索引状态：题库为空，导入后会自动预热';
      } else {
        el.className = 'kbwarm bad';
        el.textContent = '索引状态：预热失败 — ' + (st.error || '未知原因');
      }
    } catch (e) {
      el.className = 'kbwarm bad';
      el.textContent = '索引状态：读取失败（' + (e && e.message || e) + '）';
    }
  }

  async function doWarm() {
    const el = $('kbWarmState');
    const btn = $('kbWarm');
    if (btn) { btn.disabled = true; btn.textContent = '预热中…'; }
    if (el) { el.className = 'kbwarm'; el.textContent = '索引状态：正在把题库载入内存…'; }
    try {
      const r = await chrome.runtime.sendMessage({ type: 'kb-warm' });
      if (r && r.ok) {
        el.className = 'kbwarm ok';
        el.textContent = '索引状态：已预热 · ' + r.entries + ' 条 · 用时 ' + r.ms + 'ms';
      } else {
        el.className = 'kbwarm bad';
        el.textContent = '预热失败：' + ((r && r.error) || '未知原因');
      }
    } catch (e) {
      if (el) { el.className = 'kbwarm bad'; el.textContent = '预热失败：' + (e && e.message || e); }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '立即预热'; }
    }
  }

  // 目录功能已移除，保留代码但不绑定
  if ($('kbEnrichBtn')) $('kbEnrichBtn').addEventListener('click', runEnrich);
  if ($('kbEnrichClear')) $('kbEnrichClear').addEventListener('click', clearEnrichIndex);
  refreshEnrichState();

  const pickDir = () => { const inp = $('kbPickFiles'); if (inp) inp.click(); };
  if ($('kbPickDirMain')) $('kbPickDirMain').addEventListener('click', pickDir);
  if ($('kbPickDirBtn')) $('kbPickDirBtn').addEventListener('click', pickDir);
  if ($('kbBindDir')) $('kbBindDir').addEventListener('click', bindDir);
  if ($('kbSyncDir')) $('kbSyncDir').addEventListener('click', () => syncDir(true));
  if ($('kbUnbindDir')) $('kbUnbindDir').addEventListener('click', unbindDir);
  // bootDirSync();  // 目录绑定功能已移除
  if ($('exportLog')) $('exportLog').addEventListener('click', exportSolveLog);
  kbBrowseBind();
  if ($('kbWarm')) $('kbWarm').addEventListener('click', doWarm);
  refreshKbWarm();
  setInterval(refreshKbWarm, 5000);

  $('kbClear').addEventListener('click', async () => {
    const kb = await kbModule();
    await kb.clearAll();
    await notifyKbChanged();
    await refreshKB();
    await refreshCacheStats();
    setStatus('知识库已清空', 'warn');
  });
});

async function notifyKbChanged() {
  try { await chrome.runtime.sendMessage({ type: 'kbChanged' }); } catch (e) { }
}

/* ================= 知识库 ================= */

let __kb = null;
let __parse = null;

async function kbModule() {
  if (!__kb) __kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
  return __kb;
}

async function parseModule() {
  if (!__parse) __parse = await import(chrome.runtime.getURL('src/lib/parse.js'));
  return __parse;
}

function loadVendorScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve(true);
    s.onerror = () => reject(new Error('加载解析器失败：' + url));
    document.head.appendChild(s);
  });
}

async function ensureVendor(ext) {
  if (ext === 'docx' && !window.mammoth) {
    await loadVendorScript(chrome.runtime.getURL('vendor/mammoth.browser.min.js'));
  }
  if ((ext === 'xlsx' || ext === 'xls') && !window.XLSX) {
    await loadVendorScript(chrome.runtime.getURL('vendor/xlsx.full.min.js'));
  }
}

function setProgress(ratio, text) {
  const box = $('kbProgress');
  if (!box) return;
  if (ratio == null) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.querySelector('.fill').style.width = Math.round(ratio * 100) + '%';
  box.querySelector('span').textContent = text || '';
}

let __importing = false;

async function importFiles(fileList) {
  if (__importing) { setStatus('上一批还在导入中，请稍候', 'warn'); return; }
  const files = Array.from(fileList || []);
  if (!files.length) return;

  __importing = true;
  const parse = await parseModule();
  const kb = await kbModule();
  const failed = [];
  let imported = 0;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    setProgress(i / files.length, `解析中 ${i + 1}/${files.length}：${f.name}`);
    try {
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      await ensureVendor(ext);
      const parsed = await parseFileWithOcr(parse, f, (i, total) => {
        setStatus('正在识别「' + f.name + '」中的图片 ' + (i + 1) + '/' + total + '…', 'ok');
      });
      if (parsed.warning) throw new Error(parsed.warning);
      if (parsed.ocrImages) setStatus('已识别 ' + parsed.ocrImages + ' 张图片', 'ok');
      const res = await kb.addDocument(parsed);
      imported += res.entryCount;
      // 导入后让后台立刻把索引载入内存，第一次检索就是 0ms
      try { await chrome.runtime.sendMessage({ type: 'kb-warm' }); } catch (e) { }
      // 通知已打开的考试页：知识库变了，清掉旧的非知识库答案
      try {
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) {
          if (t.id != null) chrome.tabs.sendMessage(t.id, { type: 'kb-changed' }).catch(() => { });
        }
      } catch (e) { }
      refreshKbWarm();
    } catch (e) {
      failed.push(`${f.name}：${e && e.message ? e.message : e}`);
    }
    setProgress((i + 1) / files.length, `已处理 ${i + 1}/${files.length}`);
  }

  setProgress(null);
  __importing = false;
  await notifyKbChanged();
  await refreshKB();
  await refreshCacheStats();

  if (failed.length) {
    setStatus(`导入完成，${failed.length} 个文件失败：` + failed.join('；').slice(0, 220), 'bad');
  } else {
    setStatus(`导入完成 ✓ 新增 ${imported} 条知识`, 'ok');
  }
}

async function refreshKB() {
  const kb = await kbModule();
  const docs = await kb.listDocs();
  const st = await kb.stats();
  const list = $('kbList');
  if (!list) return;
  list.textContent = '';

  docs.forEach(d => {
    const row = document.createElement('div');
    row.className = 'kbitem';

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = d.name;
    nm.title = d.name;

    const tag = document.createElement('span');
    tag.className = 'tagv';
    tag.textContent = d.strategy === 'qa' ? '题库' : d.strategy === 'term' ? '术语' : '段落';

    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = d.entryCount + ' 条';

    const del = document.createElement('button');
    del.className = 'ghost';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      const kb2 = await kbModule();
      await kb2.removeDoc(d.id);
      await notifyKbChanged();
      await refreshKB();
      await refreshCacheStats();
      setStatus('已删除 ' + d.name, 'warn');
    });

    row.appendChild(nm);
    row.appendChild(tag);
    row.appendChild(num);
    row.appendChild(del);
    list.appendChild(row);
  });

  $('kbStats').textContent = st.entries
    ? `${docs.length} 个文件 · ${st.entries} 条知识 · 平均 ${Math.round(st.avgLen || 0)} token/条`
    : '尚未导入文件';
}

async function kbTest() {
  const q = $('kbQuery').value.trim();
  const box = $('kbResult');
  if (!q) return;
  const kb = await kbModule();
  const hits = await kb.search(q, { topK: 5, exactQuestion: q });
  let decision = null;
  try { decision = await chrome.runtime.sendMessage({ type: 'kbTest', question: q }); } catch (e) { }

  box.style.display = 'block';
  if (!hits.length) {
    box.textContent = '没有命中。知识库为空，或题干与条目差异过大（可换个更短的关键词试试）。';
    return;
  }
  const modeMap = {
    kb: '直答（知识库精确/高置信命中，免调模型）',
    'kb+ai': '参考推理（知识库 + AI，基于命中条目推理）',
    miss: '未收录（严格模式下跳过模型）',
    ai: '相关度较弱（未送入知识库上下文）',
    off: '知识库开关已关闭'
  };
  const head = decision && decision.ok
    ? `决策路径：${modeMap[decision.mode] || decision.mode}${decision.mode === 'kb' && decision.answer ? '  → 答案：' + decision.answer : ''}\n\n`
    : '';
  box.textContent = head + hits.map((h, i) => {
    const flag = h.exact ? '[精确]' : `[相关 ${Math.round(h.coverage * 100)}%]`;
    const tp = h.entry.type === 'term' ? '术语' : h.entry.type === 'chunk' ? '资料' : '题库';
    return `#${i + 1} ${flag} [${tp}] score=${Math.round(h.score)}  ${h.entry.docName}\n` +
      `问：${h.entry.question}\n答：${String(h.entry.answer || '').slice(0, 360)}\n`;
  }).join('\n');
}

/* ================= 答案缓存 ================= */

const CACHE_PREFIX = "qc:";

async function refreshCacheStats() {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(k => k.startsWith(CACHE_PREFIX));
    const el = $("cacheStats");
    if (el) el.textContent = keys.length ? ("缓存：" + keys.length + " 条") : "缓存：空";
  } catch (e) { }
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(CACHE_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}
