# Idempotent Windows + WSL2 installer for TAKT-UI-CC.
# Run from a normal PowerShell window after Ubuntu has completed its first-run user setup.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SshKey,

  [Parameter(Mandatory = $true)]
  [string]$SshHost,

  [Parameter(Mandatory = $true)]
  [string]$SshUser,

  [string]$SshAlias = 'takt-vps',
  [string]$Distro = 'Ubuntu',
  [string]$RepoUrl = 'https://github.com/willwill85/TAKT-UI-CC.git',
  [string]$Branch = 'main',
  [string]$InstallDir = 'TAKT-UI-CC',
  [string]$RemoteWorkDir = '',
  [string]$NodeName = 'VPS',
  [string]$NodeBadge = 'VPS',
  [string]$LocalWorkAlias = 'work',
  [switch]$SkipRemoteBootstrap,
  [switch]$NoOpenBrowser,
  [switch]$Plan
)

$ErrorActionPreference = 'Stop'

function Assert-Matches([string]$Name, [string]$Value, [string]$Pattern) {
  if ($Value -notmatch $Pattern) {
    throw "$Name contains unsupported characters: $Value"
  }
}

if ($env:OS -ne 'Windows_NT') {
  throw 'This installer must run in Windows PowerShell, not inside WSL.'
}
Assert-Matches 'SshAlias' $SshAlias '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
Assert-Matches 'SshHost' $SshHost '^[^\s\r\n]+$'
Assert-Matches 'SshUser' $SshUser '^[A-Za-z_][A-Za-z0-9._-]*$'
Assert-Matches 'Distro' $Distro '^[A-Za-z0-9][A-Za-z0-9._-]*$'
Assert-Matches 'Branch' $Branch '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
Assert-Matches 'InstallDir' $InstallDir '^[A-Za-z0-9][A-Za-z0-9._-]*$'
Assert-Matches 'LocalWorkAlias' $LocalWorkAlias '^[A-Za-z0-9][A-Za-z0-9_-]*$'
Assert-Matches 'NodeBadge' $NodeBadge '^[A-Za-z0-9_-]{1,8}$'
if ($RepoUrl -match '[\s\r\n]' -or $NodeName -match '[\r\n]') {
  throw 'RepoUrl and NodeName must not contain line breaks; RepoUrl must not contain whitespace.'
}
if ($RemoteWorkDir -and $RemoteWorkDir -notmatch '^/[^\r\n]*$') {
  throw 'RemoteWorkDir must be an absolute Linux path.'
}
if (-not (Test-Path -LiteralPath $SshKey -PathType Leaf)) {
  throw "SSH key not found: $SshKey"
}
$resolvedKey = (Resolve-Path -LiteralPath $SshKey).Path

Write-Host '== TAKT-UI-CC Windows installer ==' -ForegroundColor Green
Write-Host "WSL distribution : $Distro"
Write-Host "Repository        : $RepoUrl ($Branch)"
Write-Host "WSL install path  : ~/$InstallDir"
Write-Host "SSH target        : $SshAlias ($SshUser@$SshHost)"
Write-Host "SSH key           : $([IO.Path]::GetFileName($resolvedKey))"
if ($Plan) {
  Write-Host 'Plan only: no files, packages, SSH configuration, or services were changed.' -ForegroundColor Yellow
  exit 0
}

$wslCommand = Get-Command wsl.exe -ErrorAction SilentlyContinue
if (-not $wslCommand) {
  throw 'WSL is unavailable. In an elevated PowerShell run: wsl --install -d Ubuntu; reboot; open Ubuntu once; then rerun this installer.'
}

$distros = @(& wsl.exe --list --quiet 2>$null) | ForEach-Object { $_.ToString().Trim([char]0).Trim() } | Where-Object { $_ }
if ($distros -notcontains $Distro) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($isAdmin) {
    Write-Host "Installing WSL distribution '$Distro'..." -ForegroundColor Yellow
    & wsl.exe --install -d $Distro
    throw 'WSL installation was started. Reboot if requested, open Ubuntu once to create its Linux user, then rerun the same installer command.'
  }
  throw "WSL distribution '$Distro' is not installed. In an elevated PowerShell run: wsl --install -d $Distro"
}

