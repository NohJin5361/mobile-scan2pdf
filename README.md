# Scan2PDF — 휴대폰 문서 스캐너

휴대폰 브라우저에서 바로 쓰는 문서 스캐너입니다. 카메라로 찍으면 문서 모서리를 자동으로 찾아
반듯하게 펴고, 그림자·조명 얼룩을 지워 스캐너로 스캔한 것처럼 만들어 줍니다. 결과는 PDF/JPG로
저장하거나 공유할 수 있고, 별도 서버(DB)에 자동 업로드되어 언제든 다시 내려받을 수 있습니다.

- **앱 설치 없이** 휴대폰 브라우저(안드로이드 Chrome·삼성 인터넷, 아이폰 Safari)에서 동작하며,
  홈 화면에 추가하면 앱처럼 쓸 수 있습니다(PWA, 오프라인 동작).
- 영상처리(모서리 검출, 원근 보정, 필터)는 **외부 라이브러리 없이 순수 JavaScript로 직접 구현**해
  휴대폰 안에서 처리합니다. 서버는 저장·내보내기·OCR만 담당합니다.
- 나중에 기존 웹페이지에 붙이기 쉽도록 **정적 파일(web/) + REST API(server/)** 로 나뉘어 있습니다.

## 기능

| 구분 | 기능 |
| --- | --- |
| 촬영 | 실시간 문서 테두리 표시, 문서가 안정되면 **자동 촬영**, 한 장/**여러 장 연속 촬영**(다음 장으로 넘기면 다시 촬영), 플래시, 고해상도 촬영(ImageCapture), 갤러리에서 여러 장 가져오기, 카메라 사용 불가 시 기본 카메라 앱으로 촬영 |
| 모서리 | 자동 검출(서브픽셀 정밀도), **모서리 4개 + 변 4개를 끌어 수정**, 끄는 동안 원본 해상도 **돋보기**, 꼬인 사각형 경고, 다시 자동 감지/전체 선택/원래대로 |
| 보정 | 원근 보정 + **실제 종이 비율 추정**(비스듬히 찍어도 A4는 A4로), A4·Letter·Legal 비율 자동 맞춤 |
| 필터 | 원본, **자동 보정**(그림자·조명 제거, 색 유지, 인쇄된 사진은 보존), 선명한 문서, 그레이, 흑백, 사진 + 밝기/대비 |
| 편집 | 회전, 다시 찍기, 페이지 복제·삭제, **모든 페이지에 필터 적용**, 좌우 스와이프로 페이지 이동, 길게 눌러 끌어서 **페이지 순서 변경** |
| 저장 | **PDF**(자동/A4/Letter/Legal/A5/B5, 여백, 화질 4단계), **JPG**(한 장 또는 ZIP 묶음), 휴대폰 **공유** 시트, 문서 이름 변경·검색 |
| 클라우드 | 스캔/편집 시 서버로 **자동 업로드**(원본 사진·모서리·필터까지 저장 → 다른 기기에서도 다시 편집 가능), 클라우드 탭에서 PDF/ZIP 다운로드, 기기로 가져와 편집, 여러 기기 편집 병합 |
| OCR (선택) | 서버에 Tesseract가 있으면 **텍스트 추출**(복사/TXT 저장)과 **검색 가능한 PDF** 생성(한국어+영어) |

## 구조

```
web/                      휴대폰에서 실행되는 앱 (빌드 과정 없음, 정적 파일)
  index.html, sw.js       진입점, 오프라인용 서비스 워커
  js/core/                영상처리·파일 생성 (브라우저/Node 공용, 의존성 0)
    detect.js             문서 모서리 검출
    warp.js               원근 보정, 종이 비율 추정
    enhance.js            필터 (그림자 제거 등)
    pdf.js, zip.js        PDF/ZIP 작성기
  js/views/               화면 (홈, 카메라, 모서리, 페이지, 문서, 클라우드, 설정)
  js/store.js             기기 내 저장소 (IndexedDB)
  js/sync.js, api.js      서버 동기화
server/                   Python 서버 (FastAPI)
  scan2pdf/api.py         REST API (다른 FastAPI 앱에 그대로 붙일 수 있음)
  scan2pdf/db.py          DB 모델 (SQLite 기본, PostgreSQL/MySQL 가능)
  scan2pdf/storage.py     파일 저장소 (로컬 폴더 / DB / S3 호환)
  scan2pdf/ocr.py         OCR (선택)
tests/                    JS 단위 테스트, E2E(실제 브라우저) 테스트
```

## 빠른 시작

### 1) 서버 실행 (PC)

Python 3.10 이상이 필요합니다.

```bash
cd server
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m scan2pdf                 # http://localhost:8000
```

PC 브라우저에서 `http://localhost:8000` 을 열면 바로 사용할 수 있습니다.

### 2) 휴대폰에서 접속

브라우저는 **HTTPS 주소에서만 실시간 카메라를 허용**합니다(localhost 제외). 같은 Wi-Fi에서
시험할 때는 자체 서명 인증서로 실행하세요.

```bash
python -m scan2pdf --https --port 8443
#  Scan2PDF: https://localhost:8443
#            https://192.168.0.10:8443   (phone on the same Wi-Fi)
```

휴대폰에서 표시된 `https://192.168.x.x:8443` 주소를 열고 "안전하지 않음" 경고를 한 번 허용하면
됩니다. HTTP로 접속해도 갤러리 가져오기와 **기본 카메라 앱으로 촬영**은 그대로 동작하고 자동
보정도 똑같이 적용됩니다. 실제 운영은 아래 "배포"처럼 정식 인증서(도메인)를 쓰는 것을 권장합니다.

홈 화면에 추가(안드로이드: 메뉴 → 홈 화면에 추가, 아이폰: 공유 → 홈 화면에 추가)하면 앱처럼
전체 화면으로 실행됩니다.

### 3) Docker로 실행 (OCR 포함)

```bash
docker compose up -d --build       # http://서버주소:8000, 데이터는 ./data 에 저장
```

## 서버 설정 (환경 변수)

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `SCAN2PDF_DATA_DIR` | `./data` | SQLite DB, 파일, 인증서가 저장되는 폴더 |
| `SCAN2PDF_DATABASE_URL` | `sqlite:///<DATA_DIR>/scan2pdf.db` | 다른 DB 사용 시. 예: `postgresql+psycopg://user:pw@host/db`, `mysql+pymysql://user:pw@host/db` (해당 드라이버 설치 필요) |
| `SCAN2PDF_STORAGE` | `local` | 이미지 저장 위치: `local`(폴더), `db`(DB 안에 함께 저장), `s3`(S3/R2/MinIO 등) |
| `SCAN2PDF_S3_BUCKET`, `SCAN2PDF_S3_PREFIX`, `SCAN2PDF_S3_ENDPOINT_URL`, `SCAN2PDF_S3_REGION` | | `s3` 저장소 설정 (`pip install boto3`, 인증은 AWS 표준 환경 변수) |
| `SCAN2PDF_TOKEN` | (없음) | 설정하면 API 사용 시 토큰 필요. 앱의 **설정 → 접속 토큰**에 한 번 입력 |
| `SCAN2PDF_CORS_ORIGINS` | (없음) | 웹앱을 다른 도메인에서 띄울 때 허용할 출처(쉼표 구분) |
| `SCAN2PDF_MAX_UPLOAD_MB` | `50` | 업로드 파일 하나의 최대 크기 |
| `SCAN2PDF_WEB_DIR` | `../web` | 함께 제공할 웹앱 폴더 |
| `SCAN2PDF_TESSERACT` | `tesseract` | OCR 실행 파일 경로 |

DB 테이블 이름은 모두 `scan_` 으로 시작하므로(`scan_documents`, `scan_pages`, `scan_blobs`)
기존 사이트의 DB를 그대로 써도 충돌하지 않습니다. 테이블은 처음 실행할 때 자동으로 만들어집니다.

### OCR 켜기 (선택)

서버에 Tesseract만 설치하면 앱에 "검색 가능한 PDF", "텍스트 추출" 메뉴가 자동으로 나타납니다.

```bash
sudo apt install tesseract-ocr tesseract-ocr-kor     # Ubuntu/Debian
brew install tesseract tesseract-lang                 # macOS
```

Windows는 [UB-Mannheim 설치 파일](https://github.com/UB-Mannheim/tesseract/wiki)에서 Korean을
선택해 설치하고 `SCAN2PDF_TESSERACT` 에 `tesseract.exe` 경로를 지정하세요.

## 기존 웹페이지에 통합하기

웹앱은 모든 경로를 상대 경로로 쓰기 때문에 **어떤 하위 경로(예: `/scan/`)에 올려도 동작**합니다.
사이트 구성에 맞는 방법을 고르세요.

**A. 사이트가 FastAPI(파이썬)인 경우 — 앱째로 붙이기**

```python
import sys; sys.path.append("path/to/mobile-scan2pdf/server")
from scan2pdf.main import create_app

app.mount("/scan", create_app())   # https://내사이트/scan/ 에서 스캐너 + API(/scan/api)
```

API만 붙이고 화면은 직접 만들 때는 `create_api_router()` 를 `include_router` 하면 됩니다.

**B. 다른 백엔드(Flask, Django, Node, PHP 등) — 별도 서비스 + 리버스 프록시**

스캐너 서버를 `127.0.0.1:8000` 에서 실행하고 웹 서버에서 경로만 넘겨 줍니다. (nginx 예)

```nginx
location /scan/ {
    proxy_pass http://127.0.0.1:8000/;
    client_max_body_size 60m;
    proxy_read_timeout 300s;     # OCR/큰 PDF 생성 대비
}
```

**C. 화면 파일만 사이트에 올리고 API는 다른 주소에서**

`web/` 폴더를 사이트에 복사하고 `web/index.html` 의 `<meta name="scan2pdf-api" content="./api">` 를
API 주소(예: `https://api.내사이트/api`)로 바꾸거나, 앱의 **설정 → 서버 API 주소**에 입력합니다.
서버에는 `SCAN2PDF_CORS_ORIGINS=https://내사이트` 를 설정하세요.

**로그인 연동**: 개인용이라면 `SCAN2PDF_TOKEN` 하나로 충분합니다. 사이트의 로그인과 묶으려면
`server/scan2pdf/api.py` 의 `require_auth` 함수 하나만 사이트 세션/쿠키 검사로 바꾸면 됩니다.

## 배포 팁

- 휴대폰 카메라를 쓰려면 HTTPS가 필요합니다. 도메인이 있다면 [Caddy](https://caddyserver.com)
  (`scan.내도메인 { reverse_proxy 127.0.0.1:8000 }`)가 인증서를 자동으로 발급해 줍니다.
- 데이터는 `SCAN2PDF_DATA_DIR`(또는 지정한 DB/S3)에만 저장되므로 그 폴더만 백업하면 됩니다.
- 웹앱을 수정해 배포할 때는 `web/sw.js` 의 `CACHE` 버전 이름을 올려 주세요.

## REST API

모든 경로는 `/api` 아래에 있고, 토큰을 설정했다면 `Authorization: Bearer <토큰>` 헤더가 필요합니다.
실행 중인 서버의 `/api/docs` 에서 대화형 문서를 볼 수 있습니다.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/health` | 상태, 인증 필요 여부, OCR 지원 여부 (토큰 불필요) |
| GET | `/documents?q=` | 문서 목록/검색 |
| PUT | `/documents/{id}` | 문서 생성·수정 `{title}` |
| GET | `/documents/{id}` | 문서와 페이지 정보 |
| PATCH | `/documents/{id}` | `{title, page_order, delete_pages}` 이름·순서 변경, 페이지 삭제 |
| DELETE | `/documents/{id}` | 문서 삭제 |
| PUT | `/documents/{id}/pages/{pageId}` | 페이지 업로드 (multipart: `meta` JSON, `processed`, `original`, `thumb`) |
| DELETE | `/documents/{id}/pages/{pageId}` | 페이지 삭제 |
| GET | `/documents/{id}/pages/{pageId}/{processed\|original\|thumb}` | 이미지 (`?download=1`) |
| GET | `/documents/{id}/export.pdf` | PDF (`page_size`, `orientation`, `margin`(mm), `quality`, `pages`, `ocr=1`, `lang`) |
| GET | `/documents/{id}/export.zip` | JPG 묶음 |
| GET | `/documents/{id}/text` | OCR 텍스트 (`lang`, 기본 `kor+eng`) |

## 개발과 테스트

```bash
npm install                      # 테스트 도구(Playwright)만 설치, 앱 자체는 의존성 없음
npm test                         # 영상처리·PDF·ZIP 단위 테스트
npm run test:server              # 서버 테스트 (pytest, OCR 테스트는 tesseract 있을 때만)
npm run test:e2e                 # 실제 브라우저로 전체 흐름 테스트 (서버 자동 실행)
npm run bench                    # 합성 사진 60장으로 모서리 검출 정확도 측정
npm run lint
```

E2E 테스트는 휴대폰 화면 크기의 Chromium으로 사진 가져오기 → 모서리 검출 정확도 확인 → 필터 →
PDF 저장 → 자동 업로드, **가짜 카메라 영상으로 실시간 자동 촬영**, 페이지 순서 끌기, 다른 기기에서
내려받아 편집, 토큰 인증, OCR, 회전·다시 찍기·오프라인, 두 기기 동시 편집 병합을 검사합니다.
Python 경로는 `SCAN2PDF_PYTHON` 으로 바꿀 수 있습니다.

## 어떻게 동작하나요

1. **모서리 검출** (`detect.js`): 축소 이미지에서 색상 경계(R·G·B 중 가장 강한 기울기)로 Canny
   엣지를 구하고, 방향을 고려한 Hough 변환으로 직선 후보를 찾아 사각형을 만듭니다. 엣지 덩어리의
   볼록 껍질, 밝기 분할 영역에서 나온 사각형도 후보로 함께 평가합니다. 각 후보는 "네 변을 따라
   같은 방향의 밝기 변화가 얼마나 일정하게 이어지는가"로 점수를 매겨(글자 줄이 테두리로 오인되지
   않도록 경계의 밝기 방향을 따로 셈) 가장 좋은 것을 고르고, 큰 이미지에서 각 변을 다시 찾아
   직선을 맞춰 서브픽셀 정밀도로 다듬습니다. 합성 사진 60장(나무·어두운·밝은·잡동사니 배경, 손가락
   가림 포함) 기준 모서리 오차는 대각선 길이의 최대 0.02% 미만입니다(`npm run bench`).
2. **원근 보정** (`warp.js`): 네 꼭짓점으로 호모그래피를 구해 펴고, Zhang & He(2007) 방법으로
   실제 종이의 가로세로 비율을 추정합니다(비스듬히 찍을수록 단순 계산보다 정확). A4·Letter에
   가까우면 정확한 비율로 맞춥니다.
3. **필터** (`enhance.js`): 잉크를 지운 종이 밝기 지도를 만들어 각 픽셀을 나누면 그림자·조명
   얼룩·색 틀어짐이 사라집니다. 날카로운 테두리로 둘러싸인 인쇄 사진은 종이로 보지 않아 색이 그대로
   유지됩니다.

## 브라우저 지원과 참고 사항

- 안드로이드 Chrome/삼성 인터넷, iOS Safari 15 이상, PC Chrome/Edge/Firefox/Safari 최신 버전.
- 아이폰은 실시간 카메라 해상도가 사진 앱보다 낮을 수 있습니다. 최고 화질이 필요하면 카메라 화면의
  "가져오기"나 기본 카메라 앱으로 찍은 사진을 쓰세요(같은 자동 보정이 적용됩니다).
- 스캔 문서는 먼저 휴대폰(IndexedDB)에 저장된 뒤 서버로 올라가므로 오프라인에서도 스캔할 수 있고,
  다시 연결되면 자동으로 업로드됩니다.
- 여러 기기에서 같은 문서를 편집하면 페이지는 합쳐지고(지운 페이지만 삭제), 같은 페이지를 동시에
  고친 경우 마지막에 올린 내용이 남습니다.
