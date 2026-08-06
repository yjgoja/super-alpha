from __future__ import annotations

import re
import time
from pathlib import Path

import pyperclip
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.remote.webdriver import WebDriver
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

from .content import BlogPost, ContentBlock

# 노란 형광펜만 — 회색/저대비 절대 금지
YELLOW_HEX = (
    "#fff8b2",  # SE ONE 팔레트 실제 노랑
    "#fff2cc",
    "#ffe599",
    "#ffff00",
    "#ffeb3b",
    "#ffee58",
    "#fff176",
    "#ffff99",
    "#ffd966",
    "#fce8b2",
    "#fff59d",
    "#f9e79f",
    "#f7dc6f",
    "#f4d03f",
    "#ffe066",
    "#ffec8b",
    "#faf0a0",
)
# 노란 배경 위 가독성: 검정/진한 글자
DARK_TEXT_HEX = ("#000000", "#111111", "#222222", "#333333", "#1a1a1a")


def _safe_click(driver: WebDriver, by: By, value: str, timeout: int = 5) -> bool:
    try:
        el = WebDriverWait(driver, timeout).until(EC.element_to_be_clickable((by, value)))
        el.click()
        return True
    except Exception:
        return False


def dismiss_popups(driver: WebDriver) -> None:
    selectors = [
        (By.CSS_SELECTOR, "button.se-popup-button-cancel"),
        (By.CSS_SELECTOR, "button.se-help-panel-close-button"),
        (By.XPATH, "//button[contains(@class,'se-popup-button-cancel')]"),
        (By.XPATH, "//span[contains(.,'취소')]/ancestor::button"),
        (By.XPATH, "//button[contains(.,'닫기')]"),
    ]
    for by, value in selectors:
        try:
            for el in driver.find_elements(by, value):
                if el.is_displayed():
                    el.click()
                    time.sleep(0.3)
        except Exception:
            continue


def switch_to_main_frame(driver: WebDriver, timeout: int = 20) -> None:
    driver.switch_to.default_content()
    WebDriverWait(driver, timeout).until(
        EC.frame_to_be_available_and_switch_to_it((By.ID, "mainFrame"))
    )


def open_write_page(driver: WebDriver, naver_id: str, category_no: int | None = 2) -> None:
    if category_no:
        url = f"https://blog.naver.com/{naver_id}?Redirect=Write&categoryNo={category_no}"
    else:
        url = f"https://blog.naver.com/{naver_id}?Redirect=Write"
    driver.get(url)
    time.sleep(3.5)
    switch_to_main_frame(driver)
    dismiss_popups(driver)


def paste_title(driver: WebDriver, title: str) -> None:
    candidates = [
        (By.CSS_SELECTOR, ".se-documentTitle .se-title-text"),
        (By.CSS_SELECTOR, ".se-section-documentTitle .se-title-text"),
        (By.CSS_SELECTOR, ".se-title-text"),
        (By.CSS_SELECTOR, "textarea.se-documentTitle"),
    ]
    title_el = None
    for by, sel in candidates:
        try:
            title_el = WebDriverWait(driver, 5).until(EC.presence_of_element_located((by, sel)))
            if title_el and title_el.is_displayed():
                break
            title_el = None
        except TimeoutException:
            title_el = None
            continue
    if title_el is None:
        raise RuntimeError("제목 입력 영역을 찾지 못했습니다.")

    driver.execute_script("arguments[0].scrollIntoView({block:'center'});", title_el)
    ActionChains(driver).move_to_element(title_el).click().pause(0.25).perform()
    pyperclip.copy(title)
    ActionChains(driver).key_down(Keys.CONTROL).send_keys("a").key_up(Keys.CONTROL).pause(0.1).key_down(
        Keys.CONTROL
    ).send_keys("v").key_up(Keys.CONTROL).perform()
    time.sleep(0.5)


