const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#17255f"/><stop offset=".52" stop-color="#3a36a3"/><stop offset="1" stop-color="#7b42d8"/></linearGradient>
  <linearGradient id="bridge" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#8de8ff"/><stop offset=".5" stop-color="#ffffff"/><stop offset="1" stop-color="#d2b4ff"/></linearGradient>
  <filter id="shadow" x="-.3" y="-.3" width="1.6" height="1.6"><feGaussianBlur stdDeviation="18"/></filter>
  <clipPath id="clip"><rect x="28" y="28" width="968" height="968" rx="224"/></clipPath>
</defs>
<rect x="28" y="28" width="968" height="968" rx="224" fill="url(#bg)"/>
<g clip-path="url(#clip)"><circle cx="790" cy="190" r="230" fill="#a77bff" opacity=".18"/>
<path d="M188 674C310 384 714 384 836 674" fill="none" stroke="#0a1248" stroke-width="54" opacity=".32" filter="url(#shadow)"/>
<path d="M174 670C296 380 728 380 850 670" fill="none" stroke="url(#bridge)" stroke-width="48" stroke-linecap="round"/>
<path d="M224 694V562M800 694V562" stroke="url(#bridge)" stroke-width="48" stroke-linecap="round"/>
<circle cx="174" cy="670" r="42" fill="#8de8ff"/><circle cx="850" cy="670" r="42" fill="#d2b4ff"/>
<path d="M294 720h436" stroke="#fff" stroke-width="28" stroke-linecap="round" opacity=".9"/>
<path d="M368 284 286 364l82 80M656 284l82 80-82 80" fill="none" stroke="#fff" stroke-width="34" stroke-linecap="round" stroke-linejoin="round" opacity=".95"/>
<circle cx="512" cy="206" r="20" fill="#8de8ff"/><circle cx="512" cy="206" r="42" fill="none" stroke="#8de8ff" stroke-opacity=".28" stroke-width="12"/>
</g>
</svg>`;
const template = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none"><path d="M4 23C7 10 25 10 28 23" stroke="#fff" stroke-width="2.8" stroke-linecap="round"/><path d="M6 24V18M26 24V18M8 25h16" stroke="#fff" stroke-width="2.8" stroke-linecap="round"/><path d="m12 6-3 3 3 3M20 6l3 3-3 3" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
async function image(source, size) { return sharp(Buffer.from(source)).resize(size, size).png().toBuffer(); }
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  for (const [index, item] of images.entries()) {
    const at = 6 + index * 16; const dimension = item.size === 256 ? 0 : item.size;
    header.writeUInt8(dimension, at); header.writeUInt8(dimension, at + 1); header.writeUInt8(0, at + 2); header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6); header.writeUInt32LE(item.data.length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += item.data.length;
  }
  return Buffer.concat([header, ...images.map(item => item.data)]);
}
(async () => {
  fs.writeFileSync(path.join(root, 'desktop', 'codex-model-bridge.svg'), svg);
  fs.writeFileSync(path.join(root, 'desktop', 'icon.png'), await image(svg, 1024));
  const iconImages = [];
  for (const size of [16, 24, 32, 48, 64, 128, 256]) iconImages.push({ size, data: await image(svg, size) });
  fs.writeFileSync(path.join(root, 'desktop', 'codex-model-bridge.ico'), ico(iconImages));
  fs.writeFileSync(path.join(root, 'desktop', 'tray.png'), await image(template, 32));
  fs.writeFileSync(path.join(root, 'desktop', 'trayTemplate.png'), await image(template, 16));
  fs.writeFileSync(path.join(root, 'desktop', 'trayTemplate@2x.png'), await image(template, 32));
  fs.writeFileSync(path.join(root, 'desktop', 'trayTemplate.svg'), template);
})().catch(error => { console.error(error); process.exitCode = 1; });
