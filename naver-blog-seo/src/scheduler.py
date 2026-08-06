from __future__ import annotations

import time
from datetime import datetime

import schedule

from .config_loader import AppConfig
from .poster import PauseFn, LogFn, run_live_batch


def start_daily_scheduler(
    cfg: AppConfig,
    *,
    log: LogFn | None = None,
    pause: PauseFn | None = None,
) -> None:
    """post_times가 1개면 그 시각에 posts_per_day건 일괄 발행.
    여러 시각이면 시각마다 1건.
    """
    _log = log or print
    times = list(cfg.post_times or [])
    if not times:
        times = ["00:00"]

    batch_mode = len(times) == 1
    if batch_mode:
        _log(
            f"스케줄 등록(일괄): 매일 {times[0]} 에 {cfg.posts_per_day}건 "
            f"(간격 {int(cfg.publish.get('delay_between_posts_sec', 90))}초)"
        )
    else:
        # 시각 부족 시 기본 슬롯 보충
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

    if batch_mode:
        t = times[0]

        def job():
            _log(
                f"[{datetime.now():%Y-%m-%d %H:%M:%S}] "
                f"예약 포스팅 {cfg.posts_per_day}건 일괄 시작"
            )
            run_live_batch(cfg, count=cfg.posts_per_day, log=_log, pause=pause)

        schedule.every().day.at(t).do(job)
    else:

        def job():
            _log(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] 예약 포스팅 1건 시작")
            run_live_batch(cfg, count=1, log=_log, pause=pause)

        for t in times:
            schedule.every().day.at(t).do(job)

    while True:
        schedule.run_pending()
        time.sleep(20)
