const bankStorage = require('../../services/bank-storage');
const recordStorage = require('../../services/record-storage');
const { formatDate, formatBytes } = require('../../utils/text');
const { CURRENT_PARSER_VERSION } = require('../../utils/constants');

Page({
  data: {
    bankId: '',
    manifest: null,
    wrongCount: 0,
    favoriteCount: 0,
    needsReimport: false,
    memorizeSummary: '',
    currentParserVersion: CURRENT_PARSER_VERSION,
    titleFontRpx: 31
  },

  onLoad(query) {
    this.setData({ bankId: query.bankId || '' });
  },

  onShow() {
    this.load();
  },

  load() {
    try {
      const manifest = bankStorage.getManifest(this.data.bankId);
      if (!manifest) throw new Error('题库不存在');
      const wrong = recordStorage.getWrong(this.data.bankId);
      const nameUnits = Array.from(String(manifest.name || '')).reduce((sum, char) => sum + (/[^\x00-\xff]/.test(char) ? 1 : 0.56), 0);
      const titleFontRpx = nameUnits <= 14 ? 36 : (nameUnits <= 20 ? 31 : (nameUnits <= 25 ? 27 : (nameUnits <= 32 ? 24 : 22)));
      const expectedQuestionCount = Number(manifest.expectedQuestionCount || (manifest.diagnostics || {}).expectedQuestionCount) || 0;
      const expectedGap = expectedQuestionCount ? expectedQuestionCount - Number(manifest.questionCount || 0) : 0;
      const displayTypeCounts = manifest.displayTypeCounts || {
        单选题: Number((manifest.typeCounts || {}).single) || 0,
        多选题: Number((manifest.typeCounts || {}).multiple) || 0,
        判断题: Number((manifest.typeCounts || {}).judge) || 0,
        简答题: Number((manifest.typeCounts || {}).short) || 0
      };
      const displayTypeSummary = Object.entries(displayTypeCounts)
        .filter(([, count]) => Number(count) > 0)
        .map(([label, count]) => ({ label, shortLabel: label.replace(/题$/, ''), count: Number(count) }));
      const difficultySummary = Object.entries(manifest.difficultyCounts || {})
        .filter(([, count]) => Number(count) > 0)
        .map(([label, count]) => ({ label, count: Number(count) }));
      const memorizeProgress = typeof recordStorage.getMemorizeProgress === 'function'
        ? recordStorage.getMemorizeProgress(this.data.bankId) : null;
      const cursorEntries = Object.entries((memorizeProgress && memorizeProgress.cursors) || {})
        .filter(([, cursor]) => cursor && typeof cursor === 'object')
        .sort((left, right) => Number(right[1].updatedAt || 0) - Number(left[1].updatedAt || 0));
      let memorizeSummary = '点击选择顺序背题或随机背题';
      if (cursorEntries.length) {
        const [scopeKey, cursor] = cursorEntries[0];
        const orderLabel = String(scopeKey).startsWith('random|') ? '随机背题' : '顺序背题';
        memorizeSummary = `${orderLabel} · 上次第 ${Math.max(1, Number(cursor.index || 0) + 1)} 题`;
      } else if (memorizeProgress && memorizeProgress.cursor) {
        memorizeSummary = `顺序背题 · 上次第 ${Math.max(1, Number(memorizeProgress.cursor.index || 0) + 1)} 题`;
      }
      this.setData({
        manifest: {
          ...manifest,
          displayTypeSummary,
          difficultySummary,
          expectedQuestionCount,
          expectedGap,
          sourceMissingCount: Number(manifest.sourceMissingCount || (manifest.diagnostics || {}).sourceDeclaredMissingCount) || 0,
          sourceContentQuestionCount: Number(manifest.sourceContentQuestionCount || (manifest.diagnostics || {}).sourceContentQuestionCount || manifest.questionCount) || 0,
          usableQuestionCount: Number(manifest.usableQuestionCount || 0),
          expectedGapText: expectedQuestionCount
            ? (expectedGap > 0 ? `少 ${expectedGap} 道（未定位）` : (expectedGap < 0 ? `多 ${Math.abs(expectedGap)} 道` : '数量一致'))
            : '',
          updatedText: formatDate(manifest.updatedAt),
          sizeText: formatBytes(bankStorage.getBankSize(this.data.bankId))
        },
        wrongCount: Object.values(wrong).filter(item => !item.mastered).length,
        favoriteCount: recordStorage.getFavoriteIds(this.data.bankId).length,
        memorizeSummary,
        needsReimport: !manifest.parserVersion || manifest.parserVersion !== CURRENT_PARSER_VERSION,
        titleFontRpx
      });
      wx.setNavigationBarTitle({ title: manifest.name });
    } catch (error) {
      wx.showModal({
        title: '读取失败',
        content: error.message || String(error),
        showCancel: false,
        success: () => wx.navigateBack()
      });
    }
  },

  practice(event) {
    const mode = event.currentTarget.dataset.mode || 'sequence';
    wx.navigateTo({
      url: `/pages/practice-config/practice-config?bankId=${this.data.bankId}&mode=${mode}`
    });
  },

  exam() {
    wx.navigateTo({ url: `/pages/exam-config/exam-config?bankId=${this.data.bankId}` });
  },

  search() {
    wx.navigateTo({ url: `/pages/search/search?bankId=${this.data.bankId}` });
  },

  editBank() {
    wx.navigateTo({ url: `/pages/review/review?source=bank&bankId=${this.data.bankId}&filter=all&editMode=1` });
  },

  review() {
    wx.navigateTo({ url: `/pages/review/review?source=bank&bankId=${this.data.bankId}` });
  },

  rename() {
    wx.showModal({
      title: '重命名题库',
      editable: true,
      placeholderText: '输入题库名称',
      content: this.data.manifest.name,
      success: res => {
        if (!res.confirm || !res.content.trim()) return;
        try {
          bankStorage.renameBank(this.data.bankId, res.content);
          this.load();
        } catch (error) {
          wx.showModal({ title: '失败', content: error.message || String(error), showCancel: false });
        }
      }
    });
  },

  exportBank() {
    try {
      const filePath = bankStorage.exportBank(this.data.bankId);
      if (typeof wx.shareFileMessage === 'function') {
        wx.shareFileMessage({
          filePath,
          fileName: filePath.split('/').pop(),
          fail(error) {
            if (!/cancel/i.test(error.errMsg || '')) {
              wx.showModal({
                title: '分享失败',
                content: '题库包已生成，但系统未能打开分享面板。',
                showCancel: false
              });
            }
          }
        });
      } else {
        wx.showModal({
          title: '题库包已生成',
          content: '当前系统未能打开文件分享面板。',
          showCancel: false
        });
      }
    } catch (error) {
      wx.showModal({ title: '导出失败', content: error.message || String(error), showCancel: false });
    }
  },

  deleteBank() {
    wx.showModal({
      title: '删除题库',
      content: `确定删除“${this.data.manifest.name}”吗？将移除题目、图片、错题、收藏和进度，预计释放 ${this.data.manifest.sizeText}。`,
      confirmColor: '#b42318',
      success: res => {
        if (!res.confirm) return;
        try {
          const freed = bankStorage.deleteBank(this.data.bankId);
          recordStorage.clearBankRecords(this.data.bankId);
          wx.showToast({ title: `已释放${formatBytes(freed)}`, icon: 'none', duration: 1800 });
          setTimeout(() => wx.navigateBack(), 400);
        } catch (error) {
          wx.showModal({ title: '删除失败', content: error.message || String(error), showCancel: false });
        }
      }
    });
  }
});
