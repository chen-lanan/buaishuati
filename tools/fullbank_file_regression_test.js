'use strict';
const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sourceRoot = process.argv[2];
const pdfPath = process.argv[3];
const docxPath = process.argv[4];
const expected = Number(process.argv[5] || 1096);
if (!sourceRoot || !pdfPath || !docxPath) throw new Error('usage: node fullbank_file_regression_test.js <source-root> <pdf-path> <docx-path> [expected-count]');
const userRoot = '/tmp/buaiquiz-fullbank-regression';
fs.rmSync(userRoot, { recursive: true, force: true });
fs.mkdirSync(userRoot, { recursive: true });

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
const { extractDocx } = require(path.join(sourceRoot, 'miniapp-source/services/docx-extractor'));
const { parseParagraphsAdaptive } = require(path.join(sourceRoot, 'miniapp-source/services/question-parser'));

function summarize(result) {
  const status = result.questions.reduce((acc, q) => { acc[q.status] = (acc[q.status] || 0) + 1; return acc; }, {});
  return {
    count: result.questions.length,
    content: result.questions.filter(q => !q.sourceMissingPlaceholder).length,
    placeholders: result.questions.filter(q => q.sourceMissingPlaceholder).length,
    strategy: result.diagnostics && result.diagnostics.parserStrategy,
    status
  };
}

(async () => {
  const pdfExtracted = await extractPdf(pdfPath, `${userRoot}/pdf-work`);
  const pdf = parseParagraphsAdaptive(pdfExtracted.paragraphs, { sourceName: path.basename(pdfPath), sourceKind: 'pdf', useLocalAI: false });
  const docxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buaiquiz-fullbank-docx-'));
  childProcess.execFileSync('unzip', ['-q', docxPath, '-d', docxDir]);
  const word = parseParagraphsAdaptive(extractDocx(docxDir), { sourceName: path.basename(docxPath), sourceKind: 'docx', useLocalAI: false });

  assert.strictEqual(pdf.questions.length, expected, `PDF 应识别 ${expected} 条对账记录`);
  assert.strictEqual(word.questions.length, expected, `Word 应识别 ${expected} 条对账记录`);
  assert.strictEqual(pdf.questions.filter(q => q.sourceMissingPlaceholder).length, 3, 'PDF 应保留 3 条原文缺失占位');
  assert.strictEqual(word.questions.filter(q => q.sourceMissingPlaceholder).length, 3, 'Word 应保留 3 条原文缺失占位');
  assert.strictEqual(pdf.diagnostics.centralAnswerEntryCount, 0, 'PDF 逐题参考答案不得误识别为集中答案');
  assert.strictEqual(word.diagnostics.centralAnswerEntryCount, 0, 'Word 逐题参考答案不得误识别为集中答案');
  assert.strictEqual(pdf.diagnostics.parserStrategy, 'strict', 'PDF 自适应候选应选择 strict，避免 relaxed 过拆');
  console.log(JSON.stringify({ pdf: summarize(pdf), word: summarize(word) }, null, 2));
  console.log('full-bank PDF/Word file regression passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
