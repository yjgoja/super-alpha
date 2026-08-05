from __future__ import annotations

import time
from pathlib import Path

import pyperclip
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.remote.webdriver import WebDriver
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

from .content import BlogPost, ContentBlock


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
    # 최신/구형 iframe id 대응
    candidates = [
        (By.ID, "mainFrame"),
        (By.CSS_SELECTOR, "iframe#mainFrame"),
        (By.NAME, "mainFrame"),
        (By.CSS_SELECTOR, "iframe[name='mainFrame']"),
        (By.CSS_SELECTOR, "iframe[src*='PostWriteForm']"),
        (By.CSS_SELECTOR, "iframe[src*='Write']"),
    ]
    last = None
    for by, sel in candidates:
        try:
            WebDriverWait(driver, 4).until(EC.frame_to_be_available_and_switch_to_it((by, sel)))
            return
        except Exception as e:
            last = e
            driver.switch_to.default_content()
    # iframe 없이 바로 SE가 렌더되는 경우
    try:
        WebDriverWait(driver, 5).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, ".se-content, textarea.se-documentTitle"))
        )
        return
    except Exception as e:
        last = e
    raise TimeoutException(f"글쓰기 mainFrame/에디터를 찾지 못함: {last}")


def open_write_page(driver: WebDriver, naver_id: str, category_no: int | None = 2) -> None:
    urls = []
    if category_no:
        urls.append(f"https://blog.naver.com/{naver_id}?Redirect=Write&categoryNo={category_no}")
    urls.append(f"https://blog.naver.com/{naver_id}?Redirect=Write")
    urls.append("https://blog.naver.com/GoBlogWrite.naver")

    last_err = None
    for url in urls:
        try:
            driver.get(url)
            time.sleep(3.5)
            # 로그인 페이지로 튕기면 중단
            if "nidlogin" in driver.current_url:
                raise RuntimeError("글쓰기 진입 전 로그인 필요(캡차 가능)")
            switch_to_main_frame(driver)
            dismiss_popups(driver)
            return
        except Exception as e:
            last_err = e
            driver.switch_to.default_content()
            continue
    raise RuntimeError(f"글쓰기 창 진입 실패: {last_err}")


def paste_title(driver: WebDriver, title: str) -> None:
    from selenium.webdriver.common.action_chains import ActionChains

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
    from selenium.webdriver.common.action_chains import ActionChains

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
    """
    스마트에디터(React) 상태 반영을 위해 클립보드 붙여넣기 우선.
    CDP insertText 만 쓰면 화면엔 보여도 발행 시 빈 글로 무시될 수 있음.
    """
    from selenium.webdriver.common.action_chains import ActionChains

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
    # 최후: execCommand insertText + input 이벤트
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
    """순수 텍스트만 삽입 (HTML 태그 노출 방지)."""
    focus_body(driver)
    if text:
        _insert_text(driver, text)
    time.sleep(0.25)
    if enter_after:
        from selenium.webdriver.common.action_chains import ActionChains

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
    """left|center|right"""
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


def _pick_color_swatch(driver: WebDriver, prefer_hex: tuple[str, ...] | None = None) -> bool:
    prefer_hex = prefer_hex or ()
    for hx in prefer_hex:
        for sel in [
            f"button[data-color='{hx}']",
            f"button[data-value='{hx}']",
            f"//button[@data-color='{hx}']",
            f"//button[contains(@style,'{hx}')]",
        ]:
            by = By.XPATH if sel.startswith("//") else By.CSS_SELECTOR
            if _safe_click(driver, by, sel, timeout=1):
                return True
    # 팔레트에서 보이는 첫 강조색
    for sel in [
        ".se-color-palette button",
        ".se-property-toolbar-color button",
        "button.se-color-palette-button",
        "//div[contains(@class,'color')]//button",
    ]:
        by = By.XPATH if sel.startswith("//") else By.CSS_SELECTOR
        try:
            els = [e for e in driver.find_elements(by, sel) if e.is_displayed()]
            # 검정/흰색 피하고 중간 색 선택
            for el in els[2:8]:
                try:
                    el.click()
                    return True
                except Exception:
                    continue
        except Exception:
            continue
    return False


def apply_font_color(driver: WebDriver) -> bool:
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
        timeout=2,
    )
    if not opened:
        return False
    # 네이비/파랑 계열 선호
    ok = _pick_color_swatch(
        driver,
        prefer_hex=("#003399", "#0066cc", "#0b57d0", "#1a73e8", "#0047ab", "rgb(0, 51, 153)"),
    )
    return ok


