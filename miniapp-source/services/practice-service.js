const bankStorage = require('./bank-storage');
const recordStorage = require('./record-storage');
const { QUESTION_TYPES } = require('../utils/constants');

function shuffle(items) {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function sameAnswer(left = [], right = []) {
  return left.slice().sort().join(',') === right.slice().sort().join(',');
}

function buildQuestionEditSignature(question) {
  const item = question || {};
  return JSON.stringify({
    type: String(item.type || ''),
    question: String(item.question || ''),
    images: Array.isArray(item.images) ? item.images.map(String) : [],
    options: (Array.isArray(item.options) ? item.options : []).map(option => ({
      key: String(option && option.key || ''),
      text: String(option && option.text || ''),
      images: Array.isArray(option && option.images) ? option.images.map(String) : []
    })),
    answer: (Array.isArray(item.answer) ? item.answer : []).map(String).sort(),
    answerText: String(item.answerText || '')
  });
}

function optionEditFingerprint(option) {
  const item = option || {};
  return JSON.stringify({
    text: String(item.text || '').trim(),
    images: Array.isArray(item.images) ? item.images.map(String) : []
  });
}

function remapSelectedOptions(previousQuestion, nextQuestion, selected = []) {
  const previousOptions = Array.isArray(previousQuestion && previousQuestion.options)
    ? previousQuestion.options : [];
  const nextOptions = Array.isArray(nextQuestion && nextQuestion.options)
    ? nextQuestion.options : [];
  const used = new Set();
  const result = [];
  (Array.isArray(selected) ? selected : []).forEach(key => {
    const previous = previousOptions.find(option => option && option.key === key);
    if (!previous) return;
    const fingerprint = optionEditFingerprint(previous);
    let match = nextOptions.find(option => option && !used.has(option.key)
      && optionEditFingerprint(option) === fingerprint);
    if (!match) {
      match = nextOptions.find(option => option && option.key === key && !used.has(option.key));
    }
    if (!match) return;
    used.add(match.key);
    result.push(match.key);
  });
  return result;
}

function normalizeProgressText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[，。；：、“”‘’（）()《》【】\[\]·,.!?！？;:'"`~\-—_]/g, '')
    .toLowerCase();
}

function buildQuestionProgressKey(question) {
  if (!question) return '';
  const type = String(question.type || '');
  const category = normalizeProgressText(question.category || '');
  const text = normalizeProgressText(question.question || '').slice(0, 180);
  return `${type}|${category}|${text}`;
}


function isCompletedResult(question, result) {
  if (!result || typeof result !== 'object') return false;
  if (question && question.type === 'short') return Boolean(result.selfScore);
  return typeof result.correct === 'boolean' && !result.revealed;
}

function getQuestionAnswerStatus(question, result) {
  if (!isCompletedResult(question, result)) return 'unanswered';
  return result.correct ? 'correct' : 'wrong';
}

function getFurthestCompletedOrder(questions, results) {
  const list = Array.isArray(questions) ? questions : [];
  const state = results || {};
  let furthest = 0;
  list.forEach((question, index) => {
    if (!question || !isCompletedResult(question, state[question.id])) return;
    const order = Number(question.order);
    const stableOrder = Number.isFinite(order) && order > 0 ? order : index + 1;
    furthest = Math.max(furthest, stableOrder);
  });
  return furthest;
}

function findResumeIndexAfterCompletion(questions, results, lastCompletedOrder = 0) {
  const list = Array.isArray(questions) ? questions : [];
  if (!list.length) return 0;
  const state = results || {};
  const completedOrder = Math.max(0, Number(lastCompletedOrder) || 0);

  // “继续上次进度”由已经完成的题决定，不受用户最后停留、翻页或查看题目的位置影响。
  // 优先进入最后完成题之后的第一道未答题。
  for (let index = 0; index < list.length; index += 1) {
    const question = list[index];
    const order = Number(question && question.order);
    const stableOrder = Number.isFinite(order) && order > 0 ? order : index + 1;
    if (stableOrder > completedOrder && getQuestionAnswerStatus(question, state[question.id]) === 'unanswered') {
      return index;
    }
  }

  // 若用户通过答题卡跨题作答，最后完成题之后可能没有未答题；此时回到最早未答题。
  const firstUnanswered = list.findIndex(question =>
    getQuestionAnswerStatus(question, state[question && question.id]) === 'unanswered'
  );
  if (firstUnanswered >= 0) return firstUnanswered;

  // 全部题目均已完成时停在最后一题，便于查看结果并点击“完成”。
  return Math.max(0, list.length - 1);
}

function buildPracticeScopeKey(type = 'all', count = 0) {
  return `${String(type || 'all')}|${Math.max(0, Number(count) || 0)}`;
}

function buildMemorizeScopeKey(order = 'sequence', type = 'all', count = 0) {
  return `${order === 'random' ? 'random' : 'sequence'}|${buildPracticeScopeKey(type, count)}`;
}

function getMemorizeProgressCursor(progress, order = 'sequence', type = 'all', count = 0) {
  if (!progress || typeof progress !== 'object') return null;
  const scopeKey = buildMemorizeScopeKey(order, type, count);
  if (progress.cursors && typeof progress.cursors === 'object' && progress.cursors[scopeKey]) {
    return progress.cursors[scopeKey];
  }
  // v1.8.5 及更早版本只保存顺序背题，键名不含顺序类型。
  if (order !== 'random') {
    const legacy = buildPracticeScopeKey(type, count);
    if (progress.cursors && typeof progress.cursors === 'object' && progress.cursors[legacy]) {
      return progress.cursors[legacy];
    }
    const legacyScope = buildPracticeScopeKey(progress.type || 'all', progress.requestedCount || 0);
    if (legacy === legacyScope && progress.cursor) return progress.cursor;
  }
  return null;
}

function getMemorizeQuestionSequence(progress, order = 'random', type = 'all', count = 0) {
  if (!progress || typeof progress !== 'object' || order !== 'random') return [];
  const scopeKey = buildMemorizeScopeKey(order, type, count);
  const sequences = progress.randomSequences && typeof progress.randomSequences === 'object'
    ? progress.randomSequences : {};
  return Array.isArray(sequences[scopeKey]) ? sequences[scopeKey] : [];
}

function buildMemorizeQuestionSequence(questions = []) {
  return (Array.isArray(questions) ? questions : []).map(question => ({
    questionId: question && question.id || '',
    questionKey: buildQuestionProgressKey(question),
    questionOrder: Number.isFinite(Number(question && question.order)) ? Number(question.order) : 0
  }));
}

function reorderQuestionsBySavedSequence(questions = [], sequence = []) {
  const list = Array.isArray(questions) ? questions.slice() : [];
  const saved = Array.isArray(sequence) ? sequence : [];
  if (!saved.length || !list.length) return list;
  const used = new Set();
  const ordered = [];
  const findIndex = state => {
    if (state && state.questionId) {
      const byId = list.findIndex((question, index) => !used.has(index) && question && question.id === state.questionId);
      if (byId >= 0) return byId;
    }
    const wantedKey = state && state.questionKey || '';
    const wantedOrder = Number(state && state.questionOrder) || 0;
    const candidates = [];
    list.forEach((question, index) => {
      if (used.has(index)) return;
      if (wantedKey && buildQuestionProgressKey(question) === wantedKey) candidates.push(index);
    });
    if (candidates.length) {
      return candidates.slice().sort((left, right) => {
        const lo = Number(list[left] && list[left].order) || left + 1;
        const ro = Number(list[right] && list[right].order) || right + 1;
        return Math.abs(lo - wantedOrder) - Math.abs(ro - wantedOrder) || lo - ro;
      })[0];
    }
    if (wantedOrder > 0) {
      const byOrder = list.findIndex((question, index) => !used.has(index) && Number(question && question.order) === wantedOrder);
      if (byOrder >= 0) return byOrder;
    }
    return -1;
  };
  saved.forEach(state => {
    const index = findIndex(state);
    if (index < 0) return;
    used.add(index);
    ordered.push(list[index]);
  });
  // 题库后来新增或替换的题，随机追加到原随机序列末尾；既保留旧顺序，也不会漏题。
  const remaining = list.filter((question, index) => !used.has(index));
  return ordered.concat(shuffle(remaining));
}

function getProgressCursor(progress, type = 'all', count = 0) {
  if (!progress || typeof progress !== 'object') return null;
  const scopeKey = buildPracticeScopeKey(type, count);
  if (progress.cursors && typeof progress.cursors === 'object') {
    return progress.cursors[scopeKey] || null;
  }
  const legacyScope = buildPracticeScopeKey(progress.type || 'all', progress.requestedCount || 0);
  if (scopeKey !== legacyScope) return null;
  return {
    lastCompletedOrder: Number(progress.lastCompletedOrder || 0),
    questionId: progress.questionId || '',
    questionKey: progress.questionKey || '',
    questionOrder: Number(progress.questionOrder || 0),
    index: Number(progress.index || 0),
    completedAll: Boolean(progress.completedAll)
  };
}

function buildPersistedQuestionStates(session) {
  if (!session || !Array.isArray(session.questions)) return [];
  const answers = session.answers || {};
  const results = session.results || {};
  return session.questions.reduce((states, question) => {
    if (!question || !question.id) return states;
    const selected = Array.isArray(answers[question.id]) ? answers[question.id].slice() : [];
    const result = results[question.id] && typeof results[question.id] === 'object'
      ? { ...results[question.id] }
      : null;
    // 只保存有选择或已经显示/提交结果的题，避免 1000 多道空状态占用空间。
    if (!selected.length && !result) return states;
    const selectedSet = new Set(selected);
    const selectedTexts = (question.options || [])
      .filter(option => selectedSet.has(option.key))
      .map(option => String(option.text || ''));
    states.push({
      questionId: question.id,
      questionKey: buildQuestionProgressKey(question),
      questionOrder: Number.isFinite(Number(question.order)) ? Number(question.order) : 0,
      selected,
      selectedTexts,
      result
    });
    return states;
  }, []);
}

function mergePersistedQuestionStates(previousStates, currentStates, sessionQuestions) {
  const previous = Array.isArray(previousStates) ? previousStates : [];
  const current = Array.isArray(currentStates) ? currentStates : [];
  const questions = Array.isArray(sessionQuestions) ? sessionQuestions : [];
  const coveredIds = new Set(questions.map(question => question && question.id).filter(Boolean));
  const coveredKeys = new Set(questions.map(question => {
    if (!question) return '';
    return `${buildQuestionProgressKey(question)}|${Number(question.order) || 0}`;
  }).filter(Boolean));

  // 当前筛选/数量范围内的题以本次会话状态为准；范围外的历史状态继续保留。
  // 这样先练“全部题型”，再只练“多选题”时，不会把其他题型已保存答案清空。
  const preserved = previous.filter(state => {
    if (!state) return false;
    if (state.questionId && coveredIds.has(state.questionId)) return false;
    const key = `${state.questionKey || ''}|${Number(state.questionOrder) || 0}`;
    return !coveredKeys.has(key);
  });
  return preserved.concat(current);
}

function findQuestionIndexForState(questions, state) {
  if (!state || !Array.isArray(questions) || !questions.length) return -1;
  if (state.questionId) {
    const byId = questions.findIndex(question => question && question.id === state.questionId);
    if (byId >= 0) return byId;
  }
  const wantedOrder = Number(state.questionOrder);
  const hasOrder = Number.isFinite(wantedOrder) && wantedOrder > 0;
  if (state.questionKey) {
    const candidates = [];
    questions.forEach((question, index) => {
      if (buildQuestionProgressKey(question) === state.questionKey) candidates.push(index);
    });
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      if (!hasOrder) return candidates[0];
      return candidates.slice().sort((left, right) => {
        const leftOrder = Number(questions[left] && questions[left].order) || left + 1;
        const rightOrder = Number(questions[right] && questions[right].order) || right + 1;
        return Math.abs(leftOrder - wantedOrder) - Math.abs(rightOrder - wantedOrder)
          || leftOrder - rightOrder;
      })[0];
    }
  }
  // 已作答状态不能只凭顺序号套到新题上。覆盖导入后若题干发生变化，
  // 宁可不恢复旧答案，也不能把上一版第 N 题的答案误标到新版第 N 题。
  return -1;
}

