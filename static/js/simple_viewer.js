// simple_viewer.js - Robust, Zero-Error Scholarly Reader & Viewer

document.addEventListener('DOMContentLoaded', () => {
    const bookData = window.__BOOK_DATA__;
    if (!bookData || !bookData.pages || bookData.pages.length === 0) {
        console.error("No valid book data found.");
        return;
    }

    const pages = bookData.pages;
    const chapters = bookData.chapters || [];
    const globalFootnotes = bookData.footnotes || {};

    // --- State Variables ---
    let currentPageIndex = parseInt(localStorage.getItem('iyye_simple_page') || '0', 10);
    if (isNaN(currentPageIndex) || currentPageIndex < 0 || currentPageIndex >= pages.length) {
        currentPageIndex = 0;
    }

    let viewMode = localStorage.getItem('iyye_view_mode') || 'page'; // 'page' | 'scroll'
    let showImage = localStorage.getItem('iyye_show_img') !== 'false';
    let showEnglish = localStorage.getItem('iyye_show_eng') !== 'false';
    let hebFontScale = parseFloat(localStorage.getItem('iyye_heb_font_scale') || localStorage.getItem('iyye_font_scale') || '1.0');
    if (isNaN(hebFontScale) || hebFontScale < 0.6 || hebFontScale > 2.0) hebFontScale = 1.0;

    let engFontScale = parseFloat(localStorage.getItem('iyye_eng_font_scale') || localStorage.getItem('iyye_font_scale') || '1.0');
    if (isNaN(engFontScale) || engFontScale < 0.6 || engFontScale > 2.0) engFontScale = 1.0;
    let imgScale = 1.0;

    // --- DOM Elements ---
    const pageSelect = document.getElementById('page-select');
    const chapterSelect = document.getElementById('chapter-select');
    const btnPrev = document.getElementById('btn-prev-page');
    const btnNext = document.getElementById('btn-next-page');

    const btnViewMode = document.getElementById('btn-view-mode');
    const modeIcon = document.getElementById('mode-icon');
    const modeText = document.getElementById('mode-text');

    const toggleImageBtn = document.getElementById('toggle-image-col');
    const toggleEnglishBtn = document.getElementById('toggle-english-col');

    const panelImage = document.getElementById('panel-image');
    const panelHebrew = document.getElementById('panel-hebrew');
    const panelEnglish = document.getElementById('panel-english');

    const manuscriptImg = document.getElementById('manuscript-img');
    const imagePageLabel = document.getElementById('image-page-label');
    const hebrewPageBadge = document.getElementById('hebrew-page-badge');
    const englishPageBadge = document.getElementById('english-page-badge');

    const hebrewContent = document.getElementById('hebrew-content');
    const englishContent = document.getElementById('english-content');
    const hebrewScroll = document.getElementById('hebrew-scroll');
    const englishScroll = document.getElementById('english-scroll');

    const btnHebZoomOut = document.getElementById('btn-heb-zoom-out');
    const btnHebZoomIn = document.getElementById('btn-heb-zoom-in');
    const hebZoomDisplay = document.getElementById('heb-zoom-display');

    const btnEngZoomOut = document.getElementById('btn-eng-zoom-out');
    const btnEngZoomIn = document.getElementById('btn-eng-zoom-in');
    const engZoomDisplay = document.getElementById('eng-zoom-display');

    const scanPrevBtn = document.getElementById('scan-prev-page');
    const scanNextBtn = document.getElementById('scan-next-page');
    const scanFloatPrev = document.getElementById('scan-float-prev');
    const scanFloatNext = document.getElementById('scan-float-next');

    const imgZoomOut = document.getElementById('img-zoom-out');
    const imgZoomFit = document.getElementById('img-zoom-fit');
    const imgZoomIn = document.getElementById('img-zoom-in');

    const footnoteDrawer = document.getElementById('footnote-drawer');
    const drawerOverlay = document.getElementById('footnote-drawer-overlay');
    const btnCloseDrawer = document.getElementById('btn-close-drawer');
    const fnDrawerTitle = document.getElementById('fn-drawer-title');
    const fnHebrewText = document.getElementById('fn-hebrew-text');
    const fnEnglishText = document.getElementById('fn-english-text');

    // --- 1. Populate Dropdowns ---
    function initDropdowns() {
        // Populate Page Select
        pageSelect.innerHTML = '';
        pages.forEach((p, idx) => {
            const opt = document.createElement('option');
            opt.value = idx;
            const pNum = idx + 1;
            opt.textContent = `Page ${pNum}`;
            pageSelect.appendChild(opt);
        });

        // Populate Chapter Select
        chapterSelect.innerHTML = '<option value="">דלג לפרק / Jump to Chapter...</option>';
        chapters.forEach((ch, idx) => {
            const opt = document.createElement('option');
            opt.value = idx;
            const hebTitle = ch.title_hebrew || `פרק ${idx + 1}`;
            const engTitle = ch.title_english ? ` - ${ch.title_english}` : '';
            opt.textContent = `${hebTitle}${engTitle}`;
            chapterSelect.appendChild(opt);
        });
    }

    // --- 2. View Mode & Column Toggles ---
    function applyColumnVisibility() {
        if (showImage) {
            panelImage.classList.remove('collapsed');
            toggleImageBtn.classList.add('active');
        } else {
            panelImage.classList.add('collapsed');
            toggleImageBtn.classList.remove('active');
        }

        if (showEnglish) {
            panelEnglish.classList.remove('collapsed');
            toggleEnglishBtn.classList.add('active');
        } else {
            panelEnglish.classList.add('collapsed');
            toggleEnglishBtn.classList.remove('active');
        }

        localStorage.setItem('iyye_show_img', showImage);
        localStorage.setItem('iyye_show_eng', showEnglish);
    }

    function applyHebFontScale() {
        document.documentElement.style.setProperty('--heb-font-scale', hebFontScale);
        if (hebZoomDisplay) hebZoomDisplay.textContent = `${Math.round(hebFontScale * 100)}%`;
        localStorage.setItem('iyye_heb_font_scale', hebFontScale);
    }

    function applyEngFontScale() {
        document.documentElement.style.setProperty('--eng-font-scale', engFontScale);
        if (engZoomDisplay) engZoomDisplay.textContent = `${Math.round(engFontScale * 100)}%`;
        localStorage.setItem('iyye_eng_font_scale', engFontScale);
    }

    function applyImageScale() {
        manuscriptImg.style.transform = `scale(${imgScale})`;
    }

    // --- 3. Text Formatting Helpers ---
    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function formatMarkup(rawText, pageId) {
        if (!rawText) return '';
        // Pre-escape all raw text to prevent DOM XSS before markdown token expansion
        let text = escapeHtml(rawText);

        // Convert markdown bold **text** to <strong>
        text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

        // Convert Hebrew footnote markers like (א) or [^א]
        text = text.replace(/(?:\(([א-ת*])\)|\[\^([א-ת*])\])/g, (match, m1, m2) => {
            const marker = m1 || m2;
            return `<span class="fn-ref" data-page="${pageId}" data-marker="${marker}">(${marker})</span>`;
        });

        // Convert English footnote references like [a](#fn-...) or [1]
        text = text.replace(/\[([^\]]+)\]\(#fn-p[^-]+-([א-ת*]+)\)/g, (match, label, marker) => {
            return `<span class="fn-ref" data-page="${pageId}" data-marker="${marker}">[${label}]</span>`;
        });
        text = text.replace(/\[(\d+)\]/g, (match, num) => {
            return `<span class="fn-ref" data-page="${pageId}" data-marker="${num}">[${num}]</span>`;
        });

        return text;
    }

    // --- 4. Page Mode Rendering ---
    function renderPageMode() {
        const page = pages[currentPageIndex];
        if (!page) return;

        const pageNum = currentPageIndex + 1;
        const pageId = page.page_id;

        // Update Nav UI
        pageSelect.value = currentPageIndex;
        const hasNext = (currentPageIndex < pages.length - 1);
        const hasPrev = (currentPageIndex > 0);

        btnPrev.disabled = !hasPrev;
        btnNext.disabled = !hasNext;
        if (scanPrevBtn) scanPrevBtn.disabled = !hasPrev;
        if (scanNextBtn) scanNextBtn.disabled = !hasNext;
        if (scanFloatPrev) scanFloatPrev.disabled = !hasPrev;
        if (scanFloatNext) scanFloatNext.disabled = !hasNext;

        // Update Labels
        imagePageLabel.textContent = `Page Scan — ${pageNum} / ${pages.length}`;
        hebrewPageBadge.textContent = `עמוד ${pageNum} מתוך ${pages.length}`;
        englishPageBadge.textContent = `Page ${pageNum} of ${pages.length}`;

        // Update Image
        manuscriptImg.src = page.image_path || `/page_images/${pageId}.png`;

        // Gather Paragraphs for this page from chapters
        const pageParas = [];
        let matchingChapter = null;

        chapters.forEach(ch => {
            (ch.paragraphs || []).forEach(p => {
                if (p.page_id === pageId && p.type === 'paragraph') {
                    pageParas.push(p);
                    if (!matchingChapter) matchingChapter = ch;
                }
            });
        });

        // Top Navigation (Above paragraphs when hasPrev is true)
        let topHebNav = '';
        if (hasPrev) {
            topHebNav = `<div class="top-page-nav" dir="rtl">
                <button class="top-nav-btn btn-action-prev" title="חזור לעמוד הקודם">▶ עמוד קודם (${pageNum - 1})</button>
            </div>`;
        }

        let topEngNav = '';
        if (hasPrev) {
            topEngNav = `<div class="top-page-nav" dir="ltr">
                <button class="top-nav-btn btn-action-prev" title="Go to previous page">◀ Previous Page (${pageNum - 1})</button>
            </div>`;
        }

        // Bottom Navigation (Below paragraphs when hasNext is true, or end marker)
        let bottomHebNav = `<div class="bottom-page-nav" dir="rtl">`;
        if (hasNext) {
            bottomHebNav += `<button class="bottom-nav-btn primary btn-action-next" title="עבור לעמוד הבא">העמוד הבא (${pageNum + 1}) ◀</button>`;
        } else {
            bottomHebNav += `<span class="bottom-nav-end">סוף סימן קפ״ז ✓</span>`;
        }
        bottomHebNav += `</div>`;

        let bottomEngNav = `<div class="bottom-page-nav" dir="ltr">`;
        if (hasNext) {
            bottomEngNav += `<button class="bottom-nav-btn primary btn-action-next" title="Go to next page">Next Page (${pageNum + 1}) ▶</button>`;
        } else {
            bottomEngNav += `<span class="bottom-nav-end">End of Siman 187 ✓</span>`;
        }
        bottomEngNav += `</div>`;

        // Render Hebrew (Directly from paragraphs without page-chapter-header)
        let hebHtml = topHebNav;
        if (pageParas.length > 0) {
            pageParas.forEach(p => {
                const text = formatMarkup(p.hebrew || '', pageId);
                hebHtml += `<div class="para-unit" data-page="${pageId}">${text}</div>`;
            });
        } else {
            // Fallback to raw lines if paragraphs not structured
            const lines = (page.main_text || []).map(l => l.text).join(' ');
            hebHtml += `<div class="para-unit" data-page="${pageId}">${formatMarkup(lines, pageId)}</div>`;
        }
        hebHtml += bottomHebNav;
        hebrewContent.innerHTML = hebHtml;

        // Render English (Directly from paragraphs without page-chapter-header)
        let engHtml = topEngNav;
        if (pageParas.length > 0) {
            pageParas.forEach(p => {
                const engText = p.english && !p.english.includes('(Translation not cached)') 
                    ? formatMarkup(p.english, pageId)
                    : '<em style="color: #a8a29e;">(Translation pending for this segment)</em>';
                engHtml += `<div class="para-unit" data-page="${pageId}">${engText}</div>`;
            });
        } else {
            engHtml += `<div class="para-unit"><em style="color: #a8a29e;">(No translated paragraphs recorded for this page)</em></div>`;
        }
        engHtml += bottomEngNav;
        englishContent.innerHTML = engHtml;

        // Scroll to top
        hebrewScroll.scrollTop = 0;
        englishScroll.scrollTop = 0;

        localStorage.setItem('iyye_simple_page', currentPageIndex);
    }

    // --- 5. Continuous Scroll Mode Rendering ---
    function renderScrollMode() {
        btnPrev.disabled = true;
        btnNext.disabled = true;
        pageSelect.disabled = true;

        let hebHtml = '';
        let engHtml = '';

        chapters.forEach((ch, chIdx) => {
            const chTitleHeb = ch.title_hebrew || `פרק ${chIdx + 1}`;
            const chTitleEng = ch.title_english || `Chapter ${chIdx + 1}`;

            hebHtml += `<div class="page-chapter-header" id="ch-heb-${chIdx}">
                <h2>${chTitleHeb}</h2>
            </div>`;

            engHtml += `<div class="page-chapter-header" id="ch-eng-${chIdx}">
                <h2>${chTitleEng}</h2>
            </div>`;

            (ch.paragraphs || []).forEach(elem => {
                if (elem.type === 'page_boundary') {
                    hebHtml += `<div class="page-break-divider" data-page="${elem.page_id}">
                        <span class="page-break-badge">— עמוד ${elem.page_num} —</span>
                    </div>`;
                    engHtml += `<div class="page-break-divider" data-page="${elem.page_id}">
                        <span class="page-break-badge">— Page ${elem.page_num} —</span>
                    </div>`;
                } else if (elem.type === 'paragraph') {
                    const hText = formatMarkup(elem.hebrew || '', elem.page_id);
                    hebHtml += `<div class="para-unit" data-page="${elem.page_id}">${hText}</div>`;

                    const eText = elem.english && !elem.english.includes('(Translation not cached)')
                        ? formatMarkup(elem.english, elem.page_id)
                        : '<em style="color: #a8a29e;">(Translation pending)</em>';
                    engHtml += `<div class="para-unit" data-page="${elem.page_id}">${eText}</div>`;
                }
            });
        });

        hebrewContent.innerHTML = hebHtml;
        englishContent.innerHTML = engHtml;

        // Setup scroll observer to update manuscript image dynamically
        setupScrollSync();
    }

    function setupScrollSync() {
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && entry.target.dataset.page) {
                    const pId = entry.target.dataset.page;
                    const pageObj = pages.find(p => p.page_id === pId);
                    if (pageObj) {
                        manuscriptImg.src = pageObj.image_path || `/page_images/${pId}.png`;
                        const pIdx = pages.indexOf(pageObj);
                        imagePageLabel.textContent = `Page Scan — ${pIdx + 1} / ${pages.length}`;
                        hebrewPageBadge.textContent = `עמוד ${pIdx + 1} מתוך ${pages.length}`;
                        englishPageBadge.textContent = `Page ${pIdx + 1} of ${pages.length}`;
                    }
                }
            });
        }, { root: hebrewScroll, threshold: 0.2 });

        hebrewContent.querySelectorAll('.para-unit[data-page], .page-break-divider[data-page]').forEach(el => {
            observer.observe(el);
        });
    }

    // --- 6. Mode Switcher ---
    function updateView() {
        if (viewMode === 'page') {
            btnViewMode.classList.remove('active');
            modeIcon.textContent = '📄';
            modeText.textContent = 'עמוד / Page';
            pageSelect.disabled = false;
            renderPageMode();
        } else {
            btnViewMode.classList.add('active');
            modeIcon.textContent = '📜';
            modeText.textContent = 'רציף / Scroll';
            renderScrollMode();
        }
        localStorage.setItem('iyye_view_mode', viewMode);
    }

    // --- 7. Footnotes System ---
    function openFootnote(marker, pageId) {
        // Find footnote in page object or global footnotes
        const page = pages.find(p => p.page_id === pageId);
        const activeFootnotes = (page && page.linked_footnotes) ? page.linked_footnotes : {};
        const fnData = activeFootnotes[marker] || globalFootnotes[`${pageId}-${marker}`] || {};
        const isEditorial = (typeof fnData === 'object' && fnData.type === 'editorial') || marker === '†' || marker === '‡';

        if (isEditorial) {
            fnDrawerTitle.innerHTML = '<span class="drawer-badge-editorial">הגהת המהדיר / Editorial Note</span> הערה [' + marker + '] — ' + pageId;
        } else {
            fnDrawerTitle.textContent = 'הערה (' + marker + ') — ' + pageId;
        }

        let hebFootnote = '';
        let engFootnote = '';

        if (page && page.linked_footnotes && page.linked_footnotes[marker]) {
            const fnData = page.linked_footnotes[marker];
            if (typeof fnData === 'object') {
                hebFootnote = fnData.hebrew || '';
                engFootnote = fnData.english || '';
            } else {
                hebFootnote = String(fnData);
            }
        }

        if (!hebFootnote && globalFootnotes[`${pageId}-${marker}`]) {
            const gfn = globalFootnotes[`${pageId}-${marker}`];
            if (typeof gfn === 'object') {
                hebFootnote = gfn.hebrew || '';
                engFootnote = gfn.english || '';
            } else {
                hebFootnote = String(gfn);
            }
        }

        fnHebrewText.textContent = hebFootnote || 'לא נמצא נוסח עברי להערה זו.';
        fnEnglishText.textContent = engFootnote || 'No English translation recorded for this footnote.';

        footnoteDrawer.classList.add('open');
        drawerOverlay.classList.add('open');
    }

    function closeFootnote() {
        footnoteDrawer.classList.remove('open');
        drawerOverlay.classList.remove('open');
    }

    // Global listener for click actions
    document.addEventListener('click', (e) => {
        // Next page action at end of page
        const nextBtn = e.target.closest('.btn-action-next');
        if (nextBtn) {
            if (currentPageIndex < pages.length - 1) {
                currentPageIndex++;
                renderPageMode();
            }
            return;
        }

        // Previous page action at end of page
        const prevBtn = e.target.closest('.btn-action-prev');
        if (prevBtn) {
            if (currentPageIndex > 0) {
                currentPageIndex--;
                renderPageMode();
            }
            return;
        }

        // Footnote click
        const ref = e.target.closest('.fn-ref');
        if (ref) {
            const marker = ref.dataset.marker;
            const pageId = ref.dataset.page || pages[currentPageIndex].page_id;
            openFootnote(marker, pageId);
        }
    });

    btnCloseDrawer.addEventListener('click', closeFootnote);
    drawerOverlay.addEventListener('click', closeFootnote);

    // --- 8. Event Listeners ---
    pageSelect.addEventListener('change', (e) => {
        currentPageIndex = parseInt(e.target.value, 10);
        renderPageMode();
    });

    chapterSelect.addEventListener('change', (e) => {
        const chIdx = parseInt(e.target.value, 10);
        if (isNaN(chIdx)) return;
        const ch = chapters[chIdx];
        if (!ch) return;

        // Find first page of chapter
        const firstPara = (ch.paragraphs || []).find(p => p.page_id);
        if (firstPara) {
            const pIdx = pages.findIndex(p => p.page_id === firstPara.page_id);
            if (pIdx !== -1) {
                currentPageIndex = pIdx;
                if (viewMode === 'scroll') {
                    const targetEl = document.getElementById(`ch-heb-${chIdx}`);
                    if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth' });
                } else {
                    renderPageMode();
                }
            }
        }
    });

    function goToPrevPage() {
        if (currentPageIndex > 0) {
            currentPageIndex--;
            renderPageMode();
        }
    }

    function goToNextPage() {
        if (currentPageIndex < pages.length - 1) {
            currentPageIndex++;
            renderPageMode();
        }
    }

    btnPrev.addEventListener('click', goToPrevPage);
    btnNext.addEventListener('click', goToNextPage);

    if (scanPrevBtn) scanPrevBtn.addEventListener('click', goToPrevPage);
    if (scanNextBtn) scanNextBtn.addEventListener('click', goToNextPage);
    if (scanFloatPrev) scanFloatPrev.addEventListener('click', goToPrevPage);
    if (scanFloatNext) scanFloatNext.addEventListener('click', goToNextPage);

    btnViewMode.addEventListener('click', () => {
        viewMode = (viewMode === 'page') ? 'scroll' : 'page';
        updateView();
    });

    toggleImageBtn.addEventListener('click', () => {
        showImage = !showImage;
        applyColumnVisibility();
    });

    toggleEnglishBtn.addEventListener('click', () => {
        showEnglish = !showEnglish;
        applyColumnVisibility();
    });

    // Hebrew Font Zoom
    if (btnHebZoomOut) {
        btnHebZoomOut.addEventListener('click', () => {
            if (hebFontScale > 0.8) {
                hebFontScale = Math.round((hebFontScale - 0.1) * 10) / 10;
                applyHebFontScale();
            }
        });
    }

    if (btnHebZoomIn) {
        btnHebZoomIn.addEventListener('click', () => {
            if (hebFontScale < 1.6) {
                hebFontScale = Math.round((hebFontScale + 0.1) * 10) / 10;
                applyHebFontScale();
            }
        });
    }

    // English Font Zoom
    if (btnEngZoomOut) {
        btnEngZoomOut.addEventListener('click', () => {
            if (engFontScale > 0.8) {
                engFontScale = Math.round((engFontScale - 0.1) * 10) / 10;
                applyEngFontScale();
            }
        });
    }

    if (btnEngZoomIn) {
        btnEngZoomIn.addEventListener('click', () => {
            if (engFontScale < 1.6) {
                engFontScale = Math.round((engFontScale + 0.1) * 10) / 10;
                applyEngFontScale();
            }
        });
    }

    // Image Zoom
    imgZoomIn.addEventListener('click', () => {
        imgScale = Math.min(2.5, imgScale + 0.25);
        applyImageScale();
    });

    imgZoomOut.addEventListener('click', () => {
        imgScale = Math.max(0.5, imgScale - 0.25);
        applyImageScale();
    });

    imgZoomFit.addEventListener('click', () => {
        imgScale = 1.0;
        applyImageScale();
    });

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeFootnote();
            return;
        }
        // Only navigate in page mode and when not focused on an input/select
        if (viewMode === 'page' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                goToPrevPage();
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                goToNextPage();
            }
        }
    });

    // Manuscript Scan Drag-to-Pan
    function initImagePan() {
        const wrapper = document.getElementById('image-wrapper') || document.querySelector('.image-scroll-wrapper');
        if (!wrapper) return;

        let isDown = false;
        let startX = 0;
        let startY = 0;
        let scrollLeft = 0;
        let scrollTop = 0;

        wrapper.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            isDown = true;
            wrapper.classList.add('is-dragging');
            startX = e.pageX - wrapper.offsetLeft;
            startY = e.pageY - wrapper.offsetTop;
            scrollLeft = wrapper.scrollLeft;
            scrollTop = wrapper.scrollTop;
        });

        window.addEventListener('mouseup', () => {
            if (!isDown) return;
            isDown = false;
            wrapper.classList.remove('is-dragging');
        });

        wrapper.addEventListener('mousemove', (e) => {
            if (!isDown) return;
            e.preventDefault();
            const x = e.pageX - wrapper.offsetLeft;
            const y = e.pageY - wrapper.offsetTop;
            wrapper.scrollLeft = scrollLeft - (x - startX);
            wrapper.scrollTop = scrollTop - (y - startY);
        });

        // Touch support
        wrapper.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            isDown = true;
            wrapper.classList.add('is-dragging');
            startX = e.touches[0].pageX - wrapper.offsetLeft;
            startY = e.touches[0].pageY - wrapper.offsetTop;
            scrollLeft = wrapper.scrollLeft;
            scrollTop = wrapper.scrollTop;
        }, { passive: true });

        window.addEventListener('touchend', () => {
            if (!isDown) return;
            isDown = false;
            wrapper.classList.remove('is-dragging');
        });

        wrapper.addEventListener('touchmove', (e) => {
            if (!isDown || e.touches.length !== 1) return;
            const x = e.touches[0].pageX - wrapper.offsetLeft;
            const y = e.touches[0].pageY - wrapper.offsetTop;
            wrapper.scrollLeft = scrollLeft - (x - startX);
            wrapper.scrollTop = scrollTop - (y - startY);
        }, { passive: true });
    }

    // --- 9. Initialization ---
    initDropdowns();
    applyColumnVisibility();
    applyHebFontScale();
    applyEngFontScale();
    initImagePan();
    updateView();
});
