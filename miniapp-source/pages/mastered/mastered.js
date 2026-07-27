const bankStorage = require('../../services/bank-storage');
const recordStorage = require('../../services/record-storage');
const { QUESTION_TYPES } = require('../../utils/constants');

Page({
  data: {
    bankId: '',
    bankName: '',
    groups: [],
    query: '',
    total: 0,
    items: [],
    typeOptions: [{ value: 'all', label: '全部题型' }],
    typeIndex: 0,
    categoryOptions: [{ value: 'all', label: '全部分类' }],
    categoryIndex: 0,
    orderOptions: ['最近掌握', '原题库顺序'],
    orderIndex: 0,
    selectionMode: false,
    selectedCount: 0
  },

  onLoad(query) {
    this.setData({ bankId: query.bankId || '' });
    if (query.bankId) {
      const manifest = bankStorage.getManifest(query.bankId);
      this.setData({ bankName: manifest ? manifest.name : '已掌握题目' });
      wx.setNavigationBarTitle({ title: manifest ? manifest.name : '已掌握题目' });
    }
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    if (!this.data.bankId) {
      const groups = bankStorage.listBanks().map(bank => ({
        id: bank.id,
        name: bank.name,
        count: recordStorage.getMasteredIds(bank.id).length
      })).filter(item => item.count > 0);
      this.setData({ groups });
      return;
    }

    const bankId = this.data.bankId;
    const records = recordStorage.getMastered(bankId);
    const ids = new Set(Object.keys(records));
    let questions = [];
    try { questions = bankStorage.loadQuestions(bankId); } catch (error) {
      wx.showModal({ title: '读取失败', content: error.message || String(error), showCancel: false });
      return;
    }
    const rows = questions.map((question, sourceIndex) => ({ question, sourceIndex }))
      .filter(entry => ids.has(entry.question.id))
      .map(({ question, sourceIndex }) => ({
        rowKey: `${bankId}:${question.id}`,
        bankId,
        questionId: question.id,
        typeLabel: question.displayTypeLabel || QUESTION_TYPES[question.type] || question.type,
        category: question.category || '未分类',
        question: question.question,
        masteredAt: Number(records[question.id] && records[question.id].masteredAt || 0),
        sourceOrder: Number(question.order) > 0 ? Number(question.order) : sourceIndex + 1,
        selected: false
      }));
    const typeLabels = Array.from(new Set(rows.map(item => item.typeLabel).filter(Boolean)));
    const categories = Array.from(new Set(rows.map(item => item.category).filter(Boolean)));
    this.allItems = rows;
    this.setData({
      typeOptions: [{ value: 'all', label: '全部题型' }, ...typeLabels.map(value => ({ value, label: value }))],
      categoryOptions: [{ value: 'all', label: '全部分类' }, ...categories.map(value => ({ value, label: value }))],
      typeIndex: Math.min(this.data.typeIndex, typeLabels.length),
      categoryIndex: Math.min(this.data.categoryIndex, categories.length),
      selectionMode: false,
      selectedCount: 0
    });
    this.applyFilter();
  },

  openBank(event) {
    wx.navigateTo({ url: `/pages/mastered/mastered?bankId=${encodeURIComponent(event.currentTarget.dataset.id)}` });
  },

  onSearch(event) {
    this.setData({ query: event.detail.value || '' });
    this.applyFilter();
  },

  onTypeChange(event) {
    this.setData({ typeIndex: Number(event.detail.value) });
    this.applyFilter();
  },

  onCategoryChange(event) {
    this.setData({ categoryIndex: Number(event.detail.value) });
    this.applyFilter();
  },

  onOrderChange(event) {
    this.setData({ orderIndex: Number(event.detail.value) });
    this.applyFilter();
  },

  applyFilter() {
    const keyword = String(this.data.query || '').trim().toLowerCase();
    const type = (this.data.typeOptions[this.data.typeIndex] || {}).value || 'all';
    const category = (this.data.categoryOptions[this.data.categoryIndex] || {}).value || 'all';
    let items = (this.allItems || []).filter(item => {
      if (type !== 'all' && item.typeLabel !== type) return false;
      if (category !== 'all' && item.category !== category) return false;
      return !keyword || `${item.typeLabel} ${item.category} ${item.question}`.toLowerCase().includes(keyword);
    });
    items = items.slice().sort(this.data.orderIndex === 1
      ? (a, b) => a.sourceOrder - b.sourceOrder
      : (a, b) => b.masteredAt - a.masteredAt || a.sourceOrder - b.sourceOrder);
    this.setData({ items, total: (this.allItems || []).length, selectedCount: items.filter(item => item.selected).length });
  },

  toggleSelectionMode() {
    const enabled = !this.data.selectionMode;
    (this.allItems || []).forEach(item => { item.selected = false; });
    this.setData({ selectionMode: enabled, selectedCount: 0 });
    this.applyFilter();
  },

  toggleSelect(event) {
    if (!this.data.selectionMode) return;
    const id = event.currentTarget.dataset.id;
    const item = (this.allItems || []).find(row => row.questionId === id);
    if (!item) return;
    item.selected = !item.selected;
    this.applyFilter();
  },

  selectAllVisible() {
    const visible = new Set((this.data.items || []).map(item => item.questionId));
    const shouldSelect = !(this.data.items || []).length || !(this.data.items || []).every(item => item.selected);
    (this.allItems || []).forEach(item => { if (visible.has(item.questionId)) item.selected = shouldSelect; });
    this.applyFilter();
  },

  remove(event) {
    const questionId = event.currentTarget.dataset.id;
    this.confirmRemove([questionId]);
  },

  removeSelected() {
    const ids = (this.allItems || []).filter(item => item.selected).map(item => item.questionId);
    if (!ids.length) {
      wx.showToast({ title: '请先选择题目', icon: 'none' });
      return;
    }
    this.confirmRemove(ids);
  },

  confirmRemove(ids) {
    wx.showModal({
      title: ids.length > 1 ? `移出 ${ids.length} 道题` : '移出已掌握',
      content: '移出后，题目会重新出现在普通练习和背题中，原练习进度不会被删除。',
      confirmText: '确认移出',
      success: result => {
        if (!result.confirm) return;
        ids.forEach(questionId => recordStorage.removeMastered(this.data.bankId, questionId));
        wx.showToast({ title: `已恢复 ${ids.length} 道`, icon: 'none' });
        this.refresh();
      }
    });
  }
});
