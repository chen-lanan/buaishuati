const fileUtil = require('../utils/file');
const { decodeXmlEntities, normalizeText } = require('../utils/text');

function attrValue(xml, attrName) {
  const pattern = new RegExp(`${attrName}="([^"]+)"`);
  const match = pattern.exec(xml);
  return match ? decodeXmlEntities(match[1]) : '';
}

function parseRelationships(xml = '') {
  const result = {};
  const tags = xml.match(/<Relationship\b[^>]*\/?>/g) || [];
  tags.forEach(tag => {
    const id = attrValue(tag, 'Id');
    const target = attrValue(tag, 'Target');
    if (id && target) result[id] = target;
  });
  return result;
}

function stripInvisibleWordXml(xml = '') {
  return String(xml || '')
    .replace(/<w:del\b[\s\S]*?<\/w:del>/g, '')
    .replace(/<w:moveFrom\b[\s\S]*?<\/w:moveFrom>/g, '')
    .replace(/<w:instrText\b[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<w:customXmlDelRangeStart\b[^>]*\/>/g, '')
    .replace(/<w:customXmlDelRangeEnd\b[^>]*\/>/g, '');
}

function textFromVisibleXml(xml = '') {
  const visibleXml = stripInvisibleWordXml(xml);
  const texts = [];
  const runPattern = /<w:r\b[\s\S]*?<\/w:r>/g;
  let runMatch;
  while ((runMatch = runPattern.exec(visibleXml))) {
    const run = runMatch[0];
    if (/<w:vanish\b/.test(run) || /<w:webHidden\b/.test(run)) continue;
    const prepared = run
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n');
    const textPattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let textMatch;
    while ((textMatch = textPattern.exec(prepared))) texts.push(decodeXmlEntities(textMatch[1]));
  }
  if (!texts.length) {
    const prepared = visibleXml
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n');
    const pattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let match;
    while ((match = pattern.exec(prepared))) texts.push(decodeXmlEntities(match[1]));
  }
  return normalizeText(texts.join(''));
}

function branchQuality(xml = '') {
  const text = textFromVisibleXml(xml);
  if (!text) return -100000;
  const lines = text.split(/\n+/).map(item => normalizeText(item)).filter(Boolean);
  const uniqueLines = new Set(lines.map(item => item.replace(/\s+/g, '').toLowerCase()));
  let score = Math.min(text.length, 2000) + uniqueLines.size * 80;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].replace(/\s+/g, '') === lines[index - 1].replace(/\s+/g, '')) score -= 240;
  }
  if (/\b(?:A|Ａ)\s*[.、．:：)]/.test(text)) score += 25;
  if (/\b(?:B|Ｂ)\s*[.、．:：)]/.test(text)) score += 25;
  if (/\b(?:C|Ｃ)\s*[.、．:：)]/.test(text)) score += 25;
  if (/\b(?:D|Ｄ)\s*[.、．:：)]/.test(text)) score += 25;
  return score;
}

function resolveAlternateContent(xml = '') {
  let source = String(xml || '');
  let previous = '';
  // Some converted Word files nest AlternateContent. Resolve innermost blocks first.
  while (source !== previous && /<mc:AlternateContent\b/.test(source)) {
    previous = source;
    source = source.replace(/<mc:AlternateContent\b(?:(?!<mc:AlternateContent\b)[\s\S])*?<\/mc:AlternateContent>/g, block => {
      const choice = /<mc:Choice\b[^>]*>([\s\S]*?)<\/mc:Choice>/.exec(block);
      const fallback = /<mc:Fallback\b[^>]*>([\s\S]*?)<\/mc:Fallback>/.exec(block);
      if (!choice) return fallback ? fallback[1] : '';
      if (!fallback) return choice[1];
      const choiceScore = branchQuality(choice[1]);
      const fallbackScore = branchQuality(fallback[1]);
      return fallbackScore > choiceScore ? fallback[1] : choice[1];
    });
  }
  return source;
}

