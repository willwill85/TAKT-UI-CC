# Shared platform modules

- `platform.js`: Windows executable discovery, safe PowerShell encoding, process environment, path containment and NTFS secret protection.
- `ssh.js`: quoted remote tmux commands and Windows-compatible SSH arguments.
- `ssh-tunnels.js`: one owned SSH reverse-tunnel child per node.
- `workspace-paths.js`: Windows/local and Linux/remote mirror mapping.

Modules must not require Electron or run services on import.
