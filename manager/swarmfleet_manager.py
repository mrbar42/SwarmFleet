#!/usr/bin/env python3
import json, os, secrets, shlex, shutil, subprocess, threading, time, webbrowser
import ssl, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import rumps
try:
    from AppKit import NSApplication, NSModalResponseOK, NSOpenPanel
    from Foundation import NSURL
except Exception:
    NSApplication = None
    NSModalResponseOK = 1
    NSOpenPanel = None
    NSURL = None

BASE_PORT = 7070
BASE_DEV_PORT = 42000
DEV_PORTS_PER_ENV = 10
DEFAULT_HOSTNAME = "localhost"
REPO = Path(__file__).resolve().parents[1]
DEFAULT_STATE_ROOT = Path.home() / ".local" / "swarmfleet"
STATE_ROOT = Path(
    os.environ.get(
        "SWARMFLEET_STATE_DIR",
        os.environ.get("SWARMFLEET_MANAGER_CONFIG_DIR", str(DEFAULT_STATE_ROOT)),
    )
).expanduser()
CONFIG_ROOT = STATE_ROOT
REGISTRY = STATE_ROOT / "envs.json"
SETTINGS = STATE_ROOT / "settings.json"
LOG = STATE_ROOT / "manager.log"
RUNNER_SCRIPT = REPO / "run-docker-instance.sh"
BUILD_SCRIPT = REPO / "build-docker.sh"
DEFAULT_WORKSPACE_ROOT = REPO / "workspace"
TAILSCALE_STATE_DIR = STATE_ROOT / "tailscale"
IMAGE = os.environ.get("SWARMFLEET_IMAGE", "swarmfleet:latest")
ICONS = {
    "color": Path(__file__).with_name("icon.png"),
    "black": Path(__file__).with_name("icon-black.png"),
    "white": Path(__file__).with_name("icon-white.png"),
}

build = {"running": False, "label": "", "pct": None, "error": None}
ops = {}
op_errors = []
ops_lock = threading.Lock()
refresh_requested = False
refresh_lock = threading.Lock()


def request_refresh():
    global refresh_requested
    with refresh_lock:
        refresh_requested = True


def take_refresh_request():
    global refresh_requested
    with refresh_lock:
        requested = refresh_requested
        refresh_requested = False
        return requested


def activity_active():
    if build["running"]:
        return True
    with ops_lock:
        return bool(ops)


def op_start(key, label):
    with ops_lock:
        ops[key] = label
    request_refresh()


def op_end(key):
    with ops_lock:
        ops.pop(key, None)
    request_refresh()


def op_error(msg):
    with ops_lock:
        op_errors.append(msg[:500])
        del op_errors[:-5]


def pop_op_errors():
    with ops_lock:
        out = list(op_errors)
        op_errors.clear()
        return out


def op_label(key):
    with ops_lock:
        return ops.get(key)


def busy_icon():
    if build["running"]:
        return "🧱"
    with ops_lock:
        labels = list(ops.values())
    for label, icon in [("creating", "➕"), ("restarting", "🔄"), ("starting", "▶️"), ("stopping", "⏹"), ("deleting", "🗑")]:
        if label in labels:
            return icon
    return ""


def sh(*args, check=False, timeout=8, log_cmd=True, env=None):
    if log_cmd:
        log("$ " + " ".join(map(str, args)))
    try:
        r = subprocess.run(args, text=True, capture_output=True, check=check, timeout=timeout, env=env)
        if log_cmd:
            log(f"=> exit {r.returncode}" + (f"\nstdout: {r.stdout[-2000:]}" if r.stdout else "") + (f"\nstderr: {r.stderr[-2000:]}" if r.stderr else ""))
        return r
    except FileNotFoundError as e:
        if log_cmd:
            log(f"=> missing: {e}")
        if check:
            raise
        return subprocess.CompletedProcess(args, 127, "", str(e))
    except subprocess.TimeoutExpired as e:
        if log_cmd:
            log(f"=> timeout after {timeout}s")
        return subprocess.CompletedProcess(args, 124, e.stdout or "", e.stderr or f"timed out after {timeout}s")


def log(msg):
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a") as f:
            f.write(datetime.now().isoformat(timespec="seconds") + " " + str(msg).rstrip() + "\n")
    except Exception:
        pass


def tailscale_error(env):
    for p in (
        Path(host_path(env.get("config", ""))) / "tailscale-error.txt",
        TAILSCALE_STATE_DIR / "tailscale-error.txt",
        default_state_root() / "config" / "tailscale-error.txt",
    ):
        if p.exists():
            return p.read_text().strip()
    return None


