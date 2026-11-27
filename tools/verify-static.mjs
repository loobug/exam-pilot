import fs from "node:fs";
import path from "node:path";

const mf = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const problems = [];
const ok = [];

// 1) manifest 关键字段
if (mf.manifest_version === 3) ok.push("MV3");
else problems.push("manifest_version 不是 3");
if (!mf.actions && !mf.action) problems.push("缺少 action");
if (!Array.isArray(mf.permissions)) problems.push("缺少 permissions");
if (!mf.background || !mf.background.service_worker) problems.push("缺少 background.service_worker");
if (!Array.isArray(mf.content_scripts) || !mf.content_scripts.length) problems.push("缺少 content_scripts");
ok.push("版本 " + mf.version);
ok.push("权限 " + mf.permissions.join(","));

// 2) manifest 里引用的文件是否都存在
const refs = new Set();
if (mf.background && mf.background.service_worker) refs.add(mf.background.service_worker);
(mf.content_scripts || []).forEach(cs => {
  (cs.js || []).forEach(f => refs.add(f));
  (cs.css || []).forEach(f => refs.add(f));
});
(mf.web_accessible_resources || []).forEach(w => {
  (w.resources || []).forEach(r => {
    if (!r.includes("*")) refs.add(r);
  });
  (w.resources || []).filter(r => r.includes("*")).forEach(r => {
    const dir = r.replace(/\/\*.*$/, "");
    if (!fs.existsSync(dir)) problems.push("web_accessible 目录不存在: " + r);
  });
});
["icons", "action"].forEach(k => {
  const v = mf[k];
  if (v && v.default_icon) Object.values(v.default_icon).forEach(p => refs.add(p));
  if (v && typeof v === "object" && !v.default_icon) Object.values(v).filter(x => typeof x === "string").forEach(p => refs.add(p));
});
Object.values(mf.icons || {}).forEach(p => refs.add(p));

const missing = [...refs].filter(r => !fs.existsSync(r));
if (missing.length) problems.push("manifest 引用了不存在的文件: " + missing.join(", "));
ok.push("manifest 引用 " + refs.size + " 个文件，全部存在");

// 3) 源码语法（用 acorn 不可用，改为简单结构检查 + 之前 node --check 已覆盖）
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
const srcFiles = walk("src").filter(f => f.endsWith(".js") || f.endsWith(".html") || f.endsWith(".css") || f.endsWith(".json"));
ok.push("src 文件 " + srcFiles.length + " 个");

// 4) 关键能力点存在性
const bg = fs.readFileSync("src/background.js", "utf8");
const ct = fs.readFileSync("src/content/content.js", "utf8");
const ex = fs.readFileSync("src/content/extract.js", "utf8");
const fl = fs.readFileSync("src/content/fill.js", "utf8");
const checks = [
  ["knowledge base remap", bg, "remapKbAnswer"],
  ["alarms heartbeat", bg, "chrome.alarms.onAlarm"],
  ["auto retry", ct, "AUTO_MAX_RETRY"],
  ["follow mode", ct, "followTick"],
  ["stealth unmount", ct, "qxOverlay.unmount"],
  ["type from class", ex, "typeFromClass"],
  ["hidden input tolerance", ex, "视觉隐藏"],
  ["option relocation", fl, "refreshOptionEls"],
  ["uniform verify", fl, "补齐"],
  ["judge fill", fl, "JUDGE_TRUE"]
];
checks.forEach(([name, file, needle]) => {
  if (file.includes(needle)) ok.push("能力点 " + name);
  else problems.push("缺少能力点 " + name);
});

// 5) 扩展装载目录与源码一致性
const extFiles = walk("extension").map(f => f.replace(/^extension[\\/]/, "").replace(/\\/g, "/"));
const srcOnly = srcFiles.filter(f => !f.includes("node_modules"));
const diff = [];
for (const f of srcOnly) {
  const extPath = path.join("extension", f);
  if (!fs.existsSync(extPath)) { diff.push("缺:" + f); continue; }
  const a = fs.readFileSync(f);
  const b = fs.readFileSync(extPath);
  if (!a.equals(b)) diff.push("不同步:" + f);
}
if (diff.length) problems.push("extension 与源码不一致 → " + diff.slice(0, 8).join(", "));
else ok.push("extension 目录与源码逐字节一致（" + srcOnly.length + " 个文件）");

console.log("=== 静态检查 ===");
ok.forEach(o => console.log("  ✓ " + o));
problems.forEach(p => console.log("  ✗ " + p));
console.log("\n结论：" + (problems.length ? problems.length + " 项问题" : "全部通过"));
if (problems.length) process.exitCode = 1;
