const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.wx = {
  env: { USER_DATA_PATH: '/tmp/buaiquiz-v203-test' },
  getFileSystemManager() {
    return { accessSync(){throw new Error('missing');}, mkdirSync(){}, readFileSync(){return '';}, writeFileSync(){}, copyFileSync(){}, unlinkSync(){}, rmdirSync(){}, readdirSync(){return [];}, statSync(){return {size:0,isDirectory:()=>false};} };
  }
};
global.atob = global.atob || (v => Buffer.from(v, 'base64').toString('binary'));
global.btoa = global.btoa || (v => Buffer.from(v, 'binary').toString('base64'));

const ROOT = path.resolve(__dirname, '..');
const parser = require(path.join(ROOT, 'miniapp-source/services/question-parser'));
const pdf = require(path.join(ROOT, 'miniapp-source/services/pdf-extractor')).__test;

function p(index, text, extra = {}) {
  return Object.assign({ index, text, style: '', numId: '', level: 0, listOrdinal: 0, images: [], sourceKind: 'pdf' }, extra);
}

// 同一题库内混合“题型标签+普通题号”和“n/总数[题型]”两种常见布局。
const mixed = [
  p(0, '第一部分：理论'), p(1, '一、判断题'),
  p(2, '1. 判断题：联锁解除作业中工艺只开具作业票即可解除相关联锁。'), p(3, '答案：B（错误）'),
  p(4, '2. 判断题：仪表变更完成后应及时更新 I/O 点表。'), p(5, '答案：A（正确）'),
  p(6, '二、选择题'),
  p(7, '1. 单选题：下列关于创新的论述，正确的是（）。'), p(8, 'A. 甲'), p(9, 'B. 乙'), p(10, 'C. 丙'), p(11, 'D. 丁'), p(12, '答案：C'),
  p(13, '二、通用基础知识'), p(14, '（一）电工电子学基础知识'),
  p(15, '1/4[单选题]'), p(16, '十进制数109的二进制码为（'), p(17, 'A.105'), p(18, 'B.1100101'), p(19, 'C.1110101'), p(20, 'D.1101101'), p(21, '参考答案：D,'),
  p(22, '2/4[判断题]'), p(23, '用国家统一规定的符号来表示电路连接情况的图称为电路图。'), p(24, 'A.正确'), p(25, 'B.错误'), p(26, '参考答案：A,'),
  p(27, '3/ 4[简答题]'), p(28, '电路的状态一般分为哪三种?'), p(29, '参考答案：1、通路；2、短路；3、开路。'),
  // 模拟 PDF 把 4/4 的斜杠抽成空格，并把 4 误成尾随 1：41 4 -> 修复成 4/4
  p(30, '41 4[单选题]'), p(31, '电流单位是（）。'), p(32, 'A.安培'), p(33, 'B.伏特'), p(34, '参考答案：A,')
];
const structure = parser.analyzeQuestionBankStructure(mixed, { sourceKind: 'pdf' });
assert.ok(['mixed-indexed', 'indexed'].includes(structure.layout));
const adaptive = parser.parseParagraphsAdaptive(mixed, { sourceName: 'mixed.pdf', sourceKind: 'pdf' });
assert.strictEqual(adaptive.questions.length, 7);
assert.ok(adaptive.diagnostics.parserCandidates.length >= 2);
assert.ok(['strict', 'relaxed'].includes(adaptive.diagnostics.parserStrategy));

// 单栏试卷的题干/选项有明显缩进，但左右内容不在同一高度，不能误判成双栏。
const singleColumn = [
  {x:40,y:760,text:'1/4[单选题]'}, {x:65,y:730,text:'题干第一行'},
  {x:95,y:700,text:'A. 选项A'}, {x:95,y:670,text:'B. 选项B'},
  {x:95,y:640,text:'C. 选项C'}, {x:95,y:610,text:'D. 选项D'},
  {x:60,y:580,text:'参考答案：C'}, {x:40,y:540,text:'2/4[判断题]'},
  {x:65,y:510,text:'第二题题干'}, {x:95,y:480,text:'A.正确'}, {x:95,y:450,text:'B.错误'}, {x:60,y:420,text:'参考答案：A'}
];
assert.strictEqual(pdf.orderPdfPageEntries(singleColumn).multiColumn, false);

// 真双栏必须保留：多个高度同时存在左右栏文字。
const twoColumn = [
  {x:210,y:790,text:'培训题库'},
  {x:45,y:720,text:'左1'}, {x:45,y:670,text:'左2'}, {x:45,y:620,text:'左3'}, {x:45,y:570,text:'左4'},
  {x:360,y:720,text:'右1'}, {x:360,y:670,text:'右2'}, {x:360,y:620,text:'右3'}, {x:360,y:570,text:'右4'},
  {x:210,y:20,text:'第1页'}
];
assert.strictEqual(pdf.orderPdfPageEntries(twoColumn).multiColumn, true);

// 多页边缘重复的题号/答案属于业务内容，不能当页眉页脚清掉。
const margins = [1, 2, 3, 4].map((pageNumber, index) => ({
  pageNumber,
  entries: [
    {x:40,y:790,text:'培训题库'},
    {x:40,y:760,text:'1/39[单选题]'},
    {x:60,y:35,text:'参考答案：A'},
    {x:260,y:15,text:`第 ${pageNumber} 页`}
  ]
}));
const cleaned = pdf.removeRepeatedPdfMargins(margins);
assert.ok(cleaned.pageSets.every(page => page.entries.some(item => item.text === '1/39[单选题]')));
assert.ok(cleaned.pageSets.every(page => page.entries.some(item => item.text === '参考答案：A')));
assert.ok(cleaned.pageSets.every(page => !page.entries.some(item => /^第\s*\d+\s*页$/.test(item.text))));

// 原生选择器必须使用 JS 动态写入的扩展名列表和 MIME 白名单，不可回退到纯 */*。
const java = fs.readFileSync(path.join(ROOT, 'app/src/main/java/com/buaiquiz/quiz/android/MainActivity.java'), 'utf8');
assert.ok(java.includes('__picker_supported_extensions_v1'));
assert.ok(java.includes('Intent.EXTRA_MIME_TYPES'));
assert.ok(java.includes('application/pdf') && java.includes('application/msword'));

console.log('v2.0.3 adaptive import regression passed');
