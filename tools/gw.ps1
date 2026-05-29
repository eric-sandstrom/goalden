# gw — launcher for isolated Goalden dev sessions (git worktree + own frontend
# port + auto-launch into Claude Code). Call it via the `gw` function added to
# your PowerShell profile (see tools/install-gw.ps1), or directly.
#
#   gw <name>            create worktree session/<name>, link deps, launch claude in it
#   gw <name> -Install   same, but a clean `npm install` instead of junctioning node_modules
#   gw <name> -Port 4210 pin the frontend port (default: next free from 4200)
#   gw list   (or ls)    show all worktrees and their assigned ports
#   gw reap [-DryRun]     remove finished worktrees (clean + merged into origin/main)
#   gw rm <name>          remove one worktree (add -DeleteBranch / -Force)

[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Command = '',
  [Parameter(Position = 1)][string]$Name = '',
  [int]$Port = 0,
  [switch]$Install,
  [switch]$DryRun,
  [switch]$DeleteBranch,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$toolsDir = $PSScriptRoot
$root = (Resolve-Path (Join-Path $toolsDir '..')).Path

function Show-Worktrees {
  Write-Host 'Worktrees:' -ForegroundColor Cyan
  $p = ''
  foreach ($line in (git -C $root worktree list --porcelain)) {
    if ($line -like 'worktree *') { $p = $line.Substring(9) }
    elseif ($line -like 'branch *') {
      $br = $line.Substring(7) -replace '^refs/heads/', ''
      $port = ''
      $cfg = Join-Path $p '.worktree.json'
      if (Test-Path $cfg) { try { $port = (Get-Content $cfg -Raw | ConvertFrom-Json).port } catch {} }
      $portTxt = if ($port) { " :$port" } else { '' }
      Write-Host ('  {0,-42} {1}{2}' -f $p, $br, $portTxt)
    }
  }
}

switch -Regex ($Command) {
  '^(reap)$' {
    & (Join-Path $toolsDir 'gw-reap.ps1') -DryRun:$DryRun
    break
  }
  '^(list|ls)$' {
    Show-Worktrees
    break
  }
  '^(rm|remove)$' {
    if ($Name -eq '') { throw 'Usage: gw rm <name> [-DeleteBranch] [-Force]' }
    & (Join-Path $toolsDir 'remove-session.ps1') -Name $Name -DeleteBranch:$DeleteBranch -Force:$Force
    break
  }
  '^$' {
    Write-Host 'Usage:'
    Write-Host '  gw <name>            new isolated session (worktree + port + launch claude)'
    Write-Host '  gw <name> -Install   new session with a clean npm install'
    Write-Host '  gw list              list worktrees + ports'
    Write-Host '  gw reap [-DryRun]    remove finished worktrees'
    Write-Host '  gw rm <name>         remove one worktree'
    break
  }
  default {
    # Anything else is treated as the new session name.
    $sessionName = $Command
    $newArgs = @{ Name = $sessionName }
    if ($Port -ne 0) { $newArgs.Port = $Port }
    if (-not $Install) { $newArgs.LinkModules = $true }
    & (Join-Path $toolsDir 'new-session.ps1') @newArgs

    $parent = Split-Path $root -Parent
    $slug = ($sessionName -replace '[^A-Za-z0-9._-]', '-').ToLower()
    $dest = Join-Path $parent "goalden-$slug"

    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
      Write-Host ''
      Write-Host 'claude is not on PATH in this terminal yet (open a NEW terminal after install).' -ForegroundColor Yellow
      Write-Host "Then: cd `"$dest`"; claude"
      break
    }
    Write-Host ''
    Write-Host "Launching claude in $dest ..." -ForegroundColor Green
    Set-Location $dest
    & claude
  }
}
