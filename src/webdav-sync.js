// --- WebDAV DOM 元素 ---
// These will be initialized in WebDAVModule.initDOMElements
let webDAVSettingsModal, webdavUrlInput, webdavUsernameInput, webdavPasswordInput, webdavPathInput, webdavStatusDiv;

// --- WebDAV 数据 ---
let webDAVSettings = {}; // Stores WebDAV configuration
let selectedBackupFile = null; // Stores the currently selected backup filename in the list

// --- Helper Functions for Manual WebDAV ---

/**
 * Constructs the full WebDAV URL for an item.
 * @param {string} fullItemRelativePath - The FULL relative path of the item (file or directory)
 * from the baseUrl. E.g., "w12" or "w12/backup.json".
 * This path should ALREADY include any user-defined base remote path.
 * @returns {string} The full URL for the WebDAV operation.
 * @throws {Error} If WebDAV base URL is not configured.
 */
function _getWebDAVUrl(fullItemRelativePath = "") {
    if (!webDAVSettings.url) {
        console.error("[DAV] WebDAV base URL is not configured.");
        throw new Error("WebDAV URL is not configured.");
    }

    let baseUrl = webDAVSettings.url; // e.g., "https://example.com/dav"
    if (!baseUrl.endsWith('/')) {
        baseUrl += '/'; // Ensures "https://example.com/dav/"
    }

    const normalizedFullItemPath = (fullItemRelativePath || "").trim().replace(/^\/+|\/+$/g, '');

    return baseUrl + normalizedFullItemPath;
}

/**
 * Gets the Basic Authentication header.
 * @returns {Headers} The Headers object with Authorization if username is set.
 */
function _getAuthHeaders() {
    const headers = new Headers();
    if (webDAVSettings.username) {
        const credentials = btoa(`${webDAVSettings.username}:${webDAVSettings.password || ''}`);
        headers.append('Authorization', `Basic ${credentials}`);
    }
    return headers;
}

/**
 * Parses WebDAV PROPFIND XML response for directory listing.
 * @param {string} xmlString - The XML response string.
 * @param {string} propfindRequestUrl - The URL on which PROPFIND was executed (the directory's URL).
 * @returns {Array<Object>} Array of file/collection objects.
 */
function _parsePropfindXML(xmlString, propfindRequestUrl) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, "application/xml");
    const responses = xmlDoc.getElementsByTagNameNS("DAV:", "response");
    const items = [];

    const baseListedUrl = propfindRequestUrl.endsWith('/') ? propfindRequestUrl : propfindRequestUrl + '/';

    for (const responseNode of responses) {
        const hrefElement = responseNode.getElementsByTagNameNS("DAV:", "href")[0];
        if (!hrefElement) continue;

        let href = (hrefElement.textContent || hrefElement.innerText || "").trim();
        try {
            href = new URL(decodeURIComponent(href.split('?')[0].split('#')[0]), baseListedUrl).href;
        } catch (e) {
            console.warn(`[DAV] Could not parse href: ${href}`, e);
            continue;
        }

        if (href === baseListedUrl || href === baseListedUrl.slice(0, -1)) {
            continue;
        }

        let basename;
        if (href.startsWith(baseListedUrl)) {
            basename = href.substring(baseListedUrl.length).replace(/\/$/, '');
        } else {
            basename = href.split('/').filter(s => s).pop() || "";
        }

        if (!basename) continue;

        let itemType = "file";
        let lastmod = "";
        let size = 0;
        const propstatElements = responseNode.getElementsByTagNameNS("DAV:", "propstat");

        for (const propstat of propstatElements) {
            const statusElement = propstat.getElementsByTagNameNS("DAV:", "status")[0];
            if (statusElement && statusElement.textContent && statusElement.textContent.includes("200 OK")) {
                const prop = propstat.getElementsByTagNameNS("DAV:", "prop")[0];
                if (prop) {
                    const resourceTypeNode = prop.getElementsByTagNameNS("DAV:", "resourcetype")[0];
                    if (resourceTypeNode && resourceTypeNode.getElementsByTagNameNS("DAV:", "collection")[0]) {
                        itemType = "collection";
                    }
                    const getLastmodElement = prop.getElementsByTagNameNS("DAV:", "getlastmodified")[0];
                    if (getLastmodElement) lastmod = getLastmodElement.textContent || "";
                    const getContentLengthElement = prop.getElementsByTagNameNS("DAV:", "getcontentlength")[0];
                    if (getContentLengthElement && itemType === "file") {
                        size = parseInt(getContentLengthElement.textContent || "0", 10);
                    }
                }
            }
        }
        items.push({ basename, type: itemType, lastmod, size });
    }
    return items;
}


