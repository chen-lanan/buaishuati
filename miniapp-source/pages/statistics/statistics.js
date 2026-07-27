const statisticsService = require('../../services/statistics-service');
const recordStorage = require('../../services/record-storage');

Page({
  data: { summary: {}, recentDays: [], byBank: [], byType: [], byDifficulty: [], weakCategories: [] },
  onShow() {
    const stats = recordStorage.getStats();
    const recentDays = Object.keys(stats.studyDays || {}).sort().reverse().slice(0, 7).map(day => ({ day, count: stats.studyDays[day] }));
    const details = statisticsService.detailed();
    const weakCategories = details.categories.slice().sort((a, b) => a.accuracy - b.accuracy || b.answered - a.answered).slice(0, 8);
    this.setData({ summary: statisticsService.summary(), recentDays, byBank: details.banks, byType: details.types, byDifficulty: details.difficulties, weakCategories });
  }
});
