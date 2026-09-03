$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json
$dist = Join-Path $root "dist"
$archive = Join-Path $dist ("ai-input-history-{0}.zip" -f $manifest.version)

& node (Join-Path $PSScriptRoot "validate.mjs")
if ($LASTEXITCODE -ne 0) { throw "扩展校验失败" }
& node (Join-Path $PSScriptRoot "validate-store.mjs")
if ($LASTEXITCODE -ne 0) { throw "商店素材校验失败" }

New-Item -ItemType Directory -Path $dist -Force | Out-Null
if (Test-Path -LiteralPath $archive) {
    Remove-Item -LiteralPath $archive -Force
}

$paths = @(
    (Join-Path $root "manifest.json"),
    (Join-Path $root "background.js"),
    (Join-Path $root "src"),
    (Join-Path $root "popup"),
    (Join-Path $root "assets"),
    (Join-Path $root "_locales")
)
Compress-Archive -LiteralPath $paths -DestinationPath $archive -CompressionLevel Optimal
Write-Output $archive
