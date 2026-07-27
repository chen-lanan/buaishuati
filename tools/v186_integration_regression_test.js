const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

assert.strictEqual(read('VERSION.txt').trim(), '1.8.6');
assert.strictEqual(read('miniapp-source/VERSION.txt').trim(), '1.8.6');
assert.ok(/versionCode 186/.test(read('app/build.gradle')));
assert.ok(/versionName '1\.8\.6'/.test(read('app/build.gradle')));
assert.ok(/const APP_VERSION = '1\.8\.6'/.test(read('miniapp-source/utils/constants.js')));
assert.ok(/const CURRENT_PARSER_VERSION = '1\.8\.5'/.test(read('miniapp-source/utils/constants.js')));

const practiceJs = read('miniapp-source/pages/practice/practice.js');
const practiceWxml = read('miniapp-source/pages/practice/practice.wxml');
const practiceWxss = read('miniapp-source/pages/practice/practice.wxss');
const examJs = read('miniapp-source/pages/exam/exam.js');
const examWxml = read('miniapp-source/pages/exam/exam.wxml');
const examWxss = read('miniapp-source/pages/exam/exam.wxss');
const configJs = read('miniapp-source/pages/practice-config/practice-config.js');
const configWxml = read('miniapp-source/pages/practice-config/practice-config.wxml');
const storageJs = read('miniapp-source/services/record-storage.js');

assert.ok(practiceWxml.includes('practice-sheet-controls'));
assert.ok(practiceWxml.includes('practice-sheet-number-label'));
assert.ok(practiceWxml.includes('数字框表示当前题'));
assert.ok(practiceWxml.includes('当前题不在筛选结果中'));
assert.ok(!practiceWxml.includes('外圈为当前题'));
assert.ok(practiceWxss.includes('.practice-sheet-number-label.sheet-current-marker'));
assert.ok(practiceWxss.includes('.practice-sheet-number.sheet-current { border-color: var(--sheet-type-color); box-shadow: none; outline: none; }'));
assert.ok(practiceJs.includes('scheduleQuestionSheetScroll'));
assert.ok(practiceJs.includes("this.applyQuestionSheetFilters('current')"));
assert.ok(practiceJs.includes("this.applyQuestionSheetFilters('first')"));

assert.ok(examWxml.includes('exam-sheet-controls'));
assert.ok(examWxml.includes('exam-sheet-scroll'));
assert.ok(examWxml.includes('sheet-number-label'));
assert.ok(examJs.includes('scheduleExamSheetScroll'));
assert.ok(examWxss.includes('.sheet-number-label.sheet-current-marker'));
assert.ok(examWxss.includes('.sheet-item.current { outline: none; box-shadow: none; }'));

assert.ok(configWxml.includes('继续上次随机背题'));
assert.ok(configWxml.includes('重新随机'));
assert.ok(configJs.includes('resumeQuestionSequence'));
assert.ok(configJs.includes('clearMemorizeProgressScope'));
assert.ok(storageJs.includes('randomSequences'));
assert.ok(storageJs.includes('clearMemorizeProgressScope'));

const questions = [1, 2, 3, 4].map(n => ({
  id: `q${n}`,
  order: n,
  type: 'single',
  displayTypeLabel: '单选题',
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
global.wx = { env: { USER_DATA_PATH: '/tmp/buai-v186-test' }, getStorageSync() {}, setStorageSync() {}, getFileSystemManager() { return {}; } };
const servicePath = require.resolve('../miniapp-source/services/practice-service');
delete require.cache[servicePath];
const service = require(servicePath);
Module._load = originalLoad;

assert.strictEqual(service.buildMemorizeScopeKey('sequence', 'all', 0), 'sequence|all|0');
assert.strictEqual(service.buildMemorizeScopeKey('random', 'display:单选题', 100), 'random|display:单选题|100');

const randomSequence = ['q3', 'q1', 'q4', 'q2'].map(id => {
  const q = questions.find(item => item.id === id);
  return { questionId: q.id, questionKey: service.buildQuestionProgressKey(q), questionOrder: q.order };
});
const randomSession = service.createSession({
  bankId: 'b1', bankName: '题库', mode: 'memorize', memorizeOrder: 'random',
  type: 'all', count: 0,
  resumeQuestionSequence: randomSequence,
  resumeCursor: { questionId: 'q4', questionOrder: 4, index: 2 }
});
assert.deepStrictEqual(randomSession.questions.map(item => item.id), ['q3', 'q1', 'q4', 'q2']);
assert.strictEqual(randomSession.index, 2, '随机背题应恢复同一随机序列中的当前位置');
assert.strictEqual(randomSession.optionShuffleEnabled, false, '背题模式不得打乱选项');
assert.strictEqual(randomSession.memorizeScopeKey, 'random|all|0');

const progress = {
  mode: 'memorize',
  cursors: {
    'sequence|all|0': { questionId: 'q2', index: 1 },
    'random|all|0': { questionId: 'q4', index: 2 }
  },
  randomSequences: { 'random|all|0': randomSequence }
};
assert.strictEqual(service.getMemorizeProgressCursor(progress, 'sequence', 'all', 0).questionId, 'q2');
assert.strictEqual(service.getMemorizeProgressCursor(progress, 'random', 'all', 0).questionId, 'q4');
assert.strictEqual(service.getMemorizeQuestionSequence(progress, 'random', 'all', 0).length, 4);

console.log('v1.8.6 integration regression: PASS');
