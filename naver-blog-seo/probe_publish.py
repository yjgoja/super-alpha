from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from src.browser import create_driver
from src.config_loader import load_config
from src.login import naver_login_with_clip


def main() -> None:
    cfg = load_config(require_credentials=True, require_openai=False)
    driver = create_driver(headless=False, profile_dir=cfg.root / ".chrome-profile")
    out = []
    try:
        naver_login_with_clip(driver, cfg.naver_id, cfg.naver_pw, root=cfg.root, log=print, prefer_cookies=True)
        driver.get(f"https://blog.naver.com/{cfg.naver_id}?Redirect=Write&categoryNo=2")
        time.sleep(4)
        driver.switch_to.default_content()
        frames = driver.find_elements("css selector", "iframe")
        if frames:
            driver.switch_to.frame(frames[0])
        # dump buttons with 발행
        btns = driver.find_elements("xpath", "//button|//a|//span")
        for el in btns:
            try:
                t = (el.text or "").strip()
                if "발행" in t or "publish" in (el.get_attribute("class") or "").lower():
                    out.append(
                        f"tag={el.tag_name} text={t!r} class={el.get_attribute('class')} "
                        f"data={el.get_attribute('data-click-area')} displayed={el.is_displayed()}"
                    )
            except Exception:
                pass
        # also outside frame
        driver.switch_to.default_content()
        btns = driver.find_elements("xpath", "//button|//a|//span")
        for el in btns:
            try:
                t = (el.text or "").strip()
                if "발행" in t:
                    out.append(
                        f"ROOT tag={el.tag_name} text={t!r} class={el.get_attribute('class')} displayed={el.is_displayed()}"
                    )
            except Exception:
                pass
        path = ROOT / "output" / "probe_publish.txt"
        path.write_text("\n".join(out[:200]), encoding="utf-8")
        print("\n".join(out[:50]))
        print("wrote", path)
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