def focus_body(driver: WebDriver):
    """최신 SE ONE 본문은 p.se-text-paragraph 클릭 후 입력."""
    selectors = [
        "p.se-text-paragraph",
        ".se-section-text p",
        ".se-component.se-text .se-module-text",
        ".se-section-text",
    ]
    last_err = None
    for sel in selectors:
        try:
            els = [e for e in driver.find_elements(By.CSS_SELECTOR, sel) if e.is_displayed()]
            if not els:
                continue
            target = els[-1]
            driver.execute_script("arguments[0].scrollIntoView({block:'center'});", target)
            ActionChains(driver).move_to_element(target).click().pause(0.2).perform()
            time.sleep(0.15)
            return driver.switch_to.active_element
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError(f"본문 입력 영역을 찾지 못했습니다: {last_err}")


def _insert_text(driver: WebDriver, text: str) -> None:
    """클립보드 붙여넣기 우선 (발행 시 빈 글 방지)."""
    pyperclip.copy(text)
    active = driver.switch_to.active_element
    try:
        ActionChains(driver).click(active).key_down(Keys.CONTROL).send_keys("v").key_up(Keys.CONTROL).perform()
        return
    except Exception:
        pass
    try:
        active.send_keys(Keys.CONTROL, "v")
        return
    except Exception:
        pass
    driver.execute_script(
        """
        const el = arguments[0];
        el.focus();
        document.execCommand('insertText', false, arguments[1]);
        el.dispatchEvent(new InputEvent('input', {bubbles:true, data: arguments[1], inputType:'insertText'}));
        """,
        active,
        text,
    )


def paste_plain(driver: WebDriver, text: str, *, enter_after: bool = True) -> None:
    focus_body(driver)
    if text:
        _insert_text(driver, text)
    time.sleep(0.25)
    if enter_after:
        try:
            ActionChains(driver).send_keys(Keys.ENTER).perform()
        except Exception:
            try:
                driver.switch_to.active_element.send_keys(Keys.ENTER)
            except Exception:
                pass
        time.sleep(0.15)


def _click_toolbar(driver: WebDriver, selectors: list[str], timeout: int = 1) -> bool:
    for sel in selectors:
        by = By.XPATH if sel.startswith("//") else By.CSS_SELECTOR
        if _safe_click(driver, by, sel, timeout=timeout):
            time.sleep(0.2)
            return True
    return False


def _close_floating_ui(driver: WebDriver) -> None:
    try:
        ActionChains(driver).send_keys(Keys.ESCAPE).perform()
        time.sleep(0.1)
    except Exception:
        pass
    dismiss_popups(driver)


def apply_bold(driver: WebDriver) -> None:
    _click_toolbar(
        driver,
        [
            "button[data-name='bold']",
            "button.se-bold-toolbar-button",
            "button.se-toolbar-item-bold",
            "//button[contains(@class,'bold')]",
            "//button[.//span[contains(.,'굵게')]]",
        ],
    )


def apply_align(driver: WebDriver, mode: str = "center") -> bool:
    """left|center|right — 기본 가운데."""
    name = {
        "left": "align-left",
        "center": "align-center",
        "right": "align-right",
    }.get(mode, "align-center")
    label = {"left": "왼쪽", "center": "가운데", "right": "오른쪽"}.get(mode, "가운데")
    return _click_toolbar(
        driver,
        [
            f"button[data-name='{name}']",
            f"button.se-{name}-toolbar-button",
            f"button[data-value='{mode}']",
            f"//button[contains(@class,'{name}')]",
            f"//button[.//span[contains(.,'{label}')]]",
            f"//button[contains(@aria-label,'{label}')]",
        ],
        timeout=2,
    )


