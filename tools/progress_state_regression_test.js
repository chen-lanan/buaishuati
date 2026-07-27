const assert = require('assert');

global.wx = {
  env: { USER_DATA_PATH: '/tmp/buai-test' },
  getStorageSync() { return null; },
  setStorageSync() {},
  getFileSystemManager() { return {}; }
};

const service = require('../miniapp-source/services/practice-service');

const questions = [
  { id: 'q1', order: 1, type: 'single', category: 'A', question: '第一题', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answer: ['A'] },
  { id: 'q2', order: 2, type: 'multiple', category: 'A', question: '第二题', options: [{ key: 'A', text: '一' }, { key: 'B', text: '二' }, { key: 'C', text: '三' }], answer: ['A', 'C'] },
  { id: 'q3', order: 3, type: 'short', category: 'B', question: '第三题', options: [], answerText: '参考答案' }
];

const session = {
  questions,
  answers: { q1: ['B'], q2: ['A', 'C'] },
  results: { q1: { correct: false }, q2: { correct: true }, q3: { correct: false, revealed: true } }
};
const states = service.buildPersistedQuestionStates(session);
assert.strictEqual(states.length, 3, '应保存已选择或已显示答案的题');

const restored = service.restoreQuestionStates(questions, states);
assert.deepStrictEqual(restored.answers.q1, ['B']);
assert.deepStrictEqual(restored.answers.q2, ['A', 'C']);
assert.strictEqual(restored.results.q1.correct, false);
assert.strictEqual(restored.results.q2.correct, true);
assert.strictEqual(restored.results.q3.revealed, true);

// 覆盖导入后 ID 变化，仍按稳定键和 order 恢复。
const reimported = questions.map(q => ({ ...q, id: `new-${q.id}` }));
const restoredAfterImport = service.restoreQuestionStates(reimported, states);
assert.deepStrictEqual(restoredAfterImport.answers['new-q1'], ['B']);
assert.strictEqual(restoredAfterImport.results['new-q3'].revealed, true);

// 选项乱序后按选项正文恢复，不沿用旧字母。
const shuffled = [{
  ...reimported[0],
  options: [{ key: 'A', text: '乙' }, { key: 'B', text: '甲' }],
  answer: ['B']
}];
const shuffledRestore = service.restoreQuestionStates(shuffled, [states[0]]);
assert.deepStrictEqual(shuffledRestore.answers['new-q1'], ['A']);
assert.strictEqual(shuffledRestore.results['new-q1'].correct, false);

// 重复题干按 order 选择最近位置，不回退到前面的重复题。
const duplicateQuestions = [
  { ...questions[0], id: 'dup1', order: 6, question: '重复题' },
  { ...questions[0], id: 'dup2', order: 8, question: '重复题' }
];
const duplicateState = [{
  questionId: 'old',
  questionKey: service.buildQuestionProgressKey(duplicateQuestions[1]),
  questionOrder: 8,
  selected: ['A'],
  selectedTexts: ['甲'],
  result: { correct: true }
}];
const duplicateRestore = service.restoreQuestionStates(duplicateQuestions, duplicateState);
assert.strictEqual(duplicateRestore.results.dup1, undefined);
assert.strictEqual(duplicateRestore.results.dup2.correct, true);



// 当前筛选范围外的历史答案必须保留，范围内状态以当前会话为准。
const merged = service.mergePersistedQuestionStates(
  [states[0], states[1]],
  [{ ...states[1], result: { correct: false } }],
  [questions[1]]
);
assert.strictEqual(merged.length, 2);
assert.strictEqual(merged.find(item => item.questionId === 'q1').result.correct, false);
assert.strictEqual(merged.find(item => item.questionId === 'q2').result.correct, false);

// 正确答案变化后按当前题库重新判定，不沿用旧 correct。
const answerChanged = [{ ...reimported[0], answer: ['B'] }];
const changedAnswerRestore = service.restoreQuestionStates(answerChanged, [states[0]]);
assert.strictEqual(changedAnswerRestore.results['new-q1'].correct, true);

// 同顺序号但题干已变时，不把旧答案误套到新题。
const changedQuestion = [{ ...reimported[0], question: '已经改成另一道题' }];
const changedRestore = service.restoreQuestionStates(changedQuestion, [states[0]]);
assert.deepStrictEqual(changedRestore, { answers: {}, results: {} });

// 空状态不会产生伪答案。
const empty = service.restoreQuestionStates(questions, []);
assert.deepStrictEqual(empty, { answers: {}, results: {} });



// v1.6.7：继续位置只由已完成题决定，停留或浏览位置不参与。
assert.strictEqual(service.getQuestionAnswerStatus(questions[0], restored.results.q1), 'wrong');
assert.strictEqual(service.getQuestionAnswerStatus(questions[1], restored.results.q2), 'correct');
assert.strictEqual(service.getQuestionAnswerStatus(questions[2], restored.results.q3), 'unanswered', '简答题只查看答案但未自评仍是未答');
assert.strictEqual(service.findResumeIndexAfterCompletion(questions, restored.results, 2), 2, '做完第2题后应进入第3题');

const tenQuestions = Array.from({ length: 10 }, (_, index) => ({
  id: `t${index + 1}`, order: index + 1, type: 'single', category: 'T', question: `第${index + 1}题`,
  options: [{ key: 'A', text: '对' }, { key: 'B', text: '错' }], answer: ['A']
}));
const completedToEight = {};
for (let index = 0; index < 8; index += 1) completedToEight[`t${index + 1}`] = { correct: true };
assert.strictEqual(service.getFurthestCompletedOrder(tenQuestions, completedToEight), 8);
assert.strictEqual(service.findResumeIndexAfterCompletion(tenQuestions, completedToEight, 8), 8, '完成第8题后应进入第9题');
// 即使退出前翻回第6题，完成序号仍为8，不得倒退。
assert.strictEqual(service.findResumeIndexAfterCompletion(tenQuestions, completedToEight, 8), 8);
completedToEight.t10 = { correct: false };
assert.strictEqual(service.findResumeIndexAfterCompletion(tenQuestions, completedToEight, 10), 8, '跨题做完第10题后应回到最早未答的第9题');
assert.strictEqual(service.buildPracticeScopeKey('multiple', 50), 'multiple|50');
const scoped = { cursors: { 'multiple|50': { lastCompletedOrder: 20, questionId: 'x' } } };
assert.strictEqual(service.getProgressCursor(scoped, 'multiple', 50).lastCompletedOrder, 20);
assert.strictEqual(service.getProgressCursor(scoped, 'all', 0), null);

console.log('progress state regression: PASS');
