function sourceFormat(bank = {}) {
  const sourceName = String(bank.sourceName || '');
  const extension = ((/\.([^.\\/]+)$/.exec(sourceName) || [])[1] || '').toLowerCase();
  const kind = String(bank.sourceKind || bank.kind || extension || '').toLowerCase();
  const ext = extension || kind;
  const wordKinds = ['doc', 'docx', 'docm', 'dotx', 'dotm', 'rtf', 'odt'];
  const excelKinds = ['xls', 'xlsx', 'xlsm', 'xltx', 'xltm', 'ods', 'csv', 'tsv'];
  const textKinds = ['txt', 'md', 'markdown', 'html', 'htm'];
  const labelMap = { markdown: 'MD', htm: 'HTML', buaiquiz: '题库包', qbank: '题库包', json: 'JSON' };
  const label = labelMap[ext] || String(ext || '题库').toUpperCase();
  if (wordKinds.includes(kind) || wordKinds.includes(extension)) {
    return { sourceFormat: 'word', sourceFormatLabel: label };
  }
  if (kind === 'pdf' || extension === 'pdf') {
    return { sourceFormat: 'pdf', sourceFormatLabel: 'PDF' };
  }
  if (excelKinds.includes(kind) || excelKinds.includes(extension)) {
    return { sourceFormat: 'excel', sourceFormatLabel: label };
  }
  if (textKinds.includes(kind) || textKinds.includes(extension)) {
    return { sourceFormat: 'text', sourceFormatLabel: label };
  }
  if (['qbank', 'buaiquiz', 'json'].includes(kind) || ['qbank', 'buaiquiz', 'json'].includes(extension)) {
    return { sourceFormat: 'qbank', sourceFormatLabel: label };
  }
  return { sourceFormat: 'other', sourceFormatLabel: label === '题库'.toUpperCase() ? '题库' : label };
}

function nameSizeClass(name = '') {
  const length = Array.from(String(name || '')).length;
  if (length > 19) return 'bank-name-compact';
  if (length > 18) return 'bank-name-medium';
  return 'bank-name-normal';
}

function decorateBank(bank = {}) {
  return Object.assign({}, bank, sourceFormat(bank), {
    nameSizeClass: nameSizeClass(bank.name)
  });
}

module.exports = { sourceFormat, nameSizeClass, decorateBank };
