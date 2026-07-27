'use strict';
const assert = require('assert');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const parser = require(path.join(ROOT, 'miniapp-source', 'services', 'question-parser'));

function p(index, text, extra = {}) {
  return Object.assign({ index, text, style: '', numId: '', level: 0, listOrdinal: 0, images: [], sourceKind: 'docx' }, extra);
}

// 1) “参考答案：”是逐题答案标签时，不得误判成文末集中答案并吞掉后续题目。
let result = parser.parseParagraphsDetailed([
  p(0, '一、简答题'),
  p(1, '1. 电路的状态一般分为哪三种?'),
  p(2, '参考答案：'),
  p(3, '1、通路：电路正常工作。'),
  p(4, '2、短路：负载被旁路。'),
  p(5, '3、开路：电路断开。'),
  p(6, '2. 下一道题是什么？'),
  p(7, '参考答案：下一题答案。')
], { sourceName: 'per-question-answer.docx', sourceKind: 'docx' });
assert.strictEqual(result.questions.length, 2, '逐题“参考答案”不得吞掉后续题');
assert.strictEqual(result.diagnostics.centralAnswerEntryCount, 0, '逐题答案不得建立集中答案表');
assert.ok(result.questions[0].answerText.includes('通路'), '简答题答案正文应保留');

// 2) 真正的集中答案（强证据）仍然支持。
result = parser.parseParagraphsDetailed([
  p(0, '一、单选题（共3题）'),
  p(1, '1. 第一题？'), p(2, 'A.甲'), p(3, 'B.乙'), p(4, 'C.丙'),
  p(5, '2. 第二题？'), p(6, 'A.甲'), p(7, 'B.乙'), p(8, 'C.丙'),
  p(9, '3. 第三题？'), p(10, 'A.甲'), p(11, 'B.乙'), p(12, 'C.丙'),
  p(13, '参考答案'), p(14, '1-3 ACB')
], { sourceName: 'central-answer.docx', sourceKind: 'docx' });
assert.deepStrictEqual(result.questions.map(q => q.answer.join('')), ['A', 'C', 'B']);
assert.strictEqual(result.diagnostics.centralAnswerAppliedCount, 3);

// 3) 正文句尾“材料。”不得启动材料块；n/总数[题型] 必须立即被识别为下一题边界。
result = parser.parseParagraphsDetailed([
  p(0, '28/39[判断题]'), p(1, '半导体指常温下导电性能介于导体与绝缘体之间的'), p(2, '材料。'), p(3, 'A.正确'), p(4, 'B.错误'), p(5, '参考答案：A,'),
  p(6, '29/39[单选题]'), p(7, '以下哪些是二极管的特性'), p(8, 'A.正向导通'), p(9, 'B.反向截止'), p(10, 'C.都是'), p(11, 'D.都不是'), p(12, '参考答案：C,'),
  p(13, '30/39[判断题]'), p(14, '三极管直流放大器与交流放大器工作原理一样。'), p(15, 'A.正确'), p(16, 'B.错误'), p(17, '参考答案：A,')
], { sourceName: 'material-fragment.docx', sourceKind: 'docx' });
assert.strictEqual(result.questions.length, 3, '正文“材料。”不得吞掉后续 n/总数 题号');
assert.ok(result.questions[1].question.includes('二极管'), '29/39 题应独立恢复');

// 4) PDF 自适应选择不得单纯追求“更多题”，异常推断增加时应保守选择结构更好的候选。
// 具体整库 PDF/Word 对账由 fullbank_file_regression_test.js 在真实文件上验证。
console.log('v2.0.4 full-bank parser guard regression passed');
