const bankStorage = require('../../services/bank-storage');
const recordStorage = require('../../services/record-storage');

Page({
  data: {
    groups: []
  },

  onShow() {
    const groups = bankStorage.listBanks().map(bank => {
      const wrong = recordStorage.getWrong(bank.id);
      const count = Object.values(wrong).filter(item => !item.mastered).length;
      return { id: bank.id, name: bank.name, count };
    }).filter(item => item.count > 0);
    this.setData({ groups });
  },

  start(event) {
    const bankId = event.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/practice-config/practice-config?bankId=${bankId}&mode=wrong`
    });
  }
});
