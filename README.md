# 지도교수 면담신청

학생이 면담을 신청하고 지도교수가 승인하는 웹 프로그램. Cloudflare 에 올려서 쓴다.

```
학생   이름·학번으로 로그인 → 주간 시간표에서 빈 칸 선택 → 신청 → 승인 여부 확인
교수   비밀번호로 로그인 → 면담 가능 시간 지정 → 신청 승인·거절 → 엑셀 내보내기
                                              → 승인하면 구글 캘린더에 자동 등록
```

## 무엇으로 만들었나

| | |
|---|---|
| Cloudflare Workers | API + 정적 화면을 한 번에. 빌드 단계가 없다 |
| Cloudflare D1 | SQLite. 시간표·신청 내역 |
| 의존성 | **없음**. 프런트는 순수 HTML/CSS/JS, 엑셀 생성기도 직접 넣었다 |

`npm install` 로 받는 건 배포 도구(wrangler)뿐이다. 런타임 의존성이 0 이라
Worker 가 가볍고, 라이브러리 때문에 깨질 일이 없다.

## 파일

| 파일 | 역할 |
|---|---|
| `src/index.js` | 라우터·API 전부 |
| `src/auth.js` | 세션 쿠키 (HMAC 서명) |
| `src/google.js` | 구글 OAuth + 캘린더 등록 |
| `src/xlsx.js` | .xlsx 생성기 (ZIP + XML 직접 작성) |
| `public/` | 화면 (index.html / app.js / style.css) |
| `schema.sql` | D1 테이블 |
| `wrangler.toml` | 설정 — 면담 시간대, 학교명 등 |

---

## 1. 먼저 로컬에서 띄워 보기

```bash
cd advisor-meeting
npm install
```

`.dev.vars.example` 를 `.dev.vars` 로 복사하고 값을 채운다(로컬 전용).

```bash
npm run db:local      # 로컬 D1 에 테이블 생성
npm run dev           # http://localhost:8787
```

교수 로그인 비밀번호는 `.dev.vars` 의 `ADVISOR_PASSWORD` 다.

## 2. Cloudflare 에 올리기

```bash
npx wrangler login
```

**D1 만들기.** 출력에 나오는 `database_id` 를 `wrangler.toml` 의
`PUT-YOUR-DATABASE-ID-HERE` 자리에 붙여넣는다.

```bash
npx wrangler d1 create advisor-meeting
```

**테이블 만들기.**

```bash
npm run db:remote
```

**비밀값 넣기.** `SESSION_SECRET` 은 아무 긴 임의 문자열이면 된다
(예: `openssl rand -base64 32`).

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ADVISOR_PASSWORD
```

**배포.**

```bash
npm run deploy
```

끝나면 `https://advisor-meeting.<계정>.workers.dev` 주소가 나온다.
학생에게는 그 주소를, 교수는 같은 주소에서 오른쪽 위 **지도교수** 탭으로 들어간다.

## 3. 구글 캘린더 연동 (선택)

승인할 때마다 교수 캘린더에 면담 일정이 자동으로 올라간다. 학생은 구글 계정이
필요 없다.

**서비스 계정 방식을 쓴다.** 사용자 동의 방식(OAuth)은 동의 화면을 거쳐야 하고,
앱이 "테스트" 상태면 토큰이 7일 뒤 만료되어 일주일마다 다시 연결해야 한다.
서비스 계정은 동의도 만료도 없다. 한 번 설정하면 계속 돈다.

### 3-1. 서비스 계정 만들기

