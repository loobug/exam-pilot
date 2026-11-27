/** 从题库文本生成结构化 JSON（供随机打乱验证用） */
import fs from 'node:fs';

const text = fs.readFileSync('D:\\labs\\0exam\\demo\\kb-sangfor.txt', 'utf8');
const blocks = text.split(/\n(?=\d+\.\s)/);
const out = [];
let seq = 0;

for (const b of blocks) {
  const lines = b.split('\n').filter(Boolean);
  if (!lines.length) continue;
  const fm = lines[0].match(/^(\d+)\.\s+(.*)$/);
  if (!fm) continue;
  const options = [];
  let answer = null;
  let cat = '';
  for (const line of lines.slice(1)) {
    const om = line.match(/^([A-H])\.\s+(.*)$/);
    if (om) { options.push({ letter: om[1], text: om[2].trim() }); continue; }
    const am = line.match(/^答案：\s*([A-H]+)/);
    if (am) { answer = am[1]; continue; }
    const cm = line.match(/^分类：\s*(.*)$/);
    if (cm) cat = cm[1].trim();
  }
  if (!answer || options.length < 2) continue;

  seq += 1;
  let type = 'single';
  if (/多选题/.test(cat)) type = 'multi';
  else if (/判断题/.test(cat)) type = 'judge';
  else if (answer.length > 1) type = 'multi';
  else if (options.length === 2 && /正确|错误|对|错/.test(options.map(o => o.text).join(''))) type = 'judge';

  out.push({
    no: Number(fm[1]),
    stem: fm[2].trim(),
    type,
    cat,
    options,
    answer
  });
}

fs.writeFileSync('D:\\labs\\0exam\\demo\\bank.json', JSON.stringify(out, null, 1), 'utf8');
const byType = out.reduce((a, q) => (a[q.type] = (a[q.type] || 0) + 1, a), {});
console.log('导出题目:', out.length, JSON.stringify(byType));
console.log('示例:', JSON.stringify(out[0]).slice(0, 160));
