import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { deflateSync } from "node:zlib";
import { colors } from "~/design/tokens";

// One-off generator for the brand-mark PNG embedded as a CID inline image
// in the digest email. Gmail strips inline <svg>, so we ship a pre-rasterized
// PNG of the same polygon shape as `src/components/landing/BrandMark.tsx`.
// Run once, commit the output:
//
//   pnpm tsx scripts/gen-brand-mark.ts
//
// No external image library — PNG is just deflate-compressed pixel rows
// with a filter byte per row, wrapped in IHDR/IDAT/IEND chunks. ~70 lines.

const OUTPUT_PATH = "src/emails/assets/brand-mark.png";

// 2x the on-screen 22px so it stays crisp on retina; the <img> tag caps
// display at 22×22.
const W = 44;
const H = 44;

// Same polygon coords as the CSS clip-path in the web BrandMark, scaled
// from the [0..100] basis to [0..W/H] pixels.
const POLY = [
  [45, 0],
  [100, 0],
  [55, 45],
  [100, 45],
  [0, 100],
  [45, 55],
  [0, 55],
].map(([x, y]) => [(x * W) / 100, (y * H) / 100] as [number, number]);

const FILL = parseHex(colors.accent); // [r, g, b, 255]
const TRANSPARENT: [number, number, number, number] = [0, 0, 0, 0];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

writePng(buildPng());
console.log(`wrote ${OUTPUT_PATH} (${W}×${H})`);

function buildPng(): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < H; y++) {
    const row = [0]; // PNG filter byte (0 = None)
    for (let x = 0; x < W; x++) {
      const pixel = inPolygon(x + 0.5, y + 0.5, POLY) ? FILL : TRANSPARENT;
      row.push(...pixel);
    }
    rows.push(Buffer.from(row));
  }
  const raw = Buffer.concat(rows);
  const compressed = deflateSync(raw);

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type = RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function inPolygon(px: number, py: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function parseHex(hex: string): [number, number, number, number] {
  const clean = hex.replace(/^#/, "");
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
    255,
  ];
}

function writePng(bytes: Buffer): void {
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, bytes);
}