function drawingTextCandidates(xml = '') {
  const source = stripInvisibleWordXml(String(xml || ''));
  const values = [];
  let match;
  const drawingText = /<(?:a|m):t\b[^>]*>([\s\S]*?)<\/(?:a|m):t>/g;
  while ((match = drawingText.exec(source))) {
    const value = normalizeText(decodeXmlEntities(match[1]));
    if (value) values.push(value);
  }
  const textPath = /<v:textpath\b[^>]*\bstring="([^"]*)"[^>]*\/?>(?:<\/v:textpath>)?/g;
  while ((match = textPath.exec(source))) {
    const value = normalizeText(decodeXmlEntities(match[1]));
    if (value) values.push(value);
  }
  return values.filter((item, index, all) => all.indexOf(item) === index);
}

function paragraphTextCandidates(xml = '') {
  const source = String(xml || '');
  const variants = [resolveAlternateContent(source)];
  const blocks = source.match(/<mc:AlternateContent\b[\s\S]*?<\/mc:AlternateContent>/g) || [];
  blocks.slice(0, 6).forEach(block => {
    const branches = [];
    const choice = /<mc:Choice\b[^>]*>([\s\S]*?)<\/mc:Choice>/.exec(block);
    const fallback = /<mc:Fallback\b[^>]*>([\s\S]*?)<\/mc:Fallback>/.exec(block);
    if (choice) branches.push(choice[1]);
    if (fallback) branches.push(fallback[1]);
    branches.forEach(branch => {
      const replaced = source.replace(block, branch);
      variants.push(resolveAlternateContent(replaced));
    });
  });
  const texts = variants.map(textFromVisibleXml).filter(Boolean);
  // Visible corrections produced by PDF-to-Word converters can be DrawingML/VML text
  // rather than normal w:t runs. Keep them as alternatives, never as the primary text.
  texts.push(...drawingTextCandidates(source));
  return texts.filter((item, index, all) => all.findIndex(value => value === item) === index);
}

function paragraphText(xml = '') {
  return paragraphTextCandidates(xml)[0] || '';
}

function extractLeafParagraphBlocks(documentXml = '') {
  // Keep XML coordinates while selecting one visible AlternateContent branch. This avoids
  // reading both compatibility copies, but preserves inner text-box paragraphs in order.
  const source = resolveAlternateContent(String(documentXml || ''));

  function collectContainerRanges(tagName) {
    const pattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'g');
    const stack = [];
    const ranges = [];
    let tag;
    while ((tag = pattern.exec(source))) {
      if (tag[0][1] !== '/') stack.push(tag.index);
      else if (stack.length) ranges.push([stack.pop(), pattern.lastIndex]);
    }
    return ranges;
  }
  const textBoxRanges = [
    ...collectContainerRanges('w:txbxContent'),
    ...collectContainerRanges('v:textbox'),
    ...collectContainerRanges('wps:txbx')
  ];
  const isInsideTextBox = position => textBoxRanges.some(range => position >= range[0] && position < range[1]);

  const tokens = /<\/?w:p\b[^>]*>/g;
  const stack = [];
  const blocks = [];
  let match;
  while ((match = tokens.exec(source))) {
    const tag = match[0];
    const closing = /^<\/w:p\b/.test(tag);
    const selfClosing = /\/>$/.test(tag);
    if (!closing) {
      if (stack.length) stack[stack.length - 1].hasNestedParagraph = true;
      if (selfClosing) blocks.push({ start: match.index, xml: tag, insideTextBox: isInsideTextBox(match.index) });
      else stack.push({ start: match.index, hasNestedParagraph: false, insideTextBox: isInsideTextBox(match.index) });
      continue;
    }
    if (!stack.length) continue;
    const entry = stack.pop();
    if (!entry.hasNestedParagraph) {
      blocks.push({
        start: entry.start,
        xml: source.slice(entry.start, tokens.lastIndex),
        insideTextBox: entry.insideTextBox
      });
    }
  }
  return blocks.sort((a, b) => a.start - b.start);
}

function optionLineInfo(value = '') {
  const clean = normalizeText(value || '').replace(/\n+/g, ' ').trim();
  const match = /^\s*([A-L])\s*(?:[.、．:：)）]\s*|\s+)(.+?)\s*$/i.exec(clean);
  if (!match) return null;
  return {
    key: match[1].toUpperCase(),
    body: match[2].trim(),
    signature: match[2].replace(/[\s，。；、,.!！?？:：()（）\[\]【】]/g, '').toLowerCase()
  };
}

