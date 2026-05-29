# Tear down a dev worktree created by tools/new-session.ps1.
#
#   pwsh tools/remove-session.ps1 -Name bracket-ui
#   pwsh tools/remove-session.ps1 -Name bracket-ui -DeleteBranch
#   pwsh tools/remove-session.ps1 -Name bracket-ui -Force   # discard uncommitted changes
#
# Commit or push anything you want to keep first.

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
$parent = Split-Path $root -Parent
$slug = ($Name -replace '[^A-Za-z0-9._-]', '-').ToLower()
$dest = Join-Path $parent "goalden-$slug"
$branch = "session/$slug"

$removeArgs = @('worktree', 'remove', $dest)
if ($Force) { $removeArgs += '--force' }

git -C $root @removeArgs
if ($LASTEXITCODE -ne 0) { throw 'git worktree remove failed (uncommitted changes? re-run with -Force)' }

if ($DeleteBranch) {
  git -C $root branch -D $branch
}

Write-Host "+ Removed $dest" -ForegroundColor Green
