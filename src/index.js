// 지도교수 면담신청 — Cloudflare Worker (API) + 정적 화면
//
// 한 Worker 가 /api/* 를 처리하고 나머지는 public/ 의 파일을 그대로 내보낸다.
// 데이터는 D1(SQLite).

import { clearCookie, cookieHeader, readCookie, sameSecret, sign, verify } from "./auth.js";
import { buildXlsx } from "./xlsx.js";
import * as g from "./google.js";

const STUDENT_COOKIE = "am_student";
const ADMIN_COOKIE = "am_admin";
const SESSION_HOURS = 12;

// ---------------------------------------------------------------- 응답 도우미
const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8",
               "Cache-Control": "no-store", ...(init.headers || {}) },
  });

const fail = (status, message) => json({ error: message }, { status });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------------------------------------------------------------- 시간 도우미
/** 'YYYY-MM-DD' (Asia/Seoul 기준). 한국은 서머타임이 없어 +9 고정으로 맞다. */
function seoulToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** 그 날짜가 속한 주의 월요일. */
function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;          // 월=0 … 일=6
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 월~금 5일. */
const weekDays = (monday) => Array.from({ length: 5 }, (_, i) => addDays(monday, i));

const hhmm = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

const cfg = (env) => ({
  schoolName: env.SCHOOL_NAME || "",
  advisorName: env.ADVISOR_NAME || "지도교수",
  dayStart: Number(env.DAY_START_MIN || 540),
  dayEnd: Number(env.DAY_END_MIN || 1080),
  slotMin: Number(env.SLOT_MIN || 15),
  timezone: env.TIMEZONE || "Asia/Seoul",
});

// ---------------------------------------------------------------- 세션
function secretOf(env) {
  if (!env.SESSION_SECRET) {
    throw new HttpError(500,
      "SESSION_SECRET 이 설정되지 않았습니다. `wrangler secret put SESSION_SECRET` 로 넣으십시오.");
  }
  return env.SESSION_SECRET;
}

const isHttps = (url) => new URL(url).protocol === "https:";

async function studentOf(req, env) {
  return verify(secretOf(env), readCookie(req, STUDENT_COOKIE));
}

async function adminOf(req, env) {
  const s = await verify(secretOf(env), readCookie(req, ADMIN_COOKIE));
  return s && s.role === "advisor" ? s : null;
}

async function needAdmin(req, env) {
  const a = await adminOf(req, env);
  if (!a) throw new HttpError(401, "교수 로그인이 필요합니다.");
  return a;
}

async function needStudent(req, env) {
  const s = await studentOf(req, env);
  if (!s) throw new HttpError(401, "학생 로그인이 필요합니다.");
  return s;
}