def apply_font_size(driver: WebDriver, size_label: str = "19") -> bool:
    opened = _click_toolbar(
        driver,
        [
            "button[data-name='font-size']",
            "button.se-font-size-toolbar-button",
            "button.se-toolbar-item-font-size",
            "//button[contains(@class,'font-size')]",
            "//button[.//span[contains(.,'글자 크기')]]",
            "//button[.//span[contains(.,'글자크기')]]",
        ],
        timeout=2,
    )
    if not opened:
        return False
    for sel in [
        f"button[data-value='{size_label}']",
        f"button[data-name='{size_label}']",
        f"//button[normalize-space()='{size_label}']",
        f"//button[contains(.,'{size_label}')]",
        f"//li[contains(.,'{size_label}')]//button",
        f"//span[normalize-space()='{size_label}']/ancestor::button",
    ]:
        by = By.XPATH if sel.startswith("//") else By.CSS_SELECTOR
        if _safe_click(driver, by, sel, timeout=1):
            time.sleep(0.15)
            return True
    _close_floating_ui(driver)
    return False


def _parse_rgb(s: str) -> tuple[int, int, int] | None:
    m = re.search(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)", s or "", re.I)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


def _is_yellow_color(raw: str) -> bool:
    """노란/형광만 허용. 회색·파랑·민트 등 거절."""
    s = (raw or "").strip().lower().replace(" ", "")
    if not s:
        return False
    for hx in YELLOW_HEX:
        if hx.lower() in s:
            return True
    if s.startswith("#") and len(s) in (4, 7):
        try:
            if len(s) == 4:
                r, g, b = (int(c * 2, 16) for c in s[1:])
            else:
                r, g, b = int(s[1:3], 16), int(s[3:5], 16), int(s[5:7], 16)
        except ValueError:
            return False
    else:
        rgb = _parse_rgb(s)
        if not rgb:
            # 라벨 힌트
            return any(k in s for k in ("yellow", "노랑", "노란색", "형광"))
        r, g, b = rgb
    # 노랑: R·G 높고 B 낮음, 채도 있음 (회색 제외)
    if r < 200 or g < 180:
        return False
    if b > 200:  # #fff8b2 = (255,248,178) 허용
        return False
    if abs(r - g) > 90:
        return False
    # 회색: R≈G≈B
    if abs(r - g) < 25 and abs(g - b) < 25:
        return False
    return True


def _swatch_color_hint(el) -> str:
    parts = [
        el.get_attribute("data-color") or "",
        el.get_attribute("data-value") or "",
        el.get_attribute("title") or "",
        el.get_attribute("aria-label") or "",
        el.get_attribute("style") or "",
    ]
    try:
        bg = el.value_of_css_property("background-color") or ""
        parts.append(bg)
    except Exception:
        pass
    return " ".join(parts)


def _pick_yellow_swatch(driver: WebDriver) -> bool:
    """노란색만 클릭. 실패 시 아무 색도 고르지 않음(회색 폴백 금지)."""
    for hx in YELLOW_HEX:
        for sel in [
            f"button[data-color='{hx}']",
            f"button[data-value='{hx}']",
            f"//button[@data-color='{hx}']",
            f"//button[contains(@style,'{hx}')]",
            f"//button[contains(@style,'{hx.upper()}')]",
        ]:
            by = By.XPATH if sel.startswith("//") else By.CSS_SELECTOR
            if _safe_click(driver, by, sel, timeout=0.25):
                return True

    # 팔레트 스캔 — 노란 것만
    palette_sels = [
        ".se-color-palette button",
        ".se-property-toolbar-color button",
        "button.se-color-palette-button",
        "//div[contains(@class,'color')]//button",
        "//div[contains(@class,'palette')]//button",
    ]
    for sel in palette_sels:
        by = By.XPATH if sel.startswith("//") else By.CSS_SELECTOR
        try:
            els = [e for e in driver.find_elements(by, sel) if e.is_displayed()]
        except Exception:
            continue
        for el in els:
            hint = _swatch_color_hint(el)
            if not _is_yellow_color(hint):
                continue
            try:
                el.click()
                return True
            except Exception:
                continue

    # 라벨로 노랑
    for sel in [
        "//button[contains(@title,'노랑') or contains(@aria-label,'노랑')]",
        "//button[contains(@title,'yellow') or contains(@aria-label,'yellow')]",
        "//span[contains(.,'노랑')]/ancestor::button",
    ]:
        if _safe_click(driver, By.XPATH, sel, timeout=0.5):
            return True
    return False


