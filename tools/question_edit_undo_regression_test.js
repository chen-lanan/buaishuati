'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = '/tmp/buaiquiz-question-edit-test';
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
const questions = Array.from({ length: 205 }, (_, index) => ({
  id: `q${index + 1}`, order: index + 1, number: String(index + 1), type: 'single', displayTypeLabel: '单选题',
  question: `题目 ${index + 1}`, category: '测试', difficulty: '', images: [],
  options: [{ key: 'A', text: '正确', images: [] }, { key: 'B', text: '错误', images: [] }],
  answer: ['A'], answerText: 'A', answerImages: [], analysis: '', analysisImages: [], status: 'normal', issues: []
}));
const manifest = bankStorage.saveBank({ name: '分片编辑测试', sourceName: 'test.docx', questions });
assert.strictEqual(manifest.chunks.length, 2, '205 道题应拆成两个分片');
const bankDir = `${root}/question-banks/${manifest.id}`;
const secondChunk = `${bankDir}/${manifest.chunks[1].fileName}`;
const secondBefore = fs.readFileSync(secondChunk, 'utf8');
const first = bankStorage.loadQuestions(manifest.id)[0];
bankStorage.updateQuestion(manifest.id, { ...first, question: '修改后的第一题', difficulty: '困难' });
assert.strictEqual(fs.readFileSync(secondChunk, 'utf8'), secondBefore, '编辑第一题不得重写无关分片');
assert.strictEqual(bankStorage.loadQuestions(manifest.id)[0].question, '修改后的第一题');
assert.strictEqual(bankStorage.canUndoQuestionEdit(manifest.id, 'q1'), true, '保存后应提供一次撤销');
bankStorage.undoLastQuestionEdit(manifest.id, 'q1');
assert.strictEqual(bankStorage.loadQuestions(manifest.id)[0].question, '题目 1', '撤销应恢复编辑前题目');
assert.strictEqual(bankStorage.canUndoQuestionEdit(manifest.id, 'q1'), false, '撤销完成后不应保留失效快照');
console.log('Question partial edit and undo regression passed');
