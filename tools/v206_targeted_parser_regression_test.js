'use strict';
const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sourceRoot = path.resolve(process.argv[2] || path.resolve(__dirname, '..'));
const pdfPath = process.argv[3];
const specialDocxPath = process.argv[4];
if (!pdfPath || !specialDocxPath) {
  throw new Error('usage: node v206_targeted_parser_regression_test.js <source-root> <main-bank.pdf> <special.docx>');
}

const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'buaiquiz-v206-user-'));
global.wx = {
  env: { USER_DATA_PATH: userRoot },
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

const { extractPdf } = require(path.join(sourceRoot, 'miniapp-source/services/pdf-extractor'));
const { extractDocx } = require(path.join(sourceRoot, 'miniapp-source/services/docx-extractor'));
const { parseParagraphsAdaptive } = require(path.join(sourceRoot, 'miniapp-source/services/question-parser'));

function findQuestion(result, text) {
  const question = result.questions.find(item => String(item.question || '').includes(text));
  assert(question, `未找到题目：${text}`);
  return question;
}

(async () => {
  // 1) 只修主库 PDF 的“简答答案编号续行”边界，不再把第 3 条答案当成新题。
  const pdfExtracted = await extractPdf(pdfPath, path.join(userRoot, 'pdf-work'));
  const pdf = parseParagraphsAdaptive(pdfExtracted.paragraphs, {
    sourceName: path.basename(pdfPath), sourceKind: 'pdf', useLocalAI: false
  });
  const flange = findQuestion(pdf, '安装法兰应注意哪些事情');
  assert.strictEqual(flange.type, 'short');
  assert(flange.answerText.includes('1）'), '法兰简答应保留第 1 条答案');
  assert(flange.answerText.includes('2）'), '法兰简答应保留第 2 条答案');
  assert(flange.answerText.includes('3）在拧紧螺帽时'), '法兰简答应把第 3 条答案留在同一题');
  assert(!pdf.questions.some(item => /^在拧紧螺帽时/.test(String(item.question || ''))), '第 3 条答案不得再生成独立题目');
  const flangeIndex = pdf.questions.indexOf(flange);
  assert(pdf.questions[flangeIndex + 1] && String(pdf.questions[flangeIndex + 1].number) === '14', '法兰简答后应直接进入第 14 题');

  // 2) 特殊 Word：文末 Word 自动编号答案附录只能回填现有题，不能生成 B/C/√/× 假题。
  const docxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buaiquiz-v206-docx-'));
  childProcess.execFileSync('unzip', ['-q', specialDocxPath, '-d', docxDir]);
  const special = parseParagraphsAdaptive(extractDocx(docxDir), {
    sourceName: path.basename(specialDocxPath), sourceKind: 'docx', useLocalAI: false
  });
  assert.strictEqual(special.questions.length, 71, '特殊 Word 应得到 71 道实际题目');
  assert.strictEqual(special.diagnostics.centralAnswerEntryCount, 41, '应识别 41 条 Word 自动编号答案附录');
  assert.strictEqual(special.diagnostics.centralAnswerAppliedCount, 41, '41 条答案附录均应准确回填');
  assert.strictEqual(special.questions.filter(item => item.status === 'error').length, 0, '特殊 Word 不应产生失败题');
  assert.strictEqual(special.questions.filter(item => item.status === 'warning').length, 0, '特殊 Word 不应产生待检查题');
  assert.strictEqual(special.questions.filter(item => /^[A-L√×✓✕]$/.test(String(item.question || '').trim())).length, 0, '答案字母/对错符号不得成为独立题目');

  const q8Fill = findQuestion(special, '点记录的合法字符');
  assert.strictEqual(q8Fill.answerText, '下划线', '括号中的“自动中间点除外”是说明，不是填空答案');
  assert(q8Fill.question.includes('自动中间点除外'), '说明文字应保留在题干');

  const q9 = findQuestion(special, '测4~20mA电流信号');
  assert.deepStrictEqual(q9.answer, ['D']);
  assert.strictEqual(q9.options.length, 4);

  const radar = findQuestion(special, '雷达液位计是通过测出微波');
  assert.deepStrictEqual(radar.answer, ['B']);
  assert.deepStrictEqual(radar.options.map(item => item.text), ['微波衰减度', '时间', '声纳', '液体粘度']);

  const oxygenGauge = findQuestion(special, '氧气压力表应涂有');
  assert.deepStrictEqual(oxygenGauge.answer, ['A']);
  assert.deepStrictEqual(oxygenGauge.options.map(item => item.text), ['天蓝色', '深绿色', '黄色', '白色']);

  const firstAppendixChoice = findQuestion(special, 'MMI的全称');
  const lastAppendixChoice = findQuestion(special, '过程画面组态工具GB');
  assert.deepStrictEqual(firstAppendixChoice.answer, ['B']);
  assert.deepStrictEqual(lastAppendixChoice.answer, ['D']);

  const trailingJudge = findQuestion(special, '控制阀分为气开和气关两种');
  assert.deepStrictEqual(trailingJudge.answer, ['B']);
  assert(!/错\s*$/.test(trailingJudge.question), '题干尾部“错”应拆成判断答案');

  const short1 = findQuestion(special, '简述 EDPF-NT Plus 系统中点记录');
  const short2 = findQuestion(special, '简述系统机柜类型');
  assert(short1.answerText.includes('硬件点') && short1.answerText.includes('手工中间点'), '简答题 1 应完整回填附录答案');
  assert(short2.answerText.includes('A1 对应地址 1') && short2.answerText.includes('D1 对应地址 25'), '简答题 2 应完整回填附录答案');

  console.log(JSON.stringify({
    pdf: { questionCount: pdf.questions.length, flangeAnswerLength: flange.answerText.length },
    specialDocx: { questionCount: special.questions.length, centralAnswers: special.diagnostics.centralAnswerAppliedCount }
  }, null, 2));
  console.log('v2.0.6 targeted parser regression passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(userRoot, { recursive: true, force: true });
});
