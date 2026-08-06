"""캐시된 최신 원고로 재발행 (노란 배경 + 가운데 정렬)."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.browser import create_driver
from src.config_loader import load_config
from src.content import BlogPost, ContentBlock
from src.editor import open_write_page, publish_post, write_post_with_images
from src.login import naver_login_with_clip


def latest_post_json() -> Path:
    files = sorted((ROOT / "output").glob("*해외선물_수수료.json"))
    if not files:
        raise SystemExit("캐시 원고 JSON 없음")
    return files[-1]


def main() -> None:
    cfg = load_config(require_openai=False)
    path = latest_post_json()
    data = json.loads(path.read_text(encoding="utf-8"))
    print(f"[REPUB] file={path.name}", flush=True)
    print(f"[REPUB] title={data['title']}", flush=True)

    thumb = Path(data["thumbnail"])
    bodies = [Path(p) for p in data["body_images"]]
    for p in [thumb, *bodies]:
        if not p.exists():
            raise SystemExit(f"이미지 없음: {p}")

    blocks = [
        ContentBlock(
            type=b["type"],
            text=b.get("text") or "",
            url=b.get("url") or "",
        )
        for b in data["blocks"]
    ]
    post = BlogPost(
        keyword=data.get("keyword") or "해외선물 수수료",
        title=data["title"],
        blocks=blocks,
        thumb_text=data.get("thumb_text") or "",
        html="\n".join(b.text for b in blocks),
        plain_preview="\n".join(b.text for b in blocks),
        required_phrases=list(data.get("required_phrases") or []),
        footer_link=data.get("footer_link") or cfg.footer_link,
    )

    profile = ROOT / ".chrome-profile-repub"
    driver = create_driver(headless=False, profile_dir=profile)
    try:
        print("[REPUB] login...", flush=True)
        naver_login_with_clip(
            driver,
            cfg.naver_id,
            cfg.naver_pw,
            root=ROOT,
            log=print,
            prefer_cookies=True,
        )
        print("[REPUB] open write...", flush=True)
        open_write_page(driver, cfg.naver_id, category_no=2)
        write_post_with_images(
            driver,
            post,
            thumbnail=thumb,
            body_images=bodies,
            required_phrases=post.required_phrases,
            footer_link=post.footer_link,
        )
        print("[REPUB] publish...", flush=True)
        url = publish_post(driver)
        print(f"[REPUB] DONE url={url}", flush=True)
        out = ROOT / "output" / "_last_repub_url.txt"
        out.write_text(str(url or ""), encoding="utf-8")
        # 발행 직후 URL이 Write면 잠시 대기 후 블로그 홈에서 최신글 확인 유도
        time.sleep(2)
        print(f"[REPUB] check https://blog.naver.com/{cfg.naver_id}", flush=True)
    finally:
        try:
            driver.quit()
        except Exception:
            pass


if __name__ == "__main__":
    main()
