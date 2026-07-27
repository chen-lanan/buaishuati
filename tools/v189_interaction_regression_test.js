'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

assert.strictEqual(read('VERSION.txt').trim(), '1.8.9');
assert.strictEqual(read('miniapp-source/VERSION.txt').trim(), '1.8.9');
assert.ok(/versionCode 189/.test(read('app/build.gradle')));
assert.ok(/versionName '1\.8\.9'/.test(read('app/build.gradle')));
assert.ok(/const APP_VERSION = '1\.8\.9'/.test(read('miniapp-source/utils/constants.js')));

const runtime = read('web-runtime/runtime.js');
assert.ok(runtime.includes('activeImageViewerDismiss'));
assert.ok(runtime.includes('maxX: Math.max(0, (renderedWidth - stageWidth) / 2)'));
assert.ok(runtime.includes('tx = maxX ? Math.max(-maxX, Math.min(maxX, tx)) : 0'));
assert.ok(runtime.includes('[data-back-dismiss="true"]'));
assert.ok(runtime.includes("target.closest('.donation-dialog')"));
assert.ok(runtime.includes('saveDonationQrAndOpenWeChat'));
assert.ok(runtime.includes('openDonationPayment'));

const practiceJs = read('miniapp-source/pages/practice/practice.js');
const practiceWxml = read('miniapp-source/pages/practice/practice.wxml');
const practiceCss = read('miniapp-source/pages/practice/practice.wxss');
assert.ok(practiceJs.includes('this.pendingSwipes.push(direction)'));
assert.ok(practiceJs.includes('this.drainSwipeQueue()'));
assert.ok(practiceJs.includes('document.addEventListener(\'touchstart\''));
assert.ok(!practiceWxml.includes('bindtouchstart="onTouchStart"'));
assert.ok(practiceWxml.includes('abnormal-type-tag'));
assert.ok(practiceCss.includes('@keyframes abnormalTypePulse'));

const settingsWxml = read('miniapp-source/pages/settings/settings.wxml');
const settingsJs = read('miniapp-source/pages/settings/settings.js');
assert.ok(settingsWxml.includes('捐赠支持'));
assert.ok(settingsWxml.includes('assets/donation_wechat_qr.png'));
assert.ok(settingsWxml.includes('保存到相册并打开微信'));
assert.ok(settingsWxml.includes('直接打开付款页面'));
assert.ok(settingsJs.includes('saveDonationQr()'));
assert.ok(settingsJs.includes('openDonationPayment()'));
assert.ok(fs.existsSync(path.join(ROOT, 'miniapp-source/assets/donation_wechat_qr.png')));

const editorJs = read('miniapp-source/pages/editor/editor.js');
const editorWxml = read('miniapp-source/pages/editor/editor.wxml');
assert.ok(editorJs.includes('editCustomType(event)'));
assert.ok(editorJs.includes('saveCustomType()'));
assert.ok(editorJs.includes('deleteCustomType(event)'));
assert.ok(editorWxml.includes('保存题型修改'));

const android = read('app/src/main/java/com/buaiquiz/quiz/android/MainActivity.java');
const manifest = read('app/src/main/AndroidManifest.xml');
assert.ok(android.includes('MediaStore.Images.Media.RELATIVE_PATH'));
assert.ok(android.includes('weixin://scanqrcode'));
assert.ok(android.includes('DONATION_PAYMENT_URL'));
assert.ok(manifest.includes('android.permission.WRITE_EXTERNAL_STORAGE'));
assert.ok(manifest.includes('com.tencent.mm'));

global.wx = { env: { USER_DATA_PATH: '/tmp/buai-v189-test' }, getFileSystemManager: () => ({}) };

const questions = [
  { id: 'q1', order: 1, type: 'single', displayTypeLabel: '单选题', status: 'normal', question: '正常单选', options: [{ key: 'A', text: 'A' }, { key: 'B', text: 'B' }], answer: ['A'] },
  { id: 'q2', order: 2, type: 'single', displayTypeLabel: '单选题', status: 'warning', question: '异常单选', options: [{ key: 'A', text: '' }], answer: [] },
  { id: 'q3', order: 3, type: 'short', displayTypeLabel: '论述题', status: 'error', question: '异常论述', options: [], answer: [], answerText: '' },
  { id: 'q4', order: 4, type: 'single', displayTypeLabel: '单选题', status: 'error', sourceMissingPlaceholder: true, nonPractice: true, question: '缺失占位', options: [], answer: [] }
];
const mocks = {
  './bank-storage': { loadQuestions: () => JSON.parse(JSON.stringify(questions)) },
  './record-storage': {
    getMasteredIds: () => [], getSettings: () => ({ shuffleOptions: false }),
    getWrong: () => ({}), getFavoriteIds: () => []
  }
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent && /practice-service\.js$/.test(parent.filename) && mocks[request]) return mocks[request];
  return originalLoad.call(this, request, parent, isMain);
};
const servicePath = require.resolve('../miniapp-source/services/practice-service');
delete require.cache[servicePath];
const service = require(servicePath);
Module._load = originalLoad;
const base = { bankId: 'b1', bankName: '测试', mode: 'sequence', count: 0 };
assert.deepStrictEqual(service.createSession({ ...base, type: 'all' }).questions.map(item => item.id), ['q1', 'q2', 'q3']);
assert.deepStrictEqual(service.createSession({ ...base, type: 'display:单选题' }).questions.map(item => item.id), ['q1', 'q2']);
assert.deepStrictEqual(service.createSession({ ...base, type: 'abnormal' }).questions.map(item => item.id), ['q2', 'q3']);

console.log('v1.8.9 image, abnormal, swipe, type manager and donation regression: PASS');
