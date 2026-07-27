const bankStorage = require('../../services/bank-storage');
const practiceService = require('../../services/practice-service');
const recordStorage = require('../../services/record-storage');

const { QUESTION_TYPES } = require('../../utils/constants');

const TYPE_LABEL_ORDER = ['单选题', '多选题', '判断题', '填空题', '简答题', '计算题', '画图题'];
function displayTypeLabel(question) {
  return String(question && (question.displayTypeLabel || QUESTION_TYPES[question.type] || question.type) || '未知题型').trim();
}
function buildTypeOptions(questions = []) {
  const counts = {};
  let abnormalCount = 0;
  (questions || []).forEach(question => {
    if (!question || question.sourceMissingPlaceholder || question.nonPractice) return;
    const status = question.status || 'normal';
    // 异常状态优先于原题型：异常单选/多选等只归入统一“异常题”，
    // 不再额外制造一个看似可正常练习的原题型入口。
    if (status !== 'normal') {
      abnormalCount += 1;
      return;
    }
    const label = displayTypeLabel(question);
    counts[label] = (counts[label] || 0) + 1;
  });
  const labels = Object.keys(counts).sort((left, right) => {
    const li = TYPE_LABEL_ORDER.indexOf(left);
    const ri = TYPE_LABEL_ORDER.indexOf(right);
    if (li >= 0 || ri >= 0) return (li < 0 ? 999 : li) - (ri < 0 ? 999 : ri);
    return left.localeCompare(right, 'zh-CN');
  });
  const options = [{ value: 'all', label: '全部题型' }];
  labels.forEach(label => options.push({ value: `display:${label}`, label }));
  if (abnormalCount) options.push({ value: 'abnormal', label: '异常题' });
  return options;
}

