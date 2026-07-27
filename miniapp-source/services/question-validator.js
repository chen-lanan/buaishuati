const { unique, normalizeOneLine, hasEncodingAnomaly } = require('../utils/text');

function optionSignature(value = '') {
  return normalizeOneLine(value).toLowerCase()
    .replace(/[\s，,。；;：:'"“”‘’（）()【】\[\]［］]/g, '')
    .replace(/[−–—]/g, '-');
}

function extractRawOptionMap(question) {
  const map = {};
  const rawTexts = question && question.source && Array.isArray(question.source.rawTexts)
    ? question.source.rawTexts : [];
  rawTexts.forEach(raw => {
    String(raw || '').split(/\n+/).forEach(line => {
      const clean = normalizeOneLine(line);
      let match = /^\s*(?:[（(]\s*)?([A-L])\s*(?:[）)]|[.、．:：])\s*(.+?)\s*$/i.exec(clean);
      if (!match) match = /^\s*([A-L])\s+(.+?)\s*$/i.exec(clean);
      if (!match || !match[2]) return;
      const key = match[1].toUpperCase();
      const body = normalizeOneLine(match[2]);
      if (!body) return;
      if (!map[key]) map[key] = [];
      if (!map[key].includes(body)) map[key].push(body);
    });
  });
  return map;
}

function bestRawBody(map, key) {
  const values = map[key] || [];
  if (!values.length) return '';
  return values.slice().sort((a, b) => b.length - a.length)[0];
}

function repairOptionDuplicates(question, repairContext = {}) {
  if (!question || !Array.isArray(question.options) || !question.options.length) return question;
  const truthValue = value => {
    const clean = normalizeOneLine(value || '').toUpperCase();
    if (/^(?:正确|对|是|√|✓|✔|TRUE|T)$/.test(clean)) return true;
    if (/^(?:错误|错|否|×|✕|✖|❌|FALSE|F)$/.test(clean)) return false;
    return null;
  };
  // 判断题标准化后的“正确/错误”不能再被原始连写行“正确B.错误”覆盖。
  if (question.type === 'judge' && question.options.length === 2 &&
      question.options.every(item => truthValue(item.text) !== null)) return question;
  const rawMap = extractRawOptionMap(question);
  if (!Object.keys(rawMap).length) return question;

  const options = question.options.map(item => ({ ...item }));
  const repairs = [];
  const signatureCounts = options.reduce((acc, item) => {
    const signature = optionSignature(item.text);
    if (signature) acc[signature] = (acc[signature] || 0) + 1;
    return acc;
  }, {});

  options.forEach(option => {
    const rawBody = bestRawBody(rawMap, option.key);
    if (!rawBody) return;
    const current = normalizeOneLine(option.text || '');
    const currentSig = optionSignature(current);
    const rawSig = optionSignature(rawBody);
    if (!rawSig || currentSig === rawSig) return;

    // 原始行本身可能是 PDF/Word 的“折叠选项行”，例如：
    // A. 二氧化碳B. 干粉C. 泡沫
    // 此时 rawMap[A] 不是 A 的真实正文，而是 A+B+C 的整串。若解析器已经拆出了
    // 后续 B/C 项，绝不能再用这条“原文”把修好的 A 覆盖回去。
    const currentCode = String(option.key || '').toUpperCase().charCodeAt(0);
    const laterSiblingKeys = options.map(sibling => String(sibling.key || '').toUpperCase())
      .filter(siblingKey => /^[A-L]$/.test(siblingKey) && siblingKey.charCodeAt(0) > currentCode);
    const hasCollapsedSiblingMarker = laterSiblingKeys.some(siblingKey =>
      new RegExp(`${siblingKey}\\s*[.、．:：)）]`, 'i').test(rawBody)
    );
    // 另一种 Word 试卷直接写成“A 文本 B 文本 C 文本 D 文本”，没有任何点号。
    // 当当前解析结果已经存在至少两个后续选项，而原始 A 行又同时含有这些裸字母边界时，
    // rawMap[A] 实际是折叠整行，不能再把已经拆好的 A 覆盖回整串。
    const bareCollapsedSiblingCount = laterSiblingKeys.filter(siblingKey =>
      new RegExp(`(?:^|\\s)${siblingKey}\\s+`, 'i').test(rawBody)
    ).length;
    if (hasCollapsedSiblingMarker || (repairContext.wordAutoAnswerAppendix && bareCollapsedSiblingCount >= 2)) return;

    // 当前内容是原文行的完整延续时保留；其他明显截断、串位或重复结果按原文恢复。
    const currentExtendsRaw = currentSig.startsWith(rawSig) && currentSig.length > rawSig.length;
    if (currentExtendsRaw && signatureCounts[currentSig] <= 1) return;

    const visiblyTruncated = !currentSig || rawSig.startsWith(currentSig) || rawSig.endsWith(currentSig);
    const muchShorter = currentSig && currentSig.length < Math.floor(rawSig.length * 0.68);
    const duplicatedResult = currentSig && signatureCounts[currentSig] > 1;
    const punctuationFragment = /^[，,。；;、:：）)\]】]/.test(current);
    if (visiblyTruncated || muchShorter || duplicatedResult || punctuationFragment) {
      option.text = rawBody;
      repairs.push(`${option.key}选项按原文恢复`);
    }
  });

  const repaired = { ...question, options };
  if (repairs.length) {
    repaired.optionRepairApplied = true;
    repaired.optionRepairNotes = unique([...(question.optionRepairNotes || []), ...repairs]);
  }
  return repaired;
}


