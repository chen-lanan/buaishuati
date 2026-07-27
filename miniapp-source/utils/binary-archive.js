const fileUtil = require('./file');

const MAGIC_TEXT = 'BUAIARCH2\n';

function utf8Encode(text) {
  const value = String(text || '');
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value);
  const binary = unescape(encodeURIComponent(value));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function utf8Decode(bytes) {
  if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(bytes);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)));
  }
  return decodeURIComponent(escape(binary));
}

function base64ToBytes(base64) {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  const chunks = [];
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    chunks.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step))));
  }
  return btoa(chunks.join(''));
}

function writeUint32(view, offset, value) {
  view.setUint32(offset, Number(value) >>> 0, true);
  return offset + 4;
}

function readUint32(view, offset) {
  if (offset + 4 > view.byteLength) throw new Error('备份文件结构不完整');
  return view.getUint32(offset, true);
}

function createArchive(target, metadata, entries = []) {
  const magic = utf8Encode(MAGIC_TEXT);
  const metaBytes = utf8Encode(JSON.stringify(metadata));
  const normalized = entries.map(entry => {
    const nameBytes = utf8Encode(entry.name);
    const size = Number(fileUtil.fs.statSync(entry.path).size || 0);
    if (size < 0 || size > 0xffffffff) throw new Error(`资源文件过大：${entry.name}`);
    return { ...entry, nameBytes, size };
  });
  let total = magic.length + 4 + metaBytes.length + 4;
  normalized.forEach(entry => { total += 4 + entry.nameBytes.length + 4 + entry.size; });
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  let offset = 0;
  output.set(magic, offset); offset += magic.length;
  offset = writeUint32(view, offset, metaBytes.length);
  output.set(metaBytes, offset); offset += metaBytes.length;
  offset = writeUint32(view, offset, normalized.length);
  normalized.forEach(entry => {
    offset = writeUint32(view, offset, entry.nameBytes.length);
    output.set(entry.nameBytes, offset); offset += entry.nameBytes.length;
    offset = writeUint32(view, offset, entry.size);
    const bytes = base64ToBytes(fileUtil.readBase64(entry.path));
    if (bytes.length !== entry.size) throw new Error(`资源读取长度不一致：${entry.name}`);
    output.set(bytes, offset); offset += bytes.length;
  });
  if (offset !== output.length) throw new Error('备份文件长度校验失败');
  fileUtil.writeBase64(target, bytesToBase64(output));
  return target;
}

function readArchive(path) {
  const bytes = base64ToBytes(fileUtil.readBase64(path));
  const magic = utf8Encode(MAGIC_TEXT);
  if (bytes.length < magic.length || magic.some((value, index) => bytes[index] !== value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = magic.length;
  const metaLength = readUint32(view, offset); offset += 4;
  if (offset + metaLength > bytes.length) throw new Error('备份清单长度异常');
  const metadata = JSON.parse(utf8Decode(bytes.subarray(offset, offset + metaLength)));
  offset += metaLength;
  const count = readUint32(view, offset); offset += 4;
  const entries = {};
  for (let index = 0; index < count; index += 1) {
    const nameLength = readUint32(view, offset); offset += 4;
    if (offset + nameLength > bytes.length) throw new Error('备份资源名称长度异常');
    const name = utf8Decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    const dataLength = readUint32(view, offset); offset += 4;
    if (offset + dataLength > bytes.length) throw new Error(`备份资源不完整：${name}`);
    entries[name] = bytes.subarray(offset, offset + dataLength);
    offset += dataLength;
  }
  if (offset !== bytes.length) throw new Error('备份文件尾部存在异常数据');
  return { metadata, entries };
}

function writeBytes(path, bytes) {
  fileUtil.writeBase64(path, bytesToBase64(bytes));
}

module.exports = {
  createArchive,
  readArchive,
  writeBytes,
  utf8Encode,
  utf8Decode,
  base64ToBytes,
  bytesToBase64
};