def load():
    if not REGISTRY.exists():
        return {"next_index": 1, "next_env_ordinal": 2, "envs": []}
    db = json.loads(REGISTRY.read_text())
    db.setdefault("next_index", 1)
    db.setdefault("next_env_ordinal", infer_next_env_ordinal(db.get("envs", [])))
    db.setdefault("envs", [])
    return db


def save(db):
    REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY.write_text(json.dumps(db, indent=2) + "\n")


def infer_next_env_ordinal(envs):
    highest = 1
    for env in envs or []:
        value = env.get("stateDirName") if isinstance(env, dict) else None
        if not isinstance(value, str):
            continue
        if value.startswith("env-") and value[4:].isdigit():
            highest = max(highest, int(value[4:]))
    return highest + 1


def env_state_root(state_dir_name):
    return STATE_ROOT / state_dir_name


def default_state_root():
    return env_state_root("env-default")


def apply_state_paths(env):
    if env.get("default"):
        root = default_state_root()
        env["stateDirName"] = "env-default"
        env["stateRoot"] = str(root)
        env["config"] = os.environ.get("SWARMFLEET_CONFIG_DIR", str(root / "config"))
        env["home"] = os.environ.get("SWARMFLEET_HOME_DIR", str(root / "home"))
        return env

    state_dir_name = env.get("stateDirName")
    if state_dir_name:
        root = env_state_root(state_dir_name)
        env["stateRoot"] = str(root)
        env["config"] = str(root / "config")
        env["home"] = str(root / "home")
    elif env.get("config"):
        env["stateRoot"] = str(Path(env["config"]).expanduser().parent)
    return env


def safe_remove_state_root(path):
    if not path:
        return False
    root = Path(host_path(path)).expanduser().resolve()
    state_root = STATE_ROOT.expanduser().resolve()
    if root == state_root or state_root not in root.parents:
        return False
    shutil.rmtree(root, ignore_errors=True)
    return True


def safe_remove_generated_workspace(env):
    workspace = env.get("workspace")
    env_id = env.get("id")
    if not workspace or not env_id:
        return False
    path = Path(host_path(workspace)).expanduser().resolve()
    expected = (REPO / f"workspace-{env_id}").resolve()
    if path != expected:
        return False
    shutil.rmtree(path, ignore_errors=True)
    return True


def load_settings():
    if not SETTINGS.exists():
        return {"icon_color": "system"}
    data = json.loads(SETTINGS.read_text())
    if data.get("icon_color") not in {"color", "black", "system"}:
        data["icon_color"] = "system"
    return data


def save_settings(data):
    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS.write_text(json.dumps(data, indent=2) + "\n")


def env_workspace_override():
    return os.environ.get("SWARMFLEET_WORKSPACE_ROOT") or os.environ.get("SWARMFLEET_WORKSPACE")


def workspace_root():
    override = env_workspace_override()
    if override:
        return str(Path(override).expanduser())
    value = load_settings().get("workspaceRoot")
    return str(Path(value).expanduser()) if value else str(DEFAULT_WORKSPACE_ROOT)


def choose_projects_dir(default_path, prompt="Choose your SwarmFleet projects folder.", title="SwarmFleet setup"):
    default_path = Path(default_path).expanduser()
    default_path.mkdir(parents=True, exist_ok=True)

    if shutil.which("osascript"):
        default_for_applescript = str(default_path).replace("\\", "\\\\").replace('"', '\\"')
        prompt_for_applescript = str(prompt).replace("\\", "\\\\").replace('"', '\\"')
        script = f'''
set defaultFolder to POSIX file "{default_for_applescript}"
set chosenFolder to choose folder with prompt "{prompt_for_applescript}" default location defaultFolder
return POSIX path of chosenFolder
'''
        log(f"projects dir chooser osascript begin default={default_path}")
        r = subprocess.run(
            ["osascript", "-e", script],
            text=True,
            capture_output=True,
            timeout=3600,
        )
        if r.returncode == 0 and r.stdout.strip():
            chosen = Path(r.stdout.strip()).expanduser()
            log(f"projects dir chooser osascript selected={chosen}")
            return chosen
        log(f"projects dir chooser osascript failed rc={r.returncode} stderr={(r.stderr or '').strip()[:500]}")

    if NSOpenPanel is not None and NSURL is not None:
        if NSApplication is not None:
            NSApplication.sharedApplication().activateIgnoringOtherApps_(True)
        log(f"projects dir chooser nsopenpanel begin default={default_path}")
        panel = NSOpenPanel.openPanel()
        panel.setTitle_(title)
        panel.setCanChooseFiles_(False)
        panel.setCanChooseDirectories_(True)
        panel.setAllowsMultipleSelection_(False)
        panel.setCanCreateDirectories_(True)
        panel.setPrompt_("Use This Folder")
        panel.setMessage_(f"{prompt} Default: {default_path}")
        panel.setDirectoryURL_(NSURL.fileURLWithPath_(str(default_path)))
        if panel.runModal() == NSModalResponseOK:
            url = panel.URL()
            if url:
                chosen = Path(str(url.path())).expanduser()
                log(f"projects dir chooser nsopenpanel selected={chosen}")
                return chosen
        log("projects dir chooser nsopenpanel cancelled")
        return default_path

    log("projects dir chooser rumps window begin")
    w = rumps.Window(
        prompt,
        title=title,
        default_text=str(default_path),
    ).run()
    chosen = Path(w.text.strip()).expanduser() if w.clicked and w.text.strip() else default_path
    log(f"projects dir chooser rumps selected={chosen}")
    return chosen


