# SwarmFleet Manager

Tiny macOS menu bar controller for local SwarmFleet Docker environments.

Run:

```bash
./swarmfleet.sh
```

Behavior:

- Menu bar uses `manager/icon.png`, generated from `media/icon.svg` with the black canvas made transparent and the top padding cropped
- Options menu supports icon color modes: colorful, black, or black/white system-theme aware; default is system-theme aware
- Default env always exists in the menu
- Running containers named `swarmfleet` or `swarmfleet-*` are shown
- On first launch, the menu only shows project-directory setup, image build status if needed, and Quit
- The selected workspace folder is stored in `~/.local/swarmfleet/settings.json` by default
- The manager starts containers through `run-docker-instance.sh`; Docker build details live in `build-docker.sh`
- First open from the manager uses an enrollment URL automatically; it keeps doing that until the env has a credential, then future opens use the normal browser URL
- Browser/passkey URLs use `https://localhost:<port>` so no `/etc/hosts` setup is needed
- Tailscale host/cert state is shared globally under `~/.local/swarmfleet/tailscale/`; every env uses the same host with only the port changing
- Running env submenu:
  - Tailscale URL, when host Tailscale cert generation succeeds
  - Localhost URL
  - Enroll device / new passkey
  - Logs, which opens Terminal with `docker logs -f`
  - Rename
  - Restart
  - Stop
  - Delete
- Stopped env submenu changes to start/logs/rename/delete where the manager can safely do that
- Running but not-yet-ready envs show yellow while the web UI still returns startup/502
- `Create env` allocates immediately with no prompts
- Image menu shows built/not-built/building state and build/rebuild action
- Options menu includes Manager logs, which opens Terminal with `tail -f ~/.local/swarmfleet/manager.log`
- Registry: `~/.local/swarmfleet/envs.json`
- Default env runtime config: `~/.local/swarmfleet/env-default/config`
- Per-manager-env data: `~/.local/swarmfleet/env-<ordinal>/`
- Per-manager-env workspace: repo-local `workspace-<env-id>/` by default; each env submenu has `Change projects dir...` to choose a different folder
- Override the state root with `SWARMFLEET_STATE_DIR=/path/to/state`; legacy `SWARMFLEET_MANAGER_CONFIG_DIR` is still accepted as a fallback
- Port allocation for manager-created envs:
  - main web UI: 7070 + monotonic env index
  - public dev range: 42000 + index*10 through +9

This is intentionally minimal and does not package a `.app` bundle yet.
