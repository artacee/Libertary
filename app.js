/* ============================================================
   READER — Application Logic
   ============================================================ */

// ---- PDF.js Setup (dynamic import for ESM) ----
let pdfjsLib;
try {
    pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.worker.min.mjs';
} catch (err) {
    console.error('PDF.js load failed:', err);
    document.getElementById('landing-screen').querySelector('.landing-content').innerHTML = `
        <div style="padding:40px;text-align:center">
            <h2 style="margin-bottom:12px;color:var(--text-primary)">Could not load PDF engine</h2>
            <p style="color:var(--text-secondary)">Please serve this folder with a local server:<br>
            <code style="color:var(--accent)">npx serve .</code> or VS Code Live Server</p>
        </div>`;
    throw err;
}

// StPageFlip loaded via global <script> tag
const { PageFlip } = St;

// ============================================================
// DOM REFERENCES
// ============================================================
const $ = (sel) => document.querySelector(sel);
const dom = {
    landingScreen:   $('#landing-screen'),
    readerScreen:    $('#reader-screen'),
    dropZone:        $('#drop-zone'),
    fileInput:       $('#file-input'),
    filePickerBtn:   $('#file-picker-btn'), // Note: removed in HTML, will safely be null
    bookArea:        $('#book-area'),
    bookContainer:   $('#book'),
    welcomeView:     $('#welcome-view'),
    libraryView:     $('#library-view'),
    welcomeSelectBtn:$('#welcome-select-btn'),
    changeVaultBtn:  $('#change-vault-btn'),
    libraryName:     $('#library-name'),
    libraryCount:    $('#library-count'),
    librarySections: $('#library-sections'),
    libraryEmpty:    $('#library-empty'),
    backToLibraryBtn:$('#back-to-library-btn'),
    notesSidebar:    $('#notes-sidebar'),
    notesBtn:        $('#notes-btn'),
    closeNotesBtn:   $('#close-notes-btn'),
    exportNotesBtn:  $('#export-notes-btn'),
    notesSearch:     $('#notes-search'),
    notesList:       $('#notes-list'),
    composerPageLabel:$('#composer-page-label'),
    noteInput:       $('#note-input'),
    saveNoteBtn:     $('#save-note-btn'),
    confirmModal:    $('#confirm-modal'),
    confirmDeleteYes:$('#confirm-delete-yes-btn'),
    confirmDeleteNo: $('#confirm-delete-no-btn'),
    stackLeft:       $('#page-stack-left'),
    stackRight:      $('#page-stack-right'),
    toolbar:         $('#toolbar'),
    tocSidebar:      $('#toc-sidebar'),
    tocList:         $('#toc-list'),
    tocEmpty:        $('#toc-empty'),
    closeTocBtn:     $('#close-toc-btn'),
    sidebarOverlay:  $('#sidebar-overlay'),
    tocBtn:          $('#toc-btn'),
    openFileBtn:     $('#open-file-btn'),
    prevBtn:         $('#prev-btn'),
    nextBtn:         $('#next-btn'),
    pageInput:       $('#page-input'),
    totalPages:      $('#total-pages'),
    zoomOutBtn:      $('#zoom-out-btn'),
    zoomInBtn:       $('#zoom-in-btn'),
    zoomLevel:       $('#zoom-level'),
    fullscreenBtn:   $('#fullscreen-btn'),
    progressFill:    $('#progress-fill'),
    resumeModal:     $('#resume-modal'),
    resumePageNum:   $('#resume-page-num'),
    resumeYesBtn:    $('#resume-yes-btn'),
    resumeNoBtn:     $('#resume-no-btn'),
    loadingOverlay:  $('#loading-overlay'),
};

// ============================================================
// STATE
// ============================================================
let pdf = null;
let pageFlip = null;
let pdfFileName = '';
let pdfNumPages = 0;
let totalBookPages = 0;
let pageMap = [];          // bookIndex -> pdfPageNum (or null for blanks)
window.pageMap = pageMap; // Expose to annotations.js

let renderedHighRes = new Set();
let renderedLowRes = new Set();
let renderingInProgress = new Set();
let currentZoom = 1.0;
let pendingResumePage = null;
let bookPageWidth = 0;
let notes = []; // Array of { id, page, text, timestamp }
let pendingDeleteNoteId = null;
let pageElements = []; // Cached array of page DOM elements
let cachedOutline = null; // Cached PDF outline for ToC

const RENDER_SCALE = 2;   // canvas resolution multiplier
const PRE_RENDER_RANGE = 4;
const MAX_STACK_WIDTH = 10; // px

// ============================================================
// PAGE MAP — book index → PDF page mapping
// ============================================================
function buildPageMap(numPages) {
    if (numPages <= 0) return { map: [], total: 0 };
    if (numPages === 1) return { map: [1, null], total: 2 };
    if (numPages === 2) return { map: [1, 2], total: 2 };

    const innerCount = numPages - 2;
    const needsBlank = innerCount % 2 !== 0;
    const total = numPages + (needsBlank ? 1 : 0);
    const map = [1]; // front cover

    for (let p = 2; p < numPages; p++) map.push(p);
    if (needsBlank) map.push(null);
    map.push(numPages); // back cover

    return { map, total };
}

// ============================================================
// INDEXEDDB VAULT STORAGE
// ============================================================
const idb = {
    _db: null,
    _dbPromise: null,
    _openDB() {
        if (this._dbPromise) return this._dbPromise;
        this._dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open('reader-vault', 1);
            req.onupgradeneeded = () => req.result.createObjectStore('store');
            req.onsuccess = () => {
                this._db = req.result;
                resolve(this._db);
            };
            req.onerror = () => {
                this._dbPromise = null;
                reject(req.error);
            };
        });
        return this._dbPromise;
    },
    async get(key) {
        try {
            const db = await this._openDB();
            if (!db.objectStoreNames.contains('store')) return null;
            return new Promise((resolve) => {
                const tx = db.transaction('store', 'readonly');
                const getReq = tx.objectStore('store').get(key);
                getReq.onsuccess = () => resolve(getReq.result);
                getReq.onerror = () => resolve(null);
            });
        } catch (_) {
            return null;
        }
    },
    async set(key, val) {
        try {
            const db = await this._openDB();
            return new Promise((resolve) => {
                const tx = db.transaction('store', 'readwrite');
                tx.objectStore('store').put(val, key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            });
        } catch (_) {}
    }
};

let vaultHandle = null;

