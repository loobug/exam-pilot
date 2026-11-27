import fs from "node:fs";
const text = fs.readFileSync("demo/kb-sangfor.txt", "utf8");
function parseBank(t) {
  const blocks = t.split(/\n(?=\d+\.\s)/);
  const out = [];
  for (const b of blocks) {
    const lines = b.split("\n").filter(Boolean);
    if (!lines.length) continue;
    const fm = lines[0].match(/^(\d+)\.\s+(.*)$/);
    if (!fm) continue;
    const options = {};
    let answer = null;
    for (const l of lines.slice(1)) {
      const om = l.match(/^([A-H])\.\s+(.*)$/);
      if (om) { options[om[1]] = om[2].trim(); continue; }
      const am = l.match(/^答案：\s*([A-H]+)/);
      if (am) answer = am[1];
    }
    if (answer) out.push({ no: +fm[1], stem: fm[2].trim(), options, answer });
  }
  return out;
}
const bank = parseBank(text);
const norm = s => String(s).replace(/[\s，,。.、；;：:（）()\[\]【】"'“”‘’·\-—_/]/g, "").toLowerCase();
const byStem = new Map();
bank.forEach(q => {
  const k = norm(q.stem);
  if (!byStem.has(k)) byStem.set(k, []);
  byStem.get(k).push(q);
});
const dups = [...byStem.entries()].filter(([, v]) => v.length > 1);
console.log("题目总数:", bank.length, " 唯一题干:", byStem.size, " 重复题干组:", dups.length);
console.log("");
dups.forEach(([k, v]) => {
  const sameAns = new Set(v.map(x => x.answer)).size === 1;
  const sameOpts = new Set(v.map(x => Object.values(x.options).map(norm).sort().join("|"))).size === 1;
  console.log(`题干: ${v[0].stem.slice(0, 34)}…`);
  v.forEach(x => console.log(`   #${x.no} 答案=${x.answer} 选项数=${Object.keys(x.options).length}`));
  console.log(`   → 答案${sameAns ? "相同" : "不同"} / 选项${sameOpts ? "相同" : "不同"}`);
  console.log("");
});
