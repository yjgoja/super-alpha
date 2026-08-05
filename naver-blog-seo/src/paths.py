from __future__ import annotations

import sys
from pathlib import Path


def app_root() -> Path:
    """?? ??(EXE) ??, ?? ?? ? ???? ??."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def resource_root() -> Path:
    """PyInstaller ?? ??? ??(?? ?? ?? ??)."""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return app_root()


def ensure_runtime_files() -> Path:
    """EXE ?? config/.env/??? ??? ????? ??."""
    root = app_root()
    for name in ("assets/generated", "output", "logs"):
        (root / name).mkdir(parents=True, exist_ok=True)

    cfg = root / "config.yaml"
    if not cfg.exists():
        bundled = resource_root() / "config.yaml"
        if bundled.exists():
            cfg.write_text(bundled.read_text(encoding="utf-8"), encoding="utf-8")
        else:
            cfg.write_text(
                "posts_per_day: 4\n"
                "post_times: ['09:30','12:30','15:30','19:00']\n"
                "keywords:\n  - ?????\n"
                "required_phrases: []\n"
                "footer_link: https://minestock.kr\n"
                "body_image_count: 8\n"
                "openai:\n"
                "  text_model: gpt-4o\n"
                "  image_model: gpt-image-2\n"
                "  image_quality: medium\n"
                "  body_image_model: gpt-image-1-mini\n"
                "  body_image_quality: low\n"
                "content:\n"
                "  brand_name: ???? ??\n"
                "  min_sections: 7\n"
                "  min_chars: 2400\n"
                "  include_faq: true\n"
                "  include_cta: true\n"
                "  style: informational\n"
                "publish:\n"
                "  confirm_dialog: true\n"
                "  delay_between_posts_sec: 90\n"
                "images:\n"
                "  width: 1200\n"
                "  height: 675\n"
                "  thumb_width: 1280\n"
                "  thumb_height: 720\n",
                encoding="utf-8",
            )

    env = root / ".env"
    if not env.exists():
        env.write_text(
            "NAVER_ID=\nNAVER_PW=\nOPENAI_API_KEY=\nAUTO_PUBLISH=false\nHEADLESS=false\n",
            encoding="utf-8",
        )
    else:
        text = env.read_text(encoding="utf-8")
        if "OPENAI_API_KEY=" not in text:
            env.write_text(text.rstrip() + "\nOPENAI_API_KEY=\n", encoding="utf-8")
    return root