function updateLandingView() {
    if (!dom.welcomeView || !dom.libraryView || !dom.welcomeSelectBtn) return;
    if (vaultHandle) {
        vaultHandle.queryPermission({ mode: 'read' }).then(perm => {
            if (perm === 'granted') {
                dom.welcomeView.classList.add('hidden');
                dom.libraryView.classList.remove('hidden');
                if (dom.landingScreen) dom.landingScreen.classList.add('has-vault');
            } else {
                dom.welcomeView.classList.remove('hidden');
                dom.libraryView.classList.add('hidden');
                if (dom.landingScreen) dom.landingScreen.classList.remove('has-vault');
                const span = dom.welcomeSelectBtn.querySelector('span');
                if (span) span.textContent = `Unlock ${vaultHandle.name}`;
            }
        });
    } else {
        dom.welcomeView.classList.remove('hidden');
        dom.libraryView.classList.add('hidden');
        if (dom.landingScreen) dom.landingScreen.classList.remove('has-vault');
        const span = dom.welcomeSelectBtn.querySelector('span');
        if (span) span.textContent = 'Open Vault Folder';
    }
}

async function selectVault() {
    try {
        vaultHandle = await window.showDirectoryPicker({ mode: 'read' });
        await idb.set('vaultHandle', vaultHandle);
        await loadVault();
    } catch (e) {
        console.warn('Vault selection cancelled', e);
    }
}

async function initVault() {
    vaultHandle = await idb.get('vaultHandle');
    if (vaultHandle) {
        const perm = await vaultHandle.queryPermission({ mode: 'read' });
        if (perm === 'granted') {
            await loadVault();
        } else {
            updateLandingView();
        }
    } else {
        updateLandingView();
    }
}

// ============================================================
// FAVORITES HELPERS
// ============================================================
function getFavorites() {
    try {
        const raw = localStorage.getItem('reader_favorites');
        return raw ? JSON.parse(raw) : [];
    } catch (_) {
        return [];
    }
}

function isFavorite(fileName) {
    return getFavorites().includes(fileName);
}

function toggleFavorite(fileName) {
    let favs = getFavorites();
    const isNowFav = !favs.includes(fileName);
    if (favs.includes(fileName)) {
        favs = favs.filter(f => f !== fileName);
    } else {
        favs.push(fileName);
    }
    try {
        localStorage.setItem('reader_favorites', JSON.stringify(favs));
    } catch (_) {}
    return isNowFav;
}

async function loadVault() {
    if (dom.librarySections) dom.librarySections.innerHTML = '';
    if (dom.libraryName) dom.libraryName.textContent = vaultHandle ? vaultHandle.name : 'My Vault';
    
    const files = [];
    try {
        for await (const entry of vaultHandle.values()) {
            if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.pdf')) {
                files.push(entry);
            }
        }
    } catch (e) {
        console.error("Failed to read vault contents", e);
    }

    const filesWithMeta = [];
    for (const fileHandle of files) {
        let lastReadTime = 0;
        let lastReadPage = null;
        try {
            const bookmarkKey = 'reader_bookmark_' + fileHandle.name;
            const bookmarkRaw = localStorage.getItem(bookmarkKey);
            if (bookmarkRaw) {
                const data = JSON.parse(bookmarkRaw);
                if (data && data.timestamp) {
                    lastReadTime = data.timestamp;
                    lastReadPage = data.page;
                }
            }
        } catch (_) {}

        filesWithMeta.push({
            handle: fileHandle,
            fileName: fileHandle.name,
            cleanTitle: fileHandle.name.replace(/\.pdf$/i, ''),
            lastReadTime: lastReadTime,
            lastReadPage: lastReadPage,
            isFav: isFavorite(fileHandle.name)
        });
    }

    const count = filesWithMeta.length;
    if (dom.libraryCount) dom.libraryCount.textContent = `${count} Book${count === 1 ? '' : 's'}`;
    if (dom.libraryEmpty) dom.libraryEmpty.classList.toggle('visible', count === 0);
    
    if (count === 0) {
        updateLandingView();
        return;
    }

    // 1. Recently Read (books with lastReadTime > 0, sorted by lastReadTime descending)
    const recentlyRead = filesWithMeta
        .filter(f => f.lastReadTime > 0)
        .sort((a, b) => b.lastReadTime - a.lastReadTime);

    // 2. Favourites (books where isFav is true, sorted by title)
    const favourites = filesWithMeta
        .filter(f => f.isFav)
        .sort((a, b) => a.cleanTitle.localeCompare(b.cleanTitle));

    // 3. By Title (all books sorted alphabetically by cleanTitle)
    const byTitle = [...filesWithMeta].sort((a, b) => a.cleanTitle.localeCompare(b.cleanTitle));

    // Render category section helper
    function renderCategorySection(title, badgeText, items, iconSvg) {
        const section = document.createElement('div');
        section.className = 'library-section';

        const header = document.createElement('div');
        header.className = 'library-section-header';
        header.innerHTML = `
            <div class="library-section-title-wrap">
                ${iconSvg}
                <h3 class="library-section-title">${title}</h3>
                <span class="library-section-badge">${badgeText}</span>
            </div>
        `;
        section.appendChild(header);

        const grid = document.createElement('div');
        grid.className = 'library-grid';

        for (const item of items) {
            grid.appendChild(createBookCard(item));
        }
        section.appendChild(grid);

        dom.librarySections.appendChild(section);
    }

    // SVG Icons
    const recentIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="section-icon"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
    const favIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="var(--accent)" stroke="var(--accent)" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" class="section-icon"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
    const titleIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="section-icon"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;

    // 1. Render Recently Read (if any)
    if (recentlyRead.length > 0) {
        renderCategorySection('Recently Read', `${recentlyRead.length}`, recentlyRead, recentIcon);
    }

    // 2. Render Favourites (if any)
    if (favourites.length > 0) {
        renderCategorySection('Favourites', `${favourites.length}`, favourites, favIcon);
    }

    // 3. Render By Title (All Books)
    renderCategorySection('By Title', `${byTitle.length}`, byTitle, titleIcon);

    updateLandingView();
}

