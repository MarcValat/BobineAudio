"""Real processes, not mocks: the whole point is OS-level process lifetime."""

from __future__ import annotations

import subprocess
import sys
import time


def _spawn_sleeper() -> subprocess.Popen:
    return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])


def _spawn_watcher(parent_pid: int) -> subprocess.Popen:
    code = (
        "import time\n"
        "from syncaudio.parent_watchdog import exit_when_parent_dies\n"
        f"exit_when_parent_dies({parent_pid})\n"
        "time.sleep(60)\n"
    )
    return subprocess.Popen([sys.executable, "-c", code])


def _cleanup(*procs: subprocess.Popen) -> None:
    for p in procs:
        if p.poll() is None:
            p.kill()
            p.wait()


def test_watcher_exits_when_parent_is_killed() -> None:
    parent = _spawn_sleeper()
    watcher = _spawn_watcher(parent.pid)
    try:
        time.sleep(2.0)
        assert watcher.poll() is None, "watcher must stay alive while its parent lives"
        parent.kill()  # a hard kill: no exit handler of the parent's ever runs
        parent.wait()
        watcher.wait(timeout=10)
        assert watcher.returncode == 0
    finally:
        _cleanup(parent, watcher)


def test_watcher_exits_right_away_if_parent_is_already_gone() -> None:
    parent = _spawn_sleeper()
    parent.kill()
    parent.wait()
    watcher = _spawn_watcher(parent.pid)
    try:
        watcher.wait(timeout=10)
        assert watcher.returncode == 0
    finally:
        _cleanup(watcher)
