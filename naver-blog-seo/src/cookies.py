from __future__ import annotations

import json
import time
from pathlib import Path

from selenium.webdriver.remote.webdriver import WebDriver

COOKIE_FILE_NAME = "naver_cookies.json"


def cookie_path(root: Path) -> Path:
    return root / "output" / COOKIE_FILE_NAME


def save_cookies(driver: WebDriver, path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    # 네이버 도메인 쿠키 수집
    driver.get("https://www.naver.com/")
    time.sleep(1.0)
    cookies = driver.get_cookies()
    # blog.naver.com 도메인 쿠키도 합침
    try:
        driver.get("https://blog.naver.com/")
        time.sleep(0.8)
        seen = {(c.get("name"), c.get("domain"), c.get("path")) for c in cookies}
        for c in driver.get_cookies():
            key = (c.get("name"), c.get("domain"), c.get("path"))
            if key not in seen:
                cookies.append(c)
                seen.add(key)
    except Exception:
        pass

    path.write_text(json.dumps(cookies, ensure_ascii=False, indent=2), encoding="utf-8")
    return len(cookies)


def load_cookies(driver: WebDriver, path: Path) -> int:
    if not path.exists():
        return 0
    cookies = json.loads(path.read_text(encoding="utf-8"))
    if not cookies:
        return 0

    # 쿠키 주입 전 해당 도메인 열기 필요
    driver.get("https://www.naver.com/")
    time.sleep(0.8)
    driver.delete_all_cookies()

    added = 0
    for c in cookies:
        item = {
            "name": c.get("name"),
            "value": c.get("value"),
            "path": c.get("path") or "/",
        }
        if c.get("domain"):
            item["domain"] = c["domain"]
        if c.get("expiry") is not None:
            try:
                item["expiry"] = int(c["expiry"])
            except Exception:
                pass
        if "secure" in c:
            item["secure"] = bool(c["secure"])
        if "httpOnly" in c:
            item["httpOnly"] = bool(c["httpOnly"])
        # sameSite 는 드라이버별 이슈 있어 생략 가능
        try:
            # domain 이 blog면 blog로 이동 후 추가
            domain = (c.get("domain") or "").lstrip(".")
            if "blog.naver" in domain:
                if "blog.naver.com" not in driver.current_url:
                    driver.get("https://blog.naver.com/")
                    time.sleep(0.4)
            elif "nid.naver" in domain:
                if "nid.naver.com" not in driver.current_url:
                    driver.get("https://nid.naver.com/")
                    time.sleep(0.4)
            elif "naver.com" in domain and "www.naver.com" not in driver.current_url:
                driver.get("https://www.naver.com/")
                time.sleep(0.3)
            driver.add_cookie(item)
            added += 1
        except Exception:
            continue

    driver.get("https://www.naver.com/")
    time.sleep(1.0)
    return added


def has_auth_cookie_file(path: Path) -> bool:
    if not path.exists():
        return False
    try:
        cookies = json.loads(path.read_text(encoding="utf-8"))
        names = {c.get("name") for c in cookies}
        return bool(names & {"NID_AUT", "NID_SES"})
    except Exception:
        return False
