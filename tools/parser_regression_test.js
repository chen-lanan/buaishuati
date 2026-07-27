'use strict';

const assert = require('assert');
const parser = require('../miniapp-source/services/question-parser');

function paragraph(index, text, extra = {}) {
  return Object.assign({
    index,
    text,
    images: [],
    alternatives: [],
    style: '',
    numId: '',
    level: 0,
    listOrdinal: 0
  }, extra);
}

const paragraphs = [
  paragraph(0, '一、基础知识', { style: 'Heading2' }),
  paragraph(1, '14 题'),
  paragraph(2, '题目：在端子接线图中，每一个端子都有唯一的编号。（）'),
  paragraph(3, 'A. 正确'),
  paragraph(4, 'B. 错误'),
  paragraph(5, 'A'),

  paragraph(6, '15[题]（简答题）为什么要对控制系统进行定时检查？'),
  paragraph(7, '答案：为了及时发现故障并防止故障扩大。'),

  paragraph(8, '16 题（单选）下列说法正确的是（）。'),
  paragraph(9, 'A. 甲'),
  paragraph(10, 'B. 乙'),
  paragraph(11, 'B'),

  paragraph(12, '17 题', { images: ['/tmp/image-question.png'] }),

  paragraph(13, '18 题（判断）设备接地有利于安全。'),
  paragraph(14, 'A'),

  paragraph(15, '19/20[题]（多选）应急事故处置原则有哪些？'),
  paragraph(16, 'A. 快速报警'),
  paragraph(17, 'B. 冷静应对'),
  paragraph(18, 'A/B'),

  paragraph(19, '201 20[单选题]最后一道题的答案是（）。'),
  paragraph(20, 'A. 甲'),
  paragraph(21, 'B. 乙'),
  paragraph(22, 'A')
];

const result = parser.parseParagraphsDetailed(paragraphs, { sourceName: 'parser-regression.docx' });
assert.strictEqual(result.questions.length, 7, '应保留 7 道题目记录');
assert.strictEqual(result.diagnostics.detectedBoundaryCount, 7, '边界数应与保留记录一致');
assert.strictEqual(result.diagnostics.discardedBoundaryCount, 0, '不应静默丢弃边界');
assert.strictEqual(result.diagnostics.unassignedParagraphCount, 0, '不应遗留未归入段落');
assert.strictEqual(result.diagnostics.numberingGapCount, 0, '连续题号不应误报缺口');

const byNumber = Object.fromEntries(result.questions.map(item => [item.number, item]));
assert.strictEqual(byNumber['14'].type, 'judge');
assert.deepStrictEqual(byNumber['14'].answer, ['A']);
assert.strictEqual(byNumber['15'].type, 'short');
assert.ok(byNumber['15'].answerText.includes('及时发现故障'));
assert.strictEqual(byNumber['16'].type, 'single');
assert.deepStrictEqual(byNumber['16'].answer, ['B']);
assert.strictEqual(byNumber['17'].status, 'error');
assert.strictEqual(byNumber['17'].preservedBoundaryFailure, true);
assert.ok(byNumber['17'].question.includes('图片题'));
assert.strictEqual(byNumber['18'].type, 'judge');
assert.deepStrictEqual(byNumber['18'].answer, ['A']);
assert.strictEqual(byNumber['19'].type, 'multiple');
assert.deepStrictEqual(byNumber['19'].answer, ['A', 'B']);
assert.ok(byNumber['20'], '异常斜杠题号 201 20 应恢复为 20');

console.log('parser_regression_test: PASS');
console.log(JSON.stringify({
  questionCount: result.questions.length,
  statuses: result.questions.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {}),
  diagnostics: result.diagnostics
}, null, 2));

// v1.6.0：PDF 转 Word 后，题号与题干可能被拆成独立段落。
// 例如“1”单独一行，下一行才是“题 DCS……”。旧版会漏掉题号并把题目并入前后题。
const splitStartParagraphs = [];
for (let i = 1; i <= 6; i += 1) {
  const base = (i - 1) * 4;
  splitStartParagraphs.push(paragraph(base, String(i)));
  splitStartParagraphs.push(paragraph(base + 1, `题 测试拆分题号 ${i} 的正确答案是（）。`));
  splitStartParagraphs.push(paragraph(base + 2, 'A. 正确'));
  splitStartParagraphs.push(paragraph(base + 3, 'A'));
}
// 独立页码不能仅因下一段存在括号就被强制识别为题号。
splitStartParagraphs.push(paragraph(100, '117'));
splitStartParagraphs.push(paragraph(101, '（）'));
splitStartParagraphs.push(paragraph(102, 'A. 页面续行'));

