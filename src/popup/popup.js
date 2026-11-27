/* popup 逻辑 */
const $ = id => document.getElementById(id);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendToTab(tabId, msg) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, msg, res => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(res || { ok: true });
    });
  });
}

function setSub(text, cls) {
  $('sub').textContent = text;
  $('dot').className = 'dot' + (cls ? ' ' + cls : '');
}

function warn(text) {
  const box = $('warnbox');
  if (!text) { box.style.display = 'none'; box.textContent = ''; return; }
  box.style.display = 'block';
  box.textContent = text;
}

/** 当前页是否属于扩展够不着的类型 */
function pageProblem(tab) {
  const url = String((tab && tab.url) || '');
  if (/^chrome-extension:\/\/[a-p]{32}\/.*\.pdf/i.test(url) || /mhjfbmdgcfjbbpaeojofohoefgiehjai/.test(url)) {
    return '当前是浏览器内置 PDF 阅读器，扩展无法读取内容。请把 PDF 下载到本地，或把题目录入知识库。';
  }
  if (/\.pdf(\?|#|$)/i.test(url) && !/^https?:/i.test(url) === false && /^file:/i.test(url)) {
    return '这是本地 PDF 文件，内置阅读器里读不到题面。建议用 PDF 阅读器打开后选中文字，或导入知识库。';
  }
  if (/^(chrome|edge|about|chrome-extension|devtools):/i.test(url) && !/\.pdf/i.test(url)) {
    return '当前页面不允许扩展运行（chrome:// 、应用商店、扩展页面等），换到考试页面再试。';
  }
  if (/^https:\/\/chromewebstore\.google\.com/i.test(url)) {
    return '应用商店页面不允许扩展运行。';
  }
  return '';
}

async function ensureReady() {
  const tab = await activeTab();
  if (!tab || !tab.id) return { tab: null, error: '当前窗口没有可用标签页' };
  const ping = await sendToTab(tab.id, { type: 'exa-ping' });
  if (!ping.ok) {
    await chrome.runtime.sendMessage({ type: 'inject', tabId: tab.id });
    await new Promise(r => setTimeout(r, 260));
    const again = await sendToTab(tab.id, { type: 'exa-ping' });

    // 文件页需要用户手动打开「允许访问文件网址」
    if (!again.ok && /^file:/i.test(String(tab.url || ''))) {
      return { tab, error: 'file:// 页面需要先在扩展详情里打开「允许访问文件网址」，否则内容脚本无法注入。' };
    }
    if (!again.ok) {
      return { tab, error: '注入失败：' + (again.error || '该页面不允许扩展运行') };
    }
  }
  return { tab, error: '' };
}

async function loadSettings() {
  const r = await chrome.runtime.sendMessage({ type: 'getSettings' });
  if (!r || !r.ok) { setSub('后台未响应', 'err'); return; }
  const s = r.settings || {};

  $('model').textContent = s.model || '未配置';
  $('model').className = s.model ? 'ok' : 'bad';
  $('key').textContent = s.hasKey ? '已配置' : '未配置';
  $('key').className = s.hasKey ? 'ok' : 'bad';

  const n = r.kbEntries || 0;
  $('kb').textContent = n ? n + ' 条' : '空（建议导入题库）';
  $('kb').className = n ? 'ok' : 'bad';

  const ready = !!s.model && !!s.hasKey;
  const bits = [];
  if (s.kbStrict) bits.push('严格只用知识库');
  if (s.stealth === false) bits.push('面板常显');
  setSub((ready ? '已就绪' : '待配置模型与 Key') + (bits.length ? ' · ' + bits.join(' · ') : ''), ready ? '' : 'warn');

  if (!s.model || !s.hasKey) {
    warn('还没配置模型或 API Key，点下方「设置」填好就能用。');
  }
}

async function run(action) {
  const tab = await activeTab();
  const problem = pageProblem(tab);
  if (problem) { warn(problem); return; }

  const { tab: readyTab, error } = await ensureReady();
  if (error) { warn(error); return; }

  const map = {
    open: { type: 'cmd-toggle' },
    auto: { type: 'cmd-auto' }
  };
  const res = await sendToTab(readyTab.id, map[action]);
  if (!res.ok) { warn('操作失败：' + (res.error || '未知原因')); return; }
  if (action === 'open' || action === 'auto') window.close();
}

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  $('open').addEventListener('click', () => run('open'));
  $('auto').addEventListener('click', () => run('auto'));
  $('settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  // 快捷键提示：点击那句 hint 里的路径可直接跳到设置页
  $('hint').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    window.close();
  });
  $('hint').style.cursor = 'pointer';
});
