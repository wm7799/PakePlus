// --- 配置信息 ---
const GAME_CONFIG = {
    MAX_SCORE: 100,
    COMBO_TIERS: [3, 5, 8, 12],
    COMBO_SCORE_MULTIPLIER_STEP: 0.2,
    MAX_FALLING_WORDS_BASE: 3,
    DEFAULT_SPAWN_INTERVAL: 2200, // ms
    DEFAULT_FALL_DURATION: 8, // seconds
    MIN_SPAWN_INTERVAL: 800,
    MIN_FALL_DURATION: 3,
    DIFFICULTY_SETTINGS: {
        easy: { spawnFactor: 1.6, fallFactor: 1.4, hintEnabled: true, maxWords: 3 },
        medium: { spawnFactor: 1.0, fallFactor: 1.0, hintEnabled: true, maxWords: 4 },
        hard: { spawnFactor: 0.65, fallFactor: 0.7, hintEnabled: false, maxWords: 5 }
    },
    PROGRESS_ADJUSTMENT: {
        INTERVAL_REDUCTION_PER_10_PERCENT: 0.05,
        DURATION_REDUCTION_PER_10_PERCENT: 0.04,
    },
    INPUT_DEBOUNCE_MS: 100,
    POINTS_LOST_PER_MISS_FACTOR: 1,
    TOOLTIP_DELAY_MS: 300,
    PARTICLE_COUNT: 25,
    SOUND_ENABLED_BY_DEFAULT: true,
    SOUND_FILES: {
        correct: 'sounds/correct.mp3',
        incorrect: 'sounds/incorrect.mp3',
        combo: 'sounds/combo.mp3',
        gameover: 'sounds/gameover.mp3',
        wordMissed: 'sounds/word_missed.mp3',
        buttonClick: 'sounds/button_click.mp3'
    },
    MISTAKE_THRESHOLD: 3,
    WEBDAV_REMOTE_FILE_BASENAME: 'word_paradise_progress'
};
window.GAME_CONFIG = GAME_CONFIG;


// --- 游戏状态变量 ---
let wordList = [];
window.wordList = wordList;
let remainingWords = [];
let score = GAME_CONFIG.MAX_SCORE;
let fallingWords = [];
let gameInterval;
let wordGenerationInterval;
let difficulty;
let pointPerWord;
let lastInputTime = 0;
let lastFrameTime = null;
let comboCount = 0;
let comboMultiplier = 1;
let lastWordTime = Date.now();
let isPaused = false;
let isSoundEnabled = GAME_CONFIG.SOUND_ENABLED_BY_DEFAULT;
let currentWordSourceType = 'selection'; // Default
window.currentWordSourceType = currentWordSourceType;

// --- DOM 元素 ---
const mainPanel = document.querySelector('.main-panel');
const difficultyContainer = document.getElementById('difficulty-container');
const gameInterface = document.getElementById('game-interface');
const gameContainer = document.getElementById('game-container');
const scoreDisplay = document.getElementById('score');
const gameProgressDisplay = document.getElementById('game-progress');
const answerInput = document.getElementById('answer');
const feedbackElement = document.getElementById('feedback');
const mistakeModal = document.getElementById('mistake-modal');
const mistakeListDiv = document.getElementById('mistake-list');
const initialGuidance = document.getElementById('initial-guidance');
const dbLoadingIndicator = document.getElementById('db-loading-indicator');
const pauseButton = document.getElementById('pause-button');
const soundButton = document.getElementById('sound-button');
const pauseOverlay = document.getElementById('pause-overlay');
const fileInput = document.getElementById('file-input');
const importProgress = document.getElementById('import-progress');

// --- 数据 ---
let wrongWordsMap = new Map();
let mistakeBook = [];
window.mistakeBook = mistakeBook;
let wordsDatabase = null;

// --- 对象池 ---
class WordPool {
    constructor() {
        this.pools = { word: [], tooltip: [], particle: [], combo: [] };
        this.lastCleanTime = Date.now();
        this.POOL_CLEAN_INTERVAL = 60000;
        this.MAX_POOL_SIZE = 20;
    }
    get(type, className = type) {
        this.cleanPoolIfNeeded();
        let element;
        if (this.pools[type] && this.pools[type].length > 0) {
            element = this.pools[type].pop();
            element.className = className;
        } else {
            element = document.createElement('div');
            element.className = className;
        }
        element.style.cssText = '';
        element.innerHTML = '';
        return element;
    }
    release(type, element) {
        if (!element) return;
        element.style.cssText = '';
        element.className = type;
        element.innerHTML = '';
        if (this.pools[type]) {
            this.pools[type].push(element);
        }
    }
    cleanPoolIfNeeded() {
        if (Date.now() - this.lastCleanTime > this.POOL_CLEAN_INTERVAL) {
            Object.keys(this.pools).forEach(type => {
                if (this.pools[type] && this.pools[type].length > this.MAX_POOL_SIZE) {
                    this.pools[type] = this.pools[type].slice(-this.MAX_POOL_SIZE);
                }
            });
            this.lastCleanTime = Date.now();
        }
    }
}
const wordPool = new WordPool();

