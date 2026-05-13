#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable


REPO_ROOT = Path(__file__).resolve().parents[1]
HOME = Path.home()
OLD_MANAGER_ROOT = HOME / ".config" / "swarmfleet"
DEFAULT_STATE_ROOT = HOME / ".local" / "swarmfleet"
FORCED_ENV_STATE_DIRS = {"8e936006": "env-2"}


def now_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def file_fingerprint(path: Path) -> tuple[str, str]:
    if path.is_symlink():
        return ("symlink", os.readlink(path))
    return ("file", sha256(path))


def is_special(path: Path) -> bool:
    mode = path.lstat().st_mode
    return not (stat.S_ISREG(mode) or stat.S_ISDIR(mode) or stat.S_ISLNK(mode))


def durable_files(root: Path) -> dict[str, tuple[str, str]]:
    out: dict[str, tuple[str, str]] = {}
    if not root.exists():
        return out
    for path in root.rglob("*"):
        if path.is_dir() and not path.is_symlink():
            continue
        if is_special(path):
            continue
        out[str(path.relative_to(root))] = file_fingerprint(path)
    return out


@dataclass
class Counters:
    tree_moves: int = 0
    file_moves: int = 0
    conflicts: int = 0
    duplicates: int = 0
    mkdirs: int = 0
    specials: int = 0
    missing_sources: int = 0
    registry_updates: int = 0
    chat_index_added: int = 0


@dataclass
class Verification:
    source: Path
    target: Path
    manifest: dict[str, tuple[str, str]]