function repairExtractedOptionOverlays(paragraphs = []) {
  const skipped = new Set();
  for (let index = 1; index < paragraphs.length; index += 1) {
    if (skipped.has(index)) continue;
    const previous = optionLineInfo(paragraphs[index - 1].text);
    const current = optionLineInfo(paragraphs[index].text);
    if (!previous || !current) continue;
    const sequential = current.key.charCodeAt(0) === previous.key.charCodeAt(0) + 1;
    if (!sequential || !current.signature || current.signature !== previous.signature) continue;

    // Converted PDF/Word files sometimes keep an invisible base line plus a visible text-box
    // correction. Prefer a distinct alternative for the same option key when it exists.
    const inlineAlternative = (paragraphs[index].alternatives || [])
      .map(optionLineInfo)
      .find(item => item && item.key === current.key && item.signature && item.signature !== previous.signature);
    if (inlineAlternative) {
      paragraphs[index].text = `${current.key}. ${inlineAlternative.body}`;
      paragraphs[index].extractionRepair = '兼容分支选项恢复';
      continue;
    }
    const inlineOverlay = (paragraphs[index].alternatives || [])
      .map(value => normalizeText(value || '').replace(new RegExp(`^\\s*${current.key}\\s*[.、．:：)）]?\\s*`, 'i'), '').trim())
      .find(value => {
        if (!value || value.length > 500) return false;
        const signature = value.replace(/[\s，。；、,.!！?？:：()（）\[\]【】]/g, '').toLowerCase();
        return signature && signature !== previous.signature && signature !== current.signature;
      });
    if (inlineOverlay) {
      paragraphs[index].text = `${current.key}. ${inlineOverlay}`;
      paragraphs[index].extractionRepair = '图形覆盖选项恢复';
      continue;
    }

    // The visible overlay can also appear as the next paragraph. Use it only before an answer
    // or the next question and only when it carries the same option key.
    for (let look = index + 1; look < Math.min(paragraphs.length, index + 5); look += 1) {
      const candidateText = normalizeText(paragraphs[look].text || '');
      if (/^(?:答案|参考答案|解析|正确答案)\s*[:：]/.test(candidateText) || /^\d{1,4}\s*[.、．)）]/.test(candidateText)) break;
      const candidate = optionLineInfo(candidateText);
      if (candidate && candidate.key === current.key && candidate.signature && candidate.signature !== previous.signature) {
        paragraphs[index].text = `${current.key}. ${candidate.body}`;
        paragraphs[index].extractionRepair = '浮动文本框选项恢复';
        skipped.add(look);
        break;
      }

      // PDF-to-Word converters often leave the wrong base glyphs in the paragraph and draw
      // the visible replacement inside a text box without repeating the D./D: label. Only
      // consume such an unlabeled value when the paragraph is structurally inside a text box,
      // is adjacent to a duplicated option, and appears before the answer/next question.
      if (!candidate && paragraphs[look].insideTextBox && candidateText.length <= 500) {
        const overlayBody = candidateText
          .replace(new RegExp(`^\\s*${current.key}\\s*[.、．:：)）]?\\s*`, 'i'), '')
          .trim();
        const overlaySignature = overlayBody.replace(/[\s，。；、,.!！?？:：()（）\[\]【】]/g, '').toLowerCase();
        if (overlayBody && overlaySignature && overlaySignature !== previous.signature) {
          paragraphs[index].text = `${current.key}. ${overlayBody}`;
          paragraphs[index].extractionRepair = '文本框覆盖选项恢复';
          skipped.add(look);
          break;
        }
      }
    }
  }
  return paragraphs.filter((_, index) => !skipped.has(index));
}

