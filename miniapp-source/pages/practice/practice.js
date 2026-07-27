const bankStorage = require('../../services/bank-storage');
const recordStorage = require('../../services/record-storage');
const practiceService = require('../../services/practice-service');
const { QUESTION_TYPES } = require('../../utils/constants');

const SHEET_TYPE_CLASS_ORDER = [
  'sheet-type-single', 'sheet-type-multiple', 'sheet-type-judge', 'sheet-type-fill',
  'sheet-type-short', 'sheet-type-calc', 'sheet-type-drawing', 'sheet-type-other-0',
  'sheet-type-other-1', 'sheet-type-other-2'
];
function sheetTypeLabel(question) {
  const base = String(question && (question.displayTypeLabel || QUESTION_TYPES[question.type] || question.type) || '未知题型').trim();
  return question && (question.status || 'normal') !== 'normal' && !/^异常/.test(base) ? `异常${base}` : base;
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
    question: null,
    displayOptions: [],
    selected: [],
    submitted: false,
    showAnswer: false,
    result: null,
    favorite: false,
    mastered: false,
    progressText: '',
    progressRatio: 0,
    typeLabel: '',
    isAbnormal: false,
    difficulty: '',
    typeChipClass: 'chip-tone-blue',
    difficultyChipClass: 'chip-tone-amber',
    sheetChipClass: 'chip-tone-violet',
    editChipClass: 'chip-tone-rose',
    fontScale: 1,
    answerBottomLift: 48,
    memorizeMode: false,
    autoNextHint: '',
    answerDisplay: '',
    answerDetail: '',
    isFirst: true,
    isLast: false,
    questionBlockStyle: '',
    optionsStyle: '',
    answerPanelStyle: '',
    analysisStyle: '',
    layoutClass: 'choice-layout',
    showQuestionSheet: false,
    questionSheetItems: [],
    sheetCorrectCount: 0,
    sheetWrongCount: 0,
    sheetUnansweredCount: 0,
    sheetTotalCount: 0,
    sheetFilteredCount: 0,
    sheetStatusFilter: 'all',
    sheetTypeFilter: 'all',
    sheetTypeItems: [],
    sheetHasFilter: false,
    sheetCurrentExcluded: false
  },

  onLoad() {
    const session = getApp().globalData.currentSession;
    if (!session || !session.questions.length) {
      wx.showModal({
        title: '练习已失效',
        content: '请重新选择题库。',
        showCancel: false,
        success: () => wx.navigateBack()
      });
      return;
    }
    this.session = session;
    this.topChipClasses = buildTopChipClasses([
      session.bankId || '',
      session.mode || 'practice',
      session.memorizeOrder || '',
      session.practiceType || 'all'
    ].join('|'));
    this.pageVisible = true;
    this.layoutResizeHandler = () => this.scheduleMeasuredLayout();
    window.addEventListener('resize', this.layoutResizeHandler, { passive: true });
    // 使用不会随 setData 重建而销毁的 document 级手势监听。快速连续滑动时，
    // 每个有效手势都会进入队列，不再被旧版 380ms 锁直接丢弃。
    this.globalSwipeStart = event => {
      const target = event && event.target;
      if (!target || !target.closest || !target.closest('.question-viewport')) return;
      this.onTouchStart(event);
    };
    this.globalSwipeEnd = event => {
      if (this.swipeStart) this.onTouchEnd(event);
    };
    document.addEventListener('touchstart', this.globalSwipeStart, { passive: true, capture: true });
    document.addEventListener('touchend', this.globalSwipeEnd, { passive: true, capture: true });
    const settings = recordStorage.getSettings();
    this.settings = settings;
    this.setData({
      fontScale: settings.fontScale || 1,
      answerBottomLift: Math.max(0, Math.min(120, Number(settings.answerBottomLift) || 48)),
      memorizeMode: Boolean(session.memorize)
    });

    // Android 按 Home、切换应用、锁屏或系统直接回收 WebView 时，不一定触发页面 onUnload。
    // 因此除了每次换题立即保存，还监听后台/关闭事件作为最后一道保险。
    this.persistOnVisibilityChange = () => {
      if (document.visibilityState === 'hidden') this.persistProgress('visibility-hidden', true);
    };
    this.persistOnPageHide = () => this.persistProgress('page-hide', true);
    this.persistOnBeforeUnload = () => this.persistProgress('before-unload', true);
    document.addEventListener('visibilitychange', this.persistOnVisibilityChange, { passive: true });
    window.addEventListener('pagehide', this.persistOnPageHide, { passive: true });
    window.addEventListener('beforeunload', this.persistOnBeforeUnload);

    this.renderQuestion();
  },

  onShow() {
    this.pageVisible = true;
    this.applyLatestSettings();
    if (!this.pendingQuestionEdit) return;
    this.pendingQuestionEdit = false;
    this.refreshEditedQuestion();
  },

  applyLatestSettings() {
    const latest = recordStorage.getSettings();
    const previous = this.settings || latest;
    const shuffleChanged = Boolean(previous.shuffleOptions) !== Boolean(latest.shuffleOptions);
    this.settings = latest;
    this.setData({
      fontScale: Number(latest.fontScale) || 1,
      answerBottomLift: Math.max(0, Math.min(120, Number(latest.answerBottomLift) || 48))
    }, () => {
      if (typeof requestAnimationFrame === 'function') this.scheduleMeasuredLayout();
    });

    // 设置页可从任意界面打开。返回练习页后，未作答题目的选项顺序立即按新设置更新；
    // 已经选择或提交过的题保持原样，避免答案键位被重排。背题模式始终使用原题库选项顺序。
    if (shuffleChanged && this.session && !this.session.exam && !this.session.memorize) {
      this.session.questions = practiceService.applyOptionOrderPreference(
        this.session.questions,
        Boolean(latest.shuffleOptions),
        this.session.answers,
        this.session.results
      );
      this.session.optionShuffleEnabled = Boolean(latest.shuffleOptions);
      getApp().globalData.currentSession = this.session;
      this.renderQuestion();
    }
  },

  onHide() {
    this.pageVisible = false;
    this.clearAutoNext();
    this.persistProgress('page-hide-lifecycle', true);
  },

  onUnload() {
    this.persistProgress('page-unload', true);
    this.clearAutoNext();
    this.cleanupMeasuredLayout();
    if (this.persistOnVisibilityChange) document.removeEventListener('visibilitychange', this.persistOnVisibilityChange);
    if (this.persistOnPageHide) window.removeEventListener('pagehide', this.persistOnPageHide);
    if (this.persistOnBeforeUnload) window.removeEventListener('beforeunload', this.persistOnBeforeUnload);
    this.persistOnVisibilityChange = null;
    this.persistOnPageHide = null;
    this.persistOnBeforeUnload = null;
  },

  persistProgress(reason = '', force = false) {
    const session = this.session;
    if (!session || session.exam) return false;

    // 顺序背题和随机背题分别保存位置。随机背题额外保存本次随机序列，返回后继续同一顺序。
    if (session.mode === 'memorize') {
      if (!session.questions.length) return false;
      const question = session.questions[session.index] || session.questions[0];
      if (!question) return false;
      const existing = recordStorage.getMemorizeProgress(session.bankId) || {};
      const memorizeOrder = session.memorizeOrder === 'random' ? 'random' : 'sequence';
      const scopeKey = session.memorizeScopeKey
        || practiceService.buildMemorizeScopeKey(memorizeOrder, session.practiceType, session.requestedCount);
      const cursor = {
        questionId: question.id || '',
        questionKey: practiceService.buildQuestionProgressKey(question),
        questionOrder: Number.isFinite(Number(question.order)) ? Number(question.order) : 0,
        index: session.index,
        updatedAt: Date.now()
      };
      const cursors = Object.assign({}, existing.cursors || {}, { [scopeKey]: cursor });
      const randomSequences = Object.assign({}, existing.randomSequences || {});
      if (memorizeOrder === 'random') {
        randomSequences[scopeKey] = practiceService.buildMemorizeQuestionSequence(session.questions);
      }
      const signature = [scopeKey, cursor.questionId, cursor.questionOrder, cursor.index, session.questions.length].join('|');
      if (!force && signature === this.lastMemorizeProgressSignature) return true;
      const saved = recordStorage.saveMemorizeProgress(session.bankId, {
        ...existing,
        mode: 'memorize',
        memorizeOrder,
        type: session.practiceType || 'all',
        requestedCount: Number(session.requestedCount || 0),
        cursor,
        cursors,
        randomSequences,
        reason
      });
      if (saved) this.lastMemorizeProgressSignature = signature;
      return saved;
    }

    // 顺序练习的进度只由已经完成作答的题目决定，随意浏览不会制造虚假进度。
    if (session.mode !== 'sequence' || this.progressCompleted) return false;
    const existing = recordStorage.getProgress(session.bankId) || {};
    const questionStates = practiceService.mergePersistedQuestionStates(
      existing.questionStates,
      practiceService.buildPersistedQuestionStates(session),
      session.questions
    );
    session.lastCompletedOrder = Math.max(
      Number(session.lastCompletedOrder || 0),
      practiceService.getFurthestCompletedOrder(session.questions, session.results)
    );

    // 只打开页面、随意翻题且没有任何作答时，不创建虚假的“继续进度”。
    if (!questionStates.length && session.lastCompletedOrder <= 0) return false;

    const targetIndex = practiceService.findResumeIndexAfterCompletion(
      session.questions,
      session.results,
      session.lastCompletedOrder
    );
    const target = session.questions[targetIndex] || session.questions[0];
    if (!target) return false;
    const completedAll = session.questions.every(question =>
      practiceService.getQuestionAnswerStatus(question, session.results[question.id]) !== 'unanswered'
    );
    const scopeKey = session.progressScopeKey
      || practiceService.buildPracticeScopeKey(session.practiceType, session.requestedCount);
    const cursor = {
      lastCompletedOrder: Number(session.lastCompletedOrder || 0),
      questionId: target.id || '',
      questionKey: practiceService.buildQuestionProgressKey(target),
      questionOrder: Number.isFinite(Number(target.order)) ? Number(target.order) : 0,
      index: targetIndex,
      completedAll,
      updatedAt: Date.now()
    };
    const cursors = Object.assign({}, existing.cursors || {}, { [scopeKey]: cursor });
    const progress = {
      index: cursor.index,
      questionId: cursor.questionId,
      questionKey: cursor.questionKey,
      questionOrder: cursor.questionOrder,
      lastCompletedOrder: cursor.lastCompletedOrder,
      completedAll,
      mode: 'sequence',
      type: session.practiceType || 'all',
      requestedCount: Number(session.requestedCount || 0),
      sessionQuestionCount: session.questions.length,
      cursors,
      questionStates,
      reason
    };
    const signature = [
      scopeKey, cursor.questionId, cursor.questionOrder, cursor.lastCompletedOrder,
      questionStates.length, completedAll ? 1 : 0
    ].join('|');
    if (!force && signature === this.lastProgressSignature) return true;
    const saved = recordStorage.saveProgress(session.bankId, progress);
    if (saved) this.lastProgressSignature = signature;
    return saved;
  },

  markQuestionCompleted(question) {
    if (!this.session || !question) return;
    const order = Number(question.order);
    const stableOrder = Number.isFinite(order) && order > 0
      ? order
      : this.session.index + 1;
    this.session.lastCompletedOrder = Math.max(
      Number(this.session.lastCompletedOrder || 0),
      stableOrder
    );
  },

  clearAutoNext() {
    if (this.autoNextTimer) {
      clearTimeout(this.autoNextTimer);
      this.autoNextTimer = null;
    }
    if (this.data.autoNextHint) this.setData({ autoNextHint: '' });
  },

  decorateOptions(question, selected, revealCorrect) {
    const isGenericVisualText = value => /^(?:图|图形|图片|图示|示意图|符号图|见图|如下图)$/i.test(
      String(value || '').replace(/[\s()（）\[\]【】<>《》.。:：、，,;；]/g, '')
    );
    return (question.options || []).map(item => {
      let stateClass = selected.includes(item.key) ? 'selected' : '';
      if (revealCorrect && (question.answer || []).includes(item.key)) stateClass = 'correct';
      if (revealCorrect && selected.includes(item.key) && !(question.answer || []).includes(item.key)) stateClass = 'wrong';
      const hasImages = Array.isArray(item.images) && item.images.length > 0;
      return { ...item, stateClass, hasImages, visualOnly: hasImages && isGenericVisualText(item.text) };
    });
  },

  getAnswerDetail(question) {
    if (question.type === 'short') {
      if (question.answerText) return question.answerText;
      if (Array.isArray(question.answerImages) && question.answerImages.length) return '';
      return '未提供参考答案';
    }
    const keys = (question.answer || []).filter(Boolean);
    return keys.length ? keys.join('、') : '未提供正确答案';
  },

  buildAdaptiveLayout(question, showAnswer, memorizeMode) {
    const isShort = question && question.type === 'short';
    return {
      questionBlockStyle: '',
      optionsStyle: '',
      answerPanelStyle: '',
      analysisStyle: '',
      layoutClass: `${isShort ? 'short-layout' : 'choice-layout'} ${showAnswer ? 'answer-visible' : 'answer-hidden'} ${memorizeMode ? 'memorize-layout' : ''}`
    };
  },

  onAfterRender() {
    // setData 会重建 WebView DOM。同步测量并写入最终高度，保证在下一帧绘制前
    // 布局已经稳定，避免仅切换选中状态时题干和选项上下抖动。
    this.applyMeasuredLayout();
  },

  cleanupMeasuredLayout() {
    if (this.layoutTimer) clearTimeout(this.layoutTimer);
    this.layoutTimer = null;
    if (this.layoutFrame) cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = null;
    if (this.layoutObserver) this.layoutObserver.disconnect();
    this.layoutObserver = null;
    this.observedLayoutCard = null;
    if (this.layoutResizeHandler) window.removeEventListener('resize', this.layoutResizeHandler);
    this.layoutResizeHandler = null;
    if (this.globalSwipeStart) document.removeEventListener('touchstart', this.globalSwipeStart, true);
    if (this.globalSwipeEnd) document.removeEventListener('touchend', this.globalSwipeEnd, true);
    this.globalSwipeStart = null;
    this.globalSwipeEnd = null;
    this.pendingSwipes = [];
  },

  scheduleMeasuredLayout() {
    if (this.layoutTimer) clearTimeout(this.layoutTimer);
    if (this.layoutFrame) cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = requestAnimationFrame(() => {
      this.layoutFrame = requestAnimationFrame(() => {
        this.layoutFrame = null;
        this.applyMeasuredLayout();
      });
    });
    this.layoutTimer = setTimeout(() => {
      this.layoutTimer = null;
      this.applyMeasuredLayout();
    }, 90);
  },

  allocateMeasuredSections(sections, available) {
    const result = {};
    const usable = Math.max(0, available);
    if (!sections.length) return result;
    const desiredTotal = sections.reduce((sum, item) => sum + item.desired, 0);
    if (desiredTotal <= usable) {
      sections.forEach(item => { result[item.key] = item.desired; });
      return result;
    }
    let minimumTotal = sections.reduce((sum, item) => sum + item.min, 0);
    if (minimumTotal > usable) {
      const ratio = usable / Math.max(1, minimumTotal);
      sections.forEach(item => { result[item.key] = Math.max(42, Math.floor(item.min * ratio)); });
      return result;
    }
    sections.forEach(item => { result[item.key] = item.min; });
    let remaining = usable - minimumTotal;
    let pending = sections.filter(item => item.desired > item.min + 1);
    while (remaining > 1 && pending.length) {
      const totalWeight = pending.reduce((sum, item) => sum + Math.max(1, (item.desired - result[item.key])) * item.weight, 0);
      if (!totalWeight) break;
      let used = 0;
      pending.forEach(item => {
        const need = Math.max(0, item.desired - result[item.key]);
        if (!need) return;
        const share = remaining * (need * item.weight) / totalWeight;
        const add = Math.min(need, Math.max(1, Math.floor(share)));
        result[item.key] += add;
        used += add;
      });
      if (!used) break;
      remaining -= used;
      pending = pending.filter(item => result[item.key] < item.desired - 1);
    }
    return result;
  },

  applyMeasuredLayout() {
    const root = document.querySelector('#page-root[data-page="pages/practice/practice"]');
    if (!root || !this.data.question) return;
    const card = root.querySelector('.question-card');
    if (!card || card.clientHeight < 120) return;

    if (window.ResizeObserver && this.observedLayoutCard !== card) {
      if (this.layoutObserver) this.layoutObserver.disconnect();
      this.observedLayoutCard = card;
      let previousWidth = card.clientWidth;
      let previousHeight = card.clientHeight;
      this.layoutObserver = new ResizeObserver(entries => {
        const entry = entries && entries[0];
        if (!entry) return;
        const width = Math.round(entry.contentRect.width);
        const height = Math.round(entry.contentRect.height);
        if (Math.abs(width - previousWidth) > 1 || Math.abs(height - previousHeight) > 1) {
          previousWidth = width;
          previousHeight = height;
          this.scheduleMeasuredLayout();
        }
      });
      this.layoutObserver.observe(card);
    }

    root.querySelectorAll('.question-image, .option-image, .answer-image, .analysis-image').forEach(image => {
      if (image.dataset.layoutBound) return;
      image.dataset.layoutBound = '1';
      image.addEventListener('load', () => this.scheduleMeasuredLayout(), { once: true });
    });

    const question = card.querySelector('.question-block');
    const options = card.querySelector('.options');
    const shortArea = card.querySelector('.short-area');
    const resultZone = card.querySelector('.result-zone');
    const answer = card.querySelector('.answer-panel');
    const analysis = card.querySelector('.analysis');
    const variableElements = [question, options, answer, analysis].filter(Boolean);

    const clearSection = element => {
      element.style.setProperty('height', 'auto', 'important');
      element.style.setProperty('max-height', 'none', 'important');
      element.style.setProperty('min-height', '0', 'important');
      element.style.setProperty('flex', '0 0 auto', 'important');
      element.style.setProperty('overflow-y', 'visible', 'important');
    };
    variableElements.forEach(clearSection);
    if (resultZone) {
      resultZone.style.setProperty('height', 'auto', 'important');
      resultZone.style.setProperty('max-height', 'none', 'important');
      resultZone.style.setProperty('min-height', '0', 'important');
      resultZone.style.setProperty('flex', '0 0 auto', 'important');
      resultZone.style.setProperty('overflow', 'visible', 'important');
    }
    card.style.setProperty('justify-content', 'flex-start', 'important');

    // Force a natural-content layout before reading scrollHeight.
    void card.offsetHeight;
    const px = value => Number.parseFloat(value) || 0;
    const naturalHeight = element => {
      if (!element) return 0;
      const rect = element.getBoundingClientRect();
      return Math.ceil(Math.max(element.scrollHeight || 0, rect.height || 0));
    };
    const visible = element => Boolean(element && element.getClientRects().length);
    const cardStyle = getComputedStyle(card);
    const cardInnerHeight = Math.max(0, card.clientHeight - px(cardStyle.paddingTop) - px(cardStyle.paddingBottom));
    const outerChildren = [question, options || shortArea, resultZone].filter(visible);
    const outerGap = px(cardStyle.rowGap || cardStyle.gap);
    const outerGaps = Math.max(0, outerChildren.length - 1) * outerGap;

    let resultFixedHeight = 0;
    let resultGaps = 0;
    let resultDirectChildren = [];
    if (resultZone) {
      const resultStyle = getComputedStyle(resultZone);
      resultDirectChildren = Array.from(resultZone.children).filter(visible);
      const resultGap = px(resultStyle.rowGap || resultStyle.gap);
      resultGaps = Math.max(0, resultDirectChildren.length - 1) * resultGap;
      resultDirectChildren.forEach(child => {
        if (child !== answer && child !== analysis) resultFixedHeight += naturalHeight(child);
      });
    }
    const shortAreaHeight = shortArea && visible(shortArea) ? naturalHeight(shortArea) : 0;
    const availableForVariables = Math.max(0, cardInnerHeight - outerGaps - resultGaps - resultFixedHeight - shortAreaHeight);
    const rpx = Math.max(0.42, Math.min(0.82, window.innerWidth / 750));
    const isShort = this.data.question.type === 'short';
    const sectionData = [];
    if (question) {
      const desired = naturalHeight(question);
      sectionData.push({ key: 'question', element: question, desired, min: desired <= Math.max(145, 250 * rpx) ? desired : Math.min(desired, Math.max(72, 124 * rpx)), weight: 1.15 });
    }
    if (options) {
      const desired = naturalHeight(options);
      sectionData.push({ key: 'options', element: options, desired, min: Math.min(desired, Math.max(105, 220 * rpx)), weight: 1.85 });
    }
    if (answer) {
      const desired = naturalHeight(answer);
      const minimum = isShort ? Math.max(82, 155 * rpx) : Math.max(50, 88 * rpx);
      sectionData.push({ key: 'answer', element: answer, desired, min: Math.min(desired, minimum), weight: isShort ? 2.25 : 0.7 });
    }
    if (analysis) {
      const desired = naturalHeight(analysis);
      sectionData.push({ key: 'analysis', element: analysis, desired, min: Math.min(desired, Math.max(68, 125 * rpx)), weight: 1.35 });
    }
    const allocation = this.allocateMeasuredSections(sectionData, availableForVariables);
    sectionData.forEach(item => {
      const assigned = Math.max(0, Math.floor(allocation[item.key] || item.desired));
      item.element.style.setProperty('height', `${assigned}px`, 'important');
      item.element.style.setProperty('max-height', `${assigned}px`, 'important');
      item.element.style.setProperty('min-height', '0', 'important');
      item.element.style.setProperty('flex', '0 0 auto', 'important');
      item.element.style.setProperty('overflow-y', item.desired > assigned + 2 ? 'auto' : 'hidden', 'important');
      item.element.classList.toggle('section-scrollable', item.desired > assigned + 2);
    });
    if (resultZone) {
      const resultVariableHeight = (answer ? (allocation.answer || naturalHeight(answer)) : 0)
        + (analysis ? (allocation.analysis || naturalHeight(analysis)) : 0);
      const resultHeight = Math.max(0, Math.floor(resultFixedHeight + resultGaps + resultVariableHeight));
      resultZone.style.setProperty('height', `${resultHeight}px`, 'important');
      resultZone.style.setProperty('max-height', `${resultHeight}px`, 'important');
      resultZone.style.setProperty('min-height', '0', 'important');
      resultZone.style.setProperty('overflow', 'hidden', 'important');
    }
  },

  renderQuestion() {
    this.clearAutoNext();
    const session = this.session;
    const question = session.questions[session.index];
    const favorite = recordStorage.isFavorite(session.bankId, question.id);
    const mastered = recordStorage.isMastered(session.bankId, question.id);
    const selected = session.answers[question.id] || [];
    const storedResult = session.results[question.id] || null;
    const memorizeMode = Boolean(session.memorize);
    const submitted = memorizeMode || Boolean(storedResult);
    const showAnswer = memorizeMode || submitted;
    const layout = this.buildAdaptiveLayout(question, showAnswer, memorizeMode);
    const isAbnormal = (question.status || 'normal') !== 'normal';
    const baseTypeLabel = question.displayTypeLabel || QUESTION_TYPES[question.type] || question.type;
    const typeLabel = isAbnormal && !/^异常/.test(String(baseTypeLabel || '')) ? `异常${baseTypeLabel}` : baseTypeLabel;
    const chipClasses = this.topChipClasses || buildTopChipClasses([
      session.bankId || '', session.mode || 'practice', session.memorizeOrder || '', session.practiceType || 'all'
    ].join('|'));
    const totalQuestions = Math.max(1, session.questions.length);
    const progressRatio = session.index >= totalQuestions - 1
      ? 1
      : Math.max(0, Math.min(1, (session.index + 1) / totalQuestions));

    this.setData({
      question,
      displayOptions: this.decorateOptions(question, selected, showAnswer),
      selected,
      submitted,
      showAnswer,
      result: storedResult,
      favorite,
      mastered,
      memorizeMode,
      progressText: `${session.index + 1} / ${session.questions.length}`,
      progressRatio,
      typeLabel,
      isAbnormal,
      difficulty: question.difficulty || '',
      ...chipClasses,
      answerDisplay: (question.answer || []).join('、'),
      answerDetail: this.getAnswerDetail(question),
      isFirst: session.index === 0,
      isLast: session.index === session.questions.length - 1,
      ...layout
    });
    // 每次进入一道题就同步写入本地存储，不再依赖退出页面才保存。
    this.persistProgress('render-question');
  },

  editCurrentQuestion() {
    this.clearAutoNext();
    const session = this.session;
    const current = this.data.question;
    if (!session || !current) return;
    try {
      const stored = bankStorage.loadQuestions(session.bankId).find(item => item.id === current.id) || current;
      this.editQuestionSnapshot = practiceService.buildQuestionEditSignature(stored);
      this.pendingQuestionEdit = true;
      wx.navigateTo({
        url: `/pages/editor/editor?source=bank&bankId=${encodeURIComponent(session.bankId)}&questionId=${encodeURIComponent(current.id)}`
      });
    } catch (error) {
      wx.showModal({ title: '无法编辑题目', content: error.message || String(error), showCancel: false });
    }
  },

  refreshEditedQuestion() {
    const session = this.session;
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
      const previousResult = session.results[previous.id] && typeof session.results[previous.id] === 'object'
        ? { ...session.results[previous.id] } : null;

      session.questions[session.index] = fresh;
      if (answerContentChanged) {
        delete session.answers[previous.id];
        delete session.results[previous.id];
      } else if (fresh.type !== 'short') {
        const remapped = practiceService.remapSelectedOptions(previous, fresh, previousSelected);
        if (remapped.length) session.answers[fresh.id] = remapped;
        else delete session.answers[fresh.id];
        if (previousResult) {
          session.results[fresh.id] = remapped.length
            ? { ...previousResult, correct: practiceService.sameAnswer(fresh.answer || [], remapped) }
            : previousResult;
        }
      }
      this.editQuestionSnapshot = '';
      getApp().globalData.currentSession = session;
      this.renderQuestion();
    } catch (error) {
      this.editQuestionSnapshot = '';
      wx.showModal({ title: '题目刷新失败', content: error.message || String(error), showCancel: false });
    }
  },

  buildQuestionSheet() {
    const session = this.session;
    const items = [];
    const typeMap = new Map();
    let correct = 0;
    let wrong = 0;
    let unanswered = 0;
    (session.questions || []).forEach((question, index) => {
      const status = practiceService.getQuestionAnswerStatus(question, session.results[question.id]);
      if (status === 'correct') correct += 1;
      else if (status === 'wrong') wrong += 1;
      else unanswered += 1;
      const typeLabel = sheetTypeLabel(question);
      const typeClass = sheetTypeClass(question, typeLabel);
      if (!typeMap.has(typeLabel)) typeMap.set(typeLabel, { key: typeLabel, label: typeLabel, typeClass, count: 0 });
      typeMap.get(typeLabel).count += 1;
      items.push({
        number: index + 1,
        index,
        status,
        statusClass: `sheet-${status}`,
        typeKey: typeLabel,
        typeLabel,
        typeClass,
        current: index === session.index,
        longNumber: index + 1 >= 1000
      });
    });
    return { items, correct, wrong, unanswered, types: Array.from(typeMap.values()) };
  },

  applyQuestionSheetFilters(scrollMode = '') {
    const allItems = Array.isArray(this.questionSheetAllItems) ? this.questionSheetAllItems : [];
    const statusFilter = this.data.sheetStatusFilter || 'all';
    const typeFilter = this.data.sheetTypeFilter || 'all';
    const items = allItems.filter(item =>
      (statusFilter === 'all' || item.status === statusFilter)
      && (typeFilter === 'all' || item.typeKey === typeFilter)
    );
    const currentIndex = this.session ? Number(this.session.index) : -1;
    const currentIncluded = items.some(item => item.index === currentIndex);
    this.setData({
      questionSheetItems: items,
      sheetFilteredCount: items.length,
      sheetHasFilter: statusFilter !== 'all' || typeFilter !== 'all',
      sheetCurrentExcluded: items.length > 0 && !currentIncluded
    }, () => {
      if (scrollMode) this.scheduleQuestionSheetScroll(scrollMode);
    });
  },

  scheduleQuestionSheetScroll(mode = 'current') {
    if (this.questionSheetScrollTimer) clearTimeout(this.questionSheetScrollTimer);
    this.questionSheetScrollTimer = setTimeout(() => {
      this.questionSheetScrollTimer = null;
      const run = () => this.scrollQuestionSheet(mode);
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(run));
      else run();
    }, 30);
  },

  scrollQuestionSheet(mode = 'current') {
    if (!this.data.showQuestionSheet || typeof document === 'undefined') return;
    const root = document.querySelector('#page-root[data-page="pages/practice/practice"]') || document;
    const container = root.querySelector('.practice-sheet-scroll');
    if (!container) return;
    let target = null;
    if (mode === 'current' && this.session) {
      target = container.querySelector(`.practice-sheet-number[data-index="${Number(this.session.index)}"]`);
    }
    if (!target) target = container.querySelector('.practice-sheet-number');
    if (!target) {
      container.scrollTop = 0;
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const top = container.scrollTop + targetRect.top - containerRect.top
      - Math.max(0, (containerRect.height - targetRect.height) / 2);
    if (typeof container.scrollTo === 'function') container.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    else container.scrollTop = Math.max(0, top);
  },

  filterQuestionSheetStatus(event) {
    const selected = String(event.currentTarget.dataset.status || 'all');
    const next = selected === this.data.sheetStatusFilter ? 'all' : selected;
    this.setData({ sheetStatusFilter: next }, () => this.applyQuestionSheetFilters('first'));
  },

  filterQuestionSheetType(event) {
    const selected = String(event.currentTarget.dataset.type || 'all');
    const next = selected === this.data.sheetTypeFilter ? 'all' : selected;
    this.setData({ sheetTypeFilter: next }, () => this.applyQuestionSheetFilters('first'));
  },

  clearQuestionSheetFilters() {
    this.setData({ sheetStatusFilter: 'all', sheetTypeFilter: 'all' }, () => this.applyQuestionSheetFilters('current'));
  },

  openQuestionSheet() {
    this.clearAutoNext();
    if (!this.session) return;
    const sheet = this.buildQuestionSheet();
    this.questionSheetAllItems = sheet.items;
    const validType = sheet.types.some(item => item.key === this.data.sheetTypeFilter)
      ? this.data.sheetTypeFilter : 'all';
    this.setData({
      showQuestionSheet: true,
      sheetCorrectCount: sheet.correct,
      sheetWrongCount: sheet.wrong,
      sheetUnansweredCount: sheet.unanswered,
      sheetTotalCount: sheet.items.length,
      sheetTypeItems: sheet.types,
      sheetTypeFilter: validType
    }, () => this.applyQuestionSheetFilters('current'));
  },

  closeQuestionSheet() {
    if (this.questionSheetScrollTimer) clearTimeout(this.questionSheetScrollTimer);
    this.questionSheetScrollTimer = null;
    if (this.data.showQuestionSheet) this.setData({ showQuestionSheet: false });
  },

  noop() {},

  jumpToQuestion(event) {
    const index = Number(event.currentTarget.dataset.index);
    if (!this.session || !Number.isInteger(index) || index < 0 || index >= this.session.questions.length) return;
    this.setData({ showQuestionSheet: false }, () => {
      this.session.index = index;
      this.renderQuestion();
    });
  },

  selectOption(event) {
    if (this.data.submitted || this.data.memorizeMode) return;
    const key = event.currentTarget.dataset.key;
    const question = this.data.question;
    let selected = this.data.selected.slice();

    if (question.type === 'multiple') {
      const index = selected.indexOf(key);
      if (index >= 0) selected.splice(index, 1);
      else selected.push(key);
      // 多选题未提交前的勾选也保存，避免切后台或返回后丢失。
      this.session.answers[question.id] = selected.slice();
      this.persistProgress('multiple-selection', true);
      this.setData({ selected, displayOptions: this.decorateOptions(question, selected, false) });
      return;
    }

    selected = [key];
    // 单选题直接一次性完成选中和提交。旧逻辑会先刷新“选中态”，随后立即再次
    // 刷新“答案态”，一次点击连续重建两遍整页 DOM，是明显闪跳的另一来源。
    this.submit(selected);
  },

  submit(selectedOverride) {
    const selected = Array.isArray(selectedOverride) ? selectedOverride.slice() : this.data.selected.slice();
    if (this.data.submitted || !selected.length || this.data.memorizeMode) return;
    const session = this.session;
    const question = this.data.question;
    const result = practiceService.judgeQuestion(question, selected);
    session.answers[question.id] = selected.slice();
    session.results[question.id] = result;
    this.markQuestionCompleted(question);
    this.persistProgress('answer-submitted', true);

    if (result.correct) {
      if (session.mode === 'wrong') recordStorage.removeWrong(session.bankId, question.id);
      else recordStorage.markCorrect(session.bankId, question.id);
    } else recordStorage.markWrong(session.bankId, question.id);
    recordStorage.recordAnswer(result.correct, { bankId: session.bankId, type: question.type, typeLabel: question.displayTypeLabel || '', difficulty: question.difficulty || '', category: question.category || '' });
    const layout = this.buildAdaptiveLayout(question, true, false);

    this.setData({
      selected,
      submitted: true,
      showAnswer: true,
      result,
      displayOptions: this.decorateOptions(question, selected, true),
      ...layout
    }, () => this.scheduleAutoNext(result));
  },

  scheduleAutoNext(result) {
    if (!result || !result.correct || !this.settings.autoNext || this.data.memorizeMode) return;
    this.clearAutoNext();
    const delay = Number(this.settings.autoNextDelay) || 500;
    const seconds = delay < 1000 ? (delay / 1000).toFixed(1) : String(delay / 1000).replace(/\.0$/, '');
    const scheduledQuestionId = this.data.question && this.data.question.id;
    this.setData({ autoNextHint: `答对了，${seconds} 秒后自动下一题` });
    this.autoNextTimer = setTimeout(() => {
      this.autoNextTimer = null;
      if (!this.pageVisible || this.pendingQuestionEdit || this.data.showQuestionSheet) return;
      if (!this.data.question || this.data.question.id !== scheduledQuestionId) return;
      this.next();
    }, delay);
  },

  showShortAnswer() {
    if (this.data.submitted || this.data.memorizeMode) return;
    const question = this.data.question;
    const result = { correct: false, revealed: true };
    this.session.results[question.id] = result;
    this.persistProgress('short-answer-revealed', true);
    const layout = this.buildAdaptiveLayout(question, true, false);
    this.setData({
      submitted: true,
      showAnswer: true,
      result,
      ...layout
    });
  },

  scoreShort(event) {
    this.clearAutoNext();
    const score = event.currentTarget.dataset.score;
    const session = this.session;
    const question = this.data.question;
    const result = practiceService.judgeQuestion(question, [], score);
    session.results[question.id] = result;
    this.markQuestionCompleted(question);
    this.persistProgress('short-answer-scored', true);
    if (result.correct) {
      if (session.mode === 'wrong') recordStorage.removeWrong(session.bankId, question.id);
      else recordStorage.markCorrect(session.bankId, question.id);
    } else recordStorage.markWrong(session.bankId, question.id);
    recordStorage.recordAnswer(result.correct, { bankId: session.bankId, type: question.type, typeLabel: question.displayTypeLabel || '', difficulty: question.difficulty || '', category: question.category || '' });
    if (score === 'mastered') {
      recordStorage.setMastered(session.bankId, question.id, true);
      this.setData({ result }, () => setTimeout(() => this.removeCurrentAfterMastered(), 180));
    } else {
      this.setData({ result }, () => this.scheduleAutoNext(result));
    }
  },

  rateMemorize(event) {
    this.clearAutoNext();
    if (!this.data.memorizeMode) return;
    const score = event.currentTarget.dataset.score;
    const session = this.session;
    const question = this.data.question;
    const previous = session.results[question.id];
    const result = { correct: score === 'mastered', selfScore: score, memorize: true };
    session.results[question.id] = result;

    if (!previous) {
      if (score === 'mastered') {
        recordStorage.markCorrect(session.bankId, question.id);
        recordStorage.setMastered(session.bankId, question.id, true);
      } else recordStorage.markWrong(session.bankId, question.id);
      recordStorage.recordReview(score);
    }
    if (score === 'mastered') this.setData({ result }, () => setTimeout(() => this.removeCurrentAfterMastered(), 180));
    else this.setData({ result });
  },

  removeCurrentAfterMastered() {
    this.clearAutoNext();
    const session = this.session;
    if (!session || !session.questions.length) return;
    const removed = session.questions.splice(session.index, 1)[0];
    if (removed) {
      delete session.answers[removed.id];
      delete session.results[removed.id];
    }
    if (!session.questions.length) {
      wx.showModal({
        title: '当前题目已全部掌握',
        content: '这些题已移入“已掌握”，以后不会出现在练习和背题中。',
        showCancel: false,
        success: () => wx.navigateBack()
      });
      return;
    }
    if (session.index >= session.questions.length) session.index = session.questions.length - 1;
    this.renderQuestion();
  },

  masterCurrent() {
    this.clearAutoNext();
    if (!this.session || !this.data.question) return;
    const question = this.data.question;
    // 手动标记掌握也视为完成该题，继续进度应进入它的下一题。
    this.session.results[question.id] = { correct: true, selfScore: 'mastered', manualMastered: true };
    this.markQuestionCompleted(question);
    this.persistProgress('manual-mastered', true);
    if (!recordStorage.isMastered(this.session.bankId, question.id)) {
      recordStorage.setMastered(this.session.bankId, question.id, true);
      recordStorage.recordReview('mastered');
    }
    wx.showToast({ title: '已移入已掌握', icon: 'none' });
    this.removeCurrentAfterMastered();
  },

  toggleFavorite() {
    const favorite = recordStorage.toggleFavorite(this.session.bankId, this.data.question.id);
    this.setData({ favorite });
    wx.showToast({ title: favorite ? '已收藏' : '已取消', icon: 'none' });
  },

  onTouchStart(event) {
    const touch = event && event.touches && event.touches[0];
    if (!touch || this.data.showQuestionSheet) return;
    this.swipeStart = {
      x: Number(touch.clientX || touch.pageX || 0),
      y: Number(touch.clientY || touch.pageY || 0),
      time: Date.now()
    };
  },

  onTouchEnd(event) {
    if (!this.swipeStart) return;
    const touch = event && event.changedTouches && event.changedTouches[0];
    const start = this.swipeStart;
    this.swipeStart = null;
    if (!touch) return;

    const dx = Number(touch.clientX || touch.pageX || 0) - start.x;
    const dy = Number(touch.clientY || touch.pageY || 0) - start.y;
    const elapsed = Date.now() - start.time;
    if (elapsed > 900 || Math.abs(dx) < 62 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
    this.enqueueSwipe(dx < 0 ? 'next' : 'previous');
  },

  enqueueSwipe(direction) {
    if (!this.pendingSwipes) this.pendingSwipes = [];
    if (this.pendingSwipes.length >= 10) return;
    this.pendingSwipes.push(direction);
    this.drainSwipeQueue();
  },

  drainSwipeQueue() {
    if (this.swipeProcessing || !this.pendingSwipes || !this.pendingSwipes.length) return;
    const direction = this.pendingSwipes.shift();
    this.swipeProcessing = true;
    if (direction === 'next') this.next();
    else this.previous();
    setTimeout(() => {
      this.swipeProcessing = false;
      this.drainSwipeQueue();
    }, 85);
  },

  previous() {
    this.clearAutoNext();
    if (!this.session || this.session.index <= 0) return;
    this.session.index -= 1;
    this.renderQuestion();
  },

  next() {
    this.clearAutoNext();
    const session = this.session;
    if (!session) return;
    if (session.index >= session.questions.length - 1) {
      this.finish();
      return;
    }
    session.index += 1;
    this.renderQuestion();
  },

  finish() {
    const session = this.session;
    const allCompleted = Boolean(session && session.questions.length)
      && session.questions.every(question =>
        practiceService.getQuestionAnswerStatus(question, session.results[question.id]) !== 'unanswered'
      );
    if (session && session.mode === 'memorize' && session.memorizeOrder !== 'random') {
      this.persistProgress('finish-memorize', true);
    }
    if (session && session.mode === 'sequence') {
      // 即使完整做完最后一道题也保留进度与答题状态，便于下次查看和继续。
      // 用户主动“从头开始”时再由配置页覆盖，而不是完成后自动删除。
      this.persistProgress(allCompleted ? 'finish-completed-all' : 'finish-with-unanswered', true);
    }
    const values = Object.values(session.results).filter(item => item && (item.selfScore || typeof item.correct === 'boolean'));
    const correct = values.filter(item => item.correct).length;
    const title = session.memorize ? '背题完成' : '练习完成';
    getApp().globalData.resultData = {
      title,
      total: session.questions.length,
      answered: values.length,
      correct,
      accuracy: values.length ? Math.round(correct / values.length * 100) : 0,
      duration: Math.round((Date.now() - session.startedAt) / 1000),
      memorize: Boolean(session.memorize)
    };
    wx.redirectTo({ url: '/pages/result/result' });
  }

});
