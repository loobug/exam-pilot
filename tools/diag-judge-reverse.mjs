/** 复现：这道判断题为什么答反 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const ROOT = 'D:\\labs\\0exam';
const CHROME = 'C:\\Users\\nonb\\.cache\\puppeteer\\chrome\\win64-157.0.8103.50\\chrome-win64\\chrome.exe';

const STEM = '客户满意是服务人员最终价值体现，不满意的服务不会带来价值。';
// 模拟用户页面：选项被打乱成 A=错误 B=正确
const PAGE_OPTS = [{ label: 'A', text: '错误' }, { label: 'B', text: '正确' }];

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: [`--disable-extensions-except=${ROOT}\\extension`, `--load-extension=${ROOT}\\extension`, '--no-first-run']
});

try {
  const sw = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
  const worker = await sw.worker();
  const extId = new URL(sw.url()).host;

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

  const page = await browser.newPage();
  await page.goto('chrome-extension://' + extId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  const text = fs.readFileSync(ROOT + '\\demo\\kb-sangfor.txt', 'utf8');

  const out = await page.evaluate(async args => {
    const kb = await import(chrome.runtime.getURL('src/lib/kb.js'));
    const tk = await import(chrome.runtime.getURL('src/lib/tokenize.js'));
    await kb.clearAll();
    await kb.addDocument({ name: 'kb-sangfor.txt', size: args.text.length, mime: 'text/plain', text: args.text });

    const pageText = args.opts.map(o => o.label + '. ' + o.text).join(' ');
    const pageFp = tk.optionsFingerprint(pageText);
    const r = await kb.search(args.stem, { topK: 3, exactQuestion: args.stem, pageFp });
    const rows = (r || []).map(x => ({
      q: String(x.entry.question).slice(0, 40),
      a: String(x.entry.answer),
      exact: !!x.exact,
      cov: x.coverage != null ? Number(x.coverage.toFixed(2)) : null,
      score: x.score != null ? Number(x.score) : null,
      raw: String(x.entry.raw).slice(0, 120),
      optFp: String(x.entry.optFp || '').slice(0, 40)
    }));

    // 模拟 background 的映射
    const top = (r || [])[0];
    let remap = null;
    if (top) {
      const letters = String(top.entry.answer || '').match(/[A-H]/g) || [];
      const kbOpts = {};
      const body = String(top.entry.raw || '').split(/答案\s*[:：]/)[0];
      const re = /(?:^|[\s。；;])([A-H])\s*[.、,，:：)）．]\s*([\s\S]*?)(?=\s+[A-H]\s*[.、,，:：)）．]\s|[\s]*$)/g;
      let m;
      while ((m = re.exec(body))) { if (!kbOpts[m[1]]) kbOpts[m[1]] = m[2].trim(); }
      const texts = [];
      const outLetters = [];
      for (const L of letters) {
        const t = kbOpts[L];
        const hit = args.opts.find(o => o.text.trim() === String(t || '').trim());
        if (hit) { outLetters.push(hit.label); texts.push(hit.text); }
      }
      remap = { letters: outLetters.sort().join(''), texts, kbOpts };
    }

    return { pageFp, rows, remap, normStem: tk.normalizeQuestion ? tk.normalizeQuestion(args.stem) : null };
  }, { text, stem: STEM, opts: PAGE_OPTS });

  console.log('页面选项:', JSON.stringify(PAGE_OPTS), ' pageFp=', out.pageFp);
  console.log('normalizeQuestion:', JSON.stringify(out.normStem));
  console.log('\n检索结果:');
  out.rows.forEach((r, i) => {
    console.log(`  [${i}] exact=${r.exact} cov=${r.cov} score=${r.score} answer=${r.a} optFp=${r.optFp}`);
    console.log(`      q=${r.q}`);
    console.log(`      raw=${r.raw}`);
  });
  console.log('\n映射结果:', JSON.stringify(out.remap, null, 1));

} finally {
  await browser.close();
}
