/**
 * 演説スポット CSV（場所(目印), 住所(目黒区), ターゲット層）→ GeoJSON
 * Google Geocoding API で住所を緯度経度に変換し、地図用のポイント GeoJSON を出力する。
 * 出力: geojson/speech-spots.json
 * config.js に GOOGLE_MAPS_API_KEY を設定し、Google Cloud で Geocoding API を有効にしてください。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import iconv from 'iconv-lite';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
// 新CSV（緯度経度入り: No,Name,"Latitude, Longitude",Description,Area）
const CSV_PATH_COORDS = path.join(ROOT, '演説候補地地点', 'Meguro100Spots.csv - meguro_100_spots.csv');
// 既存スポット（施設名・住所の2列）。こちらを主に使用し、欠損時のみ 演説スポット.csv を使用
const CSV_PATH_LEGACY = path.join(ROOT, '演説候補地地点', '演説スポット100件 - シート1.csv');
// 新CSV（場所・住所・ターゲット層の3列）。ターゲット層の補完と新規行の追加に使用
const CSV_PATH_NEW = path.join(ROOT, '演説候補地地点', '演説スポット.csv');
const OUT_DIR = path.join(ROOT, 'geojson');
const OUT_FILE = path.join(OUT_DIR, 'speech-spots.json');
const STATUS_FILE = path.join(OUT_DIR, 'speech-spots-status.json');

function getGoogleApiKey() {
  const configPath = path.join(ROOT, 'config.js');
  if (!fs.existsSync(configPath)) {
    console.error('config.js が見つかりません。GOOGLE_MAPS_API_KEY を設定してください。');
    process.exit(1);
  }
  const content = fs.readFileSync(configPath, 'utf-8');
  const m = content.match(/GOOGLE_MAPS_API_KEY\s*=\s*['"]([^'"]+)['"]/);
  if (!m) {
    console.error('config.js に GOOGLE_MAPS_API_KEY が見つかりません。Google Cloud で Geocoding API を有効にし、API キーを設定してください。');
    process.exit(1);
  }
  return m[1];
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(csvPath) {
  const buf = fs.readFileSync(csvPath);
  let text = buf.toString('utf-8');
  const firstLine = text.split(/\r?\n/)[0] || '';
  if (!/場所|施設|ターゲット|住所/.test(firstLine)) {
    text = iconv.decode(buf, 'shiftjis');
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parts = parseCsvLine(line);
    const name = (parts[0] || '').trim();
    const address = (parts[1] || '').trim();
    const targetLayer = (parts[2] || '').trim();
    if (i === 0 && (name === '施設名' || /場所\s*[（(]目印[）)]/.test(name)) && (address === '住所' || /住所\s*[（(]目黒区[）)]/.test(address))) continue;
    if (!address && !name) continue;
    rows.push({ name, address: address || '', targetLayer });
  }
  return rows;
}

function parseCsvWithCoords(csvPath) {
  const buf = fs.readFileSync(csvPath);
  let text = buf.toString('utf-8');
  const firstLine = text.split(/\r?\n/)[0] || '';
  if (!/Latitude|Longitude/i.test(firstLine)) {
    text = iconv.decode(buf, 'shiftjis');
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const idxName = header.findIndex((h) => /^name$/i.test(h));
  const idxLatLng = header.findIndex((h) => /latitude/i.test(h) && /longitude/i.test(h));
  const idxLat = header.findIndex((h) => /^latitude$/i.test(h));
  const idxLng = header.findIndex((h) => /^longitude$/i.test(h));
  const idxDesc = header.findIndex((h) => /^description$/i.test(h));
  const idxArea = header.findIndex((h) => /^area$/i.test(h));

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    const name = (parts[idxName] || '').trim();
    const description = (parts[idxDesc] || '').trim();
    const area = (parts[idxArea] || '').trim();
    let lat = null;
    let lng = null;
    if (idxLatLng >= 0) {
      const latlng = (parts[idxLatLng] || '').split(',').map((s) => s.trim());
      if (latlng.length >= 2) {
        lat = Number(latlng[0]);
        lng = Number(latlng[1]);
      }
    } else if (idxLat >= 0 && idxLng >= 0) {
      lat = Number(parts[idxLat]);
      lng = Number(parts[idxLng]);
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    rows.push({ name, description, area, coords: [lng, lat] });
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
const BBOX_LNG = [139.65, 139.78];
const BBOX_LAT = [35.55, 35.65];

function isPointInBbox(lng, lat) {
  return lng >= BBOX_LNG[0] && lng <= BBOX_LNG[1] && lat >= BBOX_LAT[0] && lat <= BBOX_LAT[1];
}

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

// 住所に「東京都」がなければ付与。区が含まれない場合は目黒区を付与（新規スポットは全て目黒区）
function normalizeAddress(address) {
  let t = address.trim();
  if (!t) return t;
  if (!/区/.test(t)) {
    t = '目黒区' + t;
  }
  if (!t.startsWith('東京都') && !t.startsWith('北海道') && !t.startsWith('大阪府') && !t.startsWith('京都府')) {
    return '東京都' + t;
  }
  return t;
}

/**
 * Google Geocoding API で住所を緯度経度に変換。
 * region=jp と bounds で目黒区・大田区周辺にバイアスをかけ、日本国内の正確な位置を取得する。
 * 返却: { coords: [lng, lat] }（GeoJSON 形式）。候補なし・区外の場合は null。
 */
