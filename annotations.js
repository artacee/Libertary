/**
 * annotations.js
 * Handles Laser Pointer, Pen, Highlighter, and Eraser logic.
 */

class AnnotationManager {
    constructor() {
        this.activeTool = null; // 'laser', 'pen', 'eraser'
        this.pageStrokes = new Map(); // pageIndex -> array of strokes
        this.history = []; // stack of Map snapshots
        this.isDrawing = false;
        this.currentStroke = null;
        this.laserCanvas = document.getElementById('laser-canvas');
        this.laserCtx = this.laserCanvas.getContext('2d');
        this.currentFileName = ''; // tracks which PDF annotations are loaded for
        
        // Ephemeral laser points
        this.laserPoints = [];
        this.lastLaserTime = 0;
        this.laserLoopRunning = false;
        this._resizeTimer = null;
        
        this.bindEvents();
    }
    
    _getStorageKey() {
        return 'pdf-annotations_' + this.currentFileName;
    }

    loadForFile(fileName) {
        // Save any existing annotations for the previous file
        if (this.currentFileName && this.pageStrokes.size > 0) {
            this.saveToStorage();
        }
        this.currentFileName = fileName;
        this.pageStrokes = new Map();
        this.history = [];
        const stored = localStorage.getItem(this._getStorageKey());
        if (stored) {
            try {
                const parsed = JSON.parse(stored);
                for (const [page, strokes] of Object.entries(parsed)) {
                    this.pageStrokes.set(parseInt(page), strokes);
                }
            } catch (e) {
                console.error("Failed to parse annotations", e);
            }
        }
    }
    
    saveToStorage() {
        if (!this.currentFileName) return;
        const obj = {};
        for (const [page, strokes] of this.pageStrokes.entries()) {
            obj[page] = strokes;
        }
        localStorage.setItem(this._getStorageKey(), JSON.stringify(obj));
    }

    setTool(tool) {
        const prevTool = this.activeTool;
        this.activeTool = tool;
        document.body.classList.remove('is-laser-mode', 'is-pen-mode', 'is-eraser-mode');
        
        if (tool) {
            document.body.classList.add(`is-${tool}-mode`);
            if (window.pageFlip) {
                window.pageFlip.update({ useMouseEvents: false });
            }
            this.resize();
        } else {
            if (window.pageFlip) {
                window.pageFlip.update({ useMouseEvents: true });
            }
        }
        
        // Start/stop laser animation loop on demand
        if (tool === 'laser' && !this.laserLoopRunning) {
            this.startLaserLoop();
        } else if (prevTool === 'laser' && tool !== 'laser') {
            this.stopLaserLoop();
        }
    }
    
    resize() {
        const rect = this.laserCanvas.parentElement.getBoundingClientRect();
        this.laserCanvas.width = rect.width;
        this.laserCanvas.height = rect.height;
    }

