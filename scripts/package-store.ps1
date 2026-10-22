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
    # Compress-Archive on Windows writes backslash entry names, which are not
    # portable ZIP paths. Use '/' entries for Chrome Web Store and all unzip tools.
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::Open(
        $archive, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $files = Get-ChildItem -LiteralPath $staging -Recurse -File
        foreach ($file in $files) {
            $relative = $file.FullName.Substring($staging.Length).TrimStart('\', '/')
            $entry = $relative.Replace('\', '/')
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip, $file.FullName, $entry,
                [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally {
        $zip.Dispose()
    }
} finally {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output $archive
