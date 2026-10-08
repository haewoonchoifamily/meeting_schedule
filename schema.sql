-- 지도교수 면담신청 — D1 스키마
--
--   wrangler d1 execute advisor-meeting --local  --file=./schema.sql
--   wrangler d1 execute advisor-meeting --remote --file=./schema.sql

PRAGMA foreign_keys = ON;

-- 교수가 연 면담 가능 시간. 한 줄이 15분짜리 한 칸이다.
-- 주간 반복이 아니라 실제 날짜로 저장한다. 공휴일·출장 주간을 그냥 비우면 되고,
-- "이 주에 몇 시에 열었나" 를 나중에 그대로 돌아볼 수 있다.
CREATE TABLE IF NOT EXISTS slots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT    NOT NULL,          -- 'YYYY-MM-DD' (Asia/Seoul 기준 날짜)
  start_min  INTEGER NOT NULL,          -- 자정부터 분 (09:00 = 540)
  created_at TEXT    NOT NULL,
  UNIQUE (date, start_min)
);

CREATE INDEX IF NOT EXISTS idx_slots_date ON slots(date);

-- 학생 신청. 한 칸에 한 명만 받는다(UNIQUE slot_id).
CREATE TABLE IF NOT EXISTS bookings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id       INTEGER NOT NULL UNIQUE REFERENCES slots(id) ON DELETE CASCADE,
  student_name  TEXT    NOT NULL,
  student_no    TEXT    NOT NULL,
  topic         TEXT,                   -- 면담 주제
  phone         TEXT,
  status        TEXT    NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  note          TEXT,                   -- 교수 메모 / 거절 사유
  created_at    TEXT    NOT NULL,
  decided_at    TEXT,
  gcal_event_id TEXT                    -- 구글 캘린더에 만든 일정 id
);

CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_student ON bookings(student_no);

-- 키-값 보관함. 구글 refresh token 등.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
