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
    out = cfg.root / "output" / "probe_editor.txt"
    lines = []
    try:
        naver_login_with_clip(driver, cfg.naver_id, cfg.naver_pw, root=cfg.root, log=print, prefer_cookies=True)
        driver.get(f"https://blog.naver.com/{cfg.naver_id}?Redirect=Write&categoryNo=2")
        time.sleep(5)
        lines.append(f"URL={driver.current_url}")
        lines.append(f"TITLE={driver.title}")
        frames = driver.find_elements("css selector", "iframe")
        lines.append(f"IFRAMES={len(frames)}")
        for i, f in enumerate(frames):
            lines.append(
                f"iframe[{i}] id={f.get_attribute('id')} name={f.get_attribute('name')} "
                f"src={(f.get_attribute('src') or '')[:160]}"
            )

        # try each frame for title selectors
        sels = [
            "textarea.se-documentTitle",
            ".se-documentTitle",
            ".se-section-documentTitle",
            "[contenteditable='true']",
            ".se-title-text",
            "div.se-module-text",
            ".se-component.se-documentTitle",
        ]
        driver.switch_to.default_content()
        for sel in sels:
            lines.append(f"root {sel}={len(driver.find_elements('css selector', sel))}")

        for i, f in enumerate(frames):
            driver.switch_to.default_content()
            try:
                driver.switch_to.frame(f)
            except Exception as e:
                lines.append(f"frame[{i}] switch fail {e}")
                continue
            for sel in sels:
                n = len(driver.find_elements("css selector", sel))
                if n:
                    lines.append(f"frame[{i}] {sel}={n}")
            # sample classes
            try:
                body_html = driver.execute_script(
                    "return document.body ? document.body.innerHTML.slice(0,2500) : 'no-body';"
                )
                lines.append(f"frame[{i}] body_snip={body_html[:500].replace(chr(10),' ')}")
            except Exception as e:
                lines.append(f"frame[{i}] body err {e}")

        out.write_text("\n".join(lines), encoding="utf-8")
        print("\n".join(lines[:80]))
        print("wrote", out)
        time.sleep(2)
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
