from __future__ import annotations

import hashlib
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def _slug(text: str) -> str:
    s = re.sub(r"[^\w가-힣\-]+", "-", text.strip(), flags=re.UNICODE)
    return s.strip("-")[:40] or "keyword"


def _palette(seed: str) -> tuple[tuple[int, int, int], tuple[int, int, int], tuple[int, int, int]]:
    h = hashlib.md5(seed.encode("utf-8")).hexdigest()
    base = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    # 너무 어두운/밝은 색 보정
    base = tuple(max(40, min(180, c)) for c in base)  # type: ignore[assignment]
    accent = (min(255, base[0] + 60), min(255, base[1] + 40), min(255, base[2] + 20))
    text = (245, 245, 245)
    return base, accent, text  # type: ignore[return-value]


def _font(size: int) -> ImageFont.ImageFont:
    candidates = [
        r"C:\Windows\Fonts\malgunbd.ttf",
        r"C:\Windows\Fonts\malgun.ttf",
        r"C:\Windows\Fonts\arial.ttf",
        "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf",
        "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    ]
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size=size)
            except OSError:
                continue
    return ImageFont.load_default()


def _draw_card(
    path: Path,
    *,
    width: int,
    height: int,
    title: str,
    subtitle: str,
    badge: str,
) -> Path:
    bg, accent, fg = _palette(title + subtitle)
    img = Image.new("RGB", (width, height), bg)
    draw = ImageDraw.Draw(img)

    # 분위기용 대각 밴드
    draw.polygon(
        [(0, height * 0.55), (width, height * 0.2), (width, height), (0, height)],
        fill=accent,
    )
    draw.rectangle((0, 0, width, 18), fill=fg)

    title_font = _font(54 if width >= 1000 else 36)
    sub_font = _font(30 if width >= 1000 else 22)
    badge_font = _font(24)

    draw.rounded_rectangle((48, 48, 48 + 220, 48 + 52), radius=12, fill=(20, 20, 20))
    draw.text((64, 58), badge, font=badge_font, fill=fg)

    # 제목 줄바꿈
    max_chars = 18 if width >= 1000 else 14
    lines = [title[i : i + max_chars] for i in range(0, len(title), max_chars)][:3]
    y = height // 3
    for line in lines:
        draw.text((56, y), line, font=title_font, fill=fg)
        y += 66

    draw.text((56, y + 20), subtitle, font=sub_font, fill=(230, 230, 230))
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, format="JPEG", quality=90)
    return path


def generate_post_images(
    keyword: str,
    out_dir: Path,
    *,
    body_count: int = 8,
    width: int = 1200,
    height: int = 675,
    thumb_width: int = 1280,
    thumb_height: int = 720,
) -> tuple[Path, list[Path]]:
    """썸네일 1장 + 본문 이미지 N장 생성."""
    slug = _slug(keyword)
    base = out_dir / slug
    base.mkdir(parents=True, exist_ok=True)

    thumb = _draw_card(
        base / "thumb.jpg",
        width=thumb_width,
        height=thumb_height,
        title=keyword,
        subtitle="SEO 가이드 썸네일",
        badge="THUMBNAIL",
    )

    bodies: list[Path] = []
    captions = [
        "개념 한눈에",
        "왜 중요한가",
        "실전 단계",
        "체크리스트",
        "주의할 점",
        "예시 화면",
        "FAQ 요약",
        "핵심 정리",
        "추가 팁",
        "마무리",
    ]
    for i in range(1, body_count + 1):
        cap = captions[(i - 1) % len(captions)]
        p = _draw_card(
            base / f"body_{i:02d}.jpg",
            width=width,
            height=height,
            title=f"{keyword}",
            subtitle=f"{i}/{body_count} · {cap}",
            badge=f"IMG {i:02d}",
        )
        bodies.append(p)

    return thumb, bodies
