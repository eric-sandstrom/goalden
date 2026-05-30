# Tear down a dev worktree created by tools/new-session.ps1.
#
#   pwsh tools/remove-session.ps1 -Name bracket-ui
#   pwsh tools/remove-session.ps1 -Name bracket-ui -DeleteBranch
#   pwsh tools/remove-session.ps1 -Name bracket-ui -Force   # discard uncommitted changes
#
# Commit or push anything you want to keep first. The worktree path is looked
# up from git, so this works regardless of folder layout (grouped or flat).

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Name,

  # Also delete the session/<Name> branch after removing the worktree.
  [switch]$DeleteBranch,

  # Remove even if the worktree has uncommitted/untracked changes.
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$slug = ($Name -replace '[^A-Za-z0-9._-]', '-').ToLower()
$branch = "session/$slug"

# Resolve the worktree path from git (handles grouped or flat layouts).
$dest = $null
$p = ''
foreach ($line in (git -C $root worktree list --porcelain)) {
  if ($line -like 'worktree *') { $p = $line.Substring(9) }
  elseif ($line -like 'branch *') {
    if (($line.Substring(7) -replace '^refs/heads/', '') -eq $branch) { $dest = $p }
  }
}
if (-not $dest) { throw "No worktree found for branch $branch" }

# Stop any dev server running IN this worktree (its cmdline contains the path),
# otherwise it locks the directory and removal is left half-done.
$pb = ($dest -replace '/', '\')
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like "*$pb*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$removeArgs = @('worktree', 'remove', $dest)
if ($Force) { $removeArgs += '--force' }

git -C $root @removeArgs
if ($LASTEXITCODE -ne 0) { throw 'git worktree remove failed (uncommitted changes? re-run with -Force)' }

if ($DeleteBranch) {
  git -C $root branch -D $branch
}

# `git worktree remove` leaves Windows junctions (our node_modules) behind, so
# the directory lingers. Remove the junction LINK only (never its target), then
# the now junction-free directory.
if (Test-Path $dest) {
  $nm = Join-Path $dest 'node_modules'
  if ((Test-Path $nm) -and ((Get-Item $nm -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    cmd /c rmdir "$nm" | Out-Null
  }
  try { Remove-Item $dest -Recurse -Force -ErrorAction Stop }
  catch { Write-Host "Note: removed from git, but the folder is still locked (close any terminal/editor open there); 'gw reap' will sweep it later." -ForegroundColor Yellow }
}

# Tidy up the grouping folder if it's now empty.
$wtRoot = Join-Path (Split-Path $root -Parent) 'goalden-worktrees'
if ((Test-Path $wtRoot) -and -not (Get-ChildItem $wtRoot -Force)) { Remove-Item $wtRoot -Force }

Write-Host "+ Removed $dest" -ForegroundColor Green
