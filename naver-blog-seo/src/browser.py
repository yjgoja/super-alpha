from __future__ import annotations

import os
from pathlib import Path

os.environ.setdefault("WDM_LOG", "0")
os.environ.setdefault("DOTENV_PATH", str(Path(__file__).resolve().parent.parent / ".env"))


def _sanitize_profile(profile_dir: Path) -> None:
    """
    비정상 종료 흔적을 지운다.

    Chrome 이 강제 종료되면 Preferences 에 exit_type="Crashed" 가 남고, 다음
    실행 때 "페이지를 복원하시겠습니까?" 알림이 뜬다. 그 알림이 에디터 화면을
    가려서 input[type=file] 같은 요소를 못 찾는다 (2026-08-09 썸네일 업로드 실패).
    Preferences 가 통째로 손상됐으면 지운다 — Chrome 이 기본값으로 다시 만든다.
    """
    import json

    pref = profile_dir / "Default" / "Preferences"
    if not pref.exists():
        return
    try:
        # 정상 Preferences 는 수백 KB 다. 비정상적으로 크면 손상으로 본다
        # (실제로 2.3GB 까지 부풀어 Chrome 이 기동 직후 죽은 적이 있다).
        if pref.stat().st_size > 20 * 1024 * 1024:
            pref.unlink()
            print(f"[browser] 손상된 Preferences 제거 ({pref})")
            return
        data = json.loads(pref.read_text(encoding="utf-8"))
        prof = data.setdefault("profile", {})
        if prof.get("exit_type") != "Normal" or prof.get("exited_cleanly") is not True:
            prof["exit_type"] = "Normal"
            prof["exited_cleanly"] = True
            pref.write_text(json.dumps(data), encoding="utf-8")
            print("[browser] 이전 비정상 종료 흔적 정리")
    except Exception as e:
        print(f"[browser] 프로필 정리 실패(무시): {e}")


def create_driver(*, headless: bool = False, profile_dir: Path | None = None):
    """
    봇탐지 완화 드라이버.
    1순위: undetected-chromedriver
    2순위: 일반 selenium + stealth 옵션
    """
    if profile_dir is None:
        profile_dir = Path(__file__).resolve().parent.parent / ".chrome-profile"
    profile_dir.mkdir(parents=True, exist_ok=True)
    _sanitize_profile(profile_dir)

    # --- undetected-chromedriver ---
    try:
        import undetected_chromedriver as uc

        options = uc.ChromeOptions()
        options.add_argument("--lang=ko-KR")
        options.add_argument("--start-maximized")
        options.add_argument("--disable-popup-blocking")
        options.add_argument("--disable-session-crashed-bubble")
        options.add_argument("--hide-crash-restore-bubble")
        options.add_argument("--no-first-run")
        options.add_argument(f"--user-data-dir={str(profile_dir.resolve())}")
        options.add_argument("--profile-directory=Default")
        if headless:
            options.add_argument("--headless=new")
            options.add_argument("--window-size=1920,1080")

        driver = uc.Chrome(options=options, use_subprocess=True)
        _apply_stealth_cdp(driver)
        return driver
    except Exception as e:
        print(f"[browser] undetected-chromedriver 실패 → selenium fallback: {e}")

    # --- selenium fallback ---
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.chrome.service import Service
    from webdriver_manager.chrome import ChromeDriverManager

    options = Options()
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument("--disable-session-crashed-bubble")
    options.add_argument("--hide-crash-restore-bubble")
    options.add_argument("--no-first-run")
    options.add_argument("--lang=ko-KR")
    options.add_argument("--start-maximized")
    options.add_argument(f"--user-data-dir={str(profile_dir.resolve())}")
    options.add_argument("--profile-directory=Default")
    options.add_experimental_option("excludeSwitches", ["enable-automation", "enable-logging"])
    options.add_experimental_option("useAutomationExtension", False)
    if headless:
        options.add_argument("--headless=new")
        options.add_argument("--window-size=1920,1080")

    driver = webdriver.Chrome(
        service=Service(ChromeDriverManager().install()),
        options=options,
    )
    _apply_stealth_cdp(driver)
    return driver


def _apply_stealth_cdp(driver) -> None:
    try:
        ua = driver.execute_script("return navigator.userAgent;") or ""
        ua = ua.replace("HeadlessChrome", "Chrome")
        driver.execute_cdp_cmd(
            "Network.setUserAgentOverride",
            {
                "userAgent": ua,
                "acceptLanguage": "ko-KR,ko;q=0.9,en-US;q=0.8",
                "platform": "Windows",
            },
        )
        driver.execute_cdp_cmd(
            "Page.addScriptToEvaluateOnNewDocument",
            {
                "source": """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'languages', {get: () => ['ko-KR','ko','en-US','en']});
Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5]});
window.chrome = window.chrome || { runtime: {} };
""",
            },
        )
    except Exception:
        pass
