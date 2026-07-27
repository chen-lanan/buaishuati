const bankStorage = require('../../services/bank-storage');
const recordStorage = require('../../services/record-storage');

const TABLE_KINDS = ['xlsx', 'xlsm', 'xltx', 'xltm', 'xls', 'ods', 'csv', 'tsv'];
const WORD_KINDS = ['docx', 'docm', 'dotx', 'dotm', 'doc', 'rtf', 'odt'];
const TEXT_KINDS = ['txt', 'md', 'markdown', 'html', 'htm'];

function parseModeText(draft = {}) {
  const kind = String(draft.kind || '').toLowerCase();
  if (TABLE_KINDS.includes(kind)) return `${kind.toUpperCase()} 表格确定性解析`;
  if (kind === 'pdf') return 'PDF 文字层坐标解析（不使用 OCR）';
  if (kind === 'doc') return 'Word 97-2003 二进制正文解析';
  if (kind === 'rtf') return 'RTF Unicode/编码解析';
  if (kind === 'odt') return 'ODT XML 正文与图片解析';
  if (TEXT_KINDS.includes(kind)) return `${kind.toUpperCase()} 文本规则解析`;
  return draft.localAIEnabled ? '规则 + 本地AI + 规则复核' : '仅规则解析';
}

function parserRouteText(draft = {}) {
  const diagnostics = draft.diagnostics || {};
  const layoutLabels = {
    'mixed-indexed': '混合序号型',
    indexed: '连续序号型',
    labeled: '标签题库型',
    'numbered-choice': '编号选择型',
    generic: '通用混合型'
  };
  const strategyLabels = { strict: '严格边界', relaxed: '宽松边界' };
  const layout = layoutLabels[diagnostics.parserLayout] || '';
  const strategy = strategyLabels[diagnostics.parserStrategy] || '';
  if (!layout && !strategy) return '';
  return `结构：${layout || '自动识别'}${strategy ? ` · 采用：${strategy}` : ''}`;
}

function sourceFragmentLabel(draft = {}) {
  const kind = String(draft.kind || '').toLowerCase();
  if (TABLE_KINDS.includes(kind)) return `原始 ${kind.toUpperCase()} 行`;
  if (kind === 'pdf') return '原始 PDF 文本片段';
  return `原始 ${kind.toUpperCase()} 文本片段`;
}

function auditExplain(draft = {}) {
  const kind = String(draft.kind || '').toLowerCase();
  if (TABLE_KINDS.includes(kind)) return '“实际读取到题目”是表格中确实存在题干的行；无法识别表头或题干为空的行会进入跳过线索，不会被强行拼成题目。';
  if (kind === 'pdf') return 'PDF 直接读取文字层、文本坐标和内嵌图片，不先转换成 Word。没有文字层的扫描页不会使用 OCR，也不会伪造题目。';
  if (kind === 'doc') return '旧版 DOC 直接读取 WordDocument 与文字片段表；无法提取的旧式图片以异常线索保留，不会伪造题干或答案。';
  return '“实际读取到题目”是源文件中确实存在正文的题目；检测到边界但正文缺失的记录会保留为不可练习异常，用于核对数量和位置。';
}