function runStyleCandidates(xml = '') {
  const visible = stripInvisibleWordXml(String(xml || ''));
  const styled = [];
  const bold = [];
  let plainLength = 0;
  const runPattern = /<w:r\b[\s\S]*?<\/w:r>/g;
  let runMatch;
  while ((runMatch = runPattern.exec(visible))) {
    const run = runMatch[0];
    if (/<w:vanish\b/.test(run) || /<w:webHidden\b/.test(run)) continue;
    const text = textFromVisibleXml(run);
    if (!text) continue;
    const props = /<w:rPr\b[\s\S]*?<\/w:rPr>/.exec(run);
    const rpr = props ? props[0] : '';
    const underline = /<w:u\b(?![^>]*w:val="(?:none|0)")/.test(rpr);
    const highlight = /<w:highlight\b[^>]*w:val="(?!none|auto)[^"]+"/.test(rpr) || /<w:shd\b[^>]*w:fill="(?!auto|FFFFFF|ffffff)[A-Fa-f0-9]{6}"/.test(rpr);
    const colorMatch = /<w:color\b[^>]*w:val="([A-Fa-f0-9]{6}|auto)"/.exec(rpr);
    let answerColor = false;
    if (colorMatch && colorMatch[1].toLowerCase() !== 'auto') {
      const value = colorMatch[1];
      const red = parseInt(value.slice(0, 2), 16), green = parseInt(value.slice(2, 4), 16), blue = parseInt(value.slice(4, 6), 16);
      answerColor = red >= 150 && red >= green * 1.35 && red >= blue * 1.35;
    }
    const isBold = /<w:b\b(?![^>]*w:val="(?:false|0|off)")/.test(rpr);
    if (underline || highlight || answerColor) styled.push({ text, strength: 'strong', reason: underline ? 'underline' : (highlight ? 'highlight' : 'color') });
    else if (isBold) bold.push({ text, strength: 'bold', reason: 'bold' });
    else plainLength += Array.from(text).length;
  }
  // 粗体只有在同一段中同时存在普通文字、且粗体片段不占大多数时才视为弱答案候选，
  // 避免把整道加粗题干或标题当成填空答案。
  const boldLength = bold.reduce((sum, item) => sum + Array.from(item.text).length, 0);
  const usableBold = plainLength >= 4 && boldLength > 0 && boldLength <= Math.max(80, plainLength) ? bold : [];
  return [...styled, ...usableBold].filter((item, index, all) => all.findIndex(other => other.text === item.text && other.reason === item.reason) === index);
}

function extractTableCellRanges(documentXml = '', relationships = {}, extractDir = '') {
  const source = resolveAlternateContent(String(documentXml || ''));
  const tables = [];
  const cells = [];
  const tablePattern = /<w:tbl\b[\s\S]*?<\/w:tbl>/g;
  let tableMatch;
  let tableIndex = 0;
  while ((tableMatch = tablePattern.exec(source))) {
    const tableXml = tableMatch[0];
    const tableStart = tableMatch.index;
    const rows = [];
    const rowPattern = /<w:tr\b[\s\S]*?<\/w:tr>/g;
    let rowMatch;
    let rowIndex = 0;
    while ((rowMatch = rowPattern.exec(tableXml))) {
      const rowXml = rowMatch[0];
      const rowStart = tableStart + rowMatch.index;
      const values = [];
      const rowImages = [];
      const cellPattern = /<w:tc\b[\s\S]*?<\/w:tc>/g;
      let cellMatch;
      let colIndex = 0;
      while ((cellMatch = cellPattern.exec(rowXml))) {
        const cellXml = cellMatch[0];
        const start = rowStart + cellMatch.index;
        const end = start + cellXml.length;
        const value = textFromVisibleXml(cellXml).replace(/\n+/g, ' ').trim();
        const imageIds = [];
        const imagePattern = /(?:r:embed|r:link|r:id)="([^"]+)"/g;
        let imageMatch;
        while ((imageMatch = imagePattern.exec(cellXml))) if (!imageIds.includes(imageMatch[1])) imageIds.push(imageMatch[1]);
        const images = imageIds.map(id => relationships[id]).filter(Boolean).map(target => `${extractDir}/word/${target.replace(/^\.\.\//, '')}`).filter(fileUtil.exists);
        values[colIndex] = value;
        rowImages[colIndex] = images;
        cells.push({ start, end, tableId: tableIndex + 1, rowIndex, colIndex });
        colIndex += 1;
      }
      if (values.some(Boolean) || rowImages.some(list => list && list.length)) rows.push({ values, images: rowImages, rowIndex });
      rowIndex += 1;
    }
    if (rows.length) tables.push({ id: tableIndex + 1, name: `Word表格${tableIndex + 1}`, sourceStart: tableStart, rows });
    tableIndex += 1;
  }
  return { source, tables, cells };
}

