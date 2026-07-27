const bankStorage = require('./services/bank-storage');
const recordStorage = require('./services/record-storage');

App({
  globalData: {
    importDraft: null,
    saveImportDraftRequested: false,
    currentSession: null,
    resultData: null
  },

  onLaunch() {
    try {
      bankStorage.initStorage();
      recordStorage.initDefaults();
    } catch (error) {
      console.error('初始化本地存储失败', error);
    }
  }
});
