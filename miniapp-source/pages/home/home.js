const bankStorage = require('../../services/bank-storage');
const statisticsService = require('../../services/statistics-service');
const recordStorage = require('../../services/record-storage');
const { decorateBank } = require('../../utils/bank-display');

Page({
  data: {
    summary: {},
    recentBanks: []
  },

  onShow() {
    this.refresh();
    this.offerExamResume();
  },

  offerExamResume() {
    if (this.examResumePrompted) return;
    const draft = recordStorage.getExamDraft();
    if (!draft || !draft.session) return;
    this.examResumePrompted = true;
    const session = draft.session;
    const answered = (session.questions || []).filter(question => question.type === 'short'
      ? Boolean(session.shortAnswers && session.shortAnswers[question.id])
      : Boolean(session.answers && session.answers[question.id] && session.answers[question.id].length)).length;
    wx.showModal({
      title: '发现未完成的模拟考试',
      content: `${session.bankName || '题库'} · 已答 ${answered}/${(session.questions || []).length} 题。考试计时按原进度继续；进入题目编辑期间不计时。`,
      confirmText: '继续考试',
      cancelText: '放弃考试',
      success: result => {
        if (result.confirm) {
          getApp().globalData.currentSession = session;
          wx.navigateTo({ url: '/pages/exam/exam' });
        } else {
          recordStorage.clearExamDraft();
          wx.showToast({ title: '已放弃未完成考试', icon: 'none' });
        }
      }
    });
  },

  refresh() {
    const banks = bankStorage.listBanks();
    this.setData({
      summary: statisticsService.summary(),
      recentBanks: banks.slice(0, 3).map(decorateBank)
    });
  },

  goBanks() {
    wx.navigateTo({ url: '/pages/banks/banks' });
  },

  goImport() {
    wx.navigateTo({ url: '/pages/import/import' });
  },

  goStatistics() {
    wx.navigateTo({ url: '/pages/statistics/statistics' });
  },

  goWrong() {
    wx.navigateTo({ url: '/pages/wrong/wrong' });
  },

  goFavorites() {
    wx.navigateTo({ url: '/pages/favorites/favorites' });
  },

  goMastered() {
    wx.navigateTo({ url: '/pages/mastered/mastered' });
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  openBank(event) {
    const id = event.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/bank-detail/bank-detail?bankId=${id}` });
  },

  installDemo() {
    wx.showModal({
      title: '安装示例题库',
      content: '将安装4道示例题，用于测试刷题、错题和收藏功能。',
      success: res => {
        if (!res.confirm) return;
        try {
          const manifest = bankStorage.installDemoBank();
          wx.showToast({ title: '安装成功', icon: 'success' });
          this.refresh();
          setTimeout(() => {
            wx.navigateTo({ url: `/pages/bank-detail/bank-detail?bankId=${manifest.id}` });
          }, 400);
        } catch (error) {
          wx.showModal({ title: '安装失败', content: error.message || String(error), showCancel: false });
        }
      }
    });
  }
});
