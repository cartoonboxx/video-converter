const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'src');
const dist = path.join(__dirname, '..', 'dist');
fs.mkdirSync(dist, { recursive: true });
for (const file of ['index.html', 'styles.css']) {
  fs.copyFileSync(path.join(src, file), path.join(dist, file));
}
