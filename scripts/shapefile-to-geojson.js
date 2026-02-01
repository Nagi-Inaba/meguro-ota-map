/**
 * 国交省等の境界データ（Shapefile）→ GeoJSON
 * A002005212020DDSWC13110-JGD2011/r2ka13110.* を読み、目黒区町丁ポリゴンとして出力。
 * 座標系は JGD2011（.prj で WGS84 相当に変換される）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import shp from 'shpjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHP_DIR = path.join(__dirname, '..', 'A002005212020DDSWC13110-JGD2011');
const OUT_DIR = path.join(__dirname, '..', 'geojson');
const BASE = 'r2ka13110';

async function main() {
  const shpPath = path.join(SHP_DIR, `${BASE}.shp`);
  const dbfPath = path.join(SHP_DIR, `${BASE}.dbf`);
  const prjPath = path.join(SHP_DIR, `${BASE}.prj`);

  if (!fs.existsSync(shpPath)) {
    console.error('Shapefile not found:', shpPath);
    process.exit(1);
  }

  // 国勢調査等の DBF は Shift_JIS(CP932) のことが多い。cpg でエンコーディング指定。
  const object = {
    shp: fs.readFileSync(shpPath),
    dbf: fs.existsSync(dbfPath) ? fs.readFileSync(dbfPath) : undefined,
    prj: fs.existsSync(prjPath) ? fs.readFileSync(prjPath, 'utf-8') : undefined,
    cpg: 'Shift_JIS', // 町丁名などが文字化けしないように指定
  };

  console.log('Reading shapefile:', BASE);
  const geojson = await shp(object);

  if (!geojson?.features?.length) {
    console.error('No features in shapefile.');
    process.exit(1);
  }

  console.log('Features:', geojson.features.length);
  const sample = geojson.features[0];
  if (sample?.properties && Object.keys(sample.properties).length > 0) {
    console.log('Sample properties:', sample.properties);
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'meguro-shapefile-areas.json');
  fs.writeFileSync(outPath, JSON.stringify(geojson, null, 2), 'utf-8');
  console.log('Wrote', outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
