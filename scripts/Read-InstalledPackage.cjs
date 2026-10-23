const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const unpacked = path.join(root, 'resources', 'app', 'package.json');
const archive = path.join(root, 'resources', 'app.asar');
let metadata;
if (fs.existsSync(unpacked)) metadata = JSON.parse(fs.readFileSync(unpacked, 'utf8'));
else if (fs.existsSync(archive)) {
  const asar = require(require.resolve('@electron/asar', { paths: [path.dirname(require.resolve('app-builder-lib/package.json'))] }));
  metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
} else { console.log('null'); process.exit(0); }
const names = [...new Set([metadata.name, metadata.productName, metadata.build?.productName].filter(v => typeof v === 'string' && /^[a-z0-9][a-z0-9 ._-]{0,80}$/i.test(v)))];
console.log(JSON.stringify({ version: metadata.version, name: metadata.name, userDataNames: names, layout: fs.existsSync(unpacked) ? 'unpacked' : 'asar' }));
