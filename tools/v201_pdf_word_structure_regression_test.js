const assert = require('assert');
const path = require('path');

global.wx = {
  env: { USER_DATA_PATH: '/tmp/buaiquiz-test' },
  getFileSystemManager() {
    return {
      accessSync() { throw new Error('missing'); }, mkdirSync() {}, readFileSync() { return ''; }, writeFileSync() {},
      copyFileSync() {}, unlinkSync() {}, rmdirSync() {}, readdirSync() { return []; }, statSync() { return { size: 0, isDirectory: () => false }; }
    };
  }
};
global.atob = global.atob || (v => Buffer.from(v, 'base64').toString('binary'));
global.btoa = global.btoa || (v => Buffer.from(v, 'binary').toString('base64'));

const ROOT = path.resolve(__dirname, '..');
const pdf = require(path.join(ROOT, 'miniapp-source/services/pdf-extractor')).__test;
const docx = require(path.join(ROOT, 'miniapp-source/services/docx-extractor'));

const entries = [
  {x:200,y:780,text:'培训题库'},
  {x:50,y:700,text:'左1'}, {x:55,y:650,text:'左2'}, {x:52,y:600,text:'左3'},
  {x:350,y:700,text:'右1'}, {x:355,y:650,text:'右2'}, {x:352,y:600,text:'右3'},
  {x:250,y:20,text:'第 1 页'}
];
const ordered = pdf.orderPdfPageEntries(entries);
assert.strictEqual(ordered.multiColumn, true);
assert.deepStrictEqual(ordered.entries.map(x => x.text), ['培训题库','左1','左2','左3','右1','右2','右3','第 1 页']);

const pageSets = Array.from({length:4},(_,i)=>({pageNumber:i+1,entries:[
  {x:100,y:780,text:'某公司培训题库'}, {x:50,y:700,text:`正文${i+1}`}, {x:200,y:20,text:`第 ${i+1} 页`}
]}));
const cleaned = pdf.removeRepeatedPdfMargins(pageSets);
assert.ok(cleaned.removedCount >= 8, 'repeated header/footer should be removed');
cleaned.pageSets.forEach(page => assert.strictEqual(page.entries.length, 1));

const styleXml = '<w:p><w:r><w:t>DCS是</w:t></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>集散控制系统</w:t></w:r></w:p>';
const styled = docx.runStyleCandidates(styleXml);
assert.ok(styled.some(item => item.text === '集散控制系统' && item.reason === 'underline'));

const tableXml = '<w:document><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>题目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>答案</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>1+1=?</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
const table = docx.extractTableCellRanges(tableXml, {}, '/tmp/nope');
assert.strictEqual(table.tables.length, 1);
assert.deepStrictEqual(table.tables[0].rows.map(r => r.values), [['题目','答案'],['1+1=?','2']]);

console.log('v2.0.1 PDF/Word structure regression passed');
