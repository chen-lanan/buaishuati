const assert = require('assert');
const fs = require('fs');
const path = require('path');
const testRoot = '/tmp/buai-test-progress-storage';
fs.rmSync(testRoot, { recursive: true, force: true });
const store = {};
global.wx = {
  env: { USER_DATA_PATH: testRoot },
  getStorageSync(key) { return store[key]; },
  setStorageSync(key, value) { store[key] = JSON.parse(JSON.stringify(value)); },
  getFileSystemManager() {
    return {
      accessSync(target) { fs.accessSync(target); },
      mkdirSync(target) { fs.mkdirSync(target, { recursive: true }); },
      readFileSync(target, encoding) { return encoding === 'base64' ? fs.readFileSync(target).toString('base64') : fs.readFileSync(target, encoding || 'utf8'); },
      writeFileSync(target, data, encoding) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data, encoding === 'base64' ? 'base64' : (encoding || 'utf8')); },
      copyFileSync(source, target) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target); },
      statSync(target) { const stat = fs.statSync(target); return { size: stat.size, isDirectory: () => stat.isDirectory(), isFile: () => stat.isFile() }; },
      readdirSync(target) { return fs.readdirSync(target); },
      unlinkSync(target) { fs.unlinkSync(target); },
      rmdirSync(target) { fs.rmSync(target, { recursive: true, force: true }); }
    };
  }
};
const records = require('../miniapp-source/services/record-storage');
records.saveProgress('bank1', {
  mode: 'sequence', index: 7, questionId: 'q8',
  questionStates: [{ questionId: 'q1', selected: ['A'], result: { correct: true } }]
});
let progress = records.getProgress('bank1');
assert.strictEqual(progress.index, 7);
assert.strictEqual(progress.progressVersion, 4);
assert.strictEqual(progress.questionStates.length, 1);
assert.strictEqual(records.saveProgress('bank1', { mode: 'random', index: 99 }), false);
progress = records.getProgress('bank1');
assert.strictEqual(progress.index, 7, '随机练习不得覆盖顺序进度');
assert.strictEqual(records.clearProgressForBank('bank1'), true);
assert.strictEqual(records.getProgress('bank1'), null);

assert.strictEqual(records.saveMemorizeProgress('bank1', {
  mode: 'memorize',
  memorizeOrder: 'sequence',
  cursors: { 'all|0': { questionId: 'q3', index: 2 } }
}), true);
let memorizeProgress = records.getMemorizeProgress('bank1');
assert.strictEqual(memorizeProgress.memorizeOrder, 'sequence');
assert.strictEqual(memorizeProgress.cursors['all|0'].questionId, 'q3');
assert.strictEqual(memorizeProgress.cursors['all|0'].index, 2);
assert.strictEqual(records.clearMemorizeProgressForBank('bank1'), true);
assert.strictEqual(records.getMemorizeProgress('bank1'), null);

console.log('progress storage regression: PASS (13 assertions)');