    bindEvents() {
        // Debounced resize
        window.addEventListener('resize', () => {
            clearTimeout(this._resizeTimer);
            this._resizeTimer = setTimeout(() => this.resize(), 150);
        });
        this.resize();

        // Left click drawing (Laser / Pen / Eraser)
        this.laserCanvas.addEventListener('pointerdown', this.onPointerDown.bind(this));
        this.laserCanvas.addEventListener('pointermove', this.onPointerMove.bind(this));
        window.addEventListener('pointerup', this.onPointerUp.bind(this));
        
        // Right click highlighting (Global) - Removed for Text Selection

        // True Text Selection Highlight
        document.addEventListener('mouseup', this.onDocumentMouseUp.bind(this));
        
        // Undo (Ctrl+Z)
        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                this.undo();
                e.preventDefault();
            }
        });
    }

    getMousePos(e) {
        const rect = this.laserCanvas.getBoundingClientRect();
        return {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
    }
    
    // Convert screen coordinates to normalized page coordinates (0 to 1)
    screenToPageCoords(screenX, screenY) {
        if (!window.pageFlip) return null;
        const bookIndex = window.pageFlip.getCurrentPageIndex();
        const bookContainer = document.getElementById('book');
        const stWrapper = bookContainer.querySelector('.stf__wrapper');
        if (!stWrapper) return null;
        
        // Get the actual transformed bounds of the stf__block
        const stfBlock = stWrapper.querySelector('.stf__block');
        if (!stfBlock) return null;
        
        const rect = stfBlock.getBoundingClientRect();
        
        // If mouse is outside the block bounds, it's not on a page
        if (screenX < rect.left || screenX > rect.right || screenY < rect.top || screenY > rect.bottom) {
            return null;
        }
        
        // Block is 2 pages wide
        const blockWidth = rect.width;
        const pageWidth = blockWidth / 2;
        
        const isRightPage = screenX > (rect.left + pageWidth);
        
        // Normalize 0 to 1 relative to the specific page
        // Normalize 0 to 1 relative to the specific page
        let normX, normY, pageLeft;
        if (isRightPage) {
            pageLeft = rect.left + pageWidth;
            normX = (screenX - pageLeft) / pageWidth;
        } else {
            pageLeft = rect.left;
            normX = (screenX - pageLeft) / pageWidth;
        }
        normY = (screenY - rect.top) / rect.height;
        
        // PDF page index corresponding to left or right
        let pageIndex;
        if (bookIndex === 0) {
            // Front cover: Left side is empty, Right side is index 0
            if (isRightPage) pageIndex = 0;
            else return null;
        } else {
            // Inner spreads: Left side is bookIndex, Right side is bookIndex + 1
            if (isRightPage) pageIndex = bookIndex + 1;
            else pageIndex = bookIndex;
        }
        
        const pdfPage = window.pageMap ? window.pageMap[pageIndex] : null;
        if (!pdfPage) return null;
        
        return {
            pdfPage: pdfPage,
            x: normX,
            y: normY,
            pageLeft: pageLeft,
            pageTop: rect.top,
            pageWidth: pageWidth,
            pageHeight: rect.height
        };
    }

    onDocumentMouseUp(e) {
        if (this.activeTool === 'highlight') {
            this.captureTextHighlight();
        }
    }

    captureTextHighlight() {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) return;
        
        const range = selection.getRangeAt(0);
        const rawRects = Array.from(range.getClientRects());
        if (rawRects.length === 0) return;
        
        // Merge rects line-by-line to fill gaps between words
        const lines = [];
        for (let r of rawRects) {
            const centerY = r.top + r.height / 2;
            let foundLine = false;
            for (let line of lines) {
                // If within a few pixels vertically, it's the same line
                if (Math.abs(line.centerY - centerY) < (r.height * 0.5)) {
                    line.rects.push(r);
                    foundLine = true;
                    break;
                }
            }
            if (!foundLine) {
                lines.push({ centerY: centerY, rects: [r] });
            }
        }
        
        const mergedRects = [];
        for (let line of lines) {
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (let r of line.rects) {
                if (r.left < minX) minX = r.left;
                if (r.right > maxX) maxX = r.right;
                if (r.top < minY) minY = r.top;
                if (r.bottom > maxY) maxY = r.bottom;
            }
            // Expand slightly to cover small spaces (padding)
            minX -= 2;
            maxX += 2;
            mergedRects.push({
                left: minX,
                top: minY,
                width: maxX - minX,
                height: maxY - minY
            });
        }
        
        // Group rects by page
        const highlightsByPage = new Map();
        
        for (let rect of mergedRects) {
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            
            const pageCoord = this.screenToPageCoords(cx, cy);
            if (!pageCoord || !pageCoord.pdfPage) continue;
            
            const pdfPage = pageCoord.pdfPage;
            if (!highlightsByPage.has(pdfPage)) highlightsByPage.set(pdfPage, []);
            
            const normRect = {
                x: (rect.left - pageCoord.pageLeft) / pageCoord.pageWidth,
                y: (rect.top - pageCoord.pageTop) / pageCoord.pageHeight,
                w: rect.width / pageCoord.pageWidth,
                h: rect.height / pageCoord.pageHeight
            };
            
            // Add a tiny padding to the rect to make the highlight look better
            normRect.y -= 0.002;
            normRect.h += 0.004;
            
            highlightsByPage.get(pdfPage).push(normRect);
        }
        
        for (const [pdfPage, normRects] of highlightsByPage.entries()) {
            const stroke = {
                type: 'text-highlight',
                page: pdfPage,
                rects: normRects,
                color: 'rgba(255, 235, 59, 1.0)' // True yellow, multiplied via CSS
            };
            this.addStroke(pdfPage, stroke);
        }
        
        selection.removeAllRanges();
    }

    onPointerDown(e) {
        if (!this.activeTool || e.button !== 0) return;
        this.isDrawing = true;
        const pos = this.getMousePos(e);
        
        if (this.activeTool === 'laser') {
            this.startLaserLoop();
            this.laserPoints.push({
                x: pos.x,
                y: pos.y,
                time: Date.now(),
                gap: this.laserPoints.length > 0
            });
        } else if (this.activeTool === 'pen') {
            const pageCoord = this.screenToPageCoords(e.clientX, e.clientY);
            if (pageCoord && pageCoord.pdfPage) {
                this.currentStroke = {
                    type: 'pen',
                    page: pageCoord.pdfPage,
                    points: [{ x: pageCoord.x, y: pageCoord.y }],
                    color: '#222222',
                    width: 3
                };
            }
        } else if (this.activeTool === 'eraser') {
            this.eraseAt(e.clientX, e.clientY);
        }
    }

    onPointerMove(e) {
        if (!this.isDrawing) return;
        const pos = this.getMousePos(e);
        
        if (this.activeTool === 'laser') {
            this.laserPoints.push({ x: pos.x, y: pos.y, time: Date.now() });
        } else if (this.activeTool === 'pen' && this.currentStroke) {
            const pageCoord = this.screenToPageCoords(e.clientX, e.clientY);
            if (pageCoord && pageCoord.pdfPage === this.currentStroke.page) {
                this.currentStroke.points.push({ x: pageCoord.x, y: pageCoord.y });
                // We must re-render the page to show the live stroke
                this.reRenderPage(this.currentStroke.page);
            }
        } else if (this.activeTool === 'eraser') {
            this.eraseAt(e.clientX, e.clientY);
        }
    }

    onPointerUp(e) {
        if (!this.isDrawing) return;
        this.isDrawing = false;
        
        if (this.activeTool === 'pen' && this.currentStroke) {
            this.addStroke(this.currentStroke.page, this.currentStroke);
            this.currentStroke = null;
        }
    }
    
    undo() {
        if (this.history.length === 0) return;
        const previousState = this.history.pop();
        
        const pagesToRender = new Set();
        for (const page of this.pageStrokes.keys()) pagesToRender.add(page);
        for (const page of previousState.keys()) pagesToRender.add(page);
        
        this.pageStrokes = previousState;
        
        for (const page of pagesToRender) {
            this.reRenderPage(page);
        }
        this.saveToStorage();
    }
    
    saveState() {
        const snapshot = new Map();
        for (const [page, strokes] of this.pageStrokes.entries()) {
            snapshot.set(page, [...strokes]);
        }
        this.history.push(snapshot);
        if (this.history.length > 50) this.history.shift();
    }
    
    addStroke(pdfPage, stroke) {
        this.saveState();
        if (!this.pageStrokes.has(pdfPage)) {
            this.pageStrokes.set(pdfPage, []);
        }
        this.pageStrokes.get(pdfPage).push(stroke);
        this.reRenderPage(pdfPage);
        this.saveToStorage();
    }
    
    eraseAt(clientX, clientY) {
        const pageCoord = this.screenToPageCoords(clientX, clientY);
        if (!pageCoord || !pageCoord.pdfPage) return;
        
        const strokes = this.pageStrokes.get(pageCoord.pdfPage);
        if (!strokes) return;
        
        // Find if the point intersects any stroke (simple distance check)
        const threshold = 0.05; // 5% of page width (easier to hit thick highlights)
        
        let modified = false;
        const newStrokes = strokes.filter(stroke => {
            if (stroke.type === 'text-highlight') {
                for (let r of stroke.rects) {
                    if (pageCoord.x >= r.x - threshold && pageCoord.x <= r.x + r.w + threshold &&
                        pageCoord.y >= r.y - threshold && pageCoord.y <= r.y + r.h + threshold) {
                        modified = true;
                        return false; // erase
                    }
                }
            } else {
                // Point-to-segment distance for pen strokes (perfect hit detection)
                if (stroke.points.length === 1) {
                    const dx = stroke.points[0].x - pageCoord.x;
                    const dy = stroke.points[0].y - pageCoord.y;
                    if (dx*dx + dy*dy < threshold*threshold) {
                        modified = true;
                        return false;
                    }
                } else {
                    for (let i = 0; i < stroke.points.length - 1; i++) {
                        const v = stroke.points[i];
                        const w = stroke.points[i+1];
                        const l2 = (w.x - v.x)*(w.x - v.x) + (w.y - v.y)*(w.y - v.y);
                        let t = 0;
                        if (l2 !== 0) {
                            t = ((pageCoord.x - v.x) * (w.x - v.x) + (pageCoord.y - v.y) * (w.y - v.y)) / l2;
                            t = Math.max(0, Math.min(1, t));
                        }
                        const projX = v.x + t * (w.x - v.x);
                        const projY = v.y + t * (w.y - v.y);
                        const dist2 = (pageCoord.x - projX)*(pageCoord.x - projX) + (pageCoord.y - projY)*(pageCoord.y - projY);
                        
                        if (dist2 < threshold*threshold) {
                            modified = true;
                            return false; // erase
                        }
                    }
                }
            }
            return true;
        });
        
        if (modified) {
            this.saveState();
            this.pageStrokes.set(pageCoord.pdfPage, newStrokes);
            this.reRenderPage(pageCoord.pdfPage);
            this.saveToStorage();
        }
    }
    
    reRenderPage(pdfPage) {
        // Force the specific page canvas to update with strokes
        this.drawStrokesOnCanvas(pdfPage, this.pageStrokes.get(pdfPage));
    }
    
    // Draw strokes onto a specific page canvas
    drawStrokesOnCanvas(pdfPage, strokes) {
        
        // Find the canvas element for this pdf page
        // Since we create pages dynamically, we need to locate the wrapper with data-pdf-page
        const pageWrappers = document.querySelectorAll('.page');
        let targetCanvas = null;
        for (let wrapper of pageWrappers) {
            if (wrapper.dataset.pdfPage == pdfPage) {
                // Get the MAIN canvas (the one rendering the PDF, which has z-index 1 or no class)
                targetCanvas = wrapper.querySelector('canvas:not(.annotation-layer)');
                break;
            }
        }
        
        if (!targetCanvas) return;
        
        const ctx = targetCanvas.getContext('2d');
        const width = targetCanvas.width;
        const height = targetCanvas.height;
        
        // We only want to draw strokes ON TOP of the PDF.
        // Wait, if we just draw on it, it accumulates forever unless we re-render the PDF.
        // If we want it to be fast, we need a separate annotation canvas per page OR we re-render the PDF.
        // Re-rendering PDF is slow. Let's add an annotation layer canvas to each `.page`!
        
        // We'll look for or create a canvas with class 'annotation-layer'
        let annoLayer = targetCanvas.parentElement.querySelector('.annotation-layer');
        if (!annoLayer) {
            annoLayer = document.createElement('canvas');
            annoLayer.className = 'annotation-layer';
            annoLayer.width = width;
            annoLayer.height = height;
            annoLayer.style.position = 'absolute';
            annoLayer.style.inset = '0';
            annoLayer.style.width = '100%';
            annoLayer.style.height = '100%';
            annoLayer.style.pointerEvents = 'none';
            annoLayer.style.zIndex = '10'; // Above PDF canvas
            annoLayer.style.mixBlendMode = 'multiply'; // Makes highlights blend perfectly with text
            targetCanvas.parentElement.appendChild(annoLayer);
        }
        
        const aCtx = annoLayer.getContext('2d');
        aCtx.clearRect(0, 0, width, height);
        
        if (!strokes || strokes.length === 0) return;
        
        // If there's an active stroke being drawn for this page, include it
        const allStrokes = [...strokes];
        if (this.currentStroke && this.currentStroke.page === pdfPage && this.activeTool === 'pen') {
            allStrokes.push(this.currentStroke);
        }
        
        for (let stroke of allStrokes) {
            if (stroke.type === 'text-highlight') {
                aCtx.fillStyle = stroke.color;
                for (let r of stroke.rects) {
                    aCtx.fillRect(r.x * width, r.y * height, r.w * width, r.h * height);
                }
            } else {
                if (stroke.points.length < 2) continue;
                
                aCtx.beginPath();
                aCtx.moveTo(stroke.points[0].x * width, stroke.points[0].y * height);
                for (let i = 1; i < stroke.points.length; i++) {
                    aCtx.lineTo(stroke.points[i].x * width, stroke.points[i].y * height);
                }
                
                aCtx.strokeStyle = stroke.color;
                // Scale line width relative to page width (e.g. width=3 on 800px page)
                aCtx.lineWidth = (stroke.width / 800) * width;
                aCtx.lineCap = 'round';
                aCtx.lineJoin = 'round';
                
                aCtx.stroke();
            }
        }
    }
    
    // Called externally whenever a page finishes rendering the PDF
    onPageRendered(pdfPage, wrapperElement) {
        // Tag the wrapper so we can find it
        wrapperElement.dataset.pdfPage = pdfPage;
        
        const strokes = this.pageStrokes.get(pdfPage);
        if (strokes && strokes.length > 0) {
            this.drawStrokesOnCanvas(pdfPage, strokes);
        }
    }

    startLaserLoop() {
        if (this.laserLoopRunning) return;
        this.laserLoopRunning = true;
        const loop = (timestamp) => {
            if (!this.laserLoopRunning) {
                this.laserCtx.clearRect(0, 0, this.laserCanvas.width, this.laserCanvas.height);
                return; // Stop the loop
            }
            
            this.laserCtx.clearRect(0, 0, this.laserCanvas.width, this.laserCanvas.height);
            
            const now = Date.now();
            
            if (this.isDrawing && this.activeTool === 'laser') {
                for (let p of this.laserPoints) {
                    p.time = now;
                }
            }
            
            this.laserPoints = this.laserPoints.filter(p => (now - p.time) < 1200);
            
            if (this.laserPoints.length > 1) {
                this.laserCtx.globalCompositeOperation = 'source-over';
                this.laserCtx.lineWidth = 4;
                this.laserCtx.lineCap = 'round';
                this.laserCtx.lineJoin = 'round';
                
                for (let i = 1; i < this.laserPoints.length; i++) {
                    const p1 = this.laserPoints[i-1];
                    const p2 = this.laserPoints[i];
                    
                    if (p2.gap) continue;
                    
                    const age = now - p2.time;
                    const opacity = Math.max(0, 1 - (age / 1200));
                    
                    this.laserCtx.beginPath();
                    this.laserCtx.moveTo(p1.x, p1.y);
                    this.laserCtx.lineTo(p2.x, p2.y);
                    this.laserCtx.strokeStyle = `rgba(255, 153, 0, ${opacity})`;
                    this.laserCtx.shadowBlur = 12 * opacity;
                    this.laserCtx.shadowColor = `rgba(255, 51, 0, ${opacity})`;
                    this.laserCtx.stroke();
                }
                
                this.laserCtx.shadowBlur = 0;
            }
            
            // Only stop the loop if the laser tool is inactive and all trailing points have faded away
            if (this.activeTool !== 'laser' && this.laserPoints.length === 0) {
                this.laserLoopRunning = false;
                return;
            }
            
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }
    
    stopLaserLoop() {
        this.laserLoopRunning = false;
        this.laserPoints = [];
    }
}

// Global instance
window.annotationManager = new AnnotationManager();

// Setup toolbar button events
document.addEventListener('DOMContentLoaded', () => {
    const btns = document.querySelectorAll('.tool-btn');
    btns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tool = btn.dataset.tool;
            
            // Toggle off if already active
            if (btn.classList.contains('active')) {
                btn.classList.remove('active');
                window.annotationManager.setTool(null);
                return;
            }
            
            // Deactivate others
            btns.forEach(b => b.classList.remove('active'));
            
            // Activate this
            btn.classList.add('active');
            window.annotationManager.setTool(tool);
        });
    });
});
