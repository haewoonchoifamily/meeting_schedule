// 세션 쿠키 — HMAC-SHA256 으로 서명한 JSON.
//
// Worker 는 상태를 들고 있지 않으므로 세션을 서버에 저장하지 않는다. 대신 내용에
// 서명을 붙여 쿠키로 주고, 받을 때 서명을 확인한다. 위조는 막지만 내용 자체는
// 누구나 읽을 수 있으므로 비밀은 넣지 않는다.

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const unb64url = (s) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function key(secret) {
  return crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" },
    false, ["sign", "verify"]);
}

export async function sign(secret, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign("HMAC", await key(secret), enc.encode(body));
  return `${body}.${b64url(mac)}`;
}

export async function verify(secret, token) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  let ok;
  try {
    ok = await crypto.subtle.verify("HMAC", await key(secret),
                                    unb64url(token.slice(dot + 1)), enc.encode(body));
  } catch { return null; }
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(dec.decode(unb64url(body))); } catch { return null; }
  if (payload.exp && Date.now() > payload.exp) return null;   // 만료
  return payload;
}

/** 비밀번호 비교 — 길이·내용이 같은지를 상수 시간에 가깝게 본다. */
export async function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function readCookie(req, name) {
  const raw = req.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export function cookieHeader(name, value, { maxAge = 60 * 60 * 12, secure = true } = {}) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`,
  ];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

export const clearCookie = (name) =>
  `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
