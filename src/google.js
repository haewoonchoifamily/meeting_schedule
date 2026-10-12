// 구글 캘린더 연동 — 서비스 계정 방식.
//
// 승인한 면담을 교수 캘린더에 자동으로 올린다. 학생은 구글 계정이 필요 없다.
//
// 왜 서비스 계정인가
//   OAuth 사용자 동의 방식은 동의 화면을 거쳐야 하고, 앱이 "테스트" 상태면
//   refresh token 이 7일 뒤 만료되어 일주일마다 다시 연결해야 한다. 서비스
//   계정은 동의 화면도 만료도 없다. 한 번 설정하면 계속 돈다.
//
// 어떻게 도는가
//   비공개 키로 JWT 를 만들어 구글에 주면 access token 을 돌려준다(1시간짜리).
//   그 토큰으로 캘린더 API 를 부른다. 서비스 계정 자신의 캘린더가 아니라
//   교수 캘린더에 쓰므로, 교수가 그 캘린더를 서비스 계정 이메일에 공유해
//   두어야 한다(권한: 변경 권한).
//
// 필요한 값 (없으면 연동만 꺼지고 나머지는 그대로 돈다)
//   GOOGLE_SA_EMAIL        서비스 계정 이메일 (...iam.gserviceaccount.com)
//   GOOGLE_SA_PRIVATE_KEY  키 JSON 의 private_key (PEM)
//   GOOGLE_CALENDAR_ID     일정을 넣을 캘린더 = 보통 교수 Gmail 주소

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const JWT_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

const enc = new TextEncoder();

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const isConfigured = (env) =>
  Boolean(env.GOOGLE_SA_EMAIL && env.GOOGLE_SA_PRIVATE_KEY && env.GOOGLE_CALENDAR_ID);

/** 설정이 다 됐으면 바로 쓸 수 있다. 서비스 계정은 따로 "연결" 단계가 없다. */
export const isLinked = async (env) => isConfigured(env);
export const linkedAccount = async (env) => env.GOOGLE_CALENDAR_ID || null;
export const serviceAccount = (env) => env.GOOGLE_SA_EMAIL || null;

function eventsUrl(env, suffix = "") {
  return "https://www.googleapis.com/calendar/v3/calendars/" +
         `${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events${suffix}`;
}

/**
 * PEM 을 WebCrypto 가 받는 DER 로.
 *
 * secret 에 넣는 경로에 따라 줄바꿈이 "\n" 두 글자로 들어오기도 하고 진짜
 * 줄바꿈으로 들어오기도 한다. 둘 다 받아준다.
 */
function pemToDer(pem) {
  const text = String(pem).replace(/\\n/g, "\n").replace(/^["']|["']$/g, "");
  const body = text.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  if (!body) throw new Error("비공개 키가 비어 있습니다.");
  let bin;
  try {
    bin = atob(body);
  } catch {
    throw new Error("비공개 키를 읽을 수 없습니다. PEM 전체를 넣었는지 확인하십시오.");
  }
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// access token 은 1시간짜리다. 같은 isolate 안에서는 재사용한다.
let cached = { token: null, exp: 0, key: null };

async function accessToken(env) {
  if (!isConfigured(env)) {
    throw new Error("구글 캘린더 설정이 끝나지 않았습니다 " +
                    "(GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY / GOOGLE_CALENDAR_ID).");
  }
  const now = Math.floor(Date.now() / 1000);
  if (cached.token && cached.exp - 60 > now && cached.key === env.GOOGLE_SA_EMAIL) {
    return cached.token;
  }

  let key;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8", pemToDer(env.GOOGLE_SA_PRIVATE_KEY),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch (e) {
    throw new Error("비공개 키가 올바르지 않습니다: " + (e.message || e));
  }

  const head = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify({
    iss: env.GOOGLE_SA_EMAIL,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  })));
  const sig = b64url(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${body}`)));

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: JWT_GRANT, assertion: `${head}.${body}.${sig}` }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "토큰 발급 실패");
  }
  cached = { token: data.access_token, exp: now + (data.expires_in || 3600),
             key: env.GOOGLE_SA_EMAIL };
  return cached.token;
}

const hhmmss = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`;

/**
 * 승인한 면담을 캘린더에 올린다. 만든 일정의 id 를 돌려준다.
 * 한국은 서머타임이 없어 +09:00 고정으로 충분하다.
 */
export async function createEvent(env, { date, startMin, endMin, name, studentNo,
                                         topic, phone }) {
  const body = {
    summary: `면담 — ${name} (${studentNo})`,
    description: [
      topic ? `주제: ${topic}` : null,
      phone ? `연락처: ${phone}` : null,
      "지도교수 면담신청 시스템에서 자동 등록",
    ].filter(Boolean).join("\n"),
    start: { dateTime: `${date}T${hhmmss(startMin)}+09:00`, timeZone: "Asia/Seoul" },
    end: { dateTime: `${date}T${hhmmss(endMin)}+09:00`, timeZone: "Asia/Seoul" },
  };
  const res = await fetch(eventsUrl(env), {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken(env)}`,
               "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(explain(res.status, data));
  }
  return data.id;
}

/** 승인을 취소하거나 신청을 지울 때 캘린더에서도 치운다. 실패해도 넘어간다. */
export async function deleteEvent(env, eventId) {
  if (!eventId || !isConfigured(env)) return;
  try {
    await fetch(eventsUrl(env, `/${encodeURIComponent(eventId)}`), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await accessToken(env)}` },
    });
  } catch { /* 캘린더가 안 지워져도 신청 처리는 계속한다 */ }
}

/** 설정이 맞는지 확인 — 일정을 하나 만들고 바로 지운다. */
export async function selfTest(env) {
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const id = await createEvent(env, {
    date: today, startMin: 0, endMin: 15,
    name: "연결 시험", studentNo: "-", topic: "이 일정은 바로 삭제됩니다",
  });
  await deleteEvent(env, id);
  return { calendar: env.GOOGLE_CALENDAR_ID, account: env.GOOGLE_SA_EMAIL };
}

/** 구글이 주는 오류를 무엇을 고쳐야 하는지로 바꿔 준다. */
function explain(status, data) {
  const msg = data?.error?.message || data?.error_description || `HTTP ${status}`;
  if (status === 404) {
    return `${msg} — 캘린더를 찾을 수 없습니다. GOOGLE_CALENDAR_ID 가 맞는지, ` +
           "그 캘린더를 서비스 계정 이메일에 공유했는지 확인하십시오.";
  }
  if (status === 403) {
    return `${msg} — 권한이 없습니다. 캘린더 공유 설정에서 서비스 계정에 ` +
           '"변경 권한"을 주었는지, Calendar API 를 사용 설정했는지 확인하십시오.';
  }
  return msg;
}
