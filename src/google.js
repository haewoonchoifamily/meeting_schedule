// 구글 캘린더 연동 — 승인한 면담을 교수 캘린더에 자동으로 올린다.
//
// 교수가 한 번 구글 로그인에 동의하면 refresh token 을 받아 D1 에 넣어 두고,
// 그 뒤로는 그걸로 access token 을 새로 발급받아 쓴다. 학생은 구글 계정이 필요 없다.
//
// 필요한 것 (없으면 연동 기능만 꺼지고 나머지는 그대로 돈다)
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   secret 으로 넣는다
//   구글 클라우드 콘솔의 승인된 리디렉션 URI 에 아래를 등록
//      https://<배포주소>/api/admin/google/callback

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CAL_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const SCOPE = "https://www.googleapis.com/auth/calendar.events";

const RT_KEY = "google_refresh_token";
const EMAIL_KEY = "google_account";

export const isConfigured = (env) =>
  Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

export async function getSetting(env, key) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key).first();
  return row ? row.value : null;
}

export async function putSetting(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

export async function delSetting(env, key) {
  await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
}

export const isLinked = async (env) => Boolean(await getSetting(env, RT_KEY));
export const linkedAccount = (env) => getSetting(env, EMAIL_KEY);

export function redirectUri(url) {
  return `${new URL(url).origin}/api/admin/google/callback`;
}

export function authUrl(env, url, state) {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(url),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",      // refresh token 을 받으려면 필요
    prompt: "consent",           // 이미 동의했어도 refresh token 을 다시 준다
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${p}`;
}

/** 동의 후 받은 code 를 refresh token 으로 바꿔 저장한다. */
export async function exchangeCode(env, url, code) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(url),
      grant_type: "authorization_code",
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) {
    throw new Error(data.error_description || data.error ||
                    "refresh token 을 받지 못했습니다");
  }
  await putSetting(env, RT_KEY, data.refresh_token);
  // 어떤 계정에 붙었는지 화면에 보여주려고 id_token 에서 이메일만 꺼낸다.
  try {
    const claims = JSON.parse(atob(data.id_token.split(".")[1]
      .replace(/-/g, "+").replace(/_/g, "/")));
    if (claims.email) await putSetting(env, EMAIL_KEY, claims.email);
  } catch { /* 없으면 없는 대로 */ }
}

export async function unlink(env) {
  await delSetting(env, RT_KEY);
  await delSetting(env, EMAIL_KEY);
}

async function accessToken(env) {
  const refresh = await getSetting(env, RT_KEY);
  if (!refresh) throw new Error("구글 계정이 연결돼 있지 않습니다");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refresh,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    // 교수가 구글에서 권한을 끊으면 여기로 온다. 끊긴 토큰은 버린다.
    if (data.error === "invalid_grant") await unlink(env);
    throw new Error(data.error_description || data.error || "토큰 갱신 실패");
  }
  return data.access_token;
}

/**
 * 승인한 면담을 캘린더에 올린다. 만든 일정의 id 를 돌려준다.
 * 한국은 서머타임이 없어 +09:00 고정으로 충분하다.
 */
export async function createEvent(env, { date, startMin, endMin, name, studentNo,
                                         topic, phone }) {
  const hhmm = (m) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`;
  const body = {
    summary: `면담 — ${name} (${studentNo})`,
    description: [
      topic ? `주제: ${topic}` : null,
      phone ? `연락처: ${phone}` : null,
      "지도교수 면담신청 시스템에서 자동 등록",
    ].filter(Boolean).join("\n"),
    start: { dateTime: `${date}T${hhmm(startMin)}+09:00`, timeZone: "Asia/Seoul" },
    end: { dateTime: `${date}T${hhmm(endMin)}+09:00`, timeZone: "Asia/Seoul" },
  };
  const res = await fetch(CAL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await accessToken(env)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || "캘린더 등록 실패");
  }
  return data.id;
}

/** 승인을 취소하거나 신청을 지울 때 캘린더에서도 치운다. 실패해도 조용히 넘긴다. */
export async function deleteEvent(env, eventId) {
  if (!eventId) return;
  try {
    await fetch(`${CAL_URL}/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await accessToken(env)}` },
    });
  } catch { /* 캘린더가 안 지워져도 신청 처리는 계속한다 */ }
}
