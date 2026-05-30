# Guarded reaper for dev worktrees. Removes only session/* worktrees that are
# SAFE to delete - working tree clean AND the branch has real commits beyond its
# recorded creation point (`base` in .worktree.json) that are all merged into
# origin/main. Skips anything dirty, unmerged, with no commits yet (tip == base),
# with no recorded base, the primary worktree, or the current dir. It never
# deletes unsaved, unmerged, or not-yet-started work - even after main advances.
#
#   gw reap            reap now
#   gw reap -DryRun    show what would be reaped, change nothing
#
# Wired as a SessionStart hook (-Auto) in .claude/settings.local.json so it
# runs when you open a session in the MAIN repo. No-ops in non-primary worktrees.

[CmdletBinding()]
param(
  [switch]$DryRun,
  # SessionStart hook mode: only print when something was actually removed.
  [switch]$Auto
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# Only act from the primary worktree (belt-and-suspenders for manual runs).
$commonDir = git -C $root rev-parse --path-format=absolute --git-common-dir
$top = git -C $root rev-parse --path-format=absolute --show-toplevel
$primaryTop = (Resolve-Path (Join-Path $commonDir '..')).Path
if ((Resolve-Path $top).Path -ne $primaryTop) {
  if (-not $Auto) { Write-Host 'gw reap: not in the primary worktree - nothing to do.' }
  return
}

# Refresh origin/main so the "merged" check is accurate (read-only network op).
try { git -C $root fetch --quiet origin main } catch {}

$current = (Get-Location).Path
$removed = @()
$skipped = @()

# Parse `git worktree list --porcelain` into path/branch records.
$entries = @()
$wt = $null
foreach ($line in (git -C $root worktree list --porcelain)) {
  if ($line -like 'worktree *') { $wt = @{ path = $line.Substring(9); branch = '' } }
  elseif ($line -like 'branch *') { $wt.branch = $line.Substring(7) -replace '^refs/heads/', '' }
  elseif ($line -eq '' -and $wt) { $entries += $wt; $wt = $null }
}
if ($wt) { $entries += $wt }

foreach ($e in $entries) {
  $path = $e.path
  $branch = $e.branch
  if ($branch -notlike 'session/*') { continue }                 # only our sessions
  $resolved = (Resolve-Path $path -ErrorAction SilentlyContinue)
  if (-not $resolved) { continue }
  if ($resolved.Path -eq $primaryTop) { continue }
  if ($resolved.Path -eq $current) { $skipped += "$branch (current dir)"; continue }

  if (git -C $path status --porcelain) { $skipped += "$branch (uncommitted changes)"; continue }

  # Need a recorded creation point to tell "no work yet" from "merged work".
  $base = $null
  $cfg = Join-Path $path '.worktree.json'
  if (Test-Path $cfg) { try { $base = (Get-Content $cfg -Raw | ConvertFrom-Json).base } catch {} }
  if (-not $base) { $skipped += "$branch (no recorded base - keeping to be safe)"; continue }
  if ((git -C $root rev-parse "$branch").Trim() -eq $base) { $skipped += "$branch (no commits yet)"; continue }

  $unmerged = (git -C $root rev-list "$branch" --not origin/main --count).Trim()
  if ($unmerged -ne '0') { $skipped += "$branch ($unmerged unmerged commit(s))"; continue }

  if ($DryRun) { $removed += "$branch  ->  would remove $path"; continue }

  try {
    git -C $root worktree remove $path
    # git worktree remove leaves the node_modules junction behind on Windows;
    # remove the link only (never its target), then the leftover directory.
    if (Test-Path $path) {
      $nm = Join-Path $path 'node_modules'
      if ((Test-Path $nm) -and ((Get-Item $nm -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { cmd /c rmdir "$nm" | Out-Null }
      Remove-Item $path -Recurse -Force
    }
    git -C $root branch -D $branch | Out-Null
    $removed += "$branch  (removed $path)"
  } catch {
    $skipped += "$branch (remove failed: $($_.Exception.Message))"
  }
}

# Tidy up the grouping folder if reaping emptied it.
if (-not $DryRun) {
  $wtRoot = Join-Path (Split-Path $root -Parent) 'goalden-worktrees'
  if ((Test-Path $wtRoot) -and -not (Get-ChildItem $wtRoot -Force)) { Remove-Item $wtRoot -Force }
}

# Report.
$header = if ($DryRun) { 'gw reap (dry run):' } else { 'gw reap:' }
if ($Auto) {
  if ($removed) {
    Write-Host $header -ForegroundColor Cyan
    $removed | ForEach-Object { Write-Host "  + $_" -ForegroundColor Green }
  }
} else {
  Write-Host $header -ForegroundColor Cyan
  if ($removed) { $removed | ForEach-Object { Write-Host "  + $_" -ForegroundColor Green } }
  if ($skipped) { $skipped | ForEach-Object { Write-Host "  - kept $_" -ForegroundColor DarkYellow } }
  if (-not $removed -and -not $skipped) { Write-Host '  (no session worktrees to reap)' }
}