const splitResult = parser.parseParagraphsDetailed(splitStartParagraphs, { sourceName: 'split-start-regression.docx' });
assert.strictEqual(splitResult.questions.length, 6, '应恢复 6 道题号与题干分段的题目');
assert.strictEqual(splitResult.diagnostics.splitQuestionStartRepairCount, 6, '应记录 6 次拆分题号修复');
assert.deepStrictEqual(splitResult.questions.map(item => item.number), ['1', '2', '3', '4', '5', '6']);
assert.strictEqual(splitResult.diagnostics.discardedBoundaryCount, 0, '拆分题号修复后不应静默丢题');
console.log('split_question_start_regression: PASS');

// v1.6.1：题号后缺少句点时，仍应在上一题已经完成后切分新题。
// 真实题库中的“38更换MTL系列的安全栅时……”此前被并入第 37 题答案。
const noPunctuationParagraphs = [
  paragraph(0, '故障判断与处理', { style: 'Heading2' }),
  paragraph(1, '37、安全栅是实现安全火花型防爆系统的关键仪表。'),
  paragraph(2, '答案：（正确）'),
  paragraph(3, '38更换MTL系列的安全栅时，应注意以下事项:'),
  paragraph(4, 'A.确认安全栅的型号一致。'),
  paragraph(5, 'B.若安全栅单独供电，应先切断电源'),
  paragraph(6, 'C提前断开安全栅上的信号线'),
  paragraph(7, 'D安全栅固定螺丝应拧紧'),
  paragraph(8, '答案：ABCD'),
  paragraph(9, '39、控制柜24V电源“status”指示灯闪烁含义'),
  paragraph(10, '参考答案：表示电源存在故障，需要更换。')
];
const noPunctuationResult = parser.parseParagraphsDetailed(noPunctuationParagraphs, { sourceName: 'no-punctuation-regression.docx' });
assert.deepStrictEqual(noPunctuationResult.questions.map(item => item.number), ['37', '38', '39']);
const repaired38 = noPunctuationResult.questions.find(item => item.number === '38');
assert.ok(repaired38, '无标点第 38 题必须独立保留');
assert.strictEqual(repaired38.type, 'multiple');
assert.deepStrictEqual(repaired38.answer, ['A', 'B', 'C', 'D']);
assert.ok(noPunctuationResult.diagnostics.noPunctuationBoundaryRepairCount >= 1);
console.log('no_punctuation_boundary_regression: PASS');

// v1.6.1：简答题处于答案模式时，带“题目：”的新题不得被当作上一题的编号答案要点。
const inlineShortParagraphs = [
  paragraph(0, '一、简答题（共 3 题）'),
  paragraph(1, '1.题目：程控阀回讯不对的原因有哪些？答案：1、回讯探头损坏；2、回讯电缆断路。'),
  paragraph(2, '2.题目：根据TRICON电源模件报警灯判断故障并给出建议动作。答案：更换故障模件或修复输入电源。'),
  paragraph(3, '3.题目：校验一台压力变送器需要哪些工具？答案：套筒扳手、内六角扳手和活动扳手。')
];
const inlineShortResult = parser.parseParagraphsDetailed(inlineShortParagraphs, { sourceName: 'inline-short-regression.docx' });
assert.deepStrictEqual(inlineShortResult.questions.map(item => item.number), ['1', '2', '3']);
assert.ok(inlineShortResult.questions[1].question.includes('TRICON'));
assert.ok(inlineShortResult.questions[2].question.includes('压力变送器'));
console.log('inline_short_question_boundary_regression: PASS');

// v1.6.1：章节明确声明题数但 Word 正文缺题时，生成错误占位用于对账，
// 占位题不得伪装成可练习的正常题。
const declaredMissingParagraphs = [
  paragraph(0, '二、判断题（共 3 题）'),
  paragraph(1, '1. 第一题内容。'),
  paragraph(2, '答案：正确'),
  paragraph(3, '2. 第二题内容。'),
  paragraph(4, '答案：错误')
];
const declaredMissingResult = parser.parseParagraphsDetailed(declaredMissingParagraphs, { sourceName: 'declared-missing-regression.docx' });
assert.strictEqual(declaredMissingResult.questions.length, 3, '应以占位记录补齐章节声明的 3 道');
const missing3 = declaredMissingResult.questions.find(item => item.sourceMissingPlaceholder);
assert.ok(missing3, '应生成原文缺失题占位');
assert.strictEqual(missing3.number, '3');
assert.strictEqual(missing3.status, 'error');
assert.strictEqual(declaredMissingResult.diagnostics.sourceContentQuestionCount, 2);
assert.strictEqual(declaredMissingResult.diagnostics.sourceDeclaredMissingCount, 1);
assert.strictEqual(declaredMissingResult.diagnostics.accountedQuestionCount, 3);
console.log('declared_missing_placeholder_regression: PASS');


