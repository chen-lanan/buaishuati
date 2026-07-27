const bankStorage = require('../../services/bank-storage');
const { QUESTION_TYPES } = require('../../utils/constants');
const { buildSearchText, compactText, fuzzyContains } = require('../../utils/text');

Page({
  data: {
    bankId: '',
    keyword: '',
    results: [],
    total: 0,
    hasMore: false
  },

  onLoad(query) {
    this.bankId = query.bankId;
    this.questions = bankStorage.loadQuestions(query.bankId).map(item => ({
      ...item,
      typeLabel: item.displayTypeLabel || QUESTION_TYPES[item.type] || item.type || '未知题型',
      answerDisplay: item.type === 'short'
        ? (item.answerText || '未提供参考答案')
        : (item.answer || []).join('、'),
      _searchText: buildSearchText(item)
    }));
    this.filtered = this.questions;
    this.renderResults(true);
  },

  onUnload() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
  },

  onInput(event) {
    const keyword = event.detail.value || '';
    this.setData({ keyword });
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.search(keyword), 80);
  },

  onConfirm(event) {
    const keyword = event.detail.value || this.data.keyword;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.search(keyword);
  },

  search(keyword) {
    const query = compactText(keyword);
    if (!query) {
      this.filtered = this.questions;
    } else {
      const exact = [];
      const fuzzy = [];
      this.questions.forEach(item => {
        if (item._searchText.includes(query)) exact.push(item);
        else if (query.length >= 2 && fuzzyContains(item._searchText, query)) fuzzy.push(item);
      });
      this.filtered = exact.concat(fuzzy);
    }
    this.renderResults(true);
  },

  renderResults(reset = true) {
    this.loadedCount = reset ? 80 : this.loadedCount;
    const results = this.filtered.slice(0, this.loadedCount).map(item => {
      const clone = { ...item };
      delete clone._searchText;
      return clone;
    });
    this.setData({
      results,
      total: this.filtered.length,
      hasMore: results.length < this.filtered.length
    });
  },

  loadMore() {
    this.loadedCount += 80;
    this.renderResults(false);
  },

  open(event) {
    const questionId = event.currentTarget.dataset.id;
    const question = this.questions.find(item => item.id === questionId);
    if (!question) return;
    const cleanQuestion = { ...question };
    delete cleanQuestion._searchText;
    const session = {
      bankId: this.bankId,
      bankName: bankStorage.getManifest(this.bankId).name,
      mode: 'search',
      questions: [cleanQuestion],
      index: 0,
      answers: {},
      results: {},
      startedAt: Date.now(),
      exam: false,
      durationMinutes: 0
    };
    getApp().globalData.currentSession = session;
    wx.navigateTo({ url: '/pages/practice/practice' });
  }
});