// --- Core Manual WebDAV Operations ---
async function _davRequest(method, fullItemRelativePath, options = {}) {
    let url = _getWebDAVUrl(fullItemRelativePath);

    if ((method === 'PROPFIND' || method === 'MKCOL') && options.isDirectory && !url.endsWith('/')) {
        url += '/';
    }

    const headers = _getAuthHeaders();
    if (options.headers) {
        for (const [key, value] of Object.entries(options.headers)) {
            headers.append(key, value);
        }
    }

    if (method === 'PUT' || method === 'PROPFIND') {
        if (options.body && !headers.has('Content-Type')) {
            headers.append('Content-Type', method === 'PROPFIND' ? 'application/xml' : 'application/octet-stream');
        }
    } else if (method === 'MKCOL') {
        if (!options.body && !headers.has('Content-Length')) {
            headers.append('Content-Length', '0');
        }
    }

    console.log(`[DAV] Request: ${method} ${url}`, options.body ? `Body type: ${typeof options.body}, Length: ${options.body ? (options.body.length || options.body.size || 'N/A') : 'N/A'}`: "No body", "Headers:", Object.fromEntries(headers.entries()));

    try {
        const fetchOptions = {
            method: method,
            headers: headers,
        };
        if (options.body) {
            fetchOptions.body = options.body;
        }

        const response = await fetch(url, fetchOptions);

        const successStatus = {
            'GET': [200],
            'PUT': [200, 201, 204],
            'DELETE': [200, 202, 204],
            'MKCOL': [201],
            'PROPFIND': [207]
        };

        if (successStatus[method] && successStatus[method].includes(response.status)) {
            console.log(`[DAV] ${method} ${url} - Success (${response.status})`);
            return response;
        }

        if (method === 'MKCOL' && response.status === 405) {
            console.warn(`[DAV] MKCOL on ${url} returned 405 (Method Not Allowed). This might mean it already exists or is not a valid collection name here.`);
            return response;
        }
        if (method === 'MKCOL' && response.status === 409) {
            console.warn(`[DAV] MKCOL on ${url} returned 409 (Conflict). This often means a parent path does not exist or name collision.`);
        }

        const errorDetails = {
            status: response.status,
            statusText: response.statusText,
            url: response.url,
            method: method,
            message: `WebDAV request ${method} ${url} failed with status ${response.status} ${response.statusText}.`
        };
        try {
            errorDetails.responseText = await response.text();
            errorDetails.message += `\nResponse Body: ${errorDetails.responseText.substring(0, 500)}`;
        } catch (e) { /* ignore */ }
        console.error(`[DAV] HTTP Error:`, errorDetails);
        throw errorDetails;

    } catch (error) {
        if (error.status !== undefined) {
            throw error;
        }
        console.error(`[DAV] Network or fetch setup error for ${method} ${url}:`, error);
        const errToThrow = {
            message: `Network or setup error during ${method} for ${url}: ${error.message || String(error)} (Original error: ${String(error)})`,
            status: 0,
            method: method,
            url: url,
            originalError: error
        };
        throw errToThrow;
    }
}

async function createDirectoryRecursive(dirFullPathToCreate) {
    if (!dirFullPathToCreate) {
        console.log("[DAV] createDirectoryRecursive: No specific directory path to create (path is likely root). Skipping.");
        return;
    }

    const parts = dirFullPathToCreate.replace(/^\/+|\/+$/g, '').split('/');
    let currentPathSegment = "";

    console.log(`[DAV] createDirectoryRecursive: Ensuring directory '${dirFullPathToCreate}'`);

    for (const part of parts) {
        if (!part) continue;
        currentPathSegment = currentPathSegment ? `${currentPathSegment}/${part}` : part;

        console.log(`[DAV] createDirectoryRecursive: Checking/Creating part '${currentPathSegment}'`);
        try {
            const propfindResponse = await _davRequest('PROPFIND', currentPathSegment, {
                headers: { 'Depth': '0' },
                isDirectory: true
            });
            const xmlText = await propfindResponse.text();
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(xmlText, "application/xml");
            const resourceTypeNode = xmlDoc.querySelector("response > propstat > prop > resourcetype");
            const isCollection = resourceTypeNode && resourceTypeNode.querySelector("collection") !== null;

            if (isCollection) {
                console.log(`[DAV] createDirectoryRecursive: Path '${currentPathSegment}' already exists as a collection.`);
                continue;
            } else {
                const errorMsg = `[DAV] createDirectoryRecursive: Path '${currentPathSegment}' exists but is NOT a collection. Cannot proceed. XML: ${xmlText.substring(0,300)}`;
                console.error(errorMsg);
                throw { status: 409, message: errorMsg, part: currentPathSegment };
            }
        } catch (error) {
            if (error.status === 404) {
                console.log(`[DAV] createDirectoryRecursive: Path '${currentPathSegment}' not found (PROPFIND 404). Attempting MKCOL.`);
                try {
                    const mkcolResponse = await _davRequest('MKCOL', currentPathSegment, { isDirectory: true });

                    if (mkcolResponse.status === 201) {
                        console.log(`[DAV] createDirectoryRecursive: Successfully created directory '${currentPathSegment}' (MKCOL 201).`);
                    } else if (mkcolResponse.status === 405) {
                        console.warn(`[DAV] createDirectoryRecursive: MKCOL for '${currentPathSegment}' returned 405. Re-checking with PROPFIND.`);
                        try {
                            const recheckResponse = await _davRequest('PROPFIND', currentPathSegment, { headers: { 'Depth': '0' }, isDirectory: true });
                            const xmlText = await recheckResponse.text();
                            const parser = new DOMParser();
                            const xmlDoc = parser.parseFromString(xmlText, "application/xml");
                            const resourceTypeNode = xmlDoc.querySelector("response > propstat > prop > resourcetype");
                            if (resourceTypeNode && resourceTypeNode.querySelector("collection")) {
                                console.log(`[DAV] createDirectoryRecursive: Path '${currentPathSegment}' confirmed as collection after MKCOL 405.`);
                            } else {
                                const errorMsg = `[DAV] createDirectoryRecursive: Path '${currentPathSegment}' exists (after MKCOL 405) but is NOT a collection. XML: ${xmlText.substring(0,300)}`;
                                console.error(errorMsg);
                                throw { status: 409, message: errorMsg, part: currentPathSegment };
                            }
                        } catch (recheckError) {
                             const errorMsg = `[DAV] createDirectoryRecursive: Failed to re-check path '${currentPathSegment}' with PROPFIND after MKCOL 405. Error: ${recheckError.message}`;
                             console.error(errorMsg, recheckError);
                             throw { status: recheckError.status || 500, message: errorMsg, part: currentPathSegment, originalError: recheckError };
                        }
                    } else {
                        const responseText = await mkcolResponse.text().catch(()=>"");
                        const errorMsg = `[DAV] createDirectoryRecursive: MKCOL for '${currentPathSegment}' failed with status ${mkcolResponse.status}. Response: ${responseText}`;
                        console.error(errorMsg);
                        throw { status: mkcolResponse.status, message: errorMsg, part: currentPathSegment };
                    }
                } catch (mkcolError) {
                    console.error(`[DAV] createDirectoryRecursive: Exception during MKCOL for '${currentPathSegment}'.`, mkcolError);
                    throw mkcolError;
                }
            } else {
                console.error(`[DAV] createDirectoryRecursive: Error during PROPFIND for '${currentPathSegment}'. Status: ${error.status}`, error);
                throw error;
            }
        }
    }
    console.log(`[DAV] createDirectoryRecursive: Successfully ensured directory structure for '${dirFullPathToCreate}'`);
}

