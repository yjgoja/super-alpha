from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))


def _sync_env_from_release() -> None:
    """배포 폴더 .env 에 키가 있으면 개발 루트로 복사."""
    release_env = ROOT / "dist" / "NaverBlogSEO_Release" / ".env"
    dest = ROOT / ".env"
    if release_env.exists():
        text = release_env.read_text(encoding="utf-8")
        if "OPENAI_API_KEY=" in text and "sk-" in text:
            shutil.copy2(release_env, dest)
            print("[e2e] synced .env from Release")


def main() -> int:
    _sync_env_from_release()
    from src.config_loader import load_config, save_env
    from src.poster import run_one_keyword

    cfg = load_config(require_credentials=True, require_openai=True)
    # E2E 는 자동발행 ON
    save_env(
        cfg.naver_id,
        cfg.naver_pw,
        openai_api_key=cfg.openai_api_key,
        auto_publish=True,
        headless=False,
    )
    cfg = load_config(require_credentials=True, require_openai=True)

    keyword = "해외선물 수수료"
    print(f"[e2e] start keyword={keyword} id={cfg.naver_id} auto_publish={cfg.auto_publish}")

    def log(msg: str) -> None:
        print(msg, flush=True)

    result = run_one_keyword(
        cfg,
        keyword,
        log=log,
        auto_publish=True,
        category_no=2,
    )
    print("[e2e] RESULT", result)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