// 住所から「東京都」「〇〇区」を除いた残り（検索クエリ用）。例: 東京都目黒区青葉台1-1-1 → 青葉台1-1-1
function addressWithoutPrefectureAndWard(normalizedAddress) {
  if (!normalizedAddress || typeof normalizedAddress !== 'string') return '';
  let t = normalizedAddress.trim().replace(/^東京都\s*/, '');
  const m = t.match(/^[^区]*区\s*(.*)$/);
  return m ? m[1].trim() : t;
}

// 番地が「〇〇X-Y-Z」または「〇〇X-Y」で丁目がない場合に展開（住所検索のヒット率向上）。
// 例: 駒場4-5-1 → 駒場4丁目5-1、青葉台3-1 → 青葉台3丁目1
function expandChomeForQuery(rest) {
  if (!rest || typeof rest !== 'string') return rest;
  if (/丁目/.test(rest)) return rest;
  const m3 = rest.match(/^(.+?)([0-9０-９一二三四五六七八九十]+)-([0-9０-９]+)-([0-9０-９]+)$/);
  if (m3) return m3[1] + m3[2] + '丁目' + m3[3] + '-' + m3[4];
  const m2 = rest.match(/^(.+?)([0-9０-９一二三四五六七八九十]+)-([0-9０-９]+)$/);
  if (m2) return m2[1] + m2[2] + '丁目' + m2[3];
  return rest;
}

// 住所から「〇〇X丁目」だけのクエリを組み立て（住所検索が失敗したときのフォールバック用）
function buildChomeOnlyQuery(normalizedAddress) {
  if (!normalizedAddress || typeof normalizedAddress !== 'string') return null;
  const expectedWard = extractWardFromAddress(normalizedAddress) || '目黒区';
  const rest = addressWithoutPrefectureAndWard(normalizedAddress);
  if (!rest || /丁目/.test(rest)) return null;
  const m = rest.match(/^(.+?)([0-9０-９一二三四五六七八九十]+)(-[0-9０-９]+(-[0-9０-９]+)?)?$/);
  if (!m) return null;
  return expectedWard + ' ' + m[1] + m[2] + '丁目';
}

