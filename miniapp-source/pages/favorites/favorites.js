const bankStorage = require('../../services/bank-storage');
const recordStorage = require('../../services/record-storage');
const practiceService = require('../../services/practice-service');

Page({
  data: { groups: [] },

  onShow() {
    const groups = bankStorage.listBanks().map(bank => ({
      id: bank.id,
      name: bank.name,
      count: recordStorage.getFavoriteIds(bank.id).length
    })).filter(item => item.count > 0);
    this.setData({ groups });
  },

  start(event) {
    const bankId = event.currentTarget.dataset.id;
    const bank = bankStorage.getManifest(bankId);
    try {
      const session = practiceService.createSession({
        bankId,
        bankName: bank.name,
        mode: 'favorites',
        type: 'all',
        count: 0
      });
      if (!session.questions.length) throw new Error('没有收藏题目');
      getApp().globalData.currentSession = session;
      wx.navigateTo({ url: '/pages/practice/practice' });
    } catch (error) {
      wx.showModal({ title: '无法开始', content: error.message || String(error), showCancel: false });
    }
  }
});
