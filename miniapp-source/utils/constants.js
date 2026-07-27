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
