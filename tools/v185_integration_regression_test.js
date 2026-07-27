const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

assert.strictEqual(read('VERSION.txt').trim(), '1.8.5');
assert.strictEqual(read('miniapp-source/VERSION.txt').trim(), '1.8.5');
assert.ok(/versionCode 185/.test(read('app/build.gradle')));
assert.ok(/versionName '1\.8\.5'/.test(read('app/build.gradle')));

const practiceJs = read('miniapp-source/pages/practice/practice.js');
const practiceWxml = read('miniapp-source/pages/practice/practice.wxml');
const practiceWxss = read('miniapp-source/pages/practice/practice.wxss');
const examJs = read('miniapp-source/pages/exam/exam.js');
const examWxml = read('miniapp-source/pages/exam/exam.wxml');
const configWxml = read('miniapp-source/pages/practice-config/practice-config.wxml');
const storageJs = read('miniapp-source/services/record-storage.js');

assert.ok(practiceJs.includes('applyLatestSettings()'));
assert.ok(practiceJs.includes('this.settings = latest'));
assert.ok(practiceJs.includes('applyOptionOrderPreference'));
assert.ok(examJs.includes('applyLatestSettings()'));
assert.ok(examWxml.includes('31 * fontScale'));
assert.ok(!practiceWxml.includes('memory-tag'), '背题顶部不应再显示“背题”胶囊');
assert.ok(practiceWxml.includes('filterQuestionSheetStatus'));
assert.ok(practiceWxml.includes('filterQuestionSheetType'));
assert.ok(practiceWxml.includes('已叠加筛选'));
assert.ok(practiceWxss.includes('border: calc(4 * var(--rpx)) solid var(--sheet-type-color)'));
assert.ok(examWxml.includes('filterSheetStatus'));
assert.ok(examWxml.includes('filterSheetType'));
assert.ok(configWxml.includes('背题顺序'));
assert.ok(configWxml.includes('从上次浏览位置继续背题'));
assert.ok(storageJs.includes('saveMemorizeProgress'));
assert.ok(storageJs.includes('memorizeProgress: getMemorizeProgress'));

const questions = [1, 2, 3, 4].map(n => ({
  id: `q${n}`,
  order: n,
  type: 'single',
  displayTypeLabel: n % 2 ? '单选题' : '判断题',
  question: `题${n}`,
  options: [{ key: 'A', text: `甲${n}` }, { key: 'B', text: `乙${n}` }],
  answer: ['A'],
  status: 'normal'
}));

const mocks = {
  './bank-storage': { loadQuestions: () => JSON.parse(JSON.stringify(questions)) },
  './record-storage': {
    getMasteredIds: () => [],
    getSettings: () => ({ shuffleOptions: true }),
    getWrong: () => ({}),
    getFavoriteIds: () => []
  }
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent && /practice-service\.js$/.test(parent.filename) && mocks[request]) return mocks[request];
  return originalLoad.call(this, request, parent, isMain);
};
global.wx = { env: { USER_DATA_PATH: '/tmp/buai-v185-test' }, getStorageSync() {}, setStorageSync() {}, getFileSystemManager() { return {}; } };
const servicePath = require.resolve('../miniapp-source/services/practice-service');
delete require.cache[servicePath];
const service = require(servicePath);
Module._load = originalLoad;

const memorize = service.createSession({
  bankId: 'b1', bankName: '题库', mode: 'memorize', memorizeOrder: 'sequence',
  type: 'all', count: 0,
  resumeCursor: { questionId: 'q3', questionOrder: 3, index: 2 }
});
assert.strictEqual(memorize.index, 2, '顺序背题应恢复到保存题目');
assert.strictEqual(memorize.optionShuffleEnabled, false, '背题模式不应打乱选项');
assert.ok(memorize.questions.every(q => !q.optionOrderShuffled));

const canonical = questions[0];
const shuffled = service.shuffleQuestionOptions(canonical);
assert.ok(shuffled.optionOrderOriginal, '打乱后必须保留原选项快照以支持即时恢复');
const restored = service.restoreQuestionOptionOrder(shuffled);
assert.deepStrictEqual(restored.options, canonical.options);
assert.deepStrictEqual(restored.answer, canonical.answer);

const touched = { ...shuffled };
const applied = service.applyOptionOrderPreference([touched], false, { q1: ['A'] }, {});
assert.strictEqual(applied[0], touched, '已有选择的题不得在设置返回时重排');

console.log('v1.8.5 integration regression: PASS');
