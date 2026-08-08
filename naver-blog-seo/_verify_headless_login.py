"""
headless 로그인 검증 — 글은 절대 쓰지 않는다.

poster.py 와 똑같은 조건(headless, .chrome-profile-once, 쿠키 재사용)으로
로그인만 해보고 결과를 알린다. 네이버가 headless 를 봇으로 막는지 확인용.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from src.browser import create_driver
from src.config_loader import load_config
from src.login import is_logged_in, naver_login_with_clip


def main() -> int:
    cfg = load_config(require_credentials=True, require_openai=False)
    print(f"[verify] HEADLESS={cfg.headless}")
    profile = cfg.root / ".chrome-profile-once"  # poster.py 와 동일
    driver = create_driver(headless=cfg.headless, profile_dir=profile)
    try:
        naver_login_with_clip(
            driver,
            cfg.naver_id,
            cfg.naver_pw,
            root=cfg.root,
            log=print,
            prefer_cookies=True,
        )
        if not is_logged_in(driver):
            print("[verify] FAIL — 로그인 안 됨")
            return 1

        # 글쓰기 화면까지 열리는지 (여기서 멈춘다 — 아무것도 입력/발행하지 않음)
        driver.get(f"https://blog.naver.com/{cfg.naver_id}?Redirect=Write&categoryNo=2")
        url = driver.current_url
        print(f"[verify] 글쓰기 화면 url={url}")
        ok = "blog.naver.com" in url and "nidlogin" not in url
        print("[verify] OK — headless 로그인·글쓰기 진입 성공" if ok else "[verify] FAIL — 글쓰기 진입 실패")
        return 0 if ok else 1
    except Exception as e:
        print(f"[verify] FAIL — {type(e).__name__}: {str(e).splitlines()[0][:200]}")
        return 1
    finally:
        try:
            driver.quit()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
