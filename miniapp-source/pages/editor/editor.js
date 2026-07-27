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
