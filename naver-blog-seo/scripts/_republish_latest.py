from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.config_loader import load_config, save_env
from src.content import BlogPost, ContentBlock
from src.browser import create_driver
from src.editor import open_write_page, publish_post, write_post_with_images
from src.login import naver_login_with_clip


def main() -> int:
    files = sorted((ROOT / "output").glob("*해외선물_수수료.json"))
    path = files[-1]
    data = json.loads(path.read_text(encoding="utf-8"))
    print("[republish]", path.name, data["title"])

    joined = "\n".join(b["text"] for b in data["blocks"])
    if "이거다" in joined:
        raise SystemExit("금지 문구 이거다 포함 — 중단")

    cfg = load_config()
    save_env(cfg.naver_id, cfg.naver_pw, openai_api_key=cfg.openai_api_key, auto_publish=True, headless=False)
    cfg = load_config()

    post = BlogPost(
        keyword=data["keyword"],
        title=data["title"],
        blocks=[
            ContentBlock(type=b["type"], text=b["text"], url=str(b.get("url") or ""))
            for b in data["blocks"]
        ],
        thumb_text=data.get("thumb_text") or "",
        html=joined,
        plain_preview=joined,
        required_phrases=[],
        footer_link=data.get("footer_link") or "https://minestock.kr",
        image_topics=list(data.get("image_topics") or []),
    )
    thumb = Path(data["thumbnail"])
    bodies = [Path(p) for p in data["body_images"]]

    driver = create_driver(headless=False, profile_dir=cfg.root / ".chrome-profile")
    try:
        naver_login_with_clip(
            driver,
            cfg.naver_id,
            cfg.naver_pw,
            root=cfg.root,
            prefer_cookies=True,
            wait_captcha_sec=600,
        )
        open_write_page(driver, cfg.naver_id, category_no=2)
        write_post_with_images(
            driver,
            post,
            thumbnail=thumb,
            body_images=bodies,
            required_phrases=[],
            footer_link=post.footer_link,
        )
        url = publish_post(driver)
        print("[republish] OK", url)
        return 0
    finally:
        driver.quit()


if __name__ == "__main__":
    raise SystemExit(main())
