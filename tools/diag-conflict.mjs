/** 直接验证 kb.search 的冲突检测 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findBrowser } from './find-browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const CHROME = findBrowser();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 120000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});

try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const extId = new URL(swT.url()).host;
  const opt = await browser.newPage();
  await opt.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });

  const KB = `1. “服务完成要确认”包括以下哪些环节？
A. 故障处理结果验证确认
B. 现场清理和复原
C. 服务签字确认或在线评价确认
D. 预留服务工程师名片
E. 强迫客户填写满意评价
答案：ABCD

2. “服务完成要确认”包括以下哪些环节？
A. 结果验证
B. 现场清理
C. 讲解与培训
D. 签字或评价
E. 预留名片
F. 服务结果反馈
答案：ABCDEF
`;

  const out = await opt.evaluate(async text => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'dup.txt', size: text.length, mime: 'text/plain', text });

    const Q = '“服务完成要确认”包括以下哪些环节？';

    // 1) 页面选项与第一条完全一致 → 应能分辨，不报冲突
    const fpA = ['故障处理结果验证确认', '现场清理和复原', '服务签字确认或在线评价确认', '预留服务工程师名片', '强迫客户填写满意评价'].sort().join('|');
    const r1 = await kb.search(Q, { exactQuestion: Q, pageFp: fpA, topK: 5 });

    // 2) 页面选项是中性文字 → 分不清，应报冲突
    const fpB = ['甲方说法', '乙方说法', '丙方说法', '丁方说法'].sort().join('|');
    const r2 = await kb.search(Q, { exactQuestion: Q, pageFp: fpB, topK: 5 });

    // 3) 完全没有选项指纹 → 应报冲突
    const r3 = await kb.search(Q, { exactQuestion: Q, topK: 5 });

    return {
      caseMatched: { n: r1.length, conflict: r1.__conflict || null, answer: r1[0] && r1[0].entry.answer },
      caseNeutral: { n: r2.length, conflict: r2.__conflict || null, answer: r2[0] && r2[0].entry.answer },
      caseNoFp: { n: r3.length, conflict: r3.__conflict || null }
    };
  }, KB);

  console.log(JSON.stringify(out, null, 1));

  const ok1 = !out.caseMatched.conflict;
  const ok2 = !!out.caseNeutral.conflict;
  const ok3 = !!out.caseNoFp.conflict;
  console.log(`\n${ok1 ? 'PASS' : 'FAIL'} 选项能匹配时不报冲突`);
  console.log(`${ok2 ? 'PASS' : 'FAIL'} 选项对不上时报冲突`);
  console.log(`${ok3 ? 'PASS' : 'FAIL'} 无选项指纹时报冲突`);

} catch (e) { console.error(e); }
finally { await browser.close(); }
