from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path

import pyperclip
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.remote.webdriver import WebDriver
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

from .cookies import cookie_path, has_auth_cookie_file, load_cookies, save_cookies

LogFn = Callable[[str], None]
PauseFn = Callable[[str], None]


def _click_any(driver: WebDriver, selectors: list[tuple], timeout: int = 4) -> bool:
    for by, value in selectors:
        try:
            el = WebDriverWait(driver, timeout).until(EC.element_to_be_clickable((by, value)))
            el.click()
            return True
        except Exception:
            continue
    return False


def _has_login_cookies(driver: WebDriver) -> bool:
    try:
        names = {c.get("name") for c in driver.get_cookies()}
        return bool(names & {"NID_AUT", "NID_SES"})
    except Exception:
        return False


def captcha_visible(driver: WebDriver) -> bool:
    try:
        html = (driver.page_source or "").lower()
        if any(k in html for k in ["captcha", "캡차", "자동입력", "보안문자", "newcaptcha", "rcaptcha"]):
            return True
        for sel in ["#captcha", "#captchaimg", "img.captcha_img", "#rcaptcha_img", ".captcha"]:
            for el in driver.find_elements(By.CSS_SELECTOR, sel):
                if el.is_displayed():
                    return True
    except Exception:
        pass
    return False


def is_logged_in(driver: WebDriver) -> bool:
    try:
        if _has_login_cookies(driver):
            return True
        driver.get("https://www.naver.com/")
        time.sleep(1.0)
        if _has_login_cookies(driver):
            return True
        for a in driver.find_elements(By.CSS_SELECTOR, "a.link_login"):
            if a.is_displayed():
                return False
    except Exception:
        pass
    return False


def _cdp_insert_text(driver: WebDriver, text: str) -> None:
    try:
        driver.execute_cdp_cmd("Input.insertText", {"text": text})
    except Exception:
        pyperclip.copy(text)
        driver.switch_to.active_element.send_keys(Keys.CONTROL, "v")


def wait_until_logged_in(driver: WebDriver, *, timeout_sec: int = 300, log: LogFn | None = None) -> bool:
    _log = log or (lambda m: None)
    deadline = time.time() + timeout_sec
    warned = False
    while time.time() < deadline:
        if _has_login_cookies(driver):
            _log("[LOGIN] 로그인 쿠키 확인")
            return True
        if captcha_visible(driver) and not warned:
            _log("[LOGIN] 캡차 감지 — 브라우저에서 직접 풀면 자동 진행됩니다")
            warned = True
        for xpath in ["//a[contains(., '등록안함')]", "//span[contains(., '등록안함')]"]:
            try:
                el = driver.find_element(By.XPATH, xpath)
                if el.is_displayed():
                    el.click()
                    time.sleep(0.5)
            except Exception:
                pass
        time.sleep(1.5)
    return _has_login_cookies(driver)


def try_cookie_login(driver: WebDriver, root: Path, *, log: LogFn | None = None) -> bool:
    """저장된 쿠키로 로그인 시도. 성공 시 True."""
    _log = log or (lambda m: None)
    path = cookie_path(root)
    if not has_auth_cookie_file(path):
        _log("[LOGIN] 저장된 쿠키 없음")
        return False
    _log(f"[LOGIN] 쿠키 로드: {path}")
    n = load_cookies(driver, path)
    _log(f"[LOGIN] 쿠키 {n}개 주입")
    ok = is_logged_in(driver)
    if ok:
        _log("[LOGIN] 쿠키 로그인 성공 (캡차 없음)")
        # 최신 쿠키로 갱신
        save_cookies(driver, path)
    else:
        _log("[LOGIN] 쿠키 만료/무효")
    return ok


def naver_login_with_clip(
    driver: WebDriver,
    naver_id: str,
    naver_pw: str,
    timeout: int = 20,
    *,
    root: Path | None = None,
    log: LogFn | None = None,
    pause: PauseFn | None = None,
    wait_captcha_sec: int = 300,
    prefer_cookies: bool = True,
) -> None:
    """
    1) 쿠키 로그인 (캡차 회피 핵심)
    2) 실패 시 undetected 브라우저에서 폼 로그인
    3) 캡차 뜨면 수동 대기 후 쿠키 저장
    """
    _log = log or (lambda m: None)
    _ = pause
    root = root or Path(__file__).resolve().parent.parent

    if prefer_cookies and try_cookie_login(driver, root, log=_log):
        return

    if is_logged_in(driver):
        _log("[LOGIN] 프로필 세션으로 이미 로그인됨")
        save_cookies(driver, cookie_path(root))
        return

    _log("[LOGIN] 폼 로그인 시도...")
    driver.get("https://nid.naver.com/nidlogin.login?mode=form&url=https%3A%2F%2Fwww.naver.com")
    time.sleep(1.4)

    if _has_login_cookies(driver):
        save_cookies(driver, cookie_path(root))
        return

    wait = WebDriverWait(driver, timeout)
    id_input = wait.until(EC.element_to_be_clickable((By.ID, "id")))
    id_input.click()
    time.sleep(0.2)
    id_input.send_keys(Keys.CONTROL, "a")
    _cdp_insert_text(driver, naver_id)
    time.sleep(0.4)

    pw_input = wait.until(EC.element_to_be_clickable((By.ID, "pw")))
    pw_input.click()
    time.sleep(0.2)
    pw_input.send_keys(Keys.CONTROL, "a")
    _cdp_insert_text(driver, naver_pw)
    time.sleep(0.5)

    if not _click_any(
        driver,
        [
            (By.ID, "log.login"),
            (By.CSS_SELECTOR, "button.btn_login"),
            (By.XPATH, "//button[contains(.,'로그인')]"),
        ],
    ):
        # 엔터 대체 제출. pw_input 은 이미 stale 일 수 있다 — 클릭 시도가
        # 페이지를 건드렸거나 네이버가 폼을 다시 그렸을 때 그렇다.
        # 여기서 예외가 나면 브라우저가 닫혀 사람이 캡차를 풀 기회조차
        # 사라지므로, 실패해도 절대 죽지 않고 수동 진행으로 넘긴다.
        try:
            driver.find_element(By.ID, "pw").send_keys(Keys.ENTER)
        except Exception as e:
            _log(f"[LOGIN] 자동 제출 실패({type(e).__name__}) — 브라우저에서 직접 로그인하세요")

    time.sleep(2.0)
    if wait_until_logged_in(driver, timeout_sec=wait_captcha_sec, log=_log):
        n = save_cookies(driver, cookie_path(root))
        _log(f"[LOGIN] 성공 - 쿠키 {n}개 저장 (다음부터 캡차 없이 재사용)")
        return

    raise RuntimeError(
        "로그인 실패. `python login_once.py` 실행 후 브라우저에서 캡차를 한 번만 풀면 "
        "쿠키가 저장되어 이후에는 자동 로그인됩니다."
    )