// --- Updated WebDAV Functions (using manual DAV operations) ---

function loadWebDAVSettings() {
    try {
        const settings = localStorage.getItem('webDAVSettings');
        if (settings) {
            webDAVSettings = JSON.parse(settings);
            console.log('[DAV] Stored WebDAV settings loaded:', webDAVSettings);
        } else {
            webDAVSettings = {};
            console.log('[DAV] No stored WebDAV settings found.');
        }
    } catch (e) {
        console.error('[DAV] Failed to load WebDAV settings from localStorage:', e);
        webDAVSettings = {};
    }
}

function saveWebDAVSettings() {
    if (!webdavUrlInput || !webdavUsernameInput || !webdavPasswordInput || !webdavPathInput || !webdavStatusDiv) {
        console.error("WebDAV DOM elements not initialized for saveWebDAVSettings");
        return;
    }
    webDAVSettings.url = webdavUrlInput.value.trim();
    webDAVSettings.username = webdavUsernameInput.value.trim();
    webDAVSettings.password = webdavPasswordInput.value;
    webDAVSettings.path = webdavPathInput.value.trim().replace(/^\/+|\/+$/g, '');

    if (!webDAVSettings.url) {
        if (typeof window.showFeedback === 'function') window.showFeedback('服务器 URL 不能为空!', 'error');
        webdavStatusDiv.textContent = '错误: 服务器 URL 不能为空!';
        webdavStatusDiv.className = 'error';
        return;
    }
    try {
        new URL(webDAVSettings.url);
    } catch (_) {
        if (typeof window.showFeedback === 'function') window.showFeedback('服务器 URL 格式不正确!', 'error');
        webdavStatusDiv.textContent = '错误: 服务器 URL 格式不正确! 请确保包含 http:// 或 https://';
        webdavStatusDiv.className = 'error';
        return;
    }

    try {
        localStorage.setItem('webDAVSettings', JSON.stringify(webDAVSettings));
        if (typeof window.showFeedback === 'function') window.showFeedback('WebDAV 设置已保存!', 'correct');
        webdavStatusDiv.textContent = '设置已保存! 您可以测试连接或管理备份。';
        webdavStatusDiv.className = 'success';
        const backupListContainer = document.getElementById('webdav-backup-list');
        if (backupListContainer) backupListContainer.innerHTML = '<p>设置已更新。请测试连接以刷新备份列表。</p>';
         selectedBackupFile = null;
        const restoreButton = document.getElementById('webdav-restore-button');
        const deleteBackupButton = document.getElementById('webdav-delete-backup-button');
        if (restoreButton) restoreButton.disabled = true;
        if (deleteBackupButton) deleteBackupButton.disabled = true;
    } catch (e) {
        console.error('[DAV] Failed to save WebDAV settings to localStorage:', e);
        if (typeof window.showFeedback === 'function') window.showFeedback('无法保存 WebDAV 设置!', 'error');
        webdavStatusDiv.textContent = '错误: 无法保存设置!';
        webdavStatusDiv.className = 'error';
    }
}

