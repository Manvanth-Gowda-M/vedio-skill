import { crc32, deflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** Relative POSIX path within the zip archive (no leading slash or traversal). */
  path: string;
  data: Uint8Array;
  /** Optional modification date (default: fixed deterministic timestamp 2026-01-01T00:00:00Z for reproducibility). */
  date?: Date;
}

/**
 * Creates a standard, cross-platform, deterministic ZIP archive from entries.
 * Zero external dependencies: uses Node's built-in zlib.
 */
export function createZipArchive(entries: readonly ZipEntry[]): Buffer {
  // Sort entries for deterministic output
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of sorted) {
    const cleanPath = entry.path.replace(/\\/g, "/").replace(/^\/+/, "");
    if (cleanPath.split("/").includes("..")) {
      throw new Error(`Invalid zip entry path containing traversal: ${entry.path}`);
    }
    const nameBytes = Buffer.from(cleanPath, "utf8");
    const uncompressed = Buffer.from(entry.data);
    const uncompressedSize = uncompressed.length;
    const checksum = crc32(uncompressed);

    // Deflate compression
    const compressed = deflateRawSync(uncompressed);
    const useDeflate = compressed.length < uncompressedSize;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? compressed : uncompressed;
    const compressedSize = payload.length;

    const date = entry.date ?? new Date("2026-01-01T00:00:00Z");
    const dosTime =
      ((date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2)) & 0xffff;
    const dosDate =
      (((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()) & 0xffff;

    // Local file header (30 bytes + name)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed: 2.0
    localHeader.writeUInt16LE(0x0800, 6); // flags: UTF-8
    localHeader.writeUInt16LE(method, 8); // compression method
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(uncompressedSize, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field len

    localChunks.push(localHeader, nameBytes, payload);

    // Central directory header (46 bytes + name)
    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0); // signature
    cdHeader.writeUInt16LE(20, 4); // version made by
    cdHeader.writeUInt16LE(20, 6); // version needed
    cdHeader.writeUInt16LE(0x0800, 8); // flags: UTF-8
    cdHeader.writeUInt16LE(method, 10); // compression method
    cdHeader.writeUInt16LE(dosTime, 12);
    cdHeader.writeUInt16LE(dosDate, 14);
    cdHeader.writeUInt32LE(checksum, 16);
    cdHeader.writeUInt32LE(compressedSize, 20);
    cdHeader.writeUInt32LE(uncompressedSize, 24);
    cdHeader.writeUInt16LE(nameBytes.length, 28);
    cdHeader.writeUInt16LE(0, 30); // extra field len
    cdHeader.writeUInt16LE(0, 32); // comment len
    cdHeader.writeUInt16LE(0, 34); // disk number start
    cdHeader.writeUInt16LE(0, 36); // internal attr
    cdHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attr (regular file)
    cdHeader.writeUInt32LE(offset, 42); // relative offset of local header

    centralChunks.push(cdHeader, nameBytes);

    offset += 30 + nameBytes.length + compressedSize;
  }

  const centralOffset = offset;
  const centralBuffer = Buffer.concat(centralChunks);
  const centralSize = centralBuffer.length;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with CD
  eocd.writeUInt16LE(sorted.length, 8); // total entries on disk
  eocd.writeUInt16LE(sorted.length, 10); // total entries
  eocd.writeUInt32LE(centralSize, 12); // size of CD
  eocd.writeUInt32LE(centralOffset, 16); // offset of CD
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...localChunks, centralBuffer, eocd]);
}
