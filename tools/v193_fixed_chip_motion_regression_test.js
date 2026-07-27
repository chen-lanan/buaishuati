const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
assert.strictEqual(read('VERSION.txt').trim(), '1.9.3');
assert.strictEqual(read('miniapp-source/VERSION.txt').trim(), '1.9.3');
assert.ok(/versionCode 193/.test(read('app/build.gradle')));
assert.ok(/versionName '1\.9\.3'/.test(read('app/build.gradle')));
const base = read('web-runtime/base.css');
assert.ok(/pageEnter \.15s/.test(base));
for (const rel of ['miniapp-source/pages/practice/practice.js','miniapp-source/pages/exam/exam.js']) {
  const js = read(rel);
  assert.ok(/function buildTopChipClasses\(sessionKey\)/.test(js));
  assert.ok(/this\.topChipClasses = buildTopChipClasses/.test(js));
  assert.ok(/this\.topChipClasses \|\| buildTopChipClasses/.test(js));
  assert.ok(!/buildTopChipClasses\(question\)/.test(js));
  assert.ok(!/question && question\.id/.test(js));
}
const css = read('miniapp-source/pages/practice/practice.wxss');
const animation = css.slice(css.indexOf('@keyframes abnormalTypePulse'));
assert.ok(/animation: abnormalTypePulse 1\.8s/.test(css));
assert.ok(!/transform\s*:/.test(animation));
assert.ok(!/background\s*:/.test(animation));
assert.ok(/box-shadow/.test(animation));
console.log('v1.9.3 fixed top-chip palette and motion regression: PASS');
