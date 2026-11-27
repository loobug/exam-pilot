/* 知识库：IndexedDB 存储 + 题干精确索引 + 加权 BM25 全文检索（纯本地，无网络） */
import { chunkDocument } from './chunker.js';
import { tokenize, uniqTokens, termFreq, normalizeQuestion, optionsFingerprint, parseOptionsFromText , stemSimilarity } from './tokenize.js';

const DB_NAME = 'exa-kb';
const DB_VER = 2;
const MAX_POSTINGS = 10000;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('entries')) {
        const s = db.createObjectStore('entries', { keyPath: 'id' });
        s.createIndex('docId', 'docId');
        s.createIndex('key', 'key');
      }
      if (!db.objectStoreNames.contains('postings')) db.createObjectStore('postings', { keyPath: 'token' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      // AI 预处理索引：id → { id, aliases[], keywords[], topic }
      if (!db.objectStoreNames.contains('enrich')) db.createObjectStore('enrich', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getStore(name, mode) {
  const db = await openDB();
  return db.transaction(name, mode || 'readonly').objectStore(name);
}

async function idbGet(storeName, key) {
  const store = await getStore(storeName);
  return reqAsPromise(store.get(key));
}

/** 单事务批量读取，大幅降低多词检索时的 IndexedDB 事务开销 */
async function idbGetMany(storeName, keys) {
  if (!keys.length) return [];
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const out = new Array(keys.length);
    keys.forEach((k, idx) => {
      const req = store.get(k);
      req.onsuccess = () => { out[idx] = req.result; };
    });
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbAll(storeName) {
  const store = await getStore(storeName);
  return reqAsPromise(store.getAll());
}

async function idbPutMany(storeName, rows) {
  if (!rows.length) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    rows.forEach(r => store.put(r));
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('事务中止'));
  });
}

async function idbDeleteMany(storeName, keys) {
  if (!keys.length) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    keys.forEach(k => store.delete(k));
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

let _statsCache = null;
let _statsCacheAt = 0;
const STATS_TTL = 8000; // 8s 内不重读

async function getStats() {
  // 注意：导入可能发生在另一个上下文（设置页），本地缓存必须每次核对，
  // 否则 background 会拿着"空库"的旧快照一直不检索。
  const m = await idbGet('meta', 'stats');
  _statsCache = m || { key: 'stats', n: 0, totalLen: 0, docs: 0, updatedAt: 0 };
  _statsCacheAt = Date.now();
  return _statsCache;
}

function invalidateStatsCache() {
  _statsCache = null;
  _statsCacheAt = 0;
  invalidateMemCache();
}

/* ---- 全量内存缓存（最关键的速度优化）----
 * Service Worker 生命周期内把 entries + postings 全部加载进 Map，
 * search() 直接走内存查找，完全跳过 IndexedDB I/O。
 * 写操作（导入/删除/清空）后调 invalidateMemCache() 重置。
 */
let _mem = null;          // { entries: Map<id,entry>, byKey: Map<normKey,entry[]>, postings: Map<token,posting>, st: stats }
let _memLoading = null;   // Promise，防并发重复加载

function invalidateMemCache() {
  _mem = null;
  _memLoading = null;
}

async function loadMemCache() {
  // 先核对磁盘上的索引版本：别的上下文（设置页/其他标签）导入过知识库时要重建
  try {
    const diskStats = await idbGet('meta', 'stats');
    if (_mem) {
      const same = diskStats
        && _mem.st.updatedAt === diskStats.updatedAt
        && _mem.st.n === diskStats.n;
      if (same) return _mem;
      invalidateMemCache();
    }
    if (_memLoading) return _memLoading;
  } catch (e) {
    if (_mem) return _mem;
    if (_memLoading) return _memLoading;
  }

  _memLoading = (async () => {
    const [allEntries, allPostings, st] = await Promise.all([
      idbAll('entries'),
      idbAll('postings'),
      getStats()
    ]);
    const entries = new Map();
    const byKey = new Map();
    for (const e of allEntries) {
      entries.set(e.id, e);
      const k = e.key || normalizeQuestion(e.question || '');
      if (k) {
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(e);
      }
    }
    const postings = new Map();
    for (const p of allPostings) postings.set(p.token, p);

    // 选项指纹索引：选项文本集合完全一致的题，视为同一道题。
    // 用途：题干措辞不同（换字、加前缀、被截断）但选项一模一样的场景。
    const byOptFp = new Map();
    for (const e of allEntries) {
      const fp = e.optFp || '';
      if (!fp || fp.split('|').length < 3) continue;
      if (!byOptFp.has(fp)) byOptFp.set(fp, []);
      if (!byOptFp.get(fp).includes(e.id)) byOptFp.get(fp).push(e.id);
    }

    // AI 预处理的别名词表：同义问法 → 条目
    let enrichAll = [];
    try { enrichAll = await idbAll('enrich'); } catch (e) { enrichAll = []; }
    const enrich = new Map();
    const byAlias = new Map();
    for (const en of enrichAll) {
      if (!en || !en.id) continue;
      enrich.set(en.id, en);
      const keys = []
        .concat(Array.isArray(en.aliases) ? en.aliases : [])
        .concat(Array.isArray(en.keywords) ? en.keywords : [])
        .concat(en.topic ? [en.topic] : []);
      for (const a of keys) {
        const k = normalizeQuestion(String(a || ''));
        if (!k || k.length < 4) continue;
        if (!byAlias.has(k)) byAlias.set(k, []);
        if (!byAlias.get(k).includes(en.id)) byAlias.get(k).push(en.id);
      }
    }
    _mem = { entries, byKey, postings, st, enrich, byAlias, byOptFp };
    _memLoading = null;
    return _mem;
  })();
  return _memLoading;
}



/** 推进索引版本，让所有上下文的 _mem 缓存失效 */
async function touchIndexVersion() {
  try {
    const st = await idbGet('meta', 'stats');
    const next = Object.assign({ key: 'stats', n: 0, totalLen: 0, docs: 0 }, st || {}, {
      updatedAt: Date.now()
    });
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put(next);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { }
  invalidateStatsCache();
}

/* ---------------- AI 预处理索引（enrich）读写 ---------------- */

/** 还没做过 AI 预处理的条目 */
export async function pendingEnrich(limit = 20, onlyIds) {
  const all = await idbAll('entries');
  const done = new Set((await idbAll('enrich')).map(e => e && e.id).filter(Boolean));
  const pool = onlyIds && onlyIds.length
    ? all.filter(e => onlyIds.includes(e.id))
    : all;
  return pool
    .filter(e => e && e.id && !done.has(e.id))
    .slice(0, limit)
    .map(e => ({ id: e.id, question: e.question, answer: e.answer, type: e.type }));
}

/**
 * 写入一批预处理结果
 * @param {Array<{id:string, aliases?:string[], keywords?:string[], topic?:string}>} rows
 */
export async function writeEnrich(rows) {
  const list = (rows || []).filter(r => r && r.id);
  if (!list.length) return { written: 0 };
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('enrich', 'readwrite');
    const store = tx.objectStore('enrich');
    for (const r of list) {
      store.put({
        id: r.id,
        aliases: (Array.isArray(r.aliases) ? r.aliases : []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 6),
        keywords: (Array.isArray(r.keywords) ? r.keywords : []).map(x => String(x || '').trim()).filter(Boolean).slice(0, 10),
        topic: String(r.topic || '').trim().slice(0, 40),
        at: Date.now()
      });
    }
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
  await touchIndexVersion();
  return { written: list.length };
}

/** 预处理进度 */
export async function enrichStats() {
  const total = (await idbAll('entries')).length;
  const done = (await idbAll('enrich')).length;
  return { total, done, pending: Math.max(0, total - done), ratio: total ? done / total : 0 };
}

/** 清空预处理索引（重新整理时用） */
export async function clearEnrich() {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('enrich', 'readwrite');
    tx.objectStore('enrich').clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
  await touchIndexVersion();
  return true;
}

/* ---------------- 写入 ---------------- */

function resolveEntryOptions(e) {
  if (e && e.options && typeof e.options === 'object' && Object.keys(e.options).length) {
    return e.options;
  }
  return parseOptionsFromText((e && e.raw) || (e && e.question) || '');
}

function cleanChoiceAnswerToken(answer) {
  return String(answer || '')
    .trim()
    .replace(/^(?:(?:参考|标准|正确|选项)?答案\s*(?:是|为)?\s*[:：]?\s*)/, '')
    .replace(/(?:[,，、;；\s]*(?:回答(?:正确|错误)|恭喜答对|您的答案.*|我的答案.*)|[（(]\s*回答(?:正确|错误)\s*[)）]).*$/, '')
    .trim();
}

function resolveAnswerText(answer, optionsMap) {
  const ans = cleanChoiceAnswerToken(answer);
  const opts = optionsMap || {};
  const compact = ans.toUpperCase().replace(/[\s,，、;；\/·和与+]/g, '');
  if (/^[A-H]{1,8}$/.test(compact) && Object.keys(opts).length) {
    const letters = Array.from(new Set(compact.split('')));
    const texts = letters.map(L => opts[L]).filter(Boolean);
    if (texts.length === letters.length) return texts.join('；');
  }
  return '';
}

/** 内部：把已切分好的条目写入索引（新建或追加到已有文档） */
async function writeEntries(entries, docName, meta) {
  meta = meta || {};
  const stats = await getStats();
  const docId = meta.docId || ('d' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  const startAt = meta.startAt || 0;

  const rows = [];
  const tokenAgg = new Map();
  let totalLen = stats.totalLen || 0;

  entries.forEach((e, i) => {
    const id = docId + ':' + (startAt + i);
    const tokens = tokenize(`${e.question} ${e.answer} ${e.explain || ''} ${e.raw}`);
    const tf = termFreq(tokens);
    const len = tokens.length || 1;
    totalLen += len;
    const optsMap = resolveEntryOptions(e);
    const ansText = e.answerText || resolveAnswerText(e.answer, optsMap);
    const fpFromOpts = Object.keys(optsMap).length >= 2
      ? Object.values(optsMap).map(t => String(t || '').trim()).filter(Boolean).length >= 2
      : false;
    rows.push({
      id,
      docId,
      docName,
      type: e.type || 'qa',
      question: e.question,
      answer: e.answer,
      answerText: ansText,
      options: Object.keys(optsMap).length ? optsMap : undefined,
      explain: e.explain || '',
      raw: e.raw,
      key: normalizeQuestion(e.question),
      optFp: e.optFp || optionsFingerprint(e.raw || e.question) || (fpFromOpts ? optionsFingerprint(Object.entries(optsMap).map(([k, v]) => `${k}. ${v}`).join('\n')) : ''),
      len
    });
    tf.forEach((n, t) => {
      if (!tokenAgg.has(t)) tokenAgg.set(t, []);
      tokenAgg.get(t).push([id, n, len]);
    });
  });

  const tokens = Array.from(tokenAgg.keys());
  const existing = await idbGetMany('postings', tokens);
  const postingsRows = [];
  tokens.forEach((t, i) => {
    const prev = existing[i];
    const list = prev && Array.isArray(prev.list) ? prev.list.slice(0, MAX_POSTINGS) : [];
    const seen = new Set(list.map(x => x[0]));
    for (const row of tokenAgg.get(t)) {
      if (seen.has(row[0])) continue;
      list.push(row);
    }
    postingsRows.push({ token: t, list, df: list.length });
  });

  const prevDoc = meta.docId ? (await idbAll('docs')).find(d => d.id === meta.docId) : null;
  await idbPutMany('docs', [{
    id: docId,
    name: docName,
    size: (prevDoc ? prevDoc.size : 0) + (meta.size || 0),
    mime: meta.mime || (prevDoc ? prevDoc.mime : ''),
    strategy: meta.strategy || 'manual',
    entryCount: startAt + rows.length,
    addedAt: prevDoc ? prevDoc.addedAt : Date.now(),
    updatedAt: Date.now()
  }]);
  await idbPutMany('entries', rows);
  await idbPutMany('postings', postingsRows);
  await idbPutMany('meta', [{
    key: 'stats',
    n: (stats.n || 0) + rows.length,
    totalLen,
    docs: prevDoc ? (stats.docs || 0) : (stats.docs || 0) + 1,
    updatedAt: Date.now()
  }]);
  invalidateStatsCache();

  return { docId, entryCount: rows.length, totalInDoc: startAt + rows.length, strategy: meta.strategy || 'manual' };
}

export async function addDocument({ name, size, mime, text }) {
  const { entries, strategy } = chunkDocument(text, name);
  if (!entries.length) throw new Error('没有从「' + name + '」中解析出可用条目');
  return writeEntries(entries, name, { size, mime, strategy });
}

/** 追加或更新条目（面板里「存入知识库」用）。相同答案跳过，人工修改过答案则原地更新。 */
export async function addEntries(list, docName) {
  const name = docName || '手动收录';
  const db = await openDB();
  const docs = await idbAll('docs');
  const target = docs.find(d => d.name === name);

  const fresh = [];
  const updatedRows = [];
  let duplicated = 0;

  for (const raw of (list || [])) {
    if (!raw) continue;
    const question = String(raw.question || '').trim();
    const answer = String(raw.answer || '').trim();
    if (!question || !answer) continue;
    const key = normalizeQuestion(question);
    if (!key) continue;
    const rawFull = String(raw.raw || (question + '\n答案：' + answer)).slice(0, 2400);
    const optsMap = (raw.options && typeof raw.options === 'object' && Object.keys(raw.options).length)
      ? raw.options
      : parseOptionsFromText(rawFull);
    const ansText = raw.answerText || resolveAnswerText(answer, optsMap);
    const fp = optionsFingerprint(rawFull) || (Object.keys(optsMap).length
      ? optionsFingerprint(Object.entries(optsMap).map(([k, v]) => `${k}. ${v}`).join('\n'))
      : '');

    const exist = await new Promise((resolve, reject) => {
      const tx = db.transaction('entries', 'readonly');
      const req = tx.objectStore('entries').index('key').getAll(IDBKeyRange.only(key));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });

    const sameVariant = (exist || []).find(x => !fp || !x.optFp || x.optFp === fp);
    if (sameVariant) {
      if (String(sameVariant.answer || '').trim() === answer &&
          (!Object.keys(optsMap).length || (sameVariant.options && Object.keys(sameVariant.options).length))) {
        duplicated++;
        continue;
      }
      sameVariant.answer = answer.slice(0, 1200);
      sameVariant.raw = rawFull;
      sameVariant.optFp = fp || sameVariant.optFp || '';
      if (Object.keys(optsMap).length) sameVariant.options = optsMap;
      if (ansText) sameVariant.answerText = ansText;
      updatedRows.push(sameVariant);
      continue;
    }

    fresh.push({
      type: raw.type || 'qa',
      question: question.slice(0, 600),
      answer: answer.slice(0, 1200),
      answerText: ansText,
      options: Object.keys(optsMap).length ? optsMap : undefined,
      raw: rawFull,
      optFp: fp
    });
  }

  if (updatedRows.length) {
    await idbPutMany('entries', updatedRows);
    const st = await getStats();
    await idbPutMany('meta', [Object.assign({}, st, { key: 'stats', updatedAt: Date.now() })]);
  }

  if (!fresh.length) {
    if (updatedRows.length) {
      return { docId: target ? target.id : null, entryCount: updatedRows.length, updated: updatedRows.length, duplicated, duplicate: false };
    }
    return { docId: target ? target.id : null, entryCount: 0, duplicated, duplicate: true };
  }

  const res = await writeEntries(fresh, name, {
    strategy: 'qa',
    docId: target ? target.id : null,
    startAt: target ? target.entryCount : 0
  });
  return Object.assign({ duplicated, updated: updatedRows.length }, res);
}

export async function removeDoc(docId) {
  const db = await openDB();
  const keys = await new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readonly');
    const idx = tx.objectStore('entries').index('docId');
    const req = idx.getAllKeys(IDBKeyRange.only(docId));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await idbDeleteMany('entries', keys);
  await idbDeleteMany('docs', [docId]);
  await rebuildIndex();
  return keys.length;
}

export async function clearAll() {
  const db = await openDB();
  await Promise.all(['docs', 'entries', 'postings', 'meta'].map(store =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    })
  ));
  invalidateStatsCache();
  try { await clearEnrich(); } catch (e) { }
}

/** 重建倒排（删除文档、导入异常时使用） */
export async function rebuildIndex() {
  const entries = await idbAll('entries');
  const agg = new Map();
  let totalLen = 0;
  entries.forEach(e => {
    const tokens = tokenize(`${e.question} ${e.answer} ${e.explain || ''} ${e.raw}`);
    const tf = termFreq(tokens);
    const len = tokens.length || 1;
    totalLen += len;
    e.len = len;
    tf.forEach((n, t) => {
      if (!agg.has(t)) agg.set(t, []);
      agg.get(t).push([e.id, n, len]);
    });
  });

  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('postings', 'readwrite');
    tx.objectStore('postings').clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });

  const rows = Array.from(agg.entries()).map(([token, list]) => ({ token, list: list.slice(0, MAX_POSTINGS), df: list.length }));
  for (let i = 0; i < rows.length; i += 200) {
    await idbPutMany('postings', rows.slice(i, i + 200));
  }
  await idbPutMany('entries', entries);

  const docs = await idbAll('docs');
  await idbPutMany('meta', [{ key: 'stats', n: entries.length, totalLen, docs: docs.length, updatedAt: Date.now() }]);
  invalidateStatsCache();
  return { entries: entries.length, tokens: rows.length };
}

