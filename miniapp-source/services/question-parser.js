const { createId } = require('../utils/id');
const {
  normalizeText,
  normalizeOneLine,
  cleanQuestionText,
  cleanAnswerText,
  cleanAnalysisText,
  compactText,
  unique,
  isListStart,
  repairKnownEngineeringNotation,
  hasEncodingAnomaly
} = require('../utils/text');
const { validateQuestion, repairOptionDuplicates, repairKnownConvertedDocxOptions } = require('./question-validator');
const localAI = require('./local-ai-model');

const TYPE_LABEL = '(不定项选择题|不定项题|不定项|单选题|单项选择题|单选|多选题|多项选择题|多选|选择题|判断题|判断|简答题|问答题|实操题|论述题|填空题|计算题|画图题|绘图题|作图题|匹配题|配对题|排序题|顺序题|材料题|案例题)';
const COUNT_RE = new RegExp(`^\\s*[,，]?\\s*(\\d+)\\s*\\/\\s*\\d+\\s*(?:[\\[【]\\s*)?${TYPE_LABEL}(?:\\s*[\\]】])?\\s*(.*)$`);
const GENERIC_COUNT_RE = /^\s*[,，]?\s*(\d+)\s*\/\s*\d+\s*[\[【]?\s*题\s*[\]】]?\s*(.*)$/;
// 兼容“14 题”“4[题]”“15题（判断）……”等 PDF 转 Word 后常见的题号格式。
// v1.5.8 未覆盖这类边界，可能把整道题并入前后题，造成题目数量少于原文。
const BARE_NUMBERED_QUESTION_RE = /^\s*(\d{1,4})\s*(?:[\[【]\s*)?题\s*(?:[\]】])?\s*(?:[.、．:：)）-]\s*)?(.*)$/;
// 兼容 Word 中斜杠被异常转换为数字 1 和空格的情况，例如：171 39[单选题] ≈ 17/39[单选题]。
const BROKEN_COUNT_RE = new RegExp(`^\\s*[,，]?\\s*(\\d{1,4})\\s+(\\d{1,4})\\s*(?:[\\[【]\\s*)?${TYPE_LABEL}(?:\\s*[\\]】])?\\s*(.*)$`);
// PDF 转换偶尔把 17/39 破坏成 17139（斜杠被映射成数字 1 且空格丢失）。
// 只在 PDF 路径下按“题号 + 1 + 总题数 + 题型”恢复，避免影响普通五位题号。
const COMPACT_BROKEN_COUNT_RE = new RegExp(`^\\s*[,，]?\\s*(\\d{1,4})1(\\d{1,4})\\s*(?:[\\[【]\\s*)?${TYPE_LABEL}(?:\\s*[\\]】])?\\s*(.*)$`);
const NUMBERED_TYPE_RE = new RegExp(`^\\s*[,，]?\\s*(\\d+)\\s*(?:[\\[【]\\s*)?${TYPE_LABEL}(?:\\s*[\\]】])?\\s*(.*)$`);
const BRACKET_TYPE_RE = new RegExp(`^\\s*[（(\\[【]\\s*${TYPE_LABEL}\\s*[）)\\]】]\\s*(.*)$`);
const TYPED_RE = new RegExp(`^\\s*${TYPE_LABEL}\\s*[:：]\\s*(.*)$`);
const QUESTION_RES = [
  /^\s*(?:Q|题)\s*(\d{1,5})\s*[.、．:：)）-]\s*(.*)$/i,
  /^\s*第\s*(\d{1,5})\s*题\s*[.、．:：)）-]?\s*(.*)$/,
  /^\s*(\d{1,5})(?:\s*\/\s*\d+)?\s*[.、．:：)）]\s*(.*)$/
];
const NO_PUNCT_NUMBER_RE = /^\s*(\d{1,4})\s*([\u4e00-\u9fff].{4,})$/;
const OPTION_LINE_RE = /^\s*(?:[（(【\[]\s*)?([A-L])\s*(?:[）)】\]]\s*|[.、．:：)）]\s*)(.*)$/i;
const LOOSE_OPTION_LINE_RE = /^\s*([A-L])\s{1,3}([^A-L].{1,})$/i;
const DIRECT_OPTION_LINE_RE = /^\s*([A-L])([^A-L\s].{0,})$/i;
const BARE_ANSWER_RE = /^\s*(?:答案\s*[:：]?\s*)?(?:[（(【\[]\s*)?(?:[A-L](?:(?:\s*[,，、/\\|\s]\s*|(?=[A-L]))[A-L])*|√|✓|✔|☑|×|✕|✖|☒|❌|对|错|正确|错误|是|否)(?:\s*[）)】\]])?\s*[,，。；;]?\s*$/i;

function typeMetaFromLabel(label = '') {
  const clean = normalizeOneLine(label);
  if (/不定项/.test(clean)) return { type: 'multiple', label: '不定项选择题' };
  if (/多选|多项/.test(clean)) return { type: 'multiple', label: '多选题' };
  if (/判断|对错/.test(clean)) return { type: 'judge', label: '判断题' };
  if (/匹配|配对/.test(clean)) return { type: 'short', label: '匹配题' };
  if (/排序|顺序题/.test(clean)) return { type: 'short', label: '排序题' };
  if (/材料|案例/.test(clean)) return { type: 'short', label: clean.includes('案例') ? '案例题' : '材料题' };
  if (/填空/.test(clean)) return { type: 'short', label: '填空题' };
  if (/计算/.test(clean)) return { type: 'short', label: '计算题' };
  if (/画图|绘图|作图/.test(clean)) return { type: 'short', label: '画图题' };
  if (/实操/.test(clean)) return { type: 'short', label: '实操题' };
  if (/论述/.test(clean)) return { type: 'short', label: '论述题' };
  if (/问答/.test(clean)) return { type: 'short', label: '问答题' };
  if (/简答/.test(clean)) return { type: 'short', label: '简答题' };
  return { type: 'single', label: '单选题' };
}

function typeFromLabel(label = '') {
  return typeMetaFromLabel(label).type;
}

function displayTypeFromLabel(label = '') {
  return typeMetaFromLabel(label).label;
}

function peelLeadingType(content = '', fallbackType = '', fallbackDisplayTypeLabel = '') {
  const clean = normalizeOneLine(content);
  const match = new RegExp(`^\\s*[（(\\[【]?\\s*${TYPE_LABEL}\\s*[）)\\]】]?\\s*[:：-]?\\s*(.*)$`).exec(clean);
  if (!match) return { typeHint: fallbackType, displayTypeLabel: fallbackDisplayTypeLabel, content: clean };
  const meta = typeMetaFromLabel(match[1]);
  return { typeHint: meta.type, displayTypeLabel: meta.label, content: match[2] };
}

