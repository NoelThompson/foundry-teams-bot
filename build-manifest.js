const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = zlib.crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makeSolidPng(width, height, r, g, b, a = 255) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowLen = width * 4;
  const raw = Buffer.alloc(height * (rowLen + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (rowLen + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = a;
    }
  }
  const compressed = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const manifestDir = path.join(__dirname, 'manifest');

const color = makeSolidPng(192, 192, 0, 125, 193);
fs.writeFileSync(path.join(manifestDir, 'color.png'), color);

const outline = makeSolidPng(32, 32, 255, 255, 255);
fs.writeFileSync(path.join(manifestDir, 'outline.png'), outline);

console.log('Wrote', path.join(manifestDir, 'color.png'), `(${color.length} bytes)`);
console.log('Wrote', path.join(manifestDir, 'outline.png'), `(${outline.length} bytes)`);
