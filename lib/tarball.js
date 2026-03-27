// Pure JS tar.gz builder for Cloudflare Workers runtime.
// Uses only Web Platform APIs: Uint8Array, TextEncoder, CompressionStream, Blob, btoa.

function encodeString(buf, offset, str, len) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  for (let i = 0; i < Math.min(bytes.length, len); i++) {
    buf[offset + i] = bytes[i];
  }
}

function concat(arrays) {
  let totalLen = 0;
  for (const a of arrays) totalLen += a.length;
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

export function buildTar(files) {
  const encoder = new TextEncoder();
  const chunks = [];

  for (const file of files) {
    const data = encoder.encode(file.content);
    const header = new Uint8Array(512);

    encodeString(header, 0, file.name, 100);
    encodeString(header, 100, '0000644', 8);   // mode
    encodeString(header, 108, '0001000', 8);   // uid
    encodeString(header, 116, '0001000', 8);   // gid
    encodeString(header, 124, data.length.toString(8).padStart(11, '0'), 12); // size
    encodeString(header, 136, Math.floor(Date.now() / 1000).toString(8).padStart(11, '0'), 12); // mtime
    encodeString(header, 156, '0', 1);         // typeflag (regular file)
    encodeString(header, 257, 'ustar', 6);     // magic
    encodeString(header, 263, '00', 2);        // version

    // Compute checksum (spaces in checksum field during calculation)
    let sum = 0;
    for (let i = 0; i < 512; i++) {
      sum += (i >= 148 && i < 156) ? 32 : header[i];
    }
    encodeString(header, 148, sum.toString(8).padStart(6, '0') + '\0 ', 8);

    chunks.push(header, data);
    const pad = 512 - (data.length % 512);
    if (pad < 512) chunks.push(new Uint8Array(pad));
  }

  // End-of-archive marker (two 512-byte zero blocks)
  chunks.push(new Uint8Array(1024));
  return concat(chunks);
}

export async function packAndEncode(files) {
  const tar = buildTar(files);
  const compressed = await new Response(
    new Blob([tar]).stream().pipeThrough(new CompressionStream('gzip'))
  ).arrayBuffer();
  const bytes = new Uint8Array(compressed);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