function createBookCard(item) {
    const card = document.createElement('div');
    card.className = 'book-item';

    const cover = document.createElement('div');
    cover.className = 'book-cover';

    const loading = document.createElement('div');
    loading.className = 'book-loading';
    loading.textContent = 'Loading...';

    // Favorite Star Button
    const favBtn = document.createElement('button');
    favBtn.className = 'fav-btn' + (item.isFav ? ' active' : '');
    favBtn.title = item.isFav ? 'Remove from Favourites' : 'Add to Favourites';
    favBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="${item.isFav ? 'var(--accent)' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
    
    favBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isNowFav = toggleFavorite(item.fileName);
        // Update in-place instead of rebuilding entire library
        item.isFav = isNowFav;
        favBtn.className = 'fav-btn' + (isNowFav ? ' active' : '');
        favBtn.title = isNowFav ? 'Remove from Favourites' : 'Add to Favourites';
        favBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="${isNowFav ? 'var(--accent)' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
    });

    cover.appendChild(loading);
    cover.appendChild(favBtn);



    card.appendChild(cover);

    // Click to open book
    card.addEventListener('click', async () => {
        const file = await item.handle.getFile();
        handleFile(file);
    });

    // Thumbnail loading
    item.handle.getFile().then(async (file) => {
        const cacheKey = `cover_${file.name}_${file.size}_${file.lastModified}`;
        const cachedDataUrl = await idb.get(cacheKey);

        if (cachedDataUrl) {
            loading.remove();
            const img = document.createElement('img');
            img.src = cachedDataUrl;
            img.loading = 'lazy';
            cover.insertBefore(img, favBtn);
        } else {
            generateThumbnail(file, cover, loading, cacheKey, favBtn);
        }
    }).catch(e => {
        loading.textContent = "Error";
    });

    return card;
}

