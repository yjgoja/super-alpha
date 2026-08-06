from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def _font(size: int) -> ImageFont.ImageFont:
    candidates = [
        r"C:\Windows\Fonts\malgunbd.ttf",
        r"C:\Windows\Fonts\malgun.ttf",
        r"C:\Windows\Fonts\arialbd.ttf",
        "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size=size)
            except OSError:
                continue
    return ImageFont.load_default()


def overlay_keyword_on_thumbnail(
    src: Path,
    dst: Path,
    *,
    keyword: str,
    subtitle: str = "",
) -> Path:
    """썸네일 위에 키워드 문구를 크게 올려 대표이미지 생성."""
    img = Image.open(src).convert("RGBA")
    w, h = img.size
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    bar_h = int(h * 0.38)
    for y in range(bar_h):
        alpha = int(180 * (y / max(bar_h, 1)))
        draw.rectangle((0, h - bar_h + y, w, h - bar_h + y + 1), fill=(10, 16, 28, alpha))

    title = keyword.strip()
    sub = (subtitle or f"{keyword} 핵심 정리").strip()
    title_font = _font(max(42, w // 18))
    sub_font = _font(max(26, w // 32))

    max_chars = 12 if len(title) > 12 else max(len(title), 1)
    lines = [title[i : i + max_chars] for i in range(0, len(title), max_chars)][:3]
    y = h - bar_h + 28
    title_size = int(getattr(title_font, "size", 42) or 42)
    for line in lines:
        draw.text((48, y), line, font=title_font, fill=(255, 255, 255, 255))
        y += int(title_size * 1.25)
    draw.text((48, min(y + 8, h - 48)), sub[:40], font=sub_font, fill=(230, 235, 245, 255))

    out = Image.alpha_composite(img, overlay).convert("RGB")
    dst.parent.mkdir(parents=True, exist_ok=True)
    out.save(dst, format="JPEG", quality=92)
    return dst
