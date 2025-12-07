// ==UserScript==
// @name         WeLearn-Go
// @namespace    https://github.com/noxsk/WeLearn-Go
// @supportURL   https://github.com/noxsk/WeLearn-Go/issues
// @version      0.9.0
// @description  自动填写 WeLearn 练习答案，支持小错误生成、自动提交和批量任务执行！
// @author       Noxsk
// @match        https://welearn.sflep.com/*
// @match        http://welearn.sflep.com/*
// @match        https://centercourseware.sflep.com/*
// @match        http://centercourseware.sflep.com/*
// @match        https://*.sflep.com/*
// @run-at       document-end
// @grant        GM_addStyle
// @grant        GM_info
// ==/UserScript==

(function () {
  'use strict';

  // ==================== 配置常量 ====================
  // 从 UserScript 元数据获取版本号（避免重复定义）
  const VERSION = (typeof GM_info !== 'undefined' && GM_info.script?.version) || '0.0.0';
  const SUBMIT_DELAY_MS = 300;              // 提交前的延迟时间（毫秒）
  const PANEL_MIN_WIDTH = 340;              // 面板最小宽度
  const PANEL_MIN_HEIGHT = 180;             // 面板最小高度
  const PANEL_MAX_WIDTH = 540;              // 面板最大宽度
  const PANEL_MAX_HEIGHT = 460;             // 面板最大高度
  const PANEL_DEFAULT_WIDTH = 340;          // 面板默认宽度
  const PANEL_DEFAULT_HEIGHT = 280;         // 面板默认高度
  const MINIMIZED_PANEL_SIZE = 42;          // 最小化时的面板尺寸
  const PANEL_STATE_KEY = 'welearn_panel_state';        // 面板状态存储键
  const ONBOARDING_STATE_KEY = 'welearn_onboarding_state';  // 引导状态存储键
  const ERROR_STATS_KEY = 'welearn_error_stats';            // 错误统计存储键
  const ERROR_WEIGHTS_KEY = 'welearn_error_weights';        // 错误权重配置存储键
  const MAX_ERRORS_PER_PAGE = 2;            // 每页最多添加的小错误数量
  // 默认错误数量百分比配置：0个(50%) vs 1个(35%) vs 2个(15%)
  const DEFAULT_ERROR_WEIGHTS = { w0: 50, w1: 35, w2: 15 };
  const GROUP_WORK_PATTERN = /group\s*work/i;  // Group Work 匹配模式
  const DONATE_IMAGE_URL = 'https://ossimg.yzitc.com/2025/12/03/eb461afdde7b3.png';  // 微信赞赏码图片地址
  const DONATE_IMAGE_CACHE_KEY = 'welearn_donate_image_cache';  // 赞赏码图片缓存键
  const BATCH_COMPLETED_KEY = 'welearn_batch_completed';  // 批量任务已完成记录存储键
  const BATCH_MODE_KEY = 'welearn_batch_mode';  // 批量模式状态存储键
  const COURSE_DIRECTORY_CACHE_KEY = 'welearn_course_directory_cache';  // 课程目录缓存键
  const BATCH_TASKS_CACHE_KEY = 'welearn_batch_tasks_cache';  // 批量任务选择缓存键

  // ==================== 全局状态变量 ====================
  let lastKnownUrl = location.href;         // 记录上次的 URL，用于检测页面切换
  let groupWorkDetected = false;            // 是否检测到 Group Work
  let groupWorkNoticeShown = false;         // 是否已显示 Group Work 提示
  let openEndedExerciseShown = false;       // 是否已显示开放式练习提示
  let donateImageDataUrl = null;            // 缓存的赞赏码图片 Data URL
  let batchModeActive = false;              // 批量模式是否激活
  let batchTaskQueue = [];                  // 批量任务队列
  let currentBatchTask = null;              // 当前正在处理的批量任务
  let selectedBatchTasks = [];              // 用户选择的待执行任务
  let selectedCourseName = '';              // 选择任务时的课程名称
  
  /** 判断是否为 WeLearn 相关域名 */
  const isWeLearnHost = () => {
    const host = location.hostname;
    return host.includes('welearn.sflep.com') || 
           host.includes('centercourseware.sflep.com') ||
           host.endsWith('.sflep.com');
  };
  
  /** 判断当前是否在 iframe 中运行 */
  const isInIframe = () => {
    try {
      return window.self !== window.top;
    } catch (e) {
      return true; // 跨域时无法访问 top，说明在 iframe 中
    }
  };
  
  const getAccessibleDocuments = () => {
    const docs = [document];
    document.querySelectorAll('iframe').forEach((frame) => {
      try {
        if (frame.contentDocument) docs.push(frame.contentDocument);
      } catch (error) {
        /* Ignore cross-origin frames */
      }
    });
    return docs;
  };

  /** 检查页面是否包含练习元素 */
  const hasExerciseElements = () =>
    getAccessibleDocuments().some((doc) =>
      doc.querySelector(
        '[data-controltype="pagecontrol"], [data-controltype="filling"], [data-controltype="submit"], et-item, et-song, et-toggle, et-blank, .lrc, .dialog, .question-content, .exercise-content, iframe',
      ),
    );

  /** 判断当前是否为 WeLearn 练习页面 */
  const isWeLearnPage = () => isWeLearnHost() && hasExerciseElements();

  /** 分割答案字符串（支持多种分隔符：/、|、;、，、、） */
  const splitSolutions = (value) =>
    value
      .split(/[\/|;，、]/)
      .map((item) => item.trim())
      .filter(Boolean);

  /** 标准化文本（去空格、转大写，用于答案比对） */
  const normalizeText = (text) => (text ?? '').trim().toUpperCase();

  /**
   * 格式化答案文本
   * @param {string} text - 原始文本
   * @param {Object} options - 配置选项
   * @param {boolean} options.collapseLines - 是否合并多行为单行（用于 Group Work）
   */
  const formatSolutionText = (text = '', { collapseLines = false } = {}) => {
    if (collapseLines) {
      return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join(' ')
        .trim();
    }

    const lines = text.split(/\r?\n/);
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
    if (!nonEmptyLines.length) return text.trim();

    const baseIndent = nonEmptyLines.reduce((indent, line) => {
      const match = line.match(/^(\s*)/);
      const length = match ? match[1].length : 0;
      return indent === null ? length : Math.min(indent, length);
    }, null);

    return lines
      .map((line) => {
        if (!line.trim()) return '';
        const trimmedIndentLine = baseIndent ? line.slice(baseIndent) : line;
        return `  ${trimmedIndentLine.trimEnd()}`;
      })
      .join('\n')
      .trim();
  };

  /** 生成指定范围内的随机整数 */
  const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  /**
   * 带权重的随机选择
   * @param {Array<{value: any, weight: number}>} options - 选项数组，每个选项包含值和权重
   * @returns {any} 根据权重随机选中的值
   */
  const weightedRandom = (options) => {
    const totalWeight = options.reduce((sum, opt) => sum + opt.weight, 0);
    let random = Math.random() * totalWeight;
    
    for (const { value, weight } of options) {
      random -= weight;
      if (random <= 0) return value;
    }
    
    return options[options.length - 1].value;
  };

  // ==================== 错误统计管理 ====================

  /** 加载错误权重配置 */
  const loadErrorWeights = () => {
    try {
      const raw = localStorage.getItem(ERROR_WEIGHTS_KEY);
      return raw ? JSON.parse(raw) : { ...DEFAULT_ERROR_WEIGHTS };
    } catch (error) {
      console.warn('WeLearn autofill: failed to load error weights', error);
      return { ...DEFAULT_ERROR_WEIGHTS };
    }
  };

  /** 保存错误权重配置 */
  const saveErrorWeights = (weights) => {
    try {
      localStorage.setItem(ERROR_WEIGHTS_KEY, JSON.stringify(weights));
    } catch (error) {
      console.warn('WeLearn autofill: failed to save error weights', error);
    }
  };

  /** 获取当前错误权重数组（用于 weightedRandom） */
  const getErrorCountWeights = () => {
    const w = loadErrorWeights();
    return [
      { value: 0, weight: w.w0 },
      { value: 1, weight: w.w1 },
      { value: 2, weight: w.w2 },
    ];
  };

  /** 加载错误统计数据 */
  const loadErrorStats = () => {
    try {
      const raw = localStorage.getItem(ERROR_STATS_KEY);
      return raw ? JSON.parse(raw) : { count0: 0, count1: 0, count2: 0 };
    } catch (error) {
      console.warn('WeLearn autofill: failed to load error stats', error);
      return { count0: 0, count1: 0, count2: 0 };
    }
  };

  /** 保存错误统计数据 */
  const saveErrorStats = (stats) => {
    try {
      localStorage.setItem(ERROR_STATS_KEY, JSON.stringify(stats));
    } catch (error) {
      console.warn('WeLearn autofill: failed to save error stats', error);
    }
  };

  /** 更新错误统计并刷新显示 */
  const updateErrorStats = (errorCount) => {
    const stats = loadErrorStats();
    if (errorCount === 0) stats.count0++;
    else if (errorCount === 1) stats.count1++;
    else if (errorCount === 2) stats.count2++;
    saveErrorStats(stats);
    refreshErrorStatsDisplay();
    return stats;
  };

  /** 清空错误统计 */
  const clearErrorStats = () => {
    saveErrorStats({ count0: 0, count1: 0, count2: 0 });
    refreshErrorStatsDisplay();
  };

  /** 刷新面板上的统计显示 */
  const refreshErrorStatsDisplay = () => {
    const statsEl = document.querySelector('.welearn-error-stats');
    if (!statsEl) return;
    const stats = loadErrorStats();
    const total = stats.count0 + stats.count1 + stats.count2;
    if (total === 0) {
      statsEl.innerHTML = '统计：暂无数据';
    } else {
      const pct0 = ((stats.count0 / total) * 100).toFixed(0);
      const pct1 = ((stats.count1 / total) * 100).toFixed(0);
      const pct2 = ((stats.count2 / total) * 100).toFixed(0);
      statsEl.innerHTML = `统计：<b>${stats.count0}</b> <b>${stats.count1}</b> <b>${stats.count2}</b> (${pct0}%/${pct1}%/${pct2}%)`;
    }
  };

  /**
   * 高亮显示两个字符串的差异
   * 返回带 HTML 标记的字符串，红色表示修改的部分
   */
  const highlightDiff = (original, modified) => {
    let result = '';
    const maxLen = Math.max(original.length, modified.length);
    
    for (let i = 0; i < maxLen; i++) {
      const origChar = original[i] || '';
      const modChar = modified[i] || '';
      
      if (origChar !== modChar) {
        result += `<em>${modChar}</em>`;
      } else {
        result += modChar;
      }
    }
    
    return result;
  };

  // ==================== 小错误生成策略 ====================

  /**
   * 键盘相邻字母映射表（基于 QWERTY 键盘布局）
   * 每个字母映射到其键盘上相邻的、容易误触的字母
   */
  const ADJACENT_KEYS = {
    a: ['s', 'q', 'z'],
    b: ['v', 'n', 'g', 'h'],
    c: ['x', 'v', 'd', 'f'],
    d: ['s', 'f', 'e', 'r', 'c', 'x'],
    e: ['w', 'r', 'd', 's'],
    f: ['d', 'g', 'r', 't', 'v', 'c'],
    g: ['f', 'h', 't', 'y', 'b', 'v'],
    h: ['g', 'j', 'y', 'u', 'n', 'b'],
    i: ['u', 'o', 'k', 'j'],
    j: ['h', 'k', 'u', 'i', 'm', 'n'],
    k: ['j', 'l', 'i', 'o', 'm'],
    l: ['k', 'o', 'p'],
    m: ['n', 'j', 'k'],
    n: ['b', 'm', 'h', 'j'],
    o: ['i', 'p', 'k', 'l'],
    p: ['o', 'l'],
    q: ['w', 'a'],
    r: ['e', 't', 'd', 'f'],
    s: ['a', 'd', 'w', 'e', 'x', 'z'],
    t: ['r', 'y', 'f', 'g'],
    u: ['y', 'i', 'h', 'j'],
    v: ['c', 'b', 'f', 'g'],
    w: ['q', 'e', 'a', 's'],
    x: ['z', 'c', 's', 'd'],
    y: ['t', 'u', 'g', 'h'],
    z: ['a', 's', 'x'],
  };

  /**
   * 常见的可交换字母对（非首字母位置）
   * 这些是打字时容易顺序颠倒的字母组合
   */
  const SWAPPABLE_PAIRS = ['ea', 'ae', 'ei', 'ie', 'ou', 'uo', 'er', 're', 'ru', 'ur', 'ti', 'it', 'th', 'ht', 'io', 'oi', 'an', 'na', 'en', 'ne', 'al', 'la'];

  /**
   * 错误类型1：键盘相邻字母拼写错误
   * 在单词中间（非首尾）将一个字母替换为键盘上相邻的字母
   */
  const makeAdjacentKeyMistake = (text) => {
    const words = text.split(/\s+/);
    // 筛选长度大于3的英文单词（确保有中间字母可替换）
    const candidates = words
      .map((word, index) => ({ word, index }))
      .filter(({ word }) => /^[a-z]+$/i.test(word) && word.length > 3);

    if (!candidates.length) return '';

    const { word, index: wordIndex } = candidates[randomInt(0, candidates.length - 1)];
    // 只在中间位置（非首尾）进行替换
    const charIndex = randomInt(1, word.length - 2);
    const originalChar = word[charIndex].toLowerCase();
    const adjacentChars = ADJACENT_KEYS[originalChar];

    if (!adjacentChars || !adjacentChars.length) return '';

    const replacement = adjacentChars[randomInt(0, adjacentChars.length - 1)];
    // 保持原始大小写
    const finalReplacement = word[charIndex] === word[charIndex].toUpperCase()
      ? replacement.toUpperCase()
      : replacement;

    const newWord = word.slice(0, charIndex) + finalReplacement + word.slice(charIndex + 1);
    words[wordIndex] = newWord;
    return words.join(' ');
  };

  /**
   * 错误类型2：字母顺序颠倒
   * 将单词中常见的字母对顺序颠倒（如 ea -> ae, ru -> ur）
   * 注意：不在首字母位置进行交换，且只处理纯字母单词（排除括号、斜杠等特殊字符）
   */
  const makeLetterSwapMistake = (text) => {
    const words = text.split(/\s+/);
    const candidates = [];

    // 查找包含可交换字母对的单词
    words.forEach((word, wordIndex) => {
      // 跳过长度不足的单词
      if (word.length < 3) return;
      // 只处理纯字母单词，排除包含 ()、/、数字等特殊字符的单词
      if (!/^[a-z]+$/i.test(word)) return;
      
      const lowerWord = word.toLowerCase();

      SWAPPABLE_PAIRS.forEach((pair) => {
        // 从位置1开始搜索，确保字母对不在首字母位置
        const pairIndex = lowerWord.indexOf(pair, 1);
        if (pairIndex > 0) { // 确保不在首字母位置（交换后首字母不会变）
          candidates.push({ word, wordIndex, pairIndex, pair });
        }
      });
    });

    if (!candidates.length) return '';

    const { word, wordIndex, pairIndex, pair } = candidates[randomInt(0, candidates.length - 1)];
    // 交换字母对
    const swapped = pair[1] + pair[0];
    // 保持原始大小写
    let finalSwapped = '';
    for (let i = 0; i < 2; i++) {
      const origChar = word[pairIndex + i];
      const newChar = swapped[i];
      finalSwapped += origChar === origChar.toUpperCase() ? newChar.toUpperCase() : newChar;
    }

    const newWord = word.slice(0, pairIndex) + finalSwapped + word.slice(pairIndex + 2);
    words[wordIndex] = newWord;
    return words.join(' ');
  };

  /**
   * 错误类型3：句子首字母大小写错误
   * 将句子首字母的大小写切换
   */
  const makeCapitalizationMistake = (text) => {
    const trimmed = text.trim();
    if (!trimmed.length) return '';

    // 检查是否像句子（以字母开头）
    const firstChar = trimmed[0];
    if (!/[a-z]/i.test(firstChar)) return '';

    // 切换首字母大小写
    const toggledFirst = firstChar === firstChar.toUpperCase()
      ? firstChar.toLowerCase()
      : firstChar.toUpperCase();

    return toggledFirst + trimmed.slice(1);
  };

  /**
   * 错误类型4：句子末尾标点符号错误
   * 删除或添加句子末尾的标点符号
   */
  const makePunctuationMistake = (text) => {
    const trimmed = text.trimEnd();
    if (!trimmed.length) return '';

    const trailingSpaces = text.slice(trimmed.length);
    const endsWithPunctuation = /[.!?]$/.test(trimmed);

    if (endsWithPunctuation) {
      // 删除末尾标点
      return trimmed.slice(0, -1) + trailingSpaces;
    } else {
      // 检查是否像句子（以大写字母开头，且有一定长度）
      if (trimmed.length > 10 && /^[A-Z]/.test(trimmed)) {
        // 添加句号
        return trimmed + '.' + trailingSpaces;
      }
    }

    return '';
  };

  /**
   * 错误类型名称映射
   */
  const MISTAKE_TYPE_NAMES = {
    adjacentKey: '键盘误触',
    letterSwap: '字母顺序',
    capitalization: '大小写',
    punctuation: '标点',
  };

  /**
   * 提取变化的单词（用于错误显示）
   */
  const findChangedWord = (original, modified) => {
    const origWords = original.split(/\s+/);
    const modWords = modified.split(/\s+/);
    
    // 找到变化的单词
    for (let i = 0; i < origWords.length; i++) {
      if (origWords[i] !== modWords[i]) {
        return { original: origWords[i], modified: modWords[i] };
      }
    }
    
    // 如果是整体变化（如首字母大小写、标点），截取前15个字符
    const len = Math.min(15, original.length);
    return {
      original: original.slice(0, len) + (original.length > len ? '...' : ''),
      modified: modified.slice(0, len) + (modified.length > len ? '...' : ''),
    };
  };

  /**
   * 创建错误生成器
   * @param {boolean} enabled - 是否启用错误生成
   * @returns {Object} 包含 mutate 函数和 getErrors 方法的对象
   */
  const createMistakeMutator = (enabled) => {
    if (!enabled) {
      return {
        mutate: (value) => value,
        getErrors: () => [],
        getTargetCount: () => 0,
      };
    }

    const errors = [];
    // 按用户配置的权重随机选择错误数量
    const targetCount = weightedRandom(getErrorCountWeights());
    let remaining = targetCount;

    // 策略列表
    const strategies = [
      { fn: makeAdjacentKeyMistake, type: 'adjacentKey' },
      { fn: makeLetterSwapMistake, type: 'letterSwap' },
      { fn: makeCapitalizationMistake, type: 'capitalization' },
      { fn: makePunctuationMistake, type: 'punctuation' },
    ];

    const mutate = (value) => {
      if (remaining <= 0) return value;

      // Fisher-Yates 洗牌
      for (let i = strategies.length - 1; i > 0; i--) {
        const j = randomInt(0, i);
        [strategies[i], strategies[j]] = [strategies[j], strategies[i]];
      }

      for (const { fn, type } of strategies) {
        const next = fn(value);
        if (next && next !== value) {
          remaining--;
          const changed = findChangedWord(value, next);
          errors.push({
            type: MISTAKE_TYPE_NAMES[type],
            ...changed,
          });
          return next;
        }
      }

      return value;
    };

    return { mutate, getErrors: () => errors, getTargetCount: () => targetCount };
  };

  // ==================== 答案填充逻辑 ====================

  /**
   * 规范化答案文本，清理多余的换行和空格
   * 将多个连续空白字符（包括换行）合并为单个空格
   */
  const normalizeAnswer = (text) => {
    if (!text) return '';
    return text
      .replace(/\s+/g, ' ')  // 将所有连续空白字符（包括换行、制表符）替换为单个空格
      .trim();
  };

  /**
   * 清理 Group Work 类型答案的前缀
   * 移除 "(Answers may vary.)" 等提示语
   */
  const cleanGroupWorkAnswer = (text) => {
    if (!text) return '';
    return text
      // 移除 "(Answers may vary.)" 及其变体
      .replace(/\(?\s*Answers?\s+may\s+vary\.?\s*\)?/gi, '')
      // 移除 "(Sample answer)" 等
      .replace(/\(?\s*Sample\s+answers?\.?\s*\)?/gi, '')
      // 移除 "(Reference answer)" 等
      .replace(/\(?\s*Reference\s+answers?\.?\s*\)?/gi, '')
      // 移除 "(Suggested answer)" 等
      .replace(/\(?\s*Suggested\s+answers?\.?\s*\)?/gi, '')
      // 移除开头的空白
      .trim();
  };

  /** 从容器中读取正确答案 */
  const readSolution = (input, container) => {
    const resultNode = container.querySelector('[data-itemtype="result"]');
    let resultText = resultNode?.textContent;
    
    if (resultText) {
      // 对于 fillinglong（主观题），清理前缀
      const isLongFilling = container.getAttribute('data-controltype') === 'fillinglong';
      if (isLongFilling) {
        resultText = cleanGroupWorkAnswer(resultText);
      }
      return normalizeAnswer(resultText);
    }

    const solutionFromInput = input?.dataset?.solution;
    if (!solutionFromInput) return '';

    const normalized = normalizeAnswer(solutionFromInput);
    const candidates = splitSolutions(normalized);
    return candidates[0] ?? '';
  };

  /** 填充填空题 */
  const fillFillingItem = (container, mutateAnswer) => {
    const input = container.querySelector('[data-itemtype="input"], [data-itemtype="textarea"]');
    if (!input) {
      console.debug('[WeLearn-Go] fillFillingItem: 找不到 input 元素', container.outerHTML?.slice(0, 100));
      return false;
    }
    
    // 获取控件类型
    const controlType = container.getAttribute('data-controltype');
    console.debug('[WeLearn-Go] fillFillingItem:', { controlType, tagName: input.tagName, id: container.getAttribute('data-id') });
    
    // 对于主观题（fillinglong），检查是否有实质性答案
    if (controlType === 'fillinglong') {
      // 获取原始答案文本
      const resultEl = container.querySelector('[data-itemtype="result"]');
      const rawAnswer = resultEl?.textContent?.trim() || '';
      
      // 检查是否只有 "Answers may vary" 类的占位文本
      const cleanedAnswer = cleanGroupWorkAnswer(rawAnswer);
      if (!cleanedAnswer) {
        // 没有实质性答案，跳过填充（留空）
        console.info('[WeLearn-Go] fillinglong 无实质答案，跳过:', rawAnswer.slice(0, 50));
        return false;
      }
      console.debug('[WeLearn-Go] fillinglong 有实质答案，继续填充');
    }
    
    const solution = readSolution(input, container);
    if (!solution) {
      console.debug('[WeLearn-Go] fillFillingItem: 无法读取答案');
      return false;
    }
    console.debug('[WeLearn-Go] fillFillingItem: 读取到答案:', solution.slice(0, 50));
    
    const finalValue = mutateAnswer(solution);
    const formattedValue =
      input.tagName === 'TEXTAREA'
        ? formatSolutionText(finalValue, { collapseLines: groupWorkDetected })
        : finalValue.trim();
    if (input.value.trim() === formattedValue) {
      console.debug('[WeLearn-Go] fillFillingItem: 值已相同，跳过');
      return false;
    }
    input.value = formattedValue;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    console.debug('[WeLearn-Go] fillFillingItem: 填充成功');
    return true;
  };

  /** 选择选项（单选/多选） */
  const selectChoiceOption = (option) => {
    const input = option.querySelector('input[type="radio"], input[type="checkbox"]');
    if (input) {
      if (input.checked) return false;
      input.click();
      return true;
    }

    const wasSelected = option.classList.contains('selected') || option.getAttribute('aria-checked') === 'true';
    option.click();
    return !wasSelected;
  };

  /** 查找正确答案选项 */
  const findChoiceSolutions = (options, container) => {
    const optionsWithSolution = options.filter((item) => item.hasAttribute('data-solution'));
    if (optionsWithSolution.length) return optionsWithSolution;

    const extractCandidates = (raw) => splitSolutions(raw || '').map(normalizeText);

    const candidates = [
      ...extractCandidates(container.querySelector('[data-itemtype="result"]')?.textContent),
      ...extractCandidates(container.dataset?.solution),
    ];

    if (!candidates.length) return [];

    return options.filter((item) => {
      const optionText = normalizeText(item.textContent);
      const optionSolution = normalizeText(item.dataset?.solution);
      return candidates.includes(optionText) || candidates.includes(optionSolution);
    });
  };

  /** 填充选择题（单选/多选） */
  const fillChoiceItem = (container) => {
    const options = Array.from(container.querySelectorAll('ul[data-itemtype="options"] > li'));
    if (!options.length) return false;

    const matchedOptions = findChoiceSolutions(options, container);
    if (!matchedOptions.length) return false;

    const isCheckboxGroup = options.some((item) => item.querySelector('input[type="checkbox"]'));
    if (isCheckboxGroup) {
      return matchedOptions.reduce((changed, option) => selectChoiceOption(option) || changed, false);
    }

    return selectChoiceOption(matchedOptions[0]);
  };

  // ==================== AngularJS 组件适配（et-* 系列） ====================

  // 点击选择类型的填充队列（串行执行避免选项面板冲突）
  const clickFillQueue = [];
  let isProcessingClickQueue = false;
  let clickQueueSchedulerId = null;

  const scheduleClickQueueProcessing = () => {
    if (clickQueueSchedulerId !== null) return;

    const run = () => {
      clickQueueSchedulerId = null;
      processClickFillQueue();
    };

    if (typeof requestAnimationFrame === 'function') {
      clickQueueSchedulerId = requestAnimationFrame(run);
    } else {
      clickQueueSchedulerId = setTimeout(run, 0);
    }
  };

  /**
   * 处理点击填充队列
   */
  const processClickFillQueue = async () => {
    console.info('[WeLearn-Go] processClickFillQueue: 被调用', { 
      isProcessingClickQueue, 
      queueLength: clickFillQueue.length 
    });
    
    if (isProcessingClickQueue || clickFillQueue.length === 0) {
      return;
    }
    
    console.info('[WeLearn-Go] processClickFillQueue: 开始处理队列');
    isProcessingClickQueue = true;
    
    while (clickFillQueue.length > 0) {
      const { container, solution } = clickFillQueue.shift();
      console.info('[WeLearn-Go] processClickFillQueue: 处理队列项', { 
        solution, 
        id: container.id,
        remaining: clickFillQueue.length
      });
      await doFillEtBlankByClick(container, solution);
      // 给 AngularJS 一点时间完成 digest
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    isProcessingClickQueue = false;
    console.info('[WeLearn-Go] processClickFillQueue: 队列处理完成');
  };

  /**
   * 从答案中提取纯文本（去除选项字母前缀如 "A. "、"B. " 等）
   * @param {string} solution - 完整答案（如 "D. open"）
   * @returns {string} 纯文本答案（如 "open"）
   */
  const extractPureAnswer = (solution) => {
    // 匹配格式：字母 + 点/括号 + 可选空格 + 答案内容
    // 如 "A. open", "B) answer", "C answer" 等
    const match = solution.match(/^[A-Za-z][.\)]\s*(.+)$/);
    return match ? match[1].trim() : solution;
  };

  /**
   * 检查选项文本是否与答案匹配
   * 支持完整匹配（如 "D. open" === "D. open"）
   * 以及去除前缀后的匹配（如 "open" 匹配 "D. open"）
   * @param {string} optionText - 选项文本
   * @param {string} solution - 答案
   * @returns {boolean} 是否匹配
   */
  const isOptionMatch = (optionText, solution) => {
    const normalizedOpt = normalizeAnswer(optionText);
    const normalizedSol = normalizeAnswer(solution);
    
    // 完全匹配
    if (normalizedOpt === normalizedSol) return true;
    
    // 去除前缀后匹配
    const pureAnswer = extractPureAnswer(normalizedSol);
    if (normalizedOpt === normalizeAnswer(pureAnswer)) return true;
    
    // 选项可能也带前缀，去除后比较
    const pureOption = extractPureAnswer(normalizedOpt);
    if (pureOption === normalizeAnswer(pureAnswer)) return true;
    
    return false;
  };

  /**
   * 实际执行点击选项填充 et-blank
   * 直接修改 DOM 内容，不依赖 AngularJS
   * @param {Element} container - et-blank 容器元素
   * @param {string} solution - 答案
   * @returns {Promise<boolean>} 是否成功填充
   */
  const doFillEtBlankByClick = (container, solution) => {
    console.info('[WeLearn-Go] doFillEtBlankByClick: 开始处理', { solution, id: container.id });
    
    return new Promise((resolve) => {
      const blankEl = container.querySelector('span.blank');
      
      if (!blankEl) {
        console.warn('[WeLearn-Go] doFillEtBlankByClick: 未找到 blank 元素');
        resolve(false);
        return;
      }
      
      const doc = container.ownerDocument || document;
      
      // 步骤1: 点击 blank 元素激活 optionsPicker
      console.info('[WeLearn-Go] doFillEtBlankByClick: 点击 blank 激活选项', { id: container.id });
      blankEl.click();
      
      // 步骤2: 等待 optionsPicker 出现，然后点击对应选项
      setTimeout(() => {
        // 查找可见的 optionsPicker
        const picker = doc.querySelector('.optionsPicker.visible') || doc.querySelector('.optionsPicker');
        
        if (!picker) {
          console.warn('[WeLearn-Go] doFillEtBlankByClick: 未找到 optionsPicker');
          // 回退方案：直接设置文本
          blankEl.textContent = solution;
          resolve(true);
          return;
        }
        
        // 查找匹配的选项
        const pickerItems = picker.querySelectorAll('li[option]');
        let targetOption = null;
        
        for (const li of pickerItems) {
          const optionText = li.textContent?.trim();
          // 精确匹配或者去掉字母前缀后匹配
          if (optionText === solution || isOptionMatch(optionText, solution)) {
            // 跳过已使用的选项
            if (!li.classList.contains('used')) {
              targetOption = li;
              break;
            }
          }
        }
        
        if (targetOption) {
          console.info('[WeLearn-Go] doFillEtBlankByClick: 点击选项', { 
            option: targetOption.textContent?.trim(),
            solution
          });
          targetOption.click();
          resolve(true);
        } else {
          console.warn('[WeLearn-Go] doFillEtBlankByClick: 未找到匹配的选项', { 
            solution, 
            available: Array.from(pickerItems).map(li => li.textContent?.trim())
          });
          // 回退方案：直接设置文本
          blankEl.textContent = solution;
          resolve(true);
        }
      }, 100); // 等待 optionsPicker 出现
    });
  };

  /**
   * 通过点击选项填充 et-blank（用于带有 noinput 属性的选择题）
   * @param {Element} container - et-blank 容器元素
   * @param {string} solution - 答案
   * @returns {boolean} 是否成功填充（加入队列）
   */
  const fillEtBlankByClick = (container, solution) => {
    // 获取当前值
    const blankEl = container.querySelector('span.blank');
    if (blankEl) {
      const currentValue = blankEl.textContent?.trim() || '';
      const isAlreadyFilled = isOptionMatch(currentValue, solution);
      console.info('[WeLearn-Go] fillEtBlankByClick: 检查', { 
        currentValue, 
        solution, 
        match: isAlreadyFilled,
        id: container.id
      });
      if (isAlreadyFilled) {
        return false; // 已填充
      }
    }
    
    console.info('[WeLearn-Go] fillEtBlankByClick: 加入队列', { solution, id: container.id });
    
    // 加入队列
    clickFillQueue.push({ container, solution });
    console.info('[WeLearn-Go] fillEtBlankByClick: 队列长度', clickFillQueue.length);
    
    // 调度处理队列
    scheduleClickQueueProcessing();
    
    return true;
  };

  /**
   * 填充 et-blank 填空题
   * 答案可能在以下位置：
   * 1. et-blank 内部的 span.key 元素
   * 2. et-blank 父级容器的兄弟元素 .visible-box 中（句型练习题）
   * 支持两种输入方式：
   * - 普通输入：textarea, input, contenteditable
   * - 点击选择：带有 noinput 属性，需要点击 et-options 中的选项
   * 
   * 答案来源（按优先级）：
   * 1. et-blank 内部的 span.key 元素（WELearnHelper 方式，用 | 分隔多选项）
   * 2. 父级的 .visible-box 元素
   * 3. g 属性
   * 4. 全局上下文
   * 
   * @param {Element} container - et-blank 容器元素
   * @param {Function} mutateAnswer - 答案变异函数（用于生成小错误）
   * @returns {boolean} 是否成功填充
   */
  const fillEtBlank = (container, mutateAnswer) => {
    let solution = '';
    
    // 方法1: 查找 et-blank 内部的 span.key 或 .key 元素（WELearnHelper 的核心方式）
    const keyEl = container.querySelector('span.key, .key');
    if (keyEl) {
      // WELearnHelper: 答案可能用 | 分隔多个选项，取第一个
      const rawText = keyEl.textContent || '';
      solution = normalizeAnswer(rawText.split('|')[0]);
    }
    
    // 方法2: 查找父级容器的兄弟元素 .visible-box（句型练习题）
    if (!solution) {
      // 向上查找包含 et-blank 的容器（通常是 div[et-stem-index] 或直接父级）
      const stemContainer = container.closest('[et-stem-index]') || container.parentElement?.parentElement;
      if (stemContainer) {
        const visibleBox = stemContainer.querySelector('.visible-box');
        if (visibleBox) {
          solution = normalizeAnswer(visibleBox.textContent);
          console.debug('[WeLearn-Go] fillEtBlank: 从 .visible-box 获取答案');
        }
      }
    }
    
    // 方法3: 查找同级的 .visible-box
    if (!solution && container.parentElement) {
      const sibling = container.parentElement.querySelector('.visible-box');
      if (sibling) {
        solution = normalizeAnswer(sibling.textContent);
        console.debug('[WeLearn-Go] fillEtBlank: 从同级 .visible-box 获取答案');
      }
    }
    
    // 方法4: 从 g 属性获取答案（某些题型的答案存储在此）
    if (!solution) {
      const gAttr = container.getAttribute('g');
      if (gAttr && gAttr.trim()) {
        try {
          // g 属性可能是 JSON 或纯文本
          const parsed = JSON.parse(gAttr);
          if (typeof parsed === 'string') {
            solution = normalizeAnswer(parsed);
          } else if (parsed.answer || parsed.key) {
            solution = normalizeAnswer(parsed.answer || parsed.key);
          }
        } catch {
          // 不是 JSON，直接使用
          solution = normalizeAnswer(gAttr);
        }
        if (solution) {
          console.debug('[WeLearn-Go] fillEtBlank: 从 g 属性获取答案');
        }
      }
    }
    
    // 方法5: 从全局上下文获取答案
    if (!solution) {
      const globalAnswer = findAnswerFromGlobalContext(container);
      if (globalAnswer) {
        solution = normalizeAnswer(globalAnswer);
        console.debug('[WeLearn-Go] fillEtBlank: 从全局上下文获取答案');
      }
    }
    
    if (!solution) {
      // 检测是否为开放式无答案练习（g="" 且 noprogress）
      const gAttr = container.getAttribute('g');
      const isOpenEnded = gAttr === '' || gAttr === null;
      const hasNoprogress = container.hasAttribute('noprogress');
      
      if (isOpenEnded && hasNoprogress) {
        console.info('[WeLearn-Go] fillEtBlank: 跳过开放式练习（无标准答案）', container.id);
      } else {
        console.debug('[WeLearn-Go] fillEtBlank: 未找到答案', container.outerHTML?.substring(0, 200));
      }
      return false;
    }

    // 检查是否为点击选择类型（带有 noinput 属性）
    const isNoInput = container.hasAttribute('noinput');
    
    console.info('[WeLearn-Go] fillEtBlank: 处理', { 
      isNoInput, 
      solution: solution.substring(0, 30),
      id: container.id
    });
    
    if (isNoInput) {
      // 点击选择类型：需要先点击 blank 激活，然后点击对应的选项
      return fillEtBlankByClick(container, solution);
    }

    // 普通输入类型：查找输入区域（优先真实输入元素）
    const textInputSelector = 'textarea, [contenteditable], input.blank, input[type="text"]';
    let inputEl = container.querySelector(textInputSelector);

    if (!inputEl) {
      const etItem = container.closest('et-item');
      if (etItem) {
        const candidateInputs = Array.from(etItem.querySelectorAll(textInputSelector))
          .filter((el) => !el.closest('et-blank'));
        if (candidateInputs.length) {
          const blanksNeedingExternal = Array.from(etItem.querySelectorAll('et-blank'))
            .filter((blank) => !blank.querySelector(textInputSelector));
          const externalIndex = blanksNeedingExternal.indexOf(container);
          if (externalIndex > -1) {
            inputEl = candidateInputs[externalIndex] || null;
          }
        }
      }
    }

    if (!inputEl) {
      const scopeDoc = container.ownerDocument || document;
      inputEl = scopeDoc.querySelector(`[data-blank-id="${container.id}"]`) ||
                scopeDoc.querySelector(`[blank-id="${container.id}"]`) ||
                scopeDoc.querySelector(`[data-target="${container.id}"]`);
    }

    console.info('[WeLearn-Go] fillEtBlank: 查找输入元素', { 
      found: !!inputEl, 
      tagName: inputEl?.tagName,
      hasContentEditable: inputEl ? inputEl.hasAttribute?.('contenteditable') : false,
      containerHTML: container.innerHTML?.substring(0, 300)
    });
    if (!inputEl) {
      console.info('[WeLearn-Go] fillEtBlank: 未找到输入元素');
      return false;
    }

    const finalValue = mutateAnswer(solution);
    
    // 获取当前值（根据元素类型）
    const isContentEditable = inputEl.hasAttribute('contenteditable');
    const currentValue = (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') && !isContentEditable
      ? normalizeAnswer(inputEl.value)
      : normalizeAnswer(inputEl.textContent);
    
    // 如果已填充相同答案，跳过
    if (currentValue === finalValue) {
      console.info('[WeLearn-Go] fillEtBlank: 已填充相同答案，跳过', { currentValue, finalValue });
      return false;
    }

    // WELearnHelper 的事件触发策略：
    // 输入前事件序列
    const triggerReadyEvents = (el) => {
      try {
        el.click?.();
        el.focus?.();
        el.dispatchEvent(new Event('click', { bubbles: true }));
        el.dispatchEvent(new Event('focus', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (e) { /* 忽略 */ }
    };
    
    // 输入后事件序列
    const triggerCompleteEvents = (el) => {
      try {
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        
        // AngularJS 事件触发
        const win = el.ownerDocument?.defaultView || window;
        const angular = win.angular;
        if (angular) {
          angular.element(el).triggerHandler?.('hover');
          angular.element(el).triggerHandler?.('keyup');
          angular.element(el).triggerHandler?.('blur');
        }
      } catch (e) { /* 忽略 */ }
    };

    // 填充答案 - 根据元素类型选择正确的方式
    console.debug('[WeLearn-Go] fillEtBlank: 填充', { solution: solution.substring(0, 50), inputEl: inputEl.tagName, isContentEditable });
    
    // 触发准备事件
    triggerReadyEvents(inputEl);
    
    if ((inputEl.tagName === 'INPUT' || inputEl.tagName === 'TEXTAREA') && !isContentEditable) {
      inputEl.value = finalValue;
    } else {
      // contenteditable 或 span 元素 (WELearnHelper 使用 span.blank)
      inputEl.textContent = finalValue;
    }
    
    // 触发完成事件
    triggerCompleteEvents(inputEl);
    
    // 尝试触发 AngularJS 的数据绑定更新
    try {
      const win = inputEl.ownerDocument?.defaultView || window;
      const ngModelController = win.angular?.element(inputEl)?.controller('ngModel');
      if (ngModelController) {
        ngModelController.$setViewValue(finalValue);
        ngModelController.$render();
      }
      // 触发 AngularJS 的 $apply
      const scope = win.angular?.element(inputEl)?.scope();
      if (scope && scope.$apply) {
        scope.$apply();
      }
    } catch (e) { /* 忽略 AngularJS 相关错误 */ }

    return true;
  };

  /**
   * 填充 et-multi-noinput 多选题
   * 有两种模式：
   * 1. 选择填空模式：点击 span.multi-noinput 激活 multiOptionsPicker 浮窗，然后选择选项
   * 2. 直接选择模式：直接点击 et-multi-options 中的选项
   * 答案存储在 span.key 中（格式如 "B,I,D,K,E"）
   * @param {Element} container - et-multi-noinput 容器元素或其父容器
   * @returns {boolean} 是否成功填充
   */
  const fillEtMultiNoinput = (container) => {
    // 查找答案：在 span.key 元素中
    const keyEl = container.querySelector('span.key');
    if (!keyEl) return false;
    
    const solutionText = keyEl.textContent?.trim();
    if (!solutionText) return false;

    // 解析正确答案（格式如 "B,I,D,K,E"）
    const correctOptions = solutionText.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (!correctOptions.length) return false;

    // 检查是否为选择填空模式（有 span.multi-noinput）
    const multiNoinputSpan = container.querySelector('span.multi-noinput');
    if (multiNoinputSpan) {
      // 选择填空模式：需要点击激活浮窗，然后依次选择选项
      console.info('[WeLearn-Go] fillEtMultiNoinput: 选择填空模式', { 
        id: container.id, 
        correctOptions 
      });
      
      // 加入异步队列处理
      fillMultiNoinputByClick(container, correctOptions);
      return true;
    }

    // 直接选择模式：查找 et-multi-options 中的选项列表
    const optionsContainer = container.closest('et-item')?.querySelector('et-multi-options ul') ||
                             container.parentElement?.querySelector('et-multi-options ul');
    if (!optionsContainer) return false;

    const optionItems = Array.from(optionsContainer.querySelectorAll('li'));
    let changed = false;

    optionItems.forEach((li) => {
      // 提取选项字母（通常在 li 开头，如 "A. ..."）
      const optionMatch = li.textContent?.trim().match(/^([A-Z])\./i);
      if (!optionMatch) return;
      
      const optionLetter = optionMatch[1].toUpperCase();
      const shouldBeSelected = correctOptions.includes(optionLetter);
      const isCurrentlySelected = li.classList.contains('selected') || 
                                  li.classList.contains('used') ||
                                  li.getAttribute('aria-checked') === 'true';

      // 如果选中状态需要改变
      if (shouldBeSelected !== isCurrentlySelected) {
        li.click();
        changed = true;
      }
    });

    return changed;
  };

  /**
   * 通过点击选项填充 et-multi-noinput（选择填空模式）
   * 需要先点击 span.multi-noinput 激活浮窗，然后依次点击所有正确选项
   * @param {Element} container - et-multi-noinput 容器元素
   * @param {string[]} correctOptions - 正确选项字母数组，如 ['B', 'I', 'D', 'K', 'E']
   */
  const fillMultiNoinputByClick = async (container, correctOptions) => {
    const multiNoinputSpan = container.querySelector('span.multi-noinput');
    if (!multiNoinputSpan) return;

    const doc = container.ownerDocument || document;
    
    console.info('[WeLearn-Go] fillMultiNoinputByClick: 开始处理', { 
      id: container.id, 
      correctOptions 
    });

    // 步骤1: 点击 multi-noinput 激活浮窗
    multiNoinputSpan.click();
    
    // 等待浮窗出现
    await new Promise(resolve => setTimeout(resolve, 200));

    // 步骤2: 查找浮窗 - 浮窗在 et-item 之后的同级位置
    // 先尝试查找可见的浮窗
    let picker = doc.querySelector('.multiOptionsPicker.visible');
    
    // 如果没找到可见的，尝试查找任意浮窗
    if (!picker) {
      picker = doc.querySelector('.multiOptionsPicker');
    }
    
    // 如果还是没找到，尝试在 body 级别查找（有时浮窗会被移到 body 下）
    if (!picker) {
      picker = doc.body?.querySelector('.multiOptionsPicker');
    }
    
    if (!picker) {
      console.warn('[WeLearn-Go] fillMultiNoinputByClick: 未找到 multiOptionsPicker');
      return;
    }

    console.info('[WeLearn-Go] fillMultiNoinputByClick: 找到浮窗', { 
      visible: picker.classList.contains('visible'),
      optionsCount: picker.querySelectorAll('li[preoption]').length
    });

    const pickerItems = picker.querySelectorAll('li[preoption]');
    
    // 依次点击每个正确选项
    for (const optionLetter of correctOptions) {
      // 每次点击前，重新点击 multi-noinput 确保浮窗激活
      multiNoinputSpan.click();
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // 重新获取浮窗（因为可能会重新渲染）
      const currentPicker = doc.querySelector('.multiOptionsPicker.visible') || 
                            doc.querySelector('.multiOptionsPicker');
      if (!currentPicker) {
        console.warn('[WeLearn-Go] fillMultiNoinputByClick: 浮窗消失了');
        continue;
      }
      
      const currentItems = currentPicker.querySelectorAll('li[preoption]');
      
      for (const li of currentItems) {
        const optionMatch = li.textContent?.trim().match(/^([A-Z])\./i);
        if (optionMatch && optionMatch[1].toUpperCase() === optionLetter) {
          // 检查是否已被选中（有 used class）
          if (!li.classList.contains('used')) {
            console.info('[WeLearn-Go] fillMultiNoinputByClick: 点击选项', optionLetter);
            li.click();
            // 等待系统处理
            await new Promise(resolve => setTimeout(resolve, 100));
          } else {
            console.info('[WeLearn-Go] fillMultiNoinputByClick: 选项已使用，跳过', optionLetter);
          }
          break;
        }
      }
    }

    console.info('[WeLearn-Go] fillMultiNoinputByClick: 完成', { id: container.id });
  };

  /**
   * 检测并处理 et-song 类型（朗读/引用音频练习）
   * 这种类型通常是无需交互的阅读材料，标记为 notscored
   * @param {Element} container - et-item 容器元素
   * @returns {boolean} 是否为 et-song 类型
   */
  const isEtSongItem = (container) => {
    return container.querySelector('et-song') !== null;
  };

  /**
   * 检测是否为开放式练习（无标准答案，需要用户自行填写）
   * 特征：et-blank 的 g 属性为空，且没有任何答案来源（.key 元素或 .visible-box）
   * @param {Element} container - et-item 容器元素
   * @returns {boolean} 是否为开放式练习
   */
  const isOpenEndedItem = (container) => {
    const blanks = container.querySelectorAll('et-blank');
    if (blanks.length === 0) return false;
    
    // 检查是否所有 et-blank 都没有答案来源
    const allBlanksEmpty = Array.from(blanks).every(blank => {
      // 检查 g 属性
      const gAttr = blank.getAttribute('g');
      if (gAttr && gAttr.trim()) return false;
      
      // 检查内部 .key 元素
      const keyEl = blank.querySelector('.key, span.key');
      if (keyEl?.textContent?.trim()) return false;
      
      // 检查同级或父级的 .visible-box
      const stemContainer = blank.closest('[et-stem-index]') || blank.parentElement?.parentElement;
      if (stemContainer) {
        const visibleBox = stemContainer.querySelector('.visible-box');
        if (visibleBox?.textContent?.trim()) return false;
      }
      
      // 检查直接父级的 .visible-box
      if (blank.parentElement) {
        const sibling = blank.parentElement.querySelector('.visible-box');
        if (sibling?.textContent?.trim()) return false;
      }
      
      return true;
    });
    
    if (!allBlanksEmpty) return false;
    
    // 如果所有空格都没有答案，且包含 et-recorder（录音）或 notscored，则认为是开放式练习
    const hasRecorder = container.querySelector('et-recorder') !== null;
    
    return hasRecorder || container.hasAttribute('notscored');
  };

  /**
   * 检测是否为无交互类型的 et-item
   * 注意：notscored 属性只表示不计分，不意味着不需要填写
   * @param {Element} container - et-item 容器元素
   * @returns {boolean} 是否为无交互类型
   */
  const isNoInteractionItem = (container) => {
    // 检查是否包含 et-song（朗读/引用类型）- 这种确实不需要交互
    if (isEtSongItem(container)) return true;
    
    // 检查是否有可填写的元素（包括 textarea）
    const hasInputElements = container.querySelector('et-blank, et-multi-noinput, et-multi-options, et-recorder, et-choice, et-tof, et-matching, [contenteditable="true"], textarea, input[type="text"]');

    // 如果没有任何可填写的元素，才认为是无交互类型
    if (!hasInputElements) return true;    return false;
  };

  /**
   * 填充 et-item 容器中的所有题目
   * @param {Element} container - et-item 容器元素
   * @param {Function} mutateAnswer - 答案变异函数
   * @returns {boolean} 是否有任何填充操作
   */
  const fillEtItem = (container, mutateAnswer) => {
    // 跳过无交互类型
    if (isNoInteractionItem(container)) {
      return false;
    }

    // 检测开放式练习（无标准答案）
    if (isOpenEndedItem(container)) {
      console.info('[WeLearn-Go] fillEtItem: 检测到开放式练习（无标准答案）', container.id || container.getAttribute('uuid'));
      handleOpenEndedExercise(container);
      return false;
    }

    let filled = false;

    // 填充 et-blank 填空题
    const blanks = Array.from(container.querySelectorAll('et-blank'));
    console.info('[WeLearn-Go] fillEtItem: 找到 et-blank 数量:', blanks.length);
    blanks.forEach((blank) => {
      const changed = fillEtBlank(blank, mutateAnswer);
      console.info('[WeLearn-Go] fillEtBlank 返回:', changed, blank.id);
      filled = filled || changed;
    });

    // 填充 et-multi-noinput 多选题
    const multiNoinputs = Array.from(container.querySelectorAll('et-multi-noinput'));
    multiNoinputs.forEach((multi) => {
      const changed = fillEtMultiNoinput(multi);
      filled = filled || changed;
    });

    // 填充 et-toggle 对话填空题
    const toggles = Array.from(container.querySelectorAll('et-toggle'));
    toggles.forEach((toggle) => {
      const changed = fillEtToggle(toggle, mutateAnswer);
      filled = filled || changed;
    });

    // 填充 et-choice 二选一选择题
    const etChoices = Array.from(container.querySelectorAll('et-choice'));
    etChoices.forEach((choice) => {
      const changed = fillEtChoice(choice);
      filled = filled || changed;
    });

    // 填充 et-tof 判断题（True/False 或自定义标签如 B/S）
    const etTofs = Array.from(container.querySelectorAll('et-tof'));
    etTofs.forEach((tof) => {
      const changed = fillEtTof(tof);
      filled = filled || changed;
    });

    // 填充 et-matching 连线题
    const etMatchings = Array.from(container.querySelectorAll('et-matching'));
    etMatchings.forEach((matching) => {
      const changed = fillEtMatching(matching);
      filled = filled || changed;
    });

    return filled;
  };

  /**
   * 填充 et-matching 连线题
   * 参考 WELearnHelper 项目的实现：直接注入 SVG line 元素并更新 AngularJS 数据
   * @param {Element} container - et-matching 容器元素
   * @returns {boolean} 是否成功填充
   */
  const fillEtMatching = (container) => {
    // 防止重复执行
    if (container.dataset.welearnGoProcessed === 'true') return false;

    const key = container.getAttribute('key');
    if (!key) {
      console.warn('[WeLearn-Go] fillEtMatching: 没有 key 属性');
      return false;
    }

    // 标记为已处理
    container.dataset.welearnGoProcessed = 'true';

    // 解析答案 key="1-2,2-5,3-4,4-3,5-1" 或 key="1-6,2-5,3-4,4-2,5-1,6-9,7-7,8-3,9-8,10-10"
    // 格式：左边索引-右边索引 (1-based)
    const pairs = key.split(',').map(p => p.trim()).filter(p => p);
    if (pairs.length === 0) {
      console.warn('[WeLearn-Go] fillEtMatching: 空的 key');
      return false;
    }

    console.info('[WeLearn-Go] fillEtMatching: 解析答案', { key, pairs });

    // 获取 AngularJS scope 和 matching 控制器
    const ownerWindow = container.ownerDocument?.defaultView || window;
    const angular = ownerWindow.angular;
    let scope = null;
    let matchingCtrl = null;

    if (angular) {
      try {
        scope = angular.element(container)?.scope();
        matchingCtrl = scope?.matching;
      } catch (e) {
        console.debug('[WeLearn-Go] fillEtMatching: 获取 scope 失败', e);
      }
    }

    if (!matchingCtrl) {
      console.warn('[WeLearn-Go] fillEtMatching: 未找到 matching 控制器');
      // 继续尝试 DOM 方式
    }

    // 获取圆点信息
    const leftCircles = Array.from(container.querySelectorAll('circle[data-circle="A"]'));
    const rightCircles = Array.from(container.querySelectorAll('circle[data-circle="B"]'));
    
    console.info('[WeLearn-Go] fillEtMatching: 圆点数量', { 
      left: leftCircles.length, 
      right: rightCircles.length 
    });

    if (leftCircles.length === 0 || rightCircles.length === 0) {
      console.warn('[WeLearn-Go] fillEtMatching: 未找到圆点');
      return false;
    }

    // ═══════════════════════════════════════════════════════════════
    // 方法1: 通过 AngularJS 控制器设置答案 (最可靠)
    // ═══════════════════════════════════════════════════════════════
    if (matchingCtrl) {
      try {
        // 初始化 answers 数组
        if (!matchingCtrl.answers || !Array.isArray(matchingCtrl.answers)) {
          matchingCtrl.answers = [];
        }
        
        // 确保数组足够长
        for (let i = 0; i < leftCircles.length; i++) {
          if (!matchingCtrl.answers[i]) {
            matchingCtrl.answers[i] = [];
          }
        }
        
        // 设置每条连线
        pairs.forEach(pair => {
          const parts = pair.split('-');
          if (parts.length !== 2) return;
          
          const leftIdx = parseInt(parts[0], 10) - 1;  // 1-based to 0-based
          const rightIdx = parseInt(parts[1], 10) - 1;
          
          if (leftIdx >= 0 && leftIdx < leftCircles.length && 
              rightIdx >= 0 && rightIdx < rightCircles.length) {
            // 确保不重复添加
            if (!matchingCtrl.answers[leftIdx].includes(rightIdx)) {
              matchingCtrl.answers[leftIdx].push(rightIdx);
            }
          }
        });
        
        console.info('[WeLearn-Go] fillEtMatching: 设置 answers', matchingCtrl.answers);
        
        // 触发 AngularJS 更新
        if (scope && scope.$apply) {
          try {
            scope.$apply();
          } catch (e) {
            // 可能已经在 digest 中
            scope.$evalAsync(() => {});
          }
        }
        
        // 短暂延迟后再次触发更新，确保 SVG 渲染
        setTimeout(() => {
          if (scope && scope.$digest) {
            try {
              scope.$digest();
            } catch (e) {}
          }
        }, 100);
        
        return true;
      } catch (e) {
        console.warn('[WeLearn-Go] fillEtMatching: AngularJS 方式失败', e);
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // 方法2: 直接操作 SVG (备用方案)
    // ═══════════════════════════════════════════════════════════════
    const svg = container.querySelector('svg');
    let answersGroup = container.querySelector('g.answers');
    
    if (!svg) {
      console.warn('[WeLearn-Go] fillEtMatching: 未找到 SVG');
      return false;
    }

    // 如果没有 answers 组，创建一个
    if (!answersGroup) {
      answersGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      answersGroup.setAttribute('class', 'answers');
      svg.appendChild(answersGroup);
    }

    // 清除现有的线条（避免重复）
    const existingLines = answersGroup.querySelectorAll('line');
    existingLines.forEach(line => line.remove());

    // 画每条连线
    pairs.forEach(pair => {
      const parts = pair.split('-');
      if (parts.length !== 2) return;
      
      const leftIdx = parseInt(parts[0], 10) - 1;
      const rightIdx = parseInt(parts[1], 10) - 1;
      
      const leftCircle = leftCircles[leftIdx];
      const rightCircle = rightCircles[rightIdx];
      
      if (!leftCircle || !rightCircle) {
        console.warn('[WeLearn-Go] fillEtMatching: 未找到圆点', { leftIdx, rightIdx });
        return;
      }

      const x1 = leftCircle.getAttribute('cx');
      const y1 = leftCircle.getAttribute('cy');
      const x2 = rightCircle.getAttribute('cx');
      const y2 = rightCircle.getAttribute('cy');

      // 创建线条
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', x1);
      line.setAttribute('y1', y1);
      line.setAttribute('x2', x2);
      line.setAttribute('y2', y2);
      line.setAttribute('stroke', '#4a9'); // 绿色线条
      line.setAttribute('stroke-width', '2');
      
      answersGroup.appendChild(line);
      
      console.info('[WeLearn-Go] fillEtMatching: 画线', { leftIdx, rightIdx, x1, y1, x2, y2 });
    });

    // ═══════════════════════════════════════════════════════════════
    // 方法3: 模拟点击 (最后备用)
    // ═══════════════════════════════════════════════════════════════
    if (!matchingCtrl) {
      console.info('[WeLearn-Go] fillEtMatching: 尝试点击模拟');
      
      let clickIndex = 0;
      const doClick = () => {
        if (clickIndex >= pairs.length) return;
        
        const pair = pairs[clickIndex];
        const parts = pair.split('-');
        if (parts.length !== 2) {
          clickIndex++;
          setTimeout(doClick, 50);
          return;
        }
        
        const leftIdx = parseInt(parts[0], 10) - 1;
        const rightIdx = parseInt(parts[1], 10) - 1;
        
        const leftCircle = leftCircles[leftIdx];
        const rightCircle = rightCircles[rightIdx];
        
        if (leftCircle && rightCircle) {
          // 点击左边圆点
          leftCircle.dispatchEvent(new MouseEvent('click', {
            view: ownerWindow,
            bubbles: true,
            cancelable: true
          }));
          
          // 稍后点击右边圆点
          setTimeout(() => {
            rightCircle.dispatchEvent(new MouseEvent('click', {
              view: ownerWindow,
              bubbles: true,
              cancelable: true
            }));
            
            clickIndex++;
            setTimeout(doClick, 100);
          }, 150);
        } else {
          clickIndex++;
          setTimeout(doClick, 50);
        }
      };
      
      doClick();
    }

    return true;
  };

  /**
   * 填充 et-toggle 对话填空题（带视频/音频的对话练习）
   * 对话内容通常在 .lrc 或 .dialog 区域，填空位置有 et-blank 或 input 元素
   * @param {Element} container - et-toggle 容器元素
   * @param {Function} mutateAnswer - 答案变异函数
   * @returns {boolean} 是否有任何填充操作
   */
  const fillEtToggle = (container, mutateAnswer) => {
    let filled = false;

    // 查找对话区域中的 et-blank 填空
    const blanks = Array.from(container.querySelectorAll('et-blank'));
    blanks.forEach((blank) => {
      const changed = fillEtBlank(blank, mutateAnswer);
      filled = filled || changed;
    });

    // 查找 .lrc 区域中的填空（可能是 span 或 input）
    const lrcBlanks = Array.from(container.querySelectorAll('.lrc [contenteditable="true"], .lrc input[type="text"]'));
    lrcBlanks.forEach((input) => {
      const changed = fillGenericInput(input, mutateAnswer);
      filled = filled || changed;
    });

    // 查找对话区域中的填空
    const dialogBlanks = Array.from(container.querySelectorAll('.dialog [contenteditable="true"], .dialog input[type="text"]'));
    dialogBlanks.forEach((input) => {
      const changed = fillGenericInput(input, mutateAnswer);
      filled = filled || changed;
    });

    return filled;
  };

  /**
   * 从全局上下文中查找答案
   * @param {Element} element - 题目元素
   * @returns {string|null} 找到的答案或 null
   */
  const findAnswerFromGlobalContext = (element) => {
    const win = element.ownerDocument?.defaultView || window;
    const ids = [
      element.id,
      element.getAttribute('data-id'),
      element.getAttribute('data-question-id'),
      element.getAttribute('data-item-id'),
      element.closest('et-item')?.id
    ].filter(Boolean);

    if (ids.length === 0) return null;

    // 常见的全局数据源
    const dataSources = [
      win.courseData,
      win.pageData,
      win.activity,
      win.questionList,
      win.__INITIAL_STATE__,
      win.g_data
    ];

    for (const source of dataSources) {
      if (!source) continue;

      // 递归搜索答案
      const search = (obj, depth = 0) => {
        if (depth > 3 || !obj || typeof obj !== 'object') return null;

        // 检查当前对象是否包含 ID 和答案
        if (ids.some(id => obj.id == id || obj.questionId == id || obj.itemId == id)) {
          const possibleKeys = ['answer', 'key', 'correctAnswer', 'solution', 'rightAnswer'];
          for (const key of possibleKeys) {
            if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
              return String(obj[key]);
            }
          }
        }

        // 遍历数组或对象属性
        if (Array.isArray(obj)) {
          for (const item of obj) {
            const res = search(item, depth + 1);
            if (res) return res;
          }
        } else {
          for (const key in obj) {
            if (key === 'parent' || key === 'prev' || key === 'next') continue; // 避免循环引用
            const res = search(obj[key], depth + 1);
            if (res) return res;
          }
        }
        return null;
      };

      const result = search(source);
      if (result) {
        console.debug('[WeLearn-Go] findAnswerFromGlobalContext: 找到答案', result);
        return result;
      }
    }

    return null;
  };

  /**
   * 从解释文本中查找答案（针对 et-choice）
   * @param {Element} container - et-choice 容器
   * @param {Array<Element>} options - 选项元素数组
   * @returns {Element|null} 匹配的选项或 null
   */
  const findAnswerFromExplanation = (container, options) => {
    // 查找紧邻的 explanation 元素
    let explanationEl = container.nextElementSibling;
    if (!explanationEl || !explanationEl.classList.contains('explanation')) {
      // 尝试在父级查找
      const parent = container.parentElement;
      if (parent) {
        const explanationInParent = parent.querySelector(`.explanation[visible-on-key]`);
        // 确保它属于当前题目（简单的位置判断）
        if (explanationInParent && explanationInParent.compareDocumentPosition(container) & Node.DOCUMENT_POSITION_PRECEDING) {
           // explanation 在 container 之后
           explanationEl = explanationInParent;
        }
      }
    }

    if (!explanationEl) return null;

    const explanationText = normalizeText(explanationEl.textContent);
    if (!explanationText) return null;

    // 1. 寻找最长完整子串匹配
    let longestSubstringMatch = null;
    let longestLen = 0;
    
    options.forEach(opt => {
      const optText = normalizeText(opt.textContent);
      if (optText && explanationText.includes(optText)) {
        if (optText.length > longestLen) {
          longestLen = optText.length;
          longestSubstringMatch = opt;
        }
      }
    });
    
    if (longestSubstringMatch) {
      console.debug('[WeLearn-Go] findAnswerFromExplanation: 找到完整子串匹配', longestSubstringMatch.textContent);
      return longestSubstringMatch;
    }
    
    // 2. 如果没有完整匹配，尝试单词覆盖率
    let bestFuzzyMatch = null;
    let bestFuzzyScore = 0;
    
    options.forEach(opt => {
      const optText = normalizeText(opt.textContent);
      const stopWords = ['THE', 'A', 'AN', 'IN', 'ON', 'AT', 'TO', 'OF', 'FOR', 'AND', 'BUT', 'OR', 'IS', 'ARE', 'WAS', 'WERE', 'IT', 'THIS', 'THAT', 'HE', 'SHE', 'THEY'];
      const words = optText.split(/[^A-Z0-9]+/).filter(w => w.length > 2 && !stopWords.includes(w));
      
      if (words.length < 2) return; // 单词太少不准确

      let matchCount = 0;
      words.forEach(w => {
        // 简单的单词包含检查
        if (explanationText.includes(w)) matchCount++;
      });

      const score = matchCount / words.length;
      if (score > 0.75 && score > bestFuzzyScore) {
        bestFuzzyScore = score;
        bestFuzzyMatch = opt;
      }
    });
    
    if (bestFuzzyMatch) {
      console.debug('[WeLearn-Go] findAnswerFromExplanation: 找到模糊匹配', bestFuzzyMatch.textContent, bestFuzzyScore);
    }
    
    return bestFuzzyMatch;
  };

  /**
   * 填充 et-choice 选择题（综合实现）
   * 
   * 核心原理：et-choice 元素可能有 key 属性存储正确答案
   * 也可能需要从 AngularJS scope 或 .key 类获取答案
   * 选项可以是 li 或 span 形式
   * 
   * 答案来源（按优先级）：
   * 1. et-choice 的 key 属性 - 如 "A", "B", "1", "2" 或多选 "A,B"
   * 2. AngularJS scope 的 isKey() 方法
   * 3. 已显示的 .key 类
   * 4. span.key 答案提示文本
   * 
   * @param {Element} container - et-choice 容器元素
   * @returns {boolean} 是否成功填充
   */
  const fillEtChoice = (container) => {
    console.log('[WeLearn-Go] fillEtChoice: 开始处理');
    
    // 跳过重复元素（WELearnHelper 的 isRepeat 逻辑简化版）
    if (container.closest('et-web-only')) {
      console.log('[WeLearn-Go] fillEtChoice: 在 et-web-only 中，跳过');
      return false;
    }
    
    // 检查是否已经有选中的选项（如果已选中正确答案则跳过）
    const alreadyChosen = container.querySelector('li.chosen, li.active, li.selected');
    if (alreadyChosen) {
      console.log('[WeLearn-Go] fillEtChoice: 已有选中选项，跳过');
      return false;
    }
    
    // ====== 1. 查找选项元素 ======
    let options = Array.from(container.querySelectorAll('li'));
    let useSpan = false;
    
    if (options.length === 0) {
      options = Array.from(container.querySelectorAll('span[ng-click*="select"]'));
      useSpan = true;
    }
    
    if (options.length === 0) {
      // 尝试从 .wrapper 内查找
      const wrapper = container.querySelector('.wrapper');
      if (wrapper) {
        options = Array.from(wrapper.querySelectorAll('li'));
        if (options.length === 0) {
          options = Array.from(wrapper.querySelectorAll('span[ng-click*="select"]'));
          useSpan = true;
        }
      }
    }
    
    if (options.length === 0) {
      console.warn('[WeLearn-Go] fillEtChoice: 没有找到选项元素');
      return false;
    }
    
    console.log('[WeLearn-Go] fillEtChoice: 选项类型:', useSpan ? 'span' : 'li', '数量:', options.length);
    
    // ====== 2. 获取答案 ======
    let targetOption = null;
    let targetIdx = -1;
    let answerSource = '';  // 记录答案来源：'key', 'scope', 'explanation', 'fuzzy' 等
    let isReliable = true;  // 答案是否可靠（标准答案 vs 解析推断）
    
    // 方法1: 从 key 属性获取答案
    const keyAttr = container.getAttribute('key');
    if (keyAttr) {
      console.log('[WeLearn-Go] fillEtChoice: 发现 key 属性:', keyAttr);
      
      const answerKeys = keyAttr.split(',').map(k => k.trim());
      
      for (const answerKey of answerKeys) {
        let idx = -1;
        
        if (/^[A-Za-z]$/.test(answerKey)) {
          idx = answerKey.toUpperCase().charCodeAt(0) - 65;
        } else if (/^\d+$/.test(answerKey)) {
          idx = parseInt(answerKey, 10) - 1;
        }
        
        if (idx >= 0 && idx < options.length) {
          targetOption = options[idx];
          targetIdx = idx;
          console.log('[WeLearn-Go] fillEtChoice: 通过 key 属性找到答案，索引:', idx);
          answerSource = 'key属性';
          isReliable = true;
          break;
        }
      }
    }
    
    // 方法2: 通过 AngularJS scope 获取答案 (详细调试版)
    if (!targetOption) {
      try {
        const scopeDoc = container.ownerDocument?.defaultView || window;
        const angular = scopeDoc.angular;
        
        if (angular) {
          console.log('[WeLearn-Go] fillEtChoice: 尝试 AngularJS 方法');
          
          // 获取 scope - 尝试多种元素
          const elementsToTry = [container];
          const wrapper = container.querySelector('.wrapper');
          if (wrapper) elementsToTry.push(wrapper);
          if (options[0]) elementsToTry.push(options[0]);
          
          let scope = null;
          let controller = null;
          
          for (const el of elementsToTry) {
            scope = angular.element(el)?.scope();
            if (scope) {
              controller = scope.choice || scope.$ctrl || scope.vm;
              if (controller) break;
            }
          }
          
          if (scope) {
            console.log('[WeLearn-Go] fillEtChoice: 获取到 scope');
            
            // ★★★ 详细调试：打印 scope 中所有非 $ 开头的属性 ★★★
            const scopeKeys = Object.keys(scope).filter(k => !k.startsWith('$') && !k.startsWith('_'));
            console.log('[WeLearn-Go] fillEtChoice: scope 属性:', scopeKeys);
            
            // 特别查看 choice 对象
            if (scope.choice) {
              const choiceKeys = Object.keys(scope.choice).filter(k => !k.startsWith('$'));
              console.log('[WeLearn-Go] fillEtChoice: choice 属性:', choiceKeys);
              
              // 打印所有 choice 的值（调试用）
              for (const k of choiceKeys) {
                const v = scope.choice[k];
                if (typeof v !== 'function') {
                  console.log(`[WeLearn-Go] choice.${k} =`, v);
                } else {
                  console.log(`[WeLearn-Go] choice.${k} = [Function]`);
                }
              }
              
              controller = scope.choice;
            }
          }
          
          if (controller) {
            console.log('[WeLearn-Go] fillEtChoice: 找到 controller，keys:', Object.keys(controller).filter(k => !k.startsWith('$')));
            
            // ★★★ 核心：尝试调用 isKey 方法 ★★★
            if (typeof controller.isKey === 'function') {
              console.log('[WeLearn-Go] fillEtChoice: 找到 isKey 方法，遍历选项');
              for (let i = 0; i < options.length; i++) {
                try {
                  const isKey = controller.isKey(i);
                  console.log(`[WeLearn-Go] fillEtChoice: isKey(${i}) = ${isKey}`);
                  if (isKey) {
                    targetOption = options[i];
                    targetIdx = i;
                    console.log('[WeLearn-Go] fillEtChoice: 通过 isKey 找到答案，索引:', i);
                    answerSource = 'AngularJS isKey';
                    isReliable = true;
                    break;
                  }
                } catch (e) {
                  console.debug('[WeLearn-Go] fillEtChoice: isKey 调用失败', e);
                }
              }
            }
            
            // ★★★ 核心：检查 data.key 属性 ★★★
            if (!targetOption && controller.data) {
              console.log('[WeLearn-Go] fillEtChoice: controller.data 存在');
              if (controller.data.key !== undefined) {
                let idx = controller.data.key;
                console.log('[WeLearn-Go] fillEtChoice: controller.data.key =', idx, typeof idx);
                if (typeof idx === 'number') {
                  // key 可能是 0-based 或 1-based
                  const try0 = idx;
                  const try1 = idx - 1;
                  if (try0 >= 0 && try0 < options.length) {
                    targetOption = options[try0];
                    targetIdx = try0;
                    console.log('[WeLearn-Go] fillEtChoice: 通过 data.key (0-based) 找到答案，索引:', try0);
                    answerSource = 'AngularJS data.key';
                    isReliable = true;
                  } else if (try1 >= 0 && try1 < options.length) {
                    targetOption = options[try1];
                    targetIdx = try1;
                    console.log('[WeLearn-Go] fillEtChoice: 通过 data.key (1-based) 找到答案，索引:', try1);
                    answerSource = 'AngularJS data.key';
                    isReliable = true;
                  }
                }
              }
              // 打印 data 的其他属性
              const dataKeys = Object.keys(controller.data);
              console.log('[WeLearn-Go] fillEtChoice: controller.data 属性:', dataKeys);
            }
            
            // ★★★ 核心：检查 key 属性（字符串或数字） ★★★
            if (!targetOption && controller.key !== undefined) {
              let idx = controller.key;
              console.log('[WeLearn-Go] fillEtChoice: controller.key =', idx, typeof idx);
              if (typeof idx === 'number') {
                if (idx >= 0 && idx < options.length) {
                  targetOption = options[idx];
                  targetIdx = idx;
                } else if (idx - 1 >= 0 && idx - 1 < options.length) {
                  targetOption = options[idx - 1];
                  targetIdx = idx - 1;
                }
              } else if (typeof idx === 'string') {
                // 可能是字母 A/B/C/D
                if (/^[A-Da-d]$/.test(idx)) {
                  const letterIdx = idx.toUpperCase().charCodeAt(0) - 65;
                  if (letterIdx >= 0 && letterIdx < options.length) {
                    targetOption = options[letterIdx];
                    targetIdx = letterIdx;
                  }
                } else if (/^\d+$/.test(idx)) {
                  const numIdx = parseInt(idx, 10) - 1;
                  if (numIdx >= 0 && numIdx < options.length) {
                    targetOption = options[numIdx];
                    targetIdx = numIdx;
                  }
                }
              }
              if (targetOption) {
                console.log('[WeLearn-Go] fillEtChoice: 通过 controller.key 找到答案，索引:', targetIdx);
              }
            }
            
            // ★★★ 核心：检查 std_answer 或 answer 属性 ★★★
            if (!targetOption) {
              const answerProps = ['std_answer', 'answer', 'correctAnswer', 'correct', 'correctIndex'];
              for (const prop of answerProps) {
                if (controller[prop] !== undefined) {
                  const val = controller[prop];
                  console.log(`[WeLearn-Go] fillEtChoice: controller.${prop} =`, val, typeof val);
                  let idx = -1;
                  if (typeof val === 'number') {
                    idx = val >= 1 && val <= options.length ? val - 1 : val;
                  } else if (typeof val === 'string' && /^[A-Da-d]$/.test(val)) {
                    idx = val.toUpperCase().charCodeAt(0) - 65;
                  } else if (typeof val === 'string' && /^\d+$/.test(val)) {
                    idx = parseInt(val, 10) - 1;
                  }
                  if (idx >= 0 && idx < options.length) {
                    targetOption = options[idx];
                    targetIdx = idx;
                    console.log(`[WeLearn-Go] fillEtChoice: 通过 ${prop} 找到答案，索引:`, idx);
                    break;
                  }
                }
              }
            }
          } else {
            console.log('[WeLearn-Go] fillEtChoice: 未找到 controller/choice');
            // 打印 scope 内容帮助调试
            if (scope) {
              console.log('[WeLearn-Go] fillEtChoice: scope 内容:', 
                Object.keys(scope).filter(k => !k.startsWith('$') && !k.startsWith('_')).slice(0, 20));
            }
          }
        } else {
          console.log('[WeLearn-Go] fillEtChoice: 未找到 angular');
        }
      } catch (e) {
        console.debug('[WeLearn-Go] fillEtChoice: AngularJS 访问失败', e);
      }
    }
    
    // 方法3: 查找已有 .key 类的选项
    if (!targetOption) {
      targetOption = options.find((opt, i) => {
        if (opt.classList.contains('key')) {
          targetIdx = i;
          return true;
        }
        return false;
      });
      if (targetOption) {
        console.log('[WeLearn-Go] fillEtChoice: 通过 .key 类找到答案，索引:', targetIdx);
        answerSource = 'CSS .key类';
        isReliable = true;
      }
    }
    
    // 方法4: 从父级 et-item 中查找 span.key 答案提示
    if (!targetOption) {
      const etItem = container.closest('et-item');
      if (etItem) {
        const keySpan = etItem.querySelector('span.key:not([ng-click])');
        if (keySpan) {
          const keyText = keySpan.textContent?.trim().toLowerCase();
          console.log('[WeLearn-Go] fillEtChoice: 找到 span.key 答案:', keyText);
          
          targetOption = options.find((opt, i) => {
            const optText = opt.textContent?.trim().toLowerCase();
            if (optText === keyText || optText.includes(keyText)) {
              targetIdx = i;
              return true;
            }
            return false;
          });
          
          if (targetOption) {
            console.log('[WeLearn-Go] fillEtChoice: 通过 span.key 文本匹配找到答案');
          }
        }
      }
    }
    
    // 方法5: 从选项的 ng-class 解析 isKey
    if (!targetOption) {
      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const ngClass = opt.getAttribute('ng-class') || '';
        const keyMatch = ngClass.match(/key:\s*choice\.isKey\((\d+)\)/);
        
        if (keyMatch) {
          const expectedIdx = parseInt(keyMatch[1], 10);
          try {
            const scopeDoc = container.ownerDocument?.defaultView || window;
            const angular = scopeDoc.angular;
            const scope = angular?.element(opt)?.scope();
            
            if (scope?.choice?.isKey) {
              const isKey = scope.choice.isKey(expectedIdx);
              if (isKey) {
                targetOption = opt;
                targetIdx = i;
                console.log('[WeLearn-Go] fillEtChoice: 通过 ng-class isKey 找到答案，索引:', i);
                break;
              }
            }
          } catch (e) { /* 忽略 */ }
        }
      }
    }
    
    // 方法6: ★★★ 从解释文本 (p.explanation) 中提取答案 ★★★
    // 解释文本通常紧跟在 et-choice 后面，格式如："正确答案是B" 或 "故C是正确答案"
    if (!targetOption) {
      // 查找紧邻的 p.explanation 元素
      // 注意：explanation 必须是当前 et-choice 的直接后继，不能跨越其他 et-choice
      let explanationEl = null;
      let sibling = container.nextElementSibling;
      
      while (sibling) {
        // 如果遇到另一个 et-choice，停止搜索
        if (sibling.tagName?.toLowerCase() === 'et-choice') {
          break;
        }
        // 找到 explanation
        if (sibling.classList?.contains('explanation')) {
          explanationEl = sibling;
          break;
        }
        sibling = sibling.nextElementSibling;
      }
      
      if (explanationEl) {
        const explanationText = explanationEl.textContent || '';
        // 打印更多文本内容用于调试
        console.log('[WeLearn-Go] fillEtChoice: 找到解释文本 (长度' + explanationText.length + '):', 
          explanationText.length > 200 ? explanationText.substring(0, 100) + '...' + explanationText.substring(explanationText.length - 100) : explanationText);
        
        // 匹配多种答案格式:
        // "正确答案是B" "正确答案是 B" "正确答案为B"
        // "故C是正确答案" "故 C 是正确答案" "故C项为正确答案"
        // "答案是A" "答案为A" "选A" "选择A"
        // "所以D项并非..." (反向选择题，选错误项)
        // "The answer is B" "Answer: C"
        // "C项表述符合" "只有C项与新闻相符"
        const patterns = [
          /正确答案[是为]?\s*([A-Da-d])/,
          /故\s*([A-Da-d])\s*项?[是为]?正确答案/,  // "故C项为正确答案"
          /([A-Da-d])\s*项?[是为]正确答案/,        // "C项为正确答案"
          /([A-Da-d])\s*项?表述符合/,              // ★新增："C项表述符合"
          /([A-Da-d])\s*项?与新闻相符/,            // ★新增："C项与新闻相符"
          /([A-Da-d])\s*项?符合/,                  // ★新增："C项符合"
          /只有\s*([A-Da-d])\s*项?/,               // ★新增："只有C项"
          /答案[是为]?\s*([A-Da-d])/,
          /选[择]?\s*([A-Da-d])/,
          /[Aa]nswer[:\s]+([A-Da-d])/i,
          /([A-Da-d])\s*[是为]正确/,
          /([A-Da-d])\s*项?正确/,
          // 反向选择题格式 "所以D项并非" "D项不是" 等
          /所以\s*([A-Da-d])\s*项?/,
          /([A-Da-d])\s*项?并非/,
          /([A-Da-d])\s*项?不是/,
          /([A-Da-d])\s*项?错误/,
          /排除\s*([A-Da-d])/,
        ];
        
        for (const pattern of patterns) {
          const match = explanationText.match(pattern);
          if (match) {
            const answerLetter = match[1].toUpperCase();
            const idx = answerLetter.charCodeAt(0) - 65; // A=0, B=1, C=2, D=3
            
            if (idx >= 0 && idx < options.length) {
              targetOption = options[idx];
              targetIdx = idx;
              console.log('[WeLearn-Go] fillEtChoice: 从解释文本提取到答案:', answerLetter, '-> 索引:', idx);
              answerSource = '解释文本正则匹配';
              isReliable = false;  // 解析推断，可能有误
              break;
            }
          }
        }
        
        // ★★★ 方法6a-2: 中文解析末尾字母提取 ★★★
        // 规则：如果解释文本主要是中文，且末尾有单独的字母 A/B/C/D，则该字母就是答案
        // 例如："...C项表述符合新闻的主旨大意。C" -> 答案是 C
        // 或者："...综上所述，答案选 B。" -> 答案是 B
        if (!targetOption) {
          // 检查是否主要是中文（包含中文字符）
          const hasChinese = /[\u4e00-\u9fa5]/.test(explanationText);
          
          if (hasChinese) {
            // 提取文本末尾的字母（去除标点和空格后）
            // 匹配模式：文本结尾的 A/B/C/D，可能前面有标点或空格
            const endPatterns = [
              /[。.，,；;！!？?\s]+([A-Da-d])\s*[。.]*\s*$/,    // "...主旨大意。C" 或 "...答案选 B。"
              /([A-Da-d])\s*[。.]*\s*$/,                        // 直接以字母结尾
              /选\s*([A-Da-d])\s*[。.]*\s*$/,                   // "选C" 结尾
              /是\s*([A-Da-d])\s*[。.]*\s*$/,                   // "是C" 结尾
              /为\s*([A-Da-d])\s*[。.]*\s*$/,                   // "为C" 结尾
            ];
            
            for (const pattern of endPatterns) {
              const match = explanationText.match(pattern);
              if (match) {
                const answerLetter = match[1].toUpperCase();
                const idx = answerLetter.charCodeAt(0) - 65;
                
                if (idx >= 0 && idx < options.length) {
                  targetOption = options[idx];
                  targetIdx = idx;
                  console.log('[WeLearn-Go] fillEtChoice: 从解释文本末尾提取到答案:', answerLetter, '-> 索引:', idx);
                  answerSource = '解释文本末尾字母';
                  isReliable = false;  // 解析推断，可能有误
                  break;
                }
              }
            }
            
            // 如果上面的模式没匹配到，尝试找最后一个出现的 A/B/C/D
            if (!targetOption) {
              // 找文本中所有的 A/B/C/D（独立出现，不是单词的一部分）
              const letterMatches = explanationText.match(/(?:^|[^a-zA-Z])([A-Da-d])(?:[^a-zA-Z]|$)/g);
              if (letterMatches && letterMatches.length > 0) {
                // 取最后一个匹配
                const lastMatch = letterMatches[letterMatches.length - 1];
                const letterMatch = lastMatch.match(/[A-Da-d]/);
                if (letterMatch) {
                  const answerLetter = letterMatch[0].toUpperCase();
                  const idx = answerLetter.charCodeAt(0) - 65;
                  
                  if (idx >= 0 && idx < options.length) {
                    targetOption = options[idx];
                    targetIdx = idx;
                    console.log('[WeLearn-Go] fillEtChoice: 从解释文本最后一个字母提取答案:', answerLetter, '-> 索引:', idx);
                    answerSource = '解释文本最后字母';
                    isReliable = false;  // 解析推断，可能有误
                  }
                }
              }
            }
          }
        }
        
        // ★★★ 方法6b: 从解释文本中的数值与选项进行匹配 ★★★
        // 例如: 解释 "1.1 degrees Celsius" 匹配选项 "1.1°C"
        // 或者: 解释 "over 620,000" 匹配选项 "More than 620,000"
        // 注意: 只在选项本身包含数值时才启用数值匹配
        if (!targetOption) {
          // 先检查选项是否主要是数值型选项
          const optionTexts = options.map(opt => opt.textContent?.trim() || '');
          const numericOptionCount = optionTexts.filter(t => /^\d|^[\$€£¥]?\d|^[<>≤≥]?\s*\d/.test(t) || 
            /\d+[%°]/.test(t) || /\d+\/\d+/.test(t)).length;
          
          // 只有当至少一半选项是数值型时，才使用数值匹配
          const shouldUseNumericMatch = numericOptionCount >= options.length / 2;
          console.log('[WeLearn-Go] fillEtChoice: 数值型选项数量:', numericOptionCount, '/', options.length, 
            shouldUseNumericMatch ? '-> 启用数值匹配' : '-> 跳过数值匹配');
          
          if (shouldUseNumericMatch) {
            console.log('[WeLearn-Go] fillEtChoice: 尝试数值匹配');
            
            // ═══════════════════════════════════════════════════════════════
            // ★★★ 完整的文本标准化规则系统 ★★★
            // ═══════════════════════════════════════════════════════════════
            const normalizeText = (text) => {
              let n = text.toLowerCase();
              
              // ─────────────────────────────────────────────────────────────
              // 规则1: 英文小数点表达 "point" -> "."
              // ─────────────────────────────────────────────────────────────
              n = n.replace(/\bpoint\s+/g, '.');
              
              // ─────────────────────────────────────────────────────────────
              // 规则2: 英文复合数字 (21-99)
              // ─────────────────────────────────────────────────────────────
              const compoundNumbers = {
                'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50,
                'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90
              };
              const unitNumbers = {
                'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
                'six': 6, 'seven': 7, 'eight': 8, 'nine': 9
              };
              
              // 处理 "eighty-eight", "twenty one" 等
              for (const [tens, tensVal] of Object.entries(compoundNumbers)) {
                for (const [unit, unitVal] of Object.entries(unitNumbers)) {
                  const combined = tensVal + unitVal;
                  n = n.replace(new RegExp(`\\b${tens}[\\s-]${unit}\\b`, 'g'), String(combined));
                }
              }
              
              // ─────────────────────────────────────────────────────────────
              // 规则3: 英文基础数字 (0-19, 整十, 大数)
              // ─────────────────────────────────────────────────────────────
              const basicNumbers = {
                'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
                'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9',
                'ten': '10', 'eleven': '11', 'twelve': '12', 'thirteen': '13',
                'fourteen': '14', 'fifteen': '15', 'sixteen': '16', 'seventeen': '17',
                'eighteen': '18', 'nineteen': '19',
                'twenty': '20', 'thirty': '30', 'forty': '40', 'fifty': '50',
                'sixty': '60', 'seventy': '70', 'eighty': '80', 'ninety': '90',
                'hundred': '00', 'thousand': '000', 'million': '000000', 'billion': '000000000'
              };
              
              for (const [word, num] of Object.entries(basicNumbers)) {
                n = n.replace(new RegExp(`\\b${word}\\b`, 'g'), num);
              }
              
              // ─────────────────────────────────────────────────────────────
              // 规则4: 中文数字
              // ─────────────────────────────────────────────────────────────
              const chineseNumbers = {
                '零': '0', '一': '1', '二': '2', '两': '2', '三': '3', '四': '4',
                '五': '5', '六': '6', '七': '7', '八': '8', '九': '9', '十': '10',
                '百': '00', '千': '000', '万': '0000', '亿': '00000000'
              };
              
              for (const [cn, num] of Object.entries(chineseNumbers)) {
                n = n.replace(new RegExp(cn, 'g'), num);
              }
              
              // ─────────────────────────────────────────────────────────────
              // 规则5: 序数词
              // ─────────────────────────────────────────────────────────────
              const ordinals = {
                'first': '1', 'second': '2', 'third': '3', 'fourth': '4', 'fifth': '5',
                'sixth': '6', 'seventh': '7', 'eighth': '8', 'ninth': '9', 'tenth': '10',
                '第一': '1', '第二': '2', '第三': '3', '第四': '4', '第五': '5'
              };
              
              for (const [ord, num] of Object.entries(ordinals)) {
                n = n.replace(new RegExp(`\\b${ord}\\b`, 'gi'), num);
              }
              
              // ─────────────────────────────────────────────────────────────
              // 规则6: 分数表达
              // ─────────────────────────────────────────────────────────────
              const fractions = {
                'quarter': '1/4', 'half': '1/2', 'third': '1/3',
                'one quarter': '1/4', 'one half': '1/2', 'one third': '1/3',
                'two thirds': '2/3', 'three quarters': '3/4',
                '四分之一': '1/4', '二分之一': '1/2', '三分之一': '1/3',
                '三分之二': '2/3', '四分之三': '3/4'
              };
              
              for (const [frac, num] of Object.entries(fractions)) {
                n = n.replace(new RegExp(frac, 'gi'), num);
              }
              
              // ─────────────────────────────────────────────────────────────
              // 规则7: 百分比表达
              // ─────────────────────────────────────────────────────────────
              n = n.replace(/\s*percent\b/gi, '%');
              n = n.replace(/\s*per\s*cent\b/gi, '%');
              n = n.replace(/％/g, '%');
              n = n.replace(/百分之(\d+)/g, '$1%');
              
              // ─────────────────────────────────────────────────────────────
              // 规则8: 温度表达
              // ─────────────────────────────────────────────────────────────
              n = n.replace(/(\d+\.?\d*)\s*degrees?\s*celsius/gi, '$1°C');
              n = n.replace(/(\d+\.?\d*)\s*degrees?\s*fahrenheit/gi, '$1°F');
              n = n.replace(/(\d+\.?\d*)\s*degrees?\s*centigrade/gi, '$1°C');
              n = n.replace(/degrees?\s*celsius/gi, '°C');
              n = n.replace(/degrees?\s*fahrenheit/gi, '°F');
              n = n.replace(/摄氏(\d+)/g, '$1°C');
              n = n.replace(/华氏(\d+)/g, '$1°F');
              n = n.replace(/(\d+)\s*摄氏度/g, '$1°C');
              n = n.replace(/(\d+)\s*华氏度/g, '$1°F');
              
              // ─────────────────────────────────────────────────────────────
              // 规则9: 货币表达
              // ─────────────────────────────────────────────────────────────
              n = n.replace(/\$\s*(\d)/g, '$$$1');  // 移除 $ 后的空格
              n = n.replace(/(\d+\.?\d*)\s*dollars?/gi, '$$$1');
              n = n.replace(/(\d+\.?\d*)\s*euros?/gi, '€$1');
              n = n.replace(/(\d+\.?\d*)\s*pounds?/gi, '£$1');
              n = n.replace(/(\d+\.?\d*)\s*元/g, '¥$1');
              n = n.replace(/(\d+\.?\d*)\s*美元/g, '$$$1');
              
              // ─────────────────────────────────────────────────────────────
              // 规则10: 数量级表达
              // ─────────────────────────────────────────────────────────────
              n = n.replace(/(\d+\.?\d*)\s*million/gi, (m, p1) => String(parseFloat(p1) * 1000000));
              n = n.replace(/(\d+\.?\d*)\s*billion/gi, (m, p1) => String(parseFloat(p1) * 1000000000));
              n = n.replace(/(\d+\.?\d*)\s*thousand/gi, (m, p1) => String(parseFloat(p1) * 1000));
              
              // ─────────────────────────────────────────────────────────────
              // 规则11: 比较词标准化
              // ─────────────────────────────────────────────────────────────
              n = n.replace(/\bmore\s+than\b/gi, '>');
              n = n.replace(/\bover\b/gi, '>');
              n = n.replace(/\babove\b/gi, '>');
              n = n.replace(/\bexceeds?\b/gi, '>');
              n = n.replace(/\bless\s+than\b/gi, '<');
              n = n.replace(/\bunder\b/gi, '<');
              n = n.replace(/\bbelow\b/gi, '<');
              n = n.replace(/\bfewer\s+than\b/gi, '<');
              n = n.replace(/\babout\b/gi, '≈');
              n = n.replace(/\baround\b/gi, '≈');
              n = n.replace(/\bapproximately\b/gi, '≈');
              n = n.replace(/\bnearly\b/gi, '≈');
              n = n.replace(/\balmost\b/gi, '≈');
              n = n.replace(/\bat\s+least\b/gi, '≥');
              n = n.replace(/\bat\s+most\b/gi, '≤');
              n = n.replace(/\bup\s+to\b/gi, '≤');
              n = n.replace(/超过/g, '>');
              n = n.replace(/多于/g, '>');
              n = n.replace(/大于/g, '>');
              n = n.replace(/少于/g, '<');
              n = n.replace(/小于/g, '<');
              n = n.replace(/低于/g, '<');
              n = n.replace(/大约/g, '≈');
              n = n.replace(/约/g, '≈');
              n = n.replace(/近/g, '≈');
              n = n.replace(/至少/g, '≥');
              n = n.replace(/最多/g, '≤');
              
              // ─────────────────────────────────────────────────────────────
              // 规则12: 时间表达
              // ─────────────────────────────────────────────────────────────
              n = n.replace(/(\d+)\s*years?\s*old/gi, '$1岁');
              n = n.replace(/(\d+)\s*年/g, '$1年');
              n = n.replace(/(\d+)\s*months?/gi, '$1月');
              n = n.replace(/(\d+)\s*weeks?/gi, '$1周');
              n = n.replace(/(\d+)\s*days?/gi, '$1天');
              n = n.replace(/(\d+)\s*hours?/gi, '$1小时');
              n = n.replace(/(\d+)\s*minutes?/gi, '$1分钟');
              n = n.replace(/(\d+)\s*seconds?/gi, '$1秒');
              n = n.replace(/century/gi, '世纪');
              n = n.replace(/centuries/gi, '世纪');
              n = n.replace(/decade/gi, '十年');
              n = n.replace(/decades/gi, '十年');
              
              // ─────────────────────────────────────────────────────────────
              // 规则13: 清理格式
              // ─────────────────────────────────────────────────────────────
              n = n.replace(/,/g, '');           // 移除千位分隔符
              n = n.replace(/(\d+)\s*\.\s*(\d+)/g, '$1.$2');  // 修复小数点空格
              n = n.replace(/\s+/g, ' ');        // 合并多余空格
              
              return n.trim();
            };
            
            const normalizedExplanation = normalizeText(explanationText);
            console.log('[WeLearn-Go] fillEtChoice: 标准化解释文本:', normalizedExplanation.substring(0, 150));
            
            // ═══════════════════════════════════════════════════════════════
            // ★★★ 数值提取规则 ★★★
            // ═══════════════════════════════════════════════════════════════
            const extractPatterns = [
              { name: '温度', pattern: /(\d+\.?\d*)°[CF]/gi },
              { name: '百分比', pattern: /(\d+\.?\d*)\s*%/g },
              { name: '分数', pattern: /(\d+)\s*\/\s*(\d+)/g },
              { name: '货币', pattern: /[$€£¥]\s*(\d+\.?\d*)/g },
              { name: '比较数值', pattern: /[><=≈≥≤]\s*(\d+\.?\d*)/g },
              { name: '普通数字', pattern: /\b(\d+\.?\d*)\b/g },
            ];
            
            const extractedValues = [];
            for (const { name, pattern } of extractPatterns) {
              let match;
              const p = new RegExp(pattern.source, pattern.flags);
              while ((match = p.exec(normalizedExplanation)) !== null) {
                extractedValues.push({ type: name, value: match[0].toLowerCase(), raw: match[0] });
              }
            }
            console.log('[WeLearn-Go] fillEtChoice: 提取的数值:', extractedValues.map(v => v.value));
            
            // ═══════════════════════════════════════════════════════════════
            // ★★★ 分数与百分比等价映射 ★★★
            // ═══════════════════════════════════════════════════════════════
            const fractionToPercent = {
              '1/4': 25, '1/2': 50, '1/3': 33.33, '2/3': 66.67, '3/4': 75,
              '1/5': 20, '2/5': 40, '3/5': 60, '4/5': 80,
              '1/10': 10, '1/8': 12.5, '1/6': 16.67, '3/10': 30, '7/10': 70
            };
            
            // ═══════════════════════════════════════════════════════════════
            // ★★★ 单位标准化映射表 ★★★
            // ═══════════════════════════════════════════════════════════════
            const unitMappings = {
              // 温度
              '°C': ['°c', 'celsius', '摄氏', '摄氏度'],
              '°F': ['°f', 'fahrenheit', '华氏', '华氏度'],
              // 长度
              'km': ['kilometer', 'kilometers', 'kilometre', 'kilometres', '公里', '千米'],
              'm': ['meter', 'meters', 'metre', 'metres', '米'],
              'cm': ['centimeter', 'centimeters', 'centimetre', 'centimetres', '厘米'],
              'mm': ['millimeter', 'millimeters', 'millimetre', 'millimetres', '毫米'],
              'mi': ['mile', 'miles', '英里'],
              'ft': ['foot', 'feet', '英尺'],
              'in': ['inch', 'inches', '英寸'],
              // 重量
              'kg': ['kilogram', 'kilograms', '公斤', '千克'],
              'g': ['gram', 'grams', '克'],
              'mg': ['milligram', 'milligrams', '毫克'],
              'lb': ['pound', 'pounds', '磅'],
              'oz': ['ounce', 'ounces', '盎司'],
              't': ['ton', 'tons', 'tonne', 'tonnes', '吨'],
              // 体积/容量
              'L': ['liter', 'liters', 'litre', 'litres', '升'],
              'mL': ['milliliter', 'milliliters', 'millilitre', 'millilitres', '毫升'],
              'gal': ['gallon', 'gallons', '加仑'],
              // 面积
              'km²': ['square kilometer', 'square kilometers', 'sq km', '平方公里'],
              'm²': ['square meter', 'square meters', 'sq m', '平方米'],
              // 速度
              'km/h': ['kilometers per hour', 'kph', '公里/小时', '千米每小时'],
              'mph': ['miles per hour', '英里/小时'],
              'm/s': ['meters per second', '米/秒'],
              // 时间
              'h': ['hour', 'hours', '小时', '时'],
              'min': ['minute', 'minutes', '分钟', '分'],
              's': ['second', 'seconds', '秒'],
              'yr': ['year', 'years', '年'],
              'mo': ['month', 'months', '月'],
              'wk': ['week', 'weeks', '周'],
              'd': ['day', 'days', '天', '日'],
              // 人口/数量
              'people': ['人', '人口', 'persons'],
              'billion': ['十亿', 'bn', 'b'],
              'million': ['百万', 'm', 'mn'],
              'thousand': ['千', 'k'],
            };
            
            // 提取数值+单位的函数
            const extractValueWithUnit = (text) => {
              const results = [];
              // 匹配数值+单位的模式
              const patterns = [
                /(\d+\.?\d*)\s*°([CF])/gi,                    // 温度
                /(\d+\.?\d*)\s*%/g,                            // 百分比
                /(\d+\.?\d*)\s*(km²|m²|km\/h|mph|m\/s)/gi,     // 复合单位
                /(\d+\.?\d*)\s*(km|cm|mm|mi|ft|in|kg|mg|lb|oz|mL|gal|yr|mo|wk)\b/gi,  // 常用单位
                /(\d+\.?\d*)\s*(meters?|miles?|pounds?|gallons?|liters?|years?|months?|weeks?|days?|hours?|minutes?|seconds?)\b/gi,
                /(\d+\.?\d*)\s*(billion|million|thousand)\b/gi,  // 数量级
                /(\d+\.?\d*)\s*(人|公里|千米|米|公斤|升|年|月|周|天|小时)\b/g,  // 中文单位
              ];
              
              for (const pattern of patterns) {
                let match;
                const p = new RegExp(pattern.source, pattern.flags);
                while ((match = p.exec(text)) !== null) {
                  results.push({
                    full: match[0],
                    value: match[1],
                    unit: match[2] || ''
                  });
                }
              }
              return results;
            };
            
            // 标准化单位
            const normalizeUnit = (unit) => {
              const lowerUnit = unit.toLowerCase();
              for (const [standard, variants] of Object.entries(unitMappings)) {
                if (lowerUnit === standard.toLowerCase()) return standard;
                for (const variant of variants) {
                  if (lowerUnit === variant.toLowerCase() || lowerUnit.includes(variant.toLowerCase())) {
                    return standard;
                  }
                }
              }
              return unit;
            };
            
            // 提取解释文本中的数值+单位
            const expValueUnits = extractValueWithUnit(normalizedExplanation);
            console.log('[WeLearn-Go] fillEtChoice: 解释文本中的数值+单位:', expValueUnits.map(v => v.full));
            
            // ═══════════════════════════════════════════════════════════════
            // ★★★ 选项匹配评分系统 ★★★
            // ═══════════════════════════════════════════════════════════════
            let bestMatch = null;
            let bestScore = 0;
            
            options.forEach((opt, i) => {
              const optRaw = opt.textContent?.trim() || '';
              const optText = normalizeText(optRaw);
              let score = 0;
              let matchDetails = [];
              
              // 提取选项中的数值+单位
              const optValueUnits = extractValueWithUnit(optText);
              
              // ─────────────────────────────────────────────────────────────
              // 评分规则0: 数值+单位精确匹配 (最高优先级)
              // ─────────────────────────────────────────────────────────────
              for (const optVU of optValueUnits) {
                const optUnit = normalizeUnit(optVU.unit);
                const optValue = optVU.value;
                
                for (const expVU of expValueUnits) {
                  const expUnit = normalizeUnit(expVU.unit);
                  const expValue = expVU.value;
                  
                  // 数值相同
                  if (optValue === expValue) {
                    // 单位也相同 -> 完全匹配
                    if (optUnit === expUnit) {
                      score += 20;
                      matchDetails.push(`完全匹配: ${optValue}${optUnit}`);
                    } 
                    // 数值相同但单位不同 -> 可能是错误选项，减分
                    else if (optUnit && expUnit && optUnit !== expUnit) {
                      score -= 10;
                      matchDetails.push(`单位不匹配: ${optValue}${optUnit} vs ${expValue}${expUnit}`);
                    }
                  }
                }
              }
              
              // ─────────────────────────────────────────────────────────────
              // 评分规则1: 温度精确匹配 (数值+单位完全一致)
              // ─────────────────────────────────────────────────────────────
              const tempMatch = optText.match(/([\d.]+)°([CF])/i);
              if (tempMatch) {
                const optNum = tempMatch[1];
                const optUnit = tempMatch[2].toUpperCase();
                const expTempPattern = new RegExp(optNum.replace('.', '\\.') + '°' + optUnit, 'i');
                
                if (expTempPattern.test(normalizedExplanation)) {
                  score += 15;
                  matchDetails.push(`温度完全匹配: ${optNum}°${optUnit}`);
                } else {
                  // 检查是否数值匹配但单位错误
                  const wrongUnitPattern = new RegExp(optNum.replace('.', '\\.') + '°[CF]', 'i');
                  if (wrongUnitPattern.test(normalizedExplanation) && !expTempPattern.test(normalizedExplanation)) {
                    score -= 15;  // 数值对但单位错，强烈惩罚
                    matchDetails.push(`温度单位错误: 期望°${optUnit === 'C' ? 'F' : 'C'}`);
                  }
                }
              }
              
              // ─────────────────────────────────────────────────────────────
              // 评分规则2: 百分比精确匹配
              // ─────────────────────────────────────────────────────────────
              const percentMatch = optText.match(/([\d.]+)\s*%/);
              if (percentMatch) {
                const optPercent = percentMatch[1];
                if (normalizedExplanation.includes(optPercent + '%')) {
                  score += 15;
                  matchDetails.push(`百分比完全匹配: ${optPercent}%`);
                } else if (normalizedExplanation.includes(optPercent)) {
                  // 数值存在但不是百分比形式
                  score += 3;
                  matchDetails.push(`百分比数值存在: ${optPercent}`);
                }
              }
              
              // ─────────────────────────────────────────────────────────────
              // 评分规则3: 分数与百分比等价匹配
              // ─────────────────────────────────────────────────────────────
              for (const [fraction, percent] of Object.entries(fractionToPercent)) {
                if (optText.includes(fraction)) {
                  const percentStr = String(percent);
                  if (normalizedExplanation.includes(percentStr + '%') || 
                      normalizedExplanation.includes(percentStr)) {
                    score += 12;
                    matchDetails.push(`分数等价: ${fraction} = ${percent}%`);
                  }
                }
                const percentStr = String(percent);
                if (optText.includes(percentStr + '%')) {
                  if (normalizedExplanation.includes(fraction)) {
                    score += 12;
                    matchDetails.push(`百分比等价: ${percent}% = ${fraction}`);
                  }
                }
              }
              
              // ─────────────────────────────────────────────────────────────
              // 评分规则4: 比较词匹配 (>, <, ≈ 等)
              // ─────────────────────────────────────────────────────────────
              const comparators = ['>', '<', '≈', '≥', '≤'];
              for (const comp of comparators) {
                if (optText.includes(comp) && normalizedExplanation.includes(comp)) {
                  // 检查比较符后的数值是否匹配
                  const optCompMatch = optText.match(new RegExp(comp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(\\d+\\.?\\d*)'));
                  const expCompMatch = normalizedExplanation.match(new RegExp(comp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(\\d+\\.?\\d*)'));
                  if (optCompMatch && expCompMatch && optCompMatch[1] === expCompMatch[1]) {
                    score += 10;
                    matchDetails.push(`比较词匹配: ${comp}${optCompMatch[1]}`);
                  }
                }
              }
              
              // ─────────────────────────────────────────────────────────────
              // 评分规则5: 货币精确匹配
              // ─────────────────────────────────────────────────────────────
              const currencyMatch = optText.match(/([$€£¥])\s*([\d.]+)/);
              if (currencyMatch) {
                const symbol = currencyMatch[1];
                const amount = currencyMatch[2];
                if (normalizedExplanation.includes(symbol + amount) || 
                    normalizedExplanation.includes(symbol + ' ' + amount)) {
                  score += 12;
                  matchDetails.push(`货币匹配: ${symbol}${amount}`);
                }
              }
              
              // ─────────────────────────────────────────────────────────────
              // 评分规则6: 普通数值匹配 (需要更严格的上下文)
              // ─────────────────────────────────────────────────────────────
              const optNumbers = optText.match(/\b(\d+\.?\d*)\b/g) || [];
              for (const optNum of optNumbers) {
                // 检查是否是选项中的主要数值（排除序号等）
                if (optNum.length >= 2 || parseFloat(optNum) >= 10) {
                  // 精确匹配：数值两边是边界或非数字
                  const numPattern = new RegExp(`(^|[^\\d.])${optNum.replace('.', '\\.')}([^\\d.]|$)`);
                  if (numPattern.test(normalizedExplanation)) {
                    score += 8;
                    matchDetails.push(`数值匹配: ${optNum}`);
                  }
                }
              }
              
              // ─────────────────────────────────────────────────────────────
              // 评分规则7: 时间/年龄匹配
              // ─────────────────────────────────────────────────────────────
              const timeMatch = optText.match(/(\d+)\s*(世纪|年|月|周|天|小时|岁)/);
              if (timeMatch) {
                const timeNum = timeMatch[1];
                const timeUnit = timeMatch[2];
                if (normalizedExplanation.includes(timeNum + timeUnit) ||
                    normalizedExplanation.includes(timeNum + ' ' + timeUnit)) {
                  score += 10;
                  matchDetails.push(`时间匹配: ${timeNum}${timeUnit}`);
                }
              }
              
              console.log('[WeLearn-Go] fillEtChoice: 选项', i, '得分:', score, 
                matchDetails.length > 0 ? matchDetails.join('; ') : '无匹配',
                '| 原文:', optRaw.substring(0, 30));
              
              if (score > bestScore) {
                bestScore = score;
                bestMatch = opt;
                targetIdx = i;
              }
            });
            
            if (bestMatch && bestScore >= 5) {
              targetOption = bestMatch;
              console.log('[WeLearn-Go] fillEtChoice: 通过数值匹配找到答案，索引:', targetIdx, '得分:', bestScore);
              answerSource = '数值匹配';
              isReliable = false;  // 推断，可能有误
            }
          }
        }
        
        // ★★★ 方法6c: 关键词语义匹配（中英文通用）★★★
        // 用于非数值型选项，匹配解释文本中的关键词
        if (!targetOption) {
          console.log('[WeLearn-Go] fillEtChoice: 尝试关键词语义匹配');
          
          const expText = explanationText.toLowerCase();
          let bestMatch = null;
          let bestScore = 0;
          
          // 英文停用词
          const enStopWords = new Set(['it', 'is', 'a', 'an', 'the', 'to', 'by', 'in', 'of', 'for', 'has', 'been', 
            'was', 'will', 'be', 'about', 'that', 'this', 'with', 'are', 'have', 'do', 'does', 'and', 'or', 'but']);
          
          // 中文停用词
          const cnStopWords = new Set(['的', '了', '是', '在', '和', '与', '或', '及', '也', '都', '而', '但', 
            '这', '那', '个', '些', '所', '以', '为', '于', '从', '到', '等', '被', '把', '让', '使']);
          
          options.forEach((opt, i) => {
            const optText = (opt.textContent || '').trim();
            const optLower = optText.toLowerCase();
            let score = 0;
            let matchedWords = [];
            
            // ─────────────────────────────────────────────────────────────
            // 英文关键词提取和匹配
            // ─────────────────────────────────────────────────────────────
            const enWords = optLower.match(/[a-z]+/g) || [];
            for (const word of enWords) {
              if (word.length <= 2 || enStopWords.has(word)) continue;
              
              // 精确匹配
              if (expText.includes(word)) {
                score += 3;
                matchedWords.push(word);
              }
              // 词根匹配
              const stem = word.replace(/(ing|ed|s|ly|er|est|tion|ment|ness|able|ible)$/, '');
              if (stem.length > 3 && stem !== word && expText.includes(stem)) {
                score += 2;
                matchedWords.push(stem + '*');
              }
            }
            
            // ─────────────────────────────────────────────────────────────
            // 中文关键词提取和匹配
            // ─────────────────────────────────────────────────────────────
            const cnChars = optText.match(/[\u4e00-\u9fa5]+/g) || [];
            for (const phrase of cnChars) {
              // 跳过单字停用词
              if (phrase.length === 1 && cnStopWords.has(phrase)) continue;
              
              // 完整词组匹配
              if (expText.includes(phrase)) {
                score += phrase.length * 2;  // 中文匹配按字数加分
                matchedWords.push(phrase);
              }
              
              // 拆分成2字词组匹配
              if (phrase.length >= 2) {
                for (let j = 0; j < phrase.length - 1; j++) {
                  const biGram = phrase.substring(j, j + 2);
                  if (!cnStopWords.has(biGram[0]) && !cnStopWords.has(biGram[1])) {
                    if (expText.includes(biGram)) {
                      score += 1;
                    }
                  }
                }
              }
            }
            
            // ─────────────────────────────────────────────────────────────
            // 特殊语义匹配规则
            // ─────────────────────────────────────────────────────────────
            // 年份/世纪匹配
            const yearMatch = expText.match(/\b(17|18|19|20)\d{2}\b/);
            if (yearMatch && (optLower.includes('century') || optLower.includes('year') || optText.includes('世纪') || optText.includes('年'))) {
              const year = parseInt(yearMatch[0]);
              const age = new Date().getFullYear() - year;
              if ((optLower.includes('three') && optLower.includes('century')) || optText.includes('三') && optText.includes('世纪')) {
                if (age >= 250 && age <= 350) score += 8;
              }
            }
            
            // 增长/下降相关词
            const growthWords = ['increase', 'grow', 'rise', 'boom', 'surge', 'expand', '增长', '上升', '增加', '扩大'];
            const declineWords = ['decrease', 'fall', 'drop', 'decline', 'reduce', 'shrink', '下降', '减少', '降低', '缩小'];
            
            if (growthWords.some(w => optLower.includes(w) || optText.includes(w))) {
              if (growthWords.some(w => expText.includes(w))) score += 4;
              if (declineWords.some(w => expText.includes(w))) score -= 3;  // 相反语义减分
            }
            if (declineWords.some(w => optLower.includes(w) || optText.includes(w))) {
              if (declineWords.some(w => expText.includes(w))) score += 4;
              if (growthWords.some(w => expText.includes(w))) score -= 3;
            }
            
            // 最大/最小相关词
            const superlativeWords = ['biggest', 'largest', 'most', 'highest', 'best', 'greatest', '最大', '最多', '最高', '最好'];
            if (superlativeWords.some(w => optLower.includes(w) || optText.includes(w))) {
              if (superlativeWords.some(w => expText.includes(w))) score += 5;
            }
            
            console.log('[WeLearn-Go] fillEtChoice: 选项', i, '关键词得分:', score, 
              '匹配词:', matchedWords.slice(0, 5).join(','), 
              '| 选项:', optText.substring(0, 40));
            
            if (score > bestScore) {
              bestScore = score;
              bestMatch = opt;
              targetIdx = i;
            }
          });
          
          // 只有当得分足够高时才选择
          if (bestMatch && bestScore >= 5) {
            targetOption = bestMatch;
            console.log('[WeLearn-Go] fillEtChoice: 通过关键词语义匹配找到答案，索引:', targetIdx, '得分:', bestScore);
            answerSource = '关键词语义匹配';
            isReliable = false;  // 推断，可能有误
          }
        }
      }
    }
    
    // 如果没有找到答案，尝试最后的方法
    if (!targetOption) {
      // 方法7: 深度搜索 AngularJS scope 中的答案
      try {
        const scopeDoc = container.ownerDocument?.defaultView || window;
        const angular = scopeDoc.angular;
        
        if (angular) {
          const wrapper = container.querySelector('.wrapper');
          const scopeEl = wrapper || container;
          const scope = angular.element(scopeEl)?.scope();
          
          if (scope) {
            // 打印 scope 中所有包含 key/answer/correct 的属性
            const findAnswer = (obj, path = '', depth = 0) => {
              if (depth > 3 || !obj || typeof obj !== 'object') return null;
              
              for (const key of Object.keys(obj)) {
                if (key.startsWith('$') || key.startsWith('_')) continue;
                
                const val = obj[key];
                const fullPath = path ? `${path}.${key}` : key;
                
                // 直接检查 key/answer 属性
                if ((key === 'key' || key === 'answer' || key === 'correctIndex' || key === 'std_answer') && 
                    (typeof val === 'number' || typeof val === 'string')) {
                  console.log(`[WeLearn-Go] fillEtChoice: 发现 ${fullPath} = ${val}`);
                  
                  let idx = -1;
                  if (typeof val === 'number') {
                    idx = val >= 1 && val <= options.length ? val - 1 : val;
                  } else if (typeof val === 'string' && /^[A-Da-d]$/.test(val)) {
                    idx = val.toUpperCase().charCodeAt(0) - 65;
                  } else if (typeof val === 'string' && /^\d+$/.test(val)) {
                    idx = parseInt(val, 10) - 1;
                  }
                  
                  if (idx >= 0 && idx < options.length) {
                    targetOption = options[idx];
                    targetIdx = idx;
                    console.log('[WeLearn-Go] fillEtChoice: 通过深度搜索找到答案，索引:', idx);
                    return true;
                  }
                }
                
                // 递归搜索
                if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
                  if (findAnswer(val, fullPath, depth + 1)) return true;
                }
              }
              return false;
            };
            
            findAnswer(scope);
          }
        }
      } catch (e) {
        console.debug('[WeLearn-Go] fillEtChoice: 深度搜索失败', e);
      }
    }
    
    // 方法8: ★★★ 使用 findAnswerFromExplanation 进行模糊匹配 ★★★
    if (!targetOption) {
      console.log('[WeLearn-Go] fillEtChoice: 尝试解释文本模糊匹配');
      const fuzzyMatch = findAnswerFromExplanation(container, options);
      if (fuzzyMatch) {
        targetOption = fuzzyMatch;
        targetIdx = options.indexOf(fuzzyMatch);
        console.log('[WeLearn-Go] fillEtChoice: 通过模糊匹配找到答案，索引:', targetIdx);
      }
    }
    
    // 如果还是没有找到答案，打印详细调试信息
    if (!targetOption) {
      console.warn('[WeLearn-Go] fillEtChoice: 无法确定正确答案，跳过填写');
      // 打印调试信息
      console.debug('[WeLearn-Go] fillEtChoice: container attrs:', 
        Array.from(container.attributes).map(a => `${a.name}="${a.value}"`).join(' '));
      
      // ★★★ 详细调试：输出完整的 scope 内容供分析 ★★★
      try {
        const scopeDoc = container.ownerDocument?.defaultView || window;
        const angular = scopeDoc.angular;
        if (angular) {
          const wrapper = container.querySelector('.wrapper');
          const scope = angular.element(wrapper || container)?.scope();
          if (scope?.choice) {
            console.log('[WeLearn-Go] fillEtChoice: ★★★ 请检查以下 choice 对象的内容 ★★★');
            console.log('[WeLearn-Go] choice =', scope.choice);
            console.log('[WeLearn-Go] choice.data =', scope.choice?.data);
            
            // 尝试遍历 choice 的所有属性
            const props = {};
            for (const k in scope.choice) {
              if (!k.startsWith('$') && !k.startsWith('_') && typeof scope.choice[k] !== 'function') {
                props[k] = scope.choice[k];
              }
            }
            console.log('[WeLearn-Go] choice 属性 (非函数):', props);
            
            // 打印 data 的详细内容
            if (scope.choice.data) {
              const dataProps = {};
              for (const k in scope.choice.data) {
                if (!k.startsWith('$') && typeof scope.choice.data[k] !== 'function') {
                  dataProps[k] = scope.choice.data[k];
                }
              }
              console.log('[WeLearn-Go] choice.data 属性:', dataProps);
            }
          } else {
            console.log('[WeLearn-Go] fillEtChoice: 未找到 scope.choice，scope 内容:', 
              Object.keys(scope || {}).filter(k => !k.startsWith('$')));
          }
        }
      } catch (e) {
        console.debug('[WeLearn-Go] fillEtChoice: 调试输出失败', e);
      }
      
      return false;
    }
    
    // ====== 3. 点击选项 ======
    // 检查是否已选中
    const isAlreadyChosen = targetOption.classList.contains('chosen') || 
                            targetOption.classList.contains('active') || 
                            targetOption.classList.contains('selected');
    if (isAlreadyChosen) {
      console.log('[WeLearn-Go] fillEtChoice: 选项已被选中，跳过');
      return false;
    }
    
    console.info('[WeLearn-Go] fillEtChoice: 点击选项', targetIdx, ':', targetOption.textContent?.trim()?.substring(0, 50));
    
    // ★★★ 如果答案来自解析推断，在控制台和页面上提示用户 ★★★
    if (!isReliable) {
      console.warn(`[WeLearn-Go] ⚠️ 答案来源: ${answerSource}，存在一定错误率，请注意核对！`);
      
      // 在选项旁边添加警告标记
      try {
        const warningSpan = document.createElement('span');
        warningSpan.className = 'welearn-go-warning';
        warningSpan.style.cssText = 'color: #e67e22; font-size: 12px; margin-left: 5px; font-weight: bold;';
        warningSpan.textContent = '⚠️ 推断';
        warningSpan.title = `答案来源: ${answerSource}\n该答案通过解析文本推断，可能存在错误，请核对！`;
        
        // 检查是否已添加过警告
        if (!targetOption.querySelector('.welearn-go-warning')) {
          targetOption.appendChild(warningSpan);
        }
      } catch (e) {
        // 忽略添加标记失败
      }
    } else {
      console.info(`[WeLearn-Go] ✓ 答案来源: ${answerSource}，标准答案`);
    }
    
    targetOption.click();
    
    // 触发 AngularJS 更新
    try {
      const scopeDoc = container.ownerDocument?.defaultView || window;
      const scope = scopeDoc.angular?.element(targetOption)?.scope();
      if (scope?.$apply) {
        scope.$apply();
      }
    } catch (e) { /* 忽略 */ }
    
    return true;
  };

  /**
   * 填充 et-tof 判断题（True/False 或自定义标签如 B/S）
   * 结构：<et-tof labels="B,S" key="t">
   *   <span ng-click="tof.chose('t')">B</span>  - 第一个选项（true）
   *   <span ng-click="tof.chose('f')">S</span>  - 第二个选项（false）
   * </et-tof>
   * 
   * 答案来源（按优先级）：
   * 1. 元素的 key 属性（WELearnHelper 方式）- "t" 或 "f"
   * 2. 已显示的 .key 类
   * 3. AngularJS scope 的 isKey 方法
   * 
   * @param {Element} container - et-tof 容器元素
   * @returns {boolean} 是否成功填充
   */
  const fillEtTof = (container) => {
    console.info('[WeLearn-Go] fillEtTof: 开始处理', container.id, container.outerHTML?.substring(0, 200));
    
    // 获取正确的 window 对象（支持 iframe）
    const ownerWindow = container.ownerDocument?.defaultView || window;
    const angular = ownerWindow.angular;
    
    // 尝试多种方式查找选项容器
    let wrapper = container.querySelector('.wrapper');
    let controls = wrapper?.querySelector('.controls');
    
    // 如果标准结构找不到，直接在 container 中查找
    if (!controls) {
      controls = container.querySelector('.controls');
    }
    if (!controls) {
      controls = container.querySelector('span.controls');
    }
    
    console.info('[WeLearn-Go] fillEtTof: wrapper=', !!wrapper, 'controls=', !!controls);

    // 查找选项（多种选择器）- WELearnHelper 使用 'et-tof span.controls span'
    let options = [];
    if (controls) {
      options = Array.from(controls.querySelectorAll('span[ng-click*="chose"]'));
      // 备用：直接获取 controls 下的 span
      if (options.length < 2) {
        options = Array.from(controls.querySelectorAll('span'));
      }
    }
    // 备用：直接在 container 或 wrapper 中查找
    if (options.length < 2) {
      const searchIn = wrapper || container;
      options = Array.from(searchIn.querySelectorAll('span[ng-click*="chose"]'));
    }
    // 再备用：查找任何带有 ng-click 包含 tof 的 span
    if (options.length < 2) {
      options = Array.from(container.querySelectorAll('span[ng-click*="tof"]'));
    }
    
    console.info('[WeLearn-Go] fillEtTof: 找到选项数量:', options.length, options.map(o => o.textContent?.trim()));
    
    if (options.length < 2) {
      console.warn('[WeLearn-Go] fillEtTof: 选项不足', container.id);
      return false;
    }

    let keyOption = null;

    // ★★★ 方法0: 从 key 属性获取答案（WELearnHelper 的核心方式）★★★
    const keyAttr = container.getAttribute('key');
    if (keyAttr) {
      const keyVal = keyAttr.trim().toLowerCase();
      console.debug('[WeLearn-Go] fillEtTof: 发现 key 属性:', keyVal);
      
      // WELearnHelper 的逻辑：t/T = 第一个选项(索引0)，f/F = 第二个选项(索引1)
      if (keyVal === 't') {
        keyOption = options[0];
        console.info('[WeLearn-Go] fillEtTof: 通过 key="t" 选择第一个选项');
      } else if (keyVal === 'f') {
        keyOption = options[1];
        console.info('[WeLearn-Go] fillEtTof: 通过 key="f" 选择第二个选项');
      }
    }

    // 方法1: 查找已有 .key 类的选项（答案已显示时）
    if (!keyOption) {
      keyOption = options.find(opt => opt.classList.contains('key'));
      if (keyOption) {
        console.info('[WeLearn-Go] fillEtTof: 通过 .key 类找到答案');
      }
    }

    // 方法2: 通过 AngularJS scope 获取正确答案
    if (!keyOption && angular) {
      try {
        const scope = angular.element(container)?.scope() || 
                      angular.element(wrapper || container)?.scope();
        
        if (scope?.tof) {
          console.info('[WeLearn-Go] fillEtTof: 找到 tof scope', Object.keys(scope.tof));
          
          // 尝试调用 isKey 方法
          if (typeof scope.tof.isKey === 'function') {
            if (scope.tof.isKey('t')) {
              keyOption = options.find(opt => {
                const ngClick = opt.getAttribute('ng-click') || '';
                return ngClick.includes("'t'") || ngClick.includes('"t"');
              });
              console.info('[WeLearn-Go] fillEtTof: isKey(t) = true');
            } else if (scope.tof.isKey('f')) {
              keyOption = options.find(opt => {
                const ngClick = opt.getAttribute('ng-click') || '';
                return ngClick.includes("'f'") || ngClick.includes('"f"');
              });
              console.info('[WeLearn-Go] fillEtTof: isKey(f) = true');
            }
          }
          
          // 尝试读取 key 属性
          if (!keyOption && scope.tof.key !== undefined) {
            const key = scope.tof.key;
            console.info('[WeLearn-Go] fillEtTof: tof.key =', key);
            keyOption = options.find(opt => {
              const ngClick = opt.getAttribute('ng-click') || '';
              return ngClick.includes(`'${key}'`) || ngClick.includes(`"${key}"`);
            });
          }
          
          // 尝试读取 data.key 属性
          if (!keyOption && scope.tof.data?.key !== undefined) {
            const key = scope.tof.data.key;
            console.info('[WeLearn-Go] fillEtTof: tof.data.key =', key);
            keyOption = options.find(opt => {
              const ngClick = opt.getAttribute('ng-click') || '';
              return ngClick.includes(`'${key}'`) || ngClick.includes(`"${key}"`);
            });
          }
        }
      } catch (e) {
        console.warn('[WeLearn-Go] fillEtTof: AngularJS scope 访问失败', e);
      }
    }

    // 方法3: 从 ng-class 中解析 key 状态
    if (!keyOption && angular) {
      for (const opt of options) {
        const ngClass = opt.getAttribute('ng-class') || '';
        // 格式类似: {chosen:tof.value[0] === 't', key: tof.isKey('t')}
        const keyMatch = ngClass.match(/key:\s*tof\.isKey\(['"](t|f)['"]\)/);
        if (keyMatch) {
          const keyValue = keyMatch[1];
          try {
            const scope = angular.element(opt)?.scope();
            if (scope?.tof?.isKey && scope.tof.isKey(keyValue)) {
              keyOption = opt;
              console.info(`[WeLearn-Go] fillEtTof: 从 ng-class 确认 isKey('${keyValue}') = true`);
              break;
            }
          } catch (e) { /* 忽略 */ }
        }
      }
    }

    if (!keyOption) {
      console.warn('[WeLearn-Go] fillEtTof: 无法确定正确答案', container.id);
      return false;
    }

    // 检查是否已选中
    if (keyOption.classList.contains('chosen')) {
      console.info('[WeLearn-Go] fillEtTof: 已经选中正确答案，跳过');
      return false; // 已经选中正确答案
    }

    // 点击正确选项
    console.info('[WeLearn-Go] fillEtTof: 选择答案', keyOption.textContent?.trim());
    keyOption.click();

    // 尝试触发 AngularJS 更新
    try {
      const scope = angular?.element(keyOption)?.scope();
      if (scope && scope.$apply) {
        scope.$apply();
      }
    } catch (e) { /* 忽略 */ }

    return true;
  };

  /**
   * 填充通用输入元素（input 或 contenteditable）
   * 尝试从父元素或相邻元素中查找答案
   * @param {Element} input - 输入元素
   * @param {Function} mutateAnswer - 答案变异函数
   * @returns {boolean} 是否成功填充
   */
  const fillGenericInput = (input, mutateAnswer) => {
    // 尝试查找答案：从父元素的 .key 或 data-solution 属性
    let solution = '';
    
    // 方法1: 查找同级或父级的 .key 元素
    const parent = input.closest('et-blank, .blank, .filling, [data-controltype]');
    if (parent) {
      const keyEl = parent.querySelector('.key, [data-itemtype="result"]');
      if (keyEl) {
        solution = normalizeAnswer(keyEl.textContent);
      }
    }
    
    // 方法2: 从 input 的 data-solution 属性获取
    if (!solution && input.dataset?.solution) {
      solution = normalizeAnswer(input.dataset.solution);
    }
    
    // 方法3: 查找 placeholder 中可能的提示
    if (!solution && input.placeholder) {
      // 有些题目会在 placeholder 中给出答案格式提示
    }
    
    if (!solution) return false;

    const finalValue = mutateAnswer(solution);
    
    // 判断是 contenteditable 还是 input
    if (input.hasAttribute('contenteditable')) {
      const currentValue = normalizeAnswer(input.textContent);
      if (currentValue === finalValue) return false;
      
      input.textContent = finalValue;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
    } else {
      // input 元素
      const currentValue = normalizeAnswer(input.value);
      if (currentValue === finalValue) return false;
      
      input.value = finalValue;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    
    return true;
  };

  /** 检测是否为 Group Work 类型（有标准答案） */
  const detectGroupWork = (contexts) =>
    contexts.some((doc) => {
      const candidates = doc.querySelectorAll(
        '.subtitle2, .direction, .part_title, [data-controltype="group"], [data-controltype="page"], et-direction',
      );
      return Array.from(candidates).some((node) => GROUP_WORK_PATTERN.test(node.textContent || ''));
    });

  /** 检测是否为开放性题目（没有标准答案，如 "Answers may vary"） */
  const detectOpenEndedGroupWork = (contexts) =>
    contexts.some((doc) => {
      // 检测 "Answers may vary" 开放性题目 - 需要更精确的匹配
      const allText = doc.body?.textContent || '';
      // 必须是完整的短语 "Answers may vary" 或 "Answer may vary"
      if (/\banswers?\s+(may|will|could|can)\s+vary\b/i.test(allText)) return true;
      
      // 检测带有 vary 类名的元素（用于标记开放性答案的特定类名）
      const varyElements = doc.querySelectorAll('.vary-answers, .answers-vary, [data-vary="true"]');
      return varyElements.length > 0;
    });

  /** 禁用自动提交功能 */
  const disableAutoSubmit = () => {
    const submitToggle = document.querySelector('.welearn-submit-toggle');
    if (submitToggle && submitToggle.checked) {
      submitToggle.checked = false;
      submitToggle.classList.remove('active');
    }
  };

  /** 处理有标准答案的 Group Work 模式（正常填充但禁用自动提交） */
  const handleGroupWorkMode = () => {
    groupWorkDetected = true;
    disableAutoSubmit();
    if (groupWorkNoticeShown) return;
    groupWorkNoticeShown = true;
    showToast('检测到 Group Work 讨论作业，已填充参考答案，请修改后再提交', {
      duration: 5000,
    });
  };

  /** 检查 fillinglong 是否有实质性答案（排除 "Answers may vary" 等占位文本） */
  const hasSubstantiveAnswer = (container) => {
    // 获取答案文本
    const resultEl = container.querySelector('[data-itemtype="result"]');
    const solutionAttr = container.querySelector('[data-solution]')?.getAttribute('data-solution');
    
    let answerText = resultEl?.textContent?.trim() || solutionAttr || '';
    
    // 清理答案文本
    answerText = cleanGroupWorkAnswer(answerText);
    
    // 如果清理后还有内容，则有实质性答案
    return answerText.length > 0;
  };

  /** 处理没有标准答案的开放性 Group Work（复制提示词到剪贴板） */
  const handleOpenEndedGroupWork = (contexts) => {
    groupWorkDetected = true;
    disableAutoSubmit();
    if (groupWorkNoticeShown) return;
    
    // 固定的提示词
    let promptText = '请根据要求完成题目，使用英语回答\n\n';
    
    // 记录是否有需要复制的主观题
    let hasSubjectiveQuestions = false;
    
    // 获取原始题目内容
    contexts.forEach((doc) => {
      // 优先获取 et-item 题目区域
      const etItems = doc.querySelectorAll('et-item');
      if (etItems.length > 0) {
        etItems.forEach((item) => {
          // 克隆节点以便移除不需要的元素
          const clone = item.cloneNode(true);
          // 移除底部的提示和按钮区域，以及 style 标签
          clone.querySelectorAll('style, script, .vary-answers, .key, .submit-btn, .btn, button, [class*="submit"], [class*="key"]').forEach(el => el.remove());
          
          let text = clone.innerText?.trim();
          if (text) {
            // 移除末尾的 "Answers may vary"、"Key"、提交时间、"Submit" 等
            text = text.replace(/\n*Answers?\s*(may|will)?\s*vary\.?\s*$/i, '');
            text = text.replace(/\n*Key\s*$/i, '');
            text = text.replace(/\n*上次在.*提交\s*$/i, '');
            text = text.replace(/\n*Submit\s*$/i, '');
            text = text.trim();
            if (text) {
              promptText += text + '\n\n';
              hasSubjectiveQuestions = true;
            }
          }
        });
        return;
      }
      
      // 其次尝试获取主观题（fillinglong）的题目区域，排除客观题（filling）
      const subjectiveAreas = doc.querySelectorAll('[data-controltype="fillinglong"]');
      if (subjectiveAreas.length > 0) {
        subjectiveAreas.forEach((area) => {
          // 检查是否有实质性答案，如果有则跳过（会被自动填充）
          if (hasSubstantiveAnswer(area)) return;
          
          // 克隆并清理
          const clone = area.cloneNode(true);
          clone.querySelectorAll('style, script, .key, [data-itemtype="result"], textarea').forEach(el => el.remove());
          
          let text = clone.innerText?.trim();
          if (text) {
            // 清理 "Answers may vary" 等文本
            text = text.replace(/\(?Answers?\s*(may|will|could|can)?\s*vary\.?\)?/gi, '');
            text = text.replace(/\n{3,}/g, '\n\n').trim();
            if (text) {
              promptText += text + '\n\n';
              hasSubjectiveQuestions = true;
            }
          }
        });
        // 已处理 fillinglong，继续下一个 doc
        return;
      }
      
      // 如果没有找到特定题目区域，尝试获取通用内容（但排除 filling 类型）
      const contentAreas = doc.querySelectorAll('.question-content, .exercise-content');
      if (contentAreas.length > 0) {
        contentAreas.forEach((area) => {
          const text = area.innerText?.trim();
          if (text) {
            promptText += text + '\n\n';
            hasSubjectiveQuestions = true;
          }
        });
        return;
      }
      
      // 最后尝试获取 body 内容（排除脚本等）- 只在特殊情况下使用
      // 对于混合题目页面，不使用此方法，避免复制客观题内容
    });
    
    // 只有在有需要 AI 生成的主观题时才复制到剪贴板
    if (!hasSubjectiveQuestions) {
      console.info('[WeLearn-Go] 没有需要 AI 生成的主观题，跳过剪贴板复制');
      return;
    }
    
    // 复制到剪贴板
    navigator.clipboard.writeText(promptText.trim()).then(() => {
      showToast('检测到无标准答案的主观题，提示词已复制，请使用 AI 生成后填写', {
        duration: 0,
      });
    }).catch((err) => {
      console.error('[WeLearn-Go] 复制到剪贴板失败:', err);
      showToast('检测到无标准答案的主观题，请手动复制题目使用 AI 生成', {
        duration: 0,
      });
    });
  };

  /** 处理开放式练习（如口语大纲、录音等，复制题目到剪贴板） */
  const handleOpenEndedExercise = (container) => {
    if (openEndedExerciseShown) return;
    openEndedExerciseShown = true;
    disableAutoSubmit();
    
    // 构建提示词
    let promptText = '请根据要求完成以下口语练习，使用英语回答\n\n';
    
    // 获取题目内容
    const clone = container.cloneNode(true);
    // 移除不需要的元素
    clone.querySelectorAll('style, script, .key, button, et-recorder, textarea').forEach(el => el.remove());
    
    let text = clone.innerText?.trim();
    if (text) {
      // 清理多余的空白行
      text = text.replace(/\n{3,}/g, '\n\n').trim();
      promptText += text + '\n\n';
    }
    
    // 添加提示
    promptText += '---\n请为上述大纲的每个部分提供简短的要点内容。';
    
    // 复制到剪贴板
    navigator.clipboard.writeText(promptText.trim()).then(() => {
      showToast('该练习没有标准答案（口语/开放式），题目已复制，请使用 AI 生成后填写', {
        duration: 0,
      });
    }).catch((err) => {
      console.error('[WeLearn-Go] 复制到剪贴板失败:', err);
      showToast('该练习没有标准答案，请手动复制题目使用 AI 生成', {
        duration: 0,
      });
    });
  };

  /**
   * 尝试填充 Vue 组件管理的题目
   * @param {Element} doc - 文档对象
   * @param {Function} mutate - 答案变异函数
   */
  const fillVueItems = (doc, mutate) => {
    let filled = false;
    // 查找所有可能的输入元素
    const inputs = Array.from(doc.querySelectorAll('input, textarea, .option, .choice, .item-option'));
    
    inputs.forEach(el => {
      // 尝试获取 Vue 实例
      let vue = el.__vue__;
      if (!vue && el.parentElement) vue = el.parentElement.__vue__;
      if (!vue && el.parentElement?.parentElement) vue = el.parentElement.parentElement.__vue__;
      
      if (!vue) return;
      
      // 尝试从 Vue 数据中查找答案
      const possibleKeys = ['answer', 'correctAnswer', 'solution', 'key', 'rightAnswer', 'correct'];
      let answer = null;
      
      for (const key of possibleKeys) {
        if (vue[key] !== undefined) answer = vue[key];
        else if (vue.$data?.[key] !== undefined) answer = vue.$data[key];
        else if (vue.props?.[key] !== undefined) answer = vue.props[key];
        
        if (answer) break;
      }
      
      if (!answer) {
        // 尝试从全局上下文获取
        answer = findAnswerFromGlobalContext(el);
      }
      
      if (!answer) return;
      
      // 规范化答案
      if (Array.isArray(answer)) answer = answer.join(',');
      if (typeof answer !== 'string') answer = String(answer);
      
      answer = normalizeAnswer(answer);
      if (!answer) return;
      
      const finalValue = mutate(answer);
      
      // 填充逻辑
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        if (el.value !== finalValue) {
          el.value = finalValue;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          filled = true;
        }
      } else {
        // 可能是选择题选项
        const text = normalizeAnswer(el.textContent);
        // 检查是否匹配答案 (例如 "A" 匹配 "A. Option Text")
        if (text === finalValue || (finalValue.length === 1 && text.startsWith(finalValue))) {
           const isActive = el.classList.contains('active') || el.classList.contains('selected') || el.classList.contains('checked');
           if (!isActive) {
             el.click();
             filled = true;
           }
        }
      }
    });
    
    return filled;
  };

  /**
   * 填充所有题目（主入口函数）
   * @param {Object} options - 配置选项
   * @param {boolean} options.enableSoftErrors - 是否启用小错误
   * @returns {Object} 包含 filled 和 errors 的结果对象
   */
  const fillAll = ({ enableSoftErrors = false } = {}) => {
    if (!isWeLearnPage()) {
      console.debug('[WeLearn-Go] fillAll: 不是 WeLearn 页面');
      return { filled: false, errors: [] };
    }
    const mutator = createMistakeMutator(enableSoftErrors);
    const contexts = getAccessibleDocuments();
    let filledAny = false;
    
    console.info('[WeLearn-Go] fillAll 开始执行，文档数量:', contexts.length);

    // 检测是否为 Group Work（有或没有标准答案）
    const isOpenEnded = detectOpenEndedGroupWork(contexts);
    groupWorkDetected = detectGroupWork(contexts) || isOpenEnded;
    
    if (groupWorkDetected) {
      // 禁用自动提交
      disableAutoSubmit();
    }

    contexts.forEach((doc) => {
      // 原有的填空题和选择题处理
      const fillings = Array.from(
        doc.querySelectorAll('[data-controltype="filling"], [data-controltype="fillinglong"]'),
      );
      const choices = Array.from(
        doc.querySelectorAll('[data-controltype="choice"], .checkbox_choice, .radio_choice, .normal_choice'),
      );
      
      // AngularJS 组件
      const etItems = Array.from(doc.querySelectorAll('et-item'));
      const standaloneToggles = Array.from(doc.querySelectorAll('et-toggle:not(et-item et-toggle)'));
      const standaloneBlanks = Array.from(doc.querySelectorAll('et-blank:not(et-item et-blank)'));
      const standaloneChoices = Array.from(doc.querySelectorAll('et-choice:not(et-item et-choice)'));
      const standaloneTofs = Array.from(doc.querySelectorAll('et-tof:not(et-item et-tof)'));
      
      console.info('[WeLearn-Go] 找到元素:', {
        fillings: fillings.length,
        choices: choices.length,
        etItems: etItems.length,
        standaloneToggles: standaloneToggles.length,
        standaloneBlanks: standaloneBlanks.length,
        etChoices: standaloneChoices.length,
        standaloneTofs: standaloneTofs.length,
        docLocation: doc === document ? 'main' : 'iframe'
      });

      fillings.forEach((container, idx) => {
        console.debug('[WeLearn-Go] 处理 filling #' + idx, container.getAttribute('data-id'), container.getAttribute('data-controltype'));
        const changed = fillFillingItem(container, mutator.mutate);
        filledAny = filledAny || changed;
      });

      choices.forEach((container) => {
        const changed = fillChoiceItem(container);
        filledAny = filledAny || changed;
      });

      // AngularJS 组件适配（et-item 系列）
      etItems.forEach((etItem) => {
        console.info('[WeLearn-Go] 处理 et-item:', etItem.id, 'isNoInteraction:', isNoInteractionItem(etItem));
        const changed = fillEtItem(etItem, mutator.mutate);
        console.info('[WeLearn-Go] fillEtItem 返回:', changed);
        filledAny = filledAny || changed;
      });

      // 页面级别的 et-toggle 处理（不在 et-item 内的）
      standaloneToggles.forEach((toggle) => {
        const changed = fillEtToggle(toggle, mutator.mutate);
        filledAny = filledAny || changed;
      });

      // 页面级别的 et-blank 处理（不在 et-item 内的）
      standaloneBlanks.forEach((blank) => {
        const changed = fillEtBlank(blank, mutator.mutate);
        filledAny = filledAny || changed;
      });

      // 页面级别的 et-choice 二选一选择题处理
      standaloneChoices.forEach((choice) => {
        const changed = fillEtChoice(choice);
        filledAny = filledAny || changed;
      });

      // 页面级别的 et-tof 判断题处理（不在 et-item 内的）
      standaloneTofs.forEach((tof) => {
        const changed = fillEtTof(tof);
        filledAny = filledAny || changed;
      });

      // Vue 组件处理
      const vueChanged = fillVueItems(doc, mutator.mutate);
      filledAny = filledAny || vueChanged;
    });

    // 如果检测到开放性题目（Answers may vary），复制没有标准答案的主观题到剪贴板
    if (isOpenEnded) {
      handleOpenEndedGroupWork(contexts);
    }
    
    // 显示 Group Work 提示
    if (groupWorkDetected && !groupWorkNoticeShown) {
      groupWorkNoticeShown = true;
      
      // 检查是否有 fillinglong（主观题）被填充
      const hasFilledSubjective = contexts.some(doc => {
        const fillinglongs = doc.querySelectorAll('[data-controltype="fillinglong"]');
        return Array.from(fillinglongs).some(el => {
          const textarea = el.querySelector('textarea');
          return textarea && textarea.value.trim().length > 0;
        });
      });
      
      if (hasFilledSubjective) {
        // 有主观题被填充了参考答案
        showToast('检测到 Group Work / Pair Work，已填充参考答案，建议修改或使用 AI 重写后再提交', {
          duration: 6000,
        });
      } else if (filledAny) {
        // 只填充了客观题
        showToast('检测到 Group Work / Pair Work，已填充客观题，请检查后提交', {
          duration: 5000,
        });
      }
    }

    return { filled: filledAny, errors: mutator.getErrors(), targetCount: mutator.getTargetCount() };
  };

  /** 自动提交答案（如果启用且不是 Group Work） */
  const submitIfNeeded = (shouldSubmit) => {
    if (!shouldSubmit || !isWeLearnPage() || groupWorkDetected) return;
    const contexts = getAccessibleDocuments();
    
    // 查找并点击提交按钮
    for (const doc of contexts) {
      // 方法1：原有的 data-controltype="submit" 选择器
      let submitButton = doc.querySelector('[data-controltype="submit"]');
      if (submitButton) {
        if (!submitButton.disabled && !submitButton.hasAttribute('disabled')) {
          submitButton.click();
          console.log('[WeLearn] 已点击提交按钮 (data-controltype)');
          return;
        }
      }
      
      // 方法2：查找 et-button[action*="submit"] 的 AngularJS 按钮
      // 这种按钮结构是: <et-button action="item.submit()"><button ng-click="btn.doAction()">
      const etButtons = doc.querySelectorAll('et-button[action*="submit"]');
      for (const etBtn of etButtons) {
        // 检查是否可见且未禁用
        const isHidden = etBtn.classList.contains('ng-hide') || 
                         etBtn.style.display === 'none' ||
                         etBtn.offsetParent === null;
        const isDisabled = etBtn.hasAttribute('disabled') && 
                           etBtn.getAttribute('disabled') !== 'false';
        
        if (!isHidden && !isDisabled) {
          const innerBtn = etBtn.querySelector('button');
          if (innerBtn && !innerBtn.disabled) {
            // 尝试通过 AngularJS scope 调用
            try {
              const scope = angular.element(etBtn).isolateScope() || 
                           angular.element(etBtn).scope();
              if (scope && scope.btn && typeof scope.btn.doAction === 'function') {
                scope.btn.doAction();
                console.log('[WeLearn] 已调用 btn.doAction() 提交');
                return;
              }
            } catch (e) {
              console.log('[WeLearn] AngularJS 调用失败，尝试直接点击');
            }
            
            // 回退：直接点击按钮
            innerBtn.click();
            console.log('[WeLearn] 已点击提交按钮 (et-button)');
            return;
          }
        }
      }
      
      // 方法3：查找 controls 区域中未提交状态的按钮
      // 特征：在 et-item .controls 内，ng-hide="item.isSubmitted"
      const controlsArea = doc.querySelector('et-item > .controls');
      if (controlsArea) {
        const buttons = controlsArea.querySelectorAll('et-button');
        for (const btn of buttons) {
          const ngHide = btn.getAttribute('ng-hide');
          // 查找带 isSubmitted 条件的按钮（未提交时显示）
          if (ngHide && ngHide.includes('isSubmitted')) {
            const innerBtn = btn.querySelector('button');
            if (innerBtn && !innerBtn.disabled && btn.offsetParent !== null) {
              try {
                const scope = angular.element(btn).isolateScope() || 
                             angular.element(btn).scope();
                if (scope && scope.btn && typeof scope.btn.doAction === 'function') {
                  scope.btn.doAction();
                  console.log('[WeLearn] 已调用控制区提交按钮');
                  return;
                }
              } catch (e) {
                // 忽略
              }
              innerBtn.click();
              console.log('[WeLearn] 已点击控制区提交按钮');
              return;
            }
          }
        }
      }
      
      // 方法4：通过 et-item 的 scope 直接调用 submit
      const etItems = doc.querySelectorAll('et-item');
      for (const etItem of etItems) {
        try {
          const scope = angular.element(etItem).scope();
          if (scope && scope.item && typeof scope.item.submit === 'function') {
            // 检查是否已提交
            if (!scope.item.isSubmitted && !scope.item.suspendSubmit) {
              scope.item.submit();
              console.log('[WeLearn] 已通过 scope.item.submit() 提交');
              return;
            }
          }
        } catch (e) {
          // 忽略
        }
      }
    }
    
    console.log('[WeLearn] 未找到可用的提交按钮');
  };

  /** 
   * 自动处理提交确认对话框
   * 当点击提交按钮后，可能会弹出 layui 对话框要求二次确认
   * 此函数会自动点击"是"按钮完成确认
   */
  const autoConfirmSubmitDialog = () => {
    // 使用 MutationObserver 监听对话框的出现
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          
          // 检查是否是 layui 对话框
          if (node.classList?.contains('layui-layer-dialog') || 
              node.querySelector?.('.layui-layer-dialog')) {
            
            const dialog = node.classList.contains('layui-layer-dialog') 
              ? node 
              : node.querySelector('.layui-layer-dialog');
            
            if (!dialog) continue;
            
            // 检查对话框内容是否包含提交确认文字
            const content = dialog.querySelector('.layui-layer-content');
            if (content && content.textContent?.includes('提交')) {
              // 查找"是"按钮并点击
              const confirmBtn = dialog.querySelector('.layui-layer-btn0');
              if (confirmBtn) {
                console.log('[WeLearn-Go] 自动确认提交对话框');
                setTimeout(() => {
                  confirmBtn.click();
                }, 100);
              }
            }
          }
        }
      }
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    
    // 返回一个清理函数
    return () => observer.disconnect();
  };

  // 启动自动确认监听
  let confirmDialogCleanup = null;
  const startAutoConfirmDialog = () => {
    if (!confirmDialogCleanup) {
      confirmDialogCleanup = autoConfirmSubmitDialog();
    }
  };

  // ==================== 批量任务处理功能 ====================

  /** 加载已完成的任务记录 */
  const loadBatchCompleted = () => {
    try {
      const raw = localStorage.getItem(BATCH_COMPLETED_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (error) {
      console.warn('WeLearn: 加载已完成记录失败', error);
      return {};
    }
  };

  /** 保存已完成的任务记录 */
  const saveBatchCompleted = (completed) => {
    try {
      localStorage.setItem(BATCH_COMPLETED_KEY, JSON.stringify(completed));
    } catch (error) {
      console.warn('WeLearn: 保存已完成记录失败', error);
    }
  };

  /** 标记任务为已完成 */
  const markTaskCompleted = (taskId, courseName) => {
    const completed = loadBatchCompleted();
    if (!completed[courseName]) {
      completed[courseName] = [];
    }
    if (!completed[courseName].includes(taskId)) {
      completed[courseName].push(taskId);
      saveBatchCompleted(completed);
    }
  };

  /** 检查任务是否已完成 */
  const isTaskCompleted = (taskId, courseName) => {
    const completed = loadBatchCompleted();
    return completed[courseName]?.includes(taskId) || false;
  };

  /** 清除课程的完成记录 */
  const clearCourseCompleted = (courseName) => {
    const completed = loadBatchCompleted();
    if (completed[courseName]) {
      delete completed[courseName];
      saveBatchCompleted(completed);
    }
  };

  /** 保存批量模式状态 */
  const saveBatchModeState = (state) => {
    try {
      // 添加时间戳用于检测异常关闭
      state.lastUpdate = Date.now();
      localStorage.setItem(BATCH_MODE_KEY, JSON.stringify(state));
    } catch (error) {
      console.warn('WeLearn: 保存批量模式状态失败', error);
    }
  };

  /** 加载批量模式状态 */
  const loadBatchModeState = () => {
    try {
      const raw = localStorage.getItem(BATCH_MODE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.warn('WeLearn: 加载批量模式状态失败', error);
      return null;
    }
  };

  /** 清除批量模式状态 */
  const clearBatchModeState = () => {
    try {
      localStorage.removeItem(BATCH_MODE_KEY);
    } catch (error) {
      console.warn('WeLearn: 清除批量模式状态失败', error);
    }
  };

  /** 获取当前课程 ID */
  const getCourseId = () => {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('cid') || '';
  };

  /** 获取当前课程名称 */
  const getCourseName = () => {
    // 尝试从页面标题或特定元素获取课程名
    const courseTitle = document.querySelector('.course_title, .courseName, #courseName, .courseware_title');
    if (courseTitle) {
      return courseTitle.textContent?.trim() || '未知课程';
    }
    // 从 URL 参数获取课程 ID
    const cid = getCourseId();
    return cid ? `课程 ${cid}` : '未知课程';
  };

  /** 保存课程目录缓存 */
  const saveCourseDirectoryCache = (courseId, courseName, tasks) => {
    try {
      const cache = {
        courseId,
        courseName,
        tasks,
        timestamp: Date.now()
      };
      localStorage.setItem(COURSE_DIRECTORY_CACHE_KEY, JSON.stringify(cache));
      console.info('[WeLearn-Go] 课程目录已缓存:', courseName, tasks.length, '个任务');
    } catch (error) {
      console.warn('[WeLearn-Go] 保存目录缓存失败:', error);
    }
  };

  /** 加载课程目录缓存 */
  const loadCourseDirectoryCache = () => {
    try {
      const raw = localStorage.getItem(COURSE_DIRECTORY_CACHE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (error) {
      console.warn('[WeLearn-Go] 加载目录缓存失败:', error);
      return null;
    }
  };

  /** 保存批量任务选择缓存 */
  const saveBatchTasksCache = (courseName, tasks) => {
    try {
      const cache = {
        courseName,
        tasks,
        timestamp: Date.now()
      };
      localStorage.setItem(BATCH_TASKS_CACHE_KEY, JSON.stringify(cache));
      console.info('[WeLearn-Go] 批量任务已缓存:', tasks.length, '个任务');
    } catch (error) {
      console.warn('[WeLearn-Go] 保存任务缓存失败:', error);
    }
  };

  /** 加载批量任务选择缓存 */
  const loadBatchTasksCache = () => {
    try {
      const raw = localStorage.getItem(BATCH_TASKS_CACHE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (error) {
      console.warn('[WeLearn-Go] 加载任务缓存失败:', error);
      return null;
    }
  };

  /** 清除批量任务选择缓存 */
  const clearBatchTasksCache = () => {
    try {
      localStorage.removeItem(BATCH_TASKS_CACHE_KEY);
    } catch (error) {
      console.warn('[WeLearn-Go] 清除任务缓存失败:', error);
    }
  };

  /** 扫描页面上所有可执行的任务元素 */
  const scanPageForTasks = () => {
    const tasks = [];
    const seenIds = new Set();
    const completed = loadBatchCompleted();
    const courseName = getCourseName();
    const completedTasks = completed[courseName] || [];

    console.log('[WeLearn-Go] 开始扫描页面任务...');
    
    // 通用方法: 查找所有包含 StartSCO 的 onclick 元素
    const allClickableElements = document.querySelectorAll('[onclick*="StartSCO"]');
    console.log('[WeLearn-Go] 找到 StartSCO 元素:', allClickableElements.length);
    
    allClickableElements.forEach((el) => {
      const onclickAttr = el.getAttribute('onclick') || '';
      const scoMatch = onclickAttr.match(/StartSCO\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (!scoMatch) return;
      
      const taskId = scoMatch[1];
      if (seenIds.has(taskId)) return;
      seenIds.add(taskId);
      
      // 获取标题 - 尝试多种方式
      let title = '';
      
      // 尝试从 span 子元素获取
      const span = el.querySelector('span');
      if (span) {
        const spanClone = span.cloneNode(true);
        // 移除图标
        spanClone.querySelectorAll('i, .fa, .icon').forEach(icon => icon.remove());
        title = spanClone.textContent?.trim() || '';
      }
      
      // 尝试从 a 标签获取
      if (!title) {
        const link = el.querySelector('a');
        title = link?.getAttribute('title') || link?.textContent?.trim() || '';
      }
      
      // 尝试从元素本身获取文本
      if (!title) {
        const elClone = el.cloneNode(true);
        elClone.querySelectorAll('i, .fa, .icon, .progress, .badge').forEach(n => n.remove());
        title = elClone.textContent?.trim().substring(0, 80) || taskId;
      }
      
      // 获取父级单元名称
      let unitName = '';
      let isIntro = false; // 是否是课程介绍类（0/0任务组）
      
      // 尝试从最近的 panel-heading 获取
      const panelHeading = el.closest('.panel')?.querySelector('.panel-title > a');
      if (panelHeading) {
        const headingClone = panelHeading.cloneNode(true);
        headingClone.querySelectorAll('.progress_fix, .badge').forEach(n => n.remove());
        unitName = headingClone.textContent?.trim() || '';
        
        // 检查是否是 0/0 任务组（课程介绍类）
        const progressFix = el.closest('.panel')?.querySelector('.progress_fix');
        if (progressFix) {
          const progressText = progressFix.textContent || '';
          // 匹配类似 "X /0" 的模式，表示总任务数为0
          if (/\/\s*0\s*$/.test(progressText)) {
            isIntro = true;
          }
        }
      }
      
      // 尝试从 u_listtitle 获取
      if (!unitName) {
        let prevEl = el.previousElementSibling || el.parentElement;
        while (prevEl && !unitName) {
          if (prevEl.classList?.contains('u_listtitle')) {
            unitName = prevEl.textContent?.trim().substring(0, 50) || '';
            break;
          }
          prevEl = prevEl.previousElementSibling || prevEl.parentElement;
        }
      }
      
      // 判断状态
      const isDisabled = el.classList.contains('disabled') || 
                        el.classList.contains('list-disabled') ||
                        el.classList.contains('course_disable');
      
      const icon = el.querySelector('i.fa');
      const pageCompleted = icon?.classList.contains('fa-check-circle-o');
      const isCompletedByUs = completedTasks.includes(taskId);
      const isCompleted = isCompletedByUs || pageCompleted;
      
      tasks.push({
        id: taskId,
        title: title,
        unitName: unitName,
        isDisabled: isDisabled,
        isCompleted: isCompleted,
        isIntro: isIntro,
        element: el,
        onclick: onclickAttr
      });
    });

    // 如果没有找到 StartSCO，尝试其他结构
    if (tasks.length === 0) {
      console.log('[WeLearn-Go] 未找到 StartSCO 元素，尝试其他结构...');
      
      // 旧版结构: courseware_list
      const coursewareItems = document.querySelectorAll('.courseware_list_1_3, .courseware_list_1_4');
      console.log('[WeLearn-Go] 找到 courseware_list 元素:', coursewareItems.length);
      
      coursewareItems.forEach((item) => {
        const taskId = item.id || item.getAttribute('data-sco') || '';
        if (!taskId || seenIds.has(taskId)) return;
        seenIds.add(taskId);
        
        const link = item.querySelector('a');
        const title = link?.getAttribute('title') || link?.textContent?.trim() || '';
        
        const isDisabled = item.classList.contains('course_disable');
        const isCompletedByUs = completedTasks.includes(taskId);
        const hasProgress = item.querySelector('.progress-complete, .completed');
        const isCompleted = isCompletedByUs || !!hasProgress;

        let unitName = '';
        const categoryContainer = item.closest('.categoryitems');
        if (categoryContainer) {
          const prevHeader = categoryContainer.previousElementSibling;
          if (prevHeader?.classList?.contains('courseware_list_1_1')) {
            const unitSpan = prevHeader.querySelector('.v_1');
            unitName = unitSpan?.textContent?.trim() || '';
          }
        }

        if (title && taskId) {
          tasks.push({
            id: taskId,
            title: title,
            unitName: unitName,
            isDisabled: isDisabled,
            isCompleted: isCompleted,
            element: item
          });
        }
      });
    }

    console.log('[WeLearn-Go] 扫描完成，共找到任务:', tasks.length);
    return tasks;
  };

  /** 获取课程目录中的所有任务（使用扫描方法） */
  const getCourseTaskList = () => {
    return scanPageForTasks();
  };

  /** 展开所有目录项 */
  const expandAllCategories = async () => {
    // 检测是否在 course_info.aspx 页面
    const isCourseInfoPage = window.location.href.includes('course_info.aspx');
    
    if (isCourseInfoPage) {
      // 首先确保点击了"目录"标签
      const tabs = document.querySelectorAll('.nav-tabs li a, .course-tabs a, [role="tab"]');
      for (const tab of tabs) {
        if (tab.textContent?.includes('目录')) {
          tab.click();
          await new Promise(resolve => setTimeout(resolve, 500));
          break;
        }
      }
      
      // 展开所有单元 (点击每个单元行的展开按钮)
      const unitRows = document.querySelectorAll('.u_listtitle, .unit-row, [data-toggle="collapse"]');
      for (const row of unitRows) {
        // 检查是否已展开
        const isExpanded = row.classList.contains('expanded') || 
                          row.getAttribute('aria-expanded') === 'true';
        if (!isExpanded) {
          const expandBtn = row.querySelector('.expand-btn, .plus-icon, .fa-plus') || row;
          expandBtn.click();
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
    }
    
    // stu_unitlist 结构: 点击 collapsed 的 panel 标题来展开
    const collapsedPanels = document.querySelectorAll('.stu_unitlist .panel-title > a.collapsed');
    for (const link of collapsedPanels) {
      link.click();
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    // 旧版结构: 点击所有折叠的单元头部来展开
    const collapsedHeaders = document.querySelectorAll('.courseware_list_1_1:not(.openheader)');
    collapsedHeaders.forEach((header) => {
      header.click();
    });
    
    // 等待展开动画完成
    return new Promise(resolve => setTimeout(resolve, 800));
  };

  /** 检查当前页面是否是课程目录页面（而非任务执行页面） */
  const isOnCourseDirectoryPage = () => {
    const url = window.location.href;
    // 任务执行页面包含 StudyCourse.aspx，不是目录页面
    if (url.includes('StudyCourse.aspx')) {
      return false;
    }
    // 目录页面的 URL 特征
    return url.includes('course_info.aspx') || 
           url.includes('study.aspx') ||
           url.includes('directory.aspx');
  };

  /** 生成任务列表 HTML */
  const generateTasksHtml = (availableTasks, savedTaskIds = []) => {
    // 按单元分组任务
    const tasksByUnit = {};
    availableTasks.forEach(task => {
      const unit = task.unitName || '其他';
      if (!tasksByUnit[unit]) {
        tasksByUnit[unit] = [];
      }
      tasksByUnit[unit].push(task);
    });

    let tasksHtml = '';
    Object.entries(tasksByUnit).forEach(([unitName, unitTasks]) => {
      // 检测是否是"课程说明"类型的单元（通过名称或 isIntro 属性）
      const isIntroUnit = unitTasks.every(t => t.isIntro) || 
                          /^课程(说明|介绍|简介)/.test(unitName) ||
                          /^(Course\s*)?(Introduction|Info|Description)/i.test(unitName);
      
      tasksHtml += `
        <div class="welearn-task-unit">
          <div class="welearn-task-unit-header">
            <label class="welearn-checkbox-label">
              <input type="checkbox" class="welearn-unit-checkbox" data-unit="${unitName}" ${isIntroUnit ? 'disabled' : ''}>
              <span>${unitName || '任务列表'}</span>
            </label>
          </div>
          <div class="welearn-task-list">
            ${unitTasks.map(task => {
              const taskIsIntro = task.isIntro || isIntroUnit;
              return `
              <label class="welearn-task-item ${task.isCompleted ? 'completed' : ''} ${taskIsIntro ? 'intro' : ''}">
                <input type="checkbox" class="welearn-task-checkbox" 
                       data-task-id="${task.id}" 
                       data-title="${task.title}"
                       ${task.isCompleted || taskIsIntro ? 'disabled' : ''}
                       ${savedTaskIds.includes(task.id) && !task.isCompleted && !taskIsIntro ? 'checked' : ''}>
                <span class="welearn-task-title">${task.title}</span>
                ${task.isCompleted 
                  ? '<span class="welearn-task-badge">✓ 已完成</span>' 
                  : taskIsIntro
                    ? '<span class="welearn-task-badge intro">◇ 无需填写</span>'
                    : '<span class="welearn-task-badge pending">○ 待完成</span>'}
              </label>
            `}).join('')}
          </div>
        </div>
      `;
    });
    return tasksHtml;
  };

  /** 显示任务选择模态框 */
  const showTaskSelectorModal = async (forceRefresh = false) => {
    const currentCourseId = getCourseId();
    const currentCourseName = getCourseName();
    const cache = loadCourseDirectoryCache();
    const tasksCache = loadBatchTasksCache();
    
    // 检查是否有可用缓存且课程匹配
    const hasCacheForCurrentCourse = cache && cache.courseId === currentCourseId && cache.tasks?.length > 0;
    const courseIdMismatch = cache && cache.courseId && cache.courseId !== currentCourseId;
    
    // 创建模态框
    const overlay = document.createElement('div');
    overlay.className = 'welearn-modal-overlay welearn-task-selector';
    
    // 显示加载动画
    const showLoading = () => {
      overlay.innerHTML = `
        <div class="welearn-modal welearn-task-modal">
          <h3>📖 课程目录 - ${currentCourseName}</h3>
          <div class="welearn-loading-container">
            <div class="welearn-loading-spinner"></div>
            <p>正在读取课程目录...</p>
          </div>
        </div>
      `;
    };
    
    // 渲染任务列表
    const renderTaskList = (availableTasks, showMismatchWarning = false, isFromCache = false) => {
      if (availableTasks.length === 0) {
        overlay.innerHTML = `
          <div class="welearn-modal welearn-task-modal">
            <h3>📖 课程目录 - ${currentCourseName}</h3>
            <p class="welearn-task-desc" style="color: #ef4444;">未找到可执行的任务</p>
            <div class="welearn-modal-footer">
              <button type="button" class="welearn-modal-cancel">关闭</button>
              <button type="button" class="welearn-btn-refresh">🔄 重新读取</button>
            </div>
          </div>
        `;
        overlay.querySelector('.welearn-modal-cancel')?.addEventListener('click', () => overlay.remove());
        overlay.querySelector('.welearn-btn-refresh')?.addEventListener('click', () => {
          showLoading();
          refreshDirectory();
        });
        return;
      }

      // 检查是否有之前保存的任务选择
      const savedTaskIds = (tasksCache && tasksCache.courseName === currentCourseName) 
        ? tasksCache.tasks.map(t => t.id) 
        : [];

      const tasksHtml = generateTasksHtml(availableTasks, savedTaskIds);
      const cacheTime = isFromCache && cache?.timestamp 
        ? new Date(cache.timestamp).toLocaleString('zh-CN') 
        : '';

      overlay.innerHTML = `
        <div class="welearn-modal welearn-task-modal">
          <h3>📖 课程目录 - ${currentCourseName}</h3>
          ${showMismatchWarning ? `
            <p class="welearn-warning-text">⚠️ 缓存的课程与当前课程不匹配，建议重新读取</p>
          ` : ''}
          <p class="welearn-task-desc">
            勾选要执行的任务，然后点击「⚡ 批量执行」按钮开始。
            ${isFromCache ? `<span class="welearn-cache-time">（缓存于 ${cacheTime}）</span>` : ''}
          </p>
          
          <div class="welearn-task-actions-top">
            <button type="button" class="welearn-btn-select-all">全选未完成</button>
            <button type="button" class="welearn-btn-deselect-all">取消全选</button>
            <button type="button" class="welearn-btn-refresh">🔄 重新读取目录</button>
            <button type="button" class="welearn-btn-refresh-status">🔃 刷新完成状态</button>
          </div>
          
          <div class="welearn-task-container">
            ${tasksHtml}
          </div>
          
          <div class="welearn-task-summary">
            已选择: <span class="welearn-selected-count">0</span> 个任务
          </div>
          
          <div class="welearn-modal-footer">
            <button type="button" class="welearn-modal-cancel">取消</button>
            <button type="button" class="welearn-modal-confirm" disabled>✓ 确认选择</button>
          </div>
        </div>
      `;

      bindTaskListEvents(overlay, currentCourseName, availableTasks);
    };

    // 从页面刷新读取目录
    const refreshDirectory = async () => {
      showLoading();
      
      // 等待展开所有目录
      await expandAllCategories();
      
      const tasks = getCourseTaskList();
      const availableTasks = tasks.filter(t => !t.isDisabled);
      
      // 保存到缓存
      saveCourseDirectoryCache(currentCourseId, currentCourseName, availableTasks);
      
      renderTaskList(availableTasks, false, false);
      showToast(`已读取 ${availableTasks.length} 个任务`, { duration: 2000 });
    };

    // 刷新完成状态（从页面重新扫描任务状态）
    const refreshCompletionStatus = async (cachedTasks) => {
      showLoading();
      
      // 重新扫描页面获取最新任务状态
      const freshTasks = getCourseTaskList();
      const freshTaskMap = new Map(freshTasks.map(t => [t.id, t]));
      
      // 我们自己的完成记录
      const completed = loadBatchCompleted();
      const ourCompletedTasks = completed[currentCourseName] || [];
      
      // 更新任务的完成状态（综合页面状态和我们的记录）
      const updatedTasks = cachedTasks.map(task => {
        const freshTask = freshTaskMap.get(task.id);
        const isCompleted = (freshTask?.isCompleted) || ourCompletedTasks.includes(task.id);
        return {
          ...task,
          isCompleted: isCompleted
        };
      });
      
      // 更新缓存
      saveCourseDirectoryCache(currentCourseId, currentCourseName, updatedTasks);
      
      renderTaskList(updatedTasks, false, true);
      
      // 统计完成数量
      const completedCount = updatedTasks.filter(t => t.isCompleted).length;
      showToast(`已刷新完成状态 (${completedCount}/${updatedTasks.length} 已完成)`, { duration: 2000 });
    };

    document.body.appendChild(overlay);
    
    // 点击遮罩关闭
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
      }
    });

    // 如果强制刷新或没有缓存，直接读取
    if (forceRefresh || !hasCacheForCurrentCourse) {
      if (courseIdMismatch) {
        // 课程不匹配，显示警告并读取
        showLoading();
        await refreshDirectory();
      } else {
        // 无缓存，直接读取
        showLoading();
        await refreshDirectory();
      }
    } else {
      // 有缓存，先刷新完成状态
      await refreshCompletionStatus(cache.tasks);
    }
  };

  /** 绑定任务列表事件 */
  const bindTaskListEvents = (overlay, courseName, availableTasks) => {
    const taskCheckboxes = overlay.querySelectorAll('.welearn-task-checkbox:not([disabled])');
    const unitCheckboxes = overlay.querySelectorAll('.welearn-unit-checkbox');
    const selectedCountEl = overlay.querySelector('.welearn-selected-count');
    const confirmButton = overlay.querySelector('.welearn-modal-confirm');
    const cancelButton = overlay.querySelector('.welearn-modal-cancel');
    const selectAllBtn = overlay.querySelector('.welearn-btn-select-all');
    const deselectAllBtn = overlay.querySelector('.welearn-btn-deselect-all');
    const refreshBtn = overlay.querySelector('.welearn-btn-refresh');
    const refreshStatusBtn = overlay.querySelector('.welearn-btn-refresh-status');

    /** 更新选中数量和按钮状态 */
    const updateSelectionState = () => {
      const checkedCount = overlay.querySelectorAll('.welearn-task-checkbox:checked').length;
      selectedCountEl.textContent = checkedCount;
      confirmButton.disabled = checkedCount === 0;
      
      // 更新单元复选框状态
      unitCheckboxes.forEach(unitCb => {
        const unitContainer = unitCb.closest('.welearn-task-unit');
        const unitTasks = unitContainer?.querySelectorAll('.welearn-task-checkbox:not([disabled])') || [];
        const checkedInUnit = unitContainer?.querySelectorAll('.welearn-task-checkbox:checked').length || 0;
        
        unitCb.checked = unitTasks.length > 0 && checkedInUnit === unitTasks.length;
        unitCb.indeterminate = checkedInUnit > 0 && checkedInUnit < unitTasks.length;
      });
    };

    // 初始化选中状态
    updateSelectionState();

    // 任务复选框事件
    taskCheckboxes.forEach(cb => {
      cb.addEventListener('change', updateSelectionState);
    });

    // 单元复选框事件
    unitCheckboxes.forEach(unitCb => {
      unitCb.addEventListener('change', () => {
        const unitContainer = unitCb.closest('.welearn-task-unit');
        const unitTasks = unitContainer?.querySelectorAll('.welearn-task-checkbox:not([disabled])') || [];
        unitTasks.forEach(cb => {
          cb.checked = unitCb.checked;
        });
        updateSelectionState();
      });
    });

    // 全选按钮
    selectAllBtn?.addEventListener('click', () => {
      taskCheckboxes.forEach(cb => { cb.checked = true; });
      updateSelectionState();
    });

    // 取消全选按钮
    deselectAllBtn?.addEventListener('click', () => {
      taskCheckboxes.forEach(cb => { cb.checked = false; });
      updateSelectionState();
    });

    // 重新读取按钮
    refreshBtn?.addEventListener('click', () => {
      showTaskSelectorModal(true);
      overlay.remove();
    });

    // 刷新完成状态按钮 - 重新扫描页面获取最新完成状态
    refreshStatusBtn?.addEventListener('click', async () => {
      refreshStatusBtn.disabled = true;
      refreshStatusBtn.textContent = '刷新中...';
      
      // 保存当前选中的任务ID
      const checkedTaskIds = [];
      overlay.querySelectorAll('.welearn-task-checkbox:checked').forEach(cb => {
        checkedTaskIds.push(cb.dataset.taskId);
      });
      
      // 重新扫描页面获取最新任务状态
      const freshTasks = getCourseTaskList();
      const freshTaskMap = new Map(freshTasks.map(t => [t.id, t]));
      
      // 我们自己的完成记录
      const completed = loadBatchCompleted();
      const ourCompletedTasks = completed[courseName] || [];
      
      // 更新任务列表中的完成状态
      overlay.querySelectorAll('.welearn-task-item').forEach(item => {
        const checkbox = item.querySelector('.welearn-task-checkbox');
        if (!checkbox) return;
        
        const taskId = checkbox.dataset.taskId;
        const freshTask = freshTaskMap.get(taskId);
        
        // 综合判断：页面显示已完成 或 我们的记录显示已完成
        const isNowCompleted = (freshTask?.isCompleted) || ourCompletedTasks.includes(taskId);
        const wasCompleted = item.classList.contains('completed');
        
        if (isNowCompleted && !wasCompleted) {
          // 新完成的任务
          item.classList.add('completed');
          checkbox.checked = false;
          checkbox.disabled = true;
          
          // 更新徽章为已完成（绿色）
          let badge = item.querySelector('.welearn-task-badge');
          if (!badge) {
            badge = document.createElement('span');
            item.appendChild(badge);
          }
          badge.className = 'welearn-task-badge';
          badge.textContent = '✓ 已完成';
        } else if (!isNowCompleted && wasCompleted) {
          // 之前标记完成但现在未完成
          item.classList.remove('completed');
          checkbox.disabled = false;
          
          // 更新徽章为待完成（黄色）
          let badge = item.querySelector('.welearn-task-badge');
          if (!badge) {
            badge = document.createElement('span');
            item.appendChild(badge);
          }
          badge.className = 'welearn-task-badge pending';
          badge.textContent = '○ 待完成';
          
          // 恢复之前的选中状态
          if (checkedTaskIds.includes(taskId)) {
            checkbox.checked = true;
          }
        }
      });
      
      // 更新缓存中的任务状态
      const currentCourseId = getCourseId();
      const validTasks = freshTasks.filter(t => !t.isDisabled);
      saveCourseDirectoryCache(currentCourseId, courseName, validTasks);
      
      // 计算完成数量
      const completedCount = validTasks.filter(t => 
        t.isCompleted || ourCompletedTasks.includes(t.id)
      ).length;
      
      updateSelectionState();
      refreshStatusBtn.disabled = false;
      refreshStatusBtn.textContent = '🔃 刷新完成状态';
      showToast(`已刷新完成状态 (${completedCount}/${validTasks.length} 已完成)`, { duration: 2000 });
    });

    // 取消按钮
    cancelButton?.addEventListener('click', () => {
      overlay.remove();
    });

    // 确认选择按钮
    confirmButton?.addEventListener('click', () => {
      const tasks = [];
      overlay.querySelectorAll('.welearn-task-checkbox:checked').forEach(cb => {
        tasks.push({
          id: cb.dataset.taskId,
          title: cb.dataset.title
        });
      });

      if (tasks.length === 0) {
        showToast('请至少选择一个任务');
        return;
      }

      // 保存选择的任务到全局变量和缓存
      selectedBatchTasks = tasks;
      selectedCourseName = courseName;
      saveBatchTasksCache(courseName, tasks);
      
      overlay.remove();
      showToast(`已选择 ${tasks.length} 个任务，点击「⚡ 批量执行」开始`, { duration: 3000 });
      
      updateBatchButtonState();
    });
  };

  /** 显示恢复批量任务提示 */
  const showBatchTasksRecoveryPrompt = () => {
    const tasksCache = loadBatchTasksCache();
    if (!tasksCache || !tasksCache.tasks || tasksCache.tasks.length === 0) return;
    
    const currentCourseName = getCourseName();
    const isSameCourse = tasksCache.courseName === currentCourseName;
    const cacheTime = new Date(tasksCache.timestamp).toLocaleString('zh-CN');
    
    const overlay = document.createElement('div');
    overlay.className = 'welearn-modal-overlay welearn-recovery-prompt';
    overlay.innerHTML = `
      <div class="welearn-modal welearn-recovery-modal">
        <h3>📋 发现未完成的批量任务</h3>
        <p>
          上次选择了 <strong>${tasksCache.tasks.length}</strong> 个任务
          ${!isSameCourse ? `<br><span class="welearn-warning-text">⚠️ 来自其他课程: ${tasksCache.courseName}</span>` : ''}
        </p>
        <p class="welearn-cache-time">保存于: ${cacheTime}</p>
        <div class="welearn-modal-footer">
          <button type="button" class="welearn-modal-cancel">忽略</button>
          <button type="button" class="welearn-modal-confirm">恢复任务列表</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(overlay);
    
    overlay.querySelector('.welearn-modal-cancel')?.addEventListener('click', () => {
      clearBatchTasksCache();
      overlay.remove();
      showToast('已忽略，任务列表已清除');
    });
    
    overlay.querySelector('.welearn-modal-confirm')?.addEventListener('click', () => {
      // 恢复任务列表
      selectedBatchTasks = tasksCache.tasks;
      selectedCourseName = tasksCache.courseName;
      updateBatchButtonState();
      overlay.remove();
      showToast(`已恢复 ${tasksCache.tasks.length} 个任务，点击「⚡ 批量执行」开始`, { duration: 3000 });
    });
    
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        // 点击背景只关闭对话框，不清除缓存（下次还会提示）
        overlay.remove();
      }
    });
  };

  /** 更新批量执行按钮状态 */
  const updateBatchButtonState = () => {
    const batchBtn = document.querySelector('.welearn-batch-btn');
    if (batchBtn) {
      if (selectedBatchTasks.length > 0) {
        batchBtn.textContent = `⚡ 执行 (${selectedBatchTasks.length})`;
        batchBtn.style.boxShadow = '0 0 0 2px rgba(56, 189, 248, 0.5), 0 6px 14px rgba(245, 158, 11, 0.3)';
      } else {
        batchBtn.textContent = '⚡ 批量执行';
        batchBtn.style.boxShadow = '';
      }
    }
  };

  /** 执行已选择的批量任务 */
  const executeBatchTasks = () => {
    if (selectedBatchTasks.length === 0) {
      showToast('请先点击「📖 查看目录」选择要执行的任务', { duration: 3000 });
      return;
    }
    
    const taskCount = selectedBatchTasks.length;
    const courseName = selectedCourseName;
    
    // 清空已选任务（防止重复执行）
    const tasksToExecute = [...selectedBatchTasks];
    selectedBatchTasks = [];
    selectedCourseName = '';
    updateBatchButtonState();
    
    // 开始执行
    startBatchExecution(tasksToExecute, courseName);
  };

  /** 开始批量执行任务 */
  const startBatchExecution = (tasks, courseName) => {
    if (tasks.length === 0) {
      showToast('所有任务已完成！');
      clearBatchModeState();
      return;
    }

    batchModeActive = true;
    batchTaskQueue = [...tasks];
    
    // 清除任务选择缓存（任务已开始执行，不需要恢复提示了）
    clearBatchTasksCache();
    
    // 保存状态到 localStorage（用于页面跳转后恢复）
    saveBatchModeState({
      active: true,
      queue: batchTaskQueue,
      courseName: courseName,
      currentIndex: 0,
      totalTasks: tasks.length,
      phase: 'navigating' // 'navigating' | 'filling' | 'submitting' | 'waiting_next'
    });

    showBatchProgressIndicator(tasks.length, 0);
    showToast(`开始执行 ${tasks.length} 个任务，请勿操作页面...`, { duration: 3000 });
    
    // 执行第一个任务
    setTimeout(() => {
      executeNextTask();
    }, 1000);
  };

  /** 显示批量进度指示器 */
  const showBatchProgressIndicator = (total, current) => {
    // 移除已有的指示器
    document.querySelector('.welearn-batch-progress')?.remove();
    
    const indicator = document.createElement('div');
    indicator.className = 'welearn-batch-progress';
    indicator.innerHTML = `
      <span>批量执行中: <span class="progress-text">${current + 1}/${total}</span></span>
      <button type="button" class="welearn-batch-stop" style="margin-left: 12px; background: rgba(239, 68, 68, 0.3); border: 1px solid rgba(239, 68, 68, 0.5); color: #f87171; padding: 4px 12px; border-radius: 8px; cursor: pointer; font-weight: 600;">停止</button>
    `;
    
    indicator.querySelector('.welearn-batch-stop')?.addEventListener('click', () => {
      if (confirm('确定要停止批量执行吗？已完成的任务不会撤销。')) {
        stopBatchExecution();
      }
    });
    
    document.body.appendChild(indicator);
  };

  /** 更新批量进度 */
  const updateBatchProgress = () => {
    const state = loadBatchModeState();
    if (!state) return;
    
    const indicator = document.querySelector('.welearn-batch-progress .progress-text');
    if (indicator) {
      const completed = state.totalTasks - state.queue.length;
      indicator.textContent = `${completed + 1}/${state.totalTasks}`;
    } else {
      // 如果指示器不存在，重新创建
      showBatchProgressIndicator(state.totalTasks, state.totalTasks - state.queue.length);
    }
  };

  /** 停止批量执行 */
  const stopBatchExecution = () => {
    batchModeActive = false;
    batchTaskQueue = [];
    currentBatchTask = null;
    clearBatchModeState();
    document.querySelector('.welearn-batch-progress')?.remove();
    showToast('批量执行已停止');
  };

  /** 执行下一个任务 */
  const executeNextTask = () => {
    const state = loadBatchModeState();
    if (!state || !state.active || state.queue.length === 0) {
      finishBatchExecution();
      return;
    }

    const task = state.queue[0];
    currentBatchTask = task;
    
    console.log('[WeLearn-Go] 批量执行: 开始任务', task.title);
    showToast(`正在执行: ${task.title}`, { duration: 2000 });

    // 尝试多种方式启动任务
    
    // 方式1: 直接调用 StartSCO 函数 (新版页面)
    if (typeof window.StartSCO === 'function') {
      console.log('[WeLearn-Go] 批量执行: 使用 StartSCO 启动', task.id);
      state.phase = 'navigating';
      saveBatchModeState(state);
      window.StartSCO(task.id);
      return;
    }

    // 方式2: 通过点击元素 (旧版页面或备用方案)
    // 查找对应的任务项: li[onclick*="StartSCO('ITEM-xxx')"]
    let taskElement = document.querySelector(`li[onclick*="StartSCO('${task.id}')"]`);
    
    // 如果找不到，尝试其他选择器
    if (!taskElement) {
      taskElement = document.querySelector(`li[id="${task.id}"], [data-sco="${task.id}"]`);
    }
    
    if (!taskElement) {
      console.warn('[WeLearn-Go] 批量执行: 未找到任务元素', task.id);
      // 跳过这个任务，继续下一个
      skipCurrentTask('未找到任务元素');
      return;
    }

    // 点击任务进入学习页面
    // 优先使用 onclick 属性
    const onclickAttr = taskElement.getAttribute('onclick');
    if (onclickAttr && onclickAttr.includes('StartSCO')) {
      state.phase = 'navigating';
      saveBatchModeState(state);
      
      // 直接执行 onclick
      taskElement.click();
      // 页面会跳转，在新页面中通过 checkAndResumeBatchMode 继续执行
    } else {
      // 尝试点击内部链接
      const link = taskElement.querySelector('a');
      if (link) {
        state.phase = 'navigating';
        saveBatchModeState(state);
        link.click();
      } else {
        skipCurrentTask('未找到任务链接');
      }
    }
  };

  /** 跳过当前任务 */
  const skipCurrentTask = (reason) => {
    const state = loadBatchModeState();
    if (!state) return;

    console.warn('[WeLearn-Go] 批量执行: 跳过任务', state.queue[0]?.title, reason);
    
    // 移除当前任务
    state.queue.shift();
    state.currentIndex++;
    state.phase = 'navigating';
    saveBatchModeState(state);

    // 短暂延迟后执行下一个
    setTimeout(() => {
      executeNextTask();
    }, 1000);
  };

  /** 完成当前任务 */
  const completeCurrentTask = () => {
    const state = loadBatchModeState();
    if (!state) return;

    const task = state.queue[0];
    if (task) {
      markTaskCompleted(task.id, state.courseName);
      console.log('[WeLearn-Go] 批量执行: 完成任务', task.title);
      showToast(`✓ 已完成: ${task.title}`, { duration: 2000 });
    }

    // 移除当前任务
    state.queue.shift();
    state.currentIndex++;
    saveBatchModeState(state);
    
    // 更新进度显示
    updateBatchProgress();

    // 检查是否还有更多任务
    if (state.queue.length === 0) {
      setTimeout(() => {
        finishBatchExecution();
      }, 1500);
      return;
    }

    // 任务间隔等待 30 秒
    const TASK_INTERVAL = 30 * 1000;
    showCountdownToast('任务间隔等待中', TASK_INTERVAL, '即将执行下一个任务...');
    
    setTimeout(() => {
      returnToCoursePage();
    }, TASK_INTERVAL);
  };

  /** 返回课程主页 */
  const returnToCoursePage = () => {
    const state = loadBatchModeState();
    if (state) {
      state.phase = 'returning';
      saveBatchModeState(state);
    }

    console.log('[WeLearn-Go] 批量执行: 返回课程主页');

    // 方法1：查找页面上的返回按钮 (.main-goback)
    const mainGoback = document.querySelector('.main-goback');
    if (mainGoback && mainGoback.offsetParent !== null) {
      console.log('[WeLearn-Go] 批量执行: 点击 .main-goback 返回');
      mainGoback.click();
      return;
    }

    // 方法2：查找面包屑或返回链接
    const backLinks = document.querySelectorAll(
      'a[href*="StudyCourse"], a[href*="course_info"], a[href*="CourseIndex"], .breadcrumb a, .back-link, .back-btn, .goback'
    );
    for (const link of backLinks) {
      if (link.offsetParent !== null) { // 可见
        console.log('[WeLearn-Go] 批量执行: 点击返回链接');
        link.click();
        return;
      }
    }

    // 方法3：通过 body 的 data-classid 获取 classid
    const bodyClassid = document.body.getAttribute('data-classid');
    const urlParams = new URLSearchParams(window.location.search);
    const cid = urlParams.get('cid');
    const classid = urlParams.get('classid') || bodyClassid;
    
    if (cid && classid) {
      console.log('[WeLearn-Go] 批量执行: 通过 URL 返回课程页面');
      window.location.href = `https://welearn.sflep.com/student/course_info.aspx?cid=${cid}&classid=${classid}`;
      return;
    }

    // 方法4：使用浏览器后退
    console.log('[WeLearn-Go] 批量执行: 使用浏览器后退');
    window.history.back();
  };

  /** 完成批量执行 */
  const finishBatchExecution = () => {
    batchModeActive = false;
    batchTaskQueue = [];
    currentBatchTask = null;
    clearBatchModeState();
    clearBatchTasksCache();  // 清除任务选择缓存
    document.querySelector('.welearn-batch-progress')?.remove();
    
    showToast('🎉 所有任务已完成！', { duration: 5000 });
  };

  /** 检查并恢复批量模式（页面加载时调用） */
  const checkAndResumeBatchMode = () => {
    const state = loadBatchModeState();
    
    if (!state || !state.active) {
      return false;
    }

    // 检查是否是真正的异常中断（超过3分钟没有更新）
    const ABNORMAL_TIMEOUT = 3 * 60 * 1000; // 3分钟
    const timeSinceLastUpdate = Date.now() - (state.lastUpdate || 0);
    
    if (timeSinceLastUpdate < ABNORMAL_TIMEOUT) {
      // 批量任务仍在正常进行中，不处理
      console.log('[WeLearn-Go] 批量模式: 任务仍在进行中', {
        timeSinceLastUpdate: Math.round(timeSinceLastUpdate / 1000) + '秒'
      });
      return false;
    }

    // 超过3分钟没有更新，认为是异常中断
    const remainingCount = state.queue?.length || 0;
    console.log('[WeLearn-Go] 批量模式: 检测到异常中断的批量执行', {
      remainingTasks: remainingCount,
      phase: state.phase,
      courseName: state.courseName,
      timeSinceLastUpdate: Math.round(timeSinceLastUpdate / 1000) + '秒'
    });
    
    // 将剩余任务保存到任务选择缓存，方便用户手动恢复
    if (remainingCount > 0 && state.queue && state.courseName) {
      saveBatchTasksCache(state.courseName, state.queue);
    }
    
    // 清除批量执行状态
    clearBatchModeState();
    
    // 不显示toast提示，让任务恢复对话框来处理
    return false;
  };

  /** 执行填写和提交 */
  const executeFillAndSubmit = async () => {
    const state = loadBatchModeState();
    if (!state || !state.active) return;

    console.log('[WeLearn-Go] 批量执行: 开始填写');
    state.phase = 'filling';
    saveBatchModeState(state);

    // 等待 iframe 加载
    await waitForIframeReady();

    // 统计题目数量，用于计算等待时间
    const questionCount = countQuestions();
    
    // 执行填写
    const result = fillAll({ enableSoftErrors: false });
    triggerIframeFill(false);

    // 等待填写完成
    await new Promise(resolve => setTimeout(resolve, 1500));

    // 检查是否需要处理多页（Next 按钮）
    await handleMultiplePages();

    // 计算刷时长等待时间（根据题目数量：每题 10 秒，最少 60 秒，最多 120 秒）
    const baseTime = 60 * 1000; // 基础 60 秒
    const perQuestionTime = 10 * 1000; // 每题 10 秒
    const calculatedTime = Math.min(Math.max(questionCount * perQuestionTime, baseTime), 120 * 1000);
    
    console.log('[WeLearn-Go] 批量执行: 等待刷时长', {
      questionCount,
      waitTime: Math.round(calculatedTime / 1000) + '秒'
    });
    
    // 显示刷时长倒计时
    showCountdownToast('正在刷时长', calculatedTime, `检测到 ${questionCount} 道题目`);
    
    await new Promise(resolve => setTimeout(resolve, calculatedTime));

    // 提交
    state.phase = 'submitting';
    saveBatchModeState(state);
    
    await performSubmit();
  };
  
  /** 统计当前页面的题目数量 */
  const countQuestions = () => {
    let count = 0;
    
    // 统计各种题型
    const blanks = document.querySelectorAll('et-blank, .blank, input[type="text"], [contenteditable="true"]');
    const toggles = document.querySelectorAll('et-toggle');
    const choices = document.querySelectorAll('et-item, .choice-item, input[type="radio"], input[type="checkbox"]');
    const textareas = document.querySelectorAll('textarea');
    
    // 也检查 iframe 内的内容
    const iframes = document.querySelectorAll('iframe');
    iframes.forEach(iframe => {
      try {
        const doc = iframe.contentDocument;
        if (doc) {
          count += doc.querySelectorAll('et-blank, .blank, input[type="text"]').length;
          count += doc.querySelectorAll('et-toggle').length;
          count += doc.querySelectorAll('et-item, .choice-item').length;
          count += doc.querySelectorAll('textarea').length;
        }
      } catch (e) { /* 跨域忽略 */ }
    });
    
    count += blanks.length + toggles.length + Math.ceil(choices.length / 4) + textareas.length;
    
    // 至少返回 10（保证有基础等待时间）
    return Math.max(count, 10);
  };
  
  /** 显示倒计时 Toast */
  const showCountdownToast = (title, totalMs, subtitle = '') => {
    // 移除已有的倒计时 toast
    document.querySelector('.welearn-countdown-toast')?.remove();
    
    const toast = document.createElement('div');
    toast.className = 'welearn-countdown-toast';
    toast.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: rgba(0, 0, 0, 0.85);
      color: white;
      padding: 24px 32px;
      border-radius: 12px;
      z-index: 100001;
      text-align: center;
      min-width: 200px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    `;
    
    const remainingSeconds = Math.ceil(totalMs / 1000);
    
    toast.innerHTML = `
      <div style="font-size: 14px; color: #aaa; margin-bottom: 8px;">⏱️ ${title}</div>
      <div style="font-size: 36px; font-weight: bold; margin-bottom: 8px;" class="countdown-number">${remainingSeconds}</div>
      <div style="font-size: 12px; color: #888;">${subtitle}</div>
    `;
    
    document.body.appendChild(toast);
    
    // 更新倒计时
    let remaining = remainingSeconds;
    const interval = setInterval(() => {
      remaining--;
      const numberEl = toast.querySelector('.countdown-number');
      if (numberEl) {
        numberEl.textContent = remaining;
      }
      if (remaining <= 0) {
        clearInterval(interval);
        toast.remove();
      }
    }, 1000);
    
    // 确保在总时间后移除
    setTimeout(() => {
      clearInterval(interval);
      toast.remove();
    }, totalMs);
  };

  /** 等待 iframe 准备就绪 */
  const waitForIframeReady = () => {
    return new Promise((resolve) => {
      const maxWait = 10000;
      const startTime = Date.now();
      
      const check = () => {
        const iframes = document.querySelectorAll('iframe');
        let ready = iframes.length === 0; // 没有 iframe 则直接就绪
        
        iframes.forEach(iframe => {
          try {
            if (iframe.contentDocument?.body) {
              ready = true;
            }
          } catch (e) {
            // 跨域 iframe，假设已就绪
            ready = true;
          }
        });

        if (ready || Date.now() - startTime > maxWait) {
          resolve();
        } else {
          setTimeout(check, 500);
        }
      };

      check();
    });
  };

  /** 处理多页情况 */
  const handleMultiplePages = async () => {
    const maxPages = 20; // 最多处理 20 页
    let pageCount = 0;

    while (pageCount < maxPages) {
      // 查找 Next 按钮
      const nextButton = findNextButton();
      
      if (!nextButton) {
        console.log('[WeLearn-Go] 批量执行: 没有找到 Next 按钮，当前是最后一页');
        break;
      }

      console.log('[WeLearn-Go] 批量执行: 点击 Next 进入下一页');
      nextButton.click();
      pageCount++;

      // 等待页面切换
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 不需要重新填写（按需求，第一页已填写所有问题）
      // 继续查找 Submit 或下一个 Next
    }
  };

  /** 查找 Next 按钮 */
  const findNextButton = () => {
    const contexts = getAccessibleDocuments();
    
    for (const doc of contexts) {
      // 查找各种可能的 Next 按钮
      const selectors = [
        'button:contains("Next")',
        'a:contains("Next")',
        '.next-btn',
        '.btn-next',
        '[class*="next"]',
        'button[ng-click*="next"]',
        'et-button[action*="next"]'
      ];

      // 直接文本匹配
      const allButtons = doc.querySelectorAll('button, a.btn, et-button button, .controls button');
      for (const btn of allButtons) {
        const text = btn.textContent?.trim().toLowerCase();
        if (text === 'next' || text === '下一页' || text === '下一步') {
          // 检查是否可见和可点击
          if (!btn.disabled && btn.offsetParent !== null) {
            return btn;
          }
        }
      }

      // AngularJS et-button
      const etButtons = doc.querySelectorAll('et-button');
      for (const etBtn of etButtons) {
        const action = etBtn.getAttribute('action') || '';
        if (action.includes('next') || action.includes('Next')) {
          const innerBtn = etBtn.querySelector('button');
          if (innerBtn && !innerBtn.disabled && etBtn.offsetParent !== null) {
            return innerBtn;
          }
        }
      }
    }

    return null;
  };

  /** 查找 Submit 按钮 */
  const findSubmitButton = () => {
    const contexts = getAccessibleDocuments();
    
    for (const doc of contexts) {
      // 直接文本匹配
      const allButtons = doc.querySelectorAll('button, a.btn, et-button button, .controls button');
      for (const btn of allButtons) {
        const text = btn.textContent?.trim().toLowerCase();
        if (text === 'submit' || text === '提交' || text === '提交答案') {
          if (!btn.disabled && btn.offsetParent !== null) {
            return btn;
          }
        }
      }

      // data-controltype="submit"
      const submitByAttr = doc.querySelector('[data-controltype="submit"]:not([disabled])');
      if (submitByAttr && submitByAttr.offsetParent !== null) {
        return submitByAttr;
      }

      // AngularJS et-button
      const etButtons = doc.querySelectorAll('et-button[action*="submit"]');
      for (const etBtn of etButtons) {
        if (!etBtn.classList.contains('ng-hide') && etBtn.offsetParent !== null) {
          const innerBtn = etBtn.querySelector('button');
          if (innerBtn && !innerBtn.disabled) {
            return innerBtn;
          }
        }
      }
    }

    return null;
  };

  /** 执行提交 */
  const performSubmit = async () => {
    const submitBtn = findSubmitButton();
    
    if (submitBtn) {
      console.log('[WeLearn-Go] 批量执行: 点击 Submit 按钮');
      submitBtn.click();
      
      // 等待提交完成
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 检查是否提交成功（查找成功提示或确认界面）
      const isSuccess = await checkSubmitSuccess();
      
      if (isSuccess) {
        console.log('[WeLearn-Go] 批量执行: 提交成功');
        completeCurrentTask();
      } else {
        console.warn('[WeLearn-Go] 批量执行: 提交可能失败，继续下一个任务');
        completeCurrentTask(); // 暂时还是标记完成，避免卡住
      }
    } else {
      console.warn('[WeLearn-Go] 批量执行: 未找到 Submit 按钮');
      // 可能是已经提交过了，或者不需要提交
      completeCurrentTask();
    }
  };

  /** 检查提交是否成功 */
  const checkSubmitSuccess = async () => {
    // 等待结果显示
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const contexts = getAccessibleDocuments();
    for (const doc of contexts) {
      // 查找成功提示
      const successIndicators = doc.querySelectorAll('.success, .submitted, .complete, [class*="success"], [class*="submitted"]');
      if (successIndicators.length > 0) {
        return true;
      }
      
      // 查找错误提示
      const errorIndicators = doc.querySelectorAll('.error, .failed, [class*="error"], [class*="fail"]');
      if (errorIndicators.length > 0) {
        return false;
      }
    }
    
    // 默认认为成功
    return true;
  };

  // ==================== UI 组件 ====================

  /**
   * 显示 Toast 提示
   * @param {string} message - 提示消息（支持 HTML）
   * @param {Object} options - 配置选项
   * @param {number} options.duration - 显示时长（毫秒），0 表示不自动关闭
   * @param {boolean} options.html - 是否作为 HTML 渲染
   */
  const showToast = (message, { duration = 2500, html = false } = {}) => {
    const toast = document.createElement('div');
    toast.className = 'welearn-toast';
    if (html) {
      toast.innerHTML = message;
    } else {
      toast.textContent = message;
    }
    
    // 先添加到 DOM 以便计算高度
    document.body.appendChild(toast);
    
    // 计算当前已有 Toast 的总高度，让新 Toast 堆叠在下面
    // 包括所有 Toast（包括刚添加但还没有 visible 类的）
    const existingToasts = document.querySelectorAll('.welearn-toast');
    let topOffset = 18;
    existingToasts.forEach((t) => {
      if (t !== toast) {
        topOffset += t.offsetHeight + 10;
      }
    });
    toast.style.top = topOffset + 'px';
    
    requestAnimationFrame(() => {
      toast.classList.add('visible');
    });
    
    // Toast 移除时重新计算其他 Toast 的位置
    const removeToast = () => {
      toast.classList.remove('visible');
      setTimeout(() => {
        toast.remove();
        // 重新计算剩余 Toast 的位置
        const remainingToasts = document.querySelectorAll('.welearn-toast.visible');
        let newTop = 18;
        remainingToasts.forEach((t) => {
          t.style.top = newTop + 'px';
          newTop += t.offsetHeight + 10;
        });
      }, 300);
    };
    
    if (duration > 0 && Number.isFinite(duration)) {
      setTimeout(removeToast, duration);
    }
  };

  /** 清理页面上的所有 UI 元素 */
  const cleanupPageArtifacts = () => {
    document.querySelector('.welearn-panel')?.remove();
    document.querySelectorAll('.welearn-modal-overlay').forEach((node) => node.remove());
    document.querySelectorAll('.welearn-toast').forEach((node) => node.remove());
  };

  // ==================== 状态持久化 ====================

  /** 加载面板状态 */
  const loadPanelState = () => {
    try {
      const raw = localStorage.getItem(PANEL_STATE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (error) {
      console.warn('WeLearn autofill: failed to load panel state', error);
      return {};
    }
  };

  /** 保存面板状态 */
  const savePanelState = (state) => {
    try {
      localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(state));
    } catch (error) {
      console.warn('WeLearn autofill: failed to save panel state', error);
    }
  };

  // ==================== 样式定义 ====================

  /** 创建并注入样式 */
  const createStyles = () => {
    const css = `
      /* 主面板样式 */
      .welearn-panel {
        position: fixed;
        top: 120px;
        left: 24px;
        width: 340px;
        min-width: 340px;
        max-width: 540px;
        padding: 12px;
        background: rgba(27, 38, 56, 0.95);
        color: #f8fafc;
        border-radius: 16px;
        box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
        z-index: 2147483647;
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        backdrop-filter: blur(6px);
        transition: width 0.25s ease, height 0.25s ease, min-width 0.25s ease, max-width 0.25s ease, padding 0.25s ease;
        overflow: hidden;
      }
      .welearn-body {
        display: flex;
        flex-direction: column;
        gap: 8px;
        opacity: 1;
        transition: opacity 0.15s ease 0.1s;
        min-width: 316px;
      }
      .welearn-panel.minimized .welearn-body {
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.1s ease;
      }
      body.welearn-dragging, body.welearn-dragging * {
        user-select: none !important;
      }
      .welearn-panel h3 {
        margin: 0 0 8px;
        font-size: 16px;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: move;
        user-select: none;
        white-space: nowrap;
      }
      .welearn-panel h3 span {
        font-size: 13px;
        font-weight: 500;
        color: #cbd5e1;
      }
      .welearn-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        align-items: stretch;
        gap: 8px;
        margin: 8px 0 10px;
        min-width: 280px;
      }
      .welearn-actions .welearn-start {
        grid-column: 1 / -1;
        width: 100%;
        background: linear-gradient(135deg, #38bdf8, #6366f1);
        color: #0b1221;
        border: none;
        border-radius: 16px;
        padding: 10px 12px;
        font-weight: 700;
        font-size: 14px;
        cursor: pointer;
        box-shadow: 0 8px 18px rgba(99, 102, 241, 0.35);
        transition: transform 0.12s ease, box-shadow 0.12s ease, filter 0.12s ease;
      }
      .welearn-actions .welearn-start:hover {
        transform: translateY(-1px);
        box-shadow: 0 10px 22px rgba(56, 189, 248, 0.32);
        filter: brightness(1.03);
      }
      .welearn-actions .welearn-start:disabled {
        cursor: not-allowed;
        opacity: 0.65;
        box-shadow: none;
      }
      .welearn-toggle-btn {
        background: rgba(148, 163, 184, 0.15);
        color: #94a3b8;
        border: 1px solid rgba(148, 163, 184, 0.25);
        border-radius: 16px;
        padding: 10px 12px;
        font-weight: 600;
        font-size: 13px;
        cursor: pointer;
        box-shadow: none;
        transition: transform 0.12s ease, background 0.2s ease, color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease, filter 0.12s ease;
        white-space: nowrap;
      }
      .welearn-toggle-btn:hover {
        background: rgba(148, 163, 184, 0.25);
        transform: translateY(-1px);
      }
      .welearn-toggle-btn.active {
        background: linear-gradient(135deg, #38bdf8, #6366f1);
        background-origin: border-box;
        background-clip: padding-box;
        color: #0b1221;
        border-color: transparent;
        box-shadow: 0 6px 14px rgba(99, 102, 241, 0.3);
      }
      .welearn-toggle-btn.active:hover {
        transform: translateY(-1px);
        box-shadow: 0 8px 18px rgba(56, 189, 248, 0.32);
        filter: brightness(1.03);
      }
      .welearn-footer {
        font-size: 12px;
        color: #94a3b8;
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
      }
      .welearn-footer > span {
        width: 100%;
        text-align: center;
      }
      .welearn-footer a {
        color: #38bdf8;
        text-decoration: none;
        white-space: nowrap;
      }
      .welearn-footer a:hover {
        opacity: 0.8;
      }
      .welearn-support {
        background: rgba(56, 189, 248, 0.14);
        color: #38bdf8;
        border: 1px solid rgba(56, 189, 248, 0.35);
        border-radius: 16px;
        padding: 8px 12px;
        cursor: pointer;
        font-weight: 700;
        font-size: 12px;
        transition: transform 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
      }
      .welearn-support:hover {
        background: rgba(56, 189, 248, 0.22);
        box-shadow: 0 6px 16px rgba(56, 189, 248, 0.28);
        transform: translateY(-1px);
      }
      .welearn-stats-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-top: 6px;
        padding: 6px 10px;
        background: rgba(148, 163, 184, 0.08);
        border-radius: 10px;
        font-size: 11px;
        color: #94a3b8;
      }
      .welearn-error-stats {
        flex: 1;
        line-height: 1.4;
      }
      .welearn-error-stats b {
        color: #38bdf8;
        margin: 0 2px;
      }
      .welearn-clear-stats {
        background: rgba(239, 68, 68, 0.15);
        color: #f87171;
        border: 1px solid rgba(239, 68, 68, 0.3);
        border-radius: 8px;
        padding: 4px 8px;
        font-size: 10px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s ease, transform 0.1s ease;
        white-space: nowrap;
      }
      .welearn-clear-stats:hover {
        background: rgba(239, 68, 68, 0.25);
        transform: translateY(-1px);
      }
      .welearn-weights-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        margin-top: 6px;
        padding: 6px 10px;
        background: rgba(148, 163, 184, 0.08);
        border-radius: 10px;
        font-size: 11px;
        color: #94a3b8;
      }
      .welearn-weights-row label {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
        margin: 0 !important;
        margin-bottom: 0 !important;
        font-weight: normal !important;
        max-width: none !important;
      }
      .welearn-weight-text {
        display: inline-flex;
        align-items: center;
        height: 22px;
        line-height: 1;
        margin: 0 !important;
      }
      .welearn-weights-row input {
        width: 32px;
        height: 22px;
        padding: 0 4px;
        margin: 0 !important;
        background: rgba(30, 41, 59, 0.8);
        border: 1px solid rgba(148, 163, 184, 0.3);
        border-radius: 4px;
        color: #e2e8f0;
        font-size: 11px;
        font-family: inherit;
        text-align: center;
        line-height: 1;
        box-sizing: border-box;
        vertical-align: middle;
        -moz-appearance: textfield;
        -webkit-appearance: none;
        appearance: none;
      }
      .welearn-weights-row input::-webkit-outer-spin-button,
      .welearn-weights-row input::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      .welearn-weights-row input:focus {
        outline: none;
        border-color: #38bdf8;
      }
      .welearn-weights-row input.error {
        border-color: #ef4444;
      }
      .welearn-weights-row span.welearn-weights-label {
        color: #cbd5e1;
        white-space: nowrap;
      }
      .welearn-weights-error {
        width: 100%;
        color: #f87171;
        font-size: 10px;
        margin-top: 2px;
        display: none;
      }
      .welearn-weights-error.visible {
        display: block;
      }
      .welearn-handle {
        position: absolute;
        display: none;
      }
      .welearn-minify {
        position: absolute;
        top: 8px;
        right: 10px;
        width: 26px;
        height: 26px;
        border: none;
        border-radius: 50%;
        cursor: pointer;
        background: rgba(56, 189, 248, 0.2);
        color: #38bdf8;
        display: grid;
        place-items: center;
        transition: background 0.15s ease;
        z-index: 10;
      }
      .welearn-minify:hover {
        background: rgba(56, 189, 248, 0.35);
      }
      .welearn-panel.minimized {
        width: ${MINIMIZED_PANEL_SIZE}px !important;
        height: ${MINIMIZED_PANEL_SIZE}px !important;
        min-width: ${MINIMIZED_PANEL_SIZE}px !important;
        max-width: ${MINIMIZED_PANEL_SIZE}px !important;
        padding: 0 !important;
        border-radius: 999px;
      }
      .welearn-panel.minimized h3,
      .welearn-panel.minimized .welearn-footer,
      .welearn-panel.minimized .welearn-handle {
        opacity: 0;
        pointer-events: none;
      }
      .welearn-panel.minimized .welearn-minify {
        top: 50%;
        left: 50%;
        right: auto;
        transform: translate(-50%, -50%);
        width: 26px;
        height: 26px;
      }
      .welearn-panel.minimized .welearn-minify:hover {
        background: rgba(56, 189, 248, 0.4);
      }
      .welearn-toast {
        position: fixed;
        left: 50%;
        transform: translateX(-50%) translateY(-20px);
        padding: 12px 18px;
        background: rgba(16, 185, 129, 0.95);
        color: #0b1221;
        border-radius: 16px;
        box-shadow: 0 12px 28px rgba(16, 185, 129, 0.35);
        font-weight: 600;
        opacity: 0;
        transition: opacity 0.15s ease-out, transform 0.15s ease-out, top 0.2s ease-out;
        z-index: 2147483647;
        font-size: 13px;
        line-height: 1.5;
        will-change: opacity, transform, top;
      }
      .welearn-toast.visible {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
      .welearn-toast .welearn-error-item {
        display: inline-block;
        margin-left: 8px;
        padding: 2px 8px;
        background: rgba(0, 0, 0, 0.15);
        border-radius: 6px;
      }
      .welearn-toast .welearn-error-item b {
        margin-right: 4px;
        font-weight: 600;
      }
      .welearn-toast .welearn-error-item em {
        color: #dc2626;
        font-style: normal;
        font-weight: 700;
      }
      .welearn-modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2147483647;
        backdrop-filter: blur(4px);
      }
      .welearn-modal {
        width: min(520px, 92vw);
        padding: 20px;
        background: #0f172a;
        color: #e2e8f0;
        border-radius: 20px;
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
        border: 1px solid rgba(148, 163, 184, 0.2);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      .welearn-modal h3 {
        margin: 0 0 10px;
        font-size: 18px;
      }
      .welearn-modal p {
        margin: 6px 0;
        line-height: 1.6;
      }
      .welearn-guide {
        margin: 10px 0 14px;
        padding: 10px 12px;
        background: rgba(59, 130, 246, 0.08);
        border-radius: 16px;
        border: 1px solid rgba(59, 130, 246, 0.15);
      }
      .welearn-guide ol {
        margin: 8px 0 0;
        padding-left: 18px;
      }
      .welearn-guide li + li {
        margin-top: 4px;
      }
      .welearn-donate-grid {
        margin: 12px 0 16px;
        display: flex;
        justify-content: center;
      }
      .welearn-donate-grid a {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        padding: 16px 20px;
        border-radius: 16px;
        background: rgba(148, 163, 184, 0.08);
        border: 1px solid rgba(148, 163, 184, 0.2);
        color: #e2e8f0;
        text-decoration: none;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
        transition: transform 0.12s ease, border-color 0.12s ease, background 0.12s ease;
      }
      .welearn-donate-grid a:hover {
        transform: translateY(-1px);
        background: rgba(56, 189, 248, 0.08);
        border-color: rgba(56, 189, 248, 0.35);
      }
      .welearn-donate-grid img {
        width: 200px;
        max-width: 100%;
        border-radius: 12px;
        background: #0f172a;
      }
      .welearn-donate-grid span {
        font-weight: 700;
        color: #cbd5e1;
      }
      .welearn-modal-footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .welearn-modal-close {
        background: linear-gradient(135deg, #38bdf8, #22d3ee);
        color: #0b1221;
        border: none;
        border-radius: 16px;
        padding: 10px 16px;
        font-weight: 700;
        cursor: pointer;
        box-shadow: 0 10px 24px rgba(56, 189, 248, 0.35);
        transition: transform 0.12s ease, box-shadow 0.12s ease;
      }
      .welearn-modal-close:hover {
        transform: translateY(-1px);
        box-shadow: 0 12px 26px rgba(56, 189, 248, 0.4);
      }
      .welearn-badge {
        padding: 6px 10px;
        background: rgba(16, 185, 129, 0.16);
        color: #34d399;
        border-radius: 16px;
        border: 1px solid rgba(16, 185, 129, 0.4);
        font-weight: 600;
      }

      /* 批量任务选择器样式 */
      .welearn-task-modal {
        width: min(680px, 92vw);
        max-height: 85vh;
        display: flex;
        flex-direction: column;
      }
      .welearn-task-desc {
        color: #94a3b8;
        margin-bottom: 12px;
      }
      .welearn-task-actions-top {
        display: flex;
        gap: 8px;
        margin-bottom: 12px;
        flex-wrap: wrap;
      }
      .welearn-task-actions-top button {
        background: rgba(148, 163, 184, 0.15);
        color: #94a3b8;
        border: 1px solid rgba(148, 163, 184, 0.25);
        border-radius: 8px;
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .welearn-task-actions-top button:hover {
        background: rgba(148, 163, 184, 0.25);
        color: #e2e8f0;
      }
      .welearn-btn-refresh-status {
        background: rgba(16, 185, 129, 0.15) !important;
        color: #34d399 !important;
        border-color: rgba(16, 185, 129, 0.3) !important;
      }
      .welearn-btn-refresh-status:hover {
        background: rgba(16, 185, 129, 0.25) !important;
      }
      .welearn-btn-refresh-status:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .welearn-task-container {
        flex: 1;
        overflow-y: auto;
        max-height: 50vh;
        margin-bottom: 12px;
        padding-right: 8px;
      }
      .welearn-task-container::-webkit-scrollbar {
        width: 6px;
      }
      .welearn-task-container::-webkit-scrollbar-track {
        background: rgba(148, 163, 184, 0.1);
        border-radius: 3px;
      }
      .welearn-task-container::-webkit-scrollbar-thumb {
        background: rgba(148, 163, 184, 0.3);
        border-radius: 3px;
      }
      .welearn-task-unit {
        margin-bottom: 16px;
      }
      .welearn-task-unit-header {
        background: rgba(56, 189, 248, 0.1);
        border: 1px solid rgba(56, 189, 248, 0.2);
        border-radius: 8px;
        padding: 8px 12px;
        margin-bottom: 8px;
      }
      .welearn-task-unit-header label {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        font-weight: 600;
        color: #38bdf8;
      }
      .welearn-task-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding-left: 12px;
      }
      .welearn-task-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: rgba(148, 163, 184, 0.08);
        border-radius: 6px;
        cursor: pointer;
        transition: background 0.15s ease;
      }
      .welearn-task-item:hover {
        background: rgba(148, 163, 184, 0.15);
      }
      .welearn-task-item.completed {
        opacity: 0.6;
        background: rgba(16, 185, 129, 0.1);
      }
      .welearn-task-item.intro {
        opacity: 0.6;
        background: rgba(59, 130, 246, 0.1);
      }
      .welearn-task-item input[type="checkbox"] {
        width: 16px;
        height: 16px;
        cursor: pointer;
      }
      .welearn-task-title {
        flex: 1;
        font-size: 13px;
        color: #e2e8f0;
      }
      .welearn-task-badge {
        font-size: 11px;
        padding: 2px 8px;
        background: rgba(16, 185, 129, 0.2);
        color: #34d399;
        border-radius: 4px;
        font-weight: 600;
      }
      .welearn-task-badge.pending {
        background: rgba(234, 179, 8, 0.2);
        color: #fbbf24;
      }
      .welearn-task-badge.intro {
        background: rgba(59, 130, 246, 0.2);
        color: #60a5fa;
      }
      .welearn-task-summary {
        padding: 10px 12px;
        background: rgba(56, 189, 248, 0.1);
        border-radius: 8px;
        font-size: 13px;
        color: #38bdf8;
        margin-bottom: 12px;
      }
      .welearn-selected-count {
        font-weight: 700;
        font-size: 16px;
      }
      .welearn-checkbox-label {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
      }
      
      /* 加载动画样式 */
      .welearn-loading-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 60px 20px;
        color: #94a3b8;
      }
      .welearn-loading-spinner {
        width: 40px;
        height: 40px;
        border: 3px solid rgba(56, 189, 248, 0.2);
        border-top-color: #38bdf8;
        border-radius: 50%;
        animation: welearn-spin 0.8s linear infinite;
        margin-bottom: 16px;
      }
      @keyframes welearn-spin {
        to { transform: rotate(360deg); }
      }
      .welearn-loading-container p {
        font-size: 14px;
        margin: 0;
      }
      
      /* 警告文本样式 */
      .welearn-warning-text {
        color: #f87171 !important;
        font-size: 12px;
      }
      
      /* 缓存时间显示 */
      .welearn-cache-time {
        color: #64748b;
        font-size: 11px;
      }
      
      /* 恢复任务提示模态框 */
      .welearn-recovery-modal {
        width: min(400px, 90vw);
        text-align: center;
      }
      .welearn-recovery-modal p {
        margin: 12px 0;
        color: #cbd5e1;
      }
      .welearn-recovery-modal strong {
        color: #38bdf8;
        font-size: 18px;
      }
      
      /* 重新读取按钮特殊样式 */
      .welearn-btn-refresh {
        background: rgba(56, 189, 248, 0.15) !important;
        color: #38bdf8 !important;
        border-color: rgba(56, 189, 248, 0.3) !important;
      }
      .welearn-btn-refresh:hover {
        background: rgba(56, 189, 248, 0.25) !important;
      }
      
      .welearn-modal-cancel {
        background: rgba(148, 163, 184, 0.15);
        color: #94a3b8;
        border: 1px solid rgba(148, 163, 184, 0.25);
        border-radius: 16px;
        padding: 10px 20px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .welearn-modal-cancel:hover {
        background: rgba(148, 163, 184, 0.25);
        color: #e2e8f0;
      }
      .welearn-modal-confirm {
        background: linear-gradient(135deg, #38bdf8, #6366f1);
        color: #fff;
        border: none;
        border-radius: 16px;
        padding: 10px 24px;
        font-weight: 700;
        cursor: pointer;
        box-shadow: 0 8px 18px rgba(99, 102, 241, 0.35);
        transition: all 0.15s ease;
      }
      .welearn-modal-confirm:hover:not(:disabled) {
        transform: translateY(-1px);
        box-shadow: 0 10px 22px rgba(56, 189, 248, 0.32);
      }
      .welearn-modal-confirm:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none;
        box-shadow: none;
      }
      .welearn-modal-start {
        background: linear-gradient(135deg, #38bdf8, #6366f1);
        color: #0b1221;
        border: none;
        border-radius: 16px;
        padding: 10px 24px;
        font-weight: 700;
        cursor: pointer;
        box-shadow: 0 8px 18px rgba(99, 102, 241, 0.35);
        transition: all 0.15s ease;
      }
      .welearn-modal-start:hover:not(:disabled) {
        transform: translateY(-1px);
        box-shadow: 0 10px 22px rgba(56, 189, 248, 0.32);
      }
      .welearn-modal-start:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      
      /* 读取目录按钮样式 */
      .welearn-scan-btn {
        background: linear-gradient(135deg, #10b981, #059669);
        color: #0b1221;
        border: none;
        border-radius: 16px;
        padding: 10px 12px;
        font-weight: 700;
        font-size: 13px;
        cursor: pointer;
        box-shadow: 0 6px 14px rgba(16, 185, 129, 0.3);
        transition: transform 0.12s ease, box-shadow 0.12s ease, filter 0.12s ease;
      }
      .welearn-scan-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 8px 18px rgba(16, 185, 129, 0.4);
        filter: brightness(1.03);
      }
      .welearn-scan-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      
      /* 批量执行按钮样式 */
      .welearn-batch-btn {
        background: linear-gradient(135deg, #f59e0b, #ef4444);
        color: #0b1221;
        border: none;
        border-radius: 16px;
        padding: 10px 12px;
        font-weight: 700;
        font-size: 13px;
        cursor: pointer;
        box-shadow: 0 6px 14px rgba(245, 158, 11, 0.3);
        transition: transform 0.12s ease, box-shadow 0.12s ease, filter 0.12s ease;
      }
      .welearn-batch-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 8px 18px rgba(245, 158, 11, 0.4);
        filter: brightness(1.03);
      }
      .welearn-batch-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      
      /* 批量模式进度提示 */
      .welearn-batch-progress {
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        padding: 12px 24px;
        background: rgba(27, 38, 56, 0.95);
        color: #f8fafc;
        border-radius: 16px;
        box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
        z-index: 2147483647;
        font-size: 14px;
        font-weight: 600;
        backdrop-filter: blur(6px);
        border: 1px solid rgba(56, 189, 248, 0.3);
      }
      .welearn-batch-progress .progress-text {
        color: #38bdf8;
      }
    `;

    if (typeof GM_addStyle === 'function') {
      GM_addStyle(css);
    } else {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    }
  };

  // ==================== 面板拖动与尺寸控制 ====================

  /** 限制数值在指定范围内 */
  const clampSize = (value, min, max) => Math.min(Math.max(value, min), max);

  /** 获取最大可用宽度 */
  const getMaxWidth = () => Math.min(window.innerWidth - 24, PANEL_MAX_WIDTH);

  /** 获取最大可用高度 */
  const getMaxHeight = () => Math.min(window.innerHeight - 24, PANEL_MAX_HEIGHT);

  /** 获取可见视口尺寸 */
  const getVisibleViewport = () => {
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return { width: vw, height: vh };
  };

  /** 初始化面板拖动和尺寸调整功能 */
  const initDragAndResize = (panel, header) => {
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let isDragging = false;

    const beginInteraction = () => document.body.classList.add('welearn-dragging');
    const endInteraction = () => document.body.classList.remove('welearn-dragging');

    /** 自动调整面板尺寸 */
    const applyAutoSize = () => {
      if (panel.classList.contains('minimized')) {
        panel.style.width = `${MINIMIZED_PANEL_SIZE}px`;
        panel.style.height = `${MINIMIZED_PANEL_SIZE}px`;
        return;
      }

      const { width: vw } = getVisibleViewport();
      const maxW = Math.min(vw - 24, PANEL_MAX_WIDTH);
      const width = clampSize(PANEL_DEFAULT_WIDTH, PANEL_MIN_WIDTH, maxW);
      panel.style.width = `${width}px`;
      panel.style.height = 'auto'; // 高度自适应内容
    };

    /** 确保面板在视口范围内 */
    const enforceBounds = () => {
      const rect = panel.getBoundingClientRect();
      const { width: vw, height: vh } = getVisibleViewport();
      const isMinimized = panel.classList.contains('minimized');
      
      const maxW = Math.min(vw - 24, PANEL_MAX_WIDTH);
      
      const targetWidth = isMinimized
        ? MINIMIZED_PANEL_SIZE
        : clampSize(rect.width, PANEL_MIN_WIDTH, maxW);
      
      // 确保面板完全在视口内
      const minLeft = 8;
      const minTop = 8;
      const maxLeft = Math.max(minLeft, vw - targetWidth - 8);
      const maxTop = Math.max(minTop, vh - rect.height - 8);
      
      panel.style.width = `${targetWidth}px`;
      if (isMinimized) {
        panel.style.height = `${MINIMIZED_PANEL_SIZE}px`;
      }
      panel.style.left = `${clampSize(rect.left, minLeft, maxLeft)}px`;
      panel.style.top = `${clampSize(rect.top, minTop, maxTop)}px`;
    };

    const state = loadPanelState();
    const { width: vw, height: vh } = getVisibleViewport();
    
    // 加载保存的位置，但确保在可见范围内
    if (state.left !== undefined) {
      const maxLeft = Math.max(8, vw - PANEL_DEFAULT_WIDTH - 8);
      panel.style.left = `${clampSize(state.left, 8, maxLeft)}px`;
    }
    if (state.top !== undefined) {
      const maxTop = Math.max(8, vh - PANEL_DEFAULT_HEIGHT - 8);
      panel.style.top = `${clampSize(state.top, 8, maxTop)}px`;
    }
    applyAutoSize();
    if (state.minimized) {
      panel.classList.add('minimized');
      applyAutoSize();
    }
    enforceBounds();

    /** 鼠标移动事件处理（拖动面板） */
    const onMouseMove = (event) => {
      if (isDragging) {
        const { width: vw, height: vh } = getVisibleViewport();
        const rect = panel.getBoundingClientRect();
        const deltaX = event.clientX - startX;
        const deltaY = event.clientY - startY;
        
        const newLeft = startLeft + deltaX;
        const newTop = startTop + deltaY;
        
        // 限制在视口范围内
        const maxLeft = vw - rect.width - 8;
        const maxTop = vh - rect.height - 8;
        
        panel.style.left = `${clampSize(newLeft, 8, maxLeft)}px`;
        panel.style.top = `${clampSize(newTop, 8, maxTop)}px`;
      }
    };

    /** 鼠标释放事件处理（结束拖动并保存状态） */
    const onMouseUp = () => {
      if (isDragging) {
        const rect = panel.getBoundingClientRect();
        const limitedWidth = clampSize(rect.width, PANEL_MIN_WIDTH, getMaxWidth());
        panel.style.width = `${limitedWidth}px`;
        savePanelState({
          left: rect.left,
          top: rect.top,
          width: limitedWidth,
          minimized: panel.classList.contains('minimized'),
        });
      }
      isDragging = false;
      endInteraction();
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    // 展开状态下：只允许通过标题栏拖动
    header.addEventListener('mousedown', (event) => {
      if ((event.target instanceof HTMLElement && event.target.closest('button, input, label')) || panel.classList.contains('minimized')) return;
      event.preventDefault();
      isDragging = true;
      startX = event.clientX;
      startY = event.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      beginInteraction();
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    // ==================== 最小化状态拖动处理 ====================
    // 最小化状态使用独立的拖动逻辑，支持拖动移动位置和点击展开
    const DRAG_THRESHOLD = 5;           // 拖动阈值（像素），超过此距离才算拖动，否则视为点击
    
    // 使用对象存储拖动状态，避免闭包问题
    const minDragState = {
      active: false,        // 是否正在拖动
      moved: false,         // 是否已超过阈值
      startX: 0,            // 鼠标起始 X
      startY: 0,            // 鼠标起始 Y
      panelStartX: 0,       // 面板起始 X
      panelStartY: 0,       // 面板起始 Y
      pointerId: null,      // 指针 ID，用于 pointer capture
    };

    /** 结束最小化状态拖动 */
    const endMinimizedDrag = (savePosition = true) => {
      // 释放指针捕获
      if (minDragState.pointerId !== null) {
        try {
          panel.releasePointerCapture(minDragState.pointerId);
        } catch (e) { /* 忽略错误 */ }
        minDragState.pointerId = null;
      }
      
      minDragState.active = false;
      panel.style.cursor = '';
      
      if (minDragState.moved && savePosition) {
        enforceBounds();
        // 延迟重置 moved 状态，确保 click 事件能被正确拦截
        setTimeout(() => {
          minDragState.moved = false;
        }, 50);
      } else {
        minDragState.moved = false;
      }
    };

    /** 最小化状态指针移动处理 */
    const handleMinimizedMove = (event) => {
      if (!minDragState.active) return;
      
      const dx = event.clientX - minDragState.startX;
      const dy = event.clientY - minDragState.startY;
      
      // 检查是否超过拖动阈值
      if (!minDragState.moved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
        minDragState.moved = true;
        panel.style.cursor = 'grabbing';
      }

      if (minDragState.moved) {
        // 计算新位置并限制在视口范围内
        const { width: vw, height: vh } = getVisibleViewport();
        const newLeft = minDragState.panelStartX + dx;
        const newTop = minDragState.panelStartY + dy;
        const maxLeft = vw - MINIMIZED_PANEL_SIZE - 8;
        const maxTop = vh - MINIMIZED_PANEL_SIZE - 8;
        
        panel.style.left = clampSize(newLeft, 8, maxLeft) + 'px';
        panel.style.top = clampSize(newTop, 8, maxTop) + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      }
    };

    /** 指针释放处理 */
    const handleMinimizedUp = (event) => {
      if (!minDragState.active) return;
      
      const wasMoved = minDragState.moved;
      endMinimizedDrag();
      
      // 如果没有发生拖动，视为点击，触发展开
      if (!wasMoved && panel.classList.contains('minimized')) {
        // 模拟点击 minify 按钮来展开
        const minifyBtn = panel.querySelector('.welearn-minify');
        if (minifyBtn) {
          minifyBtn.click();
        }
      }
    };

    /** 阻止拖动后的 click 事件 */
    const blockMinimizedClick = (event) => {
      if (minDragState.moved) {
        event.stopPropagation();
        event.preventDefault();
      }
    };

    // 使用 Pointer Events API，支持指针捕获
    panel.addEventListener('pointerdown', (event) => {
      if (!panel.classList.contains('minimized')) return;
      if (event.button !== 0) return; // 只响应左键
      
      const rect = panel.getBoundingClientRect();
      minDragState.active = true;
      minDragState.moved = false;
      minDragState.startX = event.clientX;
      minDragState.startY = event.clientY;
      minDragState.panelStartX = rect.left;
      minDragState.panelStartY = rect.top;
      minDragState.pointerId = event.pointerId;
      
      // 捕获指针，确保即使鼠标快速移动离开元素，事件仍然发送到 panel
      panel.setPointerCapture(event.pointerId);
    });

    panel.addEventListener('pointermove', handleMinimizedMove);
    panel.addEventListener('pointerup', handleMinimizedUp);
    panel.addEventListener('pointercancel', () => endMinimizedDrag(false));
    
    // 当指针捕获丢失时结束拖动
    panel.addEventListener('lostpointercapture', () => {
      if (minDragState.active) {
        endMinimizedDrag();
      }
    });

    // 捕获阶段拦截 click，如果发生了拖动则阻止
    panel.addEventListener('click', blockMinimizedClick, true);

    window.addEventListener('resize', () => {
      applyAutoSize();
      enforceBounds();
    });
  };

  // ==================== 面板初始化 ====================

  /** 初始化控制面板 */
  const initPanel = () => {
    createStyles();
    const panel = document.createElement('div');
    panel.className = 'welearn-panel';
    panel.innerHTML = `
      <h3>WeLearn-Go<span>v${VERSION}</span></h3>
      <button class="welearn-minify" title="折叠">●</button>
      <div class="welearn-body">
        <div class="welearn-actions">
          <button type="button" class="welearn-start">一键填写本页问题</button>
          <button type="button" class="welearn-toggle-btn welearn-submit-toggle">自动提交</button>
          <button type="button" class="welearn-toggle-btn welearn-mistake-toggle">智能添加小错误</button>
          <button type="button" class="welearn-scan-btn">📖 查看目录</button>
          <button type="button" class="welearn-batch-btn">⚡ 批量执行</button>
        </div>
        <div class="welearn-stats-row">
          <span class="welearn-error-stats">错误统计：暂无数据</span>
          <button type="button" class="welearn-clear-stats">清空</button>
        </div>
        <div class="welearn-weights-row">
          <span class="welearn-weights-label">错误比例：</span>
          <label>
            <span class="welearn-weight-text" style="margin:0px!important;">0个</span>
            <input type="text" inputmode="numeric" class="welearn-weight-0" value="50">
            <span class="welearn-weight-text" style="margin:0px!important;">%</span>
          </label>
          <label>
            <span class="welearn-weight-text" style="margin:0px!important;">1个</span>
            <input type="text" inputmode="numeric" class="welearn-weight-1" value="35">
            <span class="welearn-weight-text" style="margin:0px!important;">%</span>
          </label>
          <label>
            <span class="welearn-weight-text" style="margin:0px!important;">2个</span>
            <input type="text" inputmode="numeric" class="welearn-weight-2" value="15">
            <span class="welearn-weight-text" style="margin:0px!important;">%</span>
          </label>
          <span class="welearn-weights-error">总和必须为 100%</span>
        </div>
        <div class="welearn-footer">
          <span>拖动标题可移动，点击圆点可折叠</span>
          <a href="https://github.com/noxsk/WeLearn-Go" target="_blank" rel="noopener noreferrer">项目地址</a>
          <button type="button" class="welearn-support">请我喝一杯咖啡 ☕️</button>
        </div>
      </div>
      <div class="welearn-handle"></div>
    `;

    document.body.appendChild(panel);

    // 获取 UI 元素引用
    const header = panel.querySelector('h3');
    const startButton = panel.querySelector('.welearn-start');
    const submitToggle = panel.querySelector('.welearn-submit-toggle');
    const mistakeToggle = panel.querySelector('.welearn-mistake-toggle');
    const scanButton = panel.querySelector('.welearn-scan-btn');
    const batchButton = panel.querySelector('.welearn-batch-btn');
    const minifyButton = panel.querySelector('.welearn-minify');
    const supportButton = panel.querySelector('.welearn-support');

    // 为按钮添加 checked 属性模拟 checkbox 行为
    submitToggle.checked = false;
    mistakeToggle.checked = false;

    const state = loadPanelState();
    if (state.autoSubmit) {
      submitToggle.checked = true;
      submitToggle.classList.add('active');
    }
    if (state.enableSoftErrors) {
      mistakeToggle.checked = true;
      mistakeToggle.classList.add('active');
    }

    initDragAndResize(panel, header);

    /** 保存当前状态到 localStorage */
    const persistState = () => {
      const rect = panel.getBoundingClientRect();
      if (panel.classList.contains('minimized')) {
        panel.style.width = `${MINIMIZED_PANEL_SIZE}px`;
        panel.style.height = `${MINIMIZED_PANEL_SIZE}px`;
      } else {
        const width = clampSize(PANEL_DEFAULT_WIDTH, PANEL_MIN_WIDTH, getMaxWidth());
        panel.style.width = `${width}px`;
        panel.style.height = 'auto'; // 高度自适应
      }
      savePanelState({
        left: rect.left,
        top: rect.top,
        width: panel.offsetWidth,
        minimized: panel.classList.contains('minimized'),
        autoSubmit: submitToggle.checked,
        enableSoftErrors: mistakeToggle.checked,
      });
    };

    // 绑定事件监听器
    submitToggle.addEventListener('click', () => {
      submitToggle.checked = !submitToggle.checked;
      submitToggle.classList.toggle('active', submitToggle.checked);
      persistState();
    });
    
    mistakeToggle.addEventListener('click', () => {
      mistakeToggle.checked = !mistakeToggle.checked;
      mistakeToggle.classList.toggle('active', mistakeToggle.checked);
      persistState();
    });

    minifyButton.addEventListener('click', () => {
      const wasMinimized = panel.classList.contains('minimized');
      panel.classList.toggle('minimized');
      
      // 展开时检查是否会超出屏幕，如果是则平滑移动到可见区域
      if (wasMinimized) {
        // 等待 CSS 尺寸动画开始后计算实际需要的空间
        requestAnimationFrame(() => {
          const { width: vw, height: vh } = getVisibleViewport();
          const rect = panel.getBoundingClientRect();
          
          // 预估展开后的尺寸
          const expandedWidth = PANEL_DEFAULT_WIDTH;
          const expandedHeight = PANEL_DEFAULT_HEIGHT;
          
          // 计算需要调整的位置
          let targetLeft = rect.left;
          let targetTop = rect.top;
          let needsMove = false;
          
          // 检查右边界
          if (rect.left + expandedWidth > vw - 8) {
            targetLeft = Math.max(8, vw - expandedWidth - 8);
            needsMove = true;
          }
          // 检查下边界
          if (rect.top + expandedHeight > vh - 8) {
            targetTop = Math.max(8, vh - expandedHeight - 8);
            needsMove = true;
          }
          
          if (needsMove) {
            // 添加位置过渡动画
            panel.style.transition = 'width 0.25s ease, height 0.25s ease, min-width 0.25s ease, max-width 0.25s ease, padding 0.25s ease, left 0.25s ease, top 0.25s ease';
            panel.style.left = targetLeft + 'px';
            panel.style.top = targetTop + 'px';
            
            // 动画结束后移除位置过渡，保留原有过渡
            setTimeout(() => {
              panel.style.transition = 'width 0.25s ease, height 0.25s ease, min-width 0.25s ease, max-width 0.25s ease, padding 0.25s ease';
            }, 260);
          }
        });
      }
      
      persistState();
    });

    supportButton?.addEventListener('click', showSupportModal);

    // 读取目录按钮 - 显示任务选择弹窗
    scanButton?.addEventListener('click', () => {
      showTaskSelectorModal();
    });

    // 批量执行按钮 - 执行已选择的任务
    batchButton?.addEventListener('click', () => {
      executeBatchTasks();
    });

    // 清空统计按钮
    const clearStatsButton = panel.querySelector('.welearn-clear-stats');
    clearStatsButton?.addEventListener('click', () => {
      if (confirm('确定要清空错误统计数据吗？')) {
        clearErrorStats();
        showToast('统计数据已清空');
      }
    });

    // 权重设置输入框
    const weight0Input = panel.querySelector('.welearn-weight-0');
    const weight1Input = panel.querySelector('.welearn-weight-1');
    const weight2Input = panel.querySelector('.welearn-weight-2');
    const weightsErrorEl = panel.querySelector('.welearn-weights-error');

    /** 获取输入框的数值，空值返回0 */
    const getInputValue = (input) => {
      const val = input.value.trim();
      if (val === '') return 0;
      const num = parseInt(val, 10);
      return isNaN(num) ? 0 : Math.max(0, Math.min(100, num));
    };

    /** 验证并保存权重配置 */
    const validateAndSaveWeights = () => {
      const w0 = getInputValue(weight0Input);
      const w1 = getInputValue(weight1Input);
      const w2 = getInputValue(weight2Input);
      const total = w0 + w1 + w2;
      
      const isValid = total === 100;
      
      // 显示/隐藏错误提示
      weightsErrorEl.classList.toggle('visible', !isValid);
      [weight0Input, weight1Input, weight2Input].forEach((input) => {
        input.classList.toggle('error', !isValid);
      });
      
      if (isValid) {
        saveErrorWeights({ w0, w1, w2 });
      }
      
      return isValid;
    };

    /** 过滤非数字字符 */
    const filterNonNumeric = (input) => {
      input.value = input.value.replace(/[^0-9]/g, '');
    };

    // 加载已保存的权重配置
    const savedWeights = loadErrorWeights();
    weight0Input.value = savedWeights.w0;
    weight1Input.value = savedWeights.w1;
    weight2Input.value = savedWeights.w2;
    validateAndSaveWeights();

    // 绑定权重输入事件
    [weight0Input, weight1Input, weight2Input].forEach((input) => {
      input.addEventListener('input', () => {
        filterNonNumeric(input);
        validateAndSaveWeights();
      });
      input.addEventListener('change', validateAndSaveWeights);
    });

    // 初始化统计显示
    refreshErrorStatsDisplay();

    // 注意：最小化状态下的点击展开逻辑已移至 initDragAndResize 函数中
    // 通过拖动阈值判断：移动小于 5px 视为点击，展开面板

    startButton.addEventListener('click', () => {
      startButton.disabled = true;
      const result = fillAll({ enableSoftErrors: mistakeToggle.checked });
      
      // 同时触发 iframe 内的填充
      triggerIframeFill(mistakeToggle.checked);
      
      if (result.filled) {
        // 更新错误统计（如果启用了添加小错误功能）
        if (mistakeToggle.checked) {
          updateErrorStats(result.errors.length);
        }
        
        // 立即显示填写完成提示
        if (!groupWorkDetected) {
          const errorCount = result.errors.length;
          if (mistakeToggle.checked && errorCount > 0) {
            // 生成带红色高亮的错误详情
            const details = result.errors.map((e) => {
              // 找出不同的字符并标红
              const highlighted = highlightDiff(e.original, e.modified);
              return `<span class="welearn-error-item"><b>${e.type}</b> ${highlighted}</span>`;
            }).join('');
            showToast(`填写完成！已添加 ${errorCount} 处小错误：${details}`, { html: true, duration: 3500 });
          } else if (mistakeToggle.checked) {
            showToast('填写完成！本次无小错误');
          } else {
            showToast('填写完成！');
          }
        }
        
        // 延迟提交（如果启用）
        if (submitToggle.checked) {
          setTimeout(() => {
            submitIfNeeded(true);
            startButton.disabled = false;
          }, SUBMIT_DELAY_MS);
        } else {
          startButton.disabled = false;
        }
      } else {
        // 检查是否有 iframe 可能包含内容
        const hasIframes = document.querySelectorAll('iframe').length > 0;
        if (hasIframes) {
          showToast('已发送填充请求到页面框架');
        } else {
          showToast('未发现可填写的内容');
        }
        startButton.disabled = false;
      }
    });
  };

  /** 确保面板已挂载到页面 */
  const ensurePanelMounted = () => {
    if (!document.body) return;
    if (document.querySelector('.welearn-panel')) return;
    initPanel();
  };

  // ==================== 引导模态框 ====================

  /** 加载引导状态 */
  const loadOnboardingState = () => {
    try {
      const raw = localStorage.getItem(ONBOARDING_STATE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (error) {
      console.warn('WeLearn autofill: failed to load onboarding state', error);
      return {};
    }
  };

  /** 保存引导状态 */
  const saveOnboardingState = (state) => {
    try {
      localStorage.setItem(ONBOARDING_STATE_KEY, JSON.stringify(state));
    } catch (error) {
      console.warn('WeLearn autofill: failed to save onboarding state', error);
    }
  };

  // ==================== 赞赏码图片缓存 ====================

  /** 从 localStorage 加载缓存的图片 */
  const loadCachedDonateImage = () => {
    try {
      const cached = localStorage.getItem(DONATE_IMAGE_CACHE_KEY);
      if (cached) {
        donateImageDataUrl = cached;
        return true;
      }
    } catch (error) {
      console.warn('WeLearn: 加载缓存图片失败', error);
    }
    return false;
  };

  /** 预加载并缓存赞赏码图片 */
  const preloadDonateImage = () => {
    // 如果已有缓存，直接使用
    if (loadCachedDonateImage()) {
      console.info('[WeLearn-Go] 已从缓存加载赞赏码图片');
      return;
    }

    // 使用 fetch 获取图片并转换为 Data URL
    fetch(DONATE_IMAGE_URL)
      .then(response => {
        if (!response.ok) throw new Error('图片加载失败');
        return response.blob();
      })
      .then(blob => {
        const reader = new FileReader();
        reader.onloadend = () => {
          donateImageDataUrl = reader.result;
          try {
            localStorage.setItem(DONATE_IMAGE_CACHE_KEY, donateImageDataUrl);
            console.info('[WeLearn-Go] 赞赏码图片已缓存到本地');
          } catch (error) {
            console.warn('WeLearn: 缓存图片到 localStorage 失败', error);
          }
        };
        reader.readAsDataURL(blob);
      })
      .catch(error => {
        console.warn('WeLearn: 预加载赞赏码图片失败', error);
      });
  };

  /** 显示赞赏模态框 */
  const showSupportModal = () => {
    // 使用缓存的图片或原始 URL
    const imageUrl = donateImageDataUrl || DONATE_IMAGE_URL;
    const overlay = document.createElement('div');
    overlay.className = 'welearn-modal-overlay';
    overlay.innerHTML = `
      <div class="welearn-modal">
        <h3>赞助支持</h3>
        <p>如果你能请我喝一杯咖啡，我将不胜感激！</p>
        <div class="welearn-donate-grid">
          <a href="${DONATE_IMAGE_URL}" target="_blank" rel="noopener noreferrer">
            <img src="${imageUrl}" alt="微信赞赏码">
            <span>微信</span>
          </a>
        </div>
        <div class="welearn-modal-footer">
          <span class="welearn-badge">感谢支持</span>
          <button type="button" class="welearn-modal-close">关闭</button>
        </div>
      </div>
    `;

    const close = () => overlay.remove();
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });

    overlay.querySelector('.welearn-modal-close')?.addEventListener('click', close);

    document.body.appendChild(overlay);
  };

  /** 显示首次使用引导模态框 */
  const showOnboardingModal = () => {
    const state = loadOnboardingState();
    if (state.seen) return;

    const overlay = document.createElement('div');
    overlay.className = 'welearn-modal-overlay';
    overlay.innerHTML = `
      <div class="welearn-modal">
        <h3>使用须知</h3>
        <p>本脚本仅供学习使用，请在 24H 内删除。对使用该脚本产生的后果均由使用者承担。</p>
        <p>本脚本始终保持免费，如购买所得说明被骗了。</p>
        <div class="welearn-guide">
          <p>简易使用教程：</p>
          <ol>
            <li>进入对应课程练习页面（当前已适配：领航大学英语综合教程1）。</li>
            <li>点击页面左侧的「一键填写」按钮自动填写答案。</li>
            <li>如需自动提交，可在面板中勾选「自动提交」。</li>
          </ol>
        </div>
        <div class="welearn-modal-footer">
          <span class="welearn-badge">适配：领航大学英语综合教程1</span>
          <button type="button" class="welearn-modal-close">我已知晓</button>
        </div>
      </div>
    `;

    const close = () => {
      saveOnboardingState({ seen: true });
      overlay.remove();
    };

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });

    const closeButton = overlay.querySelector('.welearn-modal-close');
    closeButton?.addEventListener('click', close);

    document.body.appendChild(overlay);
  };

  // ==================== 页面生命周期管理 ====================

  /** 初始化页面元素 */
  const initPageArtifacts = (showSwitchToast = false) => {
    groupWorkDetected = false;
    groupWorkNoticeShown = false;
    openEndedExerciseShown = false;
    cleanupPageArtifacts();
    showOnboardingModal();
    ensurePanelMounted();
    if (!ensurePanelMounted.observer && document.body) {
      ensurePanelMounted.observer = new MutationObserver(() => ensurePanelMounted());
      ensurePanelMounted.observer.observe(document.body, { childList: true, subtree: true });
    }
    if (showSwitchToast && !isInIframe()) {
      showToast('检测到页面切换，已为新作业自动初始化');
    }
    
    // 检查批量任务状态
    setTimeout(() => {
      // 检查是否有正在进行的批量执行
      const batchState = loadBatchModeState();
      const isExecuting = batchState && batchState.active;
      
      if (isOnCourseDirectoryPage()) {
        // 在目录页面
        if (isExecuting && batchState.phase === 'returning') {
          // 批量执行中，从任务页面返回，继续执行下一个任务
          console.log('[WeLearn-Go] 批量执行: 已返回目录页面，继续执行下一个任务');
          batchModeActive = true;
          showBatchProgressIndicator(batchState.totalTasks, batchState.currentIndex);
          
          setTimeout(() => {
            executeNextTask();
          }, 1500);
        } else if (!batchModeActive && !isExecuting && selectedBatchTasks.length === 0) {
          // 没有正在执行的批量任务，检查异常中断的任务
          checkAndResumeBatchMode();
          
          // 检查是否有缓存的任务可以恢复
          const tasksCache = loadBatchTasksCache();
          if (tasksCache && tasksCache.tasks && tasksCache.tasks.length > 0) {
            showBatchTasksRecoveryPrompt();
          }
        }
      } else if (isExecuting && batchState.phase === 'navigating') {
        // 在任务页面，且批量执行正在进行中，继续执行填写
        console.log('[WeLearn-Go] 批量执行: 任务页面已加载，开始填写');
        batchModeActive = true;
        showBatchProgressIndicator(batchState.totalTasks, batchState.currentIndex);
        
        // 等待页面完全加载后执行填写
        setTimeout(() => {
          executeFillAndSubmit();
        }, 2000);
      }
    }, 1500);
  };

  /** 在 iframe 中初始化（不显示面板，监听父窗口消息） */
  const initInIframe = () => {
    console.info('[WeLearn-Go]', 'iframe 模式已加载', location.href);
    
    // 使用 MutationObserver 监听 DOM 变化，适应 SPA
    const observer = new MutationObserver((mutations) => {
       // 简单的防抖，避免频繁检测
       if (observer.timer) clearTimeout(observer.timer);
       observer.timer = setTimeout(() => {
         checkContent();
       }, 1000);
    });
    
    observer.observe(document.body, { childList: true, subtree: true });
    
    // 检测页面是否有练习元素
    const checkContent = () => {
      const blanks = document.querySelectorAll('et-blank');
      const toggles = document.querySelectorAll('et-toggle');
      const items = document.querySelectorAll('et-item');
      const allContentEditable = document.querySelectorAll('[contenteditable="true"]');
      console.info('[WeLearn-Go] iframe 内容检测:', {
        'et-blank': blanks.length,
        'et-toggle': toggles.length,
        'et-item': items.length,
        'contenteditable': allContentEditable.length
      });
    };
    
    // 监听来自父窗口的填充请求
    window.addEventListener('message', (event) => {
      // 验证消息来源
      if (!event.origin.includes('sflep.com')) return;
      
      if (event.data?.type === 'welearn-fill') {
        const result = fillAll({ enableSoftErrors: event.data.enableSoftErrors || false });
        // 向父窗口报告结果
        try {
          window.parent.postMessage({
            type: 'welearn-fill-result',
            ...result
          }, '*');
        } catch (e) { /* 忽略跨域错误 */ }
      }
    });
    
    // 暴露全局 API 供父窗口或控制台调用
    window.WeLearnGo = {
      fill: (options = {}) => fillAll(options),
      isReady: true
    };
    
    // 通知父窗口 iframe 已准备就绪
    try {
      window.parent.postMessage({ type: 'welearn-iframe-ready' }, '*');
    } catch (e) { /* 忽略跨域错误 */ }
  };

  /** 脚本入口函数 */
  const start = () => {
    if (!isWeLearnHost()) return;
    console.info('[WeLearn-Go]', '辅助脚本已加载，祝你学习顺利！','相关内容仅供学习研究，请在 24H 内删除。','使用该脚本产生的后果均由使用者承担。');
    
    const run = () => {
      if (!document.body) {
        setTimeout(run, 50);
        return;
      }
      
      // 根据是否在 iframe 中采用不同策略
      if (isInIframe()) {
        initInIframe();
        // iframe 中也需要自动确认
        startAutoConfirmDialog();
      } else {
        // 预加载赞赏码图片（只在主页面）
        preloadDonateImage();
        initPageArtifacts();
        monitorPageSwitches();
        // 监听 iframe 就绪消息
        listenForIframeReady();
        // 启动自动确认提交对话框监听
        startAutoConfirmDialog();
      }
    };

    run();
  };

  /** 监听 iframe 就绪消息，并触发填充 */
  const listenForIframeReady = () => {
    window.addEventListener('message', (event) => {
      if (!event.origin.includes('sflep.com')) return;
      
      if (event.data?.type === 'welearn-iframe-ready') {
        console.info('[WeLearn-Go]', 'iframe 已就绪');
      }
      
      if (event.data?.type === 'welearn-fill-result') {
        // 收到 iframe 填充结果
        if (event.data.filled) {
          console.info('[WeLearn-Go]', 'iframe 填充完成');
        }
      }
    });
  };

  /** 触发 iframe 中的填充操作 */
  const triggerIframeFill = (enableSoftErrors = false) => {
    const iframes = document.querySelectorAll('iframe');
    iframes.forEach((iframe) => {
      try {
        iframe.contentWindow?.postMessage({
          type: 'welearn-fill',
          enableSoftErrors
        }, '*');
      } catch (e) { /* 忽略跨域错误 */ }
    });
  };

  /** 处理页面切换（重新初始化） */
  const handlePageChange = () => {
    if (!isWeLearnHost()) return;
    initPageArtifacts(true);
  };

  /** 监控页面切换（SPA 路由变化） */
  const monitorPageSwitches = () => {
    const WATCH_INTERVAL_MS = 1000;
    if (monitorPageSwitches.started) return;
    monitorPageSwitches.started = true;

    setInterval(() => {
      if (location.href === lastKnownUrl) return;
      lastKnownUrl = location.href;
      handlePageChange();
    }, WATCH_INTERVAL_MS);
  };

  // ==================== 脚本启动 ====================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();