from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv

from .ai_openai import FOOTER_LINK
from .paths import app_root, ensure_runtime_files


@dataclass
class AppConfig:
    naver_id: str
    naver_pw: str
    openai_api_key: str
    auto_publish: bool
    headless: bool
    posts_per_day: int
    post_times: list[str]
    keywords: list[str]
    required_phrases: list[str]
    body_image_count: int
    footer_link: str
    text_model: str
    image_model: str
    content: dict[str, Any] = field(default_factory=dict)
    publish: dict[str, Any] = field(default_factory=dict)
    images: dict[str, Any] = field(default_factory=dict)
    root: Path = field(default_factory=app_root)


def save_env(
    naver_id: str,
    naver_pw: str,
    *,
    openai_api_key: str,
    auto_publish: bool,
    headless: bool,
) -> None:
    root = ensure_runtime_files()
    text = (
        f"NAVER_ID={naver_id}\n"
        f"NAVER_PW={naver_pw}\n"
        f"OPENAI_API_KEY={openai_api_key}\n"
        f"AUTO_PUBLISH={'true' if auto_publish else 'false'}\n"
        f"HEADLESS={'true' if headless else 'false'}\n"
    )
    (root / ".env").write_text(text, encoding="utf-8")


def save_config_yaml(
    *,
    keywords: list[str],
    required_phrases: list[str],
    posts_per_day: int,
    post_times: list[str],
    body_image_count: int,
    brand_name: str,
    footer_link: str = FOOTER_LINK,
    text_model: str = "gpt-4o-mini",
    image_model: str = "dall-e-3",
) -> None:
    root = ensure_runtime_files()
    data = {
        "posts_per_day": posts_per_day,
        "post_times": post_times,
        "keywords": keywords,
        "required_phrases": required_phrases,
        "body_image_count": body_image_count,
        "footer_link": footer_link,
        "openai": {
            "text_model": text_model,
            "image_model": image_model,
        },
        "content": {
            "min_sections": 4,
            "include_faq": True,
            "include_cta": True,
            "brand_name": brand_name,
            "style": "informational",
        },
        "publish": {
            "confirm_dialog": True,
            "delay_between_posts_sec": 90,
        },
        "images": {
            "width": 1200,
            "height": 675,
            "thumb_width": 1280,
            "thumb_height": 720,
        },
    }
    with (root / "config.yaml").open("w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, allow_unicode=True, sort_keys=False)


def load_config(
    config_path: Path | None = None,
    *,
    require_credentials: bool = True,
    require_openai: bool = True,
) -> AppConfig:
    root = ensure_runtime_files()
    env_path = root / ".env"
    if env_path.exists():
        load_dotenv(env_path, override=True)

    path = config_path or (root / "config.yaml")
    with path.open(encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    naver_id = os.getenv("NAVER_ID", "").strip()
    naver_pw = os.getenv("NAVER_PW", "").strip()
    openai_api_key = os.getenv("OPENAI_API_KEY", "").strip()

    if require_credentials and (not naver_id or not naver_pw):
        raise ValueError("네이버 아이디/비밀번호를 입력하고 저장하세요.")
    if require_openai and not openai_api_key:
        raise ValueError("ChatGPT(OpenAI) API 키를 입력하고 저장하세요.")

    auto_publish = os.getenv("AUTO_PUBLISH", "false").strip().lower() in {"1", "true", "yes", "y"}
    headless = os.getenv("HEADLESS", "false").strip().lower() in {"1", "true", "yes", "y"}

    keywords = [str(k).strip() for k in raw.get("keywords", []) if str(k).strip()]
    if not keywords:
        raise ValueError("키워드가 비어 있습니다.")

    # 비우면 필수문구 강제 없음 (예: "이거다" 금지 정책)
    phrases = [str(p).strip() for p in raw.get("required_phrases", []) if str(p).strip()]

    openai_cfg = dict(raw.get("openai") or {})
    footer_link = str(raw.get("footer_link") or FOOTER_LINK).strip() or FOOTER_LINK

    return AppConfig(
        naver_id=naver_id,
        naver_pw=naver_pw,
        openai_api_key=openai_api_key,
        auto_publish=auto_publish,
        headless=headless,
        posts_per_day=int(raw.get("posts_per_day", 4)),
        post_times=list(raw.get("post_times") or ["00:00"]),
        keywords=keywords,
        required_phrases=phrases,
        body_image_count=int(raw.get("body_image_count", 8)),
        footer_link=footer_link,
        text_model=str(openai_cfg.get("text_model") or "gpt-4o-mini"),
        image_model=str(openai_cfg.get("image_model") or "dall-e-3"),
        content=dict(raw.get("content") or {}),
        publish=dict(raw.get("publish") or {}),
        images=dict(raw.get("images") or {}),
        root=root,
    )
