# Adds a `gw` function to your PowerShell profile so you can launch isolated
# Goalden dev sessions from any terminal. Idempotent — safe to re-run (it
# replaces its own managed block, so it stays correct if the repo moves).
#
#   .\tools\install-gw.ps1
#
# Then open a NEW terminal (so PATH + profile reload) and:  gw bracket-ui

$ErrorActionPreference = 'Stop'

$gwScript = (Resolve-Path (Join-Path $PSScriptRoot 'gw.ps1')).Path
$marker = '# >>> goalden gw launcher >>>'
$endMarker = '# <<< goalden gw launcher <<<'
$block = @"
$marker
function gw { & "$gwScript" @args }
$endMarker
"@

# AllHosts so it loads in the console, Windows Terminal, ISE, and VS Code.
$profilePath = $PROFILE.CurrentUserAllHosts
$profileDir = Split-Path $profilePath -Parent
if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
if (-not (Test-Path $profilePath)) { New-Item -ItemType File -Path $profilePath | Out-Null }

$content = Get-Content $profilePath -Raw
if ($null -eq $content) { $content = '' }

if ($content -match [regex]::Escape($marker)) {
  $pattern = '(?s)' + [regex]::Escape($marker) + '.*?' + [regex]::Escape($endMarker)
  $content = [regex]::Replace($content, $pattern, $block.TrimEnd())
  Set-Content -Path $profilePath -Value $content -Encoding utf8
  Write-Host "Updated gw function in $profilePath" -ForegroundColor Green
} else {
  Add-Content -Path $profilePath -Value "`r`n$block" -Encoding utf8
  Write-Host "Added gw function to $profilePath" -ForegroundColor Green
}
Write-Host 'Open a NEW terminal, then run:  gw <name>'
