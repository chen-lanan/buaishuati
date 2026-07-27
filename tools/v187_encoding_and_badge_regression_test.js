'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

assert.strictEqual(read('VERSION.txt').trim(), '1.8.7');
assert.strictEqual(read('miniapp-source/VERSION.txt').trim(), '1.8.7');
assert.ok(/versionCode 187/.test(read('app/build.gradle')));
assert.ok(/versionName '1\.8\.7'/.test(read('app/build.gradle')));
assert.ok(/const APP_VERSION = '1\.8\.7'/.test(read('miniapp-source/utils/constants.js')));
assert.ok(/const CURRENT_PARSER_VERSION = '1\.8\.7'/.test(read('miniapp-source/utils/constants.js')));

const text = require('../miniapp-source/utils/text');
assert.strictEqual(text.repairMojibake('ä¸­æ–‡'), '中文');
assert.strictEqual(text.normalizeText('ä¸­æ–‡ 题库'), '中文 题库');
assert.strictEqual(text.hasEncodingAnomaly('K�接I�.�'), true);
assert.strictEqual(text.hasEncodingAnomaly('若开关Kö²接Iö±.ö±，Kö³接Iö±.ö²'), true);
assert.strictEqual(text.hasEncodingAnomaly('若开关 K1 接 I0.0，K2 接 I0.1'), false);

const display = require('../miniapp-source/utils/bank-display');
assert.deepStrictEqual(display.sourceFormat({ sourceName: '仪表题库.docx' }), { sourceFormat: 'word', sourceFormatLabel: 'WORD' });
assert.deepStrictEqual(display.sourceFormat({ sourceKind: 'pdf' }), { sourceFormat: 'pdf', sourceFormatLabel: 'PDF' });
assert.deepStrictEqual(display.sourceFormat({ sourceName: '仪表题库.xlsx' }), { sourceFormat: 'excel', sourceFormatLabel: 'EXCEL' });
assert.strictEqual(display.decorateBank({ name: '这是一个非常非常非常非常非常长的题库名称', sourceKind: 'pdf' }).nameSizeClass, 'bank-name-compact');

const homeWxml = read('miniapp-source/pages/home/home.wxml');
const banksWxml = read('miniapp-source/pages/banks/banks.wxml');
const homeWxss = read('miniapp-source/pages/home/home.wxss');
const banksWxss = read('miniapp-source/pages/banks/banks.wxss');
assert.ok(homeWxml.includes('source-format-badge'));
assert.ok(banksWxml.includes('source-format-badge'));
assert.ok(homeWxss.includes('.source-format-word { background: #2563eb; }'));
assert.ok(homeWxss.includes('.source-format-pdf { background: #dc2626; }'));
assert.ok(homeWxss.includes('.source-format-excel { background: #16a34a; }'));
assert.ok(banksWxss.includes('white-space: nowrap'));
assert.ok(banksWxss.includes('text-overflow: ellipsis'));

assert.ok(read('miniapp-source/services/docx-extractor.js').includes('fileUtil.readTextAuto'));
assert.ok(read('miniapp-source/services/xlsx-extractor.js').includes('fileUtil.readTextAuto'));
assert.ok(read('miniapp-source/services/question-validator.js').includes("issues.push('字符映射异常')"));

// pdf-extractor depends on wx through file.js; a minimal filesystem mock is enough for pure decoder tests.
global.wx = {
  env: { USER_DATA_PATH: '/tmp/buai-v187-test' },
  getFileSystemManager() { return {}; }
};
const pdf = require('../miniapp-source/services/pdf-extractor').__test;
const cmap = pdf.parseCMap(`
2 begincodespacerange
<00> <FF>
<0000> <FFFF>
endcodespacerange
2 beginbfchar
<01> <004B>
<02> <0031>
endbfchar
1 beginbfrange
<10> <12> [<0030> <0031> <0032>]
endbfrange`);
assert.strictEqual(cmap.map['01'], 'K');
assert.strictEqual(cmap.map['02'], '1');
assert.strictEqual(cmap.map['10'], '0');
assert.strictEqual(cmap.map['12'], '2');
assert.deepStrictEqual(cmap.lengths, [2, 1]);

const differences = pdf.parseDifferences('48 /zero /one /two 65 /A /B');
assert.strictEqual(differences[48], '0');
assert.strictEqual(differences[49], '1');
assert.strictEqual(differences[50], '2');
assert.strictEqual(differences[65], 'A');

const cid = pdf.parseCidCMap(`
1 begincodespacerange <0000> <FFFF> endcodespacerange
1 begincidchar <0020> 8 endcidchar
1 begincidrange <0030> <0032> 20 endcidrange`);
assert.strictEqual(cid.map['0020'], 8);
assert.strictEqual(cid.map['0032'], 22);
assert.deepStrictEqual(cid.lengths, [2]);

const stats = { repaired: 0, unresolved: 0 };
const glyphs = pdf.decodeGlyphs({ kind: 'hex', value: '00010002' }, {
  map: {}, lengths: [2], simpleMap: {}, type0: true, identity: true,
  cidCodeMap: {}, cidToGidBytes: null,
  embeddedGidMap: { 1: 'K', 2: '1' }, hasEmbeddedGidMap: true
}, stats);
assert.strictEqual(glyphs.map(item => item.text).join(''), 'K1');
assert.strictEqual(stats.repaired, 2);

const validator = require('../miniapp-source/services/question-validator');
const validation = validator.validateQuestion({
  id: 'q1', order: 1, type: 'short', displayTypeLabel: '论述题',
  question: '若开关K�接I�.�，灯L接Q�.�。', options: [], answer: [], answerText: '参考图', analysis: '',
  images: ['/tmp/a.png'], answerImages: [], analysisImages: [], source: { rawTexts: [] }
});
assert.ok(validation.issues.includes('字符映射异常'));
assert.strictEqual(validation.status, 'warning');

const importResultWxml = read('miniapp-source/pages/import-result/import-result.wxml');
assert.ok(importResultWxml.includes('字体映射备用修复'));
assert.ok(importResultWxml.includes('仍未解析字符'));
assert.ok(importResultWxml.includes('字符异常文本片段'));

console.log('v1.8.7 encoding and bank badge regression: PASS');
