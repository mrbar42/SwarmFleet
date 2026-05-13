import importlib.util
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


class FakeMenuItem:
    def __init__(self, title, callback=None):
        self.title = title
        self.callback = callback
        self.children = []
        self._menuitem = types.SimpleNamespace(setEnabled_=lambda _enabled: None)

    def add(self, item):
        self.children.append(item)


class FakeMenu(list):
    def clear(self):
        del self[:]

    def add(self, item):
        self.append(item)


class FakeApp:
    def __init__(self, *args, **kwargs):
        self.menu = FakeMenu()
        self.title = kwargs.get("title", "")
        self.icon = kwargs.get("icon")

    def run(self):
        pass


class FakeTimer:
    instances = []

    def __init__(self, callback, interval):
        self.callback = callback
        self.interval = interval
        self.started = False
        self.stopped = False
        FakeTimer.instances.append(self)

    def start(self):
        self.started = True
        self.stopped = False

    def stop(self):
        self.stopped = True
        self.started = False


def load_manager_module():
    fake_rumps = types.SimpleNamespace(
        App=FakeApp,
        MenuItem=FakeMenuItem,
        Timer=FakeTimer,
        timer=lambda _interval: (lambda fn: fn),
        alert=lambda *args, **kwargs: 0,
        Window=lambda *args, **kwargs: types.SimpleNamespace(run=lambda: types.SimpleNamespace(clicked=False, text="")),
    )
    sys.modules["rumps"] = fake_rumps
    sys.modules.pop("swarmfleet_manager_under_test", None)
    path = Path(__file__).with_name("swarmfleet_manager.py")
    spec = importlib.util.spec_from_file_location("swarmfleet_manager_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ManagerBuildStatusTests(unittest.TestCase):
    def test_start_build_marks_running_before_thread_starts(self):
        manager = load_manager_module()
        starts = []

        class ThreadThatDoesNotRun:
            def __init__(self, target, daemon):
                self.target = target
                self.daemon = daemon

            def start(self):
                starts.append((self.target, self.daemon))

        with mock.patch.object(manager.threading, "Thread", ThreadThatDoesNotRun):
            manager.start_build(False)

        self.assertIs(manager.build["running"], True)
        self.assertEqual(manager.build["label"], "starting")
        self.assertIsNone(manager.build["pct"])
        self.assertIsNone(manager.build["error"])
        self.assertEqual(len(starts), 1)

    def test_refresh_starts_timer_while_build_is_running_and_stops_when_idle(self):
        manager = load_manager_module()
        with mock.patch.object(manager, "needs_workspace_setting", return_value=False), \
             mock.patch.object(manager, "all_envs", return_value=[]), \
             mock.patch.object(manager, "image_built", return_value=False), \
             mock.patch.object(manager, "icon_path", return_value=Path("/no/icon.png")), \
             mock.patch.object(manager, "start_build_if_missing", return_value=None), \
             mock.patch.object(manager, "should_start_default_for_workspace", return_value=False):
            app = manager.App()
            timer = app.status_timer

            manager.build.update(running=True, label="building", pct=20, error=None)
            app.refresh(None)

            self.assertIs(timer.started, True)

            manager.build.update(running=False, label="", pct=100, error=None)
            app.refresh(None)

            self.assertIs(timer.started, False)
            self.assertIs(timer.stopped, True)

    def test_build_output_parser_uses_docker_progress_detail(self):
        manager = load_manager_module()

        manager.update_build_from_output_line(
            '{"id":"layer-1","status":"Downloading","progressDetail":{"current":25,"total":100}}'
        )

        self.assertEqual(manager.build["label"], "Downloading layer-1")
        self.assertEqual(manager.build["pct"], 25)

    def test_global_refresh_timer_does_not_rebuild_menu_while_idle(self):
        manager = load_manager_module()
        refreshes = []

        class DummyApp:
            def refresh(self, sender):
                refreshes.append(sender)

        setattr(manager.rumps.App, "*app_instance", DummyApp())
        manager.build.update(running=False, label="", pct=None, error=None)

        manager.refresh_running_app("tick")

        self.assertEqual(refreshes, [])

        manager.build.update(running=True, label="building", pct=None, error=None)
        manager.refresh_running_app("tick")

        self.assertEqual(refreshes, ["tick"])

    def test_global_refresh_timer_runs_for_requested_idle_state_change(self):
        manager = load_manager_module()
        refreshes = []

        class DummyApp:
            def refresh(self, sender):
                refreshes.append(sender)

        setattr(manager.rumps.App, "*app_instance", DummyApp())
        manager.build.update(running=False, label="", pct=None, error=None)

        manager.request_refresh()
        manager.refresh_running_app("requested")
        self.assertEqual(refreshes, ["requested"])

        manager.refresh_running_app("idle")
        self.assertEqual(refreshes, ["requested"])

    def test_open_manager_logs_tails_manager_log_with_follow_flag(self):
        manager = load_manager_module()
        calls = []

        def fake_sh(*args, **kwargs):
            calls.append((args, kwargs))
            return subprocess.CompletedProcess(args, 0, "", "")

        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(manager, "LOG", Path(tmp) / "manager.log"), \
             mock.patch.object(manager.shutil, "which", return_value="/usr/bin/osascript"), \
             mock.patch.object(manager, "sh", side_effect=fake_sh):
            manager.open_manager_logs()

        self.assertEqual(calls[0][0][0], "osascript")
        script = calls[0][0][2]
        self.assertIn("tail -f", script)
        self.assertIn("manager.log", script)


if __name__ == "__main__":
    unittest.main()
