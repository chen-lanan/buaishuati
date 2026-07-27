'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const sourceRoot = path.resolve(process.argv[2] || path.resolve(__dirname, '..'));
global.wx = { env: { USER_DATA_PATH: '/tmp/buaiquiz-test' }, getFileSystemManager: () => ({}) };
const practiceService = require(path.join(sourceRoot, 'miniapp-source/services/practice-service'));

const base = {
  id: 'q1', type: 'single', displayTypeLabel: '单选题', question: '测试题',
  category: '第一章', difficulty: '中等', analysis: '旧解析', images: [],
  options: [{ key: 'A', text: '红', images: [] }, { key: 'B', text: '蓝', images: [] }],
  answer: ['B'], answerText: ''
};
const metadataOnly = { ...base, category: '第二章', difficulty: '困难', analysis: '新解析' };
assert.strictEqual(
  practiceService.buildQuestionEditSignature(base),
  practiceService.buildQuestionEditSignature(metadataOnly),
  '分类、难度和解析变化不应清除当前作答'
);
assert.notStrictEqual(
  practiceService.buildQuestionEditSignature(base),
  practiceService.buildQuestionEditSignature({ ...base, question: '修改后的题干' }),
  '题干变化必须视为作答内容变化'
);
assert.deepStrictEqual(
  practiceService.remapSelectedOptions(
    { ...base, options: [{ key: 'A', text: '蓝', images: [] }, { key: 'B', text: '红', images: [] }] },
    base,
    ['A']
  ),
  ['B'],
  '编辑返回时必须按选项内容恢复乱序后的选择'
);

const practiceTemplate = fs.readFileSync(path.join(sourceRoot, 'miniapp-source/pages/practice/practice.wxml'), 'utf8');
const examTemplate = fs.readFileSync(path.join(sourceRoot, 'miniapp-source/pages/exam/exam.wxml'), 'utf8');
const practiceStyle = fs.readFileSync(path.join(sourceRoot, 'miniapp-source/pages/practice/practice.wxss'), 'utf8');
const examStyle = fs.readFileSync(path.join(sourceRoot, 'miniapp-source/pages/exam/exam.wxss'), 'utf8');
const practiceScript = fs.readFileSync(path.join(sourceRoot, 'miniapp-source/pages/practice/practice.js'), 'utf8');
const examScript = fs.readFileSync(path.join(sourceRoot, 'miniapp-source/pages/exam/exam.js'), 'utf8');

assert.ok(practiceTemplate.indexOf('difficulty-tag') < practiceTemplate.indexOf('sheet-open-btn'));
assert.ok(practiceTemplate.indexOf('sheet-open-btn') < practiceTemplate.indexOf('edit-question-btn'));
assert.ok(examTemplate.indexOf('difficulty-tag') < examTemplate.indexOf('sheet-button'));
assert.ok(examTemplate.indexOf('sheet-button') < examTemplate.indexOf('edit-question-btn'));
assert.ok(/\.topbar\s*\{[\s\S]*?flex-wrap:\s*nowrap/.test(practiceStyle) && practiceTemplate.includes('topbar-scroll'), '练习顶部必须使用单行横向滚动');
assert.ok(/\.exam-top\s*\{[\s\S]*?flex-wrap:\s*wrap/.test(examStyle), '考试顶部必须动态换行');
assert.ok(/source=bank&bankId=/.test(practiceScript), '练习页编辑必须打开已保存题库题目');
assert.ok(/source=bank&bankId=/.test(examScript), '考试页编辑必须打开已保存题库题目');
assert.ok(/refreshEditedQuestion\(\)/.test(practiceScript) && /refreshEditedQuestion\(\)/.test(examScript), '返回后必须动态刷新当前题');

let storedQuestion = JSON.parse(JSON.stringify(base));
let navigatedUrl = '';
const recordStorageMock = {
  isFavorite: () => false,
  isMastered: () => false,
  getProgress: () => null,
  getSettings: () => ({ fontScale: 1, answerBottomLift: 48 }),
  saveProgress: () => true
};
const bankStorageMock = { loadQuestions: () => [JSON.parse(JSON.stringify(storedQuestion))] };
const pagePracticeServiceMock = Object.assign({}, practiceService, {
  getQuestionAnswerStatus: () => 'unanswered'
});
const mocks = {
  '../../services/bank-storage': bankStorageMock,
  '../../services/record-storage': recordStorageMock,
  '../../services/practice-service': pagePracticeServiceMock,
  '../../utils/constants': { QUESTION_TYPES: { single: '单选题', multiple: '多选题', judge: '判断题', short: '简答题' } }
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (mocks[request]) return mocks[request];
  return originalLoad.call(this, request, parent, isMain);
};
let pageDefinition;
global.Page = definition => { pageDefinition = definition; };
global.wx = {
  navigateTo({ url }) { navigatedUrl = url; },
  showModal() {},
  showToast() {}
};
const app = { globalData: {} };
global.getApp = () => app;
require(path.join(sourceRoot, 'miniapp-source/pages/practice/practice'));
Module._load = originalLoad;

const page = Object.assign({}, pageDefinition);
page.data = JSON.parse(JSON.stringify(pageDefinition.data));
page.setData = (patch, callback) => { Object.assign(page.data, patch); if (callback) callback(); };
page.session = {
  bankId: 'bank1', mode: 'random', exam: false, memorize: false, index: 0,
  questions: [{ ...JSON.parse(JSON.stringify(base)), options: [{ key: 'A', text: '蓝', images: [] }, { key: 'B', text: '红', images: [] }], answer: ['A'] }],
  answers: { q1: ['A'] }, results: { q1: { correct: true } }
};
page.data.question = page.session.questions[0];
page.editCurrentQuestion();
assert.ok(/questionId=q1/.test(navigatedUrl), '编辑按钮必须携带当前题 ID');
storedQuestion = { ...storedQuestion, difficulty: '困难', analysis: '更新后的解析' };
page.pendingQuestionEdit = true;
page.onShow();
assert.deepStrictEqual(page.session.answers.q1, ['B'], '仅修改元数据后应保留并映射当前选择');
assert.strictEqual(page.data.difficulty, '困难', '返回后难度胶囊必须立即刷新');

page.editQuestionSnapshot = practiceService.buildQuestionEditSignature(storedQuestion);
page.pendingQuestionEdit = true;
storedQuestion = { ...storedQuestion, question: '完全修改后的题干' };
page.onShow();
assert.strictEqual(page.session.answers.q1, undefined, '题干/答案内容变化后必须清除旧选择');
assert.strictEqual(page.session.results.q1, undefined, '题干/答案内容变化后必须清除旧判题结果');
assert.strictEqual(page.data.question.question, '完全修改后的题干', '编辑保存后当前题必须立即显示新内容');

console.log('In-session question edit regression passed');
