const fs = require("fs");

/* ---------- 1) background：严格模式 + 未命中的显式结果 ---------- */
let b = fs.readFileSync("src/background.js", "utf8");

b = b.replace(
  "  stealth: true,\n  followMode: true,",
  "  stealth: true,\n  followMode: true,\n  kbStrict: false,"
);
b = b.replace(
  "              followMode: s.followMode !== false",
  "              followMode: s.followMode !== false,\n              kbStrict: s.kbStrict === true"
);

// kbLookup：严格模式下不在库里就明确报 miss
b = b.replace(
  `    const usable = (top.exact || top.coverage >= 0.35) && top.score >= 4;
    if (usable && settings.kbContext !== false) return { mode: 'kb+ai', hits, overlap: ov };
    return { mode: 'ai', hits, overlap: ov };`,
  `    if (settings.kbStrict) {
      // 严格模式：只认题库，不在库里就明确告知，不拿模型答案充数
      return { mode: 'miss', hits, overlap: ov, strict: true };
    }
    if (top.exact && settings.kbStrict === false && ov < 0.5) {
      // 题干对上了但选项对不上：多半是同一知识点的另一道题，交给模型结合条目判断
      const usable2 = top.coverage >= 0.35 && top.score >= 4;
      if (usable2 && settings.kbContext !== false) return { mode: 'kb+ai', hits, overlap: ov };
      return { mode: 'ai', hits, overlap: ov };
    }
    const usable = (top.exact || top.coverage >= 0.35) && top.score >= 4;
    if (usable && settings.kbContext !== false) return { mode: 'kb+ai', hits, overlap: ov };
    return { mode: 'ai', hits, overlap: ov };`
);

// 严格模式下 kbLookup 命中直接返回，未命中返回 miss 后由 solveOne 处理
b = b.replace(
  `    const strong = top.exact && (!hasOpts || ov >= 0.5);
    if (strong && settings.kbDirect !== false) return { mode: 'kb', hits, overlap: ov };`,
  `    const strong = top.exact && (!hasOpts || ov >= 0.5);
    if (strong && settings.kbDirect !== false) return { mode: 'kb', hits, overlap: ov };
    if (settings.kbStrict && !top.exact) return { mode: 'miss', hits, overlap: ov, strict: true };`
);

fs.writeFileSync("src/background.js", b);

/* ---------- 2) overlay：miss 来源标签 ---------- */
let o = fs.readFileSync("src/content/overlay.js", "utf8");
o = o.replace(
  "  .anstag.page{background:#2a1f33;color:#c9a6e8;border:1px solid #4a3560}",
  `  .anstag.page{background:#2a1f33;color:#c9a6e8;border:1px solid #4a3560}
  .anstag.miss{background:#3a2018;color:#f0a37a;border:1px solid #6b3a24}`
);
o = o.replace(
  "    manual: { cls: 'cache', text: '手动' }",
  "    manual: { cls: 'cache', text: '手动' },\n    miss: { cls: 'miss', text: '知识库未收录' }"
);
fs.writeFileSync("src/content/overlay.js", o);

/* ---------- 3) options：严格模式开关 ---------- */
let h = fs.readFileSync("src/options/options.html", "utf8");
if (!h.includes('id="kbStrict"')) {
  h = h.replace(
`    <div class="switch">
      <input type="checkbox" id="followMode" />`,
`    <div class="switch">
      <input type="checkbox" id="kbStrict" />
      <div>
        <div class="lab">只用知识库（严格模式）</div>
        <div class="desc">只采用题库里<b>精确命中</b>的答案；没收录的题明确标注「知识库未收录」，不调用模型猜测。</div>
      </div>
    </div>

    <div class="switch">
      <input type="checkbox" id="followMode" />`);
  fs.writeFileSync("src/options/options.html", h);
}

let oj = fs.readFileSync("src/options/options.js", "utf8");
oj = oj.replace("  followMode: true,", "  followMode: true,\n  kbStrict: false,");
oj = oj.replace(
  "  $('followMode').checked = s.followMode !== false;",
  "  $('followMode').checked = s.followMode !== false;\n  $('kbStrict').checked = s.kbStrict === true;"
);
oj = oj.replace(
  "    followMode: $('followMode').checked,",
  "    followMode: $('followMode').checked,\n    kbStrict: $('kbStrict').checked,"
);
fs.writeFileSync("src/options/options.js", oj);

console.log("strict mode wired:",
  fs.readFileSync("src/background.js", "utf8").includes("mode: 'miss'"),
  fs.readFileSync("src/options/options.js", "utf8").includes("kbStrict"));