function restoreQuestionStates(questions, persistedStates) {
  const answers = {};
  const results = {};
  if (!Array.isArray(questions) || !Array.isArray(persistedStates)) return { answers, results };

  persistedStates.forEach(state => {
    const index = findQuestionIndexForState(questions, state);
    if (index < 0) return;
    const question = questions[index];
    const optionKeys = new Set((question.options || []).map(option => option.key));
    let selected = Array.isArray(state.selected)
      ? state.selected.filter(key => optionKeys.has(key))
      : [];

    // 开启“选项乱序”时重新进入练习，字母可能变化；按选项正文恢复到新字母。
    if (Array.isArray(state.selectedTexts) && state.selectedTexts.length) {
      const wantedTexts = state.selectedTexts.map(normalizeProgressText);
      const restored = [];
      wantedTexts.forEach(text => {
        const option = (question.options || []).find(item => normalizeProgressText(item.text) === text);
        if (option && !restored.includes(option.key)) restored.push(option.key);
      });
      if (restored.length) selected = restored;
    }

    if (selected.length) answers[question.id] = selected;
    if (state.result && typeof state.result === 'object') {
      if (question.type === 'short') {
        results[question.id] = { ...state.result };
      } else if (selected.length) {
        // 题库覆盖导入或选项乱序后，以当前题目的正确答案重新核算结果，
        // 避免旧版答案变更后仍显示过期的“正确/错误”。
        results[question.id] = {
          ...state.result,
          correct: sameAnswer(question.answer || [], selected)
        };
      }
    }
  });
  return { answers, results };
}