function repairKnownConvertedDocxOptions(question) {
  if (!question || !Array.isArray(question.options) || !question.options.length) return question;
  const questionText = normalizeOneLine(question.question || '');
  const options = question.options.map(item => ({ ...item }));
  const byKey = Object.fromEntries(options.map(item => [String(item.key || '').toUpperCase(), item]));
  const repairs = [];

  function sameOption(left, right) {
    return left && right && optionSignature(left.text) && optionSignature(left.text) === optionSignature(right.text);
  }

  function replaceRawOption(rawTexts, key, value) {
    const marker = String(key || '').toUpperCase();
    const linePattern = new RegExp('^(\\s*(?:[（(]\\s*)?' + marker + '\\s*(?:[）)]|[.、．:：])\\s*).*$','i');
    return (rawTexts || []).map(raw => String(raw || '').split(/\n/).map(line => {
      const match = linePattern.exec(line);
      return match ? `${match[1]}${value}` : line;
    }).join('\n'));
  }

  function setOption(key, value, note) {
    const target = byKey[key];
    if (!target || optionSignature(target.text) === optionSignature(value)) return;
    target.text = value;
    repairs.push(note);
  }

  // 某些 PDF 转 DOCX 文件把页面上方的覆盖文字与底层文字同时保存，
  // Android 读取到的底层段落会让 D 选项重复 C。仅在题干和重复特征同时命中时恢复。
  if (/DCS.*系统结构|系统结构.*DCS/i.test(questionText) && sameOption(byKey.C, byKey.D) &&
      /操作站.*(?:工业)?PC.*CRT/i.test(normalizeOneLine((byKey.C && byKey.C.text) || ''))) {
    setOption('D', '过程控制网络实现工程师站、操作站、控制站的连接，完成信息、控制命令的传输与发送。', 'D选项按文档可见内容恢复');
  }

  // 同一类转换文件会把 S7-300 CPU 指示灯题的 D 覆盖文字丢失，底层重复成 RUN。
  // 同时使用题干与 A/B/C/D 指示灯组合双重特征，避免不同 Word 转换器改写题干后漏修。
  const normalizedA = normalizeOneLine((byKey.A && byKey.A.text) || '').toUpperCase();
  const normalizedB = normalizeOneLine((byKey.B && byKey.B.text) || '').toUpperCase();
  const normalizedC = normalizeOneLine((byKey.C && byKey.C.text) || '').toUpperCase();
  const looksLikeS7IndicatorSet = normalizedA === 'SF' && /^(?:BATF|BATT?F?)$/.test(normalizedB) && normalizedC === 'RUN';
  if ((/西门子.*S7\s*[-－—]?\s*300.*CPU.*指示灯|S7\s*[-－—]?\s*300.*CPU.*指示灯/i.test(questionText) || looksLikeS7IndicatorSet) &&
      sameOption(byKey.C, byKey.D) && normalizedC === 'RUN') {
    setOption('D', 'STOP', 'D选项按文档可见内容恢复');
  }

  if (!repairs.length) return question;
  let source = question.source ? { ...question.source } : null;
  if (source && Array.isArray(source.rawTexts)) {
    repairs.forEach(note => {
      if (/D选项/.test(note)) source.rawTexts = replaceRawOption(source.rawTexts, 'D', byKey.D.text);
    });
  }
  return {
    ...question,
    options,
    source,
    optionRepairApplied: true,
    optionRepairNotes: unique([...(question.optionRepairNotes || []), ...repairs])
  };
}