async function geocodeGoogle(address, apiKey) {
  const normalized = normalizeAddress(address);
  // 検索時は区名を先頭に1回だけ（二重にしない）。例: 目黒区 青葉台1-1-1
  const expectedWard = extractWardFromAddress(normalized) || '目黒区';
  let rest = addressWithoutPrefectureAndWard(normalized);
  rest = expandChomeForQuery(rest);
  const queryForSearch = rest ? expectedWard + ' ' + rest : normalized;
  // bounds: 南西|北東（lat,lng|lat,lng）で目黒区・大田区周辺に絞る
  const bounds = `${BBOX_LAT[0]},${BBOX_LNG[0]}|${BBOX_LAT[1]},${BBOX_LNG[1]}`;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(queryForSearch)}&key=${apiKey}&region=jp&bounds=${bounds}&language=ja`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn('Geocode failed:', address, res.status);
    return null;
  }
  const json = await res.json();
  if (json.status !== 'OK' || !json.results?.length) return null;

  const r = json.results[0];
  const loc = r.geometry?.location;
  if (!loc || loc.lat == null || loc.lng == null) return null;

  const lng = Number(loc.lng);
  const lat = Number(loc.lat);
  if (!isPointInBbox(lng, lat)) return null;

  return { coords: [lng, lat] };
}

/**
 * Google Geocoding API で任意のクエリ（スポット名＋区など）を検索。
 * 区の範囲内の結果があれば [lng, lat] を返す。
 */
async function geocodeGoogleQuery(query, apiKey) {
  if (!query || !query.trim()) return null;
  const bounds = `${BBOX_LAT[0]},${BBOX_LNG[0]}|${BBOX_LAT[1]},${BBOX_LNG[1]}`;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${apiKey}&region=jp&bounds=${bounds}&language=ja`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  if (json.status !== 'OK' || !json.results?.length) return null;
  const loc = json.results[0].geometry?.location;
  if (!loc || loc.lat == null || loc.lng == null) return null;
  const lng = Number(loc.lng);
  const lat = Number(loc.lat);
  if (!isPointInBbox(lng, lat)) return null;
  return [lng, lat];
}

/**
 * スポット名で Google ジオコーディング（付近・横・前などは除いた施設名＋区で検索）。
 */
async function geocodeGoogleByPlaceName(placeName, address, apiKey) {
  const expectedWard = extractWardFromAddress(address) || '目黒区';
  const nameForSearch = placeNameForSearch(placeName);
  if (!nameForSearch) return null;
  // 検索時に区名を前に置くと区内の候補が返りやすくなる
  const queries = [`${expectedWard} ${nameForSearch}`];
  const chomeBase = getChomeBaseForProximity(address || '');
  if (chomeBase && chomeBase !== nameForSearch) queries.push(`${expectedWard} ${nameForSearch} ${chomeBase}`);
  for (let qi = 0; qi < queries.length; qi++) {
    if (qi > 0) await sleep(100);
    const coords = await geocodeGoogleQuery(queries[qi], apiKey);
    if (coords) return coords;
  }
  return null;
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

/** ポリゴン S_NAME から丁目番号を取得。例: "原町二丁目" → 2、"南久が原一丁目" → 1 */
function getChomeNumberFromSName(sName) {
  if (!sName || typeof sName !== 'string') return null;
  const m = (sName + '').trim().match(/([一二三四五六七八九十]+)丁目$/);
  if (m) return ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[m[1]] ?? null);
  const m2 = (sName + '').trim().match(/([0-9０-９]+)丁目$/);
  if (m2) return parseInt(String(m2[1]).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)), 10);
  return null;
}

