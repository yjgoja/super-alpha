# 폰에서 전 프로젝트 지시

외부에서도 **Cursor 앱** + **Super Alpha 앱**으로 PC처럼 지시합니다.

## 1) Super Alpha 앱 (트레이딩)

로그인 → **마이페이지 → 원격 지시 센터** (`/manage/remote`)

- 봇 / 전략 / 관리자 / 계좌 바로가기
- Cursor에 붙여 넣을 지시문 원탭 복사

## 2) Cursor 앱 (코드 + 로컬 자동화)

Private worker PC가 켜져 있어야 블로그·팩토리가 실행됩니다.

### 네이버 블로그·이미지 자동화 (지금 돌아가는 콘텐츠 자동화)

```
naver-blog-seo 상태 확인해줘
블로그 dry-run 1건 돌려줘
블로그 once 1건 작성해줘 (자동발행 말고)
블로그 스케줄 자동화 시작해줘
블로그 자동화 멈춰줘
```

또는:

```bash
cd naver-blog-seo
python scripts/remote_ctl.py status
python scripts/remote_ctl.py once --count 1
```

### 로직 팩토리

```
invent24 팩토리 상태 확인해줘
팩토리 invent 재시작해줘
```

### 엔진 / 배포

```
Render 엔진 상태 확인해줘
라이브 naked TP/SL 없는지 검증해줘
```

## 3) 범위

| 프로젝트 | 폰 경로 |
|----------|---------|
| 트레이딩 | 앱 `/bot` `/manage` `/admin` + Cursor |
| 블로그·이미지 | Cursor → `remote_ctl.py` |
| 팩토리 | Cursor → `start-factory-invent.ps1` |
| 엔진 | Cursor → 코드/검증 스크립트 |

일반 회원에게는 전략 IP·원격 센터가 열리지 않습니다 (관리자만).