/* ---------------- 读取 ---------------- */

export async function listDocs() {
  const docs = await idbAll('docs');
  return docs.sort((a, b) => b.addedAt - a.addedAt);
}

export async function stats() {
  const s = await getStats();
  return { entries: s.n || 0, docs: s.docs || 0, updatedAt: s.updatedAt || 0, avgLen: s.n ? s.totalLen / s.n : 0 };
}


/**
 * 浏览知识库条目（分页 + 关键字过滤）
 * @param {{offset?:number, limit?:number, query?:string}} opts
 */
export async function listEntries(opts) {
  opts = opts || {};
  const offset = Math.max(0, Number(opts.offset) || 0);
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 30));
  const q = String(opts.query || '').trim();
  const qNorm = q ? normalizeQuestion(q) : '';
  const qLower = q.toLowerCase();

  const all = await idbAll('entries');
  let rows = all;

  if (q) {
    rows = all.filter(e => {
      const question = String(e.question || '');
      const answer = String(e.answer || '');
      const raw = String(e.raw || '');
      if (question.toLowerCase().includes(qLower)) return true;
      if (answer.toLowerCase().includes(qLower)) return true;
      if (raw.toLowerCase().includes(qLower)) return true;
      if (qNorm && (e.key || normalizeQuestion(question)).includes(qNorm)) return true;
      return false;
    });
  }

  /* 有编号的按原顺序，没有的按写入顺序 */
  rows = rows.slice().sort((a, b) => {
    const na = Number(a.n) || 0, nb = Number(b.n) || 0;
    if (na !== nb) return na - nb;
    return String(a.id).localeCompare(String(b.id));
  });

  const total = rows.length;
  const page = rows.slice(offset, offset + limit).map(e => {
    const optsMap = resolveEntryOptions(e);
    const ansText = e.answerText || resolveAnswerText(e.answer, optsMap);
    const cleanAns = cleanChoiceAnswerToken(e.answer) || String(e.answer || '');
    return {
      id: e.id,
      n: e.n || null,
      type: e.type || 'qa',
      question: String(e.question || '').slice(0, 300),
      answer: cleanAns.slice(0, 200),
      answerText: String(ansText || '').slice(0, 200),
      options: Object.keys(optsMap).length ? optsMap : null,
      docName: e.docName || '',
      hasOptions: !!(Object.keys(optsMap).length >= 2 || (e.optFp && e.optFp.split('|').length >= 2))
    };
  });

  return { total, offset, limit, rows: page, all: all.length };
}

