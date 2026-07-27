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