async function generateThumbnail(file, coverDiv, loadingDiv, cacheKey, favBtn) {
    try {
        const data = await file.arrayBuffer();
        const doc = await pdfjsLib.getDocument({ data }).promise;
        const page = await doc.getPage(1);
        
        const viewport = page.getViewport({ scale: 0.4 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        
        await page.render({ canvasContext: ctx, viewport }).promise;
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        
        idb.set(cacheKey, dataUrl);
        
        loadingDiv.remove();
        const img = document.createElement('img');
        img.src = dataUrl;
        if (favBtn) {
            coverDiv.insertBefore(img, favBtn);
        } else {
            coverDiv.appendChild(img);
        }
        
        // Free the temporary PDF document to prevent memory leaks
        doc.destroy();
    } catch (e) {
        loadingDiv.textContent = "Error";
        console.error('Cover generation failed:', e);
    }
}

// ============================================================
// FILE LOADING
// ============================================================
let isFileLoading = false;
async function handleFile(file) {
    if (!file) return;
    const isPDF = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPDF) return;
    if (isFileLoading) return;
    isFileLoading = true;
    pdfFileName = file.name;
    showLoading(true);

    try {
        const data = await file.arrayBuffer();
        
        // Destroy previous PDF document to free memory
        if (pdf) {
            try { pdf.destroy(); } catch (_) {}
            pdf = null;
        }
        cachedOutline = null; // Reset cached outline
        
        pdf = await pdfjsLib.getDocument({ data }).promise;
        pdfNumPages = pdf.numPages;
        const pm = buildPageMap(pdfNumPages);
        pageMap = pm.map;
        window.pageMap = pageMap;
        totalBookPages = pm.total;

        dom.totalPages.textContent = pdfNumPages;
        dom.pageInput.max = pdfNumPages;

        // Check for a saved bookmark
        const savedPage = getSavedBookmark();
        if (savedPage && savedPage > 1) {
            pendingResumePage = savedPage;
        }

        // Switch screen first so bookArea has layout dimensions!
        showScreen('reader');

        loadNotesFromStorage();
        
        // Load per-file annotations
        if (window.annotationManager) {
            window.annotationManager.loadForFile(pdfFileName);
        }
        
        await initBook();

        if (pendingResumePage) {
            showResumeModal(pendingResumePage);
        }
    } catch (e) {
        console.error('PDF load error:', e);
        alert('Failed to open PDF: ' + e.message);
    } finally {
        showLoading(false);
        isFileLoading = false;
    }
}

// ============================================================
// BOOK INITIALIZATION (StPageFlip)
// ============================================================
async function initBook() {
    // Rescue stacks before clearing
    dom.bookArea.appendChild(dom.stackLeft);
    dom.bookArea.appendChild(dom.stackRight);

    // Destroy previous instance
    if (pageFlip) {
        try {
            pageFlip.destroy();
        } catch (e) {
            console.warn('PageFlip destroy error ignored:', e);
        }
        pageFlip = null;
    }
    
    // Completely recreate the book container to ensure StPageFlip starts fresh
    const oldContainer = dom.bookContainer;
    const newContainer = document.createElement('div');
    newContainer.id = 'book';
    newContainer.className = 'book-container';
    
    if (oldContainer && oldContainer.parentNode) {
        oldContainer.parentNode.replaceChild(newContainer, oldContainer);
    } else if (dom.bookArea) {
        // Fallback if the previous container was detached from the DOM during cleanup/destroy
        const stackRight = dom.bookArea.querySelector('.page-stack-right');
        if (stackRight) {
            dom.bookArea.insertBefore(newContainer, stackRight);
        } else {
            dom.bookArea.appendChild(newContainer);
        }
    }
    dom.bookContainer = newContainer;

    renderedHighRes.clear();
    renderedLowRes.clear();
    renderingInProgress.clear();

    // Get first page dimensions for aspect ratio
    const firstPage = await pdf.getPage(1);
    const baseVP = firstPage.getViewport({ scale: 1 });
    const pdfAspect = baseVP.width / baseVP.height;

    // Calculate page dimensions to fit viewport
    const areaRect = dom.bookArea.getBoundingClientRect();
    const areaH = areaRect.height * 0.95;
    const areaW = areaRect.width * 0.95;
    let pageH = areaH;
    let pageW = pageH * pdfAspect;
    if (pageW * 2 > areaW) {
        pageW = areaW / 2;
        pageH = pageW / pdfAspect;
    }
    bookPageWidth = pageW;

    // Create page elements
    for (let i = 0; i < totalBookPages; i++) {
        const div = document.createElement('div');
        div.className = 'page';
        div.dataset.bookIndex = i;

        // Hard covers
        if (i === 0 || i === totalBookPages - 1) {
            div.setAttribute('data-density', 'hard');
            div.classList.add('page-cover');
        }

        // Blank page
        if (pageMap[i] === null) {
            div.classList.add('page-blank');
        } else {
            // Add shimmer placeholder
            const shimmer = document.createElement('div');
            shimmer.className = 'page-loading';
            div.appendChild(shimmer);
        }

        dom.bookContainer.appendChild(div);
    }

    // Initialize StPageFlip
    pageFlip = new PageFlip(dom.bookContainer, {
        width:  Math.round(pageW),
        height: Math.round(pageH),
        size:   'fixed',
        minWidth:  280,
        maxWidth:  1400,
        minHeight: 380,
        maxHeight: 1800,
        drawShadow:       true,
        maxShadowOpacity: 0.5,
        showCover:        true,
        flippingTime:     800,
        usePortrait:      false,
        startPage:        0,
        autoSize:         true,
        clickEventForward: true,
        useMouseEvents:   true,
        swipeDistance:     30,
        showPageCorners:  true,
        mobileScrollSupport: false,
    });
    window.pageFlip = pageFlip; // Expose for annotations.js

    pageFlip.loadFromHTML(dom.bookContainer.querySelectorAll('.page'));

    // Cache page elements for O(1) lookups instead of repeated querySelectorAll
    pageElements = Array.from(dom.bookContainer.querySelectorAll('.page'));

    const wrapper = dom.bookContainer.querySelector('.stf__wrapper');
    if (wrapper) {
        wrapper.appendChild(dom.stackLeft);
        wrapper.appendChild(dom.stackRight);
    }

    // Events
    pageFlip.on('flip', onPageFlip);
    pageFlip.on('changeState', onStateChange);

    // Initial renders
    await preRenderAround(0);
    updateUI(0);
    updatePageStacks(0);
    updatePageNoteBadges();
}

// ============================================================
// PAGE RENDERING PIPELINE
// ============================================================
async function renderBookPage(bookIndex, isHighRes = true) {
    const pdfPageNum = pageMap[bookIndex];
    if (!pdfPageNum) {
        // Ensure blank pages render as clean, solid pages matching the book theme
        const pageDiv = pageElements[bookIndex];
        if (pageDiv) {
            const shimmer = pageDiv.querySelector('.page-loading');
            if (shimmer) shimmer.remove();
            let canvas = pageDiv.querySelector('canvas:not(.annotation-layer)');
            if (!canvas) {
                canvas = document.createElement('canvas');
                canvas.className = 'canvas-blank';
                canvas.width = 800;
                canvas.height = 1100;
                canvas.style.cssText = 'width:100%;height:100%;display:block;position:absolute;z-index:1;';
                
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#faf6ed'; // Paint cream background directly onto canvas pixels to bypass auto-dark inversion
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                
                pageDiv.appendChild(canvas);
            }
        }
        return;
    }
    
    // Check if already rendered at the requested resolution
    if (isHighRes) {
        if (renderedHighRes.has(bookIndex)) return;
        if (renderingInProgress.has(bookIndex + "_high")) return;
    } else {
        if (renderedLowRes.has(bookIndex) || renderedHighRes.has(bookIndex)) return;
        if (renderingInProgress.has(bookIndex + "_low")) return;
    }

    const renderKey = bookIndex + (isHighRes ? "_high" : "_low");
    renderingInProgress.add(renderKey);

    try {
        const page = await pdf.getPage(pdfPageNum);
        
        let requiredScale;
        if (isHighRes) {
            const dpr = window.devicePixelRatio || 1;
            const nativeVP = page.getViewport({ scale: 1 });
            const visualScale = currentZoom * 1.2;
            const physicalPixels = bookPageWidth * visualScale * dpr;
            requiredScale = physicalPixels / nativeVP.width;
        } else {
            // Low-res scales are small and extremely fast to render
            requiredScale = 0.4;
        }
        
        const viewport = page.getViewport({ scale: requiredScale });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.cssText = 'width:100%;height:100%;display:block;';
        if (!isHighRes) {
            canvas.classList.add('canvas-low-res');
        }

        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        
        let textLayerDiv = null;
        if (isHighRes) {
            // Render Text Layer ONLY for high-res pages (which are currently being read)
            const cssScale = bookPageWidth / page.getViewport({ scale: 1 }).width;
            const textViewport = page.getViewport({ scale: cssScale });
            const textContent = await page.getTextContent();
            
            textLayerDiv = document.createElement('div');
            textLayerDiv.className = 'textLayer';
            textLayerDiv.style.cssText = 'position: absolute; inset: 0; overflow: hidden; opacity: 1; z-index: 2;';
            
            const stopProp = (e) => e.stopPropagation();
            textLayerDiv.addEventListener('mousedown', stopProp);
            textLayerDiv.addEventListener('pointerdown', stopProp);
            textLayerDiv.addEventListener('touchstart', stopProp);
            
            const frag = document.createDocumentFragment();
            for (const item of textContent.items) {
                const span = document.createElement('span');
                span.textContent = item.str + (item.hasEOL ? '\n' : '');
                
                const [x, y] = textViewport.convertToViewportPoint(item.transform[4], item.transform[5]);
                const fontSize = Math.sqrt(item.transform[0] * item.transform[0] + item.transform[1] * item.transform[1]);
                const scaledFontSize = fontSize * cssScale;
                
                span.style.cssText = `
                    position: absolute;
                    left: ${x}px;
                    top: ${y - scaledFontSize}px;
                    font-size: ${scaledFontSize}px;
                    color: transparent;
                    cursor: text;
                    white-space: pre;
                    transform-origin: 0% 0%;
                    line-height: 1;
                `;
                
                frag.appendChild(span);
            }
            textLayerDiv.appendChild(frag);
        }

        const pageDiv = pageElements[bookIndex];
        if (pageDiv) {
            const shimmer = pageDiv.querySelector('.page-loading');
            if (shimmer) shimmer.remove();
            
            if (isHighRes) {
                const lowRes = pageDiv.querySelector('.canvas-low-res');
                if (lowRes) lowRes.remove();
                
                const old = pageDiv.querySelector('canvas:not(.annotation-layer):not(.canvas-low-res)');
                if (old) old.remove();
                
                const oldText = pageDiv.querySelector('.textLayer');
                if (oldText) oldText.remove();
                
                canvas.style.position = 'absolute';
                canvas.style.zIndex = '1';
                pageDiv.appendChild(canvas);
                pageDiv.appendChild(textLayerDiv);
                
                if (window.annotationManager) {
                    window.annotationManager.onPageRendered(pdfPageNum, pageDiv);
                }
                
                setTimeout(() => updatePageNoteBadges(), 50);
                
                renderedHighRes.add(bookIndex);
                renderedLowRes.delete(bookIndex);
            } else {
                const old = pageDiv.querySelector('canvas:not(.annotation-layer)');
                if (old) old.remove();
                
                canvas.style.position = 'absolute';
                canvas.style.zIndex = '1';
                pageDiv.appendChild(canvas);
                
                renderedLowRes.add(bookIndex);
            }
        }
    } catch (e) {
        console.warn(`Render failed for book page ${bookIndex}:`, e);
    } finally {
        renderingInProgress.delete(renderKey);
    }
}

async function preRenderAround(bookIndex) {
    const highResTasks = [];
    const lowResTasks = [];
    
    // High Priority: render current visible, previous, and next spreads in high-res
    // Open spread first page is always odd, so current spread is [bookIndex, bookIndex + 1].
    // Previous spread is [bookIndex - 2, bookIndex - 1].
    // Next spread is [bookIndex + 2, bookIndex + 3].
    for (let off = -2; off <= 3; off++) {
        const idx = bookIndex + off;
        if (idx >= 0 && idx < totalBookPages) {
            highResTasks.push(renderBookPage(idx, true));
        }
    }
    
    // Low Priority: render distant pages in low-res
    for (let off = -5; off <= 6; off++) {
        const idx = bookIndex + off;
        if (idx >= 0 && idx < totalBookPages) {
            // Only render low-res if we don't have it and it's outside the high-res spread range [-2, 3]
            const isOutsideHighResRange = off < -2 || off > 3;
            if (isOutsideHighResRange && !renderedHighRes.has(idx) && !renderedLowRes.has(idx)) {
                lowResTasks.push(renderBookPage(idx, false));
            }
        }
    }
    
    await Promise.all(highResTasks);
    
    setTimeout(() => {
        Promise.all(lowResTasks);
    }, 100);
}

// ============================================================
// EVENT HANDLERS
// ============================================================
function onPageFlip(e) {
    const bookIndex = e.data;
    updateUI(bookIndex);
    updatePageStacks(bookIndex);
    saveBookmark(bookIndex);
    updatePageNoteBadges();
}

function onStateChange(e) {
    // e.data can be: "read", "fold_corner", "flipping", "user_fold"
    const isResting = (e.data === 'read');
    dom.bookContainer.classList.toggle('is-flipping', !isResting);
    
    // We use fold_corner for the grab cursor hint
    if (e.data === 'fold_corner' || e.data === 'user_fold') {
        dom.bookContainer.style.cursor = 'grabbing';
    } else {
        dom.bookContainer.style.cursor = '';
    }
    
    if (isResting && pageFlip) {
        const bookIndex = pageFlip.getCurrentPageIndex();
        updateBookTransform(bookIndex); // Resync slide just in case
        preRenderAround(bookIndex);
    }
    
    // Trigger the slide animation immediately when flipping starts!
    if (e.data === 'flipping' && pageFlip) {
        const currentIndex = pageFlip.getCurrentPageIndex();
        let targetIndex = currentIndex;
        
        if (lastFlipDirection === 1) {
            // Flipping forward
            targetIndex = currentIndex + (currentIndex === 0 ? 1 : 2);
        } else {
            // Flipping backward
            targetIndex = currentIndex - (currentIndex === 1 ? 1 : 2);
        }
        
        // Clamp to valid bounds
        if (targetIndex < 0) targetIndex = 0;
        if (targetIndex >= totalBookPages) targetIndex = totalBookPages - 1;
        
        updateBookTransform(targetIndex);
    }
}

// ============================================================
// UI UPDATES
// ============================================================
function updateBookTransform(bookIndex) {
    if (!pageFlip) return;
    
    const pw = bookPageWidth;
    let stScale = 1;
    const wrapper = dom.bookContainer.querySelector('.stf__wrapper');
    if (wrapper && wrapper.style.transform) {
        const match = wrapper.style.transform.match(/scale\(([^)]+)\)/);
        if (match) stScale = parseFloat(match[1]);
    }
    
    let shiftX = 0;
    if (bookIndex === 0) {
        shiftX = -(pw * stScale / 2);
    } else if (bookIndex === totalBookPages - 1) {
        shiftX = (pw * stScale / 2);
    }
    
    // Apply the 1.2x default zoom requested by user
    const visualScale = currentZoom * 1.2;
    dom.bookContainer.style.transform = `scale(${visualScale}) translateX(${shiftX}px)`;
}