function descriptiveTypeHeading(text = '') {
  let clean = normalizeOneLine(text).replace(/^#{1,6}\s*/, '');
  clean = clean.replace(/^(?:[一二三四五六七八九十]+[、.．]|[（(][一二三四五六七八九十]+[）)])\s*/, '');
  const combinedShort = /^(?:简答题|问答题)\s*(?:[/／、和及]|\s)+\s*(?:简答题|问答题)(?:\s*[（(].*[）)])?$/.test(clean);
  if (combinedShort) return { type: 'short', label: '简答题' };
  const match = /^(填空题|选择题|不定项选择题|不定项题|单选题|单项选择题|多选题|多项选择题|判断题|简答题|问答题|实操题|论述题|计算题|画图题|绘图题|作图题|匹配题|配对题|排序题|顺序题|材料题|案例题)(?:\s*[（(].*[）)])?$/.exec(clean);
  if (!match) return null;
  if (match[1] === '选择题') {
    return /多选|多项/.test(clean) ? { type: 'multiple', label: '多选题' } : { type: 'single', label: '单选题' };
  }
  return typeMetaFromLabel(match[1]);
}

function declaredTypeSection(text = '') {
  const clean = normalizeOneLine(text);
  const meta = descriptiveTypeHeading(clean);
  if (!meta) return null;
  const countMatch = /共\s*(\d+)\s*(题|空)/.exec(clean);
  const count = countMatch ? Number(countMatch[1]) : 0;
  if (countMatch && (!Number.isInteger(count) || count < 1 || count > 5000)) return null;
  // 仅对“单选题（共 10 题）”这类纯计数标题启用缺题占位补齐。
  // “选择题（共 29 题，单选，含答案）”等整理说明标题通常夹杂自动编号、子列表，
  // 直接按编号补齐会误判，因此只作为题型章节识别，不强制补占位题。
  const simpleHeadingText = clean.replace(/^(?:[一二三四五六七八九十]+[、.．]\s*)/, '');
  const simpleCountHeading = /^(?:填空题|选择题|不定项选择题|不定项题|单选题|单项选择题|多选题|多项选择题|判断题|简答题|问答题|实操题|论述题|计算题|画图题|绘图题|作图题|匹配题|配对题|排序题|顺序题|材料题|案例题)\s*[（(]\s*共\s*\d+\s*题\s*[）)]$/.test(simpleHeadingText);
  const expectedCount = countMatch && countMatch[2] === '题' && simpleCountHeading ? count : 0;
  return { typeHint: meta.type, displayTypeLabel: meta.label, expectedCount, heading: clean };
}

function exactTypeHeading(text = '') {
  let clean = normalizeOneLine(text).replace(/^#{1,6}\s*/, '');
  clean = clean.replace(/^(?:[一二三四五六七八九十]+[、.．]|[（(][一二三四五六七八九十]+[）)])\s*/, '');
  const match = new RegExp(`^(?:图片)?\\s*[（(\\[【]?\\s*${TYPE_LABEL}\\s*[）)\\]】]?\\s*(?:[（(](?:标准格式|示例|模板|共\\s*\\d+\\s*题)[）)])?$`).exec(clean);
  if (!match) return null;
  return typeMetaFromLabel(match[1]);
}

function classifyHeader(text, style = '') {
  const clean = normalizeOneLine(text);
  if (!clean) return null;
  const exactType = exactTypeHeading(clean);
  if (exactType) return { kind: 'type', value: exactType.type, label: exactType.label };
  const descriptiveType = descriptiveTypeHeading(clean);
  if (descriptiveType) return { kind: 'type', value: descriptiveType.type, label: descriptiveType.label };
  const markdownHeading = /^#{1,6}\s*(.+)$/.exec(clean);
  if (markdownHeading) {
    const heading = markdownHeading[1].trim();
    if (/单选题|单项选择题/.test(heading)) return { kind: 'type', value: 'single', label: '单选题' };
    if (/多选题|多项选择题/.test(heading)) return { kind: 'type', value: 'multiple', label: '多选题' };
    if (/判断题|对错题/.test(heading)) return { kind: 'type', value: 'judge', label: '判断题' };
    if (/简答题|问答题/.test(heading)) { const meta = typeMetaFromLabel(heading); return { kind: 'type', value: meta.type, label: meta.label }; }
    return { kind: 'category', value: heading };
  }
  if (/^第.{0,10}章/.test(clean) && /(?:图片)?(?:单选|多选|判断|简答)题/.test(clean)) {
    return { kind: 'category', value: clean };
  }
  if (/^(?:图片)?(?:单选|多选|判断|简答)题(?:\s*[（(](?:标准格式|示例|模板)[）)])?$/.test(clean) || /(?:单选|多选|判断|简答)题\s*[（(](?:标准格式|示例|模板)[）)]$/.test(clean)) {
    if (/单选/.test(clean)) return { kind: 'type', value: 'single', label: '单选题' };
    if (/多选/.test(clean)) return { kind: 'type', value: 'multiple', label: '多选题' };
    if (/判断/.test(clean)) return { kind: 'type', value: 'judge', label: '判断题' };
    return { kind: 'type', value: 'short', label: displayTypeFromLabel(clean) };
  }
  if (OPTION_LINE_RE.test(clean) || LOOSE_OPTION_LINE_RE.test(clean) || /[；;,，]\s*[A-L]\s*[.、．:：)）]/i.test(clean)) return null;
  if (QUESTION_RES.some(pattern => pattern.test(clean)) || COUNT_RE.test(clean) || GENERIC_COUNT_RE.test(clean) ||
      BARE_NUMBERED_QUESTION_RE.test(clean) || BROKEN_COUNT_RE.test(clean) || NUMBERED_TYPE_RE.test(clean)) return null;
  if (/^(?:正确答案|标准答案|参考答案|答案|答|答案解析|试题解析|解析|说明)\s*(?:为|是)?\s*[:：]/.test(clean)) return null;
  if (/^(初级工|中级工|高级工|技师|高级技师)$/.test(clean)) {
    return { kind: 'level', value: clean };
  }

  const wrappedTypeHeading = new RegExp(`^[（(\\[【]?\\s*${TYPE_LABEL}\\s*[）)\\]】]?$`).exec(clean);
  if (wrappedTypeHeading) { const meta = typeMetaFromLabel(wrappedTypeHeading[1]); return { kind: 'type', value: meta.type, label: meta.label }; }

  const headingSuffix = '(?:（[^）]*）|\\([^)]*\\))?';
  if (new RegExp(`^(?:[一二三四五六七八九十]+[、.．]\\s*)?(?:单选题|单项选择题|单选)${headingSuffix}$`).test(clean)) return { kind: 'type', value: 'single' };
  if (new RegExp(`^(?:[一二三四五六七八九十]+[、.．]\\s*)?(?:多选题|多项选择题|多选|选择题)${headingSuffix}$`).test(clean)) return { kind: 'type', value: 'multiple' };
  if (new RegExp(`^(?:[一二三四五六七八九十]+[、.．]\\s*)?(?:判断题|判断)${headingSuffix}$`).test(clean)) return { kind: 'type', value: 'judge' };
  if (new RegExp(`^(?:[一二三四五六七八九十]+[、.．]\\s*)?(?:简答题|【简答题】|问答题|实操题)${headingSuffix}$`).test(clean)) return { kind: 'type', value: 'short' };

  const headingStyle = /(?:heading|标题|title)/i.test(style || '');
  const compactStyleHeading = Boolean(style) && clean.length <= 30 && !/[。？?！!：:（）()]/.test(clean);
  if (compactStyleHeading && !/^(?:\d+|[A-L])$/.test(clean)) {
    return { kind: 'category', value: clean.replace(/\d+$/, '').trim() || clean };
  }
  if (/^(?!.*[。？?！!])[^：:]{2,28}(?:知识|控制阀|安全环保|管理|基础|专业|法规|标准|实操)$/.test(clean)) {
    return { kind: 'category', value: clean };
  }
  const headingLooksLikeQuestion = isStrongQuestionCue(clean) || /[（(]\s*[）)]/.test(clean) || /[？?]$/.test(clean);
  if (/^[一二三四五六七八九十]+[、.．]\s*\S+/.test(clean) || /^[（(][一二三四五六七八九十]+[）)]\s*\S+/.test(clean) || /^第[一二三四五六七八九十\d]+(?:部分|章|节)/.test(clean) || (headingStyle && clean.length <= 40 && !headingLooksLikeQuestion)) {
    return {
      kind: 'category',
      value: clean.replace(/^(?:[一二三四五六七八九十]+[、.．]|[（(][一二三四五六七八九十]+[）)])\s*/, '')
    };
  }
  return null;
}


function normalizedDocumentTitle(value = '') {
  return normalizeOneLine(value)
    .replace(/\.(?:docx?|docm|dotx|dotm|xlsx?|xlsm|xltx|xltm|pdf|rtf|odt|ods|csv|tsv|txt|md|markdown|html?)$/i, '')
    // Windows/微信重复下载常在文件名末尾追加“(1)”或“（2）”，正文标题通常没有。
    .replace(/(?:[（(]\s*\d+\s*[）)])+$/g, '')
    .replace(/[\s\u3000·•_—–-]+/g, '')
    .replace(/[，,。．.：:；;]+/g, '')
    .toLowerCase();
}

function isLikelyDocumentTitle(text = '', sourceName = '', style = '') {
  const clean = normalizeOneLine(text);
  if (!clean || clean.length < 2 || clean.length > 100) return false;

  // 带明确题号、题干空格、问号、选项或答案标签的内容仍按题目处理。
  if (QUESTION_RES.some(pattern => pattern.test(clean)) || COUNT_RE.test(clean) || GENERIC_COUNT_RE.test(clean) ||
      BARE_NUMBERED_QUESTION_RE.test(clean) || BROKEN_COUNT_RE.test(clean) || NUMBERED_TYPE_RE.test(clean) ||
      OPTION_LINE_RE.test(clean) || LOOSE_OPTION_LINE_RE.test(clean) ||
      /[（(]\s*[）)]|[？?]$/.test(clean) ||
      /^(?:题目|题干|问题|正确答案|标准答案|参考答案|答案|答|解析|说明)\s*[:：]/.test(clean)) return false;

  const textKey = normalizedDocumentTitle(clean);
  const sourceKey = normalizedDocumentTitle(sourceName);
  if (sourceKey && textKey && (textKey === sourceKey || sourceKey.startsWith(textKey) || textKey.startsWith(sourceKey))) {
    return true;
  }

  // 常见周学习资料标题。日期范围只用于说明批次，不构成题目。
  if (/^(?:[\u3400-\u9fffA-Za-z0-9]+)?(?:专业)?(?:学习内容|学习资料|培训内容|培训资料|复习资料|知识汇总)(?:[（(]\s*\d{1,2}(?:[.月/]\d{1,2})?\s*(?:-|—|–|~|～|至)\s*\d{1,2}(?:[.月/]\d{1,2})?\s*[）)])?$/.test(clean)) {
    return true;
  }

  // Word 明确标为 Title/标题且没有任何题目结构时，也只作为文档元数据。
  return /(?:title|标题)/i.test(style || '') && clean.length <= 60;
}

function parseAnswerLetters(value = '') {
  const clean = normalizeOneLine(value).toUpperCase()
    .replace(/^[（(【\[]+|[）)】\]]+$/g, '')
    .replace(/^(?:正确答案|标准答案|参考答案|答案|答)\s*(?:为|是)?\s*[:：]?\s*/i, '')
    .trim();

  if (/^(?:√|✓|✔|☑|对|正确|是|TRUE|T)(?:$|[，。；;（(])/.test(clean)) return ['A'];
  if (/^(?:×|✕|✖|☒|❌|错|错误|否|FALSE|F)(?:$|[，。；;（(])/.test(clean)) return ['B'];

  // A（正确）、B（错误）、A(对) 是题库中常见的判断题答案写法。
  const truthExplained = /^([AB])\s*[（(【\[]\s*(?:正确|错误|对|错)\s*[）)】\]]\s*[,，。；;]?$/.exec(clean);
  if (truthExplained) return [truthExplained[1]];

  const explainedSingle = /^([A-L])\s*[.．:：)）]\s*\S+/.exec(clean);
  if (explainedSingle) return [explainedSingle[1]];

  const leadingExplained = /^([A-L](?:(?:\s*[,，、/\\|\s]\s*|(?=[A-L]))[A-L])*)(?=\s*(?:[；;，。]|$))/.exec(clean);
  if (leadingExplained) return unique(leadingExplained[1].match(/[A-L]/g) || []);

  const leading = /^([A-L](?:(?:\s*[,，、/\\|\s]\s*|(?=[A-L]))[A-L])*)(?:\s*[,，。；;]?\s*$|\s*[（(【\[])/.exec(clean);
  if (leading) return unique(leading[1].match(/[A-L]/g) || []);

  const bracket = /[（(【\[]\s*([A-L](?:(?:\s*[,，、/\\|\s]\s*|(?=[A-L]))[A-L])*)\s*[）)】\]]/.exec(clean);
  return bracket ? unique(bracket[1].match(/[A-L]/g) || []) : [];
}

function isJudgementAnswerValue(value = '') {
  let clean = normalizeOneLine(value)
    .replace(/^(?:正确答案|标准答案|参考答案|答案|答)\s*(?:为|是)?\s*[:：]?\s*/i, '')
    .replace(/[，,。；;]+$/g, '')
    .trim()
    .toUpperCase();
  // Word 中常见“答案：（正确）”“答案：(错误)”以及全角/方括号包裹。
  // 先反复剥离成对的外层括号，再判断语义；不能只依赖 parseAnswerLetters，
  // 否则虽然能得到 A/B，却不会把题型锁定为判断题。
  let previous = '';
  while (clean && clean !== previous) {
    previous = clean;
    clean = clean.replace(/^\s*[（(【\[]\s*(.*?)\s*[）)】\]]\s*$/, '$1').trim();
  }
  return /^(?:√|✓|×|✕|✖|正确|错误|对|错|是|否|TRUE|FALSE|T|F|A\s*[（(【\[]\s*(?:正确|对)\s*[）)】\]]|B\s*[（(【\[]\s*(?:错误|错)\s*[）)】\]])$/.test(clean);
}

function isStrongShortQuestion(value = '') {
  const clean = normalizeOneLine(value);
  if (!clean || /[（(]\s*[）)]/.test(clean)) return false;
  if (/(?:【|\[|（|\()?\s*(?:简答题|简答|问答题|实操题|论述题|填空题|计算题|画图题|绘图题|作图题)\s*(?:】|\]|）|\))?/.test(clean)) return true;
  if (/^(?:简述|写出|列出|阐述|分析|解释|回答|说明)(?!\s*[:：]?\s*(?:正确|错误))/.test(clean)) return true;
  const interrogative = /(?:是什么|有哪些|有何|如何|为什么|哪几|哪一|多少|几种|怎样|怎么|应做哪些|应做好哪些|应符合哪些|起什么作用|原理是什么|含义是什么|区别是什么|关系是什么)/.test(clean);
  return interrogative && (/[？?]\s*$/.test(clean) || /^(?:题目|题干|问题)\s*[:：]/.test(clean));
}

function optionLabelMarkers(value = '') {
  const clean = normalizeOneLine(value);
  const result = [];
  const re = /(?:^|[\s；;。])(?:[（(]\s*)?([A-Z])\s*(?:[）)]|[.、．:：)）])\s*/ig;
  let match;
  while ((match = re.exec(clean))) result.push(match[1].toUpperCase());
  return result;
}

function isMappingAnswerLine(value = '', questionText = '') {
  if (!isStrongShortQuestion(questionText)) return false;
  const keys = optionLabelMarkers(value);
  if (keys.length < 3) return false;
  let sequential = true;
  for (let index = 1; index < keys.length; index += 1) {
    if (keys[index].charCodeAt(0) !== keys[index - 1].charCodeAt(0) + 1) sequential = false;
  }
  return !sequential || keys.length >= 6 || /字母.*含义/.test(questionText);
}

function answerCandidatePattern() {
  return '(?:[A-L](?:(?:\\s*[,，、/\\\\|\\s]\\s*|(?=[A-L]))[A-L])*|√|✓|✔|☑|×|✕|✖|☒|❌|对|错|正确|错误|是|否|TRUE|FALSE)';
}

function extractInlineShortAnswer(text = '', typeHint = '') {
  const clean = normalizeText(text || '').trim();
  if (!clean) return { question: '', answer: '' };

  const match = /[？?]/.exec(clean);
  if (!match || match.index < 4 || match.index >= clean.length - 1) {
    return { question: clean, answer: '' };
  }

  const question = clean.slice(0, match.index + 1).trim();
  const answer = clean.slice(match.index + 1)
    .replace(/^\s*(?:正确答案|标准答案|参考答案|答案|答)\s*(?:为|是)?\s*[:：]?\s*/, '')
    .trim();

  if (answer.length < 8) return { question: clean, answer: '' };
  if (/^(?:第?\d+题|题目|题干|问题)\s*[:：]/.test(answer)) return { question: clean, answer: '' };

  const shortCue = /(?:什么|哪些|如何|为什么|简述|写出|列出|说明|原因|措施|步骤|内容|要求|规定|方法|特点|作用|注意事项|有何|定义|组成|分类|区别|关系|含义)/.test(question);
  if (typeHint !== 'short' && !shortCue) return { question: clean, answer: '' };

  // 一段文字中“问题？答案……”连写时，将问号后的陈述内容识别为参考答案。
  return { question, answer };
}

function extractInlineAnswer(text = '', allowImplicit = false) {
  let clean = normalizeOneLine(text);
  const answers = [];
  const sources = [];
  const candidate = answerCandidatePattern();

  const explicitBracket = new RegExp(`[（(【\\[]\\s*(?:正确答案|标准答案|参考答案|答案|答)\\s*[:：]?\\s*(${candidate})\\s*[）)】\\]]`, 'ig');
  clean = clean.replace(explicitBracket, (all, value) => {
    answers.push(...parseAnswerLetters(value));
    sources.push('题干内显式答案');
    return ' ';
  });

  const explicitPlain = new RegExp(`(?:参考答案|参考答|正确答案|标准答案|参考|答案)\\s*(?:为|是)?\\s*[:：]?\\s*(${candidate})\\s*$`, 'i');
  const plainMatch = explicitPlain.exec(clean);
  if (plainMatch) {
    answers.push(...parseAnswerLetters(plainMatch[1]));
    sources.push('题干末尾显式答案');
    clean = clean.slice(0, plainMatch.index).trim();
  }

  if (allowImplicit) {
    const leading = new RegExp(`^\\s*[（(【\\[]\\s*(${candidate})\\s*[）)】\\]]\\s*(.+)$`, 'i').exec(clean);
    if (leading) {
      answers.push(...parseAnswerLetters(leading[1]));
      sources.push('题干开头括号答案');
      clean = leading[2].trim();
    }

    const trailing = new RegExp(`^(.*?)\\s*[（(【\\[]\\s*(${candidate})\\s*[）)】\\]]\\s*$`, 'i').exec(clean);
    if (trailing && trailing[1].trim().length >= 4) {
      answers.push(...parseAnswerLetters(trailing[2]));
      sources.push('题干末尾括号答案');
      clean = trailing[1].trim();
    }
  }

  return {
    text: cleanQuestionText(clean),
    answers: unique(answers),
    sources: unique(sources)
  };
}

function bareInlineOptionMarkers(text, strictMarkers) {
  const strictOptions = strictMarkers
    .filter(item => item.type === 'option')
    .map(item => ({ ...item, strict: true, tight: false, punctuated: true }));
  const candidates = [];

  const hasStrictNear = index => strictOptions.some(item => Math.abs(item.start - index) <= 1);
  const pushCandidate = candidate => {
    if (!candidate || !candidate.key || candidate.end >= text.length + 1) return;
    if (hasStrictNear(candidate.start)) return;
    const bodyStart = candidate.end;
    if (bodyStart >= text.length) return;
    const next = text[bodyStart];
    if (!/[\u3400-\u9fffA-Za-z0-9（(\-+√✓✔×✕✖]/.test(next || '')) return;
    candidates.push(candidate);
  };

  // 第一层：识别带明确标点的选项字母。这里允许字母紧贴上一项正文，
  // 例如“36VB.60VC.110VD.220V”。是否真正采用，必须由后面的完整
  // A→B→C→D 连续链校验决定，单独出现的“B.协议”不会直接切开正文。
  const punctuated = /([A-L])\s*[.、．:：)）]\s*/ig;
  let punctMatch;
  while ((punctMatch = punctuated.exec(text))) {
    const start = punctMatch.index;
    const previous = start > 0 ? text[start - 1] : '';
    const tight = Boolean(previous && !/[\s\n；;。！？?：:）)]/.test(previous));
    pushCandidate({
      type: 'option',
      key: punctMatch[1].toUpperCase(),
      start,
      end: punctuated.lastIndex,
      strict: false,
      tight,
      punctuated: true
    });
  }

  // 第二层：兼容“A 36V B 60V C 110V D 220V”等没有标点但有清楚
  // 间隔的格式。英文单词、型号和缩写内部的大写字母绝不作为边界。
  for (let index = 0; index < text.length; index += 1) {
    const key = text[index];
    if (!/[A-L]/.test(key) || hasStrictNear(index)) continue;
    const previous = index > 0 ? text[index - 1] : '';
    if (previous && /[A-Za-z0-9_]/.test(previous)) continue;
    if (previous && !/[\s\n；;。！？?：:（(）)]/.test(previous) && index !== 0) continue;

    let cursor = index + 1;
    while (/\s/.test(text[cursor] || '')) cursor += 1;
    // 带标点的候选已由第一层处理，避免产生两个不同 end 的重复候选。
    if (/[.、．:：)）]/.test(text[cursor] || '')) continue;
    if (cursor >= text.length) continue;
    const next = text[cursor];
    if (!/[\u3400-\u9fffA-Za-z0-9（(\-+√✓✔×✕✖]/.test(next)) continue;
    candidates.push({ type: 'option', key, start: index, end: cursor, strict: false, tight: false });
  }

  const all = [...strictOptions, ...candidates]
    .sort((a, b) => a.start - b.start || Number(b.strict) - Number(a.strict) || b.end - a.end);
  const uniqueByPosition = all.filter((item, index, items) => {
    return index === 0 || item.start !== items[index - 1].start;
  });

  function collectFrom(startIndex, expectedKey) {
    const accepted = [];
    let expectedCode = expectedKey.charCodeAt(0);
    for (let index = startIndex; index < uniqueByPosition.length; index += 1) {
      const item = uniqueByPosition[index];
      const code = item.key.charCodeAt(0);
      if (code < expectedCode) continue;
      if (code > expectedCode) {
        // 选项必须严格连续，不能从 B 直接跳到 D，也不能从正文里的某个
        // 字母重新起链。
        break;
      }
      accepted.push(item);
      expectedCode += 1;
    }
    return accepted;
  }

  let accepted = [];
  let inferredA = false;
  const firstA = uniqueByPosition.findIndex(item => item.key === 'A');
  if (firstA >= 0) accepted = collectFrom(firstA, 'A');

  // 自动编号丢失 A 时，只有 B/C/D 至少连续三项，且 B 前面确有正文，
  // 才把前缀恢复成 A。这样可解决 36VB.60VC.110VD.220V，同时不会
  // 把普通文字中的单个 B. 或 A网/B网说明误拆成选项。
  if (accepted.length < 3) {
    const firstB = uniqueByPosition.findIndex(item => item.key === 'B');
    if (firstB >= 0) {
      const fromB = collectFrom(firstB, 'B');
      const prefix = text.slice(0, uniqueByPosition[firstB].start).trim();
      if (prefix && fromB.length >= 3) {
        inferredA = true;
        accepted = [{ type: 'option', key: 'A', start: 0, end: 0, strict: false, tight: false, inferred: true }, ...fromB];
      }
    }
  }

  if (accepted.length < 3) return [];

  // 每个选项必须拥有非空正文；紧贴上一项的弱边界必须形成至少 A-D
  // 四项完整链。该约束是避免选项文字中“B.协议、C.语言”被误切的关键。
  for (let index = 0; index < accepted.length; index += 1) {
    const item = accepted[index];
    const next = accepted[index + 1];
    const body = text.slice(item.end, next ? next.start : text.length).trim();
    if (!body) return [];
  }
  const hasTightBoundary = accepted.some(item => item.tight);
  // 三选项题在 PDF/Word 中很常见，例如：
  //   A. 二氧化碳B. 干粉C. 泡沫
  // Word 自动编号还可能把 A. 放在列表编号中，正文只剩“二氧化碳B...C...”。
  // 只要 A 是明确的首选项标记（原文 A. 或由 Word 列表序号恢复），且 B/C
  // 都带选项标点并严格连续，就允许 A-B-C 三项紧凑链。这样既修复三选项题，
  // 又继续拒绝“正文A.术语B.术语C.术语”这类 A 本身没有明确边界的误切。
  const explicitCompactTriple = accepted.length === 3 && !inferredA &&
    accepted[0].key === 'A' && Boolean(accepted[0].strict) &&
    accepted.slice(1).every(item => Boolean(item.punctuated));
  if (hasTightBoundary && accepted.length < 4 && !explicitCompactTriple) return [];
  if (inferredA && accepted.length < 4) return [];

  // 普通三项链仍要求至少两个清晰边界；上面的“明确 A + 紧凑 B/C”是专门的
  // 三选项兼容分支。四项及以上完整链继续兼容紧凑旧题库格式。
  const clearBoundaryCount = accepted.filter(item => item.strict || !item.tight).length;
  if (accepted.length === 3 && clearBoundaryCount < 2 && !explicitCompactTriple) return [];
  return accepted;
}
function markerPositions(text) {
  const markers = [];
  const patterns = [
    { type: 'reference', re: /(?:参考答案|参考答|参考)\s*[:：]/g },
    { type: 'analysis', re: /(?:答案解析|试题解析|解析|说明)\s*[:：]/g },
    { type: 'answer', re: /(?:正确答案|标准答案|答案|答)\s*(?:为|是)?\s*[:：]/g },
    // 同一段中的（A）…（B）…，以及 A. / B、 等格式。
    { type: 'option', re: /(^|[\s；;\n。？！?：:])(?:[（(【\[]\s*)([A-L])\s*[）)】\]]\s*/g },
    { type: 'option', re: /(^|[\s；;\n。？！?：:）)】\]])([A-L])\s*[.、．:：)）]\s*/g }
  ];

  patterns.forEach(({ type, re }) => {
    let match;
    while ((match = re.exec(text))) {
      const prefixLength = type === 'option' ? (match[1] || '').length : 0;
      markers.push({
        type,
        start: match.index + prefixLength,
        end: re.lastIndex,
        key: type === 'option' ? match[2].toUpperCase() : ''
      });
    }
  });

  const semanticMarkers = markers.filter(item => item.type !== 'option');
  const firstSemanticStart = semanticMarkers.length ? Math.min(...semanticMarkers.map(item => item.start)) : Infinity;
  const bareOptions = bareInlineOptionMarkers(text, markers.filter(item => item.type === 'option'))
    .filter(item => item.start < firstSemanticStart);
  markers.push(...bareOptions);

  const sorted = markers.sort((a, b) => a.start - b.start || b.end - a.end);
  return sorted.filter((item, index, all) => {
    if (index > 0 && item.start === all[index - 1].start) return false;
    if (item.type === 'answer') {
      return !all.some(other => (other.type === 'reference' || other.type === 'analysis') && item.start >= other.start && item.start < other.end);
    }
    if (item.type === 'option') {
      return !all.some(other => other.type !== 'option' && other.start < item.start);
    }
    return true;
  });
}
function splitInlineJudgePair(value = '') {
  const clean = normalizeOneLine(value)
    .replace(/^选项\s*[:：]\s*/, '')
    .replace(/[，,。；;]+$/g, '')
    .trim();
  // Word 自动编号经常只保留第一项正文，形成“正确B.错误”；也兼容 A.正确B.错误。
  const match = /^(?:A\s*[.、．:：)）]?\s*)?(正确|对|是|错误|错|否)\s*B\s*[.、．:：)）]?\s*(正确|对|是|错误|错|否)$/i.exec(clean);
  if (!match) return null;
  const first = /^(?:正确|对|是)$/.test(match[1]) ? '正确' : '错误';
  const second = /^(?:正确|对|是)$/.test(match[2]) ? '正确' : '错误';
  if (first === second) return null;
  return [
    { type: 'option', key: 'A', value: first },
    { type: 'option', key: 'B', value: second }
  ];
}
function repairCollapsedChoiceOptions(options = [], answerLetters = [], questionText = '', typeHint = '') {
  if (!Array.isArray(options) || !options.length) return false;

  const normalizedAnswers = unique((answerLetters || []).map(value => String(value || '').toUpperCase()));
  const strongChoiceCue = typeHint === 'single' || typeHint === 'multiple' ||
    hasBlankPlaceholder(questionText) || isStrongQuestionCue(questionText);
  let changed = false;

  // 末端兜底不再只检查 A 项。PDF/Word 常把下一项的字母黏到上一项正文：
  //   C. 身上着火……火苗D. 火灾时……
  //   B. 管道……作业C. 应预先制定……
  // 此时前置解析已经得到 A/B/C，但最后一项正文里仍藏着“下一字母.”。
  // 只允许拆“当前项的紧邻下一项”，并要求答案/题型/后续选项提供结构证据，
  // 防止把普通正文中的 D.术语、B.协议之类误切成选项。
  for (let guard = 0; guard < 12; guard += 1) {
    let repairedThisRound = false;
    for (let index = 0; index < options.length; index += 1) {
      const item = options[index];
      if (!item || !item.key || !normalizeOneLine(item.text || '')) continue;
      const expectedCode = item.key.charCodeAt(0) + 1;
      if (expectedCode > 'L'.charCodeAt(0)) continue;
      const expected = String.fromCharCode(expectedCode);
      const marker = new RegExp(`${expected}\\s*[.、．:：)）]\\s*`, 'i').exec(item.text || '');
      if (!marker || marker.index <= 0) continue;
      const prefix = cleanQuestionText((item.text || '').slice(0, marker.index));
      const suffix = cleanQuestionText((item.text || '').slice(marker.index + marker[0].length));
      if (!prefix || !suffix) continue;

      const laterExisting = options.some(other => other && other.key && other.key.charCodeAt(0) > expectedCode);
      const answerSupports = normalizedAnswers.includes(expected) || normalizedAnswers.some(letter => letter.charCodeAt(0) > expectedCode);
      if (!answerSupports && !laterExisting && !strongChoiceCue) continue;

      const existing = options.find(other => other.key === expected);
      if (existing) {
        const existingText = normalizeOneLine(existing.text || '');
        if (existingText && existingText !== normalizeOneLine(suffix)) continue;
        existing.text = existing.text || suffix;
      } else {
        options.splice(index + 1, 0, { key: expected, text: suffix, images: [] });
      }
      item.text = prefix;
      repairedThisRound = true;
      changed = true;
      break;
    }
    if (!repairedThisRound) break;
  }

  // 兼容旧的“整个 A 项里连写 A/B/C/...”形态。上面的逐项修复已经覆盖绝大多数，
  // 这里保留一次完整链重拆，以处理 Word 自动编号和 PDF 紧凑行的历史题库。
  const first = options[0];
  if (first && first.key === 'A' && normalizeOneLine(first.text || '') && /[B-L]\\s*[.、．:：)）]/i.test(first.text || '')) {
    const tokens = splitInline(`A. ${first.text || ''}`)
      .filter(item => item.type === 'option' && item.key && normalizeOneLine(item.value || ''));
    if (tokens.length >= 3) {
      let sequential = true;
      for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index].key !== String.fromCharCode(65 + index)) { sequential = false; break; }
      }
      if (sequential) {
        const repairedKeys = tokens.map(item => item.key);
        const answerFits = normalizedAnswers.length > 0 && normalizedAnswers.every(value => repairedKeys.includes(value));
        if (answerFits || strongChoiceCue) {
          const existingByKey = new Map(options.map(item => [item.key, item]));
          let conflict = options.some(item => !repairedKeys.includes(item.key));
          for (const token of tokens.slice(1)) {
            const existing = existingByKey.get(token.key);
            if (!existing) continue;
            const oldText = normalizeOneLine(existing.text || '');
            const newText = normalizeOneLine(token.value || '');
            if (oldText && newText && oldText !== newText) { conflict = true; break; }
          }
          if (!conflict) {
            const repaired = tokens.map((token, index) => {
              const existing = existingByKey.get(token.key);
              return {
                key: token.key,
                text: cleanQuestionText(token.value || ''),
                images: unique([...(existing && existing.images || []), ...(index === 0 ? (first.images || []) : [])])
              };
            });
            options.splice(0, options.length, ...repaired);
            changed = true;
          }
        }
      }
    }
  }
  return changed;
}

