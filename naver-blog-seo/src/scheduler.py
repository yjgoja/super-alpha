from __future__ import annotations

import time
from datetime import datetime

import schedule

from .config_loader import AppConfig
from .poster import LogFn, PauseFn, run_live_batch


def start_daily_scheduler(
    cfg: AppConfig,
    *,
    log: LogFn | None = None,
    pause: PauseFn | None = None,
) -> None:
    _log = log or print
    times = cfg.post_times[: cfg.posts_per_day]
    if len(times) < cfg.posts_per_day:
        defaults = ["09:30", "12:30", "15:30", "19:00", "21:00", "22:30"]
        for t in defaults:
            if t not in times:
                times.append(t)
            if len(times) >= cfg.posts_per_day:
                break
        times = times[: cfg.posts_per_day]

    _log("스케줄 등록: " + ", ".join(times))
    _log(f"AUTO_PUBLISH = {cfg.auto_publish}")

    def job():
        _log(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] 예약 포스팅 1건 시작")
        run_live_batch(cfg, count=1, log=_log, pause=pause)

    for t in times:
        schedule.every().day.at(t).do(job)

    while True:
        schedule.run_pending()
        time.sleep(20)
