/**
 * 国交省等の境界データ（Shapefile）→ GeoJSON（大田区 13111）
 * A002005212020DDSWC13111-JGD2011/r2ka13111.* を読み、大田区町丁ポリゴンとして出力。
 * 座標系は JGD2011（.prj で WGS84 相当に変換される）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import shp from 'shpjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHP_DIR = path.join(__dirname, '..', 'A002005212020DDSWC13111-JGD2011');
const OUT_DIR = path.join(__dirname, '..', 'geojson');
const BASE = 'r2ka13111';

async function main() {
  const shpPath = path.join(SHP_DIR, `${BASE}.shp`);
  const dbfPath = path.join(SHP_DIR, `${BASE}.dbf`);
  const prjPath = path.join(SHP_DIR, `${BASE}.prj`);

  if (!fs.existsSync(shpPath)) {
    console.error('Shapefile not found:', shpPath);
    process.exit(1);
  }

  const object = {
    shp: fs.readFileSync(shpPath),
    dbf: fs.existsSync(dbfPath) ? fs.readFileSync(dbfPath) : undefined,
    prj: fs.existsSync(prjPath) ? fs.readFileSync(prjPath, 'utf-8') : undefined,
    cpg: 'Shift_JIS',
  };

  console.log('Reading shapefile (大田区):', BASE);
  const geojson = await shp(object);

  if (!geojson?.features?.length) {
    console.error('No features in shapefile.');
    process.exit(1);
  }

  console.log('Features:', geojson.features.length);
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'ota-shapefile-areas.json');
  fs.writeFileSync(outPath, JSON.stringify(geojson, null, 2), 'utf-8');
  console.log('Wrote', outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
