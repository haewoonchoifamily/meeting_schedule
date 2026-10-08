"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const DOW = ["월", "화", "수", "목", "금"];

let CFG = null;
let sMonday = null, aMonday = null;
let aSlots = [];           // 교수 화면: 서버가 준 이번 주 슬롯
let aPicked = new Set();   // 'YYYY-MM-DD|540'
let pendingSlot = null;

// ------------------------------------------------------------------ 통신
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 본문이 없을 수도 있다 */ }
  if (!res.ok) throw new Error((data && data.error) || `오류 ${res.status}`);
  return data;
}

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

// ------------------------------------------------------------------ 날짜
const hhmm = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function addDays(d, n) {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

function mondayOf(d) {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}

const md = (d) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`;
const rangeLabel = (mon) => `${d2(mon)} ~ ${d2(addDays(mon, 4))}`;
const d2 = (d) => `${d.slice(0, 4)}.${d.slice(5, 7)}.${d.slice(8, 10)}`;
const times = () => {
  const out = [];
  for (let m = CFG.dayStart; m < CFG.dayEnd; m += CFG.slotMin) out.push(m);
  return out;
};

// ------------------------------------------------------------------ 격자 뼈대
function gridSkeleton(el, days, extraClass = "") {
  el.innerHTML = "";
  el.append(cellEl("hd", ""));
  days.forEach((d, i) => {
    const h = cellEl("hd", `${DOW[i]}\n${md(d)}`);
    h.style.whiteSpace = "pre-line";
    if (d === CFG.today) h.classList.add("today");
    el.append(h);
  });
  for (const m of times()) {
    el.append(cellEl("tm", m % 60 === 0 ? hhmm(m) : ""));
    for (const d of days) {
      const c = cellEl(`cell ${extraClass}`, "");
      c.dataset.key = `${d}|${m}`;
      c.dataset.date = d;
      c.dataset.min = m;
      c.title = `${md(d)} ${hhmm(m)}`;
      el.append(c);
    }
  }
}

function cellEl(cls, text) {
  const e = document.createElement("div");
  e.className = cls;
  e.textContent = text;
  return e;
}

// ================================================================== 학생
async function loadStudentWeek() {
  const data = await api(`/api/week?start=${sMonday}`);
  sMonday = data.monday;
  $("#s-range").textContent = rangeLabel(sMonday);
  const el = $("#s-grid");
  gridSkeleton(el, data.days);

  const byKey = new Map(data.slots.map((s) => [`${s.date}|${s.startMin}`, s]));
  for (const c of el.querySelectorAll(".cell")) {
    const s = byKey.get(c.dataset.key);
    if (!s) continue;
    if (c.dataset.date < CFG.today) { c.classList.add("past", "taken"); continue; }
    if (s.state === "open") {
      c.classList.add("open");
      c.onclick = () => openModal(s);
    } else if (s.state === "mine") {
      c.classList.add("mine");
      c.title += ` — 내 신청 (${statusKo(s.status)})`;
    } else {
      c.classList.add("taken");
      c.title += " — 마감";
    }
  }
}

const statusKo = (s) =>
  ({ pending: "대기", approved: "승인", rejected: "거절" }[s] || s);

function openModal(slot) {
  pendingSlot = slot;
  $("#m-when").textContent =
    `${d2(slot.date)} (${DOW[new Date(`${slot.date}T00:00:00Z`).getUTCDay() - 1] || ""}) ` +
    `${hhmm(slot.startMin)} ~ ${hhmm(slot.startMin + CFG.slotMin)}`;
  $("#m-topic").value = "";
  $("#m-phone").value = "";
  $("#m-err").hidden = true;
  $("#modal").hidden = false;
  $("#m-topic").focus();
}

async function submitBooking() {
  if (!pendingSlot) return;
  $("#m-ok").disabled = true;
  try {
    await api("/api/bookings", { method: "POST", body: {
      slotId: pendingSlot.id, topic: $("#m-topic").value, phone: $("#m-phone").value,
    } });
    $("#modal").hidden = true;
    toast("신청했습니다. 승인을 기다려 주십시오.");
    await Promise.all([loadStudentWeek(), loadMyBookings()]);
  } catch (e) {
    const p = $("#m-err"); p.textContent = e.message; p.hidden = false;
  } finally {
    $("#m-ok").disabled = false;
  }
}

async function loadMyBookings() {
  const { bookings } = await api("/api/student/bookings");
  const el = $("#s-list");
  if (!bookings.length) {
    el.innerHTML = '<div class="empty">아직 신청한 면담이 없습니다.</div>';
    return;
  }
  el.innerHTML = "";
  for (const b of bookings) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="info">
         <div class="when">${d2(b.date)} ${hhmm(b.startMin)} ~ ${hhmm(b.endMin)}</div>
         <div class="sub">${b.topic ? esc(b.topic) : "<i>주제 없음</i>"}</div>
         ${b.note ? `<div class="sub">교수 메모: ${esc(b.note)}</div>` : ""}
       </div>
       <div class="actions" style="margin:0">
         <span class="pill ${b.status}">${statusKo(b.status)}</span>
       </div>`;
    if (b.status !== "approved") {
      const btn = document.createElement("button");
      btn.className = "link";
      btn.textContent = "취소";
      btn.onclick = async () => {
        if (!confirm("이 신청을 취소할까요?")) return;
        await api(`/api/bookings/${b.id}`, { method: "DELETE" });
        toast("취소했습니다.");
        await Promise.all([loadStudentWeek(), loadMyBookings()]);
      };
      row.querySelector(".actions").append(btn);
    }
    el.append(row);
  }
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ================================================================== 교수
async function loadAdminWeek() {
  const data = await api(`/api/admin/week?start=${aMonday}`);
  aMonday = data.monday;
  aSlots = data.slots;
  aPicked = new Set(aSlots.map((s) => `${s.date}|${s.startMin}`));
  $("#a-range").textContent = rangeLabel(aMonday);
  gridSkeleton($("#a-grid"), data.days, "");
  paintAdmin();
}

