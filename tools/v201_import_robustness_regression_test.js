const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const parser = require(path.join(ROOT, 'miniapp-source', 'services', 'question-parser'));

function p(index, text, extra = {}) {
  return Object.assign({ index, text, style: '', numId: '', level: 0, listOrdinal: 0, images: [], sourceKind: 'docx' }, extra);
}

// 1) 文末集中答案：编号对照与连续答案串。
let result = parser.parseParagraphsDetailed([
  p(0, '一、单选题（共3题）'),
  p(1, '1. 第一题？'), p(2, 'A.甲'), p(3, 'B.乙'), p(4, 'C.丙'), p(5, 'D.丁'),
  p(6, '2. 第二题？'), p(7, 'A.甲'), p(8, 'B.乙'), p(9, 'C.丙'), p(10, 'D.丁'),
  p(11, '3. 第三题？'), p(12, 'A.甲'), p(13, 'B.乙'), p(14, 'C.丙'), p(15, 'D.丁'),
  p(16, '参考答案'), p(17, '1-3 ACB')
], { sourceName: 'central.docx', sourceKind: 'docx' });
assert.deepStrictEqual(result.questions.map(q => q.answer.join('')), ['A', 'C', 'B']);
assert.strictEqual(result.diagnostics.centralAnswerAppliedCount, 3);

result = parser.parseParagraphsDetailed([
  p(0, '一、简答题（共2题）'), p(1, '1. DCS 中文名称是什么？'), p(2, '2. PLC 中文名称是什么？'),
  p(3, '简答题答案'), p(4, '1. 集散控制系统'), p(5, '2. 可编程逻辑控制器')
], { sourceName: 'central-short.docx', sourceKind: 'docx' });
assert.deepStrictEqual(result.questions.map(q => q.answerText), ['集散控制系统', '可编程逻辑控制器']);

// 2) 答案前置 + 紧凑答案/选项粘连。
result = parser.parseParagraphsDetailed([
  p(0, '一、单选题'), p(1, '答案：C'), p(2, '1. 热电偶测温原理基于（）。'),
  p(3, 'A.热阻效应'), p(4, 'B.热磁效应'), p(5, 'C.热电效应'), p(6, 'D.热压效应'),
  p(7, '2. 电流单位是（）。答案 C；A.安培 B.伏特 C.瓦特 D.欧姆')
], { sourceName: 'compact.docx', sourceKind: 'docx' });
assert.deepStrictEqual(result.questions[0].answer, ['C']);
assert.deepStrictEqual(result.questions[1].answer, ['C']);
assert.strictEqual(result.questions[1].options[0].text, '安培');

// 3) 填空：Word 样式答案 + 显式多空答案。
result = parser.parseParagraphsDetailed([
  p(0, '一、填空题'),
  p(1, 'DCS 的中文名称是集散控制系统。', { styleAnswers: ['集散控制系统'] }),
  p(2, 'PID 分别表示____、____、____。'), p(3, '答案：比例；积分；微分')
], { sourceName: 'fill.docx', sourceKind: 'docx' });
assert.strictEqual(result.questions[0].question.includes('集散控制系统'), false);
assert.strictEqual(result.questions[0].answerText, '集散控制系统');
assert.deepStrictEqual(result.questions[1].blankAnswers, ['比例', '积分', '微分']);

result = parser.parseParagraphsDetailed([
  p(0, '一、单选题'), p(1, '1. 正确选项是哪一个？'),
  p(2, 'A. 甲'), p(3, 'B. 乙', { styleAnswerDetails: [{ text: '乙', reason: 'color', strength: 'strong' }] }), p(4, 'C. 丙')
], { sourceName: 'style-choice.docx', sourceKind: 'docx' });
assert.deepStrictEqual(result.questions[0].answer, ['B']);

// 4) 判断题常见符号。
result = parser.parseParagraphsDetailed([
  p(0, '一、判断题'), p(1, '1. 孔板是节流装置。（☑）'), p(2, '2. 气体可由电磁流量计测量。（☒）')
], { sourceName: 'judge.docx', sourceKind: 'docx' });
assert.deepStrictEqual(result.questions.map(q => q.answer.join('')), ['A', 'B']);

