# One command on Windows:  powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Say($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)  { Write-Host "    ok  $m" -ForegroundColor Green }

Say "Installing dependencies"; npm install --no-audit --no-fund --silent
Say "Vendoring three.js";      npm run --silent vendor
Say "Compiling";               npm run --silent compile
Say "Render smoke test";       npm run --silent test
Say "Packaging"
Remove-Item *.vsix -ErrorAction SilentlyContinue
npx --yes @vscode/vsce@3.9.2 package --allow-missing-repository
$vsix = (Get-ChildItem *.vsix | Select-Object -First 1).Name
Ok $vsix
if (Get-Command code -ErrorAction SilentlyContinue) {
  Say "Installing into VS Code"
  code --install-extension $vsix --force
  Write-Host "`nDone. Restart VS Code and open examples\policy-net.netgraph.json" -ForegroundColor Green
} else {
  Write-Host "`nVS Code CLI not found. Run: code --install-extension $vsix" -ForegroundColor Yellow
}
