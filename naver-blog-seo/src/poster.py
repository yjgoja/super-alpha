from __future__ import annotations

import json
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from .ai_openai import generate_ai_images, generate_structured_article, make_client
from .config_loader import AppConfig
from .content import BlogPost, ContentBlock
from .keyword_queue import KeywordQueue

LogFn = Callable[[str], None]
PauseFn = Callable[[str], None]


def prepare_post(
    cfg: AppConfig,
    keyword: str,
    *,
    log: LogFn | None = None,
) -> tuple[BlogPost, Path, list[Path]]:
    """원고 + 이미지를 병렬로 빠르게 생성."""
    _log = log or print
    client = make_client(cfg.openai_api_key)
    out_dir = cfg.root / "assets" / "generated"
    section_count = max(cfg.body_image_count, 4)

    def _text():
        return generate_structured_article(
            client,
            keyword=keyword,
            required_phrases=cfg.required_phrases,
            brand_name=str(cfg.content.get("brand_name", "올브릿지 노트")),
            footer_link=cfg.footer_link,
            model=cfg.text_model,
            section_count=section_count,
            min_chars=cfg.min_chars,
            log=_log,
        )

    # 1차: 원고 먼저 짧게 받아서 thumb_text 확보 후 이미지 병렬도 가능하지만
    # 속도를 위해 thumb_text 기본값으로 이미지와 원고을 동시에 시작
    default_thumb = f"{keyword} 핵심 정리"

    def _images(thumb_text: str = default_thumb, topics: list[str] | None = None):
        return generate_ai_images(
            client,
            keyword=keyword,
            out_dir=out_dir,
            body_count=cfg.body_image_count,
            image_model=cfg.image_model,
            image_quality=cfg.image_quality,
            body_image_model=cfg.body_image_model,
            body_image_quality=cfg.body_image_quality,
            thumb_text=thumb_text,
            image_topics=topics,
            api_key=cfg.openai_api_key,
            log=_log,
        )

    # 원고 먼저 → 문단 주제맞춤 이미지 생성
    _log("[AI] 원고 생성 후 주제맞춤 이미지 생성")
    data = _text()
    thumb_text = str(data.get("thumb_text") or default_thumb)
    image_topics = list(data.get("image_topics") or [])
    thumb, bodies = _images(thumb_text, image_topics)

    blocks = [
        ContentBlock(type=b["type"], text=b["text"], url=str(b.get("url") or ""))
        for b in data["blocks"]
    ]
    joined = "\n".join(b.text for b in blocks)
    phrases = [p for p in cfg.required_phrases if p and p not in {"이거다", "이거다!"}]
    missing = [p for p in phrases if p not in joined]
    if missing:
        raise RuntimeError(f"필수 문구 누락: {missing}")
    if "이거다" in joined:
        raise RuntimeError("금지 문구 '이거다' 가 본문에 포함되어 있습니다.")
    link_ok = any(
        b.type == "link" and (b.url == cfg.footer_link or cfg.footer_link in b.url)
        for b in blocks
    )
    if not link_ok:
        raise RuntimeError(f"필수 링크 누락: {cfg.footer_link}")

    post = BlogPost(
        keyword=keyword.strip(),
        title=str(data["title"]).strip(),
        blocks=blocks,
        thumb_text=thumb_text,
        html=joined,
        plain_preview=joined,
        required_phrases=list(cfg.required_phrases),
        footer_link=cfg.footer_link,
        image_topics=image_topics,
    )

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dump = cfg.root / "output" / f"{stamp}_{keyword.replace(' ', '_')}.json"
    dump.parent.mkdir(parents=True, exist_ok=True)
    dump.write_text(
        json.dumps(
            {
                "keyword": post.keyword,
                "title": post.title,
                "thumb_text": post.thumb_text,
                "required_phrases": post.required_phrases,
                "footer_link": post.footer_link,
                "blocks": [
                    {"type": b.type, "text": b.text, "url": b.url} for b in post.blocks
                ],
                "image_topics": image_topics,
                "thumbnail": str(thumb),
                "body_images": [str(p) for p in bodies],
                "ai": {
                    "text_model": cfg.text_model,
                    "image_model": cfg.image_model,
                    "image_quality": cfg.image_quality,
                    "body_image_model": cfg.body_image_model,
                    "body_image_quality": cfg.body_image_quality,
                    "min_chars": cfg.min_chars,
                    "char_count": data.get("char_count"),
                },
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    _log(f"[AI] 준비 완료: {post.title}")
    return post, thumb, bodies


def run_dry_batch(
    cfg: AppConfig,
    count: int | None = None,
    *,
    log: LogFn | None = None,
) -> list[dict]:
    _log = log or print
    n = count or cfg.posts_per_day
    queue = KeywordQueue(cfg.keywords, cfg.root / "output" / "keyword_state.json")
    batch = queue.next_batch(n)
    results = []
    for kw in batch:
        post, thumb, bodies = prepare_post(cfg, kw, log=_log)
        phrases = [p for p in cfg.required_phrases if p and p not in {"이거다", "이거다!"}]
        missing = [p for p in phrases if p not in post.html]
        link_ok = any(
            b.type == "link" and (b.url == cfg.footer_link or cfg.footer_link in b.url)
            for b in post.blocks
        )
        results.append(
            {
                "keyword": kw,
                "title": post.title,
                "thumbnail": str(thumb),
                "body_images": len(bodies),
                "required_ok": not missing and link_ok,
                "missing_phrases": missing,
                "footer_link_ok": link_ok,
                "blocks": len(post.blocks),
            }
        )
        _log(
            f"[DRY] {kw} | blocks={len(post.blocks)} | images={1 + len(bodies)} | "
            f"phrases_ok={not missing} | link_ok={link_ok}"
        )
    return results


def run_one_keyword(
    cfg: AppConfig,
    keyword: str,
    *,
    log: LogFn | None = None,
    pause: PauseFn | None = None,
    auto_publish: bool | None = None,
    category_no: int = 2,
) -> dict:
    """단일 키워드 작성(+선택 발행). E2E 검증용."""
    from .browser import create_driver
    from .editor import open_write_page, publish_post, write_post_with_images
    from .login import naver_login_with_clip

    _log = log or print
    do_publish = cfg.auto_publish if auto_publish is None else auto_publish
    profile = cfg.root / ".chrome-profile"
    driver = create_driver(headless=cfg.headless, profile_dir=profile)
    result = {"keyword": keyword, "ok": False, "url": None, "title": None, "error": None}
    try:
        # AI 먼저 (로그인과 무관하게 비용/품질 확인)
        post, thumb, bodies = prepare_post(cfg, keyword, log=_log)
        result["title"] = post.title

        _log("네이버 로그인... (캡차 뜨면 브라우저에서 직접 풀기)")
        naver_login_with_clip(
            driver,
            cfg.naver_id,
            cfg.naver_pw,
            root=cfg.root,
            log=_log,
            pause=pause,
            wait_captcha_sec=600,
            prefer_cookies=True,
        )
        _log(f"글쓰기 창 진입 categoryNo={category_no}")
        open_write_page(driver, cfg.naver_id, category_no=category_no)
        # 로그인 풀렸으면 재시도
        try:
            from selenium.webdriver.common.by import By
            from selenium.webdriver.support.ui import WebDriverWait
            from selenium.webdriver.support import expected_conditions as EC

            def _editor_ready(d):
                if d.find_elements(By.ID, "mainFrame"):
                    return True
                if d.find_elements(By.CSS_SELECTOR, ".se-content, textarea.se-documentTitle"):
                    return True
                return False

            WebDriverWait(driver, 12).until(_editor_ready)
        except Exception:
            _log("글쓰기 iframe 없음 → 재로그인 후 재진입")
            naver_login_with_clip(
                driver,
                cfg.naver_id,
                cfg.naver_pw,
                root=cfg.root,
                log=_log,
                pause=pause,
                wait_captcha_sec=600,
                prefer_cookies=True,
            )
            open_write_page(driver, cfg.naver_id, category_no=category_no)

        write_post_with_images(
            driver,
            post,
            thumbnail=thumb,
            body_images=bodies,
            required_phrases=cfg.required_phrases,
            footer_link=cfg.footer_link,
        )
        _log(f"입력 완료: {post.title}")
        if do_publish:
            url = publish_post(driver)
            result["url"] = url
            _log(f"자동 발행 완료 url={url}")
        else:
            _log("AUTO_PUBLISH=false → 수동 검수 대기")
            if pause:
                pause("검수 후 확인")
        result["ok"] = True
        return result
    except Exception as e:  # noqa: BLE001
        result["error"] = str(e)
        _log(f"[ERROR] {e}")
        raise
    finally:
        if not do_publish and pause:
            try:
                pause("종료하려면 확인")
            except Exception:
                pass
        driver.quit()


def run_live_batch(
    cfg: AppConfig,
    count: int | None = None,
    *,
    reuse_login: bool = True,
    log: LogFn | None = None,
    pause: PauseFn | None = None,
) -> None:
    _log = log or print
    n = count or cfg.posts_per_day
    queue = KeywordQueue(cfg.keywords, cfg.root / "output" / "keyword_state.json")
    batch = queue.next_batch(n)
    delay = int(cfg.publish.get("delay_between_posts_sec", 90))

    for i, kw in enumerate(batch, start=1):
        _log(f"=== [{i}/{n}] 키워드: {kw} ===")
        run_one_keyword(cfg, kw, log=_log, pause=pause, auto_publish=cfg.auto_publish)
        if i < n and cfg.auto_publish:
            time.sleep(delay)
