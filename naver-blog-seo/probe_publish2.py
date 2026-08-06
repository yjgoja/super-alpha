from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from selenium.webdriver.common.by import By

from src.browser import create_driver
from src.config_loader import load_config
from src.editor import dismiss_popups, paste_title, switch_to_main_frame
from src.login import naver_login_with_clip


def dump_buttons(driver, label: str, lines: list[str]) -> None:
    for el in driver.find_elements(By.XPATH, "//button|//a"):
        try:
            t = (el.text or "").strip().replace("\n", " ")
            cls = el.get_attribute("class") or ""
            if not t and "publish" not in cls.lower() and "confirm" not in cls.lower():
                continue
            if t or "publish" in cls.lower() or "confirm" in cls.lower() or "btn" in cls.lower():
                if any(k in (t + cls).lower() for k in ["발행", "publish", "확인", "취소", "저장", "임시", "confirm", "cancel"]):
                    lines.append(
                        f"{label} text={t!r} class={cls} data={el.get_attribute('data-click-area')} "
                        f"disp={el.is_displayed()} en={el.is_enabled()}"
                    )
        except Exception:
            pass


def main() -> None:
    cfg = load_config(require_credentials=True, require_openai=False)
    driver = create_driver(headless=False, profile_dir=cfg.root / ".chrome-profile")
    lines: list[str] = []
    try:
        naver_login_with_clip(driver, cfg.naver_id, cfg.naver_pw, root=cfg.root, log=print, prefer_cookies=True)
        driver.get(f"https://blog.naver.com/{cfg.naver_id}?Redirect=Write&categoryNo=2")
        time.sleep(4)
        switch_to_main_frame(driver)
        dismiss_popups(driver)
        paste_title(driver, "발행버튼 테스트글")
        time.sleep(0.5)
        dump_buttons(driver, "BEFORE", lines)
        btn = driver.find_element(By.CSS_SELECTOR, "button[data-click-area='tpb.publish']")
        btn.click()
        time.sleep(2)
        lines.append(f"URL_AFTER_CLICK={driver.current_url}")
        dump_buttons(driver, "FRAME", lines)
        # layer html
        try:
            html = driver.execute_script(
                "return document.body.innerHTML.includes('발행') ? document.body.innerText.slice(0,2000) : 'no';"
            )
            lines.append("FRAME_TEXT=" + str(html)[:1500])
        except Exception as e:
            lines.append(f"frame text err {e}")
        driver.switch_to.default_content()
        dump_buttons(driver, "ROOT", lines)
        try:
            html = driver.execute_script("return document.body.innerText.slice(0,2000);")
            lines.append("ROOT_TEXT=" + str(html)[:1500])
        except Exception as e:
            lines.append(f"root text err {e}")
        # iframes after click
        frames = driver.find_elements(By.CSS_SELECTOR, "iframe")
        lines.append(f"IFRAMES={len(frames)}")
        for i, f in enumerate(frames):
            lines.append(f"iframe[{i}] id={f.get_attribute('id')} src={(f.get_attribute('src') or '')[:100]}")
            try:
                driver.switch_to.default_content()
                driver.switch_to.frame(f)
                dump_buttons(driver, f"IF{i}", lines)
            except Exception as e:
                lines.append(f"if switch err {e}")

        path = ROOT / "output" / "probe_publish2.txt"
        path.write_text("\n".join(lines), encoding="utf-8")
        print("\n".join(lines[:80]))
        print("wrote", path)
        time.sleep(8)
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