$kernel = (& wsl.exe -d $Distro -- uname -r 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $kernel -notmatch '(?i)microsoft.*wsl2') {
  throw "'$Distro' is not running as WSL2. Run: wsl --set-version $Distro 2"
}

$wslKey = (& wsl.exe -d $Distro -- wslpath -a -u $resolvedKey 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $wslKey) {
  throw 'Could not map the Windows SSH key path into WSL.'
}

$bashInstaller = @'
#!/usr/bin/env bash
set -euo pipefail

key_source="$1"
ssh_host="$2"
ssh_user="$3"
ssh_alias="$4"
repo_url="$5"
branch="$6"
install_name="$7"
remote_work="$8"
node_name="$9"
node_badge="${10}"
local_alias="${11}"
skip_remote_bootstrap="${12}"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
step() { printf '\n\033[32m== %s ==\033[0m\n' "$*"; }

if [ "$remote_work" = '__AUTO__' ]; then remote_work=''; fi
if [ ! -f "$key_source" ]; then echo "SSH key is not readable from WSL" >&2; exit 1; fi

sudo_cmd=()
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || { echo 'sudo is required inside WSL' >&2; exit 1; }
  yellow 'WSL may ask for the Linux user password to install packages.'
  sudo -v
  sudo_cmd=(sudo)
fi

step 'Installing WSL dependencies'
"${sudo_cmd[@]}" env DEBIAN_FRONTEND=noninteractive apt-get update -y
"${sudo_cmd[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  build-essential ca-certificates curl git lsof openssh-client perl python3 syncthing tmux

node_ok=0
if command -v node >/dev/null 2>&1; then
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' \
    >/dev/null 2>&1 && node_ok=1
fi
if [ "$node_ok" -ne 1 ]; then
  step 'Installing Node.js 22'
  node_setup="$(mktemp /tmp/takt-nodesource.XXXXXX)"
  trap 'rm -f "$node_setup"' EXIT
  curl -fsSL https://deb.nodesource.com/setup_22.x -o "$node_setup"
  "${sudo_cmd[@]}" bash "$node_setup"
  "${sudo_cmd[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'

step 'Installing or updating TAKT-UI-CC'
repo_dir="$HOME/$install_name"
if [ -e "$repo_dir" ] && [ ! -d "$repo_dir/.git" ]; then
  echo "$repo_dir exists but is not a Git checkout" >&2
  exit 1
fi
if [ -d "$repo_dir/.git" ]; then
  if [ -n "$(git -C "$repo_dir" status --porcelain)" ]; then
    echo "$repo_dir has local changes; commit or stash them before rerunning the installer" >&2
    exit 1
  fi
  git -C "$repo_dir" remote set-url origin "$repo_url"
  git -C "$repo_dir" fetch --prune origin "$branch"
  if git -C "$repo_dir" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$repo_dir" switch "$branch"
  else
    git -C "$repo_dir" switch --track -c "$branch" "origin/$branch"
  fi
  git -C "$repo_dir" merge --ff-only "origin/$branch"
else
  git clone --branch "$branch" --single-branch "$repo_url" "$repo_dir"
fi

step 'Configuring the WSL SSH client'
install -d -m 700 "$HOME/.ssh"
key_dest="$HOME/.ssh/takt-${ssh_alias}.key"
install -m 600 "$key_source" "$key_dest"
config="$HOME/.ssh/config"
touch "$config"
chmod 600 "$config"
begin="# BEGIN TAKT:$ssh_alias"
end="# END TAKT:$ssh_alias"
config_tmp="$(mktemp "$HOME/.ssh/config.XXXXXX")"
awk -v begin="$begin" -v end="$end" '
  $0 == begin { skip=1; next }
  $0 == end { skip=0; next }
  !skip { print }
' "$config" > "$config_tmp"
cat >> "$config_tmp" <<EOF

$begin
Host $ssh_alias
    HostName $ssh_host
    User $ssh_user
    IdentityFile $key_dest
    IdentitiesOnly yes
    ServerAliveInterval 30
    ServerAliveCountMax 3
$end
EOF
chmod 600 "$config_tmp"
mv -f "$config_tmp" "$config"

