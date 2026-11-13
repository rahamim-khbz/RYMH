/**
 * guide_modal.js
 *
 * Interactive Phase I Reviewer Instruction Guide modal for /dashboard and /review.
 */

window.ReviewerGuide = (function() {
  let modalEl = null;

  function buildModalHtml() {
    return `
      <div class="guide-modal-backdrop" id="guideModalBackdrop" dir="ltr">
        <div class="guide-modal-card" role="dialog" aria-modal="true" aria-labelledby="guideModalTitle">
          <div class="guide-modal-header">
            <div>
              <span class="guide-phase-badge">Phase I Editorial Review</span>
              <h2 id="guideModalTitle">Iyye Hayyam (איי הים) — Reviewer Instruction Guide</h2>
            </div>
            <button class="btn" id="btnCloseGuide" title="Close (Esc)">✕ Close</button>
          </div>

          <div class="guide-modal-body">
            <div class="guide-section">
              <h3>1. Quick Overview & What to Do</h3>
              <p>
                Welcome to the editorial review team for Rabbi Israel Moshe Hazan’s <em>Iyye Hayyam</em> (Siman 187, 89 folios).
                Your goal is to proofread the printed transcription against the original manuscript scan, focusing on three core tasks:
              </p>
              <ul>
                <li><strong>Correct OCR Typos:</strong> Fix misread Hebrew letters (e.g., ד/ר, ו/י, ח/ת, ב/כ, ס/ם) or punctuation errors line-by-line.</li>
                <li><strong>Flag Uncertain Words (<code>🚩 ?</code> / <code>??word??</code>):</strong> If a word or abbreviation is smudged, illegible, or doubtful, wrap it in double question marks like <code>??מילה??</code> (or select it and click <strong>🚩 ?</strong> / press <code>Cmd+/</code>). This marks the line for editorial review so you can keep moving forward.</li>
                <li><strong>Bold Ashurit Script (<code>**word**</code>):</strong> Mark bold square Ashurit script (opening lemmas, headings, rabbinic citations) using double asterisks like <code>**מילה**</code> (or select and press <code>Cmd+B</code>).</li>
              </ul>
            </div>

            <div class="guide-section">
              <h3>2. Claiming Folios (Dashboard)</h3>
              <ul>
                <li><strong>Choose a Folio:</strong> Pick any available page from the grid. Cards show the scan thumbnail and review progress.</li>
                <li><strong>Claim Page:</strong> When you open a page, click <strong>Claim Page</strong> (or start editing—the system will automatically claim it in your name).</li>
                <li><strong>Mark Complete:</strong> When all lines on the folio have been checked against the scan, click <strong>✓ Complete Page</strong>.</li>
              </ul>
            </div>

            <div class="guide-section">
              <h3>3. How to Review (Line Workspace)</h3>
              <ul>
                <li><strong>Scan on Left:</strong> Drag with your mouse or finger to pan around the manuscript scan. Use the mouse wheel or <code>➕</code> / <code>➖</code> buttons to zoom in and out.</li>
                <li><strong>Lines on Right:</strong> Each numbered row matches a line in the scan. Click any line to edit directly in place.</li>
                <li><strong>Focused 3-Line Inspector (Recommended):</strong> Double-click any line to open the zoomed 3-line slice at the bottom, showing the current line alongside the line above and below.</li>
                <li><strong>Verify Button (<code>✓</code>):</strong> Click the checkmark on a line once you've confirmed it matches the scan.</li>
              </ul>
            </div>

            <div class="guide-section">
              <h3>4. Keyboard Shortcuts & Navigation</h3>
              <table class="guide-table">
                <thead>
                  <tr>
                    <th>Shortcut</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><code>Double-Click</code></td>
                    <td>Opens the Focused 3-Line Inspector for that line</td>
                  </tr>
                  <tr>
                    <td><code>Enter</code> / <code>↓ Down Arrow</code></td>
                    <td>Saves current edit and advances to the next line</td>
                  </tr>
                  <tr>
                    <td><code>↑ Up Arrow</code></td>
                    <td>Saves current edit and moves to the previous line</td>
                  </tr>
                  <tr>
                    <td><code>Cmd+B</code> / <code>Ctrl+B</code></td>
                    <td>Bolds selected text (<code>**Ashurit**</code>)</td>
                  </tr>
                  <tr>
                    <td><code>Cmd+/</code> / <code>Ctrl+/</code></td>
                    <td>Flags uncertain word (<code>??Doubtful Word??</code>)</td>
                  </tr>
                  <tr>
                    <td><code>Esc</code></td>
                    <td>Closes the 3-line inspector or guide modal</td>
                  </tr>
                </tbody>
              </table>
              <p style="margin-top:10px;">
                <strong>Automatic Saving:</strong> All your edits are saved automatically as you navigate (via Down/Up arrows, Enter, or Prev/Next buttons).
              </p>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function ensureModal() {
    if (modalEl) return modalEl;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = buildModalHtml().trim();
    modalEl = wrapper.firstElementChild;
    document.body.appendChild(modalEl);

    document.getElementById('btnCloseGuide')?.addEventListener('click', close);
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) close();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modalEl && modalEl.classList.contains('open')) {
        close();
      }
    });
    return modalEl;
  }

  function open() {
    const el = ensureModal();
    el.classList.add('open');
  }

  function close() {
    if (modalEl) {
      modalEl.classList.remove('open');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btnOpenGuide')?.addEventListener('click', open);
  });

  return { open, close };
})();
