from __future__ import annotations

import os
from pathlib import Path

os.environ.setdefault("WDM_LOG", "0")
os.environ.setdefault("DOTENV_PATH", str(Path(__file__).resolve().parent.parent / ".env"))


def create_driver(*, headless: bool = False, profile_dir: Path | None = None):
    """
    봇탐지 완화 드라이버.
    1순위: undetected-chromedriver
    2순위: 일반 selenium + stealth 옵션
    """
    if profile_dir is None:
        profile_dir = Path(__file__).resolve().parent.parent / ".chrome-profile"
    profile_dir.mkdir(parents=True, exist_ok=True)

    # --- undetected-chromedriver ---
    try:
        import undetected_chromedriver as uc

        options = uc.ChromeOptions()
        options.add_argument("--lang=ko-KR")
        options.add_argument("--start-maximized")
        options.add_argument("--disable-popup-blocking")
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