@dataclass
class Migration:
    state_root: Path
    dry_run: bool
    timestamp: str
    counters: Counters = field(default_factory=Counters)
    verifications: list[Verification] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    virtual_moves: dict[Path, Path] = field(default_factory=dict)

    @property
    def import_root(self) -> Path:
        return (
            self.state_root
            / "env-default"
            / "home"
            / ".swarmfleet"
            / "imports"
            / self.timestamp
        )

    def log(self, message: str) -> None:
        print(message)

    def ensure_dir(self, path: Path) -> None:
        self.counters.mkdirs += 1
        self.log(f"mkdir {path}")
        if not self.dry_run:
            path.mkdir(parents=True, exist_ok=True)

    def virtual_path(self, path: Path) -> Path:
        if not self.dry_run:
            return path
        for target_root, source_root in sorted(
            self.virtual_moves.items(),
            key=lambda item: len(item[0].parts),
            reverse=True,
        ):
            try:
                rel = path.relative_to(target_root)
            except ValueError:
                continue
            return source_root / rel
        return path

    def move_tree(self, source: Path, target: Path, label: str) -> None:
        if not source.exists():
            self.counters.missing_sources += 1
            self.log(f"skip missing {source}")
            return
        if target.exists():
            self.merge_tree(source, target, self.import_root / label)
            return
        manifest = durable_files(source)
        self.counters.tree_moves += 1
        self.log(f"move tree {source} -> {target} ({len(manifest)} durable files)")
        self.verifications.append(Verification(source, target, manifest))
        if self.dry_run:
            self.virtual_moves[target] = source
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(target))

    def move_children(
        self,
        source: Path,
        target: Path,
        label: str,
        exclude_names: set[str] | None = None,
    ) -> None:
        if not source.exists():
            self.counters.missing_sources += 1
            self.log(f"skip missing {source}")
            return
        exclude_names = exclude_names or set()
        self.ensure_dir(target)
        for child in sorted(source.iterdir(), key=lambda p: p.name):
            if child.name in exclude_names:
                self.log(f"skip handled {child}")
                continue
            child_target = target / child.name
            if child.is_dir() and not child.is_symlink():
                self.move_tree(child, child_target, f"{label}/{child.name}")
            else:
                self.move_path(child, child_target, self.import_root / label / child.name)
        if not self.dry_run:
            cleanup_empty_tree(source)

    def merge_tree(
        self,
        source: Path,
        target: Path,
        conflict_root: Path,
        ignore_rels: set[str] | None = None,
    ) -> None:
        ignore_rels = ignore_rels or set()
        if not source.exists():
            self.counters.missing_sources += 1
            self.log(f"skip missing {source}")
            return
        self.ensure_dir(target)
        for path in sorted(source.rglob("*"), key=lambda p: (len(p.parts), str(p))):
            rel = path.relative_to(source)
            rel_s = str(rel)
            if rel_s in ignore_rels:
                self.log(f"skip handled {source / rel}")
                continue
            dst = target / rel
            conflict = conflict_root / rel
            self.move_path(path, dst, conflict)
        if not self.dry_run:
            cleanup_empty_tree(source)

    def move_path(self, source: Path, target: Path, conflict: Path) -> None:
        if not source.exists() and not source.is_symlink():
            return
        if source.is_dir() and not source.is_symlink():
            target_actual = self.virtual_path(target)
            if target_actual.exists() and not target_actual.is_dir():
                self.counters.conflicts += 1
                self.log(f"conflict dir {source} -> {conflict}")
                if not self.dry_run:
                    conflict.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(source), str(conflict))
            elif not target_actual.exists():
                self.ensure_dir(target)
            return
        if is_special(source):
            self.counters.specials += 1
            self.log(f"drop transient special file {source}")
            if not self.dry_run:
                try:
                    source.unlink()
                except OSError as exc:
                    self.notes.append(f"failed to remove special file {source}: {exc}")
            return
        target_actual = self.virtual_path(target)
        if not target_actual.exists() and not target_actual.is_symlink():
            self.counters.file_moves += 1
            self.log(f"move file {source} -> {target}")
            self.verifications.append(Verification(source, target, {".": file_fingerprint(source)}))
            if not self.dry_run:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(source), str(target))
            return
        try:
            same = file_fingerprint(source) == file_fingerprint(target_actual)
        except OSError:
            same = False
        if same:
            self.counters.duplicates += 1
            self.log(f"dedupe identical {source}")
            if not self.dry_run:
                source.unlink()
            return
        self.counters.conflicts += 1
        self.log(f"conflict active-wins {source} -> {conflict}")
        self.verifications.append(Verification(source, conflict, {".": file_fingerprint(source)}))
        if not self.dry_run:
            conflict.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(conflict))

    def merge_chat_index(self, source_root: Path, target_root: Path, label: str) -> set[str]:
        source_index = source_root / "index.json"
        target_index = target_root / "index.json"
        target_index_actual = self.virtual_path(target_index)
        rel = str(source_index.relative_to(source_root.parent.parent))
        if not source_index.exists():
            return set()
        archive = self.import_root / label / "chat-sessions-index.json"
        self.log(f"merge chat index {source_index} -> {target_index}")
        if not target_index_actual.exists():
            self.move_path(source_index, target_index, archive)
            return {rel}
        with source_index.open("r", encoding="utf-8") as f:
            source_data = json.load(f)
        with target_index_actual.open("r", encoding="utf-8") as f:
            target_data = json.load(f)
        target_sessions = target_data.setdefault("sessions", [])
        existing = {s.get("sessionId") for s in target_sessions if isinstance(s, dict)}
        added = []
        for session in source_data.get("sessions", []):
            if not isinstance(session, dict):
                continue
            session_id = session.get("sessionId")
            if not session_id or session_id in existing:
                continue
            target_sessions.append(session)
            existing.add(session_id)
            added.append(session_id)
        self.counters.chat_index_added += len(added)
        self.counters.conflicts += 1
        self.log(f"archive legacy chat index {source_index} -> {archive} (added {len(added)} sessions)")
        if not self.dry_run:
            target_index.parent.mkdir(parents=True, exist_ok=True)
            target_index.write_text(json.dumps(target_data, indent=2) + "\n", encoding="utf-8")
            self.refresh_verification_path(target_index)
            archive.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source_index), str(archive))
        return {rel}

    def rewrite_registry(self) -> None:
        registry = self.state_root / "envs.json"
        registry_actual = self.virtual_path(registry)
        if not registry_actual.exists():
            legacy_registry = OLD_MANAGER_ROOT / "envs.json"
            if self.dry_run and legacy_registry.exists():
                registry_actual = legacy_registry
            else:
                self.log(f"skip missing registry {registry}")
                return
        data = json.loads(registry_actual.read_text(encoding="utf-8"))
        envs = data.setdefault("envs", [])
        used_ordinals = {1}
        next_ordinal = 2
        for env in envs:
            if not isinstance(env, dict):
                continue
            env_id = env.get("id")
            state_dir = env.get("stateDirName")
            if env_id in FORCED_ENV_STATE_DIRS:
                state_dir = FORCED_ENV_STATE_DIRS[env_id]
            elif not isinstance(state_dir, str) or not state_dir:
                while next_ordinal in used_ordinals:
                    next_ordinal += 1
                state_dir = f"env-{next_ordinal}"
            if state_dir.startswith("env-") and state_dir[4:].isdigit():
                used_ordinals.add(int(state_dir[4:]))
            env["stateDirName"] = state_dir
            env_root = self.state_root / state_dir
            env["config"] = str(env_root / "config")
            env["home"] = str(env_root / "home")
            self.counters.registry_updates += 1
        requested_next = data.get("next_env_ordinal")
        next_from_used = max(used_ordinals) + 1
        data["next_env_ordinal"] = max(
            next_from_used,
            requested_next if isinstance(requested_next, int) else 0,
        )
        if "next_index" not in data:
            data["next_index"] = 1
        self.log(f"rewrite registry {registry}")
        if not self.dry_run:
            registry.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
            self.refresh_verification_path(registry)

    def verify(self) -> None:
        if self.dry_run:
            return
        errors = []
        for item in self.verifications:
            if not item.target.exists() and not item.target.is_symlink():
                errors.append(f"missing target {item.target}")
                continue
            if item.manifest.keys() == {"."}:
                actual = file_fingerprint(item.target)
                expected = item.manifest["."]
                if actual != expected:
                    errors.append(f"fingerprint mismatch {item.target}")
                continue
            actual_manifest = durable_files(item.target)
            for rel, expected in item.manifest.items():
                actual = actual_manifest.get(rel)
                if actual != expected:
                    errors.append(f"fingerprint mismatch {item.target / rel}")
                    if len(errors) >= 20:
                        break
            if len(errors) >= 20:
                break
        if errors:
            raise RuntimeError("verification failed:\n" + "\n".join(errors))

    def refresh_verification_path(self, path: Path) -> None:
        if self.dry_run:
            return
        for item in self.verifications:
            try:
                rel = path.relative_to(item.target)
            except ValueError:
                continue
            key = "." if str(rel) == "." else str(rel)
            if key in item.manifest:
                item.manifest[key] = file_fingerprint(path)

    def write_report(self) -> None:
        report = {
            "timestamp": self.timestamp,
            "stateRoot": str(self.state_root),
            "dryRun": self.dry_run,
            "counters": self.counters.__dict__,
            "notes": self.notes,
        }
        self.log(json.dumps(report, indent=2))
        if not self.dry_run:
            path = self.state_root / f"migration-report-{self.timestamp}.json"
            path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


