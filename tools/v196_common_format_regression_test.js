const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MINIAPP = path.join(ROOT, 'miniapp-source');
const FIXTURES = path.join(__dirname, 'fixtures', 'v196');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'buaiquiz-v196-'));

const manager = {
  accessSync: fs.accessSync,
  mkdirSync: value => fs.mkdirSync(value),
  readFileSync: (value, encoding) => fs.readFileSync(value, encoding),
  writeFileSync: (value, data, encoding) => fs.writeFileSync(value, data, encoding),
  copyFileSync: fs.copyFileSync,
  unlinkSync: fs.unlinkSync,
  readdirSync: fs.readdirSync,
  statSync: fs.statSync,
  rmdirSync: fs.rmdirSync,
  unzip({ zipFilePath, targetPath, success, fail }) {
    try {
      fs.mkdirSync(targetPath, { recursive: true });
      childProcess.execFileSync('unzip', ['-oq', zipFilePath, '-d', targetPath]);
      if (success) success();
    } catch (error) {
      if (fail) fail(error);
    }
  }
};

global.wx = {
  env: { USER_DATA_PATH: path.join(TEMP, 'wx') },
  getFileSystemManager() { return manager; }
};

const common = require(path.join(MINIAPP, 'services', 'common-format-extractor'));
const parser = require(path.join(MINIAPP, 'services', 'question-parser'));

function parseParagraphs(result, sourceName, sourceKind) {
  return parser.parseParagraphsDetailed(result.paragraphs, { sourceName, sourceKind }).questions;
}

try {
  const doc = common.extractLegacyDoc(path.join(FIXTURES, 'sample.doc'));
  assert.strictEqual(parseParagraphs(doc, 'sample.doc', 'doc').length, 100, 'DOC should preserve all 100 question boundaries');
  assert.ok(doc.diagnostics.legacyWordPieceCount >= 1, 'DOC piece table should be used');

  const xls = common.parseLegacyXls(path.join(FIXTURES, 'sample.xls'));
  assert.strictEqual(xls.questions.length, 3, 'XLS rows should produce three questions');
  assert.strictEqual(xls.questions[0].source.kind, 'xls');

  const odtDir = path.join(TEMP, 'odt');
  manager.unzip({ zipFilePath: path.join(FIXTURES, 'sample.odt'), targetPath: odtDir, fail: error => { throw error; } });
  const odt = common.extractOdt(odtDir);
  assert.strictEqual(parseParagraphs(odt, 'sample.odt', 'odt').length, 1, 'ODT text should produce one question');

  const odsDir = path.join(TEMP, 'ods');
  manager.unzip({ zipFilePath: path.join(FIXTURES, 'sample.ods'), targetPath: odsDir, fail: error => { throw error; } });
  assert.strictEqual(common.extractOds(odsDir).questions.length, 3, 'ODS rows should produce three questions');

  const rtf = common.extractRtf(path.join(FIXTURES, 'sample.rtf'));
  assert.strictEqual(parseParagraphs(rtf, 'sample.rtf', 'rtf').length, 1, 'RTF Unicode text should produce one question');

  const utf8Path = path.join(TEMP, 'sample.txt');
  fs.writeFileSync(utf8Path, '1[单选题]\n1+1等于几？\nA. 1\nB. 2\n答案：B\n解析：基础算术\n', 'utf8');
  const txt = common.extractTextLike(utf8Path, 'txt');
  assert.strictEqual(parseParagraphs(txt, 'sample.txt', 'txt').length, 1, 'UTF-8 TXT must not be mistaken for GB18030');

  const csvPath = path.join(TEMP, 'sample.csv');
  fs.writeFileSync(csvPath, '题号,题型,题干,选项A,选项B,答案\n1,单选题,1+1等于几？,1,2,B\n', 'utf8');
  assert.strictEqual(common.extractDelimited(csvPath, 'csv').questions.length, 1, 'CSV header mapping should work');

  console.log('v1.9.6 common-format regression tests passed');
} finally {
  fs.rmSync(TEMP, { recursive: true, force: true });
}
