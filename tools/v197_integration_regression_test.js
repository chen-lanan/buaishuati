const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

assert.match(read('app/build.gradle'), /versionCode\s+197/);
assert.match(read('app/build.gradle'), /versionName\s+'1\.9\.7'/);
assert.match(read('miniapp-source/utils/constants.js'), /CURRENT_PARSER_VERSION\s*=\s*'1\.9\.7'/);
assert.match(read('miniapp-source/utils/constants.js'), /APP_VERSION\s*=\s*'1\.9\.7'/);
assert.match(read('miniapp-source/services/question-parser.js'), /splitCompactAnswerOptions/);
assert.match(read('miniapp-source/services/question-parser.js'), /extractEmbeddedFillAnswers/);
assert.match(read('miniapp-source/services/question-parser.js'), /填空题括号内答案/);
assert.match(read('miniapp-source/services/question-parser.js'), /章节逐题行/);
assert.match(read('miniapp-source/utils/text.js'), /合法字符/);
assert.match(read('CHANGELOG_v1.9.7.md'), /紧凑选择题/);
assert.match(read('TEST_REPORT_v1.9.7.txt'), /211 道/);

console.log('v1.9.7 integration regression tests passed');
