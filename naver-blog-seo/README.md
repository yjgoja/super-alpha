# 네이버 블로그 SEO 자동 포스팅

키워드 기반 SEO 글을 **매일 00:00에 4개** 자동 발행합니다.

- 외환 / MT5 / 주식 / 지표 키워드 큐 순환
- SEO 제목·본문·FAQ·중간/하단 CTA(`자세히 알아보기` + OG 링크, 가운데 정렬)
- 썸네일 1장 + 본문 이미지 8장 자동 생성·업로드
- 스마트에디터 ONE 기준 작성/발행

> 운영: `.env`에 `AUTO_PUBLISH=true` + `python main.py schedule` (또는 `scripts/install_midnight_task.ps1`)

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
post_times:
  - "00:00"   # 1개면 해당 시각에 4건 일괄
keywords:
  - "원달러 환율"
  - "MT5 사용법"
  - "RSI 지표"
required_phrases: []
body_image_count: 8
```

## 3. 실행

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

### 하루 스케줄 (기본: 매일 00:00에 4건)

```bash
python main.py schedule
```

Windows 작업 스케줄러 등록(로그인/자정 기동):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install_midnight_task.ps1
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