/** ポリゴンの S_NAME（例: 南久が原一丁目）と住所の町丁が一致するか。丁目が住所に含まれる場合は丁目も一致を要求 */
function chomeNameMatchesPolygon(sName, address) {
  if (!sName || !address) return true; // 判定できない場合は true にして通す
  const chomeBase = extractChomeBaseFromAddress(address);
  if (!chomeBase) return true;
  const sNorm = normalizeChomeForCompare(sName);
  const baseNorm = normalizeChomeForCompare(chomeBase);
  const sBase = sNorm.replace(/[一二三四五六七八九十０-９0-9]+丁目?$/g, '').trim();
  const baseMatch = sNorm.includes(baseNorm) || sNorm.startsWith(baseNorm) || baseNorm.includes(sBase);
  if (!baseMatch) return false;
  // 住所に丁目番号（例: 原町2-1-1 の 2）が含まれる場合、ポリゴンの丁目と一致必須
  const addrChome = getChomeNumberFromAddress(address);
  if (addrChome == null) return true;
  const polyChome = getChomeNumberFromSName(sName);
  if (polyChome == null) return true; // ポリゴンに丁目が無い場合はベース一致のみ
  return addrChome === polyChome;
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

/** 座標が含まれるポリゴンの丁目番号を返す。無ければ null */
function getChomeNumberAtPoint(lng, lat, polygonFeatures) {
  const poly = getPolygonAtPoint(lng, lat, polygonFeatures);
  return poly ? getChomeNumberFromSName(poly.properties?.S_NAME) : null;
}

/** スポット名で得た座標が住所と一致または付近か（同じ丁目 or 隣接丁目 = 正確、それ以外 = ずれ） */
function isSpotCoordAccurateWithAddress(lng, lat, address, polygonFeatures) {
  if (!address || !polygonFeatures.length) return true;
  const addrChome = getChomeNumberFromAddress(address);
  const polyChome = getChomeNumberAtPoint(lng, lat, polygonFeatures);
  if (addrChome == null || polyChome == null) return true;
  const diff = Math.abs(addrChome - polyChome);
  return diff <= 1; // 同じ丁目 or 隣接丁目なら正確
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

// スポット名に付随する位置を示す語（検索時は除去して施設本体名でジオコーディングする）
const PLACE_NAME_SUFFIXES = /(付近|周辺|近く|横|裏手|前|入口|角|隣|奥|手前|向かい|脇|そば|側|際|隣接|近傍|横手|前後|公園付近|付近公園|駅前|駅付近|入口付近|前付近|横付近|裏手付近|住宅側|下交差点|交差点|車寄せ)+$/g;

/** 場所名から位置表現を除いた検索用の施設本体名。例: "中根公園付近" → "中根公園"、"〇〇タワー横" → "〇〇タワー" */
function placeNameForSearch(placeName) {
  if (!placeName || typeof placeName !== 'string') return '';
  let s = placeName.replace(PLACE_NAME_SUFFIXES, '').trim().replace(/\s+/g, ' ').trim();
  return s || placeName.trim();
}

/**
 * 単純な地名かどうか。固有名詞に含めず、住所検索のみ行う対象。
 * 例: 5丁目住宅地、駒場4丁目マンション群、〇丁目住宅地
 */
function isSimplePlaceName(placeName) {
  if (!placeName || typeof placeName !== 'string') return false;
  const s = placeNameForSearch(placeName);
  if (!s) return false;
  if (/丁目(住宅地|マンション)/.test(placeName)) return true;
  if (/^[0-9０-９一二三四五六七八九十百]+丁目(住宅地|マンション群?)?$/.test(s)) return true;
  return false;
}

/** 住所の町丁ベース（例: 中根）を取得。スポット名検索の絞り込みに利用 */
function getChomeBaseForProximity(address) {
  const base = extractChomeBaseFromAddress(address);
  if (!base) return '';
  return base.replace(/[0-9０-９一二三四五六七八九十]+丁目?$/g, '').trim() || base;
}

/** 住所で候補なし／ポリゴン外の場合、スポット名（位置表現を除いた本体名）で検索。区＋町名で絞り込み。 */
async function geocodeByPlaceName(placeName, address, token) {
  let expectedWard = extractWardFromAddress(address);
  if (!expectedWard) expectedWard = '目黒区';
  const nameForSearch = placeNameForSearch(placeName);
  if (!nameForSearch) return null;

  const queries = [];
  const chomeBase = getChomeBaseForProximity(address || '');
  queries.push(`${nameForSearch} ${expectedWard}`);
  if (chomeBase && chomeBase !== nameForSearch) queries.push(`${nameForSearch} ${expectedWard} ${chomeBase}`);

  for (let qi = 0; qi < queries.length; qi++) {
    if (qi > 0) await sleep(100);
    const query = queries[qi];
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${token}&country=JP&limit=5&language=ja&proximity=${PROXIMITY}&bbox=${BBOX}`;
    const res = await fetch(url);
    if (!res.ok) continue;
    const json = await res.json();
    if (!json.features?.length) continue;
    const candidates = json.features.filter((f) => resultMatchesWard(f, expectedWard));
    if (candidates.length === 0) continue;
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
  return null;
}

function normKey(name, address) {
  return (name || '').trim() + '|' + (address || '').trim().replace(/\s+/g, '');
}

// 住所の表記ゆれを吸収（東京都・区を除いた部分で比較）
function normAddressForMatch(addr) {
  if (!addr || typeof addr !== 'string') return '';
  return addr.replace(/^東京都?\s*/, '').replace(/^(目黒区|大田区)\s*/, '').replace(/\s+/g, '').trim();
}

function normKeyLoose(name, address) {
  return (name || '').trim() + '|' + normAddressForMatch(address);
}

async function main() {
  const useCoords = fs.existsSync(CSV_PATH_COORDS);
  if (useCoords) {
    const rows = parseCsvWithCoords(CSV_PATH_COORDS);
    if (!rows.length) {
      console.error('緯度経度CSVの有効行がありません。', CSV_PATH_COORDS);
      process.exit(1);
    }
    const features = rows.map((r) => ({
      type: 'Feature',
      properties: {
        name: r.name || '',
        description: r.description || '',
        area: r.area || ''
      },
      geometry: { type: 'Point', coordinates: r.coords }
    }));
    const statusList = rows.map((r) => ({
      name: r.name || '',
      address: r.description || '',
      targetLayer: '',
      method: '緯度経度CSV',
      accurate: true,
      remark: '',
      lat: r.coords[1],
      lng: r.coords[0]
    }));
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify({ type: 'FeatureCollection', features }, null, 2), 'utf-8');
    console.log('Wrote', OUT_FILE, '(points:', features.length, ')');
    fs.writeFileSync(STATUS_FILE, JSON.stringify(statusList, null, 2), 'utf-8');
    console.log('Wrote', STATUS_FILE, '(list:', statusList.length, ')');
    return;
  }

  const useLegacy = fs.existsSync(CSV_PATH_LEGACY);
  const useNew = fs.existsSync(CSV_PATH_NEW);
  if (!useLegacy && !useNew) {
    console.error('CSV が見つかりません。', CSV_PATH_LEGACY, 'または', CSV_PATH_NEW);
    process.exit(1);
  }
  const apiKey = getGoogleApiKey();

  let rows = [];
  if (useLegacy) {
    rows = parseCsv(CSV_PATH_LEGACY);
    console.log('既存CSV（100件）読み込み:', rows.length, '件');
  }
  if (useNew) {
    const rowsNew = parseCsv(CSV_PATH_NEW);
    const keySetStrict = new Set(rows.map((r) => normKey(r.name, r.address)));
    const keySetLoose = new Set(rows.map((r) => normKeyLoose(r.name, r.address)));
    const targetByKey = new Map();
    for (const r of rowsNew) {
      if (r.targetLayer) {
        targetByKey.set(normKey(r.name, r.address), r.targetLayer);
        targetByKey.set(normKeyLoose(r.name, r.address), r.targetLayer);
        targetByKey.set((r.name || '').trim(), r.targetLayer);
      }
    }
    for (const r of rows) {
      r.targetLayer = targetByKey.get(normKey(r.name, r.address)) || targetByKey.get(normKeyLoose(r.name, r.address)) || targetByKey.get((r.name || '').trim()) || r.targetLayer || '';
    }
    for (const r of rowsNew) {
      const keyStrict = normKey(r.name, r.address);
      const keyLoose = normKeyLoose(r.name, r.address);
      const exists = keySetStrict.has(keyStrict) || keySetLoose.has(keyLoose);
      if (!exists && (r.name || r.address)) {
        keySetStrict.add(keyStrict);
        keySetLoose.add(keyLoose);
        rows.push(r);
      }
    }
    if (useLegacy) console.log('演説スポット.csv でターゲット層を補完・新規追加後:', rows.length, '件');
    else console.log('演説スポット.csv 読み込み:', rows.length, '件');
  }
  if (rows.length === 0) {
    console.error('有効なスポット行がありません。');
    process.exit(1);
  }
  console.log('演説スポット件数（処理対象）:', rows.length);

  const polygonFeatures = loadPolygonFeatures();
  if (polygonFeatures.length) {
    console.log('町丁ポリゴン読み込み:', polygonFeatures.length, '件（丁目一致の判定に使用。候補なしの場合は町丁中心は使わず、スポット名検索のみ行う）');
  } else {
    console.warn('meguro-shapefile-areas.json / ota-shapefile-areas.json が見つかりません。ポリゴン判定は行いません。');
  }

  const features = [];
  const statusList = [];
  let skipped = 0;
  for (let i = 0; i < rows.length; i++) {
    const { name, address, targetLayer } = rows[i];
    if (!address && !name) continue;
    const addressForGeocode = address ? normalizeAddress(address) : '';
    let coords = null;
    let source = null;
    let accurate = true;
    let remark = '';

    // 単純な地名（5丁目住宅地など）は固有名詞に含めず、住所検索のみ行う
    const useSpotSearchFirst = name && placeNameForSearch(name) && !isSimplePlaceName(name);

    let spotCoordsFallback = null; // 丁目不一致で捨てたスポット結果（住所検索が失敗したら採用）
    if (useSpotSearchFirst) {
      // 1. 固有名詞: 接尾語を除いたスポット名で検索（Google API）
      await sleep(150);
      let placeCoords = await geocodeGoogleByPlaceName(name, addressForGeocode || address, apiKey);
      if (placeCoords && polygonFeatures.length && address) {
        const addrForCheck = addressForGeocode || address;
        if (!isPointValidForAddress(placeCoords[0], placeCoords[1], addrForCheck, polygonFeatures)) {
          spotCoordsFallback = placeCoords; // 住所検索がダメだったら使う
          placeCoords = null;
        }
      }
      if (placeCoords) {
        coords = placeCoords;
        source = 'spot';
        if (polygonFeatures.length && address) {
          if (!isSpotCoordAccurateWithAddress(coords[0], coords[1], addressForGeocode || address, polygonFeatures)) {
            accurate = false;
            remark = '住所とスポット位置がずれている可能性';
          }
        }
      }
    }

    // 2. 住所でジオコーディング（単純な地名はここだけ。固有名詞はスポット未採用 or 候補なし時）
    if (!coords && addressForGeocode) {
      let addressResult = await geocodeGoogle(addressForGeocode, apiKey);
      if (!addressResult) {
        const chomeOnlyQuery = buildChomeOnlyQuery(normalizeAddress(addressForGeocode));
        if (chomeOnlyQuery) {
          await sleep(100);
          addressResult = await geocodeGoogle(chomeOnlyQuery, apiKey);
        }
      }
      if (addressResult) {
        const [lng, lat] = addressResult.coords;
        const inPolygons = !polygonFeatures.length || isPointInsidePolygons(lng, lat, polygonFeatures);
        const chomeMatch = polygonFeatures.length && isPointValidForAddress(lng, lat, addressForGeocode || address, polygonFeatures);
        if (inPolygons || isPointInBbox(lng, lat)) {
          coords = addressResult.coords;
          source = 'address';
          accurate = chomeMatch;
          if (!chomeMatch && polygonFeatures.length) remark = '丁目が一致しません（区内で表示）';
        }
      }
    }

    // 3. 住所もダメなら、丁目不一致で捨てたスポット結果があれば採用（accurate=false）
    if (!coords && spotCoordsFallback) {
      coords = spotCoordsFallback;
      source = 'spot';
      accurate = false;
      remark = '住所と丁目が異なります（スポット位置で表示）';
    }

    if (coords) {
      const props = { name, address: address || addressForGeocode || '' };
      if (targetLayer) props.targetLayer = targetLayer;
      features.push({
        type: 'Feature',
        properties: props,
        geometry: { type: 'Point', coordinates: coords }
      });
    } else {
      skipped++;
      source = 'skip';
      accurate = false;
      remark = '住所・スポット名のいずれでも位置を特定できませんでした';
      console.warn('スキップ（プロットなし）:', name, address);
    }

    const methodLabel = source === 'address' ? '住所で検索' : source === 'spot' ? 'スポット名で検索' : '位置が特定できなかった';
    statusList.push({
      name: name || '',
      address: address || addressForGeocode || '',
      targetLayer: targetLayer || '',
      method: methodLabel,
      accurate: accurate,
      remark: remark,
      lat: coords ? coords[1] : null,
      lng: coords ? coords[0] : null
    });
    if (i < rows.length - 1) await sleep(150); // レート制限対策
  }

  // 地図用 GeoJSON 出力（Google API で住所ごとに座標が得られるため同一座標の振り分けは行わない）
  const geojson = { type: 'FeatureCollection', features };
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(geojson, null, 2), 'utf-8');
  console.log('Wrote', OUT_FILE, '(points:', features.length, ')');

  // 特定方法・正確性・備考の一覧を出力（画面表示用）
  fs.writeFileSync(STATUS_FILE, JSON.stringify(statusList, null, 2), 'utf-8');
  console.log('Wrote', STATUS_FILE, '(list:', statusList.length, ')');
  if (skipped > 0) console.log('位置が特定できずプロットしない件数:', skipped);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
