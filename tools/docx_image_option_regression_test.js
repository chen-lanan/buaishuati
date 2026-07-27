'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.wx = {
  env: { USER_DATA_PATH: '/tmp/buaiquiz-test' },
  getFileSystemManager() {
    return {
      accessSync(target) { fs.accessSync(target); },
      mkdirSync(target) { fs.mkdirSync(target, { recursive: true }); },
      readFileSync(target, encoding) { return fs.readFileSync(target, encoding === 'base64' ? 'base64' : 'utf8'); },
      writeFileSync(target, data, encoding) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data, encoding === 'base64' ? 'base64' : 'utf8'); },
      copyFileSync(source, target) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target); },
      statSync(target) { const stat = fs.statSync(target); return { size: stat.size, isDirectory: () => stat.isDirectory(), isFile: () => stat.isFile() }; },
      readdirSync(target) { return fs.readdirSync(target); },
      unlinkSync(target) { fs.unlinkSync(target); },
      rmdirSync(target) { fs.rmdirSync(target); }
    };
  }
};

const { extractDocx } = require('../miniapp-source/services/docx-extractor');
const { parseParagraphsDetailed } = require('../miniapp-source/services/question-parser');
const root = process.argv[2];
if (!root) throw new Error('usage: node docx_image_option_regression_test.js <unzipped-docx-dir>');
const paragraphs = extractDocx(root);
const parsed = parseParagraphsDetailed(paragraphs, { sourceName: '仪器仪表维工知识题库（初级、中级）.docx' });
assert.strictEqual(parsed.questions.length, 1096, '主题库对账数量不得变化');
const targetQuestions = parsed.questions.filter(item => item.category === '通用基础知识').slice(0, 3);
assert.strictEqual(targetQuestions.length, 3, '应找到通用基础知识前三题');
targetQuestions.forEach((question, index) => {
  assert.strictEqual(question.images.length, 0, `第 ${index + 1} 题不应把选项图片堆入题干`);
  assert.strictEqual(question.options.length, 4, `第 ${index + 1} 题应有四个选项`);
  question.options.forEach(option => {
    assert.strictEqual((option.images || []).length, 1, `第 ${index + 1} 题 ${option.key} 选项应有一张图片`);
  });
});
assert.ok(parsed.diagnostics.detachedOptionImageRepairCount >= 4, '应修复拆分的图片选项段落');
console.log(JSON.stringify({
  questionCount: parsed.questions.length,
  repairedDetachedImages: parsed.diagnostics.detachedOptionImageRepairCount,
  targets: targetQuestions.map(question => ({
    number: question.number,
    question: question.question,
    optionImageCounts: question.options.map(option => (option.images || []).length),
    questionImageCount: question.images.length
  }))
}, null, 2));
console.log('DOCX image option regression passed');