// --- 初始化 ---
document.addEventListener('DOMContentLoaded', () => {
    setupSelectors();
    loadMistakeBook();
    updateSoundButtonUI();

    if (window.WebDAVModule && typeof window.WebDAVModule.initDOMElements === 'function') {
        window.WebDAVModule.initDOMElements();
    }
    if (window.WebDAVModule && typeof window.WebDAVModule.loadSettings === 'function') {
        window.WebDAVModule.loadSettings();
    }

    if (dbLoadingIndicator) dbLoadingIndicator.style.display = 'block';
    loadWordsDatabase().then(db => {
        wordsDatabase = db;
        console.log('单词数据库加载完成');
    }).catch(error => {
        console.error('加载单词数据库失败:', error);
        showFeedback('词库加载失败，将使用默认词库。', 'error', 2000);
        wordsDatabase = { "default_1_1": DEFAULT_WORDS };
    }).finally(() => {
        if (dbLoadingIndicator) dbLoadingIndicator.style.display = 'none';
    });

    if (answerInput) {
        answerInput.addEventListener('input', () => {
            if (!isPaused) checkInput();
        });
        answerInput.addEventListener('keydown', function(event) {
            if (event.key === 'Enter' && !isPaused) {
                checkAnswer();
            }
        });
    }

    document.querySelectorAll('.btn, .selector-option').forEach(button => {
        button.addEventListener('click', () => playSound('buttonClick'));
    });

    const hideGuidanceOnClickElements = document.querySelectorAll('.selector-label');
    const hideGuidanceOnChangeElements = document.querySelectorAll('#file-input');

    const hideGuidance = () => {
        if (initialGuidance && initialGuidance.style.display !== 'none') {
            initialGuidance.style.display = 'none';
        }
        hideGuidanceOnClickElements.forEach(el => el.removeEventListener('click', hideGuidance));
        hideGuidanceOnChangeElements.forEach(el => el.removeEventListener('change', hideGuidance));
    };

    hideGuidanceOnClickElements.forEach(label => {
        label.addEventListener('click', hideGuidance, { once: true });
    });
    hideGuidanceOnChangeElements.forEach(input => {
        input.addEventListener('change', hideGuidance, { once: true });
    });
});

// --- 主要的开始/加载逻辑 ---
function attemptStartOrLoadGame() {
    playSound('buttonClick');
    if (window.wordList && window.wordList.length > 0 &&
        (window.currentWordSourceType === 'file' || window.currentWordSourceType === 'webdav_import')) {
        prepareGameStart(window.wordList.length);
    } else {
        showFeedback('请选择一个TXT单词文件来开始游戏。', 'info', 2500);
        if (fileInput) {
            fileInput.click();
        } else {
            console.error("File input element not found for attemptStartOrLoadGame");
        }
    }
}
window.attemptStartOrLoadGame = attemptStartOrLoadGame;

function handleFileSelectedForGame() {
    if (fileInput && fileInput.files && fileInput.files.length > 0) {
        processSelectedFile(fileInput.files[0]);
    }
    if (fileInput) {
        fileInput.value = '';
    }
}
window.handleFileSelectedForGame = handleFileSelectedForGame;