function recoverFragmentedOptionContinuation(text = '', current = null) {
  if (!current || !Array.isArray(current.options) || current.options.length < 2) return null;
  if (current.typeHint === 'short' || current.typeHint === 'judge') return null;
  const clean = normalizeOneLine(text || '');
  if (!clean) return null;

  const last = current.options[current.options.length - 1];
  if (!last || !last.key) return null;
  const expectedCode = last.key.charCodeAt(0) + 1;
  if (expectedCode > 'L'.charCodeAt(0)) return null;
  const expected = String.fromCharCode(expectedCode);

  const questionText = cleanQuestionText(current.questionParts);
  const strongChoiceCue = current.typeHint === 'single' || current.typeHint === 'multiple' ||
    hasBlankPlaceholder(questionText) || /^(?:下列|以下|关于|根据|在|当|选择|哪|何种)/.test(questionText);
  if (!strongChoiceCue) return null;

  const markers = [];
  const re = /([A-L])\s*[.、．:：)）]\s*/ig;
  let match;
  while ((match = re.exec(clean))) {
    markers.push({ key: match[1].toUpperCase(), start: match.index, end: re.lastIndex });
  }
  if (!markers.length) return null;

  const first = markers[0];
  const firstCode = first.key.charCodeAt(0);
  const prefix = clean.slice(0, first.start).trim();
  const result = [];

  // 正常断行：上一项正文的续行末尾紧跟下一项标记。
  // B 已开始，下一段“……设备设施上不应作业C.应预先……” -> 先补 B，再创建 C。
  if (firstCode === expectedCode) {
    if (prefix) result.push({ type: 'text', value: prefix, optionContinuation: true });
  // PDF 坐标提取偶尔只丢一个选项字母：D 后下一段“火灾探测器 F.PLC...”。
  // 仅允许跳过恰好一个字母，并把 F 前面的非空前缀恢复成 E。
  } else if (firstCode === expectedCode + 1 && prefix) {
    result.push({ type: 'option', key: expected, value: prefix, inferredMissingMarker: true });
  } else return null;

  let wanted = first.key.charCodeAt(0);
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const code = marker.key.charCodeAt(0);
    if (code !== wanted) break;
    const next = markers[index + 1];
    const value = clean.slice(marker.end, next ? next.start : clean.length).trim();
    if (!value) return null;
    result.push({ type: 'option', key: marker.key, value });
    wanted += 1;
  }
  return result.some(token => token.type === 'option') ? result : null;
}
function splitCompactAnswerOptions(text = '') {
  const clean = normalizeText(text || '');
  // 兼容“答案：CA、选项… / 答案 C；A.选项… / 正确答案为C A)…”等紧凑写法。
  // `答案(?!解析)` 避免把“答案解析”误当成答案标签。
  const label = /(?:正确答案|标准答案|参考答案|答案(?!解析)|答)\s*(?:为|是)?\s*[:：]?\s*/i.exec(clean);
  if (!label) return null;
  const question = clean.slice(0, label.index).trim();
  const tail = clean.slice(label.index + label[0].length).trim();
  const compact = /^([A-L]{1,8})\s*[；;，,、\s]*A\s*(?:[.、．:：)）]\s*|\s+)([\s\S]+)$/i.exec(tail);
  if (!compact) return null;
  const answerLetters = unique((compact[1].toUpperCase().match(/[A-L]/g) || []));
  if (!answerLetters.length) return null;
  const optionStream = `A. ${compact[2].trim()}`;
  const optionMarkers = markerPositions(optionStream).filter(item => item.type === 'option');
  if (optionMarkers.length < 2 || optionMarkers[0].key !== 'A') return null;
  const options = optionMarkers.map((marker, index) => {
    const next = optionMarkers[index + 1];
    return { type: 'option', key: marker.key, value: optionStream.slice(marker.end, next ? next.start : optionStream.length).trim() };
  }).filter(item => item.value);
  if (options.length < 2) return null;
  const result = [];
  if (question) result.push({ type: 'text', value: question });
  result.push({ type: 'answer', value: answerLetters.join('') });
  result.push(...options);
  return result;
}

function splitInline(text) {
  const clean = normalizeText(text).replace(/选项\s*[:：]/g, ' ');
  const compactAnswerOptions = splitCompactAnswerOptions(clean);
  if (compactAnswerOptions) return compactAnswerOptions;
  const judgePair = splitInlineJudgePair(clean);
  if (judgePair) return judgePair;
  const markers = markerPositions(clean);
  if (!markers.length) return [{ type: 'text', value: clean }];

  const result = [];
  if (markers[0].start > 0) {
    result.push({ type: 'text', value: clean.slice(0, markers[0].start).trim() });
  }

  markers.forEach((marker, index) => {
    const next = markers[index + 1];
    result.push({
      type: marker.type,
      key: marker.key,
      value: clean.slice(marker.end, next ? next.start : clean.length).trim()
    });
  });
  return result.filter(item => item.value || item.type !== 'text');
}

function isNoiseParagraph(text, repeatedCount = 0) {
  const clean = normalizeOneLine(text);
  if (!clean) return true;
  if (/^第\s*\d+\s*页(?:\s*(?:初级工|中级工|高级工))?$/.test(clean)) return true;
  if (/^[-—–]\s*\d+\s*[-—–]$/.test(clean)) return true;
  if (/^\S.{0,50}[.．·…]{4,}\s*\d+$/.test(clean)) return true;
  if (/^后接[\u3400-\u9fff]{2,6}$/.test(clean)) return true;
  if (repeatedCount >= 3 && /^(?:第\s*\d+\s*页|[-—–]\s*\d+\s*[-—–])/.test(clean)) return true;
  return false;
}

function mergeSplitQuestionStarts(paragraphs = []) {
  const source = (paragraphs || []).map(item => Object.assign({}, item, {
    sourceIndexes: Array.isArray(item.sourceIndexes) && item.sourceIndexes.length
      ? item.sourceIndexes.slice()
      : [item.index]
  }));
  const merged = [];
  let repairedCount = 0;

  const standaloneNumber = value => /^\s*(\d{1,4})\s*[.、．:：)）-]?\s*$/.exec(normalizeOneLine(value || ''));
  const startsWithQuestionWord = value => {
    const clean = normalizeOneLine(value || '');
    if (!clean || /^题\s*(?:共)?\s*\d+\s*$/.test(clean)) return false;
    return /^(?:题目|题干|问题)\s*[:：]?|^题(?!\s*(?:共)?\s*\d+\s*$)|^(?:[（(\[【]?\s*)?(?:单选题|单项选择题|单选|多选题|多项选择题|多选|判断题|判断|简答题|问答题|实操题|论述题|填空题|计算题|画图题|绘图题|作图题)/.test(clean);
  };
  const looksLikeOptionOrAnswer = value => {
    const clean = normalizeOneLine(value || '');
    return /^(?:[A-L]\s*[.、．:：)）]|[（(]?[A-L][）)]|(?:正确答案|标准答案|参考答案|答案|答)\s*(?:为|是)?\s*[:：])/i.test(clean);
  };
  const likelyQuestionBody = (value, nextValue, number) => {
    const clean = normalizeOneLine(value || '');
    if (!clean) return false;
    if (startsWithQuestionWord(clean)) return true;
    if (Number(number) > 99) return false;
    const cue = /[？?]$|[（(]\s*[）)]|^(?:下列|以下|关于|根据|在|当|为了|某|用|一个|一台|仪表|控制|应急|进入|高处|放射|动火|什么|如何|为什么|简述|说明)/.test(clean);
    return cue && looksLikeOptionOrAnswer(nextValue);
  };

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const numberMatch = standaloneNumber(current.text);
    if (!numberMatch) {
      merged.push(current);
      continue;
    }

    const next = source[index + 1];
    const afterNext = source[index + 2];
    if (!next) {
      merged.push(current);
      continue;
    }

    let consume = 1;
    let body = normalizeText(next.text || '').trim();
    let evidenceNext = afterNext ? afterNext.text : '';

    // 某些 PDF 转 Word 文档把“题”单独放一段，题干在再下一段。
    if (/^\s*题\s*$/.test(normalizeOneLine(body)) && afterNext) {
      const third = source[index + 3];
      if (likelyQuestionBody(afterNext.text, third ? third.text : '', numberMatch[1])) {
        body = `题 ${normalizeText(afterNext.text || '').trim()}`.trim();
        evidenceNext = third ? third.text : '';
        consume = 2;
      }
    }

    if (!likelyQuestionBody(body, evidenceNext, numberMatch[1])) {
      merged.push(current);
      continue;
    }

    const parts = [current, next];
    if (consume === 2) parts.push(afterNext);
    const sourceIndexes = [];
    const images = [];
    const alternatives = [];
    parts.forEach(part => {
      (part.sourceIndexes || [part.index]).forEach(value => {
        if (!sourceIndexes.includes(value)) sourceIndexes.push(value);
      });
      (part.images || []).forEach(value => {
        if (!images.includes(value)) images.push(value);
      });
      (part.alternatives || []).forEach(value => {
        if (!alternatives.includes(value)) alternatives.push(value);
      });
    });

    merged.push(Object.assign({}, current, {
      text: `${numberMatch[1]}. ${body}`.trim(),
      images,
      alternatives,
      sourceIndexes,
      splitQuestionStartRepair: true
    }));
    repairedCount += 1;
    index += consume;
  }

  return { paragraphs: merged, repairedCount };
}

function sanitizeParagraphs(paragraphs) {
  const counts = {};
  paragraphs.forEach(item => {
    const key = compactText(item.text || '');
    if (key && key.length <= 80) counts[key] = (counts[key] || 0) + 1;
  });

  let removedNoiseCount = 0;
  const clean = paragraphs.filter(item => {
    const key = compactText(item.text || '');
    // 纯图片段落不是空白噪声，后续可能需要与 A/B/C/D 图片选项合并。
    if (!key && Array.isArray(item.images) && item.images.length) return true;
    const noise = isNoiseParagraph(item.text, counts[key] || 0);
    if (noise) removedNoiseCount += 1;
    return !noise;
  });
  return { paragraphs: clean, removedNoiseCount };
}

// Word/PDF 转换文件有时把图片和“A.图形”拆成相邻两个段落：
// 图片段在前，选项标签段在后。若不合并，图片会被当成题干图，四张图全部
// 堆在题干区域，甚至第一题的图完全无法与 A/B/C/D 对应。
function mergeDetachedOptionImages(paragraphs = []) {
  const result = [];
  let repairedCount = 0;
  const genericVisualOption = value => /^\s*(?:[（(]\s*)?([A-L])\s*(?:[）)]|[.、．:：]|\s+)?\s*(?:图|图形|图片|图示|示意图|符号图|见图|如下图)\s*$/i.exec(normalizeOneLine(value || ''));
  for (let index = 0; index < paragraphs.length; index += 1) {
    const current = paragraphs[index];
    const next = paragraphs[index + 1];
    const currentText = normalizeOneLine(current && current.text || '');
    const images = current && Array.isArray(current.images) ? current.images.filter(Boolean) : [];
    const nextMatch = next ? genericVisualOption(next.text) : null;
    if (!currentText && images.length && nextMatch) {
      const sourceIndexes = [];
      [current, next].forEach(item => {
        const indexes = Array.isArray(item.sourceIndexes) && item.sourceIndexes.length
          ? item.sourceIndexes : [item.index];
        indexes.forEach(value => { if (!sourceIndexes.includes(value)) sourceIndexes.push(value); });
      });
      result.push({
        ...next,
        images: unique([...(next.images || []), ...images]),
        sourceIndexes
      });
      repairedCount += 1;
      index += 1;
      continue;
    }
    result.push(current);
  }
  return { paragraphs: result, repairedCount };
}

function repairBrokenQuestionNumber(rawNumber = '', rawTotal = '') {
  const numberText = String(rawNumber);
  const total = Number(rawTotal);
  const direct = Number(numberText);
  if (Number.isFinite(total) && direct > total && /1$/.test(numberText)) {
    const repaired = numberText.slice(0, -1);
    const repairedNumber = Number(repaired);
    if (repaired && repairedNumber >= 1 && repairedNumber <= total) return repaired;
  }
  return numberText;
}

function normalizeBrokenPdfQuestionPrefix(text = '', sourceKind = '') {
  const clean = normalizeOneLine(text);
  if (sourceKind !== 'pdf') return clean;
  // PDF 文字坐标有时会把“80.（ ）.”重排成“80（.）.”，把题号标点
  // 塞进判断括号内部。恢复为标准题号与判断占位，避免整题并入上一题。
  const malformedJudge = /^\s*(\d{1,5})\s*[（(]\s*[.．]\s*[）)]\s*[.．、:：]?\s*(.*)$/.exec(clean);
  if (malformedJudge) return `${malformedJudge[1]}. （）${malformedJudge[2] ? ` ${malformedJudge[2]}` : ''}`;
  return clean;
}

function parseQuestionStart(text, context, paragraph, sourceKind = '') {
  text = normalizeBrokenPdfQuestionPrefix(text, sourceKind);
  const countMatch = COUNT_RE.exec(text);
  if (countMatch) {
    const meta = typeMetaFromLabel(countMatch[2]);
    return { number: countMatch[1], typeHint: meta.type, displayTypeLabel: meta.label, content: countMatch[3], boundarySource: '题号和题型' };
  }

  if (sourceKind === 'pdf') {
    const compactBrokenCount = COMPACT_BROKEN_COUNT_RE.exec(text);
    if (compactBrokenCount) {
      const number = Number(compactBrokenCount[1]);
      const total = Number(compactBrokenCount[2]);
      if (number >= 1 && total >= number && total <= 500) {
        const meta = typeMetaFromLabel(compactBrokenCount[3]);
        return {
          number: compactBrokenCount[1],
          typeHint: meta.type,
          displayTypeLabel: meta.label,
          content: compactBrokenCount[4],
          boundarySource: '修复紧连异常题号和题型'
        };
      }
    }
  }

  const brokenCount = BROKEN_COUNT_RE.exec(text);
  if (brokenCount) {
    const meta = typeMetaFromLabel(brokenCount[3]);
    return {
      number: repairBrokenQuestionNumber(brokenCount[1], brokenCount[2]),
      typeHint: meta.type,
      displayTypeLabel: meta.label,
      content: brokenCount[4],
      boundarySource: '修复异常题号和题型'
    };
  }

  const genericCount = GENERIC_COUNT_RE.exec(text);
  if (genericCount) {
    const peeled = peelLeadingType(genericCount[2], context.typeHint, context.displayTypeLabel);
    return { number: genericCount[1], typeHint: peeled.typeHint, displayTypeLabel: peeled.displayTypeLabel, content: peeled.content, boundarySource: '题库序号' };
  }

  const bareNumberedQuestion = BARE_NUMBERED_QUESTION_RE.exec(text);
  if (bareNumberedQuestion) {
    const peeled = peelLeadingType(bareNumberedQuestion[2], context.typeHint, context.displayTypeLabel);
    return {
      number: bareNumberedQuestion[1],
      typeHint: peeled.typeHint,
      displayTypeLabel: peeled.displayTypeLabel,
      content: peeled.content,
      boundarySource: '题字题号'
    };
  }

  const numberedType = NUMBERED_TYPE_RE.exec(text);
  if (numberedType) {
    const meta = typeMetaFromLabel(numberedType[2]);
    return { number: numberedType[1], typeHint: meta.type, displayTypeLabel: meta.label, content: numberedType[3], boundarySource: '题号和题型' };
  }

  const bracketType = BRACKET_TYPE_RE.exec(text);
  if (bracketType && bracketType[2]) {
    const meta = typeMetaFromLabel(bracketType[1]);
    return { number: '', typeHint: meta.type, displayTypeLabel: meta.label, content: bracketType[2], boundarySource: '题型标签' };
  }

  const typed = TYPED_RE.exec(text);
  if (typed) {
    const meta = typeMetaFromLabel(typed[1]);
    return { number: '', typeHint: meta.type, displayTypeLabel: meta.label, content: typed[2], boundarySource: '题型标签' };
  }

  const labeled = /^(?:题目|题干|问题)\s*[:：]\s*(.+)$/.exec(text);
  if (labeled) return { number: '', typeHint: context.typeHint, displayTypeLabel: context.displayTypeLabel, content: labeled[1], boundarySource: '题干标签' };

  for (let index = 0; index < QUESTION_RES.length; index += 1) {
    const match = QUESTION_RES[index].exec(text);
    if (match) {
      const peeled = peelLeadingType(match[2], context.typeHint, context.displayTypeLabel);
      return { number: match[1], typeHint: peeled.typeHint, displayTypeLabel: peeled.displayTypeLabel, content: peeled.content, boundarySource: '显式题号' };
    }
  }

  if (context.typeHint) {
    const noPunctuation = NO_PUNCT_NUMBER_RE.exec(text);
    if (noPunctuation) {
      const peeled = peelLeadingType(noPunctuation[2], context.typeHint, context.displayTypeLabel);
      return { number: noPunctuation[1], typeHint: peeled.typeHint, displayTypeLabel: peeled.displayTypeLabel, content: peeled.content, boundarySource: '无标点题号' };
    }
  }

  if (paragraph.numId && paragraph.numId !== '0' && paragraph.level === 0 && !OPTION_LINE_RE.test(text) && !/^(?:答案|参考答案|解析|答)\s*[:：]/.test(text)) {
    const peeled = peelLeadingType(text, context.typeHint, context.displayTypeLabel);
    return {
      number: paragraph.listOrdinal ? String(paragraph.listOrdinal) : '',
      typeHint: peeled.typeHint,
      displayTypeLabel: peeled.displayTypeLabel,
      content: peeled.content,
      boundarySource: 'Word自动编号'
    };
  }
  return null;
}

function createWorkingQuestion(number, context, boundarySource = '') {
  return {
    id: createId('q'),
    number: number || '',
    level: context.level,
    category: context.category,
    chapter: context.chapter,
    typeHint: context.typeHint,
    displayTypeLabel: context.displayTypeLabel || '',
    questionParts: [],
    options: [],
    answer: [],
    answerTextParts: [],
    analysisParts: [],
    images: [],
    answerImages: [],
    analysisImages: [],
    sourceParagraphs: [],
    rawTexts: [],
    boundarySource,
    answerSources: [],
    answerBoundarySource: '',
    answerBoundaryConfidence: 0,
    difficulty: '',
    knowledgePoint: '',
    material: '',
    materialImages: [],
    inferredBoundary: boundarySource === '智能推断边界'
  };
}

function pushText(target, value) {
  const clean = normalizeText(value || '');
  if (clean) target.push(clean);
}

function isGenericVisualPlaceholder(value = '') {
  const clean = normalizeOneLine(value || '')
    .replace(/[\s()（）\[\]【】<>《》]/g, '')
    .replace(/[.。:：、，,;；]/g, '')
    .toLowerCase();
  return /^(?:图|图形|图片|图示|示意图|符号图|见图|如下图)$/.test(clean);
}

function addOption(current, key, value, images = []) {
  const cleanKey = String(key || '').toUpperCase();
  const cleanText = cleanQuestionText(value || '');
  const imageList = unique((images || []).filter(Boolean));
  const existing = current.options.find(item => item.key === cleanKey);
  if (existing) {
    if (cleanText) existing.parts.push(cleanText);
    existing.images = unique([...(existing.images || []), ...imageList]);
  } else current.options.push({ key: cleanKey, parts: cleanText ? [cleanText] : [], images: imageList });
}

function matchOptionLine(text, current) {
  if (!current || !current.questionParts.length) return null;
  const clean = normalizeOneLine(text);
  const match = /^\s*([A-L])\s*(?:[.、．:：)）]\s*)?(.+?)\s*$/i.exec(clean);
  if (!match) return null;

  const key = match[1].toUpperCase();
  const value = match[2].trim();
  if (!value) return null;
  const questionText = cleanQuestionText(current.questionParts);
  // 选项行先按结构暂存，最终题型再综合题型标签、答案和选项数量决定。
  // 以前这里遇到“有哪些/是什么”等提问词就拒绝识别 A、B、C、D，
  // 会把真实选择题整段塞进简答答案。即使它最终确实是简答题，finalize
  // 也会把暂存选项还原为参考答案，因此这里不应提前丢弃结构证据。

  const expected = current.options.length
    ? String.fromCharCode(current.options[current.options.length - 1].key.charCodeAt(0) + 1)
    : 'A';
  if (key !== expected) return null;

  const hasPunctuation = /^\s*[A-L]\s*[.、．:：)）]/i.test(clean);
  // “A.第一项 B.第二项 C.第三项”同段时交给 splitInline；
  // “A.A网黄色.B网绿色”中的 A网/B网属于选项文字，不应再次拆分。
  const laterExplicit = [];
  const laterRe = /(?:^|[\s；;。！？?])(?:[（(]\s*)?([A-L])\s*(?:[）)]|[.、．:：)）])\s*/ig;
  let later;
  while ((later = laterRe.exec(value))) laterExplicit.push(later[1].toUpperCase());
  const hasSeveralInlineOptions = laterExplicit.length >= 1 && laterExplicit[0].charCodeAt(0) === key.charCodeAt(0) + 1;

  return { key, value, direct: !hasSeveralInlineOptions || !hasPunctuation };
}
function recoverMissingACompactChoiceLine(text, current) {
  if (!current || current.options.length || !current.questionParts.length) return null;
  if (current.typeHint === 'short' || current.typeHint === 'judge') return null;

  const clean = normalizeOneLine(text || '');
  if (!clean || /^[A-L]\s*[.、．:：)）]/i.test(clean)) return null;
  // 必须至少出现连续的 B./C.，前缀才有资格被恢复为 A。
  if (!/B\s*[.、．:：)）]/i.test(clean) || !/C\s*[.、．:：)）]/i.test(clean)) return null;

  const questionText = cleanQuestionText(current.questionParts);
  const choiceContext = current.typeHint === 'single' || current.typeHint === 'multiple' ||
    hasBlankPlaceholder(questionText) || /^(?:下列|以下|关于|根据|在|当|选择|哪|何种)/.test(questionText);
  if (!choiceContext) return null;

  const tokens = splitInline(`A. ${clean}`).filter(item => item.type === 'option');
  if (tokens.length < 3) return null;
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].key !== String.fromCharCode(65 + index) || !normalizeOneLine(tokens[index].value || '')) return null;
  }
  return tokens;
}

function isComplete(current) {
  if (!current) return false;
  if (current.answer.length) return true;
  if (current.answerTextParts.length) return true;
  return false;
}

