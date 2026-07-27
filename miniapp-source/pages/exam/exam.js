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