/** 取单条详情（含原文） */
export async function getEntry(id) {
  const db = await openDB();
  const row = await new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readonly');
    const rq = tx.objectStore('entries').get(id);
    rq.onsuccess = () => resolve(rq.result || null);
    rq.onerror = () => reject(rq.error);
  });
  if (!row) return null;
  return {
    id: row.id,
    n: row.n || null,
    type: row.type || 'qa',
    question: String(row.question || ''),
    answer: String(row.answer || ''),
    raw: String(row.raw || '').slice(0, 3000),
    docName: row.docName || ''
  };
}

/* ---------------- 检索 ---------------- */

function bm25(tf, len, avgLen, idf, k1 = 1.2, b = 0.72) {
  return idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (len / (avgLen || 1))));
}

function fpOverlap(fpA, fpB) {
  const A = String(fpA || '').split('|').filter(Boolean);
  const B = String(fpB || '').split('|').filter(Boolean);
  if (!A.length || !B.length) return 0;
  const setB = new Set(B);
  let hit = 0;
  A.forEach(x => {
    if (setB.has(x)) { hit++; return; }
    if (x.length >= 4 && B.some(b => b.length >= 4 && (b.includes(x) || x.includes(b)))) hit += 0.85;
  });
  return hit / Math.max(A.length, B.length);
}