async function testWebDAVConnection() {
    if (!webDAVSettings.url) {
        if (typeof window.showFeedback === 'function') window.showFeedback('请先正确配置并保存 WebDAV 设置!', 'error');
        if(webdavStatusDiv) { webdavStatusDiv.innerHTML = '错误: WebDAV URL 未配置。'; webdavStatusDiv.className = 'error';}
        return;
    }
    if(!webdavStatusDiv) return;

    webdavStatusDiv.textContent = '🧪 测试连接中...';
    webdavStatusDiv.className = 'info';
    if (typeof window.showFeedback === 'function') window.showFeedback('🧪 测试连接...', 'info', 1500);

    const pathToTest = (webDAVSettings.path || "").trim().replace(/^\/+|\/+$/g, '');

    try {
        console.log(`[DAV] Testing connection by PROPFIND on: '${_getWebDAVUrl(pathToTest)}' (derived from settings path: '${pathToTest}')`);
        await _davRequest('PROPFIND', pathToTest, { headers: { 'Depth': '1' }, isDirectory: true });

        webdavStatusDiv.textContent = '✅ 连接成功!';
        webdavStatusDiv.className = 'success';
        if (typeof window.showFeedback === 'function') window.showFeedback('✅ WebDAV 连接测试成功!', 'correct', 2000);
        listAndDisplayBackups();
    } catch (error) {
        console.error('[DAV] 测试连接失败:', error);
        let userMessage = `连接测试失败: ${error.message || '未知错误'}`;
        let technicalDetails = ` (Status: ${error.status || 'N/A'}, Method: ${error.method || 'N/A'}, URL: ${error.url || 'N/A'})`;

        if (error.status === 401) userMessage = 'WebDAV 认证失败 (401)。请仔细检查用户名和密码。';
        else if (error.status === 404) userMessage = `远程路径 "${pathToTest || '(根目录)'}" 未找到 (404)。请检查服务器URL和远程路径设置。如果目录是新设置的，这可能是正常的，尝试“创建备份”来创建它。`;
        else if (error.status === 403) userMessage = '禁止访问 WebDAV 资源 (403)。请检查账户权限及服务器配置。';
        else if (String(error.message).toLowerCase().includes("networkerror") ||
                   String(error.message).toLowerCase().includes("failed to fetch") ||
                   error.status === 0 || !error.status ) {
             userMessage = '网络请求失败。可能原因：<br>' +
                          '1. WebDAV 服务器地址 (<code>' + (webDAVSettings.url || '未配置') + '</code>) 不可达或错误 (需包含<code>http(s)://</code>)。<br>' +
                          '2. 网络连接问题 (防火墙、代理)。<br>' +
                          '3. <b>CORS 策略问题:</b> 服务器未正确配置CORS以允许来自 <code>' + window.location.origin + '</code> 的请求。<br>' +
                          '4. SSL证书问题 (如果使用HTTPS)。<br>' +
                          '请检查浏览器开发者控制台的“网络(Network)”和“控制台(Console)”选项卡获取详细信息。';
            technicalDetails = '';
        }
        webdavStatusDiv.innerHTML = `❌ 连接测试失败:<br>${userMessage}${technicalDetails}`;
        webdavStatusDiv.className = 'error';
        if (typeof window.showFeedback === 'function') window.showFeedback(`❌ ${userMessage.split('<br>')[0]}`, 'error', 7000);
    }
}

