/**
 * 本地 OCR（Tesseract.js，纯 WASM，不联网、不调 API）
 * 由 background 通过消息驱动：{ target:'offscreen', type:'ocr-text', dataUrl }
 */

let workerPromise = null;

function log(msg) {
  const el = document.getElementById('log');
  if (el) el.textContent = msg;
}

async function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const T = window.Tesseract;
    if (!T) throw new Error('Tesseract 未加载');
    log('正在初始化本地 OCR 引擎…');
    const w = await T.createWorker('chi_sim+eng', 1, {
      workerPath: chrome.runtime.getURL('vendor/tesseract/worker.min.js'),
      corePath: chrome.runtime.getURL('vendor/tesseract/'),
      langPath: chrome.runtime.getURL('vendor/tessdata'),
      gzip: false,
      workerBlobURL: false,
      cacheMethod: 'none',
      logger: m => {
        if (m && m.status) log(m.status + (m.progress != null ? ' ' + Math.round(m.progress * 100) + '%' : ''));
      }
    });
    log('本地 OCR 就绪');
    return w;
  })();
  return workerPromise;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;

  if (msg.type === 'ocr-text') {
    (async () => {
      const t0 = Date.now();
      try {
        const w = await getWorker();
        const ret = await w.recognize(msg.dataUrl);
        const text = (ret && ret.data && ret.data.text) || '';
        sendResponse({ ok: true, text, ms: Date.now() - t0 });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;   // 异步响应
  }

  if (msg.type === 'ocr-status') {
    (async () => {
      try {
        await getWorker();
        sendResponse({ ok: true, ready: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
});

/* 预热：页面一打开就开始加载引擎，第一次识别不用等太久 */
setTimeout(() => { getWorker().catch(() => { }); }, 200);