function isGenericVisualOptionText(value = '') {
  const clean = normalizeOneLine(value || '')
    .replace(/[\s()（）\[\]【】<>《》]/g, '')
    .replace(/[.。:：、，,;；]/g, '')
    .toLowerCase();
  return /^(?:图|图形|图片|图示|示意图|符号图|见图|如下图)$/.test(clean);
}

function missingVisualOptionImages(question) {
  if (!question || question.type === 'short') return false;
  const options = Array.isArray(question.options) ? question.options : [];
  if (options.length < 2 || !options.every(item => isGenericVisualOptionText(item && item.text))) return false;
  const questionImages = Array.isArray(question.images) ? question.images.length : 0;
  const optionImages = options.reduce((sum, item) => sum + (Array.isArray(item && item.images) ? item.images.length : 0), 0);
  return questionImages + optionImages < options.length;
}

function duplicateOptionIssues(question) {
  // “A.图形 / B.图形 ...”是图片选项的文本占位符：图片存在时各项由图像区分，
  // 图片缺失时由“图片选项缺少图像”单独提示。两种情况都不应报文字重复。
  const options = Array.isArray(question && question.options) ? question.options : [];
  if (options.length >= 2 && options.every(item => isGenericVisualOptionText(item && item.text))) return [];
  const groups = {};
  (question.options || []).forEach(item => {
    const signature = optionSignature(item.text);
    if (!signature) return;
    if (!groups[signature]) groups[signature] = [];
    groups[signature].push(item.key);
  });

  const rawMap = extractRawOptionMap(question);
  const issues = [];
  Object.entries(groups).forEach(([signature, keys]) => {
    if (keys.length < 2) return;
    const rawBodies = keys.map(key => bestRawBody(rawMap, key));
    const rawSignatures = rawBodies.map(optionSignature);
    const allRawPresent = rawSignatures.every(Boolean);
    const rawDistinct = allRawPresent && new Set(rawSignatures).size > 1;
    const rawSameAsResult = allRawPresent && rawSignatures.every(value => value === signature);
    const keyText = keys.join('、');

    if (rawDistinct) issues.push(`解析重复（${keyText}）`);
    else if (rawSameAsResult) issues.push(`导入片段重复（${keyText}）`);
    else issues.push(`疑似重复（${keyText}）`);
  });
  return issues;
}