async function uploadProgressToWebDAV() {
    const { mistakeBook, wordList, currentWordSourceType, GAME_CONFIG, showFeedback: appShowFeedback } = window;
    if (!mistakeBook || !wordList || !currentWordSourceType || !GAME_CONFIG) {
        console.error("Global game data not available for WebDAV upload.");
        if (typeof appShowFeedback === 'function') appShowFeedback("无法访问游戏数据进行备份。", "error");
        return false;
    }

    const syncMistakeBookCheckbox = document.getElementById('sync-mistake-book-checkbox');
    const syncUserWordsCheckbox = document.getElementById('sync-user-words-checkbox');
    const syncMistakeBook = syncMistakeBookCheckbox?.checked;
    const syncUserWords = syncUserWordsCheckbox?.checked;

    const progressData = {
        lastSyncTimestamp: new Date().toISOString(),
        options: { mistakeBookSynced: syncMistakeBook, userWordsSynced: syncUserWords }
    };
    if (syncMistakeBook) progressData.mistakeBook = mistakeBook;
    if (syncUserWords && (currentWordSourceType === 'file' || currentWordSourceType === 'webdav_import')) {
        progressData.userWords = wordList;
    } else {
        progressData.userWords = null;
        if (syncUserWords) {
            console.warn("[DAV] User words sync was checked, but currentWordSourceType is not 'file' or 'webdav_import'. Current type:", currentWordSourceType);
            if (typeof appShowFeedback === 'function') {
                appShowFeedback('用户词库未备份：当前词库来源不是文件导入或云端恢复的词库。', 'warning', 3000);
            }
        }
    }

    if (!syncMistakeBook && !(progressData.userWords && progressData.userWords.length > 0)) {
        if (typeof appShowFeedback === 'function') appShowFeedback('未选择任何内容进行备份。', 'warning', 2000);
        if(webdavStatusDiv) { webdavStatusDiv.textContent = '未选择任何内容。备份已取消。'; webdavStatusDiv.className = 'info'; }
        return false;
    }

    const jsonData = JSON.stringify(progressData, null, 2);
    const datedRemoteFilenameOnly = `${GAME_CONFIG.WEBDAV_REMOTE_FILE_BASENAME}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const remoteBaseUserPath = (webDAVSettings.path || "").trim().replace(/^\/+|\/+$/g, '');
    const fileFullPath = remoteBaseUserPath ? `${remoteBaseUserPath}/${datedRemoteFilenameOnly}` : datedRemoteFilenameOnly;

    console.log(`[DAV] Preparing to upload backup file: '${fileFullPath}' (base dir: '${remoteBaseUserPath || '(root)'}')`);
    if(webdavStatusDiv) { webdavStatusDiv.textContent = '📤 上传备份中...'; webdavStatusDiv.className = 'info'; }

    try {
        if (remoteBaseUserPath) {
            console.log(`[DAV] Ensuring remote base directory '${remoteBaseUserPath}' exists...`);
            if(webdavStatusDiv) webdavStatusDiv.textContent = `⚙️ 检查/创建远程目录 '${remoteBaseUserPath}'...`;
            await createDirectoryRecursive(remoteBaseUserPath);
        }

        if(webdavStatusDiv) webdavStatusDiv.textContent = `📤 上传备份: ${datedRemoteFilenameOnly} 到 ${remoteBaseUserPath || '根目录'}`;
        await _davRequest('PUT', fileFullPath, {
            body: jsonData,
            headers: { 'Content-Type': 'application/json' }
        });

        console.log(`[DAV] Backup upload successful to '${_getWebDAVUrl(fileFullPath)}'`);
        if (typeof appShowFeedback === 'function') appShowFeedback('✅ 备份已成功上传!', 'correct', 2000);
        if(webdavStatusDiv) { webdavStatusDiv.textContent = '✅ 备份已上传!'; webdavStatusDiv.className = 'success'; }
        listAndDisplayBackups();
        return true;
    } catch (error) {
        console.error('[DAV] 备份上传过程中发生错误:', error);
        const errorMessage = `上传失败: ${error.message || '未知错误'} (Status: ${error.status || 'N/A'})`;
        if(webdavStatusDiv) { webdavStatusDiv.textContent = `❌ ${errorMessage}`; webdavStatusDiv.className = 'error'; }
        if (typeof appShowFeedback === 'function') appShowFeedback(`❌ ${errorMessage}`, 'error', 5000);
        return false;
    }
}

async function listAndDisplayBackups() {
    if (!webDAVSettings.url) {
        if(webdavStatusDiv) { webdavStatusDiv.textContent = 'WebDAV URL未配置，无法列出备份。'; webdavStatusDiv.className = 'error'; }
        return;
    }
    const backupListContainer = document.getElementById('webdav-backup-list');
    const { GAME_CONFIG, showFeedback: appShowFeedback } = window;
    if (!backupListContainer || !GAME_CONFIG) return;

    backupListContainer.innerHTML = '<em>正在加载备份列表...</em>';

    const directoryToListPath = (webDAVSettings.path || "").trim().replace(/^\/+|\/+$/g, '');
    const requestUrlForPropfind = _getWebDAVUrl(directoryToListPath);

    if(webdavStatusDiv) { webdavStatusDiv.textContent = '🔄 正在获取备份列表...'; webdavStatusDiv.className = 'info'; }
    console.log(`[DAV] Listing backups in directory: '${requestUrlForPropfind}' (derived from settings path: '${directoryToListPath || '(root)'}')`);

    try {
        const response = await _davRequest('PROPFIND', directoryToListPath, { headers: { 'Depth': '1' }, isDirectory: true });
        const xmlData = await response.text();
        const items = _parsePropfindXML(xmlData, requestUrlForPropfind);
        const backupFileRegex = new RegExp(`^${GAME_CONFIG.WEBDAV_REMOTE_FILE_BASENAME}_.*\\.json$`);
        const backups = items
            .filter(item => item.type === 'file' && backupFileRegex.test(item.basename))
            .sort((a, b) => b.basename.localeCompare(a.basename));

        backupListContainer.innerHTML = '';
        if (backups.length === 0) {
            backupListContainer.innerHTML = '<p>未找到云端备份。</p>';
            if(webdavStatusDiv) { webdavStatusDiv.textContent = 'ℹ️ 未找到云端备份。'; webdavStatusDiv.className = 'info';}
            return;
        }

        const ul = document.createElement('ul');
        ul.className = 'backup-items-list';
        backups.forEach(backup => {
            const li = document.createElement('li');
            const sizeKB = backup.size ? (backup.size / 1024).toFixed(1) + 'KB' : 'N/A';
            const modDate = backup.lastmod ? new Date(backup.lastmod).toLocaleString() : 'N/A';
            li.textContent = `${backup.basename} (大小: ${sizeKB}, 修改日期: ${modDate})`;
            li.dataset.filename = backup.basename;
            li.addEventListener('click', () => {
                const restoreBtn = document.getElementById('webdav-restore-button');
                const deleteBtn = document.getElementById('webdav-delete-backup-button');
                document.querySelectorAll('#webdav-backup-list li').forEach(el => el.classList.remove('selected'));
                li.classList.add('selected');
                selectedBackupFile = backup.basename;
                if (restoreBtn) restoreBtn.disabled = false;
                if (deleteBtn) deleteBtn.disabled = false;
            });
            ul.appendChild(li);
        });
        backupListContainer.appendChild(ul);
        if(webdavStatusDiv) { webdavStatusDiv.textContent = `✅ 找到 ${backups.length} 个备份。请选择操作。`; webdavStatusDiv.className = 'success'; }

    } catch (error) {
        console.error('[DAV] 列出备份失败:', error);
        backupListContainer.innerHTML = '<p style="color:red;">无法加载备份列表。</p>';
        const errorMsg = `列出备份失败: ${error.message || "未知错误"} (Status: ${error.status || "N/A"})`;
        if(webdavStatusDiv) { webdavStatusDiv.textContent = `❌ ${errorMsg}`; webdavStatusDiv.className = 'error'; }
        if(typeof appShowFeedback === "function") appShowFeedback(`❌ ${errorMsg}`, 'error', 5000);
    }
}

async function downloadSpecificBackup(filenameBasename) {
    const { showFeedback: appShowFeedback } = window;
    if (!filenameBasename) {
        console.error("[DAV] No filename provided for download.");
        if(typeof appShowFeedback === "function") appShowFeedback("错误：没有提供文件名进行下载。", "error");
        return null;
    }

    const remoteBaseUserPath = (webDAVSettings.path || "").trim().replace(/^\/+|\/+$/g, '');
    const fileFullPathToDownload = remoteBaseUserPath ? `${remoteBaseUserPath}/${filenameBasename}` : filenameBasename;

    console.log(`[DAV] Preparing to download backup: '${fileFullPathToDownload}' from configured remote path.`);
    if(webdavStatusDiv) { webdavStatusDiv.textContent = `📥 下载备份 ${filenameBasename}...`; webdavStatusDiv.className = 'info'; }

    try {
        const response = await _davRequest('GET', fileFullPathToDownload);
        const jsonData = await response.text();
        console.log('[DAV] Backup download successful.');
        if(webdavStatusDiv) { webdavStatusDiv.textContent = `✅ 备份 ${filenameBasename} 下载完成。`; webdavStatusDiv.className = 'success'; }
        return JSON.parse(jsonData);
    } catch (error) {
        console.error(`[DAV] 下载备份 '${filenameBasename}' 过程中发生错误:`, error);
        const errorMsg = `下载备份 "${filenameBasename}" 失败: ${error.message || '未知错误'} (Status: ${error.status || 'N/A'})`;
        if(webdavStatusDiv) { webdavStatusDiv.textContent = `❌ ${errorMsg}`; webdavStatusDiv.className = 'error'; }
        if(typeof appShowFeedback === "function") appShowFeedback(`❌ ${errorMsg}`, 'error', 5000);
        if (error.status === 404) return null;
        throw error;
    }
}

async function restoreFromSelectedBackup() {
    // 从 window 解构 closeModal 和 appShowFeedback (showFeedback 在 app.js 中暴露为 window.showFeedback)
    // 以及 saveMistakeBook 和 showMistakeBook
    const { showFeedback: appShowFeedback, closeModal, saveMistakeBook, showMistakeBook } = window;

    if (!selectedBackupFile) {
        if (typeof appShowFeedback === 'function') appShowFeedback('请先从列表中选择一个备份文件进行恢复。', 'warning');
        return;
    }
    if (!webDAVSettings.url) {
        if (typeof appShowFeedback === 'function') appShowFeedback('WebDAV 设置未配置!', 'error');
        return;
    }

    const confirmRestore = confirm(`您确定要从备份 "${selectedBackupFile}" 恢复数据吗？\n这将根据您的选择覆盖本地的错题本和/或用户自定义词库。`);
    if (!confirmRestore) return;

    if(webdavStatusDiv) { webdavStatusDiv.textContent = `🔄 正在从 ${selectedBackupFile} 恢复...`; webdavStatusDiv.className = 'info'; }
    if (typeof appShowFeedback === 'function') appShowFeedback(`🔄 开始从 ${selectedBackupFile} 恢复...`, 'info', 2000);

    try {
        const remoteData = await downloadSpecificBackup(selectedBackupFile); // Pass basename
        if (!remoteData) {
            if (typeof appShowFeedback === 'function') appShowFeedback('无法下载或备份文件未找到。恢复失败。', 'error', 3000);
            if(webdavStatusDiv && !webdavStatusDiv.textContent.includes("下载备份")) {
                webdavStatusDiv.textContent = '❌ 恢复失败，无法获取备份数据。'; webdavStatusDiv.className = 'error';
            }
            return;
        }

        console.log("[DAV] Downloaded remote data for restore:", remoteData);
        const applyMistakeBookCheckbox = document.getElementById('apply-mistake-book-checkbox');
        const applyUserWordsCheckbox = document.getElementById('apply-user-words-checkbox');
        const applyMistakeBook = applyMistakeBookCheckbox?.checked;
        const applyUserWords = applyUserWordsCheckbox?.checked;
        let changesApplied = false;
        let wordsWereRestored = false; // 标记用户词库是否被真正恢复

        if (applyMistakeBook && remoteData.mistakeBook) {
            window.mistakeBook = [...remoteData.mistakeBook];
            if(typeof saveMistakeBook === 'function') saveMistakeBook();
            const mistakeModal = document.getElementById('mistake-modal');
            if (mistakeModal && mistakeModal.classList.contains('active') && typeof showMistakeBook === 'function') {
                showMistakeBook();
            }
            console.log("[DAV] Mistake book restored.");
            if(typeof appShowFeedback === 'function') appShowFeedback('错题本已从备份恢复。', 'correct', 1500);
            changesApplied = true;
        } else if (applyMistakeBook) {
            if(typeof appShowFeedback === 'function') appShowFeedback('备份中不包含错题本数据，未恢复错题本。', 'info', 2000);
        }

        if (applyUserWords && remoteData.userWords && remoteData.userWords.length > 0) {
            window.wordList = [...remoteData.userWords];
            window.currentWordSourceType = 'webdav_import'; // 关键：标记词库来源
            console.log("[DAV] User words restored and loaded from backup.");
            if(typeof appShowFeedback === 'function') appShowFeedback(`用户词库已从备份恢复并加载了 ${window.wordList.length} 个单词。`, 'correct', 2500);
            changesApplied = true;
            wordsWereRestored = true;
        } else if (applyUserWords) {
             if(typeof appShowFeedback === 'function') appShowFeedback('备份中不包含用户词库数据，或词库为空，未恢复用户词库。', 'info', 2000);
        }

        if (!changesApplied && (applyMistakeBook || applyUserWords)) {
            if(typeof appShowFeedback === 'function') appShowFeedback('已选择恢复，但备份中无相应数据或数据为空。', 'info', 2500);
        } else if (!applyMistakeBook && !applyUserWords) {
            if(typeof appShowFeedback === 'function') appShowFeedback('未选择任何数据类型进行恢复。', 'warning', 2000);
        }

        if(webdavStatusDiv) { webdavStatusDiv.textContent = '✅ 恢复操作完成。'; webdavStatusDiv.className = 'success'; }

        // 恢复操作完成后，关闭弹窗
        // 不再直接调用 prepareGameStart
        if (typeof closeModal === 'function') {
            closeModal('webdav-settings-modal');
        }

        // 如果恢复了用户词库，给一个额外的提示，让用户去主界面点击新按钮开始
        if (wordsWereRestored) {
            if(typeof appShowFeedback === 'function') appShowFeedback('词库已就绪！请点击主界面的“开始游戏/加载词库”按钮开始游戏。', 'info', 3500);
        }

    } catch (error) {
        console.error('[DAV] Restore operation failed:', error);
        const userMessage = `恢复失败: ${error.message || '未知错误'} (Status: ${error.status || 'N/A'})`;
        if(webdavStatusDiv) { webdavStatusDiv.innerHTML = `❌ 恢复失败:<br>${userMessage}`; webdavStatusDiv.className = 'error'; }
        if (typeof appShowFeedback === 'function') appShowFeedback(`❌ ${userMessage.split('<br>')[0]}`, 'error', 7000);
    }
}


async function deleteSpecificBackup(filenameBasenameFromEvent) {
    const { showFeedback: appShowFeedback } = window;
    let filenameToDelete = filenameBasenameFromEvent instanceof PointerEvent || typeof filenameBasenameFromEvent === "undefined" || filenameBasenameFromEvent === null
        ? selectedBackupFile
        : filenameBasenameFromEvent;

    if (!filenameToDelete) {
        if (typeof appShowFeedback === 'function') appShowFeedback('请先从列表中选择一个备份文件进行删除。', 'warning');
        return;
    }
    if (!webDAVSettings.url) {
         if (typeof appShowFeedback === 'function') appShowFeedback('WebDAV 设置未配置!', 'error');
         return;
    }

    const confirmDelete = confirm(`您确定要删除云端备份文件 "${filenameToDelete}" 吗？\n此操作不可撤销！`);
    if (!confirmDelete) return;

    const remoteBaseUserPath = (webDAVSettings.path || "").trim().replace(/^\/+|\/+$/g, '');
    const fileFullPathToDelete = remoteBaseUserPath ? `${remoteBaseUserPath}/${filenameToDelete}` : filenameToDelete;

    if(webdavStatusDiv) { webdavStatusDiv.textContent = `🗑️ 删除云端备份 ${filenameToDelete}...`; webdavStatusDiv.className = 'info'; }
    if (typeof appShowFeedback === 'function') appShowFeedback(`🗑️ 开始删除云端备份 ${filenameToDelete}...`, 'info', 1500);
    console.log(`[DAV] Attempting to DELETE file: '${fileFullPathToDelete}'`);

    try {
        await _davRequest('DELETE', fileFullPathToDelete);
        if(webdavStatusDiv) { webdavStatusDiv.textContent = `✅ 云端备份 ${filenameToDelete} 已删除!`; webdavStatusDiv.className = 'success'; }
        if (typeof appShowFeedback === 'function') appShowFeedback(`✅ 云端备份 ${filenameToDelete} 已成功删除!`, 'correct', 2500);
        selectedBackupFile = null;
        const restoreBtn = document.getElementById('webdav-restore-button');
        const deleteBtn = document.getElementById('webdav-delete-backup-button');
        if (restoreBtn) restoreBtn.disabled = true;
        if (deleteBtn) deleteBtn.disabled = true;
        listAndDisplayBackups();
    } catch (error) {
        console.error(`[DAV] 删除云端备份 '${filenameToDelete}' 失败:`, error);
        let userMessage = `删除失败: ${error.message || '未知错误'}`;
        if (error.status === 404) {
            userMessage = `云端备份 ${filenameToDelete} 未找到或已被删除。`;
            if(webdavStatusDiv) { webdavStatusDiv.textContent = `ℹ️ ${userMessage}`; webdavStatusDiv.className = 'info'; }
            if (typeof appShowFeedback === 'function') appShowFeedback(userMessage, 'info', 2500);
            listAndDisplayBackups();
        } else {
            userMessage += ` (Status: ${error.status || 'N/A'})`;
            if(webdavStatusDiv) { webdavStatusDiv.innerHTML = `❌ 删除失败: ${userMessage}`; webdavStatusDiv.className = 'error'; }
            if (typeof appShowFeedback === 'function') appShowFeedback(`❌ ${userMessage.split('<br>')[0]}`, 'error', 5000);
        }
    }
}

function openWebDAVSettingsModal() {
    if (!webDAVSettingsModal || !webdavUrlInput || !webdavUsernameInput || !webdavPasswordInput || !webdavPathInput || !webdavStatusDiv) {
        console.warn("WebDAV DOM elements not initialized for openWebDAVSettingsModal, attempting re-init.");
        WebDAVModule.initDOMElements();
        if (!webDAVSettingsModal) {
             console.error("WebDAV DOM elements STILL not found after re-init. Aborting modal open.");
             return;
        }
    }

    webdavUrlInput.value = webDAVSettings.url || '';
    webdavUsernameInput.value = webDAVSettings.username || '';
    webdavPasswordInput.value = webDAVSettings.password || '';
    webdavPathInput.value = webDAVSettings.path || '';
    webdavStatusDiv.textContent = '';
    webdavStatusDiv.className = '';

    webDAVSettingsModal.style.display = 'flex';
    setTimeout(() => webDAVSettingsModal.classList.add('active'), 10);

    const restoreButton = document.getElementById('webdav-restore-button');
    const deleteBackupButton = document.getElementById('webdav-delete-backup-button');
    if (restoreButton) restoreButton.disabled = true;
    if (deleteBackupButton) deleteBackupButton.disabled = true;
    selectedBackupFile = null;

    if (webDAVSettings.url) {
        listAndDisplayBackups();
    } else {
        const backupListContainer = document.getElementById('webdav-backup-list');
        if (backupListContainer) backupListContainer.innerHTML = '<p>请先配置并保存 WebDAV 设置以查看备份。</p>';
    }
}

async function handleCreateBackup() {
    const { showFeedback: appShowFeedback } = window;
    if (!webDAVSettings.url) {
        if (typeof appShowFeedback === 'function') appShowFeedback('请先正确配置并保存 WebDAV 设置!', 'error');
        if(webdavStatusDiv) { webdavStatusDiv.innerHTML = '错误: WebDAV URL 未配置。'; webdavStatusDiv.className = 'error'; }
        return;
    }
    if(!webdavStatusDiv) return;

    webdavStatusDiv.textContent = '🔄 准备创建备份...';
    webdavStatusDiv.className = 'info';
    if (typeof appShowFeedback === 'function') appShowFeedback('🔄 开始创建备份...', 'info', 1500);

    await uploadProgressToWebDAV();
}

// --- Expose functions to global scope ---
window.openWebDAVSettingsModal = openWebDAVSettingsModal;
window.saveWebDAVSettings = saveWebDAVSettings;
window.testWebDAVConnection = testWebDAVConnection;
window.handleCreateBackup = handleCreateBackup;
window.restoreFromSelectedBackup = restoreFromSelectedBackup;
window.deleteSpecificBackup = deleteSpecificBackup;

window.WebDAVModule = {
    initDOMElements: function() {
        webDAVSettingsModal = document.getElementById('webdav-settings-modal');
        webdavUrlInput = document.getElementById('webdav-url');
        webdavUsernameInput = document.getElementById('webdav-username');
        webdavPasswordInput = document.getElementById('webdav-password');
        webdavPathInput = document.getElementById('webdav-path');
        webdavStatusDiv = document.getElementById('webdav-status');
        console.log("[WebDAVModule] DOM elements initialized (or re-initialized).");
    },
    loadSettings: loadWebDAVSettings,
};