def choose_workspace_root(default_path):
    return choose_projects_dir(default_path)


def choose_env_projects_dir(env):
    return choose_projects_dir(
        env.get("workspace") or (REPO / f"workspace-{env.get('id') or env.get('name', 'env')}"),
        prompt=f"Choose projects folder for {env.get('name', 'env')}.",
        title=f"SwarmFleet projects: {env.get('name', 'env')}",
    )


def ensure_workspace_setting():
    data = load_settings()
    override = env_workspace_override()
    if override:
        data["workspaceRoot"] = str(Path(override).expanduser())
        save_settings(data)
        return
    if data.get("workspaceRoot"):
        return
    data["workspaceRoot"] = str(choose_workspace_root(DEFAULT_WORKSPACE_ROOT))
    save_settings(data)


def needs_workspace_setting():
    return not env_workspace_override() and not load_settings().get("workspaceRoot")


def mark_default_started_for_workspace(root):
    data = load_settings()
    data["defaultStartedForWorkspaceRoot"] = str(root)
    save_settings(data)


def should_start_default_for_workspace():
    root = load_settings().get("workspaceRoot")
    return bool(root and load_settings().get("defaultStartedForWorkspaceRoot") != root)


def start_default_for_workspace():
    root = load_settings().get("workspaceRoot")
    start_env(default_env())
    if root:
        mark_default_started_for_workspace(root)


def running_app():
    return getattr(rumps.App, "*app_instance", None)


@rumps.timer(2)
def refresh_running_app(sender):
    # Avoid rebuilding the macOS menu forever while idle. Recreating NSMenuItem
    # trees on every tick has shown unbounded RSS growth over long runtimes.
    # Active operations still get live progress via App.status_timer. Explicit
    # state-change refresh requests get one final idle refresh so transient tray
    # badges (for example ⏹ after Stop) are removed after the operation ends.
    if not activity_active() and not take_refresh_request():
        return
    app = running_app()
    if app:
        app.refresh(sender)


def default_env():
    return apply_state_paths({
        "id": "default",
        "name": "default",
        "container": "swarmfleet",
        "index": 0,
        "port": BASE_PORT,
        "dev_port_start": BASE_DEV_PORT,
        "dev_port_end": BASE_DEV_PORT + DEV_PORTS_PER_ENV - 1,
        "workspace": workspace_root(),
        "default": True,
    })


def env_key(env):
    return env.get("id") or env.get("container") or env.get("name")


def env_has_credentials(env):
    p = Path(host_path(env.get("config", ""))) / "auth.json"
    if not p.exists():
        return False
    try:
        return bool(json.loads(p.read_text()).get("credentials"))
    except Exception:
        return False


def first_open_done(env):
    return env_has_credentials(env)


def mark_first_open_done(env):
    data = load_settings()
    opened = set(data.get("opened_envs", []))
    opened.add(env_key(env))
    data["opened_envs"] = sorted(opened)
    save_settings(data)


def mac_dark_mode():
    r = sh("defaults", "read", "-g", "AppleInterfaceStyle", log_cmd=False)
    return r.returncode == 0 and r.stdout.strip().lower() == "dark"


def icon_path():
    mode = load_settings().get("icon_color", "color")
    if mode == "black":
        return ICONS["black"]
    if mode == "system":
        return ICONS["white"] if mac_dark_mode() else ICONS["black"]
    return ICONS["color"]


def icon_mode_label():
    return {"color": "🌈 Colorful", "black": "⚫️ Black", "system": "◐ Black/white (system)"}.get(load_settings().get("icon_color"), "🌈 Colorful")


def docker_json(*args):
    r = sh("docker", *args, log_cmd=False)
    if r.returncode != 0 or not r.stdout.strip():
        return None
    return json.loads(r.stdout)


def inspect_container(name):
    data = docker_json("inspect", name)
    return data[0] if data else None


def is_running(name):
    c = inspect_container(name)
    return bool(c and c.get("State", {}).get("Running"))


def image_built():
    return sh("docker", "image", "inspect", IMAGE, log_cmd=False).returncode == 0