function looksLikeQuestionLine(text, context, paragraph) {
  const clean = normalizeOneLine(text);
  if (clean.length < 5) return false;
  if (OPTION_LINE_RE.test(clean) || LOOSE_OPTION_LINE_RE.test(clean)) return false;
  if (/^(?:答案|参考答案|解析|答|说明)\s*[:：]/.test(clean)) return false;
  if (/^(?:因为|由于|所以|因此|其中|即|本题|该题|故|解析可知)/.test(clean)) return false;
  if (/[？?]$/.test(clean) || /[（(]\s*[）)]/.test(clean)) return true;
  if (/^(?:下列|以下|关于|根据|在|当|为了|某|用|一个|一台|串行|金属|仪表|控制|应急|进入|高处|放射|动火)/.test(clean)) return true;
  if (context.typeHint === 'judge') return true;
  if (paragraph.numId && paragraph.numId !== '0' && paragraph.level === 0) return true;
  return context.typeHint && clean.length >= 10;
}

function isStrongQuestionCue(text) {
  const clean = normalizeOneLine(text);
  if (/[？?]$/.test(clean) || /[（(]\s*[）)]/.test(clean)) return true;
  return /^(?:题目|题干|问题)\s*[:：]|^(?:下列|以下|关于|根据|在|当|为了|某|用|一个|一台|串行|金属|仪表|控制|应急|进入|高处|放射|动火|什么|如何|为什么|简述|说明)/.test(clean);
}

function looksLikeQuestionContinuation(text, current) {
  const clean = normalizeOneLine(text);
  const questionText = cleanQuestionText(current && current.questionParts);
  if (!clean || !questionText) return false;

  if (/^(?:和|与|及|或|以及|并|且|其中|即|分别|包括|由|是|为|的|可|应|需|需要|以及其)/.test(clean)) return true;
  if (/[，,：:、（(]$/.test(questionText)) return true;
  if (/(?:和|与|及|或|包括|分为|由|是|为|有|如下|下列|以下)$/.test(questionText)) return true;
  if (!/[。！？?；;]$/.test(questionText) && /[？?]$/.test(clean)) return true;
  if (questionText.length < 16 && !isListStart(clean) && /(?:是什么|有哪些|如何|为什么|是否|能否|怎样|何种|何时|何处|多少|几种|哪些)[？?]?$/.test(clean)) return true;
  return false;
}

function inferUnlabeledShortAnswer(text, current, mode) {
  const rejected = { isAnswer: false, confidence: 0, reason: '' };
  if (!current || mode !== 'question' || current.options.length || current.answer.length || current.answerTextParts.length) return rejected;

  const questionText = cleanQuestionText(current.questionParts);
  const clean = normalizeOneLine(text);
  if (!questionText || !clean) return rejected;

  if (current.displayTypeLabel === '填空题' && hasBlankPlaceholder(questionText) &&
      !hasBlankPlaceholder(clean) && !isStrongQuestionCue(clean) &&
      !/^(?:第?\d+题|[A-L][.、．:：)）]|(?:正确答案|标准答案|参考答案|答案|答|解析|说明)\s*[:：])/i.test(clean)) {
    return { isAnswer: true, confidence: 0.98, reason: '填空题下一行无标签答案' };
  }

  // 显式边界优先于智能推断。选项标签也必须先交给结构解析器。
  if (/^(?:题目|题干|问题|选项|正确答案|标准答案|答案|参考答案|答案解析|试题解析|解析|说明)\s*[:：]/.test(clean)) return rejected;
  const explicitShortQuestion = current.typeHint === 'short' || isStrongShortQuestion(questionText);
  if (!explicitShortQuestion) return rejected;
  if ((current.typeHint === 'short' || isStrongShortQuestion(questionText)) &&
      (/^[A-L]\s*[.、．:：)）]/i.test(clean) || isMappingAnswerLine(clean, questionText))) {
    return { isAnswer: true, confidence: 0.96, reason: '简答题字母要点或字母含义映射' };
  }
  if (/^[A-L]\s*[.、．:：)）]/i.test(clean)) return rejected;
  if (looksLikeQuestionContinuation(clean, current)) return rejected;
  if (isStrongQuestionCue(clean)) return rejected;

  let score = 0;
  const reasons = [];
  const explicitShort = current.typeHint === 'short';
  const questionEnded = /[？?]\s*$/.test(questionText);
  const sentenceEnded = /[。！!]\s*$/.test(questionText);
  const shortCue = explicitShortQuestion;
  const labeledQuestion = /题干标签/.test(current.boundarySource || '');
  const listAnswer = isListStart(clean);
  const answerOpening = /^(?:是指|是|指|包括|主要包括|由|有|可分为|分为|应|需要|需|其|答|原因是|措施有|特点是|作用是)/.test(clean);
  const nounAnswer = clean.length <= 80 &&
    /(?:说明书|规格表|一览表|接线表|布置图|安装图|配管图|流程图|示意图|记录表|清单|台账|规程|设备|材料|文件|记录|措施|步骤|方法|内容|要求|规定|系统|装置|工具|仪器|仪表|故障|误差|原因|等)$/.test(clean);

  if (explicitShort) { score += 3; reasons.push('当前题型为简答题'); }
  if (questionEnded) { score += 2; reasons.push('题干以问号结束'); }
  if (sentenceEnded && explicitShort) { score += 1; reasons.push('简答题题干已形成完整句子'); }
  if (shortCue) { score += 2; reasons.push('题干包含简答提问词'); }
  if (labeledQuestion) { score += 1; reasons.push('题干带有题目标签'); }
  if (listAnswer) { score += 3; reasons.push('下一段为编号要点'); }
  if (answerOpening) { score += 2; reasons.push('下一段具有答案句式'); }
  if (nounAnswer && explicitShort) { score += 2; reasons.push('下一段为简答要点名词'); }
  if (clean.length >= 12 && !/[？?]$/.test(clean)) { score += 1; reasons.push('下一段更像陈述答案'); }

  return {
    isAnswer: score >= 4,
    confidence: Math.min(0.95, Math.max(0.5, score / 10)),
    reason: reasons.join('、')
  };
}

function shouldTreatAsAnswerContinuation(text, current, mode, context, paragraph, continuationFlags = {}) {
  if (!current || !['reference', 'analysis', 'answer'].includes(mode)) return false;
  const clean = normalizeOneLine(text);
  const questionText = cleanQuestionText(current.questionParts);
  const shortAnswerContext = current.typeHint === 'short' || isStrongShortQuestion(questionText) || current.answerBoundarySource === '显式参考答案标签';
  // 先保留连续 A/B/C/D 结构，再由 finalize 判断它究竟是选择题选项，
  // 还是简答题中的字母要点。旧逻辑先按“简答续行”吞掉，导致多选题
  // 的选项和末尾 ABCD 答案全部进入参考答案框。
  if (matchOptionLine(clean, current)) return false;
  if ((mode === 'reference' || mode === 'answer') && shortAnswerContext && /^[A-L]\s*[.、．:：)）]/i.test(clean)) return true;
  if (COUNT_RE.test(clean) || GENERIC_COUNT_RE.test(clean) || BROKEN_COUNT_RE.test(clean) || NUMBERED_TYPE_RE.test(clean) || BRACKET_TYPE_RE.test(clean) || TYPED_RE.test(clean) || /^(?:题目|题干|问题)\s*[:：]/.test(clean)) return false;
  const possibleHeader = classifyHeader(clean, paragraph && paragraph.style);
  if (possibleHeader && (possibleHeader.kind === 'type' || possibleHeader.kind === 'level')) return false;
  if (possibleHeader && possibleHeader.kind === 'category' && ((paragraph && paragraph.style) || /(?:知识|控制阀|安全环保|管理|基础|专业|法规|标准|实操)$/.test(clean))) return false;

  const noPunctuationStart = NO_PUNCT_NUMBER_RE.exec(clean);
  if (noPunctuationStart && isComplete(current)) {
    const nextNumber = Number(noPunctuationStart[1]);
    const currentNumber = Number(current.number);
    const body = normalizeOneLine(noPunctuationStart[2]);
    const boundaryCue = /[：:？?]$|[（(]\s*[）)]|^(?:下列|以下|关于|根据|在|当|为了|某|用|一个|一台|仪表|控制|应急|进入|高处|放射|动火|更换|安装|检查|校验|简述|说明)/.test(body);
    if (Number.isFinite(currentNumber) && nextNumber === currentNumber + 1 && boundaryCue) return false;
  }

  for (const pattern of QUESTION_RES) {
    const match = pattern.exec(clean);
    if (!match) continue;
    const nextNumber = Number(match[1]);
    const currentNumber = Number(current.number);
    const shortAnswerMode = (mode === 'reference' || mode === 'answer') && (current.typeHint === 'short' || !current.options.length);
    if (shortAnswerMode) {
      let numberedItems = [];
      if (continuationFlags.enhancedNumberedAnswerContinuation) {
        current.answerTextParts.forEach(part => {
          const value = normalizeOneLine(part);
          const itemRe = /(?:^|[；;。！？!?]\s*)(\d{1,3})\s*[.、．)）](?=\s*[\u3400-\u9fffA-Za-z（(])/g;
          let itemMatch;
          while ((itemMatch = itemRe.exec(value))) {
            const number = Number(itemMatch[1]);
            if (number >= 1) numberedItems.push(number);
          }
        });
      } else {
        numberedItems = current.answerTextParts
          .map(part => /^\s*(\d+)\s*[.、．)）]/.exec(normalizeOneLine(part)))
          .filter(Boolean)
          .map(item => Number(item[1]))
          .filter(number => number >= 1);
      }
      // PDF 和“Word 自动编号答案附录”试卷启用增强续行：简答答案可能先列 1~10，
      // 再另起 1~8；也可能 PDF 把“2）”留在上一行而下一行从“3）”开始。
      // 其他既有格式仍维持 v2.0.5 的最大编号判断，降低回归面。
      const lastItem = numberedItems.length ? (continuationFlags.enhancedNumberedAnswerContinuation
        ? numberedItems[numberedItems.length - 1] : Math.max(...numberedItems)) : 0;
      const sequential = (lastItem === 0 && nextNumber === 1) || (lastItem > 0 && nextNumber === lastItem + 1);
      const explicitNewQuestion = /^(?:题目|题干|问题)\s*[:：]|[？?]|[（(]\s*[）)]|单选题|多选题|判断题|简答题|问答题|实操题|论述题|填空题|计算题|画图题|绘图题|作图题|【判断】|【判断题】/.test(match[2]);
      if (sequential && !explicitNewQuestion) return true;
    }
    if (isStrongQuestionCue(match[2])) return false;
    if (Number.isFinite(currentNumber) && currentNumber > 0 && nextNumber === currentNumber + 1) return false;
  }

  // 简答题参考答案中，未编号的“说明书、规格表、安装图”等名词条目
  // 虽然可能以“仪表”等题干高频词开头，仍应保留在当前答案中。
  // 这里只放宽短名词条目，不放宽带问号、填空括号或明显提问词的新题。
  const explicitShortAnswer = (mode === 'reference' || mode === 'answer') &&
    current.typeHint === 'short' && current.questionParts.length > 0;
  if (explicitShortAnswer) {
    const asksQuestion = /[？?]/.test(clean) || /[（(]\s*[）)]/.test(clean) ||
      /(?:什么|哪些|如何|为什么|是否|能否|下列|以下|简述|说明一下|要求回答)/.test(clean);
    const nounItem = clean.length <= 60 &&
      /(?:说明书|规格表|一览表|接线表|布置图|安装图|配管图|流程图|示意图|记录表|清单|台账|规程|设备|材料|文件|记录|措施|步骤|方法|内容|要求|规定|系统|装置|工具|仪器|仪表|等)$/.test(clean);
    if (!asksQuestion && nounItem) return true;
  }

  if (mode === 'answer') {
    const questionText = cleanQuestionText(current.questionParts);
    const looksShort = current.typeHint === 'short' || /(?:什么|简述|说明|哪些|如何|为什么|规定|要求|步骤|内容)[？?]?$/.test(questionText);
    if (!looksShort) return false;
  }

  if (/^(?:因为|由于|其中|即|所以|因此|说明|注意|另外|同时|并且|且|或)/.test(clean)) return true;
  if (isListStart(clean)) return !isStrongQuestionCue(clean);

  const previousParts = mode === 'analysis' ? current.analysisParts : current.answerTextParts;
  const previous = previousParts.length ? previousParts[previousParts.length - 1] : '';
  if (/[，,；;：:]$/.test(previous)) return true;

  if (mode === 'analysis') {
    if (current.typeHint === 'judge' && clean.length >= 5) return false;
    return !isStrongQuestionCue(clean);
  }

  if ((mode === 'reference' || mode === 'answer') && (current.typeHint === 'short' || !current.options.length) && !isStrongQuestionCue(clean)) return true;
  return false;
}
function consumeInlineAnswer(current, content, allowImplicit) {
  const extracted = extractInlineAnswer(content, allowImplicit);
  current.answer.push(...extracted.answers);
  current.answerSources.push(...extracted.sources);
  return extracted.text;
}

function extractEmbeddedFillAnswers(value = '') {
  const source = normalizeText(value || '');
  if (!source) return { question: source, answers: [] };
  const pairs = { '（': '）', '(': ')', '【': '】', '[': ']' };
  const stack = [];
  const ranges = [];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (pairs[char]) { stack.push({ char, start: index }); continue; }
    if ((char === '）' || char === ')' || char === '】' || char === ']') && stack.length) {
      let openIndex = stack.length - 1;
      while (openIndex >= 0 && pairs[stack[openIndex].char] !== char) openIndex -= 1;
      if (openIndex < 0) continue;
      const open = stack[openIndex];
      stack.splice(openIndex, 1);
      if (openIndex !== 0 || stack.length) continue;
      const answer = source.slice(open.start + 1, index).trim();
      if (!answer || /^(?:[_＿—-]+|\s+)$/.test(answer) || /^(?:√|✓|×|✕|✖|正确|错误|对|错)$/.test(answer)) continue;
      ranges.push({ start: open.start, end: index + 1, answer, open: open.char });
    }
  }
  if (!ranges.length) return { question: source, answers: [] };
  let cursor = 0;
  let question = '';
  const answers = [];
  ranges.forEach(range => {
    question += source.slice(cursor, range.start);
    question += range.open === '（' ? '（　）' : (range.open === '(' ? '( )' : (range.open === '【' ? '【　】' : '[ ]'));
    answers.push(range.answer);
    cursor = range.end;
  });
  question += source.slice(cursor);
  return { question: cleanQuestionText(question), answers };
}

function styledFillFromParagraph(value = '', paragraph = {}) {
  const source = normalizeText(value || '');
  const candidates = unique((paragraph.styleAnswers || []).map(item => normalizeOneLine(item)).filter(item => item && item.length <= 200));
  if (!source || !candidates.length) return { question: source, answers: [] };
  let question = source;
  const answers = [];
  candidates.forEach(candidate => {
    const index = question.indexOf(candidate);
    if (index < 0) return;
    const before = question.slice(0, index);
    const after = question.slice(index + candidate.length);
    question = `${before}（　）${after}`;
    answers.push(candidate);
  });
  return { question: cleanQuestionText(question), answers };
}
function hasEmbeddedFillAnswer(value = '') { return extractEmbeddedFillAnswers(value).answers.length > 0; }
function hasBlankPlaceholder(value = '') { return /[（(]\s*[）)]|_{2,}|＿{2,}|（\s*　+\s*）/.test(normalizeOneLine(value || '')); }
function isCompactChoiceLine(value = '') { return Boolean(splitCompactAnswerOptions(normalizeText(value || ''))); }
function isInlineJudgeLine(value = '') { return /[（(【\[]\s*(?:√|✓|×|✕|✖|正确|错误|对|错)\s*[）)】\]]\s*[,，。；;]?$/.test(normalizeOneLine(value || '')); }
function shouldForceSectionQuestionStart(text, context, current, paragraph, sourceKind = '') {
  const clean = normalizeOneLine(text || '');
  if (!clean || classifyHeader(clean, paragraph && paragraph.style)) return false;
  const label = context.displayTypeLabel || '';
  if (label === '填空题') {
    const embedded = extractEmbeddedFillAnswers(clean);
    const wordLikeParagraphs = /^(?:doc|docx|rtf|odt)$/i.test(sourceKind || '');
    if (wordLikeParagraphs) {
      const currentQuestion = current ? cleanQuestionText(current.questionParts) : '';
      // “题干（ ）”下一段直接写答案时，下一段应作为无标签答案续行；
      // 其余 Word/ODT 段落在明确的填空题章节中均按独立题处理，
      // 包括少数原文没有括号、需要进入异常检查的题目。
      if (current && hasBlankPlaceholder(currentQuestion) && !hasEmbeddedFillAnswer(currentQuestion) &&
          !embedded.answers.length && !isStrongQuestionCue(clean)) return false;
      return true;
    }
    if (!embedded.answers.length) return false;
    // PDF 可能把同一道题拆成多行，保留更保守的句末/多空判断。
    return /[。！？?；;]$/.test(clean) || embedded.answers.length >= 2 || !current;
  }
  if ((context.typeHint === 'single' || context.typeHint === 'multiple') && isCompactChoiceLine(clean)) return true;
  if (context.typeHint === 'judge' && isInlineJudgeLine(clean)) return true;
  if (context.typeHint === 'short' && /(?:正确答案|标准答案|参考答案|答案|答)\s*(?:为|是)?\s*[:：]/.test(clean)) return true;
  return false;
}

