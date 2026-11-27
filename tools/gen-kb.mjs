/**
 * 从考试页自带的 QUESTIONS 数组生成知识库文件（题目 + 标准答案）
 *   node tools/gen-kb.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const SITE = 'D:\\labs\\深信服服务2.0\\exam-site\\index.html';
const OUT = 'D:\\labs\\0exam\\demo\\kb-sangfor.txt';

const html = fs.readFileSync(SITE, 'utf8');

// 截取 QUESTIONS 数组字面量
const start = html.indexOf('const QUESTIONS');
if (start < 0) throw new Error('未找到 QUESTIONS 定义');
const eq = html.indexOf('=', start);
// 从等号开始做括号配平，取出完整数组字面量
let i = html.indexOf('[', eq);
let depth = 0;
let end = -1;
let inStr = null;
for (let p = i; p < html.length; p++) {
  const ch = html[p];
  if (inStr) {
    if (ch === '\\') { p++; continue; }
    if (ch === inStr) inStr = null;
    continue;
  }
  if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
  if (ch === '[') depth++;
  else if (ch === ']') { depth--; if (depth === 0) { end = p + 1; break; } }
}

const literal = html.slice(i, end);
const QUESTIONS = vm.runInNewContext('(' + literal + ')', Object.create(null));

console.log('题库题目数：', QUESTIONS.length);

const LETTERS = 'ABCDEFGH';
const CAT = {
  core: '核心总纲', discipline: '四大纪律', require: '五项要求',
  project: '六大注意', appendix: '落地附录'
};
const TYPE = { single: '单选题', multi: '多选题', judge: '判断题' };

const lines = [];
lines.push('# 客户服务规范 2.0 · 标准题库（由考试页内置题库导出）');
lines.push('');
lines.push('> 共 ' + QUESTIONS.length + ' 题。题型、选项顺序按原始题库；考试页会打乱选项，插件按题干匹配后自动映射。');
lines.push('');

QUESTIONS.forEach((q, idx) => {
  const options = q.options || [];
  const answerLetters = (q.answer || []).map(n => LETTERS[n]).filter(Boolean).join('');
  lines.push(`${idx + 1}. ${q.q}`);
  options.forEach((opt, k) => lines.push(`${LETTERS[k]}. ${opt}`));
  lines.push(`答案：${answerLetters}`);
  if (q.explain) lines.push(`解析：${q.explain}`);
  const meta = [];
  if (CAT[q.cat]) meta.push(CAT[q.cat]);
  if (q.num) meta.push('数字要点 ' + q.num);
  if (TYPE[q.type]) meta.push(TYPE[q.type]);
  if (meta.length) lines.push(`分类：${meta.join(' · ')}`);
  if (q.source) lines.push(`出处：${q.source}`);
  lines.push('');
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'), 'utf8');

const size = fs.statSync(OUT).size;
console.log('已生成', OUT, (size / 1024).toFixed(1) + ' KB');
console.log('示例：\n' + lines.slice(4, 14).join('\n'));