function updateUI(bookIndex) {
    // Determine which PDF page(s) are visible
    const pdfPage = pageMap[bookIndex] || pageMap[bookIndex + 1] || 1;
    dom.pageInput.value = pdfPage;
    updateComposerLabel(pdfPage);

    // Progress
    const progress = (bookIndex / Math.max(1, totalBookPages - 1)) * 100;
    dom.progressFill.style.width = progress + '%';
    
    // Toggle spine shadow (only visible when book is open)
    const isCover = bookIndex === 0 || bookIndex === totalBookPages - 1;
    dom.bookContainer.classList.toggle('is-open', !isCover);
    
    updateBookTransform(bookIndex);
}

function showScreen(name) {
    dom.landingScreen.classList.toggle('active', name === 'landing');
    dom.readerScreen.classList.toggle('active', name === 'reader');
}

function showLoading(visible) {
    dom.loadingOverlay.classList.toggle('visible', visible);
}



// ============================================================
// PAGE STACK EDGES
// ============================================================
function updatePageStacks(bookIndex) {
    const progress = bookIndex / Math.max(1, totalBookPages - 1);
    const leftW = Math.round(progress * MAX_STACK_WIDTH);
    const rightW = Math.round((1 - progress) * MAX_STACK_WIDTH);

    dom.stackLeft.style.width = leftW + 'px';
    dom.stackRight.style.width = rightW + 'px';

    const isCover = bookIndex === 0 || bookIndex === totalBookPages - 1;
    dom.stackLeft.classList.toggle('visible', leftW > 0 && !isCover);
    dom.stackRight.classList.toggle('visible', rightW > 0 && !isCover);
}

// ============================================================
// NAVIGATION
// ============================================================
function flipNext() {
    if (!pageFlip) return;
    const cur = pageFlip.getCurrentPageIndex();
    if (cur >= totalBookPages - 1) {
        triggerWobble();
        return;
    }
    pageFlip.flipNext();
}