def env_map(container):
    out = {}
    for e in container.get("Config", {}).get("Env", []) or []:
        if "=" in e:
            k, v = e.split("=", 1)
            out[k] = v
    return out


def host_port(container):
    ports = container.get("NetworkSettings", {}).get("Ports", {})
    binds = ports.get("443/tcp") or []
    if binds:
        return int(binds[0]["HostPort"])
    env = env_map(container)
    if env.get("SWARMFLEET_PUBLIC_PORT"):
        return int(env["SWARMFLEET_PUBLIC_PORT"])
    return None


def mount_source(container, dest):
    for m in container.get("Mounts", []) or []:
        if m.get("Destination") == dest:
            return host_path(m.get("Source"))
    return None


def host_path(p):
    if not p:
        return p
    for prefix in ("/host_mnt", "/run/desktop/mnt/host"):
        if p.startswith(prefix + "/"):
            return p[len(prefix):]
    return p


def tailscale_host(env, container=None):
    if container:
        host = env_map(container).get("SWARMFLEET_TAILSCALE_HOST")
        if host and not host.endswith(".invalid"):
            return host.strip().rstrip(".")
    for p in (
        Path(host_path(env.get("config", ""))) / "tailscale-host.txt",
        TAILSCALE_STATE_DIR / "tailscale-host.txt",
        default_state_root() / "config" / "tailscale-host.txt",
    ):
        if p.exists():
            host = p.read_text().strip().rstrip(".")
            if host and not host.endswith(".invalid"):
                return host
    return None


def local_url(env):
    return f"https://localhost:{env['port']}"


def configured_hostname(env):
    p = Path(host_path(env.get("config", ""))) / "server.json"
    if p.exists():
        try:
            host = json.loads(p.read_text()).get("hostname")
            if isinstance(host, str) and host.strip():
                host = host.strip()
                return DEFAULT_HOSTNAME if host == "swarmfleet.local" else host
        except Exception:
            pass
    return env.get("hostname") or DEFAULT_HOSTNAME


def app_url(env):
    return local_url(env) if configured_hostname(env) == "localhost" else f"https://{configured_hostname(env)}:{env['port']}"


def is_ready(env):
    if not env.get("running"):
        return False
    try:
        ctx = ssl._create_unverified_context()
        req = urllib.request.Request(local_url(env), method="GET")
        with urllib.request.urlopen(req, timeout=1.0, context=ctx) as r:
            return 200 <= r.status < 500
    except Exception:
        return False


def ts_url(env):
    host = env.get("tailscale_host")
    return f"https://{host}:{env['port']}" if host else None


def running_names():
    r = sh("docker", "ps", "--format", "{{.Names}}", log_cmd=False)
    if r.returncode != 0:
        return []
    return [x for x in r.stdout.splitlines() if x == "swarmfleet" or x.startswith("swarmfleet-")]


def registry_envs():
    db = load()
    return [apply_state_paths(dict(e, external=False)) for e in db["envs"]]


def all_envs():
    envs = [dict(default_env(), external=False)]
    known = {"swarmfleet"}
    for e in registry_envs():
        envs.append(e); known.add(e["container"])
    for name in running_names():
        if name not in known:
            envs.append({"id": name, "name": name.replace("swarmfleet-", "env-", 1), "container": name, "port": BASE_PORT, "external": True})
            known.add(name)
    out = []
    for e in envs:
        c = inspect_container(e["container"])
        e["container_exists"] = bool(c)
        e["running"] = bool(c and c.get("State", {}).get("Running"))
        if c:
            e["port"] = host_port(c) or e.get("port", BASE_PORT)
            if e["running"] or e.get("external"):
                e["config"] = mount_source(c, "/config") or e.get("config")
                e["workspace"] = mount_source(c, "/workspace") or e.get("workspace")
                e["home"] = mount_source(c, "/home/user") or e.get("home")
            e["tailscale_host"] = tailscale_host(e, c)
        else:
            e["tailscale_host"] = tailscale_host(e)
        e["ready"] = is_ready(e)
        out.append(e)
    return sorted(out, key=lambda e: (0 if e.get("default") else 1, e.get("port", 99999), e["name"]))


def allocation(i):
    return BASE_PORT + i, BASE_DEV_PORT + i * DEV_PORTS_PER_ENV, BASE_DEV_PORT + i * DEV_PORTS_PER_ENV + DEV_PORTS_PER_ENV - 1


