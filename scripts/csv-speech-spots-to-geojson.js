/**
 * 演説スポット CSV（施設名, 住所）→ GeoJSON
 * Mapbox Geocoding API で住所を緯度経度に変換し、地図用のポイント GeoJSON を出力する。
 * 出力: geojson/speech-spots.json
 *
 * 【検索フロー】
 * 1. 住所で検索 → 結果が目黒区・大田区の町丁ポリゴン内なら採用。
 * 2. ポリゴン外（または住所で候補なし）の場合、場所名で再検索。場所名に「付近」とある場合は付近を含めずに検索。
 * 3. それでもポリゴン外の座標になる場合はプロットしない（スキップ）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CSV_PATH = path.join(ROOT, '演説候補地地点', '演説スポット100件 - シート1.csv');
const OUT_DIR = path.join(ROOT, 'geojson');
const OUT_FILE = path.join(OUT_DIR, 'speech-spots.json');

function getMapboxToken() {
  const configPath = path.join(ROOT, 'config.js');
  if (!fs.existsSync(configPath)) {
    console.error('config.js が見つかりません。MAPBOX_ACCESS_TOKEN を設定してください。');
    process.exit(1);
  }
  const content = fs.readFileSync(configPath, 'utf-8');
  const m = content.match(/MAPBOX_ACCESS_TOKEN\s*=\s*['"]([^'"]+)['"]/);
  if (!m) {
    console.error('config.js に MAPBOX_ACCESS_TOKEN が見つかりません。');
    process.exit(1);
  }
  return m[1];
}

function parseCsv(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf-8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const idx = line.indexOf(',');
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim();
    const address = line.slice(idx + 1).trim();
    if (i === 0 && name === '施設名' && address === '住所') continue; // ヘッダー
    if (!address) continue;
    rows.push({ name, address });
  }
  return rows;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 目黒区・大田区周辺にバイアス（経度, 緯度）。同名の他地域との誤マッチを防ぐ
const PROXIMITY_LNG = 139.7;
const PROXIMITY_LAT = 35.63;
const PROXIMITY = `${PROXIMITY_LNG},${PROXIMITY_LAT}`;
// 結果を目黒区・大田区の範囲に限定（minLon,minLat,maxLon,maxLat）。千鳥など他地域と誤マッチするのを防ぐ
const BBOX = '139.65,35.55,139.78,35.65';

// 住所から「〇〇区」を抽出（検証用）。例: 目黒区碑文谷6-9-11 → 目黒区
function extractWardFromAddress(address) {
  const m = address.match(/^東京都?(.+?区)/) || address.match(/(.+?区)/);
  return m ? m[1].trim() : null; // "目黒区" or "大田区"
}

// 区名のローマ字（Mapbox が英語で返す場合用）
const WARD_ROMAN = { '目黒区': 'Meguro', '大田区': 'Ota' };

// Mapbox 返却の place_name と context の text に、依頼した区名が含まれるか（誤マッチ検出）
function resultMatchesWard(feature, expectedWard) {
  if (!expectedWard) return true;
  const placeName = feature.place_name || '';
  const contextTexts = (feature.context || []).map((c) => c.text || '').join(' ');
  const combined = (placeName + ' ' + contextTexts).toLowerCase();
  const wardCore = expectedWard.replace(/区$/, ''); // "目黒区" → "目黒"
  const roman = (WARD_ROMAN[expectedWard] || '').toLowerCase();
  return combined.includes(expectedWard) || combined.includes(wardCore) || (roman && combined.includes(roman));
}

// 経度緯度から PROXIMITY までの距離の二乗（比較用なので二乗で十分）
function distSqToProximity(lng, lat) {
  const dLng = lng - PROXIMITY_LNG;
  const dLat = lat - PROXIMITY_LAT;
  return dLng * dLng + dLat * dLat;
}

// 住所に「東京都」がなければ付与して精度向上
function normalizeAddress(address) {
  const t = address.trim();
  if (!t.startsWith('東京都') && !t.startsWith('北海道') && !t.startsWith('大阪府') && !t.startsWith('京都府')) {
    return '東京都' + t;
  }
  return t;
}

/**
 * 誤マッチの原因と対策:
 * 1. limit=1 だと、bbox 内で「関連度順」の1件だけ返る。碑文谷は目黒区と渋谷区側の両方に
 *    ヒットし得るが、関連度で渋谷側が先に返ることがある。
 * 2. 対策: limit=5 で複数候補を取得 → 返却の place_name/context に「依頼した区名」が
 *    含まれる候補だけに絞る（区の一致検証）→ その中で PROXIMITY に最も近い1件を採用。
 * これで「目黒区碑文谷」が渋谷側に飛ばされる」ことを防ぐ。
 */
