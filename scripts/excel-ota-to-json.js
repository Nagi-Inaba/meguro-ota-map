/**
 * 大田区用 Excel (otabilding.xlsx) → geojson/chome-households-ota.json
 * 町名, 共同住宅3～5階建, 6～10階建, 合計世帯数。Shapefile の S_NAME と町名で紐付ける。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'xlsx';
const { readFile: xlsxReadFile, utils: xlsxUtils } = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'geojson');

const KANJI_TO_NUM = { 零: '0', 〇: '0', 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9' };

function normalizeOtaChome(str) {
  if (!str || typeof str !== 'string') return '';
  let s = str.trim();
  s = s.replace(/^東京都大田区/, '');
  s = s.replace(/\s+/g, '');
  return s;
}

function toCanonicalNum(str) {
  if (!str) return '';
  let s = str;
  for (const [k, v] of Object.entries(KANJI_TO_NUM)) s = s.split(k).join(v);
  s = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  return s;
}

function main() {
  const excelPath = path.join(ROOT, 'otabilding.xlsx');
  if (!fs.existsSync(excelPath)) {
    console.error('otabilding.xlsx not found at', excelPath);
    process.exit(1);
  }
  const wb = xlsxReadFile(excelPath);
  const firstSheet = wb.SheetNames[0];
  const ws = wb.Sheets[firstSheet];
  const rows = xlsxUtils.sheet_to_json(ws, { header: 1 });
  if (!rows.length || rows.length < 2) {
    console.error('Excel has no data rows');
    process.exit(1);
  }
  const headers = rows[0].map((h) => (h != null ? String(h).trim() : ''));
  const nameCol = headers.findIndex((h) => h === '町名' || h.includes('町名'));
  let col3to5 = headers.findIndex(
    (h) => h && h.includes('共同住宅') && (h.includes('3～5') || h.includes('3-5') || (h.includes('３') && h.includes('５')))
  );
  let col6to10 = headers.findIndex(
    (h) => h && h.includes('共同住宅') && (h.includes('6～10') || h.includes('6-10') || (h.includes('６') && h.includes('１０')))
  );
  const totalCol = headers.findIndex((h) => h === '合計世帯数' || (h && h.includes('合計')));
  if (nameCol < 0) {
    console.error('Column 町名 not found. Headers:', headers);
    process.exit(1);
  }
  if (col3to5 < 0 && headers.length >= 2) col3to5 = 1;
  if (col6to10 < 0 && headers.length >= 3) col6to10 = 2;

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rawName = row[nameCol] != null ? String(row[nameCol]).trim() : '';
    if (!rawName) continue;
    const nameKey = normalizeOtaChome(rawName);
    const total = totalCol >= 0 && row[totalCol] != null ? Number(row[totalCol]) : 0;
    const raw35 = col3to5 >= 0 ? row[col3to5] : null;
    const raw610 = col6to10 >= 0 ? row[col6to10] : null;
    const b35 = raw35 !== undefined && raw35 !== null && raw35 !== '' ? Number(raw35) : 0;
    const b610 = raw610 !== undefined && raw610 !== null && raw610 !== '' ? Number(raw610) : 0;
    out.push({
      name: rawName,
      nameKey,
      total,
      apartments_3_5: b35,
      apartments_6_10: b610,
    });
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'chome-households-ota.json'), JSON.stringify(out, null, 2), 'utf-8');
  console.log('Wrote geojson/chome-households-ota.json, rows:', out.length);
}

main();
