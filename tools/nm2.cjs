const fs=require("fs");
const p="src/background.js";
let s=fs.readFileSync(p,"utf8");
const old=`    const hit = pageOpts.find(o => {
      const k = optKey(o.text);
      return k && (k === rawKey || rawKey.includes(k) || k.includes(rawKey));
    });`;
const newp=`    const hit = pageOpts.find(o => {
      const k = optKey(o.text);
      return k && (k === rawKey || rawKey.includes(k) || k.includes(rawKey));
    }) || pageOpts.find(o => normalizeAnswerText(rawAnswer) !== rawKey && normalizeAnswerText(o.text) === normalizeAnswerText(rawAnswer));`;
if(!s.includes("normalizeAnswerText(rawAnswer)")){
  s=s.replace(old,newp);
  fs.writeFileSync(p,s);
}
console.log("judge fallback:", fs.readFileSync(p,"utf8").includes("normalizeAnswerText(rawAnswer)"));