// 5) 元数据 + 材料/组合题。
result = parser.parseParagraphsDetailed([
  p(0, '阅读以下材料，回答1-2题：', { images: ['material.png'] }),
  p(1, '某控制系统由控制器、执行机构与对象构成。'),
  p(2, '1. 该系统属于什么系统？'), p(3, '答案：单回路控制系统'),
  p(4, '难度：中等'), p(5, '知识点：自动控制'),
  p(6, '2. 执行机构的作用是什么？'), p(7, '答案：改变操纵变量')
], { sourceName: 'material.docx', sourceKind: 'docx' });
assert.strictEqual(result.questions.length, 2);
assert.ok(result.questions[0].material.includes('某控制系统'));
assert.ok(result.questions[1].material.includes('某控制系统'));
assert.deepStrictEqual(result.questions[0].materialImages, ['material.png']);
assert.strictEqual(result.questions[0].difficulty, '中等');
assert.strictEqual(result.questions[0].knowledgePoint, '自动控制');

// 6) 新题型：不定项 / 匹配 / 排序都保留显示题型；结构映射正确。
result = parser.parseParagraphsDetailed([
  p(0, '一、不定项选择题'), p(1, '1. 下列正确的是（）。'), p(2, 'A.甲'), p(3, 'B.乙'), p(4, 'C.丙'), p(5, '答案：AC'),
  p(6, '二、匹配题'), p(7, '1. AI/AO 分别匹配。'), p(8, '答案：AI-模拟量输入；AO-模拟量输出'),
  p(9, '三、排序题'), p(10, '1. 请按顺序排列 A/B/C/D。'), p(11, '答案：BDAC')
], { sourceName: 'types.docx', sourceKind: 'docx' });
assert.strictEqual(result.questions[0].displayTypeLabel, '不定项选择题');
assert.strictEqual(result.questions[0].type, 'multiple');
assert.strictEqual(result.questions[1].displayTypeLabel, '匹配题');
assert.strictEqual(result.questions[1].type, 'short');
assert.strictEqual(result.questions[2].displayTypeLabel, '排序题');
assert.strictEqual(result.questions[2].answerText, 'BDAC');

// 7) UI: 异常页置信度位于状态之后，默认低到高；编辑器/练习/考试支持材料。
const reviewWxml = fs.readFileSync(path.join(ROOT, 'miniapp-source/pages/review/review.wxml'), 'utf8');
const statusPos = reviewWxml.indexOf('>状态<');
const confidencePos = reviewWxml.indexOf('>置信度<');
const typePos = reviewWxml.indexOf('>题型<');
assert.ok(statusPos >= 0 && confidencePos > statusPos && typePos > confidencePos, 'confidence filter ordering wrong');
const reviewJs = fs.readFileSync(path.join(ROOT, 'miniapp-source/pages/review/review.js'), 'utf8');
assert.ok(/sort\(\(a, b\) => \(Number\(a\.confidence\)/.test(reviewJs), 'confidence ascending sort missing');
['practice','exam','editor'].forEach(page => {
  const wxml = fs.readFileSync(path.join(ROOT, `miniapp-source/pages/${page}/${page}.wxml`), 'utf8');
  assert.ok(/question\.material/.test(wxml), `${page} material UI missing`);
});

// 8) 选择器：业务白名单集中，原生层不再使用全文件无限制选择。
const importer = fs.readFileSync(path.join(ROOT, 'miniapp-source/services/docx-importer.js'), 'utf8');
const java = fs.readFileSync(path.join(ROOT, 'app/src/main/java/com/buaiquiz/quiz/android/MainActivity.java'), 'utf8');
assert.ok(/extension:\s*SUPPORTED_EXTENSIONS/.test(importer), 'supported extension list not centralized');
assert.ok(/Intent\.EXTRA_MIME_TYPES/.test(java) && ((/application\/\*/.test(java) && /text\/\*/.test(java)) || (/supportedPickerMimeTypes/.test(java) && /__picker_supported_extensions_v1/.test(java))), 'native document MIME filtering missing');

console.log('v2.0.1 import robustness regression passed');