def make_env():
    db = load()
    i = db["next_index"]
    db["next_index"] += 1
    ordinal = db["next_env_ordinal"]
    db["next_env_ordinal"] += 1
    eid = secrets.token_hex(4)
    port, dev_start, dev_end = allocation(i)
    state_dir_name = f"env-{ordinal}"
    state_root = env_state_root(state_dir_name)
    env = {
        "id": eid,
        "name": state_dir_name,
        "container": f"swarmfleet-{eid}",
        "index": i,
        "stateDirName": state_dir_name,
        "port": port,
        "dev_port_start": dev_start,
        "dev_port_end": dev_end,
        "workspace": str(REPO / f"workspace-{eid}"),
        "config": str(state_root / "config"),
        "home": str(state_root / "home"),
    }
    db["envs"].append(env)
    save(db)
    start_env(env)


def ensure_image():
    if not image_built():
        start_build(wait=True)


def wait_for_image():
    if build["running"]:
        while build["running"]:
            time.sleep(0.2)
        if build["error"]:
            raise RuntimeError(build["error"])
    if not image_built():
        start_build(wait=True)


def start_env(env):
    env = apply_state_paths(dict(env))
    log(f"start_env begin env={env.get('name')} id={env.get('id')} container={env.get('container')} port={env.get('port')}")
    wait_for_image()
    Path(env["workspace"]).mkdir(parents=True, exist_ok=True)
    Path(env["config"]).mkdir(parents=True, exist_ok=True)
    Path(env["home"]).mkdir(parents=True, exist_ok=True)
    runner_env = os.environ.copy()
    runner_env.update({
        "SWARMFLEET_DOCKER_DETACH": "1",
        "SWARMFLEET_CONTAINER_NAME": env["container"],
        "SWARMFLEET_IMAGE": IMAGE,
        "SWARMFLEET_HOST_PORT": str(env["port"]),
        "SWARMFLEET_HOST_DEV_PORT_START": str(env["dev_port_start"]),
        "SWARMFLEET_HOST_DEV_PORT_END": str(env["dev_port_end"]),
        "SWARMFLEET_STATE_DIR": str(STATE_ROOT),
        "SWARMFLEET_ENV_STATE_DIR": str(env.get("stateRoot") or Path(env["config"]).parent),
        "SWARMFLEET_CONFIG_DIR": str(env["config"]),
        "SWARMFLEET_WORKSPACE_ROOT": str(env["workspace"]),
        "SWARMFLEET_HOME_DIR": str(env["home"]),
        "SWARMFLEET_TAILSCALE_STATE_DIR": str(TAILSCALE_STATE_DIR),
    })
    ts_host = tailscale_host(env)
    if ts_host:
        runner_env["SWARMFLEET_TAILSCALE_HOST"] = ts_host
    r = sh(str(RUNNER_SCRIPT), timeout=1800, env=runner_env)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "docker runner failed").strip())
    log(f"start_env done env={env.get('name')} container={env.get('container')}")

def iso(dt):
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def enroll(env, base_url=None, mark_opened=False):
    cfg = host_path(env.get("config"))
    if not cfg:
        rumps.alert("Enroll failed", "No config mount found for this environment."); return
    p = Path(cfg) / "auth.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.exists():
        state = json.loads(p.read_text())
    else:
        state = {"version": 1, "sessionSigningKey": secrets.token_urlsafe(32), "credentials": [], "sessions": [], "enrollmentTokens": []}
    now = datetime.now(timezone.utc)
    tok = secrets.token_hex(16)
    state.setdefault("enrollmentTokens", []).append({"token": tok, "createdAt": iso(now), "expiresAt": iso(now + timedelta(minutes=5)), "issuedBy": "swarmfleet-manager"})
    p.write_text(json.dumps(state, indent=2) + "\n")
    if mark_opened:
        mark_first_open_done(env)
    webbrowser.open(f"{(base_url or app_url(env)).rstrip('/')}/enroll?token={tok}")


def open_env(env, url=None):
    url = url or app_url(env)
    if not first_open_done(env):
        enroll(env, base_url=url, mark_opened=True)
        return
    webbrowser.open(url)


def apple_script_string(value):
    return str(value).replace("\\", "\\\\").replace('"', '\\"')


def open_logs(env):
    container = env.get("container")
    if not container:
        rumps.alert("Logs failed", "No Docker container is known for this environment.")
        return
    if not shutil.which("osascript"):
        rumps.alert("Logs failed", "Opening logs requires osascript on macOS.")
        return
    title = f"SwarmFleet logs: {env.get('name') or container}"
    command = (
        f"printf '\\033]0;{shlex.quote(title)}\\007'; "
        f"docker logs -f {shlex.quote(container)}; "
        "status=$?; echo; echo \"docker logs exited with status $status\"; "
        "echo \"Press Return to close.\"; read _"
    )
    script = f'''
tell application "Terminal"
    activate
    do script "{apple_script_string(command)}"
end tell
'''
    r = sh("osascript", "-e", script, timeout=8)
    if r.returncode != 0:
        rumps.alert("Logs failed", (r.stderr or r.stdout or "Could not open Terminal.").strip())


