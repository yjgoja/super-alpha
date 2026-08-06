from __future__ import annotations

from dataclasses import dataclass

from openai import OpenAI

from .ai_openai import FOOTER_LINK, generate_structured_article


@dataclass
class ContentBlock:
    type: str  # heading | paragraph | quote | hook | point | link
    text: str
    url: str = ""


@dataclass
class BlogPost:
    keyword: str
    title: str
    blocks: list[ContentBlock]
    thumb_text: str
    html: str  # 미리보기/검증용 텍스트 조인
    plain_preview: str
    required_phrases: list[str]
    footer_link: str = FOOTER_LINK
    image_topics: list[str] | None = None


def build_seo_post_ai(
    client: OpenAI,
    keyword: str,
    required_phrases: list[str],
    *,
    brand_name: str = "올브릿지 노트",
    footer_link: str = FOOTER_LINK,
    model: str = "gpt-4o",
    section_count: int = 8,
    log=None,
) -> BlogPost:
    data = generate_structured_article(
        client,
        keyword=keyword,
        required_phrases=required_phrases,
        brand_name=brand_name,
        footer_link=footer_link,
        model=model,
        section_count=section_count,
        log=log,
    )
    blocks = [
        ContentBlock(type=b["type"], text=b["text"], url=str(b.get("url") or ""))
        for b in data["blocks"]
    ]
    joined = "\n".join(b.text for b in blocks)
    link_ok = any(b.type == "link" and (b.url == footer_link or footer_link in b.url) for b in blocks)

    missing = [p for p in required_phrases if p not in joined]
    if missing:
        raise RuntimeError(f"필수 문구 누락: {missing}")
    if not link_ok:
        raise RuntimeError(f"필수 링크 누락: {footer_link}")

    preview_lines = []
    for b in blocks:
        if b.type == "heading":
            preview_lines.append(f"[H] {b.text}")
        elif b.type == "quote":
            preview_lines.append(f"[Q] {b.text}")
        elif b.type == "hook":
            preview_lines.append(f"[HOOK] {b.text}")
        elif b.type == "link":
            preview_lines.append(f"[LINK] {b.text} -> {b.url}")
        else:
            preview_lines.append(b.text)

    return BlogPost(
        keyword=keyword.strip(),
        title=str(data["title"]).strip(),
        blocks=blocks,
        thumb_text=str(data.get("thumb_text") or f"{keyword} 핵심 정리"),
        html=joined,
        plain_preview=f"{data['title']}\n\n" + "\n\n".join(preview_lines),
        required_phrases=list(required_phrases),
        footer_link=footer_link,
        image_topics=list(data.get("image_topics") or []),
    )
