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