function findResumeIndex(questions, config = {}) {
  if (!Array.isArray(questions) || !questions.length) return 0;

  // 同一次导入中 ID 最精确，优先使用。
  if (config.resumeQuestionId) {
    const byId = questions.findIndex(item => item.id === config.resumeQuestionId);
    if (byId >= 0) return byId;
  }

  const wantedOrder = Number(config.resumeQuestionOrder);
  const hasWantedOrder = Number.isFinite(wantedOrder) && wantedOrder > 0;

  // 覆盖导入后 ID 会变化，此时使用题型+分类+题干生成的稳定键。
  // 相同题干可能重复出现，不能简单 findIndex 取第一条；应选择与原顺序号最近的一条，
  // 避免“做到第 8 题却恢复到第 6 题”。
  if (config.resumeQuestionKey) {
    const candidates = [];
    questions.forEach((item, index) => {
      if (buildQuestionProgressKey(item) === config.resumeQuestionKey) candidates.push(index);
    });
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      if (hasWantedOrder) {
        return candidates.slice().sort((left, right) => {
          const leftOrder = Number(questions[left] && questions[left].order) || left + 1;
          const rightOrder = Number(questions[right] && questions[right].order) || right + 1;
          return Math.abs(leftOrder - wantedOrder) - Math.abs(rightOrder - wantedOrder)
            || leftOrder - rightOrder;
        })[0];
      }
      return candidates[0];
    }
  }

  // 内容被编辑或分类变化时，按 Word 原始顺序号恢复；若该题被筛掉或已掌握，
  // 从它后面的第一道可练习题继续，不向前倒退。
  if (hasWantedOrder) {
    const exact = questions.findIndex(item => Number(item && item.order) === wantedOrder);
    if (exact >= 0) return exact;
    const following = questions.findIndex(item => Number(item && item.order) > wantedOrder);
    if (following >= 0) return following;
    return Math.max(0, questions.length - 1);
  }

  // 最后才使用会受筛选影响的列表下标，并且只允许合法范围。
  const wantedIndex = Number(config.resumeQuestionIndex);
  if (Number.isInteger(wantedIndex) && wantedIndex >= 0 && wantedIndex < questions.length) return wantedIndex;

  return 0;
}

