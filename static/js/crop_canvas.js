/**
 * crop_canvas.js
 * 
 * Dynamic HTML5 Canvas cropper that renders a high-magnification 3-line slice
 * (Line N-1, Line N, Line N+1) on demand from ALTO coordinates and full manuscript scans.
 * Scales for devicePixelRatio to ensure Retina sharpness.
 */

(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CropCanvas = factory();
  }
}(typeof self !== 'undefined' ? self : this, function() {

  function parseCoord(val, fallback) {
    if (val === null || val === undefined) return fallback;
    const n = parseFloat(val);
    return isNaN(n) ? fallback : n;
  }

  function normalizeBox(coords) {
    if (!coords) return null;
    const x = parseCoord(coords.HPOS ?? coords.x, 0);
    const y = parseCoord(coords.VPOS ?? coords.y, 0);
    const w = parseCoord(coords.WIDTH ?? coords.width, 0);
    const h = parseCoord(coords.HEIGHT ?? coords.height, 0);
    if (w <= 0 || h <= 0) return null;
    return { x, y, width: w, height: h };
  }

  /**
   * Calculates bounding boxes for a 3-line crop.
   */
  function calculateThreeLineBounds(prevCoords, targetCoords, nextCoords, imgWidth, imgHeight, options = {}) {
    imgWidth = parseCoord(imgWidth, 2550);
    imgHeight = parseCoord(imgHeight, 3300);

    const targetBox = normalizeBox(targetCoords);
    if (!targetBox) {
      throw new Error('targetCoords must contain valid dimensions');
    }

    const prevBox = normalizeBox(prevCoords);
    const nextBox = normalizeBox(nextCoords);

    const activeBoxes = [prevBox, targetBox, nextBox].filter(Boolean);

    const minX = Math.min(...activeBoxes.map(b => b.x));
    const maxX = Math.max(...activeBoxes.map(b => b.x + b.width));
    const minY = Math.min(...activeBoxes.map(b => b.y));
    const maxY = Math.max(...activeBoxes.map(b => b.y + b.height));

    const padYRatio = options.padYRatio !== undefined ? options.padYRatio : 0.22;
    const padY = Math.max(12, Math.round(targetBox.height * padYRatio));
    const padX = Math.max(45, Math.round(targetBox.width * 0.035));

    const cropX = Math.max(0, minX - padX);
    const cropY = Math.max(0, minY - padY);
    const cropW = Math.min(imgWidth - cropX, (maxX - minX) + 2 * padX);
    const cropH = Math.min(imgHeight - cropY, (maxY - minY) + 2 * padY);

    return {
      cropBox: {
        x: cropX,
        y: cropY,
        width: cropW,
        height: cropH
      },
      targetRel: {
        x: targetBox.x - cropX,
        y: targetBox.y - cropY,
        width: targetBox.width,
        height: targetBox.height
      },
      prevRel: prevBox ? {
        x: prevBox.x - cropX,
        y: prevBox.y - cropY,
        width: prevBox.width,
        height: prevBox.height
      } : null,
      nextRel: nextBox ? {
        x: nextBox.x - cropX,
        y: nextBox.y - cropY,
        width: nextBox.width,
        height: nextBox.height
      } : null
    };
  }

  /**
   * Renders the 3-line crop to a canvas element, accounting for devicePixelRatio.
   */
  function renderThreeLineCrop(canvas, imgElement, prevCoords, targetCoords, nextCoords, options = {}) {
    if (!canvas || !imgElement) return null;

    const imgW = imgElement.naturalWidth || imgElement.width || 2550;
    const imgH = imgElement.naturalHeight || imgElement.height || 3300;

    const bounds = calculateThreeLineBounds(prevCoords, targetCoords, nextCoords, imgW, imgH, options);
    const { cropBox, targetRel } = bounds;

    const dpr = options.dpr || (typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1);
    const maxWidth = options.maxWidth || 1200;
    
    // Auto-fit to maxWidth (when fitToWidth is enabled, scale to maxWidth up to 1.35x; otherwise scale down if wider)
    const scale = options.fitToWidth
      ? Math.min(1.35, maxWidth / cropBox.width)
      : Math.min(1.0, maxWidth / cropBox.width);
    const displayWidth = Math.round(cropBox.width * scale);
    const displayHeight = Math.round(cropBox.height * scale);

    // High-DPI canvas dimensions
    canvas.width = Math.round(displayWidth * dpr);
    canvas.height = Math.round(displayHeight * dpr);
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr * scale, dpr * scale);

    // Draw the cropped slice
    ctx.drawImage(
      imgElement,
      cropBox.x, cropBox.y, cropBox.width, cropBox.height,
      0, 0, cropBox.width, cropBox.height
    );

    // Draw guide lines / highlight around target line if enabled
    if (options.showGuides !== false) {
      ctx.save();
      // Target line box
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.85)'; // Blue guide
      ctx.lineWidth = 2 / scale;
      ctx.setLineDash([6 / scale, 4 / scale]);
      ctx.strokeRect(targetRel.x, targetRel.y, targetRel.width, targetRel.height);

      // Subtle warm highlight over target line
      ctx.fillStyle = 'rgba(254, 240, 138, 0.12)'; // Soft yellow tint
      ctx.fillRect(targetRel.x, targetRel.y, targetRel.width, targetRel.height);
      ctx.restore();
    }

    ctx.restore();
    return bounds;
  }

  return {
    calculateThreeLineBounds,
    renderThreeLineCrop,
    normalizeBox
  };
}));
