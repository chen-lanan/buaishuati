'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = '/tmp/buaiquiz-backup-test';
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
const binaryArchive = require('../miniapp-source/utils/binary-archive');
const records = require('../miniapp-source/services/record-storage');
records.initDefaults();
const image = `${root}/source.png`;
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(image, Buffer.from('89504e470d0a1a0a', 'hex'));
const manifest = bankStorage.saveBank({
  name: '备份测试题库', sourceName: 'backup-test.docx', kind: 'docx', questions: [{
    id: 'q1', number: '1', type: 'single', displayTypeLabel: '单选题', category: '测试', difficulty: '简单',
    question: '测试题', images: [], options: [{ key: 'A', text: '', images: [image] }, { key: 'B', text: '错误', images: [] }],
    answer: ['A'], answerText: 'A', answerImages: [], analysis: '解析', analysisImages: [image], status: 'normal', issues: []
  }]
});
records.markWrong(manifest.id, 'q1');
records.toggleFavorite(manifest.id, 'q1');
records.setMastered(manifest.id, 'q1', true);
records.saveProgress(manifest.id, { mode: 'sequence', nextIndex: 1, questionStates: [] });
records.saveSettings(Object.assign(records.getSettings(), { fontScale: 1.2 }));
records.recordAnswer(true, { bankId: manifest.id, typeLabel: '单选题', difficulty: '简单', category: '测试' });
const backup = bankStorage.createFullBackup();
assert.ok(fs.existsSync(backup), '完整备份文件应生成');

// 损坏备份必须在删除当前数据之前被拒绝。
const broken = `${root}/broken.buaiquiz`;
const parsedArchive = binaryArchive.readArchive(backup);
assert.ok(parsedArchive && parsedArchive.metadata.version === 2, '完整备份应使用二进制 v2 容器');
const brokenPayload = JSON.parse(JSON.stringify(parsedArchive.metadata));
fs.writeFileSync(broken, JSON.stringify(brokenPayload));
assert.throws(() => bankStorage.restoreFullBackup(broken, true), /缺少图片资源/);
assert.strictEqual(bankStorage.listBanks().length, 1, '损坏备份失败后原题库必须保留');

bankStorage.deleteBank(manifest.id);
records.clearLearningRecords();
assert.strictEqual(bankStorage.listBanks().length, 0);
const restored = bankStorage.restoreFullBackup(backup, true);
assert.strictEqual(restored.bankCount, 1);
const banks = bankStorage.listBanks();
assert.strictEqual(banks.length, 1);
const questions = bankStorage.loadQuestions(banks[0].id);
assert.strictEqual(questions.length, 1);
assert.ok(fs.existsSync(questions[0].options[0].images[0]), '选项图片应恢复');
assert.ok(fs.existsSync(questions[0].analysisImages[0]), '解析图片应恢复');
assert.ok(records.getWrong(banks[0].id).q1, '错题记录应恢复');
assert.ok(records.getFavoriteIds(banks[0].id).includes('q1'), '收藏应恢复');
assert.ok(records.getMastered(banks[0].id).q1, '已掌握应恢复');
assert.ok(records.getProgress(banks[0].id), '进度应恢复');
assert.strictEqual(records.getSettings().fontScale, 1.2, '设置应恢复');
assert.strictEqual(records.getStats().answered, 1, '统计应恢复');
console.log(JSON.stringify({ backup, bankCount: banks.length, questionCount: questions.length, settings: records.getSettings().fontScale }, null, 2));
console.log('Full backup regression passed');
