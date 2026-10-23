#!/usr/bin/env bash
# TAKT-UI-CC — Immortal Native SSH Terminal Session Launcher
# Usage: native-ssh-session.sh <tab-id> <remote-cwd> <ssh-host>
# Completely isolated from ControlMaster & RemoteForward ports (ClearAllForwardings=yes)
# Backed by remote transparent tmux persistence + automatic network-drop recovery (exit 255).

TAB_ID="${1:-default}"
TARGET_CWD="${2:-/root/work}"
SSH_HOST="${3:-${TAKT_SSH_HOST:-}}"

if [ -z "$SSH_HOST" ]; then
  printf "\r\n[TAKT] 此节点还没有绑定 SSH Host。\r\n点击左上角「节点」按钮，填入 ~/.ssh/config 中的主机别名（如 my-server）后重试。\r\n"
  exec bash -l
fi

# Escape single quotes so a folder name can never break out of the remote command string
TARGET_CWD_Q="$(printf '%s' "$TARGET_CWD" | sed "s/'/'\\\\''/g")"

# Sanitize tmux session name
SAFE_ID="$(echo "$TAB_ID" | tr -cd 'a-zA-Z0-9_-' | cut -c1-28)"
[ -z "$SAFE_ID" ] && SAFE_ID="main"
TMUX_SESS="takt_${SAFE_ID}"

export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"
export TERM="xterm-256color"
export COLORTERM="truecolor"

REMOTE_SCRIPT="export PATH=\"\$HOME/.local/bin:\$HOME/.npm-global/bin:/usr/local/bin:\$PATH\"; CWD='${TARGET_CWD_Q}'; if ! mkdir -p \"\$CWD\" 2>/dev/null || ! cd \"\$CWD\" 2>/dev/null; then if [ -d \"\$HOME/Documents/work\" ]; then CWD=\"\$HOME/Documents/work\"; else CWD=\"\$HOME/work\"; mkdir -p \"\$CWD\" 2>/dev/null || CWD=\"\$HOME\"; fi; cd \"\$CWD\" 2>/dev/null || cd \"\$HOME\"; fi; if command -v tmux >/dev/null 2>&1; then tmux has-session -t '${TMUX_SESS}' 2>/dev/null || tmux new-session -d -s '${TMUX_SESS}' -c \"\$CWD\" 'bash -l'; tmux set-option -t '${TMUX_SESS}' status off >/dev/null 2>&1; tmux set-option -t '${TMUX_SESS}' mouse on >/dev/null 2>&1; tmux set-option -t '${TMUX_SESS}' escape-time 10 >/dev/null 2>&1; tmux set-option -t '${TMUX_SESS}' history-limit 50000 >/dev/null 2>&1; exec tmux attach-session -t '${TMUX_SESS}'; else exec bash -l; fi"

QUICK_FAILS=0
while true; do
  STARTED_AT=$(date +%s)
  /usr/bin/ssh -tt \
    -o ControlMaster=no \
    -o ControlPath=none \
    -o ClearAllForwardings=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=6 \
    -o TCPKeepAlive=yes \
    -o ConnectTimeout=8 \
    "$SSH_HOST" "$REMOTE_SCRIPT"
  EXIT_CODE=$?

  # Exit code 255 means the SSH transport failed or dropped. Reconnect automatically after a network blip,
  # but if it keeps failing right away (bad host name, key rejected, server down) stop and wait for the user.
  if [ "$EXIT_CODE" -eq 255 ]; then
    if [ $(( $(date +%s) - STARTED_AT )) -lt 10 ]; then QUICK_FAILS=$((QUICK_FAILS + 1)); else QUICK_FAILS=0; fi
    if [ "$QUICK_FAILS" -ge 4 ]; then
      printf "\r\n\033[31m[TAKT] 连续 %s 次无法连接 %s。\033[0m\r\n检查：ssh %s 在普通终端能否登录？~/.ssh/config、密钥、网络/VPN。\r\n按回车重试，Ctrl-C 关闭。\r\n" "$QUICK_FAILS" "$SSH_HOST" "$SSH_HOST"
      read -r _ || break   # stdin closed (no terminal attached): give up instead of looping forever
      QUICK_FAILS=0
      continue
    fi
    printf "\r\n\033[38;5;244m[TAKT] SSH 连接中断 (code 255)，正在自动重连并恢复会话 (%s)...\033[0m\r\n" "$TMUX_SESS"
    sleep 1.2
    continue
  fi
  break
done
