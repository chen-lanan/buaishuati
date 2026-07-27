const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

assert.strictEqual(read('VERSION.txt').trim(), '1.9.5');
assert.strictEqual(read('miniapp-source/VERSION.txt').trim(), '1.9.5');
assert.ok(/versionCode 195/.test(read('app/build.gradle')));
assert.ok(/versionName '1\.9\.5'/.test(read('app/build.gradle')));

const theme = read('web-runtime/theme.css');
const block = theme.match(/@keyframes\s+abnormalChipBlueRed\s*\{[\s\S]*?\n\}/)?.[0] || '';
assert.ok(block, 'abnormal chip animation is missing');
assert.ok(/background-color:var\(--abnormal-blue-bg\)/.test(block));
assert.ok(/background-color:var\(--abnormal-red-bg\)/.test(block));
assert.ok(/box-shadow:\s*inset/.test(block), 'warning highlight must be inset');
for (const value of [...block.matchAll(/box-shadow:\s*([^;]+);/g)].map(m => m[1].trim())) {
  assert.ok(value.startsWith('inset'), `outer warning shadow must not be used: ${value}`);
}
assert.ok(!/transform:[^;]*(scale|translate)/.test(block), 'abnormal chip must not resize or move');
assert.ok(/\.top-chip\.abnormal-type-tag[\s\S]*box-shadow:inset/.test(theme));

const builtTheme = read('app/src/main/assets/web/theme.css');
assert.ok(/inset 0 0 calc\(12 \* var\(--rpx\)\)/.test(builtTheme));
assert.ok(!/box-shadow:0 0 calc\(16 \* var\(--rpx\)\)/.test(builtTheme));

console.log('v1.9.5 abnormal chip internal-highlight regression: PASS');