def _pick_dark_text_swatch(driver: WebDriver) -> bool:
    for hx in DARK_TEXT_HEX:
        for sel in [
            f"button[data-color='{hx}']",
            f"button[data-value='{hx}']",
            f"//button[@data-color='{hx}']",
        ]:
            by = By.XPATH if sel.startswith("//") else By.CSS_SELECTOR
            if _safe_click(driver, by, sel, timeout=0.5):
                return True
    # 팔레트 첫 검정 계열
    for sel in [".se-color-palette button", "button.se-color-palette-button"]:
        try:
            els = [e for e in driver.find_elements(By.CSS_SELECTOR, sel) if e.is_displayed()]
            for el in els[:4]:
                hint = _swatch_color_hint(el).lower()
                rgb = _parse_rgb(hint)
                if "000000" in hint or "111111" in hint:
                    el.click()
                    return True
                if rgb and max(rgb) < 60:
                    el.click()
                    return True
        except Exception:
            continue
    return False


def apply_font_color(driver: WebDriver) -> bool:
    """노란 배경용 검정 글자."""
    try:
        opened = _click_toolbar(
            driver,
            [
                "button[data-name='font-color']",
                "button[data-name='color']",
                "button.se-font-color-toolbar-button",
                "button.se-color-toolbar-button",
                "//button[.//span[contains(.,'글자 색')]]",
                "//button[.//span[contains(.,'글자색')]]",
                "//button[contains(@aria-label,'글자 색')]",
            ],
            timeout=1,
        )
        if not opened:
            return False
        ok = _pick_dark_text_swatch(driver)
        if not ok:
            _close_floating_ui(driver)
        return ok
    except Exception:
        _close_floating_ui(driver)
        return False


def apply_bg_color(driver: WebDriver) -> bool:
    """노란색 형광 배경만. 회색이면 적용 안 함."""
    try:
        opened = _click_toolbar(
            driver,
            [
                "button[data-name='background-color']",
                "button[data-name='bg-color']",
                "button.se-background-color-toolbar-button",
                "button.se-bg-color-toolbar-button",
                "//button[.//span[contains(.,'배경 색')]]",
                "//button[.//span[contains(.,'배경색')]]",
                "//button[.//span[contains(.,'형광펜')]]",
                "//button[contains(@aria-label,'배경')]",
            ],
            timeout=1,
        )
        if not opened:
            return False
        ok = _pick_yellow_swatch(driver)
        if not ok:
            # 회색/임의색 폴백 금지 — 팔레트만 닫기
            _close_floating_ui(driver)
        return ok
    except Exception:
        _close_floating_ui(driver)
        return False


def insert_heading(driver: WebDriver, text: str) -> None:
    focus_body(driver)
    apply_align(driver, "center")
    apply_bold(driver)
    apply_font_size(driver, "19")
    apply_font_color(driver)
    paste_plain(driver, f"■ {text}", enter_after=True)
    apply_font_size(driver, "15")


def insert_hook(driver: WebDriver, text: str) -> None:
    """후킹: 가운데 + 굵게 + 검정글자 + 노란배경."""
    focus_body(driver)
    apply_align(driver, "center")
    apply_font_size(driver, "19")
    apply_bold(driver)
    apply_font_color(driver)
    apply_bg_color(driver)
    _insert_text(driver, text)
    time.sleep(0.15)
    ActionChains(driver).send_keys(Keys.ENTER).perform()
    apply_font_size(driver, "15")
    time.sleep(0.1)


def insert_point(driver: WebDriver, text: str) -> None:
    focus_body(driver)
    apply_align(driver, "center")
    apply_bold(driver)
    apply_font_color(driver)
    apply_bg_color(driver)
    paste_plain(driver, f"▶ {text}", enter_after=True)


