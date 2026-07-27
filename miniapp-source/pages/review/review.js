const bankStorage = require('../../services/bank-storage');
const { QUESTION_TYPES } = require('../../utils/constants');
const { validateQuestion, repairOptionDuplicates } = require('../../services/question-validator');

const TYPE_ORDER = ['单选题', '多选题', '判断题', '填空题', '简答题', '计算题', '画图题'];
const ISSUE_GROUPS = [
  { key: 'sourceOptionDuplicate', label: '片段重复', test: issue => /导入片段重复|原文确实重复|原文重复|原文选项内容重复/.test(issue) },
  { key: 'parserOptionDuplicate', label: '识别重复', test: issue => /解析重复|解析疑似重复识别/.test(issue) },
  { key: 'possibleOptionDuplicate', label: '疑似重复', test: issue => /疑似重复|选项内容重复|选项字母重复/.test(issue) },
  { key: 'missingAnswer', label: '无答案', test: issue => /无答案|缺少答案|缺少参考答案/.test(issue) },
  { key: 'answerMismatch', label: '答案不符', test: issue => /答案不符|答案.+不在选项中/.test(issue) },
  { key: 'optionStructure', label: '选项异常', test: issue => /选项不足|选项少于|空白选项|图片选项缺少图像|图片选项待核对/.test(issue) },
  { key: 'typeIssue', label: '题型异常', test: issue => /多选仅一项|多选题只有一个答案|判断选项异常|判断题选项数量/.test(issue) },
  { key: 'boundary', label: '边界异常', test: issue => /边界|题干文字未完整识别|残留答案|粘连|题干过长|答案过长/.test(issue) },
  { key: 'duplicateQuestion', label: '重复题', test: issue => /重复题|疑似与第/.test(issue) }
];