async function geocode(address, token) {
  const normalized = normalizeAddress(address);
  const expectedWard = extractWardFromAddress(address);

  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(normalized)}.json?access_token=${token}&country=JP&limit=5&language=ja&proximity=${PROXIMITY}&bbox=${BBOX}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn('Geocode failed:', address, res.status);
    return null;
  }
  const json = await res.json();
  if (!json.features?.length) return null;

  const candidates = json.features.filter((f) => resultMatchesWard(f, expectedWard));
  if (candidates.length === 0) return null;

  let best = candidates[0];
  let bestDist = distSqToProximity(best.center[0], best.center[1]);
  for (let i = 1; i < candidates.length; i++) {
    const f = candidates[i];
    const d = distSqToProximity(f.center[0], f.center[1]);
    if (d < bestDist) {
      bestDist = d;
      best = f;
    }
  }
  return { coords: best.center, wardMatched: true };
}

/**
 * 目黒区・大田区の町丁ポリゴン GeoJSON を読み、ポリゴン Feature のリストを返す。
 * 演説スポットがポリゴン内かどうかの判定に使用。
 */
function loadPolygonFeatures() {
  const list = [];
  const meguroPath = path.join(ROOT, 'geojson', 'meguro-shapefile-areas.json');
  const otaPath = path.join(ROOT, 'geojson', 'ota-shapefile-areas.json');
  for (const p of [meguroPath, otaPath]) {
    if (!fs.existsSync(p)) continue;
    const geojson = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!geojson?.features?.length) continue;
    for (const f of geojson.features) {
      if (f.geometry) list.push(f);
    }
  }
  return list;
}

/** 点が目黒区・大田区のいずれかの町丁ポリゴン内にあるか */
function isPointInsidePolygons(lng, lat, polygonFeatures) {
  if (!polygonFeatures.length) return true; // ポリゴン未読み込み時は制限しない
  const point = [lng, lat];
  for (const feature of polygonFeatures) {
    if (booleanPointInPolygon(point, feature)) return true;
  }
  return false;
}

/** 点を含むポリゴン Feature を1つ返す。無ければ null */
function getPolygonAtPoint(lng, lat, polygonFeatures) {
  const point = [lng, lat];
  for (const feature of polygonFeatures) {
    if (booleanPointInPolygon(point, feature)) return feature;
  }
  return null;
}

/** 住所から町丁のベース名を抽出。例: "大田区南久が原1-17-6" → "南久が原"、"目黒区柿の木坂3-11-10" → "柿の木坂" */
function extractChomeBaseFromAddress(address) {
  if (!address || typeof address !== 'string') return '';
  const t = address.trim().replace(/^東京都/, '');
  const afterWard = t.replace(/^[^区]*区/, ''); // 区まで削除 → "南久が原1-17-6"
  const beforeKou = afterWard.match(/^(.+?)(?=[0-9０-９]+\s*-\s*[0-9０-９]|$)/);
  const chomePart = beforeKou ? beforeKou[1].trim() : afterWard;
  const base = chomePart.replace(/[0-9０-９一二三四五六七八九十]+丁目?$/g, '').replace(/[0-9０-９]+$/g, '').trim();
  return base || chomePart.replace(/[0-9０-９]+$/g, '').trim();
}

