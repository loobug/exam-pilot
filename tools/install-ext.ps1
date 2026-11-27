# 把 dist/ 下最新的 zip 同步到 extension/，作为「加载已解压的扩展程序」的装载目录
$ErrorActionPreference = 'Stop'

$root   = Split-Path -Parent $PSScriptRoot
$dist   = Join-Path $root 'dist'
$target = Join-Path $root 'extension'

$zip = Get-ChildItem $dist -Filter *.zip | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $zip) { throw "dist 下没有 zip 包，先执行 npm run pack" }

if (Test-Path $target) { Remove-Item $target -Recurse -Force }
New-Item -ItemType Directory -Force $target | Out-Null

# 优先用系统自带 tar（对 UTF-8 文件名更稳），失败再退回 Expand-Archive
$done = $false
try {
    & tar -xf $zip.FullName -C $target 2>$null
    if ($LASTEXITCODE -eq 0) { $done = $true }
} catch { }
if (-not $done) {
    Expand-Archive -Path $zip.FullName -DestinationPath $target -Force
}

$mf = Join-Path $target 'manifest.json'
if (-not (Test-Path $mf)) { throw "解压后没有 manifest.json，检查 zip 结构" }
$ver = (Get-Content $mf -Raw -Encoding utf8 | ConvertFrom-Json).version

Write-Host "已同步 $($zip.Name) -> $target"
Write-Host "版本 $ver，共 $((Get-ChildItem $target -Recurse -File).Count) 个文件"
Write-Host "在 chrome://extensions/ 里点该扩展的刷新按钮即可生效"
