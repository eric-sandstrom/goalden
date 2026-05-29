# Create an isolated dev worktree + branch with its own frontend port, so you
# can run several Claude Code / dev sessions on Goalden without clobbering each
# other's uncommitted work or fighting over :4200.
#
#   pwsh tools/new-session.ps1 -Name bracket-ui
#   pwsh tools/new-session.ps1 -Name hotfix -Port 4210
#   pwsh tools/new-session.ps1 -Name spike -LinkModules
#
# Creates ..\goalden-<Name> on branch session/<Name>, assigns a free port
# (recorded in the worktree's git-ignored .worktree.json so `npm start` picks
# it up automatically), and installs dependencies.
#
# NOTE: the Firebase emulator suite is shared. Run `npm run emulators` ONCE
# from the main repo; every worktree frontend talks to it over localhost.
# Do NOT run emulators in more than one worktree — they bind fixed ports.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Name,

  # Explicit port. 0 = auto-pick the next free port from 4200 up.
  [int]$Port = 0,

  # Branch name. Defaults to session/<Name>.
  [string]$Branch = '',

  # Junction node_modules from the main repo instead of a fresh install. Much
  # faster + saves disk, BUT `npm install <pkg>` in the worktree then mutates
  # the shared modules. Use only for read-only / short-lived sessions.
  [switch]$LinkModules
)

$ErrorActionPreference = 'Stop'

# This script lives in <root>/tools; resolve the main worktree root.
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$parent = Split-Path $root -Parent
$slug = ($Name -replace '[^A-Za-z0-9._-]', '-').ToLower()
$dest = Join-Path $parent "goalden-$slug"
if ($Branch -eq '') { $Branch = "session/$slug" }

if (Test-Path $dest) { throw "Destination already exists: $dest" }

# --- pick a port -------------------------------------------------------------
function Get-UsedPorts {
  $used = @()
  foreach ($line in (git -C $root worktree list --porcelain)) {
    if ($line -like 'worktree *') {
      $cfg = Join-Path $line.Substring(9) '.worktree.json'
      if (Test-Path $cfg) {
        try { $used += (Get-Content $cfg -Raw | ConvertFrom-Json).port } catch {}
      }
    }
  }
  return $used
}

if ($Port -eq 0) {
  $used = Get-UsedPorts
  $Port = 4200
  while ($used -contains $Port) { $Port++ }
}

Write-Host 'Creating worktree:' -ForegroundColor Cyan
Write-Host "  path   $dest"
Write-Host "  branch $Branch"
Write-Host "  port   $Port"

# --- create the worktree -----------------------------------------------------
git -C $root worktree add -b $Branch $dest
if ($LASTEXITCODE -ne 0) { throw 'git worktree add failed' }

# --- record the assigned port (git-ignored, per-worktree) --------------------
$cfgPath = Join-Path $dest '.worktree.json'
[ordered]@{ name = $slug; port = $Port; branch = $Branch } |
  ConvertTo-Json | Set-Content -Path $cfgPath -Encoding utf8

# --- dependencies ------------------------------------------------------------
if ($LinkModules) {
  Write-Host 'Linking node_modules (junction)...' -ForegroundColor Cyan
  New-Item -ItemType Junction -Path (Join-Path $dest 'node_modules') `
    -Target (Join-Path $root 'node_modules') | Out-Null
} else {
  Write-Host 'Installing dependencies (npm install)...' -ForegroundColor Cyan
  Push-Location $dest
  try { npm install } finally { Pop-Location }
}

Write-Host ''
Write-Host '+ Worktree ready.' -ForegroundColor Green
Write-Host 'Next:'
Write-Host "  cd `"$dest`""
Write-Host "  npm start            # serves on http://localhost:$Port"
Write-Host ''
Write-Host "Point a new Claude Code session at: $dest"
Write-Host '(Emulators: run `npm run emulators` once from the main repo only.)'