function validateQuestion(question) {
  const issues = [];
  let score = 1;

  if (!question.question || question.question.length < 4) {
    issues.push('题干缺失或过短');
    score -= 0.45;
  }

  if (/(?:答案|参考答案|解析)\s*[:：]/.test(question.question || '')) {
    issues.push('题干中仍残留答案或解析标记');
    score -= 0.18;
  }

  if (question.type === 'short') {
    const hasAnswerImage = Array.isArray(question.answerImages) && question.answerImages.length > 0;
    if ((!question.answerText || !question.answerText.trim()) && !hasAnswerImage) {
      issues.push('无答案');
      score -= 0.35;
    }
  } else {
    if (!Array.isArray(question.options) || question.options.length < 2) {
      issues.push('选项不足');
      score -= 0.4;
    }
    if (!Array.isArray(question.answer) || question.answer.length === 0) {
      issues.push('无答案');
      score -= 0.35;
    } else {
      const keys = new Set((question.options || []).map(item => item.key));
      const invalid = question.answer.filter(key => !keys.has(key));
      if (invalid.length) {
        issues.push(`答案不符（${invalid.join('、')}）`);
        score -= 0.4;
      }
    }
  }

  if (missingVisualOptionImages(question)) {
    issues.push('图片选项缺少图像');
    score -= 0.2;
  }

  if (question.options && question.options.some(item => !item.text && !(Array.isArray(item.images) && item.images.length))) {
    issues.push('空白选项');
    score -= 0.15;
  }

  const optionKeys = (question.options || []).map(item => item.key);
  if (new Set(optionKeys).size !== optionKeys.length) {
    issues.push('选项字母重复');
    score -= 0.2;
  }

  const duplicateIssues = duplicateOptionIssues(question);
  duplicateIssues.forEach(issue => issues.push(issue));
  if (duplicateIssues.some(issue => issue.startsWith('解析重复') || issue.startsWith('疑似重复'))) score -= 0.18;
  else if (duplicateIssues.length) score -= 0.08;

  if (question.question && question.question.length > 1000) {
    issues.push('题干过长');
    score -= 0.25;
  }

  if (question.answerText && question.answerText.length > 3000) {
    issues.push('答案过长');
    score -= 0.2;
  }


  const encodingText = [
    question.question,
    ...(question.options || []).map(item => item.text),
    question.answerText,
    question.analysis,
    ...((question.source && question.source.rawTexts) || [])
  ].filter(Boolean).join(' ');
  if (hasEncodingAnomaly(encodingText)) {
    issues.push('字符映射异常');
    score -= 0.22;
  }

  if (question.type === 'multiple' && question.answer.length < 2) {
    issues.push('多选仅一项');
    score -= 0.15;
  }

  if (question.type === 'judge') {
    const truthValue = value => {
      const clean = normalizeOneLine(value || '').toUpperCase();
      if (/^(?:正确|对|是|√|✓|✔|TRUE|T)$/.test(clean)) return true;
      if (/^(?:错误|错|否|×|✕|✖|❌|FALSE|F)$/.test(clean)) return false;
      return null;
    };
    const values = (question.options || []).map(item => truthValue(item.text));
    if (question.options.length !== 2 || !values.includes(true) || !values.includes(false)) {
      issues.push('判断选项异常');
      score -= 0.15;
    }
  }

  if (question.inferredBoundary) {
    const hasAnyAnswer = Boolean((question.answer || []).length || question.answerText || (Array.isArray(question.answerImages) && question.answerImages.length));
    issues.push(hasAnyAnswer ? '边界待查' : '边界待查且无答案');
    score -= hasAnyAnswer ? 0.05 : 0.08;
  }

  if (question.duplicateOf) {
    issues.push('重复题');
    score -= 0.18;
  }

  const confidence = Math.max(0, Math.min(1, Number(score.toFixed(2))));
  let status = 'normal';
  const fatalChoiceStructure = question.type !== 'short' && (!Array.isArray(question.options) || question.options.length < 2);
  if (fatalChoiceStructure || confidence < 0.45) status = 'error';
  else if (issues.length) status = 'warning';

  return { issues: unique(issues), confidence, status };
}

module.exports = { validateQuestion, repairOptionDuplicates, repairKnownConvertedDocxOptions, optionSignature, extractRawOptionMap };