Page({
  data: {
    draft: null,
    name: '',
    saving: false,
    abnormalCount: 0,
    existingBankName: '',
    expectedCount: '',
    expectedGap: 0,
    expectedGapText: '',
    usableCount: 0,
    showAuditDetails: false
  },

  onLoad() {
    const draft = getApp().globalData.importDraft;
    if (!draft) {
      wx.showModal({
        title: '导入数据已失效',
        content: '请重新选择文件。',
        showCancel: false,
        success: () => wx.redirectTo({ url: '/pages/import/import' })
      });
      return;
    }
    this.draftRef = draft;
    this.existingBank = draft.kind !== 'qbank'
      ? bankStorage.listBanks().find(item => item.sourceName && item.sourceName === draft.sourceName)
      : null;
    const expectedCount = Number(draft.expectedQuestionCount || (draft.diagnostics || {}).expectedQuestionCount) || 0;
    this.setData({
      name: draft.name,
      existingBankName: this.existingBank ? this.existingBank.name : '',
      expectedCount: expectedCount ? String(expectedCount) : ''
    });
  },

  onShow() {
    const draft = getApp().globalData.importDraft;
    if (!draft) return;
    draft.diagnostics = Object.assign({
      sourceParagraphCount: draft.paragraphsCount || 0,
      effectiveParagraphCount: draft.paragraphsCount || 0,
      removedNoiseCount: 0,
      splitQuestionStartRepairCount: 0,
      noPunctuationBoundaryRepairCount: 0,
      sourceDeclaredMissingCount: 0,
      sourceDeclaredMissingItems: [],
      sourceDeclaredExtraCount: 0,
      sourceDeclaredExtraItems: [],
      sourceContentQuestionCount: (draft.questions || []).filter(item => !item.sourceMissingPlaceholder).length,
      accountedQuestionCount: (draft.questions || []).length,
      inferredBoundaryCount: 0,
      inlineAnswerCount: 0,
      duplicateCount: 0,
      unlabeledAnswerCount: 0,
      detectedBoundaryCount: (draft.questions || []).length,
      explicitBoundaryCount: 0,
      preservedFailedBoundaryCount: 0,
      discardedBoundaryCount: 0,
      assignedParagraphCount: 0,
      unassignedParagraphCount: 0,
      numberingGapCount: 0,
      silentLossCount: 0
    }, draft.diagnostics || {});
    this.draftRef = draft;
    draft.diagnostics.unassignedFragments = (draft.diagnostics.unassignedFragments || []).map(item => ({
      ...item,
      preview: item.text || (item.imageCount ? `图片段落（${item.imageCount} 张）` : '空白段落')
    }));
    draft.diagnostics.discardedFragments = (draft.diagnostics.discardedFragments || []).map(item => ({
      ...item,
      preview: (item.rawTexts || []).join(' / ') || (item.imageCount ? `图片题（${item.imageCount} 张）` : '没有可显示文字')
    }));
    draft.diagnostics.numberingIssues = (draft.diagnostics.numberingIssues || []).map(item => ({
      ...item,
      preview: item.message || '题号序列存在缺口'
    }));
    draft.diagnostics.sourceDeclaredMissingItems = (draft.diagnostics.sourceDeclaredMissingItems || []).map(item => ({
      ...item,
      preview: item.message || `原文缺少第 ${item.number || '?'} 题正文`
    }));
    draft.diagnostics.sourceDeclaredExtraItems = (draft.diagnostics.sourceDeclaredExtraItems || []).map(item => ({
      ...item,
      preview: item.message || `正文包含声明数量之外的第 ${item.number || '?'} 题`
    }));
    const expectedCount = Number(this.data.expectedCount || draft.expectedQuestionCount || draft.diagnostics.expectedQuestionCount) || 0;
    const questionCount = (draft.questions || []).length;
    const expectedGap = expectedCount ? expectedCount - questionCount : 0;
    this.setData({
      draft: {
        kind: draft.kind || '',
        sourceName: draft.sourceName,
        isTableFormat: TABLE_KINDS.includes(String(draft.kind || '').toLowerCase()),
        isPdf: draft.kind === 'pdf',
        isLegacyDoc: draft.kind === 'doc',
        parseModeText: parseModeText(draft),
        parserRouteText: parserRouteText(draft),
        sourceFragmentLabel: sourceFragmentLabel(draft),
        auditExplain: auditExplain(draft),
        questionCount,
        counts: draft.counts,
        diagnostics: draft.diagnostics,
        paragraphsCount: draft.paragraphsCount || 0,
        parserVersion: draft.parserVersion || '',
        localAIEnabled: Boolean(draft.localAIEnabled),
        localAIModelVersion: draft.localAIModelVersion || '',
        localAIAppliedCount: Number((draft.diagnostics || {}).localAIAppliedCount) || 0
      },
      abnormalCount: (draft.counts.warning || 0) + (draft.counts.error || 0),
      usableCount: (draft.counts.normal || 0) + (draft.counts.warning || 0),
      expectedCount: expectedCount ? String(expectedCount) : '',
      expectedGap,
      expectedGapText: expectedCount
        ? (expectedGap > 0 ? `比官方总数少 ${expectedGap} 道（未定位，不自动补题）` : (expectedGap < 0 ? `比官方总数多 ${Math.abs(expectedGap)} 道` : '与官方总数一致'))
        : ''
    }, () => {
      if (getApp().globalData.saveImportDraftRequested) {
        getApp().globalData.saveImportDraftRequested = false;
        setTimeout(() => this.save(), 50);
      }
    });
  },

  onUnload() {
    const draft = getApp().globalData.importDraft;
    if (draft && this.draftRef === draft) {
      bankStorage.cleanupDraft(draft);
      getApp().globalData.importDraft = null;
    }
  },

  onNameInput(event) { this.setData({ name: event.detail.value }); },
  onExpectedCountInput(event) {
    const raw = String(event.detail.value || '').replace(/[^0-9]/g, '').slice(0, 6);
    const expectedCount = Number(raw) || 0;
    const questionCount = this.data.draft ? Number(this.data.draft.questionCount) || 0 : 0;
    const expectedGap = expectedCount ? expectedCount - questionCount : 0;
    const draft = getApp().globalData.importDraft;
    if (draft) {
      draft.expectedQuestionCount = expectedCount;
      draft.diagnostics = Object.assign({}, draft.diagnostics || {}, {
        expectedQuestionCount: expectedCount,
        expectedCountGap: expectedGap
      });
    }
    this.setData({
      expectedCount: raw,
      expectedGap,
      expectedGapText: expectedCount
        ? (expectedGap > 0 ? `比官方总数少 ${expectedGap} 道（未定位，不自动补题）` : (expectedGap < 0 ? `比官方总数多 ${Math.abs(expectedGap)} 道` : '与官方总数一致'))
        : ''
    });
  },
  toggleAuditDetails() { this.setData({ showAuditDetails: !this.data.showAuditDetails }); },
  review() { wx.navigateTo({ url: '/pages/review/review?source=draft' }); },
  reviewFiltered(event) {
    const filter = event.currentTarget.dataset.filter || 'all';
    wx.navigateTo({ url: `/pages/review/review?source=draft&filter=${filter}` });
  },

  performSave(existingId = '') {
    const draft = getApp().globalData.importDraft;
    draft.name = this.data.name.trim() || draft.name;
    draft.expectedQuestionCount = Number(this.data.expectedCount) || 0;
    draft.diagnostics = Object.assign({}, draft.diagnostics || {}, {
      expectedQuestionCount: draft.expectedQuestionCount,
      expectedCountGap: draft.expectedQuestionCount ? draft.expectedQuestionCount - (draft.questions || []).length : 0
    });
    this.setData({ saving: true });
    wx.showLoading({ title: existingId ? '正在覆盖题库' : '正在保存', mask: true });
    setTimeout(() => {
      try {
        const manifest = bankStorage.saveBank(draft, existingId);
        if (existingId) recordStorage.clearBankRecords(existingId);
        bankStorage.cleanupDraft(draft);
        getApp().globalData.importDraft = null;
        wx.hideLoading();
        wx.showToast({ title: existingId ? '已覆盖并重新解析' : '题库已保存', icon: 'success' });
        setTimeout(() => wx.redirectTo({ url: `/pages/bank-detail/bank-detail?bankId=${manifest.id}` }), 500);
      } catch (error) {
        wx.hideLoading();
        this.setData({ saving: false });
        wx.showModal({ title: '保存失败', content: error.message || String(error), showCancel: false });
      }
    }, 30);
  },

  save() {
    if (this.data.saving) return;
    const existing = this.existingBank;
    if (!existing) { this.performSave(''); return; }
    wx.showModal({
      title: '检测到同名来源题库',
      content: `“${existing.name}”来自同一个源文件。建议覆盖旧题库，确保不再沿用旧版解析数据。覆盖会清除该题库旧的错题、收藏、进度和已掌握记录。`,
      confirmText: '覆盖旧题库',
      cancelText: '另存为新题库',
      success: result => this.performSave(result.confirm ? existing.id : '')
    });
  },

  cancel() {
    getApp().globalData.saveImportDraftRequested = false;
    const draft = getApp().globalData.importDraft;
    bankStorage.cleanupDraft(draft);
    getApp().globalData.importDraft = null;
    wx.navigateBack();
  }
});
