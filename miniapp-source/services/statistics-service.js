const bankStorage = require('./bank-storage');
const recordStorage = require('./record-storage');

function metric(item = {}) {
  const answered = Number(item.answered) || 0;
  const correct = Number(item.correct) || 0;
  return { answered, correct, accuracy: answered ? Math.round(correct / answered * 100) : 0 };
}

function summary() {
  const banks = bankStorage.listBanks();
  const stats = recordStorage.getStats();
  const wrongCount = banks.reduce((sum, bank) => sum + Object.values(recordStorage.getWrong(bank.id)).filter(item => !item.mastered).length, 0);
  const favoriteCount = banks.reduce((sum, bank) => sum + recordStorage.getFavoriteIds(bank.id).length, 0);
  const masteredCount = banks.reduce((sum, bank) => sum + recordStorage.getMasteredIds(bank.id).length, 0);
  return {
    bankCount: banks.length,
    questionCount: banks.reduce((sum, bank) => sum + bank.questionCount, 0),
    answered: stats.answered,
    reviewed: stats.reviewed || 0,
    correct: stats.correct,
    accuracy: stats.answered ? Math.round(stats.correct / stats.answered * 100) : 0,
    exams: stats.exams,
    studyDays: Object.keys(stats.studyDays || {}).length,
    wrongCount, favoriteCount, masteredCount
  };
}

function rows(bucket = {}, labelMap = {}) {
  return Object.keys(bucket).map(key => Object.assign({ key, label: labelMap[key] || key || '未分类' }, metric(bucket[key])))
    .filter(item => item.answered > 0)
    .sort((a, b) => b.answered - a.answered || a.accuracy - b.accuracy);
}

function detailed() {
  const stats = recordStorage.getStats();
  const banks = bankStorage.listBanks();
  const bankNames = banks.reduce((acc, bank) => { acc[bank.id] = bank.name; return acc; }, {});
  const recent = Object.keys(stats.daily || {}).sort().slice(-30).map(day => Object.assign({ day }, metric(stats.daily[day])));
  return {
    banks: rows(stats.banks, bankNames),
    types: rows(stats.types),
    difficulties: rows(stats.difficulties),
    categories: rows(stats.categories).slice(0, 12),
    recent
  };
}

module.exports = { summary, detailed };