function processSelectedFile(file) {
    if (!file) return;

    if (importProgress) importProgress.style.width = '0%';
    const reader = new FileReader();
    if (importProgress) reader.onloadstart = () => importProgress.style.width = '10%';
    if (importProgress) reader.onprogress = (e) => {
        if (e.lengthComputable) {
            importProgress.style.width = `${10 + Math.round((e.loaded / e.total) * 90)}%`;
        }
    };
    reader.onload = (e) => {
        if (importProgress) importProgress.style.width = '100%';
        let parsedWords = [];
        let skippedLines = 0;
        const lines = e.target.result.split(/\r?\n/);

        const MAX_ENGLISH_LENGTH = 50;
        const MAX_CHINESE_LENGTH = 100;
        const englishWordPattern = /^(?=.*[a-zA-Z])[a-zA-Z0-9\s'-]+$/;
        const chinesePattern = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

        lines.forEach(line => {
            const trimmedOriginalLine = line.trim();
            if (!trimmedOriginalLine) return;

            let english = "";
            let chinese = "";
            let parsedSuccessfully = false;
            let isJsonFormatAttempt = false;

            if (trimmedOriginalLine.startsWith("{") && trimmedOriginalLine.endsWith("}")) {
                isJsonFormatAttempt = true;
                try {
                    const jsonObj = JSON.parse(trimmedOriginalLine);
                    if (jsonObj && typeof jsonObj.english === 'string' && typeof jsonObj.chinese === 'string') {
                        english = jsonObj.english.trim();
                        chinese = jsonObj.chinese.trim();
                        parsedSuccessfully = true;
                    }
                } catch (jsonError) {
                    console.warn(`Line looked like JSON but failed to parse: "${trimmedOriginalLine}"`, jsonError);
                }
            }

            if (!parsedSuccessfully && !isJsonFormatAttempt) {
                const parts = trimmedOriginalLine.split(/[,，]+/);
                if (parts.length === 2) {
                    english = parts[0].trim();
                    chinese = parts[1].trim();
                    parsedSuccessfully = true;
                }
            }

            if (parsedSuccessfully && english && chinese &&
                english.length > 0 && english.length <= MAX_ENGLISH_LENGTH &&
                chinese.length > 0 && chinese.length <= MAX_CHINESE_LENGTH &&
                englishWordPattern.test(english) &&
                chinesePattern.test(chinese)
            ) {
                parsedWords.push({ english, chinese });
            } else {
                if (trimmedOriginalLine) {
                    skippedLines++;
                    console.warn(`Skipped line (failed validation or parsing): "${trimmedOriginalLine}" -> Parsed E: "${english}", C: "${chinese}"`);
                }
            }
        });

        if (parsedWords.length === 0) {
            let feedbackMsg = '文件内容无法解析或为空!';
            const nonEmptyLines = lines.filter(l => l.trim()).length;

            if (nonEmptyLines > 0 && skippedLines === nonEmptyLines) {
                feedbackMsg = `所有 ${skippedLines} 行都无法解析! <br>请确保每行格式为：<br>
                               1. 英文,中文 (例如: apple,苹果)<br>
                               2. {"english": "英文", "chinese": "中文"}`;
            } else if (nonEmptyLines > 0 && parsedWords.length === 0) {
                 feedbackMsg = `未能从文件中解析出有效单词。<br>请检查格式是否为：<br>
                               1. 英文,中文 (例如: apple,苹果)<br>
                               2. {"english": "英文", "chinese": "中文"}`;
            }
            showFeedback(`${feedbackMsg}<br>将使用默认单词列表。`, 'error', 5000);
            window.wordList = [...DEFAULT_WORDS];
            window.currentWordSourceType = 'default_fallback';
            if (window.wordList.length > 0) {
                prepareGameStart(window.wordList.length, true); // MODIFIED: Suppress prepareGameStart feedback
            } else {
                 if (typeof showMainPanel === 'function') showMainPanel();
            }
        } else { // parsedWords.length > 0
            window.wordList = parsedWords;
            window.currentWordSourceType = 'file';
            if (skippedLines > 0) {
                // MODIFIED: Show combined message and suppress prepareGameStart feedback
                showFeedback(`成功导入 ${parsedWords.length} 个单词，但忽略了 ${skippedLines} 行无效内容。<br>请选择难度。`, 'warning', 4000);
                prepareGameStart(window.wordList.length, true);
            } else {
                // MODIFIED: Perfect import, let prepareGameStart show its normal feedback
                prepareGameStart(window.wordList.length, false);
            }
        }
    };
    reader.onerror = () => {
        if (importProgress) importProgress.style.width = '0%';
        showFeedback('读取文件出错! 将使用默认单词列表。', 'error', 2500);
        window.wordList = [...DEFAULT_WORDS];
        window.currentWordSourceType = 'default_fallback';
        if (window.wordList.length > 0) {
            prepareGameStart(window.wordList.length, true); // MODIFIED: Suppress prepareGameStart feedback
        } else {
            if (typeof showMainPanel === 'function') showMainPanel();
        }
    };
    reader.readAsText(file);
}


// --- 音效系统 ---
function playSound(soundName) {
    if (!isSoundEnabled || !GAME_CONFIG.SOUND_FILES[soundName]) return;
    try {
        const audioElement = document.getElementById(`${soundName}-sound`);
        if (audioElement) {
            audioElement.currentTime = 0;
            audioElement.play().catch(e => console.warn(`无法播放音效 ${soundName}:`, e));
        } else {
            console.warn(`音效元素未找到: ${soundName}-sound`);
        }
    } catch (error) {
        console.error(`播放音效 ${soundName} 出错:`, error);
    }
}

function toggleSound() {
    isSoundEnabled = !isSoundEnabled;
    updateSoundButtonUI();
    showFeedback(isSoundEnabled ? '🔊 声音已开启' : '🔇 声音已关闭', 'info', 1000);
}
window.toggleSound = toggleSound;

function updateSoundButtonUI() {
    if (soundButton) {
        soundButton.textContent = isSoundEnabled ? '🔊' : '🔇';
        soundButton.classList.toggle('sound-on', isSoundEnabled);
        soundButton.classList.toggle('sound-off', !isSoundEnabled);
        soundButton.setAttribute('aria-label', isSoundEnabled ? '静音' : '取消静音');
    }
}

// --- UI 控制 ---
function showMainPanel() {
    if (mainPanel) mainPanel.style.display = 'block';
    if (difficultyContainer) difficultyContainer.style.display = 'none';
    if (gameInterface) gameInterface.style.display = 'none';
    resetGameUI();
}
window.showMainPanel = showMainPanel;

function closeModal(modalId) {
    const modalToClose = document.getElementById(modalId);
    if (modalToClose) {
        modalToClose.classList.remove('active');
        setTimeout(() => {
            if (!modalToClose.classList.contains('active')) {
                 modalToClose.style.display = 'none';
            }
        }, 300);
    }
}
window.closeModal = closeModal;

// --- 单词管理 (loadWordsDatabase, getWordsForSelection) ---
function loadWordsDatabase() {
    return fetch('words-database.json')
        .then(response => {
            if (!response.ok) throw new Error(`网络响应错误: ${response.statusText}`);
            return response.json();
        })
        .then(data => {
            console.log('单词数据库原始数据:', data);
            return data;
        });
}

function getWordsForSelection() {
    if (!currentStage || !currentGrade || !currentSemester) {
        showFeedback('请先完整选择学习阶段、年级和学期!', 'error');
        return [];
    }
    const sectionKey = `${currentStage}_${currentGrade}_${currentSemester}`;
    if (!wordsDatabase) {
        showFeedback('单词数据库尚未加载! 请稍后再试或使用默认单词。', 'error');
        return DEFAULT_WORDS;
    }
    if (!wordsDatabase[sectionKey] || wordsDatabase[sectionKey].length === 0) {
        console.warn('可用键名:', Object.keys(wordsDatabase));
        showFeedback(`未找到 ${currentStage}${currentGrade}年级${currentSemester === '1' ? '上学期' : '下学期'} 的单词! 将使用默认单词。`, 'warning', 2500);
        return DEFAULT_WORDS;
    }
    return wordsDatabase[sectionKey];
}

// MODIFIED: Added suppressFeedback parameter with a default value
function prepareGameStart(numWords, suppressFeedback = false) {
    if (numWords > 0) {
        remainingWords = [...window.wordList];
        pointPerWord = GAME_CONFIG.MAX_SCORE / numWords;
        if (mainPanel) mainPanel.style.display = 'none';
        if (difficultyContainer) difficultyContainer.style.display = 'block';
        // MODIFIED: Only show feedback if suppressFeedback is false
        if (!suppressFeedback) {
            showFeedback(`成功加载 ${numWords} 个单词! 请选择难度。`, 'correct', 2000);
        }
    } else {
        // MODIFIED: Consider suppressFeedback for the "no words loaded" message too,
        // but generally, if this path is hit NOT as a fallback, the error is important.
        // We only truly want to suppress this if it's a fallback from a file that had an error message displayed.
        // The currentWordSourceType check helps distinguish this.
        if (!suppressFeedback || (window.currentWordSourceType !== 'default_fallback' && numWords === 0) ) {
             showFeedback('没有加载到单词，无法开始游戏。', 'error');
        }
        if (mainPanel) mainPanel.style.display = 'block';
        if (difficultyContainer) difficultyContainer.style.display = 'none';
    }
}
window.prepareGameStart = prepareGameStart;

// --- 选择器逻辑 ---
function setupSelectors() {
    document.querySelectorAll('.selector-label').forEach(label => {
        label.addEventListener('click', function(e) {
            e.stopPropagation();
            const box = this.parentElement;
            const wasActive = box.classList.contains('active');
            document.querySelectorAll('.selector-box').forEach(b => b.classList.remove('active'));
            if (!wasActive) {
                box.classList.add('active');
                setTimeout(() => {
                    const options = box.querySelector('.selector-options');
                    if (options) {
                        const rect = options.getBoundingClientRect();
                        const maxAvailableHeight = window.innerHeight - rect.top - 30;
                        options.style.maxHeight = `${Math.min(350, maxAvailableHeight)}px`;
                    }
                }, 10);
            }
        });
    });
    document.addEventListener('click', () => {
        document.querySelectorAll('.selector-box').forEach(box => box.classList.remove('active'));
    });
}

let currentStage = null, currentGrade = null, currentSemester = null;

function selectStage(stage, displayName) {
    currentStage = stage;
    document.querySelector('#stage-selector .selector-label').textContent = displayName;
    const gradeOptionsContainer = document.getElementById('grade-options');
    gradeOptionsContainer.innerHTML = '';
    const grades = stage === 'primary' ? 6 : (stage === 'junior' || stage === 'senior' ? 3 : 0);
    const gradeName = stage === 'primary' ? '年级' : (stage === 'junior' ? '年级' : (stage === 'senior' ? '年级' : ''));
    for (let i = 1; i <= grades; i++) {
        const option = document.createElement('div');
        option.className = 'selector-option';
        option.textContent = `${i}${gradeName}`;
        option.onclick = () => selectGrade(i.toString(), `${i}${gradeName}`);
        gradeOptionsContainer.appendChild(option);
    }
    document.querySelector('#grade-selector .selector-label').textContent = '选择年级';
    document.querySelector('#semester-selector .selector-label').textContent = '选择学期';
    currentGrade = null; currentSemester = null;
    closeActiveSelectors();
}
window.selectStage = selectStage;

function selectGrade(grade, displayName) {
    currentGrade = grade;
    document.querySelector('#grade-selector .selector-label').textContent = displayName;
    document.querySelector('#semester-selector .selector-label').textContent = '选择学期';
    currentSemester = null;
    closeActiveSelectors();
}

function selectSemester(semester, displayName) {
    currentSemester = semester;
    document.querySelector('#semester-selector .selector-label').textContent = displayName;
    closeActiveSelectors();
    setTimeout(() => {
        if (currentStage && currentGrade && currentSemester) {
            const selectedWords = getWordsForSelection();
            window.wordList = selectedWords;
            if (window.wordList && window.wordList.length > 0) {
                window.currentWordSourceType = 'selection';
                prepareGameStart(window.wordList.length); // This will show feedback by default
            } else {
                 showFeedback('当前选择没有对应的单词。', 'warning', 2000);
            }
        } else {
            showFeedback('请确保已选择完整的学习阶段、年级和学期。', 'warning', 2500);
        }
    }, 100);
}
window.selectSemester = selectSemester;

function closeActiveSelectors() {
    document.querySelectorAll('.selector-box.active').forEach(box => box.classList.remove('active'));
}

// --- 游戏逻辑 ---
function startGame(selectedDifficulty) {
    if (window.wordList.length === 0) {
        showFeedback('没有单词可以开始游戏！请先选择或导入单词。', 'error');
        showMainPanel();
        return;
    }
    difficulty = selectedDifficulty;
    isPaused = false;
    resetGameState();
    if (difficultyContainer) difficultyContainer.style.display = 'none';
    if (gameInterface) gameInterface.style.display = 'block';
    if (answerInput) { answerInput.disabled = false; answerInput.focus(); }
    if(pauseOverlay) pauseOverlay.style.display = 'none';
    lastFrameTime = performance.now();
    gameInterval = requestAnimationFrame(gameLoop);
    const params = getGameParams();
    if (wordGenerationInterval) clearInterval(wordGenerationInterval);
    wordGenerationInterval = setInterval(startFallingWord, params.spawnInterval);
    for (let i = 0; i < Math.min(2, params.maxWords || 2) ; i++) {
        setTimeout(startFallingWord, i * (params.spawnInterval / 3));
    }
}
window.startGame = startGame;

function resetGameState() {
    score = GAME_CONFIG.MAX_SCORE;
    comboCount = 0; comboMultiplier = 1; lastWordTime = Date.now();
    fallingWords.forEach(fw => {
        if (fw.element) wordPool.release('word', fw.element);
        if (fw.tooltipTimeoutId) clearTimeout(fw.tooltipTimeoutId);
    });
    fallingWords = [];
    remainingWords = [...window.wordList];
    if (window.wordList.length > 0) {
        pointPerWord = GAME_CONFIG.MAX_SCORE / window.wordList.length;
    } else { pointPerWord = 10; }
    updateScoreDisplay(); updateWordProgressDisplay();
    if (pauseButton) pauseButton.textContent = '❚❚ 暂停';
    if (pauseOverlay) pauseOverlay.style.display = 'none';
}

function getGameParams() {
    const baseSettings = GAME_CONFIG.DIFFICULTY_SETTINGS[difficulty];
    let spawnInterval = GAME_CONFIG.DEFAULT_SPAWN_INTERVAL * baseSettings.spawnFactor;
    let fallDuration = GAME_CONFIG.DEFAULT_FALL_DURATION * baseSettings.fallFactor;
    let maxWords = baseSettings.maxWords;
    const totalWordsInGame = window.wordList.length > 0 ? window.wordList.length : 1;
    const progressPercent = totalWordsInGame > 0 ? (totalWordsInGame - remainingWords.length) / totalWordsInGame : 0;
    const adjustmentSteps = Math.floor(progressPercent / 0.1);
    spawnInterval *= (1 - adjustmentSteps * GAME_CONFIG.PROGRESS_ADJUSTMENT.INTERVAL_REDUCTION_PER_10_PERCENT);
    fallDuration *= (1 - adjustmentSteps * GAME_CONFIG.PROGRESS_ADJUSTMENT.DURATION_REDUCTION_PER_10_PERCENT);
    if (comboCount >= GAME_CONFIG.COMBO_TIERS[1]) spawnInterval *= 0.85;
    else if (comboCount >= GAME_CONFIG.COMBO_TIERS[0]) spawnInterval *= 0.95;
    spawnInterval = Math.max(spawnInterval, GAME_CONFIG.MIN_SPAWN_INTERVAL);
    fallDuration = Math.max(fallDuration, GAME_CONFIG.MIN_FALL_DURATION);
    return { spawnInterval, fallDuration, maxWords, hintEnabled: baseSettings.hintEnabled };
}

function gameLoop(timestamp) {
    if (isPaused) { lastFrameTime = timestamp; gameInterval = requestAnimationFrame(gameLoop); return; }
    if (!lastFrameTime) lastFrameTime = timestamp;
    if (gameContainer && fallingWords.length === 0 && remainingWords.length > 0 && Date.now() - lastWordTime > getGameParams().spawnInterval * 1.5) {
        console.log("应急生成单词 (无下落单词)"); startFallingWord();
    }
    lastFrameTime = timestamp; gameInterval = requestAnimationFrame(gameLoop);
}

function startFallingWord() {
    if (isPaused || remainingWords.length === 0) {
        if (remainingWords.length === 0 && fallingWords.length === 0) endGame(true);
        return;
    }
    const params = getGameParams();
    if (fallingWords.length >= params.maxWords) return;
    const availableWords = remainingWords.filter(w => !fallingWords.some(fw => fw.english === w.english));
    if (availableWords.length === 0) return;
    const wordData = availableWords[Math.floor(Math.random() * availableWords.length)];
    const wordElement = wordPool.get('word', 'falling-word');
    wordElement.textContent = wordData.chinese;
    let leftPosition, attempts = 0;
    const wordElementWidthClient = wordElement.offsetWidth || (gameContainer.clientWidth * 0.1);
    const wordElementWidthPercent = (wordElementWidthClient / gameContainer.clientWidth * 100);
    const MIN_HORIZONTAL_DISTANCE = wordElementWidthClient > 0 ? wordElementWidthClient * 1.2 : 100;
    do {
        leftPosition = Math.random() * (100 - wordElementWidthPercent) + (wordElementWidthPercent / 2) ;
        leftPosition = Math.max(wordElementWidthPercent / 2, Math.min(100 - wordElementWidthPercent / 2, leftPosition));
        attempts++; if (attempts > 20) break;
    } while (isOverlapping(leftPosition, MIN_HORIZONTAL_DISTANCE));
    wordElement.style.left = `${leftPosition}%`;
    wordElement.style.animationDuration = `${params.fallDuration}s`;
    wordElement.style.animationPlayState = 'running';
    let tooltipTimeoutId = null;
    if (params.hintEnabled) {
        const showHandler = (e) => showTooltip(e, wordData, wordElement);
        const touchHandler = (e) => { e.preventDefault(); showTooltip(e, wordData, wordElement); };
        wordElement.addEventListener('mouseenter', showHandler);
        wordElement.addEventListener('touchstart', touchHandler, { passive: false });
        wordElement._showHandler = showHandler; wordElement._touchHandler = touchHandler;
    }
    const fallingWord = { element: wordElement, chinese: wordData.chinese, english: wordData.english, startTime: Date.now(), missed: false, tooltipTimeoutId: tooltipTimeoutId };
    fallingWords.push(fallingWord);
    if (gameContainer) gameContainer.appendChild(wordElement);
    wordElement.addEventListener('animationend', () => handleWordEnd(fallingWord), { once: true });
    lastWordTime = Date.now();
}

function showTooltip(event, wordData, wordElement) {
    if (wordElement.querySelector('.word-tooltip') || isPaused) return;
    const tooltip = wordPool.get('tooltip', 'word-tooltip');
    tooltip.textContent = `提示: ${wordData.english[0].toUpperCase()}...`;
    wordElement.appendChild(tooltip);
    const existingFallingWord = fallingWords.find(fw => fw.element === wordElement);
    if (existingFallingWord && existingFallingWord.tooltipTimeoutId) clearTimeout(existingFallingWord.tooltipTimeoutId);
    const removeTooltipFunc = () => {
        if (tooltip.parentElement) wordPool.release('tooltip', tooltip);
        wordElement.removeEventListener('mouseleave', removeTooltipFunc);
        wordElement.removeEventListener('touchend', removeTooltipFunc);
    };
    wordElement.addEventListener('mouseleave', removeTooltipFunc, { once: true });
    wordElement.addEventListener('touchend', removeTooltipFunc, { once: true });
    if (existingFallingWord) {
        existingFallingWord.tooltipTimeoutId = setTimeout(() => { if (tooltip.parentElement) wordPool.release('tooltip', tooltip); }, 3000);
    }
}

function isOverlapping(newLeft, minDistance) {
    if (!gameContainer) return false;
    const minDistancePercent = (minDistance / gameContainer.clientWidth * 100);
    return fallingWords.some(fw => {
        if (!fw.element || !fw.element.style.left) return false;
        const existingLeft = parseFloat(fw.element.style.left);
        return Math.abs(existingLeft - newLeft) < minDistancePercent;
    });
}

function handleWordEnd(fallingWordObj) {
    if (!fallingWordObj || !fallingWordObj.element || fallingWordObj.element.style.opacity === '0') {
        const fIndex = fallingWords.indexOf(fallingWordObj); if (fIndex > -1) fallingWords.splice(fIndex, 1); return;
    }
    if (!fallingWordObj.missed) {
        fallingWordObj.missed = true; playSound('wordMissed');
        score = Math.max(0, score - (pointPerWord * GAME_CONFIG.POINTS_LOST_PER_MISS_FACTOR));
        comboCount = 0; comboMultiplier = 1;
        updateScoreDisplay(); updateWordProgressDisplay();
        const currentWordData = window.wordList.find(w => w.english === fallingWordObj.english);
        if (currentWordData) {
            const count = (wrongWordsMap.get(currentWordData.english) || 0) + 1;
            wrongWordsMap.set(currentWordData.english, count);
            if (count >= GAME_CONFIG.MISTAKE_THRESHOLD && !window.mistakeBook.some(w => w.english === currentWordData.english)) {
                window.mistakeBook.push(currentWordData);
                showFeedback(`“${currentWordData.english}”已加入错题本!`, 'warning', 1500);
                saveMistakeBook();
            }
        }
        if (fallingWordObj.element) {
            fallingWordObj.element.classList.add('missed-word');
            fallingWordObj.element.style.transition = 'opacity 0.5s ease';
            fallingWordObj.element.style.opacity = '0';
            setTimeout(() => releaseFallingWordElement(fallingWordObj), 500);
        } else { const fIndex = fallingWords.indexOf(fallingWordObj); if (fIndex > -1) fallingWords.splice(fIndex, 1); }
        if (score <= 0) { endGame(false); return; }
    } else if (fallingWordObj.missed && fallingWordObj.element) { releaseFallingWordElement(fallingWordObj); }
    if (remainingWords.length === 0 && fallingWords.filter(fw => fw.element && fw.element.style.opacity !== '0').length === 0) endGame(true);
}

function releaseFallingWordElement(fallingWordObj) {
    if (fallingWordObj.element) {
        if (fallingWordObj.element._showHandler) fallingWordObj.element.removeEventListener('mouseenter', fallingWordObj.element._showHandler);
        if (fallingWordObj.element._touchHandler) fallingWordObj.element.removeEventListener('touchstart', fallingWordObj.element._touchHandler);
        wordPool.release('word', fallingWordObj.element);
        fallingWordObj.element = null;
    }
    if (fallingWordObj.tooltipTimeoutId) clearTimeout(fallingWordObj.tooltipTimeoutId);
    const index = fallingWords.indexOf(fallingWordObj); if (index > -1) fallingWords.splice(index, 1);
}

function checkInput() {
    if (!answerInput) return false;
    const userAnswer = answerInput.value.trim().toLowerCase();
    if (!userAnswer || isPaused) return false;
    const now = Date.now(); if (now - lastInputTime < GAME_CONFIG.INPUT_DEBOUNCE_MS) return false;
    lastInputTime = now;
    const matchedWordObj = fallingWords.find(fw => fw.english.toLowerCase() === userAnswer && fw.element && fw.element.style.opacity !== '0');
    if (matchedWordObj) { processCorrectAnswer(matchedWordObj); answerInput.value = ''; return true; }
    return false;
}

function checkAnswer() {
    if (isPaused || !answerInput) return;
    const userAnswer = answerInput.value.trim().toLowerCase();
    if (!userAnswer) return;
    const matchedWordObj = fallingWords.find(fw => fw.english.toLowerCase() === userAnswer && fw.element && fw.element.style.opacity !== '0');
    if (matchedWordObj) { processCorrectAnswer(matchedWordObj); }
    else {
        playSound('incorrect');
        score = Math.max(0, score - (pointPerWord * GAME_CONFIG.POINTS_LOST_PER_MISS_FACTOR * 0.5 || 1));
        comboCount = 0; comboMultiplier = 1; updateScoreDisplay();
        showFeedback('✗ 答案错误!', 'error', 1000);
        answerInput.style.animation = 'shake 0.5s';
        setTimeout(() => { if(answerInput) answerInput.style.animation = ''; }, 500);
        if (score <= 0) endGame(false);
    }
    answerInput.value = '';
}
window.checkAnswer = checkAnswer;

function processCorrectAnswer(matchedWordObj) {
    playSound('correct'); comboCount++; let currentTier = 0;
    for (let i = 0; i < GAME_CONFIG.COMBO_TIERS.length; i++) {
        if (comboCount >= GAME_CONFIG.COMBO_TIERS[i]) currentTier = i + 1; else break;
    }
    comboMultiplier = 1 + (currentTier * GAME_CONFIG.COMBO_SCORE_MULTIPLIER_STEP);
    if (GAME_CONFIG.COMBO_TIERS.includes(comboCount)) {
        showComboEffect(comboCount); playSound('combo');
        showFeedback(`${comboCount}连击! +${((comboMultiplier - 1) * 100).toFixed(0)}% 得分!`, 'correct', 1200);
    }
    score = Math.min(GAME_CONFIG.MAX_SCORE, score + (pointPerWord * comboMultiplier));
    updateScoreDisplay(); createParticles(matchedWordObj.element);
    if (matchedWordObj.element) {
        matchedWordObj.element.style.animation = 'none';
        matchedWordObj.element.style.transition = 'transform 0.3s ease-out, opacity 0.3s ease-out';
        matchedWordObj.element.style.transform = `${matchedWordObj.element.style.transform || 'translateX(-50%)'} scale(1.3)`;
        matchedWordObj.element.style.opacity = '0';
    }
    const remainingIndex = remainingWords.findIndex(w => w.english === matchedWordObj.english);
    if (remainingIndex > -1) remainingWords.splice(remainingIndex, 1);
    setTimeout(() => releaseFallingWordElement(matchedWordObj), 300);
    updateWordProgressDisplay();
    if (remainingWords.length === 0 && fallingWords.filter(fw => fw.element && fw.element.style.opacity !== '0').length === 0) {
        setTimeout(() => { if (fallingWords.filter(fw => fw.element && fw.element.style.opacity !== '0').length === 0) endGame(true); }, 350);
    }
}

function showComboEffect(count) {
    if (!gameContainer) return;
    const effect = wordPool.get('combo', 'combo-effect');
    effect.textContent = `${count} COMBO!`;
    const gameRect = gameContainer.getBoundingClientRect();
    effect.style.left = `${Math.random() * (gameRect.width - (effect.offsetWidth > 0 ? effect.offsetWidth : 100) - 20) + 10}px`;
    effect.style.top = `${Math.random() * (gameRect.height * 0.6) + (gameRect.height * 0.1)}px`;
    gameContainer.appendChild(effect);
    setTimeout(() => wordPool.release('combo', effect), 1000);
}

function createParticles(wordElement) {
    if (!wordElement || !gameContainer) return;
    const rect = wordElement.getBoundingClientRect();
    const containerRect = gameContainer.getBoundingClientRect();
    const x = rect.left - containerRect.left + rect.width / 2;
    const y = rect.top - containerRect.top + rect.height / 2;
    for (let i = 0; i < GAME_CONFIG.PARTICLE_COUNT; i++) {
        const particle = wordPool.get('particle', 'particle');
        particle.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--success-color');
        particle.style.left = `${x}px`; particle.style.top = `${y}px`;
        const angle = Math.random() * Math.PI * 2; const distance = Math.random() * 60 + 40;
        const tx = Math.cos(angle) * distance; const ty = Math.sin(angle) * distance;
        particle.style.setProperty('--tx', `${tx}px`); particle.style.setProperty('--ty', `${ty}px`);
        gameContainer.appendChild(particle);
        setTimeout(() => wordPool.release('particle', particle), 1000);
    }
}

function updateScoreDisplay() {
    if (scoreDisplay) scoreDisplay.textContent = `⭐ 分数: ${score.toFixed(0)}`;
    const percent = score / GAME_CONFIG.MAX_SCORE;
    if (scoreDisplay) {
        if (percent > 0.7) scoreDisplay.style.color = 'var(--success-color)';
        else if (percent > 0.4) scoreDisplay.style.color = 'var(--accent-color)';
        else scoreDisplay.style.color = 'var(--error-color)';
    }
}

function updateWordProgressDisplay() {
    if (gameProgressDisplay) {
        const total = window.wordList.length;
        const completed = total - remainingWords.length;
        gameProgressDisplay.textContent = `📊 进度: ${completed}/${total}`;
    }
}

function endGame(isWin) {
    isPaused = true; cancelAnimationFrame(gameInterval); clearInterval(wordGenerationInterval);
    if (answerInput) answerInput.disabled = true;
    fallingWords.forEach(fw => {
        if (fw.element) {
            fw.element.style.animationPlayState = 'paused';
            fw.element.style.transition = 'opacity 0.5s ease';
            fw.element.style.opacity = '0';
            setTimeout(() => releaseFallingWordElement(fw), 500);
        }
    });
    setTimeout(() => fallingWords = [], 600);
    if (isWin) { playSound('gameover'); showFeedback(`🎉 胜利! 最终分数: ${score.toFixed(0)}`, 'correct', 3000); }
    else { playSound('gameover'); showFeedback(`💥 游戏结束! 分数: ${score.toFixed(0)}`, 'error', 3000); }
    setTimeout(() => { resetGameUI(); showMainPanel(); }, 3000);
}

function resetGameUI() {
    if (gameInterface) gameInterface.style.display = 'none';
    if (pauseOverlay) pauseOverlay.style.display = 'none';
    if (answerInput) { answerInput.value = ''; answerInput.disabled = true; }
}

function togglePauseGame() {
    isPaused = !isPaused;
    if (isPaused) {
        cancelAnimationFrame(gameInterval); clearInterval(wordGenerationInterval);
        fallingWords.forEach(fw => { if (fw.element) fw.element.style.animationPlayState = 'paused'; });
        if (answerInput) answerInput.disabled = true;
        if (pauseButton) { pauseButton.textContent = '▶️ 继续'; pauseButton.setAttribute('aria-label', '继续游戏'); }
        if(pauseOverlay) pauseOverlay.style.display = 'flex';
        showFeedback('❚❚ 已暂停', 'info', 1000);
    } else {
        lastFrameTime = performance.now(); gameInterval = requestAnimationFrame(gameLoop);
        const params = getGameParams();
        wordGenerationInterval = setInterval(startFallingWord, params.spawnInterval);
        fallingWords.forEach(fw => { if (fw.element) fw.element.style.animationPlayState = 'running'; });
        if (answerInput) { answerInput.disabled = false; answerInput.focus(); }
        if (pauseButton) { pauseButton.textContent = '❚❚ 暂停'; pauseButton.setAttribute('aria-label', '暂停游戏'); }
        if(pauseOverlay) pauseOverlay.style.display = 'none';
    }
}
window.togglePauseGame = togglePauseGame;

// --- 错题本 ---
function saveMistakeBook() {
    try { localStorage.setItem('mistakeBook', JSON.stringify(window.mistakeBook)); }
    catch (e) { console.error("无法保存错题本:", e); showFeedback("无法保存错题本", "error", 2500); }
}
window.saveMistakeBook = saveMistakeBook;

function loadMistakeBook() {
    try {
        const data = localStorage.getItem('mistakeBook');
        if (data) window.mistakeBook = JSON.parse(data); else window.mistakeBook = [];
    } catch (e) { console.error("无法加载错题本:", e); window.mistakeBook = []; }
}

function showMistakeBook() {
    if (!mistakeListDiv || !mistakeModal) return;
    mistakeListDiv.innerHTML = '';
    if (window.mistakeBook.length === 0) {
        mistakeListDiv.innerHTML = '<p style="text-align:center; color: var(--dark-color);">错题本是空的！</p>';
    } else {
        window.mistakeBook.forEach(word => {
            const item = document.createElement('div'); item.className = 'mistake-item';
            item.innerHTML = `<span class="word">${word.english}</span><span class="meaning">${word.chinese}</span>`;
            mistakeListDiv.appendChild(item);
        });
    }
    mistakeModal.style.display = 'flex';
    setTimeout(() => mistakeModal.classList.add('active'), 10);
}
window.showMistakeBook = showMistakeBook;

function practiceMistakes() {
    if (window.mistakeBook.length === 0) { showFeedback('错题本是空的，无法练习!', 'warning', 1500); return; }
    window.wordList = [...window.mistakeBook];
    if (window.wordList.length > 0) {
        window.currentWordSourceType = 'mistakeBook';
        closeModal('mistake-modal');
        prepareGameStart(window.wordList.length); // Will show feedback by default
        wrongWordsMap.clear();
    }
}
window.practiceMistakes = practiceMistakes;

function clearMistakeBook() {
    if (window.mistakeBook.length === 0) { showFeedback('错题本已经是空的了。', 'info', 1500); return; }
    const confirmClear = confirm("确定要清空所有错题记录吗？");
    if (confirmClear) {
        window.mistakeBook = []; wrongWordsMap.clear(); saveMistakeBook();
        showFeedback('错题本已清空!', 'correct', 1500);
        if (mistakeModal && mistakeModal.classList.contains('active')) showMistakeBook();
    }
}
window.clearMistakeBook = clearMistakeBook;

// --- 反馈信息 ---
let feedbackTimeout;
function showFeedback(message, type = 'info', duration = 1500) {
    if (!feedbackElement) return;
    clearTimeout(feedbackTimeout);
    feedbackElement.innerHTML = `
        <div class="feedback-icon">${type === 'correct' ? '🎉' : (type === 'error' ? '💥' : (type === 'warning' ? '🤔' : 'ℹ️'))}</div>
        <div class="feedback-text">${message}</div>`;
    feedbackElement.className = `feedback ${type}`;
    feedbackElement.style.opacity = '0'; feedbackElement.style.transform = 'translate(-50%, -50%) scale(0.7)';
    requestAnimationFrame(() => {
        feedbackElement.style.opacity = '1'; feedbackElement.style.transform = 'translate(-50%, -50%) scale(1)';
    });
    feedbackTimeout = setTimeout(() => {
        feedbackElement.style.opacity = '0'; feedbackElement.style.transform = 'translate(-50%, -50%) scale(0.7)';
    }, duration);
}
window.showFeedback = showFeedback;

// --- 工具 / 默认数据 ---
const DEFAULT_WORDS = [
    { english: "apple", chinese: "苹果" }, { english: "banana", chinese: "香蕉" },
    { english: "cat", chinese: "猫" }, { english: "dog", chinese: "狗" },
    { english: "sun", chinese: "太阳" }, { english: "moon", chinese: "月亮" },
    { english: "tree", chinese: "树" }, { english: "book", chinese: "书" },
    { english: "water", chinese: "水" }, { english: "happy", chinese: "开心" }
];

// --- WebDAV 同步逻辑现在位于 webdav-sync.js ---