// v1.6.3：文件名/首页中的“仪表专业学习内容（日期范围）”是文档标题，
// 不得被“仪表……”强提示规则误识别成无选项、无答案的失败题。
const documentTitleParagraphs = [
  paragraph(0, '仪表专业学习内容（6.22-6.26）'),
  paragraph(1, '一、单选'),
  paragraph(2, '1. 用孔板配差变测流量时，一般最小流量应大于（）。'),
  paragraph(3, 'A.20%'),
  paragraph(4, 'B.30%'),
  paragraph(5, '答案：B')
];
const documentTitleResult = parser.parseParagraphsDetailed(documentTitleParagraphs, {
  sourceName: '仪表专业学习内容（6.22-6.26）(1).docx'
});
assert.strictEqual(documentTitleResult.questions.length, 1, '文档标题不得生成失败题');
assert.strictEqual(documentTitleResult.questions[0].number, '1');
assert.strictEqual(documentTitleResult.diagnostics.documentTitleNoiseCount, 1);
assert.ok(!documentTitleResult.questions.some(item => /仪表专业学习内容/.test(item.question)));
console.log('document_title_noise_regression: PASS');

// v1.7.5：Word 题型大标题应像 Excel Sheet 一样向后继承。
// 画图题不要求每道题都含“画出/绘制”，计算题、填空题也保留独立显示标签。
const inheritedDisplayTypeParagraphs = [
  paragraph(0, '六、画图题'),
  paragraph(1, '1. 画出 PID 控制回路中远传液位计控制回路图。'),
  paragraph(2, '参考答案：见标准回路图。'),
  paragraph(3, '2. 分程控制 A 阀全开后 B 阀动作到全开。'),
  paragraph(4, '参考答案：按要求绘制特性曲线。'),
  paragraph(5, '（一）分程控制补充题', { style: 'Heading3' }),
  paragraph(6, '3. A 阀全关后 B 阀动作到全关。'),
  paragraph(7, '参考答案：按要求绘制特性曲线。'),
  paragraph(8, '七、计算题'),
  paragraph(9, '1. 已知量程和输出，计算当前测量值。'),
  paragraph(10, '答案：50。'),
  paragraph(11, '八、填空题（共 1 题）'),
  paragraph(12, '1. 仪表精度等级用（ ）表示。'),
  paragraph(13, '答案：最大允许误差。')
];
const inheritedDisplayTypeResult = parser.parseParagraphsDetailed(inheritedDisplayTypeParagraphs, { sourceName: 'word-type-inheritance.docx' });
assert.deepStrictEqual(inheritedDisplayTypeResult.questions.map(item => item.displayTypeLabel), ['画图题', '画图题', '画图题', '计算题', '填空题']);
assert.ok(inheritedDisplayTypeResult.questions.slice(0, 3).every(item => item.type === 'short'));
assert.strictEqual(inheritedDisplayTypeResult.questions[1].displayTypeLabel, '画图题', '没有“画出”关键词仍应继承画图题大类');
console.log('word_display_type_inheritance_regression: PASS');

// v1.7.5：Word 图片应按题干/选项/答案/解析分别归属，避免全部堆到题干。
const imageOwnershipParagraphs = [
  paragraph(0, '一、画图题'),
  paragraph(1, '1. 根据要求绘制控制回路。', { images: ['/tmp/question.png'] }),
  paragraph(2, '参考答案：见图', { images: ['/tmp/answer.png'] }),
  paragraph(3, '解析：关键连接如下。', { images: ['/tmp/analysis.png'] }),
  paragraph(4, '二、单选题'),
  paragraph(5, '1. 选择正确的图形（）。'),
  paragraph(6, 'A. 图形', { images: ['/tmp/a.png'] }),
  paragraph(7, 'B. 图形', { images: ['/tmp/b.png'] }),
  paragraph(8, '答案：A')
];
const imageOwnershipResult = parser.parseParagraphsDetailed(imageOwnershipParagraphs, { sourceName: 'word-image-ownership.docx' });
const drawingQuestion = imageOwnershipResult.questions[0];
assert.deepStrictEqual(drawingQuestion.images, ['/tmp/question.png']);
assert.deepStrictEqual(drawingQuestion.answerImages, ['/tmp/answer.png']);
assert.deepStrictEqual(drawingQuestion.analysisImages, ['/tmp/analysis.png']);
const visualChoiceQuestion = imageOwnershipResult.questions[1];
assert.strictEqual(visualChoiceQuestion.images.length, 0);
assert.deepStrictEqual(visualChoiceQuestion.options.map(item => item.images[0]), ['/tmp/a.png', '/tmp/b.png']);
console.log('word_image_ownership_regression: PASS');
