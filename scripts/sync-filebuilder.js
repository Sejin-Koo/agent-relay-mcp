#!/usr/bin/env node
// 계정 스킬 sys-file-builder(원본)의 lib/를 lib/filebuilder/(사본)로 복사하고 SOURCE.json에 버전·해시를 남긴다.
//   node scripts/sync-filebuilder.js <스킬 폴더>      예: /root/.claude/skills/synced/<id>/sys-file-builder
//   node scripts/sync-filebuilder.js --check          사본이 SOURCE.json과 같은지(직접 고친 흔적이 없는지) 검사
// 원칙: 기능의 원본은 계정 스킬이고 중계 서버는 사본을 쓴다. 사본을 직접 고치지 말고 원본을 고친 뒤 이 명령으로 다시 복사한다.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const DST = path.join(__dirname, "..", "lib", "filebuilder");
const SRC_JSON = path.join(DST, "SOURCE.json");
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const arg = process.argv[2];
if (!arg) { console.error("사용법: node scripts/sync-filebuilder.js <스킬 폴더> | --check"); process.exit(2); }
if (arg === "--check") {
  const src = JSON.parse(fs.readFileSync(SRC_JSON, "utf8"));
  const bad = Object.entries(src.files).filter(([f, h]) => !fs.existsSync(path.join(DST, f)) || sha(path.join(DST, f)) !== h).map(([f]) => f);
  const extra = fs.readdirSync(DST).filter(f => f !== "SOURCE.json" && !src.files[f]);
  if (bad.length || extra.length) { console.error("사본이 원본 기록과 다릅니다 — 계정 스킬 원본을 고친 뒤 다시 복사하세요:", bad.concat(extra).join(", ")); process.exit(1); }
  console.log(`filebuilder 사본 확인: ${src.skill} ${src.version}, 파일 ${Object.keys(src.files).length}개 일치`);
  process.exit(0);
}
const lib = path.join(arg, "lib");
if (!fs.existsSync(lib)) { console.error("스킬 폴더에 lib/가 없습니다: " + arg); process.exit(1); }
fs.mkdirSync(DST, { recursive: true });
fs.readdirSync(DST).forEach(f => fs.unlinkSync(path.join(DST, f)));
const files = {};
fs.readdirSync(lib).sort().forEach(f => { fs.copyFileSync(path.join(lib, f), path.join(DST, f)); files[f] = sha(path.join(DST, f)); });
const version = fs.existsSync(path.join(arg, "VERSION")) ? fs.readFileSync(path.join(arg, "VERSION"), "utf8").trim() : "unknown";
fs.writeFileSync(SRC_JSON, JSON.stringify({ skill: "sys-file-builder", version, copied: new Date().toISOString().slice(0, 10), files }, null, 1) + "\n");
console.log(`복사 완료: sys-file-builder ${version} → lib/filebuilder (${Object.keys(files).length}개)`);
