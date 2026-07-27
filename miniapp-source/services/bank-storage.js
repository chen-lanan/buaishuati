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
