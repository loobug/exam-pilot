/** 打包产物与装载目录一致性 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = 'D:\\labs\\0exam';
const pkgForZip = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const zipName = (pkgForZip.scripts.pack.match(/exam-helper-[\d.]+\.zip/) || [])[0];
const zip = path.join(ROOT, 'dist', zipName || 'exam-helper-1.0.11.zip');
const tmp = path.join(ROOT, '.tmp-zipcheck');

const problems = [];
const ok = [];

if (!fs.existsSync(zip)) {
  console.log('✗ 找不到安装包 ' + zip);
  process.exit(1);
}

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
execFileSync('tar', ['-xf', zip, '-C', tmp], { stdio: 'pipe' });

const walk = (dir, base = '') => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, rel));
    else out.push(rel);
  }
  return out;
};

const zipFiles = walk(tmp).sort();
const extFiles = walk(path.join(ROOT, 'extension')).sort();

ok.push('zip 内文件 ' + zipFiles.length + ' 个');
ok.push('装载目录文件 ' + extFiles.length + ' 个');

const onlyZip = zipFiles.filter(f => !extFiles.includes(f));
const onlyExt = extFiles.filter(f => !zipFiles.includes(f));
if (onlyZip.length) problems.push('zip 多出: ' + onlyZip.slice(0, 6).join(', '));
if (onlyExt.length) problems.push('装载目录多出: ' + onlyExt.slice(0, 6).join(', '));

let diffCount = 0;
for (const f of zipFiles) {
  if (!extFiles.includes(f)) continue;
  const a = fs.readFileSync(path.join(tmp, f));
  const b = fs.readFileSync(path.join(ROOT, 'extension', f));
  if (!a.equals(b)) { diffCount++; if (diffCount <= 5) problems.push('内容不同: ' + f); }
}
if (!diffCount) ok.push('所有同名文件内容逐字节一致');

// 关键文件必须在包里
['manifest.json', 'src/background.js', 'src/content/content.js', 'src/content/extract.js',
  'src/content/fill.js', 'src/content/overlay.js', 'src/lib/kb.js', 'src/lib/chunker.js',
  'src/options/options.html', 'src/popup/popup.html'].forEach(f => {
    if (!zipFiles.includes(f)) problems.push('安装包缺少 ' + f);
  });
ok.push('关键文件齐备');

// 版本一致性
const zipManifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const srcManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
if (zipManifest.version !== srcManifest.version) problems.push('zip 版本 ' + zipManifest.version + ' ≠ 源码 ' + srcManifest.version);
if (!pkg.scripts.pack.includes(zipManifest.version)) problems.push('package.json 打包目标版本不一致');
ok.push('版本 ' + zipManifest.version + ' 三处一致');

// 文档与题库文件
['README.md', 'docs/kb-sangfor.txt'].forEach(f => {
  if (!fs.existsSync(path.join(ROOT, f))) problems.push('缺少 ' + f);
});
ok.push('README 与题库文件就位');

fs.rmSync(tmp, { recursive: true, force: true });

console.log('=== 打包一致性 ===');
ok.forEach(o => console.log('  ✓ ' + o));
problems.forEach(p => console.log('  ✗ ' + p));
console.log('\n结论：' + (problems.length ? problems.length + ' 项问题' : '全部通过'));
if (problems.length) process.exit(1);
