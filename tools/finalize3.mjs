import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
manifest.version = '1.0.4';
fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n');

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.scripts['test:auto'] = 'node tools/e2e-auto.mjs';
pkg.scripts['test:all'] = 'node tools/e2e.mjs && node tools/e2e-kb.mjs && node tools/e2e-opt.mjs && node tools/e2e-site.mjs && node tools/e2e-auto.mjs';
pkg.scripts.pack = 'powershell -NoProfile -Command "Compress-Archive -Path manifest.json,src,icons,docs,vendor,README.md -DestinationPath dist/exam-helper-1.0.4.zip -Force"';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');

console.log('manifest', manifest.version, '| pack target', pkg.scripts.pack.match(/exam-helper-[\d.]+\.zip/)[0]);
