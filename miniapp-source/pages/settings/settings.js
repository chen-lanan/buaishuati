const recordStorage = require('../../services/record-storage');
const bankStorage = require('../../services/bank-storage');
const { formatBytes } = require('../../utils/text');

Page({
  data: {
    settings: {
      appearanceMode: 'system',
      amoledBlack: false,
      monetTheme: 'ocean',
      fontScale: 1,
      answerBottomLift: 48,
      autoNext: false,
      autoNextDelay: 500,
      immersivePractice: true,
      shuffleOptions: false,
      resetWrongOnRestart: true
    },
    appearanceOptions: [
      { value: 'system', label: '跟随系统', icon: '◐' },
      { value: 'light', label: '浅色', icon: '☀' },
      { value: 'dark', label: '深色', icon: '☾' }
    ],
    themeOptions: [
      { value: 'ocean', label: '湖海蓝' },
      { value: 'violet', label: '鸢尾紫' },
      { value: 'mint', label: '薄荷绿' },
      { value: 'rose', label: '雾粉' },
      { value: 'amber', label: '暖金' }
    ],
    delayOptions: [500, 1000, 2000, 3000, 5000],
    delayLabels: ['0.5秒', '1秒', '2秒', '3秒', '5秒'],
    delayIndex: 0,
    optionOrderOptions: [false, true],
    optionOrderLabels: ['固定', '打乱'],
    optionOrderIndex: 0,
    storage: {
      bankText: '0 B',
      recordText: '0 B',
      importText: '0 B',
      pickedCacheText: '0 B',
      exportText: '0 B',
      backupText: '0 B',
      unusedText: '0 B',
      totalText: '0 B'
    }
  },

  onLoad() {
    const settings = recordStorage.getSettings();
    const delayIndex = Math.max(0, this.data.delayOptions.indexOf(Number(settings.autoNextDelay)));
    const optionOrderIndex = settings.shuffleOptions ? 1 : 0;
    this.setData({ settings, delayIndex, optionOrderIndex });
  },

  onShow() {
    this.refreshStorage();
  },

  refreshStorage() {
    const summary = bankStorage.getStorageSummary();
    this.setData({
      storage: {
        bankText: formatBytes(summary.bankBytes),
        recordText: formatBytes(summary.recordBytes),
        importText: formatBytes(summary.importBytes),
        pickedCacheText: formatBytes(summary.pickedCacheBytes || 0),
        exportText: formatBytes(summary.exportBytes),
        backupText: formatBytes(summary.backupBytes),
        unusedText: formatBytes(summary.reclaimableBytes || 0),
        totalText: formatBytes(summary.bankBytes + summary.recordBytes + summary.importBytes + summary.exportBytes + summary.backupBytes)
      }
    });
  },


  onAppearancePick(event) {
    const value = String(event.currentTarget.dataset.value || 'system');
    if (!['system', 'light', 'dark'].includes(value)) return;
    this.setData({ 'settings.appearanceMode': value });
    this.save();
    if (typeof window.__applyAppTheme === 'function') window.__applyAppTheme();
  },

  onAmoledChange(event) {
    this.setData({ 'settings.amoledBlack': Boolean(event.detail.value) });
    this.save();
    if (typeof window.__applyAppTheme === 'function') window.__applyAppTheme();
  },

  onThemePick(event) {
    const value = String(event.currentTarget.dataset.value || 'ocean');
    if (!['ocean', 'violet', 'mint', 'rose', 'amber'].includes(value)) return;
    this.setData({ 'settings.monetTheme': value });
    this.save();
    if (typeof window.__applyAppTheme === 'function') window.__applyAppTheme();
  },

  onFontChange(event) {
    const value = Number(event.detail.value);
    this.setData({ 'settings.fontScale': value });
    this.save();
  },

  onAnswerBottomLiftChange(event) {
    const value = Math.max(0, Math.min(120, Number(event.detail.value) || 0));
    this.setData({ 'settings.answerBottomLift': value });
    this.save();
  },

  onAutoNext(event) {
    this.setData({ 'settings.autoNext': event.detail.value });
    this.save();
  },

  onImmersiveChange(event) {
    this.setData({ 'settings.immersivePractice': Boolean(event.detail.value) });
    this.save();
    if (typeof window.__syncPracticeChrome === 'function') window.__syncPracticeChrome();
  },

  onDelayChange(event) {
    const delayIndex = Number(event.detail.value);
    this.setData({
      delayIndex,
      'settings.autoNextDelay': this.data.delayOptions[delayIndex]
    });
    this.save();
  },

  onOptionOrderChange(event) {
    const optionOrderIndex = Number(event.detail.value) === 1 ? 1 : 0;
    this.setData({
      optionOrderIndex,
      'settings.shuffleOptions': Boolean(this.data.optionOrderOptions[optionOrderIndex])
    });
    this.save();
    wx.showToast({ title: optionOrderIndex ? '选项将智能打乱' : '选项保持原顺序', icon: 'none' });
  },

  onResetWrongChange(event) {
    this.setData({ 'settings.resetWrongOnRestart': Boolean(event.detail.value) });
    this.save();
    wx.showToast({
      title: event.detail.value ? '从头练习时重置错题' : '错题将持续累计',
      icon: 'none'
    });
  },

  onLocalAIChange(event) {
    this.setData({ 'settings.useLocalAI': Boolean(event.detail.value) });
    this.save();
    wx.showToast({
      title: event.detail.value ? '本地AI已开启' : '本地AI已关闭',
      icon: 'none'
    });
  },

  save() {
    recordStorage.saveSettings(this.data.settings);
  },

  cleanUnused() {
    wx.showModal({
      title: '智能清理无用文件',
      content: `当前预计可释放 ${this.data.storage.unusedText}。将清理系统文件选择缓存、解析工作副本、旧版原文件副本、未被题目引用的图片、失败或中断留下的临时目录，以及已删除题库的残留记录；不会删除有效题目、正在使用的图片、学习记录、导出题库或完整备份。`,
      confirmText: '开始清理',
      success: res => {
        if (!res.confirm) return;
        wx.showLoading({ title: '正在深度清理', mask: true });
        setTimeout(() => {
          try {
            const result = bankStorage.cleanupUnusedFiles();
            wx.hideLoading();
            const recovered = result.recoveredBankCount ? `，恢复 ${result.recoveredBankCount} 个索引` : '';
            wx.showToast({ title: `已释放${formatBytes(result.freedBytes)}${recovered}`, icon: 'none', duration: 2200 });
            this.refreshStorage();
          } catch (error) {
            wx.hideLoading();
            wx.showModal({ title: '清理失败', content: error.message || String(error), showCancel: false });
          }
        }, 30);
      }
    });
  },

  cleanTemporary() { this.cleanUnused(); },

  cleanExports() {
    wx.showModal({
      title: '清理本地导出副本',
      content: `当前导出副本占用 ${this.data.storage.exportText}。已发送到文件传输助手的文件不受影响。`,
      success: res => {
        if (!res.confirm) return;
        const freed = bankStorage.cleanupExportFiles();
        wx.showToast({ title: `已释放${formatBytes(freed)}`, icon: 'none' });
        this.refreshStorage();
      }
    });
  },

  goBanks() {
    wx.navigateTo({ url: '/pages/banks/banks' });
  },

  cleanBackups() {
    wx.showModal({
      title: '清理完整备份文件',
      content: `当前完整备份占用 ${this.data.storage.backupText}。请确认已经把需要保留的备份发送到外部文件夹。`,
      success: res => {
        if (!res.confirm) return;
        const freed = bankStorage.cleanupBackupFiles();
        wx.showToast({ title: `已释放${formatBytes(freed)}`, icon: 'none' });
        this.refreshStorage();
      }
    });
  },


  createBackup() {
    wx.showLoading({ title: '正在生成完整备份', mask: true });
    setTimeout(() => {
      try {
        const path = bankStorage.createFullBackup();
        wx.hideLoading();
        wx.shareFileMessage({
          filePath: path,
          fail: error => wx.showModal({ title: '备份已生成', content: `文件已保存在本机：${path}\n${error && error.message ? error.message : ''}`, showCancel: false })
        });
      } catch (error) {
        wx.hideLoading();
        wx.showModal({ title: '备份失败', content: error.message || String(error), showCancel: false });
      }
    }, 30);
  },

  async restoreBackup() {
    const importer = require('../../services/docx-importer');
    let file = null;
    const release = () => {
      importer.releasePickedFile(file);
      file = null;
    };
    try {
      file = await importer.chooseFile();
      if (!/\.buaiquiz$/i.test(file.name || '')) throw new Error('请选择 .buaiquiz 完整备份文件');
      wx.showModal({
        title: '恢复完整备份',
        content: '恢复会替换当前全部题库、错题、收藏、进度、统计和设置。建议先备份当前数据。确定继续吗？',
        confirmText: '替换并恢复',
        confirmColor: '#b42318',
        success: result => {
          if (!result.confirm) { release(); return; }
          wx.showLoading({ title: '正在恢复', mask: true });
          setTimeout(() => {
            try {
              const summary = bankStorage.restoreFullBackup(file.path, true);
              wx.hideLoading();
              wx.showModal({ title: '恢复完成', content: `已恢复 ${summary.bankCount} 个题库。应用将刷新首页。`, showCancel: false, success: () => wx.reLaunch({ url: '/pages/home/home' }) });
            } catch (error) {
              wx.hideLoading();
              wx.showModal({ title: '恢复失败', content: error.message || String(error), showCancel: false });
            } finally {
              release();
            }
          }, 30);
        }
      });
    } catch (error) {
      release();
      if (!/cancel/i.test(error.message || error.errMsg || '')) wx.showModal({ title: '选择失败', content: error.message || String(error), showCancel: false });
    }
  },
  clearRecords() {
    wx.showModal({
      title: '清除学习记录',
      content: '将删除错题、收藏、练习进度和统计，但不会删除题库文件。确定继续吗？',
      confirmColor: '#b42318',
      success: res => {
        if (!res.confirm) return;
        recordStorage.clearLearningRecords();
        wx.showToast({ title: '已清除', icon: 'success' });
      }
    });
  },


  goAbout() {
    wx.navigateTo({ url: '/pages/about/about' });
  }
});
