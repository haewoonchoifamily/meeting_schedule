// 아주 작은 .xlsx 작성기 — 의존성 없이 진짜 엑셀 파일을 만든다.
//
// .xlsx 는 XML 몇 장을 담은 ZIP 이다. 여기서는 압축하지 않고(stored) 담기만 하므로
// ZIP 구현이 CRC32 + 헤더 몇 개로 끝난다. 수백~수천 행 규모에서는 이걸로 충분하고,
// SheetJS 같은 라이브러리를 Worker 에 올리지 않아도 된다.
//
// 값은 전부 inlineStr(문자열)로 넣는다. 공유 문자열 테이블이 없어 코드가 짧고,
// 학번처럼 앞자리 0 이 중요한 값이 숫자로 바뀌어 깨지는 일도 없다.

const enc = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  // 엑셀이 거부하는 제어문자는 털어낸다
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

/** 0 -> A, 25 -> Z, 26 -> AA */
function colName(i) {
  let s = "";
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) {
    s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  }
  return s;
}

function sheetXml(rows) {
  const body = rows.map((row, r) => {
    const cells = row.map((v, c) =>
      `<c r="${colName(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">` +
      `${esc(v)}</t></is></c>`).join("");
    return `<row r="${r + 1}">${cells}</row>`;
  }).join("");
  const width = rows.reduce((m, r) => Math.max(m, r.length), 1);
  const cols = Array.from({ length: width }, (_, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="18" customWidth="1"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`;
}

function zip(files) {
  // files: [{ name, data: Uint8Array }]
  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const head = Uint8Array.from([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800) /* UTF-8 이름 */,
      ...u16(0) /* stored */, ...u16(0), ...u16(0),
      ...u32(crc), ...u32(f.data.length), ...u32(f.data.length),
      ...u16(nameBytes.length), ...u16(0), ...nameBytes,
    ]);
    chunks.push(head, f.data);
    central.push(Uint8Array.from([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800),
      ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(f.data.length), ...u32(f.data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset), ...nameBytes,
    ]));
    offset += head.length + f.data.length;
  }

  const dir = central.reduce((n, c) => n + c.length, 0);
  const end = Uint8Array.from([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length), ...u32(dir), ...u32(offset), ...u16(0),
  ]);

  const total = offset + dir + end.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of [...chunks, ...central, end]) { out.set(c, p); p += c.length; }
  return out;
}

/**
 * 2차원 배열을 .xlsx 바이트로.
 * @param {string[][]} rows  첫 줄을 머리글로 쓰면 된다
 * @param {string} sheetName
 */
export function buildXlsx(rows, sheetName = "Sheet1") {
  const file = (name, text) => ({ name, data: enc.encode(text) });
  return zip([
    file("[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`),
    file("_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    file("xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${esc(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`),
    file("xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`),
    file("xl/worksheets/sheet1.xml", sheetXml(rows)),
  ]);
}