/** 比較用に町名の表記ゆれを正規化（ノ→の、全角→半角など） */
function normalizeChomeForCompare(str) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/ノ/g, 'の').replace(/\s+/g, '').trim();
}

/** ポリゴンの S_NAME（例: 南久が原一丁目）と住所の町丁が一致するか。表記ゆれ（ノ/の）を吸収 */
function chomeNameMatchesPolygon(sName, address) {
  if (!sName || !address) return true; // 判定できない場合は true にして通す
  const chomeBase = extractChomeBaseFromAddress(address);
  if (!chomeBase) return true;
  const sNorm = normalizeChomeForCompare(sName);
  const baseNorm = normalizeChomeForCompare(chomeBase);
  const sBase = sNorm.replace(/[一二三四五六七八九十０-９0-9]+丁目?$/g, '').trim();
  return sNorm.includes(baseNorm) || sNorm.startsWith(baseNorm) || baseNorm.includes(sBase);
}

/** 座標がポリゴン内かつ、住所の町丁名とそのポリゴンの S_NAME が一致するか（町丁名不一致＝誤プロットを弾く） */
function isPointValidForAddress(lng, lat, address, polygonFeatures) {
  if (!polygonFeatures.length) return true;
  if (!isPointInsidePolygons(lng, lat, polygonFeatures)) return false;
  const poly = getPolygonAtPoint(lng, lat, polygonFeatures);
  if (!poly) return true;
  return chomeNameMatchesPolygon(poly.properties?.S_NAME, address);
}

/** 住所の丁目番号（番地の先頭数字）。例: "柿の木坂3-11-10" → 3、"南久が原1-17-6" → 1 */
function getChomeNumberFromAddress(address) {
  if (!address || typeof address !== 'string') return null;
  const afterWard = address.trim().replace(/^東京都/, '').replace(/^[^区]*区/, '');
  const m = afterWard.match(/[0-9０-９一二三四五六七八九十]+(?=\s*-\s*[0-9０-９])/);
  if (!m) return null;
  const numStr = m[0].replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const kanji = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (/^[一二三四五六七八九十]+$/.test(numStr)) {
    if (numStr === '十') return 10;
    return kanji[numStr] ?? parseInt(numStr, 10);
  }
  const n = parseInt(numStr, 10);
  return isNaN(n) ? null : n;
}

/** 住所の町丁名と一致するポリゴンの中心点（X_CODE, Y_CODE）を返す。丁目が住所と一致するものを優先 */
function getCentroidByChomeName(address, polygonFeatures) {
  if (!address || !polygonFeatures.length) return null;
  const chomeBase = extractChomeBaseFromAddress(address);
  if (!chomeBase) return null;
  const preferredChomeNum = getChomeNumberFromAddress(address); // 例: 3 → 柿の木坂三丁目を優先
  const candidates = [];
  for (const f of polygonFeatures) {
    const sName = (f.properties?.S_NAME || '').trim();
    if (!chomeNameMatchesPolygon(sName, address)) continue;
    const x = f.properties?.X_CODE;
    const y = f.properties?.Y_CODE;
    if (x == null || y == null) continue;
    const m = (sName + '').match(/([一二三四五六七八九十]+)丁目$/);
    const polyChomeNum = m ? ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[m[1]] ?? null) : null;
    candidates.push({ coords: [Number(x), Number(y)], chomeNum: polyChomeNum });
  }
  if (candidates.length === 0) return null;
  if (preferredChomeNum != null) {
    const exact = candidates.find((c) => c.chomeNum === preferredChomeNum);
    if (exact) return exact.coords;
  }
  return candidates[0].coords;
}

/** 場所名から「付近」を除いた検索用文字列。例: "〇〇十字路付近" → "〇〇十字路" */
function placeNameForSearch(placeName) {
  if (!placeName || typeof placeName !== 'string') return '';
  return placeName.replace(/付近/g, '').trim().replace(/\s+/g, ' ').trim();
}

