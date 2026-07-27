'use strict';
const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sourceRoot = path.resolve(process.argv[2] || path.resolve(__dirname, '..'));
const pdfPath = process.argv[3];
const docxPath = process.argv[4];
if (!pdfPath || !docxPath) throw new Error('usage: node v207_count_parity_regression_test.js <source-root> <main-bank.pdf> <main-bank.docx>');

const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'buaiquiz-v207-user-'));
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

function parseDocx(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buaiquiz-v207-docx-'));
  childProcess.execFileSync('unzip', ['-q', file, '-d', dir]);
  try {
    return parseParagraphsAdaptive(extractDocx(dir), { sourceName: path.basename(file), sourceKind: 'docx', useLocalAI: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function find(result, text) {
  const q = result.questions.find(item => String(item.question || '').includes(text));
  assert(q, `未找到题目：${text}`);
  return q;
}
function sourceMissing(result) {
  return result.questions.filter(item => item.sourceMissing || item.isSourceMissing || String(item.statusReason || '').includes('原文缺失')).length || Number(result.diagnostics.sourceDeclaredMissingCount || 0);
}

(async () => {
  const extracted = await extractPdf(pdfPath, path.join(userRoot, 'pdf-work'));
  const pdf = parseParagraphsAdaptive(extracted.paragraphs, { sourceName: path.basename(pdfPath), sourceKind: 'pdf', useLocalAI: false });
  const docx = parseDocx(docxPath);

  assert.strictEqual(pdf.questions.length, 1095, 'PDF 应稳定为 1095 条可定位对账记录');
  assert.strictEqual(docx.questions.length, 1095, 'Word 应稳定为 1095 条可定位对账记录');
  assert.strictEqual(Number(pdf.diagnostics.sourceContentQuestionCount), 1092, 'PDF 正文题应为 1092');
  assert.strictEqual(Number(docx.diagnostics.sourceContentQuestionCount), 1092, 'Word 正文题应为 1092');
  assert.strictEqual(Number(pdf.diagnostics.sourceDeclaredMissingCount), 3, 'PDF 明确缺失占位应为 3');
  assert.strictEqual(Number(docx.diagnostics.sourceDeclaredMissingCount), 3, 'Word 明确缺失占位应为 3');

  for (const [name, result] of [['PDF', pdf], ['Word', docx]]) {
    const q27 = find(result, '475手持通讯器可以对组态、通讯、变送过程中出现的问题进行处理');
    assert.strictEqual(String(q27.number), '27', `${name} 475 应属于第 27 题，不是题号`);
    assert.deepStrictEqual(q27.answer, ['B'], `${name} 第 27 题答案应为 B`);
    assert.strictEqual(result.questions.filter(item => String(item.question || '').trim() === '27 [判断题]').length, 0, `${name} 不得保留只有题号和题型的假题`);
    assert.strictEqual(result.questions.filter(item => String(item.number) === '475' && String(item.question || '').includes('手持通讯器')).length, 0, `${name} 不得生成第 475 假题`);

    const flange = find(result, '安装法兰应注意哪些事情');
    assert(flange.answerText.includes('1）') && flange.answerText.includes('2）') && flange.answerText.includes('3）'), `${name} 法兰简答三条答案必须留在同一题`);
    assert(!result.questions.some(item => /^在拧紧螺帽时/.test(String(item.question || '').trim())), `${name} 第 3 条答案不得成为独立题`);
  }

  const supply = find(pdf, '在电路的组成部分中，提供电能的部分是');
  assert.strictEqual(String(supply.number), '17', 'PDF 17139[单选题] 应恢复为 17/39');
  assert.strictEqual(Number(pdf.diagnostics.numberingGapCount || 0), 0, 'PDF 不应再有该异常题号造成的编号断层');
  assert.strictEqual(Number(docx.diagnostics.numberingGapCount || 0), 0, 'Word 不应有编号断层');

  console.log(JSON.stringify({
    pdf: { total: pdf.questions.length, content: pdf.diagnostics.sourceContentQuestionCount, missing: pdf.diagnostics.sourceDeclaredMissingCount, normal: pdf.questions.filter(q => q.status === 'normal').length, warning: pdf.questions.filter(q => q.status === 'warning').length, error: pdf.questions.filter(q => q.status === 'error').length },
    docx: { total: docx.questions.length, content: docx.diagnostics.sourceContentQuestionCount, missing: docx.diagnostics.sourceDeclaredMissingCount, normal: docx.questions.filter(q => q.status === 'normal').length, warning: docx.questions.filter(q => q.status === 'warning').length, error: docx.questions.filter(q => q.status === 'error').length }
  }, null, 2));
  console.log('v2.0.7 count parity regression passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(userRoot, { recursive: true, force: true }));
