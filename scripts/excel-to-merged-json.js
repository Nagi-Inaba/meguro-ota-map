/**
 * Excel (町名, 共同住宅3～5階建, 6～10階建, 合計世帯数) と CommPt を町名でマージ
 * 出力: geojson/chome-households.json (座標 + 合計世帯数 + B/C/D for pie chart)
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

function normalizeChomeName(str) {
  if (!str || typeof str !== 'string') return '';
  let s = str.trim();
  s = s.replace(/^東京都目黒区/, '');
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
  const commPtPath = path.join(OUT_DIR, 'comm-pt-meguro.json');
  if (!fs.existsSync(commPtPath)) {
    console.error('Run npm run build:gml first to create comm-pt-meguro.json');
    process.exit(1);
  }
  const commPts = JSON.parse(fs.readFileSync(commPtPath, 'utf-8'));

  const excelPath = path.join(ROOT, 'megurobilding.xlsx');
  if (!fs.existsSync(excelPath)) {
    console.error('megurobilding.xlsx not found');
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
    (h) => h && h.includes('共同住宅') && (h.includes('3～5') || h.includes('3-5') || (h.includes('3') && h.includes('5')))
  );
  let col6to10 = headers.findIndex(
    (h) => h && h.includes('共同住宅') && (h.includes('6～10') || h.includes('6-10') || (h.includes('6') && h.includes('10')))
  );
  const totalCol = headers.findIndex((h) => h === '合計世帯数' || (h && h.includes('合計')));
  if (nameCol < 0) {
    console.error('Column 町名 not found. Headers:', headers);
    process.exit(1);
  }
  if (col3to5 < 0 && headers.length >= 2) col3to5 = 1;
  if (col6to10 < 0 && headers.length >= 3) col6to10 = 2;
  if (col3to5 < 0 || col6to10 < 0) {
    console.warn('Column 共同住宅 3～5階建 or 6～10階建 not found. Headers:', JSON.stringify(headers));
  }

  const nameToPt = new Map();
  for (const pt of commPts) {
    const key = normalizeChomeName(pt.name);
    if (key) nameToPt.set(key, pt);
    const canon = toCanonicalNum(pt.name.replace(/\s+/g, ''));
    if (canon) nameToPt.set(canon, pt);
  }
  for (const pt of commPts) {
    const key = toCanonicalNum(normalizeChomeName(pt.name));
    if (key && !nameToPt.has(key)) nameToPt.set(key, pt);
  }

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rawName = row[nameCol] != null ? String(row[nameCol]).trim() : '';
    if (!rawName) continue;
    const nameKey = normalizeChomeName(rawName);
    const nameKeyCanon = toCanonicalNum(nameKey);
    let pt = nameToPt.get(nameKey) || nameToPt.get(nameKeyCanon);
    if (!pt) {
      for (const [k, v] of nameToPt) {
        if (toCanonicalNum(k) === nameKeyCanon || k === nameKey) {
          pt = v;
          break;
        }
      }
    }
    const total = totalCol >= 0 && row[totalCol] != null ? Number(row[totalCol]) : 0;
    const raw35 = col3to5 >= 0 ? row[col3to5] : null;
    const raw610 = col6to10 >= 0 ? row[col6to10] : null;
    const b35 = raw35 !== undefined && raw35 !== null && raw35 !== '' ? Number(raw35) : 0;
    const b610 = raw610 !== undefined && raw610 !== null && raw610 !== '' ? Number(raw610) : 0;
    out.push({
      name: rawName,
      nameKey,
      lng: pt ? pt.lng : null,
      lat: pt ? pt.lat : null,
      total,
      apartments_3_5: b35,
      apartments_6_10: b610,
    });
  }

  let inconsistent = 0;
  for (const r of out) {
    const sum = (r.apartments_3_5 || 0) + (r.apartments_6_10 || 0);
    if (r.total !== sum) {
      inconsistent++;
      if (inconsistent <= 5) {
        console.warn('  [整合性] ' + r.name + ': 合計=' + r.total + ', 3～5+6～10=' + sum);
      }
    }
  }
  if (inconsistent > 0) {
    console.warn('  数値の不一致: ' + inconsistent + ' 件（合計世帯数 ≠ 3～5階建+6～10階建）');
  } else {
    console.log('  数値の整合性: 全件一致（合計 = 3～5階建+6～10階建）');
  }

  fs.writeFileSync(path.join(OUT_DIR, 'chome-households.json'), JSON.stringify(out, null, 2), 'utf-8');
  console.log('Wrote geojson/chome-households.json, rows:', out.length);
  const withCoord = out.filter((r) => r.lng != null && r.lat != null).length;
  console.log('  With coordinates (matched to CommPt):', withCoord);
}

main();
