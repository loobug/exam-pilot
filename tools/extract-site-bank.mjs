/**
 * 从站点源码提取完整题库，与 demo/kb-sangfor.txt 逐题对比
 *   node tools/extract-site-bank.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const SITE = 'D:\\labs\\深信服服务2.0\\exam-site\\index.html';
const src = fs.readFileSync(SITE, 'utf8');

/* QUESTIONS 是数组字面量，用括号配对截取 */
const start = src.indexOf('QUESTIONS');
if (start < 0) throw new Error('找不到 QUESTIONS');
const arrStart = src.indexOf('[', start);
let depth = 0, arrEnd = -1, inStr = null;
for (let i = arrStart; i < src.length; i++) {
  const c = src[i];
  if (inStr) {
    if (c === '\\') { i++; continue; }
    if (c === inStr) inStr = null;
    continue;
  }
  if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
  if (c === '[') depth++;
  else if (c === ']') { depth--; if (depth === 0) { arrEnd = i + 1; break; } }
}
if (arrEnd < 0) throw new Error('数组结束没找到');

let arrText = src.slice(arrStart, arrEnd);
/* 对象字面量的 key 没引号，转成 JSON */
arrText = arrText.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
const QUESTIONS = eval('(' + arrText + ')');
console.log('站点题库题数:', QUESTIONS.length);

const TYPE_NAME = { single: '单选题', multi: '多选题', judge: '判断题' };
const LETTERS = 'ABCDEFGH'.split('');

/* 按站点原样生成知识库文本 */
const lines = ['# 客户服务规范 2.0 · 站点题库（直接从 exam-site 提取）', ''];
const jsonBank = [];

QUESTIONS.forEach((q, i) => {
  const n = i + 1;
  const typeName = TYPE_NAME[q.type] || '单选题';
  lines.push(`${n}. ${q.q}`);
  (q.options || []).forEach((opt, k) => lines.push(`${LETTERS[k]}. ${opt}`));
  const ansLetters = (q.answer || []).map(k => LETTERS[k]).join('');
  lines.push(`答案：${ansLetters}`);
  if (q.explain) lines.push(`解析：${q.explain}`);
  const meta = [q.cat ? q.cat : null, q.num ? '数字 ' + q.num : null, typeName].filter(Boolean).join(' · ');
  if (meta) lines.push('分类：' + meta);
  if (q.source) lines.push('出处：' + q.source);
  lines.push('');
  jsonBank.push({
    n, type: q.type, typeName,
    q: q.q,
    options: q.options || [],
    answer: ansLetters,
    explain: q.explain || '',
    source: q.source || '',
    cat: q.cat || '',
    num: q.num || ''
  });
});

fs.writeFileSync('demo/kb-site-full.txt', lines.join('\n'), 'utf8');
fs.writeFileSync('docs/site-bank.json', JSON.stringify(jsonBank, null, 1), 'utf8');
console.log('已写出 demo/kb-site-full.txt 与 docs/site-bank.json');

/* 与现有 demo/kb-sangfor.txt 对比 */
const oldText = fs.readFileSync('demo/kb-sangfor.txt', 'utf8');
const oldBlocks = oldText.split(/\n\s*\n/).filter(b => /答案：/.test(b));

console.log('\n旧题库块数:', oldBlocks.length, ' 站点题数:', QUESTIONS.length);

/* 逐题比对：题干 + 答案 */
const norm = s => String(s || '').replace(/\s+/g, '').replace(/[“”"']/g, '').slice(0, 60);
const oldMap = new Map();
oldBlocks.forEach(b => {
  const m = b.match(/^\s*\d+\.\s*(.+)/);
  const a = b.match(/答案：\s*([A-H、,，\s]+)/);
  if (m) oldMap.set(norm(m[1]), (a ? a[1].replace(/[^A-H]/g, '') : ''));
});

let same = 0, miss = 0, ansDiff = 0;
const problems = [];
QUESTIONS.forEach((q, i) => {
  const key = norm(q.q);
  const wantAns = (q.answer || []).map(k => LETTERS[k]).join('');
  if (!oldMap.has(key)) { miss++; problems.push({ n: i + 1, kind: '题干缺失', q: q.q, wantAns }); return; }
  const gotAns = oldMap.get(key);
  if (gotAns !== wantAns) { ansDiff++; problems.push({ n: i + 1, kind: '答案不同', q: q.q, site: wantAns, demo: gotAns }); return; }
  same++;
});

console.log(`完全一致: ${same}/${QUESTIONS.length}`);
console.log(`demo 里缺的题: ${miss}`);
console.log(`答案不一致: ${ansDiff}`);
if (problems.length) {
  console.log('\n=== 差异明细 ===');
  problems.forEach(p => console.log(`  #${p.n} [${p.kind}] ${String(p.q).slice(0, 44)}${p.site ? ' 站点=' + p.site + ' demo=' + p.demo : ' 站点答案=' + p.wantAns}`));
}
