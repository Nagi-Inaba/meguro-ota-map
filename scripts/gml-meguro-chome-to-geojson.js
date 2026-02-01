/**
 * GML → 目黒区町丁ポリゴン GeoJSON
 * 国土地理院の境界データのみからポリゴンを作成。分割は行わない。
 * 町丁名は CommPt（地名点）が含まれるポリゴンに付与。
 *
 * 【重要】町丁の境目について
 * - 町丁同士を合体・マージすることは一切しない。1ポリゴン＝1フィーチャのまま出力する。
 * - 同じ町丁名が複数ポリゴンに付いていても、それらを union して1つにまとめることはしない。
 * - 町丁の境目は必ず境界データ（CommBdry/AdmBdry）の線で表現する。隙間は「境界データなし」として別出力するのみ。
 *
 * 境界データ（全件使用）:
 * - CommBdry: 大字・町・丁目界, 町村・指定都市の区界, 郡市・東京都の区界, 都道府県界（4種）
 * - AdmBdry:  市区町村界, 町村・指定都市の区界, 郡市・東京都の区界, 都道府県界（4種）
 * - AdmArea:  目黒区(13110) 外周を線分化して追加
 * - SBBdry:   街区境界（町丁より細かいため未使用）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import Polygonizer from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js';
import intersect from '@turf/intersect';
import union from '@turf/union';
import difference from '@turf/difference';
import area from '@turf/area';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { lineString, polygon as turfPolygon, point, featureCollection } from '@turf/helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GML_DIR = path.join(__dirname, '..', 'FG-GML-533935-ALL-20260101');
const OUT_DIR = path.join(__dirname, '..', 'geojson');

function posListToCoords(posListText) {
  const nums = posListText.trim().split(/\s+/).map(Number);
  const coords = [];
  for (let i = 0; i < nums.length; i += 2) {
    const lat = nums[i];
    const lng = nums[i + 1];
    if (lat !== undefined && lng !== undefined) coords.push([lng, lat]);
  }
  return coords;
}

function dedupeCoords(coords) {
  if (coords.length <= 1) return coords;
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const a = out[out.length - 1];
    const b = coords[i];
    if (a[0] !== b[0] || a[1] !== b[1]) out.push(b);
  }
  return out;
}

// 境界線の端点は CommBdry/AdmBdry で数mずれることがある。町丁は合体させない。
// 線の内側は約1.1mグリッド、端点だけ約5mグリッドで揃えて「同じ境目」をつなぐ（境目は必ずある前提）。
const SNAP_INTERIOR = 5; // 約1.1m（内側のずれ防止）
const SNAP_ENDPOINT_DEG = 0.00005; // 約5.5m（端点のみ・閉じた輪用）
function snapCoordInterior(c) {
  const f = Math.pow(10, SNAP_INTERIOR);
  return [Math.round(c[0] * f) / f, Math.round(c[1] * f) / f];
}
function snapEndpoint(c) {
  return [
    Math.round(c[0] / SNAP_ENDPOINT_DEG) * SNAP_ENDPOINT_DEG,
    Math.round(c[1] / SNAP_ENDPOINT_DEG) * SNAP_ENDPOINT_DEG,
  ];
}
function snapLineStrings(lineStrings) {
  const out = [];
  for (const ls of lineStrings) {
    const raw = ls.geometry.coordinates.map(snapCoordInterior);
    if (raw.length >= 2) {
      raw[0] = snapEndpoint(raw[0]);
      raw[raw.length - 1] = snapEndpoint(raw[raw.length - 1]);
    }
    const coords = dedupeCoords(raw);
    if (coords.length >= 2) out.push(lineString(coords));
  }
  return out;
}

function parseBdryFile(filePath, tagName, allowedTypes) {
  const xml = fs.readFileSync(filePath, 'utf-8');
  const lineStrings = [];
  const blockRegex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'g');
  let block;
  while ((block = blockRegex.exec(xml)) !== null) {
    const inner = block[1];
    const typeMatch = inner.match(/<type>([\s\S]*?)<\/type>/);
    const type = typeMatch ? typeMatch[1].trim() : '';
    if (!allowedTypes.some((t) => type.includes(t))) continue;
    const posListRegex = /<gml:posList>([\s\S]*?)<\/gml:posList>/g;
    let pl;
    while ((pl = posListRegex.exec(inner)) !== null) {
      const pos = pl[1].trim();
      if (!pos) continue;
      let coords = posListToCoords(pos);
      coords = dedupeCoords(coords);
      if (coords.length >= 2) lineStrings.push(lineString(coords));
    }
  }
  return lineStrings;
}

const MEGURO_ADM_CODE = '13110';

function parseAdmAreaAll(filePath) {
  const xml = fs.readFileSync(filePath, 'utf-8');
  const blockRegex = /<AdmArea[^>]*>([\s\S]*?)<\/AdmArea>/g;
  const result = [];
  let block;
  while ((block = blockRegex.exec(xml)) !== null) {
    const inner = block[1];
    const codeMatch = inner.match(/<admCode>(\d+)<\/admCode>/);
    const nameMatch = inner.match(/<name>([\s\S]*?)<\/name>/);
    const admCode = codeMatch ? codeMatch[1] : '';
    const name = nameMatch ? nameMatch[1].trim() : admCode;
    const exteriorMatch = inner.match(/<gml:exterior>([\s\S]*?)<\/gml:exterior>/);
    const exteriorInner = exteriorMatch ? exteriorMatch[1] : inner;
    const posListRegex = /<gml:posList>([\s\S]*?)<\/gml:posList>/g;
    let pl;
    const allCoords = [];
    while ((pl = posListRegex.exec(exteriorInner)) !== null) {
      if (!pl[1]) continue;
      const c = posListToCoords(pl[1].trim());
      if (c.length >= 2) allCoords.push(...c);
    }
    if (allCoords.length < 3) continue;
    let coords = dedupeCoords(allCoords);
    if (coords.length < 3) continue;
    if (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) {
      coords.push(coords[0].slice());
    }
    result.push({ admCode, name, polygon: turfPolygon([coords]) });
  }
  return result;
}

function polygonCentroid(feature) {
  const coords = feature.geometry?.coordinates?.[0];
  if (!coords || !coords.length) return null;
  let sumLng = 0, sumLat = 0, n = 0;
  for (const c of coords) {
    sumLng += c[0];
    sumLat += c[1];
    n++;
  }
  return n ? [sumLng / n, sumLat / n] : null;
}

function distSq(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function parseCommPtMeguro(filePath) {
  const xml = fs.readFileSync(filePath, 'utf-8');
  const result = [];
  const blockRegex = /<CommPt[^>]*>([\s\S]*?)<\/CommPt>/g;
  let block;
  while ((block = blockRegex.exec(xml)) !== null) {
    const inner = block[1];
    if (!inner.includes('<admCode>13110</admCode>')) continue;
    const nameMatch = inner.match(/<name>([\s\S]*?)<\/name>/);
    const posMatch = inner.match(/<gml:pos>([\s\S]*?)<\/gml:pos>/);
    if (!nameMatch || !posMatch) continue;
    const name = nameMatch[1].trim();
    const nums = posMatch[1].trim().split(/\s+/).map(Number);
    if (nums.length < 2) continue;
    const lat = nums[0];
    const lng = nums[1];
    result.push({ name, lng, lat });
  }
  return result;
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const commBdryPath = path.join(GML_DIR, 'FG-GML-533935-CommBdry-20260101-0001.xml');
const admBdryPath = path.join(GML_DIR, 'FG-GML-533935-AdmBdry-20260101-0001.xml');
const admAreaPath = path.join(GML_DIR, 'FG-GML-533935-AdmArea-20260101-0001.xml');
const commPtPath = path.join(GML_DIR, 'FG-GML-533935-CommPt-20260101-0001.xml');

console.log('Parsing AdmArea (全区域)...');
const admAreaAll = parseAdmAreaAll(admAreaPath);
const meguroPoly = admAreaAll.find((a) => a.admCode === MEGURO_ADM_CODE)?.polygon || null;
if (!meguroPoly) {
  console.error('Meguro AdmArea (13110) not found.');
  process.exit(1);
}
const otherWards = admAreaAll.filter((a) => a.admCode !== MEGURO_ADM_CODE);
console.log('  目黒区(13110) + 他区:', otherWards.length, 'areas');

// 境界データ全件: CommBdry は4種、AdmBdry は4種。SBBdry(街区境界)は町丁より細かいため未使用。
const commBdryTypes = ['大字・町・丁目界', '町村・指定都市の区界', '郡市・東京都の区界', '都道府県界'];
let lineStrings = parseBdryFile(commBdryPath, 'CommBdry', commBdryTypes);
console.log('Parsing CommBdry (全4種):', lineStrings.length, 'lineStrings');
const admBdryTypes = ['市区町村界', '町村・指定都市の区界', '郡市・東京都の区界', '都道府県界'];
const admBdryLines = parseBdryFile(admBdryPath, 'AdmBdry', admBdryTypes);
lineStrings = lineStrings.concat(admBdryLines);
console.log('Parsing AdmBdry (全4種):', admBdryLines.length, 'lineStrings, total:', lineStrings.length);

if (meguroPoly?.geometry?.coordinates?.[0]) {
  const ring = meguroPoly.geometry.coordinates[0].map(snapCoordToGrid);
  for (let i = 0; i < ring.length - 1; i++) lineStrings.push(lineString([ring[i], ring[i + 1]]));
  console.log('  Added Meguro boundary segments:', ring.length - 1);
}
lineStrings = snapLineStrings(lineStrings);

console.log('Polygonizing (JSTS)...');
const reader = new GeoJSONReader();
const writer = new GeoJSONWriter();
const polygonizer = new Polygonizer();
for (const ls of lineStrings) {
  const jstsGeom = reader.read(ls.geometry);
  if (jstsGeom) polygonizer.add(jstsGeom);
}
const jstsPolys = polygonizer.getPolygons();
const polygons = { type: 'FeatureCollection', features: [] };
for (let i = 0; i < jstsPolys.size(); i++) {
  const poly = jstsPolys.get(i);
  const geom = writer.write(poly);
  if (geom?.coordinates?.[0]?.length >= 4) {
    polygons.features.push({ type: 'Feature', properties: {}, geometry: geom });
  }
}
if (!polygons.features.length) {
  console.error('No polygons from polygonize.');
  process.exit(1);
}
console.log('  Raw polygons:', polygons.features.length);

console.log('Clipping to Meguro boundary...');
let clipped = [];
const meguroArea = meguroPoly?.geometry ? area(meguroPoly) : 0;
for (const f of polygons.features) {
  const inter = intersect(featureCollection([f, meguroPoly]));
  if (inter?.geometry?.coordinates?.length) {
    if (meguroArea > 0 && area(inter) > meguroArea * 0.9) continue;
    clipped.push(inter);
  }
}
console.log('  Clipped polygons:', clipped.length);

console.log('Parsing CommPt (目黒区 13110)...');
const commPts = parseCommPtMeguro(commPtPath);
console.log('  CommPt count:', commPts.length);

// 国土地理院の境界データから得たポリゴンのみ使用。分割は行わない。
console.log('Assigning 町丁 names (polygon contains CommPt)...');
const polygonCentroids = clipped.map((f) => polygonCentroid(f));
const polygonToPt = new Map();
const assignedPts = new Set();

for (let i = 0; i < clipped.length; i++) {
  const f = clipped[i];
  const ptsInside = commPts.filter((pt) => booleanPointInPolygon(point([pt.lng, pt.lat]), f));
  if (ptsInside.length === 1) {
    polygonToPt.set(i, ptsInside[0]);
    assignedPts.add(ptsInside[0]);
  } else if (ptsInside.length >= 2) {
    const cen = polygonCentroids[i];
    if (cen) {
      let bestPt = ptsInside[0];
      let bestD = distSq(cen, [bestPt.lng, bestPt.lat]);
      for (let k = 1; k < ptsInside.length; k++) {
        const d = distSq(cen, [ptsInside[k].lng, ptsInside[k].lat]);
        if (d < bestD) {
          bestD = d;
          bestPt = ptsInside[k];
        }
      }
      polygonToPt.set(i, bestPt);
      assignedPts.add(bestPt);
    } else {
      polygonToPt.set(i, ptsInside[0]);
      assignedPts.add(ptsInside[0]);
    }
  }
}

let unassignedCount = 0;
for (let i = 0; i < clipped.length; i++) {
  if (polygonToPt.has(i)) continue;
  const cen = polygonCentroids[i];
  if (!cen) continue;
  let bestPt = null;
  let bestD = Infinity;
  for (const pt of commPts) {
    if (assignedPts.has(pt)) continue;
    const d = distSq(cen, [pt.lng, pt.lat]);
    if (d < bestD) {
      bestD = d;
      bestPt = pt;
    }
  }
  if (bestPt) {
    polygonToPt.set(i, bestPt);
    assignedPts.add(bestPt);
    unassignedCount++;
  }
}
if (unassignedCount > 0) console.log('  Polygons with no CommPt inside, assigned nearest unassigned:', unassignedCount);

const named = [];
for (let i = 0; i < clipped.length; i++) {
  const pt = polygonToPt.get(i);
  named.push({
    type: 'Feature',
    properties: { name: pt ? pt.name : '' },
    geometry: clipped[i].geometry,
  });
}

// 町丁は合体させず、1ポリゴン1フィーチャのまま出力。町丁の境目は境界データで必ず存在する。隙間は「境界データなし」として別ファイルで出力。
fs.writeFileSync(path.join(OUT_DIR, 'meguro-chome-areas.json'), JSON.stringify({ type: 'FeatureCollection', features: named }, null, 0), 'utf-8');
console.log('Wrote geojson/meguro-chome-areas.json');

if (meguroPoly?.geometry) {
  fs.writeFileSync(path.join(OUT_DIR, 'meguro-boundary.json'), JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: '目黒区' }, geometry: meguroPoly.geometry }] }, null, 0), 'utf-8');
  console.log('Wrote geojson/meguro-boundary.json');
  const otherWardsGeoJSON = { type: 'FeatureCollection', features: otherWards.map((a) => ({ type: 'Feature', properties: { admCode: a.admCode, name: a.name || a.admCode }, geometry: a.polygon.geometry })) };
  fs.writeFileSync(path.join(OUT_DIR, 'adjacent-wards-boundaries.json'), JSON.stringify(otherWardsGeoJSON, null, 0), 'utf-8');
  console.log('Wrote geojson/adjacent-wards-boundaries.json (他区境界):', otherWards.length);

  // 隙間（境界データなし区域）の算出のみ。※町丁を合体しているわけではない。
  let gapFeatures = [];
  if (named.length > 0) {
    let unionPoly = named.length === 1 ? named[0] : union(featureCollection(named));
    if (!unionPoly?.geometry) unionPoly = named[0];
    const gap = difference(featureCollection([meguroPoly, unionPoly]));
    if (gap?.geometry?.coordinates && area(gap) > 1e-6) {
      const coords = gap.geometry.coordinates;
      if (gap.geometry.type === 'Polygon') {
        gapFeatures.push({ type: 'Feature', properties: { name: '境界データなし' }, geometry: { type: 'Polygon', coordinates: coords } });
      } else if (gap.geometry.type === 'MultiPolygon') {
        for (const ring of coords) gapFeatures.push({ type: 'Feature', properties: { name: '境界データなし' }, geometry: { type: 'Polygon', coordinates: ring } });
      }
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'meguro-gaps.json'), JSON.stringify({ type: 'FeatureCollection', features: gapFeatures }, null, 0), 'utf-8');
  console.log('Wrote geojson/meguro-gaps.json (境界データなし区域):', gapFeatures.length);
}

fs.writeFileSync(path.join(OUT_DIR, 'comm-pt-meguro.json'), JSON.stringify(commPts.map((p) => ({ name: p.name, lng: p.lng, lat: p.lat })), null, 2), 'utf-8');
console.log('Wrote geojson/comm-pt-meguro.json');
