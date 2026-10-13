// ==UserScript==
// @name         Pixiv - Popularity Filter
// @namespace    https://github.com/juanjesusmcsalad/pixiv-auto-popularity
// @version      2.3
// @description  Rank Pixiv illustrations and manga strictly by Likes or Bookmarks across all pages + auto-scans 10000users/5000users/1000users Hall-of-Fame tiers for all-time masterpieces!
// @author       lageeg58
// @license      MIT
// @icon         https://www.pixiv.net/favicon.ico
// @homepageURL  https://github.com/juanjesusmcsalad/pixiv-auto-popularity
// @supportURL   https://github.com/juanjesusmcsalad/pixiv-auto-popularity/issues
// @match        *://www.pixiv.net/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // State & Storage
    let abortController = null;
    let currentRankedArtworks = [];
    let minMetricFilter = 0;
    let activeSortMetric = localStorage.getItem('pixiv_rank_metric') || 'likes'; // 'likes' or 'bookmarks'
    let targetPagesSetting = localStorage.getItem('pixiv_target_pages') || '3';
    let targetCategorySetting = localStorage.getItem('pixiv_target_category') || 'artworks'; // 'artworks' or 'manga'
    let enableHallOfFameBoost = localStorage.getItem('pixiv_hof_boost') !== 'false'; // Default TRUE

    const CONCURRENCY = 10;
    const WALL_CONTAINER_ID = 'pixiv-ranked-popularity-wall';
    const FLOAT_WIDGET_ID = 'pixiv-rank-float-widget';

    // Session cache to prevent re-fetching known artwork counts
    function getCachedMetric(id) {
        try {
            const raw = sessionStorage.getItem(`px_counts_${id}`);
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    }
    function setCachedMetric(id, counts) {
        try { sessionStorage.setItem(`px_counts_${id}`, JSON.stringify(counts)); } catch {}
    }

    // Hide Pixiv's native premium teaser banner cleanly
    const style = document.createElement('style');
    style.textContent = `
        div:has(> a[href*="premium"]), 
        div:has(> button[href*="premium"]),
        section:has(a[href*="premium"]) {
            display: none !important;
        }
    `;
    document.head.appendChild(style);

    // Extract current search query & URL filters
    function getSearchState() {
        const path = decodeURIComponent(location.pathname);
        let word = '';

        const tagMatch = path.match(/\/tags\/([^/]+)/);
        if (tagMatch) {
            word = tagMatch[1];
        } else {
            const params = new URLSearchParams(location.search);
            word = params.get('word') || params.get('q') || '';
        }

        // Clean out any existing users入り suffix from base search term
        const cleanWord = word.replace(/\s*\d+users入り/gi, '').trim();

        const urlParams = new URLSearchParams(location.search);
        return {
            word: cleanWord,
            rawWord: word.trim(),
            mode: urlParams.get('mode') || 'all',
            s_mode: urlParams.get('s_mode') || 's_tag',
            ai_type: urlParams.get('ai_type') || '0',
            csw: urlParams.get('csw') || '0'
        };
    }

    // Locate Pixiv's search results parent container
    function findNativeSearchSection() {
        const ga4 = document.querySelector('div[data-ga4-label="works_content"]');
        if (ga4) return ga4;

        const artLinks = Array.from(document.querySelectorAll('a[href*="/artworks/"]'));
        for (const a of artLinks) {
            const list = a.closest('ul') || a.closest('section');
            if (list) return list;
        }
        return null;
    }

    // Delay helper
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // Fetch Pixiv search page via internal ajax endpoint with retry on rate limit
    async function fetchSearchPage(searchWord, searchState, category, pageNum, signal) {
        const cat = category === 'manga' ? 'manga' : 'artworks';
        const params = new URLSearchParams({
            word: searchWord,
            order: 'date_d',
            mode: searchState.mode,
            p: String(pageNum),
            s_mode: 's_tag', // s_tag allows multi-tag matching (e.g. word + 10000users入り)
            type: 'all',
            ai_type: searchState.ai_type,
            csw: searchState.csw
        });

        const url = `/ajax/search/${cat}/${encodeURIComponent(searchWord)}?${params.toString()}`;

        for (let attempt = 0; attempt < 3; attempt++) {
            if (signal.aborted) return { items: [], total: 0 };
            try {
                const res = await fetch(url, { credentials: 'include', signal });
                if (res.status === 429) {
                    await sleep(1500 * (attempt + 1));
                    continue;
                }
                if (!res.ok) return { items: [], total: 0 };
                const json = await res.json();
                const body = json?.body || {};

                const items = [];
                // Harvest official top popularity teasers on first page
                if (pageNum === 1 && body.popular) {
                    if (Array.isArray(body.popular.permanent)) items.push(...body.popular.permanent);
                    if (Array.isArray(body.popular.recent)) items.push(...body.popular.recent);
                }

                if (cat === 'manga' && body.manga?.data) {
                    items.push(...body.manga.data);
                } else {
                    if (body.illust?.data) items.push(...body.illust.data);
                    if (body.illustManga?.data) items.push(...body.illustManga.data);
                }

                const total = body.manga?.total || body.illust?.total || body.illustManga?.total || 0;
                return { items, total };
            } catch {
                if (signal.aborted) return { items: [], total: 0 };
                await sleep(500);
            }
        }
        return { items: [], total: 0 };
    }

    // Fetch likeCount & bookmarkCount for a single artwork with 429 exponential backoff
    async function fetchCountsForId(id, signal) {
        const cached = getCachedMetric(id);
        if (cached) return cached;

        for (let attempt = 0; attempt < 3; attempt++) {
            if (signal.aborted) return { likes: 0, bookmarks: 0 };
            try {
                const res = await fetch(`https://www.pixiv.net/ajax/illust/${id}`, {
                    credentials: 'omit',
                    signal,
                    headers: { 'Accept': 'application/json' }
                });
                if (res.status === 429) {
                    await sleep(1200 * (attempt + 1));
                    continue;
                }
                if (!res.ok) return { likes: 0, bookmarks: 0 };
                const json = await res.json();
                const body = json?.body || {};
                const counts = {
                    likes: Number(body.likeCount || 0),
                    bookmarks: Number(body.bookmarkCount || 0)
                };
                setCachedMetric(id, counts);
                return counts;
            } catch {
                if (signal.aborted) return { likes: 0, bookmarks: 0 };
                await sleep(400);
            }
        }
        return { likes: 0, bookmarks: 0 };
    }

    // Concurrent Worker Queue with progress estimation
    async function populateCounts(artworks, signal, onProgress) {
        let index = 0;
        let completed = 0;
        const total = artworks.length;
        const startTime = Date.now();

        async function worker() {
            while (index < total && !signal.aborted) {
                const i = index++;
                const art = artworks[i];
                const counts = await fetchCountsForId(art.id, signal);
                art.likeCount = counts.likes;
                art.bookmarkCount = counts.bookmarks;
                completed++;

                if (onProgress) {
                    const elapsed = (Date.now() - startTime) / 1000;
                    const rate = completed / (elapsed || 0.1);
                    const remaining = Math.max(0, Math.round((total - completed) / (rate || 1)));
                    onProgress(completed, total, remaining);
                }
            }
        }

        const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker());
        await Promise.all(workers);
    }

    // Render Wall Cards
    function renderWallCards() {
        const wallContainer = document.getElementById(WALL_CONTAINER_ID);
        if (!wallContainer || !currentRankedArtworks.length) return;

        const grid = wallContainer.querySelector('#pixiv-ranked-grid');
        if (!grid) return;

        const metricKey = activeSortMetric === 'bookmarks' ? 'bookmarkCount' : 'likeCount';
        const filtered = currentRankedArtworks.filter(art => (art[metricKey] || 0) >= minMetricFilter);

        grid.innerHTML = filtered.map((art, idx) => {
            const rank = idx + 1;
            const rankBadgeColor = rank === 1 ? 'linear-gradient(135deg, #f1c40f, #d35400)'
                                 : rank === 2 ? 'linear-gradient(135deg, #bdc3c7, #7f8c8d)'
                                 : rank === 3 ? 'linear-gradient(135deg, #e67e22, #b9770e)'
                                 : 'rgba(0,0,0,0.8)';

            const isHof = (art.bookmarkCount >= 10000 || art.likeCount >= 10000);

            return `
                <div style="background: #1c1c1c; border-radius: 8px; overflow: hidden; border: 1px solid #333; display: flex; flex-direction: column; transition: transform 0.15s, border-color 0.15s;"
                     onmouseover="this.style.transform='translateY(-2px)'; this.style.borderColor='#0096fa';"
                     onmouseout="this.style.transform=''; this.style.borderColor='#333';">
                    <a href="/artworks/${art.id}" target="_blank" style="text-decoration: none; color: inherit; display: flex; flex-direction: column; height: 100%;">
                        <div style="position: relative; width: 100%; aspect-ratio: 1; background: #121212; overflow: hidden;">
                            <img src="${art.url}" style="width: 100%; height: 100%; object-fit: cover; display: block;" loading="lazy" />
                            
                            <!-- Rank Badge -->
                            <span style="position: absolute; top: 6px; left: 6px; background: ${rankBadgeColor}; color: #fff; font-size: 11px; font-weight: 800; padding: 2px 7px; border-radius: 4px; box-shadow: 0 2px 6px rgba(0,0,0,0.6);">
                                #${rank}
                            </span>
                            
                            <!-- Top Right Badges: Page count + Hall of Fame star -->
                            <div style="position: absolute; top: 6px; right: 6px; display: flex; gap: 4px; align-items: center;">
                                ${isHof ? `<span style="background: linear-gradient(135deg, #e74c3c, #f39c12); color: #fff; font-size: 10px; padding: 2px 5px; border-radius: 4px; font-weight: 800;" title="10,000+ Hall of Fame">👑 10k+</span>` : ''}
                                ${art.pageCount > 1 ? `<span style="background: rgba(0,0,0,0.75); color: #fff; font-size: 10px; padding: 2px 5px; border-radius: 4px; font-weight: 600;">📄 ${art.pageCount}</span>` : ''}
                            </div>
                            
                            <!-- Metric Badges -->
                            <div style="position: absolute; bottom: 6px; right: 6px; display: flex; gap: 4px; align-items: center;">
                                <span style="background: rgba(0,0,0,0.85); color: #ff5252; font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(255,82,82,0.4);">
                                    ❤️ ${(art.likeCount || 0).toLocaleString()}
                                </span>
                                <span style="background: rgba(0,0,0,0.85); color: #f1c40f; font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(241,196,15,0.4);">
                                    ⭐ ${(art.bookmarkCount || 0).toLocaleString()}
                                </span>
                            </div>
                        </div>

                        <!-- Card Info -->
                        <div style="padding: 10px; font-size: 12px; display: flex; flex-direction: column; justify-content: space-between; flex: 1;">
                            <div style="font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #eee;" title="${art.title}">
                                ${art.title}
                            </div>
                            <div style="color: #888; font-size: 11px; margin-top: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                                👤 ${art.userName}
                            </div>
                        </div>
                    </a>
                </div>
            `;
        }).join('');

        const countEl = document.getElementById('pixiv-filter-count-label');
        if (countEl) countEl.innerText = `Showing ${filtered.length.toLocaleString()} of ${currentRankedArtworks.length.toLocaleString()}`;
    }

    // Core Execution: Hybrid Normal Scan + Hall of Fame (users入り) Scan
    async function startPopularityScan() {
        const searchState = getSearchState();
        if (!searchState.word) {
            alert('Please enter a tag or search term first.');
            return;
        }

        const nativeSection = findNativeSearchSection();
        if (!nativeSection) {
            alert('Could not find artworks grid on this page.');
            return;
        }

        // Cancel previous request if active
        if (abortController) abortController.abort();
        abortController = new AbortController();
        const signal = abortController.signal;

        // Hide native section to avoid React Virtual DOM clashes
        nativeSection.style.display = 'none';

        // Prepare our dedicated wall container
        let wallContainer = document.getElementById(WALL_CONTAINER_ID);
        if (!wallContainer) {
            wallContainer = document.createElement('div');
            wallContainer.id = WALL_CONTAINER_ID;
            wallContainer.style.cssText = `
                width: 100%;
                margin: 20px 0 40px 0;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            `;
            nativeSection.parentElement.insertBefore(wallContainer, nativeSection);
        }

        const isManga = targetCategorySetting === 'manga';

        // Header bar with status
        wallContainer.innerHTML = `
            <div id="pixiv-wall-header" style="
                background: #252525; border: 1px solid #444; border-radius: 8px;
                padding: 12px 18px; margin-bottom: 20px; color: #fff; display: flex;
                flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            ">
                <div id="pixiv-status-text" style="font-weight: 600; font-size: 13px;">
                    ⏳ Connecting to search index...
                </div>
                <button id="pixiv-abort-btn" style="
                    background: #e74c3c; color: #fff; border: none; padding: 6px 14px;
                    border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: bold;
                ">
                    ⏹️ Stop & Show Now
                </button>
            </div>
            <div id="pixiv-ranked-grid" style="
                display: grid !important;
                grid-template-columns: repeat(auto-fill, minmax(185px, 1fr)) !important;
                gap: 16px !important;
                width: 100% !important;
            "></div>
        `;

        const statusText = wallContainer.querySelector('#pixiv-status-text');
        const abortBtn = wallContainer.querySelector('#pixiv-abort-btn');
        abortBtn.onclick = () => { abortController.abort(); };

        // 1. Gather First Page of base tag
        const firstPageData = await fetchSearchPage(searchState.word, searchState, targetCategorySetting, 1, signal);
        let collectedWorks = [...firstPageData.items];
        
        const totalItemsInTag = firstPageData.total || 60;
        const totalAvailablePages = Math.ceil(totalItemsInTag / 60);

        let pagesToScan = 1;
        if (targetPagesSetting === 'all') {
            pagesToScan = totalAvailablePages;
        } else if (targetPagesSetting.startsWith('custom:')) {
            const customVal = parseInt(targetPagesSetting.split(':')[1]);
            pagesToScan = isNaN(customVal) ? 1 : Math.min(customVal, totalAvailablePages);
        } else {
            const parsed = parseInt(targetPagesSetting);
            pagesToScan = isNaN(parsed) ? 1 : Math.min(parsed, totalAvailablePages);
        }

        // Confirmation for huge scans (> 200 pages) when Hall of Fame is OFF
        if (pagesToScan > 200 && targetPagesSetting === 'all' && !enableHallOfFameBoost) {
            const ok = confirm(`This tag contains ${totalAvailablePages.toLocaleString()} pages (~${totalItemsInTag.toLocaleString()} works)!\n\nScanning all pages chronologically will take time. Would you like to proceed?`);
            if (!ok) {
                wallContainer.remove();
                nativeSection.style.display = '';
                return;
            }
        }

        // 2. Fetch Base Search Pages in parallel
        const pageNumbers = Array.from({ length: pagesToScan - 1 }, (_, i) => i + 2);
        for (let i = 0; i < pageNumbers.length; i += 5) {
            if (signal.aborted) break;
            const chunk = pageNumbers.slice(i, i + 5);
            const chunkResults = await Promise.all(chunk.map(p => fetchSearchPage(searchState.word, searchState, targetCategorySetting, p, signal)));
            for (const r of chunkResults) collectedWorks.push(...r.items);
            if (statusText) {
                statusText.innerText = `⏳ Gathering pages: ${Math.min(i + 5, pagesToScan)} of ${pagesToScan.toLocaleString()} (${collectedWorks.length.toLocaleString()} items found)...`;
            }
        }

        // 3. HYBRID HARVESTER: Inject Hall of Fame "users入り" Tiers
        if (enableHallOfFameBoost && !signal.aborted) {
            if (statusText) statusText.innerText = `👑 Scanning Hall of Fame tiers (10000users / 5000users / 1000users)...`;
            
            const hofTiers = ['10000users入り', '5000users入り', '1000users入り'];
            const hofQueries = hofTiers.map(tier => `${searchState.word} ${tier}`);

            // Fetch page 1 (and page 2 if user selected >= 3 pages) for each tier
            const tierFetches = [];
            for (const query of hofQueries) {
                tierFetches.push(fetchSearchPage(query, searchState, targetCategorySetting, 1, signal));
                if (pagesToScan >= 3) {
                    tierFetches.push(fetchSearchPage(query, searchState, targetCategorySetting, 2, signal));
                }
            }

            const tierResults = await Promise.all(tierFetches);
            let hofCount = 0;
            for (const res of tierResults) {
                if (res.items && res.items.length) {
                    collectedWorks.push(...res.items);
                    hofCount += res.items.length;
                }
            }
            if (statusText) {
                statusText.innerText = `✨ Injected ${hofCount} Hall-of-Fame masterpieces! Deduplicating...`;
            }
        }

        // Deduplicate works across all streams
        const unique = Array.from(new Map(collectedWorks.map(it => [it.id, it])).values());

        // 4. Concurrently populate Likes and Bookmarks with live time remaining
        const onProgress = (done, total, remainingSec) => {
            const pct = Math.round((done / total) * 100);
            if (statusText) {
                const timeText = remainingSec > 60 ? `~${Math.round(remainingSec / 60)} min remaining` : `~${remainingSec}s remaining`;
                statusText.innerHTML = `
                    <span style="color: #0096fa;">📊 Loading popularity metrics:</span> 
                    <b>${done.toLocaleString()}</b> / ${total.toLocaleString()} (${pct}%) • <span style="color: #bbb;">${timeText}</span>
                `;
            }
        };

        await populateCounts(unique, signal, onProgress);

        // 5. STRICT SORT: Guaranteed descending order
        const sortKey = activeSortMetric === 'bookmarks' ? 'bookmarkCount' : 'likeCount';
        unique.sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));
        currentRankedArtworks = unique;

        // 6. Update Header with Interactive Filter Controls
        const headerEl = wallContainer.querySelector('#pixiv-wall-header');
        headerEl.innerHTML = `
            <div style="display: flex; align-items: center; gap: 14px; flex-wrap: wrap;">
                <div>
                    🏆 <b>Ranked:</b> <span id="pixiv-filter-count-label">${unique.length.toLocaleString()} works ${enableHallOfFameBoost ? '(+Hall of Fame)' : ''}</span>
                </div>

                <!-- Metric Toggle (Likes vs Bookmarks) -->
                <div style="display: inline-flex; background: #1a1a1a; border: 1px solid #444; border-radius: 6px; padding: 2px;">
                    <button id="pixiv-toggle-likes" style="
                        background: ${activeSortMetric === 'likes' ? '#e74c3c' : 'transparent'};
                        color: #fff; border: none; padding: 4px 10px; border-radius: 4px;
                        cursor: pointer; font-size: 11px; font-weight: bold;
                    ">❤️ Likes</button>
                    <button id="pixiv-toggle-bookmarks" style="
                        background: ${activeSortMetric === 'bookmarks' ? '#f39c12' : 'transparent'};
                        color: #fff; border: none; padding: 4px 10px; border-radius: 4px;
                        cursor: pointer; font-size: 11px; font-weight: bold;
                    ">⭐ Bookmarks</button>
                </div>

                <!-- Threshold Filter Chips -->
                <div style="display: inline-flex; align-items: center; gap: 5px; font-size: 11px;">
                    <span style="color: #888;">Min:</span>
                    ${[0, 50, 100, 500, 1000, 5000].map(min => `
                        <button class="pixiv-min-chip" data-min="${min}" style="
                            background: ${minMetricFilter === min ? '#0096fa' : '#333'};
                            color: #fff; border: 1px solid #555; padding: 3px 8px;
                            border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: 600;
                        ">
                            ${min === 0 ? 'All' : min.toLocaleString() + '+'}
                        </button>
                    `).join('')}
                </div>
            </div>

            <!-- Reset Button -->
            <button id="pixiv-restore-native-btn" style="
                background: #3a3a3a; color: #fff; border: 1px solid #555; padding: 5px 12px;
                border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600;
            ">
                ↩️ Reset to Native
            </button>
        `;

        // Bind interactive events
        headerEl.querySelector('#pixiv-toggle-likes').onclick = () => {
            activeSortMetric = 'likes';
            localStorage.setItem('pixiv_rank_metric', 'likes');
            currentRankedArtworks.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
            headerEl.querySelector('#pixiv-toggle-likes').style.background = '#e74c3c';
            headerEl.querySelector('#pixiv-toggle-bookmarks').style.background = 'transparent';
            renderWallCards();
        };

        headerEl.querySelector('#pixiv-toggle-bookmarks').onclick = () => {
            activeSortMetric = 'bookmarks';
            localStorage.setItem('pixiv_rank_metric', 'bookmarks');
            currentRankedArtworks.sort((a, b) => (b.bookmarkCount || 0) - (a.bookmarkCount || 0));
            headerEl.querySelector('#pixiv-toggle-bookmarks').style.background = '#f39c12';
            headerEl.querySelector('#pixiv-toggle-likes').style.background = 'transparent';
            renderWallCards();
        };

        headerEl.querySelectorAll('.pixiv-min-chip').forEach(btn => {
            btn.onclick = function () {
                minMetricFilter = parseInt(this.dataset.min);
                headerEl.querySelectorAll('.pixiv-min-chip').forEach(b => { b.style.background = '#333'; });
                this.style.background = '#0096fa';
                renderWallCards();
            };
        });

        headerEl.querySelector('#pixiv-restore-native-btn').onclick = () => {
            wallContainer.remove();
            nativeSection.style.display = '';
            currentRankedArtworks = [];
        };

        renderWallCards();

        // Hide native pagination bar while wall is active
        document.querySelectorAll('nav:has(polyline), nav[aria-label*="page"]').forEach(el => { el.style.display = 'none'; });
    }

    // Inject Floating Quick-Control Pill
    function injectFloatingPill() {
        const searchState = getSearchState();
        if (!searchState.word) return;

        if (document.getElementById(FLOAT_WIDGET_ID)) return;

        const pill = document.createElement('div');
        pill.id = FLOAT_WIDGET_ID;
        pill.style.cssText = `
            position: fixed; right: 20px; top: 160px; z-index: 999999;
            background: #1c1c1c; border: 1px solid #444; padding: 6px 12px;
            border-radius: 28px; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
            display: flex; align-items: center; gap: 8px; font-family: sans-serif;
        `;

        // 1. Category Dropdown
        const catSelect = document.createElement('select');
        catSelect.style.cssText = `
            background: #2b2b2b; color: #fff; border: 1px solid #555;
            padding: 5px 8px; border-radius: 14px; font-size: 12px;
            font-weight: 600; cursor: pointer; outline: none;
        `;
        [
            { label: '🎨 Illust', value: 'artworks' },
            { label: '📖 Manga', value: 'manga' }
        ].forEach(opt => {
            const o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.label;
            if (opt.value === targetCategorySetting) o.selected = true;
            catSelect.appendChild(o);
        });
        catSelect.onchange = (e) => {
            e.stopPropagation();
            targetCategorySetting = catSelect.value;
            localStorage.setItem('pixiv_target_category', targetCategorySetting);
        };
        pill.appendChild(catSelect);

        // 2. Page Count Dropdown
        const pageSelect = document.createElement('select');
        pageSelect.style.cssText = `
            background: #2b2b2b; color: #fff; border: 1px solid #555;
            padding: 5px 8px; border-radius: 14px; font-size: 12px;
            font-weight: 600; cursor: pointer; outline: none;
        `;
        [
            { label: '1 Page (60)', value: '1' },
            { label: '3 Pages (180)', value: '3' },
            { label: '5 Pages (300)', value: '5' },
            { label: '10 Pages (600)', value: '10' },
            { label: '25 Pages (1,500)', value: '25' },
            { label: '50 Pages (3,000)', value: '50' },
            { label: '100 Pages (6,000)', value: '100' },
            { label: 'Custom Pages...', value: 'custom' },
            { label: 'All Pages (Full Tag)', value: 'all' }
        ].forEach(opt => {
            const o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.label;
            if (String(opt.value) === String(targetPagesSetting) || (opt.value === 'custom' && targetPagesSetting.startsWith('custom:'))) {
                o.selected = true;
            }
            pageSelect.appendChild(o);
        });

        pageSelect.onchange = (e) => {
            e.stopPropagation();
            if (pageSelect.value === 'custom') {
                const userNum = prompt('Enter the number of pages you want to scan (each page is 60 works):', '50');
                if (userNum && !isNaN(parseInt(userNum)) && parseInt(userNum) > 0) {
                    targetPagesSetting = `custom:${parseInt(userNum)}`;
                    localStorage.setItem('pixiv_target_pages', targetPagesSetting);
                    pageSelect.options[pageSelect.selectedIndex].textContent = `Custom (${parseInt(userNum)} p)`;
                } else {
                    pageSelect.value = '3';
                    targetPagesSetting = '3';
                    localStorage.setItem('pixiv_target_pages', '3');
                }
            } else {
                targetPagesSetting = pageSelect.value;
                localStorage.setItem('pixiv_target_pages', targetPagesSetting);
            }
        };
        pill.appendChild(pageSelect);

        // 3. Hall-of-Fame (users入り) Booster Toggle Button
        const hofToggle = document.createElement('button');
        hofToggle.id = 'pixiv-hof-toggle-btn';
        hofToggle.title = 'When active, also scans 10000users/5000users/1000users tiers to pull all-time greatest masterpieces into your results!';
        const updateHofButtonState = () => {
            hofToggle.innerHTML = enableHallOfFameBoost ? '👑 <b>+users入り: ON</b>' : '👑 <b>+users入り: OFF</b>';
            hofToggle.style.background = enableHallOfFameBoost ? 'linear-gradient(135deg, #e67e22, #d35400)' : '#333';
            hofToggle.style.color = enableHallOfFameBoost ? '#fff' : '#888';
            hofToggle.style.border = enableHallOfFameBoost ? '1px solid #e67e22' : '1px solid #555';
        };
        hofToggle.style.cssText = `
            border-radius: 14px; font-size: 11px; padding: 5px 9px; cursor: pointer; outline: none; transition: all 0.2s;
        `;
        updateHofButtonState();
        hofToggle.onclick = (e) => {
            e.stopPropagation();
            enableHallOfFameBoost = !enableHallOfFameBoost;
            localStorage.setItem('pixiv_hof_boost', String(enableHallOfFameBoost));
            updateHofButtonState();
        };
        pill.appendChild(hofToggle);

        // 4. Action Trigger Button
        const rankBtn = document.createElement('button');
        rankBtn.innerHTML = '🔥 <b>Rank</b>';
        rankBtn.style.cssText = `
            background: #0096fa; color: #fff; border: none; padding: 6px 14px;
            border-radius: 18px; font-size: 12px; font-weight: bold; cursor: pointer;
            display: flex; align-items: center; gap: 6px; transition: background 0.2s;
        `;
        rankBtn.onmouseover = () => { rankBtn.style.background = '#007cd6'; };
        rankBtn.onmouseout = () => { rankBtn.style.background = '#0096fa'; };
        rankBtn.onclick = startPopularityScan;
        pill.appendChild(rankBtn);

        document.body.appendChild(pill);
    }

    // SPA Navigation Watcher
    let lastUrl = location.href;
    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            const wall = document.getElementById(WALL_CONTAINER_ID);
            if (wall) wall.remove();
            const nativeSection = findNativeSearchSection();
            if (nativeSection) nativeSection.style.display = '';
            currentRankedArtworks = [];
            const pill = document.getElementById(FLOAT_WIDGET_ID);
            if (pill) pill.remove();
        }
        injectFloatingPill();
    }, 1000);

    setTimeout(injectFloatingPill, 600);
})();