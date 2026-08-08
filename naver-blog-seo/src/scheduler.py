from __future__ import annotations

import atexit
import os
import time
from datetime import datetime
from pathlib import Path

import schedule

from .config_loader import AppConfig
from .keyword_queue import KeywordQueue
from .poster import PauseFn, LogFn, run_live_batch


def _acquire_singleton_lock(root: Path, log) -> Path:
    lock = root / "output" / "scheduler.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    if lock.exists():
        try:
            old_pid = int(lock.read_text(encoding="utf-8").strip() or "0")
        except Exception:
            old_pid = 0
        if old_pid and old_pid != os.getpid():
            try:
                os.kill(old_pid, 0)
                raise SystemExit(
                    f"스케줄러가 이미 실행 중입니다 (pid={old_pid}). 중복 실행 금지."
                )
            except OSError:
                pass
    lock.write_text(str(os.getpid()), encoding="utf-8")

    def _cleanup() -> None:
        try:
            if lock.exists() and lock.read_text(encoding="utf-8").strip() == str(os.getpid()):
                lock.unlink(missing_ok=True)
        except Exception:
            pass

    atexit.register(_cleanup)
    log(f"스케줄러 락 확보: {lock} pid={os.getpid()}")
    return lock


def start_daily_scheduler(
    cfg: AppConfig,
    *,
    log: LogFn | None = None,
    pause: PauseFn | None = None,
) -> None:
    """매일 post_times에 맞춰 발행. 하루 posts_per_day 초과 금지."""
    _log = log or print
    _acquire_singleton_lock(cfg.root, _log)
    times = list(cfg.post_times or []) or ["00:00"]

    batch_mode = len(times) == 1
    if batch_mode:
        _log(
            f"스케줄 등록(일괄): 매일 {times[0]} 에 최대 {cfg.posts_per_day}건 "
            f"(간격 {int(cfg.publish.get('delay_between_posts_sec', 90))}초)"
        )
    else:
        defaults = ["00:00", "09:30", "12:30", "15:30", "19:00", "21:00"]
        for t in defaults:
            if t not in times:
                times.append(t)
            if len(times) >= cfg.posts_per_day:
                break
        times = times[: cfg.posts_per_day]
        _log("스케줄 등록(분산): " + ", ".join(times))

    _log(f"AUTO_PUBLISH = {cfg.auto_publish}")
    _log(f"키워드 큐 크기 = {len(cfg.keywords)}")
    _log(f"하루 한도 = {cfg.posts_per_day}건 (초과분 자동 스킵)")

    def _run(count: int) -> None:
        queue = KeywordQueue(cfg.keywords, cfg.root / "output" / "keyword_state.json")
        left = queue.remaining_today(cfg.posts_per_day)
        if left <= 0:
            _log(
                f"[{datetime.now():%Y-%m-%d %H:%M:%S}] "
                f"오늘 한도({cfg.posts_per_day}) 소진 — 스킵"
            )
            return
        n = min(count, left)
        _log(
            f"[{datetime.now():%Y-%m-%d %H:%M:%S}] "
            f"예약 포스팅 {n}건 시작 (남은 한도 {left})"
        )
        run_live_batch(cfg, count=n, log=_log, pause=pause)

    if batch_mode:
        t = times[0]

        def job():
            _run(cfg.posts_per_day)

        schedule.every().day.at(t).do(job)
    else:

        def job():
            _run(1)

        for t in times:
            schedule.every().day.at(t).do(job)

    while True:
        schedule.run_pending()
        time.sleep(20)