function flipPrev() {
    if (!pageFlip) return;
    const cur = pageFlip.getCurrentPageIndex();
    if (cur <= 0) {
        triggerWobble();
        return;
    }
    pageFlip.flipPrev();
}

function navigateToPage(pdfPageNum) {
    if (!pageFlip) return;
    // Find book index for this PDF page
    let targetBookIndex = pageMap.indexOf(pdfPageNum);
    if (targetBookIndex < 0) {
        // Try closest
        targetBookIndex = Math.min(pdfPageNum - 1, totalBookPages - 1);
    }

    // In double-page mode, we must always land on the start (left) page of a spread.
    // Spread 0: index 0 (cover)
    // Spread 1: index 1 & 2
    // Spread 2: index 3 & 4
    // If targetBookIndex is even (and not the cover or back cover), subtract 1 to get the left page.
    if (targetBookIndex > 0 && targetBookIndex < totalBookPages - 1 && targetBookIndex % 2 === 0) {
        targetBookIndex = targetBookIndex - 1;
    }

    // Pre-render immediately so the page is fully rendered on arrival
    preRenderAround(targetBookIndex);

    const cur = pageFlip.getCurrentPageIndex();
    const diff = Math.abs(targetBookIndex - cur);

    if (diff === 0) return;

    if (diff <= 2) {
        pageFlip.flip(targetBookIndex);
    } else if (diff <= 8) {
        // Cascade: rapid sequential flips
        cascadeFlip(cur, targetBookIndex);
    } else {
        // Large jump: instant with slight delay to ensure DOM layout settles
        setTimeout(() => {
            pageFlip.turnToPage(targetBookIndex);
            onPageFlip({ data: targetBookIndex });
        }, 20);
    }
}

