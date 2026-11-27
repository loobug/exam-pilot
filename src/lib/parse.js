/* 文件解析：把上传的题库/笔记转成纯文本，交给 chunker 范式化
 * 支持 txt / md / csv / tsv / json / html / log / pdf / docx / xlsx / xls
 */

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'html', 'htm', 'log', 'xml', 'yaml', 'yml']);
const LETTERS = 'ABCDEFGH';

function extOf(name) {
  return String(name || '').split('.').pop().toLowerCase();
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('读取失败'));
    fr.readAsText(file, 'utf-8');
  });
}

function readAsBuffer(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('读取失败'));
    fr.readAsArrayBuffer(file);
  });
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript').forEach(n => n.remove());
  return doc.body ? doc.body.innerText || doc.body.textContent || '' : '';
}

function stripLeadingLabel(val, letter) {
  const s = String(val == null ? '' : val).trim();
  const re = new RegExp('^\\s*(?:[（(\\[]\\s*' + letter + '\\s*[)）\\]]|' + letter + '\\s*[.、,，:：)）．])\\s*', 'i');
  return s.replace(re, '').trim();
}

/** 二维表格 → 题库文本（识别「题型 / 题干 / 选项A~H / 答案 / 解析」列，否则退回制表符分隔） */
export function rowsToText(rows) {
  if (!rows || !rows.length) return '';
  const head = rows[0].map(c => String(c == null ? '' : c).trim());

  const findCol = keys => head.findIndex(h => {
    const low = h.toLowerCase();
    return keys.some(k => low.includes(k.toLowerCase()));
  });
  const qCol = findCol(['题干', '题目', '问题', '试题', '题面', 'question', 'stem']);
  const aCol = findCol(['正确答案', '参考答案', '标准答案', '选项答案', '答案', 'answer', 'correct']);
  const eCol = findCol(['解析', '解释', '分析', '说明', '依据', '出处', 'explain', 'analysis', 'note']);
  const tCol = findCol(['题型', '题目类型', '类型', 'type', 'kind']);
  const combinedOptCol = head.findIndex(h => /^(?:选项|备选项|候选答案|options|choices)$/i.test(h));

  // 识别独立的选项列：A / 选项A / A选项 / optionA / opt_a ...
  const optCols = [];
  for (let idx = 0; idx < LETTERS.length; idx++) {
    const L = LETTERS[idx];
    const col = head.findIndex(h => {
      const clean = h.replace(/\s+/g, '');
      return new RegExp('^(?:选项)?' + L + '(?:选项|内容)?$', 'i').test(clean) ||
        new RegExp('^(?:option|opt|choice)[_\\-]*' + L + '$', 'i').test(clean);
    });
    if (col >= 0 && col !== qCol && col !== aCol && col !== eCol && col !== tCol) {
      optCols.push({ letter: L, col });
    }
  }

  if (qCol >= 0 && aCol >= 0) {
    const out = [];
    let seq = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const q = String(r[qCol] == null ? '' : r[qCol]).trim();
      const a = String(r[aCol] == null ? '' : r[aCol]).trim();
      if (!q) continue;
      seq += 1;
      const tTag = tCol >= 0 && r[tCol] ? `【${String(r[tCol]).trim()}】` : '';
      out.push(`${seq}. ${tTag}${q}`);
      if (optCols.length) {
        for (const oc of optCols) {
          const rawOpt = String(r[oc.col] == null ? '' : r[oc.col]).trim();
          if (!rawOpt) continue;
          out.push(`${oc.letter}. ${stripLeadingLabel(rawOpt, oc.letter)}`);
        }
      } else if (combinedOptCol >= 0 && r[combinedOptCol]) {
        out.push(String(r[combinedOptCol]).trim());
      }
      if (a) out.push(`答案：${a}`);
      if (eCol >= 0 && r[eCol]) out.push(`解析：${String(r[eCol]).trim()}`);
      out.push('');
    }
    return out.join('\n');
  }

  // 无表头特征：整表按行输出（保留列分隔，方便人读也方便切块）
  return rows.map(r => (r || []).map(c => String(c == null ? '' : c).trim()).join('\t')).join('\n');
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuote = true; continue; }
    if (ch === ',' || ch === '\t') { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function parsePdf(file) {
  const pdfjs = await import(chrome.runtime.getURL('vendor/pdf.min.mjs'));
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.mjs');
  const buf = await readAsBuffer(file);
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true
  }).promise;

  const parts = [];
  const pages = Math.min(doc.numPages, 400);
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let line = '';
    for (const item of content.items) {
      line += item.str || '';
      if (item.hasEOL) { parts.push(line); line = ''; }
      else if (!/\s$/.test(item.str || '')) line += ' ';
    }
    if (line.trim()) parts.push(line);
    parts.push('');
  }
  try { doc.destroy(); } catch (e) { }
  return parts.join('\n');
}

