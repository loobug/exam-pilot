const fs = require("fs");
let s = fs.readFileSync("tools/e2e-strict.mjs", "utf8");
s = s.replace(
`        return { answer: res[0] && res[0].answer, src: res[0] && res[0].source && res[0].source.kind, warn: res[0] && res[0].warn, tag: globalThis.__EXA_DEBUG__.ansTag(0) };`,
`        let kb = null;
        try { kb = await globalThis.__EXA_DEBUG__.kbCheck(); } catch (e) { kb = { error: String(e && e.message || e) }; }
        const stem = (globalThis.__EXA_DEBUG__.questions()[0] || {}).stem;
        return {
          answer: res[0] && res[0].answer, src: res[0] && res[0].source && res[0].source.kind,
          warn: res[0] && res[0].warn, tag: globalThis.__EXA_DEBUG__.ansTag(0),
          stem: String(stem || "").slice(0, 40),
          kbMode: kb && kb.mode, kbExact: kb && kb.exact
        };`);
fs.writeFileSync("tools/e2e-strict.mjs", s);
console.log("diag added");