function finalize(current, sourceName, useLocalAI = false, sourceKind = '', documentFlags = {}) {
  if (!current) return null;
  let questionText = cleanQuestionText(current.questionParts);
  let inlineShortAnswer = '';

  if (current.displayTypeLabel === '填空题' && !current.answerTextParts.length && !current.answer.length && !current.options.length) {
    const embeddedFill = extractEmbeddedFillAnswers(questionText);
    const wordAppendixNote = Boolean(documentFlags.wordAutoAnswerAppendix) && /_{2,}|＿{2,}/.test(questionText) &&
      embeddedFill.answers.length === 1 && /(?:除外|除非|备注|说明)/.test(embeddedFill.answers[0]);
    // 教师版 Word 试卷里会出现“_______，且不能……（自动中间点除外）”。
    // 括号是说明，不是填空答案；仅在已确认存在 Word 自动编号答案附录的文档中关闭该误判。
    if (embeddedFill.answers.length && !wordAppendixNote) {
      questionText = embeddedFill.question;
      inlineShortAnswer = embeddedFill.answers.join('；');
      current.typeHint = 'short';
      current.answerBoundarySource = current.answerBoundarySource || '填空题括号内答案';
      current.answerBoundaryConfidence = Math.max(Number(current.answerBoundaryConfidence) || 0, 0.99);
      current.answerSources.push('括号内填空答案');
    }
  }

  // Word 中常见“题干？参考答案”被放在同一段且没有“答案”标签。
  // 仅在没有独立答案、没有选项并且具备简答题特征时拆分，避免误切普通题干。
  if (!current.answerTextParts.length && !current.options.length) {
    const split = extractInlineShortAnswer(questionText, current.typeHint);
    if (split.answer) {
      questionText = split.question;
      inlineShortAnswer = split.answer;
      current.answerBoundarySource = current.answerBoundarySource || '题干问号后内联参考答案';
      current.answerBoundaryConfidence = Math.max(current.answerBoundaryConfidence || 0, 0.92);
      current.answerSources.push('题干问号后内联参考答案');
    }
  }

  let preservedBoundaryFailure = false;
  if (!questionText && !current.options.length && !current.answerTextParts.length && !inlineShortAnswer) {
    const explicitBoundary = Boolean(current.number) || (current.boundarySource && current.boundarySource !== '智能推断边界');
    const hasImages = Boolean((current.images || []).length || (current.answerImages || []).length || (current.analysisImages || []).length);
    const meaningfulRaw = (current.rawTexts || [])
      .map(value => normalizeOneLine(value))
      .filter(value => value && !/^\d{1,4}\s*(?:[\[【]\s*)?题\s*(?:[\]】])?$/.test(value) && !/^(?:题|题目|题干|问题)$/.test(value));
    if (!explicitBoundary && !hasImages && !meaningfulRaw.length) return null;
    questionText = meaningfulRaw.join(' ') || (hasImages ? '【图片题：题干文字未识别】' : '【题干文字未识别】');
    preservedBoundaryFailure = true;
  }

  const options = current.options.map(item => {
    const images = unique(item.images || []);
    const rawText = cleanQuestionText(item.parts);
    return {
      key: item.key,
      text: images.length && isGenericVisualPlaceholder(rawText) ? '' : rawText,
      images
    };
  });
  // 同一类教师版 Word 里还有“A 文本 B 文本 C 文本 D 文本”的无标点同行选项。
  // 前置循环可能已把整行暂存进 A，同时又补出 B/C/D；在 finalize 内按原 A 文本重建一次，
  // 只影响已经确认带 Word 自动编号答案附录的文档。
  if (documentFlags.wordAutoAnswerAppendix && options.length >= 3 && options[0] && options[0].key === 'A') {
    const bareABCD = /^(.+?)\s+B\s+(.+?)\s+C\s+(.+?)\s+D\s+(.+?)$/i.exec(normalizeOneLine(options[0].text || ''));
    if (bareABCD) {
      const imageByKey = new Map(options.map(item => [item.key, unique(item.images || [])]));
      options.splice(0, options.length,
        { key: 'A', text: cleanQuestionText(bareABCD[1]), images: imageByKey.get('A') || [] },
        { key: 'B', text: cleanQuestionText(bareABCD[2]), images: imageByKey.get('B') || [] },
        { key: 'C', text: cleanQuestionText(bareABCD[3]), images: imageByKey.get('C') || [] },
        { key: 'D', text: cleanQuestionText(bareABCD[4]), images: imageByKey.get('D') || [] }
      );
      current.answerSources.push('Word无标点同行选项最终重建');
    }
  }

  let answer = unique(current.answer);

  // 只对“已确认存在 Word 自动编号答案附录”的教师版试卷启用：
  // 部分前半段选择题把正确答案直接写在题干括号里，例如“流动方向是（B）”。
  // 先恢复这些明确答案，后续文末 1~12 的集中答案才会自然落到真正未作答的 16~27 题。
  if (documentFlags.wordAutoAnswerAppendix && !answer.length && options.length >= 2 && current.typeHint !== 'judge' && current.typeHint !== 'short') {
    const bracketMatches = [...questionText.matchAll(/[（(]\s*([A-L])\s*[）)]/ig)];
    if (bracketMatches.length === 1) {
      const letter = String(bracketMatches[0][1] || '').toUpperCase();
      if (options.some(item => item.key === letter)) {
        answer = [letter];
        questionText = questionText.replace(/（\s*[A-L]\s*）/i, '（ ）').replace(/\(\s*[A-L]\s*\)/i, '( )');
        current.answerSources.push('Word题干括号答案');
        current.answerBoundarySource = current.answerBoundarySource || 'Word题干括号答案';
        current.answerBoundaryConfidence = Math.max(Number(current.answerBoundaryConfidence) || 0, 0.99);
      }
    }
  }

  // 同一类试卷的最后一道判断题把“错”直接跟在空括号后：……（ ）错。
  // 仅在判断题上下文和该特殊文档结构下拆出答案，避免影响普通题干中的“对/错”字样。
  if (documentFlags.wordAutoAnswerAppendix && !answer.length && current.typeHint === 'judge') {
    const trailingJudge = /^(.*?[（(]\s*[）)])\s*(正确|错误|对|错)\s*[。．.]?$/.exec(questionText);
    if (trailingJudge) {
      questionText = cleanQuestionText(trailingJudge[1]);
      answer = /^(?:正确|对)$/.test(trailingJudge[2]) ? ['A'] : ['B'];
      current.answerSources.push('Word题干尾随判断答案');
      current.answerBoundarySource = current.answerBoundarySource || 'Word题干尾随判断答案';
      current.answerBoundaryConfidence = Math.max(Number(current.answerBoundaryConfidence) || 0, 0.99);
    }
  }

  // matchOptionLine 会先吃掉以 A 开头的整行；若 A 文本中仍包含 B.错误，
  // 在最终定型前再次拆成标准判断题两项。
  if (options.length >= 1) {
    const pair = splitInlineJudgePair(`${options[0].key}.${options[0].text}`);
    if (pair && pair.length === 2) {
      options.splice(0, options.length,
        { key: 'A', text: pair[0].value, images: unique(options[0].images || []) },
        { key: 'B', text: pair[1].value, images: [] }
      );
      current.answerSources.push('连写对错选项自动拆分');
    }
  }

  // PDF/Word 共用的最终结构修复：
  // A. 二氧化碳B. 干粉C. 泡沫 -> A/B/C 三个独立选项。
  // 放在 finalize 做末端兜底，避免不同文件格式在前置提取阶段表现不同。
  if (repairCollapsedChoiceOptions(options, answer, questionText, current.typeHint)) {
    current.answerSources.push('紧凑连写选项自动拆分');
  }
  if (documentFlags.wordAutoAnswerAppendix && options.length >= 3 && options[0] && options[0].key === 'A') {
    const bareABCD = /^(.+?)\s+B\s+(.+?)\s+C\s+(.+?)\s+D\s+(.+?)$/i.exec(normalizeOneLine(options[0].text || ''));
    if (bareABCD) {
      const imageByKey = new Map(options.map(item => [item.key, unique(item.images || [])]));
      options.splice(0, options.length,
        { key: 'A', text: cleanQuestionText(bareABCD[1]), images: imageByKey.get('A') || [] },
        { key: 'B', text: cleanQuestionText(bareABCD[2]), images: imageByKey.get('B') || [] },
        { key: 'C', text: cleanQuestionText(bareABCD[3]), images: imageByKey.get('C') || [] },
        { key: 'D', text: cleanQuestionText(bareABCD[4]), images: imageByKey.get('D') || [] }
      );
      current.answerSources.push('Word无标点同行选项最终重建');
    }
  }

  // 某些 Word 同行选项要到上一步的末端修复后才形成完整 A/B/C/D，
  // 因此再给“题干括号答案”一次机会（例如“测 4~20mA……（D）”）。
  if (documentFlags.wordAutoAnswerAppendix && !answer.length && options.length >= 2 && current.typeHint !== 'judge' && current.typeHint !== 'short') {
    const bracketMatches = [...questionText.matchAll(/[（(]\s*([A-L])\s*[）)]/ig)];
    if (bracketMatches.length === 1) {
      const letter = String(bracketMatches[0][1] || '').toUpperCase();
      if (options.some(item => item.key === letter)) {
        answer = [letter];
        questionText = questionText.replace(/（\s*[A-L]\s*）/i, '（ ）').replace(/\(\s*[A-L]\s*\)/i, '( )');
        current.answerSources.push('Word题干括号答案');
        current.answerBoundarySource = current.answerBoundarySource || 'Word题干括号答案';
        current.answerBoundaryConfidence = Math.max(Number(current.answerBoundaryConfidence) || 0, 0.99);
      }
    }
  }
  const optionTexts = options.map(item => normalizeOneLine(item.text));
  const truthValueForType = value => {
    const clean = normalizeOneLine(value || '').toUpperCase();
    if (/^(?:正确|对|是|√|✓|✔|TRUE|T)$/.test(clean)) return true;
    if (/^(?:错误|错|否|×|✕|✖|❌|FALSE|F)$/.test(clean)) return false;
    return null;
  };
  const judgeValues = optionTexts.map(truthValueForType);
  const looksJudge = options.length === 2 && judgeValues.includes(true) && judgeValues.includes(false);

  let type;
  // 题型标签只能由解析阶段记录的 typeHint 决定，绝不能在整段原文里搜索
  // “判断”二字；否则 D.不能判断、判断故障等普通选项会把选择题误判成判断题。
  const explicitJudgeLabel = current.typeHint === 'judge';
  const explicitShortLabel = current.typeHint === 'short';
  const explicitSingleLabel = current.typeHint === 'single';
  const explicitMultipleLabel = current.typeHint === 'multiple';
  const truthAnswerEvidence = current.rawTexts.some(raw => {
    const clean = normalizeOneLine(raw);
    const match = /(?:正确答案|标准答案|参考答案|答案|答)\s*(?:为|是)?\s*[:：]\s*(.+)$/.exec(clean);
    return Boolean(match && isJudgementAnswerValue(match[1]));
  });
  const hasProseAnswer = current.answerTextParts.length > 0 || Boolean(inlineShortAnswer);
  const strongShort = isStrongShortQuestion(questionText);

  // 最终题型以“实际选项结构 + 实际答案数量”为最高优先级：
  // 1 个字母答案只能是单选（判断题除外）；2 个及以上字母答案必为多选。
  // Word 标题写错时保留异常提示，但不再让错误标题覆盖真实答案结构。
  if (explicitShortLabel && !answer.length) {
    type = 'short';
  } else if (options.length >= 2 && answer.length >= 2) {
    type = 'multiple';
  } else if (options.length >= 2 && answer.length === 1) {
    type = looksJudge || truthAnswerEvidence ? 'judge' : 'single';
  } else if (truthAnswerEvidence || (looksJudge && answer.length <= 1)) {
    type = 'judge';
  } else if (options.length >= 2) {
    if (looksJudge || explicitJudgeLabel) type = looksJudge ? 'judge' : 'single';
    else if (explicitMultipleLabel) type = 'multiple';
    else type = 'single';
  } else if (options.length === 1) {
    const onlyTruth = truthValueForType(options[0].text);
    if (onlyTruth !== null || truthAnswerEvidence || explicitJudgeLabel) type = 'judge';
    else if (answer.length >= 2) type = 'multiple';
    else type = explicitMultipleLabel && !answer.length ? 'multiple' : 'single';
  } else if (explicitShortLabel || hasProseAnswer || strongShort) {
    type = 'short';
  } else if (explicitJudgeLabel) {
    type = 'judge';
  } else if (explicitMultipleLabel && answer.length >= 2) {
    type = 'multiple';
  } else {
    type = explicitSingleLabel ? 'single' : (current.typeHint || 'single');
    if (type === 'multiple' && answer.length === 1) type = 'single';
  }

  if (explicitMultipleLabel && answer.length === 1) {
    current.answerSources.push('原题标注多选但仅一项答案，按单选处理');
  }
  if (explicitJudgeLabel && options.length >= 2 && !looksJudge) {
    current.answerSources.push('原题标注判断但选项并非对错，按答案数量重判');
  }

  if (type === 'judge') {
    const truthValue = value => {
      const clean = normalizeOneLine(value || '').toUpperCase();
      if (/^(?:正确|对|是|√|✓|✔|TRUE|T)$/.test(clean)) return true;
      if (/^(?:错误|错|否|×|✕|✖|❌|FALSE|F)$/.test(clean)) return false;
      return null;
    };

    if (options.length === 1) {
      const only = options[0];
      const semantic = truthValue(only.text);
      options.splice(0, options.length,
        { key: 'A', text: '正确', images: [] },
        { key: 'B', text: '错误', images: [] }
      );
      if (!answer.length && semantic !== null) {
        answer.push(semantic ? 'A' : 'B');
        current.answerSources.push('单个对错行自动补齐');
      }
    } else if (options.length === 0) {
      options.push({ key: 'A', text: '正确', images: [] }, { key: 'B', text: '错误', images: [] });
    } else if (options.length === 2 && options.every(item => truthValue(item.text) !== null)) {
      const truthItem = options.find(item => truthValue(item.text) === true);
      const falseItem = options.find(item => truthValue(item.text) === false);
      // 两个完整对错选项但没有答案时不能猜测，交给异常检查。
      options.splice(0, options.length,
        { key: 'A', text: '正确', images: [] },
        { key: 'B', text: '错误', images: [] }
      );
      if (answer.length) {
        const selectedText = answer.map(key => {
          const original = [truthItem, falseItem].find(item => item && item.key === key);
          return original ? truthValue(original.text) : null;
        });
        if (selectedText.some(value => value !== null)) {
          answer.splice(0, answer.length, ...unique(selectedText.filter(value => value !== null).map(value => value ? 'A' : 'B')));
        }
      }
    }
  }

  let finalQuestionText = questionText;
  let finalAnswerText = cleanAnswerText(current.answerTextParts.length ? current.answerTextParts : [inlineShortAnswer]);
  const blankPlaceholderCount = (questionText.match(/[（(【\[]\s*(?:　|_|＿|\s)*[）)】\]]|_{2,}|＿{2,}/g) || []).length;
  const blankAnswers = current.displayTypeLabel === '填空题' ? splitFillAnswerText(finalAnswerText, blankPlaceholderCount) : [];
  if (type === 'short' && options.length) {
    if (!finalAnswerText) finalAnswerText = cleanAnswerText(options.map(item => `${item.key}. ${item.text}`));
    options.splice(0, options.length);
    answer.splice(0, answer.length);
    current.answerSources.push('简答题字母要点恢复为参考答案');
  }
  if (type === 'short') {
    const match = /(.*?[？?])(\s*)([^？?]{10,})$/.exec(finalQuestionText);
    if (match && !finalAnswerText) {
      const trailing = normalizeOneLine(match[3]);
      const looksAnswer = trailing && !/[（(]\s*[）)]/.test(trailing) &&
        /^(?:仪表|电路|设备|系统|控制|表示|说明|是|指|由|有|应|需|需要|主要|包括|如果|在|当|1[、.)）]|①|原因|措施|步骤|内容|要求|规定)/.test(trailing);
      if (looksAnswer) {
        finalQuestionText = cleanQuestionText(match[1]);
        finalAnswerText = cleanAnswerText([match[3]]);
        current.answerBoundarySource = current.answerBoundarySource || '问号后答案自动拆分';
        current.answerBoundaryConfidence = Math.max(Number(current.answerBoundaryConfidence) || 0, 0.88);
        current.answerSources.push('题干问号后答案');
      }
    }
  }

  const defaultDisplayTypeLabel = type === 'single' ? '单选题' : (type === 'multiple' ? '多选题' : (type === 'judge' ? '判断题' : '简答题'));
  let displayTypeLabel = defaultDisplayTypeLabel;
  if (current.displayTypeLabel) {
    const explicitMeta = typeMetaFromLabel(current.displayTypeLabel);
    if (explicitMeta.type === type) displayTypeLabel = explicitMeta.label;
  }

  const originalRawTexts = current.rawTexts.slice(0, 20);
  const combinedRawText = originalRawTexts.join(' ');
  const repairedCombinedRawText = repairKnownEngineeringNotation(combinedRawText);
  // 已经通过完整题干语义可靠修复时，原始 PDF 碎片中的替换字符不应再次把题目标成异常。
  const sourceRawTexts = sourceKind === 'pdf' && repairedCombinedRawText !== combinedRawText && !hasEncodingAnomaly(finalQuestionText)
    ? [finalQuestionText]
    : originalRawTexts;

  const result = {
    id: current.id,
    number: current.number,
    level: current.level || '',
    category: current.category || '未分类',
    chapter: current.chapter || '',
    type,
    displayTypeLabel,
    sourceTypeLabel: current.displayTypeLabel || '',
    typeHint: current.typeHint || '',
    typeEvidence: current.boundarySource || '',
    question: finalQuestionText,
    options,
    answer,
    answerText: finalAnswerText,
    blankAnswers,
    analysis: cleanAnalysisText(current.analysisParts),
    images: unique(current.images),
    answerImages: unique(current.answerImages || []),
    analysisImages: unique(current.analysisImages || []),
    boundarySource: current.boundarySource || '未知',
    answerSource: unique(current.answerSources).join('、'),
    answerBoundarySource: current.answerBoundarySource || '',
    answerBoundaryConfidence: current.answerBoundaryConfidence || 0,
    difficulty: current.difficulty || '',
    knowledgePoint: current.knowledgePoint || '',
    material: current.material || '',
    materialImages: unique(current.materialImages || []),
    inferredBoundary: current.inferredBoundary,
    source: {
      fileName: sourceName || '',
      kind: sourceKind || '',
      paragraphIndexes: unique(current.sourceParagraphs),
      rawTexts: sourceRawTexts
    }
  };

  const assisted = useLocalAI ? localAI.assistQuestion(result) : result;
  const duplicateRepaired = repairOptionDuplicates(assisted, documentFlags);
  const repaired = repairKnownConvertedDocxOptions(duplicateRepaired);
  const validation = validateQuestion(repaired);
  if (preservedBoundaryFailure) {
    return Object.assign(repaired, validation, {
      preservedBoundaryFailure: true,
      issues: unique([...(validation.issues || []), '题目边界已检测，但题干文字未完整识别']),
      confidence: Math.min(Number(validation.confidence) || 0, 0.2),
      status: 'error'
    });
  }
  return Object.assign(repaired, validation);
}

function createSourceMissingPlaceholder(section, number, sourceName) {
  const type = section.typeHint || 'single';
  const typeLabel = section.displayTypeLabel || (type === 'judge' ? '判断题' : (type === 'multiple' ? '多选题' : (type === 'short' ? '简答题' : '单选题')));
  return {
    id: createId('missing'),
    number: String(number),
    level: section.level || '',
    category: section.category || '未分类',
    chapter: section.chapter || '',
    type,
    displayTypeLabel: typeLabel,
    sourceTypeLabel: typeLabel,
    typeHint: type,
    typeEvidence: '章节声明缺失占位',
    question: `【原文缺少内容：${typeLabel}第 ${number} 题】`,
    options: [],
    answer: [],
    answerText: '',
    analysis: `章节标题“${section.heading}”声明应包含第 ${number} 题，但 Word 正文中没有找到对应题干、选项或答案。此记录仅用于数量对账，不参与正常练习。`,
    images: [],
    answerImages: [],
    analysisImages: [],
    boundarySource: '章节声明缺失占位',
    answerSource: '',
    answerBoundarySource: '',
    answerBoundaryConfidence: 0,
    inferredBoundary: false,
    sourceMissingPlaceholder: true,
    nonPractice: true,
    source: {
      fileName: sourceName || '',
      paragraphIndexes: section.paragraphIndex === undefined ? [] : [section.paragraphIndex],
      rawTexts: [section.heading || '']
    },
    issues: [`原文声明存在第 ${number} 题，但正文缺少该题内容`],
    confidence: 0,
    status: 'error'
  };
}

function reconcileDeclaredSections(questions = [], sections = [], sourceName = '') {
  const output = [];
  const missingItems = [];
  const extraItems = [];
  let cursor = 0;

  (sections || []).forEach(section => {
    const start = Math.max(cursor, Number(section.startQuestionIndex) || 0);
    const end = Math.max(start, Number(section.endQuestionIndex) || start);
    output.push(...questions.slice(cursor, start));
    const sectionQuestions = questions.slice(start, end);
    const numbers = sectionQuestions
      .map(item => Number(item.number))
      .filter(value => Number.isInteger(value) && value >= 1 && value <= 9999);
    const numberSet = new Set(numbers);
    const expectedCount = Number(section.expectedCount) || 0;
    const missingNumbers = [];
    if (expectedCount > 0 && numbers.some(value => value >= 1 && value <= expectedCount)) {
      for (let number = 1; number <= expectedCount; number += 1) {
        if (!numberSet.has(number)) missingNumbers.push(number);
      }
    }
    const augmented = sectionQuestions.slice();
    missingNumbers.forEach(number => {
      const placeholder = createSourceMissingPlaceholder(section, number, sourceName);
      let insertAt = augmented.findIndex(item => {
        const value = Number(item.number);
        return Number.isInteger(value) && value > number;
      });
      if (insertAt < 0) insertAt = augmented.length;
      augmented.splice(insertAt, 0, placeholder);
      missingItems.push({
        level: section.level || '',
        category: section.category || '',
        chapter: section.chapter || '',
        type: section.typeHint || '',
        number,
        heading: section.heading || '',
        message: `${section.level || ''}${section.category ? ` · ${section.category}` : ''} · ${section.heading || ''}：原文缺少第 ${number} 题正文`
      });
    });
    numbers.filter(value => expectedCount > 0 && value > expectedCount).forEach(number => {
      extraItems.push({
        level: section.level || '',
        category: section.category || '',
        type: section.typeHint || '',
        number,
        heading: section.heading || '',
        message: `${section.heading || ''}声明共 ${expectedCount} 题，但正文另有第 ${number} 题`
      });
    });
    output.push(...augmented);
    cursor = end;
  });
  output.push(...questions.slice(cursor));
  return { questions: output, missingItems, extraItems };
}

function analyzeNumbering(questions = []) {
  const issues = [];
  const lastByGroup = {};
  (questions || []).forEach((item, index) => {
    const number = Number(item.number);
    if (!Number.isInteger(number) || number < 1 || number > 9999) return;
    const group = [item.level || '', item.category || '', item.chapter || ''].join('|');
    const previous = lastByGroup[group];
    if (!previous || number === 1 || number <= previous.number) {
      lastByGroup[group] = { number, order: index + 1 };
      return;
    }
    const gap = number - previous.number - 1;
    if (gap > 0 && gap <= 50) {
      issues.push({
        group,
        afterOrder: previous.order,
        beforeOrder: index + 1,
        from: previous.number + 1,
        to: number - 1,
        count: gap,
        message: gap === 1 ? `题号可能缺少 ${previous.number + 1}` : `题号可能缺少 ${previous.number + 1}-${number - 1}`
      });
    }
    lastByGroup[group] = { number, order: index + 1 };
  });
  return {
    gapCount: issues.reduce((sum, item) => sum + item.count, 0),
    issues: issues.slice(0, 80)
  };
}

