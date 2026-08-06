from __future__ import annotations

import base64
import json
import re
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.request import urlopen

from openai import OpenAI

from .thumb_text import overlay_keyword_on_thumbnail

LogFn = Callable[[str], None]

FOOTER_LINK = "https://minestock.kr"
DEFAULT_IMAGE_MODEL = "gpt-image-1"
DEFAULT_TEXT_MODEL = "gpt-4o"
DEFAULT_IMAGE_QUALITY = "medium"  # low|medium|high
DEFAULT_MIN_CHARS = 2800

IMAGE_MODEL_FALLBACKS = [
    "gpt-image-1",
    "gpt-image-1.5",
    "gpt-image-2",
    "gpt-image-1-mini",
]


def make_client(api_key: str) -> OpenAI:
    key = (api_key or "").strip()
    if not key:
        raise ValueError("OpenAI API 키가 없습니다. GUI에 ChatGPT API 키를 입력하세요.")
    return OpenAI(api_key=key)


def _slug(text: str) -> str:
    s = re.sub(r"[^\w가-힣\-]+", "-", text.strip(), flags=re.UNICODE)
    return s.strip("-")[:40] or "keyword"


def _count_chars(blocks: list[dict]) -> int:
    return sum(len(b.get("text", "")) for b in blocks)


