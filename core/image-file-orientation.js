'use strict';

// Read only the JPEG APP1/TIFF orientation field. Bounds are checked against
// the segment, so malformed camera metadata cannot escape into the decoder.
function jpegOrientation(bytes) {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) break;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset), end = offset + length;
    if (length < 2 || end > bytes.length) break;
    const start = offset + 2;
    offset = end;
    if (marker !== 0xe1 || bytes.toString('ascii', start, start + 6) !== 'Exif\0\0') continue;
    const tiff = start + 6;
    if (tiff + 8 > end) continue;
    const order = bytes.toString('ascii', tiff, tiff + 2);
    if (order !== 'II' && order !== 'MM') continue;
    const u16 = p => order === 'II' ? bytes.readUInt16LE(p) : bytes.readUInt16BE(p);
    const u32 = p => order === 'II' ? bytes.readUInt32LE(p) : bytes.readUInt32BE(p);
    if (u16(tiff + 2) !== 42) continue;
    const ifd = tiff + u32(tiff + 4);
    if (ifd < tiff + 8 || ifd + 2 > end) continue;
    const count = u16(ifd);
    for (let p = ifd + 2, n = 0; n < count && p + 12 <= end; n++, p += 12) {
      if (u16(p) !== 0x0112 || u16(p + 2) !== 3 || u32(p + 4) !== 1) continue;
      const value = u16(p + 8);
      if (value >= 1 && value <= 8) return { value, offset: p + 8, littleEndian: order === 'II' };
    }
  }
  return null;
}

function decodeImageFile(nativeImage, bytes) {
  const orientation = jpegOrientation(bytes);
  let source = bytes;
  if (orientation && orientation.value !== 1) {
    // Decode unrotated on every OS, then apply orientation exactly once.
    source = Buffer.from(bytes);
    if (orientation.littleEndian) source.writeUInt16LE(1, orientation.offset);
    else source.writeUInt16BE(1, orientation.offset);
  }
  const image = nativeImage.createFromBuffer(source, { scaleFactor: 1 });
  if (image.isEmpty() || !orientation || orientation.value === 1) return image;
  const { width, height } = image.getSize();
  const swapped = orientation.value >= 5;
  const outWidth = swapped ? height : width, outHeight = swapped ? width : height;
  const bitmap = image.toBitmap(), rotated = Buffer.alloc(bitmap.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let dx = x, dy = y;
    switch (orientation.value) {
      case 2: dx = width - 1 - x; break;
      case 3: dx = width - 1 - x; dy = height - 1 - y; break;
      case 4: dy = height - 1 - y; break;
      case 5: dx = y; dy = x; break;
      case 6: dx = height - 1 - y; dy = x; break;
      case 7: dx = height - 1 - y; dy = width - 1 - x; break;
      case 8: dx = y; dy = width - 1 - x; break;
    }
    const from = (y * width + x) * 4, to = (dy * outWidth + dx) * 4;
    rotated.writeUInt32LE(bitmap.readUInt32LE(from), to);
  }
  return nativeImage.createFromBitmap(rotated, { width: outWidth, height: outHeight, scaleFactor: 1 });
}

module.exports = { jpegOrientation, decodeImageFile };