def apply_bg_color(driver: WebDriver) -> bool:
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
        timeout=2,
    )
    if not opened:
        return False
    # 연한 노랑/민트 포인트
    return _pick_color_swatch(
        driver,
        prefer_hex=("#fff2cc", "#ffe599", "#ffff00", "#d9ead3", "#cfe2f3", "#fce5cd"),
    )


def apply_font_size(driver: WebDriver, size_label: str = "24") -> bool:
    """후킹용 글자 크기. 실패해도 본문 입력은 계속."""
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
    # 메뉴 닫기 시도
    try:
        from selenium.webdriver.common.action_chains import ActionChains

        ActionChains(driver).send_keys(Keys.ESCAPE).perform()
    except Exception:
        pass
    return False


def insert_heading(driver: WebDriver, text: str) -> None:
    focus_body(driver)
    apply_align(driver, "left")
    apply_bold(driver)
    apply_font_size(driver, "19")
    apply_font_color(driver)
    paste_plain(driver, f"■ {text}", enter_after=True)
    apply_font_size(driver, "15")


def insert_hook(driver: WebDriver, text: str) -> None:
    """후킹: 큰 글씨 + 굵게 + 글자색 + 배경색 (모바일 시선)."""
    focus_body(driver)
    apply_align(driver, "left")
    apply_font_size(driver, "19")
    apply_bold(driver)
    apply_font_color(driver)
    apply_bg_color(driver)
    _insert_text(driver, text)
    time.sleep(0.15)
    from selenium.webdriver.common.action_chains import ActionChains

    ActionChains(driver).send_keys(Keys.ENTER).perform()
    apply_font_size(driver, "15")
    time.sleep(0.1)


def insert_point(driver: WebDriver, text: str) -> None:
    """핵심 포인트: 굵게 + 배경색 + 글자색."""
    focus_body(driver)
    apply_align(driver, "left")
    apply_bold(driver)
    apply_font_color(driver)
    apply_bg_color(driver)
    paste_plain(driver, f"▶ {text}", enter_after=True)


def insert_quote(driver: WebDriver, text: str) -> None:
    focus_body(driver)
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
        _insert_text(driver, text)
        paste_plain(driver, "", enter_after=True)
        return
    apply_bg_color(driver)
    paste_plain(driver, f"“{text}”", enter_after=True)


