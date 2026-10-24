import { inflateSync } from "node:zlib";

export interface RgbImage {
  width: number;
  height: number;
  /** Packed 8-bit RGB, row-major. */
  rgb: Buffer;
}

/**
 * Decodes an 8-bit RGB (colour type 2) or RGBA (6, alpha dropped) non-interlaced
 * PNG, which is what `ffmpeg -pix_fmt rgb24 frame.png` writes. Throws on anything else.
 */
export function decodePng(png: Buffer): RgbImage {
  if (png.length < 33 || !png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error("not a PNG file");
  let off = 8;
  let width = 0;
  let height = 0;
  let channels = 3;
  const idat: Buffer[] = [];
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("latin1", off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0 || (data[9] !== 2 && data[9] !== 6)) throw new Error("only 8-bit RGB/RGBA non-interlaced PNGs are supported");
      channels = data[9] === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (!width || !height || !idat.length) throw new Error("PNG has no image data");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error("PNG image data is truncated");
  const cur = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!;
      const a = x >= channels ? cur[row + x - channels]! : 0;
      const b = y > 0 ? cur[row - stride + x]! : 0;
      const c = x >= channels && y > 0 ? cur[row - stride + x - channels]! : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new Error(`invalid PNG filter type ${f}`);
      cur[row + x] = (v + pred) & 0xff;
    }
  }
  if (channels === 3) return { width, height, rgb: cur };
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < cur.length; i += 4, j += 3) {
    rgb[j] = cur[i]!;
    rgb[j + 1] = cur[i + 1]!;
    rgb[j + 2] = cur[i + 2]!;
  }
  return { width, height, rgb };
}
