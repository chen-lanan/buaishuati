const assert = require('assert');
const Module = require('module');
let currentProgress = { questionId: 'q6', index: 5, lastCompletedOrder: 5, questionStates: [{ questionId: 'q1' }] };
let cleared = false;
let capturedConfig = null;
const mocks = {
  '../../services/bank-storage': { getManifest: () => ({ name: '测试题库' }), loadQuestions: () => [
    { type: 'single', displayTypeLabel: '单选题', status: 'normal' },
    { type: 'short', displayTypeLabel: '填空题', status: 'normal' },
    { type: 'short', displayTypeLabel: '画图题', status: 'warning' }
  ] },
  '../../services/practice-service': {
    createSession: config => { capturedConfig = config; return { questions: [{}] }; },
    getProgressCursor: progress => progress ? { lastCompletedOrder: progress.lastCompletedOrder || 0, questionId: progress.questionId || '', index: progress.index || 0 } : null,
    getMemorizeProgressCursor: () => null,
    getMemorizeQuestionSequence: () => [],
    buildMemorizeScopeKey: (order, type, count) => `${order}|${type}|${count}`,
    buildPracticeScopeKey: (type, count) => `${type}|${count}`
  },
  '../../services/record-storage': {
    getProgress: () => currentProgress,
    getMemorizeProgress: () => null,
    getSettings: () => ({ resetWrongOnRestart: false }),
    clearProgressForBank: () => { cleared = true; currentProgress = null; return true; },
    getWrong: () => ({}),
    clearWrongForBank() {}
  }
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (mocks[request]) return mocks[request];
  return originalLoad.call(this, request, parent, isMain);
};
let pageDefinition;
global.Page = definition => { pageDefinition = definition; };
global.wx = {
  env: { USER_DATA_PATH: '/tmp/buaiquiz-test' },
  navigateTo() {},
  showModal() {},
  showToast() {}
};
global.getApp = () => ({ globalData: {} });
require('../miniapp-source/pages/practice-config/practice-config');
Module._load = originalLoad;

function createPage() {
  const page = Object.assign({}, pageDefinition);
  page.data = JSON.parse(JSON.stringify(pageDefinition.data));
  page.setData = patch => Object.assign(page.data, patch);
  return page;
}

const page = createPage();
page.onLoad({ bankId: 'bank1', mode: 'sequence' });
assert.strictEqual(page.data.progress.questionId, 'q6');
assert.deepStrictEqual(page.data.typeOptions.map(item => item.label), ['全部题型', '单选题', '填空题', '异常题']);
currentProgress = { questionId: 'q9', index: 8, lastCompletedOrder: 8, questionStates: [{ questionId: 'q1' }, { questionId: 'q2' }] };
page.onShow();
assert.strictEqual(page.data.progress.questionId, 'q9', '返回配置页必须刷新到最后完成题的下一题');
assert.strictEqual(page.data.progress.questionStates.length, 2);

page.data.resume = false;
page.start();
assert.strictEqual(cleared, true, '关闭继续进度必须清除位置和答案状态');
assert.strictEqual(capturedConfig.resumeCursor, null);
assert.deepStrictEqual(capturedConfig.resumeQuestionStates, []);
console.log('practice config lifecycle: PASS (6 assertions)');