async function parseDocx(file) {
  const mammoth = window.mammoth;
  if (!mammoth) throw new Error('docx 解析器未加载');
  const buf = await readAsBuffer(file);

  // 用 HTML 转换，既能拿到文字结构，也能拿到内嵌图片（docx 里的图片会被 mammoth 转成 dataURL）
  let html = '';
  try {
    const res = await mammoth.convertToHtml({ arrayBuffer: buf });
    html = (res && res.value) || '';
  } catch (e) {
    // 老版本/异常时退回纯文本
    const res = await mammoth.extractRawText({ arrayBuffer: buf });
    return { text: res.value || '', images: [] };
  }

  const images = [];
  const seen = new Set();
  const re = /<img[^>]*?src\s*=\s*"([^"]+)"/gi;
  let m;
  while ((m = re.exec(html))) {
    const src = m[1];
    if (!src || !src.startsWith('data:image/')) continue;
    if (src.length < 2000) continue;        // 太小的多半是图标/项目符号
    if (seen.has(src)) continue;            // 同一张图只处理一次
    seen.add(src);
    images.push(src);
    if (images.length >= 60) break;         // 防御上限
  }

  // 图片位置替换成一个占位标记，让文本顺序不乱
  const withPlaceholder = html.replace(/<img[^>]*>/gi, '');
  const text = htmlToText(withPlaceholder);
  return { text: text || '', images };
}

async function parseXlsx(file) {
  const XLSX = window.XLSX;
  if (!XLSX) throw new Error('xlsx 解析器未加载');
  const buf = await readAsBuffer(file);
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
  const texts = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
    const t = rowsToText(rows);
    if (t.trim()) texts.push(t);
  }
  return texts.join('\n\n');
}


/**
 * 把文档里提取出的图片逐张 OCR，拼成补充文本。
 * 这些文字会和正文一起入库，让 docx 里的题目/表格图片也能被检索到。
 * @param {string[]} images dataURL 列表
 * @param {(i:number,total:number)=>void} onProgress
 */

/**
 * 把一段 OCR 出来的文本按「题号」切成多道题。
 * 一张截图里常有 5-10 道题，整段塞进一个条目会导致搜任何关键词都命中同一大块。
 */
