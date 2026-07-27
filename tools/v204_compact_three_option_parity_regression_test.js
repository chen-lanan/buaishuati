const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const parser = require(path.join(ROOT, 'miniapp-source/services/question-parser'));

function p(index, text, extra = {}) {
  return Object.assign({ index, text, style: '', numId: '', level: 0, listOrdinal: 0, images: [] }, extra);
}

function assertFireExtinguisher(question, sourceKind) {
  assert.ok(question, `${sourceKind}: question missing`);
  assert.strictEqual(question.number, '18');
  assert.strictEqual(question.question, '下列灭火器材中，不适用于电器灭火的是（）。');
  assert.deepStrictEqual(question.options.map(item => [item.key, item.text]), [
    ['A', '二氧化碳'],
    ['B', '干粉'],
    ['C', '泡沫']
  ]);
  assert.deepStrictEqual(question.answer, ['C']);
  assert.deepStrictEqual(question.issues, []);
  assert.strictEqual(question.status, 'normal');
}

// PDF 复制文本：题干、三项紧凑选项、参考答案在同一行。
const pdfInline = parser.parseParagraphsAdaptive([
  p(0, '18.下列灭火器材中，不适用于电器灭火的是（）。 A. 二氧化碳B. 干粉C. 泡沫 参考答案：C')
], { sourceName: '三选项.pdf', sourceKind: 'pdf' });
assertFireExtinguisher(pdfInline.questions[0], 'pdf-inline');
assert.ok(!pdfInline.questions[0].options.some(item => /参考/.test(item.text)), 'PDF 参考答案前缀不应残留进选项');


// 实际 PDF 文本层更常见的是三段：题干 / 紧凑选项 / 参考答案。
// 这一条覆盖 matchOptionLine 先把整行吞成 A 的路径，必须由 finalize 统一修复。
const pdfThreeParagraphs = parser.parseParagraphsAdaptive([
  p(0, '18.下列灭火器材中，不适用于电器灭火的是（）。'),
  p(1, 'A. 二氧化碳B. 干粉C. 泡沫'),
  p(2, '参考答案：C')
], { sourceName: '三选项分段.pdf', sourceKind: 'pdf' });
assertFireExtinguisher(pdfThreeParagraphs.questions[0], 'pdf-three-paragraphs');

// PDF 也可能把答案标签紧贴最后一项，仍应整体剥离“参考答案”。
const pdfTightReference = parser.parseParagraphsAdaptive([
  p(0, '18.下列灭火器材中，不适用于电器灭火的是（）。 A.二氧化碳B.干粉C.泡沫参考答案：C')
], { sourceName: '三选项紧贴答案.pdf', sourceKind: 'pdf' });
assertFireExtinguisher(pdfTightReference.questions[0], 'pdf-tight-reference');

// Word 自动编号：A. 在列表编号里，提取正文只剩“二氧化碳B...C...”。
// listOrdinal=1 会在共享解析层恢复 A，再由紧凑三项链拆出 B/C。
const docxAutoNumber = parser.parseParagraphsAdaptive([
  p(0, '18.下列灭火器材中，不适用于电器灭火的是（）。'),
  p(1, '二氧化碳B. 干粉C. 泡沫', { numId: '7', level: 0, listOrdinal: 1 }),
  p(2, '参考答案：C')
], { sourceName: '三选项.docx', sourceKind: 'docx' });
assertFireExtinguisher(docxAutoNumber.questions[0], 'docx-auto-number');


// 最坏情况：Word 自动编号信息也没保留下来，只剩 A 正文 + B./C.。
// 依靠题干选择题语义恢复首项 A，不能把整行并回题干。
const docxMissingA = parser.parseParagraphsAdaptive([
  p(0, '18.下列灭火器材中，不适用于电器灭火的是（）。'),
  p(1, '二氧化碳B. 干粉C. 泡沫'),
  p(2, '参考答案：C')
], { sourceName: '三选项丢A.docx', sourceKind: 'docx' });
assertFireExtinguisher(docxMissingA.questions[0], 'docx-missing-a');

// 安全性：正文内部没有明确 A 边界时，不能因为出现 A./B./C. 就误切。
assert.deepStrictEqual(
  parser.splitInline('协议支持A.主站B.从站C.广播'),
  [{ type: 'text', value: '协议支持A.主站B.从站C.广播' }]
);

// 明确以 A. 起始的三选项行应支持无空格紧凑格式。
assert.deepStrictEqual(parser.splitInline('A.二氧化碳B.干粉C.泡沫'), [
  { type: 'option', key: 'A', value: '二氧化碳' },
  { type: 'option', key: 'B', value: '干粉' },
  { type: 'option', key: 'C', value: '泡沫' }
]);

console.log('v2.0.4 compact three-option PDF/Word parity regression passed');
