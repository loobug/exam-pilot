/**
 * 直接检查题库入库与检索：题干是否真的精确命中。
 * node tools/diag-kbkey.mjs
 */
import { normalizeQuestion } from '../src/lib/tokenize.js';
import { chunkDocument } from '../src/lib/chunker.js';

const KB = `1. 客户满意是服务人员最终价值体现，也是我们持续追求的目标。
A. 错误
B. 正确
答案：B
`;
const STEM = '客户满意是服务人员最终价值体现，也是我们持续追求的目标。';

const entries = chunkDocument(KB, 'kb-test.txt');
console.log('entries:', JSON.stringify(entries, null, 1));

const key = normalizeQuestion(STEM);
console.log('stem key:', key, key.length);
const hits = [];
console.log('hits-skip'); /* JSON.stringify(hits.map(h => ({
  exact: h.exact, score: h.score, cov: h.coverage,
  q: h.entry.question, ans: h.entry.answer, raw: h.entry.raw
})), null, 1)); */