def insert_quote(driver: WebDriver, text: str) -> None:
    focus_body(driver)
    apply_align(driver, "center")
    clicked = _click_toolbar(
        driver,
        [
            "button[data-name='quotation']",
            "button.se-quotation-toolbar-button",
            "button.se-toolbar-item-quotation",
            "//button[contains(@class,'quotation')]",
            "//button[.//span[contains(.,'인용구')]]",
        ],
        timeout=1,
    )
    if clicked:
        apply_bold(driver)
        apply_bg_color(driver)
        _insert_text(driver, text)
        paste_plain(driver, "", enter_after=True)
        return
    apply_bold(driver)
    apply_font_color(driver)
    apply_bg_color(driver)
    paste_plain(driver, f"“{text}”", enter_after=True)


def insert_paragraph(driver: WebDriver, text: str) -> None:
    focus_body(driver)
    apply_align(driver, "center")
    paste_plain(driver, text, enter_after=True)


def _center_last_oglink(driver: WebDriver) -> bool:
    """OG 링크 카드(섹션)만 선택해 가운데 정렬."""
    selectors = [
        ".se-section-oglink",
        ".se-module-oglink",
        "[class*='se-oglink']",
        "[class*='oglink']",
    ]
    modules = []
    for sel in selectors:
        found = [e for e in driver.find_elements(By.CSS_SELECTOR, sel) if e.is_displayed()]
        if found:
            modules = found
            break
    if not modules:
        return apply_align(driver, "center")

    el = modules[-1]
    try:
        driver.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
        ActionChains(driver).move_to_element(el).click().pause(0.2).perform()
    except Exception:
        pass

    ok = apply_align(driver, "center")
    try:
        driver.execute_script(
            """
            var el = arguments[0];
            var section = el.closest('.se-section') || el;
            section.style.textAlign = 'center';
            section.classList.add('se-section-align-center');
            section.querySelectorAll('.se-component, .se-module, .se-oglink').forEach(function(n){
              n.style.textAlign = 'center';
              n.style.marginLeft = 'auto';
              n.style.marginRight = 'auto';
            });
            """,
            el,
        )
    except Exception:
        pass
    return ok


def insert_og_link(driver: WebDriver, url: str, label: str = "자세히 알아보기") -> None:
    """'자세히 알아보기' 문구 + OG 링크 카드만 가운데 정렬."""
    cta = (label or "자세히 알아보기").strip() or "자세히 알아보기"
    focus_body(driver)
    apply_align(driver, "center")
    apply_bold(driver)
    apply_font_size(driver, "19")
    apply_font_color(driver)
    apply_bg_color(driver)
    paste_plain(driver, cta, enter_after=True)
    apply_font_size(driver, "15")
    apply_align(driver, "center")

    opened = _click_toolbar(
        driver,
        [
            "button[data-name='oglink']",
            "button.se-oglink-toolbar-button",
            "button.se-toolbar-item-oglink",
            "button[data-name='link']",
            "button.se-link-toolbar-button",
            "//button[.//span[contains(.,'링크')]]",
            "//button[contains(@class,'oglink')]",
        ],
        timeout=2,
    )
    if opened:
        inputs = []
        for sel in [
            "input.se-popup-oglink-input",
            "input[placeholder*='URL']",
            "input[placeholder*='http']",
            "input[type='url']",
            ".se-popup-oglink input",
            "input.se-input",
        ]:
            inputs = [e for e in driver.find_elements(By.CSS_SELECTOR, sel) if e.is_displayed()]
            if inputs:
                break
        if inputs:
            el = inputs[0]
            el.clear()
            el.send_keys(url)
            time.sleep(0.3)
            confirmed = _click_toolbar(
                driver,
                [
                    "button.se-popup-button-confirm",
                    ".se-popup-button-confirm",
                    "//button[contains(.,'확인')]",
                    "//button[contains(.,'적용')]",
                    "//button[contains(.,'첨부')]",
                ],
                timeout=2,
            )
            if confirmed:
                time.sleep(1.2)
                _center_last_oglink(driver)
                focus_body(driver)
                apply_align(driver, "center")
                return

    paste_plain(driver, url, enter_after=True)
    time.sleep(1.5)
    _click_toolbar(
        driver,
        [
            "button.se-popup-button-confirm",
            "//button[contains(.,'확인')]",
            "//button[contains(.,'링크 카드')]",
        ],
        timeout=1,
    )
    _center_last_oglink(driver)
    focus_body(driver)
    apply_align(driver, "center")