const OPTION_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function hasOrderDependentOption(question) {
  return (question.options || []).some(item =>
    /(?:以上|以下|上述|前述|全部|均为|均是|都为|都是|全选|都正确|都错误|均正确|均错误)/.test(String(item && item.text || ''))
  );
}

function restoreQuestionOptionOrder(question) {
  if (!question || !question.optionOrderOriginal) return question;
  const original = question.optionOrderOriginal || {};
  const restored = {
    ...question,
    options: (original.options || []).map(item => ({ ...item })),
    answer: (original.answer || []).slice()
  };
  delete restored.optionOrderOriginal;
  delete restored.optionOrderShuffled;
  return restored;
}

function shuffleQuestionOptions(question) {
  const canonical = restoreQuestionOptionOrder(question);
  if (!canonical || canonical.type === 'short' || !Array.isArray(canonical.options) || canonical.options.length < 2) {
    return canonical;
  }
  // “以上都是/以下均不正确”等内容依赖当前位置，强行打乱会改变题意，因此智能跳过。
  if (hasOrderDependentOption(canonical)) return canonical;

  const originalOptions = canonical.options.map(item => ({ ...item }));
  const originalAnswer = (canonical.answer || []).slice();
  const shuffled = shuffle(originalOptions.map(item => ({ ...item })));
  const keyMap = {};
  const options = shuffled.map((item, index) => {
    const newKey = OPTION_KEYS[index] || item.key;
    keyMap[item.key] = newKey;
    return { ...item, key: newKey };
  });
  const answer = originalAnswer
    .map(key => keyMap[key] || key)
    .filter(Boolean)
    .sort((a, b) => OPTION_KEYS.indexOf(a) - OPTION_KEYS.indexOf(b));
  return {
    ...canonical,
    options,
    answer,
    optionOrderShuffled: true,
    optionOrderOriginal: { options: originalOptions, answer: originalAnswer }
  };
}

