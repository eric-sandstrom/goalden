# SessionStart hook (committed -> runs in every session, including worktrees).
# In a WORKTREE session it starts the frontend dev server on that worktree's
# port (unless already running) and prints guidance telling Claude to open the
# app in Playwright first. No-ops in the primary (main) worktree.
#
# MUST return fast: SessionStart blocks session init. The dev server is launched
# detached (its own minimized window), so this script returns immediately.

$ErrorActionPreference = 'SilentlyContinue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# Act only in a non-primary worktree.
$commonDir = git -C $root rev-parse --path-format=absolute --git-common-dir
$top = git -C $root rev-parse --path-format=absolute --show-toplevel
if (-not $commonDir -or -not $top) { exit 0 }
$primaryTop = (Resolve-Path (Join-Path $commonDir '..')).Path
if ((Resolve-Path $top).Path -eq $primaryTop) { exit 0 }

# Resolve this worktree's frontend port.
$port = $null
$cfg = Join-Path $top '.worktree.json'
if (Test-Path $cfg) { try { $port = (Get-Content $cfg -Raw | ConvertFrom-Json).port } catch {} }
if (-not $port) { exit 0 }

# Already serving on that port? (fast, non-blocking TCP probe)
$listening = $false
try {
  $client = New-Object Net.Sockets.TcpClient
  $iar = $client.BeginConnect('127.0.0.1', [int]$port, $null, $null)
  if ($iar.AsyncWaitHandle.WaitOne(300)) { $client.EndConnect($iar); $listening = $client.Connected }
  $client.Close()
} catch {}

if (-not $listening) {
  # Detached, minimized, its own window. cmd /c (not /k) so the window closes
  # when the server stops/is killed, releasing the dir lock cleanly at teardown.
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm start' -WorkingDirectory $top -WindowStyle Minimized | Out-Null
}

$state = if ($listening) { 'is already running' } else { 'is starting now (ng serve compiles in ~15s)' }
Write-Output "[goalden worktree session] Frontend dev server $state at http://localhost:$port"
Write-Output "Before other frontend work, open it in Playwright first: call browser_navigate to http://localhost:$port -- if it returns a connection error the server is still compiling, so wait a few seconds and retry."
exit 0
