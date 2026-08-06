"""오프라인 QA: CTA normalize + 스케줄 설정."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.ai_openai import _normalize_article  # noqa: E402
from src.config_loader import load_config  # noqa: E402


def main() -> int:
    title, thumb, blocks = _normalize_article(
        {
            "title": "RSI 지표 보는법 핵심 정리",
            "thumb_text": "RSI 핵심",
            "blocks": [
                {"type": "hook", "text": "과매수 구간을 어떻게 볼까?"},
                {"type": "heading", "text": "1. RSI란"},
                {"type": "paragraph", "text": "RSI 지표는 모멘텀을 봅니다."},
                {"type": "point", "text": "구간보다 추세 확인이 먼저다"},
            ],
        },
        required_phrases=[],
        footer_link="https://minestock.kr",
    )
    links = [b for b in blocks if b["type"] == "link"]
    assert title.startswith("RSI"), title
    assert len(links) >= 2, links
    assert all(b["text"] == "자세히 알아보기" for b in links), links
    assert all(b["url"] == "https://minestock.kr" for b in links), links
    print("OK_NORMALIZE", len(blocks), "links", len(links), "thumb", thumb)

    cfg = load_config(require_credentials=False, require_openai=False)
    assert cfg.posts_per_day == 4, cfg.posts_per_day
    assert cfg.post_times == ["00:00"], cfg.post_times
    cats = {"외환": 0, "mt5": 0, "주식": 0, "지표": 0}
    for kw in cfg.keywords:
        s = kw.lower()
        if any(x in s for x in ("환율", "환전", "외환", "해외선물")):
            cats["외환"] += 1
        if any(x in s for x in ("mt5", "메타트레이더", "ea ", "ea자동", "자동매매")):
            cats["mt5"] += 1
        if any(x in s for x in ("주식", "나스닥", "배당", "etf", "선물옵션", "골드 선물")):
            cats["주식"] += 1
        if any(
            x in s
            for x in ("rsi", "이동평균", "볼린저", "macd", "스토캐", "골든", "기술적", "차트 분석", "차트 보는")
        ):
            cats["지표"] += 1
    print("OK_KEYWORDS", len(cfg.keywords), cats)
    assert all(v >= 4 for v in cats.values()), cats
    print("OK_ALL")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
