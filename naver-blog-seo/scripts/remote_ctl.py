#!/usr/bin/env python3
"""Phone / Cursor remote control for naver-blog-seo automation.

Usage:
  python scripts/remote_ctl.py status
  python scripts/remote_ctl.py dry-run [--count N]
  python scripts/remote_ctl.py once [--count N]
  python scripts/remote_ctl.py schedule
  python scripts/remote_ctl.py stop
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATE_DIR = ROOT / "output"
PID_FILE = STATE_DIR / "remote_ctl.pid"
STATUS_FILE = STATE_DIR / "remote_ctl_status.json"
LOG_FILE = STATE_DIR / "remote_ctl.log"


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _write_status(payload: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATUS_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _read_status() -> dict:
    if not STATUS_FILE.exists():
        return {"running": False, "mode": None}
    try:
        return json.loads(STATUS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"running": False, "mode": None, "error": "status corrupt"}


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        if os.name == "nt":
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}"],
                capture_output=True,
                text=True,
                check=False,
            )
            return str(pid) in (out.stdout or "")
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def cmd_status(_: argparse.Namespace) -> int:
    st = _read_status()
    pid = int(st.get("pid") or 0)
    alive = _pid_alive(pid) if pid else False
    if st.get("running") and not alive:
        st["running"] = False
        st["note"] = "pid gone"
        _write_status(st)
    print(json.dumps({**st, "alive": alive, "checkedAt": _now()}, ensure_ascii=False, indent=2))
    return 0


def _spawn(mode: str, count: int | None) -> int:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    prev = _read_status()
    prev_pid = int(prev.get("pid") or 0)
    if prev.get("running") and _pid_alive(prev_pid):
        print(json.dumps({"ok": False, "error": "already running", "pid": prev_pid}, ensure_ascii=False))
        return 1

    py = sys.executable
    args = [py, str(ROOT / "main.py"), mode]
    if count is not None:
        args.extend(["--count", str(count)])

    log_f = open(LOG_FILE, "a", encoding="utf-8")
    log_f.write(f"\n===== {_now()} start {mode} count={count} =====\n")
    log_f.flush()

    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]

    proc = subprocess.Popen(
        args,
        cwd=str(ROOT),
        stdout=log_f,
        stderr=subprocess.STDOUT,
        creationflags=creationflags,
    )
    payload = {
        "ok": True,
        "running": True,
        "mode": mode,
        "count": count,
        "pid": proc.pid,
        "startedAt": _now(),
        "log": str(LOG_FILE),
    }
    PID_FILE.write_text(str(proc.pid), encoding="utf-8")
    _write_status(payload)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def cmd_stop(_: argparse.Namespace) -> int:
    st = _read_status()
    pid = int(st.get("pid") or 0)
    if not pid or not _pid_alive(pid):
        st.update({"running": False, "stoppedAt": _now(), "note": "not running"})
        _write_status(st)
        print(json.dumps({"ok": True, "stopped": False, "reason": "not running"}, ensure_ascii=False))
        return 0
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], check=False)
        else:
            os.kill(pid, signal.SIGTERM)
            time.sleep(0.5)
            if _pid_alive(pid):
                os.kill(pid, signal.SIGKILL)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 1
    st.update({"running": False, "stoppedAt": _now(), "pid": pid})
    _write_status(st)
    if PID_FILE.exists():
        PID_FILE.unlink(missing_ok=True)  # type: ignore[call-arg]
    print(json.dumps({"ok": True, "stopped": True, "pid": pid}, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Remote control for naver-blog-seo")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    for name in ("dry-run", "once", "schedule"):
        sp = sub.add_parser(name)
        sp.add_argument("--count", type=int, default=None)
    sub.add_parser("stop")
    return p


def main() -> int:
    args = build_parser().parse_args()
    if args.cmd == "status":
        return cmd_status(args)
    if args.cmd == "stop":
        return cmd_stop(args)
    if args.cmd in {"dry-run", "once", "schedule"}:
        count = getattr(args, "count", None)
        return _spawn(args.cmd, count)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