/**
 * @param {string} queryText 检索文本（题干 + 选项）
 * @param {{topK?:number, exactQuestion?:string, pageFp?:string}} opts
 * @returns {Promise<Array<{entry:object, score:number, coverage:number, stemCov:number, queryCov:number, entryCov:number, exact:boolean}>>}
 */
export async function search(queryText, opts = {}) {
  const topK = opts.topK || 5;

  // ── 加载全量内存缓存（首次约 10-30ms，后续 0ms）──
  const mem = await loadMemCache();
  const { entries: memEntries, byKey: memByKey, postings: memPostings, st, byAlias, byOptFp } = mem;
  if (!st.n) return [];

  // 1) 题干精确命中（内存 Map 直查，0ms）
  const exactKey = normalizeQuestion(opts.exactQuestion || queryText);
  let exactRows = (exactKey.length >= 4 ? (memByKey.get(exactKey) || []) : []).slice();

  // 1.5) AI 别名命中：页面题干虽然措辞不同，但和预处理出的同义问法一致
  if (byAlias && byAlias.size && exactKey.length >= 4) {
    const hitIds = byAlias.get(exactKey);
    if (hitIds && hitIds.length) {
      for (const id of hitIds) {
        const e = memEntries.get(id);
        if (!e) continue;
        if (!exactRows.some(r => r.id === id)) {
          exactRows.push(Object.assign({}, e, { _aliasHit: true }));
        }
      }
    }
  }

  // 1.6) 选项指纹兜底：题干措辞不同，但选项文本集合完全一致 → 同一道题
  if (!exactRows.length && opts.pageFp && byOptFp && byOptFp.size) {
    const ids = byOptFp.get(opts.pageFp) || [];
    for (const id of ids) {
      const e = memEntries.get(id);
      if (e && !exactRows.some(r => r.id === id)) {
        exactRows.push(Object.assign({}, e, { _optHit: true }));
      }
    }
  }

  // 2) 加权 BM25（内存 Map 查 postings，无 IDB I/O）
  const tokens = uniqTokens(tokenize(queryText));
  const stemTokenSet = new Set(opts.exactQuestion ? uniqTokens(tokenize(opts.exactQuestion)) : tokens);
  const queryTokenSet = new Set(tokens);

  const acc = new Map();
  const avgLen = st.totalLen / st.n || 1;
  for (const tok of tokens) {
    const p = memPostings.get(tok);
    if (!p || !Array.isArray(p.list) || !p.list.length) continue;
    const isStemTok = stemTokenSet.has(tok);
    const qWeight = isStemTok ? 1.55 : 0.9;
    const df = p.df || p.list.length;
    const idf = Math.max(0.12, Math.log(1 + (st.n - df + 0.5) / (df + 0.5)));
    for (const row of p.list) {
      const [id, tf, len] = row;
      const cur = acc.get(id) || { score: 0, hits: 0, stemHits: 0 };
      cur.score += qWeight * bm25(tf, len || 1, avgLen, idf);
      cur.hits += 1;
      if (isStemTok) cur.stemHits += 1;
      acc.set(id, cur);
    }
  }

  // 同题干多变体消歧
  let variantConflict = null;
  if (exactRows.length > 1) {
    // 先看这些变体的答案是否互相矛盾
    const ansSet = new Set(exactRows.map(r => String(r.answer || '').replace(/[\s、,，]/g, '').toUpperCase()));
    if (ansSet.size > 1) {
      // 答案不同 → 必须靠选项指纹分辨；分辨不出来就报冲突，不猜
      const scored = exactRows.map(r => ({
        r,
        fp: opts.pageFp ? fpOverlap(r.optFp, opts.pageFp) : 0
      })).sort((a, b) => b.fp - a.fp);
      if (!opts.pageFp || scored[0].fp < 0.8) {
        variantConflict = {
          count: exactRows.length,
          answers: [...ansSet].slice(0, 4),
          bestFp: scored[0] ? Number(scored[0].fp.toFixed(2)) : 0
        };
      }
    }
    let best = exactRows[0], bestScore = -1;
    exactRows.forEach(r => {
      let s = (r.type === 'qa' && r.answer ? 2 : 0);
      if (opts.pageFp) s += fpOverlap(r.optFp, opts.pageFp) * 10;
      if (s > bestScore) { bestScore = s; best = r; }
    });
    exactRows = [best];
  }

  const exactIds = new Set(exactRows.map(r => r.id));

  // 截断候选（内存 Map 直取，0ms）
  const candidateLimit = Math.max(topK * 5, 24);
  const topCandidates = Array.from(acc.entries())
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, candidateLimit);

  const results = [];
  topCandidates.forEach(([id, v]) => {
    const entry = memEntries.get(id);
    if (!entry) return;
    const queryCov = tokens.length ? v.hits / tokens.length : 0;
    const stemCov = stemTokenSet.size ? v.stemHits / stemTokenSet.size : queryCov;

    const entryQTokens = uniqTokens(tokenize(entry.question || ''));
    let entryHits = 0;
    entryQTokens.forEach(t => { if (queryTokenSet.has(t)) entryHits++; });
    const entryCov = entryQTokens.length ? entryHits / entryQTokens.length : 0;

    const effectiveCov = Math.min(1, Math.max(
      queryCov,
      stemCov * 0.96,
      entry.type === 'term' ? entryCov * 0.92 : entryCov * 0.72
    ));

    let finalScore = v.score;
    if (entryQTokens.length >= 1 && entryCov >= 0.8) finalScore += 2.2 * entryCov;

    // 题干相似度兜底：库里明明有、只是措辞/标点略不同时也能认出来
    let sim = 0;
    if (exactKey) {
      const ek = entry.key || normalizeQuestion(entry.question || '');
      sim = stemSimilarity(ek, exactKey);
    }
    const near = !exactIds.has(id) && sim >= 0.9;
    if (near) finalScore += 6 * sim;
    results.push({
      entry, score: finalScore, coverage: Math.max(effectiveCov, near ? sim : 0),
      queryCov, stemCov, entryCov, sim, near, exact: exactIds.has(id)
    });
  });

  exactRows.forEach(r => {
    const existing = results.find(x => x.entry.id === r.id);
    if (!existing) {
      results.push({ entry: r, score: 999, coverage: 1, queryCov: 1, stemCov: 1, entryCov: 1, sim: 1, near: false, exact: true });
    } else {
      existing.exact = true;
      existing.score = Math.max(existing.score, 999);
      existing.coverage = 1;
      existing.stemCov = 1;
      existing.sim = 1;
    }
  });

  results.sort((a, b) => (b.exact - a.exact) || ((b.near ? 1 : 0) - (a.near ? 1 : 0)) || (b.sim || 0) - (a.sim || 0) || (b.score - a.score));
  const out = results.slice(0, topK);
  // 同一题干在题库里有多条、答案还互相矛盾时，把这个信息带上去，让上层不要盲选
  if (variantConflict) { try { out.__conflict = variantConflict; } catch (e) { } }
  return out;
}