// ---------------------------------------------------------------- 조회
/** 한 주의 슬롯과 신청을 한 번에. */
async function weekRows(env, monday) {
  const days = weekDays(monday);
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.date, s.start_min,
            b.id AS booking_id, b.student_name, b.student_no, b.topic, b.phone,
            b.status, b.note, b.created_at, b.decided_at
       FROM slots s
       LEFT JOIN bookings b ON b.slot_id = s.id
      WHERE s.date IN (?, ?, ?, ?, ?)
      ORDER BY s.date, s.start_min`).bind(...days).all();
  return results || [];
}

// ---------------------------------------------------------------- 라우팅
async function handleApi(req, env, url) {
  const path = url.pathname;
  const method = req.method;
  const c = cfg(env);
  const body = async () => {
    try { return await req.json(); } catch { throw new HttpError(400, "잘못된 요청입니다."); }
  };

  // ---- 공통 ----
  if (path === "/api/config" && method === "GET") {
    const [student, admin] = await Promise.all([studentOf(req, env), adminOf(req, env)]);
    return json({
      ...c,
      today: seoulToday(),
      student: student ? { name: student.name, studentNo: student.studentNo } : null,
      admin: Boolean(admin),
    });
  }

  // ---- 학생 ----
  if (path === "/api/student/login" && method === "POST") {
    const { name, studentNo } = await body();
    const nm = String(name || "").trim();
    const no = String(studentNo || "").trim();
    if (nm.length < 2) throw new HttpError(400, "이름을 2자 이상 입력하십시오.");
    if (!/^[0-9A-Za-z-]{4,20}$/.test(no)) throw new HttpError(400, "학번 형식이 올바르지 않습니다.");
    const token = await sign(secretOf(env), {
      name: nm, studentNo: no, exp: Date.now() + SESSION_HOURS * 3600 * 1000,
    });
    return json({ ok: true, student: { name: nm, studentNo: no } }, {
      headers: { "Set-Cookie": cookieHeader(STUDENT_COOKIE, token,
        { maxAge: SESSION_HOURS * 3600, secure: isHttps(url) }) },
    });
  }

  if (path === "/api/student/logout" && method === "POST") {
    return json({ ok: true }, { headers: { "Set-Cookie": clearCookie(STUDENT_COOKIE) } });
  }

  // 학생이 보는 주간표 — 남의 신상은 내보내지 않는다.
  if (path === "/api/week" && method === "GET") {
    const me = await needStudent(req, env);
    const monday = mondayOf(isDate(url.searchParams.get("start"))
      ? url.searchParams.get("start") : seoulToday());
    const rows = await weekRows(env, monday);
    return json({
      monday, days: weekDays(monday),
      slots: rows.map((r) => {
        const mine = r.booking_id && r.student_no === me.studentNo;
        return {
          id: r.id, date: r.date, startMin: r.start_min,
          state: !r.booking_id ? "open" : mine ? "mine" : "taken",
          ...(mine ? {
            bookingId: r.booking_id, status: r.status, topic: r.topic,
            note: r.note,
          } : {}),
        };
      }),
    });
  }

  if (path === "/api/bookings" && method === "POST") {
    const me = await needStudent(req, env);
    const { slotId, topic, phone } = await body();
    const slot = await env.DB.prepare("SELECT id, date, start_min FROM slots WHERE id = ?")
      .bind(slotId).first();
    if (!slot) throw new HttpError(404, "없는 시간입니다.");
    if (slot.date < seoulToday()) throw new HttpError(400, "지난 날짜는 신청할 수 없습니다.");

    // 한 학생이 같은 날 여러 칸을 잡지 않도록 한 칸만 허용한다.
    const already = await env.DB.prepare(
      `SELECT b.id FROM bookings b JOIN slots s ON s.id = b.slot_id
        WHERE b.student_no = ? AND s.date = ? AND b.status != 'rejected'`)
      .bind(me.studentNo, slot.date).first();
    if (already) throw new HttpError(409, "같은 날에는 한 번만 신청할 수 있습니다.");

    try {
      const r = await env.DB.prepare(
        `INSERT INTO bookings (slot_id, student_name, student_no, topic, phone,
                               status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
        .bind(slot.id, me.name, me.studentNo, String(topic || "").slice(0, 500),
              String(phone || "").slice(0, 50), new Date().toISOString()).run();
      return json({ ok: true, id: r.meta.last_row_id });
    } catch (e) {
      // slot_id UNIQUE — 거의 동시에 둘이 눌렀을 때
      if (String(e).includes("UNIQUE")) throw new HttpError(409, "방금 다른 학생이 예약했습니다.");
      throw e;
    }
  }

  if (path === "/api/student/bookings" && method === "GET") {
    const me = await needStudent(req, env);
    const { results } = await env.DB.prepare(
      `SELECT b.id, b.status, b.topic, b.note, b.created_at, b.decided_at,
              s.date, s.start_min
         FROM bookings b JOIN slots s ON s.id = b.slot_id
        WHERE b.student_no = ?
        ORDER BY s.date DESC, s.start_min DESC`).bind(me.studentNo).all();
    return json({ bookings: (results || []).map((r) => ({
      id: r.id, status: r.status, topic: r.topic, note: r.note,
      date: r.date, startMin: r.start_min, endMin: r.start_min + c.slotMin,
      createdAt: r.created_at, decidedAt: r.decided_at,
    })) });
  }

  // 학생이 자기 신청을 취소 (승인 전까지만)
  const mCancel = path.match(/^\/api\/bookings\/(\d+)$/);
  if (mCancel && method === "DELETE") {
    const me = await needStudent(req, env);
    const row = await env.DB.prepare(
      "SELECT id, student_no, status FROM bookings WHERE id = ?").bind(mCancel[1]).first();
    if (!row || row.student_no !== me.studentNo) throw new HttpError(404, "없는 신청입니다.");
    if (row.status === "approved") {
      throw new HttpError(400, "이미 승인된 신청입니다. 교수님께 문의하십시오.");
    }
    await env.DB.prepare("DELETE FROM bookings WHERE id = ?").bind(row.id).run();
    return json({ ok: true });
  }

  // ---- 교수 ----
  if (path === "/api/admin/login" && method === "POST") {
    const { password } = await body();
    if (!env.ADVISOR_PASSWORD) {
      throw new HttpError(500,
        "ADVISOR_PASSWORD 가 설정되지 않았습니다. `wrangler secret put ADVISOR_PASSWORD` 로 넣으십시오.");
    }
    if (!(await sameSecret(String(password || ""), env.ADVISOR_PASSWORD))) {
      throw new HttpError(401, "비밀번호가 다릅니다.");
    }
    const token = await sign(secretOf(env), {
      role: "advisor", exp: Date.now() + SESSION_HOURS * 3600 * 1000,
    });
    return json({ ok: true }, {
      headers: { "Set-Cookie": cookieHeader(ADMIN_COOKIE, token,
        { maxAge: SESSION_HOURS * 3600, secure: isHttps(url) }) },
    });
  }

  if (path === "/api/admin/logout" && method === "POST") {
    return json({ ok: true }, { headers: { "Set-Cookie": clearCookie(ADMIN_COOKIE) } });
  }

  if (path === "/api/admin/status" && method === "GET") {
    await needAdmin(req, env);
    return json({
      google: {
        configured: g.isConfigured(env),
        linked: await g.isLinked(env),
        account: await g.linkedAccount(env),
        redirectUri: g.redirectUri(url),
      },
      counts: await env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM slots) AS slots,
           (SELECT COUNT(*) FROM bookings) AS bookings,
           (SELECT COUNT(*) FROM bookings WHERE status='pending') AS pending`).first(),
    });
  }

  if (path === "/api/admin/week" && method === "GET") {
    await needAdmin(req, env);
    const monday = mondayOf(isDate(url.searchParams.get("start"))
      ? url.searchParams.get("start") : seoulToday());
    const rows = await weekRows(env, monday);
    return json({
      monday, days: weekDays(monday),
      slots: rows.map((r) => ({
        id: r.id, date: r.date, startMin: r.start_min,
        booking: r.booking_id ? {
          id: r.booking_id, name: r.student_name, studentNo: r.student_no,
          topic: r.topic, phone: r.phone, status: r.status, note: r.note,
          createdAt: r.created_at, decidedAt: r.decided_at,
        } : null,
      })),
    });
  }

  // 주간 시간표 저장 — 그 주의 열린 칸을 보낸 목록과 똑같이 맞춘다.
  if (path === "/api/admin/week" && method === "PUT") {
    await needAdmin(req, env);
    const { monday: mondayIn, slots } = await body();
    if (!isDate(mondayIn)) throw new HttpError(400, "주 시작 날짜가 잘못됐습니다.");
    const monday = mondayOf(mondayIn);
    const days = new Set(weekDays(monday));
    const step = c.slotMin;

    const want = new Set();
    for (const s of Array.isArray(slots) ? slots : []) {
      if (!days.has(s.date)) throw new HttpError(400, "이번 주가 아닌 날짜가 있습니다.");
      const m = Number(s.startMin);
      if (!Number.isInteger(m) || m < c.dayStart || m >= c.dayEnd || m % step !== 0) {
        throw new HttpError(400, "시간 칸이 잘못됐습니다.");
      }
      want.add(`${s.date}|${m}`);
    }

    const existing = await weekRows(env, monday);
    const stmts = [];
    const now = new Date().toISOString();
    const keep = new Set();
    const blocked = [];

    for (const r of existing) {
      const key = `${r.date}|${r.start_min}`;
      keep.add(key);
      if (!want.has(key)) {
        if (r.booking_id) {
          // 신청이 걸린 칸은 말없이 지우지 않는다. 먼저 신청을 처리해야 한다.
          blocked.push(`${r.date} ${hhmm(r.start_min)} (${r.student_name})`);
          continue;
        }
        stmts.push(env.DB.prepare("DELETE FROM slots WHERE id = ?").bind(r.id));
      }
    }
    for (const key of want) {
      if (keep.has(key)) continue;
      const [date, m] = key.split("|");
      stmts.push(env.DB.prepare(
        "INSERT OR IGNORE INTO slots (date, start_min, created_at) VALUES (?, ?, ?)")
        .bind(date, Number(m), now));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, changed: stmts.length, blocked });
  }

  // 지난 주 패턴을 이번 주로 복사
  if (path === "/api/admin/week/copy" && method === "POST") {
    await needAdmin(req, env);
    const { from, to } = await body();
    if (!isDate(from) || !isDate(to)) throw new HttpError(400, "날짜가 잘못됐습니다.");
    const src = mondayOf(from), dst = mondayOf(to);
    const rows = await weekRows(env, src);
    const now = new Date().toISOString();
    const stmts = rows.map((r) => {
      const offset = weekDays(src).indexOf(r.date);
      return env.DB.prepare(
        "INSERT OR IGNORE INTO slots (date, start_min, created_at) VALUES (?, ?, ?)")
        .bind(addDays(dst, offset), r.start_min, now);
    });
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, copied: stmts.length });
  }

  if (path === "/api/admin/bookings" && method === "GET") {
    await needAdmin(req, env);
    const status = url.searchParams.get("status");
    const where = status && status !== "all" ? "WHERE b.status = ?" : "";
    const stmt = env.DB.prepare(
      `SELECT b.*, s.date, s.start_min FROM bookings b JOIN slots s ON s.id = b.slot_id
       ${where} ORDER BY s.date DESC, s.start_min DESC`);
    const { results } = await (where ? stmt.bind(status) : stmt).all();
    return json({ bookings: (results || []).map((r) => ({
      id: r.id, name: r.student_name, studentNo: r.student_no, topic: r.topic,
      phone: r.phone, status: r.status, note: r.note, date: r.date,
      startMin: r.start_min, endMin: r.start_min + c.slotMin,
      createdAt: r.created_at, decidedAt: r.decided_at,
      calendar: Boolean(r.gcal_event_id),
    })) });
  }

  const mDecide = path.match(/^\/api\/admin\/bookings\/(\d+)\/decide$/);
  if (mDecide && method === "POST") {
    await needAdmin(req, env);
    const { status, note } = await body();
    if (!["approved", "rejected", "pending"].includes(status)) {
      throw new HttpError(400, "상태값이 잘못됐습니다.");
    }
    const row = await env.DB.prepare(
      `SELECT b.*, s.date, s.start_min FROM bookings b JOIN slots s ON s.id = b.slot_id
        WHERE b.id = ?`).bind(mDecide[1]).first();
    if (!row) throw new HttpError(404, "없는 신청입니다.");

    let eventId = row.gcal_event_id;
    let calendarError = null;

    if (status === "approved" && !eventId && await g.isLinked(env)) {
      try {
        eventId = await g.createEvent(env, {
          date: row.date, startMin: row.start_min, endMin: row.start_min + c.slotMin,
          name: row.student_name, studentNo: row.student_no,
          topic: row.topic, phone: row.phone,
        });
      } catch (e) {
        // 캘린더가 실패해도 승인 자체는 살린다. 대신 사실대로 알려준다.
        calendarError = String(e.message || e);
      }
    }
    if (status !== "approved" && eventId) {
      await g.deleteEvent(env, eventId);
      eventId = null;
    }

    await env.DB.prepare(
      `UPDATE bookings SET status = ?, note = ?, decided_at = ?, gcal_event_id = ?
        WHERE id = ?`)
      .bind(status, String(note || "").slice(0, 500),
            status === "pending" ? null : new Date().toISOString(),
            eventId, row.id).run();
    return json({ ok: true, calendar: Boolean(eventId), calendarError });
  }

  const mDel = path.match(/^\/api\/admin\/bookings\/(\d+)$/);
  if (mDel && method === "DELETE") {
    await needAdmin(req, env);
    const row = await env.DB.prepare("SELECT id, gcal_event_id FROM bookings WHERE id = ?")
      .bind(mDel[1]).first();
    if (!row) throw new HttpError(404, "없는 신청입니다.");
    await g.deleteEvent(env, row.gcal_event_id);
    await env.DB.prepare("DELETE FROM bookings WHERE id = ?").bind(row.id).run();
    return json({ ok: true });
  }

  // 일괄 삭제 — 되돌릴 수 없으므로 confirm 문구를 그대로 받아야 지운다.
  if (path === "/api/admin/purge" && method === "POST") {
    await needAdmin(req, env);
    const { scope, before, confirm } = await body();
    if (confirm !== "삭제") throw new HttpError(400, "확인 문구가 맞지 않습니다.");
    let n = 0;
    if (scope === "before" && isDate(before)) {
      const r = await env.DB.prepare(
        `DELETE FROM bookings WHERE slot_id IN (SELECT id FROM slots WHERE date < ?)`)
        .bind(before).run();
      await env.DB.prepare("DELETE FROM slots WHERE date < ?").bind(before).run();
      n = r.meta.changes;
    } else if (scope === "bookings") {
      n = (await env.DB.prepare("DELETE FROM bookings").run()).meta.changes;
    } else if (scope === "all") {
      n = (await env.DB.prepare("DELETE FROM bookings").run()).meta.changes;
      await env.DB.prepare("DELETE FROM slots").run();
    } else {
      throw new HttpError(400, "삭제 범위가 잘못됐습니다.");
    }
    return json({ ok: true, deleted: n });
  }

  // ---- 엑셀 내보내기 ----
  if (path === "/api/admin/export.xlsx" && method === "GET") {
    await needAdmin(req, env);
    const { results } = await env.DB.prepare(
      `SELECT b.*, s.date, s.start_min FROM bookings b JOIN slots s ON s.id = b.slot_id
        ORDER BY s.date, s.start_min`).all();
    const label = { pending: "대기", approved: "승인", rejected: "거절" };
    const rows = [[
      "날짜", "요일", "시작", "종료", "이름", "학번", "주제", "연락처",
      "상태", "메모", "신청일시", "처리일시", "캘린더등록",
    ]];
    const dow = ["일", "월", "화", "수", "목", "금", "토"];
    for (const r of results || []) {
      rows.push([
        r.date, dow[new Date(`${r.date}T00:00:00Z`).getUTCDay()],
        hhmm(r.start_min), hhmm(r.start_min + c.slotMin),
        r.student_name, r.student_no, r.topic || "", r.phone || "",
        label[r.status] || r.status, r.note || "",
        r.created_at || "", r.decided_at || "", r.gcal_event_id ? "O" : "",
      ]);
    }
    const bytes = buildXlsx(rows, "면담신청");
    const name = `면담신청_${seoulToday()}.xlsx`;
    return new Response(bytes, {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition":
          `attachment; filename="meetings.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Cache-Control": "no-store",
      },
    });
  }

  // ---- 구글 캘린더 ----
  if (path === "/api/admin/google/start" && method === "GET") {
    await needAdmin(req, env);
    if (!g.isConfigured(env)) {
      throw new HttpError(400,
        "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 이 설정되지 않았습니다.");
    }
    const state = await sign(secretOf(env), { g: 1, exp: Date.now() + 10 * 60 * 1000 });
    return Response.redirect(g.authUrl(env, url, state), 302);
  }

  if (path === "/api/admin/google/callback" && method === "GET") {
    await needAdmin(req, env);
    const state = await verify(secretOf(env), url.searchParams.get("state"));
    if (!state || !state.g) throw new HttpError(400, "요청이 만료됐습니다. 다시 시도하십시오.");
    const code = url.searchParams.get("code");
    if (!code) throw new HttpError(400, url.searchParams.get("error") || "동의가 취소됐습니다.");
    await g.exchangeCode(env, url, code);
    return Response.redirect(`${url.origin}/#admin/settings`, 302);
  }

  if (path === "/api/admin/google/unlink" && method === "POST") {
    await needAdmin(req, env);
    await g.unlink(env);
    return json({ ok: true });
  }

  return fail(404, "없는 API 입니다.");
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(req);               // 정적 화면
    }
    try {
      return await handleApi(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.message);
      console.error(e);
      return fail(500, "서버 오류가 났습니다.");
    }
  },
};