step 'Testing SSH key authentication'
ssh_result="$(ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "$ssh_alias" 'printf TAKT_SSH_OK')"
[ "$ssh_result" = 'TAKT_SSH_OK' ] || { echo 'SSH key authentication failed' >&2; exit 1; }
green 'SSH key authentication succeeded.'

if [ "$skip_remote_bootstrap" != '1' ]; then
  step 'Checking remote Linux dependencies'
  ssh "$ssh_alias" 'bash -s' < "$repo_dir/scripts/remote-bootstrap.sh"
fi
if ! ssh "$ssh_alias" 'command -v claude >/dev/null 2>&1'; then
  yellow 'Claude Code is not installed for this SSH user. Install and log in on the VPS before starting a conversation.'
fi
if [ -z "$remote_work" ]; then
  remote_home="$(ssh "$ssh_alias" 'printf "%s" "$HOME"')"
  remote_work="${remote_home%/}/work"
fi

step 'Installing and starting the local workbench'
cd "$repo_dir"
bash scripts/install.sh
bash scripts/start.sh

step 'Registering the VPS and isolated MCP tunnel'
payload="$(python3 - "$ssh_alias" "$remote_work" "$node_name" "$node_badge" "$local_alias" <<'PY'
import json, sys
ssh_alias, remote_work, node_name, node_badge, local_alias = sys.argv[1:]
print(json.dumps({
    "id": "node-1",
    "name": node_name,
    "badge": node_badge,
    "sshHost": ssh_alias,
    "remoteWorkDir": remote_work,
    "localWorkAlias": local_alias,
    "syncthingFolderId": "takt-" + local_alias,
    "enabled": True,
}))
PY
)"
response="$(curl -fsS --max-time 90 -X POST \
  -H 'Content-Type: application/json' \
  --data-binary "$payload" \
  http://127.0.0.1:3080/api/nodes)"
python3 - "$response" <<'PY'
import json, sys
data = json.loads(sys.argv[1])
if not data.get("ok"):
    raise SystemExit(data.get("error") or "node provisioning failed")
for line in data.get("logs") or []:
    print("  " + line)
PY

step 'Health check'
npm run doctor
printf '\nTAKT_REPO=%s\nTAKT_URL=http://127.0.0.1:3080\n' "$repo_dir"
'@

$tempScript = Join-Path ([IO.Path]::GetTempPath()) ("takt-windows-install-{0}.sh" -f [Guid]::NewGuid().ToString('N'))
$utf8NoBom = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText($tempScript, $bashInstaller, $utf8NoBom)
try {
  $wslTempScript = (& wsl.exe -d $Distro -- wslpath -a -u $tempScript 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $wslTempScript) {
    throw 'Could not map the temporary installer into WSL.'
  }
  $remoteWorkArgument = if ($RemoteWorkDir) { $RemoteWorkDir } else { '__AUTO__' }
  $skipArgument = if ($SkipRemoteBootstrap) { '1' } else { '0' }
  $wslArguments = @(
    '-d', $Distro, '--', 'bash', $wslTempScript,
    $wslKey, $SshHost, $SshUser, $SshAlias, $RepoUrl, $Branch, $InstallDir,
    $remoteWorkArgument, $NodeName, $NodeBadge, $LocalWorkAlias, $skipArgument
  )
  & wsl.exe @wslArguments
  if ($LASTEXITCODE -ne 0) {
    throw "WSL installer failed with exit code $LASTEXITCODE. Review the last error above and rerun the same command after correcting it."
  }
} finally {
  Remove-Item -LiteralPath $tempScript -Force -ErrorAction SilentlyContinue
}

$desktop = [Environment]::GetFolderPath('Desktop')
$launcherPath = Join-Path $desktop 'Start-TAKT.cmd'
$launcher = @"
@echo off
wsl.exe -d $Distro -- bash -lc "cd ~/$InstallDir && bash scripts/start.sh"
if errorlevel 1 (
  pause
  exit /b 1
)
start "" "http://127.0.0.1:3080"
"@
[IO.File]::WriteAllText($launcherPath, $launcher, [Text.Encoding]::ASCII)
Write-Host "Created launcher: $launcherPath" -ForegroundColor Green
Write-Host 'Installation complete: http://127.0.0.1:3080' -ForegroundColor Green
if (-not $NoOpenBrowser) {
  Start-Process 'http://127.0.0.1:3080'
}
