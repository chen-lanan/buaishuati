'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(process.argv[2] || path.resolve(__dirname, '..'));
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const practice = read('miniapp-source/pages/practice/practice.js');
const exam = read('miniapp-source/pages/exam/exam.js');
const mastered = read('miniapp-source/pages/mastered/mastered.js');
const masteredTemplate = read('miniapp-source/pages/mastered/mastered.wxml');
const resultTemplate = read('miniapp-source/pages/result/result.wxml');
const resultScript = read('miniapp-source/pages/result/result.js');
const appJson = JSON.parse(read('miniapp-source/app.json'));
const bankStorage = read('miniapp-source/services/bank-storage.js');
const recordStorage = read('miniapp-source/services/record-storage.js');

const body = (source, name) => {
  const match = source.match(new RegExp(`${name}\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\},`));
  assert.ok(match, `应找到 ${name}`);
  return match[1];
};
assert.ok(/^\s*this\.clearAutoNext\(\);/.test(body(practice, 'editCurrentQuestion')), '编辑前必须立即取消自动下一题');
assert.ok(/^\s*this\.clearAutoNext\(\);/.test(body(practice, 'openQuestionSheet')), '打开题卡前必须取消自动下一题');
assert.ok(/^\s*this\.clearAutoNext\(\);/.test(body(practice, 'masterCurrent')), '标记掌握前必须取消自动下一题');
assert.ok(/^\s*this\.clearAutoNext\(\);/.test(body(practice, 'removeCurrentAfterMastered')), '移除掌握题前必须取消自动下一题');
assert.ok(/!this\.pageVisible \|\| this\.pendingQuestionEdit \|\| this\.data\.showQuestionSheet/.test(practice), '自动跳题回调必须检查页面、编辑和题卡状态');
assert.ok(/this\.data\.question\.id !== scheduledQuestionId/.test(practice), '自动跳题回调必须确认仍是原题');
assert.ok(!/clearProgressForBank/.test(practice), '练习完成或掌握最后一题不得自动清除顺序进度');
assert.ok(/persistProgress\(allCompleted \? 'finish-completed-all'/.test(practice), '完整做完最后一道也必须保存进度');

assert.ok(/bankStorage\.listBanks\(\)/.test(mastered) && /getMasteredIds\(bank\.id\)/.test(mastered), '已掌握首页必须按题库聚合');
assert.ok(/rowKey: `\$\{bankId\}:\$\{question\.id\}`/.test(mastered), '已掌握题行键必须包含题库 ID');
assert.ok(/原练习进度不会被删除/.test(mastered) && /不会清除原练习进度/.test(masteredTemplate), '移出已掌握必须明确保留原进度');

assert.ok(appJson.pages.includes('pages/exam-review/exam-review'), '必须注册整卷复盘页面');
assert.ok(/查看本次试卷/.test(resultTemplate) && /reviewExam\(\)/.test(resultScript), '考试结果页必须可查看整张试卷');
assert.ok(/saveExamDraft/.test(exam) && /clearExamDraft/.test(exam), '模拟考试必须自动保存并在交卷后清除草稿');
assert.ok(/session\.editPausedAt/.test(exam), '考试草稿必须记录编辑暂停点，恢复时不计编辑时间');
assert.ok(/EXAM_DRAFT_FILE/.test(recordStorage), '考试草稿必须落盘而非只存运行内存');

assert.ok(/version:\s*2[\s\S]*appVersion:\s*APP_VERSION/.test(bankStorage), '完整备份应使用动态版本号和二进制 v2 格式');
assert.ok(/binaryArchive\.createArchive/.test(bankStorage), '题库导出与完整备份必须使用二进制资源容器');
assert.ok(!/\n\s*banks,\n\s*banks,/.test(bankStorage), '完整备份清单不得出现重复字段');

const gradients = [];
(function walk(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (/\.wxss$/.test(entry.name) && /(?:linear|radial)-gradient/.test(fs.readFileSync(target, 'utf8'))) gradients.push(target);
  });
})(path.join(root, 'miniapp-source'));
(function walkRuntime(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) walkRuntime(target);
    else if (/\.css$/.test(entry.name) && /(?:linear|radial)-gradient/.test(fs.readFileSync(target, 'utf8'))) gradients.push(target);
  });
})(path.join(root, 'web-runtime'));
assert.deepStrictEqual(gradients, [], '莫奈界面应统一为纯色，不保留渐变');
assert.strictEqual(read('VERSION.txt').trim(), '1.8.4');
assert.strictEqual(read('miniapp-source/VERSION.txt').trim(), '1.8.4');
assert.ok(/versionCode 184/.test(read('app/build.gradle')) && /versionName '1\.8\.4'/.test(read('app/build.gradle')));
console.log('v1.8.4 integrated regression passed');
