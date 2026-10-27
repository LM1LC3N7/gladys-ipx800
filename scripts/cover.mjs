// Generates cover.png (800x534) for gladys-ipx800: plain Node, no dependency.
// A generic controller box on a DIN rail with its relay lights and network
// port, a radiator fed by a pilot wire, a light bulb on a relay, on a warm
// gradient (no brand logo).
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
const skyAt = (x, y) => {
  const t = (x / W) * 0.6 + (y / H) * 0.4;
  return [245 - 60 * t, 200 - 90 * t, 120 - 60 * t];
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    set(x, y, skyAt(x, y));
  }
}
const white = [255, 255, 255];
const dark = [50, 40, 40];
const red = [220, 70, 60];
const green = [90, 190, 120];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};

// A DIN rail with a controller box: terminals on top and bottom, a row of
// relay lights, a network port.
box(40, 150, 760, 170, 4, [200, 200, 205]);
box(80, 80, 420, 260, 14, white);
for (let k = 0; k < 8; k += 1) {
  box(100 + k * 40, 92, 128 + k * 40, 116, 4, [120, 120, 130]);
  box(100 + k * 40, 224, 128 + k * 40, 248, 4, [120, 120, 130]);
  disc(114 + k * 40, 150, 9, k % 3 === 0 ? green : [200, 210, 200]);
}
box(330, 170, 400, 210, 4, dark);
// An electric radiator fed by a pilot wire (a dashed line).
box(480, 300, 740, 470, 14, white);
for (let k = 0; k < 7; k += 1) box(505 + k * 33, 320, 525 + k * 33, 450, 6, [235, 235, 240]);
for (let y = 260; y < 300; y += 14) line(250, y, 250, y + 8, 5, red);
for (let x = 250; x < 480; x += 16) line(x, 300, x + 8, 300, 5, red);
// A light bulb on a relay.
disc(150, 390, 50, [255, 235, 140]);
box(130, 435, 170, 470, 6, [150, 150, 160]);
line(150, 260, 150, 340, 5, dark);
// The network cable.
line(365, 210, 365, 290, 6, dark);
line(365, 290, 420, 290, 6, dark);

disc(400, 267, 300, white, 0.04);

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
