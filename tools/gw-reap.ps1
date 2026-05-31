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

  # Merged into origin/main? Handles BOTH a normal/ff merge (branch is an ancestor)
  # AND a squash merge (this repo squash-merges, so the branch is NOT an ancestor;
  # instead check whether the branch's combined diff is already in main). The
  # squash test builds a virtual commit of the branch's tree on its merge-base and
  # asks `git cherry` if that patch is already applied to origin/main (a leading
  # '-' means yes). This is the standard squash-merge detection.
  $merged = $false
  git -C $root merge-base --is-ancestor "$branch" origin/main 2>$null
  if ($LASTEXITCODE -eq 0) {
    $merged = $true
  } else {
    $mb = (git -C $root merge-base origin/main "$branch" 2>$null)
    $tr = (git -C $root rev-parse "$branch^{tree}" 2>$null)
    if ($mb -and $tr) {
      $virt = (git -C $root commit-tree $tr.Trim() -p $mb.Trim() -m '_' 2>$null)
      if ($virt) {
        $cherry = git -C $root cherry origin/main $virt.Trim() 2>$null
        if (($cherry | Select-Object -First 1) -match '^-') { $merged = $true }
      }
    }
  }
  if (-not $merged) { $skipped += "$branch (unmerged - work not yet in origin/main)"; continue }

  if ($DryRun) { $removed += "$branch  ->  would remove $path"; continue }

  # Stop any dev server running IN this worktree (its cmdline contains the path),
  # otherwise it locks the directory and the removal is left half-done.
  $pb = ($path -replace '/', '\')
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like "*$pb*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  git -C $root worktree remove $path --force 2>$null
  # Delete the branch regardless of the dir-cleanup outcome (work is merged), so a
  # locked leftover can never orphan the branch.
  git -C $root branch -D $branch 2>$null
  # Best-effort dir cleanup: junction LINK only (never its target), then the dir.
  # If still locked (e.g. an open terminal), leave the husk; the sweep below
  # removes it on a later reap once the lock is gone.
  $note = ''
  if (Test-Path $path) {
    $nm = Join-Path $path 'node_modules'
    if ((Test-Path $nm) -and ((Get-Item $nm -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { cmd /c rmdir "$nm" | Out-Null }
    try { Remove-Item $path -Recurse -Force -ErrorAction Stop } catch { $note = ' (branch + git entry removed; leftover dir was locked, will sweep later)' }
  }
  $removed += "$branch  (removed)$note"
}

# Sweep husks left by earlier locked removals (dirs under goalden-worktrees that
# aren't registered worktrees), then drop the grouping folder if it's now empty.
if (-not $DryRun) {
  $wtRoot = Join-Path (Split-Path $root -Parent) 'goalden-worktrees'
  if (Test-Path $wtRoot) {
    $reg = @()
    foreach ($l in (git -C $root worktree list --porcelain)) {
      if ($l -like 'worktree *') { $rp = Resolve-Path $l.Substring(9) -ErrorAction SilentlyContinue; if ($rp) { $reg += $rp.Path } }
    }
    foreach ($d in (Get-ChildItem $wtRoot -Directory -Force)) {
      if ((Resolve-Path $d.FullName).Path -in $reg) { continue }       # a live worktree - leave it
      $nm = Join-Path $d.FullName 'node_modules'
      if ((Test-Path $nm) -and ((Get-Item $nm -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { cmd /c rmdir "$nm" | Out-Null }
      try { Remove-Item $d.FullName -Recurse -Force -ErrorAction Stop } catch {}   # still locked - try again next reap
    }
    if (-not (Get-ChildItem $wtRoot -Force)) { Remove-Item $wtRoot -Force }
  }
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
