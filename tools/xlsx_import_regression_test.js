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
if (!root) throw new Error('usage: node xlsx_import_regression_test.js <unzipped-dir>');
const result = extractXlsx(root, { sourceName: 'test.xlsx' });
const typeCounts = result.questions.reduce((acc, q) => { acc[q.displayTypeLabel] = (acc[q.displayTypeLabel] || 0) + 1; return acc; }, {});
const statusCounts = result.questions.reduce((acc, q) => { acc[q.status] = (acc[q.status] || 0) + 1; return acc; }, {});
const difficultyCounts = result.questions.reduce((acc, q) => { const key=q.difficulty || '(blank)'; acc[key]=(acc[key]||0)+1; return acc; }, {});
console.log(JSON.stringify({
  count: result.questions.length,
  expected: result.expectedQuestionCount,
  typeCounts,
  statusCounts,
  difficultyCounts,
  diagnostics: result.diagnostics,
  first: result.questions.slice(0,3),
  drawing: result.questions.filter(q => q.displayTypeLabel === '画图题').slice(0,5)
}, null, 2));

if (result.questions.length !== 1400) throw new Error(`expected 1400, got ${result.questions.length}`);
if (result.expectedQuestionCount !== 1400) throw new Error(`expected declared total 1400, got ${result.expectedQuestionCount}`);
if (typeCounts['单选题'] !== 350 || typeCounts['多选题'] !== 200 || typeCounts['判断题'] !== 330 || typeCounts['填空题'] !== 400 || typeCounts['简答题'] !== 103 || typeCounts['画图题'] !== 17) {
  throw new Error(`type counts mismatch: ${JSON.stringify(typeCounts)}`);
}
const drawings = result.questions.filter(q => q.displayTypeLabel === '画图题');
if (!drawings.some(q => (q.answerImages || []).length)) throw new Error('drawing answer images were not imported');
console.log('XLSX regression passed');