function paintAdmin() {
  const booked = new Map(aSlots.filter((s) => s.booking)
    .map((s) => [`${s.date}|${s.startMin}`, s.booking]));
  for (const c of $("#a-grid").querySelectorAll(".cell")) {
    const key = c.dataset.key;
    const b = booked.get(key);
    c.className = "cell";
    if (b) {
      c.classList.add(b.status === "approved" ? "appr"
        : b.status === "pending" ? "pend" : "open");
      c.title = `${md(c.dataset.date)} ${hhmm(+c.dataset.min)} — ` +
                `${b.name} (${b.studentNo}) ${statusKo(b.status)}`;
      c.dataset.locked = "1";
    } else {
      delete c.dataset.locked;
      c.title = `${md(c.dataset.date)} ${hhmm(+c.dataset.min)}`;
      if (aPicked.has(key)) c.classList.add("open");
    }
  }
}

function wireAdminGrid() {
  const el = $("#a-grid");
  let painting = false, mode = true;
  const apply = (c) => {
    if (!c || !c.classList.contains("cell") || c.dataset.locked) return;
    const key = c.dataset.key;
    if (mode) aPicked.add(key); else aPicked.delete(key);
    c.classList.toggle("open", mode);
  };
  el.addEventListener("pointerdown", (e) => {
    const c = e.target.closest(".cell");
    if (!c || c.dataset.locked) return;
    painting = true;
    mode = !aPicked.has(c.dataset.key);
    apply(c);
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    if (!painting) return;
    apply(document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".cell"));
  });
  const stop = () => { painting = false; };
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointercancel", stop);
}

