// node で official_blockmeta.json を作る(official_tables.html と同じ中身)
//   node tools/make_blockmeta_node.js <bloxd_models.zip を展開した js フォルダ> official_blockmeta.json
const fs = require('fs'), path = require('path');
const C = require('./blockmeta_core.js');
const acorn = require('./acorn.js');
const dir = process.argv[2], outPath = process.argv[3] || 'official_blockmeta.json';
const files = {};
for (const f of fs.readdirSync(dir)) if (f.endsWith('.js')) files[f] = fs.readFileSync(path.join(dir, f), 'utf8');
const map = C.makeModuleMap(files, acorn);
const j = C.runBlockMetadata(files, map);
const table = C.compactBlockMeta(j);
table.cosmetics = C.compactCosmetics(C.runCosmetics(files, map, C.runBlockMetadata.lastReq));
fs.writeFileSync(outPath, JSON.stringify(table));
console.log(`できました: ブロックの番号 ${Object.keys(table.ids).length} 個・着せかえ ${Object.keys(table.cosmetics).length} 個 → ${outPath}`);
