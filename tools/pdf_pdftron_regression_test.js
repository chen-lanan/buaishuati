'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sourceRoot = process.argv[2];
const pdfPath = process.argv[3];
if (!sourceRoot || !pdfPath) throw new Error('usage: node pdf_pdftron_regression_test.js <source-root> <pdf-path>');
const userRoot = '/tmp/buaiquiz-pdftron-test';
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
  assert.strictEqual(extracted.diagnostics.pdfPageCount, 261, 'PDFTron 测试文件应为 261 页');
  assert.strictEqual(extracted.diagnostics.pdfTextPageCount, 261, '全部页面应有文字层');
  assert.ok(extracted.diagnostics.pdfExpandedObjectCount > 7000, '应展开 PDF 压缩对象流');
  assert.strictEqual(extracted.diagnostics.pdfExtractedImageCount, 15, '应提取 15 张图片');
  assert.strictEqual(extracted.diagnostics.pdfUnsupportedImageCount, 0, '不应出现不支持图片');

  const parsed = parseParagraphsDetailed(extracted.paragraphs, {
    sourceName: path.basename(pdfPath),
    sourceKind: 'pdf',
    useLocalAI: false
  });
  assert.strictEqual(parsed.questions.length, 1096, '应生成 1096 条对账记录');
  assert.strictEqual(parsed.questions.filter(item => !item.sourceMissingPlaceholder).length, 1093, '应有 1093 道正文题');
  assert.strictEqual(parsed.questions.filter(item => item.sourceMissingPlaceholder).length, 3, '应有 3 道原文缺失占位');
  const allQuestionText = parsed.questions.map(item => item.question || '').join('\n');
  assert.ok(!/[q~]{20,}/.test(allQuestionText), '题目中不应残留字体编码乱码');
  assert.ok(!parsed.questions.some(item => /(?:q~){5,}|336339651356/.test(item.question || '')), '不应生成截图中的乱码假题');
  const statusCounts = parsed.questions.reduce((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, {});
  assert.ok((statusCounts.normal || 0) >= 1030, '正常题目数量应达到预期；字符映射/重复题继续进入待检查而不是静默丢弃');
  assert.ok((statusCounts.error || 0) <= 9, '失败题应仅剩原文问题和少量真实缺选项题');

  console.log(JSON.stringify({ diagnostics: extracted.diagnostics, questionCount: parsed.questions.length, sourceContentCount: 1093, sourceMissingCount: 3, statusCounts }, null, 2));
  console.log('PDFTron PDF regression passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
