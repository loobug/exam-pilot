import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function findBrowser() {
  const candidates = [];
  const cacheDir = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  if (fs.existsSync(cacheDir)) {
    try {
      const dirs = fs.readdirSync(cacheDir).sort().reverse();
      for (const d of dirs) {
        candidates.push(path.join(cacheDir, d, 'chrome-win64', 'chrome.exe'));
      }
    } catch (e) { }
  }
  candidates.push(
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  );
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('未找到可用的 Chromium / Edge 浏览器用于加载扩展测试');
}
