/** 验证这三道题能否被知识库命中 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';

const CASES = [
  '出发时间应提前 1 小时根据约定时间和路程确定，确保比约定时间提前 5–10 分钟到达。',
  '项目收尾阶段要重点关注哪些事项？',
  '项目启动阶段要重点注意哪些事项？'
];

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: [`--disable-extensions-except=${ROOT}\\extension`, `--load-extension=${ROOT}\\extension`, '--no-first-run']
});

try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await sw.worker();
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      settings: {
        baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', visionModel: '',
        temperature: 0.2, maxTokens: 512, timeoutSec: 10, doubleCheck: false, autoFillAfterSolve: false,
        extraHeaders: '', systemPrompt: '', kbEnabled: true, kbDirect: true, kbTopK: 3,
        kbMinCoverage: 0.65, cacheEnabled: false, skipAnswered: true, concurrency: 1,
        followMode: false, stealth: false
      }
    });
  });

  const extId = new URL(sw.url()).host;
  const page = await browser.newPage();
  await page.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });

  const text = fs.readFileSync(ROOT + '\\demo\\kb-sangfor.txt', 'utf8');
  const out = await page.evaluate(async (args) => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    await kb.clearAll();
    const add = await kb.addDocument({ name: 'kb-sangfor.txt', size: args.text.length, mime: 'text/plain', text: args.text });
    const results = [];
    for (const q of args.cases) {
      const rows = await kb.search(q, { topK: 3 });
      const first = (rows || [])[0];
      results.push({
        q: q.slice(0, 34),
        keys: first && first.entry ? Object.keys(first.entry) : [],
        raw: first && first.entry ? String(first.entry.raw || "").slice(0, 220) : "",
        n: (rows || []).length,
        exactHit: (rows || []).some(x => x.exact),
        hits: (rows || []).slice(0, 3).map(h => ({
          key: String(h.entry && h.entry.question || "").slice(0, 34),
          answer: h.entry && h.entry.answer,
          exact: !!h.exact,
          coverage: h.coverage != null ? Number(h.coverage.toFixed(3)) : null,
          score: h.score != null ? Number(h.score.toFixed(2)) : null
        }))
      });
    }
    return { add: add.entryCount, total: (await kb.stats()).entries, results };
  }, { text, cases: CASES });

  console.log('知识库条目：', out.total, '（文档新增', out.add, '）\n');
  out.results.forEach(r => {
    console.log('题干：' + r.q + '…');
    console.log('  返回条数 =', r.n, ' exact命中 =', r.exactHit);
    console.log('  entry keys =', JSON.stringify(r.keys));
    console.log('  raw =', JSON.stringify(r.raw));
    (r.hits || []).forEach(h => console.log(`  命中：${h.key}… | answer=${h.answer} | coverage=${h.coverage} score=${h.score}`));
    console.log('');
  });

} finally {
  await browser.close();
}