[Google Cloud Console](https://console.cloud.google.com)

1. 프로젝트를 만든다.
2. *API 및 서비스 → 라이브러리* 에서 **Google Calendar API** 를 사용 설정한다.
3. *API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → 서비스 계정*
   - 이름은 아무거나 (예: `면담신청`)
   - 역할은 지정하지 않아도 된다. 캘린더 권한은 아래 공유로 준다.
4. 만들어진 서비스 계정 → *키* 탭 → **키 추가 → 새 키 만들기 → JSON**
   JSON 파일이 내려받아진다. 이 파일에 비공개 키가 들어 있으니 잘 보관한다.

JSON 안에서 두 값을 쓴다.

```
client_email   ...@...iam.gserviceaccount.com   -> GOOGLE_SA_EMAIL
private_key    -----BEGIN PRIVATE KEY-----...   -> GOOGLE_SA_PRIVATE_KEY
```

### 3-2. 캘린더를 서비스 계정에 공유

서비스 계정은 자기 캘린더만 가지고 있다. 교수 캘린더에 쓰려면 공유해야 한다.

[Google 캘린더](https://calendar.google.com) → 왼쪽에서 본인 캘린더 → *설정과 공유*
→ **특정 사용자와 공유** → 서비스 계정 이메일(`...iam.gserviceaccount.com`)을 추가
→ 권한을 **변경 권한**(일정 변경) 으로 준다.

이 단계를 빠뜨리면 승인할 때 404 가 나고, 앱이 "캘린더를 찾을 수 없습니다 —
공유했는지 확인하십시오" 라고 알려준다.

### 3-3. 값 세 개 넣기

```bash
npx wrangler secret put GOOGLE_SA_EMAIL        # client_email
npx wrangler secret put GOOGLE_CALENDAR_ID     # 교수 Gmail 주소
```

비공개 키는 여러 줄이라 손으로 붙여넣기 번거롭다. JSON 에서 바로 꺼내 넣는다.

```bash
node -e "console.log(require('./키파일.json').private_key)" | npx wrangler secret put GOOGLE_SA_PRIVATE_KEY
```

secret 은 **즉시 반영된다. 재배포가 필요 없다.**

### 3-4. 확인

앱 → *지도교수 → 설정* 에 `설정됨 — 캘린더 ...` 이 뜨면 된다.
**연결 시험** 을 누르면 일정을 하나 만들었다가 바로 지워서 설정이 맞는지 확인한다.

캘린더 등록이 실패해도 **승인 자체는 그대로 처리되고** 실패 이유를 알려준다.
면담 일정이 캘린더에 없다고 해서 승인이 날아가지는 않는다.

## 쓰는 법

### 지도교수

- **시간표** — 칸을 눌러 면담 가능 시간을 켜고 끈다. 끌면 여러 칸이 한 번에
  선택된다. `저장` 을 눌러야 반영된다. `지난 주 시간표 복사` 로 매주 같은
  패턴을 쉽게 깐다.
  신청이 걸린 칸은 실수로 못 지우게 막아 두었다. 지우려면 먼저 그 신청을 처리한다.
- **신청 목록** — 대기/승인/거절로 걸러 보고 승인·거절한다. 거절할 때 쓴 사유는
  학생에게 그대로 보인다. 탭 옆 빨간 숫자가 대기 건수다.
- **설정** — 구글 연동, 엑셀 내보내기, 데이터 삭제.

### 학생

이름과 학번으로 들어가 초록 칸을 누르면 신청된다. **같은 날에는 한 번만**
신청할 수 있다. 승인 전까지는 스스로 취소할 수 있고, 승인 뒤에는 교수에게
문의해야 한다.

## 바꿀 만한 것

`wrangler.toml` 의 `[vars]` 를 고치고 다시 배포하면 된다.

| 값 | 뜻 | 기본 |
|---|---|---|
| `DAY_START_MIN` / `DAY_END_MIN` | 시간표에 보일 범위 (자정부터 분) | 540 / 1080 = 09:00~18:00 |
| `SLOT_MIN` | 한 칸의 길이 | 15 |
| `SCHOOL_NAME` / `ADVISOR_NAME` | 화면에 쓸 이름 | |

`SLOT_MIN` 을 바꾸면 **이미 저장된 칸과 어긋난다.** 운영 시작 전에 정하고,
바꿔야 한다면 기존 시간표를 지우고 다시 까는 편이 낫다.

## 알아둘 점

- **이름+학번은 본인 확인이 아니다.** 남의 학번을 알면 그 이름으로 신청할 수
  있다. 요청하신 대로 만들었지만, 학과 안에서 쓰는 수준의 편의 장치로 보아야
  한다. 더 단단히 하려면 학교 SSO 연동이나 최소한 학생별 비밀번호가 필요하다.
  지금 구조에서는 교수가 신청 목록에서 이름·학번을 보고 거르는 것이 마지막 방어선이다.
- 세션은 서명된 쿠키 하나로 12시간 유지된다. 서버에 세션을 저장하지 않으므로
  `SESSION_SECRET` 을 바꾸면 모두 로그아웃된다.
- 한 칸에는 한 명만 들어간다. 두 학생이 동시에 눌러도 DB 의 UNIQUE 제약이
  막고, 늦은 쪽은 "방금 다른 학생이 예약했습니다" 를 본다.
- 날짜는 전부 Asia/Seoul 기준이다. 한국은 서머타임이 없어 +09:00 고정으로 맞다.
- 엑셀 파일은 라이브러리 없이 ZIP+XML 을 직접 써서 만든다. 값은 전부 문자열로
  넣는데, 그래야 `20251111` 같은 학번이 숫자로 바뀌어 앞자리 0 이 날아가지 않는다.
- 데이터 삭제는 되돌릴 수 없다. 확인 문구로 "삭제" 를 직접 입력해야 실행된다.
  지우기 전에 엑셀로 내보내 두는 편이 안전하다.
- 지금은 **교수 한 명** 기준이다. 여러 교수를 받으려면 `slots`·`bookings` 에
  `advisor_id` 를 넣고 로그인을 교수별로 나누면 된다.
