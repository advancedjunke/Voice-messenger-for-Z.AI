import fs from 'fs';
import path from 'path';

const pngBuffer = fs.readFileSync('assets/icon-256.png');
const pngLength = pngBuffer.length;

// Windows ICO Header (6 bytes)
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // Reserved
header.writeUInt16LE(1, 2); // Type 1 = Icon
header.writeUInt16LE(1, 4); // 1 Image

// ICO Directory Entry (16 bytes)
const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0); // Width 0 = 256px
entry.writeUInt8(0, 1); // Height 0 = 256px
entry.writeUInt8(0, 2); // Colors
entry.writeUInt8(0, 3); // Reserved
entry.writeUInt16LE(1, 4); // Planes
entry.writeUInt16LE(32, 6); // Bits per pixel
entry.writeUInt32LE(pngLength, 8); // Size of image data
entry.writeUInt32LE(22, 12); // Offset (6 + 16 = 22)

const icoBuffer = Buffer.concat([header, entry, pngBuffer]);
fs.writeFileSync('assets/icon.ico', icoBuffer);
console.log('Successfully created assets/icon.ico! Size:', icoBuffer.length);