def insert_og_link(driver: WebDriver, url: str, label: str = "") -> None:
    """
    스마트에디터 링크/OG링크 첨부 + 가운데 정렬.
    """
    focus_body(driver)
    apply_align(driver, "center")
    if label:
        apply_bold(driver)
        apply_font_size(driver, "19")
        apply_font_color(driver)
        apply_bg_color(driver)
        paste_plain(driver, label, enter_after=True)
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
            "//button[contains(@class,'link') and contains(@class,'toolbar')]",
        ],
        timeout=2,
    )
    if opened:
        # URL 입력창
        inputs = []
        for sel in [
            "input.se-popup-oglink-input",
            "input[placeholder*='URL']",
            "input[placeholder*='http']",
            "input[type='url']",
            ".se-popup-oglink input",
            ".se-property-toolbar input",
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
                apply_align(driver, "left")
                return

    # 폴백: URL만 새 줄에 붙여넣기 → SE가 카드/링크로 변환
    apply_align(driver, "center")
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
    apply_align(driver, "left")


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
        focus_body(driver)
        apply_align(driver, "left")
        paste_plain(driver, block.text, enter_after=True)


def _find_file_inputs(driver: WebDriver):
    # display:none 도 send_keys 가능
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
            "button.se-document-toolbar-button[data-name='image']",
            "//button[contains(@class,'image')]",
            "//button[.//span[contains(.,'사진')]]",
            "//button[contains(@aria-label,'사진')]",
            "//li[contains(@class,'image')]//button",
            "//button[contains(.,'사진')]",
        ]:
            by = By.XPATH if sel.startswith("//") else By.CSS_SELECTOR
            if _safe_click(driver, by, sel, timeout=2):
                clicked = True
                time.sleep(0.8)
                dismiss_popups(driver)
                break
        if not clicked:
            # 기본 콘텐츠 영역 포커스 후 재시도
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

    for _ in range(24):
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
        body.send_keys(Keys.END)
        body.send_keys(Keys.ENTER)
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
    """제목 → 썸네일 → (문단/인용구 ↔ 사진) 교차 입력."""
    # 반드시 mainFrame 안인지 재확인
    try:
        driver.find_element(By.CSS_SELECTOR, ".se-documentTitle, .se-title-text")
    except Exception:
        switch_to_main_frame(driver)
        dismiss_popups(driver)

    paste_title(driver, post.title)
    time.sleep(0.4)

    # 1) 썸네일(첫 사진)
    focus_body(driver)
    upload_image_file(driver, thumbnail)

    # 배치: 썸네일 → 후킹(큰글씨) → 사진 → 섹션 → 사진 … → 링크첨부
    img_q = list(body_images)
    content_blocks = [
        b
        for b in post.blocks
        if b.type in {"heading", "paragraph", "quote", "hook", "link", "point"}
    ]

    idx = 0
    # 도입(후킹/인용): 첫 heading 이전
    while idx < len(content_blocks) and content_blocks[idx].type != "heading":
        insert_block(driver, content_blocks[idx])
        idx += 1
    if img_q:
        upload_image_file(driver, img_q.pop(0))

    # 섹션 단위
    while idx < len(content_blocks):
        insert_block(driver, content_blocks[idx])
        idx += 1
        while idx < len(content_blocks) and content_blocks[idx].type != "heading":
            insert_block(driver, content_blocks[idx])
            idx += 1
        if img_q:
            upload_image_file(driver, img_q.pop(0))

    while img_q:
        upload_image_file(driver, img_q.pop(0))

    phrases = [p for p in required_phrases if p and p not in {"이거다", "이거다!"}]
    still_missing = [p for p in phrases if p not in "\n".join(b.text for b in post.blocks)]
    if still_missing:
        raise RuntimeError(f"필수 문구가 본문에 없습니다: {still_missing}")

    has_link = any(
        b.type == "link" and (b.url == footer_link or footer_link in (b.url or ""))
        for b in post.blocks
    )
    if not has_link:
        insert_og_link(driver, footer_link, label="자세히 알아보기")


def _js_click(driver: WebDriver, el) -> None:
    driver.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
    time.sleep(0.15)
    driver.execute_script("arguments[0].click();", el)


def publish_post(driver: WebDriver) -> str | None:
    """발행 버튼 → 패널 확인 발행(confirm_btn)."""
    try:
        switch_to_main_frame(driver)
    except Exception:
        pass
    dismiss_popups(driver)

    # 1) 상단 발행
    pub = None
    for sel in [
        "button[data-click-area='tpb.publish']",
        "button[class*='publish_btn']",
    ]:
        els = driver.find_elements(By.CSS_SELECTOR, sel)
        for el in els:
            if el.is_displayed():
                pub = el
                break
        if pub:
            break
    if pub is None:
        raise RuntimeError("발행 버튼을 찾지 못했습니다.")
    _js_click(driver, pub)
    time.sleep(1.8)

    # 2) 패널 안 최종 발행 (data-click-area=tpb*i.publish)
    confirm = None
    for sel in [
        "button.confirm_btn__WEaBq",
        "button[data-click-area='tpb*i.publish']",
        "button[class*='confirm_btn']",
    ]:
        for el in driver.find_elements(By.CSS_SELECTOR, sel):
            if el.is_displayed() and el.is_enabled():
                confirm = el
                break
        if confirm:
            break
    if confirm is None:
        # xpath fallback: 패널에 보이는 '발행' 중 confirm 클래스
        for el in driver.find_elements(By.XPATH, "//button[contains(@class,'confirm') and contains(.,'발행')]"):
            if el.is_displayed():
                confirm = el
                break
    if confirm is None:
        raise RuntimeError("최종 발행(확인) 버튼을 찾지 못했습니다. 발행 패널이 열렸는지 확인하세요.")

    _js_click(driver, confirm)
    time.sleep(3.0)

    # 완료 판정: URL 변경 or 본문 비움/토스트
    end = time.time() + 30
    while time.time() < end:
        url = driver.current_url
        if "Redirect=Write" not in url and "PostWriteForm" not in url:
            return url
        # 새 탭으로 열렸을 수 있음
        if len(driver.window_handles) > 1:
            driver.switch_to.window(driver.window_handles[-1])
            return driver.current_url
        time.sleep(0.8)
    return driver.current_url
