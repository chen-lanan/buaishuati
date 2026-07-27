Page({
  data: {
    result: null,
    durationText: ''
  },

  onLoad() {
    const result = getApp().globalData.resultData;
    if (!result) {
      wx.showModal({
        title: '结果已失效',
        content: '请重新开始练习。',
        showCancel: false,
        success: () => wx.reLaunch({ url: '/pages/home/home' })
      });
      return;
    }
    const minutes = Math.floor(result.duration / 60);
    const seconds = result.duration % 60;
    this.setData({
      result,
      durationText: `${minutes}分${seconds}秒`
    });
  },

  backHome() {
    getApp().globalData.currentSession = null;
    getApp().globalData.resultData = null;
    wx.reLaunch({ url: '/pages/home/home' });
  },

  reviewExam() {
    const session = getApp().globalData.currentSession;
    if (!session || !session.exam) {
      wx.showToast({ title: '本次试卷已失效', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/exam-review/exam-review' });
  },

  reviewWrong() {
    const session = getApp().globalData.currentSession;
    if (!session) return;
    wx.redirectTo({
      url: `/pages/practice-config/practice-config?bankId=${session.bankId}&mode=wrong`
    });
  }
});
