const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const parser = require(path.join(ROOT, 'miniapp-source', 'services', 'question-parser'));

function paragraph(index, text, extra = {}) {
  return Object.assign({ index, text, style: '', numId: '', level: 0, listOrdinal: 0, images: [], sourceKind: 'docx' }, extra);
}

const paragraphs = [
  paragraph(0, '一、填空题（共 5 空，含答案）'),
  paragraph(1, '电导率仪由（振荡器）、（放大器）和（指示器）组成。'),
  paragraph(2, 'DCS 的中文意思是（ ）。'),
  paragraph(3, '答案：集散控制系统'),
  paragraph(4, '电流表应与被测电路（ ）。'),
  paragraph(5, '串联'),
  paragraph(6, '仪表五大参数之一是（压力）。'),
  paragraph(7, '这是一道原文未提供答案的填空陈述。'),
  paragraph(8, '二、选择题（共 1 题，单选，含答案）'),
  paragraph(9, '热电偶测温原理基于（）。答案：CA、热阻效应 B、热磁效应 C、热电效应 D、热压效应'),
  paragraph(10, '三、判断题（共 2 题，对打√，错打×）'),
  paragraph(11, '孔板是节流装置。（√）'),
  paragraph(12, '电磁流量计可以测量气体。（×）')
];

const result = parser.parseParagraphsDetailed(paragraphs, { sourceName: 'compact.docx', sourceKind: 'docx' });
assert.strictEqual(result.questions.length, 8, 'all compact questions should be separated');

const [embedded, labeled, unlabeled, singleFill, missing, choice, judgeTrue, judgeFalse] = result.questions;
assert.strictEqual(embedded.displayTypeLabel, '填空题');
assert.strictEqual(embedded.question, '电导率仪由（　）、（　）和（　）组成。');
assert.strictEqual(embedded.answerText, '振荡器；放大器；指示器');
assert.strictEqual(labeled.answerText, '集散控制系统');
assert.strictEqual(unlabeled.answerText, '串联');
assert.strictEqual(singleFill.answerText, '压力');
assert.ok(missing.issues.includes('无答案'), 'missing fill answer should remain inspectable');

assert.strictEqual(choice.type, 'single');
assert.deepStrictEqual(choice.answer, ['C']);
assert.deepStrictEqual(choice.options.map(item => item.text), ['热阻效应', '热磁效应', '热电效应', '热压效应']);
assert.strictEqual(judgeTrue.type, 'judge');
assert.deepStrictEqual(judgeTrue.answer, ['A']);
assert.deepStrictEqual(judgeFalse.answer, ['B']);

const pdfResult = parser.parseParagraphsDetailed([
  paragraph(0, '一、填空题（含答案）', { sourceKind: 'pdf' }),
  paragraph(1, 'DCS 的中文意思是（集散控制系统）。', { sourceKind: 'pdf' }),
  paragraph(2, '仪表位号 F 代表（流量），P 代表（压力）。', { sourceKind: 'pdf' }),
  paragraph(3, '二、选择题（单选，含答案）', { sourceKind: 'pdf' }),
  paragraph(4, '电流单位是（）。答案：AA、A B、mV C、W', { sourceKind: 'pdf' })
], { sourceName: 'compact.pdf', sourceKind: 'pdf' });
assert.strictEqual(pdfResult.questions.length, 3, 'PDF text-layer compact formats should parse');
assert.strictEqual(pdfResult.questions[0].answerText, '集散控制系统');
assert.strictEqual(pdfResult.questions[1].answerText, '流量；压力');
assert.deepStrictEqual(pdfResult.questions[2].answer, ['A']);

console.log('v1.9.7 compact fill/choice/judge regression tests passed');
