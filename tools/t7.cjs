const fs = require("fs");
const p = "src/background.js";
let s = fs.readFileSync(p, "utf8");

s = s.replace(
`  // 2) 本地缓存（同一道题不重复花 token）`,
`  // 1.5) 严格模式：题库没收录就明确告知，不调用模型
  if (lookup.mode === "miss") {
    emit({ type: "status", text: "知识库未收录" });
    const msg = "严格模式开启：题库里没有精确匹配到这道题，已跳过模型调用，请人工作答或把题目存入知识库。";
    emit({ type: "thinking", text: msg });
    return {
      kind: q.kind,
      answer: "",
      reasoning: msg,
      confidence: 0,
      warn: "知识库未收录此题",
      source: { kind: "miss", hits: summarizeHits(lookup.hits || []) }
    };
  }

  // 2) 本地缓存（同一道题不重复花 token）`
);

fs.writeFileSync(p, s);
console.log("miss handled:", s.includes('knowledgebase miss') || s.includes('if (lookup.mode === "miss")'));
