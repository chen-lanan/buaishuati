const assert = require('assert');
const fs = require('fs');
const path = require('path');
const testRoot = '/tmp/buai-test-memorize-scope';
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
      readFileSync(target, encoding) { return fs.readFileSync(target, encoding || 'utf8'); },
      writeFileSync(target, data, encoding) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data, encoding || 'utf8'); },
      copyFileSync(source, target) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target); },
      statSync(target) { const stat = fs.statSync(target); return { size: stat.size, isDirectory: () => stat.isDirectory(), isFile: () => stat.isFile() }; },
      readdirSync(target) { return fs.readdirSync(target); },
      unlinkSync(target) { fs.unlinkSync(target); },
      rmdirSync(target) { fs.rmSync(target, { recursive: true, force: true }); }
    };
  }
};
const records = require('../miniapp-source/services/record-storage');
records.saveMemorizeProgress('bank1', {
  mode: 'memorize',
  memorizeOrder: 'random',
  cursor: { questionId: 'q4', index: 2 },
  cursors: {
    'sequence|all|0': { questionId: 'q2', index: 1 },
    'random|all|0': { questionId: 'q4', index: 2 }
  },
  randomSequences: {
    'random|all|0': [{ questionId: 'q4' }, { questionId: 'q1' }]
  }
});
let progress = records.getMemorizeProgress('bank1');
assert.strictEqual(progress.progressVersion, 2);
assert.strictEqual(records.clearMemorizeProgressScope('bank1', 'random|all|0'), true);
progress = records.getMemorizeProgress('bank1');
assert.ok(progress.cursors['sequence|all|0'], '清除随机背题不得影响顺序背题');
assert.ok(!progress.cursors['random|all|0']);
assert.ok(!progress.randomSequences['random|all|0']);
assert.strictEqual(records.clearMemorizeProgressScope('bank1', 'sequence|all|0', 'all|0'), true);
assert.strictEqual(records.getMemorizeProgress('bank1'), null, '最后一个背题进度清除后应删除记录文件');
console.log('memorize progress scope regression: PASS');
