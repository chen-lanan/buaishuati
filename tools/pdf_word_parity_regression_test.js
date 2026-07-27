'use strict';
const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sourceRoot = process.argv[2];
const pdfPath = process.argv[3];
const docxPath = process.argv[4];
if (!sourceRoot || !pdfPath || !docxPath) {
  throw new Error('usage: node pdf_word_parity_regression_test.js <source-root> <pdf-path> <docx-path>');
}
const userRoot = '/tmp/buaiquiz-pdf-word-parity';
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
const { parseParagraphsDetailed } = require(path.join(sourceRoot, 'miniapp-source/services/question-parser'));

function compact(value = '') {
  return String(value).replace(/\s+/g, '').replace(/[，。、“”‘’；：,.!?！？()（）\[\]【】]/g, '').toLowerCase();
}

(async () => {
  const docxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buaiquiz-docx-'));
  childProcess.execFileSync('unzip', ['-q', docxPath, '-d', docxDir]);
  const word = parseParagraphsDetailed(extractDocx(docxDir), {
    sourceName: path.basename(docxPath),
    sourceKind: 'docx',
    useLocalAI: false
  });
  const extracted = await extractPdf(pdfPath, `${userRoot}/pdf-work`);
  const pdf = parseParagraphsDetailed(extracted.paragraphs, {
    sourceName: path.basename(pdfPath),
    sourceKind: 'pdf',
    useLocalAI: false
  });

  assert.strictEqual(word.questions.length, 220, 'Word 应识别 220 道题');
  assert.strictEqual(pdf.questions.length, 220, 'PDF 应与 Word 同为 220 道题');
  assert.strictEqual(extracted.diagnostics.pdfPageCount, 52, '测试 PDF 应为 52 页');
  assert.strictEqual(extracted.diagnostics.pdfTextPageCount, 52, '测试 PDF 全部页面应有文字层');

  const pdfQuestions = pdf.questions.map(item => compact(item.question));
  assert.ok(pdfQuestions.some(text => text.includes(compact('用万用表测量电阻时，被测电阻可以带电'))), '应恢复 PDF 错位题号 80');
  assert.ok(pdfQuestions.some(text => text.includes(compact('屏蔽电缆及屏蔽电线的屏蔽层必须接地'))), '应恢复 PDF 错位题号 88');
  assert.ok(pdfQuestions.some(text => text.includes(compact('当检验量程为0.2Mpa，精度1.5级的压力表时，如果标准表量程为0.25MPa'))), '0.25MPa 应保留在第 89 题题干中');
  assert.ok(!pdf.questions.some(item => /^25MPa/.test(String(item.question || '').trim())), '不得把 0.25MPa 误拆成新题');

  const recovered80 = pdf.questions.find(item => compact(item.question).includes(compact('用万用表测量电阻时，被测电阻可以带电')));
  const recovered88 = pdf.questions.find(item => compact(item.question).includes(compact('屏蔽电缆及屏蔽电线的屏蔽层必须接地')));
  assert.strictEqual(recovered80.type, 'judge');
  assert.deepStrictEqual(recovered80.answer, ['B']);
  assert.strictEqual(recovered88.type, 'judge');
  assert.deepStrictEqual(recovered88.answer, ['A']);

  console.log(JSON.stringify({
    pdfPages: extracted.diagnostics.pdfPageCount,
    wordQuestionCount: word.questions.length,
    pdfQuestionCount: pdf.questions.length,
    repairedQuestionNumbers: [recovered80.number, recovered88.number]
  }, null, 2));
  console.log('PDF/Word parity regression passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
