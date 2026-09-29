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

$staging = Join-Path $dist (".package-staging-{0}" -f $PID)
try {
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $root "manifest.json") -Destination $staging
    Copy-Item -LiteralPath (Join-Path $root "background.js") -Destination $staging
    foreach ($directory in @("src", "popup", "assets", "_locales")) {
        Copy-Item -LiteralPath (Join-Path $root $directory) -Destination $staging -Recurse
    }
    $paths = Get-ChildItem -LiteralPath $staging | Select-Object -ExpandProperty FullName
    Compress-Archive -LiteralPath $paths -DestinationPath $archive -CompressionLevel Optimal
} finally {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output $archive
