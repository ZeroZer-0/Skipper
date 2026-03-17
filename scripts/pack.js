// scripts/pack.js — cross-platform pack script for Chrome and Firefox
// Usage: node scripts/pack.js chrome | node scripts/pack.js firefox
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');

const target = process.argv[2];
if (target !== 'chrome' && target !== 'firefox') {
  console.error('Usage: node scripts/pack.js chrome|firefox');
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
const outFile = path.join(root, `skipper-4.0.0-${target}.zip`);
const manifestSrc = target === 'firefox'
  ? path.join(root, 'manifest.firefox.json')
  : path.join(root, 'manifest.json');

const output = fs.createWriteStream(outFile);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => console.log(`✓ ${path.basename(outFile)} (${archive.pointer()} bytes)`));
archive.on('error', err => { throw err; });
archive.pipe(output);

// Always include manifest.json (from the correct source file)
archive.file(manifestSrc, { name: 'manifest.json' });

// Shared files and folders
for (const entry of ['background.js', 'sites.json']) {
  archive.file(path.join(root, entry), { name: entry });
}
for (const dir of ['dist', 'popup', 'icons']) {
  archive.directory(path.join(root, dir), dir);
}

archive.finalize();
