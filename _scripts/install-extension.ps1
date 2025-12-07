# Install script for the controller extension
Write-Host "Cleaning old builds..." -ForegroundColor Cyan
Remove-Item -Path "*.vsix" -Force -ErrorAction SilentlyContinue

Write-Host "Building VSIX..." -ForegroundColor Cyan
npx vsce package

Write-Host "Installing extension..." -ForegroundColor Cyan
& "C:\Program Files\Microsoft VS Code\bin\code.cmd" --install-extension vscode-github-copilot-controller-0.0.1.vsix

Write-Host "`nDone! Reload VS Code to use the new version." -ForegroundColor Green