def cleanup_empty_tree(root: Path) -> None:
    if not root.exists():
        return
    for path in sorted(root.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if path.is_dir() and not path.is_symlink():
            try:
                path.rmdir()
            except OSError:
                pass
    try:
        root.rmdir()
    except OSError:
        pass


def running_swarmfleet_containers() -> list[str]:
    try:
        result = subprocess.run(
            ["docker", "ps", "--filter", "name=swarmfleet", "--format", "{{.Names}}"],
            text=True,
            capture_output=True,
            check=False,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def migrate(args: argparse.Namespace) -> None:
    state_root = Path(os.environ.get("SWARMFLEET_STATE_DIR", str(DEFAULT_STATE_ROOT))).expanduser()
    migration = Migration(state_root=state_root, dry_run=args.dry_run, timestamp=args.timestamp or now_stamp())
    running = running_swarmfleet_containers()
    if running and not args.allow_running:
        raise SystemExit(
            "Refusing to migrate while SwarmFleet containers are running: "
            + ", ".join(running)
        )

    env_default = state_root / "env-default"
    env_2 = state_root / "env-2"

    migration.move_tree(OLD_MANAGER_ROOT / "default", env_default, "old-default-conflicts")
    migration.move_tree(REPO_ROOT / "manager" / "data" / "8e936006", env_2, "env-2-conflicts")
    migration.move_children(OLD_MANAGER_ROOT, state_root, "old-manager-root-conflicts", {"default"})

    data_home = REPO_ROOT / "data" / "home"
    ignored = migration.merge_chat_index(
        data_home / ".swarmfleet" / "chat-sessions",
        env_default / "home" / ".swarmfleet" / "chat-sessions",
        "repo-data-home",
    )
    migration.merge_tree(data_home, env_default / "home", migration.import_root / "repo-data-home", ignored)

    data_config = REPO_ROOT / "data" / "config"
    migration.merge_tree(data_config, env_default / "config", migration.import_root / "repo-data-config")
    migration.move_children(REPO_ROOT / "data", migration.import_root / "repo-data-root", "repo-data-root-conflicts", {"home", "config"})
    migration.merge_tree(REPO_ROOT / ".swarmfleet", env_default / "home" / ".swarmfleet", migration.import_root / "repo-root-swarmfleet")
    migration.merge_tree(
        REPO_ROOT / ".terminal-history",
        env_default / "home" / ".swarmfleet" / "terminal-history",
        migration.import_root / "repo-terminal-history",
    )

    manager_data = REPO_ROOT / "manager" / "data"
    if manager_data.exists() and not any(manager_data.iterdir()):
        migration.log(f"remove empty {manager_data}")
        if not migration.dry_run:
            manager_data.rmdir()

    migration.rewrite_registry()
    migration.verify()
    migration.write_report()


def main(argv: Iterable[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Migrate SwarmFleet runtime state into SWARMFLEET_STATE_DIR.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Print planned actions without changing files.")
    mode.add_argument("--execute", action="store_true", help="Apply the migration.")
    parser.add_argument("--allow-running", action="store_true", help="Allow migration while SwarmFleet containers are running.")
    parser.add_argument("--timestamp", help="Override import/report timestamp.")
    args = parser.parse_args(argv)
    if not args.execute:
        args.dry_run = True
    migrate(args)


if __name__ == "__main__":
    main()
