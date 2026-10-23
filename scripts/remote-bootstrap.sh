#!/usr/bin/env bash
# Prepares a Linux server for TAKT-UI-CC. Run it ON THE LINUX HOST, or pipe it over ssh:
#   ssh my-server 'bash -s' < scripts/remote-bootstrap.sh
# Installs: tmux, python3, curl, syncthing (+ enables it as a user service). Does NOT install Claude Code.
set -uo pipefail

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if sudo -n true 2>/dev/null; then SUDO="sudo -n"; else echo "! not root and passwordless sudo unavailable — install tmux/python3/syncthing manually"; fi
fi

PKGS_APT="tmux python3 curl syncthing"
if command -v apt-get >/dev/null 2>&1; then
  $SUDO apt-get update -y >/dev/null 2>&1
  $SUDO apt-get install -y $PKGS_APT
elif command -v dnf >/dev/null 2>&1; then
  $SUDO dnf install -y tmux python3 curl syncthing
elif command -v pacman >/dev/null 2>&1; then
  $SUDO pacman -Sy --noconfirm tmux python curl syncthing
else
  echo "! unknown package manager — install tmux, python3, curl, syncthing yourself"
fi

# Run Syncthing as a user service so it survives logouts
if command -v systemctl >/dev/null 2>&1 && command -v syncthing >/dev/null 2>&1; then
  $SUDO loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
  systemctl --user enable --now syncthing.service >/dev/null 2>&1 \
    || { [ -n "$SUDO" -o "$(id -u)" -eq 0 ] && $SUDO systemctl enable --now "syncthing@$(id -un).service" >/dev/null 2>&1; } || true
fi

echo
for b in tmux python3 curl syncthing claude; do
  if command -v "$b" >/dev/null 2>&1; then echo "✔ $b: $(command -v $b)"; else echo "✘ $b: missing"; fi
done
command -v syncthing >/dev/null 2>&1 && echo "Syncthing device ID: $(syncthing --device-id 2>/dev/null | head -1)"
echo
echo "If 'claude' is missing install Claude Code (https://docs.claude.com/claude-code) for the user you SSH in as."
