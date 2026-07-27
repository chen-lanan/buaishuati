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