function extractParagraphs(documentXml, relationships, extractDir) {
  const paragraphs = [];
  const tableInfo = extractTableCellRanges(documentXml, relationships, extractDir);
  const blocks = extractLeafParagraphBlocks(documentXml);
  const listCounters = {};
  let index = 0;

  blocks.forEach(block => {
    const xml = block.xml || '';
    const candidates = paragraphTextCandidates(xml);
    const text = candidates[0] || '';
    const styleMatch = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(xml);
    const numIdMatch = /<w:numId\b[^>]*w:val="([^"]+)"/.exec(xml);
    const levelMatch = /<w:ilvl\b[^>]*w:val="([^"]+)"/.exec(xml);
    const numId = numIdMatch && numIdMatch[1] !== '0' ? numIdMatch[1] : '';
    const tableCell = tableInfo.cells.find(cell => block.start >= cell.start && block.start < cell.end) || null;
    const styleCandidates = runStyleCandidates(xml);
    const level = levelMatch ? Number(levelMatch[1]) : 0;
    let listOrdinal = 0;
    if (numId) {
      const key = `${numId}:${level}`;
      listCounters[key] = (listCounters[key] || 0) + 1;
      listOrdinal = listCounters[key];
    }

    const imageIds = [];
    // Modern DrawingML uses r:embed; older PDF-to-Word converters often use
    // VML <v:imagedata r:id="...">. Read both forms (and linked images) so
    // symbol/image options are not silently reduced to the placeholder text “图形”.
    const imagePattern = /(?:r:embed|r:link|r:id)="([^"]+)"/g;
    let imageMatch;
    while ((imageMatch = imagePattern.exec(xml))) {
      if (!imageIds.includes(imageMatch[1])) imageIds.push(imageMatch[1]);
    }

    const images = imageIds
      .map(id => relationships[id])
      .filter(Boolean)
      .map(target => {
        const normalized = target.replace(/^\.\.\//, '');
        return `${extractDir}/word/${normalized}`;
      })
      .filter(fileUtil.exists);

    if (text || images.length) {
      paragraphs.push({
        index,
        text,
        alternatives: candidates.slice(1),
        sourceStart: block.start || 0,
        insideTextBox: !!block.insideTextBox,
        style: styleMatch ? styleMatch[1] : '',
        styleAnswers: styleCandidates.map(item => item.text),
        styleAnswerDetails: styleCandidates,
        tableId: tableCell ? tableCell.tableId : 0,
        tableRow: tableCell ? tableCell.rowIndex : -1,
        tableCol: tableCell ? tableCell.colIndex : -1,
        numId,
        level,
        listOrdinal,
        images
      });
    }
    index += 1;
  });
  const repaired = repairExtractedOptionOverlays(paragraphs);
  repaired.tableContexts = tableInfo.tables;
  return repaired;
}

function extractDocx(extractDir) {
  const documentPath = `${extractDir}/word/document.xml`;
  if (!fileUtil.exists(documentPath)) {
    throw new Error('Word 文件缺少 word/document.xml，文件可能损坏或不是 DOCX。');
  }
  const documentXml = fileUtil.readTextAuto(documentPath);
  const relsPath = `${extractDir}/word/_rels/document.xml.rels`;
  const relsXml = fileUtil.exists(relsPath) ? fileUtil.readTextAuto(relsPath) : '';
  const relationships = parseRelationships(relsXml);
  return extractParagraphs(documentXml, relationships, extractDir);
}

module.exports = {
  parseRelationships,
  paragraphText,
  paragraphTextCandidates,
  extractLeafParagraphBlocks,
  extractParagraphs,
  runStyleCandidates,
  extractTableCellRanges,
  extractDocx
};