function splitOcrQuestions(text) {
  const raw = String(text || '').replace(/\r\n?/g, '\n');
  if (raw.trim().length < 4) return [];

  const lines = raw.split('\n');
  const blocks = [];
  let cur = null;
  // 题号行： 1. / 1、/ (1) / 第1题 / Q1
  const QNO = /^\s*(?:\(?\s*(\d{1,3})\s*[.、．)）]|第\s*(\d{1,3})\s*题|Q\s*(\d{1,3}))\s*/i;

  for (const rawLine of lines) {
    const line = String(rawLine).replace(/\u00a0/g, ' ').trimEnd();
    if (!line.trim()) {
      if (cur) { cur.lines.push(''); }
      continue;
    }
    const m = line.match(QNO);
    if (m) {
      if (cur && cur.lines.join('').trim().length >= 4) blocks.push(cur);
      cur = { no: m[1] || m[2] || m[3] || '', lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      // 第一行没有题号，先攒着
      cur = { no: '', lines: [line] };
    }
  }
  if (cur && cur.lines.join('').trim().length >= 4) blocks.push(cur);

  // 没有题号可切：按空行分段
  if (blocks.length <= 1) {
    const byBlank = raw.split(/\n\s*\n/).map(x => x.trim()).filter(x => x.length >= 4);
    if (byBlank.length > 1) return byBlank;
  }

  return blocks.map(b => b.lines.join('\n').trim()).filter(x => x.length >= 4);
}

export async function ocrDocImages(images, onProgress) {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return { text: '', ok: 0, failed: 0 };
  const parts = [];
  let ok = 0, failed = 0, questionCount = 0;

  for (let i = 0; i < list.length; i++) {
    if (onProgress) { try { onProgress(i, list.length); } catch (e) { } }
    try {
      const r = await chrome.runtime.sendMessage({ type: 'ocr-local-text', dataUrl: list[i] });
      if (r && r.ok && r.text && r.text.trim().length >= 4) {
        // 一张图里可能有多道题：切开后逐题成段，检索才能定位到具体某道题
        const pieces = splitOcrQuestions(r.text);
        if (pieces.length > 1) {
          pieces.forEach(piece => parts.push(piece));
          ok++;
          questionCount += pieces.length;
        } else {
          parts.push(r.text.trim());
          ok++;
          questionCount += 1;
        }
      } else {
        failed++;
      }
    } catch (e) {
      failed++;
    }
  }

  return { text: parts.join('\n\n'), ok, failed, questions: questionCount };
}

/** 解析单个文件 → {name, size, mime, text, images, warning} */
export async function parseFile(file) {
  const name = file.name || 'file';
  const ext = extOf(name);
  let text = '';
  let extraImages = [];

  if (ext === 'pdf') text = await parsePdf(file);
  else if (ext === 'docx') { const r = await parseDocx(file); text = r.text; extraImages = r.images || []; }
  else if (ext === 'xlsx' || ext === 'xls') text = await parseXlsx(file);
  else if (ext === 'html' || ext === 'htm') text = htmlToText(await readAsText(file));
  else if (ext === 'csv' || ext === 'tsv') text = rowsToText(parseCsv(await readAsText(file)));
  else if (ext === 'json') {
    const raw = await readAsText(file);
    try {
      const data = JSON.parse(raw);
      text = jsonToText(data);
    } catch (e) {
      text = raw;
    }
  } else if (TEXT_EXT.has(ext) || /text\//.test(file.type || '')) {
    text = await readAsText(file);
  } else {
    try { text = await readAsText(file); } catch (e) { text = ''; }
  }

  text = String(text || '').replace(/\r\n?/g, '\n');
  const hasImages = extraImages.length > 0;
  return {
    name,
    size: file.size || text.length,
    mime: file.type || '',
    text,
    images: extraImages,
    warning: (text.trim().length < 20 && !hasImages)
      ? '未提取到有效文本（可能是扫描版 PDF 或空文件）'
      : ''
  };
}

function formatJsonOptions(it) {
  const lines = [];
  const rawOpts = it.options || it.opts || it.choices || it['选项'];
  if (Array.isArray(rawOpts)) {
    rawOpts.forEach((o, k) => {
      if (o == null) return;
      if (typeof o === 'string' || typeof o === 'number') {
        const L = LETTERS[k] || String(k + 1);
        lines.push(`${L}. ${stripLeadingLabel(o, L)}`);
      } else if (typeof o === 'object') {
        const L = String(o.letter || o.label || o.key || LETTERS[k] || '').toUpperCase();
        const txt = o.text || o.content || o.value || o.title || '';
        if (L && txt) lines.push(`${L}. ${stripLeadingLabel(txt, L)}`);
      }
    });
  } else if (rawOpts && typeof rawOpts === 'object') {
    Object.keys(rawOpts).forEach(k => {
      const L = k.trim().toUpperCase();
      const txt = rawOpts[k];
      if (/^[A-H]$/.test(L) && txt) lines.push(`${L}. ${stripLeadingLabel(txt, L)}`);
    });
  } else {
    for (let k = 0; k < LETTERS.length; k++) {
      const L = LETTERS[k];
      const v = it[L] ?? it['选项' + L] ?? it['option' + L] ?? it['opt' + L];
      if (v != null && String(v).trim()) lines.push(`${L}. ${stripLeadingLabel(v, L)}`);
    }
  }
  return lines;
}

function formatJsonAnswer(rawAns) {
  if (rawAns == null) return '';
  if (typeof rawAns === 'boolean') return rawAns ? '正确' : '错误';
  if (Array.isArray(rawAns)) {
    if (rawAns.every(x => typeof x === 'number' && x >= 0 && x < 8)) {
      return rawAns.map(n => LETTERS[n]).join('');
    }
    const strs = rawAns.map(x => String(x).trim()).filter(Boolean);
    if (strs.every(x => /^[A-Ha-h]$/.test(x))) return strs.join('').toUpperCase();
    return strs.join(' | ');
  }
  return String(rawAns).trim();
}

/** JSON 题库：支持 [{question,options,answer,explain}] / {items:[...]} / {题库:[...]} 等 */
export function jsonToText(data) {
  const arr = Array.isArray(data) ? data
    : (data && (data.items || data.list || data.questions || data.bank || data['题库'] || data.data || data.rows)) || null;

  if (Array.isArray(arr)) {
    return arr.map((it, i) => {
      if (typeof it === 'string') return `${i + 1}. ${it}\n`;
      if (!it || typeof it !== 'object') return '';
      const q = it.question || it.q || it['题干'] || it['题目'] || it.stem || it.title || it.content || '';
      const a = formatJsonAnswer(it.answer ?? it.a ?? it['答案'] ?? it['正确答案'] ?? it.correct);
      const e = it.explain || it.explanation || it['解析'] || it.analysis || it.note || '';
      const t = it.type || it.kind || it['题型'] || '';
      if (!q) return '';
      const optLines = formatJsonOptions(it);
      const tTag = t ? `【${t}】` : '';
      return [
        `${i + 1}. ${tTag}${q}`,
        ...optLines,
        a ? `答案：${a}` : '',
        e ? `解析：${e}` : '',
        ''
      ].filter(Boolean).join('\n');
    }).join('\n');
  }
  return JSON.stringify(data, null, 2).replace(/[{}[\]"]/g, ' ');
}

export { extOf };