Page({
  data: {
    bankId: '',
    manifest: null,
    mode: 'sequence',
    modeName: '顺序练习',
    typeOptions: [{ value: 'all', label: '全部题型' }],
    typeIndex: 0,
    wrongOrderOptions: [
      { value: 'sequence', label: '按原题库顺序' },
      { value: 'random', label: '随机打乱错题' }
    ],
    wrongOrderIndex: 0,
    memorizeOrderOptions: [
      { value: 'sequence', label: '按原题库顺序' },
      { value: 'random', label: '随机打乱题目' }
    ],
    memorizeOrderIndex: 0,
    countOptions: [10, 20, 50, 100, 0],
    countLabels: ['10题', '20题', '50题', '100题', '全部'],
    countIndex: 4,
    resume: true,
    progress: null,
    progressCursor: null,
    memorizeProgress: null,
    memorizeProgressCursor: null,
    memorizeRandomSequence: [],
    settings: {
      resetWrongOnRestart: true
    }
  },

  onLoad(query) {
    const manifest = bankStorage.getManifest(query.bankId);
    const mode = query.mode || 'sequence';
    const names = {
      sequence: '顺序练习',
      random: '随机练习',
      wrong: '错题重练',
      favorites: '收藏练习',
      memorize: '背题模式'
    };
    const progress = recordStorage.getProgress(query.bankId);
    const memorizeProgress = typeof recordStorage.getMemorizeProgress === 'function'
      ? recordStorage.getMemorizeProgress(query.bankId) : null;
    let questions = [];
    try { questions = bankStorage.loadQuestions(query.bankId); } catch (_) {}
    const typeOptions = buildTypeOptions(questions);
    this.setData({
      bankId: query.bankId,
      manifest,
      mode,
      typeOptions,
      typeIndex: 0,
      modeName: names[mode] || '顺序练习',
      progress,
      progressCursor: practiceService.getProgressCursor(progress, 'all', 0),
      memorizeProgress,
      memorizeProgressCursor: practiceService.getMemorizeProgressCursor(memorizeProgress, 'sequence', 'all', 0),
      memorizeRandomSequence: practiceService.getMemorizeQuestionSequence(memorizeProgress, 'random', 'all', 0),
      settings: recordStorage.getSettings()
    });
  },

  refreshProgress() {
    if (!this.data.bankId) return;
    const progress = recordStorage.getProgress(this.data.bankId);
    const memorizeProgress = typeof recordStorage.getMemorizeProgress === 'function'
      ? recordStorage.getMemorizeProgress(this.data.bankId) : null;
    const previousValue = this.data.typeOptions[this.data.typeIndex]
      ? this.data.typeOptions[this.data.typeIndex].value : 'all';
    let questions = [];
    try { questions = bankStorage.loadQuestions(this.data.bankId); } catch (_) {}
    const typeOptions = buildTypeOptions(questions);
    let typeIndex = typeOptions.findIndex(item => item.value === previousValue);
    if (typeIndex < 0) typeIndex = 0;
    const type = typeOptions[typeIndex].value;
    const count = this.data.countOptions[this.data.countIndex];
    this.setData({
      typeOptions,
      typeIndex,
      progress,
      progressCursor: practiceService.getProgressCursor(progress, type, count),
      memorizeProgress,
      memorizeProgressCursor: practiceService.getMemorizeProgressCursor(
        memorizeProgress,
        this.data.memorizeOrderOptions[this.data.memorizeOrderIndex].value,
        type,
        count
      ),
      memorizeRandomSequence: practiceService.getMemorizeQuestionSequence(memorizeProgress, 'random', type, count),
      settings: recordStorage.getSettings()
    });
  },

  onShow() {
    // 从练习页返回时重新读取最新“已完成题”进度，不能继续使用进入前缓存。
    this.refreshProgress();
  },

  onTypeChange(event) {
    const typeIndex = Number(event.detail.value);
    this.setData({ typeIndex }, () => this.refreshProgress());
  },

  onCountChange(event) {
    const countIndex = Number(event.detail.value);
    this.setData({ countIndex }, () => this.refreshProgress());
  },

  onWrongOrderChange(event) {
    this.setData({ wrongOrderIndex: Number(event.detail.value) });
  },

  onMemorizeOrderChange(event) {
    this.setData({ memorizeOrderIndex: Number(event.detail.value), resume: true }, () => this.refreshProgress());
  },


  onResumeChange(event) {
    this.setData({ resume: Boolean(event.detail.value) });
  },

  buildConfig() {
    const type = this.data.typeOptions[this.data.typeIndex].value;
    const count = this.data.countOptions[this.data.countIndex];
    const memorizeOrder = this.data.memorizeOrderOptions[this.data.memorizeOrderIndex].value;
    const canResumeSequence = this.data.mode === 'sequence' && this.data.resume && this.data.progressCursor;
    const canResumeMemorize = this.data.mode === 'memorize'
      && this.data.resume && this.data.memorizeProgressCursor
      && (memorizeOrder !== 'random' || (this.data.memorizeRandomSequence || []).length > 0);
    return {
      bankId: this.data.bankId,
      bankName: this.data.manifest.name,
      mode: this.data.mode,
      type,
      count,
      wrongOrder: this.data.mode === 'wrong'
        ? this.data.wrongOrderOptions[this.data.wrongOrderIndex].value
        : 'sequence',
      memorizeOrder,
      resumeCursor: canResumeSequence
        ? this.data.progressCursor
        : (canResumeMemorize ? this.data.memorizeProgressCursor : null),
      resumeQuestionStates: canResumeSequence && this.data.progress
        ? (this.data.progress.questionStates || [])
        : [],
      resumeQuestionSequence: canResumeMemorize && memorizeOrder === 'random'
        ? this.data.memorizeRandomSequence
        : []
    };
  },

  beginSession() {
    try {
      const session = practiceService.createSession(this.buildConfig());
      if (!session.questions.length) {
        wx.showModal({
          title: '没有可练习题目',
          content: '当前筛选条件下没有题目。错题和收藏模式需要先产生相应记录。',
          showCancel: false
        });
        return;
      }
      getApp().globalData.currentSession = session;
      wx.navigateTo({ url: '/pages/practice/practice' });
    } catch (error) {
      wx.showModal({ title: '无法开始', content: error.message || String(error), showCancel: false });
    }
  },

  start() {
    const hasSavedSequence = Boolean(this.data.progress);
    const memorizeOrder = this.data.memorizeOrderOptions[this.data.memorizeOrderIndex].value;
    const isRestartingMemorize = this.data.mode === 'memorize'
      && !this.data.resume && Boolean(this.data.memorizeProgressCursor);
    // 只要关闭“继续上次进度”，就把对应的顺序进度重置。
    // 不再依赖当前页面缓存中是否恰好读到了 progress。
    const isRestartingSequence = this.data.mode === 'sequence' && !this.data.resume;
    const shouldResetWrong = isRestartingSequence
      && hasSavedSequence
      && Boolean(this.data.settings && this.data.settings.resetWrongOnRestart);

    const startFromBeginning = () => {
      // 先清除旧进度再建会话。否则用户选择“从头开始”后若 APP 立即被系统结束，
      // 下次仍可能读到旧位置。
      if (this.data.mode === 'sequence') {
        recordStorage.clearProgressForBank(this.data.bankId);
        this.setData({ progress: null, progressCursor: null });
      } else if (isRestartingMemorize) {
        const type = this.data.typeOptions[this.data.typeIndex].value;
        const count = this.data.countOptions[this.data.countIndex];
        const scopeKey = practiceService.buildMemorizeScopeKey(memorizeOrder, type, count);
        const legacyScopeKey = memorizeOrder === 'sequence' ? practiceService.buildPracticeScopeKey(type, count) : '';
        if (typeof recordStorage.clearMemorizeProgressScope === 'function') {
          recordStorage.clearMemorizeProgressScope(this.data.bankId, scopeKey, legacyScopeKey);
        }
        this.setData({ memorizeProgressCursor: null, memorizeRandomSequence: [] });
      }
      this.beginSession();
    };

    if (!shouldResetWrong) {
      if (isRestartingSequence || isRestartingMemorize) startFromBeginning();
      else this.beginSession();
      return;
    }

    const wrongCount = Object.values(recordStorage.getWrong(this.data.bankId)).filter(item => !item.mastered).length;
    wx.showModal({
      title: '从头开始练习',
      content: wrongCount
        ? `将从第一题开始，并清除当前题库 ${wrongCount} 道错题记录。`
        : '将从第一题开始，当前题库没有需要清除的错题。',
      confirmText: wrongCount ? '从头并清除' : '从头开始',
      cancelText: '返回',
      success: result => {
        if (!result.confirm) return;
        recordStorage.clearWrongForBank(this.data.bankId);
        startFromBeginning();
      }
    });
  }
});
