from __future__ import annotations

import base64
import json
import re
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.request import urlopen

from openai import OpenAI

LogFn = Callable[[str], None]

FOOTER_LINK = "https://minestock.kr"
# 한글 썸네일: gpt-image-2 (mini/1 은 한글 깨짐)
DEFAULT_IMAGE_MODEL = "gpt-image-2"
DEFAULT_BODY_IMAGE_MODEL = "gpt-image-1-mini"  # 본문(글자없음)만 저비용
DEFAULT_TEXT_MODEL = "gpt-4o"
DEFAULT_IMAGE_QUALITY = "medium"
DEFAULT_BODY_IMAGE_QUALITY = "low"
DEFAULT_MIN_CHARS = 2400  # 모바일 짧은 문단 기준 (장문 한 덩어리 X)

# 썸네일(한글 문구)용 — mini 제외
THUMB_MODEL_FALLBACKS = [
    "gpt-image-2",
    "gpt-image-1.5",
    "gpt-image-1",
]
# 본문(무문자)용
BODY_MODEL_FALLBACKS = [
    "gpt-image-1-mini",
    "gpt-image-1",
    "gpt-image-1.5",
    "gpt-image-2",
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
    """모바일 가독성 중심 정보성 글. 최소 글자수 미달 시 보강."""
    _log = log or (lambda m: None)
    phrase_rule = (
        "필수 문구 없음. '이거다'/'이거다!' 표현 절대 사용 금지."
        if not required_phrases
        else f"선택 필수 문구(자연스럽게만): {', '.join(required_phrases)}. 단 '이거다' 금지."
    )
    system = (
        "당신은 네이버 블로그 모바일 가독성에 강한 SEO 칼럼니스트입니다. "
        "독자 대부분이 스마트폰으로 읽습니다. 짧은 문단, 강한 후킹, 번호 섹션, "
        "섹션마다 인용 1개, FAQ, CTA 링크 구조를 씁니다. JSON만 출력합니다."
    )
    user = f"""
키워드: {keyword}
브랜드/필명: {brand_name}
{phrase_rule}
필수 링크: {footer_link}

레퍼런스 리듬(반드시 모방):
- 제목: 키워드 앞배치 정보성 (예: 해외선물수수료 거래 전 꼭 확인해야 하는 비용 구조)
- 후킹: 문제/반전을 짧고 세게 (1~2문장 × 3개). 긴 설명 금지
- 본문 각 섹션: heading → 짧은 paragraph 2~3개 → quote 1개 → (다음 섹션)
- quote를 FAQ 앞에 몰아넣지 말 것. 각 번호 섹션 끝에 바로 배치
- 중간/마지막 link 블록 (URL은 url 필드만)
- FAQ 5개: Q/A 각각 짧은 paragraph

JSON 스키마:
{{
  "title": "키워드 앞배치 SEO 제목 40~56자",
  "thumb_text": "썸네일 클릭문구 10~18자",
  "image_topics": ["섹션주제 그림설명", "...{section_count}개"],
  "hook": ["후킹1", "후킹2", "후킹3"],
  "blocks": [
    {{"type":"heading","text":"1. ..."}},
    {{"type":"paragraph","text":"..."}},
    {{"type":"point","text":"핵심 한 줄"}},
    {{"type":"quote","text":"..."}},
    {{"type":"link","text":"자세히 알아보기","url":"{footer_link}"}}
  ]
}}

모바일 규칙(중요):
1) 총 글자수 {min_chars}자 이상
2) hook 3개, 각 1~2문장, 45~100자. 첫 문장은 질문/반전으로 시작
3) paragraph 각 1~3문장, 55~130자. 긴 문단 절대 금지
4) type: heading|paragraph|point|quote|link|hook 만. HTML 금지
5) heading "1. ..." 6개+ + FAQ heading
6) 각 번호 섹션(1~6)마다 quote 1개씩 섹션 끝에 배치 (총 6개+). FAQ 직전 몰아넣기 금지
7) point 블록 4개+: 독자가 기억할 핵심 한 줄 (60자 이내)
8) link 2개(중간/마지막). text에 URL 금지, url={footer_link}
9) 본문/후킹/인용에 http URL 금지, '이거다' 금지
10) image_topics {section_count}개, 사람/얼굴 금지, 차트·개념도
11) 해외선물 수수료: 계약당 정액(달러), 왕복, 위탁+거래소+스프레드+환전. % 요율 금지
12) 확정수익 약속/이모지/해시태그 남발 금지
"""
    _log(f"[AI] 고품질 장문 원고 생성... model={model} min_chars={min_chars}")
    data = _request_article(client, model, system, user)
    title, thumb_text, blocks, image_topics = _normalize_article(
        data, required_phrases, footer_link, section_count=section_count, keyword=keyword
    )
    chars = _count_chars(blocks)
    _log(f"[AI] 1차 원고: {title} / blocks={len(blocks)} / chars={chars}")

    for attempt in range(1, 3):
        if chars >= min_chars:
            break
        _log(f"[AI] 글자수 부족({chars}<{min_chars}) → 강제 확장 #{attempt}")
        title, thumb_text, blocks, image_topics = _expand_article(
            client,
            model=model,
            title=title,
            thumb_text=thumb_text,
            blocks=blocks,
            keyword=keyword,
            required_phrases=required_phrases,
            footer_link=footer_link,
            min_chars=min_chars,
            section_count=section_count,
            image_topics=image_topics,
            log=_log,
        )
        chars = _count_chars(blocks)
        _log(f"[AI] 보강 후: blocks={len(blocks)} / chars={chars}")

    if chars < min_chars:
        _log(f"[AI] 문단 단위 살붙이기 ({chars}->{min_chars})")
        title, thumb_text, blocks, image_topics = _fatten_paragraphs(
            client,
            model=model,
            title=title,
            thumb_text=thumb_text,
            blocks=blocks,
            keyword=keyword,
            required_phrases=required_phrases,
            footer_link=footer_link,
            min_chars=min_chars,
            section_count=section_count,
            image_topics=image_topics,
            log=_log,
        )
        chars = _count_chars(blocks)
        _log(f"[AI] 살붙이 후: blocks={len(blocks)} / chars={chars}")

    if chars < int(min_chars * 0.75):
        raise RuntimeError(f"원고 품질 미달: {chars}자 (목표 {min_chars}자). 모델/프롬프트를 확인하세요.")

    _log(f"[AI] 원고 완료: {title} / chars={chars} / image_topics={len(image_topics)}")
    return {
        "title": title,
        "thumb_text": thumb_text,
        "blocks": blocks,
        "char_count": chars,
        "image_topics": image_topics,
    }


def _request_article(client: OpenAI, model: str, system: str, user: str) -> dict:
    resp = client.chat.completions.create(
        model=model,
        temperature=0.65,
        max_tokens=8000,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    raw = resp.choices[0].message.content or "{}"
    return json.loads(raw)


def _fatten_paragraphs(
    client: OpenAI,
    *,
    model: str,
    title: str,
    thumb_text: str,
    blocks: list[dict],
    keyword: str,
    required_phrases: list[str],
    footer_link: str,
    min_chars: int,
    section_count: int = 8,
    image_topics: list[str] | None = None,
    log: LogFn | None = None,
) -> tuple[str, str, list[dict], list[str]]:
    """짧은 문단을 유지한 채 각 paragraph/hook를 살붙여 총량을 맞춤."""
    _log = log or (lambda m: None)
    draft = json.dumps(
        {"title": title, "thumb_text": thumb_text, "blocks": blocks, "image_topics": image_topics or []},
        ensure_ascii=False,
    )
    system = "모바일 블로그 문단을 살붙이는 편집장. JSON만 출력."
    user = f"""
키워드: {keyword}
현재 글자수 부족. 목표 {min_chars}자 이상.
규칙:
- 기존 구조를 유지하되 각 hook/paragraph/point/quote 텍스트를 더 구체적 사례·설명으로 늘릴 것
- paragraph는 여전히 모바일형: 2~3문장, 80~130자
- 섹션마다 paragraph를 추가로 1~2개 더 넣어도 됨
- '이거다' 금지, URL 본문 금지
- link 2개 유지 url={footer_link}
- 출력 JSON: title, thumb_text, image_topics, blocks

초안:
{draft}
"""
    data = _request_article(client, model, system, user)
    title2, thumb2, blocks2, topics2 = _normalize_article(
        data, required_phrases, footer_link, section_count=section_count, keyword=keyword
    )
    if _count_chars(blocks2) > _count_chars(blocks):
        _log("[AI] 살붙이 성공")
        return title2, thumb2, blocks2, topics2
    _log("[AI] 살붙이 실패 → 초안 유지")
    return title, thumb_text, blocks, image_topics or topics2


def _expand_article(
    client: OpenAI,
    *,
    model: str,
    title: str,
    thumb_text: str,
    blocks: list[dict],
    keyword: str,
    required_phrases: list[str],
    footer_link: str,
    min_chars: int,
    section_count: int = 8,
    image_topics: list[str] | None = None,
    log: LogFn | None = None,
) -> tuple[str, str, list[dict], list[str]]:
    """짧은 초안을 유지한 채 각 문단을 늘리고 섹션/FAQ를 추가."""
    _log = log or (lambda m: None)
    draft = json.dumps(
        {
            "title": title,
            "thumb_text": thumb_text,
            "blocks": blocks,
            "image_topics": image_topics or [],
        },
        ensure_ascii=False,
    )
    system = (
        "당신은 모바일 가독성 중심의 네이버 블로그 편집장입니다. "
        "문단을 짧게 쪼개고, 섹션마다 quote를 배치하며, '이거다'를 제거합니다. JSON만 출력."
    )
    user = f"""
키워드: {keyword}
목표 글자수: {min_chars}자 이상
필수 링크 url: {footer_link}
금지: '이거다', 문장 속 URL, 긴 문단(130자 초과 paragraph)

초안을 모바일형으로 늘리세요. 짧게 쓰되 문단 개수를 크게 늘려 총 {min_chars}자 이상.
1) 각 번호 섹션마다 paragraph를 3~4개로 늘리기 (각 55~130자)
2) 섹션마다 quote 1개 + point 1개
3) FAQ Q1~Q5를 질문/답 각각 paragraph로
4) 비유/사례/체크리스트 문단 추가
5) link 2개, text에 URL 금지, '이거다' 금지
6) hook 3개 유지(각 45~100자)
7) 계약당 정액·왕복 기준 유지
8) 출력: {{"title","thumb_text","image_topics","blocks"}}

초안:
{draft}
"""
    data = _request_article(client, model, system, user)
    title2, thumb2, blocks2, topics2 = _normalize_article(
        data, required_phrases, footer_link, section_count=section_count, keyword=keyword
    )
    c2 = _count_chars(blocks2)
    c1 = _count_chars(blocks)
    if c2 > c1 or len(blocks2) > len(blocks):
        return title2, thumb2, blocks2, topics2
    _log(f"[AI] 확장본 개선 없음({c2}<={c1}) → 초안 유지")
    return title, thumb_text, blocks, image_topics or topics2


def _normalize_article(
    data: dict,
    required_phrases: list[str],
    footer_link: str,
    *,
    section_count: int = 8,
    keyword: str = "",
) -> tuple[str, str, list[dict], list[str]]:
    title = str(data.get("title", "")).strip()
    thumb_text = str(data.get("thumb_text", "")).strip()
    blocks: list[dict] = []

    hooks = data.get("hook") or []
    if isinstance(hooks, str):
        hooks = [hooks]
    banned = ("이거다", "이거다!")

    def _clean(text: str) -> str:
        text = re.sub(r"<[^>]+>", "", text)
        text = re.sub(r"https?://\S+", "", text)
        for ban in banned:
            text = text.replace(ban, "")
        text = re.sub(r"\s{2,}", " ", text).strip(" ,.")
        return text.strip()

    for h in hooks:
        text = _clean(str(h).strip())
        if text:
            blocks.append({"type": "hook", "text": text})

    for b in data.get("blocks") or []:
        t = str((b or {}).get("type", "paragraph")).strip().lower()
        text = _clean(str((b or {}).get("text", "")).strip())
        url = str((b or {}).get("url", "")).strip()
        if t == "cta":
            t = "link"
            url = url or footer_link
        if t == "link":
            if not text:
                text = "자세히 알아보기"
            text = _clean(text) or "자세히 알아보기"
            blocks.append({"type": "link", "text": text, "url": url or footer_link})
            continue
        if not text:
            continue
        if t not in {"heading", "paragraph", "quote", "hook", "point"}:
            t = "paragraph"
        # 모바일: 너무 긴 paragraph는 문장 단위로 분할
        if t == "paragraph" and len(text) > 150:
            parts = re.split(r"(?<=[.!?다요음])\s+", text)
            buf = ""
            for part in parts:
                if not part:
                    continue
                if buf and len(buf) + len(part) > 130:
                    blocks.append({"type": "paragraph", "text": buf.strip()})
                    buf = part
                else:
                    buf = f"{buf} {part}".strip()
            if buf:
                blocks.append({"type": "paragraph", "text": buf.strip()})
            continue
        blocks.append({"type": t, "text": text})

    if not title or not blocks:
        raise RuntimeError("AI 글 생성 실패: title/blocks 비어 있음")
    if not thumb_text:
        thumb_text = (keyword or title)[:18]
    thumb_text = _clean(thumb_text) or (keyword or title)[:18]

    # 선택적 필수문구만 주입 (이거다는 이미 필터됨)
    joined = "\n".join(b["text"] for b in blocks)
    for p in required_phrases:
        if p and p not in banned and p not in joined:
            blocks.insert(min(3, len(blocks)), {"type": "point", "text": p})
            joined += "\n" + p

    link_count = sum(1 for b in blocks if b.get("type") == "link")
    if link_count < 1:
        mid = max(len(blocks) // 2, 1)
        blocks.insert(mid, {"type": "link", "text": "실무 가이드 더 보기", "url": footer_link})
    if sum(1 for b in blocks if b.get("type") == "link" and b.get("url") == footer_link) < 2:
        blocks.append({"type": "link", "text": "자세히 이어서 보기", "url": footer_link})

    topics_raw = data.get("image_topics") or []
    if not isinstance(topics_raw, list):
        topics_raw = []
    image_topics = [re.sub(r"<[^>]+>", "", str(t).strip()) for t in topics_raw if str(t).strip()]
    defaults = [
        f"{keyword} 개념 다이어그램",
        f"{keyword} 비용 구조 차트",
        f"{keyword} 왕복 수수료 설명",
        f"{keyword} 체크리스트 아이콘",
        f"{keyword} 주의사항 경고 아이콘",
        f"{keyword} 비교 표 일러스트",
        f"{keyword} FAQ 아이콘",
        f"{keyword} 요약 인포그래픽",
        f"{keyword} 실무 팁 아이콘",
        f"{keyword} 핵심 포인트 카드",
    ]
    while len(image_topics) < section_count:
        image_topics.append(defaults[len(image_topics) % len(defaults)])
    image_topics = image_topics[:section_count]

    return title, thumb_text, blocks, image_topics


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


def _candidate_models(preferred: str, fallbacks: list[str]) -> list[str]:
    pref = (preferred or "").strip()
    if pref.startswith("dall-e"):
        pref = fallbacks[0]
    out: list[str] = []
    for m in [pref, *fallbacks]:
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


def _thumb_prompt(keyword: str, thumb_text: str = "") -> str:
    label = (thumb_text or f"{keyword} 핵심").strip()[:20]
    return (
        f"Korean YouTube/blog thumbnail about '{keyword}'. "
        "Dark modern finance background with charts, coins, arrows. "
        f'Large bold perfectly readable Korean Hangul centered: "{label}". '
        f'Smaller clear Korean Hangul subtitle: "{keyword}". '
        "Correct Hangul syllable composition, sharp high-contrast text, no broken characters. "
        "NO photorealistic people, NO faces. Click-worthy thumbnail."
    )


def _body_image_prompt(keyword: str, topic: str) -> str:
    return (
        f"Simple educational illustration for finance blog. Topic: '{topic}' (related to '{keyword}'). "
        "Clean flat infographic / diagram / icons matching the topic. "
        "ABSOLUTELY NO TEXT, NO LETTERS, NO NUMBERS, NO HANGUL, NO LABELS, NO WATERMARK. "
        "NO photorealistic people, NO faces, NO portraits. "
        "Charts, arrows, checklist icons, comparison boards only."
    )


def _pick_working_model(
    api_key: str,
    *,
    name: str,
    prompt: str,
    out_path: Path,
    candidates: list[str],
    quality: str,
    size: str,
    log: LogFn,
) -> tuple[str, Path]:
    last_err = None
    for model in candidates:
        use_size = size if not model.endswith("mini") else "1024x1024"
        log(f"[AI] 시도: {name} ({model}/{quality}/{use_size})")
        n, path, err = _gen_single(api_key, model, name, prompt, out_path, quality, use_size)
        if err is None and path.exists():
            log(f"[AI] 확정: {name} -> {model}")
            return model, path
        last_err = err
        log(f"[AI] 실패({model}): {(err or '')[:160]}")
    raise RuntimeError(f"이미지 모델 사용 불가({name}): {last_err}")


def generate_ai_images(
    client: OpenAI,
    *,
    keyword: str,
    out_dir: Path,
    body_count: int = 8,
    image_model: str = DEFAULT_IMAGE_MODEL,
    image_quality: str = DEFAULT_IMAGE_QUALITY,
    body_image_model: str = DEFAULT_BODY_IMAGE_MODEL,
    body_image_quality: str = DEFAULT_BODY_IMAGE_QUALITY,
    thumb_text: str = "",
    image_topics: list[str] | None = None,
    api_key: str = "",
    log: LogFn | None = None,
) -> tuple[Path, list[Path]]:
    """썸네일=gpt-image-2(한글OK) / 본문=무문자 저비용 모델."""
    _log = log or (lambda m: None)
    base = out_dir / _slug(keyword)
    base.mkdir(parents=True, exist_ok=True)

    if image_model.startswith("dall-e"):
        image_model = DEFAULT_IMAGE_MODEL
        _log("[AI] dall-e 제거됨 → gpt-image-2 사용")
    # 썸네일에 mini 강제 방지
    if image_model.endswith("mini"):
        _log(f"[AI] 썸네일용 {image_model} 은 한글 깨짐 → gpt-image-2 로 교체")
        image_model = DEFAULT_IMAGE_MODEL

    topics = list(image_topics or [])
    while len(topics) < body_count:
        topics.append(f"{keyword} 핵심 개념 {len(topics)+1}")
    topics = topics[:body_count]

    key = api_key or getattr(client, "api_key", "") or ""
    thumb_q = image_quality if image_quality in {"low", "medium", "high", "auto"} else "medium"
    body_q = (
        body_image_quality
        if body_image_quality in {"low", "medium", "high", "auto"}
        else "low"
    )

    thumb_cands = _candidate_models(image_model, THUMB_MODEL_FALLBACKS)
    body_cands = _candidate_models(body_image_model, BODY_MODEL_FALLBACKS)
    _log(f"[AI] 썸네일={thumb_cands[0]}/{thumb_q}(한글), 본문={body_cands[0]}/{body_q}(무문자)")

    thumb_model, thumb_path = _pick_working_model(
        key,
        name="thumb",
        prompt=_thumb_prompt(keyword, thumb_text),
        out_path=base / "thumb",
        candidates=thumb_cands,
        quality=thumb_q,
        size="1536x1024",
        log=_log,
    )

    bodies: list[Path] = []
    if body_count > 0:
        # 본문 모델 1장으로 확정 후 병렬
        body_model, first_body = _pick_working_model(
            key,
            name="body_01",
            prompt=_body_image_prompt(keyword, topics[0]),
            out_path=base / "body_01",
            candidates=body_cands,
            quality=body_q,
            size="1024x1024",
            log=_log,
        )
        results: dict[str, Path] = {"body_01": first_body}
        rest = list(enumerate(topics[1:], start=2))
        if rest:
            _log(f"[AI] 본문 나머지 {len(rest)}장 병렬 ({body_model}/{body_q})")
            with ThreadPoolExecutor(max_workers=3) as pool:
                futs = [
                    pool.submit(
                        _gen_single,
                        key,
                        body_model,
                        f"body_{i:02d}",
                        _body_image_prompt(keyword, topic),
                        base / f"body_{i:02d}",
                        body_q,
                        "1024x1024",
                    )
                    for i, topic in rest
                ]
                for fut in as_completed(futs):
                    name, path, err = fut.result()
                    if err:
                        raise RuntimeError(f"이미지 생성 실패({name}): {err}")
                    results[name] = path
                    _log(f"[AI] 이미지 완료: {name}")
        for i in range(1, body_count + 1):
            bodies.append(results[f"body_{i:02d}"])

    _log(
        f"[AI] 이미지 완료: thumb={thumb_model}/{thumb_q} + body={len(bodies)}장"
    )
    return thumb_path, bodies
