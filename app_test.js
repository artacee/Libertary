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
    selectVaultBtn:  $('#select-vault-btn'),
    vaultPath:       $('#vault-path'),
    libraryGrid:     $('#library-grid'),
    libraryEmpty:    $('#library-empty'),
    backToLibraryBtn:$('#back-to-library-btn'),
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

let renderedPages = new Set();
let renderingInProgress = new Set();
let currentZoom = 1.0;
let pendingResumePage = null;
let bookPageWidth = 0;

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
    async get(key) {
        return new Promise((resolve) => {
            const req = indexedDB.open('reader-vault', 1);
            req.onupgradeneeded = () => req.result.createObjectStore('store');
            req.onsuccess = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('store')) return resolve(null);
                const tx = db.transaction('store', 'readonly');
                const getReq = tx.objectStore('store').get(key);
                getReq.onsuccess = () => resolve(getReq.result);
                getReq.onerror = () => resolve(null);
            };
            req.onerror = () => resolve(null);
        });
    },
    async set(key, val) {
        return new Promise((resolve) => {
            const req = indexedDB.open('reader-vault', 1);
            req.onupgradeneeded = () => req.result.createObjectStore('store');
            req.onsuccess = () => {
                const db = req.result;
                const tx = db.transaction('store', 'readwrite');
                tx.objectStore('store').put(val, key);
                tx.oncomplete = () => resolve();
            };
        });
    }
};

let vaultHandle = null;

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
            if (dom.vaultPath) dom.vaultPath.textContent = vaultHandle.name + " (Click to Unlock)";
        }
    }
}

async function loadVault() {
    if (dom.vaultPath) dom.vaultPath.textContent = vaultHandle.name;
    if (dom.libraryGrid) dom.libraryGrid.innerHTML = '';
    let found = 0;
    
    try {
        for await (const entry of vaultHandle.values()) {
            if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.pdf')) {
                found++;
                addBookToLibrary(entry);
            }
        }
    } catch (e) {
        console.error("Failed to read vault contents", e);
    }
    
    if (dom.libraryEmpty) dom.libraryEmpty.classList.toggle('visible', found === 0);
}

function addBookToLibrary(fileHandle) {
    if (!dom.libraryGrid) return;
    const item = document.createElement('div');
    item.className = 'book-item';
    
    const cover = document.createElement('div');
    cover.className = 'book-cover';
    
    const loading = document.createElement('div');
    loading.className = 'book-loading';
    loading.textContent = 'Loading...';
    
    cover.appendChild(loading);
    item.appendChild(cover);
    
    item.addEventListener('click', async () => {
        const file = await fileHandle.getFile();
        handleFile(file);
    });
    
    dom.libraryGrid.appendChild(item);
    
    // Generate thumbnail asynchronously
    generateThumbnail(fileHandle, cover, loading);
}

