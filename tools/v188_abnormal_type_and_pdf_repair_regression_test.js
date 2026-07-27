'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

assert.strictEqual(read('VERSION.txt').trim(), '1.8.8');
assert.strictEqual(read('miniapp-source/VERSION.txt').trim(), '1.8.8');
assert.ok(/versionCode 188/.test(read('app/build.gradle')));
assert.ok(/versionName '1\.8\.8'/.test(read('app/build.gradle')));
assert.ok(/const APP_VERSION = '1\.8\.8'/.test(read('miniapp-source/utils/constants.js')));
assert.ok(/const CURRENT_PARSER_VERSION = '1\.8\.8'/.test(read('miniapp-source/utils/constants.js')));

const text = require('../miniapp-source/utils/text');
const expected = '若开关K1接I0.0，K2接I0.1，灯L接Q0.0。则实现K1通或K2断时，灯L亮；K1断且K2通时，灯L灭的梯形图是：';
assert.strictEqual(text.normalizeText('若开关K��接I��，.��K��接I��，.��灯L接Q��。��。��则实现K��通或K��断时，灯L亮，K��断且K��通时，灯L灭的梯形图是：'), expected);
assert.strictEqual(text.normalizeText('若开关Kö²接Iö±.ö±，Kö³接Iö±.ö²，灯L接Qö±.ö±。则实现Kö²通或Kö³断时，灯L亮，Kö²断且Kö³通时，灯L灭的梯形图是：'), expected);
assert.strictEqual(text.repairKnownEngineeringNotation('普通文字Kö²，不具备完整梯形图语义'), '普通文字Kö²，不具备完整梯形图语义');

const parser = require('../miniapp-source/services/question-parser');
const parsedKnown = parser.parseParagraphsDetailed([
  { index: 0, text: '1[论述题]', images: [] },
  { index: 1, text: '若开关K��接I��，.��K��接I��，.��灯L接Q��。��。��则实现K��通或K��断时，灯L亮，K��断且K��通时，灯L灭的梯形图是：', images: ['/tmp/answer.png'], encodingWarning: true }
], { sourceName: 'test.pdf', sourceKind: 'pdf' }).questions[0];
assert.strictEqual(parsedKnown.question, expected);
assert.strictEqual(parsedKnown.source.kind, 'pdf');
assert.ok(!parsedKnown.issues.includes('字符映射异常'));
assert.ok(parsedKnown.issues.includes('无答案'));
assert.deepStrictEqual(parsedKnown.images, ['/tmp/answer.png']);


global.wx = {
  env: { USER_DATA_PATH: '/tmp/buai-v188-test' },
  getFileSystemManager() { return {}; }
};
const pdf = require('../miniapp-source/services/pdf-extractor').__test;
assert.strictEqual(pdf.plausibleIdentityUnicodeChar(0x41), true);
assert.strictEqual(pdf.plausibleIdentityUnicodeChar(0x4E2D), true);
assert.strictEqual(pdf.plausibleIdentityUnicodeChar(0x00F6), false);
assert.strictEqual(pdf.plausibleIdentityUnicodeChar(0x00B1), false);
assert.strictEqual(pdf.plausibleIdentityUnicodeChar(0x00B2), false);

const questions = [
  { id: 'q1', order: 1, type: 'single', displayTypeLabel: '单选题', status: 'normal', question: '正常单选', options: [{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }], answer: ['A'] },
  { id: 'q2', order: 2, type: 'short', displayTypeLabel: '论述题', status: 'warning', question: '异常论述', options: [], answer: [], answerText: '' },
  { id: 'q3', order: 3, type: 'judge', displayTypeLabel: '判断题', status: 'normal', question: '正常判断', options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }], answer: ['A'] }
];
const mocks = {
  './bank-storage': { loadQuestions: () => JSON.parse(JSON.stringify(questions)) },
  './record-storage': {
    getMasteredIds: () => [], getSettings: () => ({ shuffleOptions: false }),
    getWrong: () => ({}), getFavoriteIds: () => []
  }
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent && /practice-service\.js$/.test(parent.filename) && mocks[request]) return mocks[request];
  return originalLoad.call(this, request, parent, isMain);
};
const servicePath = require.resolve('../miniapp-source/services/practice-service');
delete require.cache[servicePath];
const service = require(servicePath);
Module._load = originalLoad;
const base = { bankId: 'b1', bankName: '测试', mode: 'sequence', count: 0 };
assert.deepStrictEqual(service.createSession({ ...base, type: 'all' }).questions.map(item => item.id), ['q1', 'q3']);
assert.deepStrictEqual(service.createSession({ ...base, type: 'display:论述题' }).questions.map(item => item.id), []);
assert.deepStrictEqual(service.createSession({ ...base, type: 'abnormal' }).questions.map(item => item.id), ['q2']);

const config = read('miniapp-source/pages/practice-config/practice-config.js');
assert.ok(config.includes('异常优先级高于原题型'));
assert.ok(config.includes("label: '全部正常题型'"));
const editor = read('miniapp-source/pages/editor/editor.js');
const editorWxml = read('miniapp-source/pages/editor/editor.wxml');
const storage = read('miniapp-source/services/bank-storage.js');
assert.ok(editor.includes('addCustomType()'));
assert.ok(editor.includes('deleteCustomType(event)'));
assert.ok(editor.includes("moveQuestionImageToAnswer"));
assert.ok(editor.includes("moveAnswerImageToQuestion"));
assert.ok(editorWxml.includes('管理题型'));
assert.ok(editorWxml.includes('移到参考答案'));
assert.ok(editorWxml.includes('移到题干'));
assert.ok(storage.includes('getCustomTypeCatalog'));
assert.ok(storage.includes('saveCustomTypeCatalog'));
assert.ok(read('miniapp-source/pages/review/review.js').includes('原始 PDF 文本片段'));
assert.ok(read('miniapp-source/pages/import-result/import-result.wxml').includes('已知工程符号修复'));

console.log('v1.8.8 abnormal priority, custom type and PDF repair regression: PASS');
