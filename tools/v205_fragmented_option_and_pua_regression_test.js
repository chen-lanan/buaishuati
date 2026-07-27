'use strict';
const assert = require('assert');
const path = require('path');
const root = path.resolve(__dirname, '..');
global.wx = {
  env: { USER_DATA_PATH: '/tmp/buaiquiz-v205-unit' },
  getFileSystemManager() { return {}; }
};
const parser = require(path.join(root, 'miniapp-source/services/question-parser'));
const pdf = require(path.join(root, 'miniapp-source/services/pdf-extractor'));

function parseRows(rows, sourceKind = 'pdf') {
  const paragraphs = rows.map((text, index) => ({ index, text, images: [], source: sourceKind }));
  return parser.parseParagraphsDetailed(paragraphs, { sourceName: 'v205-regression', sourceKind, useLocalAI: false }).questions;
}

let questions = parseRows([
  '9.下列关于火灾时进行逃生和自救方法错误的是（ ）。',
  'A. 利用疏散通道逃生',
  'B. 逃跑时应低头弯腰，必要时可以爬行',
  'C. 身上着火，不能奔跑，应就地打滚压灭火苗D. 火灾时，可以通过阳台窗户跳下',
  '参考答案：D'
]);
assert.strictEqual(questions.length, 1);
assert.deepStrictEqual(questions[0].options.map(o => [o.key, o.text]), [
  ['A', '利用疏散通道逃生'],
  ['B', '逃跑时应低头弯腰，必要时可以爬行'],
  ['C', '身上着火，不能奔跑，应就地打滚压灭火苗'],
  ['D', '火灾时，可以通过阳台窗户跳下']
]);
assert.deepStrictEqual(questions[0].answer, ['D']);

questions = parseRows([
  '80、【多选】分析小屋的安全检测报警系统包括以下（ ）部分。',
  'A.可燃气体检测报警器',
  'B.有毒气体检测报警器',
  'C.氧气检测报警器',
  'D.声光警报器',
  '火灾探测器 F.PLC报警控制箱',
  '答案：A,B,C,D,E,F'
]);
assert.strictEqual(questions.length, 1);
assert.deepStrictEqual(questions[0].options.map(o => [o.key, o.text]), [
  ['A', '可燃气体检测报警器'],
  ['B', '有毒气体检测报警器'],
  ['C', '氧气检测报警器'],
  ['D', '声光警报器'],
  ['E', '火灾探测器'],
  ['F', 'PLC报警控制箱']
]);
assert.deepStrictEqual(questions[0].answer, ['A','B','C','D','E','F']);

questions = parseRows([
  '34、多选题：特级动火作业应符合以下规定有（ ）',
  'A.生产装置运行不稳定时,不应进行带压不置换动火作业',
  'B.存在受热分解爆炸、自爆物料的',
  '管道和设备设施上不应进行动火作业C.应预先制定作业方案,落实安全防火防爆及应急措施',
  'D.在设备或管道上进行特级动火作业时，设备或管道内应保持微正压',
  '参考答案：A,B,C,D'
]);
assert.strictEqual(questions.length, 1);
assert.deepStrictEqual(questions[0].options.map(o => o.key), ['A','B','C','D']);
assert.strictEqual(questions[0].options[1].text, '存在受热分解爆炸、自爆物料的管道和设备设施上不应进行动火作业');
assert.strictEqual(questions[0].options[2].text, '应预先制定作业方案,落实安全防火防爆及应急措施');

for (let i = 0; i < 10; i += 1) {
  assert.strictEqual(pdf.__test.knownPdfPrivateUseChar(0xF6B1 + i), String(i));
}
assert.strictEqual(pdf.__test.knownPdfPrivateUseChar(0xF6BB), '');

console.log('v2.0.5 fragmented-option + PDF private-use digit regression passed');