async function generateThumbnail(fileHandle, coverDiv, loadingDiv) {
    try {
        const file = await fileHandle.getFile();
        const data = await file.arrayBuffer();
        const doc = await pdfjsLib.getDocument({ data }).promise;
        const page = await doc.getPage(1);
        
        const viewport = page.getViewport({ scale: 0.5 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        
        await page.render({ canvasContext: ctx, viewport }).promise;
        
        loadingDiv.remove();
        coverDiv.appendChild(canvas);
    } catch (e) {
        loadingDiv.textContent = "Error";
    }
}

// ============================================================
// FILE LOADING
// ============================================================
let isFileLoading = false;
async function handleFile(file) {
    if (!file || file.type !== 'application/pdf') return;
    if (isFileLoading) return;
    isFileLoading = true;
    pdfFileName = file.name;
    showLoading(true);

    try {
        const data = await file.arrayBuffer();
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
    oldContainer.parentNode.replaceChild(newContainer, oldContainer);
    dom.bookContainer = newContainer;

    renderedPages.clear();
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
    dom.bookContainer.style.transition = 'transform 0.8s ease';
    updateUI(0);
    updatePageStacks(0);
}

// ============================================================
// PAGE RENDERING PIPELINE
// ============================================================
async function renderBookPage(bookIndex) {
    const pdfPageNum = pageMap[bookIndex];
    if (!pdfPageNum) return; // blank page
    if (renderedPages.has(bookIndex)) return;
    if (renderingInProgress.has(bookIndex)) return;

    renderingInProgress.add(bookIndex);

    try {
        const page = await pdf.getPage(pdfPageNum);
        
        const dpr = window.devicePixelRatio || 1;
        const nativeVP = page.getViewport({ scale: 1 });
        const visualScale = currentZoom * 1.2;
        const physicalPixels = bookPageWidth * visualScale * dpr;
        const requiredScale = physicalPixels / nativeVP.width;
        
        const viewport = page.getViewport({ scale: requiredScale });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.cssText = 'width:100%;height:100%;display:block;';

        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;
        
        // Render Text Layer for native selection manually (since renderTextLayer was removed from v4 core)
        const cssScale = bookPageWidth / nativeVP.width;
        const textViewport = page.getViewport({ scale: cssScale });
        const textContent = await page.getTextContent();
        
        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'textLayer';
        textLayerDiv.style.cssText = 'position: absolute; inset: 0; overflow: hidden; opacity: 1; z-index: 2;';
        
        // Stop propagation so StPageFlip doesn't prevent default text selection
        const stopProp = (e) => e.stopPropagation();
        textLayerDiv.addEventListener('mousedown', stopProp);
        textLayerDiv.addEventListener('pointerdown', stopProp);
        textLayerDiv.addEventListener('touchstart', stopProp);
        
        // Build text spans manually for selection
        for (const item of textContent.items) {
            const span = document.createElement('span');
            span.textContent = item.str + (item.hasEOL ? '\n' : '');
            
            // Item transform is [scaleX, skewY, skewX, scaleY, tx, ty]
            // We can map tx, ty (which are in PDF points) to the CSS viewport
            const [x, y] = textViewport.convertToViewportPoint(item.transform[4], item.transform[5]);
            
            // The font size is roughly item.transform[0] (or Math.sqrt(scaleX^2 + skewY^2))
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
            
            textLayerDiv.appendChild(span);
        }

        // Replace shimmer with canvas
        const pageDiv = dom.bookContainer.querySelectorAll('.page')[bookIndex];
        if (pageDiv) {
            const shimmer = pageDiv.querySelector('.page-loading');
            if (shimmer) shimmer.remove();
            // Remove any old canvas
            const old = pageDiv.querySelector('canvas:not(.annotation-layer)');
            if (old) old.remove();
            
            // Remove old text layer
            const oldText = pageDiv.querySelector('.textLayer');
            if (oldText) oldText.remove();
            
            // Ensure the main PDF canvas is below any annotation layers
            canvas.style.position = 'absolute';
            canvas.style.zIndex = '1';
            pageDiv.appendChild(canvas);
            pageDiv.appendChild(textLayerDiv);
            
            // Notify annotation manager
            if (window.annotationManager) {
                window.annotationManager.onPageRendered(pdfPageNum, pageDiv);
            }
        }

        renderedPages.add(bookIndex);
    } catch (e) {
        console.warn(`Render failed for book page ${bookIndex}:`, e);
    } finally {
        renderingInProgress.delete(bookIndex);
    }
}

async function preRenderAround(bookIndex) {
    const tasks = [];
    for (let off = 0; off <= PRE_RENDER_RANGE; off++) {
        if (bookIndex + off < totalBookPages) tasks.push(renderBookPage(bookIndex + off));
        if (off > 0 && bookIndex - off >= 0) tasks.push(renderBookPage(bookIndex - off));
    }
    await Promise.all(tasks);
}

// ============================================================
// EVENT HANDLERS
// ============================================================
function onPageFlip(e) {
    const bookIndex = e.data;
    updateUI(bookIndex);
    updatePageStacks(bookIndex);
    saveBookmark(bookIndex);
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
        preRenderAround(bookIndex);
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

    const cur = pageFlip.getCurrentPageIndex();
    const diff = Math.abs(targetBookIndex - cur);

    if (diff === 0) return;

    if (diff <= 2) {
        pageFlip.flip(targetBookIndex);
    } else if (diff <= 8) {
        // Cascade: rapid sequential flips
        cascadeFlip(cur, targetBookIndex);
    } else {
        // Large jump: instant
        pageFlip.turnToPage(targetBookIndex);
        onPageFlip({ data: targetBookIndex });
    }
}

async function cascadeFlip(from, to) {
    const forward = to > from;
    const steps = Math.ceil(Math.abs(to - from) / 2);
    for (let i = 0; i < steps; i++) {
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
        const outline = await pdf.getOutline();
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
    dom.sidebarOverlay.classList.add('visible');
    loadTableOfContents();
}

function closeSidebar() {
    dom.tocSidebar.classList.remove('open');
    dom.sidebarOverlay.classList.remove('visible');
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
    pendingResumePage = null;
}

// ============================================================
// ZOOM
// ============================================================
function setZoom(level) {
    currentZoom = Math.max(0.5, Math.min(2.0, level));
    const cur = pageFlip ? pageFlip.getCurrentPageIndex() : 0;
    updateBookTransform(cur);
    dom.zoomLevel.textContent = Math.round(currentZoom * 100) + '%';
    
    // Re-render visible pages for crisp text at new scale
    renderedPages.clear();
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

if (dom.selectVaultBtn) {
    dom.selectVaultBtn.addEventListener('click', async () => {
        if (vaultHandle && await vaultHandle.queryPermission({ mode: 'read' }) !== 'granted') {
            const perm = await vaultHandle.requestPermission({ mode: 'read' });
            if (perm === 'granted') {
                await loadVault();
                return;
            }
        }
        selectVault();
    });
}

if (dom.backToLibraryBtn) {
    dom.backToLibraryBtn.addEventListener('click', () => {
        showScreen('landing');
        if (pageFlip) {
            pageFlip.destroy();
            pageFlip = null;
        }
        if (dom.bookContainer) dom.bookContainer.innerHTML = '';
    });
}

// -- File loading --
if (dom.filePickerBtn) dom.filePickerBtn.addEventListener('click', (e) => { e.stopPropagation(); dom.fileInput.click(); });
if (dom.openFileBtn) dom.openFileBtn.addEventListener('click', () => dom.fileInput.click());
dom.fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
    e.target.value = '';
});

if (dom.dropZone) {
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

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (!pageFlip) return;
    if (e.target.tagName === 'INPUT') return;
    switch (e.key) {
        case 'ArrowRight': flipNext(); break;
        case 'ArrowLeft':  flipPrev(); break;
        case 'f': case 'F': if (!e.ctrlKey && !e.metaKey) toggleFullscreen(); break;
    }
});

// -- Sidebar --
dom.tocBtn.addEventListener('click', openSidebar);
dom.closeTocBtn.addEventListener('click', closeSidebar);
dom.sidebarOverlay.addEventListener('click', closeSidebar);

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
    hideResumeModal();
    if (pendingResumePage) navigateToPage(pendingResumePage);
    pendingResumePage = null;
});
dom.resumeNoBtn.addEventListener('click', hideResumeModal);

// -- Window resize --
window.addEventListener('resize', () => {
    // CSS positioning handles most resizing automatically now
});

// INITIALIZATION
// ============================================================
initVault();