function extractExplainFromRaw(raw) {
  const m = String(raw || '').match(/(?:^|\n)\s*(?:答案解析|试题解析|解析|分析|说明)\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:分类|出处|来源|难度|考点)\s*[:：]|$)/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function resolveKbAnswerDetail(entry) {
  const ans = cleanChoiceAnswerToken(entry.answer || '');
  const kbOpts = resolveEntryOptions(entry);
  const optKeys = Object.keys(kbOpts).sort();
  const compact = ans.toUpperCase().replace(/[\s,，、;；\/·和与+]/g, '');

  if (!optKeys.length) {
    if (/^[A-H]{1,8}$/.test(compact)) {
      return {
        optListText: '',
        answerDetail: `原题记录字母「${compact}」（⚠️ 该条目未保存选项文字，当前考题选项可能已打乱，严禁直接照抄字母「${compact}」，请依据题干、解析或学科原理核对【本题选项】文字后作答！）`
      };
    }
    return { optListText: '', answerDetail: ans };
  }

  const optListText = optKeys.map(k => `${k}. ${kbOpts[k]}`).join(' ｜ ');
  if (/^[A-H]{1,8}$/.test(compact)) {
    const letters = Array.from(new Set(compact.split('')));
    const texts = letters.map(L => kbOpts[L]).filter(Boolean);
    if (texts.length === letters.length) {
      return {
        optListText,
        answerDetail: `正确内容为：「${texts.join('」；「')}」（原题对应字母 ${letters.join('')}，注意当前考题选项顺序可能已打乱，请按选项文字匹配！）`
      };
    }
  }
  return { optListText, answerDetail: ans };
}