async function saveWeek() {
  const slots = [...aPicked].map((k) => {
    const [date, m] = k.split("|");
    return { date, startMin: Number(m) };
  });
  $("#a-save").disabled = true;
  try {
    const r = await api("/api/admin/week",
      { method: "PUT", body: { monday: aMonday, slots } });
    $("#a-save-msg").textContent = `저장했습니다 (${r.changed}칸 변경)`;
    if (r.blocked && r.blocked.length) {
      alert("신청이 걸려 있어 지우지 못한 칸이 있습니다:\n\n" + r.blocked.join("\n") +
            "\n\n먼저 신청 목록에서 처리하십시오.");
    }
    await loadAdminWeek();
  } catch (e) {
    $("#a-save-msg").textContent = e.message;
  } finally {
    $("#a-save").disabled = false;
    setTimeout(() => { $("#a-save-msg").textContent = ""; }, 4000);
  }
}

async function loadAdminList() {
  const status = $("#a-filter").value;
  const { bookings } = await api(`/api/admin/bookings?status=${status}`);
  const el = $("#a-list");
  if (!bookings.length) {
    el.innerHTML = '<div class="empty">해당하는 신청이 없습니다.</div>';
    return;
  }
  el.innerHTML = "";
  for (const b of bookings) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="info">
         <div class="when">${d2(b.date)} ${hhmm(b.startMin)} ~ ${hhmm(b.endMin)}
           <span class="pill ${b.status}">${statusKo(b.status)}</span>
           ${b.calendar ? '<span class="pill">캘린더 등록됨</span>' : ""}</div>
         <div class="sub"><b>${esc(b.name)}</b> (${esc(b.studentNo)})
           ${b.phone ? " · " + esc(b.phone) : ""}</div>
         <div class="sub">${b.topic ? esc(b.topic) : "<i>주제 없음</i>"}</div>
         ${b.note ? `<div class="sub">메모: ${esc(b.note)}</div>` : ""}
       </div>`;
    const acts = document.createElement("div");
    acts.className = "actions";
    acts.style.margin = "0";

    const mk = (label, cls, fn) => {
      const x = document.createElement("button");
      x.textContent = label; if (cls) x.className = cls; x.onclick = fn;
      return x;
    };
    if (b.status !== "approved") {
      acts.append(mk("승인", "primary", () => decide(b, "approved")));
    }
    if (b.status !== "rejected") {
      acts.append(mk("거절", "", () => decide(b, "rejected", true)));
    }
    if (b.status !== "pending") {
      acts.append(mk("대기로", "link", () => decide(b, "pending")));
    }
    acts.append(mk("삭제", "link", async () => {
      if (!confirm(`${b.name} 학생의 신청을 삭제할까요?`)) return;
      await api(`/api/admin/bookings/${b.id}`, { method: "DELETE" });
      toast("삭제했습니다."); refreshAdmin();
    }));
    row.append(acts);
    el.append(row);
  }
}

async function decide(b, status, askNote = false) {
  let note = b.note || "";
  if (askNote) {
    const v = prompt("거절 사유를 적으십시오 (학생에게 보입니다). 비워도 됩니다.", note);
    if (v === null) return;
    note = v;
  }
  const r = await api(`/api/admin/bookings/${b.id}/decide`,
    { method: "POST", body: { status, note } });
  if (r.calendarError) {
    alert(`승인은 됐지만 캘린더 등록에 실패했습니다:\n${r.calendarError}`);
  } else {
    toast(status === "approved"
      ? (r.calendar ? "승인하고 캘린더에 올렸습니다." : "승인했습니다.")
      : "처리했습니다.");
  }
  refreshAdmin();
}

async function loadAdminStatus() {
  const s = await api("/api/admin/status");
  const el = $("#a-google");
  const g = s.google;
  if (!g.configured) {
    el.innerHTML =
      `<p class="muted small">구글 연동이 설정돼 있지 않습니다. 배포 후 아래를 실행하십시오.</p>
       <pre class="muted small">wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET</pre>
       <p class="muted small">구글 클라우드 콘솔의 승인된 리디렉션 URI:<br>
       <code>${esc(g.redirectUri)}</code></p>`;
  } else if (g.linked) {
    el.innerHTML =
      `<p>연결됨 ${g.account ? `— <b>${esc(g.account)}</b>` : ""}</p>
       <p class="muted small">승인할 때마다 이 계정의 캘린더에 면담 일정이 올라갑니다.</p>`;
    const b = document.createElement("button");
    b.textContent = "연결 끊기";
    b.onclick = async () => {
      if (!confirm("구글 캘린더 연결을 끊을까요?")) return;
      await api("/api/admin/google/unlink", { method: "POST" });
      loadAdminStatus();
    };
    el.append(b);
  } else {
    el.innerHTML = `<p class="muted small">아직 연결되지 않았습니다.</p>
      <a class="btn primary" href="/api/admin/google/start">구글 계정 연결</a>`;
  }
  $("#a-counts").textContent =
    `시간표 ${s.counts.slots}칸 · 신청 ${s.counts.bookings}건 · 대기 ${s.counts.pending}건`;
  const badge = $("#a-badge");
  badge.textContent = s.counts.pending;
  badge.hidden = !s.counts.pending;
}

function refreshAdmin() {
  loadAdminWeek().catch(() => {});
  loadAdminList().catch(() => {});
  loadAdminStatus().catch(() => {});
}

async function purge() {
  const scope = $("#a-purge-scope").value;
  const before = $("#a-purge-date").value;
  if (scope === "before" && !before) { alert("기준 날짜를 고르십시오."); return; }
  const what = { before: `${before} 이전 기록`, bookings: "신청 내역 전부",
                 all: "신청과 시간표 전부" }[scope];
  if (!confirm(`${what}을(를) 지웁니다. 되돌릴 수 없습니다. 계속할까요?`)) return;
  const typed = prompt('확인을 위해 "삭제" 라고 입력하십시오.');
  if (typed === null) return;
  try {
    const r = await api("/api/admin/purge",
      { method: "POST", body: { scope, before, confirm: typed } });
    toast(`${r.deleted}건 삭제했습니다.`);
    refreshAdmin();
  } catch (e) { alert(e.message); }
}

// ================================================================== 화면 전환
function showRole(role) {
  $$("#roletabs button").forEach((b) => b.classList.toggle("on", b.dataset.role === role));
  $("#v-student").hidden = role !== "student";
  $("#v-admin").hidden = role !== "admin";
  const want = role === "admin" ? "#admin" : "#student";
  if (!location.hash.startsWith(want)) location.hash = want;
}

function showAdminTab(tab) {
  $$("#admintabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $("#t-time").hidden = tab !== "time";
  $("#t-list").hidden = tab !== "list";
  $("#t-set").hidden = tab !== "set";
  // 목록을 열 때 대기 건수(배지)도 같이 다시 센다. 안 그러면 로그인 직후 숫자가
  // 그대로 굳어서, 그 사이 들어온 신청이 배지에 안 보인다.
  if (tab === "list") {
    loadAdminList().catch((e) => toast(e.message));
    loadAdminStatus().catch(() => {});
  }
  if (tab === "set") loadAdminStatus().catch((e) => toast(e.message));
}

function setStudentLogged(student) {
  $("#student-login").hidden = Boolean(student);
  $("#student-main").hidden = !student;
  if (student) {
    $("#s-who").textContent = `${student.name} (${student.studentNo})`;
    loadStudentWeek().catch((e) => toast(e.message));
    loadMyBookings().catch((e) => toast(e.message));
  }
}

function setAdminLogged(on) {
  $("#admin-login").hidden = on;
  $("#admin-main").hidden = !on;
  if (on) refreshAdmin();
}

// ================================================================== 시작
async function boot() {
  CFG = await api("/api/config");
  $("#title").textContent =
    `${CFG.schoolName ? CFG.schoolName + " " : ""}지도교수 면담신청`;
  document.title = $("#title").textContent;
  sMonday = aMonday = mondayOf(CFG.today);
  $("#a-purge-date").value = CFG.today;

  setStudentLogged(CFG.student);
  setAdminLogged(CFG.admin);
  showRole(location.hash.startsWith("#admin") ? "admin" : "student");
  if (location.hash === "#admin/settings" && CFG.admin) showAdminTab("set");

  // 역할 탭. 주소창의 #admin / #student 로도 바뀌어야 한다 — 뒤로가기나
  // 북마크로 들어올 때 해시만 바뀌면 페이지가 다시 로드되지 않기 때문이다.
  $$("#roletabs button").forEach((b) => { b.onclick = () => showRole(b.dataset.role); });
  window.addEventListener("hashchange", () => {
    showRole(location.hash.startsWith("#admin") ? "admin" : "student");
    if (location.hash === "#admin/settings" && !$("#admin-main").hidden) showAdminTab("set");
  });
  $$("#admintabs button").forEach((b) => { b.onclick = () => showAdminTab(b.dataset.tab); });

  // 학생
  $("#s-login").onclick = async () => {
    const err = $("#s-login-err"); err.hidden = true;
    try {
      const r = await api("/api/student/login", { method: "POST", body: {
        name: $("#s-name").value, studentNo: $("#s-no").value } });
      setStudentLogged(r.student);
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  };
  $("#s-no").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#s-login").click(); });
  $("#s-logout").onclick = async () => {
    await api("/api/student/logout", { method: "POST" });
    setStudentLogged(null);
  };
  $("#s-prev").onclick = () => { sMonday = addDays(sMonday, -7); loadStudentWeek(); };
  $("#s-next").onclick = () => { sMonday = addDays(sMonday, 7); loadStudentWeek(); };
  $("#s-this").onclick = () => { sMonday = mondayOf(CFG.today); loadStudentWeek(); };

  // 모달
  $("#m-cancel").onclick = () => { $("#modal").hidden = true; };
  $("#m-ok").onclick = submitBooking;
  $("#modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") $("#modal").hidden = true;
  });

  // 교수
  $("#a-login").onclick = async () => {
    const err = $("#a-login-err"); err.hidden = true;
    try {
      await api("/api/admin/login", { method: "POST", body: { password: $("#a-pw").value } });
      $("#a-pw").value = "";
      setAdminLogged(true);
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  };
  $("#a-pw").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#a-login").click(); });
  $("#a-logout").onclick = async () => {
    await api("/api/admin/logout", { method: "POST" });
    setAdminLogged(false);
  };
  $("#a-prev").onclick = () => { aMonday = addDays(aMonday, -7); loadAdminWeek(); };
  $("#a-next").onclick = () => { aMonday = addDays(aMonday, 7); loadAdminWeek(); };
  $("#a-this").onclick = () => { aMonday = mondayOf(CFG.today); loadAdminWeek(); };
  $("#a-save").onclick = saveWeek;
  $("#a-clear").onclick = () => {
    aPicked = new Set(aSlots.filter((s) => s.booking)
      .map((s) => `${s.date}|${s.startMin}`));
    paintAdmin();
  };
  $("#a-copy").onclick = async () => {
    await api("/api/admin/week/copy",
      { method: "POST", body: { from: addDays(aMonday, -7), to: aMonday } });
    toast("지난 주 시간표를 복사했습니다.");
    loadAdminWeek();
  };
  $("#a-filter").onchange = loadAdminList;
  $("#a-purge").onclick = purge;
  wireAdminGrid();
}

boot().catch((e) => {
  document.body.innerHTML =
    `<div class="wrap"><div class="card"><h2>시작할 수 없습니다</h2>
     <p class="err">${esc(e.message)}</p></div></div>`;
});
