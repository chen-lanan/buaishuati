'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sourceRoot = process.argv[2];
const pdfPath = process.argv[3];
if (!sourceRoot || !pdfPath) throw new Error('usage: node pdf_import_regression_test.js <source-root> <pdf-path>');
const userRoot = '/tmp/buaiquiz-pdf-test';
fs.rmSync(userRoot, { recursive: true, force: true });

global.wx = {
  env: { USER_DATA_PATH: userRoot },
  getFileSystemManager() {
    return {
      accessSync(target) { fs.accessSync(target); },
      mkdirSync(target) { fs.mkdirSync(target, { recursive: true }); },
      readFileSync(target, encoding) { return encoding === 'base64' ? fs.readFileSync(target).toString('base64') : fs.readFileSync(target, encoding || 'utf8'); },
      writeFileSync(target, data, encoding) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data, encoding === 'base64' ? 'base64' : (encoding || 'utf8')); },
      copyFileSync(source, target) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target); },
      statSync(target) { const stat = fs.statSync(target); return { size: stat.size, isDirectory: () => stat.isDirectory(), isFile: () => stat.isFile() }; },
      readdirSync(target) { return fs.readdirSync(target); },
      unlinkSync(target) { fs.unlinkSync(target); },
      rmdirSync(target) { fs.rmSync(target, { recursive: true, force: true }); }
    };
  }
};

const { extractPdf } = require(path.join(sourceRoot, 'miniapp-source/services/pdf-extractor'));
const { parseParagraphsDetailed } = require(path.join(sourceRoot, 'miniapp-source/services/question-parser'));

(async () => {
  const extracted = await extractPdf(pdfPath, `${userRoot}/work`);
  assert.strictEqual(extracted.diagnostics.pdfPageCount, 165, '测试 PDF 页数应为 165');
  assert.strictEqual(extracted.diagnostics.pdfTextPageCount, 165, '全部测试页应有文字层');
  assert.strictEqual(extracted.diagnostics.pdfEmptyPageCount, 0, '不应出现扫描空页');
  assert.strictEqual(extracted.diagnostics.pdfExtractedImageCount, 15, '应提取全部 15 张内嵌图片');
  assert.strictEqual(extracted.diagnostics.pdfUnsupportedImageCount, 0, '测试 PDF 不应有未支持图片');

  const parsed = parseParagraphsDetailed(extracted.paragraphs, {
    sourceName: path.basename(pdfPath),
    sourceKind: 'pdf',
    useLocalAI: false
  });
  assert.strictEqual(parsed.questions.length, 1096, 'PDF 与 Word 的题目对账数量应一致');
  assert.strictEqual(parsed.questions.filter(item => !item.sourceMissingPlaceholder).length, 1093, '应有 1093 道正文题目');
  assert.strictEqual(parsed.questions.filter(item => item.sourceMissingPlaceholder).length, 3, '应有 3 道原文缺失占位');

  const imageChoices = parsed.questions.filter(item => String(item.category || '').includes('通用基础知识')).slice(0, 3);
  assert.strictEqual(imageChoices.length, 3, '应找到通用基础知识前三道图片选择题');
  imageChoices.forEach((question, questionIndex) => {
    assert.strictEqual((question.images || []).length, 0, `第 ${questionIndex + 1} 题不应把选项图堆入题干`);
    assert.strictEqual((question.options || []).length, 4, `第 ${questionIndex + 1} 题应有四个选项`);
    question.options.forEach(option => assert.strictEqual((option.images || []).length, 1, `第 ${questionIndex + 1} 题 ${option.key} 应有一张图片`));
  });

  console.log(JSON.stringify({
    pageCount: extracted.diagnostics.pdfPageCount,
    textPages: extracted.diagnostics.pdfTextPageCount,
    imageCount: extracted.diagnostics.pdfExtractedImageCount,
    questionCount: parsed.questions.length,
    sourceContentCount: parsed.questions.filter(item => !item.sourceMissingPlaceholder).length,
    sourceMissingCount: parsed.questions.filter(item => item.sourceMissingPlaceholder).length,
    imageChoiceOptionCounts: imageChoices.map(item => item.options.map(option => (option.images || []).length))
  }, null, 2));
  console.log('PDF import regression passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