/** 生成传给大模型的富上下文：包含原题选项文字、答案对应的真实内容与解析依据 */
export function formatHits(hits, maxChars = 1100) {
  return (hits || []).map((h, i) => {
    const e = h.entry;
    const typeLabel = e.type === 'term' ? '术语定义' : e.type === 'chunk' ? '资料原文' : '题库原题';
    const rel = h.exact ? '题干精确匹配' : ('相关度 ' + Math.round((h.coverage || 0) * 100) + '%');
    const optHint = h.matchedOptions && h.matchedOptions.length
      ? ` · 关联本题选项 ${h.matchedOptions.join('/')}`
      : '';
    const header = `[${i + 1}]（${e.docName} · ${typeLabel} · ${rel}${optHint}）`;

    let body = '';
    if (e.type === 'term') {
      body = `术语【${e.question}】：${e.answer}`;
    } else if (e.type === 'chunk') {
      body = String(e.raw || e.answer || e.question || '').trim();
    } else {
      const { optListText, answerDetail } = resolveKbAnswerDetail(e);
      const explain = String(e.explain || extractExplainFromRaw(e.raw) || '').trim();
      const lines = [`原题：${e.question}`];
      if (optListText) lines.push(`原题选项：${optListText}`);
      if (answerDetail) lines.push(`标准答案：${answerDetail}`);
      if (explain) lines.push(`解析依据：${explain}`);
      body = lines.join('\n');
    }
    return `${header}\n${body.slice(0, maxChars)}`;
  }).join('\n\n');
}