/** 住所で候補なし／ポリゴン外の場合、場所名（付近を除く）＋区で再検索。区一致する候補の座標を返す */
async function geocodeByPlaceName(placeName, address, token) {
  const expectedWard = extractWardFromAddress(address);
  const nameForSearch = placeNameForSearch(placeName);
  if (!nameForSearch) return null;
  const wardPart = expectedWard ? expectedWard : '';
  const query = wardPart ? `${nameForSearch} ${wardPart}` : normalizeAddress(address);
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${token}&country=JP&limit=5&language=ja&proximity=${PROXIMITY}&bbox=${BBOX}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  if (!json.features?.length) return null;
  const candidates = json.features.filter((f) => resultMatchesWard(f, expectedWard));
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestDist = distSqToProximity(best.center[0], best.center[1]);
  for (let i = 1; i < candidates.length; i++) {
    const f = candidates[i];
    const d = distSqToProximity(f.center[0], f.center[1]);
    if (d < bestDist) {
      bestDist = d;
      best = f;
    }
  }
  return best.center;
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error('CSV が見つかりません:', CSV_PATH);
    process.exit(1);
  }
  const token = getMapboxToken();
  const rows = parseCsv(CSV_PATH);
  console.log('演説スポット件数:', rows.length);

  const polygonFeatures = loadPolygonFeatures();
  if (polygonFeatures.length) {
    console.log('町丁ポリゴン読み込み:', polygonFeatures.length, '件（ポリゴン内で町丁名一致の点、またはポリゴン外の場合は町丁名一致ポリゴンの中心点にプロット）');
  } else {
    console.warn('meguro-shapefile-areas.json / ota-shapefile-areas.json が見つかりません。ポリゴン判定は行いません。');
  }

  const features = [];
  let skipped = 0;
  for (let i = 0; i < rows.length; i++) {
    const { name, address } = rows[i];
    let coords = null;

    // 1. 住所で検索
    const addressResult = await geocode(address, token);
    if (addressResult) {
      coords = addressResult.coords;
    }

    // 2. 住所で候補なし、またはポリゴン外／町丁名不一致の場合は場所名で再検索（付近は除く）
    if (polygonFeatures.length && (!coords || !isPointValidForAddress(coords[0], coords[1], address, polygonFeatures))) {
      if (name) {
        await sleep(150);
        const placeCoords = await geocodeByPlaceName(name, address, token);
        if (placeCoords && isPointValidForAddress(placeCoords[0], placeCoords[1], address, polygonFeatures)) {
          coords = placeCoords;
        } else {
          // ポリゴン外／町丁名不一致なら、町丁名が一致するポリゴンの中心点にプロット
          coords = getCentroidByChomeName(address, polygonFeatures);
        }
      } else {
        // 住所結果がポリゴン外／町丁名不一致 → 町丁名一致ポリゴンの中心点にプロット
        coords = getCentroidByChomeName(address, polygonFeatures);
      }
    } else if (!coords && name) {
      await sleep(150);
      const placeCoords = await geocodeByPlaceName(name, address, token);
      if (placeCoords) {
        if (polygonFeatures.length && !isPointValidForAddress(placeCoords[0], placeCoords[1], address, polygonFeatures)) {
          coords = getCentroidByChomeName(address, polygonFeatures); // 町丁名一致の中心点にプロット
        } else {
          coords = placeCoords;
        }
      }
    }

    if (coords) {
      features.push({
        type: 'Feature',
        properties: { name, address },
        geometry: { type: 'Point', coordinates: coords }
      });
    } else {
      skipped++;
      console.warn('スキップ（候補なし／ポリゴン外／町丁名不一致）:', name, address);
    }
    if (i < rows.length - 1) await sleep(150); // レート制限対策
  }
  const geojson = { type: 'FeatureCollection', features };
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(geojson, null, 2), 'utf-8');
  console.log('Wrote', OUT_FILE, '(points:', features.length, ')');
  if (skipped > 0) console.log('表示しない件数（候補なし／ポリゴン外／町丁名不一致）:', skipped);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
