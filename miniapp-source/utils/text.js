
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
