const bankStorage = require('../../services/bank-storage');
const practiceService = require('../../services/practice-service');

Page({
  data: {
    bankId: '',
    manifest: null,
    countOptions: [10, 20, 50, 100],
    countLabels: ['10题', '20题', '50题', '100题'],
    countIndex: 1,
    durationOptions: [10, 20, 30, 60, 90],
    durationLabels: ['10分钟', '20分钟', '30分钟', '60分钟', '90分钟'],
    durationIndex: 2,
    includeShort: false
  },

  onLoad(query) {
    this.setData({
      bankId: query.bankId,
      manifest: bankStorage.getManifest(query.bankId)
    });
  },

  onCountChange(event) {
    this.setData({ countIndex: Number(event.detail.value) });
  },

  onDurationChange(event) {
    this.setData({ durationIndex: Number(event.detail.value) });
  },

  onIncludeShort(event) {
    this.setData({ includeShort: event.detail.value });
  },

  start() {
    try {
      const count = this.data.countOptions[this.data.countIndex];
      const durationMinutes = this.data.durationOptions[this.data.durationIndex];
      const session = practiceService.createSession({
        bankId: this.data.bankId,
        bankName: this.data.manifest.name,
        mode: 'exam',
        type: 'all',
        count: 0,
        durationMinutes
      });

      if (!this.data.includeShort) {
        session.questions = session.questions.filter(item => item.type !== 'short');
      }
      session.questions = session.questions.slice(0, count);

      if (!session.questions.length) {
        wx.showModal({ title: '没有可考试题目', content: '当前题库没有符合条件的题目。', showCancel: false });
        return;
      }

      getApp().globalData.currentSession = session;
      wx.navigateTo({ url: '/pages/exam/exam' });
    } catch (error) {
      wx.showModal({ title: '无法开始考试', content: error.message || String(error), showCancel: false });
    }
  }
});