def generate_structured_article(
    client: OpenAI,
    *,
    keyword: str,
    required_phrases: list[str],
    brand_name: str,
    footer_link: str = FOOTER_LINK,
    model: str = DEFAULT_TEXT_MODEL,
    section_count: int = 8,
    min_chars: int = DEFAULT_MIN_CHARS,
    log: LogFn | None = None,
) -> dict:
    """SEO 정보성 장문(hook/point/link 포함). 최소 글자수 미달 시 1회 보강."""
    _log = log or (lambda m: None)
    phrases = ", ".join(required_phrases) if required_phrases else "(없음)"
    system = (
        "당신은 네이버 블로그 상위노출을 노리는 SEO 전문 정보성 칼럼니스트입니다. "
        "검색 의도에 맞는 깊이 있는 설명을 쓰고, 키워드를 자연스럽게 배치합니다. "
        "확정 수익률·확정 수치 단정, 과장 광고, 이모지, 해시태그 나열은 금지합니다. "
        "반드시 JSON만 출력합니다."
    )
    user = f"""
메인 키워드: {keyword}
브랜드/필명: {brand_name}
필수 문구(있으면 자연스럽게 포함): {phrases}
필수 CTA 링크: {footer_link}

JSON 스키마:
{{
  "title": "메인 키워드를 앞쪽에 포함한 정보성 제목 28~48자",
  "thumb_text": "썸네일용 핵심 문구 12~22자",
  "related_keywords": ["연관검색어1", "연관검색어2", "연관검색어3", "연관검색어4"],
  "blocks": [
    {{"type":"hook","text":"..."}},
    {{"type":"heading","text":"..."}},
    {{"type":"paragraph","text":"..."}},
    {{"type":"point","text":"..."}},
    {{"type":"quote","text":"..."}},
    {{"type":"link","text":"자세히 알아보기","url":"{footer_link}"}}
  ]
}}

SEO/구성 규칙:
1) 총 본문 글자수(공백 포함) {min_chars}자 이상
2) blocks {max(section_count * 4, 40)}~{max(section_count * 6, 60)}개
3) type은 hook|heading|paragraph|point|quote|link 만. HTML 금지
4) 시작에 hook 3개 (궁금증/핵심혜택/읽는이유)
5) heading 6개 이상: 정의·왜중요·구성/방법·실수·체크리스트·FAQ 등
6) 각 heading 아래 paragraph 3~5개 + point 1개 + quote 1개
7) paragraph는 2~4문장, 키워드·연관검색어를 자연스럽게 분산 배치 (키워드 스터핑 금지)
8) 메인 키워드는 제목 1회 + 본문 앞부분 1회 + 중반/FAQ에 자연스럽게 추가
9) related_keywords는 사람들이 실제로 같이 검색할 법한 한국어 검색어 4~6개
10) CTA link 블록은 정확히 2개:
    - 중간(4번째 heading 직후)
    - 맨 마지막
    text는 반드시 "자세히 알아보기", url은 반드시 "{footer_link}"
11) FAQ heading 아래 Q/A를 paragraph로 4쌍 이상
12) 이미지 태그/마크다운 금지
"""
    _log(f"[AI] SEO 장문 원고 생성... model={model} min_chars={min_chars}")
    data = _request_article(client, model, system, user)
    title, thumb_text, blocks = _normalize_article(data, required_phrases, footer_link)
    chars = _count_chars(blocks)
    _log(f"[AI] 1차 원고: {title} / blocks={len(blocks)} / chars={chars}")

    if chars < min_chars:
        _log(f"[AI] 글자수 부족({chars}<{min_chars}) → 보강 재생성")
        expand_user = user + f"""

추가 지시: 이전 초안이 {chars}자로 짧았습니다.
paragraph를 더 구체화하고 FAQ·체크리스트를 보강해 반드시 {min_chars}자 이상으로 작성하세요.
제목 키워드: {title}
"""
        data2 = _request_article(client, model, system, expand_user)
        title2, thumb2, blocks2 = _normalize_article(data2, required_phrases, footer_link)
        if _count_chars(blocks2) >= chars:
            title, thumb_text, blocks = title2, thumb2, blocks2
        chars = _count_chars(blocks)
        _log(f"[AI] 보강 후: blocks={len(blocks)} / chars={chars}")

    if chars < int(min_chars * 0.75):
        _log(f"[AI] 글자수 부족({chars}) → FAQ/체크리스트 패딩")
        pads = [
            {
                "type": "heading",
                "text": f"{keyword} 체크리스트",
            },
            {
                "type": "paragraph",
                "text": (
                    f"{keyword}를 실제로 적용하기 전에는 목적, 확인 기준, 위험 한도를 먼저 적어두세요. "
                    "막연한 기대보다 구체적인 기준이 있으면 판단이 흔들리지 않습니다. "
                    "초보 단계일수록 한 번에 많은 규칙을 넣기보다, 반복해서 확인할 수 있는 짧은 체크리스트가 더 도움이 됩니다."
                ),
            },
            {
                "type": "paragraph",
                "text": (
                    f"또한 {keyword} 관련 정보를 볼 때는 출처와 시점, 적용 조건을 함께 확인해야 합니다. "
                    "같은 용어라도 시장 환경이나 상품 구조에 따라 의미가 달라질 수 있기 때문입니다. "
                    "확정 수치를 단정하기보다, 본인 상황에 맞는 해석 기준을 정해 두는 편이 안전합니다."
                ),
            },
            {
                "type": "point",
                "text": f"{keyword}는 기준이 있어야 실무에 남는다",
            },
        ]
        # 마지막 CTA link 앞에 삽입
        insert_at = len(blocks)
        for i in range(len(blocks) - 1, -1, -1):
            if blocks[i].get("type") == "link":
                insert_at = i
                break
        for p in reversed(pads):
            blocks.insert(insert_at, p)
        chars = _count_chars(blocks)

    if chars < 1200:
        raise RuntimeError(f"원고 품질 미달: {chars}자 (최소 1200자). 모델/프롬프트를 확인하세요.")

    _log(f"[AI] 원고 완료: {title} / chars={chars}")
    return {
        "title": title,
        "thumb_text": thumb_text,
        "blocks": blocks,
        "char_count": chars,
        "related_keywords": list(data.get("related_keywords") or []),
    }


