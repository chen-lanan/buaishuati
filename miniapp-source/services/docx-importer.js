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
