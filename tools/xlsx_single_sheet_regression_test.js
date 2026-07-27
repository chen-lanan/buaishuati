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

const { extractXlsx } = require('../miniapp-source/services/xlsx-extractor');
const root = process.argv[2];
if (!root) throw new Error('usage: node xlsx_single_sheet_regression_test.js <unzipped-dir>');
const result = extractXlsx(root, { sourceName: 'single-sheet.xlsx' });
if (result.questions.length !== 4) throw new Error(`expected 4, got ${result.questions.length}`);
const expected = ['单选题', '判断题', '填空题', '简答题'];
result.questions.forEach((question, index) => {
  if (question.category !== expected[index]) throw new Error(`row ${index + 1}: expected category ${expected[index]}, got ${question.category}`);
});
if (result.questions[1].difficulty) throw new Error('blank difficulty must stay blank');
if ((result.questions[1].answer || []).join('') !== 'A') throw new Error('judge semantic answer was not normalized');
if (result.questions[2].answerText !== '参考答案') throw new Error('fill-in answer was not preserved');
console.log(JSON.stringify({
  count: result.questions.length,
  categories: result.questions.map(item => item.category),
  difficulties: result.questions.map(item => item.difficulty || '(blank)'),
  types: result.questions.map(item => item.displayTypeLabel)
}, null, 2));
console.log('XLSX single-sheet regression passed');
