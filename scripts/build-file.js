#!/usr/bin/env node
// 파일 만들기 명령 — 서버의 build_file과 같은 변환기로 원고(마크다운)에서 파일을 만든다.
// 계정 채팅에서 한글(HWPX) 보고서나 가치평가 Excel 모델을 만들 때 쓴다.
//
//   node scripts/build-file.js hwpx 보고서.md 보고서.hwpx [--brand 이름] [--date 2026-10-23]
//   node scripts/build-file.js xlsx 원고.md 모델.xlsx
//
// - hwpx: 원고의 이미지 문단(![캡션](그림.png "자료: …"))을 한글 그림 개체로 넣는다(경로는 원고 파일 기준).
//   ```chart```·```diagram``` 블록은 그림 PNG가 없으므로 그림 자료를 표로 넣는다.
// - xlsx: ```valuation-model``` JSON 블록이 있으면 수식 연결 가치평가 모델, 없으면 표를 시트로.
const fs = require("fs");
const path = require("path");
const { marked } = require("marked");
const DocExport = require("../lib/docexport");
const { buildXlsx, buildHwpxFile } = require("../lib/files");

function pngSize(buf) {
  // PNG IHDR: 16~23바이트에 너비·높이
  if (buf.length > 24 && buf.toString("ascii", 1, 4) === "PNG") return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  return { w: 16, h: 9 };
}

async function main() {
  const [fmt, inp, out, ...rest] = process.argv.slice(2);
  if (!fmt || !inp || !out) { console.error("사용법: node scripts/build-file.js <hwpx|xlsx> <원고.md> <출력 파일> [--brand 이름] [--date YYYY-MM-DD] [--dept 부서]"); process.exit(2); }
  const opt = {};
  for (let i = 0; i < rest.length; i += 2) opt[String(rest[i]).replace(/^--/, "")] = rest[i + 1];
  const md = fs.readFileSync(inp, "utf8");
  const meta = { brand: opt.brand || "", date: opt.date || "", dept: opt.dept || "", agent: opt.agent || "", fallbackTitle: path.basename(inp, path.extname(inp)) };
  let r;
  if (fmt === "hwpx") {
    const model = DocExport.mdToModel(md, s => marked.lexer(s), { images: true });
    const base = path.dirname(path.resolve(inp));
    const figs = [];
    model.sections.forEach(s => s.blocks.forEach(b => {
      if (b.type !== "figure") return;
      if (b.kind === "image" && b.src) {
        const p = path.resolve(base, decodeURIComponent(b.src));
        if (!fs.existsSync(p)) { console.error("그림 파일 없음: " + p); figs.push(null); return; }
        const buf = fs.readFileSync(p);
        figs.push(Object.assign({ data: buf.toString("base64") }, pngSize(buf)));
      } else figs.push(null);
    }));
    r = await buildHwpxFile(md, Object.assign({ images: true }, meta), figs);
  } else if (fmt === "xlsx") {
    r = await buildXlsx(md, meta);
  } else { console.error("지원 형식: hwpx, xlsx"); process.exit(2); }
  fs.writeFileSync(out, r.buffer);
  console.log(JSON.stringify({ out, title: r.title, kind: r.kind, bytes: r.buffer.length, warnings: r.warnings }, null, 1));
}
main().catch(e => { console.error(e && e.stack || e); process.exit(1); });
