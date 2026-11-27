const fs = require("fs");
let s = fs.readFileSync("tools/e2e-strict.mjs", "utf8");

// 读标签前先开面板
s = s.replace(
`    const out = await worker.evaluate(async tid => {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: async () => {
          let list = await globalThis.__EXA_DEBUG__.extract();
          for (let k = 0; k < 3 && !list.length; k++) {
            await new Promise(r2 => setTimeout(r2, 120));
            list = await globalThis.__EXA_DEBUG__.extract();
          }
          if (!list.length) return { n: 0 };
          await globalThis.__EXA_DEBUG__.solveAll();
          const res = globalThis.__EXA_DEBUG__.results();
          const tag = globalThis.__EXA_DEBUG__.ansTag(0);
          return { n: list.length, answer: res[0] && res[0].answer, src: res[0] && res[0].source && res[0].source.kind, warn: res[0] && res[0].warn, tag };
        }
      });
      return r[0].result;
    }, tabId);
    return out;`,
`    await worker.evaluate(async tid => {
      try { await chrome.tabs.sendMessage(tid, { type: "cmd-toggle" }); } catch (e) { }
    }, tabId);
    await sleep(400);
    const out = await worker.evaluate(async tid => {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: async () => {
          let list = await globalThis.__EXA_DEBUG__.extract();
          for (let k = 0; k < 3 && !list.length; k++) {
            await new Promise(r2 => setTimeout(r2, 120));
            list = await globalThis.__EXA_DEBUG__.extract();
          }
          if (!list.length) return { n: 0 };
          await globalThis.__EXA_DEBUG__.solveAll();
          const res = globalThis.__EXA_DEBUG__.results();
          return { n: list.length, answer: res[0] && res[0].answer, src: res[0] && res[0].source && res[0].source.kind, warn: res[0] && res[0].warn, tag: globalThis.__EXA_DEBUG__.ansTag(0) };
        }
      });
      return r[0].result;
    }, tabId);
    return out;`);

// 库外题：先清空结果再解
s = s.replace(
`  const miss = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        await globalThis.__EXA_DEBUG__.extract();
        await globalThis.__EXA_DEBUG__.solveAll();`,
`  const miss = await worker.evaluate(async tid => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: async () => {
        globalThis.__EXA_DEBUG__.clearResults();
        await globalThis.__EXA_DEBUG__.extract();
        await globalThis.__EXA_DEBUG__.solveAll();`);

fs.writeFileSync("tools/e2e-strict.mjs", s);
console.log("patched");