function markDuplicates(questions) {
  const firstBySignature = {};
  let duplicateCount = 0;
  questions.forEach(question => {
    const optionPart = (question.options || []).map(item => item.text).join('|');
    const signature = compactText(`${question.question}|${optionPart}`);
    if (signature.length < 8) return;
    if (firstBySignature[signature]) {
      question.duplicateOf = firstBySignature[signature].id;
      question.issues = unique([...(question.issues || []), `疑似与第 ${firstBySignature[signature].order || '?'} 题重复`]);
      question.status = question.status === 'error' ? 'error' : 'warning';
      question.confidence = Math.max(0, Number(((question.confidence || 1) - 0.18).toFixed(2)));
      duplicateCount += 1;
    } else {
      firstBySignature[signature] = question;
    }
  });
  return duplicateCount;
}

function isWorkingEmpty(current) {
  return Boolean(current) && !current.questionParts.length && !current.options.length && !current.answer.length && !current.answerTextParts.length && !current.analysisParts.length;
}

function simpleQuestionNumber(value = '') {
  const clean = normalizeOneLine(value || '');
  let match = /^\s*(?:第\s*)?(\d{1,4})\s*(?:题)?\s*[.、．:：)）-]/.exec(clean);
  if (match) return Number(match[1]);
  // 题库常见“1/39[单选题]”“1/17 判断题”“12 [简答题]”也都是强题号。
  // 材料块遇到这些边界必须结束，否则一次误触会吞掉后续整章题目。
  match = /^\s*(\d{1,4})\s*\/\s*\d{1,4}\s*(?:[\[【]?\s*(?:单选题|单项选择题|单选|多选题|多项选择题|多选|选择题|判断题|判断|简答题|问答题|实操题|论述题|填空题|计算题|画图题|绘图题|作图题|匹配题|配对题|排序题|顺序题|材料题|案例题|题)\s*[\]】]?)?/.exec(clean);
  if (match) return Number(match[1]);
  match = /^\s*(\d{1,4})\s*(?:[\[【]\s*)?(?:单选题|单项选择题|单选|多选题|多项选择题|多选|选择题|判断题|判断|简答题|问答题|实操题|论述题|填空题|计算题|画图题|绘图题|作图题|匹配题|配对题|排序题|顺序题|材料题|案例题)(?:\s*[\]】])?/.exec(clean);
  if (match) return Number(match[1]);
  match = /^\s*(\d{1,4})\s*[（(\[【]/.exec(clean);
  return match ? Number(match[1]) : 0;
}

function annotateMaterialParagraphs(sourceParagraphs = []) {
  const result = (sourceParagraphs || []).map(item => Object.assign({}, item));
  let activeMaterial = '';
  let activeMaterialImages = [];
  let collecting = false;
  let endNumber = 0;
  result.forEach(item => {
    const clean = normalizeOneLine(item.text || '');
    const explicitMaterialLabel = /^(?:材料|案例|背景资料)\s*[一二三四五六七八九十\d]*\s*[:：]/.test(clean) ||
      /^(?:材料|案例|背景资料)\s*[一二三四五六七八九十\d]+\s*$/.test(clean) ||
      (/^(?:材料|案例|背景资料)\s*$/.test(clean) && /(?:heading|标题|title)/i.test(item.style || ''));
    const materialInstruction = /^(?:阅读材料|阅读以下材料|根据以下材料|根据材料)(?:\s*[一二三四五六七八九十\d]+)?\s*(?:[:：]|，|。|$)/.test(clean) ||
      /^(?:阅读|根据).{0,20}(?:材料|案例).{0,20}(?:回答|完成|作答)/.test(clean);
    const materialStart = explicitMaterialLabel || materialInstruction;
    if (materialStart && !simpleQuestionNumber(clean)) {
      activeMaterial = clean.replace(/^(?:材料|案例|背景资料)\s*[:：]\s*/, '').trim();
      activeMaterialImages = unique((item.images || []).slice());
      collecting = true;
      const range = /(?:回答|完成|作答)(?:第)?\s*(\d{1,4})\s*(?:[-—–~～至到]|至)\s*(\d{1,4})\s*题/.exec(clean);
      endNumber = range ? Number(range[2]) : 0;
      item.materialOnly = true;
      return;
    }
    const typeHeading = descriptiveTypeHeading(clean);
    const categoryHeading = /^(?:第[一二三四五六七八九十\d]+(?:部分|章|节)|[一二三四五六七八九十]+[、.．]\s*[^\d])/.test(clean);
    if ((typeHeading || categoryHeading) && !collecting) {
      activeMaterial = '';
      activeMaterialImages = [];
      endNumber = 0;
      return;
    }
    const number = simpleQuestionNumber(clean);
    if (number) {
      if (endNumber && number > endNumber) {
        activeMaterial = '';
        activeMaterialImages = [];
        endNumber = 0;
      }
      collecting = false;
      if (activeMaterial) item.materialText = activeMaterial;
      if (activeMaterialImages.length) item.materialImages = activeMaterialImages.slice();
      return;
    }
    if (collecting && clean) {
      activeMaterial = normalizeText([activeMaterial, clean].filter(Boolean).join('\n'));
      activeMaterialImages = unique([...activeMaterialImages, ...(item.images || [])]);
      item.materialOnly = true;
      return;
    }
    if (activeMaterial) item.materialText = activeMaterial;
    if (activeMaterialImages.length) item.materialImages = activeMaterialImages.slice();
  });
  return result;
}
function parseCentralAnswerEntryText(value = '') {
  const clean = normalizeOneLine(value || '');
  const entries = [];
  const range = /^(\d{1,4})\s*(?:[-—–~～至到])\s*(\d{1,4})\s*[:：]?\s*([A-L√✓✔☑×✕✖☒❌TF对错正确错误是否\s,，、;；]+)$/i.exec(clean);
  if (range) {
    const start = Number(range[1]), end = Number(range[2]);
    const values = range[3].replace(/[\s,，、;；]+/g, '').match(/[A-L]|√|✓|✔|☑|×|✕|✖|☒|❌|T|F/g) || [];
    if (end >= start && values.length === end - start + 1) {
      values.forEach((answer, index) => entries.push({ number: start + index, value: answer }));
      return entries;
    }
  }
  const pairRe = /(\d{1,4})\s*[.、．:：)）-]?\s*(√|✓|✔|☑|×|✕|✖|☒|❌|正确|错误|对|错|是|否|[A-L](?:(?:\s*[,，、/\\|]\s*|(?=[A-L]))[A-L])*)/ig;
  let match;
  while ((match = pairRe.exec(clean))) entries.push({ number: Number(match[1]), value: match[2] });
  if (entries.length) return entries;
  // 简答/填空/计算等主观题的文末答案常写成“1. 文本答案”，答案区已由
  // 明确标题锁定，因此这里可以比正文题号识别更积极，但仍要求有分隔符。
  const textEntry = /^(?:第\s*)?(\d{1,4})\s*(?:题)?\s*[.、．:：)）-]\s*(.+)$/.exec(clean);
  if (textEntry && textEntry[2].trim()) entries.push({ number: Number(textEntry[1]), value: textEntry[2].trim() });
  return entries;
}

function answerAppendixTypeLabel(value = '') {
  const clean = normalizeOneLine(value || '');
  if (/^(?:选择题|单选题|单项选择题)$/.test(clean)) return '选择题';
  if (/^(?:多选题|多项选择题|不定项选择题)$/.test(clean)) return /不定项/.test(clean) ? '不定项选择题' : '多选题';
  if (/^(?:判断题|对错题)$/.test(clean)) return '判断题';
  if (/^(?:填空题)$/.test(clean)) return '填空题';
  if (/^(?:简答题|问答题)$/.test(clean)) return '简答题';
  if (/^(?:计算题)$/.test(clean)) return '计算题';
  return '';
}

function extractWordAutoListAnswerAppendix(paragraphs = []) {
  let headingIndex = -1;
  for (let index = 0; index < paragraphs.length; index += 1) {
    const clean = normalizeOneLine(paragraphs[index].text || '');
    // “控制系统参考答案”这类教师版试卷，答案区不是“1.B”文本，而是 Word
    // 自动编号列表：选择题 -> B/B/A/...，填空题 -> 文本，判断题 -> √/×。
    // 必须同时看到后续题型标题和自动编号答案，才启用这条专用解析，避免误伤正文。
    if (!/^.{1,24}(?:参考答案|答案汇总|答案表)\s*[:：]?$/.test(clean) || /^(?:参考答案|标准答案|正确答案)\s*[:：]?$/.test(clean)) continue;
    let typeHeadingCount = 0;
    let autoAnswerCount = 0;
    for (let look = index + 1; look < Math.min(paragraphs.length, index + 24); look += 1) {
      const next = paragraphs[look];
      const label = answerAppendixTypeLabel(next.text || '');
      if (label) { typeHeadingCount += 1; continue; }
      const text = normalizeOneLine(next.text || '');
      if (Number(next.listOrdinal || 0) > 0 && text && text.length <= 120) autoAnswerCount += 1;
    }
    if (typeHeadingCount >= 2 && autoAnswerCount >= 4) { headingIndex = index; break; }
  }
  if (headingIndex < 0) return null;

  const removed = new Set();
  const entries = [];
  let currentTypeLabel = '';
  let shortTopNumId = '';
  let shortEntry = null;

  function flushShort() {
    if (!shortEntry) return;
    const value = cleanAnswerText(shortEntry.parts.join('\n'));
    if (value) entries.push({
      number: shortEntry.number,
      value,
      typeLabel: currentTypeLabel || '简答题',
      sequentialOnly: true,
      appendixSource: 'Word自动编号答案附录'
    });
    shortEntry = null;
  }

  removed.add(paragraphs[headingIndex].index);
  for (let index = headingIndex + 1; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index];
    const clean = normalizeOneLine(paragraph.text || '');
    if (!clean) { removed.add(paragraph.index); continue; }
    const typeLabel = answerAppendixTypeLabel(clean);
    if (typeLabel) {
      flushShort();
      currentTypeLabel = typeLabel;
      shortTopNumId = '';
      removed.add(paragraph.index);
      continue;
    }

    // 答案附录已经位于文末；所有后续段落都属于答案区。若尚未识别题型，
    // 只删除标题后的说明，不制造题目。
    removed.add(paragraph.index);
    if (!currentTypeLabel) continue;

    const ordinal = Number(paragraph.listOrdinal || 0);
    const numId = String(paragraph.numId || '');
    if (currentTypeLabel === '简答题' || currentTypeLabel === '计算题') {
      if (ordinal > 0) {
        if (!shortTopNumId) shortTopNumId = numId;
        if (numId === shortTopNumId) {
          flushShort();
          shortEntry = { number: ordinal, parts: [clean] };
        } else if (shortEntry) {
          shortEntry.parts.push(clean);
        }
      } else if (shortEntry) {
        shortEntry.parts.push(clean);
      }
      continue;
    }

    if (ordinal <= 0) continue;
    entries.push({
      number: ordinal,
      value: clean,
      typeLabel: currentTypeLabel,
      sequentialOnly: true,
      appendixSource: 'Word自动编号答案附录'
    });
  }
  flushShort();
  return { entries, removed, headingIndex };
}

function extractCentralAnswerKeys(sourceParagraphs = []) {
  const paragraphs = (sourceParagraphs || []).map(item => Object.assign({}, item));
  const entries = [];
  const removed = new Set();
  let active = false;
  let currentTypeLabel = '';

  const wordAutoAppendix = extractWordAutoListAnswerAppendix(paragraphs);
  if (wordAutoAppendix) {
    wordAutoAppendix.entries.forEach(item => entries.push(item));
    wordAutoAppendix.removed.forEach(index => removed.add(index));
  }

  function centralHeadingKind(value = '') {
    const clean = normalizeOneLine(value || '');
    if (/^(?:答案汇总|答案表|参考答案汇总|选择题答案|单选题答案|多选题答案|不定项选择题答案|判断题答案|填空题答案|简答题答案|问答题答案|计算题答案|匹配题答案|配对题答案|排序题答案|顺序题答案)\s*[:：]?$/.test(clean)) return 'explicit';
    if (/^(?:参考答案|标准答案|正确答案)\s*[:：]?$/.test(clean)) return 'generic';
    return '';
  }

  function isObjectiveCentralValue(value = '') {
    const clean = normalizeOneLine(value || '');
    if (!clean) return false;
    const parsed = parseCentralAnswerEntryText(clean);
    if (!parsed.length) return false;
    return parsed.every(item => {
      const answer = normalizeOneLine(item.value || '');
      return /^(?:[A-L](?:(?:[,，、/\|\s]?)[A-L])*|√|✓|✔|☑|×|✕|✖|☒|❌|T|F|对|错|正确|错误|是|否)$/i.test(answer);
    });
  }

  function hasStrongGenericCentralEvidence(index) {
    // “参考答案”在很多题库中只是简答题的逐题答案标签。泛化标题只接受
    // 范围答案、同一行多个编号答案，或连续至少 3 条短客观答案。
    let objectiveRows = 0;
    let distinctNumbers = new Set();
    for (let look = index + 1; look < Math.min(paragraphs.length, index + 14); look += 1) {
      if (removed.has(paragraphs[look].index)) continue;
      const next = normalizeOneLine(paragraphs[look].text || '');
      if (!next) continue;
      if (centralHeadingKind(next)) return false;
      if (descriptiveTypeHeading(next)) continue;
      if (/^(?:题目|题干|问题)\s*[:：]/.test(next)) return false;
      const parsed = parseCentralAnswerEntryText(next);
      if (!parsed.length) {
        if (next.length > 12 && !/^(?:第\s*\d+\s*题)?\s*[A-L√✓✔☑×✕✖☒❌TF对错正确错误是否\s,，、;；-]+$/i.test(next)) return false;
        continue;
      }
      if (parsed.length >= 2 && isObjectiveCentralValue(next)) return true;
      if (isObjectiveCentralValue(next)) {
        objectiveRows += 1;
        parsed.forEach(item => distinctNumbers.add(Number(item.number)));
        if (objectiveRows >= 3 && distinctNumbers.size >= 3) return true;
      } else return false;
    }
    return false;
  }

  for (let index = 0; index < paragraphs.length; index += 1) {
    if (removed.has(paragraphs[index].index)) continue;
    const clean = normalizeOneLine(paragraphs[index].text || '');
    const headingKind = centralHeadingKind(clean);
    if (!active && headingKind) {
      let evidence = 0;
      if (headingKind === 'generic') evidence = hasStrongGenericCentralEvidence(index) ? 1 : 0;
      else {
        for (let look = index + 1; look < Math.min(paragraphs.length, index + 12); look += 1) {
          if (removed.has(paragraphs[look].index)) continue;
          const next = normalizeOneLine(paragraphs[look].text || '');
          if (descriptiveTypeHeading(next)) continue;
          if (parseCentralAnswerEntryText(next).length) evidence += 1;
        }
      }
      if (evidence >= 1) {
        active = true;
        removed.add(paragraphs[index].index);
        if (/判断/.test(clean)) currentTypeLabel = '判断题';
        else if (/不定项/.test(clean)) currentTypeLabel = '不定项选择题';
        else if (/单选/.test(clean)) currentTypeLabel = '单选题';
        else if (/多选/.test(clean)) currentTypeLabel = '多选题';
        else if (/选择/.test(clean)) currentTypeLabel = '选择题';
        else if (/填空/.test(clean)) currentTypeLabel = '填空题';
        else if (/简答|问答/.test(clean)) currentTypeLabel = '简答题';
        else if (/计算/.test(clean)) currentTypeLabel = '计算题';
        else if (/匹配|配对/.test(clean)) currentTypeLabel = '匹配题';
        else if (/排序|顺序/.test(clean)) currentTypeLabel = '排序题';
        continue;
      }
    }
    if (!active) continue;
    const typeHeading = descriptiveTypeHeading(clean);
    if (typeHeading) {
      currentTypeLabel = typeHeading.label;
      removed.add(paragraphs[index].index);
      continue;
    }
    const parsed = parseCentralAnswerEntryText(clean);
    if (parsed.length) {
      parsed.forEach(item => entries.push({ ...item, typeLabel: currentTypeLabel }));
      removed.add(paragraphs[index].index);
      continue;
    }
    if (/^(?:第[一二三四五六七八九十\d]+(?:部分|章|节)|[一二三四五六七八九十]+[、.．])/.test(clean)) {
      active = false;
      currentTypeLabel = '';
    }
  }
  return {
    paragraphs: paragraphs.filter(item => !removed.has(item.index)),
    entries,
    removedCount: removed.size,
    sequentialAppendix: Boolean(wordAutoAppendix)
  };
}

function centralAnswerTypeMatches(question, typeLabel = '', strictShortLabel = false) {
  if (!typeLabel) return true;
  if (question.displayTypeLabel === typeLabel || question.sourceTypeLabel === typeLabel) return true;
  if (typeLabel === '选择题') return ['single', 'multiple'].includes(question.type);
  // 仅 Word 自动编号答案附录需要严格区分填空/简答/计算；普通集中答案继续沿用旧逻辑。
  if (strictShortLabel && /^(?:填空题|简答题|问答题|计算题)$/.test(typeLabel)) {
    const hasExplicitShortLabel = /^(?:填空题|简答题|问答题|计算题)$/.test(question.displayTypeLabel || question.sourceTypeLabel || '');
    if (hasExplicitShortLabel) return false;
  }
  const meta = typeMetaFromLabel(typeLabel);
  return question.type === meta.type;
}

function canCentralAnswerReplace(question, sequentialOnly = false) {
  if ((question.answer || []).length) return false;
  if (!question.answerText) return true;
  if (!sequentialOnly) return false;
  // 文末正式答案允许覆盖“无标签智能识别”的低置信度主观答案，但绝不覆盖
  // 显式答案、样式答案或用户后续编辑产生的内容。
  return /^(?:无答案标签智能识别|本地AI辅助)/.test(String(question.answerBoundarySource || ''));
}

function applyCentralAnswerKeys(questions = [], entries = []) {
  let applied = 0;
  const used = new Set();
  entries.forEach(entry => {
    const number = String(entry.number || '');
    if (!number) return;
    let candidates = questions.map((question, index) => ({ question, index }))
      .filter(item => canCentralAnswerReplace(item.question, Boolean(entry.sequentialOnly)));

    if (entry.sequentialOnly) {
      candidates = candidates.filter(item => centralAnswerTypeMatches(item.question, entry.typeLabel, true));
    } else {
      candidates = candidates.filter(item => String(item.question.number || '') === number);
      if (entry.typeLabel) {
        const typed = candidates.filter(item => centralAnswerTypeMatches(item.question, entry.typeLabel));
        if (typed.length) candidates = typed;
      }
    }

    const candidate = candidates.find(item => !used.has(item.index));
    if (!candidate) return;
    const question = candidate.question;
    const subjective = /(?:填空题|简答题|问答题|计算题|匹配题|配对题|排序题|顺序题)/.test(entry.typeLabel || '') ||
      (question.type === 'short' && !/(?:选择题|单选题|多选题|不定项选择题|判断题)/.test(entry.typeLabel || ''));
    const letters = parseAnswerLetters(entry.value);

    if (subjective) {
      question.answer = [];
      question.answerText = cleanAnswerText(entry.value);
    } else if (isJudgementAnswerValue(entry.value)) {
      question.type = 'judge';
      question.displayTypeLabel = '判断题';
      question.answer = letters;
      question.answerText = '';
    } else if (letters.length) {
      question.answer = letters;
      question.answerText = '';
      if (letters.length > 1 && question.displayTypeLabel !== '不定项选择题') {
        question.type = 'multiple';
        if (!question.sourceTypeLabel) question.displayTypeLabel = '多选题';
      }
    } else return;

    question.answerSource = [question.answerSource, entry.appendixSource || '文末集中答案回填'].filter(Boolean).join('、');
    question.answerBoundarySource = entry.appendixSource || question.answerBoundarySource || '文末集中答案';
    question.answerBoundaryConfidence = Math.max(Number(question.answerBoundaryConfidence) || 0, 0.99);
    Object.assign(question, validateQuestion(question));
    used.add(candidate.index);
    applied += 1;
  });
  return applied;
}

function splitFillAnswerText(value = '', expected = 0) {
  const clean = cleanAnswerText(value || '');
  if (!clean || expected < 2) return [];
  const parts = clean.split(/\s*(?:；|;|、|\||\/|，(?=[^，]{1,40}(?:，|$)))\s*/).map(item => item.trim()).filter(Boolean);
  return parts.length === expected ? parts : [];
}

