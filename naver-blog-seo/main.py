from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="네이버 블로그 SEO 자동 포스팅",
    )
    p.add_argument(
        "mode",
        nargs="?",
        default="gui",
        choices=["gui", "dry-run", "once", "schedule"],
        help="gui(기본) | dry-run | once | schedule",
    )
    p.add_argument("--count", type=int, default=None)
    p.add_argument("--config", type=Path, default=None)
    return p


def main() -> int:
    args = build_parser().parse_args()

    if args.mode == "gui" or len(sys.argv) == 1:
        from gui_app import main as gui_main

        gui_main()
        return 0

    from src.config_loader import load_config
    from src.poster import run_dry_batch, run_live_batch
    from src.scheduler import start_daily_scheduler

    need_creds = args.mode != "dry-run"
    cfg = load_config(args.config, require_credentials=need_creds, require_openai=True)

    if args.mode == "dry-run":
        results = run_dry_batch(cfg, count=args.count)
        ok = all(
            r["required_ok"] and r["body_images"] >= cfg.body_image_count and r.get("footer_link_ok", False)
            for r in results
        )
        print("결과:", "OK" if ok else "FAIL", f"({len(results)}건)")
        return 0 if ok else 1

    if args.mode == "once":
        run_live_batch(cfg, count=args.count)
        return 0

    if args.mode == "schedule":
        start_daily_scheduler(cfg)
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
