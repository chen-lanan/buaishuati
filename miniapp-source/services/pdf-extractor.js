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