function parseParagraphsDetailed(sourceParagraphs, options = {}) {
  const sourceName = options.sourceName || '';
  const useLocalAI = Boolean(options.useLocalAI);
  const sourceKind = String(options.sourceKind || '').toLowerCase();
  const parserProfile = String(options.parserProfile || 'strict').toLowerCase();
  const relaxedPdfBoundaries = sourceKind === 'pdf' && parserProfile !== 'strict';
  const centralAnswers = extractCentralAnswerKeys(sourceParagraphs);
  const documentFlags = { wordAutoAnswerAppendix: sourceKind === 'docx' && Boolean(centralAnswers.sequentialAppendix) };
  const materialAnnotated = annotateMaterialParagraphs(centralAnswers.paragraphs);
  const splitStarts = mergeSplitQuestionStarts(materialAnnotated);
  const sanitized = sanitizeParagraphs(splitStarts.paragraphs);
  const detachedOptionImages = mergeDetachedOptionImages(sanitized.paragraphs);
  const paragraphs = detachedOptionImages.paragraphs;
  const questions = [];
  const context = { level: '', category: '未分类', chapter: '', typeHint: '', displayTypeLabel: '' };
  const declaredSections = [];
  let activeDeclaredSection = null;
  const diagnostics = {
    sourceParagraphCount: sourceParagraphs.length,
    effectiveParagraphCount: paragraphs.length,
    removedNoiseCount: sanitized.removedNoiseCount,
    detachedOptionImageRepairCount: detachedOptionImages.repairedCount,
    documentTitleNoiseCount: 0,
    splitQuestionStartRepairCount: splitStarts.repairedCount,
    noPunctuationBoundaryRepairCount: 0,
    sourceDeclaredSectionCount: 0,
    sourceDeclaredMissingCount: 0,
    sourceDeclaredMissingItems: [],
    sourceDeclaredExtraCount: 0,
    sourceDeclaredExtraItems: [],
    inferredBoundaryCount: 0,
    inlineAnswerCount: 0,
    embeddedFillAnswerCount: 0,
    compactChoiceRepairCount: 0,
    duplicateCount: 0,
    unlabeledAnswerCount: 0,
    detectedBoundaryCount: 0,
    explicitBoundaryCount: 0,
    preservedFailedBoundaryCount: 0,
    discardedBoundaryCount: 0,
    assignedParagraphCount: 0,
    unassignedParagraphCount: 0,
    unassignedFragments: [],
    discardedFragments: [],
    numberingGapCount: 0,
    numberingIssues: [],
    localAIEnabled: useLocalAI,
    localAIModelVersion: useLocalAI ? localAI.MODEL_VERSION : '',
    localAIAppliedCount: 0,
    sourceKind,
    parserProfile,
    centralAnswerEntryCount: centralAnswers.entries.length,
    centralAnswerAppliedCount: 0,
    centralAnswerParagraphCount: centralAnswers.removedCount
  };
  let current = null;
  let mode = 'question';
  let pendingLeadingAnswer = null;
  let sectionQuestionOrdinal = 0;
  const claimedParagraphIndexes = new Set();
  const structuralParagraphIndexes = new Set();

  function closeDeclaredSection() {
    if (!activeDeclaredSection) return;
    activeDeclaredSection.endQuestionIndex = questions.length;
    declaredSections.push(activeDeclaredSection);
    activeDeclaredSection = null;
  }

  function finish() {
    const working = current;
    const question = finalize(working, sourceName, useLocalAI, sourceKind, documentFlags);
    if (question) {
      questions.push(question);
      if (question.preservedBoundaryFailure) diagnostics.preservedFailedBoundaryCount += 1;
    } else if (working && (working.boundarySource || working.rawTexts.length || working.images.length || working.answerImages.length || working.analysisImages.length)) {
      diagnostics.discardedBoundaryCount += 1;
      if (diagnostics.discardedFragments.length < 80) {
        diagnostics.discardedFragments.push({
          number: working.number || '',
          boundarySource: working.boundarySource || '未知',
          rawTexts: (working.rawTexts || []).slice(0, 8),
          imageCount: (working.images || []).length + (working.answerImages || []).length + (working.analysisImages || []).length
        });
      }
    }
    current = null;
    mode = 'question';
  }

  function ensureCurrent(boundarySource = '') {
    if (!current) current = createWorkingQuestion('', context, boundarySource);
    return current;
  }

  function applyPendingLeadingAnswer(item) {
    if (!item || !pendingLeadingAnswer) return;
    const pending = pendingLeadingAnswer;
    pendingLeadingAnswer = null;
    if (pending.truth) item.typeHint = 'judge';
    if (pending.letters && pending.letters.length) item.answer.push(...pending.letters);
    if (pending.text && !(pending.letters || []).length) {
      item.typeHint = 'short';
      pushText(item.answerTextParts, pending.text);
    }
    item.answerSources.push('题目前置答案');
    item.answerBoundarySource = '题目前置答案';
    item.answerBoundaryConfidence = 0.9;
  }

  function touch(item, paragraph, imageTarget = 'question') {
    const sourceIndexes = Array.isArray(paragraph.sourceIndexes) && paragraph.sourceIndexes.length
      ? paragraph.sourceIndexes
      : [paragraph.index];
    sourceIndexes.forEach(index => {
      claimedParagraphIndexes.add(index);
      if (!item.sourceParagraphs.includes(index)) item.sourceParagraphs.push(index);
    });
    if (paragraph.materialText && !item.material) item.material = normalizeText(paragraph.materialText);
    if (paragraph.materialImages && paragraph.materialImages.length) item.materialImages.push(...paragraph.materialImages);
    const paragraphImages = paragraph.images || [];
    if (imageTarget === 'question') item.images.push(...paragraphImages);
    else if (imageTarget === 'answer') item.answerImages.push(...paragraphImages);
    else if (imageTarget === 'analysis') item.analysisImages.push(...paragraphImages);
    const raw = paragraph.text ? normalizeText(paragraph.text) : '';
    if (raw && item.rawTexts[item.rawTexts.length - 1] !== raw) item.rawTexts.push(raw);
  }

  function applyStyledOptionAnswer(item, key, value, paragraph) {
    const optionText = normalizeOneLine(value || '');
    const styleAnswer = (paragraph && paragraph.styleAnswerDetails || []).some(detail => {
      if (!detail || !['color', 'highlight'].includes(detail.reason)) return false;
      const styled = normalizeOneLine(detail.text || '').replace(/^\s*[A-L]\s*[.、．:：)）]\s*/i, '');
      return Boolean(styled && optionText && (styled === optionText || styled.includes(optionText) || optionText.includes(styled)));
    });
    if (!styleAnswer || item.answer.includes(key)) return;
    item.answer.push(key);
    item.answerSources.push('Word 样式标注答案');
    item.answerBoundarySource = item.answerBoundarySource || 'Word 红字/高亮答案';
    item.answerBoundaryConfidence = Math.max(Number(item.answerBoundaryConfidence) || 0, 0.9);
  }

  function consumeToken(token, paragraph) {
    if (!token || (!token.value && token.type === 'text')) return;
    const item = ensureCurrent('智能推断边界');
    let imageTarget = 'question';
    if (token.type === 'option') imageTarget = false;
    else if (token.type === 'analysis') imageTarget = 'analysis';
    else if (token.type === 'answer' || token.type === 'reference') imageTarget = 'answer';
    else if (mode === 'analysis') imageTarget = 'analysis';
    else if (mode === 'reference' || mode === 'answer') imageTarget = 'answer';
    touch(item, paragraph, imageTarget);

    if (token.type === 'option') {
      mode = 'option';
      addOption(item, token.key, token.value, paragraph.images || []);
      // 教师版 Word 常用红字/高亮标出正确选项。仅在选项正文与强样式片段明确重合时采用。
      applyStyledOptionAnswer(item, token.key, token.value, paragraph);
      return;
    }
    if (token.type === 'answer') {
      item.answerBoundarySource = item.answerBoundarySource || '显式答案标签';
      item.answerBoundaryConfidence = 1;
      const truthAnswer = isJudgementAnswerValue(token.value);
      const letters = parseAnswerLetters(token.value);
      if (truthAnswer) {
        mode = 'answer';
        item.typeHint = 'judge';
        item.answer.push(...letters);
        if (letters.length) item.answerSources.push('判断题答案行');
      } else if (letters.length && (item.options.length || item.typeHint !== 'short')) {
        mode = 'answer';
        item.answer.push(...letters);
        item.answerSources.push('答案行');
      } else if (item.options.length && item.typeHint !== 'short') {
        mode = 'analysis';
        if (token.value) pushText(item.analysisParts, token.value);
        item.answerSources.push('无字母答案说明');
      } else {
        mode = 'reference';
        item.typeHint = 'short';
        if (token.value) pushText(item.answerTextParts, token.value);
        item.answerSources.push('文本答案行');
      }
      return;
    }
    if (token.type === 'reference') {
      item.answerBoundarySource = item.answerBoundarySource || '显式参考答案标签';
      item.answerBoundaryConfidence = 1;
      const truthAnswer = isJudgementAnswerValue(token.value);
      const letters = parseAnswerLetters(token.value);
      const questionText = cleanQuestionText(item.questionParts);
      const strongShort = item.typeHint === 'short' || isStrongShortQuestion(questionText);
      if (truthAnswer) {
        mode = 'answer';
        item.typeHint = 'judge';
        item.answer.push(...letters);
        if (letters.length) item.answerSources.push('判断题参考答案行');
      } else if (letters.length && (item.options.length || ['single', 'multiple', 'judge'].includes(item.typeHint) || !strongShort)) {
        mode = 'answer';
        item.answer.push(...letters);
        item.answerSources.push('参考答案行');
      } else if (item.options.length && item.typeHint !== 'short' && !strongShort) {
        mode = 'analysis';
        if (token.value) pushText(item.analysisParts, token.value);
        item.answerSources.push('无字母参考答案说明');
      } else {
        mode = 'reference';
        item.typeHint = 'short';
        if (token.value) pushText(item.answerTextParts, token.value);
        item.answerSources.push('文本参考答案');
      }
      return;
    }
    if (token.type === 'analysis') {
      mode = 'analysis';
      pushText(item.analysisParts, token.value);
      return;
    }

    if (mode === 'option' && item.options.length) {
      const last = item.options[item.options.length - 1];
      pushText(last.parts, token.value);
    } else if (mode === 'answer') {
      const letters = parseAnswerLetters(token.value);
      if (letters.length) {
        item.answer.push(...letters);
        item.answerSources.push('答案续行');
      } else if (item.typeHint === 'short' || !item.options.length) {
        pushText(item.answerTextParts, token.value);
      } else {
        pushText(item.analysisParts, token.value);
        mode = 'analysis';
      }
    } else if (mode === 'reference') {
      pushText(item.answerTextParts, token.value);
    } else if (mode === 'analysis') {
      pushText(item.analysisParts, token.value);
    } else {
      pushText(item.questionParts, token.value);
    }
  }

  paragraphs.forEach(paragraph => {
    const text = normalizeText(paragraph.text || '');
    if (paragraph.materialOnly) {
      const indexes = Array.isArray(paragraph.sourceIndexes) && paragraph.sourceIndexes.length ? paragraph.sourceIndexes : [paragraph.index];
      indexes.forEach(index => structuralParagraphIndexes.add(index));
      return;
    }
    if (!text && !(paragraph.images || []).length) return;

    if (current && ['reference', 'answer', 'analysis'].includes(mode) && /^\d{1,4}$/.test(normalizeOneLine(text))) {
      diagnostics.removedNoiseCount += 1;
      structuralParagraphIndexes.add(paragraph.index);
      return;
    }

    const metaMatch = /^(知识点|考点|分类|章节|难度)\s*[:：]\s*(.+)$/.exec(normalizeOneLine(text));
    if (metaMatch) {
      const key = metaMatch[1], value = metaMatch[2].trim();
      if (current) {
        touch(current, paragraph, false);
        if (key === '难度') current.difficulty = value;
        else if (key === '章节') current.chapter = value;
        else if (key === '分类') current.category = value;
        else {
          current.knowledgePoint = value;
          if (!current.category || current.category === '未分类') current.category = value;
        }
      } else {
        structuralParagraphIndexes.add(paragraph.index);
        if (key === '章节') context.chapter = value;
        else if (key === '分类' || key === '知识点' || key === '考点') context.category = value;
      }
      return;
    }

    // 支持“【答案】C / 答案：C”写在题目前。只有当前没有题目时才暂存到下一道题，
    // 避免把普通题目的答案行错绑到后题。
    const leadingAnswerLine = /^\s*(?:【\s*)?(正确答案|标准答案|参考答案|答案|答)(?:\s*】)?\s*(?:为|是)?\s*[:：]?\s*(.+)\s*$/.exec(normalizeOneLine(text));
    if (!current && leadingAnswerLine) {
      const value = leadingAnswerLine[2] || '';
      const letters = parseAnswerLetters(value);
      pendingLeadingAnswer = { letters, text: letters.length ? '' : cleanAnswerText(value), truth: isJudgementAnswerValue(value) };
      structuralParagraphIndexes.add(paragraph.index);
      return;
    }

    // 选项、答案和解析标签拥有最高优先级，不能先被简答题续行逻辑吞并。
    if (/^(?:选项|正确答案|标准答案|参考答案|答案|答|答案解析|试题解析|解析|说明)\s*(?:为|是)?\s*[:：]/.test(text)) {
      splitInline(text).forEach(token => consumeToken(token, paragraph));
      return;
    }

    const earlyHeader = classifyHeader(text, paragraph.style);
    const forcedSectionBoundary = !earlyHeader && shouldForceSectionQuestionStart(text, context, current, paragraph, sourceKind);
    const continuationFlags = { enhancedNumberedAnswerContinuation: sourceKind === 'pdf' || documentFlags.wordAutoAnswerAppendix };
    if (!forcedSectionBoundary && shouldTreatAsAnswerContinuation(text, current, mode, context, paragraph, continuationFlags) && !(sourceKind === 'pdf' && earlyHeader)) {
      consumeToken({ type: 'text', value: text }, paragraph);
      return;
    }

    if (isLikelyDocumentTitle(text, sourceName, paragraph.style)) {
      structuralParagraphIndexes.add(paragraph.index);
      diagnostics.documentTitleNoiseCount += 1;
      if (current && (current.questionParts.length || current.options.length || current.answer.length || current.answerTextParts.length)) finish();
      return;
    }

    const header = earlyHeader || classifyHeader(text, paragraph.style);
    if (header) {
      structuralParagraphIndexes.add(paragraph.index);
      if (current && (current.questionParts.length || current.options.length || current.answerTextParts.length)) finish();
      const declaration = header.kind === 'type' ? declaredTypeSection(text) : null;
      if (header.kind === 'level') {
        closeDeclaredSection();
        context.level = header.value;
        context.typeHint = '';
        context.displayTypeLabel = '';
      }
      if (header.kind === 'type') {
        closeDeclaredSection();
        sectionQuestionOrdinal = 0;
        context.typeHint = header.value;
        context.displayTypeLabel = header.label || (header.value === 'single' ? '单选题' : (header.value === 'multiple' ? '多选题' : (header.value === 'judge' ? '判断题' : '简答题')));
        if (declaration) {
          activeDeclaredSection = {
            id: `declared_${declaredSections.length + 1}_${paragraph.index}`,
            level: context.level || '',
            category: context.category || '',
            chapter: context.chapter || '',
            typeHint: declaration.typeHint,
            displayTypeLabel: declaration.displayTypeLabel || context.displayTypeLabel,
            expectedCount: declaration.expectedCount,
            heading: declaration.heading,
            paragraphIndex: paragraph.index,
            startQuestionIndex: questions.length,
            endQuestionIndex: questions.length
          };
        }
      }
      if (header.kind === 'category') {
        closeDeclaredSection();
        context.category = header.value;
        context.chapter = header.value;
        // “一、专业知识”这类顶层章节表示进入新的大类，应结束上一题型；
        // “（一）控制阀”等子分类则继续继承当前“画图题/计算题”等题型大类。
        const topLevelCategory = /^[一二三四五六七八九十]+[、.．]\s*\S+/.test(normalizeOneLine(text)) || /^第[一二三四五六七八九十\d]+(?:部分|章|节)/.test(normalizeOneLine(text));
        if (topLevelCategory) {
          context.typeHint = '';
          context.displayTypeLabel = '';
        }
      }
      return;
    }

    if (forcedSectionBoundary) {
      finish();
      sectionQuestionOrdinal += 1;
      current = createWorkingQuestion(String(sectionQuestionOrdinal), context, '章节逐题行');
      applyPendingLeadingAnswer(current);
      diagnostics.detectedBoundaryCount += 1;
      diagnostics.explicitBoundaryCount += 1;
      touch(current, paragraph);
      const styledFill = context.displayTypeLabel === '填空题' ? styledFillFromParagraph(text, paragraph) : { question: text, answers: [] };
      if (styledFill.answers.length) {
        current.typeHint = 'short'; current.displayTypeLabel = '填空题';
        pushText(current.questionParts, styledFill.question);
        pushText(current.answerTextParts, styledFill.answers.join('；'));
        current.answerBoundarySource = 'Word文字样式填空答案'; current.answerBoundaryConfidence = 0.97;
        current.answerSources.push('下划线/高亮/答案色文字');
        diagnostics.embeddedFillAnswerCount += 1;
        return;
      }
      const compactChoice = isCompactChoiceLine(text);
      const embeddedFill = context.displayTypeLabel === '填空题' && hasEmbeddedFillAnswer(text);
      const cleaned = consumeInlineAnswer(current, text, true);
      splitInline(cleaned).forEach(token => consumeToken(token, paragraph));
      if (compactChoice) diagnostics.compactChoiceRepairCount += 1;
      if (embeddedFill) diagnostics.embeddedFillAnswerCount += 1;
      if (current.answer.length) diagnostics.inlineAnswerCount += 1;
      return;
    }

    const autoOptionOrdinal = Number(paragraph.listOrdinal || 0);
    const canUseAutoOption = current && !isComplete(current) && paragraph.numId && paragraph.numId !== '0' &&
      autoOptionOrdinal >= 1 && autoOptionOrdinal <= 8 && current.questionParts.length &&
      current.typeHint !== 'short' && !isStrongQuestionCue(text);
    if (canUseAutoOption) {
      const key = String.fromCharCode('A'.charCodeAt(0) + autoOptionOrdinal - 1);
      touch(current, paragraph);
      const tokens = splitInline(`${key}. ${text}`);
      tokens.forEach(token => consumeToken(token, paragraph));
      return;
    }

    // 某些 Word 题库会把题型只写在上一题/上一段中，下一题又省略题号后的标点，
    // 例如“38更换MTL系列的安全栅时……”。此时章节上下文本身没有 typeHint，
    // 但上一题已经由答案识别为判断题。仅在无标点题号候选上继承当前题型，
    // 避免把简答题答案中的普通编号条目误切成新题。
    const noPunctuationCandidate = NO_PUNCT_NUMBER_RE.test(normalizeOneLine(text));
    const startContext = noPunctuationCandidate && current && !context.typeHint && current.typeHint
      ? Object.assign({}, context, { typeHint: current.typeHint })
      : context;
    let start = parseQuestionStart(text, startContext, paragraph, sourceKind);
    // 已有“27 [判断题]”这类强题号+题型边界、但题干尚为空时，下一行优先属于本题。
    // 弱“无标点题号”只有恰好等于下一题号时才允许抢占边界。
    // 例如“475手持通讯器……”中的 475 是仪表型号，不应拆成第 475 题。
    if (start && start.boundarySource === '无标点题号' && current && current.questionParts.length === 0 &&
        !current.options.length && !current.answer.length && !current.answerTextParts.length && current.number &&
        /(?:题号和题型|修复异常题号和题型|修复紧连异常题号和题型)/.test(current.boundarySource || '')) {
      const currentNumber = Number(current.number);
      const candidateNumber = Number(start.number);
      if (!Number.isFinite(currentNumber) || !Number.isFinite(candidateNumber) || candidateNumber !== currentNumber + 1) start = null;
    }
    // PDF 行首的小数（如“0.25MPa”）可能被通用题号规则误拆成“0.”题号。
    // 当前题尚未完成时，这类带单位的小数必定是上一行题干的续行。
    if (sourceKind === 'pdf' && start && current && !isComplete(current) &&
        /^\s*[+-]?\d+\.\d+\s*(?:[A-Za-zµμΩ℃°%]|[kKmMgGuUnNpP][A-Za-z]*)/.test(normalizeOneLine(text))) {
      start = null;
    }
    // PDF 视觉换行经常把“375 手操器”“15 分钟”等续行误判为无标点题号。
    // 当前题尚未完成时，这类行优先视为题干/选项的延续，避免凭空多出题目。
    if (sourceKind === 'pdf' && !relaxedPdfBoundaries && start && start.boundarySource === '无标点题号' && current && !isComplete(current)) {
      start = null;
    }
    if (start) {
      if (start.typeHint) { context.typeHint = start.typeHint; context.displayTypeLabel = start.displayTypeLabel || context.displayTypeLabel; }
      const pdfSupplementPrefix = sourceKind === 'pdf' && current && start.boundarySource === '题干标签' &&
        !current.options.length && !current.answer.length && !current.answerTextParts.length &&
        /^(?:[（(]?补充[）)]?|附加|追加)\s*$/i.test(cleanQuestionText(current.questionParts));
      const canFillExisting = (isWorkingEmpty(current) && start.boundarySource === '题干标签') || pdfSupplementPrefix;
      if (!canFillExisting) {
        diagnostics.detectedBoundaryCount += 1;
        diagnostics.explicitBoundaryCount += 1;
        if (start.boundarySource === '无标点题号') diagnostics.noPunctuationBoundaryRepairCount += 1;
      }
      if (!canFillExisting) {
        finish();
        current = createWorkingQuestion(start.number, context, start.boundarySource);
        applyPendingLeadingAnswer(current);
      } else {
        current.boundarySource = `${current.boundarySource}+题干标签`;
      }
      if (start.typeHint) { current.typeHint = start.typeHint; current.displayTypeLabel = start.displayTypeLabel || current.displayTypeLabel; }
      touch(current, paragraph);
      const styledFill = current.displayTypeLabel === '填空题' ? styledFillFromParagraph(start.content, paragraph) : { question: start.content, answers: [] };
      if (styledFill.answers.length) {
        current.typeHint = 'short'; current.displayTypeLabel = '填空题';
        pushText(current.questionParts, styledFill.question);
        pushText(current.answerTextParts, styledFill.answers.join('；'));
        current.answerBoundarySource = 'Word文字样式填空答案'; current.answerBoundaryConfidence = 0.97;
        current.answerSources.push('下划线/高亮/答案色文字');
        diagnostics.embeddedFillAnswerCount += 1;
        return;
      }
      const compactChoice = isCompactChoiceLine(start.content);
      const embeddedFill = current.displayTypeLabel === '填空题' && hasEmbeddedFillAnswer(start.content);
      const cleaned = consumeInlineAnswer(current, start.content, true);
      if (current.answer.length) diagnostics.inlineAnswerCount += 1;
      splitInline(cleaned).forEach(token => consumeToken(token, paragraph));
      if (compactChoice) diagnostics.compactChoiceRepairCount += 1;
      if (embeddedFill) diagnostics.embeddedFillAnswerCount += 1;
      return;
    }

    // Word 自动编号/转换器偶尔会把首项 A. 标签彻底吃掉，只留下
    // “二氧化碳B. 干粉C. 泡沫”。在明确的选择题上下文中，把前缀恢复为 A，
    // 再交给同一个 splitInline 处理；PDF/DOCX 均走这条共享兜底。
    const missingACompactOptions = recoverMissingACompactChoiceLine(text, current);
    if (missingACompactOptions) {
      touch(current, paragraph);
      missingACompactOptions.forEach(token => consumeToken(token, paragraph));
      current.answerSources.push('首项A标签缺失自动恢复');
      diagnostics.compactChoiceRepairCount += 1;
      return;
    }

    const fragmentedOptionContinuation = mode === 'option' ? recoverFragmentedOptionContinuation(text, current) : null;
    if (current && fragmentedOptionContinuation) {
      touch(current, paragraph, false);
      fragmentedOptionContinuation.forEach(token => consumeToken(token, paragraph));
      current.answerSources.push(fragmentedOptionContinuation.some(token => token.inferredMissingMarker)
        ? '缺失选项字母自动恢复' : '跨行连写选项自动拆分');
      diagnostics.compactChoiceRepairCount += 1;
      return;
    }

    // 教师版 Word 试卷有少量选项写成“A 文本 B 文本 C 文本 D 文本”，没有点号/顿号。
    // matchOptionLine 会把整行吞成 A；只在已确认带 Word 自动编号答案附录的文档里，
    // 且一行能完整拆出至少 3 个连续选项时启用，避免改变现有 PDF/普通 Word 解析。
    if (documentFlags.wordAutoAnswerAppendix && current && current.typeHint !== 'short' && current.typeHint !== 'judge') {
      const inlineBareTokens = splitInline(text).filter(token => token.type === 'option');
      if (inlineBareTokens.length >= 3) {
        const startCode = current.options.length ? current.options[current.options.length - 1].key.charCodeAt(0) + 1 : 65;
        const sequential = inlineBareTokens.every((token, tokenIndex) => token.key === String.fromCharCode(startCode + tokenIndex));
        if (sequential) {
          inlineBareTokens.forEach(token => consumeToken(token, paragraph));
          current.answerSources.push('Word无标点同行选项自动拆分');
          diagnostics.compactChoiceRepairCount += 1;
          return;
        }
      }
    }

    const earlyOptionMatch = matchOptionLine(text, current);
    const standaloneJudgeLetter = current && current.typeHint === 'judge' && /^\s*[AB]\s*[,，。；;]?\s*$/i.test(normalizeOneLine(text));
    if (current && !earlyOptionMatch && BARE_ANSWER_RE.test(text) && (current.options.length || isJudgementAnswerValue(text) || standaloneJudgeLetter)) {
      const letters = parseAnswerLetters(text);
      current.answer.push(...letters);
      current.answerSources.push(isJudgementAnswerValue(text) ? '独立判断答案行' : '独立答案行');
      if (isJudgementAnswerValue(text)) current.typeHint = 'judge';
      touch(current, paragraph);
      mode = 'answer';
      return;
    }

    const standaloneJudgeAnswer = /^\s*([AB])\s*[:：]\s*(正确|错误|对|错)\s*[,，。；;]?\s*$/i.exec(normalizeOneLine(text));
    if (current && standaloneJudgeAnswer) {
      const questionText = cleanQuestionText(current.questionParts);
      const truth = /^(?:正确|对)$/.test(standaloneJudgeAnswer[2]);
      if (current.typeHint === 'judge' || /[（(]\s*[）)]/.test(questionText)) {
        touch(current, paragraph);
        current.typeHint = 'judge';
        current.answer.push(truth ? 'A' : 'B');
        current.answerSources.push('A/B冒号判断答案行');
        current.answerBoundarySource = current.answerBoundarySource || '独立判断答案行';
        current.answerBoundaryConfidence = 1;
        mode = 'answer';
        return;
      }
    }

    const optionMatch = earlyOptionMatch || matchOptionLine(text, current);
    if (current && optionMatch) {
      if (optionMatch.direct) {
        touch(current, paragraph, false);
        addOption(current, optionMatch.key, optionMatch.value, paragraph.images || []);
        applyStyledOptionAnswer(current, optionMatch.key, optionMatch.value, paragraph);
        mode = 'option';
      } else {
        splitInline(text).forEach(token => consumeToken(token, paragraph));
      }
      return;
    }

    let unlabeledAnswer = inferUnlabeledShortAnswer(text, current, mode);
    if (!unlabeledAnswer.isAnswer && useLocalAI && current && mode === 'question') {
      const aiBoundary = localAI.classifyAnswerBoundary(cleanQuestionText(current.questionParts), text, {
        typeHint: current.typeHint,
        hasOptions: Boolean(current.options.length)
      });
      if (aiBoundary.isAnswer) unlabeledAnswer = aiBoundary;
    }
    if (unlabeledAnswer.isAnswer) {
      touch(current, paragraph);
      mode = 'reference';
      current.typeHint = 'short';
      current.answerBoundarySource = `${useLocalAI && /^本地模型/.test(unlabeledAnswer.reason || '') ? '本地AI辅助' : '无答案标签智能识别'}：${unlabeledAnswer.reason}`;
      current.answerBoundaryConfidence = unlabeledAnswer.confidence;
      current.answerSources.push('无答案标签参考答案');
      diagnostics.unlabeledAnswerCount += 1;
      pushText(current.answerTextParts, text);
      return;
    }

    const pdfAllowsInferredBoundary = sourceKind !== 'pdf' || relaxedPdfBoundaries || /[?？]\s*$/.test(normalizeOneLine(text));
    if (current && isComplete(current) && pdfAllowsInferredBoundary && looksLikeQuestionLine(text, context, paragraph)) {
      finish();
      current = createWorkingQuestion('', context, '智能推断边界');
      applyPendingLeadingAnswer(current);
      diagnostics.inferredBoundaryCount += 1;
      diagnostics.detectedBoundaryCount += 1;
      touch(current, paragraph);
      const cleaned = consumeInlineAnswer(current, text, true);
      if (current.answer.length) diagnostics.inlineAnswerCount += 1;
      splitInline(cleaned).forEach(token => consumeToken(token, paragraph));
      return;
    }

    if (!current) {
      if (/^\s*(?:[（(]\s*)?[A-L]\s*(?:[）).、．:：])/.test(text)) return;
      const cleanLength = normalizeOneLine(text).length;
      const canInferWithoutType = (sourceKind !== 'pdf' || relaxedPdfBoundaries || /[?？]\s*$/.test(normalizeOneLine(text))) && (
        looksLikeQuestionLine(text, context, paragraph) ||
        (paragraph.images || []).length > 0 ||
        (paragraph.numId && paragraph.numId !== '0' && paragraph.level === 0));
      if (cleanLength < 5 || (!context.typeHint && !canInferWithoutType)) return;
      current = createWorkingQuestion('', context, '智能推断边界');
      applyPendingLeadingAnswer(current);
      diagnostics.inferredBoundaryCount += 1;
      diagnostics.detectedBoundaryCount += 1;
      touch(current, paragraph);
      const cleaned = consumeInlineAnswer(current, text, true);
      if (current.answer.length) diagnostics.inlineAnswerCount += 1;
      splitInline(cleaned).forEach(token => consumeToken(token, paragraph));
      return;
    }

    touch(current, paragraph);
    const allowImplicit = mode === 'question' && current.questionParts.length === 0;
    const cleaned = consumeInlineAnswer(current, text, allowImplicit);
    splitInline(cleaned).forEach(token => consumeToken(token, paragraph));
  });

  finish();
  closeDeclaredSection();

  const reconciled = reconcileDeclaredSections(questions, declaredSections, sourceName);
  const finalQuestions = reconciled.questions
    .filter(item => item.question || item.answerText)
    .map((item, index) => Object.assign(item, { order: index + 1 }));
  diagnostics.centralAnswerAppliedCount = applyCentralAnswerKeys(finalQuestions, centralAnswers.entries);
  diagnostics.sourceDeclaredSectionCount = declaredSections.length;
  diagnostics.sourceDeclaredMissingCount = reconciled.missingItems.length;
  diagnostics.sourceDeclaredMissingItems = reconciled.missingItems.slice(0, 80);
  diagnostics.sourceDeclaredExtraCount = reconciled.extraItems.length;
  diagnostics.sourceDeclaredExtraItems = reconciled.extraItems.slice(0, 80);
  diagnostics.sourceContentQuestionCount = finalQuestions.filter(item => !item.sourceMissingPlaceholder).length;
  diagnostics.accountedQuestionCount = finalQuestions.length;
  diagnostics.duplicateCount = markDuplicates(finalQuestions.filter(item => !item.sourceMissingPlaceholder));
  diagnostics.localAIAppliedCount = finalQuestions.filter(item => item.aiAssistApplied).length;
  diagnostics.assignedParagraphCount = claimedParagraphIndexes.size;
  const unassigned = paragraphs.filter(item => {
    const indexes = Array.isArray(item.sourceIndexes) && item.sourceIndexes.length ? item.sourceIndexes : [item.index];
    return indexes.every(index => !claimedParagraphIndexes.has(index) && !structuralParagraphIndexes.has(index));
  });
  diagnostics.unassignedParagraphCount = unassigned.length;
  diagnostics.unassignedFragments = unassigned.slice(0, 80).map(item => ({
    paragraphIndex: item.index,
    text: normalizeOneLine(item.text || '').slice(0, 500),
    imageCount: (item.images || []).length,
    style: item.style || ''
  }));
  const numbering = analyzeNumbering(finalQuestions);
  diagnostics.numberingGapCount = numbering.gapCount;
  diagnostics.numberingIssues = numbering.issues;
  diagnostics.generatedQuestionCount = finalQuestions.length;
  diagnostics.silentLossCount = diagnostics.discardedBoundaryCount;

  return { questions: finalQuestions, diagnostics };
}

