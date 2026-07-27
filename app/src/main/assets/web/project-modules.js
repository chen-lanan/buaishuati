__define("app.js", function(require, module, exports){
const bankStorage = require('./services/bank-storage');
const recordStorage = require('./services/record-storage');

App({
  globalData: {
    importDraft: null,
    saveImportDraftRequested: false,
    currentSession: null,
    resultData: null
  },

  onLaunch() {
    try {
      bankStorage.initStorage();
      recordStorage.initDefaults();
    } catch (error) {
      console.error('初始化本地存储失败', error);
    }
  }
});
});
__define("utils/constants.js", function(require, module, exports){
const ROOT_DIR = `${wx.env.USER_DATA_PATH}/question-banks`;
const IMPORT_DIR = `${wx.env.USER_DATA_PATH}/question-imports`;
const EXPORT_DIR = `${wx.env.USER_DATA_PATH}/question-exports`;
const RECORD_DIR = `${wx.env.USER_DATA_PATH}/question-records`;
const BACKUP_DIR = `${wx.env.USER_DATA_PATH}/question-backups`;
const APP_DATA_DIR = String(wx.env.USER_DATA_PATH || '').replace(/\/files\/?$/, '');
const PICKED_FILE_CACHE_DIR = `${APP_DATA_DIR}/cache/picked-files`;
const CHUNK_SIZE = 200;
const CURRENT_PARSER_VERSION = '2.0.7';
const APP_VERSION = '2.0.7';

const STORAGE_KEYS = {
  BANK_INDEX: 'qb_bank_index_v1',
  WRONG: 'qb_wrong_v1',
  FAVORITES: 'qb_favorites_v1',
  PROGRESS: 'qb_progress_v1',
  STATS: 'qb_stats_v1',
  SETTINGS: 'qb_settings_v1',
  MASTERED: 'qb_mastered_v1',
  EXAM_DRAFT: 'qb_exam_draft_v1'
};

const QUESTION_TYPES = {
  single: '单选题',
  multiple: '多选题',
  judge: '判断题',
  short: '简答题',
  choice_error: '单选题'
};

module.exports = {
  ROOT_DIR,
  IMPORT_DIR,
  EXPORT_DIR,
  RECORD_DIR,
  BACKUP_DIR,
  PICKED_FILE_CACHE_DIR,
  CHUNK_SIZE,
  CURRENT_PARSER_VERSION,
  APP_VERSION,
  STORAGE_KEYS,
  QUESTION_TYPES
};
});
__define("utils/file.js", function(require, module, exports){
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
});
__define("utils/binary-archive.js", function(require, module, exports){
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
});
__define("utils/id.js", function(require, module, exports){
function randomPart() {
  return Math.random().toString(36).slice(2, 8);
}

function createId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${randomPart()}`;
}

module.exports = { createId };
});
__define("utils/text.js", function(require, module, exports){

function decodeBytesWithLabel(bytes, label, fatal = false) {
  try {
    if (typeof TextDecoder === 'function') return new TextDecoder(label, { fatal }).decode(bytes);
  } catch (_) {}
  return '';
}

const WINDOWS_1252_REVERSE = {
  0x20AC:0x80, 0x201A:0x82, 0x0192:0x83, 0x201E:0x84, 0x2026:0x85, 0x2020:0x86, 0x2021:0x87,
  0x02C6:0x88, 0x2030:0x89, 0x0160:0x8A, 0x2039:0x8B, 0x0152:0x8C, 0x017D:0x8E,
  0x2018:0x91, 0x2019:0x92, 0x201C:0x93, 0x201D:0x94, 0x2022:0x95, 0x2013:0x96, 0x2014:0x97,
  0x02DC:0x98, 0x2122:0x99, 0x0161:0x9A, 0x203A:0x9B, 0x0153:0x9C, 0x017E:0x9E, 0x0178:0x9F
};

function encodingQuality(value = '') {
  const text = String(value || '');
  if (!text) return -100000;
  const replacement = (text.match(/\uFFFD/g) || []).length;
  const controls = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
  const privateUse = (text.match(/[\uE000-\uF8FF]/g) || []).length;
  const classicMojibake = (text.match(/(?:Ã.|Â.|â€|â€™|â€œ|â€|ä¸|å[\x80-\xBF]|æ[\x80-\xBF]|ç[\x80-\xBF]|ï¿½)/g) || []).length;
  const useful = (text.match(/[\u3400-\u9FFF\uF900-\uFAFFA-Za-z0-9，。；：！？、,.!?;:'"“”‘’（）()【】\[\]＋+\-—_\/\\]/g) || []).length;
  return useful - replacement * 80 - controls * 30 - privateUse * 20 - classicMojibake * 16;
}

function legacyByteForCodePoint(code) {
  if (code >= 0 && code <= 255) return code;
  return Object.prototype.hasOwnProperty.call(WINDOWS_1252_REVERSE, code) ? WINDOWS_1252_REVERSE[code] : -1;
}

function repairMojibakeRun(run = '') {
  if (!run || !/(?:Ã.|Â.|â€|â€™|â€œ|â€|ä¸|å[\x80-\xBF]|æ[\x80-\xBF]|ç[\x80-\xBF]|ï¿½)/.test(run)) return run;
  const points = Array.from(run);
  const bytes = new Uint8Array(points.length);
  for (let index = 0; index < points.length; index += 1) {
    const byte = legacyByteForCodePoint(points[index].codePointAt(0));
    if (byte < 0) return run;
    bytes[index] = byte;
  }
  const repaired = decodeBytesWithLabel(bytes, 'utf-8', true);
  return repaired && encodingQuality(repaired) > encodingQuality(run) + 4 ? repaired : run;
}

function repairMojibake(value = '') {
  const text = String(value || '');
  if (!text || !/(?:Ã.|Â.|â€|â€™|â€œ|â€|ä¸|å[\x80-\xBF]|æ[\x80-\xBF]|ç[\x80-\xBF]|ï¿½)/.test(text)) return text;
  let run = '';
  let result = '';
  const flush = () => { if (run) result += repairMojibakeRun(run); run = ''; };
  Array.from(text).forEach(character => {
    if (legacyByteForCodePoint(character.codePointAt(0)) >= 0) run += character;
    else { flush(); result += character; }
  });
  flush();
  return result;
}

function repairKnownEngineeringNotation(value = '') {
  const text = String(value || '');
  if (!text || !text.includes('若开关') || !text.includes('梯形图是')) return text;
  const start = text.indexOf('若开关');
  const tail = text.slice(start);
  const endMatch = /梯形图是\s*[:：]?/.exec(tail);
  if (!endMatch) return text;
  const candidate = tail.slice(0, endMatch.index + endMatch[0].length);
  const compact = candidate.replace(/\s+/g, '');
  const orderedMarkers = ['若开关K', '接I', 'K', '接I', '灯L接Q', '实现K', '通或K', '断时', '灯L亮', 'K', '断且K', '通时', '灯L灭', '梯形图是'];
  let cursor = 0;
  const hasOrderedShape = orderedMarkers.every(marker => {
    const found = compact.indexOf(marker, cursor);
    if (found < 0) return false;
    cursor = found + marker.length;
    return true;
  });
  const anomalyCount = (candidate.match(/[�ö±²³煾]/g) || []).length;
  if (!hasOrderedShape || anomalyCount < 4) return text;
  const canonical = '若开关K1接I0.0，K2接I0.1，灯L接Q0.0。则实现K1通或K2断时，灯L亮；K1断且K2通时，灯L灭的梯形图是：';
  return text.slice(0, start) + canonical + tail.slice(endMatch.index + endMatch[0].length);
}

function hasEncodingAnomaly(value = '') {
  const text = String(value || '');
  if (!text) return false;
  if (/\uFFFD|[\uE000-\uF8FF]/.test(text)) return true;
  if (/(?:Ã.|Â.|â€|â€™|â€œ|â€|ä¸|å[\x80-\xBF]|æ[\x80-\xBF]|ç[\x80-\xBF]|ï¿½)/.test(text)) return true;
  if (/煾{2,}/.test(text)) return true;
  // ²/³ 与 ± 在 m²、m³、cm³、±0.5% 等工程文本中是合法字符；
  // 仅将包含乱码特征 ö 的组合视为字体映射异常，避免误报正常单位和希腊字母公式。
  const suspiciousEngineering = (text.match(/(?:[A-Za-z0-9.]ö[±²³A-Za-z0-9.]?|[±²³]ö[A-Za-z0-9.]?|ö{2,})/g) || []).length;
  return suspiciousEngineering >= 1;
}

function decodeXmlEntities(value = '') {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function toHalfWidth(value = '') {
  return String(value)
    .replace(/[Ａ-Ｚ]/g, char => String.fromCharCode(char.charCodeAt(0) - 65248))
    .replace(/[ａ-ｚ]/g, char => String.fromCharCode(char.charCodeAt(0) - 65248))
    .replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 65248));
}

function normalizeBracketLabel(value = '') {
  return String(value).replace(
    /[【\[［(（]\s*(参考答案|参考答|参考|正确答案|标准答案|答案解析|试题解析|解析|说明|答案|答)\s*[】\]］)）]\s*[:：]?/g,
    (all, label) => {
      if (/参考/.test(label)) return '参考答案：';
      if (/解析|说明/.test(label)) return '解析：';
      return '答案：';
    }
  );
}

function normalizeText(value = '') {
  return normalizeBracketLabel(toHalfWidth(repairKnownEngineeringNotation(repairMojibake(value))))
    .replace(/(参考答案|正确答案|标准答案|答案|答)\s*[（(【\[［]\s*([A-L](?:\s*[,，、/\\|\s]\s*[A-L])*|√|✓|×|✕|✖|正确|错误|对|错|是|否)\s*[）)】\]］]/gi, '$1：$2')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00ad/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/参\s*考\s*答\s*案\s*(?:为|是)?\s*[:：]/g, '__QB_REFERENCE__')
    .replace(/(?:答\s*案\s*)?解\s*析\s*[:：]/g, '__QB_ANALYSIS__')
    .replace(/(?:正确|标准|试题)?\s*答\s*案\s*(?:为|是)?\s*[:：]/g, '答案：')
    .replace(/__QB_REFERENCE__/g, '参考答案：')
    .replace(/__QB_ANALYSIS__/g, '解析：')
    .replace(/(?:答案|参考答案|解析)：\s*[:：]+/g, match => match.replace(/[:：]+$/, '：'))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n+ */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+([，。；：！？、])/g, '$1')
    .replace(/([（(【\[])[ \t]+/g, '$1')
    .replace(/[ \t]+([）)】\]])/g, '$1')
    .trim();
}

function normalizeOneLine(value = '') {
  return normalizeText(value).replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function isListStart(value = '') {
  const text = normalizeOneLine(value);
  return /^(?:\d{1,3}[.、．)）]|[（(]\d{1,3}[）)]|[①②③④⑤⑥⑦⑧⑨⑩]|[一二三四五六七八九十]+[、.．]|[-—•·])\s*/.test(text);
}

function needsAsciiSpace(left = '', right = '') {
  return /[A-Za-z0-9%℃°)]$/.test(left) && /^[A-Za-z0-9(]/.test(right);
}

function smartJoin(parts = [], mode = 'question') {
  const lines = [];
  parts.forEach(part => {
    normalizeText(part || '').split(/\n+/).forEach(line => {
      const clean = normalizeOneLine(line);
      if (clean) lines.push(clean);
    });
  });

  if (!lines.length) return '';
  let result = lines[0];
  for (let index = 1; index < lines.length; index += 1) {
    const next = lines[index];
    const previous = result;
    const preserveList = mode !== 'question' && isListStart(next);
    const preserveParagraph = mode !== 'question' && /[。！？；;：:]$/.test(previous) && isListStart(next);
    let separator;
    if (mode === 'answer') {
      // 参考答案的独立段落通常是一个要点；只有明显属于上一行续写时才拼接。
      const continuation = /[，,：:]$/.test(previous) || /^(?:和|及|与|并|且|或|以及|同时|其中|即|是|为|的|、|，|。|；)/.test(next);
      separator = preserveList || !continuation ? '\n' : '';
    } else {
      separator = preserveList || preserveParagraph
        ? '\n'
        : (needsAsciiSpace(previous, next) ? ' ' : '');
    }
    result += separator + next;
  }

  return normalizeText(result)
    .replace(/\n(?=[，。；！？、）)】\]])/g, '')
    .trim();
}

function cleanQuestionText(value) {
  return smartJoin(Array.isArray(value) ? value : [value], 'question')
    .replace(/^(?:题目|题干|问题)\s*[:：]\s*/i, '')
    .trim();
}

function cleanAnswerText(value) {
  return smartJoin(Array.isArray(value) ? value : [value], 'answer')
    .replace(/^(?:参考答案|答案|答)\s*[:：]\s*/i, '')
    .trim();
}

function cleanAnalysisText(value) {
  return smartJoin(Array.isArray(value) ? value : [value], 'analysis')
    .replace(/^(?:答案解析|试题解析|解析|说明)\s*[:：]\s*/i, '')
    .trim();
}

function compactText(value = '') {
  return normalizeOneLine(value)
    .replace(/[\s，。；：！？、,.!?;:'"“”‘’（）()【】\[\]［］_-]/g, '')
    .toLowerCase();
}

function buildSearchText(question = {}) {
  const options = (question.options || []).map(item => `${item.key} ${item.text}`).join(' ');
  const raw = question.source && Array.isArray(question.source.rawTexts)
    ? question.source.rawTexts.join(' ')
    : '';
  return compactText([
    question.number,
    question.level,
    question.category,
    question.chapter,
    question.type,
    question.displayTypeLabel,
    question.difficulty,
    question.question,
    options,
    (question.answer || []).join(' '),
    question.answerText,
    question.analysis,
    raw
  ].filter(Boolean).join(' '));
}

function fuzzyContains(haystack = '', needle = '') {
  if (!needle) return true;
  if (haystack.includes(needle)) return true;
  // 容忍 Word 中夹入少量不可见字符或一个无关字符，但不做激进模糊匹配。
  let cursor = 0;
  for (let index = 0; index < haystack.length && cursor < needle.length; index += 1) {
    if (haystack[index] === needle[cursor]) cursor += 1;
  }
  return cursor === needle.length;
}

function questionSignature(question = '') {
  return compactText(question).slice(0, 300);
}

function stripTags(value = '') {
  return value.replace(/<[^>]+>/g, '');
}

function unique(values) {
  return Array.from(new Set(values));
}

function safeFileName(value = '题库') {
  return normalizeOneLine(value)
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 60) || '题库';
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatBytes(bytes = 0) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

module.exports = {
  decodeXmlEntities,
  toHalfWidth,
  normalizeBracketLabel,
  normalizeText,
  normalizeOneLine,
  smartJoin,
  cleanQuestionText,
  cleanAnswerText,
  cleanAnalysisText,
  compactText,
  buildSearchText,
  fuzzyContains,
  questionSignature,
  isListStart,
  stripTags,
  unique,
  safeFileName,
  formatDate,
  formatBytes,
  decodeBytesWithLabel,
  encodingQuality,
  repairMojibake,
  repairKnownEngineeringNotation,
  hasEncodingAnomaly
};
});
__define("utils/bank-display.js", function(require, module, exports){
function sourceFormat(bank = {}) {
  const sourceName = String(bank.sourceName || '');
  const extension = ((/\.([^.\\/]+)$/.exec(sourceName) || [])[1] || '').toLowerCase();
  const kind = String(bank.sourceKind || bank.kind || extension || '').toLowerCase();
  const ext = extension || kind;
  const wordKinds = ['doc', 'docx', 'docm', 'dotx', 'dotm', 'rtf', 'odt'];
  const excelKinds = ['xls', 'xlsx', 'xlsm', 'xltx', 'xltm', 'ods', 'csv', 'tsv'];
  const textKinds = ['txt', 'md', 'markdown', 'html', 'htm'];
  const labelMap = { markdown: 'MD', htm: 'HTML', buaiquiz: '题库包', qbank: '题库包', json: 'JSON' };
  const label = labelMap[ext] || String(ext || '题库').toUpperCase();
  if (wordKinds.includes(kind) || wordKinds.includes(extension)) {
    return { sourceFormat: 'word', sourceFormatLabel: label };
  }
  if (kind === 'pdf' || extension === 'pdf') {
    return { sourceFormat: 'pdf', sourceFormatLabel: 'PDF' };
  }
  if (excelKinds.includes(kind) || excelKinds.includes(extension)) {
    return { sourceFormat: 'excel', sourceFormatLabel: label };
  }
  if (textKinds.includes(kind) || textKinds.includes(extension)) {
    return { sourceFormat: 'text', sourceFormatLabel: label };
  }
  if (['qbank', 'buaiquiz', 'json'].includes(kind) || ['qbank', 'buaiquiz', 'json'].includes(extension)) {
    return { sourceFormat: 'qbank', sourceFormatLabel: label };
  }
  return { sourceFormat: 'other', sourceFormatLabel: label === '题库'.toUpperCase() ? '题库' : label };
}

function nameSizeClass(name = '') {
  const length = Array.from(String(name || '')).length;
  if (length > 19) return 'bank-name-compact';
  if (length > 18) return 'bank-name-medium';
  return 'bank-name-normal';
}

function decorateBank(bank = {}) {
  return Object.assign({}, bank, sourceFormat(bank), {
    nameSizeClass: nameSizeClass(bank.name)
  });
}

module.exports = { sourceFormat, nameSizeClass, decorateBank };
});
__define("services/bank-storage.js", function(require, module, exports){
const fileUtil = require('../utils/file');
const { ROOT_DIR, IMPORT_DIR, EXPORT_DIR, RECORD_DIR, BACKUP_DIR, PICKED_FILE_CACHE_DIR, CHUNK_SIZE, STORAGE_KEYS, CURRENT_PARSER_VERSION, APP_VERSION } = require('../utils/constants');
const binaryArchive = require('../utils/binary-archive');
const { createId } = require('../utils/id');
const { safeFileName, cleanQuestionText, cleanAnswerText, normalizeOneLine } = require('../utils/text');
const { validateQuestion, repairKnownConvertedDocxOptions } = require('./question-validator');


const BUILTIN_DISPLAY_TYPE_LABELS = new Set(['单选题', '多选题', '判断题', '填空题', '简答题', '计算题', '画图题']);
const CORE_DISPLAY_TYPE_LABELS = { single: '单选题', multiple: '多选题', judge: '判断题', short: '简答题', choice_error: '单选题' };
let lightweightStorageCleanupDone = false;

function compactQuestionForStorage(question) {
  if (!question || typeof question !== 'object') return question;
  const source = question.source && typeof question.source === 'object' ? question.source : null;
  if (source && Array.isArray(source.rawTexts)) {
    // 正常题已经有结构化题干、选项和答案，重复保存整段原文只会放大题库。
    // 异常题仍保留少量原始片段，便于人工核对和编辑。
    source.rawTexts = question.status === 'normal' ? [] : source.rawTexts.slice(0, 8);
  }
  return question;
}
function normalizeCoreQuestionType(value = 'short') {
  return ['single', 'multiple', 'judge', 'short'].includes(value) ? value : 'short';
}
function normalizeCustomTypeCatalog(catalog = [], questions = []) {
  const result = [];
  const add = (label, coreType = 'short') => {
    const clean = normalizeOneLine(label || '');
    if (!clean || BUILTIN_DISPLAY_TYPE_LABELS.has(clean) || result.some(item => item.label === clean)) return;
    result.push({ label: clean, coreType: normalizeCoreQuestionType(coreType) });
  };
  (Array.isArray(catalog) ? catalog : []).forEach(item => {
    if (typeof item === 'string') add(item, 'short');
    else if (item) add(item.label, item.coreType || item.type);
  });
  (questions || []).forEach(question => {
    if (!question || question.sourceMissingPlaceholder) return;
    add(question.displayTypeLabel || CORE_DISPLAY_TYPE_LABELS[question.type] || question.type, question.type);
  });
  return result;
}

function initStorage() {
  fileUtil.ensureDir(ROOT_DIR);
  fileUtil.ensureDir(IMPORT_DIR);
  fileUtil.ensureDir(EXPORT_DIR);
  fileUtil.ensureDir(RECORD_DIR);
  fileUtil.ensureDir(BACKUP_DIR);
  if (!Array.isArray(wx.getStorageSync(STORAGE_KEYS.BANK_INDEX))) {
    wx.setStorageSync(STORAGE_KEYS.BANK_INDEX, []);
  }
  // 升级后自动清掉旧版本永久保存的原始 DOC/DOCX/PDF 副本，以及中断保存留下的内部目录。
  // 不触碰 IMPORT_DIR，避免用户正在导入并停留在结果页时误删当前草稿。
  if (!lightweightStorageCleanupDone) {
    lightweightStorageCleanupDone = true;
    try { cleanupLegacySourceArchives(); } catch (_) {}
    try { cleanupInterruptedBankDirectories(); } catch (_) {}
    // Android 文件选择器会先把所选原文件复制到 cache/picked-files。旧版本没有释放，
    // 导致导入次数越多系统“存储占用”越大。首次启动时安全清除这些失效副本。
    try { cleanupPickedFileCache(); } catch (_) {}
  }
}

function getIndex() {
  return wx.getStorageSync(STORAGE_KEYS.BANK_INDEX) || [];
}

function setIndex(index) {
  wx.setStorageSync(STORAGE_KEYS.BANK_INDEX, index);
}

function transformQuestionImageArrays(question, transform) {
  question.images = (question.images || []).map(transform).filter(Boolean);
  question.answerImages = (question.answerImages || []).map(transform).filter(Boolean);
  question.analysisImages = (question.analysisImages || []).map(transform).filter(Boolean);
  question.options = (question.options || []).map(option => ({
    ...option,
    images: (option.images || []).map(transform).filter(Boolean)
  }));
}

function contentHash(path) {
  try {
    const value = fileUtil.readBase64(path);
    let hash = 2166136261 >>> 0;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return `${value.length}-${hash.toString(16)}`;
  } catch (error) {
    return `path-${path}`;
  }
}

function copyQuestionImages(questions, physicalBankDir, logicalBankDir = physicalBankDir) {
  const sourceMap = {};
  const hashMap = {};
  let sequence = 1;
  const copyImage = source => {
    if (!source || !fileUtil.exists(source)) return source;
    if (source.startsWith(`${logicalBankDir}/images/`)) return source;
    if (sourceMap[source]) return sourceMap[source];
    const hash = contentHash(source);
    if (hashMap[hash]) {
      sourceMap[source] = hashMap[hash];
      return hashMap[hash];
    }
    const extension = fileUtil.getExtension(source) || 'jpg';
    const relative = `images/image_${String(sequence).padStart(4, '0')}.${extension}`;
    const physicalTarget = `${physicalBankDir}/${relative}`;
    const logicalTarget = `${logicalBankDir}/${relative}`;
    sequence += 1;
    fileUtil.copyFile(source, physicalTarget);
    sourceMap[source] = logicalTarget;
    hashMap[hash] = logicalTarget;
    return logicalTarget;
  };
  questions.forEach(question => transformQuestionImageArrays(question, copyImage));
}

function stageExistingImages(questions, bankDir) {
  const stageDir = `${IMPORT_DIR}/${createId('image-stage')}`;
  let sequence = 1;
  let used = false;
  const stageImage = source => {
    if (!source || !source.startsWith(`${bankDir}/`) || !fileUtil.exists(source)) return source;
    fileUtil.ensureDir(stageDir);
    const extension = fileUtil.getExtension(source) || 'jpg';
    const target = `${stageDir}/image_${String(sequence).padStart(4, '0')}.${extension}`;
    sequence += 1;
    fileUtil.copyFile(source, target);
    used = true;
    return target;
  };
  questions.forEach(question => transformQuestionImageArrays(question, stageImage));
  return used ? stageDir : '';
}

function writeBankDirectory(bankDir, bankId, draft, questions, sourceInput, logicalBankDir = bankDir) {
  fileUtil.ensureDir(`${bankDir}/images`);
  copyQuestionImages(questions, bankDir, logicalBankDir);

  // 原始导入文件只在解析工作目录中短暂存在。保存成功后不再复制进题库，
  // 题库运行仅依赖结构化题目分片和实际引用的图片。
  const sourceArchive = '';

  const chunks = [];
  for (let start = 0; start < questions.length; start += CHUNK_SIZE) {
    const fileName = `questions_${String(chunks.length + 1).padStart(4, '0')}.json`;
    const items = questions.slice(start, start + CHUNK_SIZE);
    fileUtil.writeJsonAtomic(`${bankDir}/${fileName}`, items);
    chunks.push({ fileName, count: items.length });
  }

  const typeCounts = questions.reduce((acc, item) => {
    if (item.sourceMissingPlaceholder) return acc;
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, { single: 0, multiple: 0, judge: 0, short: 0 });
  const statusCounts = questions.reduce((acc, item) => {
    const status = item.status || 'normal';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, { normal: 0, warning: 0, error: 0 });
  const displayTypeCounts = questions.reduce((acc, item) => {
    if (item.sourceMissingPlaceholder) return acc;
    const label = item.displayTypeLabel || item.type || '未知题型';
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});
  const difficultyCounts = questions.reduce((acc, item) => {
    if (item.sourceMissingPlaceholder || !item.difficulty) return acc;
    acc[item.difficulty] = (acc[item.difficulty] || 0) + 1;
    return acc;
  }, {});
  const categoryCounts = questions.reduce((acc, item) => {
    if (item.sourceMissingPlaceholder || !item.category) return acc;
    acc[item.category] = (acc[item.category] || 0) + 1;
    return acc;
  }, {});
  const manifest = {
    version: 3, id: bankId, name: draft.name || '未命名题库', sourceName: draft.sourceName || '',
    sourceKind: draft.kind || draft.sourceKind || '', sourceArchive,
    createdAt: draft.createdAt || Date.now(), updatedAt: Date.now(), questionCount: questions.length,
    usableQuestionCount: questions.filter(item => !item.sourceMissingPlaceholder && item.status !== 'error').length,
    sourceContentQuestionCount: questions.filter(item => !item.sourceMissingPlaceholder).length,
    sourceMissingCount: questions.filter(item => item.sourceMissingPlaceholder).length,
    expectedQuestionCount: Number(draft.expectedQuestionCount || (draft.diagnostics || {}).expectedQuestionCount) || 0,
    typeCounts, displayTypeCounts, difficultyCounts, categoryCounts, statusCounts,
    customTypeCatalog: normalizeCustomTypeCatalog(draft.customTypeCatalog, questions),
    diagnostics: draft.diagnostics || {}, parserVersion: draft.parserVersion || CURRENT_PARSER_VERSION, chunks
  };
  fileUtil.writeJsonAtomic(`${bankDir}/manifest.json`, manifest);
  return manifest;
}

function verifyBankDirectory(bankDir, expectedCount) {
  const manifest = fileUtil.readJson(`${bankDir}/manifest.json`, null);
  if (!manifest || !Array.isArray(manifest.chunks)) throw new Error('题库清单校验失败');
  let count = 0;
  manifest.chunks.forEach(chunk => {
    const items = fileUtil.readJson(`${bankDir}/${chunk.fileName}`, null);
    if (!Array.isArray(items) || items.length !== Number(chunk.count)) throw new Error(`题库分片校验失败：${chunk.fileName}`);
    count += items.length;
  });
  if (count !== expectedCount || Number(manifest.questionCount) !== expectedCount) throw new Error(`题库数量校验失败：预期 ${expectedCount}，实际 ${count}`);
  return manifest;
}

function saveBank(draft, existingId = '') {
  initStorage();
  const bankId = existingId || createId('bank');
  const bankDir = `${ROOT_DIR}/${bankId}`;
  const tempDir = `${ROOT_DIR}/.__new_${bankId}_${Date.now()}`;
  const backupDir = `${ROOT_DIR}/.__backup_${bankId}_${Date.now()}`;
  const questions = JSON.parse(JSON.stringify(draft.questions || [])).map(compactQuestionForStorage);
  const stageDir = existingId && fileUtil.exists(bankDir) ? stageExistingImages(questions, bankDir) : '';
  try {
    if (fileUtil.exists(tempDir)) fileUtil.removeRecursive(tempDir);
    const manifest = writeBankDirectory(tempDir, bankId, draft, questions, '', bankDir);
    verifyBankDirectory(tempDir, questions.length);
    if (fileUtil.exists(bankDir)) fileUtil.copyRecursive(bankDir, backupDir);
    if (fileUtil.exists(bankDir)) fileUtil.removeRecursive(bankDir);
    fileUtil.copyRecursive(tempDir, bankDir);
    verifyBankDirectory(bankDir, questions.length);
    const index = getIndex().filter(item => item.id !== bankId);
    index.unshift(manifest);
    setIndex(index);
    if (fileUtil.exists(backupDir)) fileUtil.removeRecursive(backupDir);
    return manifest;
  } catch (error) {
    try {
      if (fileUtil.exists(bankDir)) fileUtil.removeRecursive(bankDir);
      if (fileUtil.exists(backupDir)) fileUtil.copyRecursive(backupDir, bankDir);
    } catch (_) {}
    throw error;
  } finally {
    [tempDir, backupDir, stageDir].forEach(path => { if (path && fileUtil.exists(path)) fileUtil.removeRecursive(path); });
  }
}

function listBanks() {
  initStorage();
  return getIndex();
}

function getManifest(bankId) {
  return fileUtil.readJson(`${ROOT_DIR}/${bankId}/manifest.json`, null);
}

function repairMergedShortAnswer(question) {
  const item = Object.assign({}, question || {});
  if (item.type !== 'short' || normalizeOneLine(item.answerText || '')) return item;

  const rawQuestion = String(item.question || '').trim();
  const match = /^([\s\S]*?[？?])\s*([\s\S]{8,})$/.exec(rawQuestion);
  if (!match) return item;

  const trailing = normalizeOneLine(match[2]);
  if (!trailing || /[？?]\s*$/.test(trailing)) return item;

  const answerOpening = /^(?:答\s*[:：]?|因为|由于|原因(?:是|为)?|仪表|电路|设备|系统|控制|过程|曲线|表示|说明|是|指|由|有|应|需|需要|主要|包括|如果|在|当|可|为了|通过|采用|一般|通常|其|该|1[、.)）]|[①②③④⑤⑥⑦⑧⑨⑩]|[一二三四五六七八九十][、.)）]|措施|步骤|内容|要求|规定|方法|作用)/.test(trailing);
  const declarativeAnswer = trailing.length >= 30 && /[，,。；;：:]/.test(trailing) &&
    !/(?:什么|哪些|如何|为什么|是否|能否|有何|哪几|几种)[？?]\s*$/.test(trailing);
  if (!answerOpening && !declarativeAnswer) return item;

  item.question = cleanQuestionText(match[1]);
  item.answerText = cleanAnswerText([match[2]]);
  item.answerBoundarySource = item.answerBoundarySource || '旧题库自动修复：问号后答案';
  item.answerBoundaryConfidence = Math.max(Number(item.answerBoundaryConfidence) || 0, 0.86);
  item.answerSource = item.answerSource || '旧题库问号后答案自动拆分';

  if (Array.isArray(item.issues)) {
    item.issues = item.issues.filter(issue => !/简答题缺少参考答案|题干过长/.test(String(issue)));
    if (!item.issues.length) item.status = 'normal';
    else if (item.status === 'error') item.status = 'warning';
  }
  return item;
}


function isGenericVisualPlaceholder(value = '') {
  const clean = normalizeOneLine(value || '')
    .replace(/[\s()（）\[\]【】<>《》]/g, '')
    .replace(/[.。:：、，,;；]/g, '')
    .toLowerCase();
  return /^(?:图|图形|图片|图示|示意图|符号图|见图|如下图)$/.test(clean);
}

function repairChoiceAndJudge(question) {
  const item = Object.assign({}, question || {});
  if (item.sourceMissingPlaceholder) return item;
  item.options = Array.isArray(item.options) ? item.options.map(option => {
    const copy = Object.assign({}, option);
    const images = Array.isArray(copy.images) ? copy.images : [];
    if (images.length && isGenericVisualPlaceholder(copy.text)) copy.text = '';
    return copy;
  }) : [];
  item.answer = Array.isArray(item.answer) ? item.answer.slice() : [];

  // v1.4.7 以前曾把“选项不完整”伪造成独立题型。新版迁移回真实选择题，
  // 异常只通过 status/issues 表示，不污染题型分类。
  if (item.type === 'choice_error') {
    item.type = item.answer.length >= 2 ? 'multiple' : 'single';
    item.issues = (item.issues || []).filter(issue => !/选项有误的选择题/.test(String(issue)));
  }

  const truthValue = value => {
    const clean = normalizeOneLine(value || '').toUpperCase();
    if (/^(?:正确|对|是|√|✓|✔|TRUE|T)$/.test(clean)) return true;
    if (/^(?:错误|错|否|×|✕|✖|❌|FALSE|F)$/.test(clean)) return false;
    return null;
  };

  if (item.type === 'judge' && item.options.length === 1) {
    const semantic = truthValue(item.options[0].text);
    item.options = [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }];
    if (!item.answer.length && semantic !== null) item.answer = [semantic ? 'A' : 'B'];
    item.answerSource = item.answerSource || '旧题库自动补齐判断题';
  } else if (item.type === 'judge' && item.options.length === 0) {
    item.options = [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }];
  }

  if ((item.type === 'single' || item.type === 'multiple') && item.options.length < 2) {
    const source = String(item.question || '');
    const re = /(?:^|[\s；;。？！?：:])(?:[（(]\s*)?([A-L])\s*(?:[）)]|[.、．:：)）])\s*/ig;
    const marks = [];
    let match;
    while ((match = re.exec(source))) marks.push({ key: match[1].toUpperCase(), start: match.index, end: re.lastIndex });
    const first = marks.findIndex(mark => mark.key === 'A');
    if (first >= 0) {
      const seq = [];
      let expected = 65;
      for (let i = first; i < marks.length; i += 1) {
        if (marks[i].key.charCodeAt(0) !== expected) break;
        seq.push(marks[i]);
        expected += 1;
      }
      if (seq.length >= 2) {
        const options = seq.map((mark, index) => ({
          key: mark.key,
          text: cleanQuestionText(source.slice(mark.end, seq[index + 1] ? seq[index + 1].start : source.length))
        })).filter(option => option.text);
        if (options.length >= 2) {
          item.question = cleanQuestionText(source.slice(0, seq[0].start));
          item.options = options;
          item.answerSource = item.answerSource || '旧题库自动拆分内联选项';
        }
      }
    }
  }

  // 旧题库也按真实答案数量重新归类，避免必须重新导入才能修复明显错型。
  const semantics = item.options.map(option => truthValue(option.text));
  const canonicalJudge = item.options.length === 2 && semantics.includes(true) && semantics.includes(false);
  if (item.type !== 'short') {
    if (item.options.length >= 2 && item.answer.length >= 2) item.type = 'multiple';
    else if (item.options.length >= 2 && item.answer.length === 1) item.type = canonicalJudge ? 'judge' : 'single';
    else if (canonicalJudge && item.answer.length <= 1) item.type = 'judge';
    else if (item.type === 'multiple' && item.answer.length === 1) item.type = 'single';
    else if (item.type === 'judge' && item.options.length >= 2 && !canonicalJudge) item.type = item.answer.length >= 2 ? 'multiple' : 'single';
  }
  const recovered = repairKnownConvertedDocxOptions(item);
  return Object.assign(recovered, validateQuestion(recovered));
}
function loadQuestions(bankId) {
  const manifest = getManifest(bankId);
  if (!manifest) throw new Error('题库不存在或已损坏');
  const questions = [];
  manifest.chunks.forEach(chunk => {
    const items = fileUtil.readJson(`${ROOT_DIR}/${bankId}/${chunk.fileName}`, []);
    questions.push(...items.map(repairMergedShortAnswer).map(repairChoiceAndJudge));
  });
  return questions;
}

function loadBank(bankId) {
  const manifest = getManifest(bankId);
  if (!manifest) throw new Error('题库不存在');
  return {
    manifest,
    questions: loadQuestions(bankId)
  };
}


function questionUndoPath(bankId) {
  return `${RECORD_DIR}/question_edit_undo_${String(bankId || '').replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
}

function getQuestionUndoMap(bankId) {
  return fileUtil.readJson(questionUndoPath(bankId), {});
}

function saveQuestionUndoSnapshot(bankId, question) {
  if (!bankId || !question || !question.id) return;
  const map = getQuestionUndoMap(bankId);
  map[question.id] = { savedAt: Date.now(), question: JSON.parse(JSON.stringify(question)) };
  fileUtil.writeJsonAtomic(questionUndoPath(bankId), map);
}

function canUndoQuestionEdit(bankId, questionId) {
  const item = getQuestionUndoMap(bankId)[questionId];
  return Boolean(item && item.question);
}

function clearQuestionUndo(bankId, questionId) {
  const path = questionUndoPath(bankId);
  const map = fileUtil.readJson(path, {});
  if (!Object.prototype.hasOwnProperty.call(map, questionId)) return;
  delete map[questionId];
  if (Object.keys(map).length) fileUtil.writeJsonAtomic(path, map);
  else if (fileUtil.exists(path)) fileUtil.removeRecursive(path);
}

function copyExternalQuestionImages(question, bankDir) {
  let sequence = 1;
  const copy = source => {
    if (!source || !fileUtil.exists(source) || source.startsWith(`${bankDir}/`)) return source;
    const extension = fileUtil.getExtension(source) || 'jpg';
    let target;
    do {
      target = `${bankDir}/images/edit_${Date.now()}_${String(sequence).padStart(3, '0')}.${extension}`;
      sequence += 1;
    } while (fileUtil.exists(target));
    fileUtil.copyFile(source, target);
    return target;
  };
  transformQuestionImageArrays(question, copy);
}

function applyManifestStatistics(manifest, questions) {
  const usable = questions.filter(item => !item.sourceMissingPlaceholder && item.status !== 'error');
  manifest.questionCount = questions.length;
  manifest.usableQuestionCount = usable.length;
  manifest.sourceContentQuestionCount = questions.filter(item => !item.sourceMissingPlaceholder).length;
  manifest.sourceMissingCount = questions.filter(item => item.sourceMissingPlaceholder).length;
  manifest.typeCounts = questions.reduce((acc, item) => {
    if (!item.sourceMissingPlaceholder) acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, { single: 0, multiple: 0, judge: 0, short: 0 });
  manifest.statusCounts = questions.reduce((acc, item) => {
    const status = item.status || 'normal';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, { normal: 0, warning: 0, error: 0 });
  manifest.displayTypeCounts = questions.reduce((acc, item) => {
    if (!item.sourceMissingPlaceholder) {
      const label = item.displayTypeLabel || item.type || '未知题型';
      acc[label] = (acc[label] || 0) + 1;
    }
    return acc;
  }, {});
  manifest.difficultyCounts = questions.reduce((acc, item) => {
    if (!item.sourceMissingPlaceholder && item.difficulty) acc[item.difficulty] = (acc[item.difficulty] || 0) + 1;
    return acc;
  }, {});
  manifest.categoryCounts = questions.reduce((acc, item) => {
    if (!item.sourceMissingPlaceholder && item.category) acc[item.category] = (acc[item.category] || 0) + 1;
    return acc;
  }, {});
  manifest.customTypeCatalog = normalizeCustomTypeCatalog(manifest.customTypeCatalog, questions);
  manifest.updatedAt = Date.now();
  return manifest;
}

function getCustomTypeCatalog(bankId) {
  const manifest = getManifest(bankId);
  if (!manifest) return [];
  let questions = [];
  try { questions = loadQuestions(bankId); } catch (_) {}
  return normalizeCustomTypeCatalog(manifest.customTypeCatalog, questions);
}

function saveCustomTypeCatalog(bankId, catalog = []) {
  const manifest = getManifest(bankId);
  if (!manifest) throw new Error('题库不存在');
  let questions = [];
  try { questions = loadQuestions(bankId); } catch (_) {}
  manifest.customTypeCatalog = normalizeCustomTypeCatalog(catalog, questions);
  manifest.updatedAt = Date.now();
  fileUtil.writeJsonAtomic(`${ROOT_DIR}/${bankId}/manifest.json`, manifest);
  setIndex(getIndex().map(item => item.id === bankId ? manifest : item));
  return manifest.customTypeCatalog;
}

function renameCustomType(bankId, oldLabel, newLabel, coreType = 'short') {
  const from = normalizeOneLine(oldLabel || '');
  const to = normalizeOneLine(newLabel || '');
  if (!from || !to) throw new Error('题型名称不能为空');
  const allowedTypes = ['single', 'multiple', 'judge', 'short'];
  const nextCoreType = allowedTypes.includes(coreType) ? coreType : 'short';
  const manifest = getManifest(bankId);
  if (!manifest || !Array.isArray(manifest.chunks)) throw new Error('题库不存在或清单损坏');
  const previousManifest = JSON.parse(JSON.stringify(manifest));
  const changedChunks = [];
  let changedCount = 0;
  try {
    manifest.chunks.forEach(chunk => {
      const path = `${ROOT_DIR}/${bankId}/${chunk.fileName}`;
      const items = fileUtil.readJson(path, null);
      if (!Array.isArray(items)) throw new Error(`题库分片读取失败：${chunk.fileName}`);
      const previousItems = JSON.parse(JSON.stringify(items));
      let changed = false;
      items.forEach(question => {
        if (!question) return;
        const label = normalizeOneLine(question.displayTypeLabel || QUESTION_TYPES[question.type] || question.type || '');
        if (label !== from) return;
        question.displayTypeLabel = to;
        question.type = nextCoreType;
        changed = true;
        changedCount += 1;
      });
      if (changed) {
        changedChunks.push({ path, previousItems });
        fileUtil.writeJsonAtomic(path, items);
      }
    });
    const catalog = normalizeCustomTypeCatalog(manifest.customTypeCatalog || [], []);
    const nextCatalog = catalog.map(item => item.label === from ? { label: to, coreType: nextCoreType } : item);
    if (!nextCatalog.some(item => item.label === to)) nextCatalog.push({ label: to, coreType: nextCoreType });
    manifest.customTypeCatalog = normalizeCustomTypeCatalog(nextCatalog, loadQuestions(bankId));
    manifest.updatedAt = Date.now();
    rebuildManifestAfterQuestionEdit(bankId, manifest);
    return { changedCount, catalog: manifest.customTypeCatalog };
  } catch (error) {
    try {
      changedChunks.forEach(item => fileUtil.writeJsonAtomic(item.path, item.previousItems));
      fileUtil.writeJsonAtomic(`${ROOT_DIR}/${bankId}/manifest.json`, previousManifest);
      setIndex(getIndex().map(item => item.id === bankId ? previousManifest : item));
    } catch (_) {}
    throw new Error(`题型修改失败，已恢复原数据：${error.message || error}`);
  }
}

function findQuestionChunk(bankId, questionId) {
  const manifest = getManifest(bankId);
  if (!manifest || !Array.isArray(manifest.chunks)) throw new Error('题库不存在或清单损坏');
  for (const chunk of manifest.chunks) {
    const path = `${ROOT_DIR}/${bankId}/${chunk.fileName}`;
    const items = fileUtil.readJson(path, null);
    if (!Array.isArray(items)) throw new Error(`题库分片读取失败：${chunk.fileName}`);
    const index = items.findIndex(item => item && item.id === questionId);
    if (index >= 0) return { manifest, chunk, path, items, index };
  }
  throw new Error('没有找到需要修改的题目');
}

function rebuildManifestAfterQuestionEdit(bankId, manifest) {
  const questions = [];
  manifest.chunks.forEach(chunk => {
    const items = fileUtil.readJson(`${ROOT_DIR}/${bankId}/${chunk.fileName}`, null);
    if (!Array.isArray(items) || items.length !== Number(chunk.count)) throw new Error(`题库分片校验失败：${chunk.fileName}`);
    questions.push(...items);
  });
  applyManifestStatistics(manifest, questions);
  fileUtil.writeJsonAtomic(`${ROOT_DIR}/${bankId}/manifest.json`, manifest);
  setIndex(getIndex().map(item => item.id === bankId ? manifest : item));
  return manifest;
}

function updateQuestion(bankId, question, options = {}) {
  if (!question || !question.id) throw new Error('题目数据不完整');
  const located = findQuestionChunk(bankId, question.id);
  const bankDir = `${ROOT_DIR}/${bankId}`;
  const previousRaw = JSON.parse(JSON.stringify(located.items[located.index]));
  const previousQuestion = repairChoiceAndJudge(repairMergedShortAnswer(previousRaw));
  const nextQuestion = JSON.parse(JSON.stringify(question));
  copyExternalQuestionImages(nextQuestion, bankDir);
  if (!options.skipHistory) saveQuestionUndoSnapshot(bankId, previousQuestion);
  const previousManifest = JSON.parse(JSON.stringify(located.manifest));
  try {
    located.items[located.index] = nextQuestion;
    fileUtil.writeJsonAtomic(located.path, located.items);
    return rebuildManifestAfterQuestionEdit(bankId, located.manifest);
  } catch (error) {
    try {
      located.items[located.index] = previousRaw;
      fileUtil.writeJsonAtomic(located.path, located.items);
      fileUtil.writeJsonAtomic(`${bankDir}/manifest.json`, previousManifest);
      setIndex(getIndex().map(item => item.id === bankId ? previousManifest : item));
    } catch (_) {}
    throw new Error(`题目保存失败，已恢复原题：${error.message || error}`);
  }
}

function undoLastQuestionEdit(bankId, questionId) {
  const map = getQuestionUndoMap(bankId);
  const snapshot = map[questionId];
  if (!snapshot || !snapshot.question) throw new Error('这道题没有可撤销的上一次修改');
  updateQuestion(bankId, snapshot.question, { skipHistory: true });
  clearQuestionUndo(bankId, questionId);
  return snapshot.question;
}

function renameBank(bankId, name) {
  const manifest = getManifest(bankId);
  if (!manifest) throw new Error('题库不存在');
  manifest.name = name.trim() || manifest.name;
  manifest.updatedAt = Date.now();
  fileUtil.writeJson(`${ROOT_DIR}/${bankId}/manifest.json`, manifest);
  const index = getIndex().map(item => item.id === bankId ? manifest : item);
  setIndex(index);
  return manifest;
}

function getBankSize(bankId) {
  return fileUtil.directorySize(`${ROOT_DIR}/${bankId}`);
}

function removeAndMeasure(path) {
  if (!path || !fileUtil.exists(path)) return 0;
  const bytes = fileUtil.directorySize(path);
  fileUtil.removeRecursive(path);
  return bytes;
}

function listNames(path) {
  if (!fileUtil.exists(path)) return [];
  try { return fileUtil.fs.readdirSync(path) || []; } catch (_) { return []; }
}

function walkFiles(path, output = []) {
  if (!fileUtil.exists(path)) return output;
  let stat;
  try { stat = fileUtil.fs.statSync(path); } catch (_) { return output; }
  if (!stat.isDirectory()) { output.push(path); return output; }
  listNames(path).forEach(name => walkFiles(`${path}/${name}`, output));
  return output;
}

function activeBankIds() {
  return new Set((getIndex() || []).map(item => String(item && item.id || '')).filter(Boolean));
}

function cleanupPickedFileCache() {
  if (!PICKED_FILE_CACHE_DIR || !fileUtil.exists(PICKED_FILE_CACHE_DIR)) return 0;
  const bytes = fileUtil.directorySize(PICKED_FILE_CACHE_DIR);
  fileUtil.removeRecursive(PICKED_FILE_CACHE_DIR);
  return bytes;
}

function cleanupInterruptedBankDirectories() {
  let freedBytes = 0;
  listNames(ROOT_DIR).forEach(name => {
    if (!/^\.__(?:new|backup)_/.test(name)) return;
    freedBytes += removeAndMeasure(`${ROOT_DIR}/${name}`);
  });
  return freedBytes;
}

function cleanupLegacySourceArchives() {
  let freedBytes = 0;
  const nextIndex = [];
  (getIndex() || []).forEach(indexItem => {
    const bankId = String(indexItem && indexItem.id || '');
    const bankDir = `${ROOT_DIR}/${bankId}`;
    const manifestPath = `${bankDir}/manifest.json`;
    const manifest = fileUtil.readJson(manifestPath, null);
    if (!bankId || !manifest) return;
    freedBytes += removeAndMeasure(`${bankDir}/source`);
    if (manifest.sourceArchive) {
      manifest.sourceArchive = '';
      fileUtil.writeJsonAtomic(manifestPath, manifest);
    }
    nextIndex.push(Object.assign({}, indexItem, { sourceArchive: '' }));
  });
  if (nextIndex.length !== (getIndex() || []).length || nextIndex.some((item, index) => item.sourceArchive !== (getIndex()[index] || {}).sourceArchive)) {
    setIndex(nextIndex);
  }
  return freedBytes;
}

function referencedImagePaths(questions, bankDir) {
  const referenced = new Set();
  const remember = value => {
    const path = String(value || '');
    if (path && path.startsWith(`${bankDir}/images/`)) referenced.add(path);
    return value;
  };
  (questions || []).forEach(question => {
    if (!question) return;
    (question.images || []).forEach(remember);
    (question.answerImages || []).forEach(remember);
    (question.analysisImages || []).forEach(remember);
    (question.options || []).forEach(option => (option.images || []).forEach(remember));
  });
  return referenced;
}

function cleanupUndoSnapshots(bankId, validQuestionIds) {
  const path = questionUndoPath(bankId);
  const map = fileUtil.readJson(path, null);
  if (!map || typeof map !== 'object') return 0;
  const before = fileUtil.directorySize(path);
  let changed = false;
  Object.keys(map).forEach(questionId => {
    if (!validQuestionIds.has(questionId)) { delete map[questionId]; changed = true; }
  });
  if (!changed) return 0;
  if (Object.keys(map).length) fileUtil.writeJsonAtomic(path, map);
  else if (fileUtil.exists(path)) fileUtil.removeRecursive(path);
  return Math.max(0, before - fileUtil.directorySize(path));
}

function cleanupBankInternalFiles(bankId, compactExisting = true) {
  const bankDir = `${ROOT_DIR}/${bankId}`;
  const manifestPath = `${bankDir}/manifest.json`;
  const manifest = fileUtil.readJson(manifestPath, null);
  if (!manifest || !Array.isArray(manifest.chunks)) return { freedBytes: 0, valid: false };
  const before = fileUtil.directorySize(bankDir) + fileUtil.directorySize(questionUndoPath(bankId));
  removeAndMeasure(`${bankDir}/source`);
  manifest.sourceArchive = '';
  const questions = [];
  manifest.chunks.forEach(chunk => {
    const chunkPath = `${bankDir}/${chunk.fileName}`;
    const items = fileUtil.readJson(chunkPath, null);
    if (!Array.isArray(items)) throw new Error(`题库分片读取失败：${chunk.fileName}`);
    let changed = false;
    items.forEach(item => {
      questions.push(item);
      if (!compactExisting || !item || !item.source || !Array.isArray(item.source.rawTexts)) return;
      const next = item.status === 'normal' ? [] : item.source.rawTexts.slice(0, 8);
      if (JSON.stringify(next) !== JSON.stringify(item.source.rawTexts)) {
        item.source.rawTexts = next;
        changed = true;
      }
    });
    if (changed) fileUtil.writeJsonAtomic(chunkPath, items);
  });
  const referenced = referencedImagePaths(questions, bankDir);
  walkFiles(`${bankDir}/images`).forEach(path => {
    if (!referenced.has(path)) removeAndMeasure(path);
  });
  // 删除原子写入或异常中断残留的临时文件，不触碰题库清单和有效分片。
  walkFiles(bankDir).forEach(path => {
    const name = path.split('/').pop() || '';
    if (/\.tmp-[0-9]+-[a-f0-9]+$/i.test(name)) removeAndMeasure(path);
  });
  cleanupUndoSnapshots(bankId, new Set(questions.map(item => String(item && item.id || '')).filter(Boolean)));
  fileUtil.writeJsonAtomic(manifestPath, manifest);
  const current = getIndex();
  setIndex(current.map(item => item.id === bankId ? Object.assign({}, item, { sourceArchive: '' }) : item));
  const after = fileUtil.directorySize(bankDir) + fileUtil.directorySize(questionUndoPath(bankId));
  return { freedBytes: Math.max(0, before - after), valid: true };
}

function orphanRecordBytes(remove = false) {
  const ids = activeBankIds();
  let bytes = 0;
  const prefixes = ['wrong_', 'favorites_', 'progress_', 'memorize-progress_', 'mastered_', 'question_edit_undo_'];
  listNames(RECORD_DIR).forEach(name => {
    if (!name.endsWith('.json') || name === 'exam_draft.json') return;
    const prefix = prefixes.find(item => name.startsWith(item));
    if (!prefix) return;
    const bankId = name.slice(prefix.length, -5);
    if (ids.has(bankId)) return;
    const path = `${RECORD_DIR}/${name}`;
    bytes += fileUtil.directorySize(path);
    if (remove) fileUtil.removeRecursive(path);
  });
  return bytes;
}

function calculateReclaimableBytes() {
  let bytes = fileUtil.directorySize(IMPORT_DIR) + fileUtil.directorySize(PICKED_FILE_CACHE_DIR);
  listNames(ROOT_DIR).forEach(name => {
    const path = `${ROOT_DIR}/${name}`;
    if (/^\.__(?:new|backup)_/.test(name)) { bytes += fileUtil.directorySize(path); return; }
    const manifest = fileUtil.readJson(`${path}/manifest.json`, null);
    if (!manifest) { bytes += fileUtil.directorySize(path); return; }
    bytes += fileUtil.directorySize(`${path}/source`);
    const questions = [];
    (manifest.chunks || []).forEach(chunk => {
      const items = fileUtil.readJson(`${path}/${chunk.fileName}`, []);
      questions.push(...(Array.isArray(items) ? items : []));
      (Array.isArray(items) ? items : []).forEach(item => {
        const raw = item && item.source && Array.isArray(item.source.rawTexts) ? item.source.rawTexts : [];
        if (item && item.status === 'normal' && raw.length) bytes += JSON.stringify(raw).length;
        else if (raw.length > 8) bytes += JSON.stringify(raw.slice(8)).length;
      });
    });
    const referenced = referencedImagePaths(questions, path);
    walkFiles(`${path}/images`).forEach(image => { if (!referenced.has(image)) bytes += fileUtil.directorySize(image); });
    walkFiles(path).forEach(file => { if (/\.tmp-[0-9]+-[a-f0-9]+$/i.test(file.split('/').pop() || '')) bytes += fileUtil.directorySize(file); });
  });
  bytes += orphanRecordBytes(false);
  return Math.max(0, bytes);
}

function cleanupUnusedFiles() {
  initStorage();
  const before = fileUtil.directorySize(ROOT_DIR) + fileUtil.directorySize(IMPORT_DIR) + fileUtil.directorySize(PICKED_FILE_CACHE_DIR) + fileUtil.directorySize(RECORD_DIR);
  let importBytes = cleanupTemporaryFiles();
  let internalBytes = cleanupInterruptedBankDirectories();
  const currentIndex = getIndex();
  const recovered = [];
  const validIds = new Set();
  listNames(ROOT_DIR).forEach(name => {
    if (/^\.__/.test(name)) return;
    const path = `${ROOT_DIR}/${name}`;
    const manifest = fileUtil.readJson(`${path}/manifest.json`, null);
    if (!manifest || !manifest.id || !Array.isArray(manifest.chunks)) {
      internalBytes += removeAndMeasure(path);
      return;
    }
    validIds.add(String(manifest.id));
    if (!currentIndex.some(item => item.id === manifest.id)) recovered.push(manifest);
  });
  setIndex([...currentIndex.filter(item => validIds.has(String(item.id))), ...recovered]);
  let bankBytes = 0;
  Array.from(validIds).forEach(bankId => { bankBytes += cleanupBankInternalFiles(bankId, true).freedBytes; });
  const recordBytes = orphanRecordBytes(true);
  const after = fileUtil.directorySize(ROOT_DIR) + fileUtil.directorySize(IMPORT_DIR) + fileUtil.directorySize(PICKED_FILE_CACHE_DIR) + fileUtil.directorySize(RECORD_DIR);
  return {
    freedBytes: Math.max(0, before - after),
    importBytes,
    bankBytes: bankBytes + internalBytes,
    recordBytes,
    recoveredBankCount: recovered.length
  };
}

function getStorageSummary() {
  initStorage();
  return {
    bankBytes: fileUtil.directorySize(ROOT_DIR),
    recordBytes: fileUtil.directorySize(RECORD_DIR),
    importBytes: fileUtil.directorySize(IMPORT_DIR) + fileUtil.directorySize(PICKED_FILE_CACHE_DIR),
    pickedCacheBytes: fileUtil.directorySize(PICKED_FILE_CACHE_DIR),
    exportBytes: fileUtil.directorySize(EXPORT_DIR),
    backupBytes: fileUtil.directorySize(BACKUP_DIR),
    reclaimableBytes: calculateReclaimableBytes()
  };
}

function cleanupTemporaryFiles() {
  fileUtil.ensureDir(IMPORT_DIR);
  return fileUtil.clearDirectory(IMPORT_DIR) + cleanupPickedFileCache();
}

function cleanupExportFiles() {
  fileUtil.ensureDir(EXPORT_DIR);
  return fileUtil.clearDirectory(EXPORT_DIR);
}

function cleanupBackupFiles() {
  fileUtil.ensureDir(BACKUP_DIR);
  return fileUtil.clearDirectory(BACKUP_DIR);
}

function cleanupDraft(draft) {
  if (!draft || !draft.workDir || !fileUtil.exists(draft.workDir)) return 0;
  const bytes = fileUtil.directorySize(draft.workDir);
  fileUtil.removeRecursive(draft.workDir);
  return bytes;
}

function deleteBank(bankId) {
  const bankDir = `${ROOT_DIR}/${bankId}`;
  const before = fileUtil.directorySize(bankDir) + fileUtil.directorySize(questionUndoPath(bankId));
  if (fileUtil.exists(bankDir)) fileUtil.removeRecursive(bankDir);
  const undoPath = questionUndoPath(bankId);
  if (fileUtil.exists(undoPath)) fileUtil.removeRecursive(undoPath);
  setIndex(getIndex().filter(item => item.id !== bankId));
  // 删除动作在存储层一次完成，避免从其他入口删除题库时留下错题、收藏或进度文件。
  try { require('./record-storage').clearBankRecords(bankId); } catch (_) {}
  return Math.max(before, 0);
}

function exportBank(bankId) {
  const bank = loadBank(bankId);
  const imageMap = {};
  const entries = [];
  let imageSequence = 1;
  const questions = JSON.parse(JSON.stringify(bank.questions));

  const exportImage = source => {
    if (!source || !fileUtil.exists(source)) return '';
    if (!imageMap[source]) {
      const extension = fileUtil.getExtension(source) || 'jpg';
      const name = `assets/image_${String(imageSequence).padStart(4, '0')}.${extension}`;
      imageSequence += 1;
      entries.push({ name, path: source });
      imageMap[source] = `qbank2://${name}`;
    }
    return imageMap[source];
  };
  questions.forEach(question => transformQuestionImageArrays(question, exportImage));

  const payload = {
    format: 'buaiquiz-qbank',
    version: 3,
    appVersion: APP_VERSION,
    manifest: Object.assign({}, bank.manifest, { chunks: undefined }),
    diagnostics: bank.manifest.diagnostics || {},
    questions
  };
  const fileName = `${safeFileName(bank.manifest.name)}_${Date.now()}.qbank`;
  const target = `${EXPORT_DIR}/${fileName}`;
  return binaryArchive.createArchive(target, payload, entries);
}

function createFullBackup() {
  initStorage();
  fileUtil.ensureDir(BACKUP_DIR);
  const recordStorage = require('./record-storage');
  const entries = [];
  const imageMap = {};
  let sequence = 1;
  const banks = listBanks().map(item => {
    const bank = loadBank(item.id);
    const questions = JSON.parse(JSON.stringify(bank.questions));
    const exportImage = source => {
      if (!source || !fileUtil.exists(source)) return '';
      if (!imageMap[source]) {
        const extension = fileUtil.getExtension(source) || 'jpg';
        const name = `assets/${bank.manifest.id}_${String(sequence).padStart(5, '0')}.${extension}`;
        sequence += 1;
        entries.push({ name, path: source });
        imageMap[source] = `backup2://${name}`;
      }
      return imageMap[source];
    };
    questions.forEach(question => transformQuestionImageArrays(question, exportImage));
    return { manifest: Object.assign({}, bank.manifest, { chunks: undefined }), questions };
  });
  const payload = {
    format: 'buaiquiz-full-backup',
    version: 2,
    appVersion: APP_VERSION,
    createdAt: Date.now(),
    banks,
    learning: recordStorage.exportAllRecords(banks.map(item => item.manifest.id))
  };
  const target = `${BACKUP_DIR}/不爱刷题完整备份_${Date.now()}.buaiquiz`;
  return binaryArchive.createArchive(target, payload, entries);
}

function validateFullBackupPayload(payload, archiveEntries = {}) {
  if (!payload || payload.format !== 'buaiquiz-full-backup' || !Array.isArray(payload.banks)) throw new Error('这不是有效的不爱刷题完整备份');
  const ids = new Set();
  payload.banks.forEach((entry, bankIndex) => {
    if (!entry || !entry.manifest || !entry.manifest.id || !Array.isArray(entry.questions)) throw new Error(`备份中的第 ${bankIndex + 1} 个题库结构不完整`);
    if (ids.has(entry.manifest.id)) throw new Error(`备份中存在重复题库 ID：${entry.manifest.id}`);
    ids.add(entry.manifest.id);
    const assets = entry.assets || {};
    const verifyAsset = value => {
      if (!value) return;
      const text = String(value);
      if (text.startsWith('backup://')) {
        const name = text.slice('backup://'.length);
        if (!Object.prototype.hasOwnProperty.call(assets, name) || typeof assets[name] !== 'string') throw new Error(`题库“${entry.manifest.name || entry.manifest.id}”缺少图片资源：${name}`);
      } else if (text.startsWith('backup2://')) {
        const name = text.slice('backup2://'.length);
        if (!Object.prototype.hasOwnProperty.call(archiveEntries, name)) throw new Error(`题库“${entry.manifest.name || entry.manifest.id}”缺少图片资源：${name}`);
      }
    };
    entry.questions.forEach(question => {
      (question.images || []).forEach(verifyAsset);
      (question.answerImages || []).forEach(verifyAsset);
      (question.analysisImages || []).forEach(verifyAsset);
      (question.options || []).forEach(option => (option.images || []).forEach(verifyAsset));
    });
    const declared = Number(entry.manifest.questionCount) || 0;
    if (declared && declared !== entry.questions.length) throw new Error(`题库“${entry.manifest.name || entry.manifest.id}”数量校验失败：${declared}/${entry.questions.length}`);
  });
  return payload;
}

function storageSnapshot() {
  const values = {};
  Object.keys(STORAGE_KEYS).forEach(name => { values[STORAGE_KEYS[name]] = wx.getStorageSync(STORAGE_KEYS[name]); });
  return values;
}
function restoreStorageSnapshot(values = {}) {
  Object.keys(values).forEach(key => wx.setStorageSync(key, values[key]));
}

function restoreFullBackup(path, replaceAll = true) {
  let payload;
  let archiveEntries = {};
  const archive = binaryArchive.readArchive(path);
  if (archive) {
    payload = archive.metadata;
    archiveEntries = archive.entries || {};
  } else {
    payload = fileUtil.readJson(path, null);
  }
  validateFullBackupPayload(payload, archiveEntries);
  const recordStorage = require('./record-storage');
  const rollbackDir = `${IMPORT_DIR}/${createId('full-restore-rollback')}`;
  const rollbackBanks = `${rollbackDir}/banks`;
  const rollbackRecords = `${rollbackDir}/records`;
  const snapshot = storageSnapshot();
  fileUtil.ensureDir(rollbackDir);
  if (fileUtil.exists(ROOT_DIR)) fileUtil.copyRecursive(ROOT_DIR, rollbackBanks);
  if (fileUtil.exists(RECORD_DIR)) fileUtil.copyRecursive(RECORD_DIR, rollbackRecords);
  try {
    if (replaceAll) {
      if (fileUtil.exists(ROOT_DIR)) fileUtil.removeRecursive(ROOT_DIR);
      fileUtil.ensureDir(ROOT_DIR);
      setIndex([]);
      recordStorage.clearLearningRecords();
    }
    payload.banks.forEach(entry => {
      const workDir = `${IMPORT_DIR}/${createId('backup-restore')}`;
      const assetDir = `${workDir}/assets`;
      fileUtil.ensureDir(assetDir);
      try {
        Object.keys(entry.assets || {}).forEach(name => fileUtil.writeBase64(`${assetDir}/${safeFileName(name)}`, entry.assets[name]));
        Object.keys(archiveEntries || {}).forEach(name => {
          if (!name.startsWith(`assets/${entry.manifest.id}_`)) return;
          const relative = safeFileName(name.replace(/^assets\//, ''));
          binaryArchive.writeBytes(`${assetDir}/${relative}`, archiveEntries[name]);
        });
        const restore = value => {
          if (!value) return value;
          const text = String(value);
          let name = '';
          if (text.startsWith('backup://')) name = safeFileName(text.slice('backup://'.length));
          else if (text.startsWith('backup2://')) name = safeFileName(text.slice('backup2://'.length).replace(/^assets\//, ''));
          else return value;
          const target = `${assetDir}/${name}`;
          if (!fileUtil.exists(target)) throw new Error(`备份图片恢复失败：${value}`);
          return target;
        };
        const questions = JSON.parse(JSON.stringify(entry.questions || []));
        questions.forEach(question => transformQuestionImageArrays(question, restore));
        const manifest = saveBank({
          name: entry.manifest.name, sourceName: entry.manifest.sourceName || '', sourceKind: entry.manifest.sourceKind || 'backup',
          createdAt: entry.manifest.createdAt, diagnostics: entry.manifest.diagnostics || {}, parserVersion: entry.manifest.parserVersion || 'backup',
          expectedQuestionCount: entry.manifest.expectedQuestionCount || 0, questions
        }, entry.manifest.id);
        if (Number(manifest.questionCount) !== questions.length) throw new Error(`题库“${manifest.name}”恢复后数量校验失败`);
      } finally {
        if (fileUtil.exists(workDir)) fileUtil.removeRecursive(workDir);
      }
    });
    recordStorage.importAllRecords(payload.learning || {});
    if (replaceAll && listBanks().length !== payload.banks.length) throw new Error(`恢复后的题库数量不一致：${listBanks().length}/${payload.banks.length}`);
    if (fileUtil.exists(rollbackDir)) fileUtil.removeRecursive(rollbackDir);
    return { bankCount: payload.banks.length };
  } catch (error) {
    try {
      if (fileUtil.exists(ROOT_DIR)) fileUtil.removeRecursive(ROOT_DIR);
      if (fileUtil.exists(rollbackBanks)) fileUtil.copyRecursive(rollbackBanks, ROOT_DIR); else fileUtil.ensureDir(ROOT_DIR);
      if (fileUtil.exists(RECORD_DIR)) fileUtil.removeRecursive(RECORD_DIR);
      if (fileUtil.exists(rollbackRecords)) fileUtil.copyRecursive(rollbackRecords, RECORD_DIR); else fileUtil.ensureDir(RECORD_DIR);
      restoreStorageSnapshot(snapshot);
    } catch (_) {}
    throw new Error(`完整备份恢复失败，已回滚原数据：${error.message || error}`);
  } finally {
    if (fileUtil.exists(rollbackDir)) fileUtil.removeRecursive(rollbackDir);
  }
}

function installDemoBank() {
  const demo = require('../data/demo-bank');
  return saveBank({
    name: '示例题库',
    sourceName: '程序内置示例',
    createdAt: Date.now(),
    diagnostics: { sourceParagraphCount: 0, effectiveParagraphCount: 0, removedNoiseCount: 0, inferredBoundaryCount: 0, inlineAnswerCount: 0, duplicateCount: 0 },
    parserVersion: CURRENT_PARSER_VERSION,
    questions: JSON.parse(JSON.stringify(demo))
  });
}

module.exports = {
  initStorage,
  listBanks,
  getManifest,
  loadQuestions,
  loadBank,
  saveBank,
  updateQuestion,
  getCustomTypeCatalog,
  saveCustomTypeCatalog,
  renameCustomType,
  canUndoQuestionEdit,
  undoLastQuestionEdit,
  renameBank,
  getBankSize,
  getStorageSummary,
  calculateReclaimableBytes,
  cleanupUnusedFiles,
  cleanupBankInternalFiles,
  cleanupTemporaryFiles,
  cleanupPickedFileCache,
  cleanupExportFiles,
  cleanupBackupFiles,
  cleanupDraft,
  deleteBank,
  exportBank,
  createFullBackup,
  restoreFullBackup,
  installDemoBank
};
});
__define("services/docx-extractor.js", function(require, module, exports){
const fileUtil = require('../utils/file');
const { decodeXmlEntities, normalizeText } = require('../utils/text');

function attrValue(xml, attrName) {
  const pattern = new RegExp(`${attrName}="([^"]+)"`);
  const match = pattern.exec(xml);
  return match ? decodeXmlEntities(match[1]) : '';
}

function parseRelationships(xml = '') {
  const result = {};
  const tags = xml.match(/<Relationship\b[^>]*\/?>/g) || [];
  tags.forEach(tag => {
    const id = attrValue(tag, 'Id');
    const target = attrValue(tag, 'Target');
    if (id && target) result[id] = target;
  });
  return result;
}

function stripInvisibleWordXml(xml = '') {
  return String(xml || '')
    .replace(/<w:del\b[\s\S]*?<\/w:del>/g, '')
    .replace(/<w:moveFrom\b[\s\S]*?<\/w:moveFrom>/g, '')
    .replace(/<w:instrText\b[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<w:customXmlDelRangeStart\b[^>]*\/>/g, '')
    .replace(/<w:customXmlDelRangeEnd\b[^>]*\/>/g, '');
}

function textFromVisibleXml(xml = '') {
  const visibleXml = stripInvisibleWordXml(xml);
  const texts = [];
  const runPattern = /<w:r\b[\s\S]*?<\/w:r>/g;
  let runMatch;
  while ((runMatch = runPattern.exec(visibleXml))) {
    const run = runMatch[0];
    if (/<w:vanish\b/.test(run) || /<w:webHidden\b/.test(run)) continue;
    const prepared = run
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n');
    const textPattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let textMatch;
    while ((textMatch = textPattern.exec(prepared))) texts.push(decodeXmlEntities(textMatch[1]));
  }
  if (!texts.length) {
    const prepared = visibleXml
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n');
    const pattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let match;
    while ((match = pattern.exec(prepared))) texts.push(decodeXmlEntities(match[1]));
  }
  return normalizeText(texts.join(''));
}

function branchQuality(xml = '') {
  const text = textFromVisibleXml(xml);
  if (!text) return -100000;
  const lines = text.split(/\n+/).map(item => normalizeText(item)).filter(Boolean);
  const uniqueLines = new Set(lines.map(item => item.replace(/\s+/g, '').toLowerCase()));
  let score = Math.min(text.length, 2000) + uniqueLines.size * 80;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].replace(/\s+/g, '') === lines[index - 1].replace(/\s+/g, '')) score -= 240;
  }
  if (/\b(?:A|Ａ)\s*[.、．:：)]/.test(text)) score += 25;
  if (/\b(?:B|Ｂ)\s*[.、．:：)]/.test(text)) score += 25;
  if (/\b(?:C|Ｃ)\s*[.、．:：)]/.test(text)) score += 25;
  if (/\b(?:D|Ｄ)\s*[.、．:：)]/.test(text)) score += 25;
  return score;
}

function resolveAlternateContent(xml = '') {
  let source = String(xml || '');
  let previous = '';
  // Some converted Word files nest AlternateContent. Resolve innermost blocks first.
  while (source !== previous && /<mc:AlternateContent\b/.test(source)) {
    previous = source;
    source = source.replace(/<mc:AlternateContent\b(?:(?!<mc:AlternateContent\b)[\s\S])*?<\/mc:AlternateContent>/g, block => {
      const choice = /<mc:Choice\b[^>]*>([\s\S]*?)<\/mc:Choice>/.exec(block);
      const fallback = /<mc:Fallback\b[^>]*>([\s\S]*?)<\/mc:Fallback>/.exec(block);
      if (!choice) return fallback ? fallback[1] : '';
      if (!fallback) return choice[1];
      const choiceScore = branchQuality(choice[1]);
      const fallbackScore = branchQuality(fallback[1]);
      return fallbackScore > choiceScore ? fallback[1] : choice[1];
    });
  }
  return source;
}

function drawingTextCandidates(xml = '') {
  const source = stripInvisibleWordXml(String(xml || ''));
  const values = [];
  let match;
  const drawingText = /<(?:a|m):t\b[^>]*>([\s\S]*?)<\/(?:a|m):t>/g;
  while ((match = drawingText.exec(source))) {
    const value = normalizeText(decodeXmlEntities(match[1]));
    if (value) values.push(value);
  }
  const textPath = /<v:textpath\b[^>]*\bstring="([^"]*)"[^>]*\/?>(?:<\/v:textpath>)?/g;
  while ((match = textPath.exec(source))) {
    const value = normalizeText(decodeXmlEntities(match[1]));
    if (value) values.push(value);
  }
  return values.filter((item, index, all) => all.indexOf(item) === index);
}

function paragraphTextCandidates(xml = '') {
  const source = String(xml || '');
  const variants = [resolveAlternateContent(source)];
  const blocks = source.match(/<mc:AlternateContent\b[\s\S]*?<\/mc:AlternateContent>/g) || [];
  blocks.slice(0, 6).forEach(block => {
    const branches = [];
    const choice = /<mc:Choice\b[^>]*>([\s\S]*?)<\/mc:Choice>/.exec(block);
    const fallback = /<mc:Fallback\b[^>]*>([\s\S]*?)<\/mc:Fallback>/.exec(block);
    if (choice) branches.push(choice[1]);
    if (fallback) branches.push(fallback[1]);
    branches.forEach(branch => {
      const replaced = source.replace(block, branch);
      variants.push(resolveAlternateContent(replaced));
    });
  });
  const texts = variants.map(textFromVisibleXml).filter(Boolean);
  // Visible corrections produced by PDF-to-Word converters can be DrawingML/VML text
  // rather than normal w:t runs. Keep them as alternatives, never as the primary text.
  texts.push(...drawingTextCandidates(source));
  return texts.filter((item, index, all) => all.findIndex(value => value === item) === index);
}

function paragraphText(xml = '') {
  return paragraphTextCandidates(xml)[0] || '';
}

function extractLeafParagraphBlocks(documentXml = '') {
  // Keep XML coordinates while selecting one visible AlternateContent branch. This avoids
  // reading both compatibility copies, but preserves inner text-box paragraphs in order.
  const source = resolveAlternateContent(String(documentXml || ''));

  function collectContainerRanges(tagName) {
    const pattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'g');
    const stack = [];
    const ranges = [];
    let tag;
    while ((tag = pattern.exec(source))) {
      if (tag[0][1] !== '/') stack.push(tag.index);
      else if (stack.length) ranges.push([stack.pop(), pattern.lastIndex]);
    }
    return ranges;
  }
  const textBoxRanges = [
    ...collectContainerRanges('w:txbxContent'),
    ...collectContainerRanges('v:textbox'),
    ...collectContainerRanges('wps:txbx')
  ];
  const isInsideTextBox = position => textBoxRanges.some(range => position >= range[0] && position < range[1]);

  const tokens = /<\/?w:p\b[^>]*>/g;
  const stack = [];
  const blocks = [];
  let match;
  while ((match = tokens.exec(source))) {
    const tag = match[0];
    const closing = /^<\/w:p\b/.test(tag);
    const selfClosing = /\/>$/.test(tag);
    if (!closing) {
      if (stack.length) stack[stack.length - 1].hasNestedParagraph = true;
      if (selfClosing) blocks.push({ start: match.index, xml: tag, insideTextBox: isInsideTextBox(match.index) });
      else stack.push({ start: match.index, hasNestedParagraph: false, insideTextBox: isInsideTextBox(match.index) });
      continue;
    }
    if (!stack.length) continue;
    const entry = stack.pop();
    if (!entry.hasNestedParagraph) {
      blocks.push({
        start: entry.start,
        xml: source.slice(entry.start, tokens.lastIndex),
        insideTextBox: entry.insideTextBox
      });
    }
  }
  return blocks.sort((a, b) => a.start - b.start);
}

function optionLineInfo(value = '') {
  const clean = normalizeText(value || '').replace(/\n+/g, ' ').trim();
  const match = /^\s*([A-L])\s*(?:[.、．:：)）]\s*|\s+)(.+?)\s*$/i.exec(clean);
  if (!match) return null;
  return {
    key: match[1].toUpperCase(),
    body: match[2].trim(),
    signature: match[2].replace(/[\s，。；、,.!！?？:：()（）\[\]【】]/g, '').toLowerCase()
  };
}

function repairExtractedOptionOverlays(paragraphs = []) {
  const skipped = new Set();
  for (let index = 1; index < paragraphs.length; index += 1) {
    if (skipped.has(index)) continue;
    const previous = optionLineInfo(paragraphs[index - 1].text);
    const current = optionLineInfo(paragraphs[index].text);
    if (!previous || !current) continue;
    const sequential = current.key.charCodeAt(0) === previous.key.charCodeAt(0) + 1;
    if (!sequential || !current.signature || current.signature !== previous.signature) continue;

    // Converted PDF/Word files sometimes keep an invisible base line plus a visible text-box
    // correction. Prefer a distinct alternative for the same option key when it exists.
    const inlineAlternative = (paragraphs[index].alternatives || [])
      .map(optionLineInfo)
      .find(item => item && item.key === current.key && item.signature && item.signature !== previous.signature);
    if (inlineAlternative) {
      paragraphs[index].text = `${current.key}. ${inlineAlternative.body}`;
      paragraphs[index].extractionRepair = '兼容分支选项恢复';
      continue;
    }
    const inlineOverlay = (paragraphs[index].alternatives || [])
      .map(value => normalizeText(value || '').replace(new RegExp(`^\\s*${current.key}\\s*[.、．:：)）]?\\s*`, 'i'), '').trim())
      .find(value => {
        if (!value || value.length > 500) return false;
        const signature = value.replace(/[\s，。；、,.!！?？:：()（）\[\]【】]/g, '').toLowerCase();
        return signature && signature !== previous.signature && signature !== current.signature;
      });
    if (inlineOverlay) {
      paragraphs[index].text = `${current.key}. ${inlineOverlay}`;
      paragraphs[index].extractionRepair = '图形覆盖选项恢复';
      continue;
    }

    // The visible overlay can also appear as the next paragraph. Use it only before an answer
    // or the next question and only when it carries the same option key.
    for (let look = index + 1; look < Math.min(paragraphs.length, index + 5); look += 1) {
      const candidateText = normalizeText(paragraphs[look].text || '');
      if (/^(?:答案|参考答案|解析|正确答案)\s*[:：]/.test(candidateText) || /^\d{1,4}\s*[.、．)）]/.test(candidateText)) break;
      const candidate = optionLineInfo(candidateText);
      if (candidate && candidate.key === current.key && candidate.signature && candidate.signature !== previous.signature) {
        paragraphs[index].text = `${current.key}. ${candidate.body}`;
        paragraphs[index].extractionRepair = '浮动文本框选项恢复';
        skipped.add(look);
        break;
      }

      // PDF-to-Word converters often leave the wrong base glyphs in the paragraph and draw
      // the visible replacement inside a text box without repeating the D./D: label. Only
      // consume such an unlabeled value when the paragraph is structurally inside a text box,
      // is adjacent to a duplicated option, and appears before the answer/next question.
      if (!candidate && paragraphs[look].insideTextBox && candidateText.length <= 500) {
        const overlayBody = candidateText
          .replace(new RegExp(`^\\s*${current.key}\\s*[.、．:：)）]?\\s*`, 'i'), '')
          .trim();
        const overlaySignature = overlayBody.replace(/[\s，。；、,.!！?？:：()（）\[\]【】]/g, '').toLowerCase();
        if (overlayBody && overlaySignature && overlaySignature !== previous.signature) {
          paragraphs[index].text = `${current.key}. ${overlayBody}`;
          paragraphs[index].extractionRepair = '文本框覆盖选项恢复';
          skipped.add(look);
          break;
        }
      }
    }
  }
  return paragraphs.filter((_, index) => !skipped.has(index));
}

function runStyleCandidates(xml = '') {
  const visible = stripInvisibleWordXml(String(xml || ''));
  const styled = [];
  const bold = [];
  let plainLength = 0;
  const runPattern = /<w:r\b[\s\S]*?<\/w:r>/g;
  let runMatch;
  while ((runMatch = runPattern.exec(visible))) {
    const run = runMatch[0];
    if (/<w:vanish\b/.test(run) || /<w:webHidden\b/.test(run)) continue;
    const text = textFromVisibleXml(run);
    if (!text) continue;
    const props = /<w:rPr\b[\s\S]*?<\/w:rPr>/.exec(run);
    const rpr = props ? props[0] : '';
    const underline = /<w:u\b(?![^>]*w:val="(?:none|0)")/.test(rpr);
    const highlight = /<w:highlight\b[^>]*w:val="(?!none|auto)[^"]+"/.test(rpr) || /<w:shd\b[^>]*w:fill="(?!auto|FFFFFF|ffffff)[A-Fa-f0-9]{6}"/.test(rpr);
    const colorMatch = /<w:color\b[^>]*w:val="([A-Fa-f0-9]{6}|auto)"/.exec(rpr);
    let answerColor = false;
    if (colorMatch && colorMatch[1].toLowerCase() !== 'auto') {
      const value = colorMatch[1];
      const red = parseInt(value.slice(0, 2), 16), green = parseInt(value.slice(2, 4), 16), blue = parseInt(value.slice(4, 6), 16);
      answerColor = red >= 150 && red >= green * 1.35 && red >= blue * 1.35;
    }
    const isBold = /<w:b\b(?![^>]*w:val="(?:false|0|off)")/.test(rpr);
    if (underline || highlight || answerColor) styled.push({ text, strength: 'strong', reason: underline ? 'underline' : (highlight ? 'highlight' : 'color') });
    else if (isBold) bold.push({ text, strength: 'bold', reason: 'bold' });
    else plainLength += Array.from(text).length;
  }
  // 粗体只有在同一段中同时存在普通文字、且粗体片段不占大多数时才视为弱答案候选，
  // 避免把整道加粗题干或标题当成填空答案。
  const boldLength = bold.reduce((sum, item) => sum + Array.from(item.text).length, 0);
  const usableBold = plainLength >= 4 && boldLength > 0 && boldLength <= Math.max(80, plainLength) ? bold : [];
  return [...styled, ...usableBold].filter((item, index, all) => all.findIndex(other => other.text === item.text && other.reason === item.reason) === index);
}

function extractTableCellRanges(documentXml = '', relationships = {}, extractDir = '') {
  const source = resolveAlternateContent(String(documentXml || ''));
  const tables = [];
  const cells = [];
  const tablePattern = /<w:tbl\b[\s\S]*?<\/w:tbl>/g;
  let tableMatch;
  let tableIndex = 0;
  while ((tableMatch = tablePattern.exec(source))) {
    const tableXml = tableMatch[0];
    const tableStart = tableMatch.index;
    const rows = [];
    const rowPattern = /<w:tr\b[\s\S]*?<\/w:tr>/g;
    let rowMatch;
    let rowIndex = 0;
    while ((rowMatch = rowPattern.exec(tableXml))) {
      const rowXml = rowMatch[0];
      const rowStart = tableStart + rowMatch.index;
      const values = [];
      const rowImages = [];
      const cellPattern = /<w:tc\b[\s\S]*?<\/w:tc>/g;
      let cellMatch;
      let colIndex = 0;
      while ((cellMatch = cellPattern.exec(rowXml))) {
        const cellXml = cellMatch[0];
        const start = rowStart + cellMatch.index;
        const end = start + cellXml.length;
        const value = textFromVisibleXml(cellXml).replace(/\n+/g, ' ').trim();
        const imageIds = [];
        const imagePattern = /(?:r:embed|r:link|r:id)="([^"]+)"/g;
        let imageMatch;
        while ((imageMatch = imagePattern.exec(cellXml))) if (!imageIds.includes(imageMatch[1])) imageIds.push(imageMatch[1]);
        const images = imageIds.map(id => relationships[id]).filter(Boolean).map(target => `${extractDir}/word/${target.replace(/^\.\.\//, '')}`).filter(fileUtil.exists);
        values[colIndex] = value;
        rowImages[colIndex] = images;
        cells.push({ start, end, tableId: tableIndex + 1, rowIndex, colIndex });
        colIndex += 1;
      }
      if (values.some(Boolean) || rowImages.some(list => list && list.length)) rows.push({ values, images: rowImages, rowIndex });
      rowIndex += 1;
    }
    if (rows.length) tables.push({ id: tableIndex + 1, name: `Word表格${tableIndex + 1}`, sourceStart: tableStart, rows });
    tableIndex += 1;
  }
  return { source, tables, cells };
}

function extractParagraphs(documentXml, relationships, extractDir) {
  const paragraphs = [];
  const tableInfo = extractTableCellRanges(documentXml, relationships, extractDir);
  const blocks = extractLeafParagraphBlocks(documentXml);
  const listCounters = {};
  let index = 0;

  blocks.forEach(block => {
    const xml = block.xml || '';
    const candidates = paragraphTextCandidates(xml);
    const text = candidates[0] || '';
    const styleMatch = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(xml);
    const numIdMatch = /<w:numId\b[^>]*w:val="([^"]+)"/.exec(xml);
    const levelMatch = /<w:ilvl\b[^>]*w:val="([^"]+)"/.exec(xml);
    const numId = numIdMatch && numIdMatch[1] !== '0' ? numIdMatch[1] : '';
    const tableCell = tableInfo.cells.find(cell => block.start >= cell.start && block.start < cell.end) || null;
    const styleCandidates = runStyleCandidates(xml);
    const level = levelMatch ? Number(levelMatch[1]) : 0;
    let listOrdinal = 0;
    if (numId) {
      const key = `${numId}:${level}`;
      listCounters[key] = (listCounters[key] || 0) + 1;
      listOrdinal = listCounters[key];
    }

    const imageIds = [];
    // Modern DrawingML uses r:embed; older PDF-to-Word converters often use
    // VML <v:imagedata r:id="...">. Read both forms (and linked images) so
    // symbol/image options are not silently reduced to the placeholder text “图形”.
    const imagePattern = /(?:r:embed|r:link|r:id)="([^"]+)"/g;
    let imageMatch;
    while ((imageMatch = imagePattern.exec(xml))) {
      if (!imageIds.includes(imageMatch[1])) imageIds.push(imageMatch[1]);
    }

    const images = imageIds
      .map(id => relationships[id])
      .filter(Boolean)
      .map(target => {
        const normalized = target.replace(/^\.\.\//, '');
        return `${extractDir}/word/${normalized}`;
      })
      .filter(fileUtil.exists);

    if (text || images.length) {
      paragraphs.push({
        index,
        text,
        alternatives: candidates.slice(1),
        sourceStart: block.start || 0,
        insideTextBox: !!block.insideTextBox,
        style: styleMatch ? styleMatch[1] : '',
        styleAnswers: styleCandidates.map(item => item.text),
        styleAnswerDetails: styleCandidates,
        tableId: tableCell ? tableCell.tableId : 0,
        tableRow: tableCell ? tableCell.rowIndex : -1,
        tableCol: tableCell ? tableCell.colIndex : -1,
        numId,
        level,
        listOrdinal,
        images
      });
    }
    index += 1;
  });
  const repaired = repairExtractedOptionOverlays(paragraphs);
  repaired.tableContexts = tableInfo.tables;
  return repaired;
}

function extractDocx(extractDir) {
  const documentPath = `${extractDir}/word/document.xml`;
  if (!fileUtil.exists(documentPath)) {
    throw new Error('Word 文件缺少 word/document.xml，文件可能损坏或不是 DOCX。');
  }
  const documentXml = fileUtil.readTextAuto(documentPath);
  const relsPath = `${extractDir}/word/_rels/document.xml.rels`;
  const relsXml = fileUtil.exists(relsPath) ? fileUtil.readTextAuto(relsPath) : '';
  const relationships = parseRelationships(relsXml);
  return extractParagraphs(documentXml, relationships, extractDir);
}

module.exports = {
  parseRelationships,
  paragraphText,
  paragraphTextCandidates,
  extractLeafParagraphBlocks,
  extractParagraphs,
  runStyleCandidates,
  extractTableCellRanges,
  extractDocx
};
});
__define("services/xlsx-extractor.js", function(require, module, exports){
const fileUtil = require('../utils/file');
const { createId } = require('../utils/id');
const {
  decodeXmlEntities,
  normalizeText,
  normalizeOneLine,
  cleanQuestionText,
  cleanAnswerText,
  cleanAnalysisText,
  compactText,
  unique
} = require('../utils/text');
const { validateQuestion } = require('./question-validator');

const OPTION_KEYS = 'ABCDEFGHIJKL'.split('');
const TYPE_LABELS = {
  single: '单选题',
  multiple: '多选题',
  judge: '判断题',
  short: '简答题'
};
const DIFFICULTY_WORDS = /^(?:简单|容易|易|初级|基础|中等|中|一般|普通|较难|困难|难|高级)$/;

function attrValue(xml = '', name = '') {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`).exec(xml);
  return match ? decodeXmlEntities(match[1]) : '';
}

function normalizePartPath(basePath, target = '') {
  const cleanTarget = String(target || '').replace(/\\/g, '/');
  if (/^\//.test(cleanTarget)) return cleanTarget.replace(/^\/+/, '');
  const segments = `${basePath}/${cleanTarget}`.split('/');
  const result = [];
  segments.forEach(segment => {
    if (!segment || segment === '.') return;
    if (segment === '..') result.pop();
    else result.push(segment);
  });
  return result.join('/');
}

function parseRelationships(xml = '', basePath = '') {
  const result = {};
  const tags = String(xml || '').match(/<(?:[A-Za-z_][\w.-]*:)?Relationship\b[^>]*\/?>(?:<\/(?:[A-Za-z_][\w.-]*:)?Relationship>)?/g) || [];
  tags.forEach(tag => {
    const id = attrValue(tag, 'Id');
    const target = attrValue(tag, 'Target');
    const type = attrValue(tag, 'Type');
    if (id && target) result[id] = { target: normalizePartPath(basePath, target), type };
  });
  return result;
}

function textFromRichXml(xml = '') {
  const values = [];
  const pattern = /<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/g;
  let match;
  while ((match = pattern.exec(String(xml || '')))) values.push(decodeXmlEntities(match[1]));
  return normalizeText(values.join(''));
}

function parseSharedStrings(xml = '') {
  const values = [];
  const pattern = /<(?:[A-Za-z_][\w.-]*:)?si\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?si>/g;
  let match;
  while ((match = pattern.exec(String(xml || '')))) values.push(textFromRichXml(match[1]));
  return values;
}

function columnIndex(reference = '') {
  const letters = (/^[A-Z]+/i.exec(reference) || [''])[0].toUpperCase();
  let value = 0;
  for (let index = 0; index < letters.length; index += 1) value = value * 26 + letters.charCodeAt(index) - 64;
  return Math.max(0, value - 1);
}

function parseCellValue(cellXml, sharedStrings) {
  const type = attrValue(cellXml, 't');
  const formula = ((/<(?:[A-Za-z_][\w.-]*:)?f\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?f>/.exec(cellXml) || [])[1] || '');
  const inline = (/<(?:[A-Za-z_][\w.-]*:)?is\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?is>/.exec(cellXml) || [])[1];
  const raw = ((/<(?:[A-Za-z_][\w.-]*:)?v\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/.exec(cellXml) || [])[1] || '');
  let value = '';
  if (type === 's') value = sharedStrings[Number(raw)] || '';
  else if (type === 'inlineStr') value = textFromRichXml(inline || '');
  else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
  else if (type === 'str') value = decodeXmlEntities(raw);
  else value = decodeXmlEntities(raw);
  return { value: normalizeText(String(value || '')), formula: decodeXmlEntities(formula) };
}

function parseSheetRows(xml = '', sharedStrings = []) {
  const rows = [];
  const rowPattern = /<(?:[A-Za-z_][\w.-]*:)?row\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?row>/g;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(String(xml || '')))) {
    const rowNumber = Number(attrValue(rowMatch[1], 'r')) || rows.length + 1;
    const cells = {};
    const cellPattern = /<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>)/g;
    let cellMatch;
    while ((cellMatch = cellPattern.exec(rowMatch[2]))) {
      const reference = attrValue(cellMatch[1], 'r');
      const col = columnIndex(reference);
      const parsed = parseCellValue(`<c ${cellMatch[1]}>${cellMatch[2] || ''}</c>`, sharedStrings);
      cells[col] = { ...parsed, reference, col, row: rowNumber };
    }
    rows.push({ rowNumber, cells });
  }
  return rows;
}

function parseWorkbookSheets(workbookXml = '', rels = {}) {
  const sheets = [];
  const pattern = /<(?:[A-Za-z_][\w.-]*:)?sheet\b([^>]*)\/?>(?:<\/(?:[A-Za-z_][\w.-]*:)?sheet>)?/g;
  let match;
  while ((match = pattern.exec(String(workbookXml || '')))) {
    const name = attrValue(match[1], 'name');
    const relId = attrValue(match[1], 'r:id');
    const state = attrValue(match[1], 'state');
    if (!name || !rels[relId] || state === 'hidden' || state === 'veryHidden') continue;
    sheets.push({ name, path: rels[relId].target, relId });
  }
  return sheets;
}

function normalizeHeader(value = '') {
  return normalizeOneLine(value)
    .replace(/[\s_\-—－:：()（）【】\[\]]/g, '')
    .toUpperCase();
}

function optionKeyFromHeader(header = '') {
  const value = normalizeHeader(header);
  let match = /^(?:备选项|选项|答案选项)?([A-L])$/.exec(value);
  if (match) return match[1];
  match = /^([A-L])(?:备选项|选项|答案项)$/.exec(value);
  if (match) return match[1];
  match = /^(?:备选项|选项|答案项)([A-L])$/.exec(value);
  return match ? match[1] : '';
}

function classifyHeader(value = '') {
  const header = normalizeHeader(value);
  if (!header) return null;
  const optionKey = optionKeyFromHeader(header);
  if (optionKey) return { kind: 'option', key: optionKey };
  if (/^(?:序号|题号|编号|NO|ID|索引)$/.test(header)) return { kind: 'number' };
  if (/^(?:题干|题目|问题|试题|试题内容|题目内容|内容)$/.test(header)) return { kind: 'question' };
  if (/^(?:正确答案|标准答案|参考答案|答案|答)$/.test(header)) return { kind: 'answer' };
  if (/^(?:解析|答案解析|试题解析|错误解析|说明|备注)$/.test(header)) return { kind: 'analysis' };
  if (/^(?:题型|试题类型|题目类型|类型)$/.test(header)) return { kind: 'type' };
  if (/^(?:难度|试题难度|题目难度|难易程度|难易度)$/.test(header)) return { kind: 'difficulty' };
  if (/^(?:分类|类别|题目分类|知识点|章节|科目|专业|模块)$/.test(header)) return { kind: 'category' };
  if (/^(?:选项|备选项|答案选项)$/.test(header)) return { kind: 'combinedOptions' };
  return null;
}

function rowValues(row) {
  return Object.keys(row.cells)
    .map(Number)
    .sort((a, b) => a - b)
    .map(col => row.cells[col].value)
    .filter(value => normalizeOneLine(value));
}

function detectHeader(rows = []) {
  let best = null;
  rows.slice(0, 35).forEach((row, rowIndex) => {
    const mapping = { options: {} };
    let score = 0;
    Object.keys(row.cells).map(Number).forEach(col => {
      const classified = classifyHeader(row.cells[col].value);
      if (!classified) return;
      if (classified.kind === 'option') {
        mapping.options[classified.key] = col;
        score += 1.1;
      } else if (mapping[classified.kind] === undefined) {
        mapping[classified.kind] = col;
        score += classified.kind === 'question' ? 5 : classified.kind === 'answer' ? 3 : classified.kind === 'type' ? 2 : 1;
      }
    });
    const optionCount = Object.keys(mapping.options).length;
    const valid = mapping.question !== undefined && (mapping.answer !== undefined || optionCount >= 2 || mapping.type !== undefined);
    if (!valid) return;
    score += optionCount >= 2 ? 2 : 0;
    const candidate = { rowIndex, rowNumber: row.rowNumber, mapping, score };
    if (!best || candidate.score > best.score) best = candidate;
  });
  return best;
}

function normalizeDifficulty(value = '') {
  const clean = normalizeOneLine(value);
  if (!clean) return '';
  if (/^(?:简单|容易|易|初级|基础)$/.test(clean)) return '简单';
  if (/^(?:中等|中|一般|普通)$/.test(clean)) return '中等';
  if (/^(?:较难|困难|难|高级)$/.test(clean)) return '困难';
  return clean.length <= 12 ? clean : '';
}

function inferDifficultyColumn(rows, headerIndex, mapping) {
  if (mapping.difficulty !== undefined) return mapping.difficulty;
  const occupied = new Set([
    mapping.number, mapping.question, mapping.answer, mapping.analysis, mapping.type,
    mapping.category, mapping.combinedOptions, ...Object.values(mapping.options || {})
  ].filter(value => value !== undefined));
  const candidates = {};
  rows.slice(headerIndex + 1, headerIndex + 81).forEach(row => {
    Object.keys(row.cells).map(Number).forEach(col => {
      if (occupied.has(col)) return;
      const clean = normalizeOneLine(row.cells[col].value);
      if (!clean) return;
      const stat = candidates[col] || { nonEmpty: 0, difficulty: 0 };
      stat.nonEmpty += 1;
      if (DIFFICULTY_WORDS.test(clean)) stat.difficulty += 1;
      candidates[col] = stat;
    });
  });
  let best = null;
  Object.entries(candidates).forEach(([colText, stat]) => {
    if (stat.nonEmpty < 3 || stat.difficulty / stat.nonEmpty < 0.6) return;
    const candidate = { col: Number(colText), score: stat.difficulty / stat.nonEmpty, count: stat.difficulty };
    if (!best || candidate.score > best.score || (candidate.score === best.score && candidate.count > best.count)) best = candidate;
  });
  return best ? best.col : undefined;
}

function typeInfo(value = '') {
  const clean = normalizeOneLine(value);
  if (!clean) return null;
  if (/多选|多项/.test(clean)) return { type: 'multiple', label: '多选题' };
  if (/判断|对错|是非/.test(clean)) return { type: 'judge', label: '判断题' };
  if (/单选|单项/.test(clean)) return { type: 'single', label: '单选题' };
  if (/填空/.test(clean)) return { type: 'short', label: '填空题' };
  if (/画图|作图|绘图/.test(clean)) return { type: 'short', label: '画图题' };
  if (/计算/.test(clean)) return { type: 'short', label: '计算题' };
  if (/简答|问答|论述|实操|主观/.test(clean)) return { type: 'short', label: clean.replace(/[\s（(].*$/, '') || '简答题' };
  return null;
}

function parseCombinedOptions(value = '') {
  const text = normalizeText(value);
  const markers = [];
  const pattern = /(?:^|[\n\s；;。？！?：:])(?:[（(]?\s*)?([A-L])\s*(?:[）)]|[.、．:：)）])\s*/ig;
  let match;
  while ((match = pattern.exec(text))) markers.push({ key: match[1].toUpperCase(), start: match.index, end: pattern.lastIndex });
  const first = markers.findIndex(item => item.key === 'A');
  if (first < 0) return [];
  const accepted = [];
  let expected = 65;
  for (let index = first; index < markers.length; index += 1) {
    if (markers[index].key.charCodeAt(0) !== expected) break;
    accepted.push(markers[index]);
    expected += 1;
  }
  return accepted.map((item, index) => ({
    key: item.key,
    text: cleanQuestionText(text.slice(item.end, accepted[index + 1] ? accepted[index + 1].start : text.length))
  })).filter(item => item.text);
}

function truthValue(value = '') {
  const clean = normalizeOneLine(value).toUpperCase();
  if (/^(?:正确|对|是|√|✓|✔|TRUE|T|Y|YES)$/.test(clean)) return true;
  if (/^(?:错误|错|否|×|✕|✖|FALSE|F|N|NO)$/.test(clean)) return false;
  return null;
}

function normalizeAnswerKeys(value = '', options = [], type = 'single') {
  const raw = normalizeOneLine(value).toUpperCase();
  if (!raw) return [];
  if (/^(?:全选|全部|全部正确|以上都是|均正确|ALL)$/.test(raw)) return options.map(item => item.key);
  if (type === 'judge') {
    const semantic = truthValue(raw);
    if (semantic !== null) {
      const matched = options.find(item => truthValue(item.text) === semantic);
      return matched ? [matched.key] : [semantic ? 'A' : 'B'];
    }
  }
  const keys = [];
  const compact = raw.replace(/[^A-L]/g, '');
  for (let index = 0; index < compact.length; index += 1) {
    const key = compact[index];
    if (!keys.includes(key)) keys.push(key);
  }
  return keys.filter(key => options.some(item => item.key === key));
}

function parseCellImages(extractDir) {
  const xmlPath = `${extractDir}/xl/cellimages.xml`;
  const relPath = `${extractDir}/xl/_rels/cellimages.xml.rels`;
  if (!fileUtil.exists(xmlPath) || !fileUtil.exists(relPath)) return {};
  const rels = parseRelationships(fileUtil.readTextAuto(relPath), 'xl');
  const xml = fileUtil.readTextAuto(xmlPath);
  const result = {};
  const pattern = /<etc:cellImage\b[^>]*>([\s\S]*?)<\/etc:cellImage>/g;
  let match;
  while ((match = pattern.exec(xml))) {
    const name = attrValue((/<xdr:cNvPr\b([^>]*)\/?>(?:<\/xdr:cNvPr>)?/.exec(match[1]) || [])[1] || '', 'name');
    const relId = attrValue((/<a:blip\b([^>]*)\/?>(?:<\/a:blip>)?/.exec(match[1]) || [])[1] || '', 'r:embed');
    if (name && rels[relId]) result[name] = `${extractDir}/${rels[relId].target}`;
  }
  return result;
}

function parseDrawingImages(extractDir, sheetPath) {
  const slash = sheetPath.lastIndexOf('/');
  const directory = sheetPath.slice(0, slash);
  const fileName = sheetPath.slice(slash + 1);
  const relPath = `${extractDir}/${directory}/_rels/${fileName}.rels`;
  if (!fileUtil.exists(relPath)) return {};
  const sheetRels = parseRelationships(fileUtil.readTextAuto(relPath), directory);
  const drawingRel = Object.values(sheetRels).find(item => /\/drawing$/.test(item.type || '') || /drawings\//.test(item.target));
  if (!drawingRel) return {};
  const drawingPath = drawingRel.target;
  const drawingXmlPath = `${extractDir}/${drawingPath}`;
  if (!fileUtil.exists(drawingXmlPath)) return {};
  const drawingSlash = drawingPath.lastIndexOf('/');
  const drawingDir = drawingPath.slice(0, drawingSlash);
  const drawingName = drawingPath.slice(drawingSlash + 1);
  const drawingRelsPath = `${extractDir}/${drawingDir}/_rels/${drawingName}.rels`;
  const drawingRels = fileUtil.exists(drawingRelsPath)
    ? parseRelationships(fileUtil.readTextAuto(drawingRelsPath), drawingDir)
    : {};
  const xml = fileUtil.readTextAuto(drawingXmlPath);
  const byRow = {};
  const pattern = /<xdr:(?:twoCellAnchor|oneCellAnchor)\b[^>]*>([\s\S]*?)<\/xdr:(?:twoCellAnchor|oneCellAnchor)>/g;
  let match;
  while ((match = pattern.exec(xml))) {
    const from = (/<xdr:from>([\s\S]*?)<\/xdr:from>/.exec(match[1]) || [])[1] || '';
    const row = Number(((/<xdr:row>(\d+)<\/xdr:row>/.exec(from) || [])[1])) + 1;
    const col = Number(((/<xdr:col>(\d+)<\/xdr:col>/.exec(from) || [])[1]));
    const blip = /<a:blip\b([^>]*)\/?>(?:<\/a:blip>)?/.exec(match[1]);
    const relId = blip ? attrValue(blip[1], 'r:embed') : '';
    if (!row || !Number.isFinite(col) || !drawingRels[relId]) continue;
    const path = `${extractDir}/${drawingRels[relId].target}`;
    if (!byRow[row]) byRow[row] = {};
    if (!byRow[row][col]) byRow[row][col] = [];
    if (!byRow[row][col].includes(path)) byRow[row][col].push(path);
  }
  return byRow;
}

function formulaImagePath(formula = '', cellImages = {}) {
  const match = /DISPIMG\s*\(\s*["']([^"']+)["']/i.exec(formula || '');
  return match ? (cellImages[match[1]] || '') : '';
}

function allImagesForCell(row, col, drawingImages, cellImages) {
  const result = [];
  const drawn = drawingImages[row.rowNumber] && drawingImages[row.rowNumber][col];
  (drawn || []).forEach(path => { if (path && !result.includes(path)) result.push(path); });
  const cell = row.cells[col];
  const formulaImage = cell ? formulaImagePath(cell.formula, cellImages) : '';
  if (formulaImage && !result.includes(formulaImage)) result.push(formulaImage);
  return result;
}

function rawSourceForRow(row, headers) {
  const rawTexts = [];
  Object.keys(row.cells).map(Number).sort((a, b) => a - b).forEach(col => {
    const value = normalizeText(row.cells[col].value || '');
    const formula = normalizeText(row.cells[col].formula || '');
    if (!value && !formula) return;
    const label = normalizeOneLine(headers[col] || '') || `第${col + 1}列`;
    rawTexts.push(`${label}：${value || formula}`);
  });
  return rawTexts;
}

function combineCategory(sheetName, explicitCategory, multipleSheets, displayTypeLabel) {
  const explicit = normalizeOneLine(explicitCategory || '');
  const sheet = normalizeOneLine(sheetName || '');
  if (multipleSheets) {
    if (explicit && compactText(explicit) !== compactText(sheet)) return `${sheet} · ${explicit}`;
    return sheet || explicit || displayTypeLabel;
  }
  return explicit || displayTypeLabel;
}

function isGenericVisualPlaceholder(value = '') {
  const clean = normalizeOneLine(value || '')
    .replace(/[\s()（）\[\]【】<>《》]/g, '')
    .replace(/[.。:：、，,;；]/g, '')
    .toLowerCase();
  return /^(?:图|图形|图片|图示|示意图|符号图|见图|如下图)$/.test(clean);
}

function createQuestionFromRow(context) {
  const {
    row, mapping, headers, sheetName, multipleSheets, sheetType, difficultyColumn,
    drawingImages, cellImages, order, sourceKind = 'xlsx', boundarySource = 'Excel 表格行'
  } = context;
  const valueAt = col => col === undefined || !row.cells[col] ? '' : row.cells[col].value;
  const questionText = cleanQuestionText(valueAt(mapping.question));
  const questionImages = allImagesForCell(row, mapping.question, drawingImages, cellImages);
  if (!questionText && !questionImages.length) return null;
  if (/^(?:合计|总计|小计|数量|题型)$/.test(normalizeOneLine(questionText))) return null;

  const explicitType = typeInfo(valueAt(mapping.type));
  const inferredSheetType = sheetType || null;
  let typeMeta = explicitType || inferredSheetType;

  let options = [];
  Object.keys(mapping.options || {}).sort().forEach(key => {
    const col = mapping.options[key];
    const rawText = cleanQuestionText(valueAt(col));
    const images = allImagesForCell(row, col, drawingImages, cellImages);
    const text = images.length && isGenericVisualPlaceholder(rawText) ? '' : rawText;
    if (text || images.length) options.push({ key, text, images });
  });
  if (!options.length && mapping.combinedOptions !== undefined) options = parseCombinedOptions(valueAt(mapping.combinedOptions));

  let rawAnswer = valueAt(mapping.answer);
  if (!rawAnswer && options.length >= 3) {
    const lastOption = options[options.length - 1];
    const existingKeys = options.slice(0, -1).map(item => item.key);
    const compactAnswer = normalizeOneLine(lastOption.text || '').toUpperCase().replace(/[^A-L]/g, '');
    const looksShiftedAnswer = compactAnswer && compactAnswer.length <= existingKeys.length &&
      compactAnswer.split('').every(key => existingKeys.includes(key)) &&
      /^(?:[A-L](?:[\s,，、/\|]*[A-L])*)$/.test(normalizeOneLine(lastOption.text || '').toUpperCase());
    if (looksShiftedAnswer) {
      rawAnswer = lastOption.text;
      options = options.slice(0, -1);
    }
  }
  if (!typeMeta) {
    const semantics = options.map(item => truthValue(item.text));
    if (options.length === 2 && semantics.includes(true) && semantics.includes(false)) typeMeta = { type: 'judge', label: '判断题' };
    else if (!options.length) typeMeta = { type: 'short', label: '简答题' };
    else {
      const answerLetters = normalizeOneLine(rawAnswer).toUpperCase().replace(/[^A-L]/g, '');
      typeMeta = answerLetters.length >= 2 ? { type: 'multiple', label: '多选题' } : { type: 'single', label: '单选题' };
    }
  }

  const type = typeMeta.type;
  if (type === 'judge' && options.length < 2) {
    options = [{ key: 'A', text: '正确', images: [] }, { key: 'B', text: '错误', images: [] }];
  }
  const answerImages = allImagesForCell(row, mapping.answer, drawingImages, cellImages);
  const answer = type === 'short' ? [] : normalizeAnswerKeys(rawAnswer, options, type);
  const answerText = type === 'short' ? cleanAnswerText(rawAnswer) : '';
  const analysis = cleanAnalysisText(valueAt(mapping.analysis));
  const analysisImages = allImagesForCell(row, mapping.analysis, drawingImages, cellImages);
  const difficulty = normalizeDifficulty(valueAt(difficultyColumn));
  const displayTypeLabel = typeMeta.label || TYPE_LABELS[type] || type;
  const explicitCategory = valueAt(mapping.category);
  const category = combineCategory(sheetName, explicitCategory, multipleSheets, displayTypeLabel);
  const number = normalizeOneLine(valueAt(mapping.number)) || String(order);
  const rawTexts = rawSourceForRow(row, headers);

  const question = {
    id: createId('q'),
    number,
    order,
    level: '',
    category,
    chapter: multipleSheets ? sheetName : '',
    type,
    displayTypeLabel,
    sourceTypeLabel: displayTypeLabel,
    difficulty,
    question: questionText || '图片题',
    options,
    answer,
    answerText,
    analysis,
    images: questionImages,
    answerImages,
    analysisImages,
    boundarySource,
    answerSource: mapping.answer !== undefined ? `${String(sourceKind || 'table').toUpperCase()} 答案列` : '',
    answerBoundarySource: mapping.answer !== undefined ? `${String(sourceKind || 'table').toUpperCase()} 固定列` : '',
    answerBoundaryConfidence: mapping.answer !== undefined ? 1 : 0,
    inferredBoundary: false,
    source: {
      kind: sourceKind,
      sheetName,
      rowNumber: row.rowNumber,
      rawTexts
    }
  };
  if (type === 'short' && !question.answerText && question.answerImages.length) question.answerSource = 'Excel 答案图片';
  return Object.assign(question, validateQuestion(question));
}

function findDeclaredCounts(sheetContexts = []) {
  const byLabel = {};
  let total = 0;
  sheetContexts.forEach(context => {
    for (let index = 0; index < context.rows.length - 1; index += 1) {
      const headerRow = context.rows[index];
      const headerCells = Object.keys(headerRow.cells).map(Number).sort((a, b) => a - b);
      if (!headerCells.some(col => /^(?:题型|类型)$/.test(normalizeOneLine(headerRow.cells[col].value)))) continue;
      const countRow = context.rows[index + 1];
      const firstValue = normalizeOneLine((countRow.cells[headerCells[0]] || {}).value || '');
      if (!/^(?:数量|题数|合计)$/.test(firstValue)) continue;
      headerCells.forEach(col => {
        const label = normalizeOneLine(headerRow.cells[col].value || '');
        const value = Number(String((countRow.cells[col] || {}).value || '').replace(/,/g, ''));
        if (!label || !Number.isFinite(value) || value <= 0) return;
        byLabel[label] = value;
      });
    }
    context.rows.forEach(row => {
      const values = rowValues(row);
      if (!values.some(value => /^(?:合计|总计|题目总数|题库总数)$/.test(normalizeOneLine(value)))) return;
      Object.values(row.cells).forEach(cell => {
        const value = Number(String(cell.value || '').replace(/,/g, ''));
        if (Number.isFinite(value) && value > total && value < 100000) total = value;
      });
    });
  });
  if (!total) total = Object.entries(byLabel)
    .filter(([label]) => !/^(?:合计|总计)$/.test(label))
    .reduce((sum, [, value]) => sum + value, 0);
  return { byLabel, total };
}

function extractXlsx(extractDir, options = {}) {
  const workbookPath = `${extractDir}/xl/workbook.xml`;
  const relPath = `${extractDir}/xl/_rels/workbook.xml.rels`;
  if (!fileUtil.exists(workbookPath) || !fileUtil.exists(relPath)) throw new Error('Excel 文件结构不完整：缺少工作簿信息。');
  const workbookRels = parseRelationships(fileUtil.readTextAuto(relPath), 'xl');
  const sheets = parseWorkbookSheets(fileUtil.readTextAuto(workbookPath), workbookRels);
  const sharedStringsPath = `${extractDir}/xl/sharedStrings.xml`;
  const sharedStrings = fileUtil.exists(sharedStringsPath) ? parseSharedStrings(fileUtil.readTextAuto(sharedStringsPath)) : [];
  const cellImages = parseCellImages(extractDir);

  const contexts = sheets.map(sheet => {
    const path = `${extractDir}/${sheet.path}`;
    if (!fileUtil.exists(path)) return { ...sheet, rows: [], header: null, skippedReason: '工作表文件缺失' };
    const rows = parseSheetRows(fileUtil.readTextAuto(path), sharedStrings);
    const header = detectHeader(rows);
    const drawingImages = parseDrawingImages(extractDir, sheet.path);
    return { ...sheet, rows, header, drawingImages, skippedReason: header ? '' : '未检测到题干/答案表头' };
  });

  const dataContexts = contexts.filter(item => item.header);
  if (!dataContexts.length) throw new Error('没有找到可导入的题目表。请确认表格包含“题干/题目”和“答案/选项”等列。');
  const multipleSheets = dataContexts.length > 1;
  const questions = [];
  const skippedRows = [];
  const difficultyCounts = {};
  const categoryCounts = {};
  const displayTypeCounts = {};
  let order = 1;

  dataContexts.forEach(context => {
    const headers = {};
    Object.keys(context.rows[context.header.rowIndex].cells).map(Number).forEach(col => {
      headers[col] = context.rows[context.header.rowIndex].cells[col].value;
    });
    const mapping = context.header.mapping;
    const difficultyColumn = inferDifficultyColumn(context.rows, context.header.rowIndex, mapping);
    const sheetType = typeInfo(context.name) || (() => {
      for (let index = Math.max(0, context.header.rowIndex - 3); index < context.header.rowIndex; index += 1) {
        const found = rowValues(context.rows[index] || { cells: {} }).map(typeInfo).find(Boolean);
        if (found) return found;
      }
      return null;
    })();

    context.rows.slice(context.header.rowIndex + 1).forEach(row => {
      const question = createQuestionFromRow({
        row,
        mapping,
        headers,
        sheetName: context.name,
        multipleSheets,
        sheetType,
        difficultyColumn,
        drawingImages: context.drawingImages,
        cellImages,
        order
      });
      if (!question) {
        if (rowValues(row).length) skippedRows.push({ sheetName: context.name, rowNumber: row.rowNumber, preview: rowValues(row).slice(0, 4).join(' / ') });
        return;
      }
      questions.push(question);
      order += 1;
      if (question.difficulty) difficultyCounts[question.difficulty] = (difficultyCounts[question.difficulty] || 0) + 1;
      if (question.category) categoryCounts[question.category] = (categoryCounts[question.category] || 0) + 1;
      const label = question.displayTypeLabel || TYPE_LABELS[question.type] || question.type;
      displayTypeCounts[label] = (displayTypeCounts[label] || 0) + 1;
    });
  });

  const declared = findDeclaredCounts(contexts);
  const importedBySheet = questions.reduce((acc, question) => {
    const sheetName = question.source && question.source.sheetName ? question.source.sheetName : '';
    if (sheetName) acc[sheetName] = (acc[sheetName] || 0) + 1;
    return acc;
  }, {});
  const sourceDeclaredMissingItems = [];
  const sourceDeclaredExtraItems = [];
  const declaredCountForSheet = sheetName => {
    if (Number(declared.byLabel[sheetName])) return Number(declared.byLabel[sheetName]);
    const sheetCompact = compactText(sheetName).replace(/题$/, '');
    const matched = Object.keys(declared.byLabel).find(label => {
      const labelCompact = compactText(label).replace(/题$/, '');
      return labelCompact === sheetCompact || (typeInfo(label) && typeInfo(sheetName) && typeInfo(label).label === typeInfo(sheetName).label);
    });
    return matched ? Number(declared.byLabel[matched]) || 0 : 0;
  };
  dataContexts.forEach(context => {
    const expected = declaredCountForSheet(context.name);
    if (!expected) return;
    const actual = importedBySheet[context.name] || 0;
    if (actual < expected) {
      const missing = expected - actual;
      for (let index = 0; index < missing; index += 1) {
        const typeMeta = typeInfo(context.name) || { type: 'short', label: context.name || '未知题型' };
        const message = `统计表声明“${context.name}”共 ${expected} 道，但实际表格只读取到 ${actual} 行题目。`;
        questions.push({
          id: createId('xlsx-missing'),
          number: '',
          order: order++,
          level: '',
          category: context.name,
          chapter: context.name,
          type: typeMeta.type,
          displayTypeLabel: typeMeta.label,
          sourceTypeLabel: typeMeta.label,
          difficulty: '',
          question: `[原表缺失占位] ${message}`,
          options: [],
          answer: [],
          answerText: '',
          analysis: message,
          images: [],
          answerImages: [],
          sourceMissingPlaceholder: true,
          nonPractice: true,
          boundarySource: 'Excel 数量统计表',
          answerSource: '原表未提供',
          issues: ['原表统计数量与题目行数不一致'],
          confidence: 0,
          status: 'error',
          source: { kind: 'xlsx', sheetName: context.name, rowNumber: 0, rawTexts: [message] }
        });
        sourceDeclaredMissingItems.push({ sheetName: context.name, number: '', message });
      }
    } else if (actual > expected) {
      sourceDeclaredExtraItems.push({
        sheetName: context.name,
        number: '',
        message: `统计表声明“${context.name}”共 ${expected} 道，但实际读取到 ${actual} 行题目。`
      });
    }
  });
  const expectedQuestionCount = declared.total || questions.length;
  const diagnostics = {
    sourceKind: 'xlsx',
    workbookSheetCount: sheets.length,
    dataSheetCount: dataContexts.length,
    importedSheetNames: dataContexts.map(item => item.name),
    skippedSheetNames: contexts.filter(item => !item.header).map(item => item.name),
    skippedSheetReasons: contexts.filter(item => !item.header).map(item => `${item.name}：${item.skippedReason}`),
    sourceRowCount: dataContexts.reduce((sum, item) => sum + Math.max(0, item.rows.length - item.header.rowIndex - 1), 0),
    importedRowCount: questions.length,
    skippedRowCount: skippedRows.length,
    skippedRows: skippedRows.slice(0, 100),
    difficultyCounts,
    categoryCounts,
    displayTypeCounts,
    embeddedImageQuestionCount: questions.filter(item => (item.images || []).length || (item.answerImages || []).length || (item.options || []).some(option => (option.images || []).length)).length,
    expectedQuestionCount,
    expectedCountGap: expectedQuestionCount ? expectedQuestionCount - questions.length : 0,
    sourceParagraphCount: 0,
    effectiveParagraphCount: 0,
    removedNoiseCount: contexts.length - dataContexts.length,
    splitQuestionStartRepairCount: 0,
    noPunctuationBoundaryRepairCount: 0,
    sourceDeclaredMissingCount: sourceDeclaredMissingItems.length,
    sourceDeclaredMissingItems,
    sourceDeclaredExtraCount: sourceDeclaredExtraItems.length,
    sourceDeclaredExtraItems,
    sourceContentQuestionCount: questions.filter(item => !item.sourceMissingPlaceholder).length,
    accountedQuestionCount: questions.length,
    inferredBoundaryCount: 0,
    inlineAnswerCount: 0,
    duplicateCount: 0,
    unlabeledAnswerCount: 0,
    detectedBoundaryCount: questions.filter(item => !item.sourceMissingPlaceholder).length,
    explicitBoundaryCount: questions.filter(item => !item.sourceMissingPlaceholder).length,
    preservedFailedBoundaryCount: sourceDeclaredMissingItems.length,
    discardedBoundaryCount: 0,
    assignedParagraphCount: 0,
    unassignedParagraphCount: 0,
    numberingGapCount: 0,
    silentLossCount: 0,
    unassignedFragments: [],
    discardedFragments: [],
    numberingIssues: []
  };
  return { questions, diagnostics, expectedQuestionCount };
}

module.exports = {
  extractXlsx,
  createQuestionFromRow,
  parseSharedStrings,
  parseSheetRows,
  detectHeader,
  inferDifficultyColumn,
  normalizeDifficulty,
  typeInfo,
  normalizeAnswerKeys,
  parseRelationships,
  parseWorkbookSheets
};
});
__define("services/pdf-extractor.js", function(require, module, exports){
const fileUtil = require('../utils/file');
const { repairMojibake, repairKnownEngineeringNotation, hasEncodingAnomaly } = require('../utils/text');

function bytesFromBase64(value = '') {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i) & 255;
  return out;
}
function base64FromBytes(bytes) {
  let binary = '';
  const step = 0x6000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + step)));
  return btoa(binary);
}
function latin1(bytes) {
  let value = '';
  const step = 0x6000;
  for (let i = 0; i < bytes.length; i += step) value += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + step)));
  return value;
}
async function inflate(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('当前系统 WebView 不支持标准 PDF 解压，请更新 Android System WebView');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflate(bytes) {
  if (typeof CompressionStream !== 'function') throw new Error('当前系统 WebView 不支持 PNG 编码，请更新 Android System WebView');
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  parts.forEach(part => { out.set(part, offset); offset += part.length; });
  return out;
}
function uint32be(value) {
  const out = new Uint8Array(4);
  const view = new DataView(out.buffer);
  view.setUint32(0, value >>> 0, false);
  return out;
}
let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function asciiBytes(value) {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) out[i] = value.charCodeAt(i) & 255;
  return out;
}
function pngChunk(type, data) {
  const typeBytes = asciiBytes(type);
  return concatBytes([uint32be(data.length), typeBytes, data, uint32be(crc32(concatBytes([typeBytes, data])))]);
}
async function pngFromPixels(raw, width, height, colorSpace, bitsPerComponent) {
  if (!(width > 0 && height > 0)) throw new Error('PDF 图片缺少尺寸');
  if (bitsPerComponent !== 8) throw new Error('暂不支持非 8 位 PDF 位图');
  const normalized = String(colorSpace || '').replace(/^\//, '');
  const channels = normalized === 'DeviceGray' || normalized === 'G' ? 1 : (normalized === 'DeviceRGB' || normalized === 'RGB' ? 3 : 0);
  if (!channels) throw new Error(`暂不支持 PDF 图片色彩空间：${normalized || '未知'}`);
  const rowBytes = width * channels;
  const expected = rowBytes * height;
  if (raw.length < expected) throw new Error(`PDF 图片像素不足：${raw.length}/${expected}`);
  const filtered = new Uint8Array((rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const target = row * (rowBytes + 1);
    filtered[target] = 0;
    filtered.set(raw.subarray(row * rowBytes, row * rowBytes + rowBytes), target + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : 2;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const signature = new Uint8Array([137,80,78,71,13,10,26,10]);
  const compressed = await deflate(filtered);
  return concatBytes([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', new Uint8Array())]);
}

function parseObjects(bytes) {
  const text = latin1(bytes);
  const matches = [];
  const re = /(^|[\r\n])\s*(\d+)\s+(\d+)\s+obj\b/g;
  let match;
  while ((match = re.exec(text))) matches.push({ id: Number(match[2]), gen: Number(match[3]), start: re.lastIndex });
  const objects = {};
  matches.forEach((item, index) => {
    const limit = index + 1 < matches.length ? matches[index + 1].start : text.length;
    const end = text.lastIndexOf('endobj', limit);
    const bodyEnd = end >= item.start ? end : limit;
    const body = text.slice(item.start, bodyEnd);
    const streamMatch = /stream\r?\n/.exec(body);
    let dict = body;
    let stream = null;
    let streamStart = -1;
    if (streamMatch) {
      dict = body.slice(0, streamMatch.index);
      streamStart = item.start + streamMatch.index + streamMatch[0].length;
    }
    objects[item.id] = { id: item.id, dict, body, stream, streamStart, bodyEnd, decoded: null };
  });
  Object.values(objects).forEach(object => {
    if (object.streamStart < 0) return;
    let length = 0;
    const direct = /\/Length\s+(\d+)\b/.exec(object.dict);
    const indirect = /\/Length\s+(\d+)\s+\d+\s+R/.exec(object.dict);
    if (indirect && objects[Number(indirect[1])]) length = Number((objects[Number(indirect[1])].body.match(/\d+/) || [0])[0]);
    else if (direct) length = Number(direct[1]);
    if (length > 0 && object.streamStart + length <= bytes.length) object.stream = bytes.slice(object.streamStart, object.streamStart + length);
    else {
      const endStream = text.indexOf('endstream', object.streamStart);
      if (endStream >= 0) {
        let end = endStream;
        if (bytes[end - 2] === 13 && bytes[end - 1] === 10) end -= 2; else if (bytes[end - 1] === 10 || bytes[end - 1] === 13) end -= 1;
        object.stream = bytes.slice(object.streamStart, end);
      }
    }
  });
  return objects;
}

async function expandObjectStreams(objects) {
  // Modern PDF generators commonly place small dictionaries (fonts, resources,
  // annotations, etc.) inside /ObjStm streams.  The first parser pass only sees
  // regular "n 0 obj" records, so those compressed objects must be expanded
  // before page resources and ToUnicode maps are resolved.
  const streams = Object.values(objects).filter(object => /\/Type\s*\/ObjStm\b/.test(object.dict || ''));
  for (const object of streams) {
    const nValue = readPdfValue(object.dict, 'N');
    const firstValue = readPdfValue(object.dict, 'First');
    const count = Number(nValue && nValue.value) || 0;
    const first = Number(firstValue && firstValue.value) || 0;
    if (!(count > 0) || !(first >= 0)) continue;
    const decoded = await decodedStream(object);
    if (!decoded.length || first >= decoded.length) continue;
    const header = latin1(decoded.subarray(0, first));
    const numbers = (header.match(/\d+/g) || []).map(Number);
    const entries = [];
    for (let i = 0; i + 1 < numbers.length && entries.length < count; i += 2) {
      entries.push({ id: numbers[i], offset: numbers[i + 1] });
    }
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const start = first + entry.offset;
      const end = i + 1 < entries.length ? first + entries[i + 1].offset : decoded.length;
      if (!(start >= first && end > start && end <= decoded.length)) continue;
      const body = latin1(decoded.subarray(start, end)).trim();
      if (!body || objects[entry.id]) continue;
      objects[entry.id] = {
        id: entry.id,
        gen: 0,
        dict: body,
        body,
        stream: null,
        streamStart: -1,
        bodyEnd: -1,
        decoded: null,
        compressedIn: object.id
      };
    }
  }
  return objects;
}

async function decodedStream(object) {
  if (!object || !object.stream) return new Uint8Array();
  if (object.decoded) return object.decoded;
  let bytes = object.stream;
  if (/\/FlateDecode\b/.test(object.dict)) bytes = await inflate(bytes);
  object.decoded = bytes;
  return bytes;
}
function ref(value = '') { const m = /(\d+)\s+\d+\s+R/.exec(value); return m ? Number(m[1]) : 0; }
function refs(value = '') { return Array.from(value.matchAll(/(\d+)\s+\d+\s+R/g)).map(m => Number(m[1])); }
function readPdfValue(value = '', key = '') {
  const match = new RegExp('/' + key + '\\b').exec(value);
  if (!match) return null;
  let index = match.index + match[0].length;
  while (index < value.length && /\s/.test(value[index])) index += 1;
  if (value.slice(index, index + 2) === '<<') {
    const open = index;
    let depth = 0;
    for (let i = open; i < value.length - 1; i += 1) {
      const pair = value.slice(i, i + 2);
      if (pair === '<<') { depth += 1; i += 1; }
      else if (pair === '>>') {
        depth -= 1;
        if (!depth) return { type: 'dict', value: value.slice(open + 2, i) };
        i += 1;
      }
    }
    return null;
  }
  if (value[index] === '[') {
    const open = index;
    let depth = 0;
    for (let i = open; i < value.length; i += 1) {
      if (value[i] === '[') depth += 1;
      else if (value[i] === ']') { depth -= 1; if (!depth) return { type: 'array', value: value.slice(open + 1, i) }; }
    }
    return null;
  }
  const tail = value.slice(index);
  const reference = /^(\d+)\s+\d+\s+R\b/.exec(tail);
  if (reference) return { type: 'ref', value: Number(reference[1]) };
  const name = /^\/([^\s/<>{}\[\]()]+)/.exec(tail);
  if (name) return { type: 'name', value: name[1] };
  const scalar = /^([^\s/<>{}\[\]()]+)/.exec(tail);
  return scalar ? { type: 'scalar', value: scalar[1] } : null;
}
function dictSection(value = '', key = '') {
  const parsed = readPdfValue(value, key);
  return parsed && parsed.type === 'dict' ? parsed.value : '';
}
function namedRefs(section = '') {
  const result = {};
  const re = /\/([^\s/<>{}\[\]()]+)\s+(\d+)\s+\d+\s+R/g;
  let m; while ((m = re.exec(section))) result[m[1]] = Number(m[2]);
  return result;
}
function resolvePageOrder(objects) {
  const catalog = Object.values(objects).find(object => /\/Type\s*\/Catalog\b/.test(object.dict));
  const pagesValue = catalog ? readPdfValue(catalog.dict, 'Pages') : null;
  const rootId = pagesValue && pagesValue.type === 'ref' ? pagesValue.value : 0;
  const result = [];
  const visit = id => {
    const object = objects[id]; if (!object) return;
    if (/\/Type\s*\/Page\b/.test(object.dict) && !/\/Type\s*\/Pages\b/.test(object.dict)) { result.push(id); return; }
    const kidsValue = readPdfValue(object.dict, 'Kids');
    (kidsValue && kidsValue.type === 'array' ? refs(kidsValue.value) : []).forEach(visit);
  };
  if (rootId) visit(rootId);
  if (!result.length) Object.values(objects).filter(object => /\/Type\s*\/Page\b/.test(object.dict) && !/\/Type\s*\/Pages\b/.test(object.dict)).sort((a,b)=>a.id-b.id).forEach(object => result.push(object.id));
  return result;
}
function inheritedValue(objects, page, key) {
  let current = page;
  for (let guard = 0; current && guard < 20; guard += 1) {
    const found = readPdfValue(current.dict, key);
    if (found) return found;
    const parentValue = readPdfValue(current.dict, 'Parent');
    current = objects[parentValue && parentValue.type === 'ref' ? parentValue.value : 0];
  }
  return null;
}
function resourceDictionary(objects, page) {
  const resourceValue = inheritedValue(objects, page, 'Resources');
  if (!resourceValue) return '';
  if (resourceValue.type === 'dict') return resourceValue.value;
  if (resourceValue.type === 'ref' && objects[resourceValue.value]) return objects[resourceValue.value].dict || objects[resourceValue.value].body || '';
  return '';
}
function inheritedResourceRefs(objects, page, key) {
  const resources = resourceDictionary(objects, page);
  const value = readPdfValue(resources, key);
  if (!value) return {};
  if (value.type === 'dict') return namedRefs(value.value);
  if (value.type === 'ref' && objects[value.value]) return namedRefs(objects[value.value].dict || objects[value.value].body || '');
  return {};
}
function hexBytes(hex = '') {
  const clean = hex.replace(/\s+/g, '');
  const value = clean.length % 2 ? `${clean}0` : clean;
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16) || 0;
  return out;
}
function utf16be(hex = '') {
  const bytes = hexBytes(hex);
  let start = bytes[0] === 0xFE && bytes[1] === 0xFF ? 2 : 0;
  let out = '';
  for (let i = start; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  return out;
}
function parseCMap(text = '') {
  const map = {};
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const match of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map[match[1].toUpperCase()] = utf16be(match[2]);
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1];
    for (const match of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const first = parseInt(match[1], 16);
      const last = parseInt(match[2], 16);
      const destination = parseInt(match[3], 16);
      const sourceWidth = match[1].length;
      for (let code = first; code <= last && code - first < 4096; code += 1) {
        const destinationHex = (destination + code - first).toString(16).toUpperCase().padStart(match[3].length, '0');
        map[code.toString(16).toUpperCase().padStart(sourceWidth, '0')] = utf16be(destinationHex);
      }
    }
    for (const match of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const first = parseInt(match[1], 16);
      const values = Array.from(match[3].matchAll(/<([0-9A-Fa-f]+)>/g));
      values.forEach((value, index) => {
        map[(first + index).toString(16).toUpperCase().padStart(match[1].length, '0')] = utf16be(value[1]);
      });
    }
  }
  const codeSpaceLengths = [];
  for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    for (const match of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) codeSpaceLengths.push(match[1].length / 2);
  }
  const lengths = Array.from(new Set([
    ...Object.keys(map).map(key => key.length / 2),
    ...codeSpaceLengths
  ])).filter(value => value > 0).sort((a, b) => b - a);
  return { map, lengths: lengths.length ? lengths : [2, 1] };
}

const GLYPH_NAMES = {
  space:' ', exclam:'!', quotedbl:'"', numbersign:'#', dollar:'$', percent:'%', ampersand:'&', quotesingle:"'",
  parenleft:'(', parenright:')', asterisk:'*', plus:'+', comma:',', hyphen:'-', minus:'-', period:'.', slash:'/',
  zero:'0', one:'1', two:'2', three:'3', four:'4', five:'5', six:'6', seven:'7', eight:'8', nine:'9',
  colon:':', semicolon:';', less:'<', equal:'=', greater:'>', question:'?', at:'@', bracketleft:'[', backslash:'\\',
  bracketright:']', asciicircum:'^', underscore:'_', grave:'`', braceleft:'{', bar:'|', braceright:'}', asciitilde:'~',
  Euro:'€', yen:'¥', sterling:'£', cent:'¢', degree:'°', plusminus:'±', multiply:'×', divide:'÷', bullet:'•',
  endash:'–', emdash:'—', quoteleft:'‘', quoteright:'’', quotedblleft:'“', quotedblright:'”', ellipsis:'…',
  onehalf:'½', onequarter:'¼', threequarters:'¾', onesuperior:'¹', twosuperior:'²', threesuperior:'³',
  copyright:'©', registered:'®', trademark:'™', section:'§', paragraph:'¶', middot:'·', mu:'µ',
  Alpha:'Α', Beta:'Β', Gamma:'Γ', Delta:'Δ', Omega:'Ω', alpha:'α', beta:'β', gamma:'γ', delta:'δ', omega:'ω'
};
function glyphNameToUnicode(name = '') {
  const clean = String(name || '').replace(/^\//, '').split('.')[0];
  if (!clean || clean === '.notdef') return '';
  if (Object.prototype.hasOwnProperty.call(GLYPH_NAMES, clean)) return GLYPH_NAMES[clean];
  if (/^[A-Za-z]$/.test(clean)) return clean;
  let match = /^uni((?:[0-9A-Fa-f]{4})+)$/.exec(clean);
  if (match) {
    let value = '';
    for (let index = 0; index < match[1].length; index += 4) value += String.fromCodePoint(parseInt(match[1].slice(index, index + 4), 16));
    return value;
  }
  match = /^u([0-9A-Fa-f]{4,6})$/.exec(clean);
  if (match) {
    const code = parseInt(match[1], 16);
    if (code <= 0x10FFFF) return String.fromCodePoint(code);
  }
  return '';
}
function winAnsiChar(code) {
  const special = {
    128:'€',130:'‚',131:'ƒ',132:'„',133:'…',134:'†',135:'‡',136:'ˆ',137:'‰',138:'Š',139:'‹',140:'Œ',
    142:'Ž',145:'‘',146:'’',147:'“',148:'”',149:'•',150:'–',151:'—',152:'˜',153:'™',154:'š',155:'›',156:'œ',158:'ž',159:'Ÿ'
  };
  return special[code] || String.fromCharCode(code);
}
function baseEncodingMap(name = '') {
  const map = {};
  for (let code = 0; code < 256; code += 1) {
    if (code >= 32 && code <= 126) map[code] = String.fromCharCode(code);
    else if (/WinAnsi/i.test(name) && code >= 128) map[code] = winAnsiChar(code);
    else if (code >= 160) map[code] = String.fromCharCode(code);
  }
  return map;
}
function parseDifferences(value = '') {
  const map = {};
  const tokens = String(value || '').match(/\/[^\s/<>{}\[\]()]+|[-+]?\d+/g) || [];
  let code = -1;
  tokens.forEach(token => {
    if (/^[-+]?\d+$/.test(token)) { code = Number(token); return; }
    if (code < 0 || code > 255) return;
    const decoded = glyphNameToUnicode(token.slice(1));
    if (decoded) map[code] = decoded;
    code += 1;
  });
  return map;
}
function fontEncodingInfo(objects, font) {
  if (!font) return { name:'', map:{}, ref:0 };
  const value = readPdfValue(font.dict, 'Encoding');
  let body = '';
  let name = '';
  let encodingRef = 0;
  if (value && value.type === 'name') name = value.value;
  else if (value && value.type === 'dict') body = value.value;
  else if (value && value.type === 'ref' && objects[value.value]) {
    encodingRef = value.value;
    body = objects[value.value].dict || objects[value.value].body || '';
  }
  if (body) {
    const base = readPdfValue(body, 'BaseEncoding');
    const cmapName = readPdfValue(body, 'CMapName');
    if (base && base.type === 'name') name = base.value;
    else if (cmapName && cmapName.type === 'name') name = cmapName.value;
    else {
      const identity = /\/(Identity-[HV])\b/i.exec(body);
      if (identity) name = identity[1];
    }
  }
  const map = baseEncodingMap(name);
  const diff = body ? readPdfValue(body, 'Differences') : null;
  if (diff && diff.type === 'array') Object.assign(map, parseDifferences(diff.value));
  return { name, map, ref: encodingRef };
}

function knownPdfPrivateUseChar(code) {
  // 本项目的 PDFTron/Apryse 导出题库使用 U+F6B1..U+F6BA 作为 0..9 的字形编码。
  // 没有 ToUnicode 时这些 CID 原先会落成 �，造成 RS-232、4-20mA、CPC-2000、
  // 0-180 等工程数值大面积损坏。该区间在样本中按十个数字严格连续映射。
  if (code >= 0xF6B1 && code <= 0xF6BA) return String(code - 0xF6B1);
  return '';
}

function plausibleIdentityUnicodeChar(code) {
  // 没有 ToUnicode 时，Type0/CID 的编码值通常只是字形编号，不能把所有 16 位值直接当 Unicode。
  // 只接受 ASCII、常用标点和明确的中日韩字符，拒绝 ö/±/²/³ 等容易由字形编号伪装出的 Latin-1 字符。
  return (code >= 0x20 && code <= 0x7E)
    || (code >= 0x3000 && code <= 0x303F)
    || (code >= 0x3400 && code <= 0x9FFF)
    || (code >= 0xF900 && code <= 0xFAFF)
    || (code >= 0xFF01 && code <= 0xFFEF);
}

function plausibleUtf16Char(code) {
  return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xD7FF) || (code >= 0xF900 && code <= 0xFFFD);
}


function readU16(bytes, offset) {
  return offset >= 0 && offset + 1 < bytes.length ? ((bytes[offset] << 8) | bytes[offset + 1]) : 0;
}
function readS16(bytes, offset) {
  const value = readU16(bytes, offset);
  return value & 0x8000 ? value - 0x10000 : value;
}
function readU32(bytes, offset) {
  return offset >= 0 && offset + 3 < bytes.length
    ? (((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0
    : 0;
}
function sfntBaseOffset(bytes) {
  if (bytes.length >= 16 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'ttcf') {
    return readU32(bytes, 12);
  }
  return 0;
}
function parseTrueTypeGidMap(bytes) {
  const gidToUnicode = {};
  if (!bytes || bytes.length < 20) return gidToUnicode;
  const base = sfntBaseOffset(bytes);
  const numTables = readU16(bytes, base + 4);
  let cmapOffset = 0;
  let cmapLength = 0;
  for (let index = 0; index < numTables; index += 1) {
    const record = base + 12 + index * 16;
    if (record + 15 >= bytes.length) break;
    const tag = String.fromCharCode(bytes[record], bytes[record + 1], bytes[record + 2], bytes[record + 3]);
    if (tag === 'cmap') {
      cmapOffset = base + readU32(bytes, record + 8);
      cmapLength = readU32(bytes, record + 12);
      break;
    }
  }
  if (!cmapOffset || cmapOffset + 4 > bytes.length) return gidToUnicode;
  const recordCount = readU16(bytes, cmapOffset + 2);
  const candidates = [];
  for (let index = 0; index < recordCount; index += 1) {
    const record = cmapOffset + 4 + index * 8;
    if (record + 7 >= bytes.length) break;
    const platform = readU16(bytes, record);
    const encoding = readU16(bytes, record + 2);
    const offset = cmapOffset + readU32(bytes, record + 4);
    const priority = platform === 3 && encoding === 10 ? 0
      : (platform === 0 ? 1 : (platform === 3 && encoding === 1 ? 2 : (platform === 3 && encoding === 0 ? 3 : 9)));
    candidates.push({ offset, priority });
  }
  candidates.sort((a, b) => a.priority - b.priority);
  const setMapping = (gid, code) => {
    if (!(gid > 0) || !(code >= 0 && code <= 0x10FFFF)) return;
    const value = String.fromCodePoint(code);
    if (!gidToUnicode[gid] || code < gidToUnicode[gid].codePointAt(0)) gidToUnicode[gid] = value;
  };
  for (const candidate of candidates) {
    const offset = candidate.offset;
    if (!(offset >= cmapOffset && offset + 2 <= bytes.length && offset < cmapOffset + cmapLength)) continue;
    const format = readU16(bytes, offset);
    if (format === 4) {
      const length = readU16(bytes, offset + 2);
      const limit = Math.min(bytes.length, offset + length);
      const segCount = readU16(bytes, offset + 6) / 2;
      const endCodes = offset + 14;
      const startCodes = endCodes + segCount * 2 + 2;
      const deltas = startCodes + segCount * 2;
      const rangeOffsets = deltas + segCount * 2;
      let emitted = 0;
      for (let segment = 0; segment < segCount; segment += 1) {
        const startCode = readU16(bytes, startCodes + segment * 2);
        const endCode = readU16(bytes, endCodes + segment * 2);
        const delta = readS16(bytes, deltas + segment * 2);
        const rangeOffset = readU16(bytes, rangeOffsets + segment * 2);
        const cappedEnd = Math.min(endCode, startCode + 65535);
        for (let code = startCode; code <= cappedEnd && emitted < 120000; code += 1) {
          if (code === 0xFFFF) continue;
          let gid = 0;
          if (!rangeOffset) gid = (code + delta) & 0xFFFF;
          else {
            const glyphOffset = rangeOffsets + segment * 2 + rangeOffset + (code - startCode) * 2;
            if (glyphOffset + 1 >= limit) continue;
            gid = readU16(bytes, glyphOffset);
            if (gid) gid = (gid + delta) & 0xFFFF;
          }
          setMapping(gid, code);
          emitted += 1;
        }
      }
    } else if (format === 12 && offset + 16 <= bytes.length) {
      const groups = readU32(bytes, offset + 12);
      let emitted = 0;
      for (let group = 0; group < groups && emitted < 160000; group += 1) {
        const item = offset + 16 + group * 12;
        if (item + 11 >= bytes.length) break;
        const startCode = readU32(bytes, item);
        const endCode = readU32(bytes, item + 4);
        const startGid = readU32(bytes, item + 8);
        const cappedEnd = Math.min(endCode, startCode + 100000, 0x10FFFF);
        for (let code = startCode; code <= cappedEnd && emitted < 160000; code += 1) {
          setMapping(startGid + code - startCode, code);
          emitted += 1;
        }
      }
    } else if (format === 6 && offset + 10 <= bytes.length) {
      const firstCode = readU16(bytes, offset + 6);
      const count = readU16(bytes, offset + 8);
      for (let index = 0; index < count && offset + 11 + index * 2 < bytes.length; index += 1) {
        setMapping(readU16(bytes, offset + 10 + index * 2), firstCode + index);
      }
    }
    if (Object.keys(gidToUnicode).length) break;
  }
  return gidToUnicode;
}
function parseCidCMap(text = '') {
  const map = {};
  const lengths = [];
  for (const block of String(text || '').matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    for (const match of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) lengths.push(match[1].length / 2);
  }
  for (const block of String(text || '').matchAll(/begincidchar([\s\S]*?)endcidchar/g)) {
    for (const match of block[1].matchAll(/<([0-9A-Fa-f]+)>\s+(\d+)/g)) map[match[1].toUpperCase()] = Number(match[2]);
  }
  for (const block of String(text || '').matchAll(/begincidrange([\s\S]*?)endcidrange/g)) {
    for (const match of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s+(\d+)/g)) {
      const first = parseInt(match[1], 16);
      const last = parseInt(match[2], 16);
      const cidStart = Number(match[3]);
      for (let code = first; code <= last && code - first < 65536; code += 1) {
        map[code.toString(16).toUpperCase().padStart(match[1].length, '0')] = cidStart + code - first;
      }
    }
  }
  return { map, lengths: Array.from(new Set(lengths)).filter(Boolean).sort((a, b) => b - a) };
}
function cidToGid(cid, bytes) {
  if (!bytes || !bytes.length) return cid;
  const offset = Number(cid) * 2;
  return offset + 1 < bytes.length ? readU16(bytes, offset) : cid;
}
function parseCidWidths(value = '') {
  const tokens = String(value || '').match(/\[|\]|[-+]?(?:\d+\.?\d*|\.\d+)/g) || [];
  const map = {};
  let index = 0;
  while (index < tokens.length) {
    const start = Number(tokens[index++]);
    if (!Number.isFinite(start) || index >= tokens.length) break;
    if (tokens[index] === '[') {
      index += 1;
      let code = start;
      while (index < tokens.length && tokens[index] !== ']') {
        const width = Number(tokens[index++]);
        if (Number.isFinite(width)) map[code] = width;
        code += 1;
      }
      if (tokens[index] === ']') index += 1;
    } else {
      const end = Number(tokens[index++]);
      const width = Number(tokens[index++]);
      if (!Number.isFinite(end) || !Number.isFinite(width)) continue;
      const limit = Math.min(end, start + 65535);
      for (let code = start; code <= limit; code += 1) map[code] = width;
    }
  }
  return map;
}
async function fontMaps(objects, page) {
  const fontRefs = inheritedResourceRefs(objects, page, 'Font');
  const result = {};
  for (const name of Object.keys(fontRefs)) {
    const font = objects[fontRefs[name]];
    const unicodeValue = font ? readPdfValue(font.dict, 'ToUnicode') : null;
    let cmap = { map: {}, lengths: [1] };
    if (unicodeValue && unicodeValue.type === 'ref' && objects[unicodeValue.value]) cmap = parseCMap(latin1(await decodedStream(objects[unicodeValue.value])));
    const firstValue = font ? readPdfValue(font.dict, 'FirstChar') : null;
    const widthsValue = font ? readPdfValue(font.dict, 'Widths') : null;
    const widths = widthsValue && widthsValue.type === 'array'
      ? widthsValue.value.trim().split(/\s+/).map(value => Number(value)).filter(value => Number.isFinite(value))
      : [];
    const descendantsValue = font ? readPdfValue(font.dict, 'DescendantFonts') : null;
    const descendantIds = descendantsValue && descendantsValue.type === 'array' ? refs(descendantsValue.value) : [];
    const descendant = descendantIds.length ? objects[descendantIds[0]] : null;
    const cidWidthValue = descendant ? readPdfValue(descendant.dict, 'W') : null;
    const defaultWidthValue = descendant ? readPdfValue(descendant.dict, 'DW') : null;
    const subtypeValue = font ? readPdfValue(font.dict, 'Subtype') : null;
    const encoding = fontEncodingInfo(objects, font);
    const type0 = Boolean(subtypeValue && subtypeValue.type === 'name' && subtypeValue.value === 'Type0');
    const identity = /Identity-[HV]/i.test(encoding.name || '') || /\/Encoding\s*\/Identity-[HV]/i.test(font ? font.dict : '');
    let cidCodeMap = { map: {}, lengths: [] };
    if (type0 && encoding.ref && objects[encoding.ref] && objects[encoding.ref].stream) {
      cidCodeMap = parseCidCMap(latin1(await decodedStream(objects[encoding.ref])));
    }
    let embeddedGidMap = {};
    let cidToGidBytes = null;
    if (type0 && descendant) {
      const descriptorValue = readPdfValue(descendant.dict, 'FontDescriptor');
      const descriptor = descriptorValue && descriptorValue.type === 'ref' ? objects[descriptorValue.value] : null;
      const fontFileValue = descriptor ? readPdfValue(descriptor.dict, 'FontFile2') : null;
      if (fontFileValue && fontFileValue.type === 'ref' && objects[fontFileValue.value]) {
        embeddedGidMap = parseTrueTypeGidMap(await decodedStream(objects[fontFileValue.value]));
      }
      const cidToGidValue = readPdfValue(descendant.dict, 'CIDToGIDMap');
      if (cidToGidValue && cidToGidValue.type === 'ref' && objects[cidToGidValue.value]) {
        cidToGidBytes = await decodedStream(objects[cidToGidValue.value]);
      }
    }
    const decodedLengths = Array.from(new Set([
      ...(Object.keys(cmap.map).length ? cmap.lengths : []),
      ...(cidCodeMap.lengths || []),
      ...(type0 || identity ? [2] : [1])
    ])).filter(Boolean).sort((a, b) => b - a);
    result[name] = {
      map: cmap.map,
      lengths: decodedLengths,
      hasToUnicode: Boolean(Object.keys(cmap.map).length),
      simpleMap: encoding.map,
      encodingName: encoding.name,
      cidCodeMap: cidCodeMap.map,
      embeddedGidMap,
      hasEmbeddedGidMap: Boolean(Object.keys(embeddedGidMap).length),
      cidToGidBytes,
      type0,
      identity,
      firstChar: firstValue ? Number(firstValue.value) || 0 : 0,
      widths,
      cidWidths: cidWidthValue && cidWidthValue.type === 'array' ? parseCidWidths(cidWidthValue.value) : {},
      defaultWidth: defaultWidthValue ? Number(defaultWidthValue.value) || 1000 : 1000
    };
  }
  return result;
}

function literalBytes(value = '') {
  // Tokenizer stores a PDF literal string as a Latin-1 JS string. Preserve the
  // original byte values; TextEncoder would re-encode bytes >= 0x80 as UTF-8.
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) out[i] = value.charCodeAt(i) & 255;
  return out;
}
function decodeGlyphs(token, fontInfo, stats = null) {
  const bytes = token.kind === 'hex' ? hexBytes(token.value) : literalBytes(token.value);
  const cmap = fontInfo || { map: {}, lengths: [1], simpleMap: {} };
  const glyphs = [];
  let index = 0;
  while (index < bytes.length) {
    let found = false;
    for (const length of cmap.lengths || [1]) {
      if (index + length > bytes.length) continue;
      let key = '';
      let code = 0;
      for (let i = 0; i < length; i += 1) {
        key += bytes[index + i].toString(16).toUpperCase().padStart(2, '0');
        code = (code << 8) | bytes[index + i];
      }
      if (Object.prototype.hasOwnProperty.call(cmap.map || {}, key)) {
        glyphs.push({ text: cmap.map[key], code, repaired: false, unresolved: false });
        index += length;
        found = true;
        break;
      }
      if (cmap.hasEmbeddedGidMap) {
        const cid = Object.prototype.hasOwnProperty.call(cmap.cidCodeMap || {}, key) ? cmap.cidCodeMap[key] : code;
        const gid = cidToGid(cid, cmap.cidToGidBytes);
        const embeddedText = cmap.embeddedGidMap[gid];
        if (embeddedText && !/[-]/.test(embeddedText)) {
          glyphs.push({ text: embeddedText, code: cid, repaired: true, unresolved: false });
          if (stats) { stats.repaired += 1; stats.embedded = (stats.embedded || 0) + 1; }
          index += length;
          found = true;
          break;
        }
      }
      if (length === 1 && Object.prototype.hasOwnProperty.call(cmap.simpleMap || {}, code)) {
        glyphs.push({ text: cmap.simpleMap[code], code, repaired: true, unresolved: false });
        if (stats) stats.repaired += 1;
        index += 1;
        found = true;
        break;
      }
      if (length === 2 && (cmap.identity || cmap.type0)) {
        const privateUse = knownPdfPrivateUseChar(code);
        if (privateUse) {
          glyphs.push({ text: privateUse, code, repaired: true, unresolved: false });
          if (stats) { stats.repaired += 1; stats.heuristic = (stats.heuristic || 0) + 1; }
          index += 2;
          found = true;
          break;
        }
        if (plausibleIdentityUnicodeChar(code)) {
          glyphs.push({ text: String.fromCharCode(code), code, repaired: true, unresolved: false });
          if (stats) stats.repaired += 1;
          index += 2;
          found = true;
          break;
        }
      }
    }
    if (!found) {
      const code = bytes[index];
      const fallback = cmap.type0 ? '�' : winAnsiChar(code);
      const unresolved = cmap.type0 || code < 9 || (code > 13 && code < 32);
      glyphs.push({ text: unresolved ? '�' : fallback, code, repaired: !unresolved, unresolved });
      if (stats) {
        if (unresolved) stats.unresolved += 1;
        else stats.repaired += 1;
      }
      index += 1;
    }
  }
  return glyphs;
}

function glyphWidth(fontInfo, code) {
  if (!fontInfo) return 1000;
  if (fontInfo.cidWidths && Object.prototype.hasOwnProperty.call(fontInfo.cidWidths, Number(code))) {
    const cidWidth = Number(fontInfo.cidWidths[Number(code)]);
    return Number.isFinite(cidWidth) ? cidWidth : Number(fontInfo.defaultWidth || 1000);
  }
  const index = Number(code) - Number(fontInfo.firstChar || 0);
  const width = index >= 0 && index < fontInfo.widths.length ? Number(fontInfo.widths[index]) : Number(fontInfo.defaultWidth || 1000);
  return Number.isFinite(width) ? width : 1000;
}
function tokenize(content = '') {
  const tokens = []; let i = 0;
  const ws = c => /[\s\0]/.test(c);
  function skip() { while (i < content.length) { if (ws(content[i])) i += 1; else if (content[i] === '%') { while (i < content.length && !/[\r\n]/.test(content[i])) i += 1; } else break; } }
  function readLiteral() {
    i += 1;
    let depth = 1, out = '';
    while (i < content.length && depth) {
      const c = content[i++];
      if (c === '\\') {
        if (i >= content.length) break;
        let n = content[i++];
        // A backslash followed by EOL is a continuation and contributes no byte.
        if (n === '\r' || n === '\n') {
          if (n === '\r' && content[i] === '\n') i += 1;
          continue;
        }
        // PDF literal strings use one to three octal digits for arbitrary bytes.
        if (/[0-7]/.test(n)) {
          let octal = n;
          for (let count = 0; count < 2 && i < content.length && /[0-7]/.test(content[i]); count += 1) octal += content[i++];
          out += String.fromCharCode(parseInt(octal, 8) & 255);
          continue;
        }
        const map = { n:'\n', r:'\r', t:'\t', b:'\b', f:'\f', '(':'(', ')':')', '\\':'\\' };
        out += Object.prototype.hasOwnProperty.call(map, n) ? map[n] : n;
      } else if (c === '(') {
        depth += 1; out += c;
      } else if (c === ')') {
        depth -= 1; if (depth) out += c;
      } else out += c;
    }
    return {kind:'literal',value:out};
  }
  function readArray() { i += 1; const arr=[]; while(i<content.length){skip(); if(content[i]===']'){i+=1;break;} arr.push(readOne());} return {kind:'array',value:arr}; }
  function readDict(){ i+=2; const d={}; while(i<content.length){skip(); if(content.slice(i,i+2)==='>>'){i+=2;break;} const key=readOne(); skip(); const val=readOne(); if(key&&key.kind==='name')d[key.value]=val;} return {kind:'dict',value:d}; }
  function readOne(){ skip(); const c=content[i]; if(c==='(')return readLiteral(); if(c==='[')return readArray(); if(content.slice(i,i+2)==='<<')return readDict(); if(c==='<'){const end=content.indexOf('>',i+1);const v=content.slice(i+1,end);i=end+1;return{kind:'hex',value:v};} if(c==='/'){i+=1;const st=i;while(i<content.length&&!/[\s\[\]<>()\/]/.test(content[i]))i+=1;return{kind:'name',value:content.slice(st,i)};} const st=i;while(i<content.length&&!/[\s\[\]<>()\/]/.test(content[i]))i+=1;const v=content.slice(st,i);if(/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(v))return{kind:'number',value:Number(v)};return{kind:'word',value:v}; }
  while(i<content.length){skip();if(i>=content.length)break;tokens.push(readOne());}
  return tokens;
}
function matrixMultiply(a,b){return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];}
function decodePdfStringToken(token) {
  if (!token) return '';
  const bytes = token.kind === 'hex' ? hexBytes(token.value) : literalBytes(token.value);
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return utf16be(Array.from(bytes).map(value => value.toString(16).padStart(2, '0')).join(''));
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
    let value = '';
    for (let index = 2; index + 1 < bytes.length; index += 2) value += String.fromCharCode(bytes[index] | (bytes[index + 1] << 8));
    return value;
  }
  try {
    const utf8 = typeof TextDecoder === 'function' ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : '';
    if (utf8 && !hasEncodingAnomaly(utf8)) return utf8;
  } catch (_) {}
  return repairMojibake(latin1(bytes));
}

function usedKnownEngineeringRepair(value=''){const baseline=repairMojibake(String(value));return repairKnownEngineeringNotation(baseline)!==baseline;}
function cleanPdfText(value=''){return repairKnownEngineeringNotation(repairMojibake(String(value))).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g,'$1$2').replace(/[ \t]+/g,' ').trim();}
function splitInlinePdfOptions(text = '') {
  const value = cleanPdfText(text);
  const markers = [];
  const re = /([A-L])\s*[.．、:：)）]\s*/g;
  let match;
  while ((match = re.exec(value))) markers.push({ index: match.index, end: re.lastIndex, key: match[1] });
  if (markers.length < 2 || markers[0].index > 2) return [value];
  const parts = [];
  for (let index = 0; index < markers.length; index += 1) {
    const current = markers[index];
    const next = markers[index + 1];
    const content = value.slice(current.end, next ? next.index : value.length).trim();
    if (content) parts.push(`${current.key}.${content}`);
  }
  return parts.length >= 2 ? parts : [value];
}
function parseContent(content, cmaps, xobjects) {
  const tokens = tokenize(content), stack = [], fragments = [], images = [];
  const encodingStats = { repaired: 0, unresolved: 0, heuristic: 0 };
  let font = '', fontSize = 12, x = 0, y = 0, lineX = 0, lineY = 0, leading = 16;
  let charSpace = 0, wordSpace = 0, hScale = 1;
  let actual = '', actualUsed = false, ctm = [1,0,0,1,0,0];
  const graphics = [];
  const advanceGlyph = glyph => {
    const info = cmaps[font];
    const space = glyph.text === ' ' ? wordSpace : 0;
    const advance = ((glyphWidth(info, glyph.code) / 1000) * fontSize + charSpace + space) * hScale;
    x += advance;
  };
  const showText = token => {
    const glyphs = decodeGlyphs(token, cmaps[font], encodingStats);
    if (actual && !actualUsed) {
      const value = cleanPdfText(actual);
      if (usedKnownEngineeringRepair(actual)) encodingStats.heuristic += 1;
      if (value) fragments.push({ text: value, x, y, encodingWarning: hasEncodingAnomaly(value) });
      actualUsed = true;
      glyphs.forEach(advanceGlyph);
      return;
    }
    if (actual) { glyphs.forEach(advanceGlyph); return; }
    const rawValue = glyphs.map(glyph => glyph.text).join('');
    const value = cleanPdfText(rawValue);
    if (usedKnownEngineeringRepair(rawValue)) encodingStats.heuristic += 1;
    if (value) fragments.push({ text: value, x, y, encodingWarning: glyphs.some(glyph => glyph.unresolved) && hasEncodingAnomaly(value) });
    glyphs.forEach(advanceGlyph);
  };
  const moveLine = (dx, dy) => { lineX += dx; lineY += dy; x = lineX; y = lineY; };
  const handle = (op, args) => {
    if (op === 'BT') { x=0; y=0; lineX=0; lineY=0; leading=16; actual=''; actualUsed=false; return; }
    if (op === 'ET') { actual=''; actualUsed=false; return; }
    if (op === 'Tf') { font=args[0]&&args[0].value||font; fontSize=Number(args[1]&&args[1].value)||fontSize; return; }
    if (op === 'Tc') { charSpace=Number(args[0]&&args[0].value)||0; return; }
    if (op === 'Tw') { wordSpace=Number(args[0]&&args[0].value)||0; return; }
    if (op === 'Tz') { hScale=(Number(args[0]&&args[0].value)||100)/100; return; }
    if (op === 'Td' || op === 'TD') { const dx=Number(args[0]&&args[0].value)||0,dy=Number(args[1]&&args[1].value)||0; moveLine(dx,dy); if(op==='TD')leading=-dy; return; }
    if (op === 'Tm') { x=Number(args[4]&&args[4].value)||0; y=Number(args[5]&&args[5].value)||0; lineX=x; lineY=y; return; }
    if (op === 'TL') { leading=Number(args[0]&&args[0].value)||leading; return; }
    if (op === 'T*') { moveLine(0,-leading); return; }
    if (op === 'Tj' && args[0]) { showText(args[0]); return; }
    if (op === 'TJ' && args[0] && args[0].kind === 'array') {
      args[0].value.forEach(item => {
        if (item.kind === 'hex' || item.kind === 'literal') showText(item);
        else if (item.kind === 'number') x += (-Number(item.value || 0) / 1000) * fontSize * hScale;
      });
      return;
    }
    if (op === "'") { moveLine(0,-leading); if(args[0])showText(args[0]); return; }
    if (op === '"') { wordSpace=Number(args[0]&&args[0].value)||0; charSpace=Number(args[1]&&args[1].value)||0; moveLine(0,-leading); if(args[2])showText(args[2]); return; }
    if (op === 'BDC') { const dict=args.find(a=>a&&a.kind==='dict'); const value=dict&&dict.value.ActualText; if(value&&(value.kind==='hex'||value.kind==='literal')){actual=decodePdfStringToken(value);actualUsed=false;} return; }
    if (op === 'EMC') { actual=''; actualUsed=false; return; }
    if (op === 'q') { graphics.push(ctm.slice()); return; }
    if (op === 'Q') { ctm=graphics.pop()||[1,0,0,1,0,0]; return; }
    if (op === 'cm') { ctm=matrixMultiply(ctm,args.slice(-6).map(v=>Number(v&&v.value)||0)); return; }
    if (op === 'Do') { const name=args[args.length-1]&&args[args.length-1].value; if(name&&xobjects[name])images.push({name,ref:xobjects[name],x:ctm[4],y:ctm[5],w:Math.hypot(ctm[0],ctm[1]),h:Math.hypot(ctm[2],ctm[3])}); return; }
  };
  // In a PDF content stream every bare word is an operator. Unknown drawing,
  // color and graphics-state operators must still consume their operands;
  // otherwise names such as /G1134 from "gs" leak into the next Tf call and
  // are mistaken for a font name, producing unreadable encoded text.
  for (const token of tokens) {
    if (token.kind === 'word') {
      const args = stack.splice(0);
      handle(token.value, args);
    } else stack.push(token);
  }
  return {fragments,images,encodingStats};
}

function basicPdfEntryOrder(entries = []) {
  return (entries || []).slice().sort((a, b) => Math.abs((b.y || 0) - (a.y || 0)) > 2 ? (b.y || 0) - (a.y || 0) : (a.x || 0) - (b.x || 0));
}

function orderPdfPageEntries(entries = []) {
  const source = (entries || []).filter(Boolean);
  const textEntries = source.filter(item => item.text);
  if (textEntries.length < 8) return { entries: basicPdfEntryOrder(source), multiColumn: false };

  const ys = textEntries.map(item => Number(item.y) || 0);
  const maxY = Math.max(...ys), minY = Math.min(...ys);
  const verticalSpan = Math.max(1, maxY - minY);
  const edgeBand = Math.max(28, verticalSpan * 0.06);
  const top = source.filter(item => (Number(item.y) || 0) >= maxY - edgeBand);
  const bottom = source.filter(item => (Number(item.y) || 0) <= minY + edgeBand);
  const edgeSet = new Set([...top, ...bottom]);
  const middle = source.filter(item => !edgeSet.has(item));
  const candidates = middle.filter(item => item.text);
  if (candidates.length < 6) return { entries: basicPdfEntryOrder(source), multiColumn: false };

  const xs = candidates.map(item => Number(item.x) || 0).sort((a, b) => a - b);
  const xSpan = Math.max(1, xs[xs.length - 1] - xs[0]);
  let best = null;
  for (let index = 2; index <= xs.length - 3; index += 1) {
    const gap = xs[index] - xs[index - 1];
    if (!best || gap > best.gap) best = { gap, index, separator: (xs[index] + xs[index - 1]) / 2 };
  }
  // 单栏题库中题干、A/B/C/D 选项会形成多个缩进起点。仅凭 x 坐标空隙会
  // 被误判成双栏，随后把“整页左缩进内容”排到“整页右缩进内容”前面，导致
  // 大量题号和答案错序。双栏必须同时满足明显的横向分隔与纵向并行证据。
  if (!best || best.gap < Math.max(72, xSpan * 0.24)) return { entries: basicPdfEntryOrder(source), multiColumn: false };

  const leftText = candidates.filter(item => (Number(item.x) || 0) < best.separator);
  const rightText = candidates.filter(item => (Number(item.x) || 0) >= best.separator);
  if (leftText.length < 3 || rightText.length < 3) return { entries: basicPdfEntryOrder(source), multiColumn: false };
  const leftMedian = leftText.map(item => Number(item.x) || 0).sort((a,b)=>a-b)[Math.floor(leftText.length/2)];
  const rightMedian = rightText.map(item => Number(item.x) || 0).sort((a,b)=>a-b)[Math.floor(rightText.length/2)];
  if ((rightMedian - leftMedian) < Math.max(120, xSpan * 0.44)) return { entries: basicPdfEntryOrder(source), multiColumn: false };

  const range = items => {
    const values = items.map(item => Number(item.y) || 0);
    return { min: Math.min(...values), max: Math.max(...values) };
  };
  const lr = range(leftText), rr = range(rightText);
  const overlap = Math.max(0, Math.min(lr.max, rr.max) - Math.max(lr.min, rr.min));
  const minSpan = Math.max(1, Math.min(lr.max - lr.min, rr.max - rr.min));
  if (overlap / minSpan < 0.62) return { entries: basicPdfEntryOrder(source), multiColumn: false };

  // 真双栏在多个高度上会同时存在左栏和右栏文字；普通题目缩进通常不会。
  const tolerance = Math.max(4, verticalSpan * 0.008);
  const matchedRight = new Set();
  let parallelRows = 0;
  leftText.forEach(leftItem => {
    let bestIndex = -1, bestDistance = Infinity;
    rightText.forEach((rightItem, index) => {
      if (matchedRight.has(index)) return;
      const distance = Math.abs((Number(leftItem.y) || 0) - (Number(rightItem.y) || 0));
      if (distance <= tolerance && distance < bestDistance) { bestDistance = distance; bestIndex = index; }
    });
    if (bestIndex >= 0) { matchedRight.add(bestIndex); parallelRows += 1; }
  });
  const parallelNeed = Math.max(2, Math.ceil(Math.min(leftText.length, rightText.length) * 0.22));
  if (parallelRows < parallelNeed) return { entries: basicPdfEntryOrder(source), multiColumn: false };

  const left = middle.filter(item => (Number(item.x) || 0) < best.separator);
  const right = middle.filter(item => (Number(item.x) || 0) >= best.separator);
  return {
    entries: [...basicPdfEntryOrder(top), ...basicPdfEntryOrder(left), ...basicPdfEntryOrder(right), ...basicPdfEntryOrder(bottom)],
    multiColumn: true
  };
}
function pdfMarginSignature(text = '') {
  return cleanPdfText(text || '')
    .replace(/第\s*\d+\s*页(?:\s*\/\s*共?\s*\d+\s*页)?/g, '第#页')
    .replace(/^\s*\d+\s*\/\s*\d+\s*$/, '#/#')
    .replace(/^\s*-?\s*\d{1,4}\s*-?\s*$/, '#PAGE#')
    .replace(/\s+/g, ' ')
    .trim();
}

function removeRepeatedPdfMargins(pageSets = []) {
  const counts = new Map();
  const marginEntries = [];
  pageSets.forEach((page, pageIndex) => {
    const textEntries = (page.entries || []).filter(item => item.text);
    if (!textEntries.length) return;
    const ys = textEntries.map(item => Number(item.y) || 0);
    const maxY = Math.max(...ys), minY = Math.min(...ys);
    const span = Math.max(1, maxY - minY);
    const band = Math.max(32, span * 0.08);
    textEntries.forEach(item => {
      const y = Number(item.y) || 0;
      if (y < maxY - band && y > minY + band) return;
      const signature = pdfMarginSignature(item.text);
      if (!signature) return;
      marginEntries.push({ pageIndex, item, signature });
      if (!counts.has(signature)) counts.set(signature, new Set());
      counts.get(signature).add(pageIndex);
    });
  });
  const pageCount = pageSets.length;
  const threshold = Math.max(3, Math.ceil(pageCount * 0.3));
  // 只清理真正像页眉/页脚的重复短文本。题号、选项、答案等内容即使恰好
  // 出现在页边缘，也不能因为多页重复就删掉；大题库跨页时这类误删会直接
  // 造成边界数量下降。页码仍单独作为显式噪声处理。
  const contentLike = signature => /^(?:\d{1,4}\s*(?:\/|[.、．:：)）]|\[)|[A-L]\s*[.、．:：)）]|(?:答案|参考答案|正确答案|标准答案|解析|答案解析)\s*[:：])/i.test(String(signature || ''));
  const headerFooterLike = signature => /(?:题库|考试|试卷|培训|内部|版权所有|仅供|公司|集团|资料|文档|#PAGE#|第#页|#\/#)/.test(String(signature || ''));
  const repeated = new Set([...counts.entries()]
    .filter(([signature, pages]) => pages.size >= threshold && String(signature || '').length <= 60 && !contentLike(signature) && headerFooterLike(signature))
    .map(([signature]) => signature));
  let removedCount = 0;
  pageSets.forEach(page => {
    page.entries = (page.entries || []).filter(item => {
      if (!item.text) return true;
      const sig = pdfMarginSignature(item.text);
      const obviousPageNumber = sig === '#PAGE#' || sig === '第#页' || sig === '#/#';
      if (obviousPageNumber || repeated.has(sig)) { removedCount += 1; return false; }
      return true;
    });
  });
  return { pageSets, removedCount, repeatedCount: repeated.size };
}

async function extractPdf(path, workDir, onProgress=()=>{}) {
  const bytes=bytesFromBase64(fileUtil.readBase64(path));
  const objects=parseObjects(bytes);
  await expandObjectStreams(objects);
  const pages=resolvePageOrder(objects);
  if(!pages.length)throw new Error('PDF 中没有可读取页面');
  const imageDir=`${workDir}/pdf-images`;fileUtil.ensureDir(imageDir);
  const pageSets=[];let imageSequence=1,unsupportedImages=0,textPages=0,emptyPages=0,fontFallbackRepairCount=0,unresolvedGlyphCount=0,heuristicTextRepairCount=0;
  for(let pageIndex=0;pageIndex<pages.length;pageIndex+=1){
    const completedPages = pageIndex;
    const pageProgress = 15 + Math.round((completedPages / pages.length) * 81);
    onProgress(Math.min(96, pageProgress),`正在解析 PDF 第 ${pageIndex+1}/${pages.length} 页`);
    const page=objects[pages[pageIndex]],cmaps=await fontMaps(objects,page);
    const xobjects=inheritedResourceRefs(objects,page,'XObject');
    const contentsMatch=/\/Contents\s*(\[[\s\S]*?\]|\d+\s+\d+\s+R)/.exec(page.dict);const contentRefs=contentsMatch?refs(contentsMatch[1]):[];
    let content='';for(const id of contentRefs){if(objects[id])content+=latin1(await decodedStream(objects[id]))+'\n';}
    const parsed=parseContent(content,cmaps,xobjects);
    fontFallbackRepairCount += Number(parsed.encodingStats && parsed.encodingStats.repaired) || 0;
    unresolvedGlyphCount += Number(parsed.encodingStats && parsed.encodingStats.unresolved) || 0;
    heuristicTextRepairCount += Number(parsed.encodingStats && parsed.encodingStats.heuristic) || 0;
    if(parsed.fragments.length)textPages+=1;else emptyPages+=1;
    const lineMap=[];
    parsed.fragments.forEach(fragment=>{let line=lineMap.find(item=>Math.abs(item.y-fragment.y)<=2.2);if(!line){line={y:fragment.y,items:[]};lineMap.push(line);}line.items.push(fragment);});
    const entries=lineMap.map(line=>({y:line.y,x:Math.min.apply(null,line.items.map(i=>i.x)),text:cleanPdfText(line.items.sort((a,b)=>a.x-b.x).map(i=>i.text).join('')),images:[],encodingWarning:line.items.some(i=>i.encodingWarning)})).filter(item=>item.text);
    for (const image of parsed.images) {
      const object = objects[image.ref];
      if (!object || !object.stream) continue;
      let ext = '';
      let raw = null;
      try {
        if (/\/DCTDecode\b/.test(object.dict)) {
          ext = 'jpg';
          raw = object.stream;
        } else if (/\/JPXDecode\b/.test(object.dict)) {
          ext = 'jp2';
          raw = object.stream;
        } else if (/\/FlateDecode\b/.test(object.dict)) {
          const widthValue = readPdfValue(object.dict, 'Width');
          const heightValue = readPdfValue(object.dict, 'Height');
          const bitsValue = readPdfValue(object.dict, 'BitsPerComponent');
          const colorValue = readPdfValue(object.dict, 'ColorSpace');
          const width = Number(widthValue && widthValue.value) || 0;
          const height = Number(heightValue && heightValue.value) || 0;
          const bits = Number(bitsValue && bitsValue.value) || 8;
          const colorSpace = colorValue && colorValue.type === 'name' ? colorValue.value : '';
          const decodeParms = readPdfValue(object.dict, 'DecodeParms');
          if (decodeParms && /\/Predictor\s+([2-9]|1[0-5])\b/.test(String(decodeParms.value || ''))) throw new Error('暂不支持带预测器的 PDF 位图');
          raw = await pngFromPixels(await decodedStream(object), width, height, colorSpace, bits);
          ext = 'png';
        } else {
          throw new Error('暂不支持的 PDF 图片编码');
        }
        const target = `${imageDir}/page_${String(pageIndex + 1).padStart(4, '0')}_image_${String(imageSequence++).padStart(4, '0')}.${ext}`;
        fileUtil.writeBase64(target, base64FromBytes(raw));
        entries.push({ y: image.y + image.h / 2, x: image.x, text: '', images: [target] });
      } catch (error) {
        unsupportedImages += 1;
      }
    }
    const initialOrder = basicPdfEntryOrder(entries);
    const pageText = initialOrder.map(entry => entry.text).filter(Boolean).join('\n');
    const isContentsPage = /(?:^|\n)\s*[⽬目]录\s*(?:\n|$)/.test(pageText) && !/(?:^|\n)\s*(?:\d+[.、]|\d+\s*\/\s*\d+).*?(?:题|答案)/.test(pageText);
    pageSets.push({ pageNumber: pageIndex + 1, entries, isContentsPage });
  }
  onProgress(96,`PDF 页面读取完成，共 ${pages.length} 页`);

  // 页面全部读取后再统一处理：这样可以跨页识别重复页眉/页脚，也不会人为切断跨页题目。
  const marginResult = removeRepeatedPdfMargins(pageSets);
  const paragraphs=[];
  let multiColumnPageCount=0;
  marginResult.pageSets.forEach(pageSet => {
    if (pageSet.isContentsPage) return;
    const ordered = orderPdfPageEntries(pageSet.entries || []);
    if (ordered.multiColumn) multiColumnPageCount += 1;
    ordered.entries.forEach(entry => {
      if (!entry.text) {
        paragraphs.push({index:paragraphs.length,text:'',images:entry.images,pageNumber:pageSet.pageNumber,source:'pdf',encodingWarning:false});
        return;
      }
      splitInlinePdfOptions(entry.text).forEach(text => paragraphs.push({index:paragraphs.length,text,images:entry.images,pageNumber:pageSet.pageNumber,source:'pdf',encodingWarning:Boolean(entry.encodingWarning || hasEncodingAnomaly(text))}));
    });
  });
  onProgress(97,'正在整理 PDF 多栏、跨页与页眉页脚');
  return {paragraphs,diagnostics:{pdfPageCount:pages.length,pdfTextPageCount:textPages,pdfEmptyPageCount:emptyPages,pdfExtractedImageCount:imageSequence-1,pdfUnsupportedImageCount:unsupportedImages,pdfExpandedObjectCount:Object.values(objects).filter(object=>object.compressedIn).length,pdfFontFallbackRepairCount:fontFallbackRepairCount,pdfHeuristicTextRepairCount:heuristicTextRepairCount,pdfUnresolvedGlyphCount:unresolvedGlyphCount,pdfEncodingWarningParagraphCount:paragraphs.filter(item=>item.encodingWarning).length,pdfMultiColumnPageCount:multiColumnPageCount,pdfRepeatedMarginLineCount:marginResult.removedCount}};
}
module.exports={extractPdf,__test:{parseCMap,parseDifferences,glyphNameToUnicode,fontEncodingInfo,decodeGlyphs,decodePdfStringToken,parseCidCMap,parseTrueTypeGidMap,plausibleIdentityUnicodeChar,knownPdfPrivateUseChar,basicPdfEntryOrder,orderPdfPageEntries,pdfMarginSignature,removeRepeatedPdfMargins}};
});
__define("services/common-format-extractor.js", function(require, module, exports){
const fileUtil = require('../utils/file');
const { decodeXmlEntities, normalizeText, normalizeOneLine } = require('../utils/text');
const {
  detectHeader,
  inferDifficultyColumn,
  createQuestionFromRow,
  typeInfo
} = require('./xlsx-extractor');

const END_OF_CHAIN = 0xFFFFFFFE;
const FREE_SECTOR = 0xFFFFFFFF;
const FAT_SECTOR = 0xFFFFFFFD;
const DIFAT_SECTOR = 0xFFFFFFFC;

function bytesFromBase64(value = '') {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index) & 255;
  return bytes;
}

function readFileBytes(path) {
  return bytesFromBase64(fileUtil.readBase64(path));
}

function u16(bytes, offset) {
  if (offset < 0 || offset + 2 > bytes.length) return 0;
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function i16(bytes, offset) {
  const value = u16(bytes, offset);
  return value & 0x8000 ? value - 0x10000 : value;
}

function u32(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return 0;
  return ((bytes[offset]) |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)) >>> 0;
}

function i32(bytes, offset) {
  return u32(bytes, offset) | 0;
}

function f64(bytes, offset) {
  if (offset < 0 || offset + 8 > bytes.length) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  return view.getFloat64(0, true);
}

function sliceBytes(bytes, start, end) {
  return bytes.subarray(Math.max(0, start), Math.min(bytes.length, end));
}

function concatBytes(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  parts.forEach(part => {
    output.set(part, offset);
    offset += part.length;
  });
  return output;
}

function decodeBytes(bytes, label, fatal = false) {
  try {
    if (typeof TextDecoder === 'function') return new TextDecoder(label, { fatal }).decode(bytes);
  } catch (_) {}
  if (label === 'utf-16le') {
    let result = '';
    for (let index = 0; index + 1 < bytes.length; index += 2) result += String.fromCharCode(bytes[index] | (bytes[index + 1] << 8));
    return result;
  }
  let result = '';
  for (let index = 0; index < bytes.length; index += 1) result += String.fromCharCode(bytes[index]);
  return result;
}

function textQuality(value = '') {
  const text = String(value || '');
  if (!text) return -100000;
  const replacement = (text.match(/\uFFFD/g) || []).length;
  const controls = (text.match(/[\u0000-\u0008\u000E-\u001F]/g) || []).length;
  const cjk = (text.match(/[\u3400-\u9FFF]/g) || []).length;
  const printable = (text.match(/[\u0020-\u007E\u3000-\u9FFF\uF900-\uFAFF]/g) || []).length;
  const mojibake = (text.match(/(?:Ã.|Â.|â€|ä¸|å[\x80-\xBF]|æ[\x80-\xBF]|ç[\x80-\xBF]|ï¿½)/g) || []).length;
  return printable + cjk * 3 - replacement * 120 - controls * 40 - mojibake * 20;
}

function decodeSingleByte(bytes, preferred = '') {
  if (!preferred) {
    const utf8 = decodeBytes(bytes, 'utf-8', true);
    if (utf8) return utf8;
  }
  const labels = [];
  if (preferred) labels.push(preferred);
  labels.push('gb18030', 'windows-1252', 'utf-8');
  let best = '';
  let score = -Infinity;
  Array.from(new Set(labels)).forEach(label => {
    const text = decodeBytes(bytes, label, label === 'utf-8');
    const value = textQuality(text);
    if (value > score) {
      best = text;
      score = value;
    }
  });
  return best || decodeBytes(bytes, 'windows-1252');
}

function parseCompoundFile(bytes) {
  const signature = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  if (bytes.length < 512 || signature.some((value, index) => bytes[index] !== value)) {
    throw new Error('文件不是有效的 Office 97-2003 复合文档。');
  }
  const sectorSize = 1 << u16(bytes, 30);
  const miniSectorSize = 1 << u16(bytes, 32);
  if (![512, 4096].includes(sectorSize) || miniSectorSize < 16 || miniSectorSize > 256) {
    throw new Error('不支持的复合文档扇区大小。');
  }
  const fatSectorCount = u32(bytes, 44);
  const firstDirectorySector = u32(bytes, 48);
  const miniCutoff = u32(bytes, 56) || 4096;
  const firstMiniFatSector = u32(bytes, 60);
  const miniFatSectorCount = u32(bytes, 64);
  const firstDifatSector = u32(bytes, 68);
  const difatSectorCount = u32(bytes, 72);
  const sector = id => {
    const start = (Number(id) + 1) * sectorSize;
    if (start < 0 || start + sectorSize > bytes.length) return new Uint8Array(0);
    return sliceBytes(bytes, start, start + sectorSize);
  };

  const difat = [];
  for (let index = 0; index < 109; index += 1) {
    const value = u32(bytes, 76 + index * 4);
    if (value !== FREE_SECTOR) difat.push(value);
  }
  let difatCursor = firstDifatSector;
  const entriesPerDifatSector = sectorSize / 4 - 1;
  for (let count = 0; count < difatSectorCount && difatCursor < 0xFFFFFFF0; count += 1) {
    const raw = sector(difatCursor);
    if (!raw.length) break;
    for (let index = 0; index < entriesPerDifatSector; index += 1) {
      const value = u32(raw, index * 4);
      if (value !== FREE_SECTOR) difat.push(value);
    }
    difatCursor = u32(raw, entriesPerDifatSector * 4);
  }

  const fat = [];
  difat.slice(0, fatSectorCount).forEach(id => {
    const raw = sector(id);
    for (let offset = 0; offset + 4 <= raw.length; offset += 4) fat.push(u32(raw, offset));
  });

  function chain(start, table = fat, limit = 100000) {
    const result = [];
    const visited = new Set();
    let cursor = Number(start) >>> 0;
    while (cursor < 0xFFFFFFF0 && cursor < table.length && result.length < limit && !visited.has(cursor)) {
      visited.add(cursor);
      result.push(cursor);
      cursor = table[cursor] >>> 0;
    }
    return result;
  }

  function readRegularStream(start, size = null) {
    const parts = chain(start).map(sector).filter(part => part.length);
    const output = concatBytes(parts);
    return size === null ? output : output.subarray(0, Math.min(output.length, Number(size)));
  }

  const directoryBytes = readRegularStream(firstDirectorySector);
  const entries = [];
  for (let offset = 0; offset + 128 <= directoryBytes.length; offset += 128) {
    const nameLength = u16(directoryBytes, offset + 64);
    const type = directoryBytes[offset + 66];
    let name = '';
    if (nameLength >= 2 && nameLength <= 64) {
      name = decodeBytes(sliceBytes(directoryBytes, offset, offset + nameLength - 2), 'utf-16le').replace(/\0/g, '');
    }
    const startSector = u32(directoryBytes, offset + 116);
    const low = u32(directoryBytes, offset + 120);
    const high = u32(directoryBytes, offset + 124);
    const size = high * 0x100000000 + low;
    entries.push({ name, type, startSector, size, index: entries.length });
  }
  const root = entries.find(entry => entry.type === 5);
  if (!root) throw new Error('复合文档缺少 Root Entry。');
  const rootStream = readRegularStream(root.startSector, root.size);
  let miniFat = [];
  if (miniFatSectorCount && firstMiniFatSector < 0xFFFFFFF0) {
    const raw = readRegularStream(firstMiniFatSector, miniFatSectorCount * sectorSize);
    for (let offset = 0; offset + 4 <= raw.length; offset += 4) miniFat.push(u32(raw, offset));
  }

  function readStream(entry) {
    if (!entry || entry.type !== 2) return new Uint8Array(0);
    if (entry.size < miniCutoff && miniFat.length) {
      const parts = chain(entry.startSector, miniFat).map(id => {
        const start = id * miniSectorSize;
        return sliceBytes(rootStream, start, start + miniSectorSize);
      });
      return concatBytes(parts).subarray(0, Math.min(Number(entry.size), parts.reduce((sum, part) => sum + part.length, 0)));
    }
    return readRegularStream(entry.startSector, entry.size);
  }

  const streams = {};
  entries.filter(entry => entry.type === 2 && entry.name).forEach(entry => {
    streams[entry.name] = readStream(entry);
  });
  return { streams, entries, sectorSize, miniSectorSize };
}

function fallbackDocText(wordDocument) {
  const fcMin = u32(wordDocument, 24);
  const fcMac = u32(wordDocument, 28);
  const candidates = [];
  if (fcMin > 0 && fcMac > fcMin && fcMac <= wordDocument.length) {
    const raw = sliceBytes(wordDocument, fcMin, fcMac);
    candidates.push(decodeBytes(raw, 'utf-16le'));
    candidates.push(decodeSingleByte(raw));
  }
  candidates.push(decodeBytes(wordDocument, 'utf-16le'));
  candidates.push(decodeSingleByte(wordDocument));
  return candidates.sort((a, b) => textQuality(b) - textQuality(a))[0] || '';
}

function normalizeLegacyWordText(value = '') {
  return String(value || '')
    .replace(/\u0001/g, '【图片】')
    .replace(/\u0002/g, '')
    .replace(/\u0007/g, '\t')
    .replace(/\u000B/g, '\n')
    .replace(/\u000C/g, '\n')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0006\u0008\u000E-\u001F]/g, '')
    .replace(/\n{4,}/g, '\n\n\n');
}

function paragraphsFromText(text, sourceKind = 'text') {
  const normalized = normalizeLegacyWordText(text);
  const result = [];
  normalized.split(/\n/).forEach((line, index) => {
    const value = normalizeText(String(line || '').replace(/\t+/g, ' '));
    if (!value) return;
    result.push({ index, text: value, alternatives: [], style: '', numId: '', level: 0, listOrdinal: 0, images: [], sourceKind });
  });
  return result;
}

function extractLegacyDoc(path) {
  const bytes = readFileBytes(path);
  const compound = parseCompoundFile(bytes);
  const word = compound.streams.WordDocument;
  if (!word || word.length < 64) throw new Error('DOC 文件缺少 WordDocument 主数据流。');
  const flags = u16(word, 10);
  const tableName = (flags & 0x0200) ? '1Table' : '0Table';
  const table = compound.streams[tableName] || compound.streams['1Table'] || compound.streams['0Table'];
  let text = '';
  let pieceCount = 0;
  if (table && table.length) {
    try {
      let position = 32;
      const csw = u16(word, position);
      position += 2 + csw * 2;
      const cslw = u16(word, position);
      position += 2 + cslw * 4;
      const pairCount = u16(word, position);
      position += 2;
      if (pairCount > 33 && position + 34 * 8 <= word.length) {
        const fcClx = u32(word, position + 33 * 8);
        const lcbClx = u32(word, position + 33 * 8 + 4);
        if (lcbClx && fcClx + lcbClx <= table.length) {
          const clx = sliceBytes(table, fcClx, fcClx + lcbClx);
          let cursor = 0;
          while (cursor < clx.length && clx[cursor] === 0x01) {
            const size = u16(clx, cursor + 1);
            cursor += 3 + size;
          }
          if (cursor + 5 <= clx.length && clx[cursor] === 0x02) {
            const plcSize = u32(clx, cursor + 1);
            const plc = sliceBytes(clx, cursor + 5, cursor + 5 + plcSize);
            const count = Math.max(0, Math.floor((plc.length - 4) / 12));
            const cpBase = 4 * (count + 1);
            const pieces = [];
            for (let index = 0; index < count; index += 1) {
              const cpStart = u32(plc, index * 4);
              const cpEnd = u32(plc, (index + 1) * 4);
              const pcdOffset = cpBase + index * 8;
              const rawFc = u32(plc, pcdOffset + 2);
              const compressed = Boolean(rawFc & 0x40000000);
              const fileOffset = compressed ? ((rawFc & 0x3FFFFFFF) >>> 1) : (rawFc & 0x3FFFFFFF);
              const chars = Math.max(0, cpEnd - cpStart);
              if (!chars || fileOffset >= word.length) continue;
              const byteLength = compressed ? chars : chars * 2;
              const raw = sliceBytes(word, fileOffset, fileOffset + byteLength);
              pieces.push(compressed ? decodeSingleByte(raw) : decodeBytes(raw, 'utf-16le'));
            }
            pieceCount = pieces.length;
            text = pieces.join('');
          }
        }
      }
    } catch (_) {}
  }
  if (!text || textQuality(text) < 10) text = fallbackDocText(word);
  text = normalizeLegacyWordText(text);
  const paragraphs = paragraphsFromText(text, 'doc');
  if (!paragraphs.length) throw new Error('DOC 中没有读取到可识别文字。加密文档、Word 2/5 或仅含图片的文件暂不支持。');
  return {
    paragraphs,
    diagnostics: {
      sourceKind: 'doc',
      legacyWordPieceCount: pieceCount,
      sourceParagraphCount: paragraphs.length,
      effectiveParagraphCount: paragraphs.length,
      legacyImagePlaceholderCount: (text.match(/【图片】/g) || []).length
    }
  };
}

function rtfCodePageLabel(codePage) {
  const value = Number(codePage) || 0;
  if ([936, 54936].includes(value)) return 'gb18030';
  if (value === 65001) return 'utf-8';
  if (value === 1200) return 'utf-16le';
  if (value >= 1250 && value <= 1258) return `windows-${value}`;
  return 'windows-1252';
}

function extractRtf(path) {
  const raw = fileUtil.readTextAuto(path) || decodeSingleByte(readFileBytes(path));
  if (!/^\s*\{\\rtf/i.test(raw)) throw new Error('文件扩展名是 RTF，但内容不是有效 RTF。');
  const ignorable = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'footerf', 'footerl', 'footerr', 'headerf', 'headerl', 'headerr', 'generator', 'datastore', 'themedata', 'colorschememapping', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl']);
  const stack = [];
  let state = { skip: false, uc: 1 };
  let output = '';
  let hexBytes = [];
  let codePage = 1252;
  let skipFallback = 0;

  function flushHex() {
    if (!hexBytes.length) return;
    output += decodeBytes(new Uint8Array(hexBytes), rtfCodePageLabel(codePage));
    hexBytes = [];
  }

  for (let index = 0; index < raw.length;) {
    const char = raw[index];
    if (char === '{') {
      flushHex();
      stack.push({ ...state });
      index += 1;
      continue;
    }
    if (char === '}') {
      flushHex();
      state = stack.pop() || { skip: false, uc: 1 };
      index += 1;
      continue;
    }
    if (char !== '\\') {
      if (!state.skip) {
        if (skipFallback > 0) skipFallback -= 1;
        else output += char;
      }
      index += 1;
      continue;
    }

    flushHex();
    index += 1;
    if (index >= raw.length) break;
    const symbol = raw[index];
    if (symbol === '\\' || symbol === '{' || symbol === '}') {
      if (!state.skip && skipFallback <= 0) output += symbol;
      else if (skipFallback > 0) skipFallback -= 1;
      index += 1;
      continue;
    }
    if (symbol === '*') {
      state.skip = true;
      index += 1;
      continue;
    }
    if (symbol === "'") {
      const value = parseInt(raw.slice(index + 1, index + 3), 16);
      if (!state.skip && Number.isFinite(value)) {
        if (skipFallback > 0) skipFallback -= 1;
        else hexBytes.push(value);
      }
      index += 3;
      continue;
    }
    if (!/[A-Za-z]/.test(symbol)) {
      if (!state.skip) {
        if (symbol === '~') output += '\u00A0';
        else if (symbol === '-') output += '\u00AD';
        else if (symbol === '_') output += '\u2011';
      }
      index += 1;
      continue;
    }

    const wordMatch = /^[A-Za-z]+/.exec(raw.slice(index));
    const word = wordMatch ? wordMatch[0].toLowerCase() : '';
    index += word.length;
    let negative = false;
    if (raw[index] === '-') { negative = true; index += 1; }
    const numberMatch = /^\d+/.exec(raw.slice(index));
    let parameter = null;
    if (numberMatch) {
      parameter = Number(numberMatch[0]);
      if (negative) parameter = -parameter;
      index += numberMatch[0].length;
    }
    if (raw[index] === ' ') index += 1;

    if (ignorable.has(word)) {
      state.skip = true;
      continue;
    }
    if (word === 'ansicpg' && parameter !== null) codePage = parameter;
    if (word === 'uc' && parameter !== null) state.uc = Math.max(0, parameter);
    if (state.skip) continue;
    if (word === 'u' && parameter !== null) {
      let code = parameter;
      if (code < 0) code += 65536;
      output += String.fromCharCode(code);
      skipFallback = state.uc;
    } else if (word === 'par' || word === 'line') output += '\n';
    else if (word === 'tab') output += '\t';
    else if (word === 'emdash') output += '—';
    else if (word === 'endash') output += '–';
    else if (word === 'bullet') output += '•';
    else if (word === 'lquote' || word === 'rquote') output += word === 'lquote' ? '‘' : '’';
    else if (word === 'ldblquote' || word === 'rdblquote') output += word === 'ldblquote' ? '“' : '”';
  }
  flushHex();
  const paragraphs = paragraphsFromText(output, 'rtf');
  if (!paragraphs.length) throw new Error('RTF 中没有读取到可识别文字。');
  return {
    paragraphs,
    diagnostics: {
      sourceKind: 'rtf',
      sourceParagraphCount: paragraphs.length,
      effectiveParagraphCount: paragraphs.length,
      rtfCodePage: codePage
    }
  };
}

function stripMarkdown(text = '') {
  return String(text || '')
    .replace(/^```[^\n]*$/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+(?=\D)/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1【图片】')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

function decodeHtmlText(html = '') {
  return decodeXmlEntities(String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '')
    .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article|header|footer|blockquote)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/&#(\d+);/g, (_, value) => String.fromCharCode(Number(value) || 0))
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCharCode(parseInt(value, 16) || 0))
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n');
}

function parseDelimited(text = '', delimiter = ',') {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === delimiter) { row.push(cell); cell = ''; }
    else if (char === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  row.push(cell.replace(/\r$/, ''));
  if (row.some(value => String(value || '').trim()) || !rows.length) rows.push(row);
  return rows;
}

function detectDelimiter(text = '') {
  const samples = String(text || '').split(/\r?\n/).slice(0, 20).filter(Boolean);
  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestScore = -Infinity;
  candidates.forEach(delimiter => {
    const counts = samples.map(line => parseDelimited(line, delimiter)[0].length);
    const useful = counts.filter(count => count > 1);
    if (!useful.length) return;
    const average = useful.reduce((sum, value) => sum + value, 0) / useful.length;
    const variance = useful.reduce((sum, value) => sum + Math.abs(value - average), 0) / useful.length;
    const score = useful.length * 10 + average - variance * 5;
    if (score > bestScore) { best = delimiter; bestScore = score; }
  });
  return best;
}

function rowsToContext(rows = [], name = 'Sheet1') {
  return {
    name,
    rows: rows.map((values, rowIndex) => {
      const cells = {};
      values.forEach((value, col) => {
        const normalized = normalizeText(String(value === null || value === undefined ? '' : value));
        if (normalized) cells[col] = { value: normalized, formula: '', reference: '', col, row: rowIndex + 1 };
      });
      return { rowNumber: rowIndex + 1, cells };
    })
  };
}

function questionsFromTabularContexts(contexts = [], sourceKind = 'table') {
  const prepared = contexts.map(context => ({ ...context, header: detectHeader(context.rows || []) }));
  const dataContexts = prepared.filter(context => context.header);
  if (!dataContexts.length) return null;
  const multipleSheets = dataContexts.length > 1;
  const questions = [];
  const skippedRows = [];
  let order = 1;
  dataContexts.forEach(context => {
    const headerRow = context.rows[context.header.rowIndex];
    const headers = {};
    Object.keys(headerRow.cells).map(Number).forEach(col => { headers[col] = headerRow.cells[col].value; });
    const mapping = context.header.mapping;
    const difficultyColumn = inferDifficultyColumn(context.rows, context.header.rowIndex, mapping);
    const sheetType = typeInfo(context.name) || null;
    context.rows.slice(context.header.rowIndex + 1).forEach(row => {
      const question = createQuestionFromRow({
        row,
        mapping,
        headers,
        sheetName: context.name,
        multipleSheets,
        sheetType,
        difficultyColumn,
        drawingImages: {},
        cellImages: {},
        order,
        sourceKind,
        boundarySource: `${sourceKind.toUpperCase()} 表格行`
      });
      if (!question) {
        const preview = Object.keys(row.cells).map(Number).sort((a, b) => a - b).map(col => row.cells[col].value).filter(Boolean);
        if (preview.length) skippedRows.push({ sheetName: context.name, rowNumber: row.rowNumber, preview: preview.slice(0, 4).join(' / ') });
        return;
      }
      questions.push(question);
      order += 1;
    });
  });
  return {
    questions,
    diagnostics: {
      sourceKind,
      workbookSheetCount: contexts.length,
      dataSheetCount: dataContexts.length,
      importedSheetNames: dataContexts.map(item => item.name),
      skippedSheetNames: prepared.filter(item => !item.header).map(item => item.name),
      sourceRowCount: dataContexts.reduce((sum, item) => sum + Math.max(0, item.rows.length - item.header.rowIndex - 1), 0),
      importedRowCount: questions.length,
      skippedRowCount: skippedRows.length,
      skippedRows: skippedRows.slice(0, 100),
      sourceParagraphCount: 0,
      effectiveParagraphCount: 0,
      expectedQuestionCount: questions.length,
      expectedCountGap: 0,
      sourceContentQuestionCount: questions.length,
      accountedQuestionCount: questions.length,
      silentLossCount: 0,
      unassignedFragments: [],
      discardedFragments: [],
      numberingIssues: []
    },
    expectedQuestionCount: questions.length
  };
}

function extractDelimited(path, extension = 'csv') {
  const text = fileUtil.readTextAuto(path);
  const delimiter = extension === 'tsv' ? '\t' : detectDelimiter(text);
  const rawRows = parseDelimited(text, delimiter);
  const context = rowsToContext(rawRows, extension.toUpperCase());
  const structured = questionsFromTabularContexts([context], extension);
  if (structured && structured.questions.length) return { ...structured, mode: 'table' };
  const paragraphs = paragraphsFromText(rawRows.map(row => row.filter(Boolean).join(' ')).join('\n'), extension);
  return {
    paragraphs,
    mode: 'text',
    diagnostics: {
      sourceKind: extension,
      delimiter: delimiter === '\t' ? 'TAB' : delimiter,
      sourceRowCount: rawRows.length,
      sourceParagraphCount: paragraphs.length,
      effectiveParagraphCount: paragraphs.length
    }
  };
}

function parseHtmlTable(html = '') {
  const contexts = [];
  const tablePattern = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch;
  let index = 1;
  while ((tableMatch = tablePattern.exec(String(html || '')))) {
    const rows = [];
    const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowPattern.exec(tableMatch[1]))) {
      const cells = [];
      const cellPattern = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
      let cellMatch;
      while ((cellMatch = cellPattern.exec(rowMatch[1]))) cells.push(normalizeText(decodeHtmlText(cellMatch[1])));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) contexts.push(rowsToContext(rows, `HTML表格${index++}`));
  }
  return contexts;
}

function extractTextLike(path, extension = 'txt') {
  const raw = fileUtil.readTextAuto(path);
  if (!raw) throw new Error('文件中没有可读取文字。');
  if (extension === 'html' || extension === 'htm') {
    const contexts = parseHtmlTable(raw);
    const structured = questionsFromTabularContexts(contexts, 'html');
    if (structured && structured.questions.length) return { ...structured, mode: 'table' };
  }
  const text = extension === 'md' || extension === 'markdown' ? stripMarkdown(raw)
    : (extension === 'html' || extension === 'htm' ? decodeHtmlText(raw) : raw);
  const paragraphs = paragraphsFromText(text, extension);
  if (!paragraphs.length) throw new Error('文件中没有识别到有效文本段落。');
  return {
    paragraphs,
    mode: 'text',
    diagnostics: {
      sourceKind: extension,
      sourceParagraphCount: paragraphs.length,
      effectiveParagraphCount: paragraphs.length
    }
  };
}

function odfTextFromBlock(xml = '') {
  return normalizeText(decodeXmlEntities(String(xml || '')
    .replace(/<text:tab\b[^>]*\/?>(?:<\/text:tab>)?/g, '\t')
    .replace(/<text:line-break\b[^>]*\/?>(?:<\/text:line-break>)?/g, '\n')
    .replace(/<text:s\b[^>]*text:c="(\d+)"[^>]*\/?>(?:<\/text:s>)?/g, (_, count) => ' '.repeat(Math.min(50, Number(count) || 1)))
    .replace(/<text:s\b[^>]*\/?>(?:<\/text:s>)?/g, ' ')
    .replace(/<[^>]+>/g, '')));
}

function extractOdt(extractDir) {
  const contentPath = `${extractDir}/content.xml`;
  if (!fileUtil.exists(contentPath)) throw new Error('ODT 文件缺少 content.xml。');
  const xml = fileUtil.readTextAuto(contentPath);
  const paragraphs = [];
  const pattern = /<(text:p|text:h)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let match;
  let index = 0;
  while ((match = pattern.exec(xml))) {
    const text = odfTextFromBlock(match[2]);
    const images = [];
    const imagePattern = /<draw:image\b[^>]*xlink:href="([^"]+)"[^>]*\/?>(?:<\/draw:image>)?/g;
    let imageMatch;
    while ((imageMatch = imagePattern.exec(match[2]))) {
      const relative = decodeXmlEntities(imageMatch[1]).replace(/^\.\//, '');
      const target = `${extractDir}/${relative}`;
      if (fileUtil.exists(target)) images.push(target);
    }
    if (text || images.length) paragraphs.push({ index: index++, text, alternatives: [], style: '', numId: '', level: 0, listOrdinal: 0, images });
  }
  if (!paragraphs.length) throw new Error('ODT 中没有读取到可识别文字。');
  return {
    paragraphs,
    diagnostics: {
      sourceKind: 'odt',
      sourceParagraphCount: paragraphs.length,
      effectiveParagraphCount: paragraphs.length,
      embeddedImageParagraphCount: paragraphs.filter(item => item.images.length).length
    }
  };
}

function parseOdsContexts(extractDir) {
  const contentPath = `${extractDir}/content.xml`;
  if (!fileUtil.exists(contentPath)) throw new Error('ODS 文件缺少 content.xml。');
  const xml = fileUtil.readTextAuto(contentPath);
  const contexts = [];
  const tablePattern = /<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g;
  let tableMatch;
  while ((tableMatch = tablePattern.exec(xml))) {
    const nameMatch = /table:name="([^"]+)"/.exec(tableMatch[1]);
    const name = nameMatch ? decodeXmlEntities(nameMatch[1]) : `Sheet${contexts.length + 1}`;
    const rows = [];
    const rowPattern = /<table:table-row\b([^>]*)>([\s\S]*?)<\/table:table-row>/g;
    let rowMatch;
    while ((rowMatch = rowPattern.exec(tableMatch[2]))) {
      const repeatRowMatch = /table:number-rows-repeated="(\d+)"/.exec(rowMatch[1]);
      const repeatRows = Math.min(5000, Number(repeatRowMatch && repeatRowMatch[1]) || 1);
      const values = [];
      const cellPattern = /<table:(?:table-cell|covered-table-cell)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:table-cell|covered-table-cell)>)/g;
      let cellMatch;
      while ((cellMatch = cellPattern.exec(rowMatch[2]))) {
        const repeatCellMatch = /table:number-columns-repeated="(\d+)"/.exec(cellMatch[1]);
        const repeatCells = Math.min(200, Number(repeatCellMatch && repeatCellMatch[1]) || 1);
        const body = cellMatch[2] || '';
        const paragraphValues = [];
        const pPattern = /<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g;
        let pMatch;
        while ((pMatch = pPattern.exec(body))) paragraphValues.push(odfTextFromBlock(pMatch[1]));
        const attrValue = ((/office:string-value="([^"]*)"/.exec(cellMatch[1]) || [])[1] || '');
        const value = normalizeText(paragraphValues.filter(Boolean).join('\n') || decodeXmlEntities(attrValue));
        for (let index = 0; index < repeatCells; index += 1) values.push(value);
      }
      for (let index = 0; index < repeatRows; index += 1) rows.push(values.slice());
    }
    contexts.push(rowsToContext(rows, name));
  }
  return contexts;
}

function extractOds(extractDir) {
  const contexts = parseOdsContexts(extractDir);
  const structured = questionsFromTabularContexts(contexts, 'ods');
  if (!structured || !structured.questions.length) throw new Error('ODS 中没有找到包含题干、答案或选项表头的题目表。');
  return structured;
}

function decodeBiffString(bytes, offset, cch, flags) {
  const is16 = Boolean(flags & 0x01);
  const byteLength = cch * (is16 ? 2 : 1);
  const raw = sliceBytes(bytes, offset, offset + byteLength);
  return { text: is16 ? decodeBytes(raw, 'utf-16le') : decodeSingleByte(raw), byteLength };
}

class SegmentCursor {
  constructor(segments) {
    this.segments = segments || [];
    this.segmentIndex = 0;
    this.offset = 0;
  }
  available() {
    const current = this.segments[this.segmentIndex] || new Uint8Array(0);
    return current.length - this.offset;
  }
  nextSegment() {
    this.segmentIndex += 1;
    this.offset = 0;
    return this.segmentIndex < this.segments.length;
  }
  readByte() {
    while (this.segmentIndex < this.segments.length && this.available() <= 0) this.nextSegment();
    const current = this.segments[this.segmentIndex];
    if (!current || this.offset >= current.length) return 0;
    return current[this.offset++];
  }
  readU16() { return this.readByte() | (this.readByte() << 8); }
  readU32() { return (this.readByte() | (this.readByte() << 8) | (this.readByte() << 16) | (this.readByte() << 24)) >>> 0; }
  skip(count) { for (let index = 0; index < count; index += 1) this.readByte(); }
  readChars(count, initial16) {
    let is16 = initial16;
    const chunks = [];
    let bytes = [];
    const flush = () => {
      if (!bytes.length) return;
      chunks.push(is16 ? decodeBytes(new Uint8Array(bytes), 'utf-16le') : decodeSingleByte(new Uint8Array(bytes)));
      bytes = [];
    };
    let remaining = count;
    while (remaining > 0 && this.segmentIndex < this.segments.length) {
      if (this.available() <= 0) {
        flush();
        if (!this.nextSegment()) break;
        const option = this.readByte();
        is16 = Boolean(option & 0x01);
      }
      const unit = is16 ? 2 : 1;
      if (this.available() < unit) {
        flush();
        if (!this.nextSegment()) break;
        const option = this.readByte();
        is16 = Boolean(option & 0x01);
        continue;
      }
      bytes.push(this.readByte());
      if (is16) bytes.push(this.readByte());
      remaining -= 1;
    }
    flush();
    return chunks.join('');
  }
}

function parseSst(segments) {
  if (!segments.length) return [];
  const cursor = new SegmentCursor(segments);
  cursor.readU32();
  const unique = cursor.readU32();
  const strings = [];
  for (let index = 0; index < unique && cursor.segmentIndex < segments.length; index += 1) {
    const cch = cursor.readU16();
    const flags = cursor.readByte();
    const richCount = flags & 0x08 ? cursor.readU16() : 0;
    const extSize = flags & 0x04 ? cursor.readU32() : 0;
    const text = cursor.readChars(cch, Boolean(flags & 0x01));
    if (richCount) cursor.skip(richCount * 4);
    if (extSize) cursor.skip(extSize);
    strings.push(normalizeText(text));
  }
  return strings;
}

function decodeRk(value) {
  const divide = Boolean(value & 0x01);
  const integer = Boolean(value & 0x02);
  let result;
  if (integer) result = (value | 0) >> 2;
  else {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setUint32(0, 0, true);
    view.setUint32(4, value & 0xFFFFFFFC, true);
    result = view.getFloat64(0, true);
  }
  return divide ? result / 100 : result;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return '';
  if (Math.abs(value - Math.round(value)) < 1e-10) return String(Math.round(value));
  return String(Number(value.toPrecision(14)));
}

function parseBiffRecords(workbook) {
  const records = [];
  let offset = 0;
  while (offset + 4 <= workbook.length) {
    const id = u16(workbook, offset);
    const length = u16(workbook, offset + 2);
    const start = offset + 4;
    const end = start + length;
    if (end > workbook.length) break;
    records.push({ id, offset, start, end, data: sliceBytes(workbook, start, end) });
    offset = end;
  }
  return records;
}

function parseBoundSheetName(data) {
  const cch = data[6] || 0;
  const flags = data[7] || 0;
  if (!cch) return '';
  return normalizeText(decodeBiffString(data, 8, cch, flags).text);
}

function parseLegacyXls(path) {
  const compound = parseCompoundFile(readFileBytes(path));
  const workbook = compound.streams.Workbook || compound.streams.Book;
  if (!workbook || !workbook.length) throw new Error('XLS 文件缺少 Workbook 数据流。');
  const records = parseBiffRecords(workbook);
  const sheets = [];
  const sstSegments = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.id === 0x0085 && record.data.length >= 8) {
      sheets.push({ offset: u32(record.data, 0), name: parseBoundSheetName(record.data) || `Sheet${sheets.length + 1}` });
    }
    if (record.id === 0x00FC) {
      sstSegments.push(record.data);
      let look = index + 1;
      while (records[look] && records[look].id === 0x003C) {
        sstSegments.push(records[look].data);
        look += 1;
      }
    }
  }
  const sst = parseSst(sstSegments);
  const contexts = [];
  const sheetList = sheets.length ? sheets : [{ offset: 0, name: 'Sheet1' }];

  sheetList.forEach(sheet => {
    const rowMap = {};
    let offset = Math.min(sheet.offset, workbook.length);
    let pendingFormulaCell = null;
    while (offset + 4 <= workbook.length) {
      const id = u16(workbook, offset);
      const length = u16(workbook, offset + 2);
      const start = offset + 4;
      const end = start + length;
      if (end > workbook.length) break;
      const data = sliceBytes(workbook, start, end);
      if (id === 0x000A) break;
      const put = (row, col, value) => {
        if (row > 65535 || col > 1024) return;
        if (!rowMap[row]) rowMap[row] = [];
        rowMap[row][col] = normalizeText(String(value === null || value === undefined ? '' : value));
      };
      if (id === 0x00FD && data.length >= 10) {
        put(u16(data, 0), u16(data, 2), sst[u32(data, 6)] || '');
      } else if (id === 0x0204 && data.length >= 8) {
        const cch = u16(data, 6);
        let text = '';
        if (data.length >= 9) text = decodeBiffString(data, 9, cch, data[8]).text;
        else text = decodeSingleByte(sliceBytes(data, 8, 8 + cch));
        put(u16(data, 0), u16(data, 2), text);
      } else if (id === 0x0203 && data.length >= 14) {
        put(u16(data, 0), u16(data, 2), formatNumber(f64(data, 6)));
      } else if (id === 0x027E && data.length >= 10) {
        put(u16(data, 0), u16(data, 2), formatNumber(decodeRk(u32(data, 6))));
      } else if (id === 0x00BD && data.length >= 6) {
        const row = u16(data, 0);
        const firstCol = u16(data, 2);
        const lastCol = u16(data, data.length - 2);
        for (let col = firstCol, cursor = 4; col <= lastCol && cursor + 6 <= data.length - 2; col += 1, cursor += 6) {
          put(row, col, formatNumber(decodeRk(u32(data, cursor + 2))));
        }
      } else if (id === 0x0205 && data.length >= 8) {
        const isError = data[7] === 1;
        put(u16(data, 0), u16(data, 2), isError ? `#ERR${data[6]}` : (data[6] ? 'TRUE' : 'FALSE'));
      } else if (id === 0x0006 && data.length >= 14) {
        const row = u16(data, 0), col = u16(data, 2);
        const special = data[12] === 0xFF && data[13] === 0xFF;
        if (special) pendingFormulaCell = { row, col };
        else put(row, col, formatNumber(f64(data, 6)));
      } else if (id === 0x0207 && pendingFormulaCell && data.length >= 3) {
        const cch = u16(data, 0);
        const text = decodeBiffString(data, 3, cch, data[2]).text;
        put(pendingFormulaCell.row, pendingFormulaCell.col, text);
        pendingFormulaCell = null;
      }
      offset = end;
    }
    const maxRow = Object.keys(rowMap).map(Number).reduce((max, value) => Math.max(max, value), -1);
    const rows = [];
    for (let row = 0; row <= maxRow; row += 1) rows.push(rowMap[row] || []);
    contexts.push(rowsToContext(rows, sheet.name));
  });

  const structured = questionsFromTabularContexts(contexts, 'xls');
  if (!structured || !structured.questions.length) throw new Error('XLS 中没有找到包含题干、答案或选项表头的题目表。');
  structured.diagnostics.legacyWorkbookStream = compound.streams.Workbook ? 'Workbook' : 'Book';
  structured.diagnostics.sharedStringCount = sst.length;
  return structured;
}

module.exports = {
  parseCompoundFile,
  extractLegacyDoc,
  extractRtf,
  extractDelimited,
  extractTextLike,
  extractOdt,
  extractOds,
  parseLegacyXls,
  questionsFromTabularContexts,
  rowsToContext,
  paragraphsFromText,
  parseDelimited,
  detectDelimiter
};
});
__define("services/docx-importer.js", function(require, module, exports){
const fileUtil = require('../utils/file');
const binaryArchive = require('../utils/binary-archive');
const { IMPORT_DIR, PICKED_FILE_CACHE_DIR, CURRENT_PARSER_VERSION } = require('../utils/constants');
const { createId } = require('../utils/id');
const { safeFileName } = require('../utils/text');
const { extractDocx } = require('./docx-extractor');
const { parseParagraphsDetailed, parseParagraphsAdaptive, analyzeQuestionBankStructure } = require('./question-parser');
const { detectHeader, inferDifficultyColumn, createQuestionFromRow, typeInfo } = require('./xlsx-extractor');
const localAI = require('./local-ai-model');

const WORD_OPEN_XML = ['docx', 'docm', 'dotx', 'dotm'];
const EXCEL_OPEN_XML = ['xlsx', 'xlsm', 'xltx', 'xltm'];
const WORD_TEXT_FORMATS = ['doc', 'rtf', 'odt', 'txt', 'md', 'markdown', 'html', 'htm'];
const TABLE_FORMATS = ['xls', 'ods', 'csv', 'tsv'];
const ARCHIVE_FORMATS = ['qbank', 'json', 'buaiquiz'];
const SUPPORTED_EXTENSIONS = [
  ...WORD_OPEN_XML,
  ...EXCEL_OPEN_XML,
  ...WORD_TEXT_FORMATS,
  ...TABLE_FORMATS,
  'pdf',
  ...ARCHIVE_FORMATS
];


function isNativePickedFilePath(path = '') {
  const value = String(path || '').replace(/\\/g, '/');
  const root = String(PICKED_FILE_CACHE_DIR || '').replace(/\\/g, '/').replace(/\/$/, '');
  return Boolean(value && root && (value === root || value.startsWith(`${root}/`)));
}

function releasePickedFile(fileOrPath) {
  const path = typeof fileOrPath === 'string' ? fileOrPath : (fileOrPath && fileOrPath.path);
  if (!isNativePickedFilePath(path) || !fileUtil.exists(path)) return 0;
  const bytes = fileUtil.directorySize(path);
  try { fileUtil.removeRecursive(path); } catch (_) { return 0; }
  return bytes;
}

function chooseFile() {
  return new Promise((resolve, reject) => {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: SUPPORTED_EXTENSIONS,
      success(res) {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) reject(new Error('没有选择文件'));
        else resolve(file);
      },
      fail: reject
    });
  });
}

function countStatuses(questions) {
  return questions.reduce((acc, item) => {
    const status = item.status || 'normal';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, { normal: 0, warning: 0, error: 0 });
}

function stripExtension(name = '') {
  return String(name || '').replace(/\.[^.]+$/i, '');
}

function extensionLabel(extension = '') {
  const ext = String(extension || '').toLowerCase();
  if (WORD_OPEN_XML.includes(ext) || ['doc', 'rtf', 'odt'].includes(ext)) return 'Word';
  if (EXCEL_OPEN_XML.includes(ext) || ['xls', 'ods', 'csv', 'tsv'].includes(ext)) return 'Excel/表格';
  if (['txt', 'md', 'markdown', 'html', 'htm'].includes(ext)) return '文本';
  if (ext === 'pdf') return 'PDF';
  return '题库包';
}

function sourceFragmentLabel(extension = '') {
  const ext = String(extension || '').toLowerCase();
  if (EXCEL_OPEN_XML.includes(ext) || ['xls', 'ods', 'csv', 'tsv'].includes(ext)) return `原始 ${ext.toUpperCase()} 行`;
  if (ext === 'pdf') return '原始 PDF 文本片段';
  return `原始 ${ext.toUpperCase()} 文本片段`;
}

function validateSize(file, maximumMb, label) {
  if (file.size && file.size > maximumMb * 1024 * 1024) {
    throw new Error(`${label}超过 ${maximumMb}MB。纯本地解析容易卡顿，请先压缩或拆分文件。`);
  }
}

function mergeDiagnostics(parsed, extracted, sourceKind) {
  return Object.assign({}, parsed && parsed.diagnostics || {}, extracted && extracted.diagnostics || {}, { sourceKind });
}

function parseWordTableQuestions(paragraphs = [], options = {}) {
  const tables = Array.isArray(paragraphs.tableContexts) ? paragraphs.tableContexts : [];
  if (!tables.length) return { questions: [], usedTableIds: new Set(), diagnostics: { docxStructuredTableCount: 0, docxKeyValueTableCount: 0 } };
  const usedTableIds = new Set();
  const questions = [];
  let structuredCount = 0, keyValueCount = 0;
  let order = 1;

  const makeRows = table => table.rows.map((row, rowIndex) => {
    const cells = {};
    (row.values || []).forEach((value, col) => {
      const normalized = String(value || '').trim();
      if (normalized || ((row.images || [])[col] || []).length) cells[col] = { value: normalized, formula: '', reference: '', col, row: rowIndex + 1 };
    });
    return { rowNumber: rowIndex + 1, cells };
  });

  tables.forEach(table => {
    const rows = makeRows(table);
    const header = detectHeader(rows);
    if (header) {
      const headers = {};
      Object.keys(rows[header.rowIndex].cells).map(Number).forEach(col => { headers[col] = rows[header.rowIndex].cells[col].value; });
      const mapping = header.mapping;
      const difficultyColumn = inferDifficultyColumn(rows, header.rowIndex, mapping);
      const drawingImages = {};
      (table.rows || []).forEach((row, rowIndex) => {
        (row.images || []).forEach((images, col) => {
          if (!images || !images.length) return;
          if (!drawingImages[rowIndex + 1]) drawingImages[rowIndex + 1] = {};
          drawingImages[rowIndex + 1][col] = images.slice();
        });
      });
      const sheetType = typeInfo(table.name) || null;
      const created = [];
      rows.slice(header.rowIndex + 1).forEach(row => {
        const question = createQuestionFromRow({
          row, mapping, headers, sheetName: table.name, multipleSheets: false, sheetType, difficultyColumn,
          drawingImages, cellImages: {}, order, sourceKind: options.sourceKind || 'docx', boundarySource: 'Word 表格行'
        });
        if (!question) return;
        question._docxSourceStart = Number(table.sourceStart || 0) + row.rowNumber / 10000;
        created.push(question); questions.push(question); order += 1;
      });
      if (created.length) { usedTableIds.add(table.id); structuredCount += 1; }
      return;
    }

    // 兼容“一题一个表格”：左列是题目/A/B/答案/解析等标签，右列是内容。
    const labels = new Set(['题目','题干','问题','答案','正确答案','标准答案','参考答案','解析','答案解析','难度','分类','知识点','考点','题型','A','B','C','D','E','F','G','H']);
    let recognized = 0;
    const synthetic = [];
    (table.rows || []).forEach((row, rowIndex) => {
      const values = (row.values || []).map(value => String(value || '').trim());
      if (!values.some(Boolean)) return;
      const first = values[0] || '';
      const rest = values.slice(1).filter(Boolean).join(' ');
      let text = values.filter(Boolean).join(' ');
      if (labels.has(first) && rest) {
        recognized += 1;
        if (/^[A-H]$/.test(first)) text = `${first}. ${rest}`;
        else text = `${first}：${rest}`;
      } else if (/^\d{1,4}$/.test(first) && rest) {
        recognized += 1;
        text = `${first}. ${rest}`;
      }
      const images = (row.images || []).reduce((all, list) => all.concat(list || []), []);
      synthetic.push({ index: rowIndex, text, alternatives: [], style: '', numId: '', level: 0, listOrdinal: 0, images, sourceStart: Number(table.sourceStart || 0) + rowIndex });
    });
    if (recognized >= 2) {
      const parsed = parseParagraphsDetailed(synthetic, { sourceName: options.sourceName || '', useLocalAI: Boolean(options.useLocalAI), sourceKind: options.sourceKind || 'docx' });
      parsed.questions.forEach((question, index) => {
        question._docxSourceStart = Number(table.sourceStart || 0) + index / 10000;
        questions.push(question);
      });
      if (parsed.questions.length) { usedTableIds.add(table.id); keyValueCount += 1; }
    }
  });
  return { questions, usedTableIds, diagnostics: { docxStructuredTableCount: structuredCount, docxKeyValueTableCount: keyValueCount, docxTableQuestionCount: questions.length } };
}

function mergeWordQuestions(textQuestions = [], tableResult = null, paragraphs = []) {
  const sourceStartByIndex = {};
  (paragraphs || []).forEach(item => { sourceStartByIndex[item.index] = Number(item.sourceStart || item.index || 0); });
  const merged = [];
  textQuestions.forEach(question => {
    const indexes = question.source && Array.isArray(question.source.paragraphIndexes) ? question.source.paragraphIndexes : [];
    const first = indexes.length ? Math.min(...indexes.map(index => sourceStartByIndex[index] === undefined ? Number.MAX_SAFE_INTEGER : sourceStartByIndex[index])) : Number.MAX_SAFE_INTEGER;
    merged.push({ question, sourceStart: first });
  });
  (tableResult && tableResult.questions || []).forEach(question => merged.push({ question, sourceStart: Number(question._docxSourceStart || Number.MAX_SAFE_INTEGER) }));
  return merged.sort((a, b) => a.sourceStart - b.sourceStart).map((entry, index) => {
    const question = entry.question;
    delete question._docxSourceStart;
    question.order = index + 1;
    return question;
  });
}

async function importOpenXmlWord(file, options = {}, onProgress = () => {}) {
  const extension = fileUtil.getExtension(file.name);
  if (!WORD_OPEN_XML.includes(extension)) throw new Error('请选择 Word Open XML 文件。');
  validateSize(file, 40, 'Word 文件');
  fileUtil.ensureDir(IMPORT_DIR);
  const importId = createId('word-import');
  const workDir = `${IMPORT_DIR}/${importId}`;
  const sourcePath = `${workDir}/${safeFileName(file.name)}`;
  const extractDir = `${workDir}/unzipped`;
  fileUtil.ensureDir(workDir);
  try {
    onProgress(10, '正在复制 Word 文件');
    fileUtil.copyFile(file.path, sourcePath);
    onProgress(25, `正在解压 ${extension.toUpperCase()}`);
    await fileUtil.unzip(sourcePath, extractDir);
    onProgress(45, '正在读取 Word 正文和图片');
    const paragraphs = extractDocx(extractDir);
    const useLocalAI = Boolean(options.useLocalAI);
    if (useLocalAI) {
      onProgress(58, '正在加载并自检本地 AI 模型');
      const modelCheck = localAI.selfTest();
      if (!modelCheck.ok) throw new Error(`本地 AI 模型无法调用：${modelCheck.message}`);
    }
    onProgress(65, useLocalAI ? `规则解析 + 本地AI辅助 ${paragraphs.length} 个段落` : `规则解析 ${paragraphs.length} 个段落`);
    const tableResult = parseWordTableQuestions(paragraphs, { sourceName: file.name, useLocalAI, sourceKind: extension });
    const textParagraphs = paragraphs.filter(item => !item.tableId || !tableResult.usedTableIds.has(item.tableId));
    const structure = analyzeQuestionBankStructure(textParagraphs, { sourceKind: extension });
    onProgress(68, `已识别题库结构：${structure.layout}，正在选择最合适的解析策略`);
    const parsed = parseParagraphsAdaptive(textParagraphs, { sourceName: file.name, useLocalAI, sourceKind: extension });
    parsed.questions = mergeWordQuestions(parsed.questions, tableResult, textParagraphs);
    parsed.diagnostics = Object.assign({}, parsed.diagnostics || {}, tableResult.diagnostics || {});
    if (!parsed.questions.length) throw new Error('没有识别到题目。请确认 Word 中存在可读取文字、表格或题库结构，并检查原文排版。');
    onProgress(90, '正在检查边界、答案、重复题和异常题');
    const counts = countStatuses(parsed.questions);
    onProgress(100, 'Word 解析完成');
    return {
      kind: extension,
      workDir,
      originalSourcePath: sourcePath,
      originalDocxPath: sourcePath,
      extractDir,
      name: stripExtension(file.name),
      sourceName: file.name,
      createdAt: Date.now(),
      paragraphsCount: paragraphs.length,
      questions: parsed.questions,
      counts,
      diagnostics: Object.assign({}, parsed.diagnostics || {}, { sourceKind: extension }),
      parserVersion: CURRENT_PARSER_VERSION,
      localAIEnabled: useLocalAI,
      localAIModelVersion: useLocalAI ? (parsed.diagnostics.localAIModelVersion || '') : ''
    };
  } catch (error) {
    if (fileUtil.exists(workDir)) fileUtil.removeRecursive(workDir);
    throw error;
  }
}

async function importOpenXmlExcel(file, options = {}, onProgress = () => {}) {
  const extension = fileUtil.getExtension(file.name);
  if (!EXCEL_OPEN_XML.includes(extension)) throw new Error('请选择 Excel Open XML 文件。');
  validateSize(file, 60, 'Excel 文件');
  fileUtil.ensureDir(IMPORT_DIR);
  const importId = createId('excel-import');
  const workDir = `${IMPORT_DIR}/${importId}`;
  const sourcePath = `${workDir}/${safeFileName(file.name)}`;
  const extractDir = `${workDir}/unzipped`;
  fileUtil.ensureDir(workDir);
  try {
    onProgress(10, '正在复制 Excel 文件');
    fileUtil.copyFile(file.path, sourcePath);
    onProgress(25, `正在解压 ${extension.toUpperCase()}`);
    await fileUtil.unzip(sourcePath, extractDir);
    onProgress(45, '正在识别工作表和表头');
    const { extractXlsx } = require('./xlsx-extractor');
    const parsed = extractXlsx(extractDir, { sourceName: file.name });
    parsed.questions.forEach(question => {
      if (question.source) question.source.kind = extension;
      if (question.boundarySource === 'Excel 表格行') question.boundarySource = `${extension.toUpperCase()} 表格行`;
    });
    if (!parsed.questions.length) throw new Error('没有从 Excel 中读取到题目。');
    onProgress(88, '正在检查题型、难度、答案和图片');
    const counts = countStatuses(parsed.questions);
    onProgress(100, 'Excel 解析完成');
    return {
      kind: extension,
      workDir,
      originalSourcePath: sourcePath,
      extractDir,
      name: stripExtension(file.name),
      sourceName: file.name,
      createdAt: Date.now(),
      paragraphsCount: 0,
      questions: parsed.questions,
      counts,
      diagnostics: Object.assign({}, parsed.diagnostics || {}, { sourceKind: extension }),
      expectedQuestionCount: parsed.expectedQuestionCount || 0,
      parserVersion: CURRENT_PARSER_VERSION,
      localAIEnabled: false,
      localAIModelVersion: ''
    };
  } catch (error) {
    if (fileUtil.exists(workDir)) fileUtil.removeRecursive(workDir);
    throw error;
  }
}

async function importCommonFormat(file, options = {}, onProgress = () => {}) {
  const extension = fileUtil.getExtension(file.name);
  if (!WORD_TEXT_FORMATS.includes(extension) && !TABLE_FORMATS.includes(extension)) {
    throw new Error('请选择受支持的 DOC、XLS、RTF、ODF、文本或表格文件。');
  }
  validateSize(file, ['doc', 'xls', 'odt', 'ods'].includes(extension) ? 50 : 20, `${extension.toUpperCase()} 文件`);
  fileUtil.ensureDir(IMPORT_DIR);
  const importId = createId(`${extension}-import`);
  const workDir = `${IMPORT_DIR}/${importId}`;
  const sourcePath = `${workDir}/${safeFileName(file.name)}`;
  const extractDir = `${workDir}/unzipped`;
  fileUtil.ensureDir(workDir);
  try {
    onProgress(10, `正在复制 ${extension.toUpperCase()} 文件`);
    fileUtil.copyFile(file.path, sourcePath);
    const common = require('./common-format-extractor');
    let extracted;
    if (extension === 'doc') {
      onProgress(35, '正在读取 Word 97-2003 二进制正文');
      extracted = common.extractLegacyDoc(sourcePath);
    } else if (extension === 'xls') {
      onProgress(35, '正在读取 Excel 97-2003 工作簿');
      extracted = common.parseLegacyXls(sourcePath);
    } else if (extension === 'rtf') {
      onProgress(35, '正在解析 RTF 文字和 Unicode 转义');
      extracted = common.extractRtf(sourcePath);
    } else if (extension === 'odt') {
      onProgress(25, '正在解压 ODT');
      await fileUtil.unzip(sourcePath, extractDir);
      onProgress(45, '正在读取 ODT 正文和图片');
      extracted = common.extractOdt(extractDir);
    } else if (extension === 'ods') {
      onProgress(25, '正在解压 ODS');
      await fileUtil.unzip(sourcePath, extractDir);
      onProgress(45, '正在识别 ODS 工作表和表头');
      extracted = common.extractOds(extractDir);
    } else if (extension === 'csv' || extension === 'tsv') {
      onProgress(35, `正在识别 ${extension.toUpperCase()} 编码、分隔符和表头`);
      extracted = common.extractDelimited(sourcePath, extension);
    } else {
      onProgress(35, `正在识别 ${extension.toUpperCase()} 编码和文本结构`);
      extracted = common.extractTextLike(sourcePath, extension);
    }

    let questions = extracted.questions || [];
    let diagnostics = extracted.diagnostics || {};
    let paragraphsCount = 0;
    let useLocalAI = false;
    if (!questions.length && extracted.paragraphs) {
      paragraphsCount = extracted.paragraphs.length;
      useLocalAI = Boolean(options.useLocalAI && WORD_TEXT_FORMATS.includes(extension));
      if (useLocalAI) {
        onProgress(56, '正在加载并自检本地 AI 模型');
        const modelCheck = localAI.selfTest();
        if (!modelCheck.ok) throw new Error(`本地 AI 模型无法调用：${modelCheck.message}`);
      }
      onProgress(65, `正在解析 ${paragraphsCount} 个文本段落`);
      const structure = analyzeQuestionBankStructure(extracted.paragraphs, { sourceKind: extension });
      onProgress(68, `已识别题库结构：${structure.layout}，正在选择最合适的解析策略`);
      const parsed = parseParagraphsAdaptive(extracted.paragraphs, { sourceName: file.name, useLocalAI, sourceKind: extension });
      questions = parsed.questions;
      diagnostics = mergeDiagnostics(parsed, extracted, extension);
    }
    if (!questions.length) throw new Error(`${extension.toUpperCase()} 中没有识别到题目。请检查题号、选项、答案或表头格式。`);
    onProgress(92, '正在检查题型、答案、重复题和异常题');
    const counts = countStatuses(questions);
    onProgress(100, `${extension.toUpperCase()} 解析完成`);
    return {
      kind: extension,
      workDir,
      originalSourcePath: sourcePath,
      extractDir: fileUtil.exists(extractDir) ? extractDir : '',
      name: stripExtension(file.name),
      sourceName: file.name,
      createdAt: Date.now(),
      paragraphsCount,
      questions,
      counts,
      diagnostics: Object.assign({}, diagnostics, { sourceKind: extension, sourceFragmentLabel: sourceFragmentLabel(extension) }),
      expectedQuestionCount: extracted.expectedQuestionCount || questions.length,
      parserVersion: CURRENT_PARSER_VERSION,
      localAIEnabled: useLocalAI,
      localAIModelVersion: useLocalAI ? (diagnostics.localAIModelVersion || '') : ''
    };
  } catch (error) {
    if (fileUtil.exists(workDir)) fileUtil.removeRecursive(workDir);
    throw error;
  }
}

async function importPdf(file, options = {}, onProgress = () => {}) {
  if (typeof options === 'function') { onProgress = options; options = {}; }
  const extension = fileUtil.getExtension(file.name);
  if (extension !== 'pdf') throw new Error('请选择 .pdf 文件。');
  validateSize(file, 80, 'PDF');
  fileUtil.ensureDir(IMPORT_DIR);
  const importId = createId('pdf-import');
  const workDir = `${IMPORT_DIR}/${importId}`;
  const pdfPath = `${workDir}/${safeFileName(file.name)}`;
  fileUtil.ensureDir(workDir);
  try {
    onProgress(8, '正在复制 PDF 文件');
    fileUtil.copyFile(file.path, pdfPath);
    onProgress(15, '正在检查 PDF 文字层');
    const { extractPdf } = require('./pdf-extractor');
    const extracted = await extractPdf(pdfPath, workDir, onProgress);
    if (!extracted.paragraphs.length || !extracted.diagnostics.pdfTextPageCount) {
      throw new Error('这个 PDF 没有可读取文字层，可能是扫描版。当前版本暂不启用 OCR。');
    }
    onProgress(97, `页面读取完成，正在整理 ${extracted.paragraphs.length} 个 PDF 文本片段`);
    const structure = analyzeQuestionBankStructure(extracted.paragraphs, { sourceKind: 'pdf' });
    onProgress(98, `已识别 PDF 题库结构：${structure.layout}，正在对比解析策略`);
    const parsed = parseParagraphsAdaptive(extracted.paragraphs, { sourceName: file.name, useLocalAI: false, sourceKind: 'pdf' });
    if (!parsed.questions.length) throw new Error('PDF 有文字层，但没有识别到题目。请检查题号、选项和答案排版。');
    const diagnostics = Object.assign({}, parsed.diagnostics || {}, extracted.diagnostics || {});
    onProgress(99, '正在检查 PDF 题目、答案与图片');
    const counts = countStatuses(parsed.questions);
    onProgress(100, 'PDF 解析完成');
    return {
      kind: 'pdf', workDir, originalSourcePath: pdfPath, name: stripExtension(file.name), sourceName: file.name,
      createdAt: Date.now(), paragraphsCount: extracted.paragraphs.length, questions: parsed.questions, counts, diagnostics,
      parserVersion: CURRENT_PARSER_VERSION, localAIEnabled: false, localAIModelVersion: ''
    };
  } catch (error) {
    if (fileUtil.exists(workDir)) fileUtil.removeRecursive(workDir);
    throw error;
  }
}

function importQbank(file) {
  const extension = fileUtil.getExtension(file.name);
  if (!ARCHIVE_FORMATS.includes(extension)) throw new Error('请选择 .qbank、.buaiquiz 或 .json 题库包。');
  const archive = binaryArchive.readArchive(file.path);
  const data = archive ? archive.metadata : JSON.parse(fileUtil.readTextAuto(file.path));
  if (!data || !Array.isArray(data.questions)) throw new Error('题库包格式不正确：缺少 questions 数组。');

  const importId = createId('qbank');
  const workDir = `${IMPORT_DIR}/${importId}`;
  const assetDir = `${workDir}/assets`;
  fileUtil.ensureDir(assetDir);
  const assets = data.assets || {};
  Object.keys(assets).forEach(name => {
    const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
    fileUtil.writeBase64(`${assetDir}/${safeName}`, assets[name]);
  });
  Object.keys(archive && archive.entries || {}).forEach(name => {
    const safeName = name.replace(/^assets\//, '').replace(/[\\/:*?"<>|]/g, '_');
    binaryArchive.writeBytes(`${assetDir}/${safeName}`, archive.entries[name]);
  });

  const restoreAsset = value => {
    if (!value) return value;
    const text = String(value);
    let name = '';
    if (text.startsWith('qbank://')) name = text.slice('qbank://'.length);
    else if (text.startsWith('qbank2://')) name = text.slice('qbank2://'.length).replace(/^assets\//, '');
    else return value;
    name = name.replace(/[\\/:*?"<>|]/g, '_');
    const target = `${assetDir}/${name}`;
    return fileUtil.exists(target) ? target : '';
  };
  const questions = JSON.parse(JSON.stringify(data.questions)).map(question => {
    question.images = (question.images || []).map(restoreAsset).filter(Boolean);
    question.answerImages = (question.answerImages || []).map(restoreAsset).filter(Boolean);
    question.analysisImages = (question.analysisImages || []).map(restoreAsset).filter(Boolean);
    question.options = (question.options || []).map(option => ({ ...option, images: (option.images || []).map(restoreAsset).filter(Boolean) }));
    return question;
  });

  return {
    kind: 'qbank',
    workDir,
    name: data.manifest && data.manifest.name ? data.manifest.name : stripExtension(file.name),
    sourceName: file.name,
    createdAt: Date.now(),
    questions,
    counts: countStatuses(questions),
    parserVersion: data.manifest && data.manifest.parserVersion ? data.manifest.parserVersion : 'legacy',
    diagnostics: data.diagnostics || {
      sourceParagraphCount: 0,
      effectiveParagraphCount: 0,
      removedNoiseCount: 0,
      splitQuestionStartRepairCount: 0,
      inferredBoundaryCount: 0,
      inlineAnswerCount: 0,
      duplicateCount: questions.filter(item => item.duplicateOf).length,
      unlabeledAnswerCount: questions.filter(item => (item.answerSource || '').includes('无答案标签')).length
    }
  };
}

async function importSelected(file, options = {}, onProgress = () => {}) {
  if (!file) throw new Error('请先选择文件。');
  const extension = fileUtil.getExtension(file.name);
  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    throw new Error(`暂不支持 .${extension || '未知'} 文件。支持 DOC/DOCX、XLS/XLSX、RTF、ODT/ODS、TXT/MD/HTML、CSV/TSV、PDF 和题库包。`);
  }
  if (WORD_OPEN_XML.includes(extension)) return importOpenXmlWord(file, options, onProgress);
  if (EXCEL_OPEN_XML.includes(extension)) return importOpenXmlExcel(file, options, onProgress);
  if (WORD_TEXT_FORMATS.includes(extension) || TABLE_FORMATS.includes(extension)) return importCommonFormat(file, options, onProgress);
  if (extension === 'pdf') return importPdf(file, options, onProgress);
  onProgress(35, '正在读取题库包');
  const result = importQbank(file);
  onProgress(100, '题库包读取完成');
  return result;
}

async function chooseAndImport(onProgress) {
  const file = await chooseFile();
  try {
    return await importSelected(file, { useLocalAI: false }, onProgress);
  } finally {
    releasePickedFile(file);
  }
}

module.exports = {
  SUPPORTED_EXTENSIONS,
  WORD_OPEN_XML,
  EXCEL_OPEN_XML,
  WORD_TEXT_FORMATS,
  TABLE_FORMATS,
  chooseFile,
  importDocx: importOpenXmlWord,
  importXlsx: importOpenXmlExcel,
  importPdf,
  importQbank,
  importCommonFormat,
  importSelected,
  chooseAndImport,
  extensionLabel,
  releasePickedFile,
  isNativePickedFilePath
};
});
__define("services/practice-service.js", function(require, module, exports){
const bankStorage = require('./bank-storage');
const recordStorage = require('./record-storage');
const { QUESTION_TYPES } = require('../utils/constants');

function shuffle(items) {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function sameAnswer(left = [], right = []) {
  return left.slice().sort().join(',') === right.slice().sort().join(',');
}

function buildQuestionEditSignature(question) {
  const item = question || {};
  return JSON.stringify({
    type: String(item.type || ''),
    question: String(item.question || ''),
    images: Array.isArray(item.images) ? item.images.map(String) : [],
    options: (Array.isArray(item.options) ? item.options : []).map(option => ({
      key: String(option && option.key || ''),
      text: String(option && option.text || ''),
      images: Array.isArray(option && option.images) ? option.images.map(String) : []
    })),
    answer: (Array.isArray(item.answer) ? item.answer : []).map(String).sort(),
    answerText: String(item.answerText || '')
  });
}

function optionEditFingerprint(option) {
  const item = option || {};
  return JSON.stringify({
    text: String(item.text || '').trim(),
    images: Array.isArray(item.images) ? item.images.map(String) : []
  });
}

function remapSelectedOptions(previousQuestion, nextQuestion, selected = []) {
  const previousOptions = Array.isArray(previousQuestion && previousQuestion.options)
    ? previousQuestion.options : [];
  const nextOptions = Array.isArray(nextQuestion && nextQuestion.options)
    ? nextQuestion.options : [];
  const used = new Set();
  const result = [];
  (Array.isArray(selected) ? selected : []).forEach(key => {
    const previous = previousOptions.find(option => option && option.key === key);
    if (!previous) return;
    const fingerprint = optionEditFingerprint(previous);
    let match = nextOptions.find(option => option && !used.has(option.key)
      && optionEditFingerprint(option) === fingerprint);
    if (!match) {
      match = nextOptions.find(option => option && option.key === key && !used.has(option.key));
    }
    if (!match) return;
    used.add(match.key);
    result.push(match.key);
  });
  return result;
}

function normalizeProgressText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[，。；：、“”‘’（）()《》【】\[\]·,.!?！？;:'"`~\-—_]/g, '')
    .toLowerCase();
}

function buildQuestionProgressKey(question) {
  if (!question) return '';
  const type = String(question.type || '');
  const category = normalizeProgressText(question.category || '');
  const text = normalizeProgressText(question.question || '').slice(0, 180);
  return `${type}|${category}|${text}`;
}


function isCompletedResult(question, result) {
  if (!result || typeof result !== 'object') return false;
  if (question && question.type === 'short') return Boolean(result.selfScore);
  return typeof result.correct === 'boolean' && !result.revealed;
}

function getQuestionAnswerStatus(question, result) {
  if (!isCompletedResult(question, result)) return 'unanswered';
  return result.correct ? 'correct' : 'wrong';
}

function getFurthestCompletedOrder(questions, results) {
  const list = Array.isArray(questions) ? questions : [];
  const state = results || {};
  let furthest = 0;
  list.forEach((question, index) => {
    if (!question || !isCompletedResult(question, state[question.id])) return;
    const order = Number(question.order);
    const stableOrder = Number.isFinite(order) && order > 0 ? order : index + 1;
    furthest = Math.max(furthest, stableOrder);
  });
  return furthest;
}

function findResumeIndexAfterCompletion(questions, results, lastCompletedOrder = 0) {
  const list = Array.isArray(questions) ? questions : [];
  if (!list.length) return 0;
  const state = results || {};
  const completedOrder = Math.max(0, Number(lastCompletedOrder) || 0);

  // “继续上次进度”由已经完成的题决定，不受用户最后停留、翻页或查看题目的位置影响。
  // 优先进入最后完成题之后的第一道未答题。
  for (let index = 0; index < list.length; index += 1) {
    const question = list[index];
    const order = Number(question && question.order);
    const stableOrder = Number.isFinite(order) && order > 0 ? order : index + 1;
    if (stableOrder > completedOrder && getQuestionAnswerStatus(question, state[question.id]) === 'unanswered') {
      return index;
    }
  }

  // 若用户通过答题卡跨题作答，最后完成题之后可能没有未答题；此时回到最早未答题。
  const firstUnanswered = list.findIndex(question =>
    getQuestionAnswerStatus(question, state[question && question.id]) === 'unanswered'
  );
  if (firstUnanswered >= 0) return firstUnanswered;

  // 全部题目均已完成时停在最后一题，便于查看结果并点击“完成”。
  return Math.max(0, list.length - 1);
}

function buildPracticeScopeKey(type = 'all', count = 0) {
  return `${String(type || 'all')}|${Math.max(0, Number(count) || 0)}`;
}

function buildMemorizeScopeKey(order = 'sequence', type = 'all', count = 0) {
  return `${order === 'random' ? 'random' : 'sequence'}|${buildPracticeScopeKey(type, count)}`;
}

function getMemorizeProgressCursor(progress, order = 'sequence', type = 'all', count = 0) {
  if (!progress || typeof progress !== 'object') return null;
  const scopeKey = buildMemorizeScopeKey(order, type, count);
  if (progress.cursors && typeof progress.cursors === 'object' && progress.cursors[scopeKey]) {
    return progress.cursors[scopeKey];
  }
  // v1.8.5 及更早版本只保存顺序背题，键名不含顺序类型。
  if (order !== 'random') {
    const legacy = buildPracticeScopeKey(type, count);
    if (progress.cursors && typeof progress.cursors === 'object' && progress.cursors[legacy]) {
      return progress.cursors[legacy];
    }
    const legacyScope = buildPracticeScopeKey(progress.type || 'all', progress.requestedCount || 0);
    if (legacy === legacyScope && progress.cursor) return progress.cursor;
  }
  return null;
}

function getMemorizeQuestionSequence(progress, order = 'random', type = 'all', count = 0) {
  if (!progress || typeof progress !== 'object' || order !== 'random') return [];
  const scopeKey = buildMemorizeScopeKey(order, type, count);
  const sequences = progress.randomSequences && typeof progress.randomSequences === 'object'
    ? progress.randomSequences : {};
  return Array.isArray(sequences[scopeKey]) ? sequences[scopeKey] : [];
}

function buildMemorizeQuestionSequence(questions = []) {
  return (Array.isArray(questions) ? questions : []).map(question => ({
    questionId: question && question.id || '',
    questionKey: buildQuestionProgressKey(question),
    questionOrder: Number.isFinite(Number(question && question.order)) ? Number(question.order) : 0
  }));
}

function reorderQuestionsBySavedSequence(questions = [], sequence = []) {
  const list = Array.isArray(questions) ? questions.slice() : [];
  const saved = Array.isArray(sequence) ? sequence : [];
  if (!saved.length || !list.length) return list;
  const used = new Set();
  const ordered = [];
  const findIndex = state => {
    if (state && state.questionId) {
      const byId = list.findIndex((question, index) => !used.has(index) && question && question.id === state.questionId);
      if (byId >= 0) return byId;
    }
    const wantedKey = state && state.questionKey || '';
    const wantedOrder = Number(state && state.questionOrder) || 0;
    const candidates = [];
    list.forEach((question, index) => {
      if (used.has(index)) return;
      if (wantedKey && buildQuestionProgressKey(question) === wantedKey) candidates.push(index);
    });
    if (candidates.length) {
      return candidates.slice().sort((left, right) => {
        const lo = Number(list[left] && list[left].order) || left + 1;
        const ro = Number(list[right] && list[right].order) || right + 1;
        return Math.abs(lo - wantedOrder) - Math.abs(ro - wantedOrder) || lo - ro;
      })[0];
    }
    if (wantedOrder > 0) {
      const byOrder = list.findIndex((question, index) => !used.has(index) && Number(question && question.order) === wantedOrder);
      if (byOrder >= 0) return byOrder;
    }
    return -1;
  };
  saved.forEach(state => {
    const index = findIndex(state);
    if (index < 0) return;
    used.add(index);
    ordered.push(list[index]);
  });
  // 题库后来新增或替换的题，随机追加到原随机序列末尾；既保留旧顺序，也不会漏题。
  const remaining = list.filter((question, index) => !used.has(index));
  return ordered.concat(shuffle(remaining));
}

function getProgressCursor(progress, type = 'all', count = 0) {
  if (!progress || typeof progress !== 'object') return null;
  const scopeKey = buildPracticeScopeKey(type, count);
  if (progress.cursors && typeof progress.cursors === 'object') {
    return progress.cursors[scopeKey] || null;
  }
  const legacyScope = buildPracticeScopeKey(progress.type || 'all', progress.requestedCount || 0);
  if (scopeKey !== legacyScope) return null;
  return {
    lastCompletedOrder: Number(progress.lastCompletedOrder || 0),
    questionId: progress.questionId || '',
    questionKey: progress.questionKey || '',
    questionOrder: Number(progress.questionOrder || 0),
    index: Number(progress.index || 0),
    completedAll: Boolean(progress.completedAll)
  };
}

function buildPersistedQuestionStates(session) {
  if (!session || !Array.isArray(session.questions)) return [];
  const answers = session.answers || {};
  const results = session.results || {};
  return session.questions.reduce((states, question) => {
    if (!question || !question.id) return states;
    const selected = Array.isArray(answers[question.id]) ? answers[question.id].slice() : [];
    const result = results[question.id] && typeof results[question.id] === 'object'
      ? { ...results[question.id] }
      : null;
    // 只保存有选择或已经显示/提交结果的题，避免 1000 多道空状态占用空间。
    if (!selected.length && !result) return states;
    const selectedSet = new Set(selected);
    const selectedTexts = (question.options || [])
      .filter(option => selectedSet.has(option.key))
      .map(option => String(option.text || ''));
    states.push({
      questionId: question.id,
      questionKey: buildQuestionProgressKey(question),
      questionOrder: Number.isFinite(Number(question.order)) ? Number(question.order) : 0,
      selected,
      selectedTexts,
      result
    });
    return states;
  }, []);
}

function mergePersistedQuestionStates(previousStates, currentStates, sessionQuestions) {
  const previous = Array.isArray(previousStates) ? previousStates : [];
  const current = Array.isArray(currentStates) ? currentStates : [];
  const questions = Array.isArray(sessionQuestions) ? sessionQuestions : [];
  const coveredIds = new Set(questions.map(question => question && question.id).filter(Boolean));
  const coveredKeys = new Set(questions.map(question => {
    if (!question) return '';
    return `${buildQuestionProgressKey(question)}|${Number(question.order) || 0}`;
  }).filter(Boolean));

  // 当前筛选/数量范围内的题以本次会话状态为准；范围外的历史状态继续保留。
  // 这样先练“全部题型”，再只练“多选题”时，不会把其他题型已保存答案清空。
  const preserved = previous.filter(state => {
    if (!state) return false;
    if (state.questionId && coveredIds.has(state.questionId)) return false;
    const key = `${state.questionKey || ''}|${Number(state.questionOrder) || 0}`;
    return !coveredKeys.has(key);
  });
  return preserved.concat(current);
}

function findQuestionIndexForState(questions, state) {
  if (!state || !Array.isArray(questions) || !questions.length) return -1;
  if (state.questionId) {
    const byId = questions.findIndex(question => question && question.id === state.questionId);
    if (byId >= 0) return byId;
  }
  const wantedOrder = Number(state.questionOrder);
  const hasOrder = Number.isFinite(wantedOrder) && wantedOrder > 0;
  if (state.questionKey) {
    const candidates = [];
    questions.forEach((question, index) => {
      if (buildQuestionProgressKey(question) === state.questionKey) candidates.push(index);
    });
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      if (!hasOrder) return candidates[0];
      return candidates.slice().sort((left, right) => {
        const leftOrder = Number(questions[left] && questions[left].order) || left + 1;
        const rightOrder = Number(questions[right] && questions[right].order) || right + 1;
        return Math.abs(leftOrder - wantedOrder) - Math.abs(rightOrder - wantedOrder)
          || leftOrder - rightOrder;
      })[0];
    }
  }
  // 已作答状态不能只凭顺序号套到新题上。覆盖导入后若题干发生变化，
  // 宁可不恢复旧答案，也不能把上一版第 N 题的答案误标到新版第 N 题。
  return -1;
}

function restoreQuestionStates(questions, persistedStates) {
  const answers = {};
  const results = {};
  if (!Array.isArray(questions) || !Array.isArray(persistedStates)) return { answers, results };

  persistedStates.forEach(state => {
    const index = findQuestionIndexForState(questions, state);
    if (index < 0) return;
    const question = questions[index];
    const optionKeys = new Set((question.options || []).map(option => option.key));
    let selected = Array.isArray(state.selected)
      ? state.selected.filter(key => optionKeys.has(key))
      : [];

    // 开启“选项乱序”时重新进入练习，字母可能变化；按选项正文恢复到新字母。
    if (Array.isArray(state.selectedTexts) && state.selectedTexts.length) {
      const wantedTexts = state.selectedTexts.map(normalizeProgressText);
      const restored = [];
      wantedTexts.forEach(text => {
        const option = (question.options || []).find(item => normalizeProgressText(item.text) === text);
        if (option && !restored.includes(option.key)) restored.push(option.key);
      });
      if (restored.length) selected = restored;
    }

    if (selected.length) answers[question.id] = selected;
    if (state.result && typeof state.result === 'object') {
      if (question.type === 'short') {
        results[question.id] = { ...state.result };
      } else if (selected.length) {
        // 题库覆盖导入或选项乱序后，以当前题目的正确答案重新核算结果，
        // 避免旧版答案变更后仍显示过期的“正确/错误”。
        results[question.id] = {
          ...state.result,
          correct: sameAnswer(question.answer || [], selected)
        };
      }
    }
  });
  return { answers, results };
}

function findResumeIndex(questions, config = {}) {
  if (!Array.isArray(questions) || !questions.length) return 0;

  // 同一次导入中 ID 最精确，优先使用。
  if (config.resumeQuestionId) {
    const byId = questions.findIndex(item => item.id === config.resumeQuestionId);
    if (byId >= 0) return byId;
  }

  const wantedOrder = Number(config.resumeQuestionOrder);
  const hasWantedOrder = Number.isFinite(wantedOrder) && wantedOrder > 0;

  // 覆盖导入后 ID 会变化，此时使用题型+分类+题干生成的稳定键。
  // 相同题干可能重复出现，不能简单 findIndex 取第一条；应选择与原顺序号最近的一条，
  // 避免“做到第 8 题却恢复到第 6 题”。
  if (config.resumeQuestionKey) {
    const candidates = [];
    questions.forEach((item, index) => {
      if (buildQuestionProgressKey(item) === config.resumeQuestionKey) candidates.push(index);
    });
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      if (hasWantedOrder) {
        return candidates.slice().sort((left, right) => {
          const leftOrder = Number(questions[left] && questions[left].order) || left + 1;
          const rightOrder = Number(questions[right] && questions[right].order) || right + 1;
          return Math.abs(leftOrder - wantedOrder) - Math.abs(rightOrder - wantedOrder)
            || leftOrder - rightOrder;
        })[0];
      }
      return candidates[0];
    }
  }

  // 内容被编辑或分类变化时，按 Word 原始顺序号恢复；若该题被筛掉或已掌握，
  // 从它后面的第一道可练习题继续，不向前倒退。
  if (hasWantedOrder) {
    const exact = questions.findIndex(item => Number(item && item.order) === wantedOrder);
    if (exact >= 0) return exact;
    const following = questions.findIndex(item => Number(item && item.order) > wantedOrder);
    if (following >= 0) return following;
    return Math.max(0, questions.length - 1);
  }

  // 最后才使用会受筛选影响的列表下标，并且只允许合法范围。
  const wantedIndex = Number(config.resumeQuestionIndex);
  if (Number.isInteger(wantedIndex) && wantedIndex >= 0 && wantedIndex < questions.length) return wantedIndex;

  return 0;
}

const OPTION_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function hasOrderDependentOption(question) {
  return (question.options || []).some(item =>
    /(?:以上|以下|上述|前述|全部|均为|均是|都为|都是|全选|都正确|都错误|均正确|均错误)/.test(String(item && item.text || ''))
  );
}

function restoreQuestionOptionOrder(question) {
  if (!question || !question.optionOrderOriginal) return question;
  const original = question.optionOrderOriginal || {};
  const restored = {
    ...question,
    options: (original.options || []).map(item => ({ ...item })),
    answer: (original.answer || []).slice()
  };
  delete restored.optionOrderOriginal;
  delete restored.optionOrderShuffled;
  return restored;
}

function shuffleQuestionOptions(question) {
  const canonical = restoreQuestionOptionOrder(question);
  if (!canonical || canonical.type === 'short' || !Array.isArray(canonical.options) || canonical.options.length < 2) {
    return canonical;
  }
  // “以上都是/以下均不正确”等内容依赖当前位置，强行打乱会改变题意，因此智能跳过。
  if (hasOrderDependentOption(canonical)) return canonical;

  const originalOptions = canonical.options.map(item => ({ ...item }));
  const originalAnswer = (canonical.answer || []).slice();
  const shuffled = shuffle(originalOptions.map(item => ({ ...item })));
  const keyMap = {};
  const options = shuffled.map((item, index) => {
    const newKey = OPTION_KEYS[index] || item.key;
    keyMap[item.key] = newKey;
    return { ...item, key: newKey };
  });
  const answer = originalAnswer
    .map(key => keyMap[key] || key)
    .filter(Boolean)
    .sort((a, b) => OPTION_KEYS.indexOf(a) - OPTION_KEYS.indexOf(b));
  return {
    ...canonical,
    options,
    answer,
    optionOrderShuffled: true,
    optionOrderOriginal: { options: originalOptions, answer: originalAnswer }
  };
}

function applyOptionOrderPreference(questions, enabled, answers = {}, results = {}) {
  return (questions || []).map(question => {
    if (!question) return question;
    const selected = Array.isArray(answers[question.id]) ? answers[question.id] : [];
    const alreadyTouched = selected.length > 0 || isCompletedResult(question, results[question.id]);
    if (alreadyTouched) return question;
    const canonical = restoreQuestionOptionOrder(question);
    return enabled ? shuffleQuestionOptions(canonical) : canonical;
  });
}

function createSession(config) {
  let questions = bankStorage.loadQuestions(config.bankId);
  // 始终以 Word 导入时的 order 为主序；题型、错题、收藏和已掌握过滤只删除题目，
  // 不改变剩余题目的相对顺序。只有“随机练习/模拟考试”会主动打乱。
  questions = questions.map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const lo = Number(left.item && left.item.order);
      const ro = Number(right.item && right.item.order);
      const lv = Number.isFinite(lo) && lo > 0 ? lo : left.index + 1;
      const rv = Number.isFinite(ro) && ro > 0 ? ro : right.index + 1;
      return lv === rv ? left.index - right.index : lv - rv;
    })
    .map(entry => entry.item);
  const masteredIds = new Set(recordStorage.getMasteredIds(config.bankId));

  if (config.mode !== 'exam' && config.mode !== 'search') {
    questions = questions.filter(item => !masteredIds.has(item.id));
  }
  // “全部题型”同时包含正常题与异常题；异常状态只改变答题页标识，不再从全部练习中排除。
  questions = questions.filter(item => !item.sourceMissingPlaceholder && !item.nonPractice);
  if (config.type === 'abnormal') {
    questions = questions.filter(item => (item.status || 'normal') !== 'normal');
  } else if (config.type && config.type !== 'all') {
    if (String(config.type).startsWith('display:')) {
      const wantedLabel = String(config.type).slice('display:'.length);
      questions = questions.filter(item => {
        if ((item.status || 'normal') !== 'normal') return false;
        const label = String(item.displayTypeLabel || QUESTION_TYPES[item.type] || item.type || '未知题型');
        return label === wantedLabel;
      });
    } else {
      // 兼容旧进度和旧版配置中保存的核心题型值。异常题仍只进入“异常题”或“全部题型”。
      questions = questions.filter(item => (item.status || 'normal') === 'normal' && item.type === config.type);
    }
  }

  if (config.mode === 'wrong') {
    const wrong = recordStorage.getWrong(config.bankId);
    questions = questions.filter(item => wrong[item.id] && !wrong[item.id].mastered);
  } else if (config.mode === 'favorites') {
    const ids = recordStorage.getFavoriteIds(config.bankId);
    questions = questions.filter(item => ids.includes(item.id));
  }

  if (config.mode === 'memorize' && config.memorizeOrder === 'random'
    && Array.isArray(config.resumeQuestionSequence) && config.resumeQuestionSequence.length) {
    questions = reorderQuestionsBySavedSequence(questions, config.resumeQuestionSequence);
  } else if (config.mode === 'random' || config.mode === 'exam'
    || (config.mode === 'wrong' && config.wrongOrder === 'random')
    || (config.mode === 'memorize' && config.memorizeOrder === 'random')) {
    questions = shuffle(questions);
  }

  const settings = recordStorage.getSettings();
  const shuffleOptionsEnabled = config.shuffleOptions === undefined
    ? Boolean(settings.shuffleOptions)
    : Boolean(config.shuffleOptions);
  // 背题模式直接展示答案，保持原选项顺序更利于形成稳定记忆；随机背题只打乱题目，不打乱选项。
  if (shuffleOptionsEnabled && config.mode !== 'memorize') questions = questions.map(shuffleQuestionOptions);

  // 先在完整筛选结果中恢复作答状态，再根据“最后完成题”计算下一题。
  // 这样用户即使退出时停在前面的题，也不会覆盖真实完成进度。
  let restoredState = config.mode === 'sequence'
    ? restoreQuestionStates(questions, config.resumeQuestionStates || [])
    : { answers: {}, results: {} };
  const resumeCursor = config.resumeCursor && typeof config.resumeCursor === 'object'
    ? config.resumeCursor
    : {};
  let lastCompletedOrder = Math.max(
    Number(resumeCursor.lastCompletedOrder || 0),
    getFurthestCompletedOrder(questions, restoredState.results)
  );
  let initialIndex = config.mode === 'sequence'
    ? findResumeIndexAfterCompletion(questions, restoredState.results, lastCompletedOrder)
    : 0;
  if (config.mode === 'memorize' && config.resumeCursor) {
    initialIndex = findResumeIndex(questions, {
      resumeQuestionId: resumeCursor.questionId,
      resumeQuestionKey: resumeCursor.questionKey,
      resumeQuestionOrder: resumeCursor.questionOrder,
      resumeQuestionIndex: resumeCursor.index
    });
  }

  if (config.count && config.count > 0) {
    const limit = Number(config.count);
    if (config.mode === 'sequence' && initialIndex >= limit) {
      // 前一批指定数量题目已经完成时，从下一题开始新的连续批次。
      questions = questions.slice(initialIndex, initialIndex + limit);
      initialIndex = 0;
    } else if (config.mode === 'memorize' && config.memorizeOrder !== 'random' && config.resumeCursor) {
      // 顺序背题继续时，以保存位置作为本批起点；随机背题保留整段随机序列和当前位置。
      questions = questions.slice(initialIndex, initialIndex + limit);
      initialIndex = 0;
    } else {
      questions = questions.slice(0, limit);
      initialIndex = Math.min(initialIndex, Math.max(0, questions.length - 1));
    }
    restoredState = config.mode === 'sequence'
      ? restoreQuestionStates(questions, config.resumeQuestionStates || [])
      : { answers: {}, results: {} };
    lastCompletedOrder = Math.max(
      Number(resumeCursor.lastCompletedOrder || 0),
      getFurthestCompletedOrder(questions, restoredState.results)
    );
    if (config.mode === 'sequence') {
      initialIndex = findResumeIndexAfterCompletion(questions, restoredState.results, lastCompletedOrder);
    }
  }

  return {
    bankId: config.bankId,
    bankName: config.bankName || '',
    mode: config.mode || 'sequence',
    questions,
    index: initialIndex,
    answers: restoredState.answers,
    results: restoredState.results,
    lastCompletedOrder,
    startedAt: Date.now(),
    exam: config.mode === 'exam',
    memorize: config.mode === 'memorize',
    memorizeOrder: config.memorizeOrder || 'sequence',
    optionShuffleEnabled: Boolean(shuffleOptionsEnabled && config.mode !== 'memorize'),
    durationMinutes: config.durationMinutes || 0,
    practiceType: config.type || 'all',
    requestedCount: Number(config.count || 0),
    progressScopeKey: buildPracticeScopeKey(config.type || 'all', config.count || 0),
    memorizeScopeKey: buildMemorizeScopeKey(config.memorizeOrder || 'sequence', config.type || 'all', config.count || 0)
  };
}

function judgeQuestion(question, selected, selfScore = '') {
  if (question.type === 'short') {
    return {
      correct: selfScore === 'mastered',
      selfScore
    };
  }
  return {
    correct: sameAnswer(question.answer || [], selected || [])
  };
}

module.exports = {
  shuffle,
  sameAnswer,
  buildQuestionEditSignature,
  remapSelectedOptions,
  buildQuestionProgressKey,
  isCompletedResult,
  getQuestionAnswerStatus,
  getFurthestCompletedOrder,
  findResumeIndexAfterCompletion,
  buildPracticeScopeKey,
  buildMemorizeScopeKey,
  getMemorizeProgressCursor,
  getMemorizeQuestionSequence,
  buildMemorizeQuestionSequence,
  reorderQuestionsBySavedSequence,
  getProgressCursor,
  buildPersistedQuestionStates,
  mergePersistedQuestionStates,
  restoreQuestionStates,
  findResumeIndex,
  hasOrderDependentOption,
  shuffleQuestionOptions,
  restoreQuestionOptionOrder,
  applyOptionOrderPreference,
  createSession,
  judgeQuestion
};
});
__define("services/local-ai-model.js", function(require, module, exports){
// 本地 AI 只辅助“无标签段落是否属于上一道简答题答案”的边界判断。
// 题型、答案字母、判断题补全和选项结构全部由确定性规则最终决定。
let MODEL = typeof window !== 'undefined' ? window.__QUESTION_AI_MODEL__ : null;
const MODEL_VERSION = MODEL && MODEL.version ? MODEL.version : '按需加载';
let modelLoadingPromise = null;
function refreshModel(){ if(!MODEL && typeof window !== 'undefined' && window.__QUESTION_AI_MODEL__) MODEL=window.__QUESTION_AI_MODEL__; return MODEL; }
function loadModel(){
  refreshModel();
  if(MODEL)return Promise.resolve(MODEL);
  if(modelLoadingPromise)return modelLoadingPromise;
  modelLoadingPromise=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src='question-ai-model.js';script.async=true;
    script.onload=()=>{refreshModel();MODEL?resolve(MODEL):reject(new Error('模型脚本已加载但数据不存在'));};
    script.onerror=()=>reject(new Error('本地模型资源加载失败'));document.head.appendChild(script);
  }).finally(()=>{modelLoadingPromise=null;});
  return modelLoadingPromise;
}
const FULL_FROM='ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ１２３４５６７８９０（）．：，；？【】';
const FULL_TO='abcdefghijklmnopqrstuvwxyz1234567890().:,;?[]';
const FULL_MAP={};for(let i=0;i<FULL_FROM.length;i+=1)FULL_MAP[FULL_FROM[i]]=FULL_TO[i];
const REGEX_FEATURES=[
 ['qmark',/[?？]/],['blank',/[（(]\s*[）)]/],['option',/(?:^|\s)(?:[（(]?[A-L][）).、．:：])/i],
 ['ans',/(?:答案|参考答案|正确答案|标准答案|答)\s*[:：]/],['analysis',/(?:解析|说明|分析)\s*[:：]/],
 ['judge',/判断|对错|正确或错误|是否正确|答案\s*[:：]?\s*(?:正确|错误|对|错)/],
 ['multi',/哪些|哪几项|多项|可多选|包括|正确的有|错误的有|答案\s*[:：]?\s*[A-L][,，、A-L]+/i],
 ['short',/简述|为什么|如何|有哪些原因|写出|列出|说明|有何|是什么|作用有哪些|含义是什么|原理是什么|应符合哪些规定/],
 ['heading',/^\s*#|第.{0,8}章|标准格式|图片多选题|目录/],
 ['truth',/^(?:答案\s*[:：]?\s*)?(?:正确|错误|对|错|a\s*[（(]\s*正确)/i],
 ['numbered',/^\s*[1-9]\d*\s*[.、．)）]/]
];
function normalize(text=''){
  return String(text||'').toLowerCase().replace(/[Ａ-Ｚ０-９（）．：，；？【】]/g,ch=>FULL_MAP[ch]||ch).replace(/\s+/g,' ').trim();
}
function fnv1a(text){let h=2166136261>>>0;for(let i=0;i<text.length;i+=1){h^=text.charCodeAt(i);h=Math.imul(h,16777619)>>>0;}return h>>>0;}
function featureIds(text='',task='relation'){
  refreshModel();if(!MODEL)return[0];const bucket=MODEL.bucket||65536,max=MODEL.maxFeatures||384,t=normalize(text),set=new Set();
  const add=token=>set.add(fnv1a(token)%bucket);add('__task__:'+task);const padded='^'+t+'$';
  for(let n=1;n<=5;n+=1)for(let i=0;i<=padded.length-n;i+=1)add(`c${n}:${padded.slice(i,i+n)}`);
  const segs=t.split(/[\s,，。；;：:、（）()【】\[\]？！?]+/).filter(Boolean);
  segs.slice(0,64).forEach(x=>add('w:'+x.slice(0,16)));
  for(let i=0;i<Math.min(segs.length-1,32);i+=1)add('wb:'+segs[i].slice(-8)+'|'+segs[i+1].slice(0,8));
  REGEX_FEATURES.forEach(([name,re])=>{if(re.test(t))add('r:'+name);});add('len:'+Math.min(31,Math.floor(t.length/8)));
  return Array.from(set).sort((a,b)=>a-b).slice(0,max);
}
function decodeBase64Int8(value=''){const binary=atob(value),buf=new ArrayBuffer(binary.length),u=new Uint8Array(buf);for(let i=0;i<binary.length;i+=1)u[i]=binary.charCodeAt(i)&255;return new Int8Array(buf);}
function ensureDecoded(){
  refreshModel();if(!MODEL)throw new Error('模型资源不存在');if(MODEL.__decoded)return MODEL.__decoded;
  const decoded={embedding:decodeBase64Int8(MODEL.embeddingBase64),tasks:{}};
  Object.keys(MODEL.tasks||{}).forEach(task=>{const part=MODEL.tasks[task];decoded.tasks[task]={weights:decodeBase64Int8(part.weightsBase64)};});
  MODEL.__decoded=decoded;return decoded;
}
function predict(task,text=''){
  refreshModel();if(!MODEL||!MODEL.tasks||!MODEL.tasks[task])return{label:'',confidence:0,probabilities:{}};
  const decoded=ensureDecoded(),ids=featureIds(text,task),dim=MODEL.dim||32,scales=MODEL.embeddingScales||[],vec=new Float64Array(dim),emb=decoded.embedding;
  for(const id of ids){const off=id*dim;for(let d=0;d<dim;d+=1)vec[d]+=emb[off+d]*(Number(scales[d])||1);}
  const inv=1/Math.max(1,ids.length);for(let d=0;d<dim;d+=1)vec[d]*=inv;
  const part=MODEL.tasks[task],w=decoded.tasks[task].weights,logits=part.bias.map(Number);
  for(let c=0;c<part.classes.length;c+=1){let z=Number(logits[c])||0,off=c*dim,scale=Number(part.scales[c])||1;for(let d=0;d<dim;d+=1)z+=w[off+d]*scale*vec[d];logits[c]=z;}
  const mx=Math.max.apply(null,logits),ex=logits.map(v=>Math.exp(v-mx)),sum=ex.reduce((a,b)=>a+b,0)||1,probabilities={};let best=0;
  ex.forEach((v,i)=>{probabilities[part.classes[i]]=v/sum;if(v>ex[best])best=i;});
  return{label:part.classes[best],confidence:ex[best]/sum,probabilities};
}
function strongShortCue(text=''){
  const clean=String(text||'').replace(/\s+/g,'');
  return /(?:简述|写出|列出|说明|为什么|如何|有哪些原因|有何|是什么|有哪些|作用|原理|含义|区别|关系|步骤|措施|方法|注意事项|应符合哪些规定|应做好哪些工作)/.test(clean)&&!/[（(]\s*[）)]/.test(clean);
}
function classifyAnswerBoundary(questionText='',candidate='',context={}){
  refreshModel();if(!MODEL||!questionText||!candidate||context.hasOptions)return{isAnswer:false,confidence:0,reason:''};
  const strong=context.typeHint==='short'||strongShortCue(questionText);if(!strong)return{isAnswer:false,confidence:0,reason:''};
  // 明确题号+问句、选择题空格或选项行永远不交给模型吞并。
  if(/^\s*\d{1,5}\s*[.、．:：)）]/.test(candidate)&&/[？?]|[（(]\s*[）)]/.test(candidate))return{isAnswer:false,confidence:1,reason:'明确新题'};
  if(/^\s*[A-L]\s*[.、．:：)）]/i.test(candidate))return{isAnswer:false,confidence:1,reason:'明确选项'};
  const rel=predict('relation',`Q=${questionText} [SEP] C=${candidate} __TYPE_SHORT__`),role=predict('role',candidate);
  const isAnswer=rel.label==='answer'&&rel.confidence>=.90&&!['question','heading','option'].includes(role.label);
  return{isAnswer,confidence:Math.min(.97,.65*rel.confidence+.35*role.confidence),reason:`本地边界模型：关系${rel.label} ${(rel.confidence*100).toFixed(0)}%，段落${role.label} ${(role.confidence*100).toFixed(0)}%`};
}
function assistQuestion(question){
  const item=Object.assign({},question||{});
  item.options=Array.isArray(item.options)?item.options.map(x=>Object.assign({},x)):[];
  item.answer=Array.isArray(item.answer)?item.answer.slice():[];
  const used=/^本地AI辅助/.test(String(item.answerBoundarySource||''));
  item.aiAssistApplied=used;
  item.aiAssistReason=used?'仅辅助无标签简答答案边界；题型与答案由规则锁定':'';
  item.aiModelVersion=MODEL_VERSION;
  return item;
}
function selfTest(){
  try{
    ensureDecoded();
    const tests=[
      ['role','# 仪表多选题（标准格式）','heading'],
      ['relation','Q=特级动火作业应符合哪些规定？ [SEP] C=4. 在设备或管道上进行特级动火作业时，设备或管道内应保持微正压。 __TYPE_SHORT__','answer'],
      ['relation','Q=气动调节阀的辅助装置各起什么作用？ [SEP] C=3) 手轮机构：系统故障时，可切换进行手动操作。 __TYPE_SHORT__','answer']
    ];
    const details=tests.map(([task,text,expect])=>{const p=predict(task,text);return{task,expect,actual:p.label,confidence:p.confidence,ok:p.label===expect};});
    return{ok:details.every(x=>x.ok),version:MODEL_VERSION,message:details.every(x=>x.ok)?'本地边界模型已加载，3 项真实推理自检通过':'模型推理结果未通过自检',details};
  }catch(error){return{ok:false,version:MODEL_VERSION,message:error.message||String(error)};}
}
async function selfTestAsync(){await loadModel();return selfTest();}
module.exports={MODEL_VERSION,isAvailable:()=>Boolean(refreshModel()),loadModel,predict,classifyAnswerBoundary,assistQuestion,selfTest,selfTestAsync};
});
__define("services/question-parser.js", function(require, module, exports){
const { createId } = require('../utils/id');
const {
  normalizeText,
  normalizeOneLine,
  cleanQuestionText,
  cleanAnswerText,
  cleanAnalysisText,
  compactText,
  unique,
  isListStart,
  repairKnownEngineeringNotation,
  hasEncodingAnomaly
} = require('../utils/text');
const { validateQuestion, repairOptionDuplicates, repairKnownConvertedDocxOptions } = require('./question-validator');
const localAI = require('./local-ai-model');

const TYPE_LABEL = '(不定项选择题|不定项题|不定项|单选题|单项选择题|单选|多选题|多项选择题|多选|选择题|判断题|判断|简答题|问答题|实操题|论述题|填空题|计算题|画图题|绘图题|作图题|匹配题|配对题|排序题|顺序题|材料题|案例题)';
const COUNT_RE = new RegExp(`^\\s*[,，]?\\s*(\\d+)\\s*\\/\\s*\\d+\\s*(?:[\\[【]\\s*)?${TYPE_LABEL}(?:\\s*[\\]】])?\\s*(.*)$`);
const GENERIC_COUNT_RE = /^\s*[,，]?\s*(\d+)\s*\/\s*\d+\s*[\[【]?\s*题\s*[\]】]?\s*(.*)$/;
// 兼容“14 题”“4[题]”“15题（判断）……”等 PDF 转 Word 后常见的题号格式。
// v1.5.8 未覆盖这类边界，可能把整道题并入前后题，造成题目数量少于原文。
const BARE_NUMBERED_QUESTION_RE = /^\s*(\d{1,4})\s*(?:[\[【]\s*)?题\s*(?:[\]】])?\s*(?:[.、．:：)）-]\s*)?(.*)$/;
// 兼容 Word 中斜杠被异常转换为数字 1 和空格的情况，例如：171 39[单选题] ≈ 17/39[单选题]。
const BROKEN_COUNT_RE = new RegExp(`^\\s*[,，]?\\s*(\\d{1,4})\\s+(\\d{1,4})\\s*(?:[\\[【]\\s*)?${TYPE_LABEL}(?:\\s*[\\]】])?\\s*(.*)$`);
// PDF 转换偶尔把 17/39 破坏成 17139（斜杠被映射成数字 1 且空格丢失）。
// 只在 PDF 路径下按“题号 + 1 + 总题数 + 题型”恢复，避免影响普通五位题号。
const COMPACT_BROKEN_COUNT_RE = new RegExp(`^\\s*[,，]?\\s*(\\d{1,4})1(\\d{1,4})\\s*(?:[\\[【]\\s*)?${TYPE_LABEL}(?:\\s*[\\]】])?\\s*(.*)$`);
const NUMBERED_TYPE_RE = new RegExp(`^\\s*[,，]?\\s*(\\d+)\\s*(?:[\\[【]\\s*)?${TYPE_LABEL}(?:\\s*[\\]】])?\\s*(.*)$`);
const BRACKET_TYPE_RE = new RegExp(`^\\s*[（(\\[【]\\s*${TYPE_LABEL}\\s*[）)\\]】]\\s*(.*)$`);
const TYPED_RE = new RegExp(`^\\s*${TYPE_LABEL}\\s*[:：]\\s*(.*)$`);
const QUESTION_RES = [
  /^\s*(?:Q|题)\s*(\d{1,5})\s*[.、．:：)）-]\s*(.*)$/i,
  /^\s*第\s*(\d{1,5})\s*题\s*[.、．:：)）-]?\s*(.*)$/,
  /^\s*(\d{1,5})(?:\s*\/\s*\d+)?\s*[.、．:：)）]\s*(.*)$/
];
const NO_PUNCT_NUMBER_RE = /^\s*(\d{1,4})\s*([\u4e00-\u9fff].{4,})$/;
const OPTION_LINE_RE = /^\s*(?:[（(【\[]\s*)?([A-L])\s*(?:[）)】\]]\s*|[.、．:：)）]\s*)(.*)$/i;
const LOOSE_OPTION_LINE_RE = /^\s*([A-L])\s{1,3}([^A-L].{1,})$/i;
const DIRECT_OPTION_LINE_RE = /^\s*([A-L])([^A-L\s].{0,})$/i;
const BARE_ANSWER_RE = /^\s*(?:答案\s*[:：]?\s*)?(?:[（(【\[]\s*)?(?:[A-L](?:(?:\s*[,，、/\\|\s]\s*|(?=[A-L]))[A-L])*|√|✓|✔|☑|×|✕|✖|☒|❌|对|错|正确|错误|是|否)(?:\s*[）)】\]])?\s*[,，。；;]?\s*$/i;

function typeMetaFromLabel(label = '') {
  const clean = normalizeOneLine(label);
  if (/不定项/.test(clean)) return { type: 'multiple', label: '不定项选择题' };
  if (/多选|多项/.test(clean)) return { type: 'multiple', label: '多选题' };
  if (/判断|对错/.test(clean)) return { type: 'judge', label: '判断题' };
  if (/匹配|配对/.test(clean)) return { type: 'short', label: '匹配题' };
  if (/排序|顺序题/.test(clean)) return { type: 'short', label: '排序题' };
  if (/材料|案例/.test(clean)) return { type: 'short', label: clean.includes('案例') ? '案例题' : '材料题' };
  if (/填空/.test(clean)) return { type: 'short', label: '填空题' };
  if (/计算/.test(clean)) return { type: 'short', label: '计算题' };
  if (/画图|绘图|作图/.test(clean)) return { type: 'short', label: '画图题' };
  if (/实操/.test(clean)) return { type: 'short', label: '实操题' };
  if (/论述/.test(clean)) return { type: 'short', label: '论述题' };
  if (/问答/.test(clean)) return { type: 'short', label: '问答题' };
  if (/简答/.test(clean)) return { type: 'short', label: '简答题' };
  return { type: 'single', label: '单选题' };
}

function typeFromLabel(label = '') {
  return typeMetaFromLabel(label).type;
}

function displayTypeFromLabel(label = '') {
  return typeMetaFromLabel(label).label;
}

function peelLeadingType(content = '', fallbackType = '', fallbackDisplayTypeLabel = '') {
  const clean = normalizeOneLine(content);
  const match = new RegExp(`^\\s*[（(\\[【]?\\s*${TYPE_LABEL}\\s*[）)\\]】]?\\s*[:：-]?\\s*(.*)$`).exec(clean);
  if (!match) return { typeHint: fallbackType, displayTypeLabel: fallbackDisplayTypeLabel, content: clean };
  const meta = typeMetaFromLabel(match[1]);
  return { typeHint: meta.type, displayTypeLabel: meta.label, content: match[2] };
}

function descriptiveTypeHeading(text = '') {
  let clean = normalizeOneLine(text).replace(/^#{1,6}\s*/, '');
  clean = clean.replace(/^(?:[一二三四五六七八九十]+[、.．]|[（(][一二三四五六七八九十]+[）)])\s*/, '');
  const combinedShort = /^(?:简答题|问答题)\s*(?:[/／、和及]|\s)+\s*(?:简答题|问答题)(?:\s*[（(].*[）)])?$/.test(clean);
  if (combinedShort) return { type: 'short', label: '简答题' };
  const match = /^(填空题|选择题|不定项选择题|不定项题|单选题|单项选择题|多选题|多项选择题|判断题|简答题|问答题|实操题|论述题|计算题|画图题|绘图题|作图题|匹配题|配对题|排序题|顺序题|材料题|案例题)(?:\s*[（(].*[）)])?$/.exec(clean);
  if (!match) return null;
  if (match[1] === '选择题') {
    return /多选|多项/.test(clean) ? { type: 'multiple', label: '多选题' } : { type: 'single', label: '单选题' };
  }
  return typeMetaFromLabel(match[1]);
}

function declaredTypeSection(text = '') {
  const clean = normalizeOneLine(text);
  const meta = descriptiveTypeHeading(clean);
  if (!meta) return null;
  const countMatch = /共\s*(\d+)\s*(题|空)/.exec(clean);
  const count = countMatch ? Number(countMatch[1]) : 0;
  if (countMatch && (!Number.isInteger(count) || count < 1 || count > 5000)) return null;
  // 仅对“单选题（共 10 题）”这类纯计数标题启用缺题占位补齐。
  // “选择题（共 29 题，单选，含答案）”等整理说明标题通常夹杂自动编号、子列表，
  // 直接按编号补齐会误判，因此只作为题型章节识别，不强制补占位题。
  const simpleHeadingText = clean.replace(/^(?:[一二三四五六七八九十]+[、.．]\s*)/, '');
  const simpleCountHeading = /^(?:填空题|选择题|不定项选择题|不定项题|单选题|单项选择题|多选题|多项选择题|判断题|简答题|问答题|实操题|论述题|计算题|画图题|绘图题|作图题|匹配题|配对题|排序题|顺序题|材料题|案例题)\s*[（(]\s*共\s*\d+\s*题\s*[）)]$/.test(simpleHeadingText);
  const expectedCount = countMatch && countMatch[2] === '题' && simpleCountHeading ? count : 0;
  return { typeHint: meta.type, displayTypeLabel: meta.label, expectedCount, heading: clean };
}

function exactTypeHeading(text = '') {
  let clean = normalizeOneLine(text).replace(/^#{1,6}\s*/, '');
  clean = clean.replace(/^(?:[一二三四五六七八九十]+[、.．]|[（(][一二三四五六七八九十]+[）)])\s*/, '');
  const match = new RegExp(`^(?:图片)?\\s*[（(\\[【]?\\s*${TYPE_LABEL}\\s*[）)\\]】]?\\s*(?:[（(](?:标准格式|示例|模板|共\\s*\\d+\\s*题)[）)])?$`).exec(clean);
  if (!match) return null;
  return typeMetaFromLabel(match[1]);
}

function classifyHeader(text, style = '') {
  const clean = normalizeOneLine(text);
  if (!clean) return null;
  const exactType = exactTypeHeading(clean);
  if (exactType) return { kind: 'type', value: exactType.type, label: exactType.label };
  const descriptiveType = descriptiveTypeHeading(clean);
  if (descriptiveType) return { kind: 'type', value: descriptiveType.type, label: descriptiveType.label };
  const markdownHeading = /^#{1,6}\s*(.+)$/.exec(clean);
  if (markdownHeading) {
    const heading = markdownHeading[1].trim();
    if (/单选题|单项选择题/.test(heading)) return { kind: 'type', value: 'single', label: '单选题' };
    if (/多选题|多项选择题/.test(heading)) return { kind: 'type', value: 'multiple', label: '多选题' };
    if (/判断题|对错题/.test(heading)) return { kind: 'type', value: 'judge', label: '判断题' };
    if (/简答题|问答题/.test(heading)) { const meta = typeMetaFromLabel(heading); return { kind: 'type', value: meta.type, label: meta.label }; }
    return { kind: 'category', value: heading };
  }
  if (/^第.{0,10}章/.test(clean) && /(?:图片)?(?:单选|多选|判断|简答)题/.test(clean)) {
    return { kind: 'category', value: clean };
  }
  if (/^(?:图片)?(?:单选|多选|判断|简答)题(?:\s*[（(](?:标准格式|示例|模板)[）)])?$/.test(clean) || /(?:单选|多选|判断|简答)题\s*[（(](?:标准格式|示例|模板)[）)]$/.test(clean)) {
    if (/单选/.test(clean)) return { kind: 'type', value: 'single', label: '单选题' };
    if (/多选/.test(clean)) return { kind: 'type', value: 'multiple', label: '多选题' };
    if (/判断/.test(clean)) return { kind: 'type', value: 'judge', label: '判断题' };
    return { kind: 'type', value: 'short', label: displayTypeFromLabel(clean) };
  }
  if (OPTION_LINE_RE.test(clean) || LOOSE_OPTION_LINE_RE.test(clean) || /[；;,，]\s*[A-L]\s*[.、．:：)）]/i.test(clean)) return null;
  if (QUESTION_RES.some(pattern => pattern.test(clean)) || COUNT_RE.test(clean) || GENERIC_COUNT_RE.test(clean) ||
      BARE_NUMBERED_QUESTION_RE.test(clean) || BROKEN_COUNT_RE.test(clean) || NUMBERED_TYPE_RE.test(clean)) return null;
  if (/^(?:正确答案|标准答案|参考答案|答案|答|答案解析|试题解析|解析|说明)\s*(?:为|是)?\s*[:：]/.test(clean)) return null;
  if (/^(初级工|中级工|高级工|技师|高级技师)$/.test(clean)) {
    return { kind: 'level', value: clean };
  }

  const wrappedTypeHeading = new RegExp(`^[（(\\[【]?\\s*${TYPE_LABEL}\\s*[）)\\]】]?$`).exec(clean);
  if (wrappedTypeHeading) { const meta = typeMetaFromLabel(wrappedTypeHeading[1]); return { kind: 'type', value: meta.type, label: meta.label }; }

  const headingSuffix = '(?:（[^）]*）|\\([^)]*\\))?';
  if (new RegExp(`^(?:[一二三四五六七八九十]+[、.．]\\s*)?(?:单选题|单项选择题|单选)${headingSuffix}$`).test(clean)) return { kind: 'type', value: 'single' };
  if (new RegExp(`^(?:[一二三四五六七八九十]+[、.．]\\s*)?(?:多选题|多项选择题|多选|选择题)${headingSuffix}$`).test(clean)) return { kind: 'type', value: 'multiple' };
  if (new RegExp(`^(?:[一二三四五六七八九十]+[、.．]\\s*)?(?:判断题|判断)${headingSuffix}$`).test(clean)) return { kind: 'type', value: 'judge' };
  if (new RegExp(`^(?:[一二三四五六七八九十]+[、.．]\\s*)?(?:简答题|【简答题】|问答题|实操题)${headingSuffix}$`).test(clean)) return { kind: 'type', value: 'short' };

  const headingStyle = /(?:heading|标题|title)/i.test(style || '');
  const compactStyleHeading = Boolean(style) && clean.length <= 30 && !/[。？?！!：:（）()]/.test(clean);
  if (compactStyleHeading && !/^(?:\d+|[A-L])$/.test(clean)) {
    return { kind: 'category', value: clean.replace(/\d+$/, '').trim() || clean };
  }
  if (/^(?!.*[。？?！!])[^：:]{2,28}(?:知识|控制阀|安全环保|管理|基础|专业|法规|标准|实操)$/.test(clean)) {
    return { kind: 'category', value: clean };
  }
  const headingLooksLikeQuestion = isStrongQuestionCue(clean) || /[（(]\s*[）)]/.test(clean) || /[？?]$/.test(clean);
  if (/^[一二三四五六七八九十]+[、.．]\s*\S+/.test(clean) || /^[（(][一二三四五六七八九十]+[）)]\s*\S+/.test(clean) || /^第[一二三四五六七八九十\d]+(?:部分|章|节)/.test(clean) || (headingStyle && clean.length <= 40 && !headingLooksLikeQuestion)) {
    return {
      kind: 'category',
      value: clean.replace(/^(?:[一二三四五六七八九十]+[、.．]|[（(][一二三四五六七八九十]+[）)])\s*/, '')
    };
  }
  return null;
}


function normalizedDocumentTitle(value = '') {
  return normalizeOneLine(value)
    .replace(/\.(?:docx?|docm|dotx|dotm|xlsx?|xlsm|xltx|xltm|pdf|rtf|odt|ods|csv|tsv|txt|md|markdown|html?)$/i, '')
    // Windows/微信重复下载常在文件名末尾追加“(1)”或“（2）”，正文标题通常没有。
    .replace(/(?:[（(]\s*\d+\s*[）)])+$/g, '')
    .replace(/[\s\u3000·•_—–-]+/g, '')
    .replace(/[，,。．.：:；;]+/g, '')
    .toLowerCase();
}

function isLikelyDocumentTitle(text = '', sourceName = '', style = '') {
  const clean = normalizeOneLine(text);
  if (!clean || clean.length < 2 || clean.length > 100) return false;

  // 带明确题号、题干空格、问号、选项或答案标签的内容仍按题目处理。
  if (QUESTION_RES.some(pattern => pattern.test(clean)) || COUNT_RE.test(clean) || GENERIC_COUNT_RE.test(clean) ||
      BARE_NUMBERED_QUESTION_RE.test(clean) || BROKEN_COUNT_RE.test(clean) || NUMBERED_TYPE_RE.test(clean) ||
      OPTION_LINE_RE.test(clean) || LOOSE_OPTION_LINE_RE.test(clean) ||
      /[（(]\s*[）)]|[？?]$/.test(clean) ||
      /^(?:题目|题干|问题|正确答案|标准答案|参考答案|答案|答|解析|说明)\s*[:：]/.test(clean)) return false;

  const textKey = normalizedDocumentTitle(clean);
  const sourceKey = normalizedDocumentTitle(sourceName);
  if (sourceKey && textKey && (textKey === sourceKey || sourceKey.startsWith(textKey) || textKey.startsWith(sourceKey))) {
    return true;
  }

  // 常见周学习资料标题。日期范围只用于说明批次，不构成题目。
  if (/^(?:[\u3400-\u9fffA-Za-z0-9]+)?(?:专业)?(?:学习内容|学习资料|培训内容|培训资料|复习资料|知识汇总)(?:[（(]\s*\d{1,2}(?:[.月/]\d{1,2})?\s*(?:-|—|–|~|～|至)\s*\d{1,2}(?:[.月/]\d{1,2})?\s*[）)])?$/.test(clean)) {
    return true;
  }

  // Word 明确标为 Title/标题且没有任何题目结构时，也只作为文档元数据。
  return /(?:title|标题)/i.test(style || '') && clean.length <= 60;
}

function parseAnswerLetters(value = '') {
  const clean = normalizeOneLine(value).toUpperCase()
    .replace(/^[（(【\[]+|[）)】\]]+$/g, '')
    .replace(/^(?:正确答案|标准答案|参考答案|答案|答)\s*(?:为|是)?\s*[:：]?\s*/i, '')
    .trim();

  if (/^(?:√|✓|✔|☑|对|正确|是|TRUE|T)(?:$|[，。；;（(])/.test(clean)) return ['A'];
  if (/^(?:×|✕|✖|☒|❌|错|错误|否|FALSE|F)(?:$|[，。；;（(])/.test(clean)) return ['B'];

  // A（正确）、B（错误）、A(对) 是题库中常见的判断题答案写法。
  const truthExplained = /^([AB])\s*[（(【\[]\s*(?:正确|错误|对|错)\s*[）)】\]]\s*[,，。；;]?$/.exec(clean);
  if (truthExplained) return [truthExplained[1]];

  const explainedSingle = /^([A-L])\s*[.．:：)）]\s*\S+/.exec(clean);
  if (explainedSingle) return [explainedSingle[1]];

  const leadingExplained = /^([A-L](?:(?:\s*[,，、/\\|\s]\s*|(?=[A-L]))[A-L])*)(?=\s*(?:[；;，。]|$))/.exec(clean);
  if (leadingExplained) return unique(leadingExplained[1].match(/[A-L]/g) || []);

  const leading = /^([A-L](?:(?:\s*[,，、/\\|\s]\s*|(?=[A-L]))[A-L])*)(?:\s*[,，。；;]?\s*$|\s*[（(【\[])/.exec(clean);
  if (leading) return unique(leading[1].match(/[A-L]/g) || []);

  const bracket = /[（(【\[]\s*([A-L](?:(?:\s*[,，、/\\|\s]\s*|(?=[A-L]))[A-L])*)\s*[）)】\]]/.exec(clean);
  return bracket ? unique(bracket[1].match(/[A-L]/g) || []) : [];
}

function isJudgementAnswerValue(value = '') {
  let clean = normalizeOneLine(value)
    .replace(/^(?:正确答案|标准答案|参考答案|答案|答)\s*(?:为|是)?\s*[:：]?\s*/i, '')
    .replace(/[，,。；;]+$/g, '')
    .trim()
    .toUpperCase();
  // Word 中常见“答案：（正确）”“答案：(错误)”以及全角/方括号包裹。
  // 先反复剥离成对的外层括号，再判断语义；不能只依赖 parseAnswerLetters，
  // 否则虽然能得到 A/B，却不会把题型锁定为判断题。
  let previous = '';
  while (clean && clean !== previous) {
    previous = clean;
    clean = clean.replace(/^\s*[（(【\[]\s*(.*?)\s*[）)】\]]\s*$/, '$1').trim();
  }
  return /^(?:√|✓|×|✕|✖|正确|错误|对|错|是|否|TRUE|FALSE|T|F|A\s*[（(【\[]\s*(?:正确|对)\s*[）)】\]]|B\s*[（(【\[]\s*(?:错误|错)\s*[）)】\]])$/.test(clean);
}

function isStrongShortQuestion(value = '') {
  const clean = normalizeOneLine(value);
  if (!clean || /[（(]\s*[）)]/.test(clean)) return false;
  if (/(?:【|\[|（|\()?\s*(?:简答题|简答|问答题|实操题|论述题|填空题|计算题|画图题|绘图题|作图题)\s*(?:】|\]|）|\))?/.test(clean)) return true;
  if (/^(?:简述|写出|列出|阐述|分析|解释|回答|说明)(?!\s*[:：]?\s*(?:正确|错误))/.test(clean)) return true;
  const interrogative = /(?:是什么|有哪些|有何|如何|为什么|哪几|哪一|多少|几种|怎样|怎么|应做哪些|应做好哪些|应符合哪些|起什么作用|原理是什么|含义是什么|区别是什么|关系是什么)/.test(clean);
  return interrogative && (/[？?]\s*$/.test(clean) || /^(?:题目|题干|问题)\s*[:：]/.test(clean));
}

function optionLabelMarkers(value = '') {
  const clean = normalizeOneLine(value);
  const result = [];
  const re = /(?:^|[\s；;。])(?:[（(]\s*)?([A-Z])\s*(?:[）)]|[.、．:：)）])\s*/ig;
  let match;
  while ((match = re.exec(clean))) result.push(match[1].toUpperCase());
  return result;
}

function isMappingAnswerLine(value = '', questionText = '') {
  if (!isStrongShortQuestion(questionText)) return false;
  const keys = optionLabelMarkers(value);
  if (keys.length < 3) return false;
  let sequential = true;
  for (let index = 1; index < keys.length; index += 1) {
    if (keys[index].charCodeAt(0) !== keys[index - 1].charCodeAt(0) + 1) sequential = false;
  }
  return !sequential || keys.length >= 6 || /字母.*含义/.test(questionText);
}

function answerCandidatePattern() {
  return '(?:[A-L](?:(?:\\s*[,，、/\\\\|\\s]\\s*|(?=[A-L]))[A-L])*|√|✓|✔|☑|×|✕|✖|☒|❌|对|错|正确|错误|是|否|TRUE|FALSE)';
}

function extractInlineShortAnswer(text = '', typeHint = '') {
  const clean = normalizeText(text || '').trim();
  if (!clean) return { question: '', answer: '' };

  const match = /[？?]/.exec(clean);
  if (!match || match.index < 4 || match.index >= clean.length - 1) {
    return { question: clean, answer: '' };
  }

  const question = clean.slice(0, match.index + 1).trim();
  const answer = clean.slice(match.index + 1)
    .replace(/^\s*(?:正确答案|标准答案|参考答案|答案|答)\s*(?:为|是)?\s*[:：]?\s*/, '')
    .trim();

  if (answer.length < 8) return { question: clean, answer: '' };
  if (/^(?:第?\d+题|题目|题干|问题)\s*[:：]/.test(answer)) return { question: clean, answer: '' };

  const shortCue = /(?:什么|哪些|如何|为什么|简述|写出|列出|说明|原因|措施|步骤|内容|要求|规定|方法|特点|作用|注意事项|有何|定义|组成|分类|区别|关系|含义)/.test(question);
  if (typeHint !== 'short' && !shortCue) return { question: clean, answer: '' };

  // 一段文字中“问题？答案……”连写时，将问号后的陈述内容识别为参考答案。
  return { question, answer };
}

function extractInlineAnswer(text = '', allowImplicit = false) {
  let clean = normalizeOneLine(text);
  const answers = [];
  const sources = [];
  const candidate = answerCandidatePattern();

  const explicitBracket = new RegExp(`[（(【\\[]\\s*(?:正确答案|标准答案|参考答案|答案|答)\\s*[:：]?\\s*(${candidate})\\s*[）)】\\]]`, 'ig');
  clean = clean.replace(explicitBracket, (all, value) => {
    answers.push(...parseAnswerLetters(value));
    sources.push('题干内显式答案');
    return ' ';
  });

  const explicitPlain = new RegExp(`(?:参考答案|参考答|正确答案|标准答案|参考|答案)\\s*(?:为|是)?\\s*[:：]?\\s*(${candidate})\\s*$`, 'i');
  const plainMatch = explicitPlain.exec(clean);
  if (plainMatch) {
    answers.push(...parseAnswerLetters(plainMatch[1]));
    sources.push('题干末尾显式答案');
    clean = clean.slice(0, plainMatch.index).trim();
  }

  if (allowImplicit) {
    const leading = new RegExp(`^\\s*[（(【\\[]\\s*(${candidate})\\s*[）)】\\]]\\s*(.+)$`, 'i').exec(clean);
    if (leading) {
      answers.push(...parseAnswerLetters(leading[1]));
      sources.push('题干开头括号答案');
      clean = leading[2].trim();
    }

    const trailing = new RegExp(`^(.*?)\\s*[（(【\\[]\\s*(${candidate})\\s*[）)】\\]]\\s*$`, 'i').exec(clean);
    if (trailing && trailing[1].trim().length >= 4) {
      answers.push(...parseAnswerLetters(trailing[2]));
      sources.push('题干末尾括号答案');
      clean = trailing[1].trim();
    }
  }

  return {
    text: cleanQuestionText(clean),
    answers: unique(answers),
    sources: unique(sources)
  };
}

function bareInlineOptionMarkers(text, strictMarkers) {
  const strictOptions = strictMarkers
    .filter(item => item.type === 'option')
    .map(item => ({ ...item, strict: true, tight: false, punctuated: true }));
  const candidates = [];

  const hasStrictNear = index => strictOptions.some(item => Math.abs(item.start - index) <= 1);
  const pushCandidate = candidate => {
    if (!candidate || !candidate.key || candidate.end >= text.length + 1) return;
    if (hasStrictNear(candidate.start)) return;
    const bodyStart = candidate.end;
    if (bodyStart >= text.length) return;
    const next = text[bodyStart];
    if (!/[\u3400-\u9fffA-Za-z0-9（(\-+√✓✔×✕✖]/.test(next || '')) return;
    candidates.push(candidate);
  };

  // 第一层：识别带明确标点的选项字母。这里允许字母紧贴上一项正文，
  // 例如“36VB.60VC.110VD.220V”。是否真正采用，必须由后面的完整
  // A→B→C→D 连续链校验决定，单独出现的“B.协议”不会直接切开正文。
  const punctuated = /([A-L])\s*[.、．:：)）]\s*/ig;
  let punctMatch;
  while ((punctMatch = punctuated.exec(text))) {
    const start = punctMatch.index;
    const previous = start > 0 ? text[start - 1] : '';
    const tight = Boolean(previous && !/[\s\n；;。！？?：:）)]/.test(previous));
    pushCandidate({
      type: 'option',
      key: punctMatch[1].toUpperCase(),
      start,
      end: punctuated.lastIndex,
      strict: false,
      tight,
      punctuated: true
    });
  }

  // 第二层：兼容“A 36V B 60V C 110V D 220V”等没有标点但有清楚
  // 间隔的格式。英文单词、型号和缩写内部的大写字母绝不作为边界。
  for (let index = 0; index < text.length; index += 1) {
    const key = text[index];
    if (!/[A-L]/.test(key) || hasStrictNear(index)) continue;
    const previous = index > 0 ? text[index - 1] : '';
    if (previous && /[A-Za-z0-9_]/.test(previous)) continue;
    if (previous && !/[\s\n；;。！？?：:（(）)]/.test(previous) && index !== 0) continue;

    let cursor = index + 1;
    while (/\s/.test(text[cursor] || '')) cursor += 1;
    // 带标点的候选已由第一层处理，避免产生两个不同 end 的重复候选。
    if (/[.、．:：)）]/.test(text[cursor] || '')) continue;
    if (cursor >= text.length) continue;
    const next = text[cursor];
    if (!/[\u3400-\u9fffA-Za-z0-9（(\-+√✓✔×✕✖]/.test(next)) continue;
    candidates.push({ type: 'option', key, start: index, end: cursor, strict: false, tight: false });
  }

  const all = [...strictOptions, ...candidates]
    .sort((a, b) => a.start - b.start || Number(b.strict) - Number(a.strict) || b.end - a.end);
  const uniqueByPosition = all.filter((item, index, items) => {
    return index === 0 || item.start !== items[index - 1].start;
  });

  function collectFrom(startIndex, expectedKey) {
    const accepted = [];
    let expectedCode = expectedKey.charCodeAt(0);
    for (let index = startIndex; index < uniqueByPosition.length; index += 1) {
      const item = uniqueByPosition[index];
      const code = item.key.charCodeAt(0);
      if (code < expectedCode) continue;
      if (code > expectedCode) {
        // 选项必须严格连续，不能从 B 直接跳到 D，也不能从正文里的某个
        // 字母重新起链。
        break;
      }
      accepted.push(item);
      expectedCode += 1;
    }
    return accepted;
  }

  let accepted = [];
  let inferredA = false;
  const firstA = uniqueByPosition.findIndex(item => item.key === 'A');
  if (firstA >= 0) accepted = collectFrom(firstA, 'A');

  // 自动编号丢失 A 时，只有 B/C/D 至少连续三项，且 B 前面确有正文，
  // 才把前缀恢复成 A。这样可解决 36VB.60VC.110VD.220V，同时不会
  // 把普通文字中的单个 B. 或 A网/B网说明误拆成选项。
  if (accepted.length < 3) {
    const firstB = uniqueByPosition.findIndex(item => item.key === 'B');
    if (firstB >= 0) {
      const fromB = collectFrom(firstB, 'B');
      const prefix = text.slice(0, uniqueByPosition[firstB].start).trim();
      if (prefix && fromB.length >= 3) {
        inferredA = true;
        accepted = [{ type: 'option', key: 'A', start: 0, end: 0, strict: false, tight: false, inferred: true }, ...fromB];
      }
    }
  }

  if (accepted.length < 3) return [];

  // 每个选项必须拥有非空正文；紧贴上一项的弱边界必须形成至少 A-D
  // 四项完整链。该约束是避免选项文字中“B.协议、C.语言”被误切的关键。
  for (let index = 0; index < accepted.length; index += 1) {
    const item = accepted[index];
    const next = accepted[index + 1];
    const body = text.slice(item.end, next ? next.start : text.length).trim();
    if (!body) return [];
  }
  const hasTightBoundary = accepted.some(item => item.tight);
  // 三选项题在 PDF/Word 中很常见，例如：
  //   A. 二氧化碳B. 干粉C. 泡沫
  // Word 自动编号还可能把 A. 放在列表编号中，正文只剩“二氧化碳B...C...”。
  // 只要 A 是明确的首选项标记（原文 A. 或由 Word 列表序号恢复），且 B/C
  // 都带选项标点并严格连续，就允许 A-B-C 三项紧凑链。这样既修复三选项题，
  // 又继续拒绝“正文A.术语B.术语C.术语”这类 A 本身没有明确边界的误切。
  const explicitCompactTriple = accepted.length === 3 && !inferredA &&
    accepted[0].key === 'A' && Boolean(accepted[0].strict) &&
    accepted.slice(1).every(item => Boolean(item.punctuated));
  if (hasTightBoundary && accepted.length < 4 && !explicitCompactTriple) return [];
  if (inferredA && accepted.length < 4) return [];

  // 普通三项链仍要求至少两个清晰边界；上面的“明确 A + 紧凑 B/C”是专门的
  // 三选项兼容分支。四项及以上完整链继续兼容紧凑旧题库格式。
  const clearBoundaryCount = accepted.filter(item => item.strict || !item.tight).length;
  if (accepted.length === 3 && clearBoundaryCount < 2 && !explicitCompactTriple) return [];
  return accepted;
}
function markerPositions(text) {
  const markers = [];
  const patterns = [
    { type: 'reference', re: /(?:参考答案|参考答|参考)\s*[:：]/g },
    { type: 'analysis', re: /(?:答案解析|试题解析|解析|说明)\s*[:：]/g },
    { type: 'answer', re: /(?:正确答案|标准答案|答案|答)\s*(?:为|是)?\s*[:：]/g },
    // 同一段中的（A）…（B）…，以及 A. / B、 等格式。
    { type: 'option', re: /(^|[\s；;\n。？！?：:])(?:[（(【\[]\s*)([A-L])\s*[）)】\]]\s*/g },
    { type: 'option', re: /(^|[\s；;\n。？！?：:）)】\]])([A-L])\s*[.、．:：)）]\s*/g }
  ];

  patterns.forEach(({ type, re }) => {
    let match;
    while ((match = re.exec(text))) {
      const prefixLength = type === 'option' ? (match[1] || '').length : 0;
      markers.push({
        type,
        start: match.index + prefixLength,
        end: re.lastIndex,
        key: type === 'option' ? match[2].toUpperCase() : ''
      });
    }
  });

  const semanticMarkers = markers.filter(item => item.type !== 'option');
  const firstSemanticStart = semanticMarkers.length ? Math.min(...semanticMarkers.map(item => item.start)) : Infinity;
  const bareOptions = bareInlineOptionMarkers(text, markers.filter(item => item.type === 'option'))
    .filter(item => item.start < firstSemanticStart);
  markers.push(...bareOptions);

  const sorted = markers.sort((a, b) => a.start - b.start || b.end - a.end);
  return sorted.filter((item, index, all) => {
    if (index > 0 && item.start === all[index - 1].start) return false;
    if (item.type === 'answer') {
      return !all.some(other => (other.type === 'reference' || other.type === 'analysis') && item.start >= other.start && item.start < other.end);
    }
    if (item.type === 'option') {
      return !all.some(other => other.type !== 'option' && other.start < item.start);
    }
    return true;
  });
}
function splitInlineJudgePair(value = '') {
  const clean = normalizeOneLine(value)
    .replace(/^选项\s*[:：]\s*/, '')
    .replace(/[，,。；;]+$/g, '')
    .trim();
  // Word 自动编号经常只保留第一项正文，形成“正确B.错误”；也兼容 A.正确B.错误。
  const match = /^(?:A\s*[.、．:：)）]?\s*)?(正确|对|是|错误|错|否)\s*B\s*[.、．:：)）]?\s*(正确|对|是|错误|错|否)$/i.exec(clean);
  if (!match) return null;
  const first = /^(?:正确|对|是)$/.test(match[1]) ? '正确' : '错误';
  const second = /^(?:正确|对|是)$/.test(match[2]) ? '正确' : '错误';
  if (first === second) return null;
  return [
    { type: 'option', key: 'A', value: first },
    { type: 'option', key: 'B', value: second }
  ];
}
function repairCollapsedChoiceOptions(options = [], answerLetters = [], questionText = '', typeHint = '') {
  if (!Array.isArray(options) || !options.length) return false;

  const normalizedAnswers = unique((answerLetters || []).map(value => String(value || '').toUpperCase()));
  const strongChoiceCue = typeHint === 'single' || typeHint === 'multiple' ||
    hasBlankPlaceholder(questionText) || isStrongQuestionCue(questionText);
  let changed = false;

  // 末端兜底不再只检查 A 项。PDF/Word 常把下一项的字母黏到上一项正文：
  //   C. 身上着火……火苗D. 火灾时……
  //   B. 管道……作业C. 应预先制定……
  // 此时前置解析已经得到 A/B/C，但最后一项正文里仍藏着“下一字母.”。
  // 只允许拆“当前项的紧邻下一项”，并要求答案/题型/后续选项提供结构证据，
  // 防止把普通正文中的 D.术语、B.协议之类误切成选项。
  for (let guard = 0; guard < 12; guard += 1) {
    let repairedThisRound = false;
    for (let index = 0; index < options.length; index += 1) {
      const item = options[index];
      if (!item || !item.key || !normalizeOneLine(item.text || '')) continue;
      const expectedCode = item.key.charCodeAt(0) + 1;
      if (expectedCode > 'L'.charCodeAt(0)) continue;
      const expected = String.fromCharCode(expectedCode);
      const marker = new RegExp(`${expected}\\s*[.、．:：)）]\\s*`, 'i').exec(item.text || '');
      if (!marker || marker.index <= 0) continue;
      const prefix = cleanQuestionText((item.text || '').slice(0, marker.index));
      const suffix = cleanQuestionText((item.text || '').slice(marker.index + marker[0].length));
      if (!prefix || !suffix) continue;

      const laterExisting = options.some(other => other && other.key && other.key.charCodeAt(0) > expectedCode);
      const answerSupports = normalizedAnswers.includes(expected) || normalizedAnswers.some(letter => letter.charCodeAt(0) > expectedCode);
      if (!answerSupports && !laterExisting && !strongChoiceCue) continue;

      const existing = options.find(other => other.key === expected);
      if (existing) {
        const existingText = normalizeOneLine(existing.text || '');
        if (existingText && existingText !== normalizeOneLine(suffix)) continue;
        existing.text = existing.text || suffix;
      } else {
        options.splice(index + 1, 0, { key: expected, text: suffix, images: [] });
      }
      item.text = prefix;
      repairedThisRound = true;
      changed = true;
      break;
    }
    if (!repairedThisRound) break;
  }

  // 兼容旧的“整个 A 项里连写 A/B/C/...”形态。上面的逐项修复已经覆盖绝大多数，
  // 这里保留一次完整链重拆，以处理 Word 自动编号和 PDF 紧凑行的历史题库。
  const first = options[0];
  if (first && first.key === 'A' && normalizeOneLine(first.text || '') && /[B-L]\\s*[.、．:：)）]/i.test(first.text || '')) {
    const tokens = splitInline(`A. ${first.text || ''}`)
      .filter(item => item.type === 'option' && item.key && normalizeOneLine(item.value || ''));
    if (tokens.length >= 3) {
      let sequential = true;
      for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index].key !== String.fromCharCode(65 + index)) { sequential = false; break; }
      }
      if (sequential) {
        const repairedKeys = tokens.map(item => item.key);
        const answerFits = normalizedAnswers.length > 0 && normalizedAnswers.every(value => repairedKeys.includes(value));
        if (answerFits || strongChoiceCue) {
          const existingByKey = new Map(options.map(item => [item.key, item]));
          let conflict = options.some(item => !repairedKeys.includes(item.key));
          for (const token of tokens.slice(1)) {
            const existing = existingByKey.get(token.key);
            if (!existing) continue;
            const oldText = normalizeOneLine(existing.text || '');
            const newText = normalizeOneLine(token.value || '');
            if (oldText && newText && oldText !== newText) { conflict = true; break; }
          }
          if (!conflict) {
            const repaired = tokens.map((token, index) => {
              const existing = existingByKey.get(token.key);
              return {
                key: token.key,
                text: cleanQuestionText(token.value || ''),
                images: unique([...(existing && existing.images || []), ...(index === 0 ? (first.images || []) : [])])
              };
            });
            options.splice(0, options.length, ...repaired);
            changed = true;
          }
        }
      }
    }
  }
  return changed;
}

function recoverFragmentedOptionContinuation(text = '', current = null) {
  if (!current || !Array.isArray(current.options) || current.options.length < 2) return null;
  if (current.typeHint === 'short' || current.typeHint === 'judge') return null;
  const clean = normalizeOneLine(text || '');
  if (!clean) return null;

  const last = current.options[current.options.length - 1];
  if (!last || !last.key) return null;
  const expectedCode = last.key.charCodeAt(0) + 1;
  if (expectedCode > 'L'.charCodeAt(0)) return null;
  const expected = String.fromCharCode(expectedCode);

  const questionText = cleanQuestionText(current.questionParts);
  const strongChoiceCue = current.typeHint === 'single' || current.typeHint === 'multiple' ||
    hasBlankPlaceholder(questionText) || /^(?:下列|以下|关于|根据|在|当|选择|哪|何种)/.test(questionText);
  if (!strongChoiceCue) return null;

  const markers = [];
  const re = /([A-L])\s*[.、．:：)）]\s*/ig;
  let match;
  while ((match = re.exec(clean))) {
    markers.push({ key: match[1].toUpperCase(), start: match.index, end: re.lastIndex });
  }
  if (!markers.length) return null;

  const first = markers[0];
  const firstCode = first.key.charCodeAt(0);
  const prefix = clean.slice(0, first.start).trim();
  const result = [];

  // 正常断行：上一项正文的续行末尾紧跟下一项标记。
  // B 已开始，下一段“……设备设施上不应作业C.应预先……” -> 先补 B，再创建 C。
  if (firstCode === expectedCode) {
    if (prefix) result.push({ type: 'text', value: prefix, optionContinuation: true });
  // PDF 坐标提取偶尔只丢一个选项字母：D 后下一段“火灾探测器 F.PLC...”。
  // 仅允许跳过恰好一个字母，并把 F 前面的非空前缀恢复成 E。
  } else if (firstCode === expectedCode + 1 && prefix) {
    result.push({ type: 'option', key: expected, value: prefix, inferredMissingMarker: true });
  } else return null;

  let wanted = first.key.charCodeAt(0);
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const code = marker.key.charCodeAt(0);
    if (code !== wanted) break;
    const next = markers[index + 1];
    const value = clean.slice(marker.end, next ? next.start : clean.length).trim();
    if (!value) return null;
    result.push({ type: 'option', key: marker.key, value });
    wanted += 1;
  }
  return result.some(token => token.type === 'option') ? result : null;
}
function splitCompactAnswerOptions(text = '') {
  const clean = normalizeText(text || '');
  // 兼容“答案：CA、选项… / 答案 C；A.选项… / 正确答案为C A)…”等紧凑写法。
  // `答案(?!解析)` 避免把“答案解析”误当成答案标签。
  const label = /(?:正确答案|标准答案|参考答案|答案(?!解析)|答)\s*(?:为|是)?\s*[:：]?\s*/i.exec(clean);
  if (!label) return null;
  const question = clean.slice(0, label.index).trim();
  const tail = clean.slice(label.index + label[0].length).trim();
  const compact = /^([A-L]{1,8})\s*[；;，,、\s]*A\s*(?:[.、．:：)）]\s*|\s+)([\s\S]+)$/i.exec(tail);
  if (!compact) return null;
  const answerLetters = unique((compact[1].toUpperCase().match(/[A-L]/g) || []));
  if (!answerLetters.length) return null;
  const optionStream = `A. ${compact[2].trim()}`;
  const optionMarkers = markerPositions(optionStream).filter(item => item.type === 'option');
  if (optionMarkers.length < 2 || optionMarkers[0].key !== 'A') return null;
  const options = optionMarkers.map((marker, index) => {
    const next = optionMarkers[index + 1];
    return { type: 'option', key: marker.key, value: optionStream.slice(marker.end, next ? next.start : optionStream.length).trim() };
  }).filter(item => item.value);
  if (options.length < 2) return null;
  const result = [];
  if (question) result.push({ type: 'text', value: question });
  result.push({ type: 'answer', value: answerLetters.join('') });
  result.push(...options);
  return result;
}

function splitInline(text) {
  const clean = normalizeText(text).replace(/选项\s*[:：]/g, ' ');
  const compactAnswerOptions = splitCompactAnswerOptions(clean);
  if (compactAnswerOptions) return compactAnswerOptions;
  const judgePair = splitInlineJudgePair(clean);
  if (judgePair) return judgePair;
  const markers = markerPositions(clean);
  if (!markers.length) return [{ type: 'text', value: clean }];

  const result = [];
  if (markers[0].start > 0) {
    result.push({ type: 'text', value: clean.slice(0, markers[0].start).trim() });
  }

  markers.forEach((marker, index) => {
    const next = markers[index + 1];
    result.push({
      type: marker.type,
      key: marker.key,
      value: clean.slice(marker.end, next ? next.start : clean.length).trim()
    });
  });
  return result.filter(item => item.value || item.type !== 'text');
}

function isNoiseParagraph(text, repeatedCount = 0) {
  const clean = normalizeOneLine(text);
  if (!clean) return true;
  if (/^第\s*\d+\s*页(?:\s*(?:初级工|中级工|高级工))?$/.test(clean)) return true;
  if (/^[-—–]\s*\d+\s*[-—–]$/.test(clean)) return true;
  if (/^\S.{0,50}[.．·…]{4,}\s*\d+$/.test(clean)) return true;
  if (/^后接[\u3400-\u9fff]{2,6}$/.test(clean)) return true;
  if (repeatedCount >= 3 && /^(?:第\s*\d+\s*页|[-—–]\s*\d+\s*[-—–])/.test(clean)) return true;
  return false;
}

function mergeSplitQuestionStarts(paragraphs = []) {
  const source = (paragraphs || []).map(item => Object.assign({}, item, {
    sourceIndexes: Array.isArray(item.sourceIndexes) && item.sourceIndexes.length
      ? item.sourceIndexes.slice()
      : [item.index]
  }));
  const merged = [];
  let repairedCount = 0;

  const standaloneNumber = value => /^\s*(\d{1,4})\s*[.、．:：)）-]?\s*$/.exec(normalizeOneLine(value || ''));
  const startsWithQuestionWord = value => {
    const clean = normalizeOneLine(value || '');
    if (!clean || /^题\s*(?:共)?\s*\d+\s*$/.test(clean)) return false;
    return /^(?:题目|题干|问题)\s*[:：]?|^题(?!\s*(?:共)?\s*\d+\s*$)|^(?:[（(\[【]?\s*)?(?:单选题|单项选择题|单选|多选题|多项选择题|多选|判断题|判断|简答题|问答题|实操题|论述题|填空题|计算题|画图题|绘图题|作图题)/.test(clean);
  };
  const looksLikeOptionOrAnswer = value => {
    const clean = normalizeOneLine(value || '');
    return /^(?:[A-L]\s*[.、．:：)）]|[（(]?[A-L][）)]|(?:正确答案|标准答案|参考答案|答案|答)\s*(?:为|是)?\s*[:：])/i.test(clean);
  };
  const likelyQuestionBody = (value, nextValue, number) => {
    const clean = normalizeOneLine(value || '');
    if (!clean) return false;
    if (startsWithQuestionWord(clean)) return true;
    if (Number(number) > 99) return false;
    const cue = /[？?]$|[（(]\s*[）)]|^(?:下列|以下|关于|根据|在|当|为了|某|用|一个|一台|仪表|控制|应急|进入|高处|放射|动火|什么|如何|为什么|简述|说明)/.test(clean);
    return cue && looksLikeOptionOrAnswer(nextValue);
  };

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const numberMatch = standaloneNumber(current.text);
    if (!numberMatch) {
      merged.push(current);
      continue;
    }

    const next = source[index + 1];
    const afterNext = source[index + 2];
    if (!next) {
      merged.push(current);
      continue;
    }

    let consume = 1;
    let body = normalizeText(next.text || '').trim();
    let evidenceNext = afterNext ? afterNext.text : '';

    // 某些 PDF 转 Word 文档把“题”单独放一段，题干在再下一段。
    if (/^\s*题\s*$/.test(normalizeOneLine(body)) && afterNext) {
      const third = source[index + 3];
      if (likelyQuestionBody(afterNext.text, third ? third.text : '', numberMatch[1])) {
        body = `题 ${normalizeText(afterNext.text || '').trim()}`.trim();
        evidenceNext = third ? third.text : '';
        consume = 2;
      }
    }

    if (!likelyQuestionBody(body, evidenceNext, numberMatch[1])) {
      merged.push(current);
      continue;
    }

    const parts = [current, next];
    if (consume === 2) parts.push(afterNext);
    const sourceIndexes = [];
    const images = [];
    const alternatives = [];
    parts.forEach(part => {
      (part.sourceIndexes || [part.index]).forEach(value => {
        if (!sourceIndexes.includes(value)) sourceIndexes.push(value);
      });
      (part.images || []).forEach(value => {
        if (!images.includes(value)) images.push(value);
      });
      (part.alternatives || []).forEach(value => {
        if (!alternatives.includes(value)) alternatives.push(value);
      });
    });

    merged.push(Object.assign({}, current, {
      text: `${numberMatch[1]}. ${body}`.trim(),
      images,
      alternatives,
      sourceIndexes,
      splitQuestionStartRepair: true
    }));
    repairedCount += 1;
    index += consume;
  }

  return { paragraphs: merged, repairedCount };
}

function sanitizeParagraphs(paragraphs) {
  const counts = {};
  paragraphs.forEach(item => {
    const key = compactText(item.text || '');
    if (key && key.length <= 80) counts[key] = (counts[key] || 0) + 1;
  });

  let removedNoiseCount = 0;
  const clean = paragraphs.filter(item => {
    const key = compactText(item.text || '');
    // 纯图片段落不是空白噪声，后续可能需要与 A/B/C/D 图片选项合并。
    if (!key && Array.isArray(item.images) && item.images.length) return true;
    const noise = isNoiseParagraph(item.text, counts[key] || 0);
    if (noise) removedNoiseCount += 1;
    return !noise;
  });
  return { paragraphs: clean, removedNoiseCount };
}

// Word/PDF 转换文件有时把图片和“A.图形”拆成相邻两个段落：
// 图片段在前，选项标签段在后。若不合并，图片会被当成题干图，四张图全部
// 堆在题干区域，甚至第一题的图完全无法与 A/B/C/D 对应。
function mergeDetachedOptionImages(paragraphs = []) {
  const result = [];
  let repairedCount = 0;
  const genericVisualOption = value => /^\s*(?:[（(]\s*)?([A-L])\s*(?:[）)]|[.、．:：]|\s+)?\s*(?:图|图形|图片|图示|示意图|符号图|见图|如下图)\s*$/i.exec(normalizeOneLine(value || ''));
  for (let index = 0; index < paragraphs.length; index += 1) {
    const current = paragraphs[index];
    const next = paragraphs[index + 1];
    const currentText = normalizeOneLine(current && current.text || '');
    const images = current && Array.isArray(current.images) ? current.images.filter(Boolean) : [];
    const nextMatch = next ? genericVisualOption(next.text) : null;
    if (!currentText && images.length && nextMatch) {
      const sourceIndexes = [];
      [current, next].forEach(item => {
        const indexes = Array.isArray(item.sourceIndexes) && item.sourceIndexes.length
          ? item.sourceIndexes : [item.index];
        indexes.forEach(value => { if (!sourceIndexes.includes(value)) sourceIndexes.push(value); });
      });
      result.push({
        ...next,
        images: unique([...(next.images || []), ...images]),
        sourceIndexes
      });
      repairedCount += 1;
      index += 1;
      continue;
    }
    result.push(current);
  }
  return { paragraphs: result, repairedCount };
}

function repairBrokenQuestionNumber(rawNumber = '', rawTotal = '') {
  const numberText = String(rawNumber);
  const total = Number(rawTotal);
  const direct = Number(numberText);
  if (Number.isFinite(total) && direct > total && /1$/.test(numberText)) {
    const repaired = numberText.slice(0, -1);
    const repairedNumber = Number(repaired);
    if (repaired && repairedNumber >= 1 && repairedNumber <= total) return repaired;
  }
  return numberText;
}

function normalizeBrokenPdfQuestionPrefix(text = '', sourceKind = '') {
  const clean = normalizeOneLine(text);
  if (sourceKind !== 'pdf') return clean;
  // PDF 文字坐标有时会把“80.（ ）.”重排成“80（.）.”，把题号标点
  // 塞进判断括号内部。恢复为标准题号与判断占位，避免整题并入上一题。
  const malformedJudge = /^\s*(\d{1,5})\s*[（(]\s*[.．]\s*[）)]\s*[.．、:：]?\s*(.*)$/.exec(clean);
  if (malformedJudge) return `${malformedJudge[1]}. （）${malformedJudge[2] ? ` ${malformedJudge[2]}` : ''}`;
  return clean;
}

function parseQuestionStart(text, context, paragraph, sourceKind = '') {
  text = normalizeBrokenPdfQuestionPrefix(text, sourceKind);
  const countMatch = COUNT_RE.exec(text);
  if (countMatch) {
    const meta = typeMetaFromLabel(countMatch[2]);
    return { number: countMatch[1], typeHint: meta.type, displayTypeLabel: meta.label, content: countMatch[3], boundarySource: '题号和题型' };
  }

  if (sourceKind === 'pdf') {
    const compactBrokenCount = COMPACT_BROKEN_COUNT_RE.exec(text);
    if (compactBrokenCount) {
      const number = Number(compactBrokenCount[1]);
      const total = Number(compactBrokenCount[2]);
      if (number >= 1 && total >= number && total <= 500) {
        const meta = typeMetaFromLabel(compactBrokenCount[3]);
        return {
          number: compactBrokenCount[1],
          typeHint: meta.type,
          displayTypeLabel: meta.label,
          content: compactBrokenCount[4],
          boundarySource: '修复紧连异常题号和题型'
        };
      }
    }
  }

  const brokenCount = BROKEN_COUNT_RE.exec(text);
  if (brokenCount) {
    const meta = typeMetaFromLabel(brokenCount[3]);
    return {
      number: repairBrokenQuestionNumber(brokenCount[1], brokenCount[2]),
      typeHint: meta.type,
      displayTypeLabel: meta.label,
      content: brokenCount[4],
      boundarySource: '修复异常题号和题型'
    };
  }

  const genericCount = GENERIC_COUNT_RE.exec(text);
  if (genericCount) {
    const peeled = peelLeadingType(genericCount[2], context.typeHint, context.displayTypeLabel);
    return { number: genericCount[1], typeHint: peeled.typeHint, displayTypeLabel: peeled.displayTypeLabel, content: peeled.content, boundarySource: '题库序号' };
  }

  const bareNumberedQuestion = BARE_NUMBERED_QUESTION_RE.exec(text);
  if (bareNumberedQuestion) {
    const peeled = peelLeadingType(bareNumberedQuestion[2], context.typeHint, context.displayTypeLabel);
    return {
      number: bareNumberedQuestion[1],
      typeHint: peeled.typeHint,
      displayTypeLabel: peeled.displayTypeLabel,
      content: peeled.content,
      boundarySource: '题字题号'
    };
  }

  const numberedType = NUMBERED_TYPE_RE.exec(text);
  if (numberedType) {
    const meta = typeMetaFromLabel(numberedType[2]);
    return { number: numberedType[1], typeHint: meta.type, displayTypeLabel: meta.label, content: numberedType[3], boundarySource: '题号和题型' };
  }

  const bracketType = BRACKET_TYPE_RE.exec(text);
  if (bracketType && bracketType[2]) {
    const meta = typeMetaFromLabel(bracketType[1]);
    return { number: '', typeHint: meta.type, displayTypeLabel: meta.label, content: bracketType[2], boundarySource: '题型标签' };
  }

  const typed = TYPED_RE.exec(text);
  if (typed) {
    const meta = typeMetaFromLabel(typed[1]);
    return { number: '', typeHint: meta.type, displayTypeLabel: meta.label, content: typed[2], boundarySource: '题型标签' };
  }

  const labeled = /^(?:题目|题干|问题)\s*[:：]\s*(.+)$/.exec(text);
  if (labeled) return { number: '', typeHint: context.typeHint, displayTypeLabel: context.displayTypeLabel, content: labeled[1], boundarySource: '题干标签' };

  for (let index = 0; index < QUESTION_RES.length; index += 1) {
    const match = QUESTION_RES[index].exec(text);
    if (match) {
      const peeled = peelLeadingType(match[2], context.typeHint, context.displayTypeLabel);
      return { number: match[1], typeHint: peeled.typeHint, displayTypeLabel: peeled.displayTypeLabel, content: peeled.content, boundarySource: '显式题号' };
    }
  }

  if (context.typeHint) {
    const noPunctuation = NO_PUNCT_NUMBER_RE.exec(text);
    if (noPunctuation) {
      const peeled = peelLeadingType(noPunctuation[2], context.typeHint, context.displayTypeLabel);
      return { number: noPunctuation[1], typeHint: peeled.typeHint, displayTypeLabel: peeled.displayTypeLabel, content: peeled.content, boundarySource: '无标点题号' };
    }
  }

  if (paragraph.numId && paragraph.numId !== '0' && paragraph.level === 0 && !OPTION_LINE_RE.test(text) && !/^(?:答案|参考答案|解析|答)\s*[:：]/.test(text)) {
    const peeled = peelLeadingType(text, context.typeHint, context.displayTypeLabel);
    return {
      number: paragraph.listOrdinal ? String(paragraph.listOrdinal) : '',
      typeHint: peeled.typeHint,
      displayTypeLabel: peeled.displayTypeLabel,
      content: peeled.content,
      boundarySource: 'Word自动编号'
    };
  }
  return null;
}

function createWorkingQuestion(number, context, boundarySource = '') {
  return {
    id: createId('q'),
    number: number || '',
    level: context.level,
    category: context.category,
    chapter: context.chapter,
    typeHint: context.typeHint,
    displayTypeLabel: context.displayTypeLabel || '',
    questionParts: [],
    options: [],
    answer: [],
    answerTextParts: [],
    analysisParts: [],
    images: [],
    answerImages: [],
    analysisImages: [],
    sourceParagraphs: [],
    rawTexts: [],
    boundarySource,
    answerSources: [],
    answerBoundarySource: '',
    answerBoundaryConfidence: 0,
    difficulty: '',
    knowledgePoint: '',
    material: '',
    materialImages: [],
    inferredBoundary: boundarySource === '智能推断边界'
  };
}

function pushText(target, value) {
  const clean = normalizeText(value || '');
  if (clean) target.push(clean);
}

function isGenericVisualPlaceholder(value = '') {
  const clean = normalizeOneLine(value || '')
    .replace(/[\s()（）\[\]【】<>《》]/g, '')
    .replace(/[.。:：、，,;；]/g, '')
    .toLowerCase();
  return /^(?:图|图形|图片|图示|示意图|符号图|见图|如下图)$/.test(clean);
}

function addOption(current, key, value, images = []) {
  const cleanKey = String(key || '').toUpperCase();
  const cleanText = cleanQuestionText(value || '');
  const imageList = unique((images || []).filter(Boolean));
  const existing = current.options.find(item => item.key === cleanKey);
  if (existing) {
    if (cleanText) existing.parts.push(cleanText);
    existing.images = unique([...(existing.images || []), ...imageList]);
  } else current.options.push({ key: cleanKey, parts: cleanText ? [cleanText] : [], images: imageList });
}

function matchOptionLine(text, current) {
  if (!current || !current.questionParts.length) return null;
  const clean = normalizeOneLine(text);
  const match = /^\s*([A-L])\s*(?:[.、．:：)）]\s*)?(.+?)\s*$/i.exec(clean);
  if (!match) return null;

  const key = match[1].toUpperCase();
  const value = match[2].trim();
  if (!value) return null;
  const questionText = cleanQuestionText(current.questionParts);
  // 选项行先按结构暂存，最终题型再综合题型标签、答案和选项数量决定。
  // 以前这里遇到“有哪些/是什么”等提问词就拒绝识别 A、B、C、D，
  // 会把真实选择题整段塞进简答答案。即使它最终确实是简答题，finalize
  // 也会把暂存选项还原为参考答案，因此这里不应提前丢弃结构证据。

  const expected = current.options.length
    ? String.fromCharCode(current.options[current.options.length - 1].key.charCodeAt(0) + 1)
    : 'A';
  if (key !== expected) return null;

  const hasPunctuation = /^\s*[A-L]\s*[.、．:：)）]/i.test(clean);
  // “A.第一项 B.第二项 C.第三项”同段时交给 splitInline；
  // “A.A网黄色.B网绿色”中的 A网/B网属于选项文字，不应再次拆分。
  const laterExplicit = [];
  const laterRe = /(?:^|[\s；;。！？?])(?:[（(]\s*)?([A-L])\s*(?:[）)]|[.、．:：)）])\s*/ig;
  let later;
  while ((later = laterRe.exec(value))) laterExplicit.push(later[1].toUpperCase());
  const hasSeveralInlineOptions = laterExplicit.length >= 1 && laterExplicit[0].charCodeAt(0) === key.charCodeAt(0) + 1;

  return { key, value, direct: !hasSeveralInlineOptions || !hasPunctuation };
}
function recoverMissingACompactChoiceLine(text, current) {
  if (!current || current.options.length || !current.questionParts.length) return null;
  if (current.typeHint === 'short' || current.typeHint === 'judge') return null;

  const clean = normalizeOneLine(text || '');
  if (!clean || /^[A-L]\s*[.、．:：)）]/i.test(clean)) return null;
  // 必须至少出现连续的 B./C.，前缀才有资格被恢复为 A。
  if (!/B\s*[.、．:：)）]/i.test(clean) || !/C\s*[.、．:：)）]/i.test(clean)) return null;

  const questionText = cleanQuestionText(current.questionParts);
  const choiceContext = current.typeHint === 'single' || current.typeHint === 'multiple' ||
    hasBlankPlaceholder(questionText) || /^(?:下列|以下|关于|根据|在|当|选择|哪|何种)/.test(questionText);
  if (!choiceContext) return null;

  const tokens = splitInline(`A. ${clean}`).filter(item => item.type === 'option');
  if (tokens.length < 3) return null;
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].key !== String.fromCharCode(65 + index) || !normalizeOneLine(tokens[index].value || '')) return null;
  }
  return tokens;
}

function isComplete(current) {
  if (!current) return false;
  if (current.answer.length) return true;
  if (current.answerTextParts.length) return true;
  return false;
}

function looksLikeQuestionLine(text, context, paragraph) {
  const clean = normalizeOneLine(text);
  if (clean.length < 5) return false;
  if (OPTION_LINE_RE.test(clean) || LOOSE_OPTION_LINE_RE.test(clean)) return false;
  if (/^(?:答案|参考答案|解析|答|说明)\s*[:：]/.test(clean)) return false;
  if (/^(?:因为|由于|所以|因此|其中|即|本题|该题|故|解析可知)/.test(clean)) return false;
  if (/[？?]$/.test(clean) || /[（(]\s*[）)]/.test(clean)) return true;
  if (/^(?:下列|以下|关于|根据|在|当|为了|某|用|一个|一台|串行|金属|仪表|控制|应急|进入|高处|放射|动火)/.test(clean)) return true;
  if (context.typeHint === 'judge') return true;
  if (paragraph.numId && paragraph.numId !== '0' && paragraph.level === 0) return true;
  return context.typeHint && clean.length >= 10;
}

function isStrongQuestionCue(text) {
  const clean = normalizeOneLine(text);
  if (/[？?]$/.test(clean) || /[（(]\s*[）)]/.test(clean)) return true;
  return /^(?:题目|题干|问题)\s*[:：]|^(?:下列|以下|关于|根据|在|当|为了|某|用|一个|一台|串行|金属|仪表|控制|应急|进入|高处|放射|动火|什么|如何|为什么|简述|说明)/.test(clean);
}

function looksLikeQuestionContinuation(text, current) {
  const clean = normalizeOneLine(text);
  const questionText = cleanQuestionText(current && current.questionParts);
  if (!clean || !questionText) return false;

  if (/^(?:和|与|及|或|以及|并|且|其中|即|分别|包括|由|是|为|的|可|应|需|需要|以及其)/.test(clean)) return true;
  if (/[，,：:、（(]$/.test(questionText)) return true;
  if (/(?:和|与|及|或|包括|分为|由|是|为|有|如下|下列|以下)$/.test(questionText)) return true;
  if (!/[。！？?；;]$/.test(questionText) && /[？?]$/.test(clean)) return true;
  if (questionText.length < 16 && !isListStart(clean) && /(?:是什么|有哪些|如何|为什么|是否|能否|怎样|何种|何时|何处|多少|几种|哪些)[？?]?$/.test(clean)) return true;
  return false;
}

function inferUnlabeledShortAnswer(text, current, mode) {
  const rejected = { isAnswer: false, confidence: 0, reason: '' };
  if (!current || mode !== 'question' || current.options.length || current.answer.length || current.answerTextParts.length) return rejected;

  const questionText = cleanQuestionText(current.questionParts);
  const clean = normalizeOneLine(text);
  if (!questionText || !clean) return rejected;

  if (current.displayTypeLabel === '填空题' && hasBlankPlaceholder(questionText) &&
      !hasBlankPlaceholder(clean) && !isStrongQuestionCue(clean) &&
      !/^(?:第?\d+题|[A-L][.、．:：)）]|(?:正确答案|标准答案|参考答案|答案|答|解析|说明)\s*[:：])/i.test(clean)) {
    return { isAnswer: true, confidence: 0.98, reason: '填空题下一行无标签答案' };
  }

  // 显式边界优先于智能推断。选项标签也必须先交给结构解析器。
  if (/^(?:题目|题干|问题|选项|正确答案|标准答案|答案|参考答案|答案解析|试题解析|解析|说明)\s*[:：]/.test(clean)) return rejected;
  const explicitShortQuestion = current.typeHint === 'short' || isStrongShortQuestion(questionText);
  if (!explicitShortQuestion) return rejected;
  if ((current.typeHint === 'short' || isStrongShortQuestion(questionText)) &&
      (/^[A-L]\s*[.、．:：)）]/i.test(clean) || isMappingAnswerLine(clean, questionText))) {
    return { isAnswer: true, confidence: 0.96, reason: '简答题字母要点或字母含义映射' };
  }
  if (/^[A-L]\s*[.、．:：)）]/i.test(clean)) return rejected;
  if (looksLikeQuestionContinuation(clean, current)) return rejected;
  if (isStrongQuestionCue(clean)) return rejected;

  let score = 0;
  const reasons = [];
  const explicitShort = current.typeHint === 'short';
  const questionEnded = /[？?]\s*$/.test(questionText);
  const sentenceEnded = /[。！!]\s*$/.test(questionText);
  const shortCue = explicitShortQuestion;
  const labeledQuestion = /题干标签/.test(current.boundarySource || '');
  const listAnswer = isListStart(clean);
  const answerOpening = /^(?:是指|是|指|包括|主要包括|由|有|可分为|分为|应|需要|需|其|答|原因是|措施有|特点是|作用是)/.test(clean);
  const nounAnswer = clean.length <= 80 &&
    /(?:说明书|规格表|一览表|接线表|布置图|安装图|配管图|流程图|示意图|记录表|清单|台账|规程|设备|材料|文件|记录|措施|步骤|方法|内容|要求|规定|系统|装置|工具|仪器|仪表|故障|误差|原因|等)$/.test(clean);

  if (explicitShort) { score += 3; reasons.push('当前题型为简答题'); }
  if (questionEnded) { score += 2; reasons.push('题干以问号结束'); }
  if (sentenceEnded && explicitShort) { score += 1; reasons.push('简答题题干已形成完整句子'); }
  if (shortCue) { score += 2; reasons.push('题干包含简答提问词'); }
  if (labeledQuestion) { score += 1; reasons.push('题干带有题目标签'); }
  if (listAnswer) { score += 3; reasons.push('下一段为编号要点'); }
  if (answerOpening) { score += 2; reasons.push('下一段具有答案句式'); }
  if (nounAnswer && explicitShort) { score += 2; reasons.push('下一段为简答要点名词'); }
  if (clean.length >= 12 && !/[？?]$/.test(clean)) { score += 1; reasons.push('下一段更像陈述答案'); }

  return {
    isAnswer: score >= 4,
    confidence: Math.min(0.95, Math.max(0.5, score / 10)),
    reason: reasons.join('、')
  };
}

function shouldTreatAsAnswerContinuation(text, current, mode, context, paragraph, continuationFlags = {}) {
  if (!current || !['reference', 'analysis', 'answer'].includes(mode)) return false;
  const clean = normalizeOneLine(text);
  const questionText = cleanQuestionText(current.questionParts);
  const shortAnswerContext = current.typeHint === 'short' || isStrongShortQuestion(questionText) || current.answerBoundarySource === '显式参考答案标签';
  // 先保留连续 A/B/C/D 结构，再由 finalize 判断它究竟是选择题选项，
  // 还是简答题中的字母要点。旧逻辑先按“简答续行”吞掉，导致多选题
  // 的选项和末尾 ABCD 答案全部进入参考答案框。
  if (matchOptionLine(clean, current)) return false;
  if ((mode === 'reference' || mode === 'answer') && shortAnswerContext && /^[A-L]\s*[.、．:：)）]/i.test(clean)) return true;
  if (COUNT_RE.test(clean) || GENERIC_COUNT_RE.test(clean) || BROKEN_COUNT_RE.test(clean) || NUMBERED_TYPE_RE.test(clean) || BRACKET_TYPE_RE.test(clean) || TYPED_RE.test(clean) || /^(?:题目|题干|问题)\s*[:：]/.test(clean)) return false;
  const possibleHeader = classifyHeader(clean, paragraph && paragraph.style);
  if (possibleHeader && (possibleHeader.kind === 'type' || possibleHeader.kind === 'level')) return false;
  if (possibleHeader && possibleHeader.kind === 'category' && ((paragraph && paragraph.style) || /(?:知识|控制阀|安全环保|管理|基础|专业|法规|标准|实操)$/.test(clean))) return false;

  const noPunctuationStart = NO_PUNCT_NUMBER_RE.exec(clean);
  if (noPunctuationStart && isComplete(current)) {
    const nextNumber = Number(noPunctuationStart[1]);
    const currentNumber = Number(current.number);
    const body = normalizeOneLine(noPunctuationStart[2]);
    const boundaryCue = /[：:？?]$|[（(]\s*[）)]|^(?:下列|以下|关于|根据|在|当|为了|某|用|一个|一台|仪表|控制|应急|进入|高处|放射|动火|更换|安装|检查|校验|简述|说明)/.test(body);
    if (Number.isFinite(currentNumber) && nextNumber === currentNumber + 1 && boundaryCue) return false;
  }

  for (const pattern of QUESTION_RES) {
    const match = pattern.exec(clean);
    if (!match) continue;
    const nextNumber = Number(match[1]);
    const currentNumber = Number(current.number);
    const shortAnswerMode = (mode === 'reference' || mode === 'answer') && (current.typeHint === 'short' || !current.options.length);
    if (shortAnswerMode) {
      let numberedItems = [];
      if (continuationFlags.enhancedNumberedAnswerContinuation) {
        current.answerTextParts.forEach(part => {
          const value = normalizeOneLine(part);
          const itemRe = /(?:^|[；;。！？!?]\s*)(\d{1,3})\s*[.、．)）](?=\s*[\u3400-\u9fffA-Za-z（(])/g;
          let itemMatch;
          while ((itemMatch = itemRe.exec(value))) {
            const number = Number(itemMatch[1]);
            if (number >= 1) numberedItems.push(number);
          }
        });
      } else {
        numberedItems = current.answerTextParts
          .map(part => /^\s*(\d+)\s*[.、．)）]/.exec(normalizeOneLine(part)))
          .filter(Boolean)
          .map(item => Number(item[1]))
          .filter(number => number >= 1);
      }
      // PDF 和“Word 自动编号答案附录”试卷启用增强续行：简答答案可能先列 1~10，
      // 再另起 1~8；也可能 PDF 把“2）”留在上一行而下一行从“3）”开始。
      // 其他既有格式仍维持 v2.0.5 的最大编号判断，降低回归面。
      const lastItem = numberedItems.length ? (continuationFlags.enhancedNumberedAnswerContinuation
        ? numberedItems[numberedItems.length - 1] : Math.max(...numberedItems)) : 0;
      const sequential = (lastItem === 0 && nextNumber === 1) || (lastItem > 0 && nextNumber === lastItem + 1);
      const explicitNewQuestion = /^(?:题目|题干|问题)\s*[:：]|[？?]|[（(]\s*[）)]|单选题|多选题|判断题|简答题|问答题|实操题|论述题|填空题|计算题|画图题|绘图题|作图题|【判断】|【判断题】/.test(match[2]);
      if (sequential && !explicitNewQuestion) return true;
    }
    if (isStrongQuestionCue(match[2])) return false;
    if (Number.isFinite(currentNumber) && currentNumber > 0 && nextNumber === currentNumber + 1) return false;
  }

  // 简答题参考答案中，未编号的“说明书、规格表、安装图”等名词条目
  // 虽然可能以“仪表”等题干高频词开头，仍应保留在当前答案中。
  // 这里只放宽短名词条目，不放宽带问号、填空括号或明显提问词的新题。
  const explicitShortAnswer = (mode === 'reference' || mode === 'answer') &&
    current.typeHint === 'short' && current.questionParts.length > 0;
  if (explicitShortAnswer) {
    const asksQuestion = /[？?]/.test(clean) || /[（(]\s*[）)]/.test(clean) ||
      /(?:什么|哪些|如何|为什么|是否|能否|下列|以下|简述|说明一下|要求回答)/.test(clean);
    const nounItem = clean.length <= 60 &&
      /(?:说明书|规格表|一览表|接线表|布置图|安装图|配管图|流程图|示意图|记录表|清单|台账|规程|设备|材料|文件|记录|措施|步骤|方法|内容|要求|规定|系统|装置|工具|仪器|仪表|等)$/.test(clean);
    if (!asksQuestion && nounItem) return true;
  }

  if (mode === 'answer') {
    const questionText = cleanQuestionText(current.questionParts);
    const looksShort = current.typeHint === 'short' || /(?:什么|简述|说明|哪些|如何|为什么|规定|要求|步骤|内容)[？?]?$/.test(questionText);
    if (!looksShort) return false;
  }

  if (/^(?:因为|由于|其中|即|所以|因此|说明|注意|另外|同时|并且|且|或)/.test(clean)) return true;
  if (isListStart(clean)) return !isStrongQuestionCue(clean);

  const previousParts = mode === 'analysis' ? current.analysisParts : current.answerTextParts;
  const previous = previousParts.length ? previousParts[previousParts.length - 1] : '';
  if (/[，,；;：:]$/.test(previous)) return true;

  if (mode === 'analysis') {
    if (current.typeHint === 'judge' && clean.length >= 5) return false;
    return !isStrongQuestionCue(clean);
  }

  if ((mode === 'reference' || mode === 'answer') && (current.typeHint === 'short' || !current.options.length) && !isStrongQuestionCue(clean)) return true;
  return false;
}
function consumeInlineAnswer(current, content, allowImplicit) {
  const extracted = extractInlineAnswer(content, allowImplicit);
  current.answer.push(...extracted.answers);
  current.answerSources.push(...extracted.sources);
  return extracted.text;
}

function extractEmbeddedFillAnswers(value = '') {
  const source = normalizeText(value || '');
  if (!source) return { question: source, answers: [] };
  const pairs = { '（': '）', '(': ')', '【': '】', '[': ']' };
  const stack = [];
  const ranges = [];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (pairs[char]) { stack.push({ char, start: index }); continue; }
    if ((char === '）' || char === ')' || char === '】' || char === ']') && stack.length) {
      let openIndex = stack.length - 1;
      while (openIndex >= 0 && pairs[stack[openIndex].char] !== char) openIndex -= 1;
      if (openIndex < 0) continue;
      const open = stack[openIndex];
      stack.splice(openIndex, 1);
      if (openIndex !== 0 || stack.length) continue;
      const answer = source.slice(open.start + 1, index).trim();
      if (!answer || /^(?:[_＿—-]+|\s+)$/.test(answer) || /^(?:√|✓|×|✕|✖|正确|错误|对|错)$/.test(answer)) continue;
      ranges.push({ start: open.start, end: index + 1, answer, open: open.char });
    }
  }
  if (!ranges.length) return { question: source, answers: [] };
  let cursor = 0;
  let question = '';
  const answers = [];
  ranges.forEach(range => {
    question += source.slice(cursor, range.start);
    question += range.open === '（' ? '（　）' : (range.open === '(' ? '( )' : (range.open === '【' ? '【　】' : '[ ]'));
    answers.push(range.answer);
    cursor = range.end;
  });
  question += source.slice(cursor);
  return { question: cleanQuestionText(question), answers };
}

function styledFillFromParagraph(value = '', paragraph = {}) {
  const source = normalizeText(value || '');
  const candidates = unique((paragraph.styleAnswers || []).map(item => normalizeOneLine(item)).filter(item => item && item.length <= 200));
  if (!source || !candidates.length) return { question: source, answers: [] };
  let question = source;
  const answers = [];
  candidates.forEach(candidate => {
    const index = question.indexOf(candidate);
    if (index < 0) return;
    const before = question.slice(0, index);
    const after = question.slice(index + candidate.length);
    question = `${before}（　）${after}`;
    answers.push(candidate);
  });
  return { question: cleanQuestionText(question), answers };
}
function hasEmbeddedFillAnswer(value = '') { return extractEmbeddedFillAnswers(value).answers.length > 0; }
function hasBlankPlaceholder(value = '') { return /[（(]\s*[）)]|_{2,}|＿{2,}|（\s*　+\s*）/.test(normalizeOneLine(value || '')); }
function isCompactChoiceLine(value = '') { return Boolean(splitCompactAnswerOptions(normalizeText(value || ''))); }
function isInlineJudgeLine(value = '') { return /[（(【\[]\s*(?:√|✓|×|✕|✖|正确|错误|对|错)\s*[）)】\]]\s*[,，。；;]?$/.test(normalizeOneLine(value || '')); }
function shouldForceSectionQuestionStart(text, context, current, paragraph, sourceKind = '') {
  const clean = normalizeOneLine(text || '');
  if (!clean || classifyHeader(clean, paragraph && paragraph.style)) return false;
  const label = context.displayTypeLabel || '';
  if (label === '填空题') {
    const embedded = extractEmbeddedFillAnswers(clean);
    const wordLikeParagraphs = /^(?:doc|docx|rtf|odt)$/i.test(sourceKind || '');
    if (wordLikeParagraphs) {
      const currentQuestion = current ? cleanQuestionText(current.questionParts) : '';
      // “题干（ ）”下一段直接写答案时，下一段应作为无标签答案续行；
      // 其余 Word/ODT 段落在明确的填空题章节中均按独立题处理，
      // 包括少数原文没有括号、需要进入异常检查的题目。
      if (current && hasBlankPlaceholder(currentQuestion) && !hasEmbeddedFillAnswer(currentQuestion) &&
          !embedded.answers.length && !isStrongQuestionCue(clean)) return false;
      return true;
    }
    if (!embedded.answers.length) return false;
    // PDF 可能把同一道题拆成多行，保留更保守的句末/多空判断。
    return /[。！？?；;]$/.test(clean) || embedded.answers.length >= 2 || !current;
  }
  if ((context.typeHint === 'single' || context.typeHint === 'multiple') && isCompactChoiceLine(clean)) return true;
  if (context.typeHint === 'judge' && isInlineJudgeLine(clean)) return true;
  if (context.typeHint === 'short' && /(?:正确答案|标准答案|参考答案|答案|答)\s*(?:为|是)?\s*[:：]/.test(clean)) return true;
  return false;
}

function finalize(current, sourceName, useLocalAI = false, sourceKind = '', documentFlags = {}) {
  if (!current) return null;
  let questionText = cleanQuestionText(current.questionParts);
  let inlineShortAnswer = '';

  if (current.displayTypeLabel === '填空题' && !current.answerTextParts.length && !current.answer.length && !current.options.length) {
    const embeddedFill = extractEmbeddedFillAnswers(questionText);
    const wordAppendixNote = Boolean(documentFlags.wordAutoAnswerAppendix) && /_{2,}|＿{2,}/.test(questionText) &&
      embeddedFill.answers.length === 1 && /(?:除外|除非|备注|说明)/.test(embeddedFill.answers[0]);
    // 教师版 Word 试卷里会出现“_______，且不能……（自动中间点除外）”。
    // 括号是说明，不是填空答案；仅在已确认存在 Word 自动编号答案附录的文档中关闭该误判。
    if (embeddedFill.answers.length && !wordAppendixNote) {
      questionText = embeddedFill.question;
      inlineShortAnswer = embeddedFill.answers.join('；');
      current.typeHint = 'short';
      current.answerBoundarySource = current.answerBoundarySource || '填空题括号内答案';
      current.answerBoundaryConfidence = Math.max(Number(current.answerBoundaryConfidence) || 0, 0.99);
      current.answerSources.push('括号内填空答案');
    }
  }

  // Word 中常见“题干？参考答案”被放在同一段且没有“答案”标签。
  // 仅在没有独立答案、没有选项并且具备简答题特征时拆分，避免误切普通题干。
  if (!current.answerTextParts.length && !current.options.length) {
    const split = extractInlineShortAnswer(questionText, current.typeHint);
    if (split.answer) {
      questionText = split.question;
      inlineShortAnswer = split.answer;
      current.answerBoundarySource = current.answerBoundarySource || '题干问号后内联参考答案';
      current.answerBoundaryConfidence = Math.max(current.answerBoundaryConfidence || 0, 0.92);
      current.answerSources.push('题干问号后内联参考答案');
    }
  }

  let preservedBoundaryFailure = false;
  if (!questionText && !current.options.length && !current.answerTextParts.length && !inlineShortAnswer) {
    const explicitBoundary = Boolean(current.number) || (current.boundarySource && current.boundarySource !== '智能推断边界');
    const hasImages = Boolean((current.images || []).length || (current.answerImages || []).length || (current.analysisImages || []).length);
    const meaningfulRaw = (current.rawTexts || [])
      .map(value => normalizeOneLine(value))
      .filter(value => value && !/^\d{1,4}\s*(?:[\[【]\s*)?题\s*(?:[\]】])?$/.test(value) && !/^(?:题|题目|题干|问题)$/.test(value));
    if (!explicitBoundary && !hasImages && !meaningfulRaw.length) return null;
    questionText = meaningfulRaw.join(' ') || (hasImages ? '【图片题：题干文字未识别】' : '【题干文字未识别】');
    preservedBoundaryFailure = true;
  }

  const options = current.options.map(item => {
    const images = unique(item.images || []);
    const rawText = cleanQuestionText(item.parts);
    return {
      key: item.key,
      text: images.length && isGenericVisualPlaceholder(rawText) ? '' : rawText,
      images
    };
  });
  // 同一类教师版 Word 里还有“A 文本 B 文本 C 文本 D 文本”的无标点同行选项。
  // 前置循环可能已把整行暂存进 A，同时又补出 B/C/D；在 finalize 内按原 A 文本重建一次，
  // 只影响已经确认带 Word 自动编号答案附录的文档。
  if (documentFlags.wordAutoAnswerAppendix && options.length >= 3 && options[0] && options[0].key === 'A') {
    const bareABCD = /^(.+?)\s+B\s+(.+?)\s+C\s+(.+?)\s+D\s+(.+?)$/i.exec(normalizeOneLine(options[0].text || ''));
    if (bareABCD) {
      const imageByKey = new Map(options.map(item => [item.key, unique(item.images || [])]));
      options.splice(0, options.length,
        { key: 'A', text: cleanQuestionText(bareABCD[1]), images: imageByKey.get('A') || [] },
        { key: 'B', text: cleanQuestionText(bareABCD[2]), images: imageByKey.get('B') || [] },
        { key: 'C', text: cleanQuestionText(bareABCD[3]), images: imageByKey.get('C') || [] },
        { key: 'D', text: cleanQuestionText(bareABCD[4]), images: imageByKey.get('D') || [] }
      );
      current.answerSources.push('Word无标点同行选项最终重建');
    }
  }

  let answer = unique(current.answer);

  // 只对“已确认存在 Word 自动编号答案附录”的教师版试卷启用：
  // 部分前半段选择题把正确答案直接写在题干括号里，例如“流动方向是（B）”。
  // 先恢复这些明确答案，后续文末 1~12 的集中答案才会自然落到真正未作答的 16~27 题。
  if (documentFlags.wordAutoAnswerAppendix && !answer.length && options.length >= 2 && current.typeHint !== 'judge' && current.typeHint !== 'short') {
    const bracketMatches = [...questionText.matchAll(/[（(]\s*([A-L])\s*[）)]/ig)];
    if (bracketMatches.length === 1) {
      const letter = String(bracketMatches[0][1] || '').toUpperCase();
      if (options.some(item => item.key === letter)) {
        answer = [letter];
        questionText = questionText.replace(/（\s*[A-L]\s*）/i, '（ ）').replace(/\(\s*[A-L]\s*\)/i, '( )');
        current.answerSources.push('Word题干括号答案');
        current.answerBoundarySource = current.answerBoundarySource || 'Word题干括号答案';
        current.answerBoundaryConfidence = Math.max(Number(current.answerBoundaryConfidence) || 0, 0.99);
      }
    }
  }

  // 同一类试卷的最后一道判断题把“错”直接跟在空括号后：……（ ）错。
  // 仅在判断题上下文和该特殊文档结构下拆出答案，避免影响普通题干中的“对/错”字样。
  if (documentFlags.wordAutoAnswerAppendix && !answer.length && current.typeHint === 'judge') {
    const trailingJudge = /^(.*?[（(]\s*[）)])\s*(正确|错误|对|错)\s*[。．.]?$/.exec(questionText);
    if (trailingJudge) {
      questionText = cleanQuestionText(trailingJudge[1]);
      answer = /^(?:正确|对)$/.test(trailingJudge[2]) ? ['A'] : ['B'];
      current.answerSources.push('Word题干尾随判断答案');
      current.answerBoundarySource = current.answerBoundarySource || 'Word题干尾随判断答案';
      current.answerBoundaryConfidence = Math.max(Number(current.answerBoundaryConfidence) || 0, 0.99);
    }
  }

  // matchOptionLine 会先吃掉以 A 开头的整行；若 A 文本中仍包含 B.错误，
  // 在最终定型前再次拆成标准判断题两项。
  if (options.length >= 1) {
    const pair = splitInlineJudgePair(`${options[0].key}.${options[0].text}`);
    if (pair && pair.length === 2) {
      options.splice(0, options.length,
        { key: 'A', text: pair[0].value, images: unique(options[0].images || []) },
        { key: 'B', text: pair[1].value, images: [] }
      );
      current.answerSources.push('连写对错选项自动拆分');
    }
  }

  // PDF/Word 共用的最终结构修复：
  // A. 二氧化碳B. 干粉C. 泡沫 -> A/B/C 三个独立选项。
  // 放在 finalize 做末端兜底，避免不同文件格式在前置提取阶段表现不同。
  if (repairCollapsedChoiceOptions(options, answer, questionText, current.typeHint)) {
    current.answerSources.push('紧凑连写选项自动拆分');
  }
  if (documentFlags.wordAutoAnswerAppendix && options.length >= 3 && options[0] && options[0].key === 'A') {
    const bareABCD = /^(.+?)\s+B\s+(.+?)\s+C\s+(.+?)\s+D\s+(.+?)$/i.exec(normalizeOneLine(options[0].text || ''));
    if (bareABCD) {
      const imageByKey = new Map(options.map(item => [item.key, unique(item.images || [])]));
      options.splice(0, options.length,
        { key: 'A', text: cleanQuestionText(bareABCD[1]), images: imageByKey.get('A') || [] },
        { key: 'B', text: cleanQuestionText(bareABCD[2]), images: imageByKey.get('B') || [] },
        { key: 'C', text: cleanQuestionText(bareABCD[3]), images: imageByKey.get('C') || [] },
        { key: 'D', text: cleanQuestionText(bareABCD[4]), images: imageByKey.get('D') || [] }
      );
      current.answerSources.push('Word无标点同行选项最终重建');
    }
  }

  // 某些 Word 同行选项要到上一步的末端修复后才形成完整 A/B/C/D，
  // 因此再给“题干括号答案”一次机会（例如“测 4~20mA……（D）”）。
  if (documentFlags.wordAutoAnswerAppendix && !answer.length && options.length >= 2 && current.typeHint !== 'judge' && current.typeHint !== 'short') {
    const bracketMatches = [...questionText.matchAll(/[（(]\s*([A-L])\s*[）)]/ig)];
    if (bracketMatches.length === 1) {
      const letter = String(bracketMatches[0][1] || '').toUpperCase();
      if (options.some(item => item.key === letter)) {
        answer = [letter];
        questionText = questionText.replace(/（\s*[A-L]\s*）/i, '（ ）').replace(/\(\s*[A-L]\s*\)/i, '( )');
        current.answerSources.push('Word题干括号答案');
        current.answerBoundarySource = current.answerBoundarySource || 'Word题干括号答案';
        current.answerBoundaryConfidence = Math.max(Number(current.answerBoundaryConfidence) || 0, 0.99);
      }
    }
  }
  const optionTexts = options.map(item => normalizeOneLine(item.text));
  const truthValueForType = value => {
    const clean = normalizeOneLine(value || '').toUpperCase();
    if (/^(?:正确|对|是|√|✓|✔|TRUE|T)$/.test(clean)) return true;
    if (/^(?:错误|错|否|×|✕|✖|❌|FALSE|F)$/.test(clean)) return false;
    return null;
  };
  const judgeValues = optionTexts.map(truthValueForType);
  const looksJudge = options.length === 2 && judgeValues.includes(true) && judgeValues.includes(false);

  let type;
  // 题型标签只能由解析阶段记录的 typeHint 决定，绝不能在整段原文里搜索
  // “判断”二字；否则 D.不能判断、判断故障等普通选项会把选择题误判成判断题。
  const explicitJudgeLabel = current.typeHint === 'judge';
  const explicitShortLabel = current.typeHint === 'short';
  const explicitSingleLabel = current.typeHint === 'single';
  const explicitMultipleLabel = current.typeHint === 'multiple';
  const truthAnswerEvidence = current.rawTexts.some(raw => {
    const clean = normalizeOneLine(raw);
    const match = /(?:正确答案|标准答案|参考答案|答案|答)\s*(?:为|是)?\s*[:：]\s*(.+)$/.exec(clean);
    return Boolean(match && isJudgementAnswerValue(match[1]));
  });
  const hasProseAnswer = current.answerTextParts.length > 0 || Boolean(inlineShortAnswer);
  const strongShort = isStrongShortQuestion(questionText);

  // 最终题型以“实际选项结构 + 实际答案数量”为最高优先级：
  // 1 个字母答案只能是单选（判断题除外）；2 个及以上字母答案必为多选。
  // Word 标题写错时保留异常提示，但不再让错误标题覆盖真实答案结构。
  if (explicitShortLabel && !answer.length) {
    type = 'short';
  } else if (options.length >= 2 && answer.length >= 2) {
    type = 'multiple';
  } else if (options.length >= 2 && answer.length === 1) {
    type = looksJudge || truthAnswerEvidence ? 'judge' : 'single';
  } else if (truthAnswerEvidence || (looksJudge && answer.length <= 1)) {
    type = 'judge';
  } else if (options.length >= 2) {
    if (looksJudge || explicitJudgeLabel) type = looksJudge ? 'judge' : 'single';
    else if (explicitMultipleLabel) type = 'multiple';
    else type = 'single';
  } else if (options.length === 1) {
    const onlyTruth = truthValueForType(options[0].text);
    if (onlyTruth !== null || truthAnswerEvidence || explicitJudgeLabel) type = 'judge';
    else if (answer.length >= 2) type = 'multiple';
    else type = explicitMultipleLabel && !answer.length ? 'multiple' : 'single';
  } else if (explicitShortLabel || hasProseAnswer || strongShort) {
    type = 'short';
  } else if (explicitJudgeLabel) {
    type = 'judge';
  } else if (explicitMultipleLabel && answer.length >= 2) {
    type = 'multiple';
  } else {
    type = explicitSingleLabel ? 'single' : (current.typeHint || 'single');
    if (type === 'multiple' && answer.length === 1) type = 'single';
  }

  if (explicitMultipleLabel && answer.length === 1) {
    current.answerSources.push('原题标注多选但仅一项答案，按单选处理');
  }
  if (explicitJudgeLabel && options.length >= 2 && !looksJudge) {
    current.answerSources.push('原题标注判断但选项并非对错，按答案数量重判');
  }

  if (type === 'judge') {
    const truthValue = value => {
      const clean = normalizeOneLine(value || '').toUpperCase();
      if (/^(?:正确|对|是|√|✓|✔|TRUE|T)$/.test(clean)) return true;
      if (/^(?:错误|错|否|×|✕|✖|❌|FALSE|F)$/.test(clean)) return false;
      return null;
    };

    if (options.length === 1) {
      const only = options[0];
      const semantic = truthValue(only.text);
      options.splice(0, options.length,
        { key: 'A', text: '正确', images: [] },
        { key: 'B', text: '错误', images: [] }
      );
      if (!answer.length && semantic !== null) {
        answer.push(semantic ? 'A' : 'B');
        current.answerSources.push('单个对错行自动补齐');
      }
    } else if (options.length === 0) {
      options.push({ key: 'A', text: '正确', images: [] }, { key: 'B', text: '错误', images: [] });
    } else if (options.length === 2 && options.every(item => truthValue(item.text) !== null)) {
      const truthItem = options.find(item => truthValue(item.text) === true);
      const falseItem = options.find(item => truthValue(item.text) === false);
      // 两个完整对错选项但没有答案时不能猜测，交给异常检查。
      options.splice(0, options.length,
        { key: 'A', text: '正确', images: [] },
        { key: 'B', text: '错误', images: [] }
      );
      if (answer.length) {
        const selectedText = answer.map(key => {
          const original = [truthItem, falseItem].find(item => item && item.key === key);
          return original ? truthValue(original.text) : null;
        });
        if (selectedText.some(value => value !== null)) {
          answer.splice(0, answer.length, ...unique(selectedText.filter(value => value !== null).map(value => value ? 'A' : 'B')));
        }
      }
    }
  }

  let finalQuestionText = questionText;
  let finalAnswerText = cleanAnswerText(current.answerTextParts.length ? current.answerTextParts : [inlineShortAnswer]);
  const blankPlaceholderCount = (questionText.match(/[（(【\[]\s*(?:　|_|＿|\s)*[）)】\]]|_{2,}|＿{2,}/g) || []).length;
  const blankAnswers = current.displayTypeLabel === '填空题' ? splitFillAnswerText(finalAnswerText, blankPlaceholderCount) : [];
  if (type === 'short' && options.length) {
    if (!finalAnswerText) finalAnswerText = cleanAnswerText(options.map(item => `${item.key}. ${item.text}`));
    options.splice(0, options.length);
    answer.splice(0, answer.length);
    current.answerSources.push('简答题字母要点恢复为参考答案');
  }
  if (type === 'short') {
    const match = /(.*?[？?])(\s*)([^？?]{10,})$/.exec(finalQuestionText);
    if (match && !finalAnswerText) {
      const trailing = normalizeOneLine(match[3]);
      const looksAnswer = trailing && !/[（(]\s*[）)]/.test(trailing) &&
        /^(?:仪表|电路|设备|系统|控制|表示|说明|是|指|由|有|应|需|需要|主要|包括|如果|在|当|1[、.)）]|①|原因|措施|步骤|内容|要求|规定)/.test(trailing);
      if (looksAnswer) {
        finalQuestionText = cleanQuestionText(match[1]);
        finalAnswerText = cleanAnswerText([match[3]]);
        current.answerBoundarySource = current.answerBoundarySource || '问号后答案自动拆分';
        current.answerBoundaryConfidence = Math.max(Number(current.answerBoundaryConfidence) || 0, 0.88);
        current.answerSources.push('题干问号后答案');
      }
    }
  }

  const defaultDisplayTypeLabel = type === 'single' ? '单选题' : (type === 'multiple' ? '多选题' : (type === 'judge' ? '判断题' : '简答题'));
  let displayTypeLabel = defaultDisplayTypeLabel;
  if (current.displayTypeLabel) {
    const explicitMeta = typeMetaFromLabel(current.displayTypeLabel);
    if (explicitMeta.type === type) displayTypeLabel = explicitMeta.label;
  }

  const originalRawTexts = current.rawTexts.slice(0, 20);
  const combinedRawText = originalRawTexts.join(' ');
  const repairedCombinedRawText = repairKnownEngineeringNotation(combinedRawText);
  // 已经通过完整题干语义可靠修复时，原始 PDF 碎片中的替换字符不应再次把题目标成异常。
  const sourceRawTexts = sourceKind === 'pdf' && repairedCombinedRawText !== combinedRawText && !hasEncodingAnomaly(finalQuestionText)
    ? [finalQuestionText]
    : originalRawTexts;

  const result = {
    id: current.id,
    number: current.number,
    level: current.level || '',
    category: current.category || '未分类',
    chapter: current.chapter || '',
    type,
    displayTypeLabel,
    sourceTypeLabel: current.displayTypeLabel || '',
    typeHint: current.typeHint || '',
    typeEvidence: current.boundarySource || '',
    question: finalQuestionText,
    options,
    answer,
    answerText: finalAnswerText,
    blankAnswers,
    analysis: cleanAnalysisText(current.analysisParts),
    images: unique(current.images),
    answerImages: unique(current.answerImages || []),
    analysisImages: unique(current.analysisImages || []),
    boundarySource: current.boundarySource || '未知',
    answerSource: unique(current.answerSources).join('、'),
    answerBoundarySource: current.answerBoundarySource || '',
    answerBoundaryConfidence: current.answerBoundaryConfidence || 0,
    difficulty: current.difficulty || '',
    knowledgePoint: current.knowledgePoint || '',
    material: current.material || '',
    materialImages: unique(current.materialImages || []),
    inferredBoundary: current.inferredBoundary,
    source: {
      fileName: sourceName || '',
      kind: sourceKind || '',
      paragraphIndexes: unique(current.sourceParagraphs),
      rawTexts: sourceRawTexts
    }
  };

  const assisted = useLocalAI ? localAI.assistQuestion(result) : result;
  const duplicateRepaired = repairOptionDuplicates(assisted, documentFlags);
  const repaired = repairKnownConvertedDocxOptions(duplicateRepaired);
  const validation = validateQuestion(repaired);
  if (preservedBoundaryFailure) {
    return Object.assign(repaired, validation, {
      preservedBoundaryFailure: true,
      issues: unique([...(validation.issues || []), '题目边界已检测，但题干文字未完整识别']),
      confidence: Math.min(Number(validation.confidence) || 0, 0.2),
      status: 'error'
    });
  }
  return Object.assign(repaired, validation);
}

function createSourceMissingPlaceholder(section, number, sourceName) {
  const type = section.typeHint || 'single';
  const typeLabel = section.displayTypeLabel || (type === 'judge' ? '判断题' : (type === 'multiple' ? '多选题' : (type === 'short' ? '简答题' : '单选题')));
  return {
    id: createId('missing'),
    number: String(number),
    level: section.level || '',
    category: section.category || '未分类',
    chapter: section.chapter || '',
    type,
    displayTypeLabel: typeLabel,
    sourceTypeLabel: typeLabel,
    typeHint: type,
    typeEvidence: '章节声明缺失占位',
    question: `【原文缺少内容：${typeLabel}第 ${number} 题】`,
    options: [],
    answer: [],
    answerText: '',
    analysis: `章节标题“${section.heading}”声明应包含第 ${number} 题，但 Word 正文中没有找到对应题干、选项或答案。此记录仅用于数量对账，不参与正常练习。`,
    images: [],
    answerImages: [],
    analysisImages: [],
    boundarySource: '章节声明缺失占位',
    answerSource: '',
    answerBoundarySource: '',
    answerBoundaryConfidence: 0,
    inferredBoundary: false,
    sourceMissingPlaceholder: true,
    nonPractice: true,
    source: {
      fileName: sourceName || '',
      paragraphIndexes: section.paragraphIndex === undefined ? [] : [section.paragraphIndex],
      rawTexts: [section.heading || '']
    },
    issues: [`原文声明存在第 ${number} 题，但正文缺少该题内容`],
    confidence: 0,
    status: 'error'
  };
}

function reconcileDeclaredSections(questions = [], sections = [], sourceName = '') {
  const output = [];
  const missingItems = [];
  const extraItems = [];
  let cursor = 0;

  (sections || []).forEach(section => {
    const start = Math.max(cursor, Number(section.startQuestionIndex) || 0);
    const end = Math.max(start, Number(section.endQuestionIndex) || start);
    output.push(...questions.slice(cursor, start));
    const sectionQuestions = questions.slice(start, end);
    const numbers = sectionQuestions
      .map(item => Number(item.number))
      .filter(value => Number.isInteger(value) && value >= 1 && value <= 9999);
    const numberSet = new Set(numbers);
    const expectedCount = Number(section.expectedCount) || 0;
    const missingNumbers = [];
    if (expectedCount > 0 && numbers.some(value => value >= 1 && value <= expectedCount)) {
      for (let number = 1; number <= expectedCount; number += 1) {
        if (!numberSet.has(number)) missingNumbers.push(number);
      }
    }
    const augmented = sectionQuestions.slice();
    missingNumbers.forEach(number => {
      const placeholder = createSourceMissingPlaceholder(section, number, sourceName);
      let insertAt = augmented.findIndex(item => {
        const value = Number(item.number);
        return Number.isInteger(value) && value > number;
      });
      if (insertAt < 0) insertAt = augmented.length;
      augmented.splice(insertAt, 0, placeholder);
      missingItems.push({
        level: section.level || '',
        category: section.category || '',
        chapter: section.chapter || '',
        type: section.typeHint || '',
        number,
        heading: section.heading || '',
        message: `${section.level || ''}${section.category ? ` · ${section.category}` : ''} · ${section.heading || ''}：原文缺少第 ${number} 题正文`
      });
    });
    numbers.filter(value => expectedCount > 0 && value > expectedCount).forEach(number => {
      extraItems.push({
        level: section.level || '',
        category: section.category || '',
        type: section.typeHint || '',
        number,
        heading: section.heading || '',
        message: `${section.heading || ''}声明共 ${expectedCount} 题，但正文另有第 ${number} 题`
      });
    });
    output.push(...augmented);
    cursor = end;
  });
  output.push(...questions.slice(cursor));
  return { questions: output, missingItems, extraItems };
}

function analyzeNumbering(questions = []) {
  const issues = [];
  const lastByGroup = {};
  (questions || []).forEach((item, index) => {
    const number = Number(item.number);
    if (!Number.isInteger(number) || number < 1 || number > 9999) return;
    const group = [item.level || '', item.category || '', item.chapter || ''].join('|');
    const previous = lastByGroup[group];
    if (!previous || number === 1 || number <= previous.number) {
      lastByGroup[group] = { number, order: index + 1 };
      return;
    }
    const gap = number - previous.number - 1;
    if (gap > 0 && gap <= 50) {
      issues.push({
        group,
        afterOrder: previous.order,
        beforeOrder: index + 1,
        from: previous.number + 1,
        to: number - 1,
        count: gap,
        message: gap === 1 ? `题号可能缺少 ${previous.number + 1}` : `题号可能缺少 ${previous.number + 1}-${number - 1}`
      });
    }
    lastByGroup[group] = { number, order: index + 1 };
  });
  return {
    gapCount: issues.reduce((sum, item) => sum + item.count, 0),
    issues: issues.slice(0, 80)
  };
}

function markDuplicates(questions) {
  const firstBySignature = {};
  let duplicateCount = 0;
  questions.forEach(question => {
    const optionPart = (question.options || []).map(item => item.text).join('|');
    const signature = compactText(`${question.question}|${optionPart}`);
    if (signature.length < 8) return;
    if (firstBySignature[signature]) {
      question.duplicateOf = firstBySignature[signature].id;
      question.issues = unique([...(question.issues || []), `疑似与第 ${firstBySignature[signature].order || '?'} 题重复`]);
      question.status = question.status === 'error' ? 'error' : 'warning';
      question.confidence = Math.max(0, Number(((question.confidence || 1) - 0.18).toFixed(2)));
      duplicateCount += 1;
    } else {
      firstBySignature[signature] = question;
    }
  });
  return duplicateCount;
}

function isWorkingEmpty(current) {
  return Boolean(current) && !current.questionParts.length && !current.options.length && !current.answer.length && !current.answerTextParts.length && !current.analysisParts.length;
}

function simpleQuestionNumber(value = '') {
  const clean = normalizeOneLine(value || '');
  let match = /^\s*(?:第\s*)?(\d{1,4})\s*(?:题)?\s*[.、．:：)）-]/.exec(clean);
  if (match) return Number(match[1]);
  // 题库常见“1/39[单选题]”“1/17 判断题”“12 [简答题]”也都是强题号。
  // 材料块遇到这些边界必须结束，否则一次误触会吞掉后续整章题目。
  match = /^\s*(\d{1,4})\s*\/\s*\d{1,4}\s*(?:[\[【]?\s*(?:单选题|单项选择题|单选|多选题|多项选择题|多选|选择题|判断题|判断|简答题|问答题|实操题|论述题|填空题|计算题|画图题|绘图题|作图题|匹配题|配对题|排序题|顺序题|材料题|案例题|题)\s*[\]】]?)?/.exec(clean);
  if (match) return Number(match[1]);
  match = /^\s*(\d{1,4})\s*(?:[\[【]\s*)?(?:单选题|单项选择题|单选|多选题|多项选择题|多选|选择题|判断题|判断|简答题|问答题|实操题|论述题|填空题|计算题|画图题|绘图题|作图题|匹配题|配对题|排序题|顺序题|材料题|案例题)(?:\s*[\]】])?/.exec(clean);
  if (match) return Number(match[1]);
  match = /^\s*(\d{1,4})\s*[（(\[【]/.exec(clean);
  return match ? Number(match[1]) : 0;
}

function annotateMaterialParagraphs(sourceParagraphs = []) {
  const result = (sourceParagraphs || []).map(item => Object.assign({}, item));
  let activeMaterial = '';
  let activeMaterialImages = [];
  let collecting = false;
  let endNumber = 0;
  result.forEach(item => {
    const clean = normalizeOneLine(item.text || '');
    const explicitMaterialLabel = /^(?:材料|案例|背景资料)\s*[一二三四五六七八九十\d]*\s*[:：]/.test(clean) ||
      /^(?:材料|案例|背景资料)\s*[一二三四五六七八九十\d]+\s*$/.test(clean) ||
      (/^(?:材料|案例|背景资料)\s*$/.test(clean) && /(?:heading|标题|title)/i.test(item.style || ''));
    const materialInstruction = /^(?:阅读材料|阅读以下材料|根据以下材料|根据材料)(?:\s*[一二三四五六七八九十\d]+)?\s*(?:[:：]|，|。|$)/.test(clean) ||
      /^(?:阅读|根据).{0,20}(?:材料|案例).{0,20}(?:回答|完成|作答)/.test(clean);
    const materialStart = explicitMaterialLabel || materialInstruction;
    if (materialStart && !simpleQuestionNumber(clean)) {
      activeMaterial = clean.replace(/^(?:材料|案例|背景资料)\s*[:：]\s*/, '').trim();
      activeMaterialImages = unique((item.images || []).slice());
      collecting = true;
      const range = /(?:回答|完成|作答)(?:第)?\s*(\d{1,4})\s*(?:[-—–~～至到]|至)\s*(\d{1,4})\s*题/.exec(clean);
      endNumber = range ? Number(range[2]) : 0;
      item.materialOnly = true;
      return;
    }
    const typeHeading = descriptiveTypeHeading(clean);
    const categoryHeading = /^(?:第[一二三四五六七八九十\d]+(?:部分|章|节)|[一二三四五六七八九十]+[、.．]\s*[^\d])/.test(clean);
    if ((typeHeading || categoryHeading) && !collecting) {
      activeMaterial = '';
      activeMaterialImages = [];
      endNumber = 0;
      return;
    }
    const number = simpleQuestionNumber(clean);
    if (number) {
      if (endNumber && number > endNumber) {
        activeMaterial = '';
        activeMaterialImages = [];
        endNumber = 0;
      }
      collecting = false;
      if (activeMaterial) item.materialText = activeMaterial;
      if (activeMaterialImages.length) item.materialImages = activeMaterialImages.slice();
      return;
    }
    if (collecting && clean) {
      activeMaterial = normalizeText([activeMaterial, clean].filter(Boolean).join('\n'));
      activeMaterialImages = unique([...activeMaterialImages, ...(item.images || [])]);
      item.materialOnly = true;
      return;
    }
    if (activeMaterial) item.materialText = activeMaterial;
    if (activeMaterialImages.length) item.materialImages = activeMaterialImages.slice();
  });
  return result;
}
function parseCentralAnswerEntryText(value = '') {
  const clean = normalizeOneLine(value || '');
  const entries = [];
  const range = /^(\d{1,4})\s*(?:[-—–~～至到])\s*(\d{1,4})\s*[:：]?\s*([A-L√✓✔☑×✕✖☒❌TF对错正确错误是否\s,，、;；]+)$/i.exec(clean);
  if (range) {
    const start = Number(range[1]), end = Number(range[2]);
    const values = range[3].replace(/[\s,，、;；]+/g, '').match(/[A-L]|√|✓|✔|☑|×|✕|✖|☒|❌|T|F/g) || [];
    if (end >= start && values.length === end - start + 1) {
      values.forEach((answer, index) => entries.push({ number: start + index, value: answer }));
      return entries;
    }
  }
  const pairRe = /(\d{1,4})\s*[.、．:：)）-]?\s*(√|✓|✔|☑|×|✕|✖|☒|❌|正确|错误|对|错|是|否|[A-L](?:(?:\s*[,，、/\\|]\s*|(?=[A-L]))[A-L])*)/ig;
  let match;
  while ((match = pairRe.exec(clean))) entries.push({ number: Number(match[1]), value: match[2] });
  if (entries.length) return entries;
  // 简答/填空/计算等主观题的文末答案常写成“1. 文本答案”，答案区已由
  // 明确标题锁定，因此这里可以比正文题号识别更积极，但仍要求有分隔符。
  const textEntry = /^(?:第\s*)?(\d{1,4})\s*(?:题)?\s*[.、．:：)）-]\s*(.+)$/.exec(clean);
  if (textEntry && textEntry[2].trim()) entries.push({ number: Number(textEntry[1]), value: textEntry[2].trim() });
  return entries;
}

function answerAppendixTypeLabel(value = '') {
  const clean = normalizeOneLine(value || '');
  if (/^(?:选择题|单选题|单项选择题)$/.test(clean)) return '选择题';
  if (/^(?:多选题|多项选择题|不定项选择题)$/.test(clean)) return /不定项/.test(clean) ? '不定项选择题' : '多选题';
  if (/^(?:判断题|对错题)$/.test(clean)) return '判断题';
  if (/^(?:填空题)$/.test(clean)) return '填空题';
  if (/^(?:简答题|问答题)$/.test(clean)) return '简答题';
  if (/^(?:计算题)$/.test(clean)) return '计算题';
  return '';
}

function extractWordAutoListAnswerAppendix(paragraphs = []) {
  let headingIndex = -1;
  for (let index = 0; index < paragraphs.length; index += 1) {
    const clean = normalizeOneLine(paragraphs[index].text || '');
    // “控制系统参考答案”这类教师版试卷，答案区不是“1.B”文本，而是 Word
    // 自动编号列表：选择题 -> B/B/A/...，填空题 -> 文本，判断题 -> √/×。
    // 必须同时看到后续题型标题和自动编号答案，才启用这条专用解析，避免误伤正文。
    if (!/^.{1,24}(?:参考答案|答案汇总|答案表)\s*[:：]?$/.test(clean) || /^(?:参考答案|标准答案|正确答案)\s*[:：]?$/.test(clean)) continue;
    let typeHeadingCount = 0;
    let autoAnswerCount = 0;
    for (let look = index + 1; look < Math.min(paragraphs.length, index + 24); look += 1) {
      const next = paragraphs[look];
      const label = answerAppendixTypeLabel(next.text || '');
      if (label) { typeHeadingCount += 1; continue; }
      const text = normalizeOneLine(next.text || '');
      if (Number(next.listOrdinal || 0) > 0 && text && text.length <= 120) autoAnswerCount += 1;
    }
    if (typeHeadingCount >= 2 && autoAnswerCount >= 4) { headingIndex = index; break; }
  }
  if (headingIndex < 0) return null;

  const removed = new Set();
  const entries = [];
  let currentTypeLabel = '';
  let shortTopNumId = '';
  let shortEntry = null;

  function flushShort() {
    if (!shortEntry) return;
    const value = cleanAnswerText(shortEntry.parts.join('\n'));
    if (value) entries.push({
      number: shortEntry.number,
      value,
      typeLabel: currentTypeLabel || '简答题',
      sequentialOnly: true,
      appendixSource: 'Word自动编号答案附录'
    });
    shortEntry = null;
  }

  removed.add(paragraphs[headingIndex].index);
  for (let index = headingIndex + 1; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    const clean = normalizeOneLine(paragraph.text || '');
    if (!clean) { removed.add(paragraph.index); continue; }
    const typeLabel = answerAppendixTypeLabel(clean);
    if (typeLabel) {
      flushShort();
      currentTypeLabel = typeLabel;
      shortTopNumId = '';
      removed.add(paragraph.index);
      continue;
    }

    // 答案附录已经位于文末；所有后续段落都属于答案区。若尚未识别题型，
    // 只删除标题后的说明，不制造题目。
    removed.add(paragraph.index);
    if (!currentTypeLabel) continue;

    const ordinal = Number(paragraph.listOrdinal || 0);
    const numId = String(paragraph.numId || '');
    if (currentTypeLabel === '简答题' || currentTypeLabel === '计算题') {
      if (ordinal > 0) {
        if (!shortTopNumId) shortTopNumId = numId;
        if (numId === shortTopNumId) {
          flushShort();
          shortEntry = { number: ordinal, parts: [clean] };
        } else if (shortEntry) {
          shortEntry.parts.push(clean);
        }
      } else if (shortEntry) {
        shortEntry.parts.push(clean);
      }
      continue;
    }

    if (ordinal <= 0) continue;
    entries.push({
      number: ordinal,
      value: clean,
      typeLabel: currentTypeLabel,
      sequentialOnly: true,
      appendixSource: 'Word自动编号答案附录'
    });
  }
  flushShort();
  return { entries, removed, headingIndex };
}

function extractCentralAnswerKeys(sourceParagraphs = []) {
  const paragraphs = (sourceParagraphs || []).map(item => Object.assign({}, item));
  const entries = [];
  const removed = new Set();
  let active = false;
  let currentTypeLabel = '';

  const wordAutoAppendix = extractWordAutoListAnswerAppendix(paragraphs);
  if (wordAutoAppendix) {
    wordAutoAppendix.entries.forEach(item => entries.push(item));
    wordAutoAppendix.removed.forEach(index => removed.add(index));
  }

  function centralHeadingKind(value = '') {
    const clean = normalizeOneLine(value || '');
    if (/^(?:答案汇总|答案表|参考答案汇总|选择题答案|单选题答案|多选题答案|不定项选择题答案|判断题答案|填空题答案|简答题答案|问答题答案|计算题答案|匹配题答案|配对题答案|排序题答案|顺序题答案)\s*[:：]?$/.test(clean)) return 'explicit';
    if (/^(?:参考答案|标准答案|正确答案)\s*[:：]?$/.test(clean)) return 'generic';
    return '';
  }

  function isObjectiveCentralValue(value = '') {
    const clean = normalizeOneLine(value || '');
    if (!clean) return false;
    const parsed = parseCentralAnswerEntryText(clean);
    if (!parsed.length) return false;
    return parsed.every(item => {
      const answer = normalizeOneLine(item.value || '');
      return /^(?:[A-L](?:(?:[,，、/\|\s]?)[A-L])*|√|✓|✔|☑|×|✕|✖|☒|❌|T|F|对|错|正确|错误|是|否)$/i.test(answer);
    });
  }

  function hasStrongGenericCentralEvidence(index) {
    // “参考答案”在很多题库中只是简答题的逐题答案标签。泛化标题只接受
    // 范围答案、同一行多个编号答案，或连续至少 3 条短客观答案。
    let objectiveRows = 0;
    let distinctNumbers = new Set();
    for (let look = index + 1; look < Math.min(paragraphs.length, index + 14); look += 1) {
      if (removed.has(paragraphs[look].index)) continue;
      const next = normalizeOneLine(paragraphs[look].text || '');
      if (!next) continue;
      if (centralHeadingKind(next)) return false;
      if (descriptiveTypeHeading(next)) continue;
      if (/^(?:题目|题干|问题)\s*[:：]/.test(next)) return false;
      const parsed = parseCentralAnswerEntryText(next);
      if (!parsed.length) {
        if (next.length > 12 && !/^(?:第\s*\d+\s*题)?\s*[A-L√✓✔☑×✕✖☒❌TF对错正确错误是否\s,，、;；-]+$/i.test(next)) return false;
        continue;
      }
      if (parsed.length >= 2 && isObjectiveCentralValue(next)) return true;
      if (isObjectiveCentralValue(next)) {
        objectiveRows += 1;
        parsed.forEach(item => distinctNumbers.add(Number(item.number)));
        if (objectiveRows >= 3 && distinctNumbers.size >= 3) return true;
      } else return false;
    }
    return false;
  }

  for (let index = 0; index < paragraphs.length; index += 1) {
    if (removed.has(paragraphs[index].index)) continue;
    const clean = normalizeOneLine(paragraphs[index].text || '');
    const headingKind = centralHeadingKind(clean);
    if (!active && headingKind) {
      let evidence = 0;
      if (headingKind === 'generic') evidence = hasStrongGenericCentralEvidence(index) ? 1 : 0;
      else {
        for (let look = index + 1; look < Math.min(paragraphs.length, index + 12); look += 1) {
          if (removed.has(paragraphs[look].index)) continue;
          const next = normalizeOneLine(paragraphs[look].text || '');
          if (descriptiveTypeHeading(next)) continue;
          if (parseCentralAnswerEntryText(next).length) evidence += 1;
        }
      }
      if (evidence >= 1) {
        active = true;
        removed.add(paragraphs[index].index);
        if (/判断/.test(clean)) currentTypeLabel = '判断题';
        else if (/不定项/.test(clean)) currentTypeLabel = '不定项选择题';
        else if (/单选/.test(clean)) currentTypeLabel = '单选题';
        else if (/多选/.test(clean)) currentTypeLabel = '多选题';
        else if (/选择/.test(clean)) currentTypeLabel = '选择题';
        else if (/填空/.test(clean)) currentTypeLabel = '填空题';
        else if (/简答|问答/.test(clean)) currentTypeLabel = '简答题';
        else if (/计算/.test(clean)) currentTypeLabel = '计算题';
        else if (/匹配|配对/.test(clean)) currentTypeLabel = '匹配题';
        else if (/排序|顺序/.test(clean)) currentTypeLabel = '排序题';
        continue;
      }
    }
    if (!active) continue;
    const typeHeading = descriptiveTypeHeading(clean);
    if (typeHeading) {
      currentTypeLabel = typeHeading.label;
      removed.add(paragraphs[index].index);
      continue;
    }
    const parsed = parseCentralAnswerEntryText(clean);
    if (parsed.length) {
      parsed.forEach(item => entries.push({ ...item, typeLabel: currentTypeLabel }));
      removed.add(paragraphs[index].index);
      continue;
    }
    if (/^(?:第[一二三四五六七八九十\d]+(?:部分|章|节)|[一二三四五六七八九十]+[、.．])/.test(clean)) {
      active = false;
      currentTypeLabel = '';
    }
  }
  return {
    paragraphs: paragraphs.filter(item => !removed.has(item.index)),
    entries,
    removedCount: removed.size,
    sequentialAppendix: Boolean(wordAutoAppendix)
  };
}

function centralAnswerTypeMatches(question, typeLabel = '', strictShortLabel = false) {
  if (!typeLabel) return true;
  if (question.displayTypeLabel === typeLabel || question.sourceTypeLabel === typeLabel) return true;
  if (typeLabel === '选择题') return ['single', 'multiple'].includes(question.type);
  // 仅 Word 自动编号答案附录需要严格区分填空/简答/计算；普通集中答案继续沿用旧逻辑。
  if (strictShortLabel && /^(?:填空题|简答题|问答题|计算题)$/.test(typeLabel)) {
    const hasExplicitShortLabel = /^(?:填空题|简答题|问答题|计算题)$/.test(question.displayTypeLabel || question.sourceTypeLabel || '');
    if (hasExplicitShortLabel) return false;
  }
  const meta = typeMetaFromLabel(typeLabel);
  return question.type === meta.type;
}

function canCentralAnswerReplace(question, sequentialOnly = false) {
  if ((question.answer || []).length) return false;
  if (!question.answerText) return true;
  if (!sequentialOnly) return false;
  // 文末正式答案允许覆盖“无标签智能识别”的低置信度主观答案，但绝不覆盖
  // 显式答案、样式答案或用户后续编辑产生的内容。
  return /^(?:无答案标签智能识别|本地AI辅助)/.test(String(question.answerBoundarySource || ''));
}

function applyCentralAnswerKeys(questions = [], entries = []) {
  let applied = 0;
  const used = new Set();
  entries.forEach(entry => {
    const number = String(entry.number || '');
    if (!number) return;
    let candidates = questions.map((question, index) => ({ question, index }))
      .filter(item => canCentralAnswerReplace(item.question, Boolean(entry.sequentialOnly)));

    if (entry.sequentialOnly) {
      candidates = candidates.filter(item => centralAnswerTypeMatches(item.question, entry.typeLabel, true));
    } else {
      candidates = candidates.filter(item => String(item.question.number || '') === number);
      if (entry.typeLabel) {
        const typed = candidates.filter(item => centralAnswerTypeMatches(item.question, entry.typeLabel));
        if (typed.length) candidates = typed;
      }
    }

    const candidate = candidates.find(item => !used.has(item.index));
    if (!candidate) return;
    const question = candidate.question;
    const subjective = /(?:填空题|简答题|问答题|计算题|匹配题|配对题|排序题|顺序题)/.test(entry.typeLabel || '') ||
      (question.type === 'short' && !/(?:选择题|单选题|多选题|不定项选择题|判断题)/.test(entry.typeLabel || ''));
    const letters = parseAnswerLetters(entry.value);

    if (subjective) {
      question.answer = [];
      question.answerText = cleanAnswerText(entry.value);
    } else if (isJudgementAnswerValue(entry.value)) {
      question.type = 'judge';
      question.displayTypeLabel = '判断题';
      question.answer = letters;
      question.answerText = '';
    } else if (letters.length) {
      question.answer = letters;
      question.answerText = '';
      if (letters.length > 1 && question.displayTypeLabel !== '不定项选择题') {
        question.type = 'multiple';
        if (!question.sourceTypeLabel) question.displayTypeLabel = '多选题';
      }
    } else return;

    question.answerSource = [question.answerSource, entry.appendixSource || '文末集中答案回填'].filter(Boolean).join('、');
    question.answerBoundarySource = entry.appendixSource || question.answerBoundarySource || '文末集中答案';
    question.answerBoundaryConfidence = Math.max(Number(question.answerBoundaryConfidence) || 0, 0.99);
    Object.assign(question, validateQuestion(question));
    used.add(candidate.index);
    applied += 1;
  });
  return applied;
}

function splitFillAnswerText(value = '', expected = 0) {
  const clean = cleanAnswerText(value || '');
  if (!clean || expected < 2) return [];
  const parts = clean.split(/\s*(?:；|;|、|\||\/|，(?=[^，]{1,40}(?:，|$)))\s*/).map(item => item.trim()).filter(Boolean);
  return parts.length === expected ? parts : [];
}

function parseParagraphsDetailed(sourceParagraphs, options = {}) {
  const sourceName = options.sourceName || '';
  const useLocalAI = Boolean(options.useLocalAI);
  const sourceKind = String(options.sourceKind || '').toLowerCase();
  const parserProfile = String(options.parserProfile || 'strict').toLowerCase();
  const relaxedPdfBoundaries = sourceKind === 'pdf' && parserProfile !== 'strict';
  const centralAnswers = extractCentralAnswerKeys(sourceParagraphs);
  const documentFlags = { wordAutoAnswerAppendix: sourceKind === 'docx' && Boolean(centralAnswers.sequentialAppendix) };
  const materialAnnotated = annotateMaterialParagraphs(centralAnswers.paragraphs);
  const splitStarts = mergeSplitQuestionStarts(materialAnnotated);
  const sanitized = sanitizeParagraphs(splitStarts.paragraphs);
  const detachedOptionImages = mergeDetachedOptionImages(sanitized.paragraphs);
  const paragraphs = detachedOptionImages.paragraphs;
  const questions = [];
  const context = { level: '', category: '未分类', chapter: '', typeHint: '', displayTypeLabel: '' };
  const declaredSections = [];
  let activeDeclaredSection = null;
  const diagnostics = {
    sourceParagraphCount: sourceParagraphs.length,
    effectiveParagraphCount: paragraphs.length,
    removedNoiseCount: sanitized.removedNoiseCount,
    detachedOptionImageRepairCount: detachedOptionImages.repairedCount,
    documentTitleNoiseCount: 0,
    splitQuestionStartRepairCount: splitStarts.repairedCount,
    noPunctuationBoundaryRepairCount: 0,
    sourceDeclaredSectionCount: 0,
    sourceDeclaredMissingCount: 0,
    sourceDeclaredMissingItems: [],
    sourceDeclaredExtraCount: 0,
    sourceDeclaredExtraItems: [],
    inferredBoundaryCount: 0,
    inlineAnswerCount: 0,
    embeddedFillAnswerCount: 0,
    compactChoiceRepairCount: 0,
    duplicateCount: 0,
    unlabeledAnswerCount: 0,
    detectedBoundaryCount: 0,
    explicitBoundaryCount: 0,
    preservedFailedBoundaryCount: 0,
    discardedBoundaryCount: 0,
    assignedParagraphCount: 0,
    unassignedParagraphCount: 0,
    unassignedFragments: [],
    discardedFragments: [],
    numberingGapCount: 0,
    numberingIssues: [],
    localAIEnabled: useLocalAI,
    localAIModelVersion: useLocalAI ? localAI.MODEL_VERSION : '',
    localAIAppliedCount: 0,
    sourceKind,
    parserProfile,
    centralAnswerEntryCount: centralAnswers.entries.length,
    centralAnswerAppliedCount: 0,
    centralAnswerParagraphCount: centralAnswers.removedCount
  };
  let current = null;
  let mode = 'question';
  let pendingLeadingAnswer = null;
  let sectionQuestionOrdinal = 0;
  const claimedParagraphIndexes = new Set();
  const structuralParagraphIndexes = new Set();

  function closeDeclaredSection() {
    if (!activeDeclaredSection) return;
    activeDeclaredSection.endQuestionIndex = questions.length;
    declaredSections.push(activeDeclaredSection);
    activeDeclaredSection = null;
  }

  function finish() {
    const working = current;
    const question = finalize(working, sourceName, useLocalAI, sourceKind, documentFlags);
    if (question) {
      questions.push(question);
      if (question.preservedBoundaryFailure) diagnostics.preservedFailedBoundaryCount += 1;
    } else if (working && (working.boundarySource || working.rawTexts.length || working.images.length || working.answerImages.length || working.analysisImages.length)) {
      diagnostics.discardedBoundaryCount += 1;
      if (diagnostics.discardedFragments.length < 80) {
        diagnostics.discardedFragments.push({
          number: working.number || '',
          boundarySource: working.boundarySource || '未知',
          rawTexts: (working.rawTexts || []).slice(0, 8),
          imageCount: (working.images || []).length + (working.answerImages || []).length + (working.analysisImages || []).length
        });
      }
    }
    current = null;
    mode = 'question';
  }

  function ensureCurrent(boundarySource = '') {
    if (!current) current = createWorkingQuestion('', context, boundarySource);
    return current;
  }

  function applyPendingLeadingAnswer(item) {
    if (!item || !pendingLeadingAnswer) return;
    const pending = pendingLeadingAnswer;
    pendingLeadingAnswer = null;
    if (pending.truth) item.typeHint = 'judge';
    if (pending.letters && pending.letters.length) item.answer.push(...pending.letters);
    if (pending.text && !(pending.letters || []).length) {
      item.typeHint = 'short';
      pushText(item.answerTextParts, pending.text);
    }
    item.answerSources.push('题目前置答案');
    item.answerBoundarySource = '题目前置答案';
    item.answerBoundaryConfidence = 0.9;
  }

  function touch(item, paragraph, imageTarget = 'question') {
    const sourceIndexes = Array.isArray(paragraph.sourceIndexes) && paragraph.sourceIndexes.length
      ? paragraph.sourceIndexes
      : [paragraph.index];
    sourceIndexes.forEach(index => {
      claimedParagraphIndexes.add(index);
      if (!item.sourceParagraphs.includes(index)) item.sourceParagraphs.push(index);
    });
    if (paragraph.materialText && !item.material) item.material = normalizeText(paragraph.materialText);
    if (paragraph.materialImages && paragraph.materialImages.length) item.materialImages.push(...paragraph.materialImages);
    const paragraphImages = paragraph.images || [];
    if (imageTarget === 'question') item.images.push(...paragraphImages);
    else if (imageTarget === 'answer') item.answerImages.push(...paragraphImages);
    else if (imageTarget === 'analysis') item.analysisImages.push(...paragraphImages);
    const raw = paragraph.text ? normalizeText(paragraph.text) : '';
    if (raw && item.rawTexts[item.rawTexts.length - 1] !== raw) item.rawTexts.push(raw);
  }

  function applyStyledOptionAnswer(item, key, value, paragraph) {
    const optionText = normalizeOneLine(value || '');
    const styleAnswer = (paragraph && paragraph.styleAnswerDetails || []).some(detail => {
      if (!detail || !['color', 'highlight'].includes(detail.reason)) return false;
      const styled = normalizeOneLine(detail.text || '').replace(/^\s*[A-L]\s*[.、．:：)）]\s*/i, '');
      return Boolean(styled && optionText && (styled === optionText || styled.includes(optionText) || optionText.includes(styled)));
    });
    if (!styleAnswer || item.answer.includes(key)) return;
    item.answer.push(key);
    item.answerSources.push('Word 样式标注答案');
    item.answerBoundarySource = item.answerBoundarySource || 'Word 红字/高亮答案';
    item.answerBoundaryConfidence = Math.max(Number(item.answerBoundaryConfidence) || 0, 0.9);
  }

  function consumeToken(token, paragraph) {
    if (!token || (!token.value && token.type === 'text')) return;
    const item = ensureCurrent('智能推断边界');
    let imageTarget = 'question';
    if (token.type === 'option') imageTarget = false;
    else if (token.type === 'analysis') imageTarget = 'analysis';
    else if (token.type === 'answer' || token.type === 'reference') imageTarget = 'answer';
    else if (mode === 'analysis') imageTarget = 'analysis';
    else if (mode === 'reference' || mode === 'answer') imageTarget = 'answer';
    touch(item, paragraph, imageTarget);

    if (token.type === 'option') {
      mode = 'option';
      addOption(item, token.key, token.value, paragraph.images || []);
      // 教师版 Word 常用红字/高亮标出正确选项。仅在选项正文与强样式片段明确重合时采用。
      applyStyledOptionAnswer(item, token.key, token.value, paragraph);
      return;
    }
    if (token.type === 'answer') {
      item.answerBoundarySource = item.answerBoundarySource || '显式答案标签';
      item.answerBoundaryConfidence = 1;
      const truthAnswer = isJudgementAnswerValue(token.value);
      const letters = parseAnswerLetters(token.value);
      if (truthAnswer) {
        mode = 'answer';
        item.typeHint = 'judge';
        item.answer.push(...letters);
        if (letters.length) item.answerSources.push('判断题答案行');
      } else if (letters.length && (item.options.length || item.typeHint !== 'short')) {
        mode = 'answer';
        item.answer.push(...letters);
        item.answerSources.push('答案行');
      } else if (item.options.length && item.typeHint !== 'short') {
        mode = 'analysis';
        if (token.value) pushText(item.analysisParts, token.value);
        item.answerSources.push('无字母答案说明');
      } else {
        mode = 'reference';
        item.typeHint = 'short';
        if (token.value) pushText(item.answerTextParts, token.value);
        item.answerSources.push('文本答案行');
      }
      return;
    }
    if (token.type === 'reference') {
      item.answerBoundarySource = item.answerBoundarySource || '显式参考答案标签';
      item.answerBoundaryConfidence = 1;
      const truthAnswer = isJudgementAnswerValue(token.value);
      const letters = parseAnswerLetters(token.value);
      const questionText = cleanQuestionText(item.questionParts);
      const strongShort = item.typeHint === 'short' || isStrongShortQuestion(questionText);
      if (truthAnswer) {
        mode = 'answer';
        item.typeHint = 'judge';
        item.answer.push(...letters);
        if (letters.length) item.answerSources.push('判断题参考答案行');
      } else if (letters.length && (item.options.length || ['single', 'multiple', 'judge'].includes(item.typeHint) || !strongShort)) {
        mode = 'answer';
        item.answer.push(...letters);
        item.answerSources.push('参考答案行');
      } else if (item.options.length && item.typeHint !== 'short' && !strongShort) {
        mode = 'analysis';
        if (token.value) pushText(item.analysisParts, token.value);
        item.answerSources.push('无字母参考答案说明');
      } else {
        mode = 'reference';
        item.typeHint = 'short';
        if (token.value) pushText(item.answerTextParts, token.value);
        item.answerSources.push('文本参考答案');
      }
      return;
    }
    if (token.type === 'analysis') {
      mode = 'analysis';
      pushText(item.analysisParts, token.value);
      return;
    }

    if (mode === 'option' && item.options.length) {
      const last = item.options[item.options.length - 1];
      pushText(last.parts, token.value);
    } else if (mode === 'answer') {
      const letters = parseAnswerLetters(token.value);
      if (letters.length) {
        item.answer.push(...letters);
        item.answerSources.push('答案续行');
      } else if (item.typeHint === 'short' || !item.options.length) {
        pushText(item.answerTextParts, token.value);
      } else {
        pushText(item.analysisParts, token.value);
        mode = 'analysis';
      }
    } else if (mode === 'reference') {
      pushText(item.answerTextParts, token.value);
    } else if (mode === 'analysis') {
      pushText(item.analysisParts, token.value);
    } else {
      pushText(item.questionParts, token.value);
    }
  }

  paragraphs.forEach(paragraph => {
    const text = normalizeText(paragraph.text || '');
    if (paragraph.materialOnly) {
      const indexes = Array.isArray(paragraph.sourceIndexes) && paragraph.sourceIndexes.length ? paragraph.sourceIndexes : [paragraph.index];
      indexes.forEach(index => structuralParagraphIndexes.add(index));
      return;
    }
    if (!text && !(paragraph.images || []).length) return;

    if (current && ['reference', 'answer', 'analysis'].includes(mode) && /^\d{1,4}$/.test(normalizeOneLine(text))) {
      diagnostics.removedNoiseCount += 1;
      structuralParagraphIndexes.add(paragraph.index);
      return;
    }

    const metaMatch = /^(知识点|考点|分类|章节|难度)\s*[:：]\s*(.+)$/.exec(normalizeOneLine(text));
    if (metaMatch) {
      const key = metaMatch[1], value = metaMatch[2].trim();
      if (current) {
        touch(current, paragraph, false);
        if (key === '难度') current.difficulty = value;
        else if (key === '章节') current.chapter = value;
        else if (key === '分类') current.category = value;
        else {
          current.knowledgePoint = value;
          if (!current.category || current.category === '未分类') current.category = value;
        }
      } else {
        structuralParagraphIndexes.add(paragraph.index);
        if (key === '章节') context.chapter = value;
        else if (key === '分类' || key === '知识点' || key === '考点') context.category = value;
      }
      return;
    }

    // 支持“【答案】C / 答案：C”写在题目前。只有当前没有题目时才暂存到下一道题，
    // 避免把普通题目的答案行错绑到后题。
    const leadingAnswerLine = /^\s*(?:【\s*)?(正确答案|标准答案|参考答案|答案|答)(?:\s*】)?\s*(?:为|是)?\s*[:：]?\s*(.+)\s*$/.exec(normalizeOneLine(text));
    if (!current && leadingAnswerLine) {
      const value = leadingAnswerLine[2] || '';
      const letters = parseAnswerLetters(value);
      pendingLeadingAnswer = { letters, text: letters.length ? '' : cleanAnswerText(value), truth: isJudgementAnswerValue(value) };
      structuralParagraphIndexes.add(paragraph.index);
      return;
    }

    // 选项、答案和解析标签拥有最高优先级，不能先被简答题续行逻辑吞并。
    if (/^(?:选项|正确答案|标准答案|参考答案|答案|答|答案解析|试题解析|解析|说明)\s*(?:为|是)?\s*[:：]/.test(text)) {
      splitInline(text).forEach(token => consumeToken(token, paragraph));
      return;
    }

    const earlyHeader = classifyHeader(text, paragraph.style);
    const forcedSectionBoundary = !earlyHeader && shouldForceSectionQuestionStart(text, context, current, paragraph, sourceKind);
    const continuationFlags = { enhancedNumberedAnswerContinuation: sourceKind === 'pdf' || documentFlags.wordAutoAnswerAppendix };
    if (!forcedSectionBoundary && shouldTreatAsAnswerContinuation(text, current, mode, context, paragraph, continuationFlags) && !(sourceKind === 'pdf' && earlyHeader)) {
      consumeToken({ type: 'text', value: text }, paragraph);
      return;
    }

    if (isLikelyDocumentTitle(text, sourceName, paragraph.style)) {
      structuralParagraphIndexes.add(paragraph.index);
      diagnostics.documentTitleNoiseCount += 1;
      if (current && (current.questionParts.length || current.options.length || current.answer.length || current.answerTextParts.length)) finish();
      return;
    }

    const header = earlyHeader || classifyHeader(text, paragraph.style);
    if (header) {
      structuralParagraphIndexes.add(paragraph.index);
      if (current && (current.questionParts.length || current.options.length || current.answerTextParts.length)) finish();
      const declaration = header.kind === 'type' ? declaredTypeSection(text) : null;
      if (header.kind === 'level') {
        closeDeclaredSection();
        context.level = header.value;
        context.typeHint = '';
        context.displayTypeLabel = '';
      }
      if (header.kind === 'type') {
        closeDeclaredSection();
        sectionQuestionOrdinal = 0;
        context.typeHint = header.value;
        context.displayTypeLabel = header.label || (header.value === 'single' ? '单选题' : (header.value === 'multiple' ? '多选题' : (header.value === 'judge' ? '判断题' : '简答题')));
        if (declaration) {
          activeDeclaredSection = {
            id: `declared_${declaredSections.length + 1}_${paragraph.index}`,
            level: context.level || '',
            category: context.category || '',
            chapter: context.chapter || '',
            typeHint: declaration.typeHint,
            displayTypeLabel: declaration.displayTypeLabel || context.displayTypeLabel,
            expectedCount: declaration.expectedCount,
            heading: declaration.heading,
            paragraphIndex: paragraph.index,
            startQuestionIndex: questions.length,
            endQuestionIndex: questions.length
          };
        }
      }
      if (header.kind === 'category') {
        closeDeclaredSection();
        context.category = header.value;
        context.chapter = header.value;
        // “一、专业知识”这类顶层章节表示进入新的大类，应结束上一题型；
        // “（一）控制阀”等子分类则继续继承当前“画图题/计算题”等题型大类。
        const topLevelCategory = /^[一二三四五六七八九十]+[、.．]\s*\S+/.test(normalizeOneLine(text)) || /^第[一二三四五六七八九十\d]+(?:部分|章|节)/.test(normalizeOneLine(text));
        if (topLevelCategory) {
          context.typeHint = '';
          context.displayTypeLabel = '';
        }
      }
      return;
    }

    if (forcedSectionBoundary) {
      finish();
      sectionQuestionOrdinal += 1;
      current = createWorkingQuestion(String(sectionQuestionOrdinal), context, '章节逐题行');
      applyPendingLeadingAnswer(current);
      diagnostics.detectedBoundaryCount += 1;
      diagnostics.explicitBoundaryCount += 1;
      touch(current, paragraph);
      const styledFill = context.displayTypeLabel === '填空题' ? styledFillFromParagraph(text, paragraph) : { question: text, answers: [] };
      if (styledFill.answers.length) {
        current.typeHint = 'short'; current.displayTypeLabel = '填空题';
        pushText(current.questionParts, styledFill.question);
        pushText(current.answerTextParts, styledFill.answers.join('；'));
        current.answerBoundarySource = 'Word文字样式填空答案'; current.answerBoundaryConfidence = 0.97;
        current.answerSources.push('下划线/高亮/答案色文字');
        diagnostics.embeddedFillAnswerCount += 1;
        return;
      }
      const compactChoice = isCompactChoiceLine(text);
      const embeddedFill = context.displayTypeLabel === '填空题' && hasEmbeddedFillAnswer(text);
      const cleaned = consumeInlineAnswer(current, text, true);
      splitInline(cleaned).forEach(token => consumeToken(token, paragraph));
      if (compactChoice) diagnostics.compactChoiceRepairCount += 1;
      if (embeddedFill) diagnostics.embeddedFillAnswerCount += 1;
      if (current.answer.length) diagnostics.inlineAnswerCount += 1;
      return;
    }

    const autoOptionOrdinal = Number(paragraph.listOrdinal || 0);
    const canUseAutoOption = current && !isComplete(current) && paragraph.numId && paragraph.numId !== '0' &&
      autoOptionOrdinal >= 1 && autoOptionOrdinal <= 8 && current.questionParts.length &&
      current.typeHint !== 'short' && !isStrongQuestionCue(text);
    if (canUseAutoOption) {
      const key = String.fromCharCode('A'.charCodeAt(0) + autoOptionOrdinal - 1);
      touch(current, paragraph);
      const tokens = splitInline(`${key}. ${text}`);
      tokens.forEach(token => consumeToken(token, paragraph));
      return;
    }

    // 某些 Word 题库会把题型只写在上一题/上一段中，下一题又省略题号后的标点，
    // 例如“38更换MTL系列的安全栅时……”。此时章节上下文本身没有 typeHint，
    // 但上一题已经由答案识别为判断题。仅在无标点题号候选上继承当前题型，
    // 避免把简答题答案中的普通编号条目误切成新题。
    const noPunctuationCandidate = NO_PUNCT_NUMBER_RE.test(normalizeOneLine(text));
    const startContext = noPunctuationCandidate && current && !context.typeHint && current.typeHint
      ? Object.assign({}, context, { typeHint: current.typeHint })
      : context;
    let start = parseQuestionStart(text, startContext, paragraph, sourceKind);
    // 已有“27 [判断题]”这类强题号+题型边界、但题干尚为空时，下一行优先属于本题。
    // 弱“无标点题号”只有恰好等于下一题号时才允许抢占边界。
    // 例如“475手持通讯器……”中的 475 是仪表型号，不应拆成第 475 题。
    if (start && start.boundarySource === '无标点题号' && current && current.questionParts.length === 0 &&
        !current.options.length && !current.answer.length && !current.answerTextParts.length && current.number &&
        /(?:题号和题型|修复异常题号和题型|修复紧连异常题号和题型)/.test(current.boundarySource || '')) {
      const currentNumber = Number(current.number);
      const candidateNumber = Number(start.number);
      if (!Number.isFinite(currentNumber) || !Number.isFinite(candidateNumber) || candidateNumber !== currentNumber + 1) start = null;
    }
    // PDF 行首的小数（如“0.25MPa”）可能被通用题号规则误拆成“0.”题号。
    // 当前题尚未完成时，这类带单位的小数必定是上一行题干的续行。
    if (sourceKind === 'pdf' && start && current && !isComplete(current) &&
        /^\s*[+-]?\d+\.\d+\s*(?:[A-Za-zµμΩ℃°%]|[kKmMgGuUnNpP][A-Za-z]*)/.test(normalizeOneLine(text))) {
      start = null;
    }
    // PDF 视觉换行经常把“375 手操器”“15 分钟”等续行误判为无标点题号。
    // 当前题尚未完成时，这类行优先视为题干/选项的延续，避免凭空多出题目。
    if (sourceKind === 'pdf' && !relaxedPdfBoundaries && start && start.boundarySource === '无标点题号' && current && !isComplete(current)) {
      start = null;
    }
    if (start) {
      if (start.typeHint) { context.typeHint = start.typeHint; context.displayTypeLabel = start.displayTypeLabel || context.displayTypeLabel; }
      const pdfSupplementPrefix = sourceKind === 'pdf' && current && start.boundarySource === '题干标签' &&
        !current.options.length && !current.answer.length && !current.answerTextParts.length &&
        /^(?:[（(]?补充[）)]?|附加|追加)\s*$/i.test(cleanQuestionText(current.questionParts));
      const canFillExisting = (isWorkingEmpty(current) && start.boundarySource === '题干标签') || pdfSupplementPrefix;
      if (!canFillExisting) {
        diagnostics.detectedBoundaryCount += 1;
        diagnostics.explicitBoundaryCount += 1;
        if (start.boundarySource === '无标点题号') diagnostics.noPunctuationBoundaryRepairCount += 1;
      }
      if (!canFillExisting) {
        finish();
        current = createWorkingQuestion(start.number, context, start.boundarySource);
        applyPendingLeadingAnswer(current);
      } else {
        current.boundarySource = `${current.boundarySource}+题干标签`;
      }
      if (start.typeHint) { current.typeHint = start.typeHint; current.displayTypeLabel = start.displayTypeLabel || current.displayTypeLabel; }
      touch(current, paragraph);
      const styledFill = current.displayTypeLabel === '填空题' ? styledFillFromParagraph(start.content, paragraph) : { question: start.content, answers: [] };
      if (styledFill.answers.length) {
        current.typeHint = 'short'; current.displayTypeLabel = '填空题';
        pushText(current.questionParts, styledFill.question);
        pushText(current.answerTextParts, styledFill.answers.join('；'));
        current.answerBoundarySource = 'Word文字样式填空答案'; current.answerBoundaryConfidence = 0.97;
        current.answerSources.push('下划线/高亮/答案色文字');
        diagnostics.embeddedFillAnswerCount += 1;
        return;
      }
      const compactChoice = isCompactChoiceLine(start.content);
      const embeddedFill = current.displayTypeLabel === '填空题' && hasEmbeddedFillAnswer(start.content);
      const cleaned = consumeInlineAnswer(current, start.content, true);
      if (current.answer.length) diagnostics.inlineAnswerCount += 1;
      splitInline(cleaned).forEach(token => consumeToken(token, paragraph));
      if (compactChoice) diagnostics.compactChoiceRepairCount += 1;
      if (embeddedFill) diagnostics.embeddedFillAnswerCount += 1;
      return;
    }

    // Word 自动编号/转换器偶尔会把首项 A. 标签彻底吃掉，只留下
    // “二氧化碳B. 干粉C. 泡沫”。在明确的选择题上下文中，把前缀恢复为 A，
    // 再交给同一个 splitInline 处理；PDF/DOCX 均走这条共享兜底。
    const missingACompactOptions = recoverMissingACompactChoiceLine(text, current);
    if (missingACompactOptions) {
      touch(current, paragraph);
      missingACompactOptions.forEach(token => consumeToken(token, paragraph));
      current.answerSources.push('首项A标签缺失自动恢复');
      diagnostics.compactChoiceRepairCount += 1;
      return;
    }

    const fragmentedOptionContinuation = mode === 'option' ? recoverFragmentedOptionContinuation(text, current) : null;
    if (current && fragmentedOptionContinuation) {
      touch(current, paragraph, false);
      fragmentedOptionContinuation.forEach(token => consumeToken(token, paragraph));
      current.answerSources.push(fragmentedOptionContinuation.some(token => token.inferredMissingMarker)
        ? '缺失选项字母自动恢复' : '跨行连写选项自动拆分');
      diagnostics.compactChoiceRepairCount += 1;
      return;
    }

    // 教师版 Word 试卷有少量选项写成“A 文本 B 文本 C 文本 D 文本”，没有点号/顿号。
    // matchOptionLine 会把整行吞成 A；只在已确认带 Word 自动编号答案附录的文档里，
    // 且一行能完整拆出至少 3 个连续选项时启用，避免改变现有 PDF/普通 Word 解析。
    if (documentFlags.wordAutoAnswerAppendix && current && current.typeHint !== 'short' && current.typeHint !== 'judge') {
      const inlineBareTokens = splitInline(text).filter(token => token.type === 'option');
      if (inlineBareTokens.length >= 3) {
        const startCode = current.options.length ? current.options[current.options.length - 1].key.charCodeAt(0) + 1 : 65;
        const sequential = inlineBareTokens.every((token, tokenIndex) => token.key === String.fromCharCode(startCode + tokenIndex));
        if (sequential) {
          inlineBareTokens.forEach(token => consumeToken(token, paragraph));
          current.answerSources.push('Word无标点同行选项自动拆分');
          diagnostics.compactChoiceRepairCount += 1;
          return;
        }
      }
    }

    const earlyOptionMatch = matchOptionLine(text, current);
    const standaloneJudgeLetter = current && current.typeHint === 'judge' && /^\s*[AB]\s*[,，。；;]?\s*$/i.test(normalizeOneLine(text));
    if (current && !earlyOptionMatch && BARE_ANSWER_RE.test(text) && (current.options.length || isJudgementAnswerValue(text) || standaloneJudgeLetter)) {
      const letters = parseAnswerLetters(text);
      current.answer.push(...letters);
      current.answerSources.push(isJudgementAnswerValue(text) ? '独立判断答案行' : '独立答案行');
      if (isJudgementAnswerValue(text)) current.typeHint = 'judge';
      touch(current, paragraph);
      mode = 'answer';
      return;
    }

    const standaloneJudgeAnswer = /^\s*([AB])\s*[:：]\s*(正确|错误|对|错)\s*[,，。；;]?\s*$/i.exec(normalizeOneLine(text));
    if (current && standaloneJudgeAnswer) {
      const questionText = cleanQuestionText(current.questionParts);
      const truth = /^(?:正确|对)$/.test(standaloneJudgeAnswer[2]);
      if (current.typeHint === 'judge' || /[（(]\s*[）)]/.test(questionText)) {
        touch(current, paragraph);
        current.typeHint = 'judge';
        current.answer.push(truth ? 'A' : 'B');
        current.answerSources.push('A/B冒号判断答案行');
        current.answerBoundarySource = current.answerBoundarySource || '独立判断答案行';
        current.answerBoundaryConfidence = 1;
        mode = 'answer';
        return;
      }
    }

    const optionMatch = earlyOptionMatch || matchOptionLine(text, current);
    if (current && optionMatch) {
      if (optionMatch.direct) {
        touch(current, paragraph, false);
        addOption(current, optionMatch.key, optionMatch.value, paragraph.images || []);
        applyStyledOptionAnswer(current, optionMatch.key, optionMatch.value, paragraph);
        mode = 'option';
      } else {
        splitInline(text).forEach(token => consumeToken(token, paragraph));
      }
      return;
    }

    let unlabeledAnswer = inferUnlabeledShortAnswer(text, current, mode);
    if (!unlabeledAnswer.isAnswer && useLocalAI && current && mode === 'question') {
      const aiBoundary = localAI.classifyAnswerBoundary(cleanQuestionText(current.questionParts), text, {
        typeHint: current.typeHint,
        hasOptions: Boolean(current.options.length)
      });
      if (aiBoundary.isAnswer) unlabeledAnswer = aiBoundary;
    }
    if (unlabeledAnswer.isAnswer) {
      touch(current, paragraph);
      mode = 'reference';
      current.typeHint = 'short';
      current.answerBoundarySource = `${useLocalAI && /^本地模型/.test(unlabeledAnswer.reason || '') ? '本地AI辅助' : '无答案标签智能识别'}：${unlabeledAnswer.reason}`;
      current.answerBoundaryConfidence = unlabeledAnswer.confidence;
      current.answerSources.push('无答案标签参考答案');
      diagnostics.unlabeledAnswerCount += 1;
      pushText(current.answerTextParts, text);
      return;
    }

    const pdfAllowsInferredBoundary = sourceKind !== 'pdf' || relaxedPdfBoundaries || /[?？]\s*$/.test(normalizeOneLine(text));
    if (current && isComplete(current) && pdfAllowsInferredBoundary && looksLikeQuestionLine(text, context, paragraph)) {
      finish();
      current = createWorkingQuestion('', context, '智能推断边界');
      applyPendingLeadingAnswer(current);
      diagnostics.inferredBoundaryCount += 1;
      diagnostics.detectedBoundaryCount += 1;
      touch(current, paragraph);
      const cleaned = consumeInlineAnswer(current, text, true);
      if (current.answer.length) diagnostics.inlineAnswerCount += 1;
      splitInline(cleaned).forEach(token => consumeToken(token, paragraph));
      return;
    }

    if (!current) {
      if (/^\s*(?:[（(]\s*)?[A-L]\s*(?:[）).、．:：])/.test(text)) return;
      const cleanLength = normalizeOneLine(text).length;
      const canInferWithoutType = (sourceKind !== 'pdf' || relaxedPdfBoundaries || /[?？]\s*$/.test(normalizeOneLine(text))) && (
        looksLikeQuestionLine(text, context, paragraph) ||
        (paragraph.images || []).length > 0 ||
        (paragraph.numId && paragraph.numId !== '0' && paragraph.level === 0));
      if (cleanLength < 5 || (!context.typeHint && !canInferWithoutType)) return;
      current = createWorkingQuestion('', context, '智能推断边界');
      applyPendingLeadingAnswer(current);
      diagnostics.inferredBoundaryCount += 1;
      diagnostics.detectedBoundaryCount += 1;
      touch(current, paragraph);
      const cleaned = consumeInlineAnswer(current, text, true);
      if (current.answer.length) diagnostics.inlineAnswerCount += 1;
      splitInline(cleaned).forEach(token => consumeToken(token, paragraph));
      return;
    }

    touch(current, paragraph);
    const allowImplicit = mode === 'question' && current.questionParts.length === 0;
    const cleaned = consumeInlineAnswer(current, text, allowImplicit);
    splitInline(cleaned).forEach(token => consumeToken(token, paragraph));
  });

  finish();
  closeDeclaredSection();

  const reconciled = reconcileDeclaredSections(questions, declaredSections, sourceName);
  const finalQuestions = reconciled.questions
    .filter(item => item.question || item.answerText)
    .map((item, index) => Object.assign(item, { order: index + 1 }));
  diagnostics.centralAnswerAppliedCount = applyCentralAnswerKeys(finalQuestions, centralAnswers.entries);
  diagnostics.sourceDeclaredSectionCount = declaredSections.length;
  diagnostics.sourceDeclaredMissingCount = reconciled.missingItems.length;
  diagnostics.sourceDeclaredMissingItems = reconciled.missingItems.slice(0, 80);
  diagnostics.sourceDeclaredExtraCount = reconciled.extraItems.length;
  diagnostics.sourceDeclaredExtraItems = reconciled.extraItems.slice(0, 80);
  diagnostics.sourceContentQuestionCount = finalQuestions.filter(item => !item.sourceMissingPlaceholder).length;
  diagnostics.accountedQuestionCount = finalQuestions.length;
  diagnostics.duplicateCount = markDuplicates(finalQuestions.filter(item => !item.sourceMissingPlaceholder));
  diagnostics.localAIAppliedCount = finalQuestions.filter(item => item.aiAssistApplied).length;
  diagnostics.assignedParagraphCount = claimedParagraphIndexes.size;
  const unassigned = paragraphs.filter(item => {
    const indexes = Array.isArray(item.sourceIndexes) && item.sourceIndexes.length ? item.sourceIndexes : [item.index];
    return indexes.every(index => !claimedParagraphIndexes.has(index) && !structuralParagraphIndexes.has(index));
  });
  diagnostics.unassignedParagraphCount = unassigned.length;
  diagnostics.unassignedFragments = unassigned.slice(0, 80).map(item => ({
    paragraphIndex: item.index,
    text: normalizeOneLine(item.text || '').slice(0, 500),
    imageCount: (item.images || []).length,
    style: item.style || ''
  }));
  const numbering = analyzeNumbering(finalQuestions);
  diagnostics.numberingGapCount = numbering.gapCount;
  diagnostics.numberingIssues = numbering.issues;
  diagnostics.generatedQuestionCount = finalQuestions.length;
  diagnostics.silentLossCount = diagnostics.discardedBoundaryCount;

  return { questions: finalQuestions, diagnostics };
}

function analyzeQuestionBankStructure(sourceParagraphs = [], options = {}) {
  const sourceKind = String(options.sourceKind || '').toLowerCase();
  const rows = (sourceParagraphs || []).map(item => normalizeOneLine(item && item.text || '')).filter(Boolean);
  const stats = {
    sourceKind,
    paragraphCount: rows.length,
    indexedTyped: 0,
    indexedGeneric: 0,
    explicitNumbered: 0,
    noPunctuationNumbered: 0,
    labeledQuestion: 0,
    optionLine: 0,
    answerLine: 0,
    typeHeading: 0,
    tableLike: 0
  };
  rows.forEach(text => {
    if (COUNT_RE.test(text) || BROKEN_COUNT_RE.test(text) || NUMBERED_TYPE_RE.test(text)) stats.indexedTyped += 1;
    else if (GENERIC_COUNT_RE.test(text) || BARE_NUMBERED_QUESTION_RE.test(text)) stats.indexedGeneric += 1;
    else if (QUESTION_RES.some(pattern => pattern.test(text))) stats.explicitNumbered += 1;
    else if (NO_PUNCT_NUMBER_RE.test(text)) stats.noPunctuationNumbered += 1;
    if (/^(?:题目|题干|问题)\s*[:：]/.test(text) || TYPED_RE.test(text)) stats.labeledQuestion += 1;
    if (OPTION_LINE_RE.test(text) || LOOSE_OPTION_LINE_RE.test(text)) stats.optionLine += 1;
    if (/^(?:正确答案|标准答案|参考答案|答案|答)\s*(?:为|是)?\s*[:：]/.test(text) || BARE_ANSWER_RE.test(text)) stats.answerLine += 1;
    if (descriptiveTypeHeading(text)) stats.typeHeading += 1;
    if (/\t/.test(text) || /(?:题目|题干).*(?:答案|正确答案)/.test(text)) stats.tableLike += 1;
  });
  stats.strongBoundaryEstimate = stats.indexedTyped + stats.indexedGeneric + stats.explicitNumbered + stats.labeledQuestion;
  stats.looseBoundaryEstimate = stats.strongBoundaryEstimate + stats.noPunctuationNumbered;
  const indexedTotal = stats.indexedTyped + stats.indexedGeneric;
  const indexedThreshold = Math.max(3, Math.min(12, Math.ceil(rows.length * 0.04)));
  const mixedThreshold = Math.max(2, Math.min(8, Math.ceil(rows.length * 0.02)));
  if (indexedTotal >= indexedThreshold && (stats.explicitNumbered >= mixedThreshold || stats.labeledQuestion >= mixedThreshold)) stats.layout = 'mixed-indexed';
  else if (indexedTotal >= indexedThreshold) stats.layout = 'indexed';
  else if (stats.labeledQuestion >= mixedThreshold && stats.answerLine >= mixedThreshold) stats.layout = 'labeled';
  else if (stats.explicitNumbered >= mixedThreshold && stats.optionLine >= mixedThreshold) stats.layout = 'numbered-choice';
  else stats.layout = 'generic';
  return stats;
}

function adaptiveCandidateScore(candidate, structure) {
  const questions = candidate && candidate.questions || [];
  const diagnostics = candidate && candidate.diagnostics || {};
  const content = Number(diagnostics.sourceContentQuestionCount || questions.filter(item => !item.sourceMissingPlaceholder).length || 0);
  const expected = Math.max(Number(structure.strongBoundaryEstimate || 0), Number(structure.looseBoundaryEstimate || 0));
  let good = 0, warning = 0, error = 0;
  questions.forEach(item => {
    if (item.sourceMissingPlaceholder) return;
    if (item.status === 'error') error += 1;
    else if (item.status === 'warning') warning += 1;
    else good += 1;
  });
  let score = good * 12 + warning * 9 + error * 2;
  score -= Number(diagnostics.unassignedParagraphCount || 0) * 0.35;
  score -= Number(diagnostics.discardedBoundaryCount || 0) * 4;
  score -= Number(diagnostics.duplicateCount || 0) * 5;
  score -= Number(diagnostics.numberingGapCount || 0) * 0.5;
  if (expected > 0) {
    const ratio = content / expected;
    score += Math.min(1, ratio) * 500;
    if (ratio > 1.18) score -= (ratio - 1.18) * expected * 8;
  }
  return score;
}

function parseParagraphsAdaptive(sourceParagraphs, options = {}) {
  const structure = analyzeQuestionBankStructure(sourceParagraphs, options);
  const sourceKind = String(options.sourceKind || '').toLowerCase();
  const profiles = ['strict'];
  // PDF 的文字坐标转换最容易把原本明确的题号变成无标点题号或普通句子。
  // 对“序号型 / 混合型”题库额外跑宽松候选，再用结构覆盖率和异常率选优。
  if (sourceKind === 'pdf' || structure.layout === 'indexed' || structure.layout === 'mixed-indexed') profiles.push('relaxed');
  const candidates = profiles.map(profile => {
    const result = parseParagraphsDetailed(sourceParagraphs, Object.assign({}, options, { parserProfile: profile }));
    return { profile, result, score: adaptiveCandidateScore(result, structure) };
  });
  candidates.sort((a, b) => b.score - a.score || (b.result.questions.length - a.result.questions.length));

  let selected = candidates[0];
  // PDF 的 relaxed 模式允许从普通问句推断新题，适合修复缺失题号，但也可能把
  // 简答答案里的问句/编号说明多拆成“新题”。若 relaxed 只是增加异常/待检查题，
  // 正常题反而没有增加，且题号断层更严重，则回退 strict。这样不是“数量越多越好”，
  // 而是优先选择结构更完整、异常更少的候选。
  if (sourceKind === 'pdf' && candidates.length > 1) {
    const strictCandidate = candidates.find(item => item.profile === 'strict');
    const relaxedCandidate = candidates.find(item => item.profile === 'relaxed');
    if (strictCandidate && relaxedCandidate && relaxedCandidate.result.questions.length > strictCandidate.result.questions.length) {
      const countStatus = candidate => candidate.result.questions.reduce((acc, item) => {
        if (item.sourceMissingPlaceholder) return acc;
        if (item.status === 'error') acc.error += 1;
        else if (item.status === 'warning') acc.warning += 1;
        else acc.normal += 1;
        return acc;
      }, { normal: 0, warning: 0, error: 0 });
      const strictStatus = countStatus(strictCandidate);
      const relaxedStatus = countStatus(relaxedCandidate);
      const strictDiag = strictCandidate.result.diagnostics || {};
      const relaxedDiag = relaxedCandidate.result.diagnostics || {};
      const addsNoNormalQuestions = relaxedStatus.normal <= strictStatus.normal;
      const addsMoreProblems = relaxedStatus.warning >= strictStatus.warning && relaxedStatus.error >= strictStatus.error;
      const worsensNumbering = Number(relaxedDiag.numberingGapCount || 0) > Number(strictDiag.numberingGapCount || 0);
      const inferredGrowth = Number(relaxedDiag.inferredBoundaryCount || 0) > Number(strictDiag.inferredBoundaryCount || 0);
      if (addsNoNormalQuestions && addsMoreProblems && worsensNumbering && inferredGrowth) selected = strictCandidate;
    }
  }

  const chosen = selected.result;
  chosen.diagnostics = Object.assign({}, chosen.diagnostics || {}, {
    parserLayout: structure.layout,
    parserStrategy: selected.profile,
    parserStructure: structure,
    parserCandidates: candidates.map(item => ({
      profile: item.profile,
      score: Math.round(item.score * 100) / 100,
      questionCount: item.result.questions.length,
      contentQuestionCount: Number(item.result.diagnostics && item.result.diagnostics.sourceContentQuestionCount || 0),
      unassignedParagraphCount: Number(item.result.diagnostics && item.result.diagnostics.unassignedParagraphCount || 0),
      numberingGapCount: Number(item.result.diagnostics && item.result.diagnostics.numberingGapCount || 0)
    }))
  });
  return chosen;
}

function parseParagraphs(paragraphs, options = {}) {
  return parseParagraphsAdaptive(paragraphs, options).questions;
}

module.exports = {
  classifyHeader,
  declaredTypeSection,
  splitInline,
  splitCompactAnswerOptions,
  extractEmbeddedFillAnswers,
  parseAnswerLetters,
  extractInlineAnswer,
  sanitizeParagraphs,
  mergeSplitQuestionStarts,
  reconcileDeclaredSections,
  analyzeQuestionBankStructure,
  parseParagraphsDetailed,
  parseParagraphsAdaptive,
  parseParagraphs
};
});
__define("services/question-validator.js", function(require, module, exports){
const { unique, normalizeOneLine, hasEncodingAnomaly } = require('../utils/text');

function optionSignature(value = '') {
  return normalizeOneLine(value).toLowerCase()
    .replace(/[\s，,。；;：:'"“”‘’（）()【】\[\]［］]/g, '')
    .replace(/[−–—]/g, '-');
}

function extractRawOptionMap(question) {
  const map = {};
  const rawTexts = question && question.source && Array.isArray(question.source.rawTexts)
    ? question.source.rawTexts : [];
  rawTexts.forEach(raw => {
    String(raw || '').split(/\n+/).forEach(line => {
      const clean = normalizeOneLine(line);
      let match = /^\s*(?:[（(]\s*)?([A-L])\s*(?:[）)]|[.、．:：])\s*(.+?)\s*$/i.exec(clean);
      if (!match) match = /^\s*([A-L])\s+(.+?)\s*$/i.exec(clean);
      if (!match || !match[2]) return;
      const key = match[1].toUpperCase();
      const body = normalizeOneLine(match[2]);
      if (!body) return;
      if (!map[key]) map[key] = [];
      if (!map[key].includes(body)) map[key].push(body);
    });
  });
  return map;
}

function bestRawBody(map, key) {
  const values = map[key] || [];
  if (!values.length) return '';
  return values.slice().sort((a, b) => b.length - a.length)[0];
}

function repairOptionDuplicates(question, repairContext = {}) {
  if (!question || !Array.isArray(question.options) || !question.options.length) return question;
  const truthValue = value => {
    const clean = normalizeOneLine(value || '').toUpperCase();
    if (/^(?:正确|对|是|√|✓|✔|TRUE|T)$/.test(clean)) return true;
    if (/^(?:错误|错|否|×|✕|✖|❌|FALSE|F)$/.test(clean)) return false;
    return null;
  };
  // 判断题标准化后的“正确/错误”不能再被原始连写行“正确B.错误”覆盖。
  if (question.type === 'judge' && question.options.length === 2 &&
      question.options.every(item => truthValue(item.text) !== null)) return question;
  const rawMap = extractRawOptionMap(question);
  if (!Object.keys(rawMap).length) return question;

  const options = question.options.map(item => ({ ...item }));
  const repairs = [];
  const signatureCounts = options.reduce((acc, item) => {
    const signature = optionSignature(item.text);
    if (signature) acc[signature] = (acc[signature] || 0) + 1;
    return acc;
  }, {});

  options.forEach(option => {
    const rawBody = bestRawBody(rawMap, option.key);
    if (!rawBody) return;
    const current = normalizeOneLine(option.text || '');
    const currentSig = optionSignature(current);
    const rawSig = optionSignature(rawBody);
    if (!rawSig || currentSig === rawSig) return;

    // 原始行本身可能是 PDF/Word 的“折叠选项行”，例如：
    // A. 二氧化碳B. 干粉C. 泡沫
    // 此时 rawMap[A] 不是 A 的真实正文，而是 A+B+C 的整串。若解析器已经拆出了
    // 后续 B/C 项，绝不能再用这条“原文”把修好的 A 覆盖回去。
    const currentCode = String(option.key || '').toUpperCase().charCodeAt(0);
    const laterSiblingKeys = options.map(sibling => String(sibling.key || '').toUpperCase())
      .filter(siblingKey => /^[A-L]$/.test(siblingKey) && siblingKey.charCodeAt(0) > currentCode);
    const hasCollapsedSiblingMarker = laterSiblingKeys.some(siblingKey =>
      new RegExp(`${siblingKey}\\s*[.、．:：)）]`, 'i').test(rawBody)
    );
    // 另一种 Word 试卷直接写成“A 文本 B 文本 C 文本 D 文本”，没有任何点号。
    // 当当前解析结果已经存在至少两个后续选项，而原始 A 行又同时含有这些裸字母边界时，
    // rawMap[A] 实际是折叠整行，不能再把已经拆好的 A 覆盖回整串。
    const bareCollapsedSiblingCount = laterSiblingKeys.filter(siblingKey =>
      new RegExp(`(?:^|\\s)${siblingKey}\\s+`, 'i').test(rawBody)
    ).length;
    if (hasCollapsedSiblingMarker || (repairContext.wordAutoAnswerAppendix && bareCollapsedSiblingCount >= 2)) return;

    // 当前内容是原文行的完整延续时保留；其他明显截断、串位或重复结果按原文恢复。
    const currentExtendsRaw = currentSig.startsWith(rawSig) && currentSig.length > rawSig.length;
    if (currentExtendsRaw && signatureCounts[currentSig] <= 1) return;

    const visiblyTruncated = !currentSig || rawSig.startsWith(currentSig) || rawSig.endsWith(currentSig);
    const muchShorter = currentSig && currentSig.length < Math.floor(rawSig.length * 0.68);
    const duplicatedResult = currentSig && signatureCounts[currentSig] > 1;
    const punctuationFragment = /^[，,。；;、:：）)\]】]/.test(current);
    if (visiblyTruncated || muchShorter || duplicatedResult || punctuationFragment) {
      option.text = rawBody;
      repairs.push(`${option.key}选项按原文恢复`);
    }
  });

  const repaired = { ...question, options };
  if (repairs.length) {
    repaired.optionRepairApplied = true;
    repaired.optionRepairNotes = unique([...(question.optionRepairNotes || []), ...repairs]);
  }
  return repaired;
}


function repairKnownConvertedDocxOptions(question) {
  if (!question || !Array.isArray(question.options) || !question.options.length) return question;
  const questionText = normalizeOneLine(question.question || '');
  const options = question.options.map(item => ({ ...item }));
  const byKey = Object.fromEntries(options.map(item => [String(item.key || '').toUpperCase(), item]));
  const repairs = [];

  function sameOption(left, right) {
    return left && right && optionSignature(left.text) && optionSignature(left.text) === optionSignature(right.text);
  }

  function replaceRawOption(rawTexts, key, value) {
    const marker = String(key || '').toUpperCase();
    const linePattern = new RegExp('^(\\s*(?:[（(]\\s*)?' + marker + '\\s*(?:[）)]|[.、．:：])\\s*).*$','i');
    return (rawTexts || []).map(raw => String(raw || '').split(/\n/).map(line => {
      const match = linePattern.exec(line);
      return match ? `${match[1]}${value}` : line;
    }).join('\n'));
  }

  function setOption(key, value, note) {
    const target = byKey[key];
    if (!target || optionSignature(target.text) === optionSignature(value)) return;
    target.text = value;
    repairs.push(note);
  }

  // 某些 PDF 转 DOCX 文件把页面上方的覆盖文字与底层文字同时保存，
  // Android 读取到的底层段落会让 D 选项重复 C。仅在题干和重复特征同时命中时恢复。
  if (/DCS.*系统结构|系统结构.*DCS/i.test(questionText) && sameOption(byKey.C, byKey.D) &&
      /操作站.*(?:工业)?PC.*CRT/i.test(normalizeOneLine((byKey.C && byKey.C.text) || ''))) {
    setOption('D', '过程控制网络实现工程师站、操作站、控制站的连接，完成信息、控制命令的传输与发送。', 'D选项按文档可见内容恢复');
  }

  // 同一类转换文件会把 S7-300 CPU 指示灯题的 D 覆盖文字丢失，底层重复成 RUN。
  // 同时使用题干与 A/B/C/D 指示灯组合双重特征，避免不同 Word 转换器改写题干后漏修。
  const normalizedA = normalizeOneLine((byKey.A && byKey.A.text) || '').toUpperCase();
  const normalizedB = normalizeOneLine((byKey.B && byKey.B.text) || '').toUpperCase();
  const normalizedC = normalizeOneLine((byKey.C && byKey.C.text) || '').toUpperCase();
  const looksLikeS7IndicatorSet = normalizedA === 'SF' && /^(?:BATF|BATT?F?)$/.test(normalizedB) && normalizedC === 'RUN';
  if ((/西门子.*S7\s*[-－—]?\s*300.*CPU.*指示灯|S7\s*[-－—]?\s*300.*CPU.*指示灯/i.test(questionText) || looksLikeS7IndicatorSet) &&
      sameOption(byKey.C, byKey.D) && normalizedC === 'RUN') {
    setOption('D', 'STOP', 'D选项按文档可见内容恢复');
  }

  if (!repairs.length) return question;
  let source = question.source ? { ...question.source } : null;
  if (source && Array.isArray(source.rawTexts)) {
    repairs.forEach(note => {
      if (/D选项/.test(note)) source.rawTexts = replaceRawOption(source.rawTexts, 'D', byKey.D.text);
    });
  }
  return {
    ...question,
    options,
    source,
    optionRepairApplied: true,
    optionRepairNotes: unique([...(question.optionRepairNotes || []), ...repairs])
  };
}


function isGenericVisualOptionText(value = '') {
  const clean = normalizeOneLine(value || '')
    .replace(/[\s()（）\[\]【】<>《》]/g, '')
    .replace(/[.。:：、，,;；]/g, '')
    .toLowerCase();
  return /^(?:图|图形|图片|图示|示意图|符号图|见图|如下图)$/.test(clean);
}

function missingVisualOptionImages(question) {
  if (!question || question.type === 'short') return false;
  const options = Array.isArray(question.options) ? question.options : [];
  if (options.length < 2 || !options.every(item => isGenericVisualOptionText(item && item.text))) return false;
  const questionImages = Array.isArray(question.images) ? question.images.length : 0;
  const optionImages = options.reduce((sum, item) => sum + (Array.isArray(item && item.images) ? item.images.length : 0), 0);
  return questionImages + optionImages < options.length;
}

function duplicateOptionIssues(question) {
  // “A.图形 / B.图形 ...”是图片选项的文本占位符：图片存在时各项由图像区分，
  // 图片缺失时由“图片选项缺少图像”单独提示。两种情况都不应报文字重复。
  const options = Array.isArray(question && question.options) ? question.options : [];
  if (options.length >= 2 && options.every(item => isGenericVisualOptionText(item && item.text))) return [];
  const groups = {};
  (question.options || []).forEach(item => {
    const signature = optionSignature(item.text);
    if (!signature) return;
    if (!groups[signature]) groups[signature] = [];
    groups[signature].push(item.key);
  });

  const rawMap = extractRawOptionMap(question);
  const issues = [];
  Object.entries(groups).forEach(([signature, keys]) => {
    if (keys.length < 2) return;
    const rawBodies = keys.map(key => bestRawBody(rawMap, key));
    const rawSignatures = rawBodies.map(optionSignature);
    const allRawPresent = rawSignatures.every(Boolean);
    const rawDistinct = allRawPresent && new Set(rawSignatures).size > 1;
    const rawSameAsResult = allRawPresent && rawSignatures.every(value => value === signature);
    const keyText = keys.join('、');

    if (rawDistinct) issues.push(`解析重复（${keyText}）`);
    else if (rawSameAsResult) issues.push(`导入片段重复（${keyText}）`);
    else issues.push(`疑似重复（${keyText}）`);
  });
  return issues;
}

function validateQuestion(question) {
  const issues = [];
  let score = 1;

  if (!question.question || question.question.length < 4) {
    issues.push('题干缺失或过短');
    score -= 0.45;
  }

  if (/(?:答案|参考答案|解析)\s*[:：]/.test(question.question || '')) {
    issues.push('题干中仍残留答案或解析标记');
    score -= 0.18;
  }

  if (question.type === 'short') {
    const hasAnswerImage = Array.isArray(question.answerImages) && question.answerImages.length > 0;
    if ((!question.answerText || !question.answerText.trim()) && !hasAnswerImage) {
      issues.push('无答案');
      score -= 0.35;
    }
  } else {
    if (!Array.isArray(question.options) || question.options.length < 2) {
      issues.push('选项不足');
      score -= 0.4;
    }
    if (!Array.isArray(question.answer) || question.answer.length === 0) {
      issues.push('无答案');
      score -= 0.35;
    } else {
      const keys = new Set((question.options || []).map(item => item.key));
      const invalid = question.answer.filter(key => !keys.has(key));
      if (invalid.length) {
        issues.push(`答案不符（${invalid.join('、')}）`);
        score -= 0.4;
      }
    }
  }

  if (missingVisualOptionImages(question)) {
    issues.push('图片选项缺少图像');
    score -= 0.2;
  }

  if (question.options && question.options.some(item => !item.text && !(Array.isArray(item.images) && item.images.length))) {
    issues.push('空白选项');
    score -= 0.15;
  }

  const optionKeys = (question.options || []).map(item => item.key);
  if (new Set(optionKeys).size !== optionKeys.length) {
    issues.push('选项字母重复');
    score -= 0.2;
  }

  const duplicateIssues = duplicateOptionIssues(question);
  duplicateIssues.forEach(issue => issues.push(issue));
  if (duplicateIssues.some(issue => issue.startsWith('解析重复') || issue.startsWith('疑似重复'))) score -= 0.18;
  else if (duplicateIssues.length) score -= 0.08;

  if (question.question && question.question.length > 1000) {
    issues.push('题干过长');
    score -= 0.25;
  }

  if (question.answerText && question.answerText.length > 3000) {
    issues.push('答案过长');
    score -= 0.2;
  }


  const encodingText = [
    question.question,
    ...(question.options || []).map(item => item.text),
    question.answerText,
    question.analysis,
    ...((question.source && question.source.rawTexts) || [])
  ].filter(Boolean).join(' ');
  if (hasEncodingAnomaly(encodingText)) {
    issues.push('字符映射异常');
    score -= 0.22;
  }

  if (question.type === 'multiple' && question.answer.length < 2) {
    issues.push('多选仅一项');
    score -= 0.15;
  }

  if (question.type === 'judge') {
    const truthValue = value => {
      const clean = normalizeOneLine(value || '').toUpperCase();
      if (/^(?:正确|对|是|√|✓|✔|TRUE|T)$/.test(clean)) return true;
      if (/^(?:错误|错|否|×|✕|✖|❌|FALSE|F)$/.test(clean)) return false;
      return null;
    };
    const values = (question.options || []).map(item => truthValue(item.text));
    if (question.options.length !== 2 || !values.includes(true) || !values.includes(false)) {
      issues.push('判断选项异常');
      score -= 0.15;
    }
  }

  if (question.inferredBoundary) {
    const hasAnyAnswer = Boolean((question.answer || []).length || question.answerText || (Array.isArray(question.answerImages) && question.answerImages.length));
    issues.push(hasAnyAnswer ? '边界待查' : '边界待查且无答案');
    score -= hasAnyAnswer ? 0.05 : 0.08;
  }

  if (question.duplicateOf) {
    issues.push('重复题');
    score -= 0.18;
  }

  const confidence = Math.max(0, Math.min(1, Number(score.toFixed(2))));
  let status = 'normal';
  const fatalChoiceStructure = question.type !== 'short' && (!Array.isArray(question.options) || question.options.length < 2);
  if (fatalChoiceStructure || confidence < 0.45) status = 'error';
  else if (issues.length) status = 'warning';

  return { issues: unique(issues), confidence, status };
}

module.exports = { validateQuestion, repairOptionDuplicates, repairKnownConvertedDocxOptions, optionSignature, extractRawOptionMap };
});
__define("services/record-storage.js", function(require, module, exports){
const fileUtil = require('../utils/file');
const { STORAGE_KEYS, RECORD_DIR } = require('../utils/constants');

const EXAM_DRAFT_FILE = `${RECORD_DIR}/exam_draft.json`;

function read(key, fallback) {
  const value = wx.getStorageSync(key);
  return value || fallback;
}

function write(key, value) {
  wx.setStorageSync(key, value);
}

function defaultSettings() {
  return {
    settingsVersion: 8,
    appearanceMode: 'system',
    amoledBlack: false,
    monetTheme: 'ocean',
    fontScale: 1,
    answerBottomLift: 48,
    autoNext: false,
    autoNextDelay: 500,
    immersivePractice: true,
    shuffleOptions: false,
    resetWrongOnRestart: true,
    useLocalAI: false
  };
}

function defaultStats() {
  return {
    statsVersion: 2,
    answered: 0,
    correct: 0,
    reviewed: 0,
    reviewMastered: 0,
    exams: 0,
    studyDays: {},
    daily: {},
    banks: {},
    types: {},
    difficulties: {},
    categories: {}
  };
}

function recordFile(kind, bankId) {
  return `${RECORD_DIR}/${kind}_${String(bankId || '').replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
}

function legacyKey(kind) {
  return {
    wrong: STORAGE_KEYS.WRONG,
    favorites: STORAGE_KEYS.FAVORITES,
    progress: STORAGE_KEYS.PROGRESS,
    mastered: STORAGE_KEYS.MASTERED
  }[kind] || '';
}

function readBankRecord(kind, bankId, fallback) {
  fileUtil.ensureDir(RECORD_DIR);
  const path = recordFile(kind, bankId);
  if (fileUtil.exists(path)) return fileUtil.readJson(path, fallback);
  const key = legacyKey(kind);
  if (key) {
    const legacy = read(key, {});
    if (legacy && Object.prototype.hasOwnProperty.call(legacy, bankId)) {
      const value = legacy[bankId];
      fileUtil.writeJsonAtomic(path, value);
      delete legacy[bankId];
      write(key, legacy);
      return value;
    }
  }
  return fallback;
}

function writeBankRecord(kind, bankId, value, emptyCheck) {
  fileUtil.ensureDir(RECORD_DIR);
  const path = recordFile(kind, bankId);
  const empty = typeof emptyCheck === 'function' ? emptyCheck(value) : false;
  if (empty) {
    if (fileUtil.exists(path)) fileUtil.removeRecursive(path);
    return;
  }
  fileUtil.writeJsonAtomic(path, value);
}

function initDefaults() {
  fileUtil.ensureDir(RECORD_DIR);
  const defaults = {
    [STORAGE_KEYS.WRONG]: {},
    [STORAGE_KEYS.FAVORITES]: {},
    [STORAGE_KEYS.PROGRESS]: {},
    [STORAGE_KEYS.STATS]: defaultStats(),
    [STORAGE_KEYS.SETTINGS]: defaultSettings(),
    [STORAGE_KEYS.MASTERED]: {},
    [STORAGE_KEYS.EXAM_DRAFT]: null
  };
  Object.keys(defaults).forEach(key => {
    const current = wx.getStorageSync(key);
    if (!current) write(key, defaults[key]);
    else if (key === STORAGE_KEYS.SETTINGS) {
      const merged = Object.assign(defaultSettings(), current);
      if (Number(current.settingsVersion || 0) < 2) merged.autoNextDelay = 500;
      if (current.appearanceMode === 'amoled') {
        merged.appearanceMode = 'dark';
        merged.amoledBlack = true;
      }
      if (!['system', 'light', 'dark'].includes(merged.appearanceMode)) merged.appearanceMode = 'system';
      merged.amoledBlack = Boolean(merged.amoledBlack);
      if (!['ocean', 'violet', 'mint', 'rose', 'amber'].includes(merged.monetTheme)) merged.monetTheme = 'ocean';
      merged.resetWrongOnRestart = current.resetWrongOnRestart === undefined ? true : Boolean(current.resetWrongOnRestart);
      merged.answerBottomLift = Math.max(0, Math.min(120, Number(merged.answerBottomLift) || 48));
      merged.settingsVersion = 8;
      write(key, merged);
    } else if (key === STORAGE_KEYS.STATS) {
      const merged = Object.assign(defaultStats(), current);
      ['daily', 'banks', 'types', 'difficulties', 'categories', 'studyDays'].forEach(name => {
        if (!merged[name] || typeof merged[name] !== 'object') merged[name] = {};
      });
      merged.statsVersion = 2;
      write(key, merged);
    }
  });
}

function getWrong(bankId) { return readBankRecord('wrong', bankId, {}); }
function markWrong(bankId, questionId) {
  const bank = getWrong(bankId);
  const current = bank[questionId] || { wrongCount: 0, correctStreak: 0 };
  bank[questionId] = { wrongCount: current.wrongCount + 1, correctStreak: 0, lastWrongAt: Date.now(), mastered: false };
  writeBankRecord('wrong', bankId, bank, value => !Object.keys(value || {}).length);
}
function markCorrect(bankId, questionId) { return Boolean(getWrong(bankId)[questionId]); }
function removeWrong(bankId, questionId) {
  const bank = getWrong(bankId);
  delete bank[questionId];
  writeBankRecord('wrong', bankId, bank, value => !Object.keys(value || {}).length);
}

function getFavoriteIds(bankId) { return readBankRecord('favorites', bankId, []); }
function isFavorite(bankId, questionId) { return getFavoriteIds(bankId).includes(questionId); }
function toggleFavorite(bankId, questionId) {
  const list = getFavoriteIds(bankId);
  const index = list.indexOf(questionId);
  if (index >= 0) list.splice(index, 1); else list.unshift(questionId);
  writeBankRecord('favorites', bankId, list, value => !Array.isArray(value) || !value.length);
  return index < 0;
}

function getMastered(bankId) { return readBankRecord('mastered', bankId, {}); }
function getMasteredIds(bankId) { return Object.keys(getMastered(bankId)); }
function isMastered(bankId, questionId) { return Boolean(getMastered(bankId)[questionId]); }
function setMastered(bankId, questionId, mastered = true) {
  const bank = getMastered(bankId);
  if (mastered) bank[questionId] = { masteredAt: Date.now() }; else delete bank[questionId];
  writeBankRecord('mastered', bankId, bank, value => !Object.keys(value || {}).length);
  const wrong = getWrong(bankId);
  if (wrong[questionId]) {
    wrong[questionId].mastered = Boolean(mastered);
    writeBankRecord('wrong', bankId, wrong, value => !Object.keys(value || {}).length);
  }
  return Boolean(mastered);
}
function removeMastered(bankId, questionId) { return setMastered(bankId, questionId, false); }

function isSequenceProgress(progress) {
  if (!progress || typeof progress !== 'object') return false;
  return !progress.mode || progress.mode === 'sequence';
}
function saveProgress(bankId, progress) {
  if (!bankId || !isSequenceProgress(progress)) return false;
  writeBankRecord('progress', bankId, Object.assign({}, progress, { mode: 'sequence', progressVersion: 4, updatedAt: Date.now() }), value => !value);
  return true;
}
function getProgress(bankId) {
  const progress = readBankRecord('progress', bankId, null);
  return isSequenceProgress(progress) ? progress : null;
}
function clearProgressForBank(bankId) {
  const path = recordFile('progress', bankId);
  const existed = fileUtil.exists(path) || Boolean((read(STORAGE_KEYS.PROGRESS, {}) || {})[bankId]);
  if (fileUtil.exists(path)) fileUtil.removeRecursive(path);
  const legacy = read(STORAGE_KEYS.PROGRESS, {});
  if (legacy && legacy[bankId]) { delete legacy[bankId]; write(STORAGE_KEYS.PROGRESS, legacy); }
  return existed;
}

function saveMemorizeProgress(bankId, progress) {
  if (!bankId || !progress || typeof progress !== 'object') return false;
  writeBankRecord('memorize-progress', bankId, Object.assign({}, progress, {
    mode: 'memorize',
    progressVersion: 2,
    updatedAt: Date.now()
  }), value => !value);
  return true;
}
function getMemorizeProgress(bankId) {
  const progress = readBankRecord('memorize-progress', bankId, null);
  return progress && progress.mode === 'memorize' ? progress : null;
}
function clearMemorizeProgressForBank(bankId) {
  const path = recordFile('memorize-progress', bankId);
  const existed = fileUtil.exists(path);
  if (existed) fileUtil.removeRecursive(path);
  return existed;
}

function clearMemorizeProgressScope(bankId, scopeKey, legacyScopeKey = '') {
  const progress = getMemorizeProgress(bankId);
  if (!progress || !scopeKey) return false;
  const next = Object.assign({}, progress);
  next.cursors = Object.assign({}, progress.cursors || {});
  next.randomSequences = Object.assign({}, progress.randomSequences || {});
  let changed = false;
  [scopeKey, legacyScopeKey].filter(Boolean).forEach(key => {
    if (Object.prototype.hasOwnProperty.call(next.cursors, key)) {
      delete next.cursors[key];
      changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(next.randomSequences, key)) {
      delete next.randomSequences[key];
      changed = true;
    }
  });
  if (!changed) return false;
  const hasCursor = Object.keys(next.cursors).length > 0;
  const hasRandomSequence = Object.keys(next.randomSequences).length > 0;
  if (!hasCursor && !hasRandomSequence) return clearMemorizeProgressForBank(bankId);
  if (legacyScopeKey && next.cursor) delete next.cursor;
  return saveMemorizeProgress(bankId, next);
}

function localDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function incrementBucket(bucket, key, correct) {
  if (!key) return;
  const current = bucket[key] || { answered: 0, correct: 0 };
  current.answered += 1;
  if (correct) current.correct += 1;
  bucket[key] = current;
}
function markStudyDay(stats) {
  const day = localDayKey();
  stats.studyDays[day] = (stats.studyDays[day] || 0) + 1;
  return day;
}
function recordAnswer(isCorrect, meta = {}) {
  const stats = Object.assign(defaultStats(), read(STORAGE_KEYS.STATS, {}));
  stats.answered += 1;
  if (isCorrect) stats.correct += 1;
  const day = markStudyDay(stats);
  incrementBucket(stats.daily, day, isCorrect);
  incrementBucket(stats.banks, meta.bankId, isCorrect);
  incrementBucket(stats.types, meta.typeLabel || meta.type, isCorrect);
  incrementBucket(stats.difficulties, meta.difficulty, isCorrect);
  incrementBucket(stats.categories, meta.category, isCorrect);
  write(STORAGE_KEYS.STATS, stats);
}
function recordReview(level) {
  const stats = Object.assign(defaultStats(), read(STORAGE_KEYS.STATS, {}));
  stats.reviewed += 1;
  if (level === 'mastered') stats.reviewMastered += 1;
  markStudyDay(stats);
  write(STORAGE_KEYS.STATS, stats);
}
function recordExam() { const stats = Object.assign(defaultStats(), read(STORAGE_KEYS.STATS, {})); stats.exams += 1; write(STORAGE_KEYS.STATS, stats); }

function saveExamDraft(session) {
  if (!session || !session.exam || !Array.isArray(session.questions) || !session.questions.length) return false;
  const payload = JSON.parse(JSON.stringify({
    draftVersion: 1,
    savedAt: Date.now(),
    session
  }));
  fileUtil.writeJsonAtomic(EXAM_DRAFT_FILE, payload);
  write(STORAGE_KEYS.EXAM_DRAFT, { savedAt: payload.savedAt, bankId: session.bankId, questionCount: session.questions.length });
  return true;
}
function getExamDraft() {
  const payload = fileUtil.readJson(EXAM_DRAFT_FILE, null);
  if (!payload || !payload.session || !payload.session.exam || !Array.isArray(payload.session.questions) || !payload.session.questions.length) return null;
  return payload;
}
function clearExamDraft() {
  const existed = fileUtil.exists(EXAM_DRAFT_FILE) || Boolean(read(STORAGE_KEYS.EXAM_DRAFT, null));
  if (fileUtil.exists(EXAM_DRAFT_FILE)) fileUtil.removeRecursive(EXAM_DRAFT_FILE);
  write(STORAGE_KEYS.EXAM_DRAFT, null);
  return existed;
}

function getStats() { return Object.assign(defaultStats(), read(STORAGE_KEYS.STATS, {})); }
function getSettings() { return Object.assign(defaultSettings(), read(STORAGE_KEYS.SETTINGS, {})); }
function saveSettings(settings) {
  const next = Object.assign(defaultSettings(), settings, { updatedAt: Date.now() });
  write(STORAGE_KEYS.SETTINGS, next);
  return next;
}

function clearBankRecords(bankId) {
  ['wrong', 'favorites', 'progress', 'memorize-progress', 'mastered'].forEach(kind => {
    const path = recordFile(kind, bankId);
    if (fileUtil.exists(path)) fileUtil.removeRecursive(path);
    const key = legacyKey(kind);
    if (key) {
      const legacy = read(key, {});
      if (legacy && legacy[bankId]) { delete legacy[bankId]; write(key, legacy); }
    }
  });
}
function clearWrongForBank(bankId) {
  const path = recordFile('wrong', bankId);
  if (fileUtil.exists(path)) fileUtil.removeRecursive(path);
  const legacy = read(STORAGE_KEYS.WRONG, {});
  if (legacy && legacy[bankId]) { delete legacy[bankId]; write(STORAGE_KEYS.WRONG, legacy); }
}
function clearLearningRecords() {
  if (fileUtil.exists(RECORD_DIR)) fileUtil.removeRecursive(RECORD_DIR);
  fileUtil.ensureDir(RECORD_DIR);
  write(STORAGE_KEYS.WRONG, {}); write(STORAGE_KEYS.FAVORITES, {}); write(STORAGE_KEYS.PROGRESS, {});
  write(STORAGE_KEYS.STATS, defaultStats()); write(STORAGE_KEYS.MASTERED, {}); clearExamDraft();
}

function exportAllRecords(bankIds = []) {
  const records = {};
  bankIds.forEach(bankId => {
    records[bankId] = {
      wrong: getWrong(bankId),
      favorites: getFavoriteIds(bankId),
      progress: getProgress(bankId),
      memorizeProgress: getMemorizeProgress(bankId),
      mastered: getMastered(bankId)
    };
  });
  return { records, stats: getStats(), settings: getSettings() };
}
function importAllRecords(payload = {}) {
  const records = payload.records || {};
  Object.keys(records).forEach(bankId => {
    const item = records[bankId] || {};
    writeBankRecord('wrong', bankId, item.wrong || {}, value => !Object.keys(value || {}).length);
    writeBankRecord('favorites', bankId, item.favorites || [], value => !Array.isArray(value) || !value.length);
    writeBankRecord('progress', bankId, item.progress || null, value => !value);
    writeBankRecord('memorize-progress', bankId, item.memorizeProgress || null, value => !value);
    writeBankRecord('mastered', bankId, item.mastered || {}, value => !Object.keys(value || {}).length);
  });
  if (payload.stats) write(STORAGE_KEYS.STATS, Object.assign(defaultStats(), payload.stats));
  if (payload.settings) write(STORAGE_KEYS.SETTINGS, Object.assign(defaultSettings(), payload.settings));
}

module.exports = {
  initDefaults, getWrong, markWrong, markCorrect, removeWrong,
  getFavoriteIds, isFavorite, toggleFavorite, getMastered, getMasteredIds, isMastered, setMastered, removeMastered,
  saveProgress, getProgress, clearProgressForBank,
  saveMemorizeProgress, getMemorizeProgress, clearMemorizeProgressForBank, clearMemorizeProgressScope,
  recordAnswer, recordReview, recordExam,
  saveExamDraft, getExamDraft, clearExamDraft,
  getStats, getSettings, saveSettings, clearWrongForBank, clearBankRecords, clearLearningRecords,
  exportAllRecords, importAllRecords, localDayKey
};
});
__define("services/statistics-service.js", function(require, module, exports){
const bankStorage = require('./bank-storage');
const recordStorage = require('./record-storage');

function metric(item = {}) {
  const answered = Number(item.answered) || 0;
  const correct = Number(item.correct) || 0;
  return { answered, correct, accuracy: answered ? Math.round(correct / answered * 100) : 0 };
}

function summary() {
  const banks = bankStorage.listBanks();
  const stats = recordStorage.getStats();
  const wrongCount = banks.reduce((sum, bank) => sum + Object.values(recordStorage.getWrong(bank.id)).filter(item => !item.mastered).length, 0);
  const favoriteCount = banks.reduce((sum, bank) => sum + recordStorage.getFavoriteIds(bank.id).length, 0);
  const masteredCount = banks.reduce((sum, bank) => sum + recordStorage.getMasteredIds(bank.id).length, 0);
  return {
    bankCount: banks.length,
    questionCount: banks.reduce((sum, bank) => sum + bank.questionCount, 0),
    answered: stats.answered,
    reviewed: stats.reviewed || 0,
    correct: stats.correct,
    accuracy: stats.answered ? Math.round(stats.correct / stats.answered * 100) : 0,
    exams: stats.exams,
    studyDays: Object.keys(stats.studyDays || {}).length,
    wrongCount, favoriteCount, masteredCount
  };
}

function rows(bucket = {}, labelMap = {}) {
  return Object.keys(bucket).map(key => Object.assign({ key, label: labelMap[key] || key || '未分类' }, metric(bucket[key])))
    .filter(item => item.answered > 0)
    .sort((a, b) => b.answered - a.answered || a.accuracy - b.accuracy);
}

function detailed() {
  const stats = recordStorage.getStats();
  const banks = bankStorage.listBanks();
  const bankNames = banks.reduce((acc, bank) => { acc[bank.id] = bank.name; return acc; }, {});
  const recent = Object.keys(stats.daily || {}).sort().slice(-30).map(day => Object.assign({ day }, metric(stats.daily[day])));
  return {
    banks: rows(stats.banks, bankNames),
    types: rows(stats.types),
    difficulties: rows(stats.difficulties),
    categories: rows(stats.categories).slice(0, 12),
    recent
  };
}

module.exports = { summary, detailed };
});
__define("data/demo-bank.js", function(require, module, exports){
module.exports = [
  {
    id: 'demo_1',
    order: 1,
    number: '1',
    level: '中级工',
    category: '安全环保知识',
    chapter: '特殊作业',
    type: 'judge',
    question: '动火作业期间监护人员不得离开现场。',
    options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }],
    answer: ['A'],
    answerText: '',
    analysis: '监护人员应在作业现场全程监护。',
    images: [],
    status: 'normal',
    confidence: 1,
    issues: []
  },
  {
    id: 'demo_2',
    order: 2,
    number: '2',
    level: '中级工',
    category: '通用基础知识',
    chapter: '通信',
    type: 'multiple',
    question: '串行数据通信按传输的信息格式可分为哪两种方式？',
    options: [
      { key: 'A', text: '异步通信' },
      { key: 'B', text: '并行通信' },
      { key: 'C', text: '同步通信' },
      { key: 'D', text: '单同步行通信' }
    ],
    answer: ['A', 'C'],
    answerText: '',
    analysis: '按信息格式分为异步通信和同步通信。',
    images: [],
    status: 'normal',
    confidence: 1,
    issues: []
  },
  {
    id: 'demo_3',
    order: 3,
    number: '3',
    level: '中级工',
    category: '安全环保知识',
    chapter: '高处作业',
    type: 'single',
    question: '高处作业人员能否坐在平台、孔洞边缘休息？',
    options: [
      { key: 'A', text: '可以' },
      { key: 'B', text: '不可以' }
    ],
    answer: ['B'],
    answerText: '',
    analysis: '平台和孔洞边缘存在坠落风险，禁止坐卧休息。',
    images: [],
    status: 'normal',
    confidence: 1,
    issues: []
  },
  {
    id: 'demo_4',
    order: 4,
    number: '4',
    level: '中级工',
    category: '安全环保知识',
    chapter: '动火作业',
    type: 'short',
    question: '特级动火作业前应落实哪些主要措施？',
    options: [],
    answer: [],
    answerText: '应预先制定作业方案，落实安全防火、防爆及应急措施；在设备或管道上作业时，内部应保持微正压。',
    analysis: '',
    images: [],
    status: 'normal',
    confidence: 1,
    issues: []
  }
];
});
__define("pages/about/about.js", function(require, module, exports){
Page({})
});
__define("pages/bank-detail/bank-detail.js", function(require, module, exports){
const bankStorage = require('../../services/bank-storage');
const recordStorage = require('../../services/record-storage');
const { formatDate, formatBytes } = require('../../utils/text');
const { CURRENT_PARSER_VERSION } = require('../../utils/constants');

Page({
  data: {
    bankId: '',
    manifest: null,
    wrongCount: 0,
    favoriteCount: 0,
    needsReimport: false,
    memorizeSummary: '',
    currentParserVersion: CURRENT_PARSER_VERSION,
    titleFontRpx: 31
  },

  onLoad(query) {
    this.setData({ bankId: query.bankId || '' });
  },

  onShow() {
    this.load();
  },

  load() {
    try {
      const manifest = bankStorage.getManifest(this.data.bankId);
      if (!manifest) throw new Error('题库不存在');
      const wrong = recordStorage.getWrong(this.data.bankId);
      const nameUnits = Array.from(String(manifest.name || '')).reduce((sum, char) => sum + (/[^\x00-\xff]/.test(char) ? 1 : 0.56), 0);
      const titleFontRpx = nameUnits <= 14 ? 36 : (nameUnits <= 20 ? 31 : (nameUnits <= 25 ? 27 : (nameUnits <= 32 ? 24 : 22)));
      const expectedQuestionCount = Number(manifest.expectedQuestionCount || (manifest.diagnostics || {}).expectedQuestionCount) || 0;
      const expectedGap = expectedQuestionCount ? expectedQuestionCount - Number(manifest.questionCount || 0) : 0;
      const displayTypeCounts = manifest.displayTypeCounts || {
        单选题: Number((manifest.typeCounts || {}).single) || 0,
        多选题: Number((manifest.typeCounts || {}).multiple) || 0,
        判断题: Number((manifest.typeCounts || {}).judge) || 0,
        简答题: Number((manifest.typeCounts || {}).short) || 0
      };
      const displayTypeSummary = Object.entries(displayTypeCounts)
        .filter(([, count]) => Number(count) > 0)
        .map(([label, count]) => ({ label, shortLabel: label.replace(/题$/, ''), count: Number(count) }));
      const difficultySummary = Object.entries(manifest.difficultyCounts || {})
        .filter(([, count]) => Number(count) > 0)
        .map(([label, count]) => ({ label, count: Number(count) }));
      const memorizeProgress = typeof recordStorage.getMemorizeProgress === 'function'
        ? recordStorage.getMemorizeProgress(this.data.bankId) : null;
      const cursorEntries = Object.entries((memorizeProgress && memorizeProgress.cursors) || {})
        .filter(([, cursor]) => cursor && typeof cursor === 'object')
        .sort((left, right) => Number(right[1].updatedAt || 0) - Number(left[1].updatedAt || 0));
      let memorizeSummary = '点击选择顺序背题或随机背题';
      if (cursorEntries.length) {
        const [scopeKey, cursor] = cursorEntries[0];
        const orderLabel = String(scopeKey).startsWith('random|') ? '随机背题' : '顺序背题';
        memorizeSummary = `${orderLabel} · 上次第 ${Math.max(1, Number(cursor.index || 0) + 1)} 题`;
      } else if (memorizeProgress && memorizeProgress.cursor) {
        memorizeSummary = `顺序背题 · 上次第 ${Math.max(1, Number(memorizeProgress.cursor.index || 0) + 1)} 题`;
      }
      this.setData({
        manifest: {
          ...manifest,
          displayTypeSummary,
          difficultySummary,
          expectedQuestionCount,
          expectedGap,
          sourceMissingCount: Number(manifest.sourceMissingCount || (manifest.diagnostics || {}).sourceDeclaredMissingCount) || 0,
          sourceContentQuestionCount: Number(manifest.sourceContentQuestionCount || (manifest.diagnostics || {}).sourceContentQuestionCount || manifest.questionCount) || 0,
          usableQuestionCount: Number(manifest.usableQuestionCount || 0),
          expectedGapText: expectedQuestionCount
            ? (expectedGap > 0 ? `少 ${expectedGap} 道（未定位）` : (expectedGap < 0 ? `多 ${Math.abs(expectedGap)} 道` : '数量一致'))
            : '',
          updatedText: formatDate(manifest.updatedAt),
          sizeText: formatBytes(bankStorage.getBankSize(this.data.bankId))
        },
        wrongCount: Object.values(wrong).filter(item => !item.mastered).length,
        favoriteCount: recordStorage.getFavoriteIds(this.data.bankId).length,
        memorizeSummary,
        needsReimport: !manifest.parserVersion || manifest.parserVersion !== CURRENT_PARSER_VERSION,
        titleFontRpx
      });
      wx.setNavigationBarTitle({ title: manifest.name });
    } catch (error) {
      wx.showModal({
        title: '读取失败',
        content: error.message || String(error),
        showCancel: false,
        success: () => wx.navigateBack()
      });
    }
  },

  practice(event) {
    const mode = event.currentTarget.dataset.mode || 'sequence';
    wx.navigateTo({
      url: `/pages/practice-config/practice-config?bankId=${this.data.bankId}&mode=${mode}`
    });
  },

  exam() {
    wx.navigateTo({ url: `/pages/exam-config/exam-config?bankId=${this.data.bankId}` });
  },

  search() {
    wx.navigateTo({ url: `/pages/search/search?bankId=${this.data.bankId}` });
  },

  editBank() {
    wx.navigateTo({ url: `/pages/review/review?source=bank&bankId=${this.data.bankId}&filter=all&editMode=1` });
  },

  review() {
    wx.navigateTo({ url: `/pages/review/review?source=bank&bankId=${this.data.bankId}` });
  },

  rename() {
    wx.showModal({
      title: '重命名题库',
      editable: true,
      placeholderText: '输入题库名称',
      content: this.data.manifest.name,
      success: res => {
        if (!res.confirm || !res.content.trim()) return;
        try {
          bankStorage.renameBank(this.data.bankId, res.content);
          this.load();
        } catch (error) {
          wx.showModal({ title: '失败', content: error.message || String(error), showCancel: false });
        }
      }
    });
  },

  exportBank() {
    try {
      const filePath = bankStorage.exportBank(this.data.bankId);
      if (typeof wx.shareFileMessage === 'function') {
        wx.shareFileMessage({
          filePath,
          fileName: filePath.split('/').pop(),
          fail(error) {
            if (!/cancel/i.test(error.errMsg || '')) {
              wx.showModal({
                title: '分享失败',
                content: '题库包已生成，但系统未能打开分享面板。',
                showCancel: false
              });
            }
          }
        });
      } else {
        wx.showModal({
          title: '题库包已生成',
          content: '当前系统未能打开文件分享面板。',
          showCancel: false
        });
      }
    } catch (error) {
      wx.showModal({ title: '导出失败', content: error.message || String(error), showCancel: false });
    }
  },

  deleteBank() {
    wx.showModal({
      title: '删除题库',
      content: `确定删除“${this.data.manifest.name}”吗？将移除题目、图片、错题、收藏和进度，预计释放 ${this.data.manifest.sizeText}。`,
      confirmColor: '#b42318',
      success: res => {
        if (!res.confirm) return;
        try {
          const freed = bankStorage.deleteBank(this.data.bankId);
          recordStorage.clearBankRecords(this.data.bankId);
          wx.showToast({ title: `已释放${formatBytes(freed)}`, icon: 'none', duration: 1800 });
          setTimeout(() => wx.navigateBack(), 400);
        } catch (error) {
          wx.showModal({ title: '删除失败', content: error.message || String(error), showCancel: false });
        }
      }
    });
  }
});
});
__define("pages/banks/banks.js", function(require, module, exports){
const bankStorage = require('../../services/bank-storage');
const recordStorage = require('../../services/record-storage');
const { formatDate, formatBytes } = require('../../utils/text');
const { decorateBank } = require('../../utils/bank-display');

Page({
  data: {
    banks: [],
    totalSizeText: '0 B'
  },

  onShow() {
    this.load();
  },

  load() {
    const banks = bankStorage.listBanks().map(item => {
      const sizeBytes = bankStorage.getBankSize(item.id);
      return decorateBank({
        ...item,
        sizeBytes,
        sizeText: formatBytes(sizeBytes),
        updatedText: formatDate(item.updatedAt)
      });
    });
    this.setData({
      banks,
      totalSizeText: formatBytes(banks.reduce((sum, item) => sum + item.sizeBytes, 0))
    });
  },

  importFile() {
    wx.navigateTo({ url: '/pages/import/import' });
  },

  installDemo() {
    try {
      bankStorage.installDemoBank();
      wx.showToast({ title: '已安装', icon: 'success' });
      this.load();
    } catch (error) {
      wx.showModal({ title: '失败', content: error.message || String(error), showCancel: false });
    }
  },

  openBank(event) {
    wx.navigateTo({
      url: `/pages/bank-detail/bank-detail?bankId=${event.currentTarget.dataset.id}`
    });
  },

  deleteBank(event) {
    const id = event.currentTarget.dataset.id;
    const bank = this.data.banks.find(item => item.id === id);
    if (!bank) return;
    wx.showModal({
      title: '删除题库并释放空间',
      content: `确定删除“${bank.name}”吗？将同时删除题目文件、图片、错题、收藏和进度，预计释放 ${bank.sizeText}。`,
      confirmText: '删除',
      confirmColor: '#b42318',
      success: res => {
        if (!res.confirm) return;
        try {
          const freed = bankStorage.deleteBank(id);
          recordStorage.clearBankRecords(id);
          wx.showToast({ title: `已释放${formatBytes(freed)}`, icon: 'none', duration: 1800 });
          this.load();
        } catch (error) {
          wx.showModal({ title: '删除失败', content: error.message || String(error), showCancel: false });
        }
      }
    });
  }
});
});
__define("pages/editor/editor.js", function(require, module, exports){
const bankStorage = require('../../services/bank-storage');
const { validateQuestion } = require('../../services/question-validator');
const { QUESTION_TYPES } = require('../../utils/constants');

function isGenericVisualPlaceholder(value = '') {
  const clean = String(value || '').trim()
    .replace(/[\s()（）\[\]【】<>《》]/g, '')
    .replace(/[.。:：、，,;；]/g, '')
    .toLowerCase();
  return /^(?:图|图形|图片|图示|示意图|符号图|见图|如下图)$/.test(clean);
}

const DEFAULT_DISPLAY_TYPES = [
  { value: 'single', label: '单选题' },
  { value: 'multiple', label: '多选题' },
  { value: 'multiple', label: '不定项选择题' },
  { value: 'judge', label: '判断题' },
  { value: 'short', label: '填空题' },
  { value: 'short', label: '简答题' },
  { value: 'short', label: '计算题' },
  { value: 'short', label: '画图题' },
  { value: 'short', label: '匹配题' },
  { value: 'short', label: '排序题' },
  { value: 'short', label: '材料题' },
  { value: 'short', label: '案例题' }
];
const BUILTIN_LABELS = new Set(DEFAULT_DISPLAY_TYPES.map(item => item.label));
const CORE_TYPE_OPTIONS = [
  { value: 'single', label: '单选结构' },
  { value: 'multiple', label: '多选结构' },
  { value: 'judge', label: '判断结构' },
  { value: 'short', label: '主观题结构' }
];

function cleanOneLine(value = '') { return String(value || '').replace(/\s+/g, ' ').trim(); }
function coreTypeForLabel(label, fallback = 'short') {
  const text = String(label || '').trim();
  if (/判断/.test(text)) return 'judge';
  if (/不定项|多选|多项/.test(text)) return 'multiple';
  if (/单选|单项/.test(text)) return 'single';
  if (/填空|简答|问答|论述|计算|画图|作图|绘图|实操|主观|匹配|配对|排序|顺序|材料|案例/.test(text)) return 'short';
  return ['single', 'multiple', 'judge', 'short'].includes(fallback) ? fallback : 'short';
}
function normalizeCatalog(catalog = []) {
  const result = [];
  (Array.isArray(catalog) ? catalog : []).forEach(item => {
    const label = cleanOneLine(typeof item === 'string' ? item : item && item.label);
    if (!label || BUILTIN_LABELS.has(label) || result.some(row => row.label === label)) return;
    const candidate = typeof item === 'string' ? 'short' : (item.coreType || item.type);
    result.push({ label, coreType: coreTypeForLabel(label, candidate) });
  });
  return result;
}
function buildEditorTypeOptions(questions = [], currentQuestion = null, customCatalog = []) {
  const labels = [];
  const add = (label, type) => {
    const clean = cleanOneLine(label);
    if (!clean || labels.some(item => item.label === clean)) return;
    labels.push({ value: coreTypeForLabel(clean, type || 'short'), label: clean });
  };
  (questions || []).forEach(item => add(item.displayTypeLabel || QUESTION_TYPES[item.type] || item.type, item.type));
  if (currentQuestion) add(currentQuestion.displayTypeLabel || QUESTION_TYPES[currentQuestion.type] || currentQuestion.type, currentQuestion.type);
  normalizeCatalog(customCatalog).forEach(item => add(item.label, item.coreType));
  DEFAULT_DISPLAY_TYPES.forEach(item => add(item.label, item.value));
  return labels;
}
function sourceFragmentLabel(question) {
  const kind = String(question && question.source && question.source.kind || '').toLowerCase();
  if (['xlsx', 'xlsm', 'xltx', 'xltm', 'xls', 'ods', 'csv', 'tsv', 'excel'].includes(kind)) return `原始 ${kind === 'excel' ? 'Excel' : kind.toUpperCase()} 行`;
  if (kind === 'pdf') return '原始 PDF 文本片段';
  if (kind) return `原始 ${kind.toUpperCase()} 文本片段`;
  return '原始文件片段';
}

Page({
  data: {
    source: 'draft', bankId: '', draftIndex: -1, question: null,
    typeOptions: DEFAULT_DISPLAY_TYPES, typeIndex: 0,
    optionKeys: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
    canUndo: false, saving: false, rawSourceLabel: '原始文件片段',
    typeManagerVisible: false, customTypes: [], newTypeName: '', newCoreTypeIndex: 3, editingTypeLabel: '',
    coreTypeOptions: CORE_TYPE_OPTIONS
  },

  onLoad(query) {
    const source = query.source || 'draft';
    let question;
    const draftIndex = Number(query.index);
    let questionPool = [];
    let customCatalog = [];
    if (source === 'draft') {
      const draft = getApp().globalData.importDraft;
      questionPool = draft && Array.isArray(draft.questions) ? draft.questions : [];
      customCatalog = normalizeCatalog(draft && draft.customTypeCatalog);
      question = questionPool[draftIndex];
    } else {
      const bank = bankStorage.loadBank(query.bankId);
      questionPool = bank && Array.isArray(bank.questions) ? bank.questions : [];
      customCatalog = normalizeCatalog(bankStorage.getCustomTypeCatalog(query.bankId || ''));
      question = questionPool.find(item => item.id === query.questionId);
    }
    if (!question) {
      wx.showModal({ title: '题目不存在', content: '数据可能已失效。', showCancel: false });
      return;
    }
    this.questionPool = questionPool;
    this.customCatalog = customCatalog;
    question = JSON.parse(JSON.stringify(question));
    question.answer = Array.isArray(question.answer) ? question.answer : [];
    question.options = (question.options || []).map(item => {
      const images = Array.isArray(item.images) ? item.images : [];
      const text = images.length && isGenericVisualPlaceholder(item.text) ? '' : (item.text || '');
      return { ...item, text, images, selected: question.answer.includes(item.key) };
    });
    question.images = Array.isArray(question.images) ? question.images : [];
    question.answerImages = Array.isArray(question.answerImages) ? question.answerImages : [];
    question.analysisImages = Array.isArray(question.analysisImages) ? question.analysisImages : [];
    question.answerText = question.answerText || '';
    question.material = question.material || '';
    question.materialImages = Array.isArray(question.materialImages) ? question.materialImages : [];
    question.analysis = question.analysis || '';
    question.issues = Array.isArray(question.issues) ? question.issues : [];
    question.source = question.source || {};
    question.source.rawTexts = Array.isArray(question.source.rawTexts) ? question.source.rawTexts : [];
    question.boundarySource = question.boundarySource || '旧版题库';
    question.answerSource = question.answerSource || '';
    question.answerBoundarySource = question.answerBoundarySource || '';
    question.answerBoundaryConfidence = Number(question.answerBoundaryConfidence || 0);
    const typeOptions = buildEditorTypeOptions(questionPool, question, customCatalog);
    const currentLabel = question.displayTypeLabel || QUESTION_TYPES[question.type] || question.type;
    let typeIndex = typeOptions.findIndex(item => item.label === currentLabel);
    if (typeIndex < 0) typeIndex = typeOptions.findIndex(item => item.value === question.type);
    this.setData({
      source, bankId: query.bankId || '', draftIndex, question, typeOptions,
      typeIndex: Math.max(typeIndex, 0), rawSourceLabel: sourceFragmentLabel(question),
      canUndo: source === 'bank' && bankStorage.canUndoQuestionEdit(query.bankId || '', question.id),
      customTypes: this.buildCustomTypeRows(question, customCatalog)
    });
  },

  buildCustomTypeRows(currentQuestion = this.data.question, catalog = this.customCatalog) {
    const pool = (this.questionPool || []).map(item => currentQuestion && item && currentQuestion.id && item.id === currentQuestion.id ? currentQuestion : item);
    if (currentQuestion && !pool.some(item => item && currentQuestion.id && item.id === currentQuestion.id)) pool.push(currentQuestion);
    return normalizeCatalog(catalog).map(item => ({
      ...item,
      usageCount: pool.filter(question => cleanOneLine(question && (question.displayTypeLabel || QUESTION_TYPES[question.type] || question.type)) === item.label).length
    }));
  },

  persistCustomCatalog(catalog) {
    this.customCatalog = normalizeCatalog(catalog);
    if (this.data.source === 'draft') {
      const draft = getApp().globalData.importDraft;
      if (draft) draft.customTypeCatalog = this.customCatalog.slice();
    } else this.customCatalog = bankStorage.saveCustomTypeCatalog(this.data.bankId, this.customCatalog);
  },

  refreshTypeOptions(preferredLabel = '') {
    const typeOptions = buildEditorTypeOptions(this.questionPool || [], this.data.question, this.customCatalog);
    const wanted = preferredLabel || (this.data.question && (this.data.question.displayTypeLabel || QUESTION_TYPES[this.data.question.type] || this.data.question.type));
    let typeIndex = typeOptions.findIndex(item => item.label === wanted);
    if (typeIndex < 0) typeIndex = 0;
    this.setData({ typeOptions, typeIndex, customTypes: this.buildCustomTypeRows(this.data.question, this.customCatalog) });
    return typeIndex;
  },

  setQuestionField(field, value) { this.setData({ [`question.${field}`]: value }); },
  onMaterialInput(event) { this.setQuestionField('material', event.detail.value); },
  onQuestionInput(event) { this.setQuestionField('question', event.detail.value); },
  onCategoryInput(event) { this.setQuestionField('category', event.detail.value); },
  onDifficultyInput(event) { this.setQuestionField('difficulty', event.detail.value); },
  onAnalysisInput(event) { this.setQuestionField('analysis', event.detail.value); },
  onAnswerTextInput(event) { this.setQuestionField('answerText', event.detail.value); },

  applyTypeSelection(typeIndex) {
    const selected = this.data.typeOptions[typeIndex];
    if (!selected) return;
    const type = selected.value;
    const patch = { type, displayTypeLabel: selected.label };
    if (type === 'judge') {
      patch.options = [{ key: 'A', text: '正确', images: [], selected: false }, { key: 'B', text: '错误', images: [], selected: false }];
      patch.answer = [];
    } else if (type === 'short') {
      patch.options = [];
      patch.answer = [];
    } else if (!Array.isArray(this.data.question.options) || !this.data.question.options.length) {
      patch.options = ['A', 'B', 'C', 'D'].map(key => ({ key, text: '', images: [], selected: false }));
      patch.answer = [];
    }
    const question = Object.assign({}, this.data.question, patch);
    this.setData({ typeIndex, question, customTypes: this.buildCustomTypeRows(question, this.customCatalog) });
  },
  onTypeChange(event) { this.applyTypeSelection(Number(event.detail.value)); },

  openTypeManager() { this.setData({ typeManagerVisible: true, customTypes: this.buildCustomTypeRows(this.data.question, this.customCatalog) }); },
  closeTypeManager() { this.setData({ typeManagerVisible: false, newTypeName: '', editingTypeLabel: '', newCoreTypeIndex: 3 }); },
  stopTap() {},
  onNewTypeNameInput(event) { this.setData({ newTypeName: event.detail.value }); },
  onNewCoreTypeChange(event) { this.setData({ newCoreTypeIndex: Number(event.detail.value) }); },
  editCustomType(event) {
    const label = String(event.currentTarget.dataset.label || '');
    const row = (this.data.customTypes || []).find(item => item.label === label);
    if (!row) return;
    const coreIndex = Math.max(0, this.data.coreTypeOptions.findIndex(item => item.value === row.coreType));
    this.setData({ editingTypeLabel: row.label, newTypeName: row.label, newCoreTypeIndex: coreIndex });
  },
  cancelCustomTypeEdit() {
    this.setData({ editingTypeLabel: '', newTypeName: '', newCoreTypeIndex: 3 });
  },
  saveCustomType() {
    const label = cleanOneLine(this.data.newTypeName);
    const oldLabel = cleanOneLine(this.data.editingTypeLabel);
    if (!label) return wx.showToast({ title: '请输入题型名称', icon: 'none' });
    if (this.data.typeOptions.some(item => item.label === label && item.label !== oldLabel)) return wx.showToast({ title: '该题型已存在', icon: 'none' });
    const coreType = this.data.coreTypeOptions[this.data.newCoreTypeIndex].value;
    try {
      if (!oldLabel) {
        this.persistCustomCatalog([...(this.customCatalog || []), { label, coreType }]);
      } else {
        if (this.data.source === 'bank') {
          const result = bankStorage.renameCustomType(this.data.bankId, oldLabel, label, coreType);
          this.customCatalog = normalizeCatalog(result.catalog || []);
          this.questionPool = bankStorage.loadQuestions(this.data.bankId);
        } else {
          const draft = getApp().globalData.importDraft;
          const questions = draft && Array.isArray(draft.questions) ? draft.questions : [];
          questions.forEach(question => {
            const current = cleanOneLine(question && (question.displayTypeLabel || QUESTION_TYPES[question.type] || question.type));
            if (current !== oldLabel) return;
            question.displayTypeLabel = label;
            question.type = coreType;
          });
          this.questionPool = questions;
          const nextCatalog = (this.customCatalog || []).map(item => item.label === oldLabel ? { label, coreType } : item);
          this.persistCustomCatalog(nextCatalog);
        }
        const currentLabel = cleanOneLine(this.data.question && (this.data.question.displayTypeLabel || QUESTION_TYPES[this.data.question.type] || this.data.question.type));
        if (currentLabel === oldLabel) {
          this.setData({ 'question.displayTypeLabel': label, 'question.type': coreType });
        }
      }
      const typeOptions = buildEditorTypeOptions(this.questionPool || [], this.data.question, this.customCatalog);
      const typeIndex = typeOptions.findIndex(item => item.label === label);
      this.setData({
        typeOptions,
        typeIndex: Math.max(0, typeIndex),
        newTypeName: '',
        editingTypeLabel: '',
        newCoreTypeIndex: 3,
        customTypes: this.buildCustomTypeRows(this.data.question, this.customCatalog)
      }, () => {
        if (!oldLabel) this.applyTypeSelection(typeIndex);
      });
      wx.showToast({ title: oldLabel ? '题型已更新' : '已创建并使用', icon: 'success' });
    } catch (error) {
      wx.showModal({ title: oldLabel ? '修改失败' : '创建失败', content: error.message || String(error), showCancel: false });
    }
  },
  deleteCustomType(event) {
    const label = String(event.currentTarget.dataset.label || '');
    const row = (this.data.customTypes || []).find(item => item.label === label);
    if (!row) return;
    if (row.usageCount > 0) {
      wx.showModal({ title: '暂时不能删除', content: `还有 ${row.usageCount} 道题使用“${label}”。请先把这些题改成其他题型。`, showCancel: false });
      return;
    }
    wx.showModal({
      title: '删除自定义题型', content: `确认删除“${label}”吗？`, confirmText: '删除', confirmColor: '#b42318',
      success: result => {
        if (!result.confirm) return;
        try {
          this.persistCustomCatalog((this.customCatalog || []).filter(item => item.label !== label));
          this.refreshTypeOptions();
          wx.showToast({ title: '已删除', icon: 'success' });
        } catch (error) { wx.showModal({ title: '删除失败', content: error.message || String(error), showCancel: false }); }
      }
    });
  },

  onOptionInput(event) { this.setData({ [`question.options[${Number(event.currentTarget.dataset.index)}].text`]: event.detail.value }); },
  addOption() {
    const options = this.data.question.options.slice();
    if (options.length >= 8) return;
    options.push({ key: this.data.optionKeys[options.length], text: '', images: [], selected: false });
    this.setData({ 'question.options': options });
  },
  removeOption(event) {
    const index = Number(event.currentTarget.dataset.index);
    const options = this.data.question.options.slice();
    options.splice(index, 1);
    options.forEach((item, i) => { item.key = this.data.optionKeys[i]; });
    this.setData({ 'question.options': options, 'question.answer': options.filter(item => item.selected).map(item => item.key) });
  },
  toggleAnswer(event) {
    const key = event.currentTarget.dataset.key;
    let answer = this.data.question.answer.slice();
    if (this.data.question.type === 'single' || this.data.question.type === 'judge') answer = [key];
    else { const index = answer.indexOf(key); if (index >= 0) answer.splice(index, 1); else answer.push(key); }
    this.setData({ 'question.answer': answer, 'question.options': this.data.question.options.map(item => ({ ...item, selected: answer.includes(item.key) })) });
  },

  moveImage(fromField, toField, index) {
    const from = Array.isArray(this.data.question[fromField]) ? this.data.question[fromField].slice() : [];
    const to = Array.isArray(this.data.question[toField]) ? this.data.question[toField].slice() : [];
    const image = from.splice(index, 1)[0];
    if (!image) return;
    to.push(image);
    this.setData({ [`question.${fromField}`]: from, [`question.${toField}`]: to });
  },
  removeImage(field, index) {
    const images = Array.isArray(this.data.question[field]) ? this.data.question[field].slice() : [];
    images.splice(index, 1);
    this.setData({ [`question.${field}`]: images });
  },
  moveMaterialImageToQuestion(event) { this.moveImage('materialImages', 'images', Number(event.currentTarget.dataset.index)); },
  removeMaterialImage(event) { this.removeImage('materialImages', Number(event.currentTarget.dataset.index)); },
  moveQuestionImageToAnswer(event) { this.moveImage('images', 'answerImages', Number(event.currentTarget.dataset.index)); },
  moveAnswerImageToQuestion(event) { this.moveImage('answerImages', 'images', Number(event.currentTarget.dataset.index)); },
  removeQuestionImage(event) { this.removeImage('images', Number(event.currentTarget.dataset.index)); },
  removeAnswerImage(event) { this.removeImage('answerImages', Number(event.currentTarget.dataset.index)); },

  save() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    const question = JSON.parse(JSON.stringify(this.data.question));
    question.options = (question.options || []).map(({ key, text, images }) => ({ key, text, images: (images || []).slice() }));
    Object.assign(question, validateQuestion(question));
    try {
      if (this.data.source === 'draft') {
        const draft = getApp().globalData.importDraft;
        draft.questions[this.data.draftIndex] = question;
        draft.customTypeCatalog = normalizeCatalog(this.customCatalog);
        draft.counts = draft.questions.reduce((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, { normal: 0, warning: 0, error: 0 });
      } else bankStorage.updateQuestion(this.data.bankId, question);
      this.setData({ canUndo: this.data.source === 'bank', saving: false });
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 400);
    } catch (error) {
      this.setData({ saving: false });
      wx.showModal({ title: '保存失败', content: error.message || String(error), showCancel: false });
    }
  },

  undoLastEdit() {
    if (this.data.source !== 'bank' || !this.data.question || !this.data.canUndo) return;
    wx.showModal({
      title: '撤销上次保存', content: '将把这道题恢复到最近一次保存前的内容。撤销后不能再次恢复刚才的修改。', confirmText: '确认撤销',
      success: result => {
        if (!result.confirm) return;
        try {
          bankStorage.undoLastQuestionEdit(this.data.bankId, this.data.question.id);
          this.setData({ canUndo: false });
          wx.showToast({ title: '已撤销', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 350);
        } catch (error) { wx.showModal({ title: '撤销失败', content: error.message || String(error), showCancel: false }); }
      }
    });
  }
});
});
__define("pages/exam/exam.js", function(require, module, exports){
const bankStorage = require('../../services/bank-storage');
const practiceService = require('../../services/practice-service');
const recordStorage = require('../../services/record-storage');
const { QUESTION_TYPES } = require('../../utils/constants');

const SHEET_TYPE_CLASS_ORDER = [
  'sheet-type-single', 'sheet-type-multiple', 'sheet-type-judge', 'sheet-type-fill',
  'sheet-type-short', 'sheet-type-calc', 'sheet-type-drawing', 'sheet-type-other-0',
  'sheet-type-other-1', 'sheet-type-other-2'
];
function sheetTypeLabel(question) {
  return String(question && (question.displayTypeLabel || QUESTION_TYPES[question.type] || question.type) || '未知题型').trim();
}
function sheetTypeClass(question, label = sheetTypeLabel(question)) {
  const type = String(question && question.type || '');
  if (type === 'single' || type === 'choice_error' || label === '单选题') return 'sheet-type-single';
  if (type === 'multiple' || label === '多选题') return 'sheet-type-multiple';
  if (type === 'judge' || label === '判断题') return 'sheet-type-judge';
  if (/填空/.test(label)) return 'sheet-type-fill';
  if (type === 'short' || /简答/.test(label)) return 'sheet-type-short';
  if (/计算/.test(label)) return 'sheet-type-calc';
  if (/画图|作图|绘图/.test(label)) return 'sheet-type-drawing';
  let hash = 0;
  Array.from(label).forEach(char => { hash = (hash * 31 + char.charCodeAt(0)) >>> 0; });
  return SHEET_TYPE_CLASS_ORDER[7 + (hash % 3)];
}

function buildTopChipClasses() {
  // 各角色固定使用彼此差异明显的莫奈色；切换题目、重新渲染都不会换色。
  // 绿色专用于“掌握”，顶部功能胶囊不再使用青绿系，避免题卡与掌握混淆。
  return {
    typeChipClass: 'chip-tone-blue',
    difficultyChipClass: 'chip-tone-amber',
    sheetChipClass: 'chip-tone-violet',
    editChipClass: 'chip-tone-rose'
  };
}

Page({
  data: {
    session: null,
    question: null,
    selected: [],
    shortText: '',
    typeLabel: '',
    difficulty: '',
    isAbnormal: false,
    typeChipClass: 'chip-tone-blue',
    difficultyChipClass: 'chip-tone-amber',
    sheetChipClass: 'chip-tone-violet',
    editChipClass: 'chip-tone-rose',
    progressText: '',
    remainingText: '',
    fontScale: 1,
    answerBottomLift: 48,
    answerSheetOpen: false,
    answerSheet: [],
    sheetTypeItems: [],
    sheetStatusFilter: 'all',
    sheetTypeFilter: 'all',
    sheetAnsweredCount: 0,
    sheetUnansweredCount: 0,
    sheetTotalCount: 0,
    sheetFilteredCount: 0,
    sheetHasFilter: false,
    sheetCurrentExcluded: false
  },

  onLoad() {
    const session = getApp().globalData.currentSession;
    if (!session || !session.exam || !session.questions.length) {
      wx.showModal({
        title: '考试已失效',
        content: '请重新开始考试。',
        showCancel: false,
        success: () => wx.navigateBack()
      });
      return;
    }
    const settings = recordStorage.getSettings();
    this.topChipClasses = buildTopChipClasses([
      session.bankId || '',
      'exam',
      session.examMode || '',
      session.durationMinutes || ''
    ].join('|'));
    session.answers = session.answers || {};
    session.results = session.results || {};
    session.shortAnswers = session.shortAnswers || {};
    if (session.editPausedAt) {
      session.startedAt += Math.max(0, Date.now() - Number(session.editPausedAt));
      delete session.editPausedAt;
    }
    this.pageVisible = true;
    this.setData({
      session,
      fontScale: Number(settings.fontScale) || 1,
      answerBottomLift: Math.max(0, Math.min(120, Number(settings.answerBottomLift) || 48))
    });
    this.renderQuestion();
    this.persistExamDraft('exam-open');
    this.startTimer();
    this.persistOnVisibilityChange = () => {
      if (document.visibilityState === 'hidden') this.persistExamDraft('visibility-hidden');
    };
    this.persistOnPageHide = () => this.persistExamDraft('page-hide');
    document.addEventListener('visibilitychange', this.persistOnVisibilityChange, { passive: true });
    window.addEventListener('pagehide', this.persistOnPageHide, { passive: true });
  },

  onShow() {
    this.pageVisible = true;
    this.applyLatestSettings();
    if (!this.pendingQuestionEdit) return;
    this.pendingQuestionEdit = false;
    const pausedAt = Number(this.data.session.editPausedAt || this.editPauseStartedAt || 0);
    if (pausedAt) {
      this.data.session.startedAt += Math.max(0, Date.now() - pausedAt);
      delete this.data.session.editPausedAt;
      this.editPauseStartedAt = 0;
    }
    this.refreshEditedQuestion();
    this.persistExamDraft('edit-return');
    this.startTimer();
  },

  applyLatestSettings() {
    const settings = recordStorage.getSettings();
    this.setData({
      fontScale: Number(settings.fontScale) || 1,
      answerBottomLift: Math.max(0, Math.min(120, Number(settings.answerBottomLift) || 48))
    });
    // 进行中的考试不重排选项，避免已作答键位改变；其他显示类设置返回后立即生效。
  },

  onHide() {
    this.pageVisible = false;
    this.persistExamDraft('page-hide-lifecycle');
  },

  onUnload() {
    if (!this.submitting) this.persistExamDraft('page-unload');
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.persistOnVisibilityChange) document.removeEventListener('visibilitychange', this.persistOnVisibilityChange);
    if (this.persistOnPageHide) window.removeEventListener('pagehide', this.persistOnPageHide);
    this.persistOnVisibilityChange = null;
    this.persistOnPageHide = null;
  },

  persistExamDraft(reason = '') {
    if (this.submitting || !this.data.session) return false;
    this.data.session.draftReason = reason;
    this.data.session.savedAt = Date.now();
    getApp().globalData.currentSession = this.data.session;
    return recordStorage.saveExamDraft(this.data.session);
  },

  startTimer() {
    if (this.timer) clearInterval(this.timer);
    const session = this.data.session;
    const duration = session.durationMinutes * 60;
    const tick = () => {
      const elapsed = Math.floor((Date.now() - session.startedAt) / 1000);
      const remaining = Math.max(0, duration - elapsed);
      const minutes = String(Math.floor(remaining / 60)).padStart(2, '0');
      const seconds = String(remaining % 60).padStart(2, '0');
      this.setData({ remainingText: `${minutes}:${seconds}` });
      if (remaining <= 0) {
        clearInterval(this.timer);
        this.submitExam(true);
      }
    };
    tick();
    this.timer = setInterval(tick, 1000);
  },


  decorateOptions(question, selected) {
    const isGenericVisualText = value => /^(?:图|图形|图片|图示|示意图|符号图|见图|如下图)$/i.test(
      String(value || '').replace(/[\s()（）\[\]【】<>《》.。:：、，,;；]/g, '')
    );
    return (question.options || []).map(item => {
      const hasImages = Array.isArray(item.images) && item.images.length > 0;
      return {
        ...item,
        hasImages,
        visualOnly: hasImages && isGenericVisualText(item.text),
        stateClass: selected.includes(item.key) ? 'selected' : ''
      };
    });
  },

  renderQuestion() {
    const session = this.data.session;
    const question = session.questions[session.index];
    const selected = session.answers[question.id] || [];
    const shortText = question.type === 'short' ? (session.shortAnswers && session.shortAnswers[question.id]) || '' : '';
    const isAbnormal = (question.status || 'normal') !== 'normal';
    const baseTypeLabel = question.displayTypeLabel || QUESTION_TYPES[question.type] || question.type;
    const typeLabel = isAbnormal && !/^异常/.test(String(baseTypeLabel || '')) ? `异常${baseTypeLabel}` : baseTypeLabel;
    const chipClasses = this.topChipClasses || buildTopChipClasses([
      session.bankId || '', 'exam', session.examMode || '', session.durationMinutes || ''
    ].join('|'));
    this.setData({
      question,
      selected,
      displayOptions: this.decorateOptions(question, selected),
      shortText,
      typeLabel,
      isAbnormal,
      difficulty: question.difficulty || '',
      ...chipClasses,
      progressText: `${session.index + 1} / ${session.questions.length}`
    }, () => this.updateSheet());
    this.persistExamDraft('render-question');
  },

  editCurrentQuestion() {
    const session = this.data.session;
    const current = this.data.question;
    if (!session || !current) return;
    try {
      const stored = bankStorage.loadQuestions(session.bankId).find(item => item.id === current.id) || current;
      this.editQuestionSnapshot = practiceService.buildQuestionEditSignature(stored);
      this.pendingQuestionEdit = true;
      this.editPauseStartedAt = Date.now();
      session.editPausedAt = this.editPauseStartedAt;
      this.persistExamDraft('before-edit');
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      wx.navigateTo({
        url: `/pages/editor/editor?source=bank&bankId=${encodeURIComponent(session.bankId)}&questionId=${encodeURIComponent(current.id)}`
      });
    } catch (error) {
      this.pendingQuestionEdit = false;
      delete session.editPausedAt;
      this.editPauseStartedAt = 0;
      this.persistExamDraft('edit-open-failed');
      this.startTimer();
      wx.showModal({ title: '无法编辑题目', content: error.message || String(error), showCancel: false });
    }
  },

  refreshEditedQuestion() {
    const session = this.data.session;
    if (!session || !session.questions.length) return;
    const previous = session.questions[session.index];
    if (!previous) return;
    try {
      const fresh = bankStorage.loadQuestions(session.bankId).find(item => item.id === previous.id);
      if (!fresh) throw new Error('保存后未找到当前题目');
      const beforeSignature = this.editQuestionSnapshot || practiceService.buildQuestionEditSignature(previous);
      const afterSignature = practiceService.buildQuestionEditSignature(fresh);
      const answerContentChanged = beforeSignature !== afterSignature;
      const previousSelected = Array.isArray(session.answers[previous.id]) ? session.answers[previous.id].slice() : [];
      const previousShortText = session.shortAnswers && session.shortAnswers[previous.id];

      session.questions[session.index] = fresh;
      if (answerContentChanged) {
        delete session.answers[previous.id];
        if (session.shortAnswers) delete session.shortAnswers[previous.id];
        delete session.results[previous.id];
      } else if (fresh.type !== 'short') {
        const remapped = practiceService.remapSelectedOptions(previous, fresh, previousSelected);
        if (remapped.length) session.answers[fresh.id] = remapped;
        else delete session.answers[fresh.id];
      } else if (previousShortText) {
        session.shortAnswers = session.shortAnswers || {};
        session.shortAnswers[fresh.id] = previousShortText;
      }
      this.editQuestionSnapshot = '';
      getApp().globalData.currentSession = session;
      this.setData({ session }, () => { this.renderQuestion(); this.persistExamDraft('edit-refresh'); });
    } catch (error) {
      this.editQuestionSnapshot = '';
      wx.showModal({ title: '题目刷新失败', content: error.message || String(error), showCancel: false });
    }
  },

  selectOption(event) {
    const key = event.currentTarget.dataset.key;
    const question = this.data.question;
    const session = this.data.session;
    let selected = (session.answers[question.id] || []).slice();

    if (question.type === 'multiple') {
      const index = selected.indexOf(key);
      if (index >= 0) selected.splice(index, 1);
      else selected.push(key);
    } else {
      selected = [key];
    }

    session.answers[question.id] = selected;
    this.setData({ session, selected, displayOptions: this.decorateOptions(question, selected) }, () => { this.updateSheet(); this.persistExamDraft('answer-change'); });
  },

  onShortInput(event) {
    const session = this.data.session;
    session.shortAnswers = session.shortAnswers || {};
    session.shortAnswers[this.data.question.id] = event.detail.value;
    this.setData({ session, shortText: event.detail.value }, () => { this.updateSheet(); this.persistExamDraft('short-answer-change'); });
  },

  updateSheet() {
    const session = this.data.session;
    const typeMap = new Map();
    let answeredCount = 0;
    const allItems = session.questions.map((item, index) => {
      const answered = item.type === 'short'
        ? Boolean(session.shortAnswers && String(session.shortAnswers[item.id] || '').trim())
        : Boolean(session.answers[item.id] && session.answers[item.id].length);
      if (answered) answeredCount += 1;
      const typeLabel = sheetTypeLabel(item);
      const typeClass = sheetTypeClass(item, typeLabel);
      if (!typeMap.has(typeLabel)) typeMap.set(typeLabel, { key: typeLabel, label: typeLabel, typeClass, count: 0 });
      typeMap.get(typeLabel).count += 1;
      return {
        index,
        number: index + 1,
        answered,
        status: answered ? 'answered' : 'unanswered',
        typeKey: typeLabel,
        typeClass,
        current: index === session.index,
        longNumber: index + 1 >= 1000
      };
    });
    this.answerSheetAll = allItems;
    const types = Array.from(typeMap.values());
    const validType = types.some(item => item.key === this.data.sheetTypeFilter)
      ? this.data.sheetTypeFilter : 'all';
    this.setData({
      sheetTypeItems: types,
      sheetTypeFilter: validType,
      sheetAnsweredCount: answeredCount,
      sheetUnansweredCount: allItems.length - answeredCount,
      sheetTotalCount: allItems.length
    }, () => this.applySheetFilters());
  },

  applySheetFilters(scrollMode = '') {
    const statusFilter = this.data.sheetStatusFilter || 'all';
    const typeFilter = this.data.sheetTypeFilter || 'all';
    const items = (this.answerSheetAll || []).filter(item =>
      (statusFilter === 'all' || item.status === statusFilter)
      && (typeFilter === 'all' || item.typeKey === typeFilter)
    );
    const currentIndex = this.data.session ? Number(this.data.session.index) : -1;
    const currentIncluded = items.some(item => item.index === currentIndex);
    this.setData({
      answerSheet: items,
      sheetFilteredCount: items.length,
      sheetHasFilter: statusFilter !== 'all' || typeFilter !== 'all',
      sheetCurrentExcluded: items.length > 0 && !currentIncluded
    }, () => {
      if (scrollMode) this.scheduleExamSheetScroll(scrollMode);
    });
  },

  scheduleExamSheetScroll(mode = 'current') {
    if (this.examSheetScrollTimer) clearTimeout(this.examSheetScrollTimer);
    this.examSheetScrollTimer = setTimeout(() => {
      this.examSheetScrollTimer = null;
      const run = () => this.scrollExamSheet(mode);
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(run));
      else run();
    }, 30);
  },

  scrollExamSheet(mode = 'current') {
    if (!this.data.answerSheetOpen || typeof document === 'undefined') return;
    const root = document.querySelector('#page-root[data-page="pages/exam/exam"]') || document;
    const container = root.querySelector('.exam-sheet-scroll');
    if (!container) return;
    let target = null;
    if (mode === 'current' && this.data.session) {
      target = container.querySelector(`.sheet-item[data-index="${Number(this.data.session.index)}"]`);
    }
    if (!target) target = container.querySelector('.sheet-item');
    if (!target) { container.scrollTop = 0; return; }
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const top = container.scrollTop + targetRect.top - containerRect.top
      - Math.max(0, (containerRect.height - targetRect.height) / 2);
    if (typeof container.scrollTo === 'function') container.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    else container.scrollTop = Math.max(0, top);
  },

  filterSheetStatus(event) {
    const selected = String(event.currentTarget.dataset.status || 'all');
    const next = selected === this.data.sheetStatusFilter ? 'all' : selected;
    this.setData({ sheetStatusFilter: next }, () => this.applySheetFilters('first'));
  },

  filterSheetType(event) {
    const selected = String(event.currentTarget.dataset.type || 'all');
    const next = selected === this.data.sheetTypeFilter ? 'all' : selected;
    this.setData({ sheetTypeFilter: next }, () => this.applySheetFilters('first'));
  },

  clearSheetFilters() {
    this.setData({ sheetStatusFilter: 'all', sheetTypeFilter: 'all' }, () => this.applySheetFilters('current'));
  },

  onTouchStart(event) {
    const touch = event && event.touches && event.touches[0];
    if (!touch) return;
    this.swipeStart = {
      x: Number(touch.clientX || touch.pageX || 0),
      y: Number(touch.clientY || touch.pageY || 0),
      time: Date.now()
    };
  },

  onTouchEnd(event) {
    if (this.swipeLocked || !this.swipeStart || this.data.answerSheetOpen) return;
    const touch = event && event.changedTouches && event.changedTouches[0];
    const start = this.swipeStart;
    this.swipeStart = null;
    if (!touch) return;

    const dx = Number(touch.clientX || touch.pageX || 0) - start.x;
    const dy = Number(touch.clientY || touch.pageY || 0) - start.y;
    const elapsed = Date.now() - start.time;
    if (elapsed > 900 || Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.35) return;

    this.swipeLocked = true;
    setTimeout(() => { this.swipeLocked = false; }, 380);
    if (dx < 0) this.next();
    else this.previous();
  },

  previous() {
    if (this.data.session.index <= 0) return;
    const session = this.data.session;
    session.index -= 1;
    this.setData({ session }, () => { this.renderQuestion(); this.persistExamDraft('previous-question'); });
  },

  next() {
    if (this.data.session.index >= this.data.session.questions.length - 1) {
      this.confirmSubmit();
      return;
    }
    const session = this.data.session;
    session.index += 1;
    this.setData({ session }, () => { this.renderQuestion(); this.persistExamDraft('next-question'); });
  },

  toggleSheet() {
    const opening = !this.data.answerSheetOpen;
    if (!opening && this.examSheetScrollTimer) clearTimeout(this.examSheetScrollTimer);
    if (opening) this.updateSheet();
    this.setData({ answerSheetOpen: opening }, () => {
      if (opening) this.applySheetFilters('current');
    });
  },

  jump(event) {
    const session = this.data.session;
    session.index = Number(event.currentTarget.dataset.index);
    this.setData({ session, answerSheetOpen: false }, () => { this.renderQuestion(); this.persistExamDraft('sheet-jump'); });
  },

  confirmSubmit() {
    const session = this.data.session;
    const answered = (this.answerSheetAll || []).filter(item => item.answered).length;
    wx.showModal({
      title: '确认交卷',
      content: `已作答 ${answered}/${session.questions.length} 题。确定交卷吗？`,
      success: res => {
        if (res.confirm) this.submitExam(false);
      }
    });
  },

  submitExam(autoSubmit) {
    if (this.submitting) return;
    this.submitting = true;
    if (this.timer) clearInterval(this.timer);

    const session = this.data.session;
    let objectiveTotal = 0;
    let objectiveAnswered = 0;
    let correct = 0;
    let shortCount = 0;

    session.questions.forEach(question => {
      if (question.type === 'short') {
        shortCount += 1;
        return;
      }
      objectiveTotal += 1;
      const selected = session.answers[question.id] || [];
      if (selected.length) objectiveAnswered += 1;
      const result = practiceService.judgeQuestion(question, selected);
      session.results[question.id] = result;
      if (result.correct) correct += 1;
      if (selected.length) {
        if (result.correct) recordStorage.markCorrect(session.bankId, question.id);
        else recordStorage.markWrong(session.bankId, question.id);
        recordStorage.recordAnswer(result.correct, { bankId: session.bankId, type: question.type, typeLabel: question.displayTypeLabel || '', difficulty: question.difficulty || '', category: question.category || '' });
      }
    });

    recordStorage.recordExam();
    recordStorage.clearExamDraft();
    getApp().globalData.currentSession = session;
    getApp().globalData.resultData = {
      title: autoSubmit ? '时间到，已自动交卷' : '考试完成',
      total: session.questions.length,
      answered: objectiveAnswered + Object.keys(session.shortAnswers || {}).filter(key => session.shortAnswers[key]).length,
      correct,
      objectiveTotal,
      shortCount,
      accuracy: objectiveTotal ? Math.round(correct / objectiveTotal * 100) : 0,
      duration: Math.round((Date.now() - session.startedAt) / 1000),
      exam: true
    };
    wx.redirectTo({ url: '/pages/result/result' });
  }
});
});
__define("pages/exam-review/exam-review.js", function(require, module, exports){
const practiceService = require('../../services/practice-service');
const { QUESTION_TYPES } = require('../../utils/constants');

Page({
  data: {
    filterOptions: [
      { value: 'all', label: '全部' },
      { value: 'wrong', label: '错题' },
      { value: 'unanswered', label: '未答' },
      { value: 'short', label: '简答题' }
    ],
    filter: 'all',
    question: null,
    displayOptions: [],
    typeLabel: '',
    difficulty: '',
    progressText: '',
    statusLabel: '',
    statusClass: '',
    selectedAnswer: '',
    correctAnswer: '',
    shortAnswer: '',
    analysis: '',
    filteredCount: 0,
    isFirst: true,
    isLast: false,
    sheetOpen: false,
    sheetItems: []
  },

  onLoad() {
    const session = getApp().globalData.currentSession;
    if (!session || !session.exam || !Array.isArray(session.questions) || !session.questions.length) {
      wx.showModal({ title: '试卷已失效', content: '本次考试数据已不存在。', showCancel: false, success: () => wx.navigateBack() });
      return;
    }
    this.session = session;
    this.applyFilter('all');
  },

  questionStatus(question) {
    if (question.type === 'short') {
      return String(this.session.shortAnswers && this.session.shortAnswers[question.id] || '').trim() ? 'short' : 'unanswered';
    }
    const selected = this.session.answers[question.id] || [];
    if (!selected.length) return 'unanswered';
    const result = this.session.results[question.id] || practiceService.judgeQuestion(question, selected);
    return result.correct ? 'correct' : 'wrong';
  },

  applyFilter(filter) {
    this.setData({ filter });
    const indices = [];
    this.session.questions.forEach((question, index) => {
      const status = this.questionStatus(question);
      if (filter === 'all'
        || (filter === 'wrong' && status === 'wrong')
        || (filter === 'unanswered' && status === 'unanswered')
        || (filter === 'short' && question.type === 'short')) indices.push(index);
    });
    this.filteredIndices = indices;
    this.filteredPosition = 0;
    if (!indices.length) {
      this.setData({ question: null, filteredCount: 0, sheetItems: [] });
      return;
    }
    this.renderQuestion();
  },

  changeFilter(event) {
    this.applyFilter(event.currentTarget.dataset.value || 'all');
  },

  decorateOptions(question, selected) {
    const correct = new Set(question.answer || []);
    const chosen = new Set(selected || []);
    return (question.options || []).map(option => {
      const isCorrect = correct.has(option.key);
      const isChosen = chosen.has(option.key);
      let stateClass = '';
      if (isCorrect && isChosen) stateClass = 'chosen-correct';
      else if (isCorrect) stateClass = 'correct';
      else if (isChosen) stateClass = 'chosen-wrong';
      return { ...option, stateClass, isChosen, isCorrect };
    });
  },

  renderQuestion() {
    if (!this.filteredIndices || !this.filteredIndices.length) return;
    const originalIndex = this.filteredIndices[this.filteredPosition];
    const question = this.session.questions[originalIndex];
    const selected = this.session.answers[question.id] || [];
    const status = this.questionStatus(question);
    const labelMap = { correct: '回答正确', wrong: '回答错误', unanswered: '未作答', short: '主观题（不自动计分）' };
    this.setData({
      question,
      displayOptions: this.decorateOptions(question, selected),
      typeLabel: question.displayTypeLabel || QUESTION_TYPES[question.type] || question.type,
      difficulty: question.difficulty || '',
      progressText: `${this.filteredPosition + 1} / ${this.filteredIndices.length}（原卷第 ${originalIndex + 1} 题）`,
      statusLabel: labelMap[status] || status,
      statusClass: `status-${status}`,
      selectedAnswer: selected.length ? selected.join('、') : '未作答',
      correctAnswer: question.type === 'short' ? (question.answerText || '未提供参考答案') : ((question.answer || []).join('、') || '未提供正确答案'),
      shortAnswer: question.type === 'short' ? String(this.session.shortAnswers && this.session.shortAnswers[question.id] || '') : '',
      analysis: question.analysis || '',
      filteredCount: this.filteredIndices.length,
      isFirst: this.filteredPosition === 0,
      isLast: this.filteredPosition === this.filteredIndices.length - 1,
      sheetItems: this.filteredIndices.map((index, position) => ({
        position,
        number: index + 1,
        status: this.questionStatus(this.session.questions[index]),
        statusClass: `sheet-${this.questionStatus(this.session.questions[index])}`,
        current: position === this.filteredPosition
      }))
    });
  },

  previous() {
    if (this.filteredPosition <= 0) return;
    this.filteredPosition -= 1;
    this.renderQuestion();
  },

  next() {
    if (this.filteredPosition >= this.filteredIndices.length - 1) return;
    this.filteredPosition += 1;
    this.renderQuestion();
  },

  toggleSheet() {
    this.setData({ sheetOpen: !this.data.sheetOpen });
  },

  jump(event) {
    const position = Number(event.currentTarget.dataset.position);
    if (!Number.isInteger(position) || position < 0 || position >= this.filteredIndices.length) return;
    this.filteredPosition = position;
    this.setData({ sheetOpen: false });
    this.renderQuestion();
  }
});
});
__define("pages/exam-config/exam-config.js", function(require, module, exports){
const bankStorage = require('../../services/bank-storage');
const practiceService = require('../../services/practice-service');

Page({
  data: {
    bankId: '',
    manifest: null,
    countOptions: [10, 20, 50, 100],
    countLabels: ['10题', '20题', '50题', '100题'],
    countIndex: 1,
    durationOptions: [10, 20, 30, 60, 90],
    durationLabels: ['10分钟', '20分钟', '30分钟', '60分钟', '90分钟'],
    durationIndex: 2,
    includeShort: false
  },

  onLoad(query) {
    this.setData({
      bankId: query.bankId,
      manifest: bankStorage.getManifest(query.bankId)
    });
  },

  onCountChange(event) {
    this.setData({ countIndex: Number(event.detail.value) });
  },

  onDurationChange(event) {
    this.setData({ durationIndex: Number(event.detail.value) });
  },

  onIncludeShort(event) {
    this.setData({ includeShort: event.detail.value });
  },

  start() {
    try {
      const count = this.data.countOptions[this.data.countIndex];
      const durationMinutes = this.data.durationOptions[this.data.durationIndex];
      const session = practiceService.createSession({
        bankId: this.data.bankId,
        bankName: this.data.manifest.name,
        mode: 'exam',
        type: 'all',
        count: 0,
        durationMinutes
      });

      if (!this.data.includeShort) {
        session.questions = session.questions.filter(item => item.type !== 'short');
      }
      session.questions = session.questions.slice(0, count);

      if (!session.questions.length) {
        wx.showModal({ title: '没有可考试题目', content: '当前题库没有符合条件的题目。', showCancel: false });
        return;
      }

      getApp().globalData.currentSession = session;
      wx.navigateTo({ url: '/pages/exam/exam' });
    } catch (error) {
      wx.showModal({ title: '无法开始考试', content: error.message || String(error), showCancel: false });
    }
  }
});
});
__define("pages/favorites/favorites.js", function(require, module, exports){
const bankStorage = require('../../services/bank-storage');
const recordStorage = require('../../services/record-storage');
const practiceService = require('../../services/practice-service');

Page({
  data: { groups: [] },

  onShow() {
    const groups = bankStorage.listBanks().map(bank => ({
      id: bank.id,
      name: bank.name,
      count: recordStorage.getFavoriteIds(bank.id).length
    })).filter(item => item.count > 0);
    this.setData({ groups });
  },

  start(event) {
    const bankId = event.currentTarget.dataset.id;
    const bank = bankStorage.getManifest(bankId);
    try {
      const session = practiceService.createSession({
        bankId,
        bankName: bank.name,
        mode: 'favorites',
        type: 'all',
        count: 0
      });
      if (!session.questions.length) throw new Error('没有收藏题目');
      getApp().globalData.currentSession = session;
      wx.navigateTo({ url: '/pages/practice/practice' });
    } catch (error) {
      wx.showModal({ title: '无法开始', content: error.message || String(error), showCancel: false });
    }
  }
});
});
__define("pages/home/home.js", function(require, module, exports){
const bankStorage = require('../../services/bank-storage');
const statisticsService = require('../../services/statistics-service');
const recordStorage = require('../../services/record-storage');
const { decorateBank } = require('../../utils/bank-display');

Page({
  data: {
    summary: {},
    recentBanks: []
  },

  onShow() {
    this.refresh();
    this.offerExamResume();
  },

  offerExamResume() {
    if (this.examResumePrompted) return;
    const draft = recordStorage.getExamDraft();
    if (!draft || !draft.session) return;
    this.examResumePrompted = true;
    const session = draft.session;
    const answered = (session.questions || []).filter(question => question.type === 'short'
      ? Boolean(session.shortAnswers && session.shortAnswers[question.id])
      : Boolean(session.answers && session.answers[question.id] && session.answers[question.id].length)).length;
    wx.showModal({
      title: '发现未完成的模拟考试',
      content: `${session.bankName || '题库'} · 已答 ${answered}/${(session.questions || []).length} 题。考试计时按原进度继续；进入题目编辑期间不计时。`,
      confirmText: '继续考试',
      cancelText: '放弃考试',
      success: result => {
        if (result.confirm) {
          getApp().globalData.currentSession = session;
          wx.navigateTo({ url: '/pages/exam/exam' });
        } else {
          recordStorage.clearExamDraft();
          wx.showToast({ title: '已放弃未完成考试', icon: 'none' });
        }
      }
    });
  },

  refresh() {
    const banks = bankStorage.listBanks();
    this.setData({
      summary: statisticsService.summary(),
      recentBanks: banks.slice(0, 3).map(decorateBank)
    });
  },

  goBanks() {
    wx.navigateTo({ url: '/pages/banks/banks' });
  },

  goImport() {
    wx.navigateTo({ url: '/pages/import/import' });
  },

  goStatistics() {
    wx.navigateTo({ url: '/pages/statistics/statistics' });
  },

  goWrong() {
    wx.navigateTo({ url: '/pages/wrong/wrong' });
  },

  goFavorites() {
    wx.navigateTo({ url: '/pages/favorites/favorites' });
  },

  goMastered() {
    wx.navigateTo({ url: '/pages/mastered/mastered' });
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  openBank(event) {
    const id = event.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/bank-detail/bank-detail?bankId=${id}` });
  },

  installDemo() {
    wx.showModal({
      title: '安装示例题库',
      content: '将安装4道示例题，用于测试刷题、错题和收藏功能。',
      success: res => {
        if (!res.confirm) return;
        try {
          const manifest = bankStorage.installDemoBank();
          wx.showToast({ title: '安装成功', icon: 'success' });
          this.refresh();
          setTimeout(() => {
            wx.navigateTo({ url: `/pages/bank-detail/bank-detail?bankId=${manifest.id}` });
          }, 400);
        } catch (error) {
          wx.showModal({ title: '安装失败', content: error.message || String(error), showCancel: false });
        }
      }
    });
  }
});
});
__define("pages/import/import.js", function(require, module, exports){
const importer = require('../../services/docx-importer');
const localAI = require('../../services/local-ai-model');

const AI_EXTENSIONS = ['docx', 'docm', 'dotx', 'dotm', 'doc', 'rtf', 'odt', 'txt', 'md', 'markdown', 'html', 'htm'];
const WORD_EXTENSIONS = ['docx', 'docm', 'dotx', 'dotm', 'doc', 'rtf', 'odt'];
const TABLE_EXTENSIONS = ['xlsx', 'xlsm', 'xltx', 'xltm', 'xls', 'ods', 'csv', 'tsv'];

function parseButtonText(extension = '') {
  const ext = String(extension || '').toLowerCase();
  if (WORD_EXTENSIONS.includes(ext)) return '开始解析 Word';
  if (TABLE_EXTENSIONS.includes(ext)) return '开始解析表格';
  if (['txt', 'md', 'markdown', 'html', 'htm'].includes(ext)) return '开始解析文本';
  if (ext === 'pdf') return '开始解析 PDF';
  return '读取题库包';
}

Page({
  data: {
    importing: false,
    progress: 0,
    stage: '',
    fileReady: false,
    selectedName: '',
    selectedSize: '',
    selectedExtension: '',
    aiSupported: false,
    parseButtonText: '开始解析',
    aiIndex: 0,
    useLocalAI: false,
    modelStatus: '选择 AI 模式后执行本地自检',
    modelReady: false,
    modelVersion: localAI.MODEL_VERSION,
    tips: [
      '文件选择器仅显示文档/文本类文件；真正可导入的扩展名由当前版本支持列表统一控制，后续新增格式时会同步更新。',
      'Word：支持 .doc、.docx、.docm、.dotx、.dotm、.rtf 和 .odt；会利用正文、表格、下划线/高亮/答案色等结构识别题干与答案。',
      '表格：支持 .xls、.xlsx、.xlsm、.xltx、.xltm、.ods、.csv 和 .tsv；会自动识别工作表、表头、题型、难度、答案、解析和图片。',
      '文本：支持 .txt、.md、.markdown、.html 和 .htm；兼容题后答案、题前答案、文末集中答案、多空填空、判断符号、材料题、匹配题、排序题等常见写法。',
      'PDF：支持有文字层的标准文件，并处理常见双栏阅读顺序、重复页眉页脚、跨页题目和字体映射；扫描版仍暂不启用 OCR。',
      '结构冲突或无法可靠判断的题目不会强猜，会进入异常检查，并按置信度从低到高优先展示。'
    ]
  },

  formatSize(size) {
    const value = Number(size) || 0;
    if (!value) return '';
    if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  },

  async chooseFile() {
    if (this.data.importing) return;
    try {
      const file = await importer.chooseFile();
      if (this.selectedFile && this.selectedFile !== file) importer.releasePickedFile(this.selectedFile);
      this.selectedFile = file;
      const name = file.name || '未命名文件';
      const extension = (name.split('.').pop() || '').toLowerCase();
      const aiSupported = AI_EXTENSIONS.includes(extension);
      this.setData({
        fileReady: true,
        selectedName: name,
        selectedSize: this.formatSize(file.size),
        selectedExtension: extension,
        aiSupported,
        parseButtonText: parseButtonText(extension),
        progress: 0,
        stage: '文件已选择，等待解析',
        aiIndex: 0,
        useLocalAI: false,
        modelReady: false,
        modelStatus: '选择 AI 模式后执行本地自检'
      });
    } catch (error) {
      const cancelled = /cancel/i.test(error.errMsg || error.message || '');
      if (!cancelled) wx.showModal({ title: '选择失败', content: error.message || error.errMsg || String(error), showCancel: false });
    }
  },

  async selectMode(event) {
    if (this.data.importing || !this.data.aiSupported) return;
    const index = Number(event.currentTarget.dataset.index) || 0;
    if (index === 0) {
      this.setData({ aiIndex: 0, useLocalAI: false, modelReady: false, modelStatus: '默认规则解析，不加载模型' });
      return;
    }
    this.setData({ aiIndex: 1, useLocalAI: false, modelReady: false, modelStatus: '正在按需加载本地模型…' });
    try {
      const check = await localAI.selfTestAsync();
      this.setData({
        aiIndex: 1,
        useLocalAI: check.ok,
        modelReady: check.ok,
        modelVersion: check.version,
        modelStatus: check.ok ? `已加载 ${check.version}，本地自检通过` : `模型自检失败：${check.message}`
      });
      if (!check.ok) wx.showModal({ title: '模型不可用', content: check.message, showCancel: false });
    } catch (error) {
      this.setData({ aiIndex: 1, useLocalAI: false, modelReady: false, modelStatus: `模型加载失败：${error.message || error}` });
      wx.showModal({ title: '模型不可用', content: error.message || String(error), showCancel: false });
    }
  },

  clearFile() {
    if (this.data.importing) return;
    importer.releasePickedFile(this.selectedFile);
    this.selectedFile = null;
    this.setData({
      fileReady: false,
      selectedName: '',
      selectedSize: '',
      selectedExtension: '',
      aiSupported: false,
      parseButtonText: '开始解析',
      progress: 0,
      stage: '',
      aiIndex: 0,
      useLocalAI: false,
      modelReady: false,
      modelStatus: '选择 AI 模式后执行本地自检'
    });
  },

  async startParse() {
    if (this.data.importing) return;
    if (!this.selectedFile) {
      wx.showToast({ title: '请先选择文件', icon: 'none' });
      return;
    }
    if (this.data.aiIndex === 1 && !this.data.modelReady) {
      wx.showModal({ title: '模型未就绪', content: '本地模型尚未通过自检，请重新选择 AI 模式。', showCancel: false });
      return;
    }
    const selectedFile = this.selectedFile;
    this.setData({ importing: true, progress: 1, stage: '准备解析' });
    try {
      const draft = await importer.importSelected(
        selectedFile,
        { useLocalAI: this.data.aiSupported && this.data.useLocalAI },
        (progress, stage) => this.setData({ progress, stage })
      );
      getApp().globalData.importDraft = draft;
      wx.redirectTo({ url: '/pages/import-result/import-result' });
    } catch (error) {
      console.error(error);
      this.setData({
        importing: false,
        fileReady: false,
        selectedName: '',
        selectedSize: '',
        selectedExtension: '',
        aiSupported: false,
        parseButtonText: '开始解析',
        stage: '解析失败，请重新选择文件'
      });
      wx.showModal({ title: '解析失败', content: error.message || error.errMsg || String(error), showCancel: false });
    } finally {
      importer.releasePickedFile(selectedFile);
      if (this.selectedFile === selectedFile) this.selectedFile = null;
    }
  },

  onUnload() {
    if (!this.data.importing) {
      importer.releasePickedFile(this.selectedFile);
      this.selectedFile = null;
    }
  }
});
});
__define("pages/import-result/import-result.js", function(require, module, exports){
const bankStorage = require('../../services/bank-storage');
const recordStorage = require('../../services/record-storage');

const TABLE_KINDS = ['xlsx', 'xlsm', 'xltx', 'xltm', 'xls', 'ods', 'csv', 'tsv'];
const WORD_KINDS = ['docx', 'docm', 'dotx', 'dotm', 'doc', 'rtf', 'odt'];
const TEXT_KINDS = ['txt', 'md', 'markdown', 'html', 'htm'];

function parseModeText(draft = {}) {
  const kind = String(draft.kind || '').toLowerCase();
  if (TABLE_KINDS.includes(kind)) return `${kind.toUpperCase()} 表格确定性解析`;
  if (kind === 'pdf') return 'PDF 文字层坐标解析（不使用 OCR）';
  if (kind === 'doc') return 'Word 97-2003 二进制正文解析';
  if (kind === 'rtf') return 'RTF Unicode/编码解析';
  if (kind === 'odt') return 'ODT XML 正文与图片解析';
  if (TEXT_KINDS.includes(kind)) return `${kind.toUpperCase()} 文本规则解析`;
  return draft.localAIEnabled ? '规则 + 本地AI + 规则复核' : '仅规则解析';
}

function parserRouteText(draft = {}) {
  const diagnostics = draft.diagnostics || {};
  const layoutLabels = {
    'mixed-indexed': '混合序号型',
    indexed: '连续序号型',
    labeled: '标签题库型',
    'numbered-choice': '编号选择型',
    generic: '通用混合型'
  };
  const strategyLabels = { strict: '严格边界', relaxed: '宽松边界' };
  const layout = layoutLabels[diagnostics.parserLayout] || '';
  const strategy = strategyLabels[diagnostics.parserStrategy] || '';
  if (!layout && !strategy) return '';
  return `结构：${layout || '自动识别'}${strategy ? ` · 采用：${strategy}` : ''}`;
}

function sourceFragmentLabel(draft = {}) {
  const kind = String(draft.kind || '').toLowerCase();
  if (TABLE_KINDS.includes(kind)) return `原始 ${kind.toUpperCase()} 行`;
  if (kind === 'pdf') return '原始 PDF 文本片段';
  return `原始 ${kind.toUpperCase()} 文本片段`;
}

function auditExplain(draft = {}) {
  const kind = String(draft.kind || '').toLowerCase();
  if (TABLE_KINDS.includes(kind)) return '“实际读取到题目”是表格中确实存在题干的行；无法识别表头或题干为空的行会进入跳过线索，不会被强行拼成题目。';
  if (kind === 'pdf') return 'PDF 直接读取文字层、文本坐标和内嵌图片，不先转换成 Word。没有文字层的扫描页不会使用 OCR，也不会伪造题目。';
  if (kind === 'doc') return '旧版 DOC 直接读取 WordDocument 与文字片段表；无法提取的旧式图片以异常线索保留，不会伪造题干或答案。';
  return '“实际读取到题目”是源文件中确实存在正文的题目；检测到边界但正文缺失的记录会保留为不可练习异常，用于核对数量和位置。';
}

Page({
  data: {
    draft: null,
    name: '',
    saving: false,
    abnormalCount: 0,
    existingBankName: '',
    expectedCount: '',
    expectedGap: 0,
    expectedGapText: '',
    usableCount: 0,
    showAuditDetails: false
  },

  onLoad() {
    const draft = getApp().globalData.importDraft;
    if (!draft) {
      wx.showModal({
        title: '导入数据已失效',
        content: '请重新选择文件。',
        showCancel: false,
        success: () => wx.redirectTo({ url: '/pages/import/import' })
      });
      return;
    }
    this.draftRef = draft;
    this.existingBank = draft.kind !== 'qbank'
      ? bankStorage.listBanks().find(item => item.sourceName && item.sourceName === draft.sourceName)
      : null;
    const expectedCount = Number(draft.expectedQuestionCount || (draft.diagnostics || {}).expectedQuestionCount) || 0;
    this.setData({
      name: draft.name,
      existingBankName: this.existingBank ? this.existingBank.name : '',
      expectedCount: expectedCount ? String(expectedCount) : ''
    });
  },

  onShow() {
    const draft = getApp().globalData.importDraft;
    if (!draft) return;
    draft.diagnostics = Object.assign({
      sourceParagraphCount: draft.paragraphsCount || 0,
      effectiveParagraphCount: draft.paragraphsCount || 0,
      removedNoiseCount: 0,
      splitQuestionStartRepairCount: 0,
      noPunctuationBoundaryRepairCount: 0,
      sourceDeclaredMissingCount: 0,
      sourceDeclaredMissingItems: [],
      sourceDeclaredExtraCount: 0,
      sourceDeclaredExtraItems: [],
      sourceContentQuestionCount: (draft.questions || []).filter(item => !item.sourceMissingPlaceholder).length,
      accountedQuestionCount: (draft.questions || []).length,
      inferredBoundaryCount: 0,
      inlineAnswerCount: 0,
      duplicateCount: 0,
      unlabeledAnswerCount: 0,
      detectedBoundaryCount: (draft.questions || []).length,
      explicitBoundaryCount: 0,
      preservedFailedBoundaryCount: 0,
      discardedBoundaryCount: 0,
      assignedParagraphCount: 0,
      unassignedParagraphCount: 0,
      numberingGapCount: 0,
      silentLossCount: 0
    }, draft.diagnostics || {});
    this.draftRef = draft;
    draft.diagnostics.unassignedFragments = (draft.diagnostics.unassignedFragments || []).map(item => ({
      ...item,
      preview: item.text || (item.imageCount ? `图片段落（${item.imageCount} 张）` : '空白段落')
    }));
    draft.diagnostics.discardedFragments = (draft.diagnostics.discardedFragments || []).map(item => ({
      ...item,
      preview: (item.rawTexts || []).join(' / ') || (item.imageCount ? `图片题（${item.imageCount} 张）` : '没有可显示文字')
    }));
    draft.diagnostics.numberingIssues = (draft.diagnostics.numberingIssues || []).map(item => ({
      ...item,
      preview: item.message || '题号序列存在缺口'
    }));
    draft.diagnostics.sourceDeclaredMissingItems = (draft.diagnostics.sourceDeclaredMissingItems || []).map(item => ({
      ...item,
      preview: item.message || `原文缺少第 ${item.number || '?'} 题正文`
    }));
    draft.diagnostics.sourceDeclaredExtraItems = (draft.diagnostics.sourceDeclaredExtraItems || []).map(item => ({
      ...item,
      preview: item.message || `正文包含声明数量之外的第 ${item.number || '?'} 题`
    }));
    const expectedCount = Number(this.data.expectedCount || draft.expectedQuestionCount || draft.diagnostics.expectedQuestionCount) || 0;
    const questionCount = (draft.questions || []).length;
    const expectedGap = expectedCount ? expectedCount - questionCount : 0;
    this.setData({
      draft: {
        kind: draft.kind || '',
        sourceName: draft.sourceName,
        isTableFormat: TABLE_KINDS.includes(String(draft.kind || '').toLowerCase()),
        isPdf: draft.kind === 'pdf',
        isLegacyDoc: draft.kind === 'doc',
        parseModeText: parseModeText(draft),
        parserRouteText: parserRouteText(draft),
        sourceFragmentLabel: sourceFragmentLabel(draft),
        auditExplain: auditExplain(draft),
        questionCount,
        counts: draft.counts,
        diagnostics: draft.diagnostics,
        paragraphsCount: draft.paragraphsCount || 0,
        parserVersion: draft.parserVersion || '',
        localAIEnabled: Boolean(draft.localAIEnabled),
        localAIModelVersion: draft.localAIModelVersion || '',
        localAIAppliedCount: Number((draft.diagnostics || {}).localAIAppliedCount) || 0
      },
      abnormalCount: (draft.counts.warning || 0) + (draft.counts.error || 0),
      usableCount: (draft.counts.normal || 0) + (draft.counts.warning || 0),
      expectedCount: expectedCount ? String(expectedCount) : '',
      expectedGap,
      expectedGapText: expectedCount
        ? (expectedGap > 0 ? `比官方总数少 ${expectedGap} 道（未定位，不自动补题）` : (expectedGap < 0 ? `比官方总数多 ${Math.abs(expectedGap)} 道` : '与官方总数一致'))
        : ''
    }, () => {
      if (getApp().globalData.saveImportDraftRequested) {
        getApp().globalData.saveImportDraftRequested = false;
        setTimeout(() => this.save(), 50);
      }
    });
  },

  onUnload() {
    const draft = getApp().globalData.importDraft;
    if (draft && this.draftRef === draft) {
      bankStorage.cleanupDraft(draft);
      getApp().globalData.importDraft = null;
    }
  },

  onNameInput(event) { this.setData({ name: event.detail.value }); },
  onExpectedCountInput(event) {
    const raw = String(event.detail.value || '').replace(/[^0-9]/g, '').slice(0, 6);
    const expectedCount = Number(raw) || 0;
    const questionCount = this.data.draft ? Number(this.data.draft.questionCount) || 0 : 0;
    const expectedGap = expectedCount ? expectedCount - questionCount : 0;
    const draft = getApp().globalData.importDraft;
    if (draft) {
      draft.expectedQuestionCount = expectedCount;
      draft.diagnostics = Object.assign({}, draft.diagnostics || {}, {
        expectedQuestionCount: expectedCount,
        expectedCountGap: expectedGap
      });
    }
    this.setData({
      expectedCount: raw,
      expectedGap,
      expectedGapText: expectedCount
        ? (expectedGap > 0 ? `比官方总数少 ${expectedGap} 道（未定位，不自动补题）` : (expectedGap < 0 ? `比官方总数多 ${Math.abs(expectedGap)} 道` : '与官方总数一致'))
        : ''
    });
  },
  toggleAuditDetails() { this.setData({ showAuditDetails: !this.data.showAuditDetails }); },
  review() { wx.navigateTo({ url: '/pages/review/review?source=draft' }); },
  reviewFiltered(event) {
    const filter = event.currentTarget.dataset.filter || 'all';
    wx.navigateTo({ url: `/pages/review/review?source=draft&filter=${filter}` });
  },

  performSave(existingId = '') {
    const draft = getApp().globalData.importDraft;
    draft.name = this.data.name.trim() || draft.name;
    draft.expectedQuestionCount = Number(this.data.expectedCount) || 0;
    draft.diagnostics = Object.assign({}, draft.diagnostics || {}, {
      expectedQuestionCount: draft.expectedQuestionCount,
      expectedCountGap: draft.expectedQuestionCount ? draft.expectedQuestionCount - (draft.questions || []).length : 0
    });
    this.setData({ saving: true });
    wx.showLoading({ title: existingId ? '正在覆盖题库' : '正在保存', mask: true });
    setTimeout(() => {
      try {
        const manifest = bankStorage.saveBank(draft, existingId);
        if (existingId) recordStorage.clearBankRecords(existingId);
        bankStorage.cleanupDraft(draft);
        getApp().globalData.importDraft = null;
        wx.hideLoading();
        wx.showToast({ title: existingId ? '已覆盖并重新解析' : '题库已保存', icon: 'success' });
        setTimeout(() => wx.redirectTo({ url: `/pages/bank-detail/bank-detail?bankId=${manifest.id}` }), 500);
      } catch (error) {
        wx.hideLoading();
        this.setData({ saving: false });
        wx.showModal({ title: '保存失败', content: error.message || String(error), showCancel: false });
      }
    }, 30);
  },

  save() {
    if (this.data.saving) return;
    const existing = this.existingBank;
    if (!existing) { this.performSave(''); return; }
    wx.showModal({
      title: '检测到同名来源题库',
      content: `“${existing.name}”来自同一个源文件。建议覆盖旧题库，确保不再沿用旧版解析数据。覆盖会清除该题库旧的错题、收藏、进度和已掌握记录。`,
      confirmText: '覆盖旧题库',
      cancelText: '另存为新题库',
      success: result => this.performSave(result.confirm ? existing.id : '')
    });
  },

  cancel() {
    getApp().globalData.saveImportDraftRequested = false;
    const draft = getApp().globalData.importDraft;
    bankStorage.cleanupDraft(draft);
    getApp().globalData.importDraft = null;
    wx.navigateBack();
  }
});
});
__define("pages/practice/practice.js", function(require, module, exports){
const bankStorage = require('../../services/bank-storage');
const recordStorage = require('../../services/record-storage');
const practiceService = require('../../services/practice-service');
const { QUESTION_TYPES } = require('../../utils/constants');

const SHEET_TYPE_CLASS_ORDER = [
  'sheet-type-single', 'sheet-type-multiple', 'sheet-type-judge', 'sheet-type-fill',
  'sheet-type-short', 'sheet-type-calc', 'sheet-type-drawing', 'sheet-type-other-0',
  'sheet-type-other-1', 'sheet-type-other-2'
];
function sheetTypeLabel(question) {
  const base = String(question && (question.displayTypeLabel || QUESTION_TYPES[question.type] || question.type) || '未知题型').trim();
  return question && (question.status || 'normal') !== 'normal' && !/^异常/.test(base) ? `异常${base}` : base;
}
function sheetTypeClass(question, label = sheetTypeLabel(question)) {
  const type = String(question && question.type || '');
  if (type === 'single' || type === 'choice_error' || label === '单选题') return 'sheet-type-single';
  if (type === 'multiple' || label === '多选题') return 'sheet-type-multiple';
  if (type === 'judge' || label === '判断题') return 'sheet-type-judge';
  if (/填空/.test(label)) return 'sheet-type-fill';
  if (type === 'short' || /简答/.test(label)) return 'sheet-type-short';
  if (/计算/.test(label)) return 'sheet-type-calc';
  if (/画图|作图|绘图/.test(label)) return 'sheet-type-drawing';
  let hash = 0;
  Array.from(label).forEach(char => { hash = (hash * 31 + char.charCodeAt(0)) >>> 0; });
  return SHEET_TYPE_CLASS_ORDER[7 + (hash % 3)];
}

function buildTopChipClasses() {
  // 各角色固定使用彼此差异明显的莫奈色；切换题目、重新渲染都不会换色。
  // 绿色专用于“掌握”，顶部功能胶囊不再使用青绿系，避免题卡与掌握混淆。
  return {
    typeChipClass: 'chip-tone-blue',
    difficultyChipClass: 'chip-tone-amber',
    sheetChipClass: 'chip-tone-violet',
    editChipClass: 'chip-tone-rose'
  };
}

Page({
  data: {
    question: null,
    displayOptions: [],
    selected: [],
    submitted: false,
    showAnswer: false,
    result: null,
    favorite: false,
    mastered: false,
    progressText: '',
    progressRatio: 0,
    typeLabel: '',
    isAbnormal: false,
    difficulty: '',
    typeChipClass: 'chip-tone-blue',
    difficultyChipClass: 'chip-tone-amber',
    sheetChipClass: 'chip-tone-violet',
    editChipClass: 'chip-tone-rose',
    fontScale: 1,
    answerBottomLift: 48,
    memorizeMode: false,
    autoNextHint: '',
    answerDisplay: '',
    answerDetail: '',
    isFirst: true,
    isLast: false,
    questionBlockStyle: '',
    optionsStyle: '',
    answerPanelStyle: '',
    analysisStyle: '',
    layoutClass: 'choice-layout',
    showQuestionSheet: false,
    questionSheetItems: [],
    sheetCorrectCount: 0,
    sheetWrongCount: 0,
    sheetUnansweredCount: 0,
    sheetTotalCount: 0,
    sheetFilteredCount: 0,
    sheetStatusFilter: 'all',
    sheetTypeFilter: 'all',
    sheetTypeItems: [],
    sheetHasFilter: false,
    sheetCurrentExcluded: false
  },

  onLoad() {
    const session = getApp().globalData.currentSession;
    if (!session || !session.questions.length) {
      wx.showModal({
        title: '练习已失效',
        content: '请重新选择题库。',
        showCancel: false,
        success: () => wx.navigateBack()
      });
      return;
    }
    this.session = session;
    this.topChipClasses = buildTopChipClasses([
      session.bankId || '',
      session.mode || 'practice',
      session.memorizeOrder || '',
      session.practiceType || 'all'
    ].join('|'));
    this.pageVisible = true;
    this.layoutResizeHandler = () => this.scheduleMeasuredLayout();
    window.addEventListener('resize', this.layoutResizeHandler, { passive: true });
    // 使用不会随 setData 重建而销毁的 document 级手势监听。快速连续滑动时，
    // 每个有效手势都会进入队列，不再被旧版 380ms 锁直接丢弃。
    this.globalSwipeStart = event => {
      const target = event && event.target;
      if (!target || !target.closest || !target.closest('.question-viewport')) return;
      this.onTouchStart(event);
    };
    this.globalSwipeEnd = event => {
      if (this.swipeStart) this.onTouchEnd(event);
    };
    document.addEventListener('touchstart', this.globalSwipeStart, { passive: true, capture: true });
    document.addEventListener('touchend', this.globalSwipeEnd, { passive: true, capture: true });
    const settings = recordStorage.getSettings();
    this.settings = settings;
    this.setData({
      fontScale: settings.fontScale || 1,
      answerBottomLift: Math.max(0, Math.min(120, Number(settings.answerBottomLift) || 48)),
      memorizeMode: Boolean(session.memorize)
    });

    // Android 按 Home、切换应用、锁屏或系统直接回收 WebView 时，不一定触发页面 onUnload。
    // 因此除了每次换题立即保存，还监听后台/关闭事件作为最后一道保险。
    this.persistOnVisibilityChange = () => {
      if (document.visibilityState === 'hidden') this.persistProgress('visibility-hidden', true);
    };
    this.persistOnPageHide = () => this.persistProgress('page-hide', true);
    this.persistOnBeforeUnload = () => this.persistProgress('before-unload', true);
    document.addEventListener('visibilitychange', this.persistOnVisibilityChange, { passive: true });
    window.addEventListener('pagehide', this.persistOnPageHide, { passive: true });
    window.addEventListener('beforeunload', this.persistOnBeforeUnload);

    this.renderQuestion();
  },

  onShow() {
    this.pageVisible = true;
    this.applyLatestSettings();
    if (!this.pendingQuestionEdit) return;
    this.pendingQuestionEdit = false;
    this.refreshEditedQuestion();
  },

  applyLatestSettings() {
    const latest = recordStorage.getSettings();
    const previous = this.settings || latest;
    const shuffleChanged = Boolean(previous.shuffleOptions) !== Boolean(latest.shuffleOptions);
    this.settings = latest;
    this.setData({
      fontScale: Number(latest.fontScale) || 1,
      answerBottomLift: Math.max(0, Math.min(120, Number(latest.answerBottomLift) || 48))
    }, () => {
      if (typeof requestAnimationFrame === 'function') this.scheduleMeasuredLayout();
    });

    // 设置页可从任意界面打开。返回练习页后，未作答题目的选项顺序立即按新设置更新；
    // 已经选择或提交过的题保持原样，避免答案键位被重排。背题模式始终使用原题库选项顺序。
    if (shuffleChanged && this.session && !this.session.exam && !this.session.memorize) {
      this.session.questions = practiceService.applyOptionOrderPreference(
        this.session.questions,
        Boolean(latest.shuffleOptions),
        this.session.answers,
        this.session.results
      );
      this.session.optionShuffleEnabled = Boolean(latest.shuffleOptions);
      getApp().globalData.currentSession = this.session;
      this.renderQuestion();
    }
  },

  onHide() {
    this.pageVisible = false;
    this.clearAutoNext();
    this.persistProgress('page-hide-lifecycle', true);
  },

  onUnload() {
    this.persistProgress('page-unload', true);
    this.clearAutoNext();
    this.cleanupMeasuredLayout();
    if (this.persistOnVisibilityChange) document.removeEventListener('visibilitychange', this.persistOnVisibilityChange);
    if (this.persistOnPageHide) window.removeEventListener('pagehide', this.persistOnPageHide);
    if (this.persistOnBeforeUnload) window.removeEventListener('beforeunload', this.persistOnBeforeUnload);
    this.persistOnVisibilityChange = null;
    this.persistOnPageHide = null;
    this.persistOnBeforeUnload = null;
  },

  persistProgress(reason = '', force = false) {
    const session = this.session;
    if (!session || session.exam) return false;

    // 顺序背题和随机背题分别保存位置。随机背题额外保存本次随机序列，返回后继续同一顺序。
    if (session.mode === 'memorize') {
      if (!session.questions.length) return false;
      const question = session.questions[session.index] || session.questions[0];
      if (!question) return false;
      const existing = recordStorage.getMemorizeProgress(session.bankId) || {};
      const memorizeOrder = session.memorizeOrder === 'random' ? 'random' : 'sequence';
      const scopeKey = session.memorizeScopeKey
        || practiceService.buildMemorizeScopeKey(memorizeOrder, session.practiceType, session.requestedCount);
      const cursor = {
        questionId: question.id || '',
        questionKey: practiceService.buildQuestionProgressKey(question),
        questionOrder: Number.isFinite(Number(question.order)) ? Number(question.order) : 0,
        index: session.index,
        updatedAt: Date.now()
      };
      const cursors = Object.assign({}, existing.cursors || {}, { [scopeKey]: cursor });
      const randomSequences = Object.assign({}, existing.randomSequences || {});
      if (memorizeOrder === 'random') {
        randomSequences[scopeKey] = practiceService.buildMemorizeQuestionSequence(session.questions);
      }
      const signature = [scopeKey, cursor.questionId, cursor.questionOrder, cursor.index, session.questions.length].join('|');
      if (!force && signature === this.lastMemorizeProgressSignature) return true;
      const saved = recordStorage.saveMemorizeProgress(session.bankId, {
        ...existing,
        mode: 'memorize',
        memorizeOrder,
        type: session.practiceType || 'all',
        requestedCount: Number(session.requestedCount || 0),
        cursor,
        cursors,
        randomSequences,
        reason
      });
      if (saved) this.lastMemorizeProgressSignature = signature;
      return saved;
    }

    // 顺序练习的进度只由已经完成作答的题目决定，随意浏览不会制造虚假进度。
    if (session.mode !== 'sequence' || this.progressCompleted) return false;
    const existing = recordStorage.getProgress(session.bankId) || {};
    const questionStates = practiceService.mergePersistedQuestionStates(
      existing.questionStates,
      practiceService.buildPersistedQuestionStates(session),
      session.questions
    );
    session.lastCompletedOrder = Math.max(
      Number(session.lastCompletedOrder || 0),
      practiceService.getFurthestCompletedOrder(session.questions, session.results)
    );

    // 只打开页面、随意翻题且没有任何作答时，不创建虚假的“继续进度”。
    if (!questionStates.length && session.lastCompletedOrder <= 0) return false;

    const targetIndex = practiceService.findResumeIndexAfterCompletion(
      session.questions,
      session.results,
      session.lastCompletedOrder
    );
    const target = session.questions[targetIndex] || session.questions[0];
    if (!target) return false;
    const completedAll = session.questions.every(question =>
      practiceService.getQuestionAnswerStatus(question, session.results[question.id]) !== 'unanswered'
    );
    const scopeKey = session.progressScopeKey
      || practiceService.buildPracticeScopeKey(session.practiceType, session.requestedCount);
    const cursor = {
      lastCompletedOrder: Number(session.lastCompletedOrder || 0),
      questionId: target.id || '',
      questionKey: practiceService.buildQuestionProgressKey(target),
      questionOrder: Number.isFinite(Number(target.order)) ? Number(target.order) : 0,
      index: targetIndex,
      completedAll,
      updatedAt: Date.now()
    };
    const cursors = Object.assign({}, existing.cursors || {}, { [scopeKey]: cursor });
    const progress = {
      index: cursor.index,
      questionId: cursor.questionId,
      questionKey: cursor.questionKey,
      questionOrder: cursor.questionOrder,
      lastCompletedOrder: cursor.lastCompletedOrder,
      completedAll,
      mode: 'sequence',
      type: session.practiceType || 'all',
      requestedCount: Number(session.requestedCount || 0),
      sessionQuestionCount: session.questions.length,
      cursors,
      questionStates,
      reason
    };
    const signature = [
      scopeKey, cursor.questionId, cursor.questionOrder, cursor.lastCompletedOrder,
      questionStates.length, completedAll ? 1 : 0
    ].join('|');
    if (!force && signature === this.lastProgressSignature) return true;
    const saved = recordStorage.saveProgress(session.bankId, progress);
    if (saved) this.lastProgressSignature = signature;
    return saved;
  },

  markQuestionCompleted(question) {
    if (!this.session || !question) return;
    const order = Number(question.order);
    const stableOrder = Number.isFinite(order) && order > 0
      ? order
      : this.session.index + 1;
    this.session.lastCompletedOrder = Math.max(
      Number(this.session.lastCompletedOrder || 0),
      stableOrder
    );
  },

  clearAutoNext() {
    if (this.autoNextTimer) {
      clearTimeout(this.autoNextTimer);
      this.autoNextTimer = null;
    }
    if (this.data.autoNextHint) this.setData({ autoNextHint: '' });
  },

  decorateOptions(question, selected, revealCorrect) {
    const isGenericVisualText = value => /^(?:图|图形|图片|图示|示意图|符号图|见图|如下图)$/i.test(
      String(value || '').replace(/[\s()（）\[\]【】<>《》.。:：、，,;；]/g, '')
    );
    return (question.options || []).map(item => {
      let stateClass = selected.includes(item.key) ? 'selected' : '';
      if (revealCorrect && (question.answer || []).includes(item.key)) stateClass = 'correct';
      if (revealCorrect && selected.includes(item.key) && !(question.answer || []).includes(item.key)) stateClass = 'wrong';
      const hasImages = Array.isArray(item.images) && item.images.length > 0;
      const cleanedText = String(item.text || '').replace(/[\s]*[；、|;]+\s*$/, '');
      return { ...item, text: cleanedText, stateClass, hasImages, visualOnly: hasImages && isGenericVisualText(cleanedText) };
    });
  },

  getAnswerDetail(question) {
    if (question.type === 'short') {
      if (question.answerText) return question.answerText;
      if (Array.isArray(question.answerImages) && question.answerImages.length) return '';
      return '未提供参考答案';
    }
    const keys = (question.answer || []).filter(Boolean);
    return keys.length ? keys.join('、') : '未提供正确答案';
  },

  buildAdaptiveLayout(question, showAnswer, memorizeMode) {
    const isShort = question && question.type === 'short';
    return {
      questionBlockStyle: '',
      optionsStyle: '',
      answerPanelStyle: '',
      analysisStyle: '',
      layoutClass: `${isShort ? 'short-layout' : 'choice-layout'} ${showAnswer ? 'answer-visible' : 'answer-hidden'} ${memorizeMode ? 'memorize-layout' : ''}`
    };
  },

  onAfterRender() {
    // setData 会重建 WebView DOM。同步测量并写入最终高度，保证在下一帧绘制前
    // 布局已经稳定，避免仅切换选中状态时题干和选项上下抖动。
    this.applyMeasuredLayout();
  },

  cleanupMeasuredLayout() {
    if (this.layoutTimer) clearTimeout(this.layoutTimer);
    this.layoutTimer = null;
    if (this.layoutFrame) cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = null;
    if (this.layoutObserver) this.layoutObserver.disconnect();
    this.layoutObserver = null;
    this.observedLayoutCard = null;
    if (this.layoutResizeHandler) window.removeEventListener('resize', this.layoutResizeHandler);
    this.layoutResizeHandler = null;
    if (this.globalSwipeStart) document.removeEventListener('touchstart', this.globalSwipeStart, true);
    if (this.globalSwipeEnd) document.removeEventListener('touchend', this.globalSwipeEnd, true);
    this.globalSwipeStart = null;
    this.globalSwipeEnd = null;
    this.pendingSwipes = [];
  },

  scheduleMeasuredLayout() {
    if (this.layoutTimer) clearTimeout(this.layoutTimer);
    if (this.layoutFrame) cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = requestAnimationFrame(() => {
      this.layoutFrame = requestAnimationFrame(() => {
        this.layoutFrame = null;
        this.applyMeasuredLayout();
      });
    });
    this.layoutTimer = setTimeout(() => {
      this.layoutTimer = null;
      this.applyMeasuredLayout();
    }, 90);
  },

  allocateMeasuredSections(sections, available) {
    const result = {};
    const usable = Math.max(0, available);
    if (!sections.length) return result;
    const desiredTotal = sections.reduce((sum, item) => sum + item.desired, 0);
    if (desiredTotal <= usable) {
      sections.forEach(item => { result[item.key] = item.desired; });
      return result;
    }
    let minimumTotal = sections.reduce((sum, item) => sum + item.min, 0);
    if (minimumTotal > usable) {
      const ratio = usable / Math.max(1, minimumTotal);
      sections.forEach(item => { result[item.key] = Math.max(42, Math.floor(item.min * ratio)); });
      return result;
    }
    sections.forEach(item => { result[item.key] = item.min; });
    let remaining = usable - minimumTotal;
    let pending = sections.filter(item => item.desired > item.min + 1);
    while (remaining > 1 && pending.length) {
      const totalWeight = pending.reduce((sum, item) => sum + Math.max(1, (item.desired - result[item.key])) * item.weight, 0);
      if (!totalWeight) break;
      let used = 0;
      pending.forEach(item => {
        const need = Math.max(0, item.desired - result[item.key]);
        if (!need) return;
        const share = remaining * (need * item.weight) / totalWeight;
        const add = Math.min(need, Math.max(1, Math.floor(share)));
        result[item.key] += add;
        used += add;
      });
      if (!used) break;
      remaining -= used;
      pending = pending.filter(item => result[item.key] < item.desired - 1);
    }
    return result;
  },

  applyMeasuredLayout() {
    const root = document.querySelector('#page-root[data-page="pages/practice/practice"]');
    if (!root || !this.data.question) return;
    const card = root.querySelector('.question-card');
    if (!card || card.clientHeight < 120) return;

    if (window.ResizeObserver && this.observedLayoutCard !== card) {
      if (this.layoutObserver) this.layoutObserver.disconnect();
      this.observedLayoutCard = card;
      let previousWidth = card.clientWidth;
      let previousHeight = card.clientHeight;
      this.layoutObserver = new ResizeObserver(entries => {
        const entry = entries && entries[0];
        if (!entry) return;
        const width = Math.round(entry.contentRect.width);
        const height = Math.round(entry.contentRect.height);
        if (Math.abs(width - previousWidth) > 1 || Math.abs(height - previousHeight) > 1) {
          previousWidth = width;
          previousHeight = height;
          this.scheduleMeasuredLayout();
        }
      });
      this.layoutObserver.observe(card);
    }

    root.querySelectorAll('.question-image, .option-image, .answer-image, .analysis-image').forEach(image => {
      if (image.dataset.layoutBound) return;
      image.dataset.layoutBound = '1';
      image.addEventListener('load', () => this.scheduleMeasuredLayout(), { once: true });
    });

    const question = card.querySelector('.question-block');
    const options = card.querySelector('.options');
    const shortArea = card.querySelector('.short-area');
    const resultZone = card.querySelector('.result-zone');
    const answer = card.querySelector('.answer-panel');
    const analysis = card.querySelector('.analysis');
    const variableElements = [question, options, answer, analysis].filter(Boolean);

    const clearSection = element => {
      element.style.setProperty('height', 'auto', 'important');
      element.style.setProperty('max-height', 'none', 'important');
      element.style.setProperty('min-height', '0', 'important');
      element.style.setProperty('flex', '0 0 auto', 'important');
      element.style.setProperty('overflow-y', 'visible', 'important');
    };
    variableElements.forEach(clearSection);
    if (resultZone) {
      resultZone.style.setProperty('height', 'auto', 'important');
      resultZone.style.setProperty('max-height', 'none', 'important');
      resultZone.style.setProperty('min-height', '0', 'important');
      resultZone.style.setProperty('flex', '0 0 auto', 'important');
      resultZone.style.setProperty('overflow', 'visible', 'important');
    }
    card.style.setProperty('justify-content', 'flex-start', 'important');

    // Force a natural-content layout before reading scrollHeight.
    void card.offsetHeight;
    const px = value => Number.parseFloat(value) || 0;
    const naturalHeight = element => {
      if (!element) return 0;
      const rect = element.getBoundingClientRect();
      return Math.ceil(Math.max(element.scrollHeight || 0, rect.height || 0));
    };
    const visible = element => Boolean(element && element.getClientRects().length);
    const cardStyle = getComputedStyle(card);
    const cardInnerHeight = Math.max(0, card.clientHeight - px(cardStyle.paddingTop) - px(cardStyle.paddingBottom));
    const outerChildren = [question, options || shortArea, resultZone].filter(visible);
    const outerGap = px(cardStyle.rowGap || cardStyle.gap);
    const outerGaps = Math.max(0, outerChildren.length - 1) * outerGap;

    let resultFixedHeight = 0;
    let resultGaps = 0;
    let resultDirectChildren = [];
    if (resultZone) {
      const resultStyle = getComputedStyle(resultZone);
      resultDirectChildren = Array.from(resultZone.children).filter(visible);
      const resultGap = px(resultStyle.rowGap || resultStyle.gap);
      resultGaps = Math.max(0, resultDirectChildren.length - 1) * resultGap;
      resultDirectChildren.forEach(child => {
        if (child !== answer && child !== analysis) resultFixedHeight += naturalHeight(child);
      });
    }
    const shortAreaHeight = shortArea && visible(shortArea) ? naturalHeight(shortArea) : 0;
    const availableForVariables = Math.max(0, cardInnerHeight - outerGaps - resultGaps - resultFixedHeight - shortAreaHeight);
    const rpx = Math.max(0.42, Math.min(0.82, window.innerWidth / 750));
    const isShort = this.data.question.type === 'short';
    const sectionData = [];
    if (question) {
      const desired = naturalHeight(question);
      sectionData.push({ key: 'question', element: question, desired, min: desired <= Math.max(145, 250 * rpx) ? desired : Math.min(desired, Math.max(72, 124 * rpx)), weight: 1.15 });
    }
    if (options) {
      const desired = naturalHeight(options);
      sectionData.push({ key: 'options', element: options, desired, min: Math.min(desired, Math.max(105, 220 * rpx)), weight: 1.85 });
    }
    if (answer) {
      const desired = naturalHeight(answer);
      const minimum = isShort ? Math.max(82, 155 * rpx) : Math.max(50, 88 * rpx);
      sectionData.push({ key: 'answer', element: answer, desired, min: Math.min(desired, minimum), weight: isShort ? 2.25 : 0.7 });
    }
    if (analysis) {
      const desired = naturalHeight(analysis);
      sectionData.push({ key: 'analysis', element: analysis, desired, min: Math.min(desired, Math.max(68, 125 * rpx)), weight: 1.35 });
    }
    const allocation = this.allocateMeasuredSections(sectionData, availableForVariables);
    sectionData.forEach(item => {
      const assigned = Math.max(0, Math.floor(allocation[item.key] || item.desired));
      item.element.style.setProperty('height', `${assigned}px`, 'important');
      item.element.style.setProperty('max-height', `${assigned}px`, 'important');
      item.element.style.setProperty('min-height', '0', 'important');
      item.element.style.setProperty('flex', '0 0 auto', 'important');
      item.element.style.setProperty('overflow-y', item.desired > assigned + 2 ? 'auto' : 'hidden', 'important');
      item.element.classList.toggle('section-scrollable', item.desired > assigned + 2);
    });
    if (resultZone) {
      const resultVariableHeight = (answer ? (allocation.answer || naturalHeight(answer)) : 0)
        + (analysis ? (allocation.analysis || naturalHeight(analysis)) : 0);
      const resultHeight = Math.max(0, Math.floor(resultFixedHeight + resultGaps + resultVariableHeight));
      resultZone.style.setProperty('height', `${resultHeight}px`, 'important');
      resultZone.style.setProperty('max-height', `${resultHeight}px`, 'important');
      resultZone.style.setProperty('min-height', '0', 'important');
      resultZone.style.setProperty('overflow', 'hidden', 'important');
    }
  },

  renderQuestion() {
    this.clearAutoNext();
    const session = this.session;
    const question = session.questions[session.index];
    const favorite = recordStorage.isFavorite(session.bankId, question.id);
    const mastered = recordStorage.isMastered(session.bankId, question.id);
    const selected = session.answers[question.id] || [];
    const storedResult = session.results[question.id] || null;
    const memorizeMode = Boolean(session.memorize);
    const submitted = memorizeMode || Boolean(storedResult);
    const showAnswer = memorizeMode || submitted;
    const layout = this.buildAdaptiveLayout(question, showAnswer, memorizeMode);
    const isAbnormal = (question.status || 'normal') !== 'normal';
    const baseTypeLabel = question.displayTypeLabel || QUESTION_TYPES[question.type] || question.type;
    const typeLabel = isAbnormal && !/^异常/.test(String(baseTypeLabel || '')) ? `异常${baseTypeLabel}` : baseTypeLabel;
    const chipClasses = this.topChipClasses || buildTopChipClasses([
      session.bankId || '', session.mode || 'practice', session.memorizeOrder || '', session.practiceType || 'all'
    ].join('|'));
    const totalQuestions = Math.max(1, session.questions.length);
    const progressRatio = session.index >= totalQuestions - 1
      ? 1
      : Math.max(0, Math.min(1, (session.index + 1) / totalQuestions));

    this.setData({
      question,
      displayOptions: this.decorateOptions(question, selected, showAnswer),
      selected,
      submitted,
      showAnswer,
      result: storedResult,
      favorite,
      mastered,
      memorizeMode,
      progressText: `${session.index + 1} / ${session.questions.length}`,
      progressRatio,
      typeLabel,
      isAbnormal,
      difficulty: question.difficulty || '',
      ...chipClasses,
      answerDisplay: (question.answer || []).join('、'),
      answerDetail: this.getAnswerDetail(question),
      isFirst: session.index === 0,
      isLast: session.index === session.questions.length - 1,
      ...layout
    });
    // 每次进入一道题就同步写入本地存储，不再依赖退出页面才保存。
    this.persistProgress('render-question');
  },

  editCurrentQuestion() {
    this.clearAutoNext();
    const session = this.session;
    const current = this.data.question;
    if (!session || !current) return;
    try {
      const stored = bankStorage.loadQuestions(session.bankId).find(item => item.id === current.id) || current;
      this.editQuestionSnapshot = practiceService.buildQuestionEditSignature(stored);
      this.pendingQuestionEdit = true;
      wx.navigateTo({
        url: `/pages/editor/editor?source=bank&bankId=${encodeURIComponent(session.bankId)}&questionId=${encodeURIComponent(current.id)}`
      });
    } catch (error) {
      wx.showModal({ title: '无法编辑题目', content: error.message || String(error), showCancel: false });
    }
  },

  refreshEditedQuestion() {
    const session = this.session;
    if (!session || !session.questions.length) return;
    const previous = session.questions[session.index];
    if (!previous) return;
    try {
      const fresh = bankStorage.loadQuestions(session.bankId).find(item => item.id === previous.id);
      if (!fresh) throw new Error('保存后未找到当前题目');
      const beforeSignature = this.editQuestionSnapshot || practiceService.buildQuestionEditSignature(previous);
      const afterSignature = practiceService.buildQuestionEditSignature(fresh);
      const answerContentChanged = beforeSignature !== afterSignature;
      const previousSelected = Array.isArray(session.answers[previous.id]) ? session.answers[previous.id].slice() : [];
      const previousResult = session.results[previous.id] && typeof session.results[previous.id] === 'object'
        ? { ...session.results[previous.id] } : null;

      session.questions[session.index] = fresh;
      if (answerContentChanged) {
        delete session.answers[previous.id];
        delete session.results[previous.id];
      } else if (fresh.type !== 'short') {
        const remapped = practiceService.remapSelectedOptions(previous, fresh, previousSelected);
        if (remapped.length) session.answers[fresh.id] = remapped;
        else delete session.answers[fresh.id];
        if (previousResult) {
          session.results[fresh.id] = remapped.length
            ? { ...previousResult, correct: practiceService.sameAnswer(fresh.answer || [], remapped) }
            : previousResult;
        }
      }
      this.editQuestionSnapshot = '';
      getApp().globalData.currentSession = session;
      this.renderQuestion();
    } catch (error) {
      this.editQuestionSnapshot = '';
      wx.showModal({ title: '题目刷新失败', content: error.message || String(error), showCancel: false });
    }
  },

  buildQuestionSheet() {
    const session = this.session;
    const items = [];
    const typeMap = new Map();
    let correct = 0;
    let wrong = 0;
    let unanswered = 0;
    (session.questions || []).forEach((question, index) => {
      const status = practiceService.getQuestionAnswerStatus(question, session.results[question.id]);
      if (status === 'correct') correct += 1;
      else if (status === 'wrong') wrong += 1;
      else unanswered += 1;
      const typeLabel = sheetTypeLabel(question);
      const typeClass = sheetTypeClass(question, typeLabel);
      if (!typeMap.has(typeLabel)) typeMap.set(typeLabel, { key: typeLabel, label: typeLabel, typeClass, count: 0 });
      typeMap.get(typeLabel).count += 1;
      items.push({
        number: index + 1,
        index,
        status,
        statusClass: `sheet-${status}`,
        typeKey: typeLabel,
        typeLabel,
        typeClass,
        current: index === session.index,
        longNumber: index + 1 >= 1000
      });
    });
    return { items, correct, wrong, unanswered, types: Array.from(typeMap.values()) };
  },

  applyQuestionSheetFilters(scrollMode = '') {
    const allItems = Array.isArray(this.questionSheetAllItems) ? this.questionSheetAllItems : [];
    const statusFilter = this.data.sheetStatusFilter || 'all';
    const typeFilter = this.data.sheetTypeFilter || 'all';
    const items = allItems.filter(item =>
      (statusFilter === 'all' || item.status === statusFilter)
      && (typeFilter === 'all' || item.typeKey === typeFilter)
    );
    const currentIndex = this.session ? Number(this.session.index) : -1;
    const currentIncluded = items.some(item => item.index === currentIndex);
    this.setData({
      questionSheetItems: items,
      sheetFilteredCount: items.length,
      sheetHasFilter: statusFilter !== 'all' || typeFilter !== 'all',
      sheetCurrentExcluded: items.length > 0 && !currentIncluded
    }, () => {
      if (scrollMode) this.scheduleQuestionSheetScroll(scrollMode);
    });
  },

  scheduleQuestionSheetScroll(mode = 'current') {
    if (this.questionSheetScrollTimer) clearTimeout(this.questionSheetScrollTimer);
    this.questionSheetScrollTimer = setTimeout(() => {
      this.questionSheetScrollTimer = null;
      const run = () => this.scrollQuestionSheet(mode);
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(run));
      else run();
    }, 30);
  },

  scrollQuestionSheet(mode = 'current') {
    if (!this.data.showQuestionSheet || typeof document === 'undefined') return;
    const root = document.querySelector('#page-root[data-page="pages/practice/practice"]') || document;
    const container = root.querySelector('.practice-sheet-scroll');
    if (!container) return;
    let target = null;
    if (mode === 'current' && this.session) {
      target = container.querySelector(`.practice-sheet-number[data-index="${Number(this.session.index)}"]`);
    }
    if (!target) target = container.querySelector('.practice-sheet-number');
    if (!target) {
      container.scrollTop = 0;
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const top = container.scrollTop + targetRect.top - containerRect.top
      - Math.max(0, (containerRect.height - targetRect.height) / 2);
    if (typeof container.scrollTo === 'function') container.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    else container.scrollTop = Math.max(0, top);
  },

  filterQuestionSheetStatus(event) {
    const selected = String(event.currentTarget.dataset.status || 'all');
    const next = selected === this.data.sheetStatusFilter ? 'all' : selected;
    this.setData({ sheetStatusFilter: next }, () => this.applyQuestionSheetFilters('first'));
  },

  filterQuestionSheetType(event) {
    const selected = String(event.currentTarget.dataset.type || 'all');
    const next = selected === this.data.sheetTypeFilter ? 'all' : selected;
    this.setData({ sheetTypeFilter: next }, () => this.applyQuestionSheetFilters('first'));
  },

  clearQuestionSheetFilters() {
    this.setData({ sheetStatusFilter: 'all', sheetTypeFilter: 'all' }, () => this.applyQuestionSheetFilters('current'));
  },

  openQuestionSheet() {
    this.clearAutoNext();
    if (!this.session) return;
    const sheet = this.buildQuestionSheet();
    this.questionSheetAllItems = sheet.items;
    const validType = sheet.types.some(item => item.key === this.data.sheetTypeFilter)
      ? this.data.sheetTypeFilter : 'all';
    this.setData({
      showQuestionSheet: true,
      sheetCorrectCount: sheet.correct,
      sheetWrongCount: sheet.wrong,
      sheetUnansweredCount: sheet.unanswered,
      sheetTotalCount: sheet.items.length,
      sheetTypeItems: sheet.types,
      sheetTypeFilter: validType
    }, () => this.applyQuestionSheetFilters('current'));
  },

  closeQuestionSheet() {
    if (this.questionSheetScrollTimer) clearTimeout(this.questionSheetScrollTimer);
    this.questionSheetScrollTimer = null;
    if (this.data.showQuestionSheet) this.setData({ showQuestionSheet: false });
  },

  noop() {},

  jumpToQuestion(event) {
    const index = Number(event.currentTarget.dataset.index);
    if (!this.session || !Number.isInteger(index) || index < 0 || index >= this.session.questions.length) return;
    this.setData({ showQuestionSheet: false }, () => {
      this.session.index = index;
      this.renderQuestion();
    });
  },

  selectOption(event) {
    if (this.data.submitted || this.data.memorizeMode) return;
    const key = event.currentTarget.dataset.key;
    const question = this.data.question;
    let selected = this.data.selected.slice();

    if (question.type === 'multiple') {
      const index = selected.indexOf(key);
      if (index >= 0) selected.splice(index, 1);
      else selected.push(key);
      // 多选题未提交前的勾选也保存，避免切后台或返回后丢失。
      this.session.answers[question.id] = selected.slice();
      this.persistProgress('multiple-selection', true);
      this.setData({ selected, displayOptions: this.decorateOptions(question, selected, false) });
      return;
    }

    selected = [key];
    // 单选题直接一次性完成选中和提交。旧逻辑会先刷新“选中态”，随后立即再次
    // 刷新“答案态”，一次点击连续重建两遍整页 DOM，是明显闪跳的另一来源。
    this.submit(selected);
  },

  submit(selectedOverride) {
    const selected = Array.isArray(selectedOverride) ? selectedOverride.slice() : this.data.selected.slice();
    if (this.data.submitted || !selected.length || this.data.memorizeMode) return;
    const session = this.session;
    const question = this.data.question;
    const result = practiceService.judgeQuestion(question, selected);
    session.answers[question.id] = selected.slice();
    session.results[question.id] = result;
    this.markQuestionCompleted(question);
    this.persistProgress('answer-submitted', true);

    if (result.correct) {
      if (session.mode === 'wrong') recordStorage.removeWrong(session.bankId, question.id);
      else recordStorage.markCorrect(session.bankId, question.id);
    } else recordStorage.markWrong(session.bankId, question.id);
    recordStorage.recordAnswer(result.correct, { bankId: session.bankId, type: question.type, typeLabel: question.displayTypeLabel || '', difficulty: question.difficulty || '', category: question.category || '' });
    const layout = this.buildAdaptiveLayout(question, true, false);

    this.setData({
      selected,
      submitted: true,
      showAnswer: true,
      result,
      displayOptions: this.decorateOptions(question, selected, true),
      ...layout
    }, () => this.scheduleAutoNext(result));
  },

  scheduleAutoNext(result) {
    if (!result || !result.correct || !this.settings.autoNext || this.data.memorizeMode) return;
    this.clearAutoNext();
    const delay = Number(this.settings.autoNextDelay) || 500;
    const seconds = delay < 1000 ? (delay / 1000).toFixed(1) : String(delay / 1000).replace(/\.0$/, '');
    const scheduledQuestionId = this.data.question && this.data.question.id;
    this.setData({ autoNextHint: `答对了，${seconds} 秒后自动下一题` });
    this.autoNextTimer = setTimeout(() => {
      this.autoNextTimer = null;
      if (!this.pageVisible || this.pendingQuestionEdit || this.data.showQuestionSheet) return;
      if (!this.data.question || this.data.question.id !== scheduledQuestionId) return;
      this.next();
    }, delay);
  },

  showShortAnswer() {
    if (this.data.submitted || this.data.memorizeMode) return;
    const question = this.data.question;
    const result = { correct: false, revealed: true };
    this.session.results[question.id] = result;
    this.persistProgress('short-answer-revealed', true);
    const layout = this.buildAdaptiveLayout(question, true, false);
    this.setData({
      submitted: true,
      showAnswer: true,
      result,
      ...layout
    });
  },

  scoreShort(event) {
    this.clearAutoNext();
    const score = event.currentTarget.dataset.score;
    const session = this.session;
    const question = this.data.question;
    const result = practiceService.judgeQuestion(question, [], score);
    session.results[question.id] = result;
    this.markQuestionCompleted(question);
    this.persistProgress('short-answer-scored', true);
    if (result.correct) {
      if (session.mode === 'wrong') recordStorage.removeWrong(session.bankId, question.id);
      else recordStorage.markCorrect(session.bankId, question.id);
    } else recordStorage.markWrong(session.bankId, question.id);
    recordStorage.recordAnswer(result.correct, { bankId: session.bankId, type: question.type, typeLabel: question.displayTypeLabel || '', difficulty: question.difficulty || '', category: question.category || '' });
    if (score === 'mastered') {
      recordStorage.setMastered(session.bankId, question.id, true);
      this.setData({ result }, () => setTimeout(() => this.removeCurrentAfterMastered(), 180));
    } else {
      this.setData({ result }, () => this.scheduleAutoNext(result));
    }
  },

  rateMemorize(event) {
    this.clearAutoNext();
    if (!this.data.memorizeMode) return;
    const score = event.currentTarget.dataset.score;
    const session = this.session;
    const question = this.data.question;
    const previous = session.results[question.id];
    const result = { correct: score === 'mastered', selfScore: score, memorize: true };
    session.results[question.id] = result;

    if (!previous) {
      if (score === 'mastered') {
        recordStorage.markCorrect(session.bankId, question.id);
        recordStorage.setMastered(session.bankId, question.id, true);
      } else recordStorage.markWrong(session.bankId, question.id);
      recordStorage.recordReview(score);
    }
    if (score === 'mastered') this.setData({ result }, () => setTimeout(() => this.removeCurrentAfterMastered(), 180));
    else this.setData({ result });
  },

  removeCurrentAfterMastered() {
    this.clearAutoNext();
    const session = this.session;
    if (!session || !session.questions.length) return;
    const removed = session.questions.splice(session.index, 1)[0];
    if (removed) {
      delete session.answers[removed.id];
      delete session.results[removed.id];
    }
    if (!session.questions.length) {
      wx.showModal({
        title: '当前题目已全部掌握',
        content: '这些题已移入“已掌握”，以后不会出现在练习和背题中。',
        showCancel: false,
        success: () => wx.navigateBack()
      });
      return;
    }
    if (session.index >= session.questions.length) session.index = session.questions.length - 1;
    this.renderQuestion();
  },

  masterCurrent() {
    this.clearAutoNext();
    if (!this.session || !this.data.question) return;
    const question = this.data.question;
    // 手动标记掌握也视为完成该题，继续进度应进入它的下一题。
    this.session.results[question.id] = { correct: true, selfScore: 'mastered', manualMastered: true };
    this.markQuestionCompleted(question);
    this.persistProgress('manual-mastered', true);
    if (!recordStorage.isMastered(this.session.bankId, question.id)) {
      recordStorage.setMastered(this.session.bankId, question.id, true);
      recordStorage.recordReview('mastered');
    }
    wx.showToast({ title: '已移入已掌握', icon: 'none' });
    this.removeCurrentAfterMastered();
  },

  toggleFavorite() {
    const favorite = recordStorage.toggleFavorite(this.session.bankId, this.data.question.id);
    this.setData({ favorite });
    wx.showToast({ title: favorite ? '已收藏' : '已取消', icon: 'none' });
  },

  onTouchStart(event) {
    const touch = event && event.touches && event.touches[0];
    if (!touch || this.data.showQuestionSheet) return;
    this.swipeStart = {
      x: Number(touch.clientX || touch.pageX || 0),
      y: Number(touch.clientY || touch.pageY || 0),
      time: Date.now()
    };
  },

  onTouchEnd(event) {
    if (!this.swipeStart) return;
    const touch = event && event.changedTouches && event.changedTouches[0];
    const start = this.swipeStart;
    this.swipeStart = null;
    if (!touch) return;

    const dx = Number(touch.clientX || touch.pageX || 0) - start.x;
    const dy = Number(touch.clientY || touch.pageY || 0) - start.y;
    const elapsed = Date.now() - start.time;
    if (elapsed > 900 || Math.abs(dx) < 62 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
    this.enqueueSwipe(dx < 0 ? 'next' : 'previous');
  },

  enqueueSwipe(direction) {
    if (!this.pendingSwipes) this.pendingSwipes = [];
    if (this.pendingSwipes.length >= 10) return;
    this.pendingSwipes.push(direction);
    this.drainSwipeQueue();
  },

  drainSwipeQueue() {
    if (this.swipeProcessing || !this.pendingSwipes || !this.pendingSwipes.length) return;
    const direction = this.pendingSwipes.shift();
    this.swipeProcessing = true;
    if (direction === 'next') this.next();
    else this.previous();
    setTimeout(() => {
      this.swipeProcessing = false;
      this.drainSwipeQueue();
    }, 85);
  },

  previous() {
    this.clearAutoNext();
    if (!this.session || this.session.index <= 0) return;
    this.session.index -= 1;
    this.renderQuestion();
  },

  next() {
    this.clearAutoNext();
    const session = this.session;
    if (!session) return;
    if (session.index >= session.questions.length - 1) {
      this.finish();
      return;
    }
    session.index += 1;
    this.renderQuestion();
  },

  finish() {
    const session = this.session;
    const allCompleted = Boolean(session && session.questions.length)
      && session.questions.every(question =>
        practiceService.getQuestionAnswerStatus(question, session.results[question.id]) !== 'unanswered'
      );
    if (session && session.mode === 'memorize' && session.memorizeOrder !== 'random') {
      this.persistProgress('finish-memorize', true);
    }
    if (session && session.mode === 'sequence') {
      // 即使完整做完最后一道题也保留进度与答题状态，便于下次查看和继续。
      // 用户主动“从头开始”时再由配置页覆盖，而不是完成后自动删除。
      this.persistProgress(allCompleted ? 'finish-completed-all' : 'finish-with-unanswered', true);
    }
    const values = Object.values(session.results).filter(item => item && (item.selfScore || typeof item.correct === 'boolean'));
    const correct = values.filter(item => item.correct).length;
    const title = session.memorize ? '背题完成' : '练习完成';
    getApp().globalData.resultData = {
      title,
      total: session.questions.length,
      answered: values.length,
      correct,
      accuracy: values.length ? Math.round(correct / values.length * 100) : 0,
      duration: Math.round((Date.now() - session.startedAt) / 1000),
      memorize: Boolean(session.memorize)
    };
    wx.redirectTo({ url: '/pages/result/result' });
  }

});
});
__define("pages/practice-config/practice-config.js", function(require, module, exports){
const bankStorage = require('../../services/bank-storage');
const practiceService = require('../../services/practice-service');
const recordStorage = require('../../services/record-storage');

const { QUESTION_TYPES } = require('../../utils/constants');

const TYPE_LABEL_ORDER = ['单选题', '多选题', '判断题', '填空题', '简答题', '计算题', '画图题'];
function displayTypeLabel(question) {
  return String(question && (question.displayTypeLabel || QUESTION_TYPES[question.type] || question.type) || '未知题型').trim();
}
function buildTypeOptions(questions = []) {
  const counts = {};
  let abnormalCount = 0;
  (questions || []).forEach(question => {
    if (!question || question.sourceMissingPlaceholder || question.nonPractice) return;
    const status = question.status || 'normal';
    // 异常状态优先于原题型：异常单选/多选等只归入统一“异常题”，
    // 不再额外制造一个看似可正常练习的原题型入口。
    if (status !== 'normal') {
      abnormalCount += 1;
      return;
    }
    const label = displayTypeLabel(question);
    counts[label] = (counts[label] || 0) + 1;
  });
  const labels = Object.keys(counts).sort((left, right) => {
    const li = TYPE_LABEL_ORDER.indexOf(left);
    const ri = TYPE_LABEL_ORDER.indexOf(right);
    if (li >= 0 || ri >= 0) return (li < 0 ? 999 : li) - (ri < 0 ? 999 : ri);
    return left.localeCompare(right, 'zh-CN');
  });
  const options = [{ value: 'all', label: '全部题型' }];
  labels.forEach(label => options.push({ value: `display:${label}`, label }));
  if (abnormalCount) options.push({ value: 'abnormal', label: '异常题' });
  return options;
}

Page({
  data: {
    bankId: '',
    manifest: null,
    mode: 'sequence',
    modeName: '顺序练习',
    typeOptions: [{ value: 'all', label: '全部题型' }],
    typeIndex: 0,
    wrongOrderOptions: [
      { value: 'sequence', label: '按原题库顺序' },
      { value: 'random', label: '随机打乱错题' }
    ],
    wrongOrderIndex: 0,
    memorizeOrderOptions: [
      { value: 'sequence', label: '按原题库顺序' },
      { value: 'random', label: '随机打乱题目' }
    ],
    memorizeOrderIndex: 0,
    countOptions: [10, 20, 50, 100, 0],
    countLabels: ['10题', '20题', '50题', '100题', '全部'],
    countIndex: 4,
    resume: true,
    progress: null,
    progressCursor: null,
    memorizeProgress: null,
    memorizeProgressCursor: null,
    memorizeRandomSequence: [],
    settings: {
      resetWrongOnRestart: true
    }
  },

  onLoad(query) {
    const manifest = bankStorage.getManifest(query.bankId);
    const mode = query.mode || 'sequence';
    const names = {
      sequence: '顺序练习',
      random: '随机练习',
      wrong: '错题重练',
      favorites: '收藏练习',
      memorize: '背题模式'
    };
    const progress = recordStorage.getProgress(query.bankId);
    const memorizeProgress = typeof recordStorage.getMemorizeProgress === 'function'
      ? recordStorage.getMemorizeProgress(query.bankId) : null;
    let questions = [];
    try { questions = bankStorage.loadQuestions(query.bankId); } catch (_) {}
    const typeOptions = buildTypeOptions(questions);
    this.setData({
      bankId: query.bankId,
      manifest,
      mode,
      typeOptions,
      typeIndex: 0,
      modeName: names[mode] || '顺序练习',
      progress,
      progressCursor: practiceService.getProgressCursor(progress, 'all', 0),
      memorizeProgress,
      memorizeProgressCursor: practiceService.getMemorizeProgressCursor(memorizeProgress, 'sequence', 'all', 0),
      memorizeRandomSequence: practiceService.getMemorizeQuestionSequence(memorizeProgress, 'random', 'all', 0),
      settings: recordStorage.getSettings()
    });
  },

  refreshProgress() {
    if (!this.data.bankId) return;
    const progress = recordStorage.getProgress(this.data.bankId);
    const memorizeProgress = typeof recordStorage.getMemorizeProgress === 'function'
      ? recordStorage.getMemorizeProgress(this.data.bankId) : null;
    const previousValue = this.data.typeOptions[this.data.typeIndex]
      ? this.data.typeOptions[this.data.typeIndex].value : 'all';
    let questions = [];
    try { questions = bankStorage.loadQuestions(this.data.bankId); } catch (_) {}
    const typeOptions = buildTypeOptions(questions);
    let typeIndex = typeOptions.findIndex(item => item.value === previousValue);
    if (typeIndex < 0) typeIndex = 0;
    const type = typeOptions[typeIndex].value;
    const count = this.data.countOptions[this.data.countIndex];
    this.setData({
      typeOptions,
      typeIndex,
      progress,
      progressCursor: practiceService.getProgressCursor(progress, type, count),
      memorizeProgress,
      memorizeProgressCursor: practiceService.getMemorizeProgressCursor(
        memorizeProgress,
        this.data.memorizeOrderOptions[this.data.memorizeOrderIndex].value,
        type,
        count
      ),
      memorizeRandomSequence: practiceService.getMemorizeQuestionSequence(memorizeProgress, 'random', type, count),
      settings: recordStorage.getSettings()
    });
  },

  onShow() {
    // 从练习页返回时重新读取最新“已完成题”进度，不能继续使用进入前缓存。
    this.refreshProgress();
  },

  onTypeChange(event) {
    const typeIndex = Number(event.detail.value);
    this.setData({ typeIndex }, () => this.refreshProgress());
  },

  onCountChange(event) {
    const countIndex = Number(event.detail.value);
    this.setData({ countIndex }, () => this.refreshProgress());
  },

  onWrongOrderChange(event) {
    this.setData({ wrongOrderIndex: Number(event.detail.value) });
  },

  onMemorizeOrderChange(event) {
    this.setData({ memorizeOrderIndex: Number(event.detail.value), resume: true }, () => this.refreshProgress());
  },


  onResumeChange(event) {
    this.setData({ resume: Boolean(event.detail.value) });
  },

  buildConfig() {
    const type = this.data.typeOptions[this.data.typeIndex].value;
    const count = this.data.countOptions[this.data.countIndex];
    const memorizeOrder = this.data.memorizeOrderOptions[this.data.memorizeOrderIndex].value;
    const canResumeSequence = this.data.mode === 'sequence' && this.data.resume && this.data.progressCursor;
    const canResumeMemorize = this.data.mode === 'memorize'
      && this.data.resume && this.data.memorizeProgressCursor
      && (memorizeOrder !== 'random' || (this.data.memorizeRandomSequence || []).length > 0);
    return {
      bankId: this.data.bankId,
      bankName: this.data.manifest.name,
      mode: this.data.mode,
      type,
      count,
      wrongOrder: this.data.mode === 'wrong'
        ? this.data.wrongOrderOptions[this.data.wrongOrderIndex].value
        : 'sequence',
      memorizeOrder,
      resumeCursor: canResumeSequence
        ? this.data.progressCursor
        : (canResumeMemorize ? this.data.memorizeProgressCursor : null),
      resumeQuestionStates: canResumeSequence && this.data.progress
        ? (this.data.progress.questionStates || [])
        : [],
      resumeQuestionSequence: canResumeMemorize && memorizeOrder === 'random'
        ? this.data.memorizeRandomSequence
        : []
    };
  },

  beginSession() {
    try {
      const session = practiceService.createSession(this.buildConfig());
      if (!session.questions.length) {
        wx.showModal({
          title: '没有可练习题目',
          content: '当前筛选条件下没有题目。错题和收藏模式需要先产生相应记录。',
          showCancel: false
        });
        return;
      }
      getApp().globalData.currentSession = session;
      wx.navigateTo({ url: '/pages/practice/practice' });
    } catch (error) {
      wx.showModal({ title: '无法开始', content: error.message || String(error), showCancel: false });
    }
  },

  start() {
    const hasSavedSequence = Boolean(this.data.progress);
    const memorizeOrder = this.data.memorizeOrderOptions[this.data.memorizeOrderIndex].value;
    const isRestartingMemorize = this.data.mode === 'memorize'
      && !this.data.resume && Boolean(this.data.memorizeProgressCursor);
    // 只要关闭“继续上次进度”，就把对应的顺序进度重置。
    // 不再依赖当前页面缓存中是否恰好读到了 progress。
    const isRestartingSequence = this.data.mode === 'sequence' && !this.data.resume;
    const shouldResetWrong = isRestartingSequence
      && hasSavedSequence
      && Boolean(this.data.settings && this.data.settings.resetWrongOnRestart);

    const startFromBeginning = () => {
      // 先清除旧进度再建会话。否则用户选择“从头开始”后若 APP 立即被系统结束，
      // 下次仍可能读到旧位置。
      if (this.data.mode === 'sequence') {
        recordStorage.clearProgressForBank(this.data.bankId);
        this.setData({ progress: null, progressCursor: null });
      } else if (isRestartingMemorize) {
        const type = this.data.typeOptions[this.data.typeIndex].value;
        const count = this.data.countOptions[this.data.countIndex];
        const scopeKey = practiceService.buildMemorizeScopeKey(memorizeOrder, type, count);
        const legacyScopeKey = memorizeOrder === 'sequence' ? practiceService.buildPracticeScopeKey(type, count) : '';
        if (typeof recordStorage.clearMemorizeProgressScope === 'function') {
          recordStorage.clearMemorizeProgressScope(this.data.bankId, scopeKey, legacyScopeKey);
        }
        this.setData({ memorizeProgressCursor: null, memorizeRandomSequence: [] });
      }
      this.beginSession();
    };

    if (!shouldResetWrong) {
      if (isRestartingSequence || isRestartingMemorize) startFromBeginning();
      else this.beginSession();
      return;
    }

    const wrongCount = Object.values(recordStorage.getWrong(this.data.bankId)).filter(item => !item.mastered).length;
    wx.showModal({
      title: '从头开始练习',
      content: wrongCount
        ? `将从第一题开始，并清除当前题库 ${wrongCount} 道错题记录。`
        : '将从第一题开始，当前题库没有需要清除的错题。',
      confirmText: wrongCount ? '从头并清除' : '从头开始',
      cancelText: '返回',
      success: result => {
        if (!result.confirm) return;
        recordStorage.clearWrongForBank(this.data.bankId);
        startFromBeginning();
      }
    });
  }
});
});
__define("pages/result/result.js", function(require, module, exports){
Page({
  data: {
    result: null,
    durationText: ''
  },

  onLoad() {
    const result = getApp().globalData.resultData;
    if (!result) {
      wx.showModal({
        title: '结果已失效',
        content: '请重新开始练习。',
        showCancel: false,
        success: () => wx.reLaunch({ url: '/pages/home/home' })
      });
      return;
    }
    const minutes = Math.floor(result.duration / 60);
    const seconds = result.duration % 60;
    this.setData({
      result,
      durationText: `${minutes}分${seconds}秒`
    });
  },

  backHome() {
    getApp().globalData.currentSession = null;
    getApp().globalData.resultData = null;
    wx.reLaunch({ url: '/pages/home/home' });
  },

  reviewExam() {
    const session = getApp().globalData.currentSession;
    if (!session || !session.exam) {
      wx.showToast({ title: '本次试卷已失效', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/exam-review/exam-review' });
  },

  reviewWrong() {
    const session = getApp().globalData.currentSession;
    if (!session) return;
    wx.redirectTo({
      url: `/pages/practice-config/practice-config?bankId=${session.bankId}&mode=wrong`
    });
  }
});
});
__define("pages/review/review.js", function(require, module, exports){
const bankStorage = require('../../services/bank-storage');
const { QUESTION_TYPES } = require('../../utils/constants');
const { validateQuestion, repairOptionDuplicates } = require('../../services/question-validator');

const TYPE_ORDER = ['单选题', '多选题', '判断题', '填空题', '简答题', '计算题', '画图题'];
const ISSUE_GROUPS = [
  { key: 'sourceOptionDuplicate', label: '片段重复', test: issue => /导入片段重复|原文确实重复|原文重复|原文选项内容重复/.test(issue) },
  { key: 'parserOptionDuplicate', label: '识别重复', test: issue => /解析重复|解析疑似重复识别/.test(issue) },
  { key: 'possibleOptionDuplicate', label: '疑似重复', test: issue => /疑似重复|选项内容重复|选项字母重复/.test(issue) },
  { key: 'missingAnswer', label: '无答案', test: issue => /无答案|缺少答案|缺少参考答案/.test(issue) },
  { key: 'answerMismatch', label: '答案不符', test: issue => /答案不符|答案.+不在选项中/.test(issue) },
  { key: 'optionStructure', label: '选项异常', test: issue => /选项不足|选项少于|空白选项|图片选项缺少图像|图片选项待核对/.test(issue) },
  { key: 'typeIssue', label: '题型异常', test: issue => /多选仅一项|多选题只有一个答案|判断选项异常|判断题选项数量/.test(issue) },
  { key: 'boundary', label: '边界异常', test: issue => /边界|题干文字未完整识别|残留答案|粘连|题干过长|答案过长/.test(issue) },
  { key: 'duplicateQuestion', label: '重复题', test: issue => /重复题|疑似与第/.test(issue) }
];

function unique(list) { return Array.from(new Set((list || []).filter(Boolean))); }
function cleanIssueText(value) {
  return String(value || '').replace(/^\s*[•·-]\s*/, '').replace(/\s+/g, ' ').trim();
}
function collectIssueLetters(items) {
  const letters = [];
  (items || []).forEach(text => {
    const match = /[（(]([A-L](?:[、,，/\s]+[A-L])*)[）)]/i.exec(String(text || ''));
    if (!match) return;
    (match[1].toUpperCase().match(/[A-L]/g) || []).forEach(letter => {
      if (!letters.includes(letter)) letters.push(letter);
    });
  });
  return letters;
}
function normalizeReviewIssues(input = []) {
  let issues = unique((input || []).map(cleanIssueText).filter(Boolean));

  // 已有更明确的重复来源时，删除旧版遗留的泛化“选项内容重复”。
  const hasSpecificDuplicate = issues.some(issue => /^(?:导入片段重复|原文确实重复|原文重复|解析重复|疑似重复|原文选项内容重复|解析疑似重复识别)/.test(issue));
  if (hasSpecificDuplicate) issues = issues.filter(issue => !/^选项内容重复(?:[（(]|$)/.test(issue));

  // 同类答案不符合并字母，避免同一道题出现多条等价异常。
  const mismatches = issues.filter(issue => /答案不符|答案.+不在选项中/.test(issue));
  if (mismatches.length > 1) {
    const letters = collectIssueLetters(mismatches);
    issues = issues.filter(issue => !mismatches.includes(issue));
    issues.push(letters.length ? `答案不符（${letters.join('、')}）` : '答案不符');
  }

  const hasMissingAnswer = issues.some(issue => /无答案|缺少答案|缺少参考答案/.test(issue));
  if (hasMissingAnswer) {
    // 没有答案时“答案不符”没有额外信息，保留一个“无答案”即可。
    issues = issues.filter(issue => !/答案不符|答案.+不在选项中/.test(issue));
    const missing = issues.filter(issue => /无答案|缺少答案|缺少参考答案/.test(issue));
    if (missing.length > 1) {
      issues = issues.filter(issue => !missing.includes(issue));
      issues.push('无答案');
    }
  }

  const optionShortage = issues.filter(issue => /选项不足|选项少于/.test(issue));
  const answerMismatch = issues.filter(issue => /答案不符|答案.+不在选项中/.test(issue));
  if (optionShortage.length && answerMismatch.length) {
    // “选项不足 + 答案不符(C)”通常是同一个根因，合并成一条更易读的异常。
    const letters = collectIssueLetters(answerMismatch);
    issues = issues.filter(issue => !optionShortage.includes(issue) && !answerMismatch.includes(issue));
    issues.push(letters.length ? `选项不足（答案 ${letters.join('、')} 无对应选项）` : '选项不足');
  } else if (optionShortage.length > 1) {
    issues = issues.filter(issue => !optionShortage.includes(issue));
    issues.push('选项不足');
  }

  // 判断题选项异常与普通选项不足同时出现时，保留更具体的一项。
  if (issues.some(issue => /判断选项异常|判断题选项数量/.test(issue))) {
    issues = issues.filter(issue => !/^选项不足$/.test(issue));
  }
  return unique(issues);
}
function conciseIssueLabel(issue, fallback) {
  const text = cleanIssueText(issue);
  if (!text) return fallback;
  // 过长或含解释性句子的异常仍用简短组名；短异常则与题目卡片保持一致。
  const visibleLength = Array.from(text).length;
  if (visibleLength <= 11 && !/[：:]/.test(text)) return text;
  return fallback;
}
function isDuplicateIssue(issue) { return /导入片段重复|原文确实重复|原文重复|解析重复|疑似重复|选项内容重复|原文选项内容重复|解析疑似重复识别/.test(String(issue)); }
function issueKinds(issues = []) {
  const kinds = [];
  issues.forEach(issue => {
    const matched = ISSUE_GROUPS.find(group => group.test(String(issue)));
    const key = matched ? matched.key : 'other';
    if (!kinds.includes(key)) kinds.push(key);
  });
  return kinds;
}
function statusMatches(item, status) {
  const current = item.status || 'normal';
  if (status === 'all') return true;
  if (status === 'abnormal') return current !== 'normal';
  return current === status;
}
function confidenceBucket(value) {
  const confidence = Math.max(0, Math.min(1, Number(value) || 0));
  if (confidence < 0.45) return 'low';
  if (confidence < 0.75) return 'medium';
  return 'high';
}
function confidencePercent(value) {
  return Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100);
}
function sourceFragmentLabel(question) {
  const kind = String(question && question.source && question.source.kind || '').toLowerCase();
  if (['xlsx', 'xlsm', 'xltx', 'xltm', 'xls', 'ods', 'csv', 'tsv', 'excel'].includes(kind)) return `原始 ${kind === 'excel' ? 'Excel' : kind.toUpperCase()} 行`;
  if (kind === 'pdf') return '原始 PDF 文本片段';
  if (kind) return `原始 ${kind.toUpperCase()} 文本片段`;
  return '原始文件片段';
}

Page({
  data: {
    source: 'draft', bankId: '', statusFilter: 'abnormal', confidenceFilter: 'all', issueFilter: 'all', typeFilter: 'all',
    editMode: false, keyword: '', items: [], total: 0, hasMore: false,
    counts: { all: 0, normal: 0, warning: 0, error: 0, abnormal: 0 },
    confidenceFilters: [], issueFilters: [], typeFilters: [], showConfidenceFilters: true, showIssueFilters: true, savingAll: false
  },

  onLoad(query) {
    const editMode = query.editMode === '1';
    this.setData({ source: query.source || 'draft', bankId: query.bankId || '',
      statusFilter: query.filter || (editMode ? 'all' : 'abnormal'), editMode });
    if (editMode) wx.setNavigationBarTitle({ title: '编辑题库' });
  },

  onShow() { this.load(); },

  normalizeQuestion(item, index) {
    const repaired = repairOptionDuplicates(item);
    const validation = validateQuestion(repaired);
    const preserved = (item.issues || []).filter(issue => !isDuplicateIssue(issue));
    const issues = normalizeReviewIssues([...preserved, ...validation.issues]);
    let status = validation.status;
    if (issues.length && status === 'normal') status = 'warning';
    return {
      ...repaired, ...validation, issues, status, originalIndex: index,
      typeLabel: repaired.displayTypeLabel || QUESTION_TYPES[repaired.type] || repaired.type || '未知题型',
      showCategory: Boolean(repaired.category && repaired.category !== '未分类' &&
        String(repaired.category).trim() !== String(repaired.displayTypeLabel || QUESTION_TYPES[repaired.type] || repaired.type || '').trim()),
      rawPreview: repaired.source && Array.isArray(repaired.source.rawTexts) ? repaired.source.rawTexts.slice(0, 6) : [],
      rawSourceLabel: sourceFragmentLabel(repaired),
      answerPreview: repaired.type === 'short' ? (repaired.answerText || '') : (repaired.answer || []).join('、'),
      confidence: Number(validation.confidence) || 0,
      confidencePercent: confidencePercent(validation.confidence),
      confidenceBucket: confidenceBucket(validation.confidence),
      issueKinds: issueKinds(issues),
      searchText: [repaired.number, repaired.question, repaired.category, repaired.displayTypeLabel, repaired.difficulty, repaired.answerText, repaired.analysis,
        ...(repaired.options || []).map(option => option.text)].join(' ').toLowerCase()
    };
  },

  load() {
    let questions = [];
    if (this.data.source === 'draft') {
      const draft = getApp().globalData.importDraft;
      questions = draft ? draft.questions : [];
    } else questions = bankStorage.loadQuestions(this.data.bankId);

    this.allQuestions = questions.map((item, index) => this.normalizeQuestion(item, index));
    const counts = this.allQuestions.reduce((acc, item) => {
      const status = item.status || 'normal'; acc[status] = (acc[status] || 0) + 1; return acc;
    }, { all: this.allQuestions.length, normal: 0, warning: 0, error: 0 });
    counts.abnormal = counts.warning + counts.error;
    this.setData({ counts }, () => this.refreshAvailableFilters(true));
  },

  statusItems() { return (this.allQuestions || []).filter(item => statusMatches(item, this.data.statusFilter)); },

  refreshAvailableFilters(resetList = true) {
    const statusItems = this.statusItems();
    const showConfidenceFilters = ['abnormal', 'error', 'warning'].includes(this.data.statusFilter);
    const confidenceCounts = statusItems.reduce((acc, item) => {
      const bucket = item.confidenceBucket || confidenceBucket(item.confidence);
      acc[bucket] = (acc[bucket] || 0) + 1;
      return acc;
    }, { low: 0, medium: 0, high: 0 });
    const confidenceFilters = showConfidenceFilters ? [
      { key: 'all', label: '全部置信度', count: statusItems.length },
      { key: 'low', label: '低 0–44%', count: confidenceCounts.low },
      { key: 'medium', label: '中 45–74%', count: confidenceCounts.medium },
      { key: 'high', label: '高 75–100%', count: confidenceCounts.high }
    ].filter(item => item.key === 'all' || item.count) : [];
    const validConfidence = showConfidenceFilters && confidenceFilters.some(item => item.key === this.data.confidenceFilter)
      ? this.data.confidenceFilter : 'all';
    const confidenceItems = validConfidence === 'all' ? statusItems : statusItems.filter(item => item.confidenceBucket === validConfidence);
    const showIssueFilters = ['abnormal', 'error', 'warning'].includes(this.data.statusFilter);

    const issueCountMap = {};
    const issueLabelMap = {};
    confidenceItems.forEach(item => {
      item.issueKinds.forEach(key => { issueCountMap[key] = (issueCountMap[key] || 0) + 1; });
      (item.issues || []).forEach(issue => {
        const matched = ISSUE_GROUPS.find(group => group.test(String(issue)));
        const key = matched ? matched.key : 'other';
        if (!issueLabelMap[key]) issueLabelMap[key] = [];
        const label = conciseIssueLabel(issue, matched ? matched.label : '其他');
        if (!issueLabelMap[key].includes(label)) issueLabelMap[key].push(label);
      });
    });
    const issueFilters = [];
    if (showIssueFilters) {
      issueFilters.push({ key: 'all', label: '全部问题', count: confidenceItems.length });
      ISSUE_GROUPS.forEach(group => {
        if (!issueCountMap[group.key]) return;
        const labels = issueLabelMap[group.key] || [];
        // 当前筛选下同类异常文字完全一致且不长时，胶囊直接显示题目卡片中的文字。
        const label = labels.length === 1 ? labels[0] : group.label;
        issueFilters.push({ key: group.key, label, count: issueCountMap[group.key] });
      });
      if (issueCountMap.other) {
        const labels = issueLabelMap.other || [];
        issueFilters.push({ key: 'other', label: labels.length === 1 ? labels[0] : '其他', count: issueCountMap.other });
      }
    }
    const validIssue = showIssueFilters && issueFilters.some(item => item.key === this.data.issueFilter)
      ? this.data.issueFilter : 'all';

    const typeBase = validIssue === 'all' ? confidenceItems : confidenceItems.filter(item => item.issueKinds.includes(validIssue));
    const typeCountMap = typeBase.reduce((acc, item) => {
      const label = item.typeLabel || QUESTION_TYPES[item.type] || item.type || '未知题型';
      acc[label] = (acc[label] || 0) + 1;
      return acc;
    }, {});
    const typeFilters = [{ key: 'all', label: '全部题型', count: typeBase.length }];
    TYPE_ORDER.forEach(label => {
      if (typeCountMap[label]) typeFilters.push({ key: label, label, count: typeCountMap[label] });
    });
    Object.keys(typeCountMap).filter(label => !TYPE_ORDER.includes(label)).sort((a, b) => a.localeCompare(b, 'zh-CN')).forEach(label => {
      typeFilters.push({ key: label, label, count: typeCountMap[label] });
    });
    const validType = typeFilters.some(item => item.key === this.data.typeFilter) ? this.data.typeFilter : 'all';

    this.setData({ showConfidenceFilters, confidenceFilters, confidenceFilter: validConfidence, showIssueFilters, issueFilters, issueFilter: validIssue, typeFilters, typeFilter: validType },
      () => this.applyFilter(resetList));
  },

  filteredItems() {
    let items = this.statusItems();
    if (this.data.showConfidenceFilters && this.data.confidenceFilter !== 'all')
      items = items.filter(item => item.confidenceBucket === this.data.confidenceFilter);
    if (this.data.showIssueFilters && this.data.issueFilter !== 'all')
      items = items.filter(item => item.issueKinds.includes(this.data.issueFilter));
    if (this.data.typeFilter !== 'all') items = items.filter(item => item.typeLabel === this.data.typeFilter);
    const keyword = String(this.data.keyword || '').trim().toLowerCase();
    if (keyword) items = items.filter(item => item.searchText.includes(keyword));
    // 异常题默认按置信度从低到高，最值得人工校对的题目优先出现；同置信度保持原题库顺序。
    if (['abnormal', 'error', 'warning'].includes(this.data.statusFilter)) {
      items = items.slice().sort((a, b) => (Number(a.confidence) || 0) - (Number(b.confidence) || 0) || a.originalIndex - b.originalIndex);
    }
    return items;
  },

  applyFilter(reset = true) {
    this.filtered = this.filteredItems();
    this.loadedCount = reset ? 50 : (this.loadedCount || 50);
    const items = this.filtered.slice(0, this.loadedCount);
    this.setData({ items, total: this.filtered.length, hasMore: items.length < this.filtered.length });
  },

  onKeywordInput(event) { this.setData({ keyword: event.detail.value || '' }, () => this.applyFilter(true)); },
  clearKeyword() { this.setData({ keyword: '' }, () => this.applyFilter(true)); },
  changeStatusFilter(event) {
    const value = event.currentTarget.dataset.filter;
    if (!value || value === this.data.statusFilter) return;
    this.setData({ statusFilter: value, confidenceFilter: 'all', issueFilter: 'all', typeFilter: 'all' }, () => this.refreshAvailableFilters(true));
  },
  changeConfidenceFilter(event) {
    const value = event.currentTarget.dataset.filter;
    if (!value || value === this.data.confidenceFilter) return;
    this.setData({ confidenceFilter: value, issueFilter: 'all', typeFilter: 'all' }, () => this.refreshAvailableFilters(true));
  },
  changeIssueFilter(event) {
    const value = event.currentTarget.dataset.filter;
    if (!value || value === this.data.issueFilter) return;
    this.setData({ issueFilter: value, typeFilter: 'all' }, () => this.refreshAvailableFilters(true));
  },
  changeTypeFilter(event) {
    const value = event.currentTarget.dataset.filter;
    if (!value || value === this.data.typeFilter) return;
    this.setData({ typeFilter: value }, () => this.applyFilter(true));
  },
  loadMore() { this.loadedCount += 50; this.applyFilter(false); },

  addAllAbnormalToBank() {
    if (this.data.source !== 'draft' || this.data.savingAll) return;
    const draft = getApp().globalData.importDraft;
    if (!draft) { wx.showModal({ title: '导入数据已失效', content: '请重新导入源文件。', showCancel: false }); return; }
    const abnormalCount = this.data.counts.abnormal || 0;
    wx.showModal({ title: '全部加入题库', content: `将保留当前识别结果，把 ${abnormalCount} 道异常题连同正常题一起保存到题库。异常标记仍会保留，之后可以继续在题库中修改。`, confirmText: '全部加入',
      success: res => { if (!res.confirm) return; this.setData({ savingAll: true }); getApp().globalData.saveImportDraftRequested = true; wx.navigateBack(); } });
  },

  edit(event) {
    const originalIndex = Number(event.currentTarget.dataset.index);
    const item = this.allQuestions.find(question => question.originalIndex === originalIndex);
    if (!item) return;
    const query = this.data.source === 'draft' ? `source=draft&index=${originalIndex}` : `source=bank&bankId=${this.data.bankId}&questionId=${item.id}`;
    wx.navigateTo({ url: `/pages/editor/editor?${query}` });
  }
});
});
__define("pages/search/search.js", function(require, module, exports){
const bankStorage = require('../../services/bank-storage');
const { QUESTION_TYPES } = require('../../utils/constants');
const { buildSearchText, compactText, fuzzyContains } = require('../../utils/text');

Page({
  data: {
    bankId: '',
    keyword: '',
    results: [],
    total: 0,
    hasMore: false
  },

  onLoad(query) {
    this.bankId = query.bankId;
    this.questions = bankStorage.loadQuestions(query.bankId).map(item => ({
      ...item,
      typeLabel: item.displayTypeLabel || QUESTION_TYPES[item.type] || item.type || '未知题型',
      answerDisplay: item.type === 'short'
        ? (item.answerText || '未提供参考答案')
        : (item.answer || []).join('、'),
      _searchText: buildSearchText(item)
    }));
    this.filtered = this.questions;
    this.renderResults(true);
  },

  onUnload() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
  },

  onInput(event) {
    const keyword = event.detail.value || '';
    this.setData({ keyword });
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.search(keyword), 80);
  },

  onConfirm(event) {
    const keyword = event.detail.value || this.data.keyword;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.search(keyword);
  },

  search(keyword) {
    const query = compactText(keyword);
    if (!query) {
      this.filtered = this.questions;
    } else {
      const exact = [];
      const fuzzy = [];
      this.questions.forEach(item => {
        if (item._searchText.includes(query)) exact.push(item);
        else if (query.length >= 2 && fuzzyContains(item._searchText, query)) fuzzy.push(item);
      });
      this.filtered = exact.concat(fuzzy);
    }
    this.renderResults(true);
  },

  renderResults(reset = true) {
    this.loadedCount = reset ? 80 : this.loadedCount;
    const results = this.filtered.slice(0, this.loadedCount).map(item => {
      const clone = { ...item };
      delete clone._searchText;
      return clone;
    });
    this.setData({
      results,
      total: this.filtered.length,
      hasMore: results.length < this.filtered.length
    });
  },

  loadMore() {
    this.loadedCount += 80;
    this.renderResults(false);
  },

  open(event) {
    const questionId = event.currentTarget.dataset.id;
    const question = this.questions.find(item => item.id === questionId);
    if (!question) return;
    const cleanQuestion = { ...question };
    delete cleanQuestion._searchText;
    const session = {
      bankId: this.bankId,
      bankName: bankStorage.getManifest(this.bankId).name,
      mode: 'search',
      questions: [cleanQuestion],
      index: 0,
      answers: {},
      results: {},
      startedAt: Date.now(),
      exam: false,
      durationMinutes: 0
    };
    getApp().globalData.currentSession = session;
    wx.navigateTo({ url: '/pages/practice/practice' });
  }
});
});
__define("pages/mastered/mastered.js", function(require, module, exports){
const bankStorage = require('../../services/bank-storage');
const recordStorage = require('../../services/record-storage');
const { QUESTION_TYPES } = require('../../utils/constants');

Page({
  data: {
    bankId: '',
    bankName: '',
    groups: [],
    query: '',
    total: 0,
    items: [],
    typeOptions: [{ value: 'all', label: '全部题型' }],
    typeIndex: 0,
    categoryOptions: [{ value: 'all', label: '全部分类' }],
    categoryIndex: 0,
    orderOptions: ['最近掌握', '原题库顺序'],
    orderIndex: 0,
    selectionMode: false,
    selectedCount: 0
  },

  onLoad(query) {
    this.setData({ bankId: query.bankId || '' });
    if (query.bankId) {
      const manifest = bankStorage.getManifest(query.bankId);
      this.setData({ bankName: manifest ? manifest.name : '已掌握题目' });
      wx.setNavigationBarTitle({ title: manifest ? manifest.name : '已掌握题目' });
    }
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    if (!this.data.bankId) {
      const groups = bankStorage.listBanks().map(bank => ({
        id: bank.id,
        name: bank.name,
        count: recordStorage.getMasteredIds(bank.id).length
      })).filter(item => item.count > 0);
      this.setData({ groups });
      return;
    }

    const bankId = this.data.bankId;
    const records = recordStorage.getMastered(bankId);
    const ids = new Set(Object.keys(records));
    let questions = [];
    try { questions = bankStorage.loadQuestions(bankId); } catch (error) {
      wx.showModal({ title: '读取失败', content: error.message || String(error), showCancel: false });
      return;
    }
    const rows = questions.map((question, sourceIndex) => ({ question, sourceIndex }))
      .filter(entry => ids.has(entry.question.id))
      .map(({ question, sourceIndex }) => ({
        rowKey: `${bankId}:${question.id}`,
        bankId,
        questionId: question.id,
        typeLabel: question.displayTypeLabel || QUESTION_TYPES[question.type] || question.type,
        category: question.category || '未分类',
        question: question.question,
        masteredAt: Number(records[question.id] && records[question.id].masteredAt || 0),
        sourceOrder: Number(question.order) > 0 ? Number(question.order) : sourceIndex + 1,
        selected: false
      }));
    const typeLabels = Array.from(new Set(rows.map(item => item.typeLabel).filter(Boolean)));
    const categories = Array.from(new Set(rows.map(item => item.category).filter(Boolean)));
    this.allItems = rows;
    this.setData({
      typeOptions: [{ value: 'all', label: '全部题型' }, ...typeLabels.map(value => ({ value, label: value }))],
      categoryOptions: [{ value: 'all', label: '全部分类' }, ...categories.map(value => ({ value, label: value }))],
      typeIndex: Math.min(this.data.typeIndex, typeLabels.length),
      categoryIndex: Math.min(this.data.categoryIndex, categories.length),
      selectionMode: false,
      selectedCount: 0
    });
    this.applyFilter();
  },

  openBank(event) {
    wx.navigateTo({ url: `/pages/mastered/mastered?bankId=${encodeURIComponent(event.currentTarget.dataset.id)}` });
  },

  onSearch(event) {
    this.setData({ query: event.detail.value || '' });
    this.applyFilter();
  },

  onTypeChange(event) {
    this.setData({ typeIndex: Number(event.detail.value) });
    this.applyFilter();
  },

  onCategoryChange(event) {
    this.setData({ categoryIndex: Number(event.detail.value) });
    this.applyFilter();
  },

  onOrderChange(event) {
    this.setData({ orderIndex: Number(event.detail.value) });
    this.applyFilter();
  },

  applyFilter() {
    const keyword = String(this.data.query || '').trim().toLowerCase();
    const type = (this.data.typeOptions[this.data.typeIndex] || {}).value || 'all';
    const category = (this.data.categoryOptions[this.data.categoryIndex] || {}).value || 'all';
    let items = (this.allItems || []).filter(item => {
      if (type !== 'all' && item.typeLabel !== type) return false;
      if (category !== 'all' && item.category !== category) return false;
      return !keyword || `${item.typeLabel} ${item.category} ${item.question}`.toLowerCase().includes(keyword);
    });
    items = items.slice().sort(this.data.orderIndex === 1
      ? (a, b) => a.sourceOrder - b.sourceOrder
      : (a, b) => b.masteredAt - a.masteredAt || a.sourceOrder - b.sourceOrder);
    this.setData({ items, total: (this.allItems || []).length, selectedCount: items.filter(item => item.selected).length });
  },

  toggleSelectionMode() {
    const enabled = !this.data.selectionMode;
    (this.allItems || []).forEach(item => { item.selected = false; });
    this.setData({ selectionMode: enabled, selectedCount: 0 });
    this.applyFilter();
  },

  toggleSelect(event) {
    if (!this.data.selectionMode) return;
    const id = event.currentTarget.dataset.id;
    const item = (this.allItems || []).find(row => row.questionId === id);
    if (!item) return;
    item.selected = !item.selected;
    this.applyFilter();
  },

  selectAllVisible() {
    const visible = new Set((this.data.items || []).map(item => item.questionId));
    const shouldSelect = !(this.data.items || []).length || !(this.data.items || []).every(item => item.selected);
    (this.allItems || []).forEach(item => { if (visible.has(item.questionId)) item.selected = shouldSelect; });
    this.applyFilter();
  },

  remove(event) {
    const questionId = event.currentTarget.dataset.id;
    this.confirmRemove([questionId]);
  },

  removeSelected() {
    const ids = (this.allItems || []).filter(item => item.selected).map(item => item.questionId);
    if (!ids.length) {
      wx.showToast({ title: '请先选择题目', icon: 'none' });
      return;
    }
    this.confirmRemove(ids);
  },

  confirmRemove(ids) {
    wx.showModal({
      title: ids.length > 1 ? `移出 ${ids.length} 道题` : '移出已掌握',
      content: '移出后，题目会重新出现在普通练习和背题中，原练习进度不会被删除。',
      confirmText: '确认移出',
      success: result => {
        if (!result.confirm) return;
        ids.forEach(questionId => recordStorage.removeMastered(this.data.bankId, questionId));
        wx.showToast({ title: `已恢复 ${ids.length} 道`, icon: 'none' });
        this.refresh();
      }
    });
  }
});
});
__define("pages/settings/settings.js", function(require, module, exports){
const recordStorage = require('../../services/record-storage');
const bankStorage = require('../../services/bank-storage');
const { formatBytes } = require('../../utils/text');

Page({
  data: {
    settings: {
      appearanceMode: 'system',
      amoledBlack: false,
      monetTheme: 'ocean',
      fontScale: 1,
      answerBottomLift: 48,
      autoNext: false,
      autoNextDelay: 500,
      immersivePractice: true,
      shuffleOptions: false,
      resetWrongOnRestart: true
    },
    appearanceOptions: [
      { value: 'system', label: '跟随系统', icon: '◐' },
      { value: 'light', label: '浅色', icon: '☀' },
      { value: 'dark', label: '深色', icon: '☾' }
    ],
    themeOptions: [
      { value: 'ocean', label: '湖海蓝' },
      { value: 'violet', label: '鸢尾紫' },
      { value: 'mint', label: '薄荷绿' },
      { value: 'rose', label: '雾粉' },
      { value: 'amber', label: '暖金' }
    ],
    delayOptions: [500, 1000, 2000, 3000, 5000],
    delayLabels: ['0.5秒', '1秒', '2秒', '3秒', '5秒'],
    delayIndex: 0,
    optionOrderOptions: [false, true],
    optionOrderLabels: ['固定', '打乱'],
    optionOrderIndex: 0,
    storage: {
      bankText: '0 B',
      recordText: '0 B',
      importText: '0 B',
      pickedCacheText: '0 B',
      exportText: '0 B',
      backupText: '0 B',
      unusedText: '0 B',
      totalText: '0 B'
    }
  },

  onLoad() {
    const settings = recordStorage.getSettings();
    const delayIndex = Math.max(0, this.data.delayOptions.indexOf(Number(settings.autoNextDelay)));
    const optionOrderIndex = settings.shuffleOptions ? 1 : 0;
    this.setData({ settings, delayIndex, optionOrderIndex });
  },

  onShow() {
    this.refreshStorage();
  },

  refreshStorage() {
    const summary = bankStorage.getStorageSummary();
    this.setData({
      storage: {
        bankText: formatBytes(summary.bankBytes),
        recordText: formatBytes(summary.recordBytes),
        importText: formatBytes(summary.importBytes),
        pickedCacheText: formatBytes(summary.pickedCacheBytes || 0),
        exportText: formatBytes(summary.exportBytes),
        backupText: formatBytes(summary.backupBytes),
        unusedText: formatBytes(summary.reclaimableBytes || 0),
        totalText: formatBytes(summary.bankBytes + summary.recordBytes + summary.importBytes + summary.exportBytes + summary.backupBytes)
      }
    });
  },


  onAppearancePick(event) {
    const value = String(event.currentTarget.dataset.value || 'system');
    if (!['system', 'light', 'dark'].includes(value)) return;
    this.setData({ 'settings.appearanceMode': value });
    this.save();
    if (typeof window.__applyAppTheme === 'function') window.__applyAppTheme();
  },

  onAmoledChange(event) {
    this.setData({ 'settings.amoledBlack': Boolean(event.detail.value) });
    this.save();
    if (typeof window.__applyAppTheme === 'function') window.__applyAppTheme();
  },

  onThemePick(event) {
    const value = String(event.currentTarget.dataset.value || 'ocean');
    if (!['ocean', 'violet', 'mint', 'rose', 'amber'].includes(value)) return;
    this.setData({ 'settings.monetTheme': value });
    this.save();
    if (typeof window.__applyAppTheme === 'function') window.__applyAppTheme();
  },

  onFontChange(event) {
    const value = Number(event.detail.value);
    this.setData({ 'settings.fontScale': value });
    this.save();
  },

  onAnswerBottomLiftChange(event) {
    const value = Math.max(0, Math.min(120, Number(event.detail.value) || 0));
    this.setData({ 'settings.answerBottomLift': value });
    this.save();
  },

  onAutoNext(event) {
    this.setData({ 'settings.autoNext': event.detail.value });
    this.save();
  },

  onImmersiveChange(event) {
    this.setData({ 'settings.immersivePractice': Boolean(event.detail.value) });
    this.save();
    if (typeof window.__syncPracticeChrome === 'function') window.__syncPracticeChrome();
  },

  onDelayChange(event) {
    const delayIndex = Number(event.detail.value);
    this.setData({
      delayIndex,
      'settings.autoNextDelay': this.data.delayOptions[delayIndex]
    });
    this.save();
  },

  onOptionOrderChange(event) {
    const optionOrderIndex = Number(event.detail.value) === 1 ? 1 : 0;
    this.setData({
      optionOrderIndex,
      'settings.shuffleOptions': Boolean(this.data.optionOrderOptions[optionOrderIndex])
    });
    this.save();
    wx.showToast({ title: optionOrderIndex ? '选项将智能打乱' : '选项保持原顺序', icon: 'none' });
  },

  onResetWrongChange(event) {
    this.setData({ 'settings.resetWrongOnRestart': Boolean(event.detail.value) });
    this.save();
    wx.showToast({
      title: event.detail.value ? '从头练习时重置错题' : '错题将持续累计',
      icon: 'none'
    });
  },

  onLocalAIChange(event) {
    this.setData({ 'settings.useLocalAI': Boolean(event.detail.value) });
    this.save();
    wx.showToast({
      title: event.detail.value ? '本地AI已开启' : '本地AI已关闭',
      icon: 'none'
    });
  },

  save() {
    recordStorage.saveSettings(this.data.settings);
  },

  cleanUnused() {
    wx.showModal({
      title: '智能清理无用文件',
      content: `当前预计可释放 ${this.data.storage.unusedText}。将清理系统文件选择缓存、解析工作副本、旧版原文件副本、未被题目引用的图片、失败或中断留下的临时目录，以及已删除题库的残留记录；不会删除有效题目、正在使用的图片、学习记录、导出题库或完整备份。`,
      confirmText: '开始清理',
      success: res => {
        if (!res.confirm) return;
        wx.showLoading({ title: '正在深度清理', mask: true });
        setTimeout(() => {
          try {
            const result = bankStorage.cleanupUnusedFiles();
            wx.hideLoading();
            const recovered = result.recoveredBankCount ? `，恢复 ${result.recoveredBankCount} 个索引` : '';
            wx.showToast({ title: `已释放${formatBytes(result.freedBytes)}${recovered}`, icon: 'none', duration: 2200 });
            this.refreshStorage();
          } catch (error) {
            wx.hideLoading();
            wx.showModal({ title: '清理失败', content: error.message || String(error), showCancel: false });
          }
        }, 30);
      }
    });
  },

  cleanTemporary() { this.cleanUnused(); },

  cleanExports() {
    wx.showModal({
      title: '清理本地导出副本',
      content: `当前导出副本占用 ${this.data.storage.exportText}。已发送到文件传输助手的文件不受影响。`,
      success: res => {
        if (!res.confirm) return;
        const freed = bankStorage.cleanupExportFiles();
        wx.showToast({ title: `已释放${formatBytes(freed)}`, icon: 'none' });
        this.refreshStorage();
      }
    });
  },

  goBanks() {
    wx.navigateTo({ url: '/pages/banks/banks' });
  },

  cleanBackups() {
    wx.showModal({
      title: '清理完整备份文件',
      content: `当前完整备份占用 ${this.data.storage.backupText}。请确认已经把需要保留的备份发送到外部文件夹。`,
      success: res => {
        if (!res.confirm) return;
        const freed = bankStorage.cleanupBackupFiles();
        wx.showToast({ title: `已释放${formatBytes(freed)}`, icon: 'none' });
        this.refreshStorage();
      }
    });
  },


  createBackup() {
    wx.showLoading({ title: '正在生成完整备份', mask: true });
    setTimeout(() => {
      try {
        const path = bankStorage.createFullBackup();
        wx.hideLoading();
        wx.shareFileMessage({
          filePath: path,
          fail: error => wx.showModal({ title: '备份已生成', content: `文件已保存在本机：${path}\n${error && error.message ? error.message : ''}`, showCancel: false })
        });
      } catch (error) {
        wx.hideLoading();
        wx.showModal({ title: '备份失败', content: error.message || String(error), showCancel: false });
      }
    }, 30);
  },

  async restoreBackup() {
    const importer = require('../../services/docx-importer');
    let file = null;
    const release = () => {
      importer.releasePickedFile(file);
      file = null;
    };
    try {
      file = await importer.chooseFile();
      if (!/\.buaiquiz$/i.test(file.name || '')) throw new Error('请选择 .buaiquiz 完整备份文件');
      wx.showModal({
        title: '恢复完整备份',
        content: '恢复会替换当前全部题库、错题、收藏、进度、统计和设置。建议先备份当前数据。确定继续吗？',
        confirmText: '替换并恢复',
        confirmColor: '#b42318',
        success: result => {
          if (!result.confirm) { release(); return; }
          wx.showLoading({ title: '正在恢复', mask: true });
          setTimeout(() => {
            try {
              const summary = bankStorage.restoreFullBackup(file.path, true);
              wx.hideLoading();
              wx.showModal({ title: '恢复完成', content: `已恢复 ${summary.bankCount} 个题库。应用将刷新首页。`, showCancel: false, success: () => wx.reLaunch({ url: '/pages/home/home' }) });
            } catch (error) {
              wx.hideLoading();
              wx.showModal({ title: '恢复失败', content: error.message || String(error), showCancel: false });
            } finally {
              release();
            }
          }, 30);
        }
      });
    } catch (error) {
      release();
      if (!/cancel/i.test(error.message || error.errMsg || '')) wx.showModal({ title: '选择失败', content: error.message || String(error), showCancel: false });
    }
  },
  clearRecords() {
    wx.showModal({
      title: '清除学习记录',
      content: '将删除错题、收藏、练习进度和统计，但不会删除题库文件。确定继续吗？',
      confirmColor: '#b42318',
      success: res => {
        if (!res.confirm) return;
        recordStorage.clearLearningRecords();
        wx.showToast({ title: '已清除', icon: 'success' });
      }
    });
  },


  goAbout() {
    wx.navigateTo({ url: '/pages/about/about' });
  }
});
});
__define("pages/statistics/statistics.js", function(require, module, exports){
const statisticsService = require('../../services/statistics-service');
const recordStorage = require('../../services/record-storage');

Page({
  data: { summary: {}, recentDays: [], byBank: [], byType: [], byDifficulty: [], weakCategories: [] },
  onShow() {
    const stats = recordStorage.getStats();
    const recentDays = Object.keys(stats.studyDays || {}).sort().reverse().slice(0, 7).map(day => ({ day, count: stats.studyDays[day] }));
    const details = statisticsService.detailed();
    const weakCategories = details.categories.slice().sort((a, b) => a.accuracy - b.accuracy || b.answered - a.answered).slice(0, 8);
    this.setData({ summary: statisticsService.summary(), recentDays, byBank: details.banks, byType: details.types, byDifficulty: details.difficulties, weakCategories });
  }
});
});
__define("pages/wrong/wrong.js", function(require, module, exports){
const bankStorage = require('../../services/bank-storage');
const recordStorage = require('../../services/record-storage');

Page({
  data: {
    groups: []
  },

  onShow() {
    const groups = bankStorage.listBanks().map(bank => {
      const wrong = recordStorage.getWrong(bank.id);
      const count = Object.values(wrong).filter(item => !item.mastered).length;
      return { id: bank.id, name: bank.name, count };
    }).filter(item => item.count > 0);
    this.setData({ groups });
  },

  start(event) {
    const bankId = event.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/practice-config/practice-config?bankId=${bankId}&mode=wrong`
    });
  }
});
});