function applyOptionOrderPreference(questions, enabled, answers = {}, results = {}) {
  return (questions || []).map(question => {
    if (!question) return question;
    const selected = Array.isArray(answers[question.id]) ? answers[question.id] : [];
    const alreadyTouched = selected.length > 0 || isCompletedResult(question, results[question.id]);
    if (alreadyTouched) return question;
    const canonical = restoreQuestionOptionOrder(question);
    return enabled ? shuffleQuestionOptions(canonical) : canonical;
  });
}

function createSession(config) {
  let questions = bankStorage.loadQuestions(config.bankId);
  // 始终以 Word 导入时的 order 为主序；题型、错题、收藏和已掌握过滤只删除题目，
  // 不改变剩余题目的相对顺序。只有“随机练习/模拟考试”会主动打乱。
  questions = questions.map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const lo = Number(left.item && left.item.order);
      const ro = Number(right.item && right.item.order);
      const lv = Number.isFinite(lo) && lo > 0 ? lo : left.index + 1;
      const rv = Number.isFinite(ro) && ro > 0 ? ro : right.index + 1;
      return lv === rv ? left.index - right.index : lv - rv;
    })
    .map(entry => entry.item);
  const masteredIds = new Set(recordStorage.getMasteredIds(config.bankId));

  if (config.mode !== 'exam' && config.mode !== 'search') {
    questions = questions.filter(item => !masteredIds.has(item.id));
  }
  // “全部题型”同时包含正常题与异常题；异常状态只改变答题页标识，不再从全部练习中排除。
  questions = questions.filter(item => !item.sourceMissingPlaceholder && !item.nonPractice);
  if (config.type === 'abnormal') {
    questions = questions.filter(item => (item.status || 'normal') !== 'normal');
  } else if (config.type && config.type !== 'all') {
    if (String(config.type).startsWith('display:')) {
      const wantedLabel = String(config.type).slice('display:'.length);
      questions = questions.filter(item => {
        if ((item.status || 'normal') !== 'normal') return false;
        const label = String(item.displayTypeLabel || QUESTION_TYPES[item.type] || item.type || '未知题型');
        return label === wantedLabel;
      });
    } else {
      // 兼容旧进度和旧版配置中保存的核心题型值。异常题仍只进入“异常题”或“全部题型”。
      questions = questions.filter(item => (item.status || 'normal') === 'normal' && item.type === config.type);
    }
  }

  if (config.mode === 'wrong') {
    const wrong = recordStorage.getWrong(config.bankId);
    questions = questions.filter(item => wrong[item.id] && !wrong[item.id].mastered);
  } else if (config.mode === 'favorites') {
    const ids = recordStorage.getFavoriteIds(config.bankId);
    questions = questions.filter(item => ids.includes(item.id));
  }

  if (config.mode === 'memorize' && config.memorizeOrder === 'random'
    && Array.isArray(config.resumeQuestionSequence) && config.resumeQuestionSequence.length) {
    questions = reorderQuestionsBySavedSequence(questions, config.resumeQuestionSequence);
  } else if (config.mode === 'random' || config.mode === 'exam'
    || (config.mode === 'wrong' && config.wrongOrder === 'random')
    || (config.mode === 'memorize' && config.memorizeOrder === 'random')) {
    questions = shuffle(questions);
  }

  const settings = recordStorage.getSettings();
  const shuffleOptionsEnabled = config.shuffleOptions === undefined
    ? Boolean(settings.shuffleOptions)
    : Boolean(config.shuffleOptions);
  // 背题模式直接展示答案，保持原选项顺序更利于形成稳定记忆；随机背题只打乱题目，不打乱选项。
  if (shuffleOptionsEnabled && config.mode !== 'memorize') questions = questions.map(shuffleQuestionOptions);

  // 先在完整筛选结果中恢复作答状态，再根据“最后完成题”计算下一题。
  // 这样用户即使退出时停在前面的题，也不会覆盖真实完成进度。
  let restoredState = config.mode === 'sequence'
    ? restoreQuestionStates(questions, config.resumeQuestionStates || [])
    : { answers: {}, results: {} };
  const resumeCursor = config.resumeCursor && typeof config.resumeCursor === 'object'
    ? config.resumeCursor
    : {};
  let lastCompletedOrder = Math.max(
    Number(resumeCursor.lastCompletedOrder || 0),
    getFurthestCompletedOrder(questions, restoredState.results)
  );
  let initialIndex = config.mode === 'sequence'
    ? findResumeIndexAfterCompletion(questions, restoredState.results, lastCompletedOrder)
    : 0;
  if (config.mode === 'memorize' && config.resumeCursor) {
    initialIndex = findResumeIndex(questions, {
      resumeQuestionId: resumeCursor.questionId,
      resumeQuestionKey: resumeCursor.questionKey,
      resumeQuestionOrder: resumeCursor.questionOrder,
      resumeQuestionIndex: resumeCursor.index
    });
  }

  if (config.count && config.count > 0) {
    const limit = Number(config.count);
    if (config.mode === 'sequence' && initialIndex >= limit) {
      // 前一批指定数量题目已经完成时，从下一题开始新的连续批次。
      questions = questions.slice(initialIndex, initialIndex + limit);
      initialIndex = 0;
    } else if (config.mode === 'memorize' && config.memorizeOrder !== 'random' && config.resumeCursor) {
      // 顺序背题继续时，以保存位置作为本批起点；随机背题保留整段随机序列和当前位置。
      questions = questions.slice(initialIndex, initialIndex + limit);
      initialIndex = 0;
    } else {
      questions = questions.slice(0, limit);
      initialIndex = Math.min(initialIndex, Math.max(0, questions.length - 1));
    }
    restoredState = config.mode === 'sequence'
      ? restoreQuestionStates(questions, config.resumeQuestionStates || [])
      : { answers: {}, results: {} };
    lastCompletedOrder = Math.max(
      Number(resumeCursor.lastCompletedOrder || 0),
      getFurthestCompletedOrder(questions, restoredState.results)
    );
    if (config.mode === 'sequence') {
      initialIndex = findResumeIndexAfterCompletion(questions, restoredState.results, lastCompletedOrder);
    }
  }

  return {
    bankId: config.bankId,
    bankName: config.bankName || '',
    mode: config.mode || 'sequence',
    questions,
    index: initialIndex,
    answers: restoredState.answers,
    results: restoredState.results,
    lastCompletedOrder,
    startedAt: Date.now(),
    exam: config.mode === 'exam',
    memorize: config.mode === 'memorize',
    memorizeOrder: config.memorizeOrder || 'sequence',
    optionShuffleEnabled: Boolean(shuffleOptionsEnabled && config.mode !== 'memorize'),
    durationMinutes: config.durationMinutes || 0,
    practiceType: config.type || 'all',
    requestedCount: Number(config.count || 0),
    progressScopeKey: buildPracticeScopeKey(config.type || 'all', config.count || 0),
    memorizeScopeKey: buildMemorizeScopeKey(config.memorizeOrder || 'sequence', config.type || 'all', config.count || 0)
  };
}

function judgeQuestion(question, selected, selfScore = '') {
  if (question.type === 'short') {
    return {
      correct: selfScore === 'mastered',
      selfScore
    };
  }
  return {
    correct: sameAnswer(question.answer || [], selected || [])
  };
}

module.exports = {
  shuffle,
  sameAnswer,
  buildQuestionEditSignature,
  remapSelectedOptions,
  buildQuestionProgressKey,
  isCompletedResult,
  getQuestionAnswerStatus,
  getFurthestCompletedOrder,
  findResumeIndexAfterCompletion,
  buildPracticeScopeKey,
  buildMemorizeScopeKey,
  getMemorizeProgressCursor,
  getMemorizeQuestionSequence,
  buildMemorizeQuestionSequence,
  reorderQuestionsBySavedSequence,
  getProgressCursor,
  buildPersistedQuestionStates,
  mergePersistedQuestionStates,
  restoreQuestionStates,
  findResumeIndex,
  hasOrderDependentOption,
  shuffleQuestionOptions,
  restoreQuestionOptionOrder,
  applyOptionOrderPreference,
  createSession,
  judgeQuestion
};
