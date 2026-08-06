"""
1회 수동 로그인(캡차 포함) → 쿠키 저장.
이후 e2e/EXE 는 쿠키로 캡차 없이 로그인합니다.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from src.browser import create_driver
from src.config_loader import load_config
from src.cookies import cookie_path, save_cookies
from src.login import is_logged_in, naver_login_with_clip, wait_until_logged_in


def main() -> int:
    cfg = load_config(require_credentials=True, require_openai=False)
    path = cookie_path(cfg.root)
    print("[login_once] undetected-chrome + 쿠키 저장 모드")
    print("[login_once] 캡차가 뜨면 브라우저에서 직접 푸세요. 풀리면 쿠키 저장됩니다.")
    print(f"[login_once] cookie file => {path}")

    driver = create_driver(headless=False, profile_dir=cfg.root / ".chrome-profile")
    try:
        # 쿠키 없이 폼 로그인 (이번 1회)
        naver_login_with_clip(
            driver,
            cfg.naver_id,
            cfg.naver_pw,
            root=cfg.root,
            log=print,
            prefer_cookies=False,
            wait_captcha_sec=600,
        )
        if not is_logged_in(driver):
            print("[login_once] 대기 중...")
            wait_until_logged_in(driver, timeout_sec=600, log=print)

        if not is_logged_in(driver):
            print("[login_once] FAIL")
            return 1

        n = save_cookies(driver, path)
        print(f"[login_once] OK — 쿠키 {n}개 저장: {path}")
        driver.get(f"https://blog.naver.com/{cfg.naver_id}?Redirect=Write&categoryNo=2")
        time.sleep(3)
        print("[login_once] write url=", driver.current_url)
        return 0
    finally:
        try:
            driver.quit()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
