param(
  [string]$OutputRoot = (Join-Path $PSScriptRoot 'release'),
  [string]$ExtensionVersion = '4.11.0',
  [string]$PluginVersion = '2.8.0'
)

$ErrorActionPreference = 'Stop'
$sourceExtension = Join-Path $PSScriptRoot 'linkedin-profile-audit-extension-2.1.1'
$sourcePlugin = Join-Path $sourceExtension 'codex-plugin\linkedin-profile-resume-sync'
$packageName = "Resume-Contract-Studio-extension-$ExtensionVersion-mcp-$PluginVersion"
$packageRoot = Join-Path $OutputRoot $packageName
$zipPath = "$packageRoot.zip"

if (Test-Path $packageRoot) { Remove-Item -LiteralPath $packageRoot -Recurse -Force }
if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

New-Item -ItemType Directory -Path (Join-Path $packageRoot 'browser-extension') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $packageRoot 'mcp-plugin\skills\linkedin-resume-sync') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $packageRoot 'mcp-plugin\.codex-plugin') -Force | Out-Null

$extensionFiles = @('manifest.json', 'background.js', 'linkedin_profile_audit_v2.user.js', 'INSTALL_EDGE_EXTENSION.md')
foreach ($file in $extensionFiles) {
  Copy-Item -LiteralPath (Join-Path $sourceExtension $file) -Destination (Join-Path $packageRoot "browser-extension\$file")
}

$pluginFiles = @('plugin.json', 'mcp.json', 'README.md', 'server.mjs')
foreach ($file in $pluginFiles) {
  Copy-Item -LiteralPath (Join-Path $sourcePlugin $file) -Destination (Join-Path $packageRoot "mcp-plugin\$file")
}
Copy-Item -LiteralPath (Join-Path $sourcePlugin '.codex-plugin\plugin.json') -Destination (Join-Path $packageRoot 'mcp-plugin\.codex-plugin\plugin.json') -Force
Copy-Item -LiteralPath (Join-Path $sourcePlugin 'skills\linkedin-resume-sync\SKILL.md') -Destination (Join-Path $packageRoot 'mcp-plugin\skills\linkedin-resume-sync\SKILL.md')

@"
# Resume Contract Studio

標準化套件：Edge 瀏覽器擴充功能 + Codex MCP Plugin。

## 安裝

1. 在 Edge 開啟 `edge://extensions/`，啟用開發人員模式，載入 `browser-extension/`。
2. 在 Codex 安裝或連接 `mcp-plugin/`。
3. 登入 LinkedIn，開啟個人檔案頁後再使用 MCP。

## 版本

- Browser extension: $ExtensionVersion
- MCP plugin: $PluginVersion

套件不包含個人履歷資料、登入資訊或使用者專屬 target JSON。
"@ | Set-Content -LiteralPath (Join-Path $packageRoot 'README.md') -Encoding UTF8

Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal
Write-Output $zipPath
