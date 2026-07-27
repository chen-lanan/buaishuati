const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

assert.strictEqual(read('VERSION.txt').trim(), '1.9.4');
assert.strictEqual(read('miniapp-source/VERSION.txt').trim(), '1.9.4');
assert.ok(/versionCode 194/.test(read('app/build.gradle')));
assert.ok(/versionName '1\.9\.4'/.test(read('app/build.gradle')));

for (const rel of ['miniapp-source/pages/practice/practice.js', 'miniapp-source/pages/exam/exam.js']) {
  const js = read(rel);
  assert.ok(/typeChipClass:\s*'chip-tone-blue'/.test(js));
  assert.ok(/difficultyChipClass:\s*'chip-tone-amber'/.test(js));
  assert.ok(/sheetChipClass:\s*'chip-tone-violet'/.test(js));
  assert.ok(/editChipClass:\s*'chip-tone-rose'/.test(js));
  assert.ok(!/TOP_CHIP_TONES/.test(js), 'chip roles must not reshuffle while changing questions');
}

const practiceWxml = read('miniapp-source/pages/practice/practice.wxml');
const practiceCss = read('miniapp-source/pages/practice/practice.wxss');
assert.ok(/data-preserve-scroll="practice-topbar"/.test(practiceWxml));
assert.ok(/\.topbar-scroll\s*\{[\s\S]*overflow-x:\s*auto\s*!important/.test(practiceCss));
assert.ok(/touch-action:\s*pan-x/.test(practiceCss));
assert.ok(/-webkit-overflow-scrolling:\s*touch/.test(practiceCss));

const theme = read('web-runtime/theme.css');
assert.ok(/\.tag:not\(\.top-chip\)/.test(theme));
assert.ok(/@keyframes\s+abnormalChipBlueRed/.test(theme));
assert.ok(/background-color:var\(--abnormal-blue-bg\)/.test(theme));
assert.ok(/background-color:var\(--abnormal-red-bg\)/.test(theme));
assert.ok(/\.chip-tone-blue:not\(\.abnormal-type-tag\)/.test(theme));
assert.ok(!/transform:[^;]*(scale|translate)/.test(theme.match(/@keyframes\s+abnormalChipBlueRed\s*\{[\s\S]*?\n\}/)?.[0] || ''), 'abnormal chip must not resize');

console.log('v1.9.4 abnormal chip color and horizontal topbar regression: PASS');
