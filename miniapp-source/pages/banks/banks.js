const bankStorage = require('../../services/bank-storage');
const recordStorage = require('../../services/record-storage');
const { formatDate, formatBytes } = require('../../utils/text');
const { decorateBank } = require('../../utils/bank-display');

Page({
  data: {
    banks: [],
    totalSizeText: '0 B'
  },

  onShow() {
    this.load();
  },

  load() {
    const banks = bankStorage.listBanks().map(item => {
      const sizeBytes = bankStorage.getBankSize(item.id);
      return decorateBank({
        ...item,
        sizeBytes,
        sizeText: formatBytes(sizeBytes),
        updatedText: formatDate(item.updatedAt)
      });
    });
    this.setData({
      banks,
      totalSizeText: formatBytes(banks.reduce((sum, item) => sum + item.sizeBytes, 0))
    });
  },

  importFile() {
    wx.navigateTo({ url: '/pages/import/import' });
  },

  installDemo() {
    try {
      bankStorage.installDemoBank();
      wx.showToast({ title: '已安装', icon: 'success' });
      this.load();
    } catch (error) {
      wx.showModal({ title: '失败', content: error.message || String(error), showCancel: false });
    }
  },

  openBank(event) {
    wx.navigateTo({
      url: `/pages/bank-detail/bank-detail?bankId=${event.currentTarget.dataset.id}`
    });
  },

  deleteBank(event) {
    const id = event.currentTarget.dataset.id;
    const bank = this.data.banks.find(item => item.id === id);
    if (!bank) return;
    wx.showModal({
      title: '删除题库并释放空间',
      content: `确定删除“${bank.name}”吗？将同时删除题目文件、图片、错题、收藏和进度，预计释放 ${bank.sizeText}。`,
      confirmText: '删除',
      confirmColor: '#b42318',
      success: res => {
        if (!res.confirm) return;
        try {
          const freed = bankStorage.deleteBank(id);
          recordStorage.clearBankRecords(id);
          wx.showToast({ title: `已释放${formatBytes(freed)}`, icon: 'none', duration: 1800 });
          this.load();
        } catch (error) {
          wx.showModal({ title: '删除失败', content: error.message || String(error), showCancel: false });
        }
      }
    });
  }
});
