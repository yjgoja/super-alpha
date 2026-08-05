# 네이버 블로그 SEO 자동 포스팅

## EXE (완성본)

- 실행 파일: `dist/NaverBlogSEO_Release/NaverBlogSEO.exe`
- 압축본: `dist/NaverBlogSEO_Release.zip`
- 재빌드: `powershell -ExecutionPolicy Bypass -File .\build_exe.ps1`

키워드 기반 **정보성** SEO 글을 **하루 4개**까지 작성합니다.

- ChatGPT(OpenAI)로 정보성 본문 생성
- DALL·E로 썸네일 1 + 본문 이미지 8장 생성·업로드
- 글 하단 필수 링크: `https://minestock.kr`
- 필수 문구 포함 (기본: `이거다`)
- GUI에 OpenAI API Key 입력칸 제공

> 권장: `AUTO_PUBLISH=false`로 입력까지 자동화하고, **최종 발행은 수동 검수**.
> 이미지 9장/글 × 하루 4건은 OpenAI 비용이 꽤 나올 수 있습니다.

## 1. 설치

```bash
cd naver-blog-seo
python -m venv .venv
# Windows
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

`.env`에 네이버 계정과 옵션을 넣습니다.

```env
NAVER_ID=your_id
NAVER_PW=your_pw
AUTO_PUBLISH=false
HEADLESS=false
```

## 2. 키워드 / 필수 문구 설정

`config.yaml`을 수정하세요.

```yaml
posts_per_day: 4
keywords:
  - "원하는 키워드1"
  - "원하는 키워드2"
required_phrases:
  - "이거다"
body_image_count: 8
post_times:
  - "09:30"
  - "12:30"
  - "15:30"
  - "19:00"
```

## 3. 실행

### 폰 / Cursor 원격 제어 (권장)

```bash
cd naver-blog-seo
python scripts/remote_ctl.py status
python scripts/remote_ctl.py dry-run --count 1
python scripts/remote_ctl.py once --count 1
python scripts/remote_ctl.py schedule
python scripts/remote_ctl.py stop
```

상태/로그: `output/remote_ctl_status.json`, `output/remote_ctl.log`

### 글/이미지만 생성 (브라우저 없음)

```bash
python main.py dry-run
python main.py dry-run --count 4
```

### 지금 바로 작성 (Selenium)

```bash
python main.py once
python main.py once --count 4
```

### 하루 스케줄 (시각마다 1건)

```bash
python main.py schedule
```

## 4. 동작 요약

1. 키워드 큐에서 다음 키워드 선택
2. SEO 본문 생성 + 필수 문구 포함 검증
3. Pillow로 썸네일/본문 이미지 생성
4. 네이버 로그인 (클립보드 붙여넣기)
5. `blog.naver.com/{id}?Redirect=Write` → `mainFrame` 전환
6. 제목 붙여넣기 + 본문 `insertHTML` + 이미지 8장(+썸네일) 업로드
7. `AUTO_PUBLISH=true`면 발행 버튼까지, 아니면 수동 발행 대기

## 5. 주의

- 네이버 정책/캡차/2단계 인증에 걸릴 수 있습니다. 최초 로그인·기기 확인은 직접 처리하세요.
- 완전 자동 대량 발행은 저품질(C-Rank) 위험이 큽니다. 검수 후 발행을 권장합니다.
- 계정 정보는 Git에 커밋하지 마세요.
