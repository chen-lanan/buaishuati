const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const extractor = fs.readFileSync(path.join(root, 'miniapp-source/services/pdf-extractor.js'), 'utf8');
const importer = fs.readFileSync(path.join(root, 'miniapp-source/services/docx-importer.js'), 'utf8');
if (!extractor.includes('(completedPages / pages.length) * 81')) throw new Error('PDF page progress mapping missing');
if (!extractor.includes('PDF 页面读取完成，共 ${pages.length} 页')) throw new Error('PDF completion stage missing');
if (!importer.includes('onProgress(97, `页面读取完成，正在整理')) throw new Error('97% parse stage missing');
if (!importer.includes("onProgress(99, '正在检查 PDF 题目、答案与图片')")) throw new Error('99% validation stage missing');
function progress(completed, total) { return Math.min(96, 15 + Math.round((completed / total) * 81)); }
const total = 261;
const checkpoints = [[0,15],[147,61],[259,95],[260,96],[261,96]];
for (const [done, expected] of checkpoints) {
  const actual = progress(done, total);
  if (actual !== expected) throw new Error(`progress ${done}/${total}: ${actual} != ${expected}`);
}
let previous = 0;
for (let done = 0; done <= total; done += 1) {
  const current = progress(done, total);
  if (current < previous) throw new Error('progress regressed');
  previous = current;
}
console.log('v1.9.8 PDF progress regression passed');