def open_manager_logs(_=None):
    if not shutil.which("osascript"):
        rumps.alert("Manager logs failed", "Opening manager logs requires osascript on macOS.")
        return
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        LOG.touch(exist_ok=True)
    except Exception as e:
        rumps.alert("Manager logs failed", str(e))
        return
    title = "SwarmFleet manager logs"
    command = (
        f"printf '\\033]0;{shlex.quote(title)}\\007'; "
        f"tail -f {shlex.quote(str(LOG))}; "
        "status=$?; echo; echo \"tail exited with status $status\"; "
        "echo \"Press Return to close.\"; read _"
    )
    script = f'''
tell application "Terminal"
    activate
    do script "{apple_script_string(command)}"
end tell
'''
    r = sh("osascript", "-e", script, timeout=8)
    if r.returncode != 0:
        rumps.alert("Manager logs failed", (r.stderr or r.stdout or "Could not open Terminal.").strip())


def bar(pct):
    if pct is None:
        return "▰▱▱▱▱"
    n = max(0, min(5, round(pct / 20)))
    return "▰" * n + "▱" * (5 - n)


def update_build_from_output_line(line):
    try:
        ev = json.loads(line)
        name = ev.get("name") or ev.get("id") or build["label"]
        status = ev.get("status") or ev.get("vertex", {}).get("name") or "building"
        build["label"] = f"{status} {name}"[:40]
        progress = ev.get("progressDetail") or ev
        cur = progress.get("current"); total = progress.get("total")
        if isinstance(cur, int) and isinstance(total, int) and total > 0:
            build["pct"] = int(cur * 100 / total)
    except Exception:
        build["label"] = line[:40]


