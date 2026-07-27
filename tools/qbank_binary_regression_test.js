'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = '/tmp/buaiquiz-qbank-binary-test';
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
const importer = require('../miniapp-source/services/docx-importer');
const archiveUtil = require('../miniapp-source/utils/binary-archive');
fs.mkdirSync(root, { recursive: true });
const image = `${root}/choice.png`;
fs.writeFileSync(image, Buffer.from('89504e470d0a1a0a', 'hex'));
const manifest = bankStorage.saveBank({ name: '二进制题库包', sourceName: 'test.docx', questions: [{
  id: 'q1', order: 1, number: '1', type: 'single', displayTypeLabel: '单选题', question: '图片选项题', images: [],
  options: [{ key: 'A', text: '', images: [image] }, { key: 'B', text: '错误', images: [] }], answer: ['A'], answerText: 'A',
  answerImages: [], analysis: '', analysisImages: [], category: '', difficulty: '', status: 'normal', issues: []
}] });
const exported = bankStorage.exportBank(manifest.id);
const parsed = archiveUtil.readArchive(exported);
assert.ok(parsed && parsed.metadata.version === 3, 'QBANK 应使用二进制 v3 格式');
assert.strictEqual(Object.keys(parsed.entries).length, 1, '图片应作为独立二进制资源写入');
const imported = importer.importQbank({ name: '二进制题库包.qbank', path: exported });
assert.strictEqual(imported.questions.length, 1);
assert.ok(fs.existsSync(imported.questions[0].options[0].images[0]), '二进制题库包图片应可恢复');
assert.strictEqual(fs.readFileSync(imported.questions[0].options[0].images[0]).toString('hex'), '89504e470d0a1a0a');
console.log('QBANK binary export/import regression passed');
