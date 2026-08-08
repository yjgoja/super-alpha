from __future__ import annotations

import json
import time
from collections.abc import Callable
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
    """원고 먼저 → 이미지 순차 생성 (OpenAI 모듈 데드락 방지)."""
    _log = log or print
    client = make_client(cfg.openai_api_key)
    out_dir = cfg.root / "assets" / "generated"
    section_count = max(cfg.body_image_count, 4)

    min_chars = int(cfg.content.get("min_chars") or 2400)
    _log("[AI] 원고 생성 시작")
    data = generate_structured_article(
        client,
        keyword=keyword,
        required_phrases=cfg.required_phrases,
        brand_name=str(cfg.content.get("brand_name", "올브릿지 노트")),
        footer_link=cfg.footer_link,
        model=cfg.text_model,
        section_count=section_count,
        min_chars=min_chars,
        log=_log,
    )
    thumb_text = str(data.get("thumb_text") or f"{keyword} 핵심 정리")

    _log("[AI] 이미지 생성 시작")
    thumb, bodies = generate_ai_images(
        client,
        keyword=keyword,
        out_dir=out_dir,
        body_count=cfg.body_image_count,
        image_model=cfg.image_model,
        thumb_text=thumb_text,
        api_key=cfg.openai_api_key,
        log=_log,
    )

    blocks = [
        ContentBlock(type=b["type"], text=b.get("text") or "", url=str(b.get("url") or ""))
        for b in data["blocks"]
    ]
    joined = "\n".join(b.text for b in blocks)
    missing = [p for p in cfg.required_phrases if p not in joined]
    if missing:
        raise RuntimeError(f"필수 문구 누락: {missing}")
    link_ok = any(
        b.type == "link" and (b.url == cfg.footer_link or cfg.footer_link in (b.url or b.text))
        for b in blocks
    ) or cfg.footer_link in joined
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
                "related_keywords": list(data.get("related_keywords") or []),
                "blocks": [
                    {"type": b.type, "text": b.text, "url": b.url}
                    for b in post.blocks
                ],
                "thumbnail": str(thumb),
                "body_images": [str(p) for p in bodies],
                "ai": {"text_model": cfg.text_model, "image_model": cfg.image_model},
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
        missing = [p for p in cfg.required_phrases if p not in post.html]
        link_ok = cfg.footer_link in post.html
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
    profile_dir: Path | None = None,
    forbidden_titles: set[str] | None = None,
) -> dict:
    """단일 키워드 작성(+선택 발행). E2E 검증용."""
    from .browser import create_driver
    from .editor import open_write_page, publish_post, write_post_with_images
    from .login import naver_login_with_clip

    _log = log or print
    do_publish = cfg.auto_publish if auto_publish is None else auto_publish
    profile = profile_dir or (cfg.root / ".chrome-profile-once")
    driver = create_driver(headless=cfg.headless, profile_dir=profile)
    result = {"keyword": keyword, "ok": False, "url": None, "title": None, "error": None}
    try:
        _log("네이버 로그인...")
        naver_login_with_clip(
            driver,
            cfg.naver_id,
            cfg.naver_pw,
            root=cfg.root,
            log=_log,
            prefer_cookies=True,
        )
        post, thumb, bodies = prepare_post(cfg, keyword, log=_log)
        banned = forbidden_titles or set()
        if post.title.strip() in banned:
            _log(f"[AI] 제목 중복 → 재생성: {post.title}")
            post, thumb, bodies = prepare_post(cfg, keyword, log=_log)
            if post.title.strip() in banned:
                post.title = f"{keyword} 실무 가이드 {datetime.now():%m%d%H%M}"
                _log(f"[AI] 제목 강제 유니크: {post.title}")
        result["title"] = post.title
        _log(f"글쓰기 창 진입 categoryNo={category_no}")
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
        try:
            driver.quit()
        except Exception:
            pass


def run_live_batch(
    cfg: AppConfig,
    count: int | None = None,
    *,
    reuse_login: bool = True,
    log: LogFn | None = None,
    pause: PauseFn | None = None,
    keywords: list[str] | None = None,
) -> list[dict]:
    """성공한 건만 키워드 커서를 전진. 하루 posts_per_day 상한 강제. 제목 중복 금지."""
    _log = log or print
    queue = KeywordQueue(cfg.keywords, cfg.root / "output" / "keyword_state.json")
    remaining = queue.remaining_today(cfg.posts_per_day)
    want = count if count is not None else cfg.posts_per_day
    n = min(int(want), remaining)
    _log(
        f"[BATCH] 오늘 이미 {queue.posted_today()}건 / 한도 {cfg.posts_per_day}건 "
        f"→ 이번 실행 {n}건"
    )
    if n <= 0:
        _log("[BATCH] 오늘 한도 소진 — 발행 안 함")
        return []

    delay = int(cfg.publish.get("delay_between_posts_sec", 90))
    used_titles: set[str] = set()
    results: list[dict] = []

    for i in range(1, n + 1):
        if queue.remaining_today(cfg.posts_per_day) <= 0:
            _log("[BATCH] 오늘 한도 도달 — 중단")
            break
        if keywords is not None:
            if i - 1 >= len(keywords):
                break
            kw = keywords[i - 1]
        else:
            kw = queue.peek_one()
        _log(f"=== [{i}/{n}] 키워드: {kw} ===")
        try:
            result = run_one_keyword(
                cfg,
                kw,
                log=_log,
                pause=pause,
                auto_publish=cfg.auto_publish,
                forbidden_titles=used_titles,
            )
        except Exception as e:  # noqa: BLE001
            results.append({"keyword": kw, "ok": False, "error": str(e)})
            _log(f"[BATCH] 실패로 중단: {kw} / {e}")
            break
        if result.get("title"):
            used_titles.add(str(result["title"]).strip())
        if result.get("ok"):
            queue.commit_one(kw, advance_cursor=keywords is None)
        results.append(result)
        if i < n and cfg.auto_publish:
            time.sleep(delay)

    out = cfg.root / "output" / f"batch_{datetime.now():%Y%m%d_%H%M%S}.json"
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    _log(f"[BATCH] 결과 저장: {out}")
    return results
