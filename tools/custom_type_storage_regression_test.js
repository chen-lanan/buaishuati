'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = '/tmp/buaiquiz-custom-type-test';
fs.rmSync(root, { recursive: true, force: true });
const storage = {};
global.wx = {
  env: { USER_DATA_PATH: root },
  getStorageSync(key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : ''; },
  setStorageSync(key, value) { storage[key] = JSON.parse(JSON.stringify(value)); },
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
const bankStorage = require('../miniapp-source/services/bank-storage');
const questions = [
  { id: 'q1', order: 1, type: 'single', displayTypeLabel: '单选题', question: '正常题', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answer: ['A'], answerText: '', images: [], answerImages: [], analysisImages: [], status: 'normal', issues: [] },
  { id: 'q2', order: 2, type: 'short', displayTypeLabel: '论述题', question: '异常题', options: [], answer: [], answerText: '', images: [], answerImages: [], analysisImages: [], status: 'warning', issues: ['无答案'] }
];
const manifest = bankStorage.saveBank({ name: '自定义题型测试', sourceName: 'test.pdf', kind: 'pdf', questions });
assert.deepStrictEqual(bankStorage.getCustomTypeCatalog(manifest.id), [{ label: '论述题', coreType: 'short' }]);
bankStorage.saveCustomTypeCatalog(manifest.id, [{ label: '论述题', coreType: 'short' }, { label: '案例分析题', coreType: 'short' }]);
assert.ok(bankStorage.getCustomTypeCatalog(manifest.id).some(item => item.label === '案例分析题'));
bankStorage.saveCustomTypeCatalog(manifest.id, [{ label: '论述题', coreType: 'short' }]);
assert.ok(!bankStorage.getCustomTypeCatalog(manifest.id).some(item => item.label === '案例分析题'));
// 仍被题目使用的题型即使从目录中移除，也会从题目本身重新恢复，避免出现悬空分类。
bankStorage.saveCustomTypeCatalog(manifest.id, []);
assert.ok(bankStorage.getCustomTypeCatalog(manifest.id).some(item => item.label === '论述题'));
console.log('custom type catalog storage regression: PASS');