function analyzeQuestionBankStructure(sourceParagraphs = [], options = {}) {
  const sourceKind = String(options.sourceKind || '').toLowerCase();
  const rows = (sourceParagraphs || []).map(item => normalizeOneLine(item && item.text || '')).filter(Boolean);
  const stats = {
    sourceKind,
    paragraphCount: rows.length,
    indexedTyped: 0,
    indexedGeneric: 0,
    explicitNumbered: 0,
    noPunctuationNumbered: 0,
    labeledQuestion: 0,
    optionLine: 0,
    answerLine: 0,
    typeHeading: 0,
    tableLike: 0
  };
  rows.forEach(text => {
    if (COUNT_RE.test(text) || BROKEN_COUNT_RE.test(text) || NUMBERED_TYPE_RE.test(text)) stats.indexedTyped += 1;
    else if (GENERIC_COUNT_RE.test(text) || BARE_NUMBERED_QUESTION_RE.test(text)) stats.indexedGeneric += 1;
    else if (QUESTION_RES.some(pattern => pattern.test(text))) stats.explicitNumbered += 1;
    else if (NO_PUNCT_NUMBER_RE.test(text)) stats.noPunctuationNumbered += 1;
    if (/^(?:题目|题干|问题)\s*[:：]/.test(text) || TYPED_RE.test(text)) stats.labeledQuestion += 1;
    if (OPTION_LINE_RE.test(text) || LOOSE_OPTION_LINE_RE.test(text)) stats.optionLine += 1;
    if (/^(?:正确答案|标准答案|参考答案|答案|答)\s*(?:为|是)?\s*[:：]/.test(text) || BARE_ANSWER_RE.test(text)) stats.answerLine += 1;
    if (descriptiveTypeHeading(text)) stats.typeHeading += 1;
    if (/\t/.test(text) || /(?:题目|题干).*(?:答案|正确答案)/.test(text)) stats.tableLike += 1;
  });
  stats.strongBoundaryEstimate = stats.indexedTyped + stats.indexedGeneric + stats.explicitNumbered + stats.labeledQuestion;
  stats.looseBoundaryEstimate = stats.strongBoundaryEstimate + stats.noPunctuationNumbered;
  const indexedTotal = stats.indexedTyped + stats.indexedGeneric;
  const indexedThreshold = Math.max(3, Math.min(12, Math.ceil(rows.length * 0.04)));
  const mixedThreshold = Math.max(2, Math.min(8, Math.ceil(rows.length * 0.02)));
  if (indexedTotal >= indexedThreshold && (stats.explicitNumbered >= mixedThreshold || stats.labeledQuestion >= mixedThreshold)) stats.layout = 'mixed-indexed';
  else if (indexedTotal >= indexedThreshold) stats.layout = 'indexed';
  else if (stats.labeledQuestion >= mixedThreshold && stats.answerLine >= mixedThreshold) stats.layout = 'labeled';
  else if (stats.explicitNumbered >= mixedThreshold && stats.optionLine >= mixedThreshold) stats.layout = 'numbered-choice';
  else stats.layout = 'generic';
  return stats;
}

function adaptiveCandidateScore(candidate, structure) {
  const questions = candidate && candidate.questions || [];
  const diagnostics = candidate && candidate.diagnostics || {};
  const content = Number(diagnostics.sourceContentQuestionCount || questions.filter(item => !item.sourceMissingPlaceholder).length || 0);
  const expected = Math.max(Number(structure.strongBoundaryEstimate || 0), Number(structure.looseBoundaryEstimate || 0));
  let good = 0, warning = 0, error = 0;
  questions.forEach(item => {
    if (item.sourceMissingPlaceholder) return;
    if (item.status === 'error') error += 1;
    else if (item.status === 'warning') warning += 1;
    else good += 1;
  });
  let score = good * 12 + warning * 9 + error * 2;
  score -= Number(diagnostics.unassignedParagraphCount || 0) * 0.35;
  score -= Number(diagnostics.discardedBoundaryCount || 0) * 4;
  score -= Number(diagnostics.duplicateCount || 0) * 5;
  score -= Number(diagnostics.numberingGapCount || 0) * 0.5;
  if (expected > 0) {
    const ratio = content / expected;
    score += Math.min(1, ratio) * 500;
    if (ratio > 1.18) score -= (ratio - 1.18) * expected * 8;
  }
  return score;
}

function parseParagraphsAdaptive(sourceParagraphs, options = {}) {
  const structure = analyzeQuestionBankStructure(sourceParagraphs, options);
  const sourceKind = String(options.sourceKind || '').toLowerCase();
  const profiles = ['strict'];
  // PDF 的文字坐标转换最容易把原本明确的题号变成无标点题号或普通句子。
  // 对“序号型 / 混合型”题库额外跑宽松候选，再用结构覆盖率和异常率选优。
  if (sourceKind === 'pdf' || structure.layout === 'indexed' || structure.layout === 'mixed-indexed') profiles.push('relaxed');
  const candidates = profiles.map(profile => {
    const result = parseParagraphsDetailed(sourceParagraphs, Object.assign({}, options, { parserProfile: profile }));
    return { profile, result, score: adaptiveCandidateScore(result, structure) };
  });
  candidates.sort((a, b) => b.score - a.score || (b.result.questions.length - a.result.questions.length));

  let selected = candidates[0];
  // PDF 的 relaxed 模式允许从普通问句推断新题，适合修复缺失题号，但也可能把
  // 简答答案里的问句/编号说明多拆成“新题”。若 relaxed 只是增加异常/待检查题，
  // 正常题反而没有增加，且题号断层更严重，则回退 strict。这样不是“数量越多越好”，
  // 而是优先选择结构更完整、异常更少的候选。
  if (sourceKind === 'pdf' && candidates.length > 1) {
    const strictCandidate = candidates.find(item => item.profile === 'strict');
    const relaxedCandidate = candidates.find(item => item.profile === 'relaxed');
    if (strictCandidate && relaxedCandidate && relaxedCandidate.result.questions.length > strictCandidate.result.questions.length) {
      const countStatus = candidate => candidate.result.questions.reduce((acc, item) => {
        if (item.sourceMissingPlaceholder) return acc;
        if (item.status === 'error') acc.error += 1;
        else if (item.status === 'warning') acc.warning += 1;
        else acc.normal += 1;
        return acc;
      }, { normal: 0, warning: 0, error: 0 });
      const strictStatus = countStatus(strictCandidate);
      const relaxedStatus = countStatus(relaxedCandidate);
      const strictDiag = strictCandidate.result.diagnostics || {};
      const relaxedDiag = relaxedCandidate.result.diagnostics || {};
      const addsNoNormalQuestions = relaxedStatus.normal <= strictStatus.normal;
      const addsMoreProblems = relaxedStatus.warning >= strictStatus.warning && relaxedStatus.error >= strictStatus.error;
      const worsensNumbering = Number(relaxedDiag.numberingGapCount || 0) > Number(strictDiag.numberingGapCount || 0);
      const inferredGrowth = Number(relaxedDiag.inferredBoundaryCount || 0) > Number(strictDiag.inferredBoundaryCount || 0);
      if (addsNoNormalQuestions && addsMoreProblems && worsensNumbering && inferredGrowth) selected = strictCandidate;
    }
  }

  const chosen = selected.result;
  chosen.diagnostics = Object.assign({}, chosen.diagnostics || {}, {
    parserLayout: structure.layout,
    parserStrategy: selected.profile,
    parserStructure: structure,
    parserCandidates: candidates.map(item => ({
      profile: item.profile,
      score: Math.round(item.score * 100) / 100,
      questionCount: item.result.questions.length,
      contentQuestionCount: Number(item.result.diagnostics && item.result.diagnostics.sourceContentQuestionCount || 0),
      unassignedParagraphCount: Number(item.result.diagnostics && item.result.diagnostics.unassignedParagraphCount || 0),
      numberingGapCount: Number(item.result.diagnostics && item.result.diagnostics.numberingGapCount || 0)
    }))
  });
  return chosen;
}

function parseParagraphs(paragraphs, options = {}) {
  return parseParagraphsAdaptive(paragraphs, options).questions;
}

module.exports = {
  classifyHeader,
  declaredTypeSection,
  splitInline,
  splitCompactAnswerOptions,
  extractEmbeddedFillAnswers,
  parseAnswerLetters,
  extractInlineAnswer,
  sanitizeParagraphs,
  mergeSplitQuestionStarts,
  reconcileDeclaredSections,
  analyzeQuestionBankStructure,
  parseParagraphsDetailed,
  parseParagraphsAdaptive,
  parseParagraphs
};
