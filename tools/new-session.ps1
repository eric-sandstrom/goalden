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
# Do NOT run emulators in more than one worktree - they bind fixed ports.

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
$wtRoot = Join-Path $parent 'goalden-worktrees'
$dest = Join-Path $wtRoot $slug
if ($Branch -eq '') { $Branch = "session/$slug" }

if (Test-Path $dest) { throw "Destination already exists: $dest" }
if (-not (Test-Path $wtRoot)) { New-Item -ItemType Directory -Path $wtRoot -Force | Out-Null }

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

# --- base the new worktree on the latest main --------------------------------
# Fetch so we branch from up-to-date main even when work was merged via GitHub
# (origin advances but local main can lag). Offline: fall back to local refs.
git -C $root fetch origin main --quiet 2>$null
$baseRef = 'main'
$localMain = git -C $root rev-parse --verify -q main 2>$null
$originMain = git -C $root rev-parse --verify -q origin/main 2>$null
if ($originMain) {
  if (-not $localMain) {
    $baseRef = 'origin/main'
  } else {
    git -C $root merge-base --is-ancestor $localMain $originMain 2>$null
    if ($LASTEXITCODE -eq 0) {
      # origin/main is ahead of (or equal to) local main: branch from latest.
      $baseRef = 'origin/main'
      # Keep the hub current too: fast-forward local main when it is safe.
      if ($localMain -ne $originMain -and
          (git -C $root symbolic-ref --quiet --short HEAD) -eq 'main' -and
          -not (git -C $root status --porcelain)) {
        git -C $root merge --ff-only origin/main --quiet 2>$null
      }
    }
    # else: local main has commits origin lacks (unpushed/diverged) -> keep local main
  }
}

# Branch from the resolved commit, not the ref, so the session branch does NOT
# inherit origin/main as its upstream (which would muddle git status / push).
$baseSha = git -C $root rev-parse $baseRef 2>$null

Write-Host 'Creating worktree:' -ForegroundColor Cyan
Write-Host "  path   $dest"
Write-Host "  branch $Branch"
Write-Host "  base   $baseRef ($(git -C $root rev-parse --short $baseRef 2>$null))"
Write-Host "  port   $Port"

# --- create the worktree -----------------------------------------------------
git -C $root worktree add -b $Branch $dest $baseSha
if ($LASTEXITCODE -ne 0) { throw 'git worktree add failed' }

# --- record port + base commit (git-ignored, per-worktree) -------------------
# `base` is the commit the branch was created at; the reaper uses it to tell
# "no work done yet" (tip == base) from "finished, merged work" (tip moved on).
$base = (git -C $dest rev-parse HEAD).Trim()
$cfgPath = Join-Path $dest '.worktree.json'
[ordered]@{ name = $slug; port = $Port; branch = $Branch; base = $base } |
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
