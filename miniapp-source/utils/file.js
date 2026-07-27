const fs = wx.getFileSystemManager();

function exists(path) {
  try {
    fs.accessSync(path);
    return true;
  } catch (error) {
    return false;
  }
}

function ensureDir(path) {
  if (exists(path)) return;
  const parent = path.slice(0, path.lastIndexOf('/'));
  if (parent && !exists(parent)) ensureDir(parent);
  try {
    fs.mkdirSync(path);
  } catch (error) {
    if (!exists(path)) throw error;
  }
}

function bytesFromBase64(value = '') {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index) & 255;
  return bytes;
}

function decodeBytes(bytes, label, fatal = false) {
  try {
    if (typeof TextDecoder === 'function') return new TextDecoder(label, { fatal }).decode(bytes);
  } catch (_) {}
  return '';
}

function textQuality(value = '') {
  const text = String(value || '');
  if (!text) return -100000;
  const replacement = (text.match(/\uFFFD/g) || []).length;
  const controls = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
  const mojibake = (text.match(/(?:Ã.|Â.|â€|ä¸|å[\x80-\xBF]|æ[\x80-\xBF]|ç[\x80-\xBF]|ï¿½)/g) || []).length;
  const printable = (text.match(/[\u0020-\u007E\u3000-\u9FFF\uF900-\uFAFF]/g) || []).length;
  return printable - replacement * 100 - controls * 30 - mojibake * 18;
}

function readText(path) {
  return fs.readFileSync(path, 'utf8');
}

function readTextAuto(path) {
  let bytes;
  try { bytes = bytesFromBase64(fs.readFileSync(path, 'base64')); }
  catch (_) { return readText(path); }
  if (!bytes.length) return '';
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return decodeBytes(bytes.subarray(3), 'utf-8') || readText(path);
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return decodeBytes(bytes.subarray(2), 'utf-16le') || readText(path);
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return decodeBytes(bytes.subarray(2), 'utf-16be') || readText(path);

  const header = String.fromCharCode.apply(null, bytes.subarray(0, Math.min(bytes.length, 240)));
  const declared = /<\?xml[^>]+encoding=["']([^"']+)["']/i.exec(header);
  if (declared) {
    const declaredText = decodeBytes(bytes, String(declared[1] || '').toLowerCase(), false);
    if (declaredText) return declaredText;
  }

  // UTF-8 has a strict byte grammar. Prefer a fatal UTF-8 decode whenever it succeeds;
  // otherwise Chinese UTF-8 text can be mis-scored as plausible GB18030 mojibake.
  const utf8 = decodeBytes(bytes, 'utf-8', true);
  if (utf8) return utf8;

  const labels = ['utf-16le', 'utf-16be', 'gb18030', 'windows-1252'];
  let best = '';
  let bestScore = -Infinity;
  Array.from(new Set(labels.map(item => String(item || '').toLowerCase()))).forEach(label => {
    const decoded = decodeBytes(bytes, label, label === 'utf-8');
    if (!decoded) return;
    const score = textQuality(decoded);
    if (score > bestScore) { best = decoded; bestScore = score; }
  });
  return best || readText(path);
}

function writeText(path, text) {
  const parent = path.slice(0, path.lastIndexOf('/'));
  ensureDir(parent);
  fs.writeFileSync(path, text, 'utf8');
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readText(path));
  } catch (error) {
    return fallback;
  }
}

function writeJson(path, data) {
  writeText(path, JSON.stringify(data));
}

function writeJsonAtomic(path, data) {
  const temp = `${path}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writeJson(temp, data);
  try {
    if (exists(path)) fs.unlinkSync(path);
    fs.copyFileSync(temp, path);
  } finally {
    if (exists(temp)) fs.unlinkSync(temp);
  }
}

function copyRecursive(source, target) {
  if (!exists(source)) return;
  const stat = fs.statSync(source);
  if (!stat.isDirectory()) { copyFile(source, target); return; }
  ensureDir(target);
  fs.readdirSync(source).forEach(name => copyRecursive(`${source}/${name}`, `${target}/${name}`));
}


function readBase64(path) {
  return fs.readFileSync(path, 'base64');
}

function writeBase64(path, data) {
  const parent = path.slice(0, path.lastIndexOf('/'));
  ensureDir(parent);
  fs.writeFileSync(path, data, 'base64');
}

function copyFile(source, target) {
  const parent = target.slice(0, target.lastIndexOf('/'));
  ensureDir(parent);
  fs.copyFileSync(source, target);
}

function removeRecursive(path) {
  if (!exists(path)) return;
  const stat = fs.statSync(path);
  if (!stat.isDirectory()) {
    fs.unlinkSync(path);
    return;
  }
  const items = fs.readdirSync(path);
  items.forEach(name => removeRecursive(`${path}/${name}`));
  fs.rmdirSync(path);
}

function unzip(zipFilePath, targetPath) {
  ensureDir(targetPath);
  return new Promise((resolve, reject) => {
    fs.unzip({
      zipFilePath,
      targetPath,
      success: resolve,
      fail: reject
    });
  });
}

function directorySize(path) {
  if (!exists(path)) return 0;
  const stat = fs.statSync(path);
  if (!stat.isDirectory()) return Number(stat.size || 0);
  return fs.readdirSync(path).reduce((sum, name) => sum + directorySize(`${path}/${name}`), 0);
}

function clearDirectory(path) {
  if (!exists(path)) return 0;
  const size = directorySize(path);
  removeRecursive(path);
  ensureDir(path);
  return size;
}

function getExtension(path = '') {
  const match = /\.([^.\/]+)$/.exec(path);
  return match ? match[1].toLowerCase() : '';
}

module.exports = {
  fs,
  exists,
  ensureDir,
  readText,
  readTextAuto,
  writeText,
  readJson,
  writeJson,
  writeJsonAtomic,
  copyRecursive,
  readBase64,
  writeBase64,
  copyFile,
  removeRecursive,
  directorySize,
  clearDirectory,
  unzip,
  getExtension
};
