"""오늘 4건: 카테고리 분산 키워드 + 서로 다른 제목으로 즉시 발행."""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.config_loader import load_config
from src.poster import run_live_batch

# 외환 / MT5 / 지표 / 주식 — 제목 겹침 최소화
TODAY_KEYWORDS = [
    "원달러 환율",
    "MT5 사용법",
    "RSI 지표",
    "나스닥 선물",
]


def main() -> int:
    cfg = load_config()
    print(f"[TODAY4] start {datetime.now():%Y-%m-%d %H:%M:%S}", flush=True)
    print(f"[TODAY4] keywords={TODAY_KEYWORDS}", flush=True)
    print(f"[TODAY4] AUTO_PUBLISH={cfg.auto_publish}", flush=True)
    results = run_live_batch(cfg, count=4, keywords=TODAY_KEYWORDS, log=print)
    out = ROOT / "output" / "_today4_urls.json"
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    ok = [r for r in results if r.get("ok")]
    print(f"[TODAY4] done ok={len(ok)}/{len(results)}", flush=True)
    for r in results:
        print(
            f"  - {r.get('keyword')} | ok={r.get('ok')} | title={r.get('title')} | url={r.get('url')}",
            flush=True,
        )
    return 0 if len(ok) == 4 else 1


if __name__ == "__main__":
    raise SystemExit(main())
