const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

assert.strictEqual(read('VERSION.txt').trim(), '1.9.0');
assert.strictEqual(read('miniapp-source/VERSION.txt').trim(), '1.9.0');
assert.ok(/versionCode 190/.test(read('app/build.gradle')));
assert.ok(/versionName '1\.9\.0'/.test(read('app/build.gradle')));

const practiceWxml = read('miniapp-source/pages/practice/practice.wxml');
const practiceCss = read('miniapp-source/pages/practice/practice.wxss');
assert.ok(practiceWxml.includes('topbar-scroll-shell'));
assert.ok(practiceWxml.includes('scroll-x class="topbar-scroll"'));
assert.ok(practiceWxml.includes('topbar-divider'));
assert.ok(/\.topbar[\s\S]*flex-wrap:\s*nowrap/.test(practiceCss));
assert.ok(practiceCss.includes('-webkit-mask-image: linear-gradient'));
assert.ok(practiceCss.includes('#page-root[data-page="pages/practice/practice"] .abnormal-type-tag'));
assert.ok(/animation:\s*abnormalTypePulse/.test(practiceCss));
assert.ok(!practiceCss.includes('prefers-reduced-motion'));

const configJs = read('miniapp-source/pages/practice-config/practice-config.js');
const configWxml = read('miniapp-source/pages/practice-config/practice-config.wxml');
assert.ok(configJs.includes("value: 'abnormal', label: '异常题'"));
assert.ok(!configJs.includes('仅异常题'));
assert.ok(configWxml.includes('包含当前题库全部可进入的正常题和异常题'));

const practiceServiceJs = read('miniapp-source/services/practice-service.js');
const runtimeJs = read('web-runtime/runtime.js');
const baseCss = read('web-runtime/base.css');
const themeCss = read('web-runtime/theme.css');
assert.ok(configJs.includes("if (status !== 'normal') {"));
assert.ok(configJs.includes('abnormalCount += 1;\n      return;'));
assert.ok(practiceServiceJs.includes("if ((item.status || 'normal') !== 'normal') return false;"));
assert.ok(practiceServiceJs.includes("(item.status || 'normal') === 'normal' && item.type === config.type"));
assert.ok(runtimeJs.includes('picker-modal-card'));
assert.ok(runtimeJs.includes('picker-item-check'));
assert.ok(baseCss.includes('.picker-modal-header'));
assert.ok(themeCss.includes('background:var(--theme-accent-soft)!important'));
assert.ok(themeCss.includes('border-color:var(--theme-accent-border)!important'));
assert.ok(!runtimeJs.includes('saveDonationQrAndOpenWeChat'));
assert.ok(!runtimeJs.includes('openDonationPayment'));
assert.ok(!runtimeJs.includes('payapp.wechatpay.cn'));
assert.ok(!baseCss.includes('donation-payment-layer'));
const mainActivity = read('app/src/main/java/com/buaiquiz/quiz/android/MainActivity.java');
const manifest = read('app/src/main/AndroidManifest.xml');
assert.ok(!mainActivity.includes('DONATION_'));
assert.ok(!mainActivity.includes('saveDonationQr'));
assert.ok(!manifest.includes('WRITE_EXTERNAL_STORAGE'));

const settingsWxml = read('miniapp-source/pages/settings/settings.wxml');
const settingsJs = read('miniapp-source/pages/settings/settings.js');
assert.ok(!settingsWxml.includes('捐赠支持'));
assert.ok(!settingsWxml.includes('donation-'));
assert.ok(!settingsJs.includes('openDonation'));
assert.ok(!settingsJs.includes('donationVisible'));
assert.ok(!fs.existsSync(path.join(ROOT, 'miniapp-source/assets/donation_wechat_qr.png')));
console.log('v1.9.0 header, abnormal pulse, type filter and donation removal regression: PASS');