def _request_article(client: OpenAI, model: str, system: str, user: str) -> dict:
    resp = client.chat.completions.create(
        model=model,
        temperature=0.7,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    raw = resp.choices[0].message.content or "{}"
    return json.loads(raw)


def _normalize_article(
    data: dict,
    required_phrases: list[str],
    footer_link: str,
) -> tuple[str, str, list[dict]]:
    title = str(data.get("title", "")).strip()
    thumb_text = str(data.get("thumb_text", "")).strip()
    blocks_raw = data.get("blocks") or []
    blocks: list[dict] = []
    allowed = {"hook", "heading", "paragraph", "point", "quote", "link"}
    for b in blocks_raw:
        t = str((b or {}).get("type", "paragraph")).strip().lower()
        text = str((b or {}).get("text", "")).strip()
        url = str((b or {}).get("url", "")).strip()
        if t == "link":
            text = text or "자세히 알아보기"
            url = url or footer_link
        elif not text:
            continue
        if t not in allowed:
            t = "paragraph"
        text = re.sub(r"<[^>]+>", "", text).strip()
        item = {"type": t, "text": text}
        if t == "link":
            item["url"] = url or footer_link
            item["text"] = "자세히 알아보기"
        blocks.append(item)
    if not title or not blocks:
        raise RuntimeError("AI 글 생성 실패: title/blocks 비어 있음")
    if not thumb_text:
        thumb_text = title[:22]

    joined = "\n".join(b["text"] for b in blocks)
    for p in required_phrases:
        if p and p not in joined:
            blocks.insert(max(len(blocks) - 1, 0), {"type": "quote", "text": p})
            joined += "\n" + p

    link_blocks = [b for b in blocks if b["type"] == "link"]
    if len(link_blocks) < 2:
        # mid + end CTA 보장
        mid = max(len(blocks) // 2, 1)
        if not any(b["type"] == "link" for b in blocks[: mid + 1]):
            blocks.insert(
                mid,
                {"type": "link", "text": "자세히 알아보기", "url": footer_link},
            )
        if not blocks or blocks[-1].get("type") != "link":
            blocks.append({"type": "link", "text": "자세히 알아보기", "url": footer_link})
    else:
        for b in blocks:
            if b["type"] == "link":
                b["text"] = "자세히 알아보기"
                b["url"] = footer_link
    return title, thumb_text, blocks


def _download_to(path: Path, url: str | None = None, b64: str | None = None) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if b64:
        path.write_bytes(base64.b64decode(b64))
        return path
    if not url:
        raise RuntimeError("이미지 데이터(URL/b64)가 없습니다.")
    with urlopen(url, timeout=180) as r:  # noqa: S310
        path.write_bytes(r.read())
    return path


def _generate_one_image(
    client: OpenAI,
    *,
    model: str,
    prompt: str,
    size: str = "1024x1024",
    quality: str = DEFAULT_IMAGE_QUALITY,
):
    kwargs: dict = {
        "model": model,
        "prompt": prompt,
        "size": size,
        "n": 1,
    }
    if model.startswith("gpt-image"):
        # low=빠름/저질, medium=균형, high=고퀄(비쌈)
        q = quality if quality in {"low", "medium", "high", "auto"} else "medium"
        kwargs["quality"] = q
    elif model.startswith("dall-e"):
        kwargs["quality"] = "hd" if quality in {"high", "hd"} else "standard"
    return client.images.generate(**kwargs)


def _candidate_models(preferred: str) -> list[str]:
    pref = (preferred or DEFAULT_IMAGE_MODEL).strip()
    if pref.startswith("dall-e"):
        pref = DEFAULT_IMAGE_MODEL
    # mini 만 쓰라고 되어 있어도 품질 모델 우선 시도 후 mini
    out: list[str] = []
    for m in [pref, *IMAGE_MODEL_FALLBACKS]:
        if m and m not in out:
            out.append(m)
    return out


def _gen_single(
    api_key: str,
    model: str,
    name: str,
    prompt: str,
    out_path: Path,
    quality: str = DEFAULT_IMAGE_QUALITY,
    size: str = "1024x1024",
) -> tuple[str, Path, str | None]:
    try:
        client = OpenAI(api_key=api_key)
        result = _generate_one_image(
            client, model=model, prompt=prompt, size=size, quality=quality
        )
        item = result.data[0]
        b64 = getattr(item, "b64_json", None)
        url = getattr(item, "url", None)
        ext = "png" if b64 else "jpg"
        path = out_path.with_suffix(f".{ext}")
        _download_to(path, url=url, b64=b64)
        return name, path, None
    except Exception as e:  # noqa: BLE001
        return name, out_path, str(e)


def _image_prompt(keyword: str, theme: str, *, premium: bool = True) -> str:
    base = (
        f"Premium editorial photograph for a Korean finance/education blog about '{keyword}'. "
        f"Scene: {theme}. "
        "Photorealistic, sharp focus, natural lighting, shallow depth of field, "
        "clean composition, high detail, professional stock-photo quality. "
        "Absolutely no text, no letters, no watermark, no logo, no UI mockup."
    )
    if premium:
        base += " 8k detail, color graded, magazine cover aesthetic."
    return base


def generate_ai_images(
    client: OpenAI,
    *,
    keyword: str,
    out_dir: Path,
    body_count: int = 8,
    image_model: str = DEFAULT_IMAGE_MODEL,
    image_quality: str = DEFAULT_IMAGE_QUALITY,
    thumb_text: str = "",
    api_key: str = "",
    log: LogFn | None = None,
) -> tuple[Path, list[Path]]:
    """썸네일 1 + 본문 N장 병렬 생성(고퀄). 썸네일에 키워드 문구 오버레이."""
    _log = log or (lambda m: None)
    base = out_dir / _slug(keyword)
    base.mkdir(parents=True, exist_ok=True)

    if image_model.startswith("dall-e"):
        _log(f"[AI] {image_model} 제거됨 → gpt-image 계열 사용")

    themes = [
        ("thumb", f"wide cinematic desk scene related to {keyword}, charts and calm professional mood", "1536x1024"),
        ("body_01", f"clear conceptual visual explaining what {keyword} means", "1024x1024"),
        ("body_02", f"why {keyword} matters in real trading/finance workflow", "1024x1024"),
        ("body_03", f"step-by-step practical process for {keyword}", "1024x1024"),
        ("body_04", f"checklist notebook and planning for {keyword}", "1024x1024"),
        ("body_05", f"common mistakes and caution related to {keyword}", "1024x1024"),
        ("body_06", f"realistic example scenario around {keyword}", "1024x1024"),
        ("body_07", f"friendly Q&A consultation scene about {keyword}", "1024x1024"),
        ("body_08", f"summary and key takeaways mood for {keyword}", "1024x1024"),
        ("body_09", f"advanced tip visual for {keyword}", "1024x1024"),
        ("body_10", f"confident closing insight related to {keyword}", "1024x1024"),
    ]
    jobs = [themes[0]] + themes[1 : body_count + 1]
    key = api_key or getattr(client, "api_key", "") or ""
    candidates = _candidate_models(image_model)
    _log(f"[AI] 이미지 품질={image_quality}, 모델우선={candidates[0]}")

    first_name, first_theme, first_size = jobs[0]
    first_prompt = _image_prompt(keyword, first_theme)
    active_model: str | None = None
    first_path: Path | None = None
    last_err = None
    for model in candidates:
        # mini 는 size 제한 있을 수 있어 1024로 폴백
        size = first_size if not model.endswith("mini") else "1024x1024"
        _log(f"[AI] 이미지 생성: {first_name} ({model}, {image_quality}, {size})")
        name, path, err = _gen_single(
            key, model, first_name, first_prompt, base / first_name, image_quality, size
        )
        if err is None and path.exists():
            active_model = model
            first_path = path
            _log(f"[AI] 이미지 모델 확정: {model}")
            break
        last_err = err
        _log(f"[AI] 모델 실패({model}): {(err or '')[:180]}")
    if not active_model or not first_path:
        raise RuntimeError(f"이미지 모델 사용 불가: {last_err}")

    results: dict[str, Path] = {first_name: first_path}
    rest = jobs[1:]
    if rest:
        _log(f"[AI] 나머지 {len(rest)}장 병렬 생성 (workers=3, quality={image_quality})")
        with ThreadPoolExecutor(max_workers=3) as pool:
            futs = []
            for name, theme, size in rest:
                use_size = size if not active_model.endswith("mini") else "1024x1024"
                prompt = _image_prompt(keyword, theme)
                futs.append(
                    pool.submit(
                        _gen_single,
                        key,
                        active_model,
                        name,
                        prompt,
                        base / name,
                        image_quality,
                        use_size,
                    )
                )
            for fut in as_completed(futs):
                name, path, err = fut.result()
                if err:
                    raise RuntimeError(f"이미지 생성 실패({name}): {err}")
                results[name] = path
                _log(f"[AI] 이미지 완료: {name}")

    raw_thumb = results["thumb"]
    thumb = overlay_keyword_on_thumbnail(
        raw_thumb,
        base / "thumb_final.jpg",
        keyword=keyword,
        subtitle=thumb_text or f"{keyword} 핵심 가이드",
    )
    bodies: list[Path] = []
    for i in range(1, body_count + 1):
        key_name = f"body_{i:02d}"
        if key_name not in results:
            raise RuntimeError(f"본문 이미지 누락: {key_name}")
        bodies.append(results[key_name])

    _log(f"[AI] 이미지 완료: thumb + {len(bodies)}장 ({active_model}/{image_quality})")
    return thumb, bodies
