from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def _font(size: int) -> ImageFont.ImageFont:
    candidates = [
        r"C:\Windows\Fonts\malgunbd.ttf",
        r"C:\Windows\Fonts\malgun.ttf",
        r"C:\Windows\Fonts\NanumGothicBold.ttf",
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


def _wrap(text: str, max_chars: int) -> list[str]:
    t = text.strip()
    if not t:
        return []
    if len(t) <= max_chars:
        return [t]
    lines: list[str] = []
    buf = ""
    for ch in t:
        buf += ch
        if len(buf) >= max_chars:
            lines.append(buf)
            buf = ""
        if len(lines) >= 3:
            break
    if buf and len(lines) < 3:
        lines.append(buf)
    return lines


def overlay_keyword_on_thumbnail(
    src: Path,
    dst: Path,
    *,
    keyword: str,
    subtitle: str = "",
) -> Path:
    """
    AI 배경(글자 없음) 위에 맑은고딕으로 한글 문구를 올린다.
    - 메인: thumb_text(클릭 유도)
    - 서브: keyword
    """
    img = Image.open(src).convert("RGBA")
    w, h = img.size
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    # 하단 그라데이션 바 (가독성)
    bar_h = int(h * 0.42)
    for y in range(bar_h):
        alpha = int(210 * (y / max(bar_h, 1)))
        draw.rectangle((0, h - bar_h + y, w, h - bar_h + y + 1), fill=(8, 12, 22, alpha))

    main = (subtitle or keyword).strip()
    sub = keyword.strip()
    # 메인이 키워드와 같으면 서브는 보조 문구
    if main == sub:
        sub = f"{keyword} 핵심 정리"

    main_font = _font(max(48, w // 14))
    sub_font = _font(max(28, w // 28))
    main_size = int(getattr(main_font, "size", 48) or 48)

    lines = _wrap(main, max_chars=10 if w < 1200 else 12)
    y = h - bar_h + 36
    for line in lines:
        # 살짝 그림자
        draw.text((50, y + 2), line, font=main_font, fill=(0, 0, 0, 160))
        draw.text((48, y), line, font=main_font, fill=(255, 255, 255, 255))
        y += int(main_size * 1.2)

    draw.text((50, min(y + 10, h - 56) + 1), sub[:28], font=sub_font, fill=(0, 0, 0, 140))
    draw.text((48, min(y + 10, h - 56)), sub[:28], font=sub_font, fill=(210, 220, 235, 255))

    out = Image.alpha_composite(img, overlay).convert("RGB")
    dst.parent.mkdir(parents=True, exist_ok=True)
    out.save(dst, format="JPEG", quality=93)
    return dst