function unique(list) { return Array.from(new Set((list || []).filter(Boolean))); }
function cleanIssueText(value) {
  return String(value || '').replace(/^\s*[•·-]\s*/, '').replace(/\s+/g, ' ').trim();
}
function collectIssueLetters(items) {
  const letters = [];
  (items || []).forEach(text => {
    const match = /[（(]([A-L](?:[、,，/\s]+[A-L])*)[）)]/i.exec(String(text || ''));
    if (!match) return;
    (match[1].toUpperCase().match(/[A-L]/g) || []).forEach(letter => {
      if (!letters.includes(letter)) letters.push(letter);
    });
  });
  return letters;
}
function normalizeReviewIssues(input = []) {
  let issues = unique((input || []).map(cleanIssueText).filter(Boolean));

  // 已有更明确的重复来源时，删除旧版遗留的泛化“选项内容重复”。
  const hasSpecificDuplicate = issues.some(issue => /^(?:导入片段重复|原文确实重复|原文重复|解析重复|疑似重复|原文选项内容重复|解析疑似重复识别)/.test(issue));
  if (hasSpecificDuplicate) issues = issues.filter(issue => !/^选项内容重复(?:[（(]|$)/.test(issue));

  // 同类答案不符合并字母，避免同一道题出现多条等价异常。
  const mismatches = issues.filter(issue => /答案不符|答案.+不在选项中/.test(issue));
  if (mismatches.length > 1) {
    const letters = collectIssueLetters(mismatches);
    issues = issues.filter(issue => !mismatches.includes(issue));
    issues.push(letters.length ? `答案不符（${letters.join('、')}）` : '答案不符');
  }

  const hasMissingAnswer = issues.some(issue => /无答案|缺少答案|缺少参考答案/.test(issue));
  if (hasMissingAnswer) {
    // 没有答案时“答案不符”没有额外信息，保留一个“无答案”即可。
    issues = issues.filter(issue => !/答案不符|答案.+不在选项中/.test(issue));
    const missing = issues.filter(issue => /无答案|缺少答案|缺少参考答案/.test(issue));
    if (missing.length > 1) {
      issues = issues.filter(issue => !missing.includes(issue));
      issues.push('无答案');
    }
  }

  const optionShortage = issues.filter(issue => /选项不足|选项少于/.test(issue));
  const answerMismatch = issues.filter(issue => /答案不符|答案.+不在选项中/.test(issue));
  if (optionShortage.length && answerMismatch.length) {
    // “选项不足 + 答案不符(C)”通常是同一个根因，合并成一条更易读的异常。
    const letters = collectIssueLetters(answerMismatch);
    issues = issues.filter(issue => !optionShortage.includes(issue) && !answerMismatch.includes(issue));
    issues.push(letters.length ? `选项不足（答案 ${letters.join('、')} 无对应选项）` : '选项不足');
  } else if (optionShortage.length > 1) {
    issues = issues.filter(issue => !optionShortage.includes(issue));
    issues.push('选项不足');
  }

  // 判断题选项异常与普通选项不足同时出现时，保留更具体的一项。
  if (issues.some(issue => /判断选项异常|判断题选项数量/.test(issue))) {
    issues = issues.filter(issue => !/^选项不足$/.test(issue));
  }
  return unique(issues);
}
function conciseIssueLabel(issue, fallback) {
  const text = cleanIssueText(issue);
  if (!text) return fallback;
  // 过长或含解释性句子的异常仍用简短组名；短异常则与题目卡片保持一致。
  const visibleLength = Array.from(text).length;
  if (visibleLength <= 11 && !/[：:]/.test(text)) return text;
  return fallback;
}
function isDuplicateIssue(issue) { return /导入片段重复|原文确实重复|原文重复|解析重复|疑似重复|选项内容重复|原文选项内容重复|解析疑似重复识别/.test(String(issue)); }
function issueKinds(issues = []) {
  const kinds = [];
  issues.forEach(issue => {
    const matched = ISSUE_GROUPS.find(group => group.test(String(issue)));
    const key = matched ? matched.key : 'other';
    if (!kinds.includes(key)) kinds.push(key);
  });
  return kinds;
}
function statusMatches(item, status) {
  const current = item.status || 'normal';
  if (status === 'all') return true;
  if (status === 'abnormal') return current !== 'normal';
  return current === status;
}
function confidenceBucket(value) {
  const confidence = Math.max(0, Math.min(1, Number(value) || 0));
  if (confidence < 0.45) return 'low';
  if (confidence < 0.75) return 'medium';
  return 'high';
}
function confidencePercent(value) {
  return Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100);
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
    source: 'draft', bankId: '', statusFilter: 'abnormal', confidenceFilter: 'all', issueFilter: 'all', typeFilter: 'all',
    editMode: false, keyword: '', items: [], total: 0, hasMore: false,
    counts: { all: 0, normal: 0, warning: 0, error: 0, abnormal: 0 },
    confidenceFilters: [], issueFilters: [], typeFilters: [], showConfidenceFilters: true, showIssueFilters: true, savingAll: false
  },

  onLoad(query) {
    const editMode = query.editMode === '1';
    this.setData({ source: query.source || 'draft', bankId: query.bankId || '',
      statusFilter: query.filter || (editMode ? 'all' : 'abnormal'), editMode });
    if (editMode) wx.setNavigationBarTitle({ title: '编辑题库' });
  },

  onShow() { this.load(); },

  normalizeQuestion(item, index) {
    const repaired = repairOptionDuplicates(item);
    const validation = validateQuestion(repaired);
    const preserved = (item.issues || []).filter(issue => !isDuplicateIssue(issue));
    const issues = normalizeReviewIssues([...preserved, ...validation.issues]);
    let status = validation.status;
    if (issues.length && status === 'normal') status = 'warning';
    return {
      ...repaired, ...validation, issues, status, originalIndex: index,
      typeLabel: repaired.displayTypeLabel || QUESTION_TYPES[repaired.type] || repaired.type || '未知题型',
      showCategory: Boolean(repaired.category && repaired.category !== '未分类' &&
        String(repaired.category).trim() !== String(repaired.displayTypeLabel || QUESTION_TYPES[repaired.type] || repaired.type || '').trim()),
      rawPreview: repaired.source && Array.isArray(repaired.source.rawTexts) ? repaired.source.rawTexts.slice(0, 6) : [],
      rawSourceLabel: sourceFragmentLabel(repaired),
      answerPreview: repaired.type === 'short' ? (repaired.answerText || '') : (repaired.answer || []).join('、'),
      confidence: Number(validation.confidence) || 0,
      confidencePercent: confidencePercent(validation.confidence),
      confidenceBucket: confidenceBucket(validation.confidence),
      issueKinds: issueKinds(issues),
      searchText: [repaired.number, repaired.question, repaired.category, repaired.displayTypeLabel, repaired.difficulty, repaired.answerText, repaired.analysis,
        ...(repaired.options || []).map(option => option.text)].join(' ').toLowerCase()
    };
  },

  load() {
    let questions = [];
    if (this.data.source === 'draft') {
      const draft = getApp().globalData.importDraft;
      questions = draft ? draft.questions : [];
    } else questions = bankStorage.loadQuestions(this.data.bankId);

    this.allQuestions = questions.map((item, index) => this.normalizeQuestion(item, index));
    const counts = this.allQuestions.reduce((acc, item) => {
      const status = item.status || 'normal'; acc[status] = (acc[status] || 0) + 1; return acc;
    }, { all: this.allQuestions.length, normal: 0, warning: 0, error: 0 });
    counts.abnormal = counts.warning + counts.error;
    this.setData({ counts }, () => this.refreshAvailableFilters(true));
  },

  statusItems() { return (this.allQuestions || []).filter(item => statusMatches(item, this.data.statusFilter)); },

  refreshAvailableFilters(resetList = true) {
    const statusItems = this.statusItems();
    const showConfidenceFilters = ['abnormal', 'error', 'warning'].includes(this.data.statusFilter);
    const confidenceCounts = statusItems.reduce((acc, item) => {
      const bucket = item.confidenceBucket || confidenceBucket(item.confidence);
      acc[bucket] = (acc[bucket] || 0) + 1;
      return acc;
    }, { low: 0, medium: 0, high: 0 });
    const confidenceFilters = showConfidenceFilters ? [
      { key: 'all', label: '全部置信度', count: statusItems.length },
      { key: 'low', label: '低 0–44%', count: confidenceCounts.low },
      { key: 'medium', label: '中 45–74%', count: confidenceCounts.medium },
      { key: 'high', label: '高 75–100%', count: confidenceCounts.high }
    ].filter(item => item.key === 'all' || item.count) : [];
    const validConfidence = showConfidenceFilters && confidenceFilters.some(item => item.key === this.data.confidenceFilter)
      ? this.data.confidenceFilter : 'all';
    const confidenceItems = validConfidence === 'all' ? statusItems : statusItems.filter(item => item.confidenceBucket === validConfidence);
    const showIssueFilters = ['abnormal', 'error', 'warning'].includes(this.data.statusFilter);

    const issueCountMap = {};
    const issueLabelMap = {};
    confidenceItems.forEach(item => {
      item.issueKinds.forEach(key => { issueCountMap[key] = (issueCountMap[key] || 0) + 1; });
      (item.issues || []).forEach(issue => {
        const matched = ISSUE_GROUPS.find(group => group.test(String(issue)));
        const key = matched ? matched.key : 'other';
        if (!issueLabelMap[key]) issueLabelMap[key] = [];
        const label = conciseIssueLabel(issue, matched ? matched.label : '其他');
        if (!issueLabelMap[key].includes(label)) issueLabelMap[key].push(label);
      });
    });
    const issueFilters = [];
    if (showIssueFilters) {
      issueFilters.push({ key: 'all', label: '全部问题', count: confidenceItems.length });
      ISSUE_GROUPS.forEach(group => {
        if (!issueCountMap[group.key]) return;
        const labels = issueLabelMap[group.key] || [];
        // 当前筛选下同类异常文字完全一致且不长时，胶囊直接显示题目卡片中的文字。
        const label = labels.length === 1 ? labels[0] : group.label;
        issueFilters.push({ key: group.key, label, count: issueCountMap[group.key] });
      });
      if (issueCountMap.other) {
        const labels = issueLabelMap.other || [];
        issueFilters.push({ key: 'other', label: labels.length === 1 ? labels[0] : '其他', count: issueCountMap.other });
      }
    }
    const validIssue = showIssueFilters && issueFilters.some(item => item.key === this.data.issueFilter)
      ? this.data.issueFilter : 'all';

    const typeBase = validIssue === 'all' ? confidenceItems : confidenceItems.filter(item => item.issueKinds.includes(validIssue));
    const typeCountMap = typeBase.reduce((acc, item) => {
      const label = item.typeLabel || QUESTION_TYPES[item.type] || item.type || '未知题型';
      acc[label] = (acc[label] || 0) + 1;
      return acc;
    }, {});
    const typeFilters = [{ key: 'all', label: '全部题型', count: typeBase.length }];
    TYPE_ORDER.forEach(label => {
      if (typeCountMap[label]) typeFilters.push({ key: label, label, count: typeCountMap[label] });
    });
    Object.keys(typeCountMap).filter(label => !TYPE_ORDER.includes(label)).sort((a, b) => a.localeCompare(b, 'zh-CN')).forEach(label => {
      typeFilters.push({ key: label, label, count: typeCountMap[label] });
    });
    const validType = typeFilters.some(item => item.key === this.data.typeFilter) ? this.data.typeFilter : 'all';

    this.setData({ showConfidenceFilters, confidenceFilters, confidenceFilter: validConfidence, showIssueFilters, issueFilters, issueFilter: validIssue, typeFilters, typeFilter: validType },
      () => this.applyFilter(resetList));
  },

  filteredItems() {
    let items = this.statusItems();
    if (this.data.showConfidenceFilters && this.data.confidenceFilter !== 'all')
      items = items.filter(item => item.confidenceBucket === this.data.confidenceFilter);
    if (this.data.showIssueFilters && this.data.issueFilter !== 'all')
      items = items.filter(item => item.issueKinds.includes(this.data.issueFilter));
    if (this.data.typeFilter !== 'all') items = items.filter(item => item.typeLabel === this.data.typeFilter);
    const keyword = String(this.data.keyword || '').trim().toLowerCase();
    if (keyword) items = items.filter(item => item.searchText.includes(keyword));
    // 异常题默认按置信度从低到高，最值得人工校对的题目优先出现；同置信度保持原题库顺序。
    if (['abnormal', 'error', 'warning'].includes(this.data.statusFilter)) {
      items = items.slice().sort((a, b) => (Number(a.confidence) || 0) - (Number(b.confidence) || 0) || a.originalIndex - b.originalIndex);
    }
    return items;
  },

  applyFilter(reset = true) {
    this.filtered = this.filteredItems();
    this.loadedCount = reset ? 50 : (this.loadedCount || 50);
    const items = this.filtered.slice(0, this.loadedCount);
    this.setData({ items, total: this.filtered.length, hasMore: items.length < this.filtered.length });
  },

  onKeywordInput(event) { this.setData({ keyword: event.detail.value || '' }, () => this.applyFilter(true)); },
  clearKeyword() { this.setData({ keyword: '' }, () => this.applyFilter(true)); },
  changeStatusFilter(event) {
    const value = event.currentTarget.dataset.filter;
    if (!value || value === this.data.statusFilter) return;
    this.setData({ statusFilter: value, confidenceFilter: 'all', issueFilter: 'all', typeFilter: 'all' }, () => this.refreshAvailableFilters(true));
  },
  changeConfidenceFilter(event) {
    const value = event.currentTarget.dataset.filter;
    if (!value || value === this.data.confidenceFilter) return;
    this.setData({ confidenceFilter: value, issueFilter: 'all', typeFilter: 'all' }, () => this.refreshAvailableFilters(true));
  },
  changeIssueFilter(event) {
    const value = event.currentTarget.dataset.filter;
    if (!value || value === this.data.issueFilter) return;
    this.setData({ issueFilter: value, typeFilter: 'all' }, () => this.refreshAvailableFilters(true));
  },
  changeTypeFilter(event) {
    const value = event.currentTarget.dataset.filter;
    if (!value || value === this.data.typeFilter) return;
    this.setData({ typeFilter: value }, () => this.applyFilter(true));
  },
  loadMore() { this.loadedCount += 50; this.applyFilter(false); },

  addAllAbnormalToBank() {
    if (this.data.source !== 'draft' || this.data.savingAll) return;
    const draft = getApp().globalData.importDraft;
    if (!draft) { wx.showModal({ title: '导入数据已失效', content: '请重新导入源文件。', showCancel: false }); return; }
    const abnormalCount = this.data.counts.abnormal || 0;
    wx.showModal({ title: '全部加入题库', content: `将保留当前识别结果，把 ${abnormalCount} 道异常题连同正常题一起保存到题库。异常标记仍会保留，之后可以继续在题库中修改。`, confirmText: '全部加入',
      success: res => { if (!res.confirm) return; this.setData({ savingAll: true }); getApp().globalData.saveImportDraftRequested = true; wx.navigateBack(); } });
  },

  edit(event) {
    const originalIndex = Number(event.currentTarget.dataset.index);
    const item = this.allQuestions.find(question => question.originalIndex === originalIndex);
    if (!item) return;
    const query = this.data.source === 'draft' ? `source=draft&index=${originalIndex}` : `source=bank&bankId=${this.data.bankId}&questionId=${item.id}`;
    wx.navigateTo({ url: `/pages/editor/editor?${query}` });
  }
});
