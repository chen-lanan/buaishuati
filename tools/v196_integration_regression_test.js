const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

assert.match(read('app/build.gradle'), /versionCode\s+196/);
assert.match(read('app/build.gradle'), /versionName\s+'1\.9\.6'/);
assert.match(read('miniapp-source/utils/constants.js'), /CURRENT_PARSER_VERSION\s*=\s*'1\.9\.6'/);
assert.match(read('miniapp-source/utils/constants.js'), /APP_VERSION\s*=\s*'1\.9\.6'/);

const importer = read('miniapp-source/services/docx-importer.js');
['doc','docx','docm','dotx','dotm','rtf','odt','xls','xlsx','xlsm','xltx','xltm','ods','csv','tsv','txt','md','markdown','html','htm','pdf','qbank','json'].forEach(ext => {
  assert.ok(importer.includes(`'${ext}'`), `missing importer extension: ${ext}`);
});
assert.match(read('tools/module-order.json'), /services\/common-format-extractor\.js/);
assert.match(read('miniapp-source/pages/home/home.wxml'), /DOC\/DOCX、XLS\/XLSX、PDF、TXT/);
assert.match(read('miniapp-source/pages/about/about.wxml'), /Word 97-2003/);
assert.match(read('miniapp-source/utils/bank-display.js'), /sourceFormat:\s*'text'/);
assert.match(read('miniapp-source/pages/home/home.wxss'), /source-format-text/);
assert.match(read('miniapp-source/pages/banks/banks.wxss'), /source-format-text/);

console.log('v1.9.6 integration regression tests passed');
