const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const assert = require('assert');

assert.strictEqual(read('VERSION.txt').trim(), '1.9.2');
assert.strictEqual(read('miniapp-source/VERSION.txt').trim(), '1.9.2');
assert.ok(/versionCode 192/.test(read('app/build.gradle')));
assert.ok(/versionName '1\.9\.2'/.test(read('app/build.gradle')));
assert.ok(/CURRENT_PARSER_VERSION = '1\.9\.2'/.test(read('miniapp-source/utils/constants.js')));

const practiceJs = read('miniapp-source/pages/practice/practice.js');
const practiceWxml = read('miniapp-source/pages/practice/practice.wxml');
const practiceCss = read('miniapp-source/pages/practice/practice.wxss');
const theme = read('web-runtime/theme.css');
const editorCss = read('miniapp-source/pages/editor/editor.wxss');
const runtime = read('web-runtime/runtime.js');
const baseCss = read('web-runtime/base.css');

assert.ok(/typeChipClass: 'chip-tone-blue'/.test(practiceJs));
assert.ok(/TOP_CHIP_TONES = \['chip-tone-violet', 'chip-tone-amber', 'chip-tone-rose', 'chip-tone-cyan'\]/.test(practiceJs));
assert.ok(/top-chip type-chip \{\{typeChipClass\}\}/.test(practiceWxml));
['blue','violet','amber','rose','cyan'].forEach(tone => {
  assert.ok(theme.includes(`.top-chip.chip-tone-${tone}`), `missing ${tone} chip theme`);
});
assert.ok(theme.includes('html[data-appearance="dark"]'));
assert.ok(theme.includes('html[data-appearance="amoled"]'));
assert.ok(theme.includes('.type-manager-card'));
assert.ok(editorCss.includes('background: var(--theme-surface-strong'));
assert.ok(/animation: abnormalTypePulse 1\.8s/.test(practiceCss));
assert.ok(/transform: scale\(1\.055\)/.test(practiceCss));
assert.ok(/width: calc\(100% - calc\(40 \* var\(--rpx\)\)\)/.test(practiceCss));
assert.ok(/border-radius: calc\(999 \* var\(--rpx\)\)/.test(practiceCss));
assert.ok(runtime.includes('instance.__suspendRender = true'));
assert.ok(runtime.includes('instance.__renderQueued'));
assert.ok(runtime.includes('queueMicrotask'));
assert.ok(baseCss.includes('animation: pageEnter .11s'));

console.log('v1.9.2 theme, progress and navigation responsiveness regression: PASS');