def insert_block(driver: WebDriver, block: ContentBlock) -> None:
    if block.type == "heading":
        insert_heading(driver, block.text)
    elif block.type == "hook":
        insert_hook(driver, block.text)
    elif block.type == "point":
        insert_point(driver, block.text)
    elif block.type == "quote":
        insert_quote(driver, block.text)
    elif block.type == "link":
        insert_og_link(driver, block.url or "https://minestock.kr", label=block.text)
    else:
        insert_paragraph(driver, block.text)


def _find_file_inputs(driver: WebDriver):
    return driver.find_elements(By.CSS_SELECTOR, "input[type='file']")


def _wait_file_inputs(driver: WebDriver, timeout: float = 6.0):
    end = time.time() + timeout
    while time.time() < end:
        inputs = _find_file_inputs(driver)
        if inputs:
            return inputs
        time.sleep(0.25)
    return []


def upload_image_file(driver: WebDriver, image_path: Path) -> None:
    path = str(image_path.resolve())
    if not Path(path).exists():
        raise RuntimeError(f"이미지 파일 없음: {path}")

    try:
        switch_to_main_frame(driver)
    except Exception:
        pass
    dismiss_popups(driver)

    before = len(driver.find_elements(By.CSS_SELECTOR, "img, .se-image-resource"))
    inputs = _wait_file_inputs(driver, timeout=1.5)
    usable = [i for i in inputs if "image" in ((i.get_attribute("accept") or "image").lower())]
    if not usable:
        usable = list(inputs)

    if not usable:
        clicked = False
        for sel in [
            "button.se-image-toolbar-button",
            "button[data-name='image']",
            "button.se-toolbar-item-image",
            "button[data-name='image-group']",
            "//button[contains(@class,'image')]",
            "//button[.//span[contains(.,'사진')]]",
            "//button[contains(@aria-label,'사진')]",
            "//button[contains(.,'사진')]",
        ]:
            by = By.XPATH if sel.startswith("//") else By.CSS_SELECTOR
            if _safe_click(driver, by, sel, timeout=2):
                clicked = True
                time.sleep(0.8)
                dismiss_popups(driver)
                break
        if not clicked:
            try:
                focus_body(driver)
            except Exception:
                pass
            if not _safe_click(driver, By.CSS_SELECTOR, "button[data-name='image']", timeout=2):
                raise RuntimeError("이미지 업로드 버튼을 찾지 못했습니다.")
            time.sleep(0.8)
        inputs = _wait_file_inputs(driver, timeout=6.0)
        usable = list(inputs)

    if not usable:
        raise RuntimeError("input[type=file] 을 찾지 못했습니다.")

    usable[-1].send_keys(path)
    time.sleep(1.5)

    for _ in range(30):
        now = len(driver.find_elements(By.CSS_SELECTOR, "img, .se-image-resource"))
        if now > before:
            break
        time.sleep(0.4)

    for sel in [
        "button.se-popup-button-confirm",
        ".se-popup-button-confirm",
        "//button[contains(.,'확인')]",
        "//button[contains(.,'본문 추가')]",
    ]:
        by = By.XPATH if sel.startswith("//") else By.CSS_SELECTOR
        if _safe_click(driver, by, sel, timeout=1):
            time.sleep(0.4)
            break

    try:
        body = focus_body(driver)
        ActionChains(driver).send_keys(Keys.END).send_keys(Keys.ENTER).perform()
    except Exception:
        pass