def build_worker():
    cmd = [str(BUILD_SCRIPT)]
    env = os.environ.copy()
    env["BUILDKIT_PROGRESS"] = "rawjson"
    env["SWARMFLEET_IMAGE"] = IMAGE
    try:
        p = subprocess.Popen(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
        for line in p.stdout or []:
            line = line.strip()
            if not line: continue
            update_build_from_output_line(line)
        rc = p.wait()
        build.update(running=False, pct=100 if rc == 0 else None, error=None if rc == 0 else f"docker build exited {rc}")
    except Exception as e:
        build.update(running=False, pct=None, error=str(e))


def start_build(wait=False):
    if build["running"]: return
    build.update(running=True, label="starting", pct=None, error=None)
    t = threading.Thread(target=build_worker, daemon=True)
    t.start()
    if wait:
        while build["running"]:
            time.sleep(0.2)
        if build["error"]:
            raise RuntimeError(build["error"])


def start_build_if_missing():
    if build["running"] or image_built():
        return
    start_build(False)


def disabled_item(title):
    item = rumps.MenuItem(title)
    try: item._menuitem.setEnabled_(False)
    except Exception: pass
    return item


class App(rumps.App):
    def __init__(self):
        path = icon_path()
        if path.exists():
            super().__init__("SwarmFleet", title="", icon=str(path), quit_button="Quit")
        else:
            super().__init__("SF", quit_button="Quit")
        self.status_timer = rumps.Timer(self.status_tick, 1)
        self.status_timer_active = False
        self.workspace_prompt_pending = False
        start_build_if_missing()
        self.refresh(None)
        if should_start_default_for_workspace():
            if is_running(default_env()["container"]):
                mark_default_started_for_workspace(workspace_root())
            else:
                self.bg("default", "starting", start_default_for_workspace, "Start failed")

    def finish_first_launch(self):
        log("workspace prompt begin")
        self.workspace_prompt_pending = False
        ensure_workspace_setting()
        log(f"workspace prompt done workspaceRoot={load_settings().get('workspaceRoot')}")
        self.refresh(None)

    def refresh(self, sender):
        self.apply_icon()
        self.menu.clear()
        for msg in pop_op_errors():
            rumps.alert("SwarmFleet Manager", msg)
        if needs_workspace_setting():
            self.menu.add(disabled_item("Configure projects dir to mount into the container"))
            self.menu.add(rumps.MenuItem("Choose projects dir...", callback=self.change_workspace))
            if build["running"] or build["error"] or not image_built():
                self.menu.add(None)
                self.add_image_menu(show_built=False)
            self.sync_status_timer()
            return
        envs = all_envs()
        for env in envs:
            active = op_label(env_key(env))
            status = {"starting": "▶️", "restarting": "🔄", "stopping": "⏹", "deleting": "🗑"}.get(active)
            if not status:
                status = "🟢" if env.get("ready") else ("🟡" if env["running"] else "⚫️")
            label = f"{status} {env['name']}  :{env['port']}"
            item = rumps.MenuItem(label, callback=(lambda _, e=env: open_env(e)) if env.get("ready") and not active else None)
            if active:
                item.add(disabled_item(f"⏳ {active}"))
                item.add(None)
            if env["running"]:
                if not env.get("ready"):
                    item.add(disabled_item("🟡 Starting / waiting for web UI"))
                    item.add(None)
                u = ts_url(env)
                if u:
                    item.add(rumps.MenuItem(f"🛜 Tailscale URL  {u}", callback=lambda _, e=env, url=u: open_env(e, url)))
                else:
                    err = tailscale_error(env) or "not enabled for this run"
                    if not env.get("external"):
                        item.add(rumps.MenuItem("🛜 Retry Tailscale + restart", callback=lambda _, e=env: self.restart(e)))
                    else:
                        item.add(disabled_item(f"🛜 Tailscale unavailable: {err[:80]}"))
                item.add(rumps.MenuItem(f"🏠 Localhost URL  {local_url(env)}", callback=lambda _, e=env: open_env(e)))
                item.add(None)
                item.add(rumps.MenuItem("🔑 Enroll device / new passkey", callback=lambda _, e=env: enroll(e)))
                item.add(rumps.MenuItem("📜 Logs", callback=lambda _, e=env: open_logs(e)))
                item.add(None)
                if env.get("default"):
                    item.add(rumps.MenuItem("Change projects dir...", callback=self.change_workspace))
                elif not env.get("external"):
                    item.add(rumps.MenuItem("Change projects dir...", callback=lambda _, e=env: self.change_env_workspace(e)))
                if not env.get("default"):
                    item.add(rumps.MenuItem("✏️ Rename", callback=lambda _, e=env: self.rename(e)))
                item.add(rumps.MenuItem("🔄 Restart", callback=lambda _, e=env: self.restart(e)))
                item.add(rumps.MenuItem("⏹ Stop", callback=lambda _, e=env: self.stop(e)))
                if not env.get("default"):
                    item.add(rumps.MenuItem("🗑 Delete", callback=lambda _, e=env: self.delete(e)))
            else:
                if not env.get("external"):
                    item.add(rumps.MenuItem("▶️ Start", callback=lambda _, e=env: self.restart(e)))
                    if env.get("container_exists"):
                        item.add(rumps.MenuItem("📜 Logs", callback=lambda _, e=env: open_logs(e)))
                    if env.get("default"):
                        item.add(rumps.MenuItem("Change projects dir...", callback=self.change_workspace))
                    if not env.get("default"):
                        item.add(rumps.MenuItem("Change projects dir...", callback=lambda _, e=env: self.change_env_workspace(e)))
                        item.add(rumps.MenuItem("✏️ Rename", callback=lambda _, e=env: self.rename(e)))
                        item.add(rumps.MenuItem("🗑 Delete", callback=lambda _, e=env: self.delete(e)))
                else:
                    item.add(disabled_item("▶️ Start unavailable"))
                    item.add(rumps.MenuItem("✏️ Rename", callback=lambda _, e=env: self.rename(e)))
            self.menu.add(item)
        self.menu.add(None)
        self.menu.add(rumps.MenuItem("➕ Create env", callback=self.create))
        self.menu.add(rumps.MenuItem("↻ Refresh", callback=self.refresh))
        self.menu.add(None)
        self.add_image_menu()
        self.add_icon_menu()
        self.sync_status_timer()

    def status_tick(self, sender):
        self.refresh(sender)

    def sync_status_timer(self):
        active = activity_active()
        if active and not self.status_timer_active:
            self.status_timer.start()
            self.status_timer_active = True
        elif not active and self.status_timer_active:
            self.status_timer.stop()
            self.status_timer_active = False

    def apply_icon(self):
        self.title = busy_icon()
        path = icon_path()
        if not path.exists():
            return
        try:
            self.icon = str(path)
        except Exception:
            pass

    def add_icon_menu(self):
        options = rumps.MenuItem("⚙️ Options")
        options.add(rumps.MenuItem("📜 Manager logs", callback=open_manager_logs))
        item = rumps.MenuItem(f"🎨 Icon color: {icon_mode_label()}")
        current = load_settings().get("icon_color", "color")
        for key, label in [("color", "🌈 Colorful"), ("black", "⚫️ Black"), ("system", "◐ Black/white (system theme)")]:
            prefix = "✓ " if current == key else ""
            item.add(rumps.MenuItem(prefix + label, callback=lambda _, k=key: self.set_icon_color(k)))
        options.add(item)
        self.menu.add(options)

    def change_workspace(self, _):
        self.workspace_prompt_pending = False
        chosen = choose_workspace_root(workspace_root())
        data = load_settings()
        data["workspaceRoot"] = str(chosen)
        save_settings(data)
        log(f"workspaceRoot saved {chosen}")
        self.refresh(None)
        env = default_env()
        label = "restarting" if is_running(env["container"]) else "starting"
        self.bg("default", label, start_default_for_workspace, "Start failed")

    def change_env_workspace(self, env):
        if env.get("default") or env.get("external"):
            self.refresh(None)
            return
        chosen = choose_env_projects_dir(env)
        db = load()
        updated = None
        for x in db["envs"]:
            if x["id"] == env["id"]:
                x["workspace"] = str(chosen)
                updated = dict(x)
                break
        if updated is None:
            self.refresh(None)
            return
        save(db)
        log(f"env workspace saved env={env.get('name')} id={env.get('id')} workspace={chosen}")
        self.refresh(None)
        label = "restarting" if is_running(updated["container"]) else "starting"
        self.bg(env_key(updated), label, lambda e=updated: start_env(e), "Start failed")

    def set_icon_color(self, mode):
        data = load_settings()
        data["icon_color"] = mode
        save_settings(data)
        self.apply_icon()
        self.refresh(None)

    def add_image_menu(self, show_built=True):
        if build["running"]:
            title = f"🧱 Image building {bar(build['pct'])} {build['pct'] or ''}%"
        elif image_built():
            if not show_built:
                return
            title = "🧱 Image built"
        else:
            title = "🧱 Image not built"
        item = rumps.MenuItem(title)
        if build["running"]:
            item.add(disabled_item(f"⏳ {build['label']}"))
        else:
            item.add(rumps.MenuItem("🔨 Rebuild" if image_built() else "🔨 Build", callback=lambda _: (start_build(False), self.refresh(None))))
            if build["error"]:
                item.add(disabled_item(f"⚠️ {build['error']}"))
        self.menu.add(item)

    def bg(self, key, label, fn, fail_title):
        def run():
            log(f"op begin key={key} label={label}")
            op_start(key, label)
            try:
                fn()
            except Exception as e:
                log(f"op error key={key} label={label}: {e}")
                op_error(f"{fail_title}: {e}")
            finally:
                op_end(key)
                log(f"op end key={key} label={label}")
        threading.Thread(target=run, daemon=True).start()
        self.refresh(None)

    def create(self, _):
        self.bg("__create__", "creating", make_env, "Create failed")

    def rename(self, env):
        w = rumps.Window("New name", default_text=env["name"]).run()
        if w.clicked:
            name = w.text.strip()
            if not name:
                self.refresh(None); return
            if env.get("external"):
                safe = "swarmfleet" if env.get("default") else "swarmfleet-" + "".join(c if c.isalnum() or c in "_.-" else "-" for c in name)
                if env["running"] and safe != env["container"]:
                    sh("docker", "rename", env["container"], safe)
            else:
                db = load()
                for x in db["envs"]:
                    if x["id"] == env["id"]: x["name"] = name
                save(db)
        self.refresh(None)

    def restart(self, env):
        key = env_key(env)
        label = "restarting" if env.get("running") else "starting"
        log(f"restart clicked env={env.get('name')} key={key} external={env.get('external')} running={env.get('running')}")
        def work():
            if env.get("external"):
                log(f"restart external docker restart {env['container']}")
                r = sh("docker", "restart", env["container"], timeout=60)
                if r.returncode != 0:
                    raise RuntimeError((r.stderr or r.stdout or "docker restart failed").strip())
            else:
                log(f"restart managed start_env {env.get('container')}")
                start_env(env)
        self.bg(key, label, work, "Restart failed")

    def stop(self, env):
        def work():
            r = sh("docker", "stop", env["container"], timeout=60)
            if r.returncode != 0:
                raise RuntimeError((r.stderr or r.stdout or "docker stop failed").strip())
        self.bg(env_key(env), "stopping", work, "Stop failed")

    def delete(self, env):
        if env.get("default"):
            rumps.alert("Default env", "The default env always exists. Stop it instead."); return
        if rumps.alert("Delete env?", env["name"], ok="Delete", cancel="Cancel") != 1:
            return
        def work():
            r = sh("docker", "rm", "-f", env["container"], timeout=60)
            if r.returncode != 0:
                raise RuntimeError((r.stderr or r.stdout or "docker rm failed").strip())
            if not env.get("external"):
                sh("docker", "volume", "rm", f"{env['container']}-backend-deps", f"{env['container']}-frontend-deps", timeout=60)
                safe_remove_generated_workspace(env)
                safe_remove_state_root(env.get("stateRoot") or Path(env["config"]).parent)
                db = load(); db["envs"] = [x for x in db["envs"] if x["id"] != env["id"]]; save(db)
        self.bg(env_key(env), "deleting", work, "Delete failed")


if __name__ == "__main__":
    App().run()
