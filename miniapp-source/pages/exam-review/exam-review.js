const practiceService = require('../../services/practice-service');
const { QUESTION_TYPES } = require('../../utils/constants');

Page({
  data: {
    filterOptions: [
      { value: 'all', label: '全部' },
      { value: 'wrong', label: '错题' },
      { value: 'unanswered', label: '未答' },
      { value: 'short', label: '简答题' }
    ],
    filter: 'all',
    question: null,
    displayOptions: [],
    typeLabel: '',
    difficulty: '',
    progressText: '',
    statusLabel: '',
    statusClass: '',
    selectedAnswer: '',
    correctAnswer: '',
    shortAnswer: '',
    analysis: '',
    filteredCount: 0,
    isFirst: true,
    isLast: false,
    sheetOpen: false,
    sheetItems: []
  },

  onLoad() {
    const session = getApp().globalData.currentSession;
    if (!session || !session.exam || !Array.isArray(session.questions) || !session.questions.length) {
      wx.showModal({ title: '试卷已失效', content: '本次考试数据已不存在。', showCancel: false, success: () => wx.navigateBack() });
      return;
    }
    this.session = session;
    this.applyFilter('all');
  },

  questionStatus(question) {
    if (question.type === 'short') {
      return String(this.session.shortAnswers && this.session.shortAnswers[question.id] || '').trim() ? 'short' : 'unanswered';
    }
    const selected = this.session.answers[question.id] || [];
    if (!selected.length) return 'unanswered';
    const result = this.session.results[question.id] || practiceService.judgeQuestion(question, selected);
    return result.correct ? 'correct' : 'wrong';
  },

  applyFilter(filter) {
    this.setData({ filter });
    const indices = [];
    this.session.questions.forEach((question, index) => {
      const status = this.questionStatus(question);
      if (filter === 'all'
        || (filter === 'wrong' && status === 'wrong')
        || (filter === 'unanswered' && status === 'unanswered')
        || (filter === 'short' && question.type === 'short')) indices.push(index);
    });
    this.filteredIndices = indices;
    this.filteredPosition = 0;
    if (!indices.length) {
      this.setData({ question: null, filteredCount: 0, sheetItems: [] });
      return;
    }
    this.renderQuestion();
  },

  changeFilter(event) {
    this.applyFilter(event.currentTarget.dataset.value || 'all');
  },

  decorateOptions(question, selected) {
    const correct = new Set(question.answer || []);
    const chosen = new Set(selected || []);
    return (question.options || []).map(option => {
      const isCorrect = correct.has(option.key);
      const isChosen = chosen.has(option.key);
      let stateClass = '';
      if (isCorrect && isChosen) stateClass = 'chosen-correct';
      else if (isCorrect) stateClass = 'correct';
      else if (isChosen) stateClass = 'chosen-wrong';
      return { ...option, stateClass, isChosen, isCorrect };
    });
  },

  renderQuestion() {
    if (!this.filteredIndices || !this.filteredIndices.length) return;
    const originalIndex = this.filteredIndices[this.filteredPosition];
    const question = this.session.questions[originalIndex];
    const selected = this.session.answers[question.id] || [];
    const status = this.questionStatus(question);
    const labelMap = { correct: '回答正确', wrong: '回答错误', unanswered: '未作答', short: '主观题（不自动计分）' };
    this.setData({
      question,
      displayOptions: this.decorateOptions(question, selected),
      typeLabel: question.displayTypeLabel || QUESTION_TYPES[question.type] || question.type,
      difficulty: question.difficulty || '',
      progressText: `${this.filteredPosition + 1} / ${this.filteredIndices.length}（原卷第 ${originalIndex + 1} 题）`,
      statusLabel: labelMap[status] || status,
      statusClass: `status-${status}`,
      selectedAnswer: selected.length ? selected.join('、') : '未作答',
      correctAnswer: question.type === 'short' ? (question.answerText || '未提供参考答案') : ((question.answer || []).join('、') || '未提供正确答案'),
      shortAnswer: question.type === 'short' ? String(this.session.shortAnswers && this.session.shortAnswers[question.id] || '') : '',
      analysis: question.analysis || '',
      filteredCount: this.filteredIndices.length,
      isFirst: this.filteredPosition === 0,
      isLast: this.filteredPosition === this.filteredIndices.length - 1,
      sheetItems: this.filteredIndices.map((index, position) => ({
        position,
        number: index + 1,
        status: this.questionStatus(this.session.questions[index]),
        statusClass: `sheet-${this.questionStatus(this.session.questions[index])}`,
        current: position === this.filteredPosition
      }))
    });
  },

  previous() {
    if (this.filteredPosition <= 0) return;
    this.filteredPosition -= 1;
    this.renderQuestion();
  },

  next() {
    if (this.filteredPosition >= this.filteredIndices.length - 1) return;
    this.filteredPosition += 1;
    this.renderQuestion();
  },

  toggleSheet() {
    this.setData({ sheetOpen: !this.data.sheetOpen });
  },

  jump(event) {
    const position = Number(event.currentTarget.dataset.position);
    if (!Number.isInteger(position) || position < 0 || position >= this.filteredIndices.length) return;
    this.filteredPosition = position;
    this.setData({ sheetOpen: false });
    this.renderQuestion();
  }
});