def write_post_with_images(
    driver: WebDriver,
    post: BlogPost,
    *,
    thumbnail: Path,
    body_images: list[Path],
    required_phrases: list[str],
    footer_link: str = "https://minestock.kr",
) -> None:
    print("[SE] paste title...", flush=True)
    paste_title(driver, post.title)
    time.sleep(0.4)

    print("[SE] upload thumbnail...", flush=True)
    focus_body(driver)
    upload_image_file(driver, thumbnail)

    img_q = list(body_images)
    content_blocks = [
        b
        for b in post.blocks
        if b.type in {"heading", "paragraph", "quote", "hook", "link", "point"}
    ]

    idx = 0
    print("[SE] insert hooks (center + yellow)...", flush=True)
    while idx < len(content_blocks) and content_blocks[idx].type != "heading":
        insert_block(driver, content_blocks[idx])
        idx += 1
    if img_q:
        print("[SE] upload body image after hook...", flush=True)
        upload_image_file(driver, img_q.pop(0))

    print("[SE] insert sections (center)...", flush=True)
    section_n = 0
    while idx < len(content_blocks):
        section_n += 1
        insert_block(driver, content_blocks[idx])
        idx += 1
        while idx < len(content_blocks) and content_blocks[idx].type != "heading":
            insert_block(driver, content_blocks[idx])
            idx += 1
        if img_q:
            upload_image_file(driver, img_q.pop(0))
        if section_n % 2 == 0:
            print(f"[SE] sections done={section_n} remaining_img={len(img_q)}", flush=True)

    while img_q:
        upload_image_file(driver, img_q.pop(0))
    print("[SE] body write done", flush=True)

    phrases = [p for p in required_phrases if p and p not in {"이거다", "이거다!"}]
    still_missing = [p for p in phrases if p not in "\n".join(b.text for b in post.blocks)]
    if still_missing:
        raise RuntimeError(f"필수 문구가 본문에 없습니다: {still_missing}")

    has_link = any(
        b.type == "link" and (b.url == footer_link or footer_link in (b.url or b.text or ""))
        for b in post.blocks
    )
    if not has_link:
        insert_og_link(driver, footer_link, label="자세히 알아보기")


def publish_post(driver: WebDriver) -> str | None:
    try:
        switch_to_main_frame(driver)
    except Exception:
        pass
    dismiss_popups(driver)

    publish_selectors = [
        (By.CSS_SELECTOR, "button[data-click-area='tpb.publish']"),
        (By.CSS_SELECTOR, "button[class*='publish_btn']"),
        (By.CSS_SELECTOR, "button.publish_btn__m9KHH"),
        (By.CSS_SELECTOR, "button.publish_btn__m9KAf"),
        (By.XPATH, "//button[.//span[contains(.,'발행')] or contains(.,'발행')]"),
        (By.XPATH, "//span[contains(@class,'text') and contains(.,'발행')]/ancestor::button"),
    ]
    clicked = False
    for by, sel in publish_selectors:
        if _safe_click(driver, by, sel, timeout=4):
            clicked = True
            break
    if not clicked:
        raise RuntimeError("발행 버튼을 찾지 못했습니다.")

    time.sleep(1.5)

    confirm_selectors = [
        (By.CSS_SELECTOR, "button[data-testid='seOnePublishBtn']"),
        (By.CSS_SELECTOR, "button.confirm_btn__WEaBq"),
        (By.CSS_SELECTOR, "button[class*='confirm']"),
        (By.XPATH, "//button[contains(.,'발행')]"),
        (By.XPATH, "//button[contains(.,'확인')]"),
    ]
    for _ in range(2):
        confirmed = False
        for by, sel in confirm_selectors:
            if _safe_click(driver, by, sel, timeout=2):
                confirmed = True
                time.sleep(1.2)
                break
        if not confirmed:
            try:
                driver.switch_to.default_content()
                for by, sel in confirm_selectors:
                    if _safe_click(driver, by, sel, timeout=2):
                        confirmed = True
                        time.sleep(1.2)
                        break
            except Exception:
                pass
        if confirmed:
            break

    end = time.time() + 25
    while time.time() < end:
        url = driver.current_url
        if "Redirect=Write" not in url and "PostWriteForm" not in url:
            return url
        time.sleep(0.8)
    return driver.current_url