async function cascadeFlip(from, to) {
    const forward = to > from;
    const steps = Math.ceil(Math.abs(to - from) / 2);
    for (let i = 0; i < steps; i++) {
        // Guard: stop if we've reached the target or overshot
        const cur = pageFlip.getCurrentPageIndex();
        if (forward && cur >= to) break;
        if (!forward && cur <= to) break;
        
        if (forward) pageFlip.flipNext();
        else pageFlip.flipPrev();
        await sleep(90);
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}


// ============================================================
// RESISTANCE WOBBLE
// ============================================================
function triggerWobble() {
    dom.bookContainer.classList.add('wobble');
    dom.bookContainer.addEventListener('animationend', () => {
        dom.bookContainer.classList.remove('wobble');
    }, { once: true });
}

// ============================================================
// TABLE OF CONTENTS
// ============================================================
async function loadTableOfContents() {
    if (!pdf) return;
    try {
        // Use cached outline if available
        const outline = cachedOutline || (cachedOutline = await pdf.getOutline());
        dom.tocList.innerHTML = '';

        if (!outline || outline.length === 0) {
            dom.tocEmpty.classList.add('visible');
            dom.tocList.style.display = 'none';
            return;
        }

        dom.tocEmpty.classList.remove('visible');
        dom.tocList.style.display = '';

        await renderOutlineItems(outline, 0);
    } catch (e) {
        console.warn('ToC load error:', e);
        dom.tocEmpty.classList.add('visible');
    }
}

async function renderOutlineItems(items, depth) {
    for (const item of items) {
        const btn = document.createElement('button');
        btn.className = 'toc-item';
        if (depth > 0) btn.classList.add(`indent-${Math.min(depth, 2)}`);
        btn.textContent = item.title;

        // Resolve destination to page number
        let pageNum = 1;
        try {
            if (item.dest) {
                const dest = typeof item.dest === 'string'
                    ? await pdf.getDestination(item.dest)
                    : item.dest;
                if (dest) {
                    const idx = await pdf.getPageIndex(dest[0]);
                    pageNum = idx + 1;
                }
            }
        } catch (_) {}

        btn.addEventListener('click', () => {
            navigateToPage(pageNum);
            closeSidebar();
        });

        dom.tocList.appendChild(btn);

        if (item.items && item.items.length > 0) {
            await renderOutlineItems(item.items, depth + 1);
        }
    }
}

// ============================================================
// SIDEBAR
// ============================================================
function openSidebar() {
    dom.tocSidebar.classList.add('open');
    if (dom.notesSidebar) dom.notesSidebar.classList.remove('open');
    dom.sidebarOverlay.classList.add('visible');
    if (dom.bookArea) dom.bookArea.classList.add('notes-sidebar-open');
    loadTableOfContents();
}

function closeSidebar() {
    dom.tocSidebar.classList.remove('open');
    if (dom.notesSidebar) dom.notesSidebar.classList.remove('open');
    dom.sidebarOverlay.classList.remove('visible');
    if (dom.bookArea) dom.bookArea.classList.remove('notes-sidebar-open');
}

function openNotesSidebar() {
    if (!dom.notesSidebar || !dom.sidebarOverlay) return;
    dom.notesSidebar.classList.add('open');
    dom.sidebarOverlay.classList.add('visible');
    dom.tocSidebar.classList.remove('open');
    if (dom.bookArea) dom.bookArea.classList.add('notes-sidebar-open');
    renderNotes();
}

function closeNotesSidebar() {
    if (dom.notesSidebar) dom.notesSidebar.classList.remove('open');
    dom.sidebarOverlay.classList.remove('visible');
    if (dom.bookArea) dom.bookArea.classList.remove('notes-sidebar-open');
}

// ============================================================
// PERSONAL NOTEBOOK SYSTEM
// ============================================================
function loadNotesFromStorage() {
    try {
        const raw = localStorage.getItem('reader_notes_' + pdfFileName);
        notes = raw ? JSON.parse(raw) : [];
    } catch (_) {
        notes = [];
    }
}

function saveNotesToStorage() {
    try {
        localStorage.setItem('reader_notes_' + pdfFileName, JSON.stringify(notes));
    } catch (_) {}
    updatePageNoteBadges();
}

function renderNotes() {
    if (!dom.notesList) return;
    dom.notesList.innerHTML = '';
    
    const query = dom.notesSearch ? dom.notesSearch.value.toLowerCase() : '';
    
    const filtered = notes.filter(n => n.text.toLowerCase().includes(query));
    
    filtered.sort((a, b) => {
        if (a.page !== b.page) return a.page - b.page;
        return a.timestamp - b.timestamp;
    });
    
    if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'toc-empty visible';
        empty.textContent = query ? 'No matching notes found.' : 'No notes written yet.';
        dom.notesList.appendChild(empty);
        return;
    }
    
    filtered.forEach(note => {
        const card = document.createElement('div');
        card.className = 'note-card';
        card.dataset.id = note.id;
        card.dataset.page = note.page;
        
        const dateStr = new Date(note.timestamp).toLocaleDateString(undefined, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        
        card.innerHTML = `
            <div class="note-card-header">
                <span class="note-page-badge">Page ${note.page}</span>
                <span class="note-date">${dateStr}</span>
            </div>
            <div class="note-text">${escapeHtml(note.text)}</div>
            <div class="note-actions">
                <button class="note-action-btn edit-btn">Edit</button>
                <button class="note-action-btn delete-btn">Delete</button>
            </div>
        `;
        
        card.querySelector('.note-page-badge').addEventListener('click', () => {
            navigateToPage(note.page);
        });
        
        const editBtn = card.querySelector('.edit-btn');
        const deleteBtn = card.querySelector('.delete-btn');
        const textDiv = card.querySelector('.note-text');
        
        editBtn.addEventListener('click', () => {
            if (editBtn.textContent === 'Edit') {
                editBtn.textContent = 'Save';
                const textarea = document.createElement('textarea');
                textarea.className = 'note-text-edit';
                textarea.value = note.text;
                textDiv.replaceWith(textarea);
                textarea.focus();
            } else {
                const textarea = card.querySelector('.note-text-edit');
                const val = textarea.value.trim();
                if (val) {
                    note.text = val;
                    note.timestamp = Date.now();
                    saveNotesToStorage();
                    renderNotes();
                }
            }
        });
        
        deleteBtn.addEventListener('click', () => {
            showDeleteConfirmation(note.id);
        });
        
        dom.notesList.appendChild(card);
    });
}

function showDeleteConfirmation(noteId) {
    pendingDeleteNoteId = noteId;
    if (dom.confirmModal) dom.confirmModal.classList.add('visible');
}

function hideDeleteConfirmation() {
    pendingDeleteNoteId = null;
    if (dom.confirmModal) dom.confirmModal.classList.remove('visible');
}

function executeDeleteNote() {
    if (pendingDeleteNoteId) {
        notes = notes.filter(n => n.id !== pendingDeleteNoteId);
        saveNotesToStorage();
        renderNotes();
    }
    hideDeleteConfirmation();
}

function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function updateComposerLabel(pdfPage) {
    if (dom.composerPageLabel) {
        dom.composerPageLabel.textContent = `Add Note for Page ${pdfPage}`;
    }
}

function saveCurrentNote() {
    if (!dom.noteInput) return;
    const text = dom.noteInput.value.trim();
    if (!text) return;
    
    const currentPage = parseInt(dom.pageInput.value, 10) || 1;
    
    const newNote = {
        id: crypto.randomUUID(),
        page: currentPage,
        text: text,
        timestamp: Date.now()
    };
    
    notes.push(newNote);
    dom.noteInput.value = '';
    saveNotesToStorage();
    renderNotes();
}

function exportNotesToMarkdown() {
    if (notes.length === 0) {
        alert('No notes to export.');
        return;
    }
    
    const sorted = [...notes].sort((a, b) => {
        if (a.page !== b.page) return a.page - b.page;
        return a.timestamp - b.timestamp;
    });
    
    let md = `# Notes for ${pdfFileName}\n\n`;
    sorted.forEach(n => {
        const dateStr = new Date(n.timestamp).toLocaleString();
        md += `## Page ${n.page} _(${dateStr})_\n\n${n.text}\n\n---\n\n`;
    });
    
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${pdfFileName.replace(/\.pdf$/i, '')}_notes.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function updatePageNoteBadges() {
    if (!dom.bookContainer || pageElements.length === 0) return;
    
    // Only update badges for visible pages (current spread ± 1 spread)
    const currentIndex = pageFlip ? pageFlip.getCurrentPageIndex() : 0;
    const start = Math.max(0, currentIndex - 2);
    const end = Math.min(pageElements.length - 1, currentIndex + 3);
    
    for (let i = start; i <= end; i++) {
        const pageDiv = pageElements[i];
        if (!pageDiv) continue;
        const bookIndex = parseInt(pageDiv.dataset.bookIndex, 10);
        const pdfPageNum = pageMap[bookIndex];
        
        const existing = pageDiv.querySelector('.page-note-badge');
        if (existing) existing.remove();
        
        if (!pdfPageNum) continue;
        
        const hasNotes = notes.some(n => n.page === pdfPageNum);
        if (hasNotes) {
            const badge = document.createElement('div');
            badge.className = 'page-note-badge';
            badge.title = 'Click to view notes';
            badge.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                </svg>
            `;
            
            if (bookIndex % 2 !== 0) {
                badge.style.left = '12px';
            } else {
                badge.style.right = '12px';
            }
            
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                openNotesSidebar();
                
                const cards = dom.notesList.querySelectorAll('.note-card');
                cards.forEach(card => card.classList.remove('highlighted'));
                
                const card = dom.notesList.querySelector(`.note-card[data-page="${pdfPageNum}"]`);
                if (card) {
                    card.classList.add('highlighted');
                    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            });
            
            pageDiv.appendChild(badge);
        }
    }
}

// ============================================================
// BOOKMARKS / RESUME
// ============================================================
function getBookmarkKey() {
    return 'reader_bookmark_' + pdfFileName;
}

function saveBookmark(bookIndex) {
    const pdfPage = pageMap[bookIndex];
    if (!pdfPage) return;
    try {
        localStorage.setItem(getBookmarkKey(), JSON.stringify({
            page: pdfPage,
            timestamp: Date.now()
        }));
    } catch (_) {}
}

function getSavedBookmark() {
    try {
        const raw = localStorage.getItem(getBookmarkKey());
        if (!raw) return null;
        const data = JSON.parse(raw);
        return data.page || null;
    } catch (_) { return null; }
}

function showResumeModal(pdfPage) {
    dom.resumePageNum.textContent = pdfPage;
    dom.resumeModal.classList.add('visible');
}

function hideResumeModal() {
    dom.resumeModal.classList.remove('visible');
}

// ============================================================
// ZOOM
// ============================================================
function setZoom(level) {
    currentZoom = Math.max(0.5, Math.min(2.0, level));
    const cur = pageFlip ? pageFlip.getCurrentPageIndex() : 0;
    updateBookTransform(cur);
    dom.zoomLevel.textContent = Math.round(currentZoom * 100) + '%';
    
    // Only invalidate visible spread + neighbors (not ALL pages)
    const start = Math.max(0, cur - PRE_RENDER_RANGE);
    const end = Math.min(totalBookPages - 1, cur + PRE_RENDER_RANGE);
    for (let i = start; i <= end; i++) {
        renderedHighRes.delete(i);
        renderedLowRes.delete(i);
    }
    preRenderAround(cur);
}

// ============================================================
// FULLSCREEN
// ============================================================
function toggleFullscreen() {
    if (document.fullscreenElement) {
        document.exitFullscreen();
    } else {
        document.documentElement.requestFullscreen().catch(() => {});
    }
}

// ============================================================
// EVENT LISTENERS
// ============================================================

async function handleVaultAction() {
    if (vaultHandle) {
        const perm = await vaultHandle.queryPermission({ mode: 'read' });
        if (perm !== 'granted') {
            const req = await vaultHandle.requestPermission({ mode: 'read' });
            if (req === 'granted') {
                await loadVault();
                return;
            }
        }
    }
    selectVault();
}

if (dom.welcomeSelectBtn) {
    dom.welcomeSelectBtn.addEventListener('click', handleVaultAction);
}

if (dom.changeVaultBtn) {
    dom.changeVaultBtn.addEventListener('click', selectVault);
}

if (dom.backToLibraryBtn) {
    dom.backToLibraryBtn.addEventListener('click', () => {
        showScreen('landing');
        loadVault();
        closeNotesSidebar();
        // Save annotations before leaving
        if (window.annotationManager) {
            window.annotationManager.saveToStorage();
        }
        if (pageFlip) {
            pageFlip.destroy();
            pageFlip = null;
        }
        // Destroy PDF to free memory
        if (pdf) {
            try { pdf.destroy(); } catch (_) {}
            pdf = null;
        }
        cachedOutline = null;
        pageElements = [];
        if (dom.bookContainer) dom.bookContainer.innerHTML = '';
    });
}

// -- File loading --
if (dom.filePickerBtn && dom.fileInput) dom.filePickerBtn.addEventListener('click', (e) => { e.stopPropagation(); dom.fileInput.click(); });
if (dom.openFileBtn && dom.fileInput) dom.openFileBtn.addEventListener('click', () => dom.fileInput.click());
if (dom.fileInput) {
    dom.fileInput.addEventListener('change', (e) => {
        if (e.target.files[0]) handleFile(e.target.files[0]);
        e.target.value = '';
    });
}

if (dom.dropZone && dom.fileInput) {
    dom.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dom.dropZone.classList.add('drag-over'); });
    dom.dropZone.addEventListener('dragleave', () => dom.dropZone.classList.remove('drag-over'));
    dom.dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dom.dropZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
    });
    dom.dropZone.addEventListener('click', () => dom.fileInput.click());
}

// Prevent default drag behaviour on body
document.body.addEventListener('dragover', (e) => e.preventDefault());
document.body.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') handleFile(file);
});

// -- Navigation --
dom.prevBtn.addEventListener('click', flipPrev);
dom.nextBtn.addEventListener('click', flipNext);
dom.pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const val = parseInt(dom.pageInput.value, 10);
        if (val >= 1 && val <= pdfNumPages) navigateToPage(val);
    }
});

// ============================================================
// KEYBOARD / POINTER EVENTS
// ============================================================

let lastFlipDirection = 1;

window.addEventListener('pointerdown', (e) => {
    // Determine if the interaction is on the right half or left half of the screen
    lastFlipDirection = (e.clientX > window.innerWidth / 2) ? 1 : -1;
}, true); // Capture phase to ensure we record this before page-flip processes it

document.addEventListener('keydown', (e) => {
    if (!pageFlip) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    
    if (e.key === 'ArrowRight') lastFlipDirection = 1;
    if (e.key === 'ArrowLeft') lastFlipDirection = -1;
    
    switch (e.key) {
        case 'ArrowRight': flipNext(); break;
        case 'ArrowLeft':  flipPrev(); break;
        case 'f': case 'F': if (!e.ctrlKey && !e.metaKey) toggleFullscreen(); break;
    }
}, true);

// -- Sidebar & Notes --
if (dom.tocBtn) {
    dom.tocBtn.addEventListener('click', () => {
        if (dom.tocSidebar.classList.contains('open')) {
            closeSidebar();
        } else {
            openSidebar();
        }
    });
}
dom.closeTocBtn.addEventListener('click', closeSidebar);
dom.sidebarOverlay.addEventListener('click', () => {
    closeSidebar();
    closeNotesSidebar();
});

if (dom.notesBtn) {
    dom.notesBtn.addEventListener('click', () => {
        if (dom.notesSidebar.classList.contains('open')) {
            closeNotesSidebar();
        } else {
            openNotesSidebar();
        }
    });
}
if (dom.closeNotesBtn) dom.closeNotesBtn.addEventListener('click', closeNotesSidebar);
if (dom.saveNoteBtn) dom.saveNoteBtn.addEventListener('click', saveCurrentNote);
if (dom.exportNotesBtn) dom.exportNotesBtn.addEventListener('click', exportNotesToMarkdown);
if (dom.confirmDeleteYes) dom.confirmDeleteYes.addEventListener('click', executeDeleteNote);
if (dom.confirmDeleteNo) dom.confirmDeleteNo.addEventListener('click', hideDeleteConfirmation);
if (dom.notesSearch) {
    dom.notesSearch.addEventListener('input', () => renderNotes());
}
if (dom.noteInput) {
    dom.noteInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            saveCurrentNote();
        }
    });
}

// -- Zoom --
dom.zoomInBtn.addEventListener('click', () => setZoom(currentZoom + 0.1));
dom.zoomOutBtn.addEventListener('click', () => setZoom(currentZoom - 0.1));


// -- Fullscreen --
dom.fullscreenBtn.addEventListener('click', toggleFullscreen);

document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('is-fullscreen', !!document.fullscreenElement);
});

// -- Resume modal --
dom.resumeYesBtn.addEventListener('click', () => {
    const pageToResume = pendingResumePage;
    hideResumeModal();
    if (pageToResume) navigateToPage(pageToResume);
    pendingResumePage = null;
});
dom.resumeNoBtn.addEventListener('click', () => {
    hideResumeModal();
    pendingResumePage = null;
});



// INITIALIZATION
// ============================================================
initVault();
