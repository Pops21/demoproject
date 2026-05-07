// ============================================================
// UE5 Widget Generator — HTML to UMG Widget Converter
// ============================================================

// ==================== UTILITIES ====================

function generateGUID() {
  return 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'.replace(/X/g, () =>
    Math.floor(Math.random() * 16).toString(16).toUpperCase()
  );
}

// Short unique ID for this conversion session — appended to texture names
function generateSessionId() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}
// Will be set fresh per generate() call
let SESSION_ID = generateSessionId();
const GRADIENT_RENDER_SCALE = 2;
const GRADIENT_MAX_TEXTURE_DIM = 4096;
const GRADIENT_MAX_TEXTURE_PIXELS = 8388608;
const GRADIENT_DITHER_STRENGTH = 3.0;
const ANALYSIS_CACHE_VERSION = 37;
const ZIP_UTF8_FLAG = 0x0800;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function isCanvasReadable(target) {
  const canvas = target && typeof target.getContext === 'function' ? target : target?.canvas;
  const ctx = target && typeof target.getImageData === 'function' ? target : canvas?.getContext?.('2d');
  if (!canvas || !ctx || canvas.width < 1 || canvas.height < 1) return false;
  try {
    ctx.getImageData(0, 0, 1, 1);
    return true;
  } catch {
    return false;
  }
}

function cssBackgroundMayTaintCanvas(bgImage) {
  if (!bgImage || bgImage === 'none') return false;
  const urlMatches = [...bgImage.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)];
  return urlMatches.some((match) => {
    const ref = (match[2] || '').trim();
    if (!ref) return false;
    return !/^(?:data:|blob:)/i.test(ref);
  });
}

function stripAssetUrlSuffix(ref) {
  const value = String(ref || '').trim();
  if (/^data:/i.test(value)) return value;
  return value.split('#')[0].split('?')[0];
}

function normalizeLocalAssetPath(ref) {
  let value = stripAssetUrlSuffix(ref).replace(/\\/g, '/').replace(/^\/+/, '');
  try { value = decodeURIComponent(value); } catch {}
  return value;
}

function extractCssUrlRefs(bgImage) {
  const value = String(bgImage || '');
  return [...value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)]
    .map(match => (match[2] || '').trim())
    .filter(Boolean);
}

function extractSingleCssUrl(bgImage) {
  const refs = extractCssUrlRefs(bgImage);
  const value = String(bgImage || '').trim();
  return refs.length === 1 && /^url\(/i.test(value) ? refs[0] : null;
}

function normalizeTextureCssFilter(filterValue) {
  const value = String(filterValue || '').trim();
  if (!value || value === 'none') return '';
  const supported = [];
  for (const match of value.matchAll(/\b(brightness|saturate|contrast|opacity|grayscale|sepia)\(([^)]+)\)/gi)) {
    supported.push(`${match[1].toLowerCase()}(${match[2].trim()})`);
  }
  return supported.join(' ');
}

async function applyCssFilterToDataUrl(dataUrl, filterValue) {
  const filter = normalizeTextureCssFilter(filterValue);
  if (!filter || !/^data:image\//i.test(dataUrl || '')) return dataUrl;
  const img = await loadImageFromUrl(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width || 1;
  canvas.height = img.naturalHeight || img.height || 1;
  const ctx = canvas.getContext('2d');
  ctx.filter = filter;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function base64ToBytes(base64) {
  // Strip whitespace defensively (some encoders insert line wraps in long
  // base64 payloads — `atob` rejects those as "invalid character"). Also
  // throw a descriptive error instead of letting the raw DOMException
  // bubble up: a corrupt entry shouldn't kill the whole zip build with
  // an opaque "String contains an invalid character" message.
  const clean = String(base64 == null ? '' : base64).replace(/\s+/g, '');
  let binary;
  try {
    binary = atob(clean);
  } catch (e) {
    const sample = clean.slice(0, 40);
    throw new Error(`Invalid base64 payload (length=${clean.length}, head="${sample}"): ${e.message}`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function getZipDosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = ((date.getHours() & 0x1F) << 11) |
    ((date.getMinutes() & 0x3F) << 5) |
    Math.floor(date.getSeconds() / 2);
  const dosDate = (((year - 1980) & 0x7F) << 9) |
    (((date.getMonth() + 1) & 0x0F) << 5) |
    (date.getDate() & 0x1F);
  return { dosTime, dosDate };
}

function normalizeZipEntryBytes(entry) {
  if (entry.bytes instanceof Uint8Array) return entry.bytes;
  if (entry.base64) return base64ToBytes(entry.base64);
  return new TextEncoder().encode(entry.text || '');
}

function createZipBlob(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const fileName = String(entry.path || entry.name || '').replace(/\\/g, '/');
    const nameBytes = encoder.encode(fileName);
    const fileBytes = normalizeZipEntryBytes(entry);
    const checksum = crc32(fileBytes);
    const { dosTime, dosDate } = getZipDosDateTime(entry.date);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034B50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, ZIP_UTF8_FLAG, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, fileBytes.length, true);
    localView.setUint32(22, fileBytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014B50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, ZIP_UTF8_FLAG, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, fileBytes.length, true);
    centralView.setUint32(24, fileBytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    chunks.push(localHeader, fileBytes);
    centralChunks.push(centralHeader);
    offset += localHeader.length + fileBytes.length;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const chunk of centralChunks) {
    chunks.push(chunk);
    centralSize += chunk.length;
    offset += chunk.length;
  }

  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  endView.setUint32(0, 0x06054B50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  endView.setUint16(20, 0, true);
  chunks.push(endRecord);

  return new Blob(chunks, { type: 'application/zip' });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function parseColor(cssColor) {
  if (!cssColor || cssColor === 'transparent' || cssColor === 'rgba(0, 0, 0, 0)') {
    return null;
  }

  // Parse rgb(r, g, b) or rgba(r, g, b, a) directly — avoids canvas premultiplied alpha issues
  let m = cssColor.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/);
  if (m) {
    return {
      r: Math.round(parseFloat(m[1])),
      g: Math.round(parseFloat(m[2])),
      b: Math.round(parseFloat(m[3])),
      a: m[4] !== undefined ? parseFloat(m[4]) : 1
    };
  }

  // Parse #RRGGBB or #RRGGBBAA
  m = cssColor.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i);
  if (m) {
    return {
      r: parseInt(m[1], 16),
      g: parseInt(m[2], 16),
      b: parseInt(m[3], 16),
      a: m[4] !== undefined ? parseInt(m[4], 16) / 255 : 1
    };
  }

  // Parse #RGB
  m = cssColor.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (m) {
    return {
      r: parseInt(m[1] + m[1], 16),
      g: parseInt(m[2] + m[2], 16),
      b: parseInt(m[3] + m[3], 16),
      a: 1
    };
  }

  // Fallback: canvas with premultiplied alpha correction
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = cssColor;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  if (a > 0 && a < 255) {
    // Undo premultiplied alpha to get true RGB values
    return {
      r: Math.min(255, Math.round(r * 255 / a)),
      g: Math.min(255, Math.round(g * 255 / a)),
      b: Math.min(255, Math.round(b * 255 / a)),
      a: a / 255
    };
  }
  return { r, g, b, a: a / 255 };
}

// Extract first color from CSS gradient (linear-gradient, radial-gradient, etc.)
function parseGradientColor(bgImage) {
  if (!bgImage || bgImage === 'none') return null;
  const rgbMatch = bgImage.match(/rgba?\([^)]+\)/);
  if (rgbMatch) return parseColor(rgbMatch[0]);
  const hexMatch = bgImage.match(/#[0-9a-f]{3,8}/i);
  if (hexMatch) return parseColor(hexMatch[0]);
  return null;
}

function extractFirstVisibleCssColor(input) {
  if (!input || input === 'none') return null;
  const colorTokens = String(input).match(/(?:rgba?\([^)]+\)|#[0-9a-fA-F]{3,8})/g) || [];
  for (const token of colorTokens) {
    const c = parseColor(token);
    if (c && c.a > 0.001) return c;
  }
  return parseGradientColor(input);
}

function splitTopLevelCssCommaList(input) {
  const out = [];
  let depth = 0;
  let start = 0;
  const s = String(input || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out.filter(Boolean);
}

function tryRenderSimpleGridPatternTexture(bgImage, width, height, style = null) {
  const layers = splitTopLevelCssCommaList(bgImage).filter(layer => /linear-gradient/i.test(layer));
  if (layers.length < 2) return null;
  const hasVerticalLayer = layers.some(layer => /\b90deg\b|to\s+right|to\s+left/i.test(layer));
  const hasHorizontalLayer = layers.some(layer => !/\b90deg\b|to\s+right|to\s+left/i.test(layer));
  if (!hasVerticalLayer || !hasHorizontalLayer) return null;

  const bgSize = String(style?.backgroundSize || '').trim();
  if (!bgSize) return null;
  const firstSize = splitTopLevelCssCommaList(bgSize)[0] || '';
  const sizeParts = firstSize.trim().split(/\s+/).filter(Boolean);
  if (!sizeParts.length) return null;
  const tileW = Math.max(1, Math.round(parseCssLengthToken(sizeParts[0], width, NaN)));
  const tileH = Math.max(1, Math.round(parseCssLengthToken(sizeParts[1] || sizeParts[0], height, NaN)));
  if (!Number.isFinite(tileW) || !Number.isFinite(tileH)) return null;

  const lineColor = extractFirstVisibleCssColor(bgImage);
  if (!lineColor || lineColor.a <= 0.001) return null;

  const tileCanvas = document.createElement('canvas');
  tileCanvas.width = tileW;
  tileCanvas.height = tileH;
  const tctx = tileCanvas.getContext('2d');
  tctx.clearRect(0, 0, tileW, tileH);
  tctx.fillStyle = `rgba(${lineColor.r},${lineColor.g},${lineColor.b},${lineColor.a})`;
  tctx.fillRect(0, 0, tileW, 1);
  tctx.fillRect(0, 0, 1, tileH);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = Math.max(1, Math.ceil(width));
  outCanvas.height = Math.max(1, Math.ceil(height));
  const octx = outCanvas.getContext('2d');
  const pattern = octx.createPattern(tileCanvas, 'repeat');
  if (!pattern) return null;
  octx.fillStyle = pattern;
  octx.fillRect(0, 0, outCanvas.width, outCanvas.height);
  return outCanvas.toDataURL('image/png');
}

function hasGradient(bgImage) {
  if (!bgImage || bgImage === 'none') return false;
  return /(linear-gradient|radial-gradient|conic-gradient|repeating-linear-gradient|repeating-radial-gradient|repeating-conic-gradient)\s*\(/i.test(bgImage);
}

// Returns true when every color stop in the gradient is effectively the same color.
// In that case we skip texture generation and write a solid bgColor instead.
function isSolidColorGradient(bgImage) {
  if (!hasGradient(bgImage)) return false;
  const colors = [];
  for (const m of bgImage.matchAll(/rgba?\(([^)]+)\)/g)) {
    const p = m[1].split(',').map(s => parseFloat(s.trim()));
    if (p.length >= 3) colors.push({ r: p[0], g: p[1], b: p[2], a: p[3] !== undefined ? p[3] : 1 });
  }
  if (colors.length === 0) return false;
  if (colors.length === 1) return true;
  const f = colors[0];
  return colors.every(c =>
    Math.abs(c.r - f.r) < 5 && Math.abs(c.g - f.g) < 5 &&
    Math.abs(c.b - f.b) < 5 && Math.abs(c.a - f.a) < 0.05
  );
}

function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function computeGradientExportScale(width, height) {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  let scale = GRADIENT_RENDER_SCALE;

  while (scale > 1) {
    const scaledW = Math.ceil(w * scale);
    const scaledH = Math.ceil(h * scale);
    if (
      scaledW <= GRADIENT_MAX_TEXTURE_DIM &&
      scaledH <= GRADIENT_MAX_TEXTURE_DIM &&
      scaledW * scaledH <= GRADIENT_MAX_TEXTURE_PIXELS
    ) {
      break;
    }
    scale -= 0.5;
  }

  return Math.max(1, scale);
}

function roundedRectPath(ctx, x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius || 0, w / 2, h / 2));
  ctx.beginPath();
  if (r <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function clipRoundedRect(ctx, x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius || 0, w / 2, h / 2));
  ctx.beginPath();
  if (r <= 0) {
    ctx.rect(x, y, w, h);
    ctx.clip();
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.clip();
}

function interleavedGradientNoise(x, y) {
  const n = 52.9829189 * (((0.06711056 * x) + (0.00583715 * y)) % 1);
  return (n % 1) - 0.5;
}

function applyOrderedDither(ctx, w, h, strength = GRADIENT_DITHER_STRENGTH) {
  if (strength <= 0) return;
  let image;
  try {
    image = ctx.getImageData(0, 0, w, h);
  } catch {
    return;
  }
  const data = image.data;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      if (data[idx + 3] === 0) continue;
      // Use per-channel interleaved gradient noise only — no Bayer matrix.
      // Bayer creates a visible 4×4 repeating grid; gradient noise is quasi-random
      // and becomes invisible after the 2× downsample.
      data[idx]     = clampByte(data[idx]     + interleavedGradientNoise(x,         y        ) * strength);
      data[idx + 1] = clampByte(data[idx + 1] + interleavedGradientNoise(x + 17.13, y +  9.71) * strength);
      data[idx + 2] = clampByte(data[idx + 2] + interleavedGradientNoise(x + 31.77, y + 23.19) * strength);
    }
  }

  ctx.putImageData(image, 0, 0);
}

// Detect CSS text gradient (-webkit-background-clip: text) — cannot be rendered to canvas
function isTextGradient(cs) {
  const bgClip = cs.backgroundClip || cs.webkitBackgroundClip || '';
  return bgClip === 'text' || bgClip === '-webkit-text';
}

// Extract icon class name from FontAwesome classes
// IMPORTANT: Skip modifier classes (solid, regular, brands, light, thin, duotone)
// and use only the actual icon name class (e.g. fa-wallet, fa-star, fa-power-off)
function iconNameFromClass(el) {
  const cls = (el.className || '').toString();
  // FA modifier prefixes to skip — these don't describe the icon shape
  const modifiers = new Set(['solid','regular','brands','light','thin','duotone','sharp','kit','fw','spin','pulse','flip','rotate','inverse']);
  // Extract ALL fa-xxx classes
  const allMatches = [...cls.matchAll(/fa-([\w-]+)/g)].map(m => m[1]);
  // Find the first one that is NOT a modifier
  const iconSlug = allMatches.find(slug => !modifiers.has(slug));
  if (iconSlug) return 'T_Icon_' + iconSlug.replace(/-/g, '_');
  // Material Icons fallback
  const m2 = cls.match(/material-icons?\s+([\w-]+)/);
  if (m2) return 'T_Icon_' + m2[1].replace(/-/g, '_');
  return null;
}

// Canvas2D shadows are rendered as a single-pass gaussian which is visually
// sharper and more concentrated than CSS's multi-pass box-blur approximation.
// Without compensation, baked shadows look too dark compared to the live CSS
// preview. Widen the blur a bit and drop alpha to match CSS appearance.
const CSS_SHADOW_BLUR_SCALE = 1.5;
const CSS_SHADOW_ALPHA_SCALE = 0.65;

// Compute shadow padding (how far beyond the element rect each shadow extends).
// Returned values are non-negative padding amounts for each edge.
function computeBoxShadowPadding(shadows) {
  let padL = 0, padR = 0, padT = 0, padB = 0;
  for (const s of shadows) {
    // Each shadow layer's extent = scaled-blur*2 (~3σ covers a gaussian) + spread, offset by offset.
    const scaledBlur = s.blurRadius * CSS_SHADOW_BLUR_SCALE;
    const reach = Math.ceil(scaledBlur * 2 + Math.max(s.spreadRadius, 0) + 1);
    padL = Math.max(padL, reach - s.offsetX);
    padR = Math.max(padR, reach + s.offsetX);
    padT = Math.max(padT, reach - s.offsetY);
    padB = Math.max(padB, reach + s.offsetY);
  }
  return {
    padL: Math.max(0, Math.ceil(padL)),
    padR: Math.max(0, Math.ceil(padR)),
    padT: Math.max(0, Math.ceil(padT)),
    padB: Math.max(0, Math.ceil(padB))
  };
}

// Render a static element's background with baked box-shadow(s).
// Produces a PNG whose canvas is the element rect expanded by shadow padding.
// Supports: solid bg color, optional rounded corners, optional border.
// Does NOT currently composite gradients (gradient + shadow combo returns null).
async function renderBoxShadowTexture(w, h, borderRadius, bgColor, borderColor, borderWidth, shadows) {
  if (!shadows || !shadows.length) return null;
  const pad = computeBoxShadowPadding(shadows);
  const totalW = Math.max(1, Math.ceil(w + pad.padL + pad.padR));
  const totalH = Math.max(1, Math.ceil(h + pad.padT + pad.padB));
  const canvas = document.createElement('canvas');
  canvas.width = totalW;
  canvas.height = totalH;
  const ctx = canvas.getContext('2d');

  const ex = pad.padL;
  const ey = pad.padT;

  // Draw each shadow layer as a blurred halo only. Trick: draw the shape far
  // off-canvas and set shadowOffset so that only the shadow lands in the
  // visible region. The actual fill is invisible (outside canvas bounds).
  for (const s of shadows) {
    ctx.save();
    const srcW = w + s.spreadRadius * 2;
    const srcH = h + s.spreadRadius * 2;
    const srcX = -totalW - 2000;              // far off-canvas
    const srcY = ey - s.spreadRadius;         // vertical position we want the shadow at (before offsetY)
    const sRad = Math.max(0, borderRadius + s.spreadRadius);
    const compensatedAlpha = Math.max(0, Math.min(1, s.color.a * CSS_SHADOW_ALPHA_SCALE));
    ctx.shadowColor = `rgba(${s.color.r},${s.color.g},${s.color.b},${compensatedAlpha})`;
    ctx.shadowBlur = Math.max(0, s.blurRadius * CSS_SHADOW_BLUR_SCALE);
    // shadowOffset moves the shadow from (srcX, srcY) to the visible target
    //   targetX = ex - spread + offsetX  (upper-left of shadow rect on canvas)
    //   targetY = ey - spread + offsetY
    ctx.shadowOffsetX = (ex - s.spreadRadius + s.offsetX) - srcX;
    ctx.shadowOffsetY = (ey - s.spreadRadius + s.offsetY) - srcY;
    ctx.fillStyle = 'rgba(0,0,0,1)';
    roundedRectPath(ctx, srcX, srcY, srcW, srcH, sRad);
    ctx.fill();
    ctx.restore();
  }

  // Draw the actual element fill on top of the shadow halo.
  ctx.save();
  clipRoundedRect(ctx, ex, ey, w, h, borderRadius);
  if (bgColor && bgColor.a > 0.001) {
    ctx.fillStyle = `rgba(${bgColor.r},${bgColor.g},${bgColor.b},${bgColor.a})`;
    ctx.fillRect(ex, ey, w, h);
  }
  ctx.restore();

  // Optional stroke for border (solid color only; we bake it so UE doesn't
  // need to emit OutlineSettings on top of a shadow-padded texture).
  if (borderColor && borderWidth > 0 && borderColor.a > 0.01) {
    ctx.save();
    ctx.strokeStyle = `rgba(${borderColor.r},${borderColor.g},${borderColor.b},${borderColor.a})`;
    ctx.lineWidth = borderWidth;
    // Inset the stroke path by half-line so the stroke stays inside the element rect
    const half = borderWidth / 2;
    const strokeR = Math.max(0, borderRadius - half);
    ctx.beginPath();
    const rx = ex + half, ry = ey + half, rw = w - borderWidth, rh = h - borderWidth;
    if (strokeR <= 0) {
      ctx.rect(rx, ry, rw, rh);
    } else {
      ctx.moveTo(rx + strokeR, ry);
      ctx.arcTo(rx + rw, ry, rx + rw, ry + rh, strokeR);
      ctx.arcTo(rx + rw, ry + rh, rx, ry + rh, strokeR);
      ctx.arcTo(rx, ry + rh, rx, ry, strokeR);
      ctx.arcTo(rx, ry, rx + rw, ry, strokeR);
      ctx.closePath();
    }
    ctx.stroke();
    ctx.restore();
  }

  return {
    dataUrl: canvas.toDataURL('image/png'),
    padL: pad.padL, padR: pad.padR, padT: pad.padT, padB: pad.padB,
    totalW, totalH
  };
}

// Convert a blob: or file: URL into a data:image/...;base64,... URL.
// Required because SVG-as-image (loaded via `<img src=svg-blob>`) is rendered
// in "secure static mode" by browsers — it's NOT allowed to fetch any external
// resource, including blob: URLs that the parent document created. So when the
// rewriter substitutes `url("assets/panel.png")` → `url("blob:...")` and we
// later try to bake that CSS into a foreignObject SVG, the image layer just
// silently fails to load and the resulting texture only contains the gradient
// stops. Inlining the bytes as data: URLs sidesteps the restriction.
async function blobOrFileUrlToDataUrl(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

// Walk every `url(...)` inside a CSS value and replace blob:/file: URLs with
// inline data: URLs (with results memoised so the same blob isn't refetched
// once per element). HTTP(S) URLs are left alone — the browser may still load
// them inside an SVG-as-image when the response is CORS-permissive, and
// inlining huge cross-origin assets would balloon the texture cache.
const _bgUrlInlineCache = new Map();
async function inlineBlobAndFileUrlsInCss(cssValue) {
  if (!cssValue || cssValue === 'none') return cssValue;
  const re = /url\(\s*(['"]?)(blob:[^)'"]+|file:\/\/[^)'"]+)\1\s*\)/gi;
  const matches = [...cssValue.matchAll(re)];
  if (matches.length === 0) return cssValue;
  let out = cssValue;
  for (const m of matches) {
    const original = m[0];
    const url = m[2];
    if (!_bgUrlInlineCache.has(url)) {
      _bgUrlInlineCache.set(url, await blobOrFileUrlToDataUrl(url));
    }
    const dataUrl = _bgUrlInlineCache.get(url);
    if (dataUrl) {
      // Use split/join instead of regex replace so the data URL contents
      // (which may contain `$`/`'`/`"`/etc.) don't trigger replacement
      // pattern interpretation.
      out = out.split(original).join(`url("${dataUrl}")`);
    }
  }
  return out;
}

async function renderCssBackgroundTexture(style, width, height, borderRadius) {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  const inlinedBgImage = await inlineBlobAndFileUrlsInCss(style.backgroundImage || 'none');
  // CSS values from getComputedStyle (`url("blob:...")`, `url("data:...")`)
  // come back with DOUBLE quotes around the URL. The styleText below is
  // serialised verbatim into the outer `style="..."` HTML attribute when we
  // build the foreignObject SVG. If we leave the inner `"` characters
  // untouched, the XML parser truncates the attribute at the first nested
  // quote (e.g. `style="...;background-image:url("`), the rest of the CSS is
  // discarded, and the bake silently produces an empty/transparent canvas.
  // That is the underlying reason the multi-layer + url() path "lost" panel/
  // icons/button/bg images in the first place. CSS allows BOTH `"` and `'`
  // (and even unquoted) inside `url()` and `font-family` so flipping every
  // double quote to a single quote inside the style value is lossless and
  // keeps the outer attribute well-formed. We only generate `background-*`
  // and `border-*` properties here — none of which use string literals where
  // the choice of quote character matters semantically.
  // When the caller supplied EITHER a per-side `borderTopWidth/Color/Style`
  // (etc.) OR a per-side longhand from a stamped `mixedBorder` block, emit
  // each side as its own CSS rule. This is the only way `foreignObject`
  // will draw an asymmetric border like `border-left:none; border-bottom:none`
  // — the shorthand `border:${w} ${style} ${color}` collapses to ONE width
  // and ONE color, so an L-shape bracket (top+right only) silently
  // becomes a full 4-side box. Without the per-side path the user's
  // `<span class="br tl">` decorative corners and `border-bottom: 2px solid`
  // accent lines all rendered as full rectangles.
  const _hasPerSide =
    style.borderTopWidth !== undefined || style.borderRightWidth !== undefined ||
    style.borderBottomWidth !== undefined || style.borderLeftWidth !== undefined;
  const _borderRules = _hasPerSide
    ? [
        `border-top:${style.borderTopWidth || '0px'} ${style.borderTopStyle || 'solid'} ${style.borderTopColor || 'transparent'}`,
        `border-right:${style.borderRightWidth || '0px'} ${style.borderRightStyle || 'solid'} ${style.borderRightColor || 'transparent'}`,
        `border-bottom:${style.borderBottomWidth || '0px'} ${style.borderBottomStyle || 'solid'} ${style.borderBottomColor || 'transparent'}`,
        `border-left:${style.borderLeftWidth || '0px'} ${style.borderLeftStyle || 'solid'} ${style.borderLeftColor || 'transparent'}`
      ]
    : [
        `border:${style.borderWidth || 0}px ${style.borderStyle || 'solid'} ${style.borderColor || 'transparent'}`
      ];
  const safeStyleText = [
    'width:100%',
    'height:100%',
    'box-sizing:border-box',
    `background-image:${inlinedBgImage}`,
    `background-color:${style.backgroundColor || 'transparent'}`,
    `background-size:${style.backgroundSize || 'auto'}`,
    `background-position:${style.backgroundPosition || '0% 0%'}`,
    `background-repeat:${style.backgroundRepeat || 'repeat'}`,
    `background-origin:${style.backgroundOrigin || 'padding-box'}`,
    `background-clip:${style.backgroundClip || 'border-box'}`,
    ..._borderRules,
    `border-radius:${Math.max(0, borderRadius || 0)}px`
  ].join(';').replace(/"/g, "'");

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <foreignObject width="100%" height="100%">
        <div xmlns="http://www.w3.org/1999/xhtml" style="${safeStyleText}"></div>
      </foreignObject>
    </svg>
  `;

  const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const svgUrl = URL.createObjectURL(svgBlob);

  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(svgUrl);
      resolve(image);
    };
    image.onerror = (err) => {
      URL.revokeObjectURL(svgUrl);
      reject(err);
    };
    image.src = svgUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas;
}

function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

const SVG_STYLE_PROPS = [
  'display',
  'visibility',
  'opacity',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-opacity',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'paint-order',
  'vector-effect',
  'clip-path',
  'filter',
  'mask',
  'color',
  'stop-color',
  'stop-opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'text-anchor',
  'dominant-baseline',
  'transform',
  'transform-origin'
];

function cloneSvgWithInlineStyles(svgEl, win, width, height) {
  const clone = svgEl.cloneNode(true);
  const sourceNodes = [svgEl, ...svgEl.querySelectorAll('*')];
  const cloneNodes = [clone, ...clone.querySelectorAll('*')];

  for (let i = 0; i < sourceNodes.length; i++) {
    const sourceNode = sourceNodes[i];
    const cloneNode = cloneNodes[i];
    if (!sourceNode || !cloneNode || sourceNode.nodeType !== Node.ELEMENT_NODE) continue;
    const computed = win.getComputedStyle(sourceNode);
    for (const prop of SVG_STYLE_PROPS) {
      // The CSS transform on the OUTER <svg> element (e.g.
      // `.corner-ornament.tr { transform: scaleX(-1); }`) must NOT be baked
      // into the rasterized texture: traverse() reads the same transform
      // off the host element and emits `renderTransform` on the Image
      // widget, so applying it to the cloned root would produce a
      // double-flipped/double-rotated visual. Inner SVG nodes still keep
      // their own transforms — those are part of the artwork.
      if (i === 0 && (prop === 'transform' || prop === 'transform-origin')) continue;
      const value = computed.getPropertyValue(prop);
      if (!value) continue;
      cloneNode.style.setProperty(prop, value);
    }
  }
  // Belt-and-suspenders: also strip any inline `transform` / `transform-origin`
  // that may have been carried over by `cloneNode(true)` from the source.
  // Some CSS-in-JS / Tailwind setups put the transform inline; without this
  // the texture would still rasterize transformed.
  clone.style.removeProperty('transform');
  clone.style.removeProperty('transform-origin');
  clone.removeAttribute('transform'); // SVG `transform` attribute on root, if any

  if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (!clone.getAttribute('xmlns:xlink')) clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('width', String(Math.max(1, Math.ceil(width))));
  clone.setAttribute('height', String(Math.max(1, Math.ceil(height))));
  if (!clone.getAttribute('viewBox')) {
    clone.setAttribute('viewBox', `0 0 ${Math.max(1, Math.ceil(width))} ${Math.max(1, Math.ceil(height))}`);
  }

  return clone;
}

// Rasterize a `data:image/svg+xml,...` data URL (URL-encoded or base64) into
// a PNG data URL at the requested pixel size. Used to convert SVG-pattern
// background-images (a common authoring pattern: `background-image:
// url("data:image/svg+xml,%3Csvg…")`) into Unreal-importable PNG textures
// — UE has no native SVG asset type, so leaving the data URL untouched
// would produce an unimportable .png file with raw SVG bytes inside.
//
// Non-SVG URLs (regular `data:image/png`, `data:image/jpeg`, `https://…`,
// `blob:`, …) are returned unchanged so callers can use this helper as a
// drop-in transformer at every texture-push site without branching.
async function maybeRasterizeSvgUrl(url, width, height) {
  if (typeof url !== 'string') return url;
  if (!/^data:image\/svg\+xml/i.test(url)) return url;
  const w = Math.max(1, Math.ceil(width || 64));
  const h = Math.max(1, Math.ceil(height || 64));
  const rasterizeFromImage = async (srcUrl) => {
    const img = await loadImageFromUrl(srcUrl);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/png');
  };
  try {
    return await rasterizeFromImage(url);
  } catch (_directErr) {
    // Some CSS-authored inline SVG URLs load fine as CSS backgrounds but fail
    // when fed directly to <img src="data:image/svg+xml,..."> because the
    // payload is only minimally escaped for CSS parsing. Decode the SVG data
    // manually, repackage it as a Blob URL, and retry the raster step. This
    // fixes body backgrounds like:
    //   background:url('data:image/svg+xml,<svg ... fill=\"%231a120b\">...')
    // that otherwise ended up as broken "PNG" entries in the texture panel.
    let blobUrl = null;
    try {
      const m = /^data:image\/svg\+xml(?:;charset=[^;,]*)?(;base64)?,(.*)$/i.exec(url);
      if (!m) return url;
      const isBase64 = !!m[1];
      const payload = m[2] || '';
      let svgText = '';
      if (isBase64) {
        svgText = atob(payload.replace(/\s+/g, ''));
      } else {
        try {
          svgText = decodeURIComponent(payload);
        } catch {
          svgText = payload;
        }
      }
      if (!svgText || !/<svg[\s>]/i.test(svgText)) return url;
      const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
      blobUrl = URL.createObjectURL(svgBlob);
      return await rasterizeFromImage(blobUrl);
    } catch (_blobErr) {
      // Preserve old behavior as last resort; callers will still show the
      // broken entry rather than crash the whole export.
      return url;
    } finally {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    }
  }
}

async function renderInlineSvgTexture(svgEl, width, height, win) {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  const clone = cloneSvgWithInlineStyles(svgEl, win, w, h);
  const svgMarkup = new XMLSerializer().serializeToString(clone);
  const svgBlob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
  const svgUrl = URL.createObjectURL(svgBlob);

  try {
    const img = await loadImageFromUrl(svgUrl);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

function parseCssLengthToken(token, size, fallback = 0, absoluteScale = 1) {
  const value = String(token || '').trim().toLowerCase();
  if (!value) return fallback;
  const calc = value.match(/^calc\((.*)\)$/i);
  if (calc) {
    const expr = calc[1].replace(/\s+/g, '');
    const parts = expr.match(/[+-]?[^+-]+/g);
    if (parts && parts.length) {
      let total = 0;
      for (const part of parts) {
        const sign = part.startsWith('-') ? -1 : 1;
        const raw = part.replace(/^[+-]/, '');
        const parsed = parseCssLengthToken(raw, size, NaN, absoluteScale);
        if (!Number.isFinite(parsed)) return fallback;
        total += sign * parsed;
      }
      return total;
    }
    return fallback;
  }
  if (value === 'center') return size / 2;
  if (value === 'left' || value === 'top') return 0;
  if (value === 'right' || value === 'bottom') return size;
  if (value.endsWith('%')) {
    const pct = parseFloat(value);
    return Number.isFinite(pct) ? size * pct / 100 : fallback;
  }
  const num = parseFloat(value);
  return Number.isFinite(num) ? num * absoluteScale : fallback;
}

function expandCssBoxValues(tokens) {
  if (!tokens.length) return ['0', '0', '0', '0'];
  if (tokens.length === 1) return [tokens[0], tokens[0], tokens[0], tokens[0]];
  if (tokens.length === 2) return [tokens[0], tokens[1], tokens[0], tokens[1]];
  if (tokens.length === 3) return [tokens[0], tokens[1], tokens[2], tokens[1]];
  return [tokens[0], tokens[1], tokens[2], tokens[3]];
}

function splitCssPointCoords(point) {
  const coords = [];
  let current = '';
  let depth = 0;
  for (const ch of String(point || '').trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (current) {
        coords.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) coords.push(current);
  return coords;
}

function resolveCircleRadiusToken(token, w, h, cx, cy, absoluteScale = 1) {
  const value = String(token || '').trim().toLowerCase();
  if (!value || value === 'closest-side') return Math.min(cx, cy, w - cx, h - cy);
  if (value === 'farthest-side') return Math.max(cx, cy, w - cx, h - cy);
  if (value === 'closest-corner') {
    return Math.min(
      Math.hypot(cx, cy),
      Math.hypot(w - cx, cy),
      Math.hypot(cx, h - cy),
      Math.hypot(w - cx, h - cy)
    );
  }
  if (value === 'farthest-corner') {
    return Math.max(
      Math.hypot(cx, cy),
      Math.hypot(w - cx, cy),
      Math.hypot(cx, h - cy),
      Math.hypot(w - cx, h - cy)
    );
  }
  if (value.endsWith('%')) {
    const pct = parseFloat(value);
    return Number.isFinite(pct) ? Math.min(w, h) * pct / 100 : Math.min(w, h) / 2;
  }
  const num = parseFloat(value);
  return Number.isFinite(num) ? num * absoluteScale : Math.min(w, h) / 2;
}

function resolveEllipseRadiusToken(token, axisSize, nearEdge, farEdge, absoluteScale = 1) {
  const value = String(token || '').trim().toLowerCase();
  if (!value || value === 'closest-side') return Math.min(nearEdge, farEdge);
  if (value === 'farthest-side') return Math.max(nearEdge, farEdge);
  if (value.endsWith('%')) {
    const pct = parseFloat(value);
    return Number.isFinite(pct) ? axisSize * pct / 100 : axisSize / 2;
  }
  const num = parseFloat(value);
  return Number.isFinite(num) ? num * absoluteScale : axisSize / 2;
}

// Build a CSS clip-path shape onto `ctx` as a sub-path WITHOUT calling
// `ctx.clip()`. Returns true when a recognised shape was emitted. Callers can
// then choose to clip (`applyClipPathMask`) or stroke (border-along-clip-path)
// the same geometry. Splitting these two concerns keeps clip-path parsing in
// one place while letting the caller decide what to do with the path.
function buildClipPathOnCtx(ctx, clipPath, width, height, scaleX = 1, scaleY = 1) {
  const value = String(clipPath || '').trim();
  if (!value || value === 'none') return false;

  let match = value.match(/^polygon\((.*)\)$/i);
  if (match) {
    let body = match[1].trim();
    body = body.replace(/^(?:nonzero|evenodd)\s*,\s*/i, '');
    const points = body.split(/\s*,\s*/).map(part => part.trim()).filter(Boolean);
    if (points.length < 3) return false;

    ctx.beginPath();
    points.forEach((point, index) => {
      const coords = splitCssPointCoords(point);
      if (coords.length < 2) return;
      const x = parseCssLengthToken(coords[0], width, 0, scaleX);
      const y = parseCssLengthToken(coords[1], height, 0, scaleY);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    return true;
  }

  match = value.match(/^inset\((.*)\)$/i);
  if (match) {
    let body = match[1].trim();
    body = body.split(/\s+round\s+/i)[0].trim();
    const [top, right, bottom, left] = expandCssBoxValues(body.split(/\s+/).filter(Boolean));
    const insetTop = parseCssLengthToken(top, height, 0, scaleY);
    const insetRight = parseCssLengthToken(right, width, 0, scaleX);
    const insetBottom = parseCssLengthToken(bottom, height, 0, scaleY);
    const insetLeft = parseCssLengthToken(left, width, 0, scaleX);
    ctx.beginPath();
    ctx.rect(
      insetLeft,
      insetTop,
      Math.max(0, width - insetLeft - insetRight),
      Math.max(0, height - insetTop - insetBottom)
    );
    return true;
  }

  match = value.match(/^circle\((.*)\)$/i);
  if (match) {
    const body = match[1].trim();
    const parts = body.split(/\s+at\s+/i);
    const radiusToken = parts[0].trim();
    const posTokens = (parts[1] || '50% 50%').trim().split(/\s+/);
    const cx = parseCssLengthToken(posTokens[0], width, width / 2, scaleX);
    const cy = parseCssLengthToken(posTokens[1] || '50%', height, height / 2, scaleY);
    const radius = resolveCircleRadiusToken(radiusToken, width, height, cx, cy, Math.max(scaleX, scaleY));
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(0, radius), 0, Math.PI * 2);
    return true;
  }

  match = value.match(/^ellipse\((.*)\)$/i);
  if (match) {
    const body = match[1].trim();
    const parts = body.split(/\s+at\s+/i);
    const radiusTokens = parts[0].trim().split(/\s+/);
    const posTokens = (parts[1] || '50% 50%').trim().split(/\s+/);
    const cx = parseCssLengthToken(posTokens[0], width, width / 2, scaleX);
    const cy = parseCssLengthToken(posTokens[1] || '50%', height, height / 2, scaleY);
    const rx = resolveEllipseRadiusToken(radiusTokens[0], width, cx, width - cx, scaleX);
    const ry = resolveEllipseRadiusToken(radiusTokens[1] || radiusTokens[0], height, cy, height - cy, scaleY);
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(0, rx), Math.max(0, ry), 0, 0, Math.PI * 2);
    return true;
  }

  return false;
}

function applyClipPathMask(ctx, clipPath, width, height, scaleX = 1, scaleY = 1) {
  if (buildClipPathOnCtx(ctx, clipPath, width, height, scaleX, scaleY)) {
    ctx.clip();
    return true;
  }
  return false;
}

async function renderStyledLayerTexture(style, width, height, borderRadius = 0) {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  const bgImage = style?.backgroundImage || 'none';
  const bgColor = parseColor(style?.backgroundColor);
  const clipPath = style?.clipPath || style?.webkitClipPath || 'none';
  const borderWidth = parseFloat(style?.borderWidth) || 0;
  const borderColor = parseColor(style?.borderColor);
  // Per-side longhand presence — when the caller passed asymmetric
  // border props (`borderTopWidth` etc.) instead of the shorthand,
  // we still need to enter the foreignObject bake branch below so
  // `renderCssBackgroundTexture` can stroke each side independently.
  // Without this check, mixed-border spans (`<span class="br tl">`
  // L-shape brackets) skipped the bake entirely because `borderWidth`
  // shorthand was unset → `hasBorder` was false → bake branch
  // returned a transparent texture and the bracket disappeared.
  const _perSideEffW = (s, w) =>
    (s === 'none' || s === 'hidden') ? 0 : (parseFloat(w) || 0);
  const hasPerSideBorder =
    _perSideEffW(style?.borderTopStyle,    style?.borderTopWidth)    > 0 ||
    _perSideEffW(style?.borderRightStyle,  style?.borderRightWidth)  > 0 ||
    _perSideEffW(style?.borderBottomStyle, style?.borderBottomWidth) > 0 ||
    _perSideEffW(style?.borderLeftStyle,   style?.borderLeftWidth)   > 0;
  const hasBorder = (borderWidth > 0 && (style?.borderStyle || 'solid') !== 'none' &&
    borderColor && borderColor.a > 0.001) || hasPerSideBorder;

  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = w;
  sourceCanvas.height = h;
  const sourceCtx = sourceCanvas.getContext('2d');
  let hasPixels = false;

  if (bgColor && bgColor.a > 0.001) {
    sourceCtx.fillStyle = `rgba(${bgColor.r},${bgColor.g},${bgColor.b},${bgColor.a})`;
    sourceCtx.fillRect(0, 0, w, h);
    hasPixels = true;
  }

  if ((bgImage && bgImage !== 'none') || hasBorder) {
    if (hasGradient(bgImage)) {
      const dataUrl = await renderGradientTexture(bgImage, w, h, borderRadius, style);
      const img = await loadImageFromUrl(dataUrl);
      sourceCtx.drawImage(img, 0, 0, w, h);
      hasPixels = true;
    } else if (!cssBackgroundMayTaintCanvas(bgImage)) {
      try {
        const nativeCanvas = await renderCssBackgroundTexture(style, w, h, borderRadius);
        if (isCanvasReadable(nativeCanvas)) {
          sourceCtx.drawImage(nativeCanvas, 0, 0, w, h);
          hasPixels = true;
        }
      } catch {}
    }
  }

  if (!hasPixels) return null;

  const hasClipPath = clipPath && clipPath !== 'none';
  // For pixel-perfect 1px borders that authors expect to follow the clip-path
  // outline (e.g. `.sub-card { border: 1px solid rgba(...,0.12); clip-path:
  // polygon(...) }`), we re-stroke the border on top of the bake using the
  // exact clip-path geometry. The CSS-rendered border inside the foreignObject
  // is rectangular and gets clipped at chamfered corners, often becoming
  // imperceptible after PNG → texture sampling — especially for low-alpha
  // hairlines. Stroking explicitly along the clip-path makes the border follow
  // the polygon and stays crisp regardless of texture downscaling.
  const needsExplicitBorder = hasBorder && hasClipPath && borderColor && borderColor.a > 0.001;

  if (!hasClipPath && borderRadius <= 0 && !needsExplicitBorder) {
    return sourceCanvas.toDataURL('image/png');
  }

  const scale = computeGradientExportScale(w, h);
  const renderW = Math.max(1, Math.ceil(w * scale));
  const renderH = Math.max(1, Math.ceil(h * scale));
  const clipScaleX = w > 0 ? renderW / w : 1;
  const clipScaleY = h > 0 ? renderH / h : 1;
  const hiResCanvas = document.createElement('canvas');
  hiResCanvas.width = renderW;
  hiResCanvas.height = renderH;
  const hiResCtx = hiResCanvas.getContext('2d');
  hiResCtx.save();
  const clipped = applyClipPathMask(hiResCtx, clipPath, renderW, renderH, clipScaleX, clipScaleY);
  if (!clipped) clipRoundedRect(hiResCtx, 0, 0, renderW, renderH, (borderRadius || 0) * scale);
  hiResCtx.drawImage(sourceCanvas, 0, 0, w, h, 0, 0, renderW, renderH);
  hiResCtx.restore();

  if (needsExplicitBorder) {
    hiResCtx.save();
    hiResCtx.strokeStyle = `rgba(${borderColor.r},${borderColor.g},${borderColor.b},${borderColor.a})`;
    // Round up sub-pixel widths so a `border: 1px` doesn't render as a
    // half-transparent 0.5px artefact when the bake is downscaled.
    hiResCtx.lineWidth = Math.max(1, borderWidth * scale);
    hiResCtx.lineJoin = 'miter';
    hiResCtx.lineCap = 'butt';
    if (buildClipPathOnCtx(hiResCtx, clipPath, renderW, renderH, clipScaleX, clipScaleY)) {
      hiResCtx.stroke();
    }
    hiResCtx.restore();
  }

  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = w;
  outputCanvas.height = h;
  const outputCtx = outputCanvas.getContext('2d');
  outputCtx.imageSmoothingEnabled = true;
  outputCtx.imageSmoothingQuality = 'high';
  outputCtx.drawImage(hiResCanvas, 0, 0, renderW, renderH, 0, 0, w, h);
  return outputCanvas.toDataURL('image/png');
}

// Render a CSS gradient to a canvas and return a PNG data URL
async function renderGradientTexture(bgImage, width, height, borderRadius, style = null, options = {}) {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  const scale = computeGradientExportScale(w, h);
  const renderW = Math.max(1, Math.ceil(w * scale));
  const renderH = Math.max(1, Math.ceil(h * scale));
  const hiResCanvas = document.createElement('canvas');
  hiResCanvas.width = renderW;
  hiResCanvas.height = renderH;
  const hiResCtx = hiResCanvas.getContext('2d', { willReadFrequently: true });
  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = w;
  outputCanvas.height = h;
  const outputCtx = outputCanvas.getContext('2d');
  const clipRoundedCorners = options.clipRoundedCorners !== false;
  const renderRadius = clipRoundedCorners ? (borderRadius || 0) : 0;

  if (!bgImage || bgImage === 'none') return outputCanvas.toDataURL('image/png');
  if (style) {
    const simpleGridDataUrl = tryRenderSimpleGridPatternTexture(bgImage, w, h, style);
    if (simpleGridDataUrl) return simpleGridDataUrl;
  }

  let renderedByBrowser = false;
  if (style) {
    try {
      const browserBgImage = style.backgroundImage || bgImage;
      if (!cssBackgroundMayTaintCanvas(browserBgImage)) {
        const nativeCanvas = await renderCssBackgroundTexture({
          backgroundImage: browserBgImage,
          backgroundColor: style.backgroundColor || 'transparent',
          backgroundSize: style.backgroundSize,
          backgroundPosition: style.backgroundPosition,
          backgroundRepeat: style.backgroundRepeat,
          backgroundOrigin: style.backgroundOrigin,
          backgroundClip: style.backgroundClip
        }, renderW, renderH, renderRadius * scale);
        if (isCanvasReadable(nativeCanvas)) {
          hiResCtx.drawImage(nativeCanvas, 0, 0, renderW, renderH);
          renderedByBrowser = true;
        }
      }
    } catch (e) {
      renderedByBrowser = false;
    }
  }

  if (!renderedByBrowser) {
    hiResCtx.save();
    clipRoundedRect(hiResCtx, 0, 0, renderW, renderH, renderRadius * scale);

    const parsed = parseCanvasGradient(hiResCtx, bgImage, renderW, renderH);
    if (parsed) {
      hiResCtx.fillStyle = parsed;
      hiResCtx.fillRect(0, 0, renderW, renderH);
    } else {
      // Basic fallback for simple rgb/rgba blocks
      const fc = parseGradientColor(bgImage);
      if (fc) {
        hiResCtx.fillStyle = `rgba(${fc.r},${fc.g},${fc.b},${fc.a})`;
        hiResCtx.fillRect(0, 0, renderW, renderH);
      }
    }
    hiResCtx.restore();
  }

  applyOrderedDither(hiResCtx, renderW, renderH);
  outputCtx.imageSmoothingEnabled = true;
  outputCtx.imageSmoothingQuality = 'high';
  outputCtx.drawImage(hiResCanvas, 0, 0, renderW, renderH, 0, 0, w, h);
  try {
    return outputCanvas.toDataURL('image/png');
  } catch {
    const fallbackCanvas = document.createElement('canvas');
    fallbackCanvas.width = w;
    fallbackCanvas.height = h;
    const fallbackCtx = fallbackCanvas.getContext('2d');
    const fallbackColor = parseGradientColor(bgImage);
    fallbackCtx.save();
    clipRoundedRect(fallbackCtx, 0, 0, w, h, borderRadius || 0);
    if (fallbackColor) {
      fallbackCtx.fillStyle = `rgba(${fallbackColor.r},${fallbackColor.g},${fallbackColor.b},${fallbackColor.a})`;
      fallbackCtx.fillRect(0, 0, w, h);
    }
    fallbackCtx.restore();
    return fallbackCanvas.toDataURL('image/png');
  }
}

// Parse CSS gradient string into a CanvasGradient object
function parseCanvasGradient(ctx, bgImage, w, h) {
  const colorStops = [];
  // Match any CSS color function (rgb/rgba/hsl/hsla/hwb/lab/lch/oklch/oklab/color/…),
  // hex (#rgb #rrggbb #rrggbbaa), or bare named keyword
  const colorFnRe = /(?:(?:rgba?|hsla?|hwb|lab|lch|oklch|oklab|color|device-cmyk|light-dark)\s*\([^)]+\)|#[0-9a-fA-F]{3,8}|[a-zA-Z][-a-zA-Z]*)\s*(?:[\d.]+%)?/g;
  const rawStops = bgImage.match(colorFnRe) || [];
  
  for (let i = 0; i < rawStops.length; i++) {
    let matchStr = rawStops[i].trim();
    // Extract the color portion (function, hex, or word) from the token
    const colorMatch = matchStr.match(/(?:(?:rgba?|hsla?|hwb|lab|lch|oklch|oklab|color|device-cmyk|light-dark)\s*\([^)]+\)|#[0-9a-fA-F]{3,8}|[a-zA-Z][-a-zA-Z]*)/);
    let colorStr = colorMatch ? colorMatch[0] : matchStr.split(/\s+/)[0];
    
    // Ignore gradient directional / structural keywords
    const kw = colorStr.toLowerCase();
    if (['circle', 'ellipse', 'at', 'top', 'bottom', 'left', 'right', 'center',
         'to', 'closest-side', 'closest-corner', 'farthest-side', 'farthest-corner',
         'radial-gradient', 'linear-gradient', 'conic-gradient',
         'radial', 'linear', 'gradient'].includes(kw)) continue;
    
    const pctMatch = matchStr.match(/([\d.]+)%/);
    let stop = null;
    if (pctMatch) {
       stop = parseFloat(pctMatch[1]) / 100;
    }
    colorStops.push({ color: colorStr, stop: stop });
  }

  if (colorStops.length < 2) return null;

  // Auto-distribute missing stops
  colorStops.forEach((cs, i) => {
    if (cs.stop === null) {
      if (i === 0) cs.stop = 0;
      else if (i === colorStops.length - 1) cs.stop = 1;
      else cs.stop = i / (colorStops.length - 1);
    }
    cs.stop = Math.min(1, Math.max(0, cs.stop));
  });

  let grad;
  if (/linear-gradient/.test(bgImage)) {
    const dirMatch = bgImage.match(/linear-gradient\(\s*(to\s+[^,]+|[\d.]+deg|[\d.]+turn)/i);
    let angle = 180; // default
    if (dirMatch) {
      const d = dirMatch[1].trim().toLowerCase();
      if (d.includes('to bottom')) angle = 180;
      else if (d.includes('to top')) angle = 0;
      else if (d.includes('to right')) angle = 90;
      else if (d.includes('to left')) angle = 270;
      else if (d.includes('to bottom right')) angle = 135;
      else if (d.includes('to top left')) angle = 315;
      else if (d.includes('to top right')) angle = 45;
      else if (d.includes('to bottom left')) angle = 225;
      else { const deg = parseFloat(d); if (!isNaN(deg)) angle = deg; }
    }
    const rad = (angle - 90) * Math.PI / 180;
    const cx = w/2, cy = h/2;
    const len = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
    const dx = Math.cos(rad) * len/2, dy = Math.sin(rad) * len/2;
    grad = ctx.createLinearGradient(cx-dx, cy-dy, cx+dx, cy+dy);
  } else if (/radial-gradient/.test(bgImage)) {
    let cx = w/2, cy = h/2;
    if (bgImage.includes('at 50% 0%') || bgImage.includes('at top')) cy = 0;
    else if (bgImage.includes('at bottom')) cy = h;
    grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w,h));
  } else {
    return null;
  }
  
  let validStops = 0;
  for (const cs of colorStops) {
    try { grad.addColorStop(cs.stop, cs.color); validStops++; }
    catch (_) { /* skip unrecognised color syntax */ }
  }
  if (validStops < 2) return null;
  return grad;
}

// Convert sRGB (0-1) to Linear (0-1) — UE SpecifiedColor uses FLinearColor
function sRGBToLinear(c) {
  if (c <= 0.04045) return c / 12.92;
  return Math.pow((c + 0.055) / 1.055, 2.4);
}

function colorToUE(r, g, b, a) {
  if (a === undefined) a = 1;
  return {
    R: sRGBToLinear(r / 255).toFixed(6),
    G: sRGBToLinear(g / 255).toFixed(6),
    B: sRGBToLinear(b / 255).toFixed(6),
    A: parseFloat(a).toFixed(6) // Alpha is NOT gamma-corrected
  };
}

function ueColor(c) {
  if (!c) return '(R=0.000000,G=0.000000,B=0.000000,A=1.000000)';
  const ue = colorToUE(c.r, c.g, c.b, c.a);
  return `(R=${ue.R},G=${ue.G},B=${ue.B},A=${ue.A})`;
}

function toRoman(n) {
  const map = [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];
  let out = '';
  for (const [v, s] of map) { while (n >= v) { out += s; n -= v; } }
  return out;
}

function getListMarker(el, cs) {
  if (!el || el.tagName.toLowerCase() !== 'li') return '';
  const listStyleType = cs.listStyleType;
  if (listStyleType === 'none') return '';
  const parent = el.parentElement;
  if (!parent) return '';
  const parentTag = parent.tagName.toLowerCase();
  let index = 0;
  for (const sib of parent.children) {
    if (sib === el) break;
    if (sib.tagName.toLowerCase() === 'li') index++;
  }
  let start = 1;
  if (parentTag === 'ol' && parent.hasAttribute('start')) {
    start = parseInt(parent.getAttribute('start')) || 1;
  }
  const n = index + start;
  switch (listStyleType) {
    case 'decimal': return `${n}. `;
    case 'decimal-leading-zero': return `${String(n).padStart(2, '0')}. `;
    case 'lower-alpha':
    case 'lower-latin': return `${String.fromCharCode(96 + ((n - 1) % 26) + 1)}. `;
    case 'upper-alpha':
    case 'upper-latin': return `${String.fromCharCode(64 + ((n - 1) % 26) + 1)}. `;
    case 'lower-roman': return `${toRoman(n).toLowerCase()}. `;
    case 'upper-roman': return `${toRoman(n)}. `;
    case 'disc': return '• ';
    case 'circle': return '○ ';
    case 'square': return '■ ';
    default:
      if (parentTag === 'ol') return `${n}. `;
      if (parentTag === 'ul') return '• ';
      return '';
  }
}

// Compute CanvasPanelSlot layout data (offsets + anchors). When the element
// touches both opposite edges of the parent (within EDGE_T px), the
// corresponding axis is stretched (min != max anchor). In stretch mode the
// paired offset becomes a distance from the opposite edge instead of a size.
function computeCanvasLayoutData(el, parentW, parentH) {
  const EDGE_T = 4; // edge-touch tolerance in px
  const PW = parentW > 0 ? parentW : 0;
  const PH = parentH > 0 ? parentH : 0;
  const stretchX = PW > 0 && el.x <= EDGE_T && (el.x + el.w) >= (PW - EDGE_T);
  const stretchY = PH > 0 && el.y <= EDGE_T && (el.y + el.h) >= (PH - EDGE_T);
  const aMinX = 0, aMaxX = stretchX ? 1 : 0;
  const aMinY = 0, aMaxY = stretchY ? 1 : 0;
  const offLeft = el.x;
  const offTop = el.y;
  const offRight = stretchX ? Math.max(0, PW - el.x - el.w) : el.w;
  const offBottom = stretchY ? Math.max(0, PH - el.y - el.h) : el.h;
  return {
    anchors: { minX: aMinX, minY: aMinY, maxX: aMaxX, maxY: aMaxY },
    offsets: { left: offLeft, top: offTop, right: offRight, bottom: offBottom },
    stretchX, stretchY
  };
}

function formatCanvasLayoutDataString(ld) {
  const o = ld.offsets, a = ld.anchors;
  return `(Offsets=(Left=${o.left.toFixed(6)},Top=${o.top.toFixed(6)},Right=${o.right.toFixed(6)},Bottom=${o.bottom.toFixed(6)}),Anchors=(Minimum=(X=${a.minX.toFixed(6)},Y=${a.minY.toFixed(6)}),Maximum=(X=${a.maxX.toFixed(6)},Y=${a.maxY.toFixed(6)})))`;
}

function fontWeightName(w) {
  const n = parseInt(w) || 400;
  if (n <= 300) return 'Light';
  if (n <= 500) return '';
  if (n <= 700) return 'Bold';
  return 'Black';
}

// Parse CSS text-shadow: "offsetX offsetY blur? color?" (first layer only).
// UMG TextBlock only supports offset + solid color (no blur), so we collapse
// blur into a slightly boosted alpha instead of losing it entirely.
function parseTextShadow(cssValue) {
  if (!cssValue || cssValue === 'none') return null;
  const firstLayer = cssValue.split(/,(?![^()]*\))/)[0].trim();
  const colorMatch = firstLayer.match(/rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/);
  let color = null;
  let remaining = firstLayer;
  if (colorMatch) {
    color = parseColor(colorMatch[0]);
    remaining = firstLayer.replace(colorMatch[0], '').trim();
  }
  const nums = remaining.match(/-?\d*\.?\d+/g) || [];
  const offsetX = parseFloat(nums[0]) || 0;
  const offsetY = parseFloat(nums[1]) || 0;
  const blurRadius = parseFloat(nums[2]) || 0;
  if (!color) color = { r: 0, g: 0, b: 0, a: 0.6 };
  if (offsetX === 0 && offsetY === 0 && blurRadius === 0) return null;
  if (color.a < 0.01) return null;
  return { offsetX, offsetY, blurRadius, color };
}

// Parse CSS box-shadow into a list of layers. Inset shadows are skipped
// (not supported). Each layer: offsetX, offsetY, blurRadius, spreadRadius, color.
function parseBoxShadow(cssValue) {
  if (!cssValue || cssValue === 'none') return null;
  const layers = cssValue.split(/,(?![^()]*\))/);
  const shadows = [];
  for (const raw of layers) {
    const layer = raw.trim();
    if (!layer || /\binset\b/i.test(layer)) continue;
    const colorMatch = layer.match(/rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/);
    const color = colorMatch ? parseColor(colorMatch[0]) : { r: 0, g: 0, b: 0, a: 0.5 };
    const remaining = colorMatch ? layer.replace(colorMatch[0], '') : layer;
    const nums = remaining.match(/-?\d*\.?\d+/g) || [];
    const offsetX = parseFloat(nums[0]) || 0;
    const offsetY = parseFloat(nums[1]) || 0;
    const blurRadius = parseFloat(nums[2]) || 0;
    const spreadRadius = parseFloat(nums[3]) || 0;
    if (offsetX === 0 && offsetY === 0 && blurRadius === 0 && spreadRadius === 0) continue;
    if (!color || color.a < 0.01) continue;
    shadows.push({ offsetX, offsetY, blurRadius, spreadRadius, color });
  }
  return shadows.length ? shadows : null;
}

function isWhiteish(c) {
  return c && c.r > 240 && c.g > 240 && c.b > 240 && c.a > 0.9;
}

function darkenColor(c, factor) {
  return {
    r: Math.round(c.r * factor),
    g: Math.round(c.g * factor),
    b: Math.round(c.b * factor),
    a: c.a
  };
}

function lightenColor(c, factor) {
  return {
    r: Math.min(255, Math.round(c.r + (255 - c.r) * factor)),
    g: Math.min(255, Math.round(c.g + (255 - c.g) * factor)),
    b: Math.min(255, Math.round(c.b + (255 - c.b) * factor)),
    a: c.a
  };
}

function isIconFontFamily(fontFamily) {
  return normalizeFontFamilyList(fontFamily).some(name => {
    const normalized = String(name || '').toLowerCase().trim();
    return /(^|[\s-])(font\s*awesome|fontawesome|material\s*(icons|symbols)|material design icons|bootstrap\s*icons|bootstrap-icons|remixicon|tabler-icons|ionicons|boxicons|simple-line-icons|line-awesome|glyphicons|codicon|anticon|octicons|phosphor|themify|weathericons|icomoon|iconmoon|mdi|eva icons)([\s-]|$)/i.test(normalized);
  });
}

function isLikelyIconClassName(className) {
  const tokens = String(className || '')
    .split(/\s+/)
    .map(token => token.trim().toLowerCase())
    .filter(Boolean);
  return tokens.some(token => /^(?:fa|fa-[\w-]+|fas|far|fal|fat|fab|fad|fak|svg-inline--fa(?:-[\w-]+)?|material-icons(?:-[\w-]+)?|material-symbols(?:-[\w-]+)?|ri-[\w-]+|bi|bi-[\w-]+|ti-[\w-]+|mdi|mdi-[\w-]+|iconfont|iconify|ph|ph-[\w-]+|bx|bx-[\w-]+|bxs-[\w-]+|bxr-[\w-]+|bxl-[\w-]+|fi-[\w-]+|icon-[\w-]+|ico-[\w-]+|glyphicon|glyphicon-[\w-]+|lucide|lucide-[\w-]+|feather|feather-[\w-]+|heroicon|heroicons|heroicon-[\w-]+|heroicons-[\w-]+|octicon|octicon-[\w-]+|codicon|codicon-[\w-]+|iconoir|iconoir-[\w-]+|anticon|anticon-[\w-]+|eva|eva-[\w-]+)$/.test(token));
}

function decodeCssEscapes(text) {
  return String(text || '')
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return '';
      }
    })
    .replace(/\\([\\'"])/g, '$1');
}

function cssContentToText(content) {
  let value = String(content || '').trim();
  if (!value || value === 'none' || value === 'normal') return '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return decodeCssEscapes(value).trim();
}

function getOwnTextContent(el) {
  if (!el) return '';
  return Array.from(el.childNodes || [])
    .filter(node => node.nodeType === Node.TEXT_NODE)
    .map(node => node.textContent || '')
    .join('')
    .trim();
}

function extractFontIconCharacter(el) {
  return decodeCssEscapes(getOwnTextContent(el) || (el.textContent || '')).trim();
}

function getRenderableIconCharacter(el, win) {
  const ownText = extractFontIconCharacter(el);
  if (ownText) return ownText;
  try {
    return cssContentToText(win.getComputedStyle(el, '::before').content);
  } catch {
    return '';
  }
}

// Strict emoji cluster regex — matches ONLY true color-emoji glyphs, i.e.:
//   - Chars with default emoji presentation (\p{Emoji_Presentation}): 🎉 ⚡ 👍 🚀 …
//   - Extended_Pictographic + VS16 (\uFE0F) — explicitly forces emoji form: ™️ ©️ ❤️
//   - ZWJ sequences for compound emoji: 👨‍👩‍👧‍👦
//   - Skin-tone modifiers appended to a base emoji: 👋🏽
//   - Regional-indicator pairs (flag emoji): 🇹🇷
//   - Keycap sequences: 1️⃣ #️⃣ *️⃣
// It INTENTIONALLY does NOT match bare typographic symbols like → ← ↑ ★ ▶ ® © ™
// when they appear without the VS16 selector — those are regular text glyphs,
// not emojis, and should stay in the TextBlock.
const EMOJI_CLUSTER_RE = (() => {
  // "Base emoji" accepts, in order of preference:
  //   1. Any SMP pictograph codepoint — U+1F000..U+1FFFF encoded as the UTF-16
  //      pair [\uD83C-\uD83F][\uDC00-\uDFFF]. This is the unconditional path
  //      that fixes 🗡 / 🖥 / 🎭 / 🫠 etc. — characters whose Unicode default
  //      presentation is technically "text" but which every modern renderer
  //      draws as a color emoji. Without this, users would have to append
  //      VS16 (U+FE0F) to every such codepoint for texture baking to trigger.
  //   2. BMP default-emoji codepoints via \p{Emoji_Presentation} — e.g. ⌚ ⭐.
  //   3. BMP pictographs via \p{Extended_Pictographic} IMMEDIATELY followed by
  //      VS16 — keeps typographic glyphs (→ ← ↑ ★ ▶ ® © ™) as plain text
  //      unless the author explicitly opted into emoji presentation.
  // IMPORTANT: With the /u flag a range over surrogate halves such as
  // [\uD83C-\uD83F] is treated as invalid and NEVER matches, so the obvious
  // `[\uD83C-\uD83F][\uDC00-\uDFFF]` pair trick does not work. The codepoint
  // escape form is required to express an SMP range under Unicode mode.
  const SMP_PICTO = '[\\u{1F000}-\\u{1FFFF}]';
  const BASE = `(?:${SMP_PICTO}|\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F)`;
  // Inside a ZWJ sequence the trailing VS16 on BMP Extended_Pictographic may be
  // omitted by some authors, so relax that rule there only.
  const BASE_ZWJ_TAIL = `(?:${SMP_PICTO}|\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F?)`;
  try {
    return new RegExp(
      '(?:\\uD83C[\\uDDE6-\\uDDFF]\\uD83C[\\uDDE6-\\uDDFF]' +                    // flag pair
      '|[#*0-9]\\uFE0F\\u20E3' +                                                   // keycap
      '|' + BASE +                                                                 // base emoji
      '(?:\\uFE0F' +                                                               // optional trailing VS16
      '|\\uD83C[\\uDFFB-\\uDFFF]' +                                                // skin-tone modifier
      '|\\u200D' + BASE_ZWJ_TAIL +                                                 // ZWJ-joined emoji
      ')*)',
      'gu'
    );
  } catch {
    // Fallback for engines without \p{} support — approximate by core emoji ranges.
    return /(?:\uD83C[\uDDE6-\uDDFF]\uD83C[\uDDE6-\uDDFF]|[#*0-9]\uFE0F\u20E3|(?:[\uD83C-\uD83F][\uDC00-\uDFFF]|[\u00A9\u00AE\u203C\u2049\u2122\u2139\u2194-\u2199\u21A9\u21AA\u231A\u231B\u2328\u23CF\u23E9-\u23F3\u23F8-\u23FA\u24C2\u25AA\u25AB\u25B6\u25C0\u25FB-\u25FE\u2600-\u27BF\u2934\u2935\u2B00-\u2BFF\u3030\u303D\u3297\u3299]\uFE0F?)(?:\uFE0F|\uD83C[\uDFFB-\uDFFF]|\u200D(?:[\uD83C-\uD83F][\uDC00-\uDFFF]|[\u00A9\u00AE\u2000-\u3299]\uFE0F?))*)/gu;
  }
})();

function textContainsEmoji(text) {
  if (!text) return false;
  const re = new RegExp(EMOJI_CLUSTER_RE.source, EMOJI_CLUSTER_RE.flags);
  return re.test(String(text));
}

function stripEmojiClusters(text) {
  const re = new RegExp(EMOJI_CLUSTER_RE.source, EMOJI_CLUSTER_RE.flags);
  return String(text || '').replace(re, '');
}

// Broader inline-extractable cluster regex used by extractAndBakeInlineEmojis
// to also pull single-codepoint decorative symbols (⚔ ☠ ✦ ★ ➤ ◆ etc.) out of
// body text. EMOJI_CLUSTER_RE intentionally rejects these without VS16 so
// that bare typography (→ ← ↑ ®) stays as text — but Unreal's default runtime
// fonts almost never ship glyphs for the U+2600..U+27BF / U+2B00..U+2BFF
// blocks, so leaving "⚔ Savaş başladı" verbatim in a TextBlock renders the
// leading glyph as a tofu box. By extracting them inline we bake an Image
// at the original glyph rect and strip the codepoint from the TextBlock.
//
// Why two regexes instead of broadening EMOJI_CLUSTER_RE itself:
//   - EMOJI_CLUSTER_RE is also used by isStandaloneEmojiOrSymbolGlyph and
//     getUsedFontSummary — broadening it there has different semantics.
//   - The strict regex's rule that ZWJ/skin-tone/keycap join-on-base
//     requires emoji presentation must NOT be relaxed for body text or
//     unrelated codepoints get glued into bogus clusters.
const INLINE_BAKEABLE_RE = (() => {
  const SMP_PICTO = '[\\u{1F000}-\\u{1FFFF}]';
  const BASE = `(?:${SMP_PICTO}|\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F)`;
  const BASE_ZWJ_TAIL = `(?:${SMP_PICTO}|\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F?)`;
  // Standalone decorative typography that should ALSO be extracted inline.
  // Limited to Misc Symbols + Dingbats and the second Misc Symbols and Arrows
  // block — these contain ⚔ ☠ ✦ ★ ➤ ◆ ✓ ✗ etc. that almost no engine font
  // covers. Arrows (U+2190..U+21FF) are intentionally excluded because they
  // ARE common typography tokens that engine fonts usually have.
  const DECO = '[\\u2600-\\u27BF\\u2B00-\\u2BFF]\\uFE0F?';
  try {
    return new RegExp(
      '(?:\\uD83C[\\uDDE6-\\uDDFF]\\uD83C[\\uDDE6-\\uDDFF]' +
      '|[#*0-9]\\uFE0F\\u20E3' +
      '|' + BASE +
      '(?:\\uFE0F|\\uD83C[\\uDFFB-\\uDFFF]|\\u200D' + BASE_ZWJ_TAIL + ')*' +
      '|' + DECO +
      ')',
      'gu'
    );
  } catch {
    return new RegExp(EMOJI_CLUSTER_RE.source, EMOJI_CLUSTER_RE.flags);
  }
})();

function textContainsInlineBakeableGlyph(text) {
  if (!text) return false;
  const re = new RegExp(INLINE_BAKEABLE_RE.source, INLINE_BAKEABLE_RE.flags);
  return re.test(String(text));
}

function stripInlineBakeableGlyphs(text) {
  const re = new RegExp(INLINE_BAKEABLE_RE.source, INLINE_BAKEABLE_RE.flags);
  return String(text || '').replace(re, '');
}

// Broad typographic / decorative glyph ranges — the symbols designers
// commonly use as iconography when they DON'T have a dedicated icon font:
// crossed swords (⚔ U+2694), skull (☠ U+2620), four-pointed star (✦ U+2726),
// arrows (→ ← ↑ ↓), geometric shapes (■ ▲ ● ◆), dingbats (★ ✓ ✗ ➤), etc.
// These codepoints deliberately do NOT match the strict EMOJI_CLUSTER_RE
// above because inside body text they should stay as normal glyphs; but
// when they appear as the ONLY content of an element (a standalone icon
// span) OR as CSS ::before / ::after content, they are decorative and must
// be baked to a texture so Unreal's text fonts don't render a tofu box.
//
// Ranges covered:
//   U+00A9/AE/2122/2139 — © ® ™ ℹ
//   U+203C/2049         — ‼ ⁉
//   U+2190-21FF         — Arrows
//   U+2300-23FF         — Misc Technical (⌘ ⌚ ⏰ …)
//   U+2460-24FF         — Enclosed Alphanumerics (① ⑴ …)
//   U+25A0-25FF         — Geometric Shapes
//   U+2600-27BF         — Misc Symbols + Dingbats  ← ⚔ ☠ ✦ live here
//   U+2900-297F         — Supplemental Arrows
//   U+2B00-2BFF         — Misc Symbols and Arrows
const DECORATIVE_TYPOGRAPHIC_RE = /^[\u00A9\u00AE\u203C\u2049\u2122\u2139\u2190-\u21FF\u2300-\u23FF\u2460-\u24FF\u25A0-\u25FF\u2600-\u27BF\u2900-\u297F\u2B00-\u2BFF\s]+$/u;

function isStandaloneEmojiOrSymbolGlyph(text) {
  const raw = String(text || '').trim().replace(/\uFE0E|\uFE0F/g, '');
  if (!raw) return false;
  if (Array.from(raw).length > 10) return false;
  // Private-use area (icon fonts like FontAwesome) is still treated as icon
  if (/[\uE000-\uF8FF]/u.test(raw)) return true;
  // Strict emoji check: whole string consists only of emoji clusters + whitespace
  const withoutEmoji = stripEmojiClusters(raw).replace(/\s+/g, '');
  if (withoutEmoji.length === 0) return true;
  // Broad typographic fallback — matches ⚔ ☠ ✦ ★ → ◆ etc. when the element's
  // entire trimmed content is decorative symbols. Gated on the 10-codepoint
  // length cap above so long word strings that happen to contain a symbol
  // cannot accidentally trip this path.
  return DECORATIVE_TYPOGRAPHIC_RE.test(raw);
}

// Permissive detector for CSS pseudo-element content (::before / ::after).
// Pseudo content is author-written CSS (not user text), so when a designer
// puts `content: "★"` or `content: "➤"` on `::before`, they're explicitly
// placing a decorative glyph — we should treat it as an icon and bake it.
// Currently identical to isStandaloneEmojiOrSymbolGlyph; kept as a distinct
// function so future tweaks to either policy (e.g. looser size cap for
// pseudo, or a different whitespace policy) don't have to touch both sites.
function isPseudoDecorativeGlyph(text) {
  return isStandaloneEmojiOrSymbolGlyph(text);
}

function isRenderableFontIconElement(el, cs, win) {
  if (!el || !cs || !win || el.children.length !== 0) return false;
  const ownText = extractFontIconCharacter(el);
  const familyOrClassIcon = isIconFontFamily(cs.fontFamily) || isLikelyIconClassName(el.className);
  if (familyOrClassIcon) {
    if (ownText) return true;
    try {
      return !!cssContentToText(win.getComputedStyle(el, '::before').content);
    } catch {
      return false;
    }
  }
  return !!ownText && isStandaloneEmojiOrSymbolGlyph(ownText);
}

function normalizeFontFamilyList(fontFamilyValue) {
  return String(fontFamilyValue || '')
    .split(',')
    .map(part => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

// Used Fonts panel filter. We ONLY drop:
//   - The five CSS generic families (`sans-serif`, `serif`, `monospace`,
//     `cursive`, `fantasy`) — the user can't install a generic.
//   - The `ui-*` and `system-ui` keywords — they resolve to whatever the OS
//     decides at render time and are not packageable typefaces.
//   - The macOS / Windows system-stack tokens (`-apple-system`,
//     `BlinkMacSystemFont`) which are aliases, not real font names.
//   - The `emoji`, `math`, `fangsong` script-specific generics.
//   - CSS-wide reset keywords (`inherit`, `initial`, `unset`, `revert`).
// Specific named typefaces — including ubiquitous ones like Arial, Helvetica,
// Trebuchet MS, Courier New, Segoe UI, Roboto — are KEPT in the panel even if
// they happen to ship with most desktop OSes, because Unreal's runtime fonts
// don't include any of them and the user must explicitly add a Font asset to
// match the original look. (User report: "fontları analiz edilememiş gözüküyor
// used fonts kısmında" — the page used Arial Narrow / Trebuchet MS / Courier
// New, all named real fonts the user wanted to see in the chip list.)
const GENERIC_FONT_FAMILIES = new Set([
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy',
  'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded',
  'emoji', 'math', 'fangsong',
  '-apple-system', 'blinkmacsystemfont',
  'inherit', 'initial', 'unset', 'revert'
]);

function isGenericFontFamily(name) {
  const lower = String(name || '').toLowerCase().trim();
  if (!lower) return true;
  return GENERIC_FONT_FAMILIES.has(lower);
}

// Extract font-family names declared in a Google Fonts request URL.
// Supports both the legacy /css?family=A|B and the /css2?family=A&family=B forms.
function parseGoogleFontsFamilies(url) {
  const names = [];
  if (!url || !/fonts\.googleapis\.com/i.test(url)) return names;
  try {
    const u = new URL(url);
    const path = u.pathname || '';
    if (/\/css2\b/.test(path)) {
      for (const raw of u.searchParams.getAll('family')) {
        const name = raw.split(':')[0].replace(/\+/g, ' ').trim();
        if (name) names.push(name);
      }
    } else {
      const family = u.searchParams.get('family') || '';
      for (const raw of family.split('|')) {
        const name = raw.split(':')[0].replace(/\+/g, ' ').trim();
        if (name) names.push(name);
      }
    }
  } catch { /* malformed URL */ }
  return names;
}

// Return a browse/specimen URL for known icon-font families so their chips
// link straight to the official icon index instead of a raw text search.
function getIconFontSpecimenUrl(family) {
  const lower = String(family || '').toLowerCase();
  if (/font\s*awesome|fontawesome/.test(lower)) return 'https://fontawesome.com/icons';
  if (/material\s*symbols/.test(lower)) return 'https://fonts.google.com/icons?icon.set=Material+Symbols';
  if (/material\s*icons|material design icons/.test(lower)) return 'https://fonts.google.com/icons?icon.set=Material+Icons';
  if (/bootstrap\s*icons|bootstrap-icons/.test(lower)) return 'https://icons.getbootstrap.com/';
  if (/remix\s*icon|remixicon/.test(lower)) return 'https://remixicon.com/';
  if (/tabler/.test(lower)) return 'https://tabler.io/icons';
  if (/phosphor/.test(lower)) return 'https://phosphoricons.com/';
  if (/ionicon/.test(lower)) return 'https://ionic.io/ionicons';
  if (/boxicon/.test(lower)) return 'https://boxicons.com/';
  if (/line\s*awesome/.test(lower)) return 'https://icons8.com/line-awesome';
  if (/simple-line-icons|simple line icons/.test(lower)) return 'https://simplelineicons.github.io/';
  if (/^mdi\b|material design icons/.test(lower)) return 'https://pictogrammers.com/library/mdi/';
  if (/octicons/.test(lower)) return 'https://primer.style/foundations/icons';
  if (/themify/.test(lower)) return 'https://themify.me/themify-icons';
  if (/codicon/.test(lower)) return 'https://microsoft.github.io/vscode-codicons/dist/codicon.html';
  return null;
}

// ==================== HTML ANALYZER ====================

const INTERACTIVE_UE_WIDGET_TYPES = new Set([
  'Button',
  'EditableTextBox',
  'CheckBox',
  'ComboBoxString',
  'Slider',
  'ScrollBox',
  'ExpandableArea'
]);

function isInteractiveUeWidgetType(ueType) {
  return INTERACTIVE_UE_WIDGET_TYPES.has(ueType);
}

function hasCustomShapeBrush(el) {
  return !!(el && (el.customShape || el.hasCustomShape));
}

function getUeVisibilityStateForWidget(el) {
  const ueType = typeof el === 'string' ? el : (el && el.ueType);
  return isInteractiveUeWidgetType(ueType) ? 'Visible' : 'SelfHitTestInvisible';
}

class HTMLAnalyzer {
  constructor(w, h, options) {
    this.w = w;
    this.h = h;
    // Render options: which expensive visual effects to bake into textures.
    // Both default to true. When false, the effect is skipped entirely (no
    // texture is created and the corresponding element property is omitted).
    const opts = options || {};
    this.renderShadows = opts.renderShadows !== false;
    this.renderGradients = opts.renderGradients !== false;
    this.renderFontIcons = opts.renderFontIcons === true;
    // CSS @keyframes export gate. When false, the analyzer skips
    // `_buildKeyframesIndex` AND `_extractElementAnimations` entirely so
    // no `animations[]` field is attached to any widget — equivalent to
    // a pre-animation-feature export. Defaults to true so animations are
    // included when the user hasn't explicitly opted out.
    this.renderAnimations = opts.renderAnimations !== false;
    this._progressReporter = typeof opts.progress === 'function' ? opts.progress : null;
    this.elements = [];
    this.textures = [];
    this.counters = {};
    this.fontFamilies = new Set();
    this.fontSources = new Set();
  }

  reportProgress(message) {
    if (this._progressReporter) this._progressReporter(message);
  }

  recordFontFamily(fontFamilyValue) {
    normalizeFontFamilyList(fontFamilyValue).forEach(name => this.fontFamilies.add(name));
  }

  recordFontSource(source) {
    const value = String(source || '').trim();
    if (value) this.fontSources.add(value);
  }

  collectFontSources(doc) {
    for (const link of doc.querySelectorAll('link[href]')) {
      const rel = (link.getAttribute('rel') || '').toLowerCase();
      const as = (link.getAttribute('as') || '').toLowerCase();
      const href = link.href || link.getAttribute('href') || '';
      if (rel.includes('stylesheet') || rel.includes('preload') || as === 'style' || /font|typekit|fonts\.googleapis|fontawesome/i.test(href)) {
        this.recordFontSource(href);
      }
    }
    for (const styleEl of doc.querySelectorAll('style')) {
      const css = styleEl.textContent || '';
      for (const match of css.matchAll(/@import\s+(?:url\()?['"]?([^'")\s]+)['"]?\)?/gi)) {
        this.recordFontSource(match[1]);
      }
    }
    for (const sheet of Array.from(doc.styleSheets || [])) {
      let rules = null;
      try { rules = sheet.cssRules; } catch {}
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        const fontFaceRuleType = (typeof CSSRule !== 'undefined' && CSSRule.FONT_FACE_RULE) || 5;
        if (rule.type === fontFaceRuleType) {
          const family = rule.style.getPropertyValue('font-family');
          const src = rule.style.getPropertyValue('src');
          if (family || src) this.recordFontSource(`@font-face ${family || ''} ${src || ''}`.trim());
        }
      }
    }
  }

  getUsedFontSummary() {
    // Pull out family names that were actually used on elements, minus the
    // generic / ubiquitous-system fonts that aren't installable as a package.
    const families = Array.from(this.fontFamilies)
      .map(name => String(name || '').trim())
      .filter(name => name && !isGenericFontFamily(name));

    // Build a Google Fonts lookup from any <link> / @import URLs we collected.
    // Key is lower-cased display name; value is the original casing so the chip
    // label shows the canonical form (e.g. "Poppins", not "poppins").
    const googleFonts = new Map();
    for (const src of this.fontSources) {
      for (const gf of parseGoogleFontsFamilies(src)) {
        googleFonts.set(gf.toLowerCase(), gf);
      }
    }
    const hasAnyGoogleFontsHref = Array.from(this.fontSources).some(
      s => /fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(s)
    );

    // De-dupe while preserving the best-cased label we've seen (Google Fonts
    // URL casing wins over CSS-declared casing because the URL is canonical).
    const seen = new Map();
    for (const name of families) {
      const key = name.toLowerCase();
      if (!seen.has(key)) seen.set(key, name);
    }
    for (const [key, gf] of googleFonts) {
      if (!seen.has(key)) seen.set(key, gf); // family only referenced by URL
      else seen.set(key, gf);                // prefer Google Fonts casing
    }

    const summary = [];
    for (const [key, displayName] of seen) {
      const iconUrl = getIconFontSpecimenUrl(displayName);
      if (iconUrl) {
        summary.push({ name: displayName, url: iconUrl, type: 'iconFont' });
        continue;
      }
      if (googleFonts.has(key)) {
        const slug = encodeURIComponent(displayName.replace(/\s+/g, '+'));
        summary.push({
          name: displayName,
          url: `https://fonts.google.com/specimen/${slug}`,
          type: 'googleFonts'
        });
        continue;
      }
      // Fallback: if ANY Google Fonts stylesheet was linked, it's reasonable to
      // send the user to the Google Fonts search for the family name even when
      // our URL parser didn't pick it up (e.g. preconnect-only loads).
      if (hasAnyGoogleFontsHref) {
        const query = encodeURIComponent(displayName);
        summary.push({
          name: displayName,
          url: `https://fonts.google.com/?query=${query}`,
          type: 'googleFontsSearch'
        });
        continue;
      }
      summary.push({ name: displayName });
    }

    summary.sort((a, b) => a.name.localeCompare(b.name));
    return summary;
  }

  async analyze(html) {
    return new Promise((resolve, reject) => {
      this.reportProgress(`Loading iframe (${this.w}x${this.h})`);
      const iframe = document.getElementById('renderFrame');
      iframe.style.width = this.w + 'px';
      iframe.style.height = this.h + 'px';
      iframe.style.display = 'block';

      iframe.onload = () => {
        this.reportProgress('Iframe loaded');
        // Wait for fonts (FontAwesome etc.) to fully load before traversing
        const win0 = iframe.contentWindow;
        const fontsReady = win0.document.fonts ? win0.document.fonts.ready : Promise.resolve();
        this.reportProgress('Waiting for fonts');
        fontsReady.then(() => {
          this.reportProgress('Fonts ready');
          setTimeout(async () => {
          try {
            const doc = iframe.contentDocument;
            const body = doc.body;
            const win = iframe.contentWindow;
            if (!body) { reject(new Error('Body not found')); return; }

            this.elements = [];
            this.textures = [];
            this.counters = {};
            this.scrollRegions = [];
            // Panel groups discovered during traversal. Each entry corresponds
            // to a `data-ue-panel="..."` container that the exporter emits as
            // its own UMG.CanvasPanel with `Visibility=Collapsed` (or Visible
            // when `data-ue-panel-default="open"`). Children of the panel are
            // tagged via `_meta.panelGroup` and the exporter pulls them out
            // of the root canvas's child list, putting them inside the panel
            // CanvasPanel instead.
            this.panelGroups = [];
            this._texCache = new Map();
            this.fontFamilies = new Set();
            this.fontSources = new Set();
            this.collectFontSources(doc);
            this.reportProgress('Preparing DOM');

            // Capture page background color from body or root element
            let pageBgColor = null;
            const bodyCs = win.getComputedStyle(body);
            pageBgColor = parseColor(bodyCs.backgroundColor);
            if (!pageBgColor || pageBgColor.a < 0.01) {
              pageBgColor = parseGradientColor(bodyCs.backgroundImage);
            }
            // Also check <html> element
            if (!pageBgColor || pageBgColor.a < 0.01) {
              const htmlEl = doc.documentElement;
              const htmlCs = win.getComputedStyle(htmlEl);
              pageBgColor = parseColor(htmlCs.backgroundColor);
              if (!pageBgColor || pageBgColor.a < 0.01) {
                pageBgColor = parseGradientColor(htmlCs.backgroundImage);
              }
            }
            // Default to black if nothing found
            if (!pageBgColor || pageBgColor.a < 0.01) {
              pageBgColor = { r: 0, g: 0, b: 0, a: 1 };
            }

            // Preserve the source open/closed state before force-opening so we
            // can export the original expanded flag and state-specific summary
            // indicator styling later.
            doc.querySelectorAll('details').forEach(d => {
              d.setAttribute('data-ue-original-open', d.hasAttribute('open') ? '1' : '0');
            });
            // Force-open all <details> elements so their full content is measured
            doc.querySelectorAll('details:not([open])').forEach(d => { d.open = true; });

            // Reset the DOM-element registry that traverse() will populate
            // for scroll containers. We use it in `assignPanelGroupsByDom`
            // to detect "innermost ancestor is scroll, not panel" cases.
            this._scrollContainerRegistry = new Map();

            // JS-driven panel population: click every `data-ue-toggle` button
            // before force-show so user scripts that lazily build a panel's
            // body on first open (canonical pattern: `togglePanel('inv')`
            // calls `buildInventory()` which fills `<div class="inv-grid">`)
            // run and inject their DOM children. Without this pass, panels
            // that are empty in source HTML stay empty and the analyzer
            // sees 0 children.
            //
            // We intentionally do NOT try to keep panels "all open at once"
            // here — the user's script may toggle other panels closed when
            // a new one is opened. That's fine: the post-click state of the
            // panels (open or closed) is irrelevant because force-show runs
            // RIGHT AFTER and forces every panel visible regardless. The
            // DOM children created by the click handlers persist.
            //
            // Errors inside click handlers are swallowed; we do not want a
            // single malformed page script to abort the whole analyze().
            // Two selectors are dispatched:
            //   1. `[data-ue-toggle]` — the explicit, opt-in marker authors
            //      can place on toggle buttons.
            //   2. `[onclick]` — generic inline click handlers. The
            //      canonical pattern in non-marker pages is the bare
            //      `<button onclick="togglePanel('tree')">` whose handler
            //      lazy-builds skill-tree nodes. Without firing these,
            //      panels populated by `buildTree()` / `buildInventory()`
            //      etc. ship empty (`tree-container` had zero children →
            //      no tree-node widgets → no emoji icons in the export).
            // Dedup is by handler/target STRING so multiple buttons with
            // the same `togglePanel('tree')` onclick fire once each (the
            // close-X button and the nav-btn share onclick=`togglePanel('tree')`,
            // we only need the first to trigger the lazy build).
            // ── Destruction guard ──────────────────────────────────────────
            // The onclick-firing loop below fires ALL `[onclick]` handlers to
            // trigger lazy panel builders (`buildInventory()`, `togglePanel()`
            // etc.). A side-effect is that buttons like `onclick="doQuit()"`,
            // `onclick="resetGame()"` or `onclick="window.location='...'"`
            // also fire — in the worst case replacing `document.body.innerHTML`
            // entirely (the user-reported "FAREWELL, WANDERER" bug where the
            // whole widget came out as one text node).
            //
            // We neutralize this BEFORE clicking by shadowing `document.body`'s
            // own `innerHTML` property with a no-op setter. The shadow is
            // implemented as an own-property on `doc.body` specifically so that
            // `someDiv.innerHTML = '...'` (used by panel builders) continues to
            // work through the prototype chain. We also guard:
            //   • `document.open()` / `document.write()` — page-teardown sequence
            //   • `window.location` assignment — navigation away from the srcdoc
            // All three guards are confined to the iframe's window object and
            // are cleaned up (configurable:true) if we ever need to restore them,
            // though the iframe document is discarded after analyze() anyway.
            try {
              const _bodyElemProtoDesc = Object.getOwnPropertyDescriptor(
                win.Element.prototype, 'innerHTML');
              if (_bodyElemProtoDesc) {
                Object.defineProperty(doc.body, 'innerHTML', {
                  set(_v) { /* guard: silently suppress document.body wipe during analysis */ },
                  get() { return _bodyElemProtoDesc.get.call(this); },
                  configurable: true
                });
              }
              // Guard document.open() so page-teardown sequences can't nuke the DOM
              const _origDocOpen = doc.open.bind(doc);
              doc.open = function() { /* no-op during analysis */ };
              // Guard location redirects (srcdoc navigation would reload the frame)
              try {
                Object.defineProperty(win, 'location', {
                  set(_v) { /* no-op */ },
                  get() { return win.location; },
                  configurable: true
                });
              } catch { /* some browsers make location non-configurable — skip */ }
            } catch (_guardErr) { /* guard setup failed — non-fatal, continue without it */ }

            try {
              const _toggleBtns = doc.querySelectorAll('[data-ue-toggle], [onclick]');
              const _seenToggleTargets = new Set();
              for (const btn of _toggleBtns) {
                if (!this._shouldAutoClickTrigger(btn, doc)) continue;
                const _key = (btn.getAttribute('data-ue-toggle') ||
                              btn.getAttribute('onclick') || '').trim();
                if (!_key || _seenToggleTargets.has(_key)) continue;
                _seenToggleTargets.add(_key);
                try { btn.click(); } catch (_e) { /* swallow page-script error */ }
              }
            } catch (_e) { /* selector or DOM error — non-fatal */ }
            this.reportProgress('DOM preparation complete');

            // After toggle clicks may have injected fresh `<img>` elements
            // (e.g. inventory item icons created by `buildInventory()`'s
            // `slot.innerHTML = '<img src="items.png">...'` line), wait for
            // them to load before traversing. Without this wait, texture
            // extraction fires while images are still in their `complete=false`
            // state — `getBoundingClientRect()` returns the layout slot but
            // the canvas `drawImage` source is empty, producing transparent
            // textures that show as "white" / missing in UE.
            //
            // Each pending image gets a 5s safety timeout so a 404'd or
            // CORS-blocked asset cannot stall the whole analyze pass. Errors
            // resolve the wait too — the texture extraction will fall back
            // to whatever `<img>.naturalWidth/naturalHeight` reports.
            try {
              const _allImgs = Array.from(doc.querySelectorAll('img'));
              const _pending = _allImgs.filter(im => !im.complete || (im.naturalWidth === 0 && im.naturalHeight === 0));
              if (_pending.length) {
                await Promise.all(_pending.map(im => new Promise(resolve => {
                  let done = false;
                  const finish = () => { if (done) return; done = true; im.removeEventListener('load', finish); im.removeEventListener('error', finish); resolve(); };
                  im.addEventListener('load', finish);
                  im.addEventListener('error', finish);
                  setTimeout(finish, 5000);
                })));
              }
            } catch (_e) { /* non-fatal */ }

            // Force-show every `data-ue-panel` container so its subtree is
            // measurable. Without this, a panel that is `display:none` in its
            // default state contributes 0×0 rects to `getBoundingClientRect`
            // and is dropped at the traverse hidden-skip guard. We override
            // `display`, `visibility`, `opacity`, and the `hidden` attribute
            // with !important inline styles — this beats stylesheet rules
            // and per-element style. The override stays in place for the
            // entire analyze() pass; we don't bother undoing it because the
            // iframe document is throwaway anyway. Toggle-state in UMG is
            // expressed via the per-panel CanvasPanel's `Visibility` field
            // (Collapsed by default, Visible when `data-ue-panel-default="open"`).
            //
            // We also build a registry of panel names while we're here so
            // `traverse()` can look up "is this element a known panel root?"
            // without re-querying the DOM each call.
            const panelRoots = doc.querySelectorAll('[data-ue-panel]');
            this._panelRegistry = new Map();
            const _seenPanelNames = new Set();
            for (const panelEl of panelRoots) {
              const rawName = (panelEl.getAttribute('data-ue-panel') || '').trim();
              if (!rawName) continue;
              // Sanitize to UMG-safe identifier; suffix when duplicates.
              let safeName = this._sanitizeUmgIdentifier(rawName) || 'Panel';
              let dedup = safeName;
              let n = 2;
              while (_seenPanelNames.has(dedup)) dedup = `${safeName}_${n++}`;
              _seenPanelNames.add(dedup);
              const defaultOpen =
                (panelEl.getAttribute('data-ue-panel-default') || '').trim().toLowerCase() === 'open';
              this._panelRegistry.set(panelEl, { name: dedup, defaultOpen });
            }
            // Build the CSS @keyframes index ONCE for the document. The
            // index is consumed by the `traverse()` wrapper to attach
            // `animations[]` to every widget whose source element has a
            // matching computed `animation-name`. Cross-origin sheets are
            // silently skipped (their `cssRules` access throws).
            this._buildKeyframesIndex(doc);
            // Conservative force-show — preserve every panel's natural
            // `display` whenever possible. Forcing `display:block`
            // unconditionally was a bug: panels that legitimately use
            // `display:flex` / `display:grid` for their internal layout
            // (e.g. a `.char-layout` flexbox holding a portrait + stats
            // column) had their layout collapsed, making children
            // overflow the panel rect and miss-measure during traversal.
            //
            // Two-pass strategy:
            //   1) Sample the natural display value used by panels that
            //      are CURRENTLY visible (any `[data-ue-panel]` whose
            //      cascade gives a non-`none` display). Authors typically
            //      style every panel uniformly via a shared class so the
            //      modal "open" panel's display value is also the value
            //      every hidden sibling should adopt.
            //   2) For each hidden panel, try clearing its inline display
            //      first (covers the `style="display:none"` authoring
            //      pattern). If cascade STILL hides it, force the sampled
            //      visible display (or fall back to `block`). Author can
            //      override with `data-ue-panel-display="flex|grid|...".
            //
            // Visibility / opacity / hidden-attr force-show is unchanged.
            this._forceShowPanelRoots(panelRoots, body);

            const root = this.findRoot(body);
            const bodyRect = body.getBoundingClientRect();

            // If body has a CSS gradient/pattern background, render it as a full-page texture
            // Strategy: Don't use parseCanvasGradient at all for grid patterns.
            // Instead, manually draw 1px white lines on a transparent tile canvas,
            // then tile it across the full page. Store original low-alpha color as
            // gridTintColor so UE applies it via TintColor.
            const bodyBgImage = bodyCs.backgroundImage || '';
            const htmlBgCsForTexture = win.getComputedStyle(doc.documentElement);
            const textureBgCs = (bodyBgImage && bodyBgImage !== 'none') ? bodyCs : htmlBgCsForTexture;
            const textureBgImage = textureBgCs.backgroundImage || '';
            const bgStr = textureBgImage.toLowerCase();
            const isGridPattern = hasGradient(textureBgImage) && (bgStr.includes('1px') || bgStr.includes('repeating-'));
            if (isGridPattern) {
              const bgSize = textureBgCs.backgroundSize || '30px 30px';
              const firstSize = bgSize.split(',')[0].trim();
              const sizeParts = firstSize.split(/\s+/);
              const tileW = parseInt(sizeParts[0]) || 30;
              const tileH = parseInt(sizeParts[1] || sizeParts[0]) || tileW;

              // Extract original tint color from gradient (the low-alpha color)
              let gridTintColor = null;
              const rgbaMatch = textureBgImage.match(/rgba?\(([^)]+)\)/);
              if (rgbaMatch) {
                const parts = rgbaMatch[1].split(',').map(s => parseFloat(s.trim()));
                if (parts.length >= 4) {
                  gridTintColor = { r: parts[0], g: parts[1], b: parts[2], a: parts[3] };
                } else if (parts.length === 3) {
                  gridTintColor = { r: parts[0], g: parts[1], b: parts[2], a: 1 };
                }
              }

              // Manual canvas drawing — NO parseCanvasGradient.
              // Draw crisp 1px white lines on transparent background.
              const tileCanvas = document.createElement('canvas');
              tileCanvas.width = tileW;
              tileCanvas.height = tileH;
              const tctx = tileCanvas.getContext('2d');
              // Canvas stays transparent — no fillRect for background
              tctx.fillStyle = 'rgba(255, 255, 255, 1)';
              tctx.fillRect(0, 0, tileW, 1); // Top horizontal line
              tctx.fillRect(0, 0, 1, tileH); // Left vertical line

              // Tile across full page
              const patternCanvas = document.createElement('canvas');
              patternCanvas.width = this.w;
              patternCanvas.height = this.h;
              const pctx = patternCanvas.getContext('2d');
              const pattern = pctx.createPattern(tileCanvas, 'repeat');
              if (pattern) {
                pctx.fillStyle = pattern;
                pctx.fillRect(0, 0, this.w, this.h);
              }

              const texName = `T_BodyPattern_${SESSION_ID}`;
              const uePath = `/Game/UI/Textures/${texName}`;
              this.textures.push({ url: patternCanvas.toDataURL('image/png'), name: texName + '.png', suggestedPath: uePath, isGradient: true });
              this.elements.unshift({
                ueType:'Image', name:this.uid('Image_BodyBg'), x:0, y:0, w:this.w, h:this.h,
                bgColor:null, borderRadius:0, gradientTexturePath:uePath,
                gridTintColor: gridTintColor
              });
            } else if (hasGradient(textureBgImage)) {
              // Standard body gradient (no grid pattern)
              const texName = `T_BodyGrad_${SESSION_ID}`;
              const uePath = `/Game/UI/Textures/${texName}`;
              const dataUrl = await renderGradientTexture(textureBgImage, this.w, this.h, 0, {
                backgroundImage: textureBgCs.backgroundImage,
                backgroundColor: textureBgCs.backgroundColor,
                backgroundSize: textureBgCs.backgroundSize,
                backgroundPosition: textureBgCs.backgroundPosition,
                backgroundRepeat: textureBgCs.backgroundRepeat,
                backgroundOrigin: textureBgCs.backgroundOrigin,
                backgroundClip: textureBgCs.backgroundClip
              });
              this.textures.push({ url: dataUrl, name: texName + '.png', suggestedPath: uePath, isGradient: true });
              this.elements.unshift({
                ueType:'Image', name:this.uid('Image_BodyBg'), x:0, y:0, w:this.w, h:this.h,
                bgColor:null, borderRadius:0, gradientTexturePath:uePath
              });
            } else {
              const bodyBgUrl = extractSingleCssUrl(textureBgImage);
              if (bodyBgUrl) {
                const texName = `T_BodyBg_${SESSION_ID}`;
                const uePath = `/Game/UI/Textures/${texName}`;
                // SVG data URLs are rasterized to PNG at the body's full
                // viewport size before the texture entry is recorded.
                const _bakedUrl = await maybeRasterizeSvgUrl(bodyBgUrl, this.w, this.h);
                this.textures.push({ url: _bakedUrl, name: texName + '.png', suggestedPath: uePath, isExternalUrl: /^https?:\/\//.test(bodyBgUrl), externalSrc: bodyBgUrl, cssFilter: textureBgCs.filter });
                this.elements.unshift({
                  ueType:'Image', name:this.uid('Image_BodyBg'), x:0, y:0, w:this.w, h:this.h,
                  bgColor:null, borderRadius:0, gradientTexturePath:uePath
                });
              }
            }

            this.reportProgress('Traversing DOM');
            await this.traverse(root, bodyRect, win);
            this.reportProgress(`Traverse complete (${this.elements.length} widgets, ${this.textures.length} textures)`);

            // Root scroll wrap: if page content is taller than the selected resolution
            if (bodyRect.height > this.h + 1) {
              const rootScrollId = this.uid('RootScrollBox');
              this.elements.forEach(el => { if (!el.scrollRegionId) el.scrollRegionId = rootScrollId; });
              this.scrollRegions.unshift({ id: rootScrollId, isRootScroll: true, x: 0, y: 0, w: this.w, h: this.h, contentH: bodyRect.height });
            }

            this.dedupeTexturesAndRemapElements();
            this.removeEmptyElementsAndUnusedTextures();
            // DOM-based panel-group assignment runs AFTER dedupe/cleanup so
            // every surviving widget is bucketed into the panel that
            // actually contains it in the DOM (closest `[data-ue-panel]`
            // ancestor of the widget's source element). Also strips the
            // private `__srcEl` field set by the traverse wrapper.
            this.assignPanelGroupsByDom();
            this.reportProgress(`Finalize complete (${(this.panelGroups || []).length} panels)`);
            resolve({
              elements: this.elements, textures: this.textures,
              scrollRegions: this.scrollRegions,
              panelGroups: this.panelGroups || [],
              usedFonts: this.getUsedFontSummary(),
              rootW: bodyRect.width, rootH: bodyRect.height,
              pageBgColor, resW: this.w, resH: this.h,
              pageName: this._derivePageName(doc, root)
            });
          } catch (e) { this.reportProgress(`Analyze error: ${e.message}`); reject(e); }
          }, 1500);
        }).catch(() => {
          this.reportProgress('Fonts failed, using fallback path');
          // Fonts failed to load, proceed anyway after delay
          setTimeout(async () => {
            try {
              const doc = iframe.contentDocument;
              const body = doc.body;
              const win = iframe.contentWindow;
              this.elements = [];
              this.textures = [];
              this.counters = {};
              this.scrollRegions = [];
              this.panelGroups = [];
              this._texCache = new Map();
              this.fontFamilies = new Set();
              this.fontSources = new Set();
              this.collectFontSources(doc);
              doc.querySelectorAll('details:not([open])').forEach(d => { d.open = true; });
              // Reset scroll-container registry (used by assignPanelGroupsByDom).
              this._scrollContainerRegistry = new Map();
              // Mirror primary-path JS-driven panel population: click each
              // `data-ue-toggle` button so toggle handlers can lazily build
              // panel bodies. See the long comment in the primary path.
              try {
                const _toggleBtns = doc.querySelectorAll('[data-ue-toggle], [onclick]');
                const _seenToggleTargetsFb = new Set();
                for (const btn of _toggleBtns) {
                  if (!this._shouldAutoClickTrigger(btn, doc)) continue;
                  const _key = (btn.getAttribute('data-ue-toggle') ||
                                btn.getAttribute('onclick') || '').trim();
                  if (!_key || _seenToggleTargetsFb.has(_key)) continue;
                  _seenToggleTargetsFb.add(_key);
                  try { btn.click(); } catch (_e) { /* swallow */ }
                }
              } catch (_e) { /* non-fatal */ }
              // Wait for any newly-injected `<img>` elements to load (see
              // primary-path comment for rationale).
              try {
                const _allImgs = Array.from(doc.querySelectorAll('img'));
                const _pending = _allImgs.filter(im => !im.complete || (im.naturalWidth === 0 && im.naturalHeight === 0));
                if (_pending.length) {
                  await Promise.all(_pending.map(im => new Promise(resolve => {
                    let done = false;
                    const finish = () => { if (done) return; done = true; im.removeEventListener('load', finish); im.removeEventListener('error', finish); resolve(); };
                    im.addEventListener('load', finish);
                    im.addEventListener('error', finish);
                    setTimeout(finish, 5000);
                  })));
                }
              } catch (_e) { /* non-fatal */ }
              // Mirror the primary-path force-show + panel registry build.
              const _panelRoots = doc.querySelectorAll('[data-ue-panel]');
              this._panelRegistry = new Map();
              const _seenPanelNamesFb = new Set();
              for (const panelEl of _panelRoots) {
                const rawName = (panelEl.getAttribute('data-ue-panel') || '').trim();
                if (!rawName) continue;
                let safeName = this._sanitizeUmgIdentifier(rawName) || 'Panel';
                let dedup = safeName;
                let n = 2;
                while (_seenPanelNamesFb.has(dedup)) dedup = `${safeName}_${n++}`;
                _seenPanelNamesFb.add(dedup);
                const defaultOpen = (panelEl.getAttribute('data-ue-panel-default') || '').trim().toLowerCase() === 'open';
                this._panelRegistry.set(panelEl, { name: dedup, defaultOpen });
              }
              // Mirror primary path: build CSS @keyframes index for the
              // document so `traverse()` can attach `animations[]` to
              // widgets that source from animated elements.
              this._buildKeyframesIndex(doc);
              // Same conservative two-pass force-show as the primary path
              // (see the long-form comment there for the rationale). Sample
              // a visible peer's display value, then for each hidden panel
              // try clearing inline `display` and only force a value as
              // last resort. `data-ue-panel-display` attribute wins if set.
              this._forceShowPanelRoots(_panelRoots, body);
              const root = this.findRoot(body);
              const bodyRect = body.getBoundingClientRect();
              const bodyCs = win.getComputedStyle(body);
              const bodyBgUrl = extractSingleCssUrl(bodyCs.backgroundImage || '');
              if (bodyBgUrl) {
                const texName = `T_BodyBg_${SESSION_ID}`;
                const uePath = `/Game/UI/Textures/${texName}`;
                const _bakedUrl = await maybeRasterizeSvgUrl(bodyBgUrl, this.w, this.h);
                this.textures.push({ url: _bakedUrl, name: texName + '.png', suggestedPath: uePath, isExternalUrl: /^https?:\/\//.test(bodyBgUrl), externalSrc: bodyBgUrl, cssFilter: bodyCs.filter });
                this.elements.unshift({ ueType:'Image', name:this.uid('Image_BodyBg'), x:0, y:0, w:this.w, h:this.h, bgColor:null, borderRadius:0, gradientTexturePath:uePath });
              }
              this.reportProgress('Traversing DOM (fallback)');
              await this.traverse(root, bodyRect, win);
              this.reportProgress(`Traverse complete (${this.elements.length} widgets, ${this.textures.length} textures)`);
              if (bodyRect.height > this.h + 1) {
                const rootScrollId = this.uid('RootScrollBox');
                this.elements.forEach(el => { if (!el.scrollRegionId) el.scrollRegionId = rootScrollId; });
                this.scrollRegions.unshift({ id: rootScrollId, isRootScroll: true, x: 0, y: 0, w: this.w, h: this.h, contentH: bodyRect.height });
              }
              const pageBgColor = parseColor(win.getComputedStyle(body).backgroundColor) || { r: 0, g: 0, b: 0, a: 1 };
              this.dedupeTexturesAndRemapElements();
              this.removeEmptyElementsAndUnusedTextures();
              this.assignPanelGroupsByDom();
              this.reportProgress(`Finalize complete (${(this.panelGroups || []).length} panels)`);
              resolve({
                elements: this.elements,
                textures: this.textures,
                scrollRegions: this.scrollRegions || [],
                panelGroups: this.panelGroups || [],
                usedFonts: this.getUsedFontSummary(),
                rootW: bodyRect.width,
                rootH: bodyRect.height,
                pageBgColor,
                resW: this.w,
                resH: this.h,
                pageName: this._derivePageName(doc, root)
              });
            } catch (e) { this.reportProgress(`Analyze error: ${e.message}`); reject(e); }
          }, 2500);
        });
      };

      iframe.onerror = () => {
        this.reportProgress('Iframe load failed');
        reject(new Error('iframe load failed'));
      };
      iframe.srcdoc = html;
    });
  }

  findRoot(body) {
    const kids = Array.from(body.children).filter(c => {
      const t = c.tagName.toLowerCase();
      return t !== 'script' && t !== 'style' && t !== 'link';
    });
    return kids.length === 1 ? kids[0] : body;
  }

  uid(prefix) {
    if (!this.counters[prefix]) this.counters[prefix] = 0;
    return `${prefix}_${this.counters[prefix]++}`;
  }

  // Sanitize an HTML class/id string into a UMG-safe identifier. UMG widget
  // names (and `suggestedWidgetName` hints we expose to the plugin) accept
  // [A-Za-z0-9_]; everything else is folded to `_`. Names cannot start with a
  // digit and we cap the length so excessively long Tailwind/utility class
  // strings don't blow up the export.
  _sanitizeUmgIdentifier(s) {
    let out = String(s || '').trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    if (!out) return '';
    if (/^[0-9]/.test(out)) out = '_' + out;
    if (out.length > 32) out = out.slice(0, 32).replace(/_+$/, '');
    return out;
  }

  // Pull a descriptive base name from an element's id/class/tag, preferring
  // semantic identifiers over generic utility classes. Used to populate
  // `suggestedWidgetName` on each pushed widget so the UE plugin can rename
  // the actual UMG widget to something meaningful (e.g. `Image_Bg_card` /
  // `Button_cta` / `TextBlock_hero_title`) instead of `Image_Bg_3` /
  // `Button_0` / `TextBlock_12`.
  _deriveBaseNameFromEl(el) {
    if (!el || el.nodeType !== 1) return '';
    // 1) Explicit id wins — most specific identifier the author gave us.
    const id = (el.getAttribute && el.getAttribute('id')) || '';
    if (id) {
      const s = this._sanitizeUmgIdentifier(id);
      if (s && s.length >= 2) return s;
    }
    // 2) First "meaningful" class. Skip very short tokens (`fa`, `p1`, `m2`)
    //    and obvious utility patterns from Tailwind/Bootstrap that don't
    //    describe the element's role (display/flex/spacing/colour helpers).
    const utilityRegex = /^(active|hover|focus|disabled|hidden|visible|show|d-\w+|p[xy]?-\d+|m[xy]?-\d+|w-\d+|h-\d+|text-\w+|bg-\w+|flex(-\w+)?|grid(-\w+)?|items-\w+|justify-\w+|gap-\d+|rounded(-\w+)?|shadow(-\w+)?|border(-\w+)?|opacity-\d+|top-\d+|left-\d+|right-\d+|bottom-\d+|inset-\d+|z-\d+|font-\w+|leading-\w+|tracking-\w+|col-\w+|row-\w+|btn|container|wrapper|inner|outer|content)$/i;
    const cls = el.classList ? Array.from(el.classList) : [];
    for (const c of cls) {
      if (!c || c.length < 3) continue;
      if (utilityRegex.test(c)) continue;
      const s = this._sanitizeUmgIdentifier(c);
      if (s) return s;
    }
    // 3) Semantic HTML5 tag as last-resort hint.
    const tag = (el.tagName || '').toLowerCase();
    if (['header', 'nav', 'main', 'article', 'section', 'aside', 'footer', 'form'].includes(tag)) {
      return tag;
    }
    return '';
  }

  // Returns the widget hint to attach to `_meta.suggestedWidgetName` for an
  // element. Multiple widgets pushed by the same element naturally share the
  // hint — UE plugin disambiguates them by widget type and traversal order.
  _suggestedNameFromEl(el) {
    return this._deriveBaseNameFromEl(el) || '';
  }

  // Compute a single page-level identifier used for export filenames (zip /
  // JSON). Order: <title>, body[id], body's first non-utility class, root
  // element id/class, else empty (caller falls back to the legacy default).
  _derivePageName(doc, root) {
    const titleStr = ((doc && doc.title) || '').trim();
    if (titleStr) {
      const s = this._sanitizeUmgIdentifier(titleStr);
      if (s) return s;
    }
    const body = doc && doc.body;
    if (body) {
      const fromBody = this._deriveBaseNameFromEl(body);
      if (fromBody) return fromBody;
    }
    if (root) {
      const fromRoot = this._deriveBaseNameFromEl(root);
      if (fromRoot) return fromRoot;
    }
    return '';
  }

  dedupeTexturesAndRemapElements() {
    const seen = new Map();
    const pathRemap = new Map();
    const unique = [];
    for (const tex of this.textures) {
      const key = [
        tex.url || tex.externalSrc || tex.suggestedPath || tex.name,
        normalizeTextureCssFilter(tex.cssFilter)
      ].join('|filter:');
      if (key && seen.has(key)) {
        const first = seen.get(key);
        if (tex.suggestedPath && first.suggestedPath) pathRemap.set(tex.suggestedPath, first.suggestedPath);
        continue;
      }
      if (key) seen.set(key, tex);
      unique.push(tex);
    }
    if (!pathRemap.size) {
      this.textures = unique;
      return;
    }
    const remapElement = (el) => {
      ['texturePath', 'gradientTexturePath', 'borderFrameTexturePath'].forEach(prop => {
        if (el[prop] && pathRemap.has(el[prop])) el[prop] = pathRemap.get(el[prop]);
      });
      if (Array.isArray(el.bodyElements)) el.bodyElements.forEach(remapElement);
      if (Array.isArray(el.children)) el.children.forEach(remapElement);
    };
    this.elements.forEach(remapElement);
    this.textures = unique;
  }

  removeEmptyElementsAndUnusedTextures() {
    const hasVisibleColor = (c) => c && (c.a === undefined || c.a > 0.001);
    const isEmpty = (el) => {
      if (!el) return true;
      if (el.ueType === 'TextBlock') return !String(el.text || '').trim();
      if (el.ueType === 'Image') {
        return !el.texturePath && !el.gradientTexturePath && !el.borderFrameTexturePath &&
          !hasVisibleColor(el.bgColor) && !(el.borderColor && el.borderWidth > 0) &&
          !el._isBorderFrame && !el.gridTintColor;
      }
      if (el.ueType === 'Button') {
        // Rich-content / click-shell buttons (`_isClickShell`) are
        // intentionally text-less and visually transparent — their visible
        // children (icon span, label, count badge) are emitted as
        // siblings by traverse() recursion. Filtering them as "empty"
        // would silently delete the click target while leaving its
        // children orphaned at root, which is the inactive-nav-tab
        // disappearance bug. Always preserve them.
        if (el._isClickShell) return false;
        const hasVisual = el.gradientTexturePath || hasVisibleColor(el.bgColor) ||
          (el.borderColor && el.borderWidth > 0) || el.borderRadius > 0;
        return !String(el.text || '').trim() && !hasVisual;
      }
      if (el.ueType === 'ExpandableArea') {
        el.bodyElements = (el.bodyElements || []).filter(child => !isEmpty(child));
        return !String(el.summaryText || '').trim() && !el.bodyElements.length;
      }
      return false;
    };

    this.elements = this.elements.filter(el => !isEmpty(el));
    const usedPaths = new Set();
    const collect = (el) => {
      ['texturePath', 'gradientTexturePath', 'borderFrameTexturePath'].forEach(prop => {
        if (el[prop]) usedPaths.add(el[prop]);
      });
      if (Array.isArray(el.bodyElements)) el.bodyElements.forEach(collect);
      if (Array.isArray(el.children)) el.children.forEach(collect);
    };
    this.elements.forEach(collect);
    this.textures = this.textures.filter(tex => !tex.suggestedPath || usedPaths.has(tex.suggestedPath) || tex.isBorderFrame);
  }

  // Render a glyph from a font (FontAwesome / Material Icons / emoji etc.) into
  // a high-resolution PNG while keeping the widget slot at the browser-measured rect.
  // Cached by (char + family + size + color + measured box).
  // Used both by standalone icon elements in traverse() and
  // by icons inside buttons in addButton().
  renderFontIconTexture(el, cs, iconChar, iconColor, cssFontSize, fallbackW, fallbackH, win) {
    const boxW = Math.max(1, Math.ceil(fallbackW || cssFontSize || 16));
    const boxH = Math.max(1, Math.ceil(fallbackH || cssFontSize || 16));
    const fontPx = Math.max(1, cssFontSize || Math.min(boxW, boxH));
    const _key = [
      'glyph',
      iconChar,
      cs.fontFamily,
      cs.fontWeight,
      cs.fontStyle,
      Math.round(fontPx * 100) / 100,
      boxW + 'x' + boxH,
      iconColor.r + ',' + iconColor.g + ',' + iconColor.b + ',' + iconColor.a
    ].join('|');
    const cached = this._texCache ? this._texCache.get(_key) : null;
    if (cached) return cached;
    const baseName = iconNameFromClass(el) || ('T_Icon_' + this.uid('icon'));
    const texName = `${baseName}_${SESSION_ID}`;
    const SCALE = Math.max(4, Math.min(8, Math.ceil(96 / Math.max(12, fontPx))));
    const cw = Math.max(1, Math.ceil(boxW * SCALE));
    const ch = Math.max(1, Math.ceil(boxH * SCALE));
    const canvas = win.document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ictx = canvas.getContext('2d');
    ictx.clearRect(0, 0, cw, ch);
    ictx.fillStyle = `rgba(${iconColor.r},${iconColor.g},${iconColor.b},${iconColor.a})`;
    // Fit-to-canvas glyph sizing — prevents clipping of tall SMP pictographs
    // (🗡 🖥 🏆 …) and wide dingbats whose actual ink bbox exceeds the CSS
    // font-size em box. We measure the glyph at `fontPx * SCALE` and, if any
    // side (ascent / descent / left / right) would overflow the canvas,
    // shrink the font proportionally so the full glyph fits inside the
    // widget's original pixel rect. A 2% safety margin guards against
    // sub-pixel measurement rounding in cross-browser `measureText` output.
    let drawFontPx = fontPx * SCALE;
    ictx.font = `${cs.fontStyle || 'normal'} ${cs.fontWeight || '900'} ${drawFontPx}px ${cs.fontFamily}`;
    try {
      const m = ictx.measureText(iconChar);
      const asc = Number.isFinite(m.actualBoundingBoxAscent)  ? m.actualBoundingBoxAscent  : drawFontPx * 0.8;
      const dsc = Number.isFinite(m.actualBoundingBoxDescent) ? m.actualBoundingBoxDescent : drawFontPx * 0.2;
      const lft = Number.isFinite(m.actualBoundingBoxLeft)    ? m.actualBoundingBoxLeft    : (m.width || drawFontPx) * 0.5;
      const rgt = Number.isFinite(m.actualBoundingBoxRight)   ? m.actualBoundingBoxRight   : (m.width || drawFontPx) * 0.5;
      const inkW = Math.max(1, lft + rgt);
      const inkH = Math.max(1, asc + dsc);
      const SAFETY = 0.98;
      const fitScale = Math.min((cw * SAFETY) / inkW, (ch * SAFETY) / inkH, 1);
      if (fitScale < 1) {
        drawFontPx *= fitScale;
        ictx.font = `${cs.fontStyle || 'normal'} ${cs.fontWeight || '900'} ${drawFontPx}px ${cs.fontFamily}`;
      }
    } catch { /* measureText unsupported on this glyph — fall through to default sizing */ }
    ictx.textAlign = 'center'; ictx.textBaseline = 'middle';
    ictx.fillText(iconChar, cw / 2, ch / 2);
    const path = `/Game/UI/Textures/Icons/${texName}`;
    this.textures.push({ url: canvas.toDataURL('image/png'), name: texName + '.png', suggestedPath: path, isIcon: true });
    if (this._texCache) this._texCache.set(_key, path);
    return path;
  }

  // When renderFontIcons is ON, inline emojis inside otherwise-regular text
  // (e.g. "Welcome 🎉 to the page!") are extracted: each emoji cluster is baked
  // to its own PNG texture and emitted as an Image widget positioned at its
  // exact Range-measured pixel rect. The caller is expected to strip the
  // matched emoji clusters from the TextBlock's text so UE doesn't re-render
  // them as empty boxes (most UE runtime fonts lack color-emoji coverage).
  //
  // Scope rules (mirrors the parent TextBlock's inline-merge behaviour):
  //   - Own text nodes of `el` are scanned.
  //   - Inline-display children are recursed into.
  //   - Block-level children are skipped — traverse() visits them separately
  //     and their emojis will be handled in that call.
  //   - Renderable icon-font elements (whole-element icons) are skipped —
  //     they're emitted by the dedicated isFontIcon path.
  //   - <script>/<style>/<br>/<hr> subtrees are skipped.
  //
  // Returns { images, extractedRanges } where:
  //   images          — Image widget descriptors to push (one per glyph)
  //   extractedRanges — list of { node, start, end } DOM offsets that were
  //                     baked, so the caller's TextBlock-bounds walk can
  //                     SKIP them when computing minX/minY. Without this
  //                     skip the TextBlock's left edge is anchored to the
  //                     extracted glyph's left edge and the remaining text
  //                     gets drawn ON TOP of the baked Image — which is
  //                     exactly the "icon ile text aynı pozisyonda iç içe
  //                     giriyor" overlap the user reported.
  extractAndBakeInlineEmojis(el, cs, win, rootRect, scrollContext) {
    const images = [];
    const extractedRanges = [];
    // NOTE: this path is intentionally NOT gated on `this.renderFontIcons`.
    // It only matches plain emoji / pictograph clusters via
    // `INLINE_BAKEABLE_RE` (filled emoji + Misc Symbols + Dingbats + Misc
    // Symbols and Arrows), and Unreal's runtime fonts cover none of those
    // codepoints — leaving the glyphs in the TextBlock would render as
    // tofu boxes. Icon-font glyphs (FontAwesome PUA, Material Icons) are
    // handled separately by `isRenderableFontIconElement` and DO respect
    // the toggle, since those need a real Font Asset in the project.
    const refLeft = scrollContext ? scrollContext.rect.left : rootRect.left;
    const refTop = scrollContext ? scrollContext.rect.top : rootRect.top;
    const textColor = parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
    const cssFontSize = parseFloat(cs.fontSize) || 14;
    const range = win.document.createRange();

    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || '';
        if (!text || !textContainsInlineBakeableGlyph(text)) return;
        const re = new RegExp(INLINE_BAKEABLE_RE.source, INLINE_BAKEABLE_RE.flags);
        let m;
        while ((m = re.exec(text)) !== null) {
          const startOffset = m.index;
          const endOffset = m.index + m[0].length;
          let rect = null;
          try {
            range.setStart(node, startOffset);
            range.setEnd(node, endOffset);
            const rects = range.getClientRects();
            rect = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
          } catch { /* detached node */ }
          if (!rect || rect.width < 1 || rect.height < 1) continue;
          const ex = rect.left - refLeft;
          const ey = rect.top - refTop;
          const ew = rect.width;
          const eh = rect.height;
          const texPath = this.renderFontIconTexture(el, cs, m[0], textColor, cssFontSize, ew, eh, win);
          images.push({
            ueType: 'Image', name: this.uid('Image_Icon'),
            x: ex, y: ey, w: ew, h: eh,
            bgColor: null, borderRadius: 0, gradientTexturePath: texPath
          });
          extractedRanges.push({ node, start: startOffset, end: endOffset });
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'br' || tag === 'hr') return;
        let ncs;
        try { ncs = win.getComputedStyle(node); } catch { return; }
        if (!ncs) return;
        // A child that IS itself an icon element will be emitted by its own traverse path
        if (isRenderableFontIconElement(node, ncs, win)) return;
        // Only recurse into inline-display children — block children are handled by traverse()
        const disp = ncs.display;
        const isInline = disp === 'inline' || disp === 'inline-block' ||
          disp === 'inline-flex' || disp === 'contents';
        if (!isInline) return;
        Array.from(node.childNodes).forEach(walk);
      }
    };
    Array.from(el.childNodes).forEach(walk);
    return { images, extractedRanges };
  }

  // Lazily creates a single white 10x10 PNG used as the 9-slice brush source
  // for frame-style borders (DrawAs=Border). Tint color is applied per widget.
  ensureBorderFrameTexture(win) {
    if (this._borderFrameTexPath) return this._borderFrameTexPath;
    const path = '/Game/UI/Textures/T_Border_White_10x10';
    const c = win.document.createElement('canvas');
    c.width = 10; c.height = 10;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 10, 10);
    this.textures.push({
      url: c.toDataURL('image/png'),
      name: 'T_Border_White_10x10.png',
      suggestedPath: path,
      isBorderFrame: true
    });
    this._borderFrameTexPath = path;
    return path;
  }

  // Get the correct border-radius in pixels (handles shorthand and per-corner values)
  getCornerRadius(cs) {
    // Use the first value from computed borderRadius which gives the shorthand px value
    // The browser sometimes returns e.g. "8px" or "8px / 8px" or just "8px 8px 8px 8px"
    const raw = cs.borderRadius || '';
    // Handle slash notation (horizontal / vertical) - take horizontal
    const part = raw.split('/')[0].trim();
    // Take the first space-separated value
    const first = part.split(/\s+/)[0];
    const px = parseFloat(first) || 0;
    return px;
  }

  getVisuallyWrappedText(el, win, cs) {
    // If parent is a flex container, DON'T merge children.
    // Each flex child should be its own TextBlock (e.g. space-between spans with different colors).
    const dispType = cs.display;
    if (dispType === 'flex' || dispType === 'inline-flex' || dispType === 'grid' || dispType === 'inline-grid') {
      // Only extract direct text nodes, let recursion handle children
      let t = '';
      for (const n of el.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
      }
      return t.trim();
    }

    const inlineTags2 = ['b', 'i', 'strong', 'em', 'span', 'mark', 'sub', 'sup', 'u', 's', 'del', 'ins', 'small', 'big', 'q'];
    let hasBlockChildren = false;
    for (const child of el.children) {
      const childTag = child.tagName.toLowerCase();
      if (childTag === 'br') continue; // BR is inline formatting, not a block child
      if (!inlineTags2.includes(childTag)) { hasBlockChildren = true; break; }
      // Also check computed display: Tailwind "block" / "flex" on <span> creates visual line breaks
      const childDisp = win.getComputedStyle(child).display;
      if (childDisp !== 'inline' && childDisp !== 'inline-block' &&
          childDisp !== 'inline-flex' && childDisp !== 'contents') {
        hasBlockChildren = true; break;
      }
    }

    if (hasBlockChildren) {
      // Block-level children will be traversed separately by traverse().
      // Only return direct text nodes from this element, not recursive child text.
      let t = '';
      for (const n of el.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
        else if (n.nodeType === Node.ELEMENT_NODE && n.tagName === 'BR') t += '\n';
      }
      return t.trim();
    }

    // No block children: Use Range API to find exact visual line breaks
    const range = win.document.createRange();
    let lines = [];
    let currentLine = '';
    let lastCenterY = -1;
    const fontSize = parseFloat(cs.fontSize) || 14;

    const textNodes = [];
    const walk = (n) => {
      if (n.nodeType === Node.ELEMENT_NODE) {
        const ccs = win.getComputedStyle(n);
        if (ccs.display === 'none' || ccs.opacity === '0') return;
        if (this.renderFontIcons && isRenderableFontIconElement(n, ccs, win)) return;
      }
      if (n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0) textNodes.push(n);
      else if (n.nodeType === Node.ELEMENT_NODE) {
        if (n.tagName === 'BR') textNodes.push(n);
        else Array.from(n.childNodes).forEach(walk);
      }
    };
    
    Array.from(el.childNodes).forEach(walk);

    for (const node of textNodes) {
      if (node.tagName === 'BR') {
          lines.push(currentLine.trimEnd());
          currentLine = '';
          lastCenterY = -1;
          continue;
      }
      const text = node.textContent;
      const isPre = win.getComputedStyle(node.parentElement).whiteSpace.startsWith('pre');
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '\n' || char === '\r') {
           if (isPre) {
               lines.push(currentLine.trimEnd());
               currentLine = '';
               lastCenterY = -1;
           } else {
               if (currentLine.length > 0 && !currentLine.endsWith(' ')) currentLine += ' ';
           }
           continue;
        }
        
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rects = range.getClientRects();
        let centerY = lastCenterY;
        if (rects.length > 0) {
          centerY = rects[0].top + rects[0].height / 2;
          if (lastCenterY === -1) {
            lastCenterY = centerY;
          } else if (Math.abs(centerY - lastCenterY) > fontSize * 0.6) { // visual wrap threshold
            lines.push(currentLine.trimEnd());
            currentLine = '';
            lastCenterY = centerY;
          }
        }
        
        if (currentLine.length === 0 && char.trim() === '') continue; // skip leading space
        currentLine += char;
      }
    }
    if (currentLine.trim().length > 0) lines.push(currentLine.trimEnd());
    
    return lines.join('\n');
  }

  // Get full visible text of element (for pre/code/p), including sub/sup merged inline
  fullText(el) {
    // Use innerText to get rendered, newline-aware text
    return (el.innerText || el.textContent || '').trim();
  }

  // Check if element is a clickable link/anchor/button that should become a UE Button
  // True if the element should be emitted as a UMG.Button click receiver.
  //
  // Tightened criteria: `cursor:pointer` ALONE is no longer enough — many
  // sites use it on hover-able cards, list rows, disclosure summaries, even
  // entire viewport sections (`html { cursor: pointer }` global resets).
  // We require a second, explicit interactive signal:
  //   • role="button" / "link" / "menuitem" / "tab" / "option" / "switch" /
  //     "checkbox" (handled separately) / "radio"
  //   • onclick / onmousedown / onmouseup attribute on the element
  //   • tabindex="0" (the canonical way to mark a non-form element focusable)
  //   • data-action / data-click / data-href hooks commonly bound by frameworks
  //   • A class token whose name itself reads like "button"
  //     (btn / button / cta / clickable / action-btn)
  // Native interactive tags <button>, <input type=button|submit>, <summary>
  // remain unconditional buttons. Anchors are buttons only when they carry an
  // actual `href` (decorative <a> placeholders without href are not buttons),
  // OR when one of the explicit signals above is present.
  isLinkButton(el, cs, tag) {
    if (tag === 'button' || tag === 'summary') return true;
    if (tag === 'input' && (el.type === 'submit' || el.type === 'button')) return true;
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href !== null && href !== '') return true;
      return this._hasExplicitClickSignal(el);
    }
    if (cs.cursor === 'pointer') {
      return this._hasExplicitClickSignal(el);
    }
    // No `cursor:pointer`, but the element nonetheless advertises itself as
    // interactive (role/onclick/tabindex). Honor that.
    return this._hasExplicitClickSignal(el);
  }

  // Post-processes `this.elements` after traversal completes and assigns
  // each widget a `panelGroup` (the panel name) by walking the source DOM
  // element's ancestor chain looking for an entry in `_panelRegistry`.
  // This is DOM-based, not bbox-based: the panel a widget belongs to is
  // its closest `[data-ue-panel]` ancestor, exactly mirroring how
  // `display:none` would hide it in the browser. Bbox-based assignment
  // (the previous implementation) had several pathologies that surfaced on
  // real UIs:
  //   • Root-level full-screen background `<div>`s have a center that
  //     falls inside any panel's rect, so they were vacuumed into the
  //     smallest panel and disappeared when the panel was Collapsed.
  //   • Widgets that visually overlap a panel without being inside it (a
  //     toolbar button rendered just above the panel, a tooltip, etc.)
  //     were miscategorized as panel children.
  //   • The "smallest panel wins" tiebreak hoisted random elements into
  //     small inner sub-panels they had no DOM relationship with.
  //
  // After assignment we strip `__srcEl` from every widget so the field —
  // which holds a live DOM node ref into the throwaway iframe document —
  // does not leak into the JSON exporter or the parity validator.
  assignPanelGroupsByDom() {
    if (!this.elements || !this.elements.length) return;
    const panelReg = this._panelRegistry;
    const scrollReg = this._scrollContainerRegistry;
    const hasPanels = panelReg && panelReg.size > 0;
    const hasScrolls = scrollReg && scrollReg.size > 0;
    for (const w of this.elements) {
      if (hasPanels && !w.panelGroup) {
        // Walk up DOM ancestors looking for the INNERMOST container of
        // either kind:
        //   - If the first match is a scroll container, the widget already
        //     has `scrollRegionId` set and belongs to that scroll's group.
        //     Tagging panelGroup too would route the widget into the panel
        //     directly with scroll-relative coordinates being misread as
        //     panel-relative (skill-tree position-shift bug). The scroll
        //     region itself carries a `panelGroup` reference (stamped in
        //     `traverse()` from `activePanelContext.id`) which makes the
        //     scrollbox land inside the panel — children stay grouped
        //     under the scrollbox where their scroll-relative coords
        //     resolve correctly.
        //   - If the first match is a panel root, set panelGroup. This is
        //     the regular case for elements directly inside a panel that
        //     are NOT inside any inner scroll.
        let node = w.__srcEl || null;
        while (node && node.nodeType === Node.ELEMENT_NODE) {
          if (hasScrolls && scrollReg.has(node)) {
            // Innermost ancestor is a scroll. Don't tag panelGroup.
            break;
          }
          const info = panelReg.get(node);
          if (info) { w.panelGroup = info.name; break; }
          node = node.parentElement;
        }
      }
      // Whether or not a panel was found, drop the DOM ref so it doesn't
      // get serialized / pinned in memory after analyze() returns.
      if (w.__srcEl) delete w.__srcEl;
    }
  }

  // Resolves a `data-ue-toggle="<name>"` attribute value into the sanitized
  // panel name the exporter expects. We look up the value in the panel
  // registry first (so the toggle string can be the user's PascalCase
  // panel name and we resolve it to whatever sanitized + dedup'd identifier
  // the exporter will use). If the value doesn't match any known panel we
  // fall back to running the same sanitizer over it directly — the
  // exporter's hint comment will still be useful and a "panel not found"
  // warning is logged separately so the developer can fix the typo.
  _resolveToggleTargetName(rawValue) {
    if (!rawValue) return null;
    const trimmed = String(rawValue).trim();
    if (!trimmed) return null;
    if (this._panelRegistry) {
      for (const [el, info] of this._panelRegistry.entries()) {
        const raw = (el.getAttribute('data-ue-panel') || '').trim();
        if (raw === trimmed) return info.name;
      }
    }
    return this._sanitizeUmgIdentifier(trimmed) || null;
  }

  // Walks the parent chain looking for a rounded-clipping ancestor that the
  // current element visually fills. Returns the smallest border-radius (in
  // CSS pixels) that should be inherited, or 0 when no ancestor applies.
  //
  // An ancestor "rounds-clips" when ALL of the following hold:
  //   • Its computed `overflow` (or both axes) is `hidden` or `clip`.
  //   • At least one corner has a non-zero border-radius.
  // The current element "fills" the ancestor when its bbox covers the full
  // parent content box within a 1.5px tolerance — smaller / centered
  // children sit in the rounded "safe zone" and need no inheritance.
  //
  // We pick the SMALLEST radius among the rounded corners we find on the
  // ancestor; using max would over-round when only one or two corners are
  // actually rounded. We also bail at <body>/<html> so we never read body's
  // border-radius (which is rarely intended to clip children).
  _inheritParentClipRadius(el, win) {
    const childRect = el.getBoundingClientRect();
    if (!childRect || childRect.width < 1 || childRect.height < 1) return 0;
    const TOL = 1.5;
    let cur = el.parentElement;
    let bestR = 0;
    while (cur) {
      const tag = cur.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') break;
      let cs;
      try { cs = win.getComputedStyle(cur); } catch { break; }
      if (!cs) break;
      const overflow = cs.overflow;
      const overflowX = cs.overflowX;
      const overflowY = cs.overflowY;
      const isClipping =
        overflow === 'hidden' || overflow === 'clip' ||
        ((overflowX === 'hidden' || overflowX === 'clip') &&
         (overflowY === 'hidden' || overflowY === 'clip'));
      if (isClipping) {
        const corners = [
          parseFloat(cs.borderTopLeftRadius) || 0,
          parseFloat(cs.borderTopRightRadius) || 0,
          parseFloat(cs.borderBottomLeftRadius) || 0,
          parseFloat(cs.borderBottomRightRadius) || 0
        ];
        const minRoundedR = corners.filter(v => v > 0).length > 0
          ? Math.min(...corners.filter(v => v > 0))
          : 0;
        if (minRoundedR > 0) {
          const parentRect = cur.getBoundingClientRect();
          const fills =
            childRect.left   <= parentRect.left   + TOL &&
            childRect.top    <= parentRect.top    + TOL &&
            childRect.right  >= parentRect.right  - TOL &&
            childRect.bottom >= parentRect.bottom - TOL;
          if (fills && minRoundedR > bestR) bestR = minRoundedR;
        }
      }
      cur = cur.parentElement;
    }
    return bestR;
  }

  // Compact string fingerprint of an element's user-visible typography. Used
  // to decide whether two inline siblings inside the same container carry
  // visually distinct styling — when at least two siblings differ, the
  // container should NOT be collapsed into a single parent TextBlock with
  // the parent's baseline color/size, because that would silently drop the
  // per-span styling. Each span gets emitted as its own TextBlock instead.
  // We deliberately ignore properties that don't affect visual identity at
  // the per-span level (line-height, letter-spacing, text-align inherited
  // from parent, …).
  _typographySignature(cs) {
    return [
      cs.color,
      cs.fontSize,
      cs.fontWeight,
      cs.fontStyle,
      cs.fontFamily,
      cs.textDecorationLine || cs.textDecoration || '',
      cs.textTransform || ''
    ].join('|');
  }

  _hasExplicitClickSignal(el) {
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'button' || role === 'link' || role === 'menuitem' ||
        role === 'tab' || role === 'option' || role === 'switch' ||
        role === 'radio') {
      return true;
    }
    if (el.hasAttribute('onclick') || el.hasAttribute('onmousedown') || el.hasAttribute('onmouseup')) {
      return true;
    }
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && tabindex.trim() !== '' && tabindex.trim() !== '-1') {
      return true;
    }
    if (el.hasAttribute('data-action') || el.hasAttribute('data-click') ||
        el.hasAttribute('data-href') || el.hasAttribute('data-target')) {
      return true;
    }
    const cls = (el.className || '').toString().toLowerCase();
    if (/(?:^|[\s_-])(btn|button|cta|clickable)(?:[\s_-]|$)/.test(cls)) {
      return true;
    }
    return false;
  }

  // Public traverse entry — thin wrapper around `_traverseImpl` whose only
  // job is to record the source DOM element on every widget pushed during
  // this call's subtree. The recorded `__srcEl` is consumed by
  // `assignPanelGroupsByDom()` in the analyze finalizer to bucket widgets
  // into panel groups via DOM ancestry (NOT bounding-box containment —
  // bbox-based assignment incorrectly sucks in root background widgets
  // whose center happens to fall inside a panel rect, hoists root-level
  // elements into panels, and miscategorizes elements that visually
  // overlap a panel without being its DOM descendants).
  //
  // The stamp uses `if (!__srcEl)` so a child traverse call's stamps win
  // over the parent's: deeper recursion always tags more specifically. We
  // delete `__srcEl` again at the end of `analyze()` so the field never
  // leaks into the exporter / JSON output (DOM refs aren't serializable
  // and would prevent garbage collection of the iframe document).
  async traverse(el, rootRect, win, scrollContext, zContext, panelContext) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
    const _startIdx = this.elements.length;
    try {
      return await this._traverseImpl(el, rootRect, win, scrollContext, zContext, panelContext);
    } finally {
      const end = this.elements.length;
      // CSS animation extraction: compute once for THIS element, attach
      // to every widget pushed during this element's traversal that
      // wasn't already claimed by a deeper child. The same `!w.__srcEl`
      // gate used for `__srcEl` is reused so animations follow the same
      // "deepest emitter wins" semantics — a widget pushed by a nested
      // child carries the CHILD'S animations (matching CSS, where
      // `animation` does not cascade from parent to descendants).
      //
      // Computed only when there's at least one keyframes rule in the
      // document AND at least one unclaimed widget exists in our range,
      // so the animation read is skipped entirely on un-animated pages.
      let _anims = null;
      let _checkedAnims = false;
      let _assignedAnimCount = 0;
      for (let i = _startIdx; i < end; i++) {
        const w = this.elements[i];
        if (!w || w.__srcEl) continue;
        if (!_checkedAnims) {
          _checkedAnims = true;
          if (this._keyframesIndex && this._keyframesIndex.size > 0) {
            _anims = this._extractElementAnimations(el, win);
          }
        }
        w.__srcEl = el;
        if (_anims) {
          w.animations = _anims;
          _assignedAnimCount++;
        }
      }
      // Pure layout containers can carry a transform/opacity animation while
      // producing no direct widget of their own (canonical case: an animated
      // wrapper whose only child is one baked SVG/Image). In that case the
      // loop above assigns the descendant widget to its concrete child node
      // first, so the container would otherwise lose the animation entirely.
      // Safe fallback: when the container resolved exactly ONE descendant
      // widget, mirror the container animation onto that lone visual child.
      if (_anims && _assignedAnimCount === 0) {
        const _descWidgets = [];
        for (let i = _startIdx; i < end; i++) {
          const w = this.elements[i];
          if (!w || !w.__srcEl || w.__srcEl === el) continue;
          _descWidgets.push(w);
        }
        if (_descWidgets.length === 1) {
          _descWidgets[0].animations = _anims;
        }
      }
    }
  }

  _panelLooksPrebuilt(panelEl) {
    if (!panelEl) return false;
    if ((panelEl.textContent || '').trim().length > 0) return true;
    return !!panelEl.querySelector('*');
  }

  _shouldAutoClickTrigger(el, doc) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const toggleTarget = (el.getAttribute('data-ue-toggle') || '').trim();
    if (toggleTarget) {
      const targetPanel = Array.from(doc.querySelectorAll('[data-ue-panel]'))
        .find(panel => ((panel.getAttribute('data-ue-panel') || '').trim() === toggleTarget)) || null;
      // If the target panel already exists in source HTML and visibly contains
      // authored structure/text, do NOT click the trigger — UI scripts like
      // ForzaUI's `selectCat()` / `selectTab()` would otherwise reshuffle the
      // active panel/screen state and hide unrelated content before analysis.
      // We only auto-click when the target panel looks empty, which is the
      // canonical lazy-build case this pass was originally added for.
      if (targetPanel && this._panelLooksPrebuilt(targetPanel)) return false;
      return true;
    }

    const onclick = (el.getAttribute('onclick') || '').trim();
    if (!onclick) return false;
    // Conservative fallback for non-marker pages: only fire inline handlers
    // that LOOK like panel/lazy-build/populate actions. Avoid broad UI-state
    // handlers such as `selectCat()`, `selectTab()`, `showScreen()`, etc.
    if (/\b(build|populate|render|togglePanel|openPanel|showPanel)\b/i.test(onclick)) {
      return true;
    }
    return false;
  }

  _shouldUseRichContentButton(el, cs, win, hasBlockChildren, parentBlockifiesInlineChildren) {
    if (hasBlockChildren) return true;
    if (!parentBlockifiesInlineChildren || !el || !el.children || el.children.length === 0) return false;

    let hasDirectLooseText = false;
    for (const node of el.childNodes || []) {
      if (node.nodeType === Node.TEXT_NODE && (node.textContent || '').trim().length > 0) {
        hasDirectLooseText = true;
        break;
      }
    }

    const inlineTags = new Set(['b', 'i', 'strong', 'em', 'span', 'mark', 'sub', 'sup', 'u', 's', 'del', 'ins', 'small', 'big', 'q']);
    const parentSig = this._typographySignature(cs);
    const inlineChildSigs = new Set();
    let hasRenderableIconChild = false;

    for (const child of el.children) {
      const childTag = child.tagName.toLowerCase();
      if (childTag === 'br' || childTag === 'hr') continue;
      const childCss = win.getComputedStyle(child);
      if (isRenderableFontIconElement(child, childCss, win)) {
        hasRenderableIconChild = true;
      }
      if (!inlineTags.has(childTag)) return true;
      const childDisp = childCss.display;
      if (!parentBlockifiesInlineChildren &&
          childDisp !== 'inline' && childDisp !== 'inline-block' &&
          childDisp !== 'inline-flex' && childDisp !== 'contents') {
        return true;
      }
      const childTxt = (child.textContent || '').trim();
      if (childTxt && childCss.display !== 'none' && childCss.visibility !== 'hidden') {
        inlineChildSigs.add(this._typographySignature(childCss));
      }
    }

    if (!hasDirectLooseText) return true;
    if (hasRenderableIconChild) return true;
    if (inlineChildSigs.size >= 2) return true;
    if (inlineChildSigs.size === 1) {
      const onlySig = inlineChildSigs.values().next().value;
      if (onlySig !== parentSig) return true;
    }
    return false;
  }

  _buildPanelStackAnchors(panelRoots, win) {
    const groups = new Map();
    for (const panelEl of panelRoots) {
      const parent = panelEl && panelEl.parentElement;
      if (!parent) continue;
      let arr = groups.get(parent);
      if (!arr) {
        arr = [];
        groups.set(parent, arr);
      }
      arr.push(panelEl);
    }

    const anchors = new Map();
    for (const [parent, siblings] of groups.entries()) {
      if (!siblings || siblings.length < 2) continue;
      let visibleSibling = null;
      for (const sibling of siblings) {
        const cs = win.getComputedStyle(sibling);
        if (cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.01) {
          visibleSibling = sibling;
          break;
        }
      }
      if (!visibleSibling) continue;
      const parentRect = parent.getBoundingClientRect();
      const visibleRect = visibleSibling.getBoundingClientRect();
      anchors.set(parent, {
        left: visibleRect.left - parentRect.left,
        top: visibleRect.top - parentRect.top,
        width: visibleRect.width,
        display: win.getComputedStyle(visibleSibling).display || 'block'
      });
    }
    return anchors;
  }

  _forceShowPanelRoots(panelRoots, body) {
    const win = body.ownerDocument.defaultView;
    const roots = Array.from(panelRoots || []);
    const stackAnchors = this._buildPanelStackAnchors(roots, win);
    let sampledDisplay = '';
    for (const panelEl of roots) {
      const cs = win.getComputedStyle(panelEl);
      if (cs.display && cs.display !== 'none') {
        sampledDisplay = cs.display;
        break;
      }
    }

    for (const panelEl of roots) {
      if (panelEl.hasAttribute('hidden')) panelEl.removeAttribute('hidden');
      if (panelEl.getAttribute('aria-hidden') === 'true') {
        panelEl.setAttribute('aria-hidden', 'false');
      }

      const csNow = win.getComputedStyle(panelEl);
      const wasDisplayNone = csNow.display === 'none';
      const stackAnchor = stackAnchors.get(panelEl.parentElement) || null;

      if (csNow.visibility === 'hidden') {
        panelEl.style.setProperty('visibility', 'visible', 'important');
      }
      if (parseFloat(csNow.opacity) < 0.01) {
        panelEl.style.setProperty('opacity', '1', 'important');
      }
      if (wasDisplayNone) {
        const origInlineDisplay = panelEl.style.display;
        panelEl.style.removeProperty('display');
        if (win.getComputedStyle(panelEl).display === 'none') {
          if (origInlineDisplay) panelEl.style.display = origInlineDisplay;
          const attrDisplay = (panelEl.getAttribute('data-ue-panel-display') || '').trim();
          const forcedDisplay = attrDisplay || (stackAnchor && stackAnchor.display) || sampledDisplay || 'block';
          panelEl.style.setProperty('display', forcedDisplay, 'important');
        }
      }

      // Tab-stack panels (Forza settings categories, tabbed content panes,
      // etc.) must NOT all be reopened in normal flow at once: sibling
      // `display:none` panels share the same slot and should overlay the
      // currently visible peer, otherwise they stack vertically and every
      // hidden panel gets a fake Y offset during measurement.
      if (wasDisplayNone && stackAnchor) {
        const parent = panelEl.parentElement;
        if (parent) {
          const pcs = win.getComputedStyle(parent);
          if (pcs.position === 'static') {
            parent.style.setProperty('position', 'relative', 'important');
          }
        }
        panelEl.style.setProperty('position', 'absolute', 'important');
        panelEl.style.setProperty('left', `${stackAnchor.left}px`, 'important');
        panelEl.style.setProperty('top', `${stackAnchor.top}px`, 'important');
        panelEl.style.setProperty('right', 'auto', 'important');
        panelEl.style.setProperty('bottom', 'auto', 'important');
        if (stackAnchor.width > 0) {
          panelEl.style.setProperty('width', `${stackAnchor.width}px`, 'important');
        }
      }

      if (panelEl.getBoundingClientRect().height < 1) {
        panelEl.style.setProperty('height', 'auto', 'important');
        panelEl.style.setProperty('min-height', 'auto', 'important');
        panelEl.style.setProperty('max-height', 'none', 'important');
        panelEl.style.setProperty('overflow', 'visible', 'important');
      }
    }
  }

  async _traverseImpl(el, rootRect, win, scrollContext, zContext, panelContext) {
    if (el.nodeType !== Node.ELEMENT_NODE) return;
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'link', 'meta', 'head', 'noscript', 'br'].includes(tag)) return;

    // Panel root detection — must come BEFORE the hidden-skip guards. The
    // pre-analysis pass in `analyze()` already forced `display:block`,
    // `visibility:visible`, `opacity:1` on every `[data-ue-panel]` element,
    // so the guards below would naturally pass. We still want to register
    // the group + bbox here (not in the pre-analysis pass) because the
    // panel's bbox is only meaningful AFTER any layout-affecting styles
    // higher in the tree have been resolved by the browser. We snapshot the
    // bbox now and stash it as a `panelGroups` entry; subsequent recursion
    // tags every emitted widget with `_meta.panelGroup = name` so the
    // exporter can pull them out of the root canvas's child list and place
    // them inside a dedicated `UMG.CanvasPanel` named `Panel_<n>`. Nested
    // panels ARE supported: when an `[data-ue-panel]` container sits inside
    // another panel, we record `parentId` (the enclosing panel's name) so
    // the partition step in `generate` / `exportObject` can nest the inner
    // panel placeholder INSIDE the outer panel's children list. Without
    // that nesting, inner panels' content was being routed to its closest
    // panel by `assignPanelGroupsByDom` (innermost wins) but the inner
    // panel's *own placeholder* was emitted as a sibling of the outer panel
    // at root → the outer panel's CanvasPanel ended up empty and the inner
    // panel's children rendered at root-relative coords (bug seen on the
    // prison-lobby `LeftPanel` / `RightPanel` containers).
    let activePanelContext = panelContext;
    const panelInfo = this._panelRegistry ? this._panelRegistry.get(el) : null;
    if (panelInfo) {
      const _pr = el.getBoundingClientRect();
      // Coordinate-frame parity with regular widgets. Leaf widget x/y
      // (`line ~3186`) are stored in SCROLL-relative space when the
      // element sits inside a scroll region; otherwise root-relative.
      // Panels MUST follow the exact same rule, otherwise the
      // `serializePanelCanvas` translation `child.x - pg.x` mixes two
      // frames and produces nonsense offsets — the user-reported
      // "panel içindeki yazıların pozisyonu kayması" bug, where the
      // `stats-container` panel sat inside `details-scroll` (a scroll
      // region) but its registered x/y were root-rel while every text
      // child's x/y was scroll-rel; their difference equalled the
      // scroll's distance from page origin (a few hundred pixels) and
      // dragged the texts off-canvas to the upper-left.
      const _refLeft = scrollContext ? scrollContext.rect.left : rootRect.left;
      const _refTop  = scrollContext ? scrollContext.rect.top  : rootRect.top;
      this.panelGroups.push({
        id: panelInfo.name,
        name: panelInfo.name,
        // parentId is the immediately-enclosing panel's name, or `null`
        // when this panel sits at root (no panel ancestor). Recursion is
        // top-down so `panelContext` here is already the closest-ancestor
        // panel that was registered earlier in this DOM walk.
        parentId: panelContext ? panelContext.id : null,
        // `scrollContextId` mirrors the leaf-widget rule: when a panel
        // sits inside a scroll region, the partition step must place it
        // as a child of that ScrollBox (not of the next panel ancestor)
        // so the panel's slot coords resolve against the scroll's
        // local canvas space — which is exactly what scroll-rel x/y
        // above describe. Without this routing, a `data-ue-panel`
        // inside `overflow:auto` ended up rendered in the outer panel
        // canvas with scroll-rel coords interpreted as root-rel, so
        // the panel itself drifted to a wrong location AND its
        // children (which were correctly scroll-rel) got
        // double-translated against the drifted panel origin.
        scrollContextId: scrollContext ? scrollContext.id : null,
        defaultOpen: !!panelInfo.defaultOpen,
        x: _pr.left - _refLeft,
        y: _pr.top  - _refTop,
        w: _pr.width,
        h: _pr.height
      });
      activePanelContext = { id: panelInfo.name };
    }

    const cs = win.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    if (el.hasAttribute('hidden')) return;
    if (parseFloat(cs.opacity) === 0) return;
    // Screen-reader-only / visually-hidden patterns
    if (cs.clip && /rect\(\s*0(?:px)?\s*[, ]\s*0(?:px)?\s*[, ]\s*0(?:px)?\s*[, ]\s*0(?:px)?\s*\)/.test(cs.clip)) return;
    if (cs.clipPath && /inset\(\s*100%\s*\)|inset\(\s*50%\s*\)/.test(cs.clipPath)) return;

    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    // Common sr-only / visually-hidden pattern: ~1px absolutely-positioned + overflow:hidden
    if (rect.width <= 2 && rect.height <= 2 &&
        (cs.position === 'absolute' || cs.position === 'fixed') &&
        cs.overflow === 'hidden') return;
    this.recordFontFamily(cs.fontFamily);

    // If inside a scroll context, use local coordinates relative to scroll container
    const x = scrollContext ? (rect.left - scrollContext.rect.left) : (rect.left - rootRect.left);
    const y = scrollContext ? (rect.top - scrollContext.rect.top) : (rect.top - rootRect.top);
    const w = rect.width;
    const h = rect.height;

    // --- Common metadata: tooltip, z-index, CSS transform, scroll region ---
    const _tooltip = el.getAttribute('title') || undefined;
    const _rawZ = parseInt(cs.zIndex);
    const _cssZIndex = isNaN(_rawZ) ? undefined : _rawZ;
    // Stamp the just-pushed panelGroup record (if any) with this element's
    // effective z-index. The panel push happens earlier in this function
    // (BEFORE `cs` is computed) so we couldn't compute it inline; here we
    // back-fill it. Without this stamp, every panel collapses to z=0 in
    // the root canvas sort and ties with un-z-indexed bg overlays — which
    // then win the DOM-order tie-break and cover the panel's interactive
    // children. Inheriting from `zContext` when CSS z-index is auto
    // mirrors the same `effectiveZ` rule used for leaf widgets so panels
    // sit at their CSS-stacking-context level (e.g. a panel inside
    // `.main-content { z-index: 5 }` sorts at z=5, above the
    // `.bg-layer { z-index: 0 }` siblings).
    if (panelInfo) {
      const _panelEff = _cssZIndex !== undefined ? _cssZIndex : zContext;
      if (_panelEff !== undefined) {
        const _last = this.panelGroups[this.panelGroups.length - 1];
        if (_last && _last.id === panelInfo.name) _last.zIndex = _panelEff;
      }
    }
    const _transform = this._parseTransform(cs.transform, cs);
    const _meta = {};
    if (_tooltip) _meta.tooltip = _tooltip;
    if (_transform) {
      if (_transform.angle) _meta.renderAngle = _transform.angle;
      if (_transform.scaleX !== 1 || _transform.scaleY !== 1) _meta.renderScale = { x: _transform.scaleX, y: _transform.scaleY };
    }
    if (scrollContext) _meta.scrollRegionId = scrollContext.id;
    // NOTE: `_meta.panelGroup` is NOT set here. Several emit paths
    // (`addButton`'s inline icon overlays, `addImgElement`, the bake
    // branches) push more than one element and only `_tagMeta()` (which
    // applies meta to the LAST pushed widget) runs at this site —
    // propagating panelGroup per-push would miss those overlays. Instead,
    // panel grouping is resolved post-traversal by `assignPanelGroupsByDom`
    // using the `__srcEl` DOM ref that the public `traverse` wrapper
    // stamps on every widget pushed during a node's subtree. The
    // `activePanelContext` parameter on the recursion is preserved as
    // a forward-compat signal (e.g. for future nested-panel detection)
    // even though the actual grouping no longer relies on it.
    // Effective z-index: own CSS z-index takes priority, else inherit from parent context.
    //
    // Decoration-overlay demotion: when an element has `pointer-events:none`
    // AND is `position: absolute|fixed` AND has NO explicit z-index, treat
    // it as a decorative effect layer (shine, vignette, scanlines, glow
    // halo — all the typical `pointer-events:none + absolute + inset:0`
    // patterns). In CSS these paint ON TOP of interactive siblings but
    // clicks pass through and the layer is usually translucent enough
    // that you can see through. In UMG with the same paint order, the
    // baked texture would obscure buttons / text below it. Demoting these
    // by a fractional 0.5 below the inherited z-context keeps them
    // visually behind interactive siblings while still ABOVE anything
    // explicitly z-indexed lower (so a decoration inside a `z-index:5`
    // panel stays above `z-index:0` bg siblings — only the within-panel
    // ordering changes).
    //
    // Decorations with EXPLICIT z-index are respected as-is: the dev who
    // wrote `pointer-events:none; z-index:10` clearly wants the layer on
    // top of everything but non-interactive, so we don't second-guess.
    //
    // Children of a demoted decoration inherit the demoted z-context, so
    // an entire decoration subtree stays behind interactive siblings —
    // matches the typical authoring pattern of nesting glow / shine /
    // scanline divs inside a single `pointer-events:none` wrapper.
    const _isDecorationOverlay =
      cs.pointerEvents === 'none' &&
      (cs.position === 'absolute' || cs.position === 'fixed') &&
      _cssZIndex === undefined;
    let effectiveZ;
    if (_cssZIndex !== undefined) {
      effectiveZ = _cssZIndex;
    } else if (_isDecorationOverlay) {
      effectiveZ = (zContext !== undefined ? zContext : 0) - 0.5;
    } else {
      effectiveZ = zContext;
    }
    if (effectiveZ !== undefined) _meta.zIndex = effectiveZ;
    // Stamp `pointer-events:none` onto the meta so the exporter can emit
    // `bIsHitTestVisible=False` on the resulting widget. Without this,
    // even a correctly z-demoted decoration would still capture mouse
    // events in UMG when it happens to sit on top (e.g. a translucent
    // overlay that's visually behind but technically above a button due
    // to traversal-order tie-break) — clicks would land on the
    // decoration instead of passing through to the button below.
    if (cs.pointerEvents === 'none') _meta.pointerEventsNone = true;
    // text-shadow → emitted as ShadowOffset / ShadowColorAndOpacity on any TextBlock we push for this element
    const _textShadow = this.renderShadows ? parseTextShadow(cs.textShadow) : null;
    if (_textShadow) _meta.textShadow = _textShadow;
    // box-shadow → baked into texture for static Images later. Skipped on
    // panel root elements: a `data-ue-panel` container already gets its own
    // dedicated `UMG.CanvasPanel` widget, and shadow-baking would replace
    // its background with a Texture whose canvas is expanded by the
    // shadow's blur radius (commonly 30–50px on each side for `box-shadow:
    // 0 0 40px ...`). That expanded rect then gets translated into
    // panel-relative coordinates and ends up at negative offsets that
    // overflow the panel CanvasPanel — visually breaking the panel
    // boundary. Dropping the shadow on the panel root itself is an
    // accepted limitation (same class of trade-off as the `gradient` /
    // `frame-border` / `Button` shadow exclusions documented in the
    // schema). Children inside the panel still get their normal shadow
    // bakes since they're not panel roots themselves.
    // Skip box-shadow baking for ANY `[data-ue-panel]` root — including
    // panels nested inside another panel. The shadow bake produces a
    // texture larger than the element rect (canvas grows by `pad.padL/T/R/B`)
    // and shifts the emitted Image by `(-padL, -padT)` so the visible
    // content stays aligned. For an inner widget that's fine — the
    // overflow drapes outside the widget into its parent canvas. But for
    // a panel ROOT, the panel's CanvasPanelSlot in UMG has its own
    // (x, y, w, h) sized to the panel's bbox; the bg child cannot
    // legally extend beyond that rect, and the negative `(x, y)` ends
    // up clipped or rendered at a wrong offset (the user's repro:
    // `box-shadow: 0 8px 30px ...` on `.store-sidebar` produced
    // `offset left -91 top -83` on its bg child). Earlier this exclusion
    // was gated on `!panelContext` (top-level panel only), which
    // silently regressed when the same panel sat inside another panel —
    // the inner panel's shadow was still baked and its bg shifted.
    const _isPanelRoot = !!panelInfo;
    const _boxShadow = (this.renderShadows && !_isPanelRoot) ? parseBoxShadow(cs.boxShadow) : null;
    if (_boxShadow) _meta.boxShadow = _boxShadow;
    // HTML-derived widget name hint — surfaced as `suggestedWidgetName` in the
    // exported JSON. Lets the UE plugin rename UMG widgets from the generic
    // role-based `Button_0` / `Image_Bg_3` to the semantic class/id from the
    // source HTML (`Button_cta` / `Image_Bg_card`). Multiple widgets emitted
    // by the same element share the same hint; the plugin disambiguates by
    // widget type + traversal order.
    const _suggested = this._suggestedNameFromEl(el);
    if (_suggested) _meta.suggestedWidgetName = _suggested;
    const _tagMeta = () => { const last = this.elements[this.elements.length - 1]; if (last) Object.assign(last, _meta); };

    // --- <hr> → thin horizontal line Image ---
    if (tag === 'hr') {
      let hrColor = parseColor(cs.borderTopColor);
      if (!hrColor || hrColor.a < 0.01) hrColor = parseColor(cs.backgroundColor);
      if (!hrColor || hrColor.a < 0.01) hrColor = parseColor(cs.color);
      if (!hrColor || hrColor.a < 0.01) hrColor = { r: 128, g: 128, b: 128, a: 1 };
      this.elements.push({ ueType: 'Image', name: this.uid('Image_Hr'), x, y, w, h: Math.max(h, 1), bgColor: hrColor, borderRadius: 0 });
      _tagMeta();
      return;
    }

    // --- Border radius: use per-corner computed values for accuracy ---
    const brRaw = parseFloat(cs.borderTopLeftRadius) || 0;
    let br = Math.min(brRaw, w/2, h/2); // clamp to half the smallest dimension

    // If the element has no border-radius of its own, inherit one from a
    // rounded-clipping ancestor when the element visually fills that
    // ancestor's content box (avatar-in-circle pattern):
    //
    //   <div class="avatar-circle" style="border-radius:50%;overflow:hidden">
    //     <img src="...">      <!-- browser visually clips this to a circle -->
    //   </div>
    //
    // Without inheritance the converter would emit a square image, since the
    // <img> itself carries no border-radius. We only inherit when the child's
    // own bbox covers the full parent content box (within a small tolerance);
    // smaller / centered children sit inside the rounded "safe zone" and
    // don't need clipping. Heavier shapes (clip-path polygons / circles set
    // via clip-path) are not inherited here — those would require texture
    // baking and are handled by the dedicated clip-path branches elsewhere.
    if (br <= 0) {
      const inheritedR = this._inheritParentClipRadius(el, win);
      if (inheritedR > 0) br = Math.min(inheritedR, w/2, h/2);
    }

    // --- Background ---
    let bgColor = parseColor(cs.backgroundColor);
    const isGradient = hasGradient(cs.backgroundImage);
    const isTextGrad = isTextGradient(cs);
    // Check CSS background-image: url(...)
    const bgUrlRefs = extractCssUrlRefs(cs.backgroundImage);
    // Single-url shortcut (push the asset directly as a UE texture without
    // baking) is only safe when there are NO gradient layers stacked on top
    // of the image. If a gradient is also present (very common pattern, e.g.
    // `linear-gradient(rgba(0,0,0,.6), rgba(0,0,0,.2)), url(panel.png)` for a
    // darkening overlay), we MUST send the element through the multi-layer
    // baking path — otherwise the gradient is silently dropped and we ship
    // only the bare image, which is exactly the "panel.png/icons.png/button.png
    // gelmemiş, ama gelse de overlay'leri eksik" issue the user reported.
    const bgImgUrl = (bgUrlRefs.length === 1 && !isGradient) ? bgUrlRefs[0] : null;
    const hasBgImageUrls = bgUrlRefs.length > 0;
    if (!bgColor || bgColor.a < 0.01) {
      if (!isTextGrad && !bgImgUrl) bgColor = parseGradientColor(cs.backgroundImage);
    }
    const hasBg = bgColor && bgColor.a > 0.01;
    // Per-side border resolution. The shorthand `cs.borderWidth` returns a
    // SPACE-separated string when sides differ ("0px 1px 1px 0px") whose
    // `parseFloat` value is the FIRST side only — so the L-shape bracket
    // pattern (`border-top:1px; border-right:1px; border-bottom:none;
    // border-left:none`) silently parses as `borderW=0`, the engine uniform
    // border is dropped, and the visible "corner accent" disappears in UE.
    // We instead read each side independently, treat `none`/`hidden` as
    // zero-width, and decide:
    //   • all 4 sides identical (or all zero) → uniform path (keeps the
    //     existing Image+borderColor+borderWidth fast path)
    //   • any pair differs → mixed-border path (route through bg-bake so
    //     foreignObject SVG can stroke each side independently)
    const _bTopW    = parseFloat(cs.borderTopWidth)    || 0;
    const _bRightW  = parseFloat(cs.borderRightWidth)  || 0;
    const _bBotW    = parseFloat(cs.borderBottomWidth) || 0;
    const _bLeftW   = parseFloat(cs.borderLeftWidth)   || 0;
    const _bTopS    = cs.borderTopStyle    || 'none';
    const _bRightS  = cs.borderRightStyle  || 'none';
    const _bBotS    = cs.borderBottomStyle || 'none';
    const _bLeftS   = cs.borderLeftStyle   || 'none';
    const _effSide = (style, width) =>
      (style === 'none' || style === 'hidden') ? 0 : width;
    const _effTopW   = _effSide(_bTopS,   _bTopW);
    const _effRightW = _effSide(_bRightS, _bRightW);
    const _effBotW   = _effSide(_bBotS,   _bBotW);
    const _effLeftW  = _effSide(_bLeftS,  _bLeftW);
    const _bTopColor    = (cs.borderTopColor    || '');
    const _bRightColor  = (cs.borderRightColor  || '');
    const _bBotColor    = (cs.borderBottomColor || '');
    const _bLeftColor   = (cs.borderLeftColor   || '');
    const _maxSideW = Math.max(_effTopW, _effRightW, _effBotW, _effLeftW);
    const _sidesWidthEqual =
      _effTopW === _effRightW && _effRightW === _effBotW && _effBotW === _effLeftW;
    const _sidesColorEqual =
      _bTopColor === _bRightColor && _bRightColor === _bBotColor && _bBotColor === _bLeftColor;
    const hasMixedBorders =
      _maxSideW > 0 && (!_sidesWidthEqual || !_sidesColorEqual);
    // For uniform path: prefer the per-side widths / styles (more reliable
    // than the shorthand on mixed-side cases that happen to share a width
    // but differ on style/color, e.g. `border:1px solid; border-bottom-color:red`).
    const borderW = hasMixedBorders ? _maxSideW : (_effTopW || parseFloat(cs.borderWidth) || 0);
    const hasBorder = borderW > 0 && cs.borderStyle !== 'none';
    const opacity = parseFloat(cs.opacity);
    const clipPath = cs.clipPath || cs.webkitClipPath || 'none';
    const hasClipPath = !!(clipPath && clipPath !== 'none');

    // --- <input type="range"> → Slider ---
    if (tag === 'input' && el.type === 'range') {
      this.addSlider(el, cs, x, y, w, h, br);
      _tagMeta();
      return;
    }
    // --- <progress>, <meter> → ProgressBar ---
    if (tag === 'progress' || tag === 'meter') {
      this.addProgressBar(el, cs, x, y, w, h, br, tag);
      _tagMeta();
      return;
    }
    // --- radio input / checkbox → CheckBox ---
    if (tag === 'input' && (el.type === 'radio' || el.type === 'checkbox')) {
      let checkBgColor = parseColor(cs.backgroundColor);
      // If background is transparent (browser default), leave null → UE default style
      if (checkBgColor && checkBgColor.a < 0.01) checkBgColor = null;
      const checkBorderW = parseFloat(cs.borderWidth) || 0;
      const checkBorderColor = checkBorderW > 0 && cs.borderStyle !== 'none' ? parseColor(cs.borderColor) : null;
      // CSS `accent-color: <color>` colors the form-control's checked state
      // (the tick / radio dot). Browsers default this to the user's system
      // accent (`auto`), which we treat as "no override". When the author
      // explicitly sets a color we surface it on the widget so the UE
      // CheckBox style emits a tinted CheckedImage instead of the
      // engine-default light-blue. Any non-`auto`/non-`currentcolor` value
      // is honored — including custom-property resolved values like
      // `var(--orange)` (computedStyle resolves these for us).
      let accentColor = null;
      const _accent = cs.accentColor;
      if (_accent && _accent !== 'auto' && _accent !== 'currentcolor') {
        const _ac = parseColor(_accent);
        if (_ac && _ac.a > 0.01) accentColor = _ac;
      }
      this.elements.push({
        ueType: 'CheckBox', name: this.uid('CheckBox'), x, y, w, h,
        bgColor: checkBgColor, borderColor: checkBorderColor, borderWidth: checkBorderW,
        borderRadius: br, checked: el.checked || false,
        accentColor
      });
      _tagMeta();
      return;
    }
    // --- check for buttons (button, a, input submit/button, cursor:pointer) ---
    const isClickable = this.isLinkButton(el, cs, tag);
    const inlineTags = ['b', 'i', 'strong', 'em', 'span', 'mark', 'sub', 'sup', 'u', 's', 'del', 'ins', 'small', 'big', 'q'];
    // Children of a flex/grid parent are "blockified" by CSS — `<strong>` /
    // `<span>` inside `display:flex` get computedDisplay === "block" even when
    // the author clearly meant them as inline content (e.g. a CTA button laid
    // out as a flex stack: `<a class="cta"><strong>Title</strong><span>// 03</span></a>`).
    // Without this skip, the blockification would prevent the anchor from being
    // detected as a button and it would fall through to the generic baked-image
    // path. Inline-tag children inside flex/grid parents are treated as inline.
    const parentBlockifiesInlineChildren =
      cs.display === 'flex' || cs.display === 'inline-flex' ||
      cs.display === 'grid' || cs.display === 'inline-grid';
    const hasBlockChildren = Array.from(el.children).some(c => {
      const ct = c.tagName.toLowerCase();
      if (ct === 'br' || ct === 'hr') return false;
      if (!inlineTags.includes(ct)) return true;
      if (parentBlockifiesInlineChildren) return false;
      // Also check computed display — e.g. span with display:grid/block is a visual block
      const childDisp = win.getComputedStyle(c).display;
      return childDisp !== 'inline' && childDisp !== 'inline-block' &&
             childDisp !== 'inline-flex' && childDisp !== 'contents';
    });

    // Any element the user has explicitly marked as interactive MUST always
    // be emitted as a Button widget regardless of children type. This
    // covers two groups:
    //   - Native interactive tags: <button>, <a href>, <input type=submit|button>, <summary>
    //   - Author-tagged interactive elements: role="button" / "link" /
    //     "menuitem" / "tab" / "option" / "switch" / "radio", onclick=,
    //     tabindex="0", data-action / data-click / data-href hooks,
    //     class names containing btn / button / cta / clickable.
    // The earlier gate `!hasBlockChildren` (and its later `|| isNativeInteractive`
    // version) silently dropped the click receiver for tagged tabs / cards
    // / dropdown triggers like:
    //     <button class="sidebar-tab" role="button" tabindex="0">
    //         <div class="tab-indicator"></div>
    //         <span class="tab-text">PISTOLS</span>
    //         <span class="tab-count">5</span>
    //     </button>
    // and:
    //     <div role="button" tabindex="0" data-action="open-shop">
    //         <i class="icon"></i>
    //         <span>Shop</span>
    //     </div>
    // — both have block-ish children (div, i, etc.) so the gate failed
    // even though the author clearly wired up an interactive element.
    // Now we trust `isLinkButton`'s decision (which already requires either
    // a native tag OR an explicit click signal) and route every clickable
    // element through the Button branch. Block children flip the rich-
    // content path on so traverse() recurses into them and emits each as
    // its own widget at the correct flex / grid position.
    const isNativeInteractive =
      tag === 'button' || tag === 'summary' ||
      (tag === 'input' && (el.type === 'submit' || el.type === 'button')) ||
      (tag === 'a' && el.getAttribute('href') !== null && el.getAttribute('href') !== '');

    if (isClickable) {
      // "Rich content" CTAs — flex/grid anchors with multiple element children
      // each carrying distinct styling, e.g.
      //   <a class="cta"><strong>Deploy Now</strong><span>// 01</span></a>
      // — used to lose ALL their visible content because:
      //   1) `getVisuallyWrappedText()` for flex/grid only collects DIRECT
      //      text nodes (so the <strong>/<span> text was never read),
      //   2) the Button branch always `return`ed without recursing into
      //      children, and
      //   3) the same return also skipped the post-button pseudo handlers,
      //      so .cta::before linear-gradient shine overlays vanished.
      // For these buttons we keep the Button as the click receiver but emit
      // it as a TEXT-LESS shell, then run the pseudo handlers and recurse
      // into children so each child renders as its own TextBlock at the
      // visually correct flex position with full font / color / weight.
      // Same path is now also used for native interactive tags with
      // non-inline (e.g. <svg>) children — the click target stays a UMG
      // Button and the SVG inside is rendered as a baked Image via
      // traverse() recursion.
      // Rich-content path is used whenever the button has children that
      // can't be flattened into a single inner TextBlock label — namely
      // any block-level child (div / icon / svg) OR multiple distinctly-
      // styled inline children inside a flex/grid layout. In both cases
      // the Button widget becomes a click-receiver shell (skipText=true)
      // and traverse() recurses into the children to emit each as its
      // own widget at the correct flex/grid-resolved position. Without
      // this, button content like the SHOP/PISTOLS/DROPDOWN trio of
      // tab-indicator + label + count was silently dropped.
      const isRichContentButton = this._shouldUseRichContentButton(
        el,
        cs,
        win,
        hasBlockChildren,
        parentBlockifiesInlineChildren
      );
      // `data-ue-toggle="..."` on this button declares which panel it
      // opens / closes. We resolve the raw attribute value to the
      // sanitized panel identifier the exporter will use (or, if no
      // registered panel matches, just sanitize the raw value so a hint
      // is still produced). The resolved name is stamped on the emitted
      // Button widget as `toggleTarget`; the T3D exporter prints a wiring
      // hint comment above the button so the Blueprint developer can wire
      // its OnClicked event to `Panel_<n>` Visibility manually (T3D
      // delegate bindings don't survive clipboard paste).
      const toggleAttr = el.getAttribute && el.getAttribute('data-ue-toggle');
      const toggleTarget = toggleAttr ? this._resolveToggleTargetName(toggleAttr) : null;
      await this.addButton(el, cs, x, y, w, h, br, win, rootRect, hasBorder, borderW, {
        skipText: isRichContentButton,
        toggleTarget
      });
      _tagMeta();
      if (isRichContentButton) {
        await this.handlePseudoGradient(el, cs, x, y, w, h, rootRect, win, '::before', _meta, 'before');
        await this.handlePseudoGradient(el, cs, x, y, w, h, rootRect, win, '::after',  _meta, 'before');
        for (const child of el.children) {
          await this.traverse(child, rootRect, win, scrollContext, effectiveZ, activePanelContext);
        }
        await this.handlePseudoGradient(el, cs, x, y, w, h, rootRect, win, '::before', _meta, 'after');
        await this.handlePseudoGradient(el, cs, x, y, w, h, rootRect, win, '::after',  _meta, 'after');
      }
      return; // Stop traversing children so they don't render separately from the button
    }
    
    // --- <input> (text) / <textarea> ---
    if (tag === 'input' || tag === 'textarea') {
      this.addInput(el, cs, x, y, w, h, br);
      _tagMeta();
      return;
    }
    // --- <select> ---
    if (tag === 'select') {
      this.addComboBox(el, cs, x, y, w, h, br);
      _tagMeta();
      return;
    }
    // --- <img> ---
    if (tag === 'img') {
      await this.addImgElement(el, cs, x, y, w, h, br, win);
      _tagMeta();
      return;
    }
    // --- <canvas> → PNG snapshot ---
    // Authors increasingly drive panel backgrounds, particle layers, and
    // procedural art with `<canvas>` filled by JavaScript at runtime
    // (`bgCtx.fillRect(...)`, particle systems, pixel art generators).
    // We can't replay that JS in UMG, but we CAN snapshot the current
    // pixel state once the iframe has finished loading and stamp it as
    // a regular Image widget — preserving the visual that the author
    // intended without manual texture export. Tainted canvases (e.g.
    // ones that drew a cross-origin image without CORS) throw
    // SecurityError on `toDataURL`; we silently swallow that and skip
    // the canvas (the rest of the layout still emits correctly).
    if (tag === 'canvas') {
      try {
        const cvs = el;
        if (cvs.width > 0 && cvs.height > 0) {
          const dataUrl = cvs.toDataURL('image/png');
          if (dataUrl && dataUrl.length > 'data:image/png;base64,'.length + 16) {
            const texName = `T_Canvas_${SESSION_ID}_${this.uid('canvas')}`;
            const texPath = `/Game/UI/Textures/${texName}`;
            this.textures.push({
              url: dataUrl,
              name: texName + '.png',
              suggestedPath: texPath,
              isGradient: false,
              cssFilter: cs.filter
            });
            this.elements.push({
              ueType: 'Image', name: this.uid('Image_Canvas'),
              x, y, w, h,
              bgColor: null, borderRadius: br,
              gradientTexturePath: texPath,
              opacity: (() => {
                const v = parseFloat(cs.opacity);
                return Number.isFinite(v) && v < 1 ? v : undefined;
              })()
            });
            _tagMeta();
          }
        }
      } catch { /* tainted canvas / SecurityError → skip */ }
      return;
    }
    // --- inline <svg> → baked texture Image ---
    if (tag === 'svg') {
      await this.addSvgElement(el, cs, x, y, w, h, br, win);
      _tagMeta();
      return;
    }
    // --- <pre> / <code> → TextBlock with full content ---
    if (tag === 'pre' || tag === 'code') {
      const preText = this.fullText(el);
      if (preText) {
        const color = parseColor(cs.color) || { r:255, g:255, b:255, a:1 };
        const fontSize = parseFloat(cs.fontSize) || 14;
        const fw = fontWeightName(cs.fontWeight);
        // Add background for pre
        if (hasBg || hasBorder) {
          const borderColor = hasBorder ? parseColor(cs.borderColor) : null;
          this.elements.push({ ueType:'Image', name:this.uid('Image_Bg'), x, y, w, h, bgColor, borderRadius:br, borderColor, borderWidth:borderW, opacity });
          _tagMeta();
        }
        this.elements.push({ ueType:'TextBlock', name:this.uid('TextBlock_Pre'), x, y, w, h, text:preText, color, fontSize, fontWeight:fw, fontFamily:cs.fontFamily, textAlign:cs.textAlign, autoSize:true });
        _tagMeta();
      }
      return; // don't recurse into pre/code children
    }

    // --- CSS background-image: url(...) → Image widget ---
    // --- Background div -> Image widget ---
    let effectiveGradient = isGradient && !isTextGrad && !isSolidColorGradient(cs.backgroundImage);
    // When the user has toggled off gradient rendering, skip baking and fall
    // back to a solid fill extracted from the first gradient color stop.
    if (effectiveGradient && !this.renderGradients) {
      effectiveGradient = false;
      if (!hasBg) {
        const gc = parseGradientColor(cs.backgroundImage);
        if (gc && gc.a > 0.01) { bgColor = gc; }
      }
    }
    // Re-evaluate hasBg after possible fallback assignment above
    const hasBgResolved = bgColor && bgColor.a > 0.01;
    let backgroundWasBaked = false;

    if (hasClipPath && !isTextGrad && (hasBgResolved || hasBorder || effectiveGradient || hasBgImageUrls)) {
      const _clipKey = [
        'clipbg',
        cs.backgroundImage,
        cs.backgroundColor,
        cs.backgroundSize,
        cs.backgroundPosition,
        cs.backgroundRepeat,
        cs.backgroundOrigin,
        cs.backgroundClip,
        cs.borderColor,
        cs.borderWidth,
        cs.borderStyle,
        clipPath,
        Math.round(w) + 'x' + Math.round(h),
        Math.round(br)
      ].join('|');
      let _clipPath = this._texCache ? this._texCache.get(_clipKey) : null;
      if (!_clipPath) {
        const dataUrl = await renderStyledLayerTexture({
          backgroundImage: cs.backgroundImage,
          backgroundColor: cs.backgroundColor,
          backgroundSize: cs.backgroundSize,
          backgroundPosition: cs.backgroundPosition,
          backgroundRepeat: cs.backgroundRepeat,
          backgroundOrigin: cs.backgroundOrigin,
          backgroundClip: cs.backgroundClip,
          borderColor: cs.borderColor,
          borderWidth: cs.borderWidth,
          borderStyle: cs.borderStyle,
          clipPath
        }, w, h, br);
        if (dataUrl) {
          const texName = `T_Clip_${SESSION_ID}_${this.uid('clip')}`;
          _clipPath = `/Game/UI/Textures/${texName}`;
          this.textures.push({ url: dataUrl, name: texName + '.png', suggestedPath: _clipPath, isGradient: effectiveGradient, cssFilter: cs.filter });
          if (this._texCache) this._texCache.set(_clipKey, _clipPath);
        }
      }
      if (_clipPath) {
        this.elements.push({
          ueType:'Image', name:this.uid('Image_ClipPath'), x, y, w, h,
          bgColor:null, borderRadius:0, borderColor:null, borderWidth:0,
          opacity, gradientTexturePath:_clipPath, customShape:true
        });
        _tagMeta();
        backgroundWasBaked = true;
      }
    }

    if (!backgroundWasBaked && bgImgUrl) {
      let _bgPath = this._texCache ? this._texCache.get(bgImgUrl) : null;
      if (!_bgPath) {
        const tName = `T_BgImg_${SESSION_ID}_${this.uid('bgimg')}`;
        _bgPath = `/Game/UI/Textures/${tName}`;
        // Rasterize SVG data URLs to PNG at the element's rect size.
        // Plain URLs (https / png-data / blob) pass through unchanged.
        const _bakedUrl = await maybeRasterizeSvgUrl(bgImgUrl, w, h);
        this.textures.push({ url: _bakedUrl, name: tName + '.png', suggestedPath: _bgPath, isExternalUrl: /^https?:\/\//.test(bgImgUrl), externalSrc: bgImgUrl, cssFilter: cs.filter });
        if (this._texCache) this._texCache.set(bgImgUrl, _bgPath);
      }
      this.elements.push({ ueType:'Image', name:this.uid('Image_BgImg'), x, y, w, h, bgColor:null, borderRadius:br, gradientTexturePath:_bgPath });
      _tagMeta();
    }

    // --- Background div → Image widget ---
    if (!backgroundWasBaked && !bgImgUrl && hasBgImageUrls && !cssBackgroundMayTaintCanvas(cs.backgroundImage)) {
      const _multiKey = [
        'bgmulti',
        cs.backgroundImage,
        cs.backgroundColor,
        cs.backgroundSize,
        cs.backgroundPosition,
        cs.backgroundRepeat,
        cs.backgroundOrigin,
        cs.backgroundClip,
        Math.round(w) + 'x' + Math.round(h),
        Math.round(br)
      ].join('|');
      let _multiPath = this._texCache ? this._texCache.get(_multiKey) : null;
      if (!_multiPath) {
        const dataUrl = await renderStyledLayerTexture({
          backgroundImage: cs.backgroundImage,
          backgroundColor: cs.backgroundColor,
          backgroundSize: cs.backgroundSize,
          backgroundPosition: cs.backgroundPosition,
          backgroundRepeat: cs.backgroundRepeat,
          backgroundOrigin: cs.backgroundOrigin,
          backgroundClip: cs.backgroundClip
        }, w, h, br);
        if (dataUrl) {
          const texName = `T_BgMulti_${SESSION_ID}_${this.uid('bgmulti')}`;
          _multiPath = `/Game/UI/Textures/${texName}`;
          this.textures.push({ url: dataUrl, name: texName + '.png', suggestedPath: _multiPath, isGradient: hasGradient(cs.backgroundImage), cssFilter: cs.filter });
          if (this._texCache) this._texCache.set(_multiKey, _multiPath);
        }
      }
      if (_multiPath) {
        this.elements.push({ ueType:'Image', name:this.uid('Image_BgImg'), x, y, w, h, bgColor:null, borderRadius:0, opacity, gradientTexturePath:_multiPath });
        _tagMeta();
        backgroundWasBaked = true;
      }
    }

    // --- Mixed per-side borders → bake bg + asymmetric borders to a texture ---
    // UE's Image widget only supports a UNIFORM border (single color, single
    // width, all 4 sides). When the author uses CSS like
    //   border-top:1px solid; border-right:1px solid;
    //   border-bottom:none;  border-left:none;
    // (the L-shape "corner bracket" pattern, or single-edge accent lines like
    // `border-bottom: 2px solid red` for a tab underline), the uniform path
    // either drops the border entirely (parseFloat of mismatched shorthand
    // returns the FIRST side, often 0) or draws a full 4-side box that
    // visually replaces the bracket with a rectangle. Routing through the
    // foreignObject SVG bake — which now honors per-side `border-top/right/
    // bottom/left` rules in `renderCssBackgroundTexture` — preserves exactly
    // what the browser paints. We emit a texture-only Image (no engine
    // border / radius) so UMG doesn't double-stroke on top.
    if (!backgroundWasBaked && !bgImgUrl && hasMixedBorders &&
        !cssBackgroundMayTaintCanvas(cs.backgroundImage)) {
      const _mixKey = [
        'mixedborder',
        cs.backgroundImage,
        cs.backgroundColor,
        cs.borderTopWidth, cs.borderTopStyle, cs.borderTopColor,
        cs.borderRightWidth, cs.borderRightStyle, cs.borderRightColor,
        cs.borderBottomWidth, cs.borderBottomStyle, cs.borderBottomColor,
        cs.borderLeftWidth, cs.borderLeftStyle, cs.borderLeftColor,
        Math.round(w) + 'x' + Math.round(h),
        Math.round(br)
      ].join('|');
      let _mixPath = this._texCache ? this._texCache.get(_mixKey) : null;
      if (!_mixPath) {
        const dataUrl = await renderStyledLayerTexture({
          backgroundImage: cs.backgroundImage,
          backgroundColor: cs.backgroundColor,
          backgroundSize: cs.backgroundSize,
          backgroundPosition: cs.backgroundPosition,
          backgroundRepeat: cs.backgroundRepeat,
          backgroundOrigin: cs.backgroundOrigin,
          backgroundClip: cs.backgroundClip,
          // Per-side longhands flip `renderCssBackgroundTexture` into its
          // 4-rule branch instead of the uniform shorthand.
          borderTopWidth:    cs.borderTopWidth,
          borderTopStyle:    cs.borderTopStyle,
          borderTopColor:    cs.borderTopColor,
          borderRightWidth:  cs.borderRightWidth,
          borderRightStyle:  cs.borderRightStyle,
          borderRightColor:  cs.borderRightColor,
          borderBottomWidth: cs.borderBottomWidth,
          borderBottomStyle: cs.borderBottomStyle,
          borderBottomColor: cs.borderBottomColor,
          borderLeftWidth:   cs.borderLeftWidth,
          borderLeftStyle:   cs.borderLeftStyle,
          borderLeftColor:   cs.borderLeftColor
        }, w, h, br);
        if (dataUrl) {
          const texName = `T_BorderMix_${SESSION_ID}_${this.uid('bmix')}`;
          _mixPath = `/Game/UI/Textures/${texName}`;
          this.textures.push({ url: dataUrl, name: texName + '.png', suggestedPath: _mixPath, isGradient: hasGradient(cs.backgroundImage), cssFilter: cs.filter });
          if (this._texCache) this._texCache.set(_mixKey, _mixPath);
        }
      }
      if (_mixPath) {
        this.elements.push({
          ueType: 'Image', name: this.uid('Image_BorderMix'),
          x, y, w, h,
          bgColor: null, borderRadius: 0,
          borderColor: null, borderWidth: 0,
          opacity, gradientTexturePath: _mixPath
        });
        _tagMeta();
        backgroundWasBaked = true;
      }
    }

    const useEngineRoundedGradient = effectiveGradient && br > 0;
    if (!backgroundWasBaked && !bgImgUrl && (hasBgResolved || hasBorder || effectiveGradient)) {
      const borderColor = hasBorder ? parseColor(cs.borderColor) : null;
      // Frame-style border: visible border, no fill, no gradient → UMG.Image
      // with DrawAs=Border (a 9-slice with a 10×10 white tile). Only applied
      // to SQUARE-CORNER frames (br <= 0). The 9-slice brush ignores
      // border-radius — using it on a `border-radius: 50%` element draws a
      // rectangular outline where the user expected a circle (the .reticle
      // case the user reported: "yuvarlak bir border varken sadece ortasındaki
      // grid gelmiş"). When br > 0 we fall through to the regular Image
      // push below, which UMG renders with `DrawAs=RoundedBox` honoring both
      // the radius and the outline color/width.
      const isFrameLike = hasBorder && !hasBgResolved && !effectiveGradient && borderColor && borderColor.a > 0.01 && br <= 0;
      if (isFrameLike) {
        const framePath = this.ensureBorderFrameTexture(win);
        const marginNorm = Math.min(0.5, Math.max(0.05, borderW / 10));
        this.elements.push({
          ueType: 'Image', name: this.uid('Image_BorderFrame'), x, y, w, h,
          bgColor: null, borderRadius: br, opacity,
          _isBorderFrame: true,
          borderFrameColor: borderColor,
          borderFrameMargin: marginNorm,
          borderFrameTexturePath: framePath,
          borderColor, borderWidth: borderW
        });
        _tagMeta();
        // Fall through to text / children handling below by not returning here
        // but skip the regular background-image push
      } else {
      let gradientTexturePath = null;
      if (effectiveGradient) {
        const _gKey = cs.backgroundImage + '|' + Math.round(w) + 'x' + Math.round(h) + '|' + Math.round(br);
        gradientTexturePath = this._texCache ? this._texCache.get(_gKey) : null;
        if (!gradientTexturePath) {
          const texName = `T_Gradient_${SESSION_ID}_${this.uid('grad')}`;
          const dataUrl = await renderGradientTexture(cs.backgroundImage, w, h, br, {
            backgroundImage: cs.backgroundImage,
            backgroundColor: cs.backgroundColor,
            backgroundSize: cs.backgroundSize,
            backgroundPosition: cs.backgroundPosition,
            backgroundRepeat: cs.backgroundRepeat,
            backgroundOrigin: cs.backgroundOrigin,
            backgroundClip: cs.backgroundClip
          }, { clipRoundedCorners: !useEngineRoundedGradient });
          gradientTexturePath = `/Game/UI/Textures/${texName}`;
          this.textures.push({ url: dataUrl, name: texName + '.png', suggestedPath: gradientTexturePath, isGradient: true, cssFilter: cs.filter });
          if (this._texCache) this._texCache.set(_gKey, gradientTexturePath);
        }
      }

      // box-shadow: bake shadow halo + fill into a single texture for static
      // solid-bg Images. Skips gradient, frame-border, and non-Image types.
      // Element bbox is expanded by shadow padding so the visible rect stays aligned.
      const shadows = this.renderShadows ? _meta.boxShadow : null;
      if (shadows && !effectiveGradient && hasBgResolved) {
        const _sKey = `shadow|${cs.boxShadow}|${Math.round(w)}x${Math.round(h)}|${Math.round(br)}|${bgColor.r},${bgColor.g},${bgColor.b},${bgColor.a}`;
        let _sPath = this._texCache ? this._texCache.get(_sKey) : null;
        let _sPad = null;
        // Always need padding; cache only stores path. Re-compute padding from shadows.
        const _cachedPad = computeBoxShadowPadding(shadows);
        if (!_sPath) {
          const baked = await renderBoxShadowTexture(w, h, br, bgColor, borderColor, borderW, shadows);
          if (baked) {
            const texName = `T_Shadow_${SESSION_ID}_${this.uid('shadow')}`;
            _sPath = `/Game/UI/Textures/${texName}`;
            this.textures.push({ url: baked.dataUrl, name: texName + '.png', suggestedPath: _sPath, isShadowBake: true, cssFilter: cs.filter });
            if (this._texCache) this._texCache.set(_sKey, _sPath);
            _sPad = baked;
          }
        } else {
          _sPad = { padL: _cachedPad.padL, padR: _cachedPad.padR, padT: _cachedPad.padT, padB: _cachedPad.padB, totalW: w + _cachedPad.padL + _cachedPad.padR, totalH: h + _cachedPad.padT + _cachedPad.padB };
        }
        if (_sPath && _sPad) {
          // Shift element origin/size to include the shadow padding. Border and
          // radius are already baked into the PNG — emit as a texture-only Image.
          this.elements.push({
            ueType: 'Image', name: this.uid('Image_Shadow'),
            x: x - _sPad.padL, y: y - _sPad.padT,
            w: _sPad.totalW, h: _sPad.totalH,
            bgColor: null, borderRadius: 0, borderColor: null, borderWidth: 0,
            opacity,
            gradientTexturePath: _sPath,
            _shadowBaked: true
          });
          _tagMeta();
          // Skip the regular non-shadow push; text/children still render above.
        } else {
          // Baking failed — fall back to regular push
          this.elements.push({
            ueType:'Image', name:this.uid(gradientTexturePath ? 'Image_Gradient' : 'Image_Bg'), x, y, w, h,
            bgColor, borderRadius:br, borderColor, borderWidth:borderW, opacity,
            gradientTexturePath, engineRoundedCorners: useEngineRoundedGradient
          });
          _tagMeta();
        }
      } else {
        this.elements.push({
          ueType:'Image', name:this.uid(gradientTexturePath ? 'Image_Gradient' : 'Image_Bg'), x, y, w, h,
          bgColor, borderRadius:br, borderColor, borderWidth:borderW, opacity,
          gradientTexturePath, engineRoundedCorners: useEngineRoundedGradient
        });
        _tagMeta();
      }
      } // end else (non-frame branch)
    }

    // --- <details> → ExpandableArea (CanvasPanel container) ---
    // We DO NOT use UMG.ExpandableArea + NamedSlotBindings because those
    // bindings do not round-trip through T3D clipboard paste — header/body
    // widgets end up orphaned at (0,0) in the root canvas. Instead we emit a
    // CanvasPanel named "ExpandableArea_<n>" and place the synthesized header
    // TextBlock + body children as REAL CanvasPanelSlot children of it. The
    // outer name is preserved so users can swap to UExpandableArea manually.
    if (tag === 'details') {
      const summaryEl = Array.from(el.children).find(c => c.tagName.toLowerCase() === 'summary');
      const summaryText = summaryEl ? (summaryEl.innerText || summaryEl.textContent || '').trim() : '';
      const summaryCs = summaryEl ? win.getComputedStyle(summaryEl) : cs;
      const summaryFontSize = parseFloat(summaryCs.fontSize) || 14;
      const summaryFw = fontWeightName(summaryCs.fontWeight);
      const summaryColor = parseColor(summaryCs.color);
      const summaryBgColor = parseColor(summaryCs.backgroundColor);
      const summaryBorderColor = parseColor(summaryCs.borderColor);
      const summaryBorderWidth = parseFloat(summaryCs.borderTopWidth) || 0;
      const summaryBorderRadius = parseFloat(summaryCs.borderTopLeftRadius) || 0;
      const summaryPadLeft = parseFloat(summaryCs.paddingLeft) || 0;
      const summaryPadRight = parseFloat(summaryCs.paddingRight) || 0;
      const originalExpanded = el.getAttribute('data-ue-original-open') === '1';
      const readSummaryIndicatorState = (forceExpanded) => {
        if (!summaryEl) return { text: '', color: summaryColor };
        const prevOpen = el.open;
        try {
          el.open = !!forceExpanded;
          // Force style recomputation so selectors like details[open] summary::after update.
          void summaryEl.offsetWidth;
          const afterCs = win.getComputedStyle(summaryEl, '::after');
          return {
            text: afterCs ? (cssContentToText(afterCs.content) || '') : '',
            color: afterCs ? (parseColor(afterCs.color) || summaryColor) : summaryColor
          };
        } finally {
          el.open = prevOpen;
          void summaryEl.offsetWidth;
        }
      };
      const collapsedIndicator = readSummaryIndicatorState(false);
      const expandedIndicator = readSummaryIndicatorState(true);
      // Keep the legacy flat arrow fields for backward compatibility. Prefer the
      // state that matches the source HTML's original open/closed state.
      const activeIndicator = originalExpanded ? expandedIndicator : collapsedIndicator;
      const summaryArrowText = activeIndicator.text || '';
      const summaryArrowColor = activeIndicator.color || summaryColor;
      // Ensure body measurement/traversal still happens with the details forced open.
      el.open = true;
      // Measure the summary's rect relative to the <details> container so the
      // header TextBlock lands exactly where the browser drew it.
      let summaryRect = null;
      if (summaryEl) {
        const sRect = summaryEl.getBoundingClientRect();
        const _refTop = scrollContext ? scrollContext.rect.top : rootRect.top;
        const _refLeft = scrollContext ? scrollContext.rect.left : rootRect.left;
        summaryRect = {
          x: (sRect.left - _refLeft) - x,
          y: (sRect.top - _refTop) - y,
          w: sRect.width,
          h: sRect.height
        };
      }
      const isExpanded = originalExpanded;
      // Sub-traverse body children into a separate bucket
      const _savedElements = this.elements;
      this.elements = [];
      for (const child of el.children) {
        if (child.tagName.toLowerCase() === 'summary') continue;
        await this.traverse(child, rootRect, win, scrollContext, effectiveZ, activePanelContext);
      }
      const bodyElements = this.elements;
      this.elements = _savedElements;
      // Re-origin body element positions to be relative to the <details> rect
      bodyElements.forEach(be => { be.x -= x; be.y -= y; });
      this.elements.push({
        ueType: 'ExpandableArea', name: this.uid('ExpandableArea'),
        x, y, w, h,
        summaryText, summaryFontSize, summaryFontWeight: summaryFw, summaryColor,
        summaryBgColor, summaryBorderColor, summaryBorderWidth, summaryBorderRadius,
        summaryPadLeft, summaryPadRight, summaryArrowText, summaryArrowColor,
        summaryCollapsedArrowText: collapsedIndicator.text || '',
        summaryCollapsedArrowColor: collapsedIndicator.color || summaryColor,
        summaryExpandedArrowText: expandedIndicator.text || '',
        summaryExpandedArrowColor: expandedIndicator.color || summaryColor,
        summaryRect, isExpanded, bodyElements
      });
      _tagMeta();
      return;
    }

    // --- Direct text content → TextBlock ---
    // Extract text with visual wrapping preserved exactly
    let directTxt = this.getVisuallyWrappedText(el, win, cs);
    // Normalize HTML-source whitespace runs (CSS white-space:normal collapses these but textContent doesn't)
    if (directTxt && !cs.whiteSpace.startsWith('pre')) {
      directTxt = directTxt.split('\n').map(l => l.replace(/[ \t]{2,}/g, ' ').trim()).join('\n').trim();
    }
    // Prepend list marker for <li> (1. / a. / • etc.) — CSS-rendered markers are not in textContent
    if (tag === 'li') {
      const marker = getListMarker(el, cs);
      if (marker && directTxt) directTxt = marker + directTxt;
    }

    const isFontIcon = isRenderableFontIconElement(el, cs, win);

    // --- Pseudo-element UNDERLAYS (before text/icons) ---
    // Inline decorative ::before glyphs (bullets, stars, chevrons) and
    // absolutely-positioned gradient-border pseudos (typically z-index:-1)
    // belong BEHIND this element's TextBlock / emoji / icon, otherwise they
    // end up covering the text. Overlay pseudos (explicit z-index > 0 on an
    // absolute pseudo) are deferred to the 'after' pass further below.
    // Skip entirely when this element itself IS a font-icon: in that case
    // ::before already holds the icon glyph and the dedicated isFontIcon
    // branch below is the canonical emitter — handling it here too would
    // produce two stacked Image widgets for the same glyph.
    if (!(isFontIcon && this.renderFontIcons)) {
      await this.handlePseudoGradient(el, cs, x, y, w, h, rootRect, win, '::before', _meta, 'before');
      await this.handlePseudoGradient(el, cs, x, y, w, h, rootRect, win, '::after',  _meta, 'before');
    }

    // --- Inline emoji / decorative-glyph extraction ---
    // When the render-emoji toggle is ON and this element carries inline emoji
    // OR BMP decorative symbols (⚔ ☠ ✦ ★ ➤ …) mixed with regular text — i.e.
    // NOT a standalone icon element — pull each glyph out as its own Image
    // widget at its exact glyph rect and strip the codepoint from directTxt.
    // Reason: most UE runtime fonts lack coverage for both color emoji AND
    // the U+2600..U+27BF / U+2B00..U+2BFF blocks, so leaving them in the
    // TextBlock renders missing-glyph boxes (e.g. "☠ Kara Mezar Canavar"
    // shows tofu before the title). The extracted ranges are also returned
    // so the TextBlock-bounds walk below can SKIP those character offsets
    // and not anchor the TextBlock's left edge to the extracted glyph's
    // position — without that skip, the remaining text would render directly
    // ON TOP of the baked Image. Standalone icon elements are still handled
    // by the dedicated isFontIcon branch further below.
    let inlineEmojiImages = null;
    let inlineExtractedRanges = null;
    // Inline emoji/pictograph extraction runs unconditionally — see comment
    // on `extractAndBakeInlineEmojis` for why the toggle does NOT gate this.
    if (!isFontIcon && directTxt && textContainsInlineBakeableGlyph(directTxt)) {
      const extraction = this.extractAndBakeInlineEmojis(el, cs, win, rootRect, scrollContext);
      inlineEmojiImages = extraction.images;
      inlineExtractedRanges = extraction.extractedRanges;
      if (inlineEmojiImages.length) {
        directTxt = stripInlineBakeableGlyphs(directTxt)
          .replace(/[ \t]+/g, ' ')
          .replace(/ ?\n ?/g, '\n')
          .trim();
      }
    }

    let skipChildren = false;
    if (directTxt.length > 0 && !(isFontIcon && this.renderFontIcons)) {
      const inlineTags = ['b', 'i', 'strong', 'em', 'span', 'mark', 'sub', 'sup', 'u', 's', 'del', 'ins', 'small', 'big', 'q'];
      let hasBlockChildren = false;
      let hasIconChild = false;
      // Track distinct typography fingerprints across visible inline children.
      // When at least two inline siblings differ from each other (or from the
      // parent's baseline) we should NOT fold their text into a single parent
      // TextBlock — each span needs to be emitted as its own TextBlock at its
      // own measured rect with its own color / size / weight. Without this
      // split, markup like
      //   <div class="chat-msg"><span class="sys">[System]</span> <span class="t">Welcome!</span></div>
      // collapses to a single TextBlock in the parent's baseline color and
      // both spans lose their per-span styling.
      const parentSig = this._typographySignature(cs);
      const inlineChildSigs = new Set();
      for (const child of el.children) {
        const childTag = child.tagName.toLowerCase();
        if (childTag === 'br' || childTag === 'hr') continue;
        const childCss = win.getComputedStyle(child);
        if (!inlineTags.includes(childTag)) {
          hasBlockChildren = true;
        } else {
          const childDisp = childCss.display;
          if (childDisp !== 'inline' && childDisp !== 'inline-block' &&
              childDisp !== 'inline-flex' && childDisp !== 'contents') {
            hasBlockChildren = true;
          } else {
            // Visible inline child with text content contributes its
            // typography signature.
            const childTxt = (child.textContent || '').trim();
            if (childTxt &&
                childCss.display !== 'none' &&
                childCss.visibility !== 'hidden') {
              inlineChildSigs.add(this._typographySignature(childCss));
            }
          }
        }
        if (isRenderableFontIconElement(child, childCss, win)) hasIconChild = true;
      }

      // We ONLY split the parent into per-span TextBlocks when the layout
      // is unambiguously "label list" rather than "mixed inline prose":
      //
      //   ✅ split:   <div><span class="sys">[System]</span> <span class="t">Hi</span></div>
      //   ❌ merge:   <p>Hello <strong>world</strong>!</p>
      //
      // The discriminator is whether the parent has any LOOSE direct text
      // node (a text node directly under `el` whose trimmed content is
      // non-empty). Whitespace-only text nodes between spans don't count.
      // When there's loose text, splitting would silently drop "Hello " and
      // "!" because traverse only recurses into element children, not bare
      // text nodes.
      let hasParentLooseText = false;
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE &&
            (node.textContent || '').trim().length > 0) {
          hasParentLooseText = true;
          break;
        }
      }

      // "Distinct styling" = there are >=2 different signatures across inline
      // children, OR exactly one child whose signature differs from the
      // parent baseline. In either case the spans carry user-visible
      // typography that the parent's baseline can't represent on a single
      // merged TextBlock.
      let hasDistinctStyledInlineChildren = false;
      if (!hasBlockChildren && !hasIconChild && !hasParentLooseText && inlineChildSigs.size > 0) {
        if (inlineChildSigs.size >= 2) {
          hasDistinctStyledInlineChildren = true;
        } else {
          const onlySig = inlineChildSigs.values().next().value;
          if (onlySig !== parentSig) hasDistinctStyledInlineChildren = true;
        }
      }

      // "Rich mix" = parent has BOTH loose text AND a styled inline child
      // whose typography sig differs from the parent (e.g.
      //   <span class="card-price"><span class="price-num">15,000</span> CR</span>
      // — `price-num` is gold/larger, " CR" inherits the parent's smaller
      // gray). Merging into a single parent TextBlock would force one
      // color/size for both segments and silently drop the per-segment
      // styling the author put in. Instead, we suppress the merged push
      // AND emit the loose text node(s) as their own TextBlocks at their
      // Range-measured rect with the parent's typography; the styled
      // element children get recursed by the bottom-of-function walk and
      // emit their own TextBlocks with their own typography.
      let hasRichMix = false;
      if (!hasBlockChildren && !hasIconChild && hasParentLooseText && inlineChildSigs.size > 0) {
        for (const sig of inlineChildSigs) {
          if (sig !== parentSig) { hasRichMix = true; break; }
        }
      }

      if (hasDistinctStyledInlineChildren || hasRichMix) {
        // Suppress the parent's merged TextBlock and let each child emit
        // its own through traverse() below. We clear directTxt so the
        // push at the end of this block becomes a no-op (gated on
        // `directTxt.length > 0`). skipChildren stays false so the
        // recursion at the bottom of traverse() walks the children.
        directTxt = '';
        if (hasRichMix) {
          // Emit each loose text node as its own TextBlock at the
          // Range-measured rect, using the parent's typography (color /
          // font-size / font-weight). The styled element siblings will be
          // recursed by the loop at the end of this function and emit
          // their own TextBlocks with their own typography. We reuse the
          // same x/y reference frame as other widgets pushed under this
          // element (scrollContext-relative when inside a scroll region,
          // else rootRect-relative) so the loose-text TextBlock lines up
          // with surrounding elements.
          const _refLeft = scrollContext ? scrollContext.rect.left : rootRect.left;
          const _refTop  = scrollContext ? scrollContext.rect.top  : rootRect.top;
          const _looseRange = win.document.createRange();
          const _looseFontSize = parseFloat(cs.fontSize) || 14;
          const _looseFw = fontWeightName(cs.fontWeight);
          const _looseColor = parseColor(cs.color) || { r:255, g:255, b:255, a:1 };
          const _looseLetterSpacing = (() => {
            const v = parseFloat(cs.letterSpacing);
            return Number.isFinite(v) && v !== 0 ? v : undefined;
          })();
          for (const node of el.childNodes) {
            if (node.nodeType !== Node.TEXT_NODE) continue;
            const raw = node.textContent || '';
            const trimmed = raw.replace(/\s+/g, ' ').trim();
            if (!trimmed) continue;
            // Skip leading whitespace so the measured left edge sits on
            // the first real glyph (mirrors the same skip used in the
            // merged-TextBlock measurement below).
            let _lStart = 0;
            const _lLen = raw.length;
            while (_lStart < _lLen && /\s/.test(raw[_lStart])) _lStart++;
            let _lEnd = _lLen;
            while (_lEnd > _lStart && /\s/.test(raw[_lEnd - 1])) _lEnd--;
            if (_lStart >= _lEnd) continue;
            try {
              _looseRange.setStart(node, _lStart);
              _looseRange.setEnd(node, _lEnd);
            } catch (_e) { continue; }
            const rects = _looseRange.getClientRects();
            if (!rects || rects.length === 0) continue;
            // Tight bounding box across all line rects.
            let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
            for (const rc of rects) {
              if (rc.width < 0.5 || rc.height < 0.5) continue;
              if (rc.left   < l) l = rc.left;
              if (rc.top    < t) t = rc.top;
              if (rc.right  > r) r = rc.right;
              if (rc.bottom > b) b = rc.bottom;
            }
            if (!Number.isFinite(l)) continue;
            const tx = l - _refLeft;
            const ty = t - _refTop;
            const tw = r - l;
            const th = b - t;
            if (tw < 1 || th < 1) continue;
            // Apply CSS text-transform from the parent.
            let segText = trimmed;
            const _tt = cs.textTransform;
            if (_tt === 'uppercase') segText = segText.toUpperCase();
            else if (_tt === 'lowercase') segText = segText.toLowerCase();
            else if (_tt === 'capitalize') segText = segText.replace(/\b\w/g, c => c.toUpperCase());
            const looseTb = {
              ueType: 'TextBlock', name: this.uid('TextBlock'),
              x: tx, y: ty, w: tw, h: th,
              text: segText, color: _looseColor, fontSize: _looseFontSize,
              fontWeight: _looseFw, fontFamily: cs.fontFamily,
              textAlign: cs.textAlign,
              letterSpacing: _looseLetterSpacing,
              autoSize: true
            };
            Object.assign(looseTb, _meta);
            this.elements.push(looseTb);
          }
        }
      } else if (!hasBlockChildren && !hasIconChild) {
        skipChildren = true; // Text is fully handled here, no need to traverse spans/b/i
      }
      // When hasBlockChildren or hasIconChild, always traverse children individually.
      // Each child creates its own TextBlock with correct font size, color, weight etc.

      // Compute exact starting position of the text using Range API.
      // When inline emojis / decorative glyphs were extracted above, we must
      // NOT measure those character offsets here — otherwise the TextBlock's
      // left edge anchors to the extracted glyph rect and the remaining text
      // gets drawn at that same x/y, visually overlapping the baked Image
      // (the "iç içe geçiyor" overlap reported by the user). Build a per-node
      // map of extracted offset intervals so we can carve them out below.
      let minX = Infinity, minY = Infinity, MathMaxX = -Infinity;
      const range = win.document.createRange();
      const extractedByNode = new Map();
      if (inlineExtractedRanges && inlineExtractedRanges.length) {
        for (const r of inlineExtractedRanges) {
          let arr = extractedByNode.get(r.node);
          if (!arr) { arr = []; extractedByNode.set(r.node, arr); }
          arr.push([r.start, r.end]);
        }
        for (const arr of extractedByNode.values()) arr.sort((a, b) => a[0] - b[0]);
      }
      const measureRectsForRange = (rects) => {
        if (!rects || rects.length === 0) return;
        // Use the FIRST non-zero rect — for left-aligned text that's the
        // leftmost-topmost glyph of the segment. Multi-line ranges have
        // multiple rects; we only contribute the topmost one's left to minX
        // and the leftmost one's top to minY, plus the widest right to maxX.
        for (const rc of rects) {
          if (rc.width < 0.5 || rc.height < 0.5) continue;
          if (rc.left < minX) minX = rc.left;
          if (rc.top < minY) minY = rc.top;
          if (rc.right > MathMaxX) MathMaxX = rc.right;
          break; // first non-empty rect is sufficient per call
        }
      };
      const findRectWalk = (n) => {
        if (n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0) {
          const exts = extractedByNode.get(n);
          if (!exts || exts.length === 0) {
            // Skip leading whitespace so the measured left edge sits on the
            // first real glyph. Without this skip, a text node like " Home"
            // (a leading space sitting RIGHT AFTER a font-icon sibling such
            // as `<i class="fa fa-home"></i> Home`) measures from the
            // leading space — which visually starts at the icon's right
            // edge, so the resulting TextBlock gets placed on top of the
            // baked icon Image. Selecting from the first non-whitespace
            // character moves the TextBlock past the icon. This mirrors the
            // gap-walking branch below which already does the same skip.
            const len = n.textContent.length;
            let realStart = 0;
            while (realStart < len && /\s/.test(n.textContent[realStart])) realStart++;
            if (realStart < len) {
              try {
                range.setStart(n, realStart);
                range.setEnd(n, len);
                measureRectsForRange(range.getClientRects());
              } catch {
                range.selectNodeContents(n);
                measureRectsForRange(range.getClientRects());
              }
            }
          } else {
            // Walk the gaps between extracted intervals. For each gap, also
            // skip leading whitespace so the measured left edge sits on the
            // first real glyph (otherwise " Savaş" measures from the leading
            // space, which sits exactly where the extracted "⚔" was).
            const len = n.textContent.length;
            let cursor = 0;
            for (let i = 0; i <= exts.length; i++) {
              const segStart = cursor;
              const segEnd   = (i < exts.length) ? exts[i][0] : len;
              if (segEnd > segStart) {
                const segText = n.textContent.slice(segStart, segEnd);
                if (segText.trim().length > 0) {
                  // Skip leading whitespace inside the gap
                  let realStart = segStart;
                  while (realStart < segEnd && /\s/.test(n.textContent[realStart])) realStart++;
                  if (realStart < segEnd) {
                    try {
                      range.setStart(n, realStart);
                      range.setEnd(n, segEnd);
                      measureRectsForRange(range.getClientRects());
                    } catch { /* node detached */ }
                  }
                }
              }
              if (i < exts.length) cursor = exts[i][1];
            }
          }
        } else if (n.nodeType === Node.ELEMENT_NODE) {
          const t = n.tagName.toLowerCase();
          const ncs = win.getComputedStyle(n);
          if (this.renderFontIcons && isRenderableFontIconElement(n, ncs, win)) return;
          if (t !== 'script' && Math.max(n.getBoundingClientRect().width, n.getBoundingClientRect().height) > 0) {
             Array.from(n.childNodes).forEach(findRectWalk);
          }
        }
      };
      
      // If we are skipping children, it means we merged all inline children into our direct text.
      // So we should measure bounds across all our children.
      // If not, we still measure bounds across all our children because directTxt combines floating text nodes.
      Array.from(el.childNodes).forEach(findRectWalk);

      // Text color resolution. CSS gradient-text patterns —
      //   `background: linear-gradient(...);
      //    -webkit-background-clip: text;
      //    -webkit-text-fill-color: transparent;`
      // — produce a `cs.color` of pure black + a transparent fill. UMG
      // can't render the gradient on glyphs, so without intervention the
      // export shows pitch-black text on top of the dark panel bg
      // (the user-reported "siyah simsiyah" regression). Pick a
      // representative stop from the gradient as the text color so the
      // label remains legible. We sample `parseGradientColor` (same
      // helper used for solid-fallback bg color) for a perceptually-
      // central stop. The original gradient is still serialized into
      // metadata in case the plugin wants to bake a glyph texture later.
      let color = parseColor(cs.color);
      const _textFill = cs.webkitTextFillColor || cs.textFillColor || '';
      const _isTransparentFill = /^(transparent|rgba?\(\s*0,\s*0,\s*0,\s*0\s*\))$/i.test(_textFill.trim());
      if (isTextGrad || _isTransparentFill) {
        const gradColor = parseGradientColor(cs.backgroundImage);
        if (gradColor && gradColor.a > 0.01) color = gradColor;
      }
      const fontSize = parseFloat(cs.fontSize) || 14;
      const fw = fontWeightName(cs.fontWeight);
      const padTop = parseFloat(cs.paddingTop) || 0;
      const padL = parseFloat(cs.paddingLeft) || 0;
      const rawLetterSpacing = parseFloat(cs.letterSpacing);
      const letterSpacing = !isNaN(rawLetterSpacing) && rawLetterSpacing !== 0 ? rawLetterSpacing : undefined;
      
      // For centered/right text, use the parent element's full width so Justification works.
      // For left-aligned text, use measured text bounds for tighter fit.
      // Use scroll-relative origin when inside a scroll context
      const _refTop = scrollContext ? scrollContext.rect.top : rootRect.top;
      const _refLeft = scrollContext ? scrollContext.rect.left : rootRect.left;
      const textY = minY !== Infinity ? minY - _refTop : ((hasBg || hasBorder || effectiveGradient) ? y + padTop : y);
      
      let finalX, finalW;
      if (cs.textAlign === 'center' || cs.textAlign === 'right' || cs.textAlign === '-webkit-center') {
        // Use the parent container's x and width so Justification=Center/Right works
        finalX = x;
        finalW = w;
      } else {
        // Left-aligned: use exact text bounds
        finalX = minX !== Infinity ? minX - _refLeft : x + padL;
        finalW = (MathMaxX !== -Infinity && minX !== Infinity) ? (MathMaxX - minX) : (w - padL);
      }

      // Apply CSS text-transform
      const tt = cs.textTransform;
      if (tt === 'uppercase') directTxt = directTxt.toUpperCase();
      else if (tt === 'lowercase') directTxt = directTxt.toLowerCase();
      else if (tt === 'capitalize') directTxt = directTxt.replace(/\b\w/g, c => c.toUpperCase());

      // directTxt may be empty here in two cases:
      //   1) Inline emoji extraction stripped every glyph above (line 3107)
      //      and only whitespace was left.
      //   2) `hasDistinctStyledInlineChildren` was true and we cleared
      //      directTxt to suppress this parent TextBlock so each styled
      //      span can emit its own TextBlock through traversal.
      // In either case, skip the empty push — `removeEmptyElementsAndUnusedTextures`
      // would filter it later anyway, but skipping here also avoids a
      // pointless minX/minY computation cost and keeps `_tagMeta()` from
      // tagging an element that won't exist.
      if (directTxt.length > 0) {
        this.elements.push({
          ueType:'TextBlock', name:this.uid('TextBlock'),
          x: finalX, y: textY, w: finalW, h: Math.max(fontSize * 1.5, h - padTop),
          text: directTxt, color, fontSize, fontWeight: fw, fontFamily: cs.fontFamily,
          textAlign: cs.textAlign, letterSpacing,
          autoSize: !(cs.textAlign === 'center' || cs.textAlign === 'right' || cs.textAlign === '-webkit-center')
        });
        _tagMeta();
      }
    }

    // Overlay any extracted inline emoji Image widgets on top of the TextBlock
    // (or on their own, if the text became empty after stripping). Positioned
    // at the exact Range-measured glyph rect so they land where the browser
    // originally drew the emoji.
    //
    // Z-order / context inheritance: each Image must inherit the parent's
    // zIndex + scrollRegionId so it sorts alongside the surrounding text and
    // doesn't fall back to the canvas-root z=0 layer (the "altda kalıp
    // görünmeyen ikonlar" the user reported). We deliberately DO NOT copy
    // renderAngle / renderScale / textShadow / boxShadow: those are CSS
    // transform-related fields that the browser ALREADY baked into the rect
    // returned by `range.getClientRects()`. Re-applying them as
    // RenderTransform on the widget would double-transform the glyph.
    if (inlineEmojiImages && inlineEmojiImages.length) {
      const inheritKeys = ['zIndex', 'scrollRegionId', 'tooltip'];
      for (const img of inlineEmojiImages) {
        for (const k of inheritKeys) if (_meta[k] !== undefined) img[k] = _meta[k];
        this.elements.push(img);
      }
    }

    // --- Icon elements (FontAwesome etc.) → texture ---
    if (isFontIcon && w > 4 && h > 4) {
      const iconColor = parseColor(cs.color) || {r:255,g:255,b:255,a:1};
      const cssFontSize = parseFloat(cs.fontSize);
      const iconChar = getRenderableIconCharacter(el, win);
      if (!iconChar) return;
      // Two flavors of "isFontIcon" reach here:
      //   • Real icon-font glyphs (FontAwesome PUA codepoints, Material Icons)
      //     — gated on the toggle because they need a Font Asset in UE.
      //   • Standalone emoji / pictograph elements (🛡️ ⚒️ 👤 …) — these are
      //     always baked, since UE's runtime fonts cannot render emoji
      //     codepoints regardless of what the user does on the engine side.
      const isEmojiGlyph = isStandaloneEmojiOrSymbolGlyph(iconChar);
      const shouldBake = this.renderFontIcons || isEmojiGlyph;
      if (shouldBake) {
        const _iconPath = this.renderFontIconTexture(el, cs, iconChar, iconColor, cssFontSize, w, h, win);
        this.elements.push({ ueType:'Image', name:this.uid('Image_Icon'), x, y, w, h, bgColor:null, borderRadius:br, gradientTexturePath:_iconPath });
      } else if (!directTxt) {
        this.elements.push({
          ueType:'TextBlock', name:this.uid('TextBlock_Icon'),
          x, y, w, h,
          text: iconChar,
          color: iconColor,
          fontSize: cssFontSize || Math.min(w, h),
          fontWeight: fontWeightName(cs.fontWeight),
          fontFamily: cs.fontFamily,
          textAlign: 'center',
          autoSize: true
        });
      }
      _tagMeta();
      return;
    }

    // --- Pseudo-element OVERLAYS (after text/icons) ---
    // Only absolutely-positioned pseudos with explicit z-index > 0 reach this
    // pass; everything else was already emitted as an underlay above.
    await this.handlePseudoGradient(el, cs, x, y, w, h, rootRect, win, '::before', _meta, 'after');
    await this.handlePseudoGradient(el, cs, x, y, w, h, rootRect, win, '::after',  _meta, 'after');

    // --- Recurse children ---
    if (!skipChildren) {
      // Detect scroll containers: overflow-y auto/scroll with content taller than container
      const oy = cs.overflowY;
      const isScrollable = (oy === 'auto' || oy === 'scroll') && el.scrollHeight > rect.height + 1;
      let childScrollCtx = scrollContext;
      if (isScrollable && !scrollContext) {
        const scrollId = this.uid('ScrollBox');
        childScrollCtx = { id: scrollId, rect: rect };
        this.scrollRegions.push({
          id: scrollId,
          x: rect.left - rootRect.left,
          y: rect.top - rootRect.top,
          w: rect.width,
          h: rect.height,
          contentH: el.scrollHeight,
          // Effective z-index for the scroll container itself. Same rule
          // as panels: own CSS z-index wins, otherwise inherit `zContext`.
          // Without this, a `<div class="content" style="z-index:5; overflow:auto">`
          // ends up at z=0 in the root sort and slides UNDER any
          // overlay/background sibling that happens to sit later in the
          // DOM, even though CSS would paint the scroll content above.
          zIndex: effectiveZ,
          // Stamp the panel context so the partition step can place the
          // scroll region as a child of its enclosing panel (rather than
          // hoisting it to root or to the root scroll). Without this, a
          // scrollable region inside a panel ended up as an empty
          // `UScrollBox` at root because all its children were stolen
          // into the panel by the panel-wins precedence in the partition.
          panelGroup: activePanelContext ? activePanelContext.id : null
        });
        // Stamp the scroll container's source DOM element so
        // `assignPanelGroupsByDom()` can detect "scroll ancestor encountered
        // before panel ancestor" and skip panel-group tagging. Without this,
        // a widget inside `.panel-body[overflow:auto]` inside `.panel
        // [data-ue-panel]` was tagged with BOTH `scrollRegionId` and
        // `panelGroup`; the panel-wins partition then routed it into the
        // panel with scroll-RELATIVE coordinates being treated as
        // panel-relative — visually shifting every dynamic node (skill-tree
        // case: `.tree-node[style.left=300px]` ended up at random offsets
        // relative to the panel canvas).
        if (!this._scrollContainerRegistry) this._scrollContainerRegistry = new Map();
        this._scrollContainerRegistry.set(el, scrollId);
      }
      for (const child of el.children) {
        // Reset z context when entering a new scroll region (scroll children have independent stacking)
        const childZ = childScrollCtx !== scrollContext ? undefined : effectiveZ;
        await this.traverse(child, rootRect, win, childScrollCtx, childZ, activePanelContext);
      }
    }

    if (isClickable && hasBlockChildren) {
      this.elements.push({
        ueType: 'Button', name: this.uid('BtnOverlay'),
        textBlockName: this.uid('Txt'),
        x, y, w, h, text: '', bgColor: {r:0,g:0,b:0,a:0}, textColor: {r:255,g:255,b:255,a:0},
        fontSize: 14, fontWeight: 'Regular', borderRadius: br,
        borderColor: null, borderWidth: 0,
        textHAlign: 'HAlign_Center', textVAlign: 'VAlign_Center',
        textPadLeft: 0, textPadRight: 0, gradientTexturePath: null
      });
      _tagMeta();
      // Force this click-catcher on top of every child in its subtree so it
      // actually receives pointer events instead of being buried under them.
      const overlayEl = this.elements[this.elements.length - 1];
      if (overlayEl) overlayEl.zIndex = 1000000;
    }
  }

  measurePseudoGlyphBox(text, pcs, win) {
    const fontSize = parseFloat(pcs.fontSize) || 12;
    let lineHeight = parseFloat(pcs.lineHeight);
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) lineHeight = fontSize * 1.2;
    const measureCanvas = win.document.createElement('canvas');
    const ctx = measureCanvas.getContext('2d');
    ctx.font = `${pcs.fontStyle || 'normal'} ${pcs.fontWeight || '400'} ${fontSize}px ${pcs.fontFamily || 'sans-serif'}`;
    const letterSpacing = parseFloat(pcs.letterSpacing) || 0;
    const glyphCount = Math.max(1, Array.from(text || '').length);
    const measured = ctx.measureText(text || '');
    const fallbackW = Math.ceil(measured.width + Math.max(0, glyphCount - 1) * letterSpacing);
    const cssW = parseFloat(pcs.width);
    const cssH = parseFloat(pcs.height);
    return {
      w: Math.max(1, Number.isFinite(cssW) && cssW > 0 ? cssW : fallbackW),
      h: Math.max(1, Number.isFinite(cssH) && cssH > 0 ? cssH : Math.ceil(lineHeight)),
      fontSize
    };
  }

  getDirectTextClientRect(el, win) {
    const range = win.document.createRange();
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        left = Math.min(left, rect.left);
        top = Math.min(top, rect.top);
        right = Math.max(right, rect.right);
        bottom = Math.max(bottom, rect.bottom);
      }
    }
    if (left === Infinity) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  getPseudoBoxPosition(el, pcs, cs, parentX, parentY, parentW, parentH, pw, ph, rootRect, win, pseudo) {
    let px = parentX;
    let py = parentY;
    const top = parseFloat(pcs.top);
    const bottom = parseFloat(pcs.bottom);
    const left = parseFloat(pcs.left);
    const right = parseFloat(pcs.right);
    const isPositioned = pcs.position === 'absolute' || pcs.position === 'fixed' ||
      Number.isFinite(top) || Number.isFinite(bottom) || Number.isFinite(left) || Number.isFinite(right);

    if (isPositioned) {
      if (Number.isFinite(top)) py = parentY + top;
      else if (Number.isFinite(bottom)) py = parentY + parentH - ph - bottom;
      if (Number.isFinite(left)) px = parentX + left;
      else if (Number.isFinite(right)) px = parentX + parentW - pw - right;
      return { x: px, y: py };
    }

    const textRect = this.getDirectTextClientRect(el, win);
    const rootLeft = rootRect ? rootRect.left : 0;
    const rootTop = rootRect ? rootRect.top : 0;
    const gap = parseFloat(cs.columnGap || cs.gap) || parseFloat(pcs.marginLeft) || parseFloat(pcs.marginRight) || 0;
    if (textRect) {
      const textX = textRect.left - rootLeft;
      const textY = textRect.top - rootTop;
      const textRight = textRect.right - rootLeft;
      px = pseudo === '::before' ? textX - gap - pw : textRight + gap;
      py = textY + (textRect.height - ph) / 2;
    } else {
      px = pseudo === '::before' ? parentX : parentX + parentW - pw;
      py = parentY + (parentH - ph) / 2;
    }
    return { x: px, y: py };
  }

  async handlePseudoGradient(el, cs, parentX, parentY, parentW, parentH, rootRect, win, pseudo, meta, phase) {
    try {
      const pcs = win.getComputedStyle(el, pseudo);
      if (!pcs || pcs.content === 'none' || pcs.content === 'normal') return;
      const pbg = pcs.backgroundImage || '';
      const pbgColor = parseColor(pcs.backgroundColor);
      const clipPath = pcs.clipPath || pcs.webkitClipPath || 'none';
      const pseudoText = cssContentToText(pcs.content);
      const hasTextIcon = pseudoText && this.renderFontIcons &&
        (isIconFontFamily(pcs.fontFamily) || isLikelyIconClassName(el.className) || isPseudoDecorativeGlyph(pseudoText));
      const hasVisibleFill = (pbg && pbg !== 'none') || (pbgColor && pbgColor.a > 0.01);
      // Border-only pseudos render decorative lines / underlines with patterns
      // like `.section::after { content:''; height:0; border-bottom:2px solid red; }`
      // or top-accent strokes. The fill check above misses these (no
      // background), so the pseudo would silently bail and the line never
      // appeared in UE. Detect any non-zero, non-transparent border edge
      // and route the pseudo through the bake path so the border itself
      // becomes the visible texture content.
      const _pBorderStyle = pcs.borderStyle || 'none';
      const _edgeWidths = [
        parseFloat(pcs.borderTopWidth) || 0,
        parseFloat(pcs.borderRightWidth) || 0,
        parseFloat(pcs.borderBottomWidth) || 0,
        parseFloat(pcs.borderLeftWidth) || 0
      ];
      const _hasBorderEdge = _edgeWidths.some(v => v > 0);
      const _pBorderColor = parseColor(pcs.borderColor);
      const hasVisibleBorder =
        _hasBorderEdge && _pBorderStyle !== 'none' &&
        _pBorderColor && _pBorderColor.a > 0.01;
      if (!hasVisibleFill && !hasTextIcon && !hasVisibleBorder) return;

      // Decide whether this pseudo should render BEHIND the element's own text
      // ("underlay", e.g. gradient-border pseudos with z-index:-1, or an inline
      // decorative ::before glyph that sits alongside text) or ON TOP of it
      // ("overlay", e.g. an absolutely positioned ::after shine stripe with
      // explicit z-index > 0). The caller invokes this method twice per
      // pseudo — once BEFORE pushing text/icons (phase='before', underlays
      // only) and once AFTER (phase='after', overlays only).
      if (phase === 'before' || phase === 'after') {
        const pPos = pcs.position;
        const pzRaw = parseInt(pcs.zIndex, 10);
        const pzIsNum = !Number.isNaN(pzRaw);
        // An "overlay" is an absolutely/fixed-positioned pseudo with an
        // explicit positive z-index. Everything else (inline flow pseudos,
        // absolute pseudos without z-index or with negative z-index) is
        // treated as an underlay so it stacks below the element's text.
        const isOverlayOnTop =
          (pPos === 'absolute' || pPos === 'fixed' || pPos === 'sticky') &&
          pzIsNum && pzRaw > 0;
        if (phase === 'before' && isOverlayOnTop) return;
        if (phase === 'after' && !isOverlayOnTop) return;
      }
      const glyphBox = hasTextIcon ? this.measurePseudoGlyphBox(pseudoText, pcs, win) : null;
      const ph = hasTextIcon ? glyphBox.h : (parseFloat(pcs.height) || 0);
      const pw = hasTextIcon ? glyphBox.w : (parseFloat(pcs.width) || parentW);
      if (ph < 1 || pw < 1) return;
      const pseudoRadius = Math.min(parseFloat(pcs.borderTopLeftRadius) || 0, pw / 2, ph / 2);

      const pos = this.getPseudoBoxPosition(el, pcs, cs, parentX, parentY, parentW, parentH, pw, ph, rootRect, win, pseudo);
      // Resolve CSS transform translate offset. `getPseudoBoxPosition` reads
      // only the CSS layout properties (left/top/right/bottom); a transform
      // like `translateX(-105%)` is NOT reflected there. The browser resolves
      // percentage-based translations to pixel values in the computed matrix
      // (stored as the `e`/`f` components). We extract them here so that
      // off-screen hover fills (the common `.btn::before { transform:
      // translateX(-105%) }` pattern) land at their correct rendered position
      // instead of covering the button at its CSS layout origin (0,0).
      const _pseudoTx = this._parseTransform(pcs.transform, pcs);
      let px = pos.x + (_pseudoTx && _pseudoTx.translateX ? _pseudoTx.translateX : 0);
      let py = pos.y + (_pseudoTx && _pseudoTx.translateY ? _pseudoTx.translateY : 0);

      if (hasTextIcon && !hasVisibleFill) {
        const iconColor = parseColor(pcs.color) || parseColor(cs.color) || {r:255,g:255,b:255,a:1};
        const _glyphPath = this.renderFontIconTexture(el, pcs, pseudoText, iconColor, glyphBox.fontSize, pw, ph, win);
        const pushedGlyph = {
          ueType: 'Image', name: this.uid('Image_Pseudo'),
          x: px, y: py, w: pw, h: ph,
          bgColor: null, borderRadius: 0, gradientTexturePath: _glyphPath,
          opacity: (() => {
            const value = parseFloat(pcs.opacity);
            return Number.isFinite(value) && value < 1 ? value : undefined;
          })()
        };
        if (meta) Object.assign(pushedGlyph, meta);
        this.elements.push(pushedGlyph);
        return;
      }

      // Inherit the parent's clip-path when the pseudo fills the parent's box
      // exactly (the very common `position:absolute; inset:0` overlay pattern,
      // e.g. `.cta::before` shine layers). Without this, the pseudo bake stays
      // rectangular while the parent itself is clipped to a chamfered polygon
      // and the bake "spills" past the parent's silhouette in UE — visible as
      // square corners poking out of an otherwise-clipped button. We only
      // inherit when (a) the pseudo has no clip-path of its own AND (b) the
      // pseudo's bounding box matches the parent's content box (so the parent
      // polygon coordinates apply 1:1 to the pseudo's own coordinate frame).
      const parentClipPathRaw = cs.clipPath || cs.webkitClipPath || 'none';
      const pseudoFillsParent =
        Math.abs(px - parentX) < 0.5 && Math.abs(py - parentY) < 0.5 &&
        Math.abs(pw - parentW) < 0.5 && Math.abs(ph - parentH) < 0.5;
      const effectiveClipPath = (clipPath && clipPath !== 'none')
        ? clipPath
        : (pseudoFillsParent && parentClipPathRaw && parentClipPathRaw !== 'none'
            ? parentClipPathRaw
            : clipPath);
      // Render pseudo fills as baked textures so clip-path / custom shapes survive UE export.
      const _pKey = [
        pcs.backgroundImage,
        pcs.backgroundColor,
        pcs.backgroundSize,
        pcs.backgroundPosition,
        pcs.backgroundRepeat,
        pcs.backgroundOrigin,
        pcs.backgroundClip,
        effectiveClipPath,
        Math.round(pseudoRadius * 100) / 100,
        Math.round(pw) + 'x' + Math.round(ph)
      ].join('|');
      let _pPath = this._texCache ? this._texCache.get(_pKey) : null;
      if (!_pPath) {
        const texName = `T_PseudoBorder_${SESSION_ID}_${this.uid('pseudo')}`;
        const dataUrl = await renderStyledLayerTexture({
          backgroundImage: pcs.backgroundImage,
          backgroundColor: pcs.backgroundColor,
          backgroundSize: pcs.backgroundSize,
          backgroundPosition: pcs.backgroundPosition,
          backgroundRepeat: pcs.backgroundRepeat,
          backgroundOrigin: pcs.backgroundOrigin,
          backgroundClip: pcs.backgroundClip,
          clipPath: effectiveClipPath
        }, pw, ph, pseudoRadius);
        if (!dataUrl) return;
        _pPath = `/Game/UI/Textures/${texName}`;
        this.textures.push({
          url: dataUrl,
          name: texName + '.png',
          suggestedPath: _pPath,
          isGradient: hasGradient(pbg)
        });
        if (this._texCache) this._texCache.set(_pKey, _pPath);
      }
      const pushed = {
        ueType: 'Image', name: this.uid('Image_Pseudo'),
        x: px, y: py, w: pw, h: ph,
        bgColor: null, borderRadius: 0, gradientTexturePath: _pPath,
        opacity: (() => {
          const value = parseFloat(pcs.opacity);
          return Number.isFinite(value) && value < 1 ? value : undefined;
        })()
      };
      // Inherit parent metadata first (tooltip, panelGroup, scrollRegionId,
      // zIndex etc.) — but the pseudo has its OWN transform that must
      // override the parent's renderAngle/renderScale. The user reported
      // `.panel-frame::before { rotate: 45deg }` rendering un-rotated
      // because the parent's `_meta` (no transform) was overwriting the
      // pseudo's tilt with `undefined`. Read the pseudo's own
      // transform / individual rotate / scale and stamp directly.
      if (meta) Object.assign(pushed, meta);
      // _pseudoTx was already computed above (used for translate-offset of px/py).
      if (_pseudoTx) {
        if (_pseudoTx.angle) pushed.renderAngle = _pseudoTx.angle;
        else delete pushed.renderAngle;
        if (_pseudoTx.scaleX !== 1 || _pseudoTx.scaleY !== 1) {
          pushed.renderScale = { x: _pseudoTx.scaleX, y: _pseudoTx.scaleY };
        } else {
          delete pushed.renderScale;
        }
      } else {
        // Pseudo has identity transform — drop the parent's transform so
        // the pseudo doesn't inherit a rotation it doesn't actually have.
        delete pushed.renderAngle;
        delete pushed.renderScale;
      }
      this.elements.push(pushed);
    } catch (e) { /* pseudo not supported or not available */ }
  }

  async addButton(el, cs, x, y, w, h, br, win, rootRect, hasBorder, borderW, options = {}) {
    // Treat the button's text identically to normal text (visual wrap preserving)
    const btnWin = win || el.ownerDocument.defaultView;
    // For "rich content" buttons (flex/grid CTAs whose visible label is built
    // from multiple distinctly-styled inline children, e.g.
    // `<a class="cta"><strong>Deploy Now</strong><span>// 01</span></a>`),
    // the caller asks us to skip text emission entirely. The Button widget
    // becomes a click-receiver shell with no inner TextBlock; the children
    // get emitted as their own absolutely-positioned TextBlocks afterwards
    // so each one keeps its own font/color/weight and sits at the visually
    // correct position dictated by flex layout.
    let text = options.skipText ? '' : this.getVisuallyWrappedText(el, btnWin, cs);
    // Normalize HTML-source whitespace runs
    if (text && !cs.whiteSpace.startsWith('pre')) {
      text = text.split('\n').map(l => l.replace(/[ \t]{2,}/g, ' ').trim()).join('\n').trim();
    }
    // Apply CSS text-transform
    const tt = cs.textTransform;
    if (tt === 'uppercase') text = text.toUpperCase();
    else if (tt === 'lowercase') text = text.toLowerCase();
    else if (tt === 'capitalize') text = text.replace(/\b\w/g, c => c.toUpperCase());
    if (this.renderFontIcons && isRenderableFontIconElement(el, cs, btnWin)) {
      text = '';
    }

    // Inline emoji extraction inside the button's own text. Same rationale
    // as the regular-text path: pictograph emoji codepoints (`⚒️ 🛡️ 🗡️ 👤 🎒
    // 🌳 🗺️ ⚜️` etc.) are not present in any of UE's runtime fonts, so
    // leaving them in `button.text` would render as tofu boxes inside the
    // button. Extract each match into its own Image_Icon at the
    // Range-measured pixel rect, strip the matched glyphs from `text`, and
    // attach the Images to the button via `_pendingButtonInlineIcons` so the
    // post-push tagging at the call site can stamp z-index / scrollRegionId
    // / tooltip metadata onto them. We only do this when the toggle is on
    // OR — for emoji clusters specifically — always, since UE can't render
    // emoji codepoints regardless of the toggle's state.
    let _inlineButtonEmojiImages = null;
    if (text && !options.skipText && textContainsInlineBakeableGlyph(text)) {
      const extraction = this.extractAndBakeInlineEmojis(el, cs, btnWin, rootRect, null);
      if (extraction.images && extraction.images.length) {
        _inlineButtonEmojiImages = extraction.images;
        text = stripInlineBakeableGlyphs(text)
          .replace(/[ \t]+/g, ' ')
          .replace(/ ?\n ?/g, '\n')
          .trim();
      }
    }
    
    let bgColor = parseColor(cs.backgroundColor);
    if (!bgColor || bgColor.a < 0.01) bgColor = parseGradientColor(cs.backgroundImage);
    let gradientTexturePath = null;
    let buttonBorderRadius = br;
    const bgImgUrl = extractSingleCssUrl(cs.backgroundImage);
    const clipPath = cs.clipPath || cs.webkitClipPath || 'none';
    const hasClipPath = !!(clipPath && clipPath !== 'none');
    const useEngineRoundedGradient = !hasClipPath && hasGradient(cs.backgroundImage) && br > 0;
    if (hasClipPath && (cs.backgroundImage !== 'none' || (bgColor && bgColor.a > 0.01) || hasBorder)) {
      const _btnClipKey = [
        'btnclip',
        cs.backgroundImage,
        cs.backgroundColor,
        cs.backgroundSize,
        cs.backgroundPosition,
        cs.backgroundRepeat,
        cs.backgroundOrigin,
        cs.backgroundClip,
        cs.borderColor,
        cs.borderWidth,
        cs.borderStyle,
        clipPath,
        Math.round(w) + 'x' + Math.round(h),
        Math.round(br)
      ].join('|');
      gradientTexturePath = this._texCache ? this._texCache.get(_btnClipKey) : null;
      if (!gradientTexturePath) {
        const dataUrl = await renderStyledLayerTexture({
          backgroundImage: cs.backgroundImage,
          backgroundColor: cs.backgroundColor,
          backgroundSize: cs.backgroundSize,
          backgroundPosition: cs.backgroundPosition,
          backgroundRepeat: cs.backgroundRepeat,
          backgroundOrigin: cs.backgroundOrigin,
          backgroundClip: cs.backgroundClip,
          borderColor: cs.borderColor,
          borderWidth: cs.borderWidth,
          borderStyle: cs.borderStyle,
          clipPath
        }, w, h, br);
        if (dataUrl) {
          const texName = `T_ButtonClip_${SESSION_ID}_${this.uid('clip')}`;
          gradientTexturePath = `/Game/UI/Textures/${texName}`;
          this.textures.push({ url:dataUrl, name:texName+'.png', suggestedPath:gradientTexturePath, isGradient:hasGradient(cs.backgroundImage), cssFilter: cs.filter });
          if (this._texCache) this._texCache.set(_btnClipKey, gradientTexturePath);
          bgColor = { r: 255, g: 255, b: 255, a: 1 };
          buttonBorderRadius = 0;
        }
      }
      if (gradientTexturePath) {
        bgColor = { r: 255, g: 255, b: 255, a: 1 };
        buttonBorderRadius = 0;
      }
    } else if (bgImgUrl) {
      gradientTexturePath = this._texCache ? this._texCache.get(bgImgUrl) : null;
      if (!gradientTexturePath) {
        const texName = `T_ButtonBg_${SESSION_ID}_${this.uid('bgimg')}`;
        gradientTexturePath = `/Game/UI/Textures/${texName}`;
        const _bakedUrl = await maybeRasterizeSvgUrl(bgImgUrl, w, h);
        this.textures.push({ url:_bakedUrl, name:texName+'.png', suggestedPath:gradientTexturePath, isExternalUrl:/^https?:\/\//.test(bgImgUrl), externalSrc:bgImgUrl, cssFilter: cs.filter });
        if (this._texCache) this._texCache.set(bgImgUrl, gradientTexturePath);
      }
      bgColor = { r: 255, g: 255, b: 255, a: 1 };
    } else if (hasGradient(cs.backgroundImage)) {
      const _btnGKey = cs.backgroundImage + '|' + Math.round(w) + 'x' + Math.round(h) + '|' + Math.round(br);
      gradientTexturePath = this._texCache ? this._texCache.get(_btnGKey) : null;
      if (!gradientTexturePath) {
        const texName = `T_Gradient_${SESSION_ID}_${this.uid('grad')}`;
        const dataUrl = await renderGradientTexture(cs.backgroundImage, w, h, br, {
          backgroundImage: cs.backgroundImage,
          backgroundColor: cs.backgroundColor,
          backgroundSize: cs.backgroundSize,
          backgroundPosition: cs.backgroundPosition,
          backgroundRepeat: cs.backgroundRepeat,
          backgroundOrigin: cs.backgroundOrigin,
          backgroundClip: cs.backgroundClip
        }, { clipRoundedCorners: !useEngineRoundedGradient });
        gradientTexturePath = `/Game/UI/Textures/${texName}`;
        this.textures.push({ url:dataUrl, name:texName+'.png', suggestedPath:gradientTexturePath, isGradient:true, cssFilter: cs.filter });
        if (this._texCache) this._texCache.set(_btnGKey, gradientTexturePath);
      }
    }
    if (!bgColor) bgColor = { r: 0, g: 0, b: 0, a: 0 }; // Keep transparent if not set
    const textColor = parseColor(cs.color) || { r: 255, g: 255, b: 255, a: 1 };
    const fontSize = parseFloat(cs.fontSize) || 14;
    const fw = fontWeightName(cs.fontWeight);

    // Calculate text offset within button using DOM Rect
    // This avoids icon-text overlap when HAlign_Center forces text to center
    let textPadLeft = 0;
    let textPadRight = 0;
    let btnTextHAlign = 'HAlign_Center';
    const btnRect = el.getBoundingClientRect();
    // Find first text node's position relative to button
    const textNodes = [];
      const walkText = (n) => {
      if (n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0) textNodes.push(n);
      else if (n.nodeType === Node.ELEMENT_NODE) {
        const ccs = btnWin.getComputedStyle(n);
        if (!isRenderableFontIconElement(n, ccs, btnWin)) {
          Array.from(n.childNodes).forEach(walkText);
        }
      }
    };
    Array.from(el.childNodes).forEach(walkText);
    if (textNodes.length > 0) {
      const range = btnWin.document.createRange();
      // Skip leading whitespace before measuring — when the button has a
      // font-icon sibling at the start (`<button><i class="fa fa-home"></i>
      // Home</button>`), the first text node is " Home". Selecting the
      // whole node (including the space) returns a rect whose left edge
      // sits AT the icon's right edge, so the inner TextBlock ends up on
      // top of the baked icon Image. Starting the range at the first
      // non-whitespace char shifts the TextBlock past the icon.
      const firstText = textNodes[0];
      const ftLen = firstText.textContent.length;
      let realStart = 0;
      while (realStart < ftLen && /\s/.test(firstText.textContent[realStart])) realStart++;
      if (realStart >= ftLen) realStart = 0;
      try {
        range.setStart(firstText, realStart);
        range.setEnd(firstText, ftLen);
      } catch {
        range.selectNodeContents(firstText);
      }
      const textRect = range.getBoundingClientRect();
      const offsetLeft = textRect.left - btnRect.left;
      const offsetRight = btnRect.right - textRect.right;
      // If text is NOT roughly centered (icon pushing it), use left-aligned padding
      const centerThreshold = w * 0.1;
      if (Math.abs(offsetLeft - offsetRight) > centerThreshold) {
        textPadLeft = Math.max(0, offsetLeft);
        textPadRight = Math.max(0, offsetRight);
        btnTextHAlign = 'HAlign_Left';
      }
    }

    this.elements.push({
      ueType: 'Button', name: this.uid('Button'),
      textBlockName: this.uid('TextBlock_Button'),
      x, y, w, h, text, bgColor, textColor, gradientTexturePath,
      fontSize, fontWeight: fw, fontFamily: cs.fontFamily, borderRadius: buttonBorderRadius,
      engineRoundedCorners: useEngineRoundedGradient,
      customShape: hasClipPath,
      borderColor: (hasBorder && !hasClipPath) ? parseColor(cs.borderColor) : null,
      borderWidth: hasClipPath ? 0 : borderW,
      textHAlign: btnTextHAlign, textVAlign: 'VAlign_Center',
      textPadLeft, textPadRight,
      // `toggleTarget` (when present) names a `data-ue-panel` whose
      // visibility this button is meant to toggle. The exporter prints a
      // hint comment above the button's T3D block; the actual OnClicked
      // → SetVisibility wiring still has to be done in Blueprint Graph
      // (T3D delegate bindings don't survive clipboard paste).
      toggleTarget: options.toggleTarget || undefined,
      // Rich-content / click-shell marker. When `skipText=true`, the Button
      // is a TRANSPARENT click receiver: the visible content (icon spans,
      // labels, count badges) is emitted by traverse() recursion as
      // sibling widgets, and the Button itself often has no visual of
      // its own (no bg, no border, no radius). Without this flag,
      // `removeEmptyElementsAndUnusedTextures` would treat the shell as
      // empty and filter it out, silently dropping the click target —
      // exactly the "nav-tab.active is detected, the inactive ones aren't"
      // bug, where only the active tab had a colored bg keeping it alive.
      _isClickShell: !!options.skipText
    });

    // Emit any inline emoji Image_Icon widgets that were extracted from the
    // button's own text (e.g. "⚒️ Forge Excalion" → an Image_Icon for ⚒️
    // plus a button with text "Forge Excalion"). They sit at their original
    // Range-measured pixel rect so they render in the correct spot inside
    // the button's bounds.
    if (_inlineButtonEmojiImages && _inlineButtonEmojiImages.length) {
      for (const img of _inlineButtonEmojiImages) this.elements.push(img);
    }

    // If button contains font icons, render them as separate textures
    const iconEls = [el, ...Array.from(el.querySelectorAll('*'))];
    for (const iconEl of iconEls) {
      const iconCs = btnWin.getComputedStyle(iconEl);
      if (!isRenderableFontIconElement(iconEl, iconCs, btnWin)) continue;
      const iconRect = iconEl.getBoundingClientRect();
      if (iconRect.width < 2 || iconRect.height < 2) continue;
      const btnRootRect = rootRect || { left: 0, top: 0 };
      const ix = iconRect.left - btnRootRect.left;
      const iy = iconRect.top - btnRootRect.top;
      const iw = iconRect.width, ih = iconRect.height;
      const iconColor = parseColor(iconCs.color) || {r:255,g:255,b:255,a:1};
      const cssFontSize = parseFloat(iconCs.fontSize);
      const iconChar = getRenderableIconCharacter(iconEl, btnWin);
      if (iconChar) {
        // Same emoji-vs-icon-font split as the standalone path: emoji
        // glyphs always bake (UE can't render them otherwise), icon-font
        // glyphs only bake when the toggle is on.
        const isEmojiGlyph = isStandaloneEmojiOrSymbolGlyph(iconChar);
        const shouldBake = this.renderFontIcons || isEmojiGlyph;
        if (shouldBake) {
          const _biPath = this.renderFontIconTexture(iconEl, iconCs, iconChar, iconColor, cssFontSize, iw, ih, btnWin);
          this.elements.push({ ueType:'Image', name:this.uid('Image_Icon'), x:ix, y:iy, w:iw, h:ih, bgColor:null, borderRadius:0, gradientTexturePath:_biPath });
        } else {
          this.elements.push({
            ueType:'TextBlock', name:this.uid('TextBlock_Icon'),
            x: ix, y: iy, w: iw, h: ih,
            text: iconChar,
            color: iconColor,
            fontSize: cssFontSize || Math.min(iw, ih),
            fontWeight: fontWeightName(iconCs.fontWeight),
            fontFamily: iconCs.fontFamily,
            textAlign: 'center',
            autoSize: true
          });
        }
      }
    }
  }

  addInput(el, cs, x, y, w, h, br) {
    let bgColor = parseColor(cs.backgroundColor);
    if (!bgColor || bgColor.a < 0.01) bgColor = parseGradientColor(cs.backgroundImage);
    if (!bgColor) bgColor = { r: 30, g: 30, b: 30, a: 1 };
    const textColor = parseColor(cs.color) || { r: 255, g: 255, b: 255, a: 1 };
    const fontSize = parseFloat(cs.fontSize) || 14;
    const placeholder = el.placeholder || el.getAttribute('placeholder') || '';
    const isPassword = el.type === 'password';
    this.elements.push({
      ueType: 'EditableTextBox', name: this.uid('EditableTextBox'),
      x, y, w, h, bgColor, textColor, fontSize, borderRadius: br, placeholder, isPassword
    });
  }

  addComboBox(el, cs, x, y, w, h, br) {
    const options = Array.from(el.querySelectorAll('option')).map(o => o.textContent.trim());
    const selected = el.value ? el.options[el.selectedIndex]?.textContent.trim() : (options[0] || '');
    let bgColor = parseColor(cs.backgroundColor);
    if (!bgColor || bgColor.a < 0.01) bgColor = parseGradientColor(cs.backgroundImage);
    if (!bgColor) bgColor = { r: 30, g: 30, b: 30, a: 1 };
    const textColor = parseColor(cs.color) || { r: 255, g: 255, b: 255, a: 1 };
    const borderColor = parseColor(cs.borderColor);
    const borderW = parseFloat(cs.borderWidth) || 0;
    const hasBorder = borderW > 0 && borderColor && borderColor.a > 0.01;
    const fontSize = parseFloat(cs.fontSize) || 14;
    this.elements.push({
      ueType: 'ComboBoxString', name: this.uid('ComboBox'),
      x, y, w, h, options, borderRadius: br,
      bgColor, textColor, fontSize,
      borderColor: hasBorder ? borderColor : null,
      borderWidth: borderW,
      selectedOption: selected
    });
  }

  addSlider(el, cs, x, y, w, h, br) {
    const min = parseFloat(el.min) || 0;
    const max = parseFloat(el.max) || 100;
    const value = parseFloat(el.value) || 0;
    const step = parseFloat(el.step) || 1;
    const normalized = max > min ? (value - min) / (max - min) : 0;
    const stepNormalized = max > min ? step / (max - min) : 0.01;
    // Bar color resolution mirrors the rest of the bg-color readers:
    // try `background-color` first, then fall back to a representative
    // stop from a CSS gradient. Authors style ranged inputs via
    // `background: linear-gradient(...)` (the standard CSS-only way to
    // draw the filled-vs-empty track since `appearance:none` strips the
    // native widget). Without the gradient fallback the bar collapsed
    // to the placeholder gray and the user's `#5A7A30` track was lost.
    let barColor = parseColor(cs.backgroundColor);
    if (!barColor || barColor.a < 0.01) barColor = parseGradientColor(cs.backgroundImage);
    if (!barColor || barColor.a < 0.01) barColor = { r: 80, g: 80, b: 80, a: 1 };
    // The "fill" color (the portion to the left of the thumb) is
    // typically the FIRST gradient stop of the bar background — for
    // `linear-gradient(90deg, #5A7A30 60%, rgba(80,60,20,0.4) 60%)` the
    // visual fill is `#5A7A30`. `parseGradientColor` returns the first
    // visible stop, so we reuse it; if no gradient, fall back to
    // `cs.color` (the engine's accent / foreground hint).
    let fillColor = parseGradientColor(cs.backgroundImage);
    if (!fillColor || fillColor.a < 0.01) fillColor = parseColor(cs.color);
    if (!fillColor || fillColor.a < 0.01) fillColor = { r: 50, g: 120, b: 220, a: 1 };
    // Thumb styling — read the `::-webkit-slider-thumb` pseudo-element
    // (and the Firefox `::-moz-range-thumb` as a fallback) so authors
    // who style the thumb via `background: var(--gold); border: 2px
    // solid #2A1608; rotate: 45deg;` get those properties carried into
    // UMG. Default thumbColor remains opaque white when no pseudo is
    // styled, preserving the previous behavior.
    let thumbColor = { r: 255, g: 255, b: 255, a: 1 };
    let thumbBorderColor = null;
    let thumbBorderWidth = 0;
    let thumbAngle = 0;
    let thumbRadius = 0;
    let thumbW = 0, thumbH = 0;
    const win = el.ownerDocument && el.ownerDocument.defaultView;
    const _readThumbPseudo = (pseudoName) => {
      try {
        const tcs = win.getComputedStyle(el, pseudoName);
        if (!tcs) return false;
        // Pseudo not actually rendered when `width`/`height` come back as
        // `auto` / 0; treat that as "no styled thumb" so we don't overwrite
        // sane defaults with garbage.
        const tw = parseFloat(tcs.width);
        const th = parseFloat(tcs.height);
        if (!Number.isFinite(tw) || tw <= 0 || !Number.isFinite(th) || th <= 0) return false;
        const tBg = parseColor(tcs.backgroundColor);
        if (tBg && tBg.a > 0.01) thumbColor = tBg;
        else {
          const grad = parseGradientColor(tcs.backgroundImage);
          if (grad && grad.a > 0.01) thumbColor = grad;
        }
        const tbw = parseFloat(tcs.borderWidth) || 0;
        if (tbw > 0 && tcs.borderStyle && tcs.borderStyle !== 'none') {
          const tbc = parseColor(tcs.borderColor);
          if (tbc && tbc.a > 0.01) {
            thumbBorderColor = tbc;
            thumbBorderWidth = tbw;
          }
        }
        const tx = this._parseTransform(tcs.transform, tcs);
        if (tx && tx.angle) thumbAngle = tx.angle;
        const tbr = parseFloat(tcs.borderRadius) || 0;
        if (tbr > 0) thumbRadius = tbr;
        thumbW = tw;
        thumbH = th;
        return true;
      } catch { return false; }
    };
    if (win) {
      _readThumbPseudo('::-webkit-slider-thumb') || _readThumbPseudo('::-moz-range-thumb');
    }
    this.elements.push({
      ueType: 'Slider', name: this.uid('Slider'),
      x, y, w, h, value: normalized, stepSize: stepNormalized,
      barColor, fillColor, thumbColor, borderRadius: br,
      // Optional thumb meta — consumers that don't know about these
      // fields ignore them. The T3D `genSlider` and JSON serializer
      // both stamp them onto `WidgetStyle.NormalThumbImage` when
      // present.
      thumbBorderColor: thumbBorderColor || undefined,
      thumbBorderWidth: thumbBorderWidth || undefined,
      thumbBorderRadius: thumbRadius || undefined,
      thumbAngle: thumbAngle || undefined,
      thumbW: thumbW || undefined,
      thumbH: thumbH || undefined
    });
  }

  addProgressBar(el, cs, x, y, w, h, br, tag) {
    let percent = 0;
    if (tag === 'progress') {
      const max = parseFloat(el.max) || 1;
      const val = parseFloat(el.value);
      percent = !isNaN(val) && max > 0 ? val / max : 0;
    } else { // meter
      const min = parseFloat(el.min) || 0;
      const max = parseFloat(el.max) || 1;
      const val = parseFloat(el.value) || 0;
      percent = max > min ? (val - min) / (max - min) : 0;
    }
    let bgColor = parseColor(cs.backgroundColor);
    if (!bgColor || bgColor.a < 0.01) bgColor = { r: 40, g: 40, b: 40, a: 1 };
    const fillColor = parseColor(cs.color) || { r: 50, g: 120, b: 220, a: 1 };
    this.elements.push({
      ueType: 'ProgressBar', name: this.uid('ProgressBar'),
      x, y, w, h, percent: Math.max(0, Math.min(1, percent)),
      bgColor, fillColor, borderRadius: br
    });
  }

  // Parse a CSS transform-like value plus the optional `style` object's
  // individual transform properties (`rotate`, `scale`) and combine them.
  // The individual properties (CSS Transforms Module Level 2) are computed
  // SEPARATELY from `cs.transform` — when an author writes `rotate: 45deg`
  // (the standalone property, not `transform: rotate(45deg)`), browsers
  // expose it on `cs.rotate` while `cs.transform` stays "none". The user
  // reported `.panel-frame::before { rotate: 45deg }` losing its 45° tilt
  // because we were ignoring the individual property entirely. Now we
  // also harvest `cs.rotate` / `cs.scale` and add them to whatever the
  // matrix/keyword form contributed (additive angle, multiplicative scale).
  _parseTransform(transformStr, style) {
    const fromMatrix = this._parseTransformMatrix(transformStr);
    return this._mergeIndividualTransforms(fromMatrix, style);
  }

  // Apply CSS Transforms Module L2 individual properties (`rotate`,
  // `scale`) on top of whatever `_parseTransformMatrix` produced from
  // the `transform` shorthand. Returns null when the combined result is
  // an identity (no rotation, unit scale).
  _mergeIndividualTransforms(result, style) {
    if (!style) return result;
    let extraAngle = 0;
    const rotateRaw = style.rotate;
    if (rotateRaw && rotateRaw !== 'none') {
      const trimmed = String(rotateRaw).trim();
      const num = parseFloat(trimmed);
      if (Number.isFinite(num)) {
        extraAngle = /rad\s*$/i.test(trimmed) ? num * (180 / Math.PI) : num;
      }
    }
    let extraSx = 1, extraSy = 1;
    const scaleRaw = style.scale;
    if (scaleRaw && scaleRaw !== 'none') {
      const parts = String(scaleRaw).trim().split(/\s+/);
      const sx = parseFloat(parts[0]);
      const sy = parts[1] !== undefined ? parseFloat(parts[1]) : sx;
      if (Number.isFinite(sx)) extraSx = sx;
      if (Number.isFinite(sy)) extraSy = sy;
    }
    const noExtra =
      Math.abs(extraAngle) < 0.01 &&
      Math.abs(extraSx - 1) < 0.001 &&
      Math.abs(extraSy - 1) < 0.001;
    if (noExtra) return result;
    const merged = result
      ? { angle: result.angle, scaleX: result.scaleX, scaleY: result.scaleY,
          translateX: result.translateX, translateY: result.translateY }
      : { angle: 0, scaleX: 1, scaleY: 1 };
    merged.angle = Math.round((merged.angle + extraAngle) * 100) / 100;
    merged.scaleX = Math.round(merged.scaleX * extraSx * 1000000) / 1000000;
    merged.scaleY = Math.round(merged.scaleY * extraSy * 1000000) / 1000000;
    if (Math.abs(merged.angle) < 0.01) merged.angle = 0;
    if (Math.abs(merged.scaleX - 1) < 0.001) merged.scaleX = 1;
    if (Math.abs(merged.scaleY - 1) < 0.001) merged.scaleY = 1;
    const hasMergeTx = Math.abs(merged.translateX || 0) > 0.1 || Math.abs(merged.translateY || 0) > 0.1;
    if (merged.angle === 0 && merged.scaleX === 1 && merged.scaleY === 1 && !hasMergeTx) return null;
    return merged;
  }

  _parseTransformMatrix(transformStr) {
    if (!transformStr || transformStr === 'none') return null;
    let a, b, c, d, e = 0, f = 0;
    const m2 = transformStr.match(/matrix\(([^)]+)\)/);
    const m3 = transformStr.match(/matrix3d\(([^)]+)\)/);

    if (m3) {
      const vals = m3[1].split(',').map(v => Number(v.trim()));
      if (vals.length !== 16 || vals.some(v => Number.isNaN(v))) return null;
      a = vals[0]; b = vals[1]; c = vals[4]; d = vals[5]; e = vals[12]; f = vals[13];
    } else if (m2) {
      const vals = m2[1].split(',').map(v => Number(v.trim()));
      if (vals.length !== 6 || vals.some(v => Number.isNaN(v))) return null;
      [a, b, c, d, e, f] = vals;
    } else {
      let scaleX = 1, scaleY = 1, angle = 0;
      const scaleMatch = transformStr.match(/scale\(\s*([^,\s)]+)(?:\s*,\s*([^)]+))?\)/i);
      const scaleXMatch = transformStr.match(/scaleX\(\s*([^)]+)\)/i);
      const scaleYMatch = transformStr.match(/scaleY\(\s*([^)]+)\)/i);
      const rotateMatch = transformStr.match(/rotate\(\s*([^)]+)\)/i);
      if (scaleMatch) {
        scaleX = Number(scaleMatch[1]);
        scaleY = Number(scaleMatch[2] !== undefined ? scaleMatch[2] : scaleMatch[1]);
      }
      if (scaleXMatch) scaleX = Number(scaleXMatch[1]);
      if (scaleYMatch) scaleY = Number(scaleYMatch[1]);
      if (rotateMatch) {
        const raw = rotateMatch[1].trim();
        angle = raw.endsWith('rad') ? Number(raw.replace(/rad$/i, '')) * (180 / Math.PI) : Number(raw.replace(/deg$/i, ''));
      }
      if ([scaleX, scaleY, angle].some(v => Number.isNaN(v))) return null;
      const roundedAngle = Math.abs(angle) > 0.01 ? Math.round(angle * 100) / 100 : 0;
      const roundedScaleX = Math.abs(scaleX - 1) > 0.001 ? Math.round(scaleX * 1000000) / 1000000 : 1;
      const roundedScaleY = Math.abs(scaleY - 1) > 0.001 ? Math.round(scaleY * 1000000) / 1000000 : 1;
      if (roundedAngle === 0 && roundedScaleX === 1 && roundedScaleY === 1) return null;
      return { angle: roundedAngle, scaleX: roundedScaleX, scaleY: roundedScaleY };
    }

    const nearZero = (v) => Math.abs(v) < 0.000001;
    if (nearZero(b) && nearZero(c)) {
      const roundedScaleX = Math.abs(a - 1) > 0.001 ? Math.round(a * 1000000) / 1000000 : 1;
      const roundedScaleY = Math.abs(d - 1) > 0.001 ? Math.round(d * 1000000) / 1000000 : 1;
      // Also carry translate (e/f) — the browser resolves percentage-based
      // translateX/Y to absolute pixels in the matrix. Without extracting them
      // here, `getPseudoBoxPosition` returns the untransformed CSS position and
      // off-screen hover-fills (e.g. `translateX(-105%)`) land on top of buttons.
      const hasTx = Math.abs(e) > 0.1 || Math.abs(f) > 0.1;
      if (roundedScaleX === 1 && roundedScaleY === 1 && !hasTx) return null;
      return { angle: 0, scaleX: roundedScaleX, scaleY: roundedScaleY,
               translateX: e || undefined, translateY: f || undefined };
    }

    const scaleX = Math.hypot(a, b);
    let angleRad = 0;
    let scaleY = 0;
    if (scaleX > 0.000001) {
      angleRad = Math.atan2(b, a);
      scaleY = ((a * d) - (b * c)) / scaleX;
    } else {
      scaleY = Math.hypot(c, d);
      angleRad = Math.atan2(-c, d);
    }

    const angle = angleRad * (180 / Math.PI);
    const roundedAngle = Math.abs(angle) > 0.01 ? Math.round(angle * 100) / 100 : 0;
    const roundedScaleX = Math.abs(scaleX - 1) > 0.001 ? Math.round(scaleX * 1000000) / 1000000 : 1;
    const roundedScaleY = Math.abs(scaleY - 1) > 0.001 ? Math.round(scaleY * 1000000) / 1000000 : 1;

    const hasTxRot = Math.abs(e) > 0.1 || Math.abs(f) > 0.1;
    if (
      roundedAngle === 0 &&
      roundedScaleX === 1 &&
      roundedScaleY === 1 &&
      !hasTxRot
    ) return null;

    return {
      angle: roundedAngle,
      scaleX: roundedScaleX,
      scaleY: roundedScaleY,
      translateX: e || undefined,
      translateY: f || undefined
    };
  }

  // =============================================================
  // CSS @keyframes / animation extraction → JSON `animations[]`
  // =============================================================
  //
  // Parses every `@keyframes` rule found in any same-origin stylesheet of
  // the analyzed document into a Map<keyframesName, sortedKeyframeArray>
  // stashed on `this._keyframesIndex`. Then, during traversal, every
  // element whose computed `animation-name` references one of those
  // keyframes contributes an `animations[]` entry on its emitted widgets.
  //
  // Per-widget duplication is intentional: CSS lets ONE `@keyframes`
  // definition be applied to many elements via class/selector matching;
  // UMG has no equivalent — each `UWidgetAnimation` belongs to exactly
  // one Widget Blueprint instance and animates explicitly named tracks
  // on widgets it contains. So a CSS rule like `.btn { animation: pulse 2s }`
  // applied to 3 buttons becomes 3 separate `UWidgetAnimation` assets in
  // the imported Widget Blueprint.
  //
  // Triggers are NOT translated. The plugin should auto-play any animation
  // emitted here (CSS animations auto-start on layout) by hooking
  // `Construct` → `PlayAnimation(NumLoopsToPlay=iterations)`. Hover /
  // focus / active / class-toggle / JS-driven triggers are out of scope —
  // the user wires those manually in Blueprint.

  // Walks all stylesheets and collects keyframe definitions. Cross-origin
  // sheets throw on `cssRules` access; we swallow that and continue with
  // whatever sheets are readable. Nested rules (`@media`, `@supports`)
  // are recursed into so animations defined under media queries are
  // still picked up.
  _buildKeyframesIndex(doc) {
    const idx = new Map();
    // Honor the user's `Animations` toggle: when off, leave the index
    // empty so `_extractElementAnimations` short-circuits to null on
    // every element (it bails when `_keyframesIndex.size === 0`). This
    // also avoids the per-stylesheet `cssRules` walk on large docs when
    // the user doesn't want animation data.
    if (!this.renderAnimations) {
      this._keyframesIndex = idx;
      return idx;
    }
    if (!doc || !doc.styleSheets) {
      this._keyframesIndex = idx;
      return idx;
    }
    for (const sheet of doc.styleSheets) {
      let rules;
      try { rules = sheet.cssRules || sheet.rules; }
      catch (_e) { continue; /* cross-origin or unreadable */ }
      if (!rules) continue;
      this._collectKeyframesFromRules(rules, idx);
    }
    this._keyframesIndex = idx;
    return idx;
  }

  _collectKeyframesFromRules(rules, idx) {
    for (const r of rules) {
      // CSSRule.KEYFRAMES_RULE = 7. Use type number for cross-browser
      // safety since the constant on the rule may be undefined depending
      // on environment.
      if (r.type === 7 || (typeof CSSKeyframesRule !== 'undefined' && r instanceof CSSKeyframesRule)) {
        const name = r.name;
        if (!name) continue;
        const keyframes = [];
        for (const kr of r.cssRules) {
          if (!kr || !kr.style) continue;
          const offsets = this._parseKeyframeKeyText(kr.keyText);
          const props = this._snapshotKeyframeStyle(kr.style);
          if (!offsets.length) continue;
          for (const offset of offsets) {
            keyframes.push({ offset, properties: props });
          }
        }
        if (!keyframes.length) continue;
        keyframes.sort((a, b) => a.offset - b.offset);
        idx.set(name, keyframes);
      } else if (r.cssRules) {
        // Nested @media / @supports / @container etc.
        this._collectKeyframesFromRules(r.cssRules, idx);
      }
    }
  }

  // "0%" → [0], "from" → [0], "to" → [1], "50%, 75%" → [0.5, 0.75]
  _parseKeyframeKeyText(keyText) {
    if (!keyText) return [];
    return keyText.split(',').map(s => {
      const t = s.trim().toLowerCase();
      if (t === 'from') return 0;
      if (t === 'to') return 1;
      if (t.endsWith('%')) {
        const n = parseFloat(t);
        return isNaN(n) ? null : n / 100;
      }
      const n = parseFloat(t);
      return isNaN(n) ? null : n;
    }).filter(v => v !== null && v >= 0 && v <= 1);
  }

  // Captures only properties UMG can animate. Other CSS props in the
  // keyframe are ignored.
  _snapshotKeyframeStyle(style) {
    const props = {};
    const transform = style.getPropertyValue('transform');
    if (transform && transform !== 'none') props.transform = transform;
    const opacity = style.getPropertyValue('opacity');
    if (opacity !== '' && opacity !== undefined) {
      const n = parseFloat(opacity);
      if (!isNaN(n)) props.opacity = n;
    }
    const color = style.getPropertyValue('color');
    if (color) props.color = color;
    const bg = style.getPropertyValue('background-color');
    if (bg) props.backgroundColor = bg;
    const bgPos = style.getPropertyValue('background-position');
    if (bgPos) props.backgroundPosition = bgPos;
    return props;
  }

  // Splits a CSS comma-list while respecting nested parentheses (so
  // `cubic-bezier(0.4, 0.0, 0.2, 1), linear` splits into 2, not 5).
  _splitCssAnimationList(s) {
    if (!s) return [];
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) {
        out.push(s.slice(start, i).trim());
        start = i + 1;
      }
    }
    out.push(s.slice(start).trim());
    return out.filter(x => x.length > 0);
  }

  // "2s" → 2, "500ms" → 0.5, "0" → 0. Returns NaN-safe 0 default.
  _cssTimeToSeconds(s) {
    if (!s) return 0;
    const t = String(s).trim().toLowerCase();
    if (t.endsWith('ms')) {
      const n = parseFloat(t);
      return isNaN(n) ? 0 : n / 1000;
    }
    if (t.endsWith('s')) {
      const n = parseFloat(t);
      return isNaN(n) ? 0 : n;
    }
    const n = parseFloat(t);
    return isNaN(n) ? 0 : n;
  }

  // Maps a CSS timing-function value to a coarse UMG interpolation hint.
  // UMG's per-key interpolation is one of Linear / Cubic / Constant;
  // CSS's `cubic-bezier(...)` / `ease*` family don't have exact UMG
  // analogs so we approximate with `Cubic` (works well visually for
  // most pulse/glow/spin patterns). Step functions map to `Constant`.
  _cssTimingToInterp(s) {
    if (!s) return 'Cubic';
    const t = String(s).trim().toLowerCase();
    if (t === 'linear') return 'Linear';
    if (t.startsWith('step')) return 'Constant';
    // ease, ease-in, ease-out, ease-in-out, cubic-bezier(...) → Cubic
    return 'Cubic';
  }

  // Decomposes a CSS transform string to UMG-friendly TRS using the
  // browser's `DOMMatrix` API (handles all transform-function forms
  // including `matrix3d`, `scale`, `rotate`, `translate`, combinations,
  // even `perspective(...)` — projection components are dropped).
  _decomposeTransformForAnim(transformStr, win) {
    const ident = { tx: 0, ty: 0, scaleX: 1, scaleY: 1, angle: 0 };
    if (!transformStr || transformStr === 'none') return ident;
    try {
      const M = (win && win.DOMMatrix) || (typeof DOMMatrix !== 'undefined' ? DOMMatrix : null);
      if (!M) return ident;
      const m = new M(transformStr);
      const a = m.a, b = m.b, c = m.c, d = m.d;
      const tx = m.e || 0;
      const ty = m.f || 0;
      let scaleX = Math.hypot(a, b);
      let scaleY = Math.hypot(c, d);
      // Sign correction: a negative determinant means one axis is mirrored.
      // We attribute the flip to scaleY by convention (matches how CSS
      // `scale(-1, 1)` typically decomposes in browsers).
      const det = a * d - b * c;
      if (det < 0) scaleY = -scaleY;
      const angleRad = Math.atan2(b, a);
      const angle = angleRad * 180 / Math.PI;
      const r4 = (n) => Math.round(n * 10000) / 10000;
      const r6 = (n) => Math.round(n * 1000000) / 1000000;
      const r3 = (n) => Math.round(n * 1000) / 1000;
      return {
        tx: r4(tx),
        ty: r4(ty),
        scaleX: r6(scaleX),
        scaleY: r6(scaleY),
        angle: Math.abs(r3(angle)) < 0.01 ? 0 : r3(angle)
      };
    } catch (_e) {
      return ident;
    }
  }

  // Heuristic: does the element directly carry visible text content? Used
  // to pick between `ColorAndOpacity` (text-bearing → TextBlock) and
  // `BrushColor` (non-text → Image) for animated color tracks. Conservative:
  // requires text in a direct text node, not just descendants.
  _elementHasDirectText(el) {
    if (!el || !el.childNodes) return false;
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE && n.textContent && n.textContent.trim().length > 0) return true;
    }
    return false;
  }

  // Per-element animation extractor. Reads computed `animation-*` shorthand
  // properties (CSS already resolved comma-lists for us), looks each
  // animation name up in `_keyframesIndex`, and builds the final
  // `animations[]` array suitable for direct JSON emission.
  //
  // Returns `null` (not `[]`) when the element has no resolvable
  // animations so the caller can skip stamping the field entirely.
  _extractElementAnimations(el, win) {
    if (!this._keyframesIndex || this._keyframesIndex.size === 0) return null;
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    const cs = win.getComputedStyle(el);
    const namesStr = cs.animationName;
    if (!namesStr || namesStr === 'none' || namesStr === '') return null;
    const names = this._splitCssAnimationList(namesStr);
    if (!names.length) return null;
    const durations = this._splitCssAnimationList(cs.animationDuration || '0s');
    const delays = this._splitCssAnimationList(cs.animationDelay || '0s');
    const iters = this._splitCssAnimationList(cs.animationIterationCount || '1');
    const dirs = this._splitCssAnimationList(cs.animationDirection || 'normal');
    const timings = this._splitCssAnimationList(cs.animationTimingFunction || 'ease');
    const dirMap = {
      'normal': 'Normal',
      'reverse': 'Reverse',
      'alternate': 'Alternate',
      'alternate-reverse': 'AlternateReverse'
    };
    const out = [];
    const isText = this._elementHasDirectText(el);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (!name || name === 'none') continue;
      const keyframes = this._keyframesIndex.get(name);
      if (!keyframes || keyframes.length < 2) continue;
      const duration = this._cssTimeToSeconds(durations[i % durations.length] || '0s');
      if (duration <= 0) continue;
      const delay = this._cssTimeToSeconds(delays[i % delays.length] || '0s');
      const iterRaw = (iters[i % iters.length] || '1').trim().toLowerCase();
      const iterations = iterRaw === 'infinite' ? 0 : Math.max(1, Math.floor(parseFloat(iterRaw) || 1));
      const dirRaw = (dirs[i % dirs.length] || 'normal').trim().toLowerCase();
      const direction = dirMap[dirRaw] || 'Normal';
      const interp = this._cssTimingToInterp(timings[i % timings.length] || 'ease');
      const rect = (() => {
        try { return el.getBoundingClientRect(); }
        catch (_e) { return null; }
      })();
      const tracks = this._buildAnimTracksFromKeyframes(keyframes, duration, win, interp, isText, rect);
      if (!tracks.length) continue;
      const r4 = (n) => Math.round(n * 10000) / 10000;
      const entry = {
        name,
        duration: r4(duration),
        iterations,
        direction,
        autoPlay: true,
        tracks
      };
      if (delay > 0) entry.delay = r4(delay);
      out.push(entry);
    }
    return out.length ? out : null;
  }

  // Walks the keyframes for ONE @keyframes rule and pivots them by
  // animatable property into UMG track arrays. Tracks with fewer than
  // 2 keyframes after the pivot are dropped (UMG needs at least 2 to
  // interpolate).
  _parseBackgroundPositionForAnim(value, width = 0, height = 0) {
    if (!value) return null;
    const firstLayer = this._splitCssAnimationList(String(value))[0] || '';
    const tokens = splitCssPointCoords(firstLayer);
    if (!tokens.length) return null;
    const xToken = tokens[0];
    let yToken = tokens[1];
    if (!yToken) {
      const lower = String(xToken || '').trim().toLowerCase();
      yToken = (lower === 'top' || lower === 'bottom') ? lower : '50%';
    }
    const x = parseCssLengthToken(xToken, Math.max(0, width || 0), 0);
    const y = parseCssLengthToken(yToken, Math.max(0, height || 0), 0);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return {
      x: Math.round(x * 10000) / 10000,
      y: Math.round(y * 10000) / 10000
    };
  }

  _buildAnimTracksFromKeyframes(keyframes, duration, win, interp, isText, rect = null) {
    const r4 = (n) => Math.round(n * 10000) / 10000;
    const animW = rect && Number.isFinite(rect.width) ? rect.width : 0;
    const animH = rect && Number.isFinite(rect.height) ? rect.height : 0;
    const tracks = {
      'RenderTransform.Scale': null,
      'RenderTransform.Angle': null,
      'RenderTransform.Translation': null,
      'RenderOpacity': null,
      'ColorAndOpacity': null,
      'BrushColor': null,
      'BackgroundPosition': null
    };
    const ensure = (key, axisDefault) => {
      if (!tracks[key]) tracks[key] = { property: key, interp, keyframes: [] };
      return tracks[key];
    };
    for (const kf of keyframes) {
      const time = r4(kf.offset * duration);
      if (kf.properties.transform !== undefined) {
        const d = this._decomposeTransformForAnim(kf.properties.transform, win);
        ensure('RenderTransform.Scale').keyframes.push({ time, value: { x: d.scaleX, y: d.scaleY } });
        ensure('RenderTransform.Angle').keyframes.push({ time, value: d.angle });
        ensure('RenderTransform.Translation').keyframes.push({ time, value: { x: d.tx, y: d.ty } });
      }
      if (kf.properties.opacity !== undefined) {
        ensure('RenderOpacity').keyframes.push({ time, value: r4(kf.properties.opacity) });
      }
      if (isText && kf.properties.color) {
        const c = parseColor(kf.properties.color);
        if (c) ensure('ColorAndOpacity').keyframes.push({ time, value: serializeColorForJson(c) });
      }
      if (!isText && kf.properties.backgroundColor) {
        const c = parseColor(kf.properties.backgroundColor);
        if (c) ensure('BrushColor').keyframes.push({ time, value: serializeColorForJson(c) });
      }
      if (!isText && kf.properties.backgroundPosition) {
        const pos = this._parseBackgroundPositionForAnim(kf.properties.backgroundPosition, animW, animH);
        if (pos) ensure('BackgroundPosition').keyframes.push({ time, value: pos });
      }
    }
    // Detect "constant" tracks (all keyframes share the same value) and
    // drop them: a track that never changes is noise, and UMG's keyframe
    // optimizer would compact it to a single key anyway.
    const result = [];
    for (const key of Object.keys(tracks)) {
      const t = tracks[key];
      if (!t || t.keyframes.length < 2) continue;
      const allSame = this._animTrackIsConstant(t);
      if (allSame) continue;
      result.push(t);
    }
    return result;
  }

  _animTrackIsConstant(track) {
    if (!track || !track.keyframes || track.keyframes.length < 2) return true;
    const first = track.keyframes[0].value;
    for (let i = 1; i < track.keyframes.length; i++) {
      if (!this._animValueEquals(first, track.keyframes[i].value)) return false;
    }
    return true;
  }

  _animValueEquals(a, b) {
    if (a === b) return true;
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.0001;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (const k of ka) {
        if (!this._animValueEquals(a[k], b[k])) return false;
      }
      return true;
    }
    return false;
  }

  async addImgElement(el, cs, x, y, w, h, br, win) {
    // Use el.currentSrc (resolved by browser) if available, else el.src
    const src = el.currentSrc || el.src || el.getAttribute('src') || '';
    if (!src) return;
    const tName = `T_Img_${SESSION_ID}_${this.uid('img')}`;
    const suggestedPath = `/Game/UI/Textures/${tName}`;
    const clipPath = cs.clipPath || cs.webkitClipPath || 'none';
    let textureUrl = src;
    let outRadius = br;

    if (clipPath && clipPath !== 'none') {
      try {
        const img = await loadImageFromUrl(src);
        const canvas = (win?.document || document).createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(w));
        canvas.height = Math.max(1, Math.ceil(h));
        const ctx = canvas.getContext('2d');
        ctx.save();
        const clipped = applyClipPathMask(ctx, clipPath, canvas.width, canvas.height);
        if (!clipped) clipRoundedRect(ctx, 0, 0, canvas.width, canvas.height, br);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        ctx.restore();
        textureUrl = canvas.toDataURL('image/png');
        outRadius = 0;
      } catch {
        textureUrl = src;
      }
    }

    // Store URL as-is; updateTextures will convert blob/file/http to data URL.
    // SVG-source `<img>` (e.g. `<img src="data:image/svg+xml,...">` or
    // `<img src="icon.svg">`) is rasterized to PNG at the element's rect
    // size before being recorded — UE has no native SVG asset type, so
    // leaving raw SVG bytes inside a `.png` would produce an unimportable
    // texture asset on disk.
    if (!textureUrl.startsWith('data:image/png') && !textureUrl.startsWith('blob:')) {
      textureUrl = await maybeRasterizeSvgUrl(textureUrl, w, h);
    }
    this.textures.push({
      url: textureUrl,
      name: tName + '.png',
      suggestedPath,
      isExternalUrl: /^https?:\/\//.test(src),
      externalSrc: src,
      cssFilter: cs.filter
    });
    this.elements.push({
      ueType: 'Image', name: this.uid('Image_Img'),
      x, y, w, h, bgColor: null,
      borderRadius: outRadius, gradientTexturePath: suggestedPath
    });
  }

  async addSvgElement(el, cs, x, y, w, h, br, win) {
    const cacheKey = [
      'inline-svg',
      Math.round(w),
      Math.round(h),
      el.outerHTML
    ].join('|');
    let suggestedPath = this._texCache ? this._texCache.get(cacheKey) : null;

    if (!suggestedPath) {
      const tName = `T_Svg_${SESSION_ID}_${this.uid('svg')}`;
      suggestedPath = `/Game/UI/Textures/${tName}`;
      const dataUrl = await renderInlineSvgTexture(el, w, h, win);
      this.textures.push({
        url: dataUrl,
        name: tName + '.png',
        suggestedPath,
        cssFilter: cs.filter
      });
      if (this._texCache) this._texCache.set(cacheKey, suggestedPath);
    }

    this.elements.push({
      ueType: 'Image', name: this.uid('Image_Svg'),
      x, y, w, h, bgColor: null,
      borderRadius: br,
      gradientTexturePath: suggestedPath,
      opacity: (() => {
        const value = parseFloat(cs.opacity);
        return Number.isFinite(value) && value < 1 ? value : undefined;
      })()
    });
  }
}

// ==================== UE WIDGET GENERATOR ====================

class UEWidgetGenerator {
  constructor(data) {
    this.elements = data.elements;
    this.scrollRegions = data.scrollRegions || [];
    // Panel groups: each entry is `{ id, name, defaultOpen, x, y, w, h }`.
    // The exporter emits one `UMG.CanvasPanel` per panel, named `Panel_<n>`.
    // Children with `el.panelGroup === panel.id` are pulled out of the root
    // canvas and placed inside the panel container instead, with their
    // coordinates translated to be panel-relative (so the panel's
    // Visibility=Collapsed reliably hides exactly the panel's visual area).
    this.panelGroups = data.panelGroups || [];
    this.rootW = data.rootW;
    this.rootH = data.rootH;
    this.pageBgColor = data.pageBgColor || { r: 0, g: 0, b: 0, a: 1 };
    this.resW = data.resW || 1920;
    this.resH = data.resH || 1080;
    this.overlayName = 'Overlay_Root';
    this.bgImageName = 'Image_Background';
    this.canvasName = 'CanvasPanel_Root';
    this.I = '   '; // 3-space indent matching UE format
  }

  generate() {
    const L = [];
    const I = this.I;
    const I2 = I + I;

    // Pre-compute root scroll so Overlay wiring can reference it before partitioning
    const _rootScrollEarly = this.scrollRegions.find(sr => sr.isRootScroll);
    const _slot1Class = _rootScrollEarly ? 'UMG.ScrollBox' : 'UMG.CanvasPanel';
    const _slot1Name = _rootScrollEarly ? _rootScrollEarly.id : this.canvasName;

    // === 1. Overlay root (Background Image + CanvasPanel or RootScrollBox) ===
    L.push(`Begin Object Class=/Script/UMG.Overlay Name="${this.overlayName}"`);
    L.push(`${I}Begin Object Class=/Script/UMG.OverlaySlot Name="OverlaySlot_0"`);
    L.push(`${I}End Object`);
    L.push(`${I}Begin Object Class=/Script/UMG.OverlaySlot Name="OverlaySlot_1"`);
    L.push(`${I}End Object`);
    // Slot 0: Background Image
    L.push(`${I}Begin Object Name="OverlaySlot_0"`);
    L.push(`${I2}HorizontalAlignment=HAlign_Fill`);
    L.push(`${I2}VerticalAlignment=VAlign_Fill`);
    L.push(`${I2}Parent=/Script/UMG.Overlay'"${this.overlayName}"'`);
    L.push(`${I2}Content=/Script/UMG.Image'"${this.bgImageName}"'`);
    L.push(`${I}End Object`);
    // Slot 1: CanvasPanel (or RootScrollBox when page overflows viewport)
    L.push(`${I}Begin Object Name="OverlaySlot_1"`);
    L.push(`${I2}HorizontalAlignment=HAlign_Fill`);
    L.push(`${I2}VerticalAlignment=VAlign_Fill`);
    L.push(`${I2}Parent=/Script/UMG.Overlay'"${this.overlayName}"'`);
    L.push(`${I2}Content=/Script/${_slot1Class}'"${_slot1Name}"'`);
    L.push(`${I}End Object`);
    L.push(`${I}Slots(0)=/Script/UMG.OverlaySlot'"OverlaySlot_0"'`);
    L.push(`${I}Slots(1)=/Script/UMG.OverlaySlot'"OverlaySlot_1"'`);
    L.push(`${I}bExpandedInDesigner=True`);
    L.push(`${I}DisplayLabel="${this.overlayName}"`);
    L.push(`End Object`);

    // === 2. WidgetSlotPair for Overlay ===
    L.push(`Begin Object Class=/Script/UMGEditor.WidgetSlotPair Name="WidgetSlotPair_0"`);
    L.push(`${I}WidgetName="${this.overlayName}"`);
    L.push(`${I}SlotPropertyNames(0)="Padding"`);
    L.push(`${I}SlotPropertyNames(1)="HorizontalAlignment"`);
    L.push(`${I}SlotPropertyNames(2)="VerticalAlignment"`);
    L.push(`${I}SlotPropertyValues(0)="(Left=0.000000,Top=0.000000,Right=0.000000,Bottom=0.000000)"`);
    L.push(`${I}SlotPropertyValues(1)="HAlign_Fill"`);
    L.push(`${I}SlotPropertyValues(2)="VAlign_Fill"`);
    L.push(`End Object`);

    // === 3. Background Image ===
    const bgSz = `ImageSize=(X=${this.resW.toFixed(6)},Y=${this.resH.toFixed(6)})`;
    L.push(`Begin Object Class=/Script/UMG.Image Name="${this.bgImageName}"`);
    L.push(`${I}Brush=(${bgSz},TintColor=(SpecifiedColor=${ueColor(this.pageBgColor)}))`);
    L.push(`${I}Visibility=ESlateVisibility::SelfHitTestInvisible`);
    L.push(`${I}bIsVariable=False`);
    L.push(`${I}DisplayLabel="${this.bgImageName}"`);
    L.push(`End Object`);

    // === 4. Partition elements: root vs scroll groups vs panel groups ===
    //
    // Order of precedence: panelGroup > scrollRegionId > root.
    // Rationale: a `data-ue-panel` container is meant to be hideable as a
    // unit, so its contents are pulled OUT of any scroll region they
    // happened to fall inside. Mixing the two would couple panel
    // visibility to scroll-region layout in subtle ways (e.g. opening a
    // hidden panel inside a vertical scrollbox would make the scrollbox's
    // computed content height "wrong" because the panel was force-shown
    // during analysis but is `Collapsed` at runtime). Keeping panels
    // top-level under the root canvas avoids that whole class of
    // interaction.
    const scrollGroupMap = {};
    this.scrollRegions.forEach(sr => { scrollGroupMap[sr.id] = []; });
    const panelGroupMap = {};
    this.panelGroups.forEach(pg => { panelGroupMap[pg.id] = []; });
    const rootElements = [];
    this.elements.forEach(el => {
      if (el.panelGroup && panelGroupMap[el.panelGroup]) {
        panelGroupMap[el.panelGroup].push(el);
      } else if (el.scrollRegionId && scrollGroupMap[el.scrollRegionId]) {
        scrollGroupMap[el.scrollRegionId].push(el);
      } else {
        rootElements.push(el);
      }
    });
    // Add ScrollBox placeholders.
    //   • Root scroll: always emitted at the Overlay level (handled below).
    //   • Inner scroll WITH children: emitted as a child of either its
    //     enclosing panel (when the scroll's source DOM container sits
    //     inside a `data-ue-panel`) or, failing that, the root scroll
    //     group / root canvas.
    //   • Inner scroll WITH NO children (children all stolen by a parent
    //     panel via panel-wins precedence): dropped entirely. We used to
    //     emit an empty `UScrollBox → USizeBox → UCanvasPanel` shell that
    //     showed up in UMG as an unselectable, unused widget tree. The
    //     widget-rich version of the same content is already inside the
    //     panel; the empty shell was strictly noise.
    const _rootScroll = _rootScrollEarly;
    this.scrollRegions.forEach(sr => {
      if (sr.isRootScroll) {
        // Root scroll wraps everything else and is always the sole top-level
        // child — its z-index relative to siblings doesn't matter, but we
        // still propagate it for symmetry with non-root scrolls.
        rootElements.push({ ueType: 'ScrollBox', name: sr.id, x: sr.x, y: sr.y, w: sr.w, h: sr.h, zIndex: sr.zIndex, _scrollRegion: sr });
        return;
      }
      const children = scrollGroupMap[sr.id];
      if (!children || !children.length) return; // drop empty inner scroll
      // `zIndex: sr.zIndex` propagates the source element's effective
      // z-index onto the sort placeholder. Without it the inner scroll
      // collapses to z=0 in the root sort and ties with un-z-indexed
      // bg overlays — same root cause as the panel-z bug fixed below.
      const ph = { ueType: 'ScrollBox', name: sr.id, x: sr.x, y: sr.y, w: sr.w, h: sr.h, zIndex: sr.zIndex, _scrollRegion: sr };
      if (sr.panelGroup && panelGroupMap[sr.panelGroup]) {
        panelGroupMap[sr.panelGroup].push(ph);
      } else if (_rootScroll) {
        scrollGroupMap[_rootScroll.id].push(ph);
      } else {
        rootElements.push(ph);
      }
    });
    // Add panel placeholders. Each placeholder represents the panel's
    // outer `UMG.CanvasPanel` shell whose `Visibility` defaults to
    // `Collapsed` (or `Visible` when `defaultOpen` is set). Hosting rules:
    //   • Panel with `parentId` set: nest INSIDE the parent panel's
    //     children list. The parent panel's `genPanelCanvasPanel` call
    //     dispatches on `ueType === 'PanelCanvas'` and recurses, producing
    //     a CanvasPanel-inside-CanvasPanel hierarchy. Coords stay absolute
    //     here; `genPanelCanvasPanel` translates them by the parent's
    //     offset when computing the child slot's `LayoutData`.
    //   • Panel without `parentId` (top-level): when the page overflows
    //     and a root ScrollBox wraps everything, sit INSIDE the root
    //     scroll's inner canvas — that's the only place where absolute
    //     coords still make sense. Otherwise sit at root level.
    this.panelGroups.forEach(pg => {
      const ph = {
        ueType: 'PanelCanvas',
        name: 'Panel_' + pg.name,
        x: pg.x, y: pg.y, w: pg.w, h: pg.h,
        // Effective z-index inherited from the source `[data-ue-panel]`
        // element's CSS z-index (or its zContext when CSS z is auto).
        // Critical: without this, every panel container collapses to
        // z=0 in the T3D root sort and is then DOM-order-tied with bg
        // overlay siblings — bg-overlay later in the DOM wins the tie,
        // covers the panel's interactive children. With this stamp
        // panels sort at their CSS-stacking-context level (e.g. a panel
        // inside `.main-content { z-index: 5 }` correctly outranks
        // `.bg-layer { z-index: 0 }` siblings).
        zIndex: pg.zIndex,
        _panelGroup: pg
      };
      // Panel hosting precedence:
      //   1. `scrollContextId` — panel sits INSIDE a scroll region (the
      //      scroll, not the next panel ancestor, is the immediate
      //      parent of this panel's CanvasPanel slot). The panel's x/y
      //      are stored in scroll-rel space (see registration at
      //      `_traverseImpl`), so handing it to the scroll's children
      //      list lines the slot up exactly. Without this, a
      //      `[data-ue-panel]` inside `overflow:auto` was routed to
      //      the next panel ancestor and its scroll-rel coords got
      //      interpreted as root-rel — the panel itself shifted off
      //      and its children drifted with it (the user-reported
      //      `stats-container`-inside-`details-scroll` bug).
      //   2. `parentId` — panel nested inside another panel (no scroll
      //      between them). Both panel coords are root-rel, so
      //      `genPanelCanvasPanel`'s `child.x - parent.x` translation
      //      gives the correct offset.
      //   3. Root scroll fallback / root canvas.
      if (pg.scrollContextId && scrollGroupMap[pg.scrollContextId]) {
        scrollGroupMap[pg.scrollContextId].push(ph);
      } else if (pg.parentId && panelGroupMap[pg.parentId]) {
        panelGroupMap[pg.parentId].push(ph);
      } else if (_rootScroll) {
        scrollGroupMap[_rootScroll.id].push(ph);
      } else {
        rootElements.push(ph);
      }
    });
    // Stash the partition maps so `genScrollBox` (which can also nest
    // panels for the rootScroll case) and `genPanelCanvasPanel` (which
    // can now nest scroll regions for scroll-inside-panel cases) can
    // resolve child lists without us threading the map through every
    // recursive call.
    this._panelGroupMap = panelGroupMap;
    this._scrollGroupMap = scrollGroupMap;

    // Stable-sort by effective z-index (CSS stacking order), preserving traversal order within same group
    const sortedRoot = rootElements
      .map((el, i) => ({ el, i }))
      .sort((a, b) => {
        const az = a.el.zIndex !== undefined ? a.el.zIndex : 0;
        const bz = b.el.zIndex !== undefined ? b.el.zIndex : 0;
        return az !== bz ? az - bz : a.i - b.i;
      })
      .map(x => x.el);

    if (_rootScroll) {
      // === 5. Root scroll exists: wire Overlay directly to ScrollBox, skip CanvasPanel ===
      const rootScrollEl = sortedRoot.find(el => el.name === _rootScroll.id);
      if (rootScrollEl) {
        L.push(...this.genScrollBox(rootScrollEl, scrollGroupMap[_rootScroll.id] || [], scrollGroupMap));
      }
    } else {
      // === 5. Root CanvasPanel with all root child slots ===
      L.push(`Begin Object Class=/Script/UMG.CanvasPanel Name="${this.canvasName}"`);

      // Forward-declare slots
      sortedRoot.forEach((_, i) => {
        L.push(`${I}Begin Object Class=/Script/UMG.CanvasPanelSlot Name="CanvasPanelSlot_${i}"`);
        L.push(`${I}End Object`);
      });

      // Slot details. ZOrder uses the element's CSS z-index VERBATIM when
      // it has one (so a `z-index: 51` author stamp shows up as `ZOrder=51`
      // in UE's CanvasPanelSlot, not as the normalized sort index 1/2/3 the
      // sort step produced). Elements without an explicit z-index fall back
      // to the sort position so they still paint in CSS stacking order.
      // UE breaks ZOrder ties by Slot index, which mirrors our sort, so
      // tied authoring intents resolve identically in both engines.
      sortedRoot.forEach((el, i) => {
        L.push(`${I}Begin Object Name="CanvasPanelSlot_${i}"`);
        const ldObj = computeCanvasLayoutData(el, this.resW, this.resH);
        L.push(`${I2}LayoutData=${formatCanvasLayoutDataString(ldObj)}`);
        if (el.autoSize && el.ueType === 'TextBlock') {
          L.push(`${I2}bAutoSize=True`);
        }
        const _zOrder = el.zIndex !== undefined ? Math.round(el.zIndex) : i;
        L.push(`${I2}ZOrder=${_zOrder}`);
        L.push(`${I2}Parent=/Script/UMG.CanvasPanel'"${this.canvasName}"'`);
        L.push(`${I2}Content=/Script/${this.ueClass(el)}'"${el.name}"'`);
        L.push(`${I}End Object`);
      });

      // Slots array
      sortedRoot.forEach((_, i) => {
        L.push(`${I}Slots(${i})=/Script/UMG.CanvasPanelSlot'"CanvasPanelSlot_${i}"'`);
      });

      L.push(`${I}Visibility=ESlateVisibility::SelfHitTestInvisible`);
      L.push(`${I}bLockedInDesigner=True`);
      L.push(`${I}bExpandedInDesigner=True`);
      L.push(`${I}DisplayLabel="${this.canvasName}"`);
      L.push(`End Object`);

      // === 6. Widget definitions for root elements ===
      sortedRoot.forEach(el => {
        if (el.ueType === 'ScrollBox') {
          L.push(...this.genScrollBox(el, scrollGroupMap[el.name] || [], scrollGroupMap));
        } else if (el.ueType === 'PanelCanvas') {
          L.push(...this.genPanelCanvasPanel(el, panelGroupMap[el._panelGroup.id] || []));
        } else {
          L.push(...this.genWidget(el));
        }
      });
    }

    return L.join('\r\n');
  }

  ueClass(el) {
    const m = {
      TextBlock: 'UMG.TextBlock',
      Image: 'UMG.Image',
      Button: 'UMG.Button',
      EditableTextBox: 'UMG.EditableTextBox',
      CheckBox: 'UMG.CheckBox',
      ComboBoxString: 'UMG.ComboBoxString',
      Slider: 'UMG.Slider',
      ProgressBar: 'UMG.ProgressBar',
      ScrollBox: 'UMG.ScrollBox',
      // ExpandableArea is implemented as a CanvasPanel container so its
      // synthesized header + body widgets become real CanvasPanelSlot children
      // (NamedSlotBindings on UMG.ExpandableArea did not survive T3D paste —
      // header/body ended up orphaned at root canvas (0,0)).
      ExpandableArea: 'UMG.CanvasPanel',
      // `data-ue-panel` containers are emitted as CanvasPanels with their
      // own absolute slot in the parent canvas; children are panel-relative.
      PanelCanvas: 'UMG.CanvasPanel'
    };
    return m[el.ueType] || 'UMG.Widget';
  }

  genWidget(el) {
    let lines;
    switch (el.ueType) {
      case 'TextBlock': lines = this.genTextBlock(el); break;
      case 'Image': lines = this.genImage(el); break;
      case 'Button': lines = this.genButton(el); break;
      case 'EditableTextBox': lines = this.genEditableTextBox(el); break;
      case 'CheckBox': lines = this.genCheckBox(el); break;
      case 'ComboBoxString': lines = this.genComboBox(el); break;
      case 'Slider': lines = this.genSlider(el); break;
      case 'ProgressBar': lines = this.genProgressBar(el); break;
      case 'ExpandableArea': return this.genExpandableArea(el);
      default: return [];
    }
    // Common properties emitted for every widget type
    if (lines.length > 1) {
      const insertIdx = lines.length - 1; // Before "End Object"
      const I = this.I;
      if (el.tooltip) {
        const g1 = generateGUID(), g2 = generateGUID();
        const escaped = el.tooltip.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        lines.splice(insertIdx, 0, `${I}ToolTipText=NSLOCTEXT("[${g1}]", "${g2}", "${escaped}")`);
      }
      if (el.renderAngle || el.renderScale) {
        let tfParts = [];
        if (el.renderScale) tfParts.push(`Scale=(X=${el.renderScale.x.toFixed(6)},Y=${el.renderScale.y.toFixed(6)})`);
        if (el.renderAngle) tfParts.push(`Angle=${el.renderAngle.toFixed(6)}`);
        lines.splice(insertIdx, 0, `${I}RenderTransform=(${tfParts.join(',')})`);
        lines.splice(insertIdx + 1, 0, `${I}RenderTransformPivot=(X=0.500000,Y=0.500000)`);
      }
      // Make the button a Blueprint variable when it has a toggleTarget so
      // the developer can drag it into the graph by name to wire its
      // OnClicked event. UMG defaults `bIsVariable` to True for most
      // widgets but Buttons that are auto-emitted by `genButton` don't set
      // it explicitly; we add it here for toggle buttons specifically.
      if (el.toggleTarget && el.ueType === 'Button') {
        lines.splice(insertIdx, 0, `${I}bIsVariable=True`);
      }
      // CSS `pointer-events: none` → UMG `bIsHitTestVisible=False`. Same
      // semantic in both engines: the widget renders but does NOT capture
      // pointer events. Critical for translucent overlay decorations
      // (shines, vignettes, scanlines) that may sit on top of buttons in
      // UMG's canvas — without this they'd swallow clicks even though the
      // CSS author tagged them as non-interactive. Combined with the
      // z-demotion of `pointer-events:none + absolute + no-z-index`
      // patterns above, decorations are now both visually behind and
      // click-transparent.
      // Image and TextBlock are ALWAYS non-hit-testable: they are purely
      // decorative — no interactivity model in UMG. Making them
      // HitTestInvisible guarantees they never swallow clicks meant for
      // Button/Slider widgets that share the same canvas area, regardless
      // of z-order. This is the UMG equivalent of CSS `pointer-events:none`
      // for all visual-only widget types.
      lines.splice(insertIdx, 0, `${I}Visibility=ESlateVisibility::${getUeVisibilityStateForWidget(el)}`);
    }
    // Toggle hint preamble — prepended OUTSIDE the widget's `Begin/End
    // Object` block so it doesn't interfere with T3D parsing. The lines
    // are pure comments (`;` prefix); UE's T3D parser ignores them but a
    // human reading the exported `.txt` / paste payload sees exactly which
    // panel each toggle button is supposed to control. We can't emit the
    // actual `OnClicked` → `SetVisibility(Panel_X, ...)` wiring through
    // T3D — Blueprint event delegate bindings don't survive clipboard
    // paste, so the developer has to add the wiring in the Graph editor.
    if (el.toggleTarget && el.ueType === 'Button') {
      const targetPanel = 'Panel_' + el.toggleTarget;
      const hintLines = [
        `; ─────────────────────────────────────────────────────`,
        `; data-ue-toggle="${el.toggleTarget}"`,
        `; This Button is meant to toggle visibility of "${targetPanel}".`,
        `; In Blueprint Graph, wire its OnClicked event:`,
        `;     ${el.name}.OnClicked  →  ${targetPanel}.SetVisibility(SelfHitTestInvisible/Collapsed)`,
        `; (T3D paste cannot carry the delegate binding — wire it manually.)`,
        `; ─────────────────────────────────────────────────────`
      ];
      lines = hintLines.concat(lines);
    }
    return lines;
  }

  genComboBox(el) {
    const I = this.I;
    const L = [];
    L.push(`Begin Object Class=/Script/UMG.ComboBoxString Name="${el.name}"`);
    if (el.options && el.options.length) {
      el.options.forEach((opt, idx) => {
        L.push(`${I}DefaultOptions(${idx})="${opt.replace(/"/g, '\\"')}"`);
      });
    }
    if (el.selectedOption) {
      L.push(`${I}SelectedOption="${el.selectedOption.replace(/"/g, '\\"')}"`);
    }

    // WidgetStyle with ComboButtonStyle
    const bg = el.bgColor || { r: 30, g: 30, b: 30, a: 1 };
    const hovered = lightenColor(bg, 0.15);
    const sz = `ImageSize=(X=${el.w.toFixed(6)},Y=${el.h.toFixed(6)})`;

    const makeButtonState = (c) => {
      let parts = [`TintColor=(SpecifiedColor=${ueColor(c)})`];
      if (el.borderColor && el.borderWidth > 0) {
        const r = (el.borderRadius || 0).toFixed(6);
        parts.push(`OutlineSettings=(CornerRadii=(X=${r},Y=${r},Z=${r},W=${r}),Color=(SpecifiedColor=${ueColor(el.borderColor)}),Width=${(el.borderWidth * 0.5).toFixed(6)},RoundingType=FixedRadius)`);
      }
      return `(${parts.join(',')})`;
    };

    const normalState = makeButtonState(bg);
    const hoveredState = makeButtonState(hovered);
    const pressedState = makeButtonState(bg);
    L.push(`${I}WidgetStyle=(ComboButtonStyle=(ButtonStyle=(Normal=${normalState},Hovered=${hoveredState},Pressed=${pressedState})))`);

    // ItemStyle — text color for dropdown items
    const tc = el.textColor || { r: 255, g: 255, b: 255, a: 1 };
    L.push(`${I}ItemStyle=(TextColor=(SpecifiedColor=${ueColor(tc)}))`);

    // Font
    const fp = [];
    fp.push(`Size=${Math.round((el.fontSize || 14) * 0.78)}`);
    L.push(`${I}Font=(${fp.join(',')})`);

    // ForegroundColor — main text color
    L.push(`${I}ForegroundColor=(SpecifiedColor=${ueColor(tc)})`);

    L.push(`${I}DisplayLabel="${el.name}"`);
    L.push(`End Object`);
    return L;
  }

  genCheckBox(el) {
    const I = this.I;
    const L = [];

    L.push(`Begin Object Class=/Script/UMG.CheckBox Name="${el.name}"`);

    // Emit a custom WidgetStyle whenever the HTML carried EITHER a custom
    // background color OR an explicit CSS `accent-color`. Without this, a
    // checkbox styled only via `accent-color: var(--orange)` (the modern
    // CSS-only way to recolor the tick / radio dot) would fall through to
    // UE's stock light-blue check style, silently dropping the author's
    // brand color.
    if (el.bgColor || el.accentColor) {
      // Background fallback when ONLY `accent-color` was authored. Using
      // opaque white here (the previous default) painted a hard white
      // rectangle for the UNCHECKED state, which doesn't match what a
      // browser renders: native checkboxes with `accent-color: orange`
      // and no `background-color` show an empty unchecked control and
      // an orange tick once checked. An alpha-0 fill keeps the
      // unchecked image visually empty so only the orange checked
      // state stands out — exactly the user's reported intent
      // (`accent-color: var(--orange)` should NOT bleed into the
      // unchecked state with a fake white plate).
      const bg = el.bgColor || { r: 255, g: 255, b: 255, a: 0 };
      // Checked-state tint: prefer the author's `accent-color` verbatim
      // (matches CSS exactly — that property literally controls the
      // checked-state color). Otherwise fall back to a lightened bg so
      // legacy bg-only stylings still produce a visible tick.
      const checked = el.accentColor || lightenColor(bg, 0.4);
      const sz = `ImageSize=(X=${(el.w || 20).toFixed(6)},Y=${(el.h || 20).toFixed(6)})`;
      const r = (el.borderRadius || 0).toFixed(6);

      const makeState = (c) => {
        const parts = [];
        if (el.borderRadius > 0) parts.push('DrawAs=RoundedBox');
        parts.push(sz);
        parts.push(`TintColor=(SpecifiedColor=${ueColor(c)})`);
        if (el.borderRadius > 0 || (el.borderColor && el.borderWidth > 0)) {
          let outline = `CornerRadii=(X=${r},Y=${r},Z=${r},W=${r}),RoundingType=FixedRadius`;
          if (el.borderColor && el.borderWidth > 0) {
            outline += `,Color=(SpecifiedColor=${ueColor(el.borderColor)}),Width=${(el.borderWidth * 0.5).toFixed(6)}`;
          } else {
            outline += `,Color=(SpecifiedColor=${ueColor(c)})`;
          }
          parts.push(`OutlineSettings=(${outline})`);
        }
        return `(${parts.join(',')})`;
      };

      L.push(`${I}WidgetStyle=(CheckedImage=${makeState(checked)},UncheckedImage=${makeState(bg)},CheckedHoveredImage=${makeState(lightenColor(checked, 0.1))},UncheckedHoveredImage=${makeState(lightenColor(bg, 0.15))},CheckedPressedImage=${makeState(checked)},UncheckedPressedImage=${makeState(bg)})`);
    }

    if (el.checked) L.push(`${I}IsChecked=True`);
    L.push(`${I}DisplayLabel="${el.name}"`);
    L.push(`End Object`);
    return L;
  }

  genScrollBox(el, children, scrollGroupMap = {}) {
    const I = this.I;
    const I2 = I + I;
    const L = [];
    const sr = el._scrollRegion;
    const sizeBoxName = `SizeBox_${el.name}`;
    const canvasName = `Canvas_${el.name}`;

    // --- ScrollBox widget ---
    L.push(`Begin Object Class=/Script/UMG.ScrollBox Name="${el.name}"`);
    // Forward-declare slot for SizeBox
    L.push(`${I}Begin Object Class=/Script/UMG.ScrollBoxSlot Name="SBSlot_${el.name}"`);
    L.push(`${I}End Object`);
    // Slot detail
    L.push(`${I}Begin Object Name="SBSlot_${el.name}"`);
    L.push(`${I2}Parent=/Script/UMG.ScrollBox'"${el.name}"'`);
    L.push(`${I2}Content=/Script/UMG.SizeBox'"${sizeBoxName}"'`);
    L.push(`${I}End Object`);
    L.push(`${I}Slots(0)=/Script/UMG.ScrollBoxSlot'"SBSlot_${el.name}"'`);
    L.push(`${I}Orientation=Orient_Vertical`);
    L.push(`${I}Visibility=ESlateVisibility::Visible`);
    L.push(`${I}DisplayLabel="${el.name}"`);
    L.push(`End Object`);

    // --- SizeBox (forces content size for scrolling) ---
    L.push(`Begin Object Class=/Script/UMG.SizeBox Name="${sizeBoxName}"`);
    L.push(`${I}Begin Object Class=/Script/UMG.SizeBoxSlot Name="SBxSlot_${el.name}"`);
    L.push(`${I}End Object`);
    L.push(`${I}Begin Object Name="SBxSlot_${el.name}"`);
    L.push(`${I2}Parent=/Script/UMG.SizeBox'"${sizeBoxName}"'`);
    L.push(`${I2}Content=/Script/UMG.CanvasPanel'"${canvasName}"'`);
    L.push(`${I}End Object`);
    L.push(`${I}Slots(0)=/Script/UMG.SizeBoxSlot'"SBxSlot_${el.name}"'`);
    L.push(`${I}WidthOverride=${sr.w.toFixed(6)}`);
    L.push(`${I}HeightOverride=${sr.contentH.toFixed(6)}`);
    L.push(`${I}bOverride_WidthOverride=True`);
    L.push(`${I}bOverride_HeightOverride=True`);
    L.push(`${I}DisplayLabel="${sizeBoxName}"`);
    L.push(`End Object`);

    // Stable-sort scroll children by (effectiveZ, traversal_order) for correct inner stacking
    const sortedChildren = children
      .map((c, i) => ({ c, i }))
      .sort((a, b) => {
        const az = a.c.zIndex !== undefined ? a.c.zIndex : 0;
        const bz = b.c.zIndex !== undefined ? b.c.zIndex : 0;
        return az !== bz ? az - bz : a.i - b.i;
      })
      .map(x => x.c);

    // --- Inner CanvasPanel for absolute-positioned scroll children ---
    L.push(`Begin Object Class=/Script/UMG.CanvasPanel Name="${canvasName}"`);
    // Forward-declare child slots
    sortedChildren.forEach((_, i) => {
      L.push(`${I}Begin Object Class=/Script/UMG.CanvasPanelSlot Name="SC_${el.name}_Slot_${i}"`);
      L.push(`${I}End Object`);
    });
    // Slot details. Same ZOrder rule as the root canvas: prefer the
    // child's stamped CSS z-index verbatim (so `z-index:51` shows up as
    // `ZOrder=51` in UE rather than the normalized 0…N-1 sort index),
    // falling back to the sort position when no CSS z was set.
    sortedChildren.forEach((child, i) => {
      L.push(`${I}Begin Object Name="SC_${el.name}_Slot_${i}"`);
      const ldObj = computeCanvasLayoutData(child, sr.w, sr.contentH);
      L.push(`${I2}LayoutData=${formatCanvasLayoutDataString(ldObj)}`);
      if (child.autoSize && child.ueType === 'TextBlock') {
        L.push(`${I2}bAutoSize=True`);
      }
      const _zOrder = child.zIndex !== undefined ? Math.round(child.zIndex) : i;
      L.push(`${I2}ZOrder=${_zOrder}`);
      L.push(`${I2}Parent=/Script/UMG.CanvasPanel'"${canvasName}"'`);
      L.push(`${I2}Content=/Script/${this.ueClass(child)}'"${child.name}"'`);
      L.push(`${I}End Object`);
    });
    // Slots array
    sortedChildren.forEach((_, i) => {
      L.push(`${I}Slots(${i})=/Script/UMG.CanvasPanelSlot'"SC_${el.name}_Slot_${i}"'`);
    });
    L.push(`${I}Visibility=ESlateVisibility::SelfHitTestInvisible`);
    L.push(`${I}bLockedInDesigner=True`);
    L.push(`${I}bExpandedInDesigner=True`);
    L.push(`${I}DisplayLabel="${canvasName}"`);
    L.push(`End Object`);

    // --- Child widget definitions ---
    sortedChildren.forEach(child => {
      if (child.ueType === 'ScrollBox') {
        L.push(...this.genScrollBox(child, scrollGroupMap[child.name] || [], scrollGroupMap));
      } else if (child.ueType === 'PanelCanvas') {
        const panelChildren = (this._panelGroupMap && this._panelGroupMap[child._panelGroup.id]) || [];
        L.push(...this.genPanelCanvasPanel(child, panelChildren));
      } else {
        L.push(...this.genWidget(child));
      }
    });

    return L;
  }

  // Emits a `data-ue-panel` container as a `UMG.CanvasPanel` whose slot in
  // the parent canvas matches the panel's measured bbox. The panel's children
  // (every widget tagged with `el.panelGroup === panel.id`) are placed
  // inside this CanvasPanel with PANEL-RELATIVE coordinates — we subtract
  // the panel's `(x, y)` from each child's `(x, y)` before computing slot
  // layout data. This is necessary because UMG CanvasPanelSlot offsets are
  // interpreted relative to their parent canvas; without translation,
  // children would render at `(panel.x + child.x, panel.y + child.y)`
  // globally, doubling the offset.
  //
  // The panel's `Visibility` defaults to `Collapsed` (children invisible AND
  // not laid out — exactly what `display:none` does in CSS). When
  // `data-ue-panel-default="open"` was set in the source HTML, we emit
  // `Visible` instead so the panel ships visible and the developer can
  // wire OnClicked → SetVisibility to flip it to `Collapsed`.
  //
  // We deliberately do NOT emit `RenderTransform` / `RenderOpacity` on the
  // panel container — those would also affect the children, and per-child
  // transforms are already baked into each child widget's own properties.
  genPanelCanvasPanel(panel, children) {
    const I = this.I;
    const I2 = I + I;
    const L = [];
    const pg = panel._panelGroup;
    const offsetX = panel.x;
    const offsetY = panel.y;

    // Stable-sort panel children by (effectiveZ, traversal_order).
    const sortedChildren = children
      .map((c, i) => ({ c, i }))
      .sort((a, b) => {
        const az = a.c.zIndex !== undefined ? a.c.zIndex : 0;
        const bz = b.c.zIndex !== undefined ? b.c.zIndex : 0;
        return az !== bz ? az - bz : a.i - b.i;
      })
      .map(x => x.c);

    // --- Panel CanvasPanel ---
    L.push(`Begin Object Class=/Script/UMG.CanvasPanel Name="${panel.name}"`);
    // Forward-declare child slots
    sortedChildren.forEach((_, i) => {
      L.push(`${I}Begin Object Class=/Script/UMG.CanvasPanelSlot Name="P_${panel.name}_Slot_${i}"`);
      L.push(`${I}End Object`);
    });
    // Slot details — coords translated to be panel-relative. ZOrder
    // mirrors the root-canvas rule: CSS z-index verbatim when present.
    sortedChildren.forEach((child, i) => {
      L.push(`${I}Begin Object Name="P_${panel.name}_Slot_${i}"`);
      // Synthesize a translated child for layout calculation only. We don't
      // mutate the original `child` object because it may be referenced
      // elsewhere (JSON exporter, parity validator) with absolute coords.
      const translatedChild = { ...child, x: child.x - offsetX, y: child.y - offsetY };
      const ldObj = computeCanvasLayoutData(translatedChild, panel.w, panel.h);
      L.push(`${I2}LayoutData=${formatCanvasLayoutDataString(ldObj)}`);
      if (child.autoSize && child.ueType === 'TextBlock') {
        L.push(`${I2}bAutoSize=True`);
      }
      const _zOrder = child.zIndex !== undefined ? Math.round(child.zIndex) : i;
      L.push(`${I2}ZOrder=${_zOrder}`);
      L.push(`${I2}Parent=/Script/UMG.CanvasPanel'"${panel.name}"'`);
      L.push(`${I2}Content=/Script/${this.ueClass(child)}'"${child.name}"'`);
      L.push(`${I}End Object`);
    });
    // Slots array
    sortedChildren.forEach((_, i) => {
      L.push(`${I}Slots(${i})=/Script/UMG.CanvasPanelSlot'"P_${panel.name}_Slot_${i}"'`);
    });
    // Visibility — open panels ship as SelfHitTestInvisible, closed panels
    // stay Collapsed. Nested panels do NOT override their own authored
    // default state just because an ancestor is collapsed.
    const panelInitialVisibility = (pg && pg.defaultOpen) ? 'SelfHitTestInvisible' : 'Collapsed';
    L.push(`${I}Visibility=ESlateVisibility::${panelInitialVisibility}`);
    L.push(`${I}bIsVariable=True`);
    L.push(`${I}bLockedInDesigner=True`);
    L.push(`${I}bExpandedInDesigner=True`);
    L.push(`${I}DisplayLabel="${panel.name}"`);
    L.push(`End Object`);

    // --- Child widget definitions ---
    // Dispatch on widget type so nested ScrollBoxes (a `data-ue-panel`
    // body that itself uses `overflow-y:auto`) and nested PanelCanvas
    // entries (forward-compat with future nested-panel support) are
    // emitted as full UMG hierarchies, not as bare primitive widgets.
    // Each child still owns its global coords for the JSON exporter; the
    // PANEL slot above used translated coords. genWidget reads el.x/el.y
    // for things like ImageSize, but ImageSize uses w/h not x/y, so it's
    // unaffected.
    const _scrollMap = this._scrollGroupMap || {};
    sortedChildren.forEach(child => {
      if (child.ueType === 'ScrollBox') {
        L.push(...this.genScrollBox(child, _scrollMap[child.name] || [], _scrollMap));
      } else if (child.ueType === 'PanelCanvas') {
        const panelChildren = (this._panelGroupMap && this._panelGroupMap[child._panelGroup.id]) || [];
        L.push(...this.genPanelCanvasPanel(child, panelChildren));
      } else {
        L.push(...this.genWidget(child));
      }
    });

    return L;
  }

  // ExpandableArea container — emitted as a CanvasPanel that REALLY parents
  // the synthesized header TextBlock and body widgets via CanvasPanelSlots.
  // This bypasses the broken NamedSlotBindings T3D-paste path that left
  // header/body orphans at root canvas (0,0).
  // Toggle / collapse behaviour is intentionally not preserved — content is
  // rendered statically as the disclosure was open.
  genExpandableArea(el) {
    const I = this.I;
    const I2 = I + I;
    const L = [];
    const headerName = `T_Header_${el.name}`;
    const headerBgName = `I_HeaderBg_${el.name}`;
    const headerArrowName = `T_HeaderArrow_${el.name}`;
    const bodyChildren = el.bodyElements || [];
    const hasHeaderBg = !!(
      (el.summaryBgColor && el.summaryBgColor.a > 0.001) ||
      (el.summaryBorderColor && el.summaryBorderColor.a > 0.001 && el.summaryBorderWidth > 0)
    );
    const hasHeaderArrow = !!String(el.summaryArrowText || '').trim();

    // Header rect inside the ExpandableArea container (which sits at el.x,el.y, sized el.w x el.h)
    const sRect = el.summaryRect || { x: 0, y: 0, w: el.w, h: Math.max(20, el.summaryFontSize ? el.summaryFontSize * 1.4 : 20) };

    const headerSlotEls = [];
    if (hasHeaderBg) {
      headerSlotEls.push({
        ueType: 'Image', name: headerBgName,
        x: sRect.x, y: sRect.y, w: sRect.w, h: sRect.h,
        bgColor: el.summaryBgColor || null,
        borderColor: (el.summaryBorderColor && el.summaryBorderWidth > 0) ? el.summaryBorderColor : null,
        borderWidth: el.summaryBorderWidth || 0,
        borderRadius: el.summaryBorderRadius || 0
      });
    }

    const sortedBody = bodyChildren
      .map((c, i) => ({ c, i }))
      .sort((a, b) => {
        const az = a.c.zIndex !== undefined ? a.c.zIndex : 0;
        const bz = b.c.zIndex !== undefined ? b.c.zIndex : 0;
        return az !== bz ? az - bz : a.i - b.i;
      })
      .map(x => x.c);

    const headerSlotEl = {
      ueType: 'TextBlock', name: headerName,
      x: sRect.x + (el.summaryPadLeft || 0),
      y: sRect.y,
      w: Math.max(1, sRect.w - (el.summaryPadLeft || 0) - (el.summaryPadRight || 0) - (hasHeaderArrow ? Math.max(18, (el.summaryFontSize || 14) * 1.2) : 0)),
      h: sRect.h,
      autoSize: false
    };
    headerSlotEls.push(headerSlotEl);
    if (hasHeaderArrow) {
      headerSlotEls.push({
        ueType: 'TextBlock', name: headerArrowName,
        x: sRect.x + sRect.w - Math.max(18, (el.summaryPadRight || 14) + (el.summaryFontSize || 14)),
        y: sRect.y,
        w: Math.max(18, (el.summaryPadRight || 14) + (el.summaryFontSize || 14)),
        h: sRect.h,
        autoSize: false
      });
    }
    const allSlotEls = [...headerSlotEls, ...sortedBody];

    // --- CanvasPanel container ---
    L.push(`Begin Object Class=/Script/UMG.CanvasPanel Name="${el.name}"`);
    // Forward-declare slots
    allSlotEls.forEach((_, i) => {
      L.push(`${I}Begin Object Class=/Script/UMG.CanvasPanelSlot Name="EA_Slot_${el.name}_${i}"`);
      L.push(`${I}End Object`);
    });
    // Slot details — same ZOrder rule (prefer CSS z-index verbatim).
    allSlotEls.forEach((child, i) => {
      L.push(`${I}Begin Object Name="EA_Slot_${el.name}_${i}"`);
      const ldObj = computeCanvasLayoutData(child, el.w, el.h);
      L.push(`${I2}LayoutData=${formatCanvasLayoutDataString(ldObj)}`);
      if (child.autoSize && child.ueType === 'TextBlock') L.push(`${I2}bAutoSize=True`);
      const _zOrder = child.zIndex !== undefined ? Math.round(child.zIndex) : i;
      L.push(`${I2}ZOrder=${_zOrder}`);
      L.push(`${I2}Parent=/Script/UMG.CanvasPanel'"${el.name}"'`);
      L.push(`${I2}Content=/Script/${this.ueClass(child)}'"${child.name}"'`);
      L.push(`${I}End Object`);
    });
    allSlotEls.forEach((_, i) => {
      L.push(`${I}Slots(${i})=/Script/UMG.CanvasPanelSlot'"EA_Slot_${el.name}_${i}"'`);
    });
    L.push(`${I}Visibility=ESlateVisibility::SelfHitTestInvisible`);
    L.push(`${I}bLockedInDesigner=True`);
    L.push(`${I}bExpandedInDesigner=True`);
    L.push(`${I}DisplayLabel="${el.name}"`);
    L.push(`End Object`);

    // --- Header TextBlock (synthesized from <summary>) ---
    const textColor = el.summaryColor || { r: 255, g: 255, b: 255, a: 1 };
    const ueFs = Math.round((el.summaryFontSize || 14) * 0.78);
    const g1 = generateGUID(), g2 = generateGUID();
    const escaped = (el.summaryText || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (hasHeaderBg) {
      L.push(...this.genImage({
        ueType: 'Image',
        name: headerBgName,
        x: sRect.x,
        y: sRect.y,
        w: sRect.w,
        h: sRect.h,
        bgColor: el.summaryBgColor || null,
        borderColor: (el.summaryBorderColor && el.summaryBorderWidth > 0) ? el.summaryBorderColor : null,
        borderWidth: el.summaryBorderWidth || 0,
        borderRadius: el.summaryBorderRadius || 0
      }));
    }
    L.push(`Begin Object Class=/Script/UMG.TextBlock Name="${headerName}"`);
    L.push(`${I}Text=NSLOCTEXT("[${g1}]", "${g2}", "${escaped}")`);
    if (el.summaryFontWeight && el.summaryFontWeight !== 'Regular') {
      L.push(`${I}Font=(FontObject=/Engine/EngineFonts/Roboto.Roboto,TypefaceFontName="${el.summaryFontWeight}",Size=${ueFs})`);
    } else {
      L.push(`${I}Font=(FontObject=/Engine/EngineFonts/Roboto.Roboto,Size=${ueFs})`);
    }
    L.push(`${I}ColorAndOpacity=(SpecifiedColor=${ueColor(textColor)})`);
    L.push(`${I}Visibility=ESlateVisibility::SelfHitTestInvisible`);
    L.push(`${I}bIsVariable=False`);
    L.push(`${I}DisplayLabel="${headerName}"`);
    L.push(`End Object`);
    if (hasHeaderArrow) {
      const ag1 = generateGUID(), ag2 = generateGUID();
      const arrowEscaped = String(el.summaryArrowText || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const arrowColor = el.summaryArrowColor || textColor;
      L.push(`Begin Object Class=/Script/UMG.TextBlock Name="${headerArrowName}"`);
      L.push(`${I}Text=NSLOCTEXT("[${ag1}]", "${ag2}", "${arrowEscaped}")`);
      if (el.summaryFontWeight && el.summaryFontWeight !== 'Regular') {
        L.push(`${I}Font=(FontObject=/Engine/EngineFonts/Roboto.Roboto,TypefaceFontName="${el.summaryFontWeight}",Size=${ueFs})`);
      } else {
        L.push(`${I}Font=(FontObject=/Engine/EngineFonts/Roboto.Roboto,Size=${ueFs})`);
      }
      L.push(`${I}ColorAndOpacity=(SpecifiedColor=${ueColor(arrowColor)})`);
      L.push(`${I}Justification=Center`);
      L.push(`${I}Visibility=ESlateVisibility::SelfHitTestInvisible`);
      L.push(`${I}DisplayLabel="${headerArrowName}"`);
      L.push(`End Object`);
    }

    // --- Body child widget definitions ---
    sortedBody.forEach(child => L.push(...this.genWidget(child)));

    return L;
  }

  genSlider(el) {
    const I = this.I;
    const L = [];
    L.push(`Begin Object Class=/Script/UMG.Slider Name="${el.name}"`);
    L.push(`${I}Value=${el.value.toFixed(6)}`);
    if (el.stepSize && el.stepSize > 0) L.push(`${I}StepSize=${el.stepSize.toFixed(6)}`);
    const barCol = el.barColor || { r: 80, g: 80, b: 80, a: 1 };
    const fillCol = el.fillColor || { r: 50, g: 120, b: 220, a: 1 };
    const thumbCol = el.thumbColor || { r: 255, g: 255, b: 255, a: 1 };
    const barState = `(TintColor=(SpecifiedColor=${ueColor(barCol)}))`;
    // Build the thumb brush. When the author styled
    // `::-webkit-slider-thumb` with a border-radius / outline (the user's
    // `border-radius:2px;border:2px solid #2A1608` thumb pattern), emit a
    // RoundedBox brush with OutlineSettings so the rotated diamond
    // silhouette survives. Plain colored thumbs fall back to the simple
    // TintColor-only brush — same shape as before, no regression.
    const thumbHasOutline = !!(el.thumbBorderColor && el.thumbBorderWidth > 0);
    const thumbHasRadius = !!(el.thumbBorderRadius && el.thumbBorderRadius > 0);
    const buildThumbBrush = () => {
      const parts = [];
      if (thumbHasRadius || thumbHasOutline) parts.push('DrawAs=RoundedBox');
      if (el.thumbW && el.thumbH) {
        parts.push(`ImageSize=(X=${(+el.thumbW).toFixed(6)},Y=${(+el.thumbH).toFixed(6)})`);
      }
      parts.push(`TintColor=(SpecifiedColor=${ueColor(thumbCol)})`);
      if (thumbHasRadius || thumbHasOutline) {
        const r = (el.thumbBorderRadius || 0).toFixed(6);
        let outline = `CornerRadii=(X=${r},Y=${r},Z=${r},W=${r}),RoundingType=FixedRadius`;
        if (thumbHasOutline) {
          outline += `,Color=(SpecifiedColor=${ueColor(el.thumbBorderColor)}),Width=${el.thumbBorderWidth.toFixed(6)}`;
        }
        parts.push(`OutlineSettings=(${outline})`);
      }
      return `(${parts.join(',')})`;
    };
    const thumbState = (thumbHasOutline || thumbHasRadius || el.thumbW)
      ? buildThumbBrush()
      : `(TintColor=(SpecifiedColor=${ueColor(thumbCol)}))`;
    L.push(`${I}WidgetStyle=(NormalBarImage=${barState},HoveredBarImage=${barState},DisabledBarImage=${barState},NormalThumbImage=${thumbState},HoveredThumbImage=${thumbState},DisabledThumbImage=${thumbState},BarThickness=${Math.max(el.h * 0.3, 4).toFixed(6)})`);
    L.push(`${I}SliderBarColor=(R=1.000000,G=1.000000,B=1.000000,A=1.000000)`);
    L.push(`${I}SliderHandleColor=(R=1.000000,G=1.000000,B=1.000000,A=1.000000)`);
    // RenderTransformAngle on the Slider rotates the entire widget — not
    // just the thumb. We don't apply `el.thumbAngle` here because UMG's
    // Slider doesn't expose a "thumb-only rotate" knob; the rotation is
    // a CSS-level visual flourish that doesn't survive the export. The
    // value is still serialized into JSON so a downstream plugin can opt
    // to rotate the thumb image manually.
    L.push(`${I}DisplayLabel="${el.name}"`);
    L.push(`End Object`);
    return L;
  }

  genProgressBar(el) {
    const I = this.I;
    const L = [];
    L.push(`Begin Object Class=/Script/UMG.ProgressBar Name="${el.name}"`);
    L.push(`${I}Percent=${el.percent.toFixed(6)}`);
    const bgCol = el.bgColor || { r: 40, g: 40, b: 40, a: 1 };
    const fillCol = el.fillColor || { r: 50, g: 120, b: 220, a: 1 };
    // FSlateBrush defaults to DrawAs=Image with no ResourceObject, i.e. nothing
    // visible no matter what TintColor we set. Force DrawAs=Box (or RoundedBox
    // when the element has a border-radius) and supply ImageSize + Margin so
    // the tint actually paints. Matching the outline color to the fill and
    // using >=1 width gives clean anti-aliased edges (same fix as EditableTextBox).
    const sz = `ImageSize=(X=${el.w.toFixed(6)},Y=${el.h.toFixed(6)})`;
    const margins = 'Margin=(Left=0.000000,Top=0.000000,Right=0.000000,Bottom=0.000000)';
    const rounded = el.borderRadius > 0;
    const drawAs = rounded ? 'RoundedBox' : 'Box';
    const makeBrush = (c) => {
      const parts = [`DrawAs=${drawAs}`, sz, margins, `TintColor=(SpecifiedColor=${ueColor(c)})`];
      if (rounded) {
        const r = (el.borderRadius || 0).toFixed(6);
        parts.push(`OutlineSettings=(CornerRadii=(X=${r},Y=${r},Z=${r},W=${r}),RoundingType=FixedRadius,Color=(SpecifiedColor=${ueColor(c)}),Width=1.000000)`);
      }
      return `(${parts.join(',')})`;
    };
    L.push(`${I}WidgetStyle=(BackgroundImage=${makeBrush(bgCol)},FillImage=${makeBrush(fillCol)})`);
    L.push(`${I}FillColorAndOpacity=(SpecifiedColor=${ueColor(fillCol)})`);
    L.push(`${I}DisplayLabel="${el.name}"`);
    L.push(`End Object`);
    return L;
  }

  genTextBlock(el) {
    const I = this.I;
    const L = [];
    const g1 = generateGUID(), g2 = generateGUID();

    // Use exact text format (has precise \n inserted by our visual line wrap parser)
    let rawText = el.text || '';
    
    // Escape for UE NSLOCTEXT: quotes → \", backslashes → \\, newlines → literal \n in string
    const escaped = rawText
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');

    L.push(`Begin Object Class=/Script/UMG.TextBlock Name="${el.name}"`);
    L.push(`${I}Text=NSLOCTEXT("[${g1}]", "${g2}", "${escaped}")`);

    // Font
    const fp = [];
    if (el.fontWeight) fp.push(`TypefaceFontName="${el.fontWeight}"`);
    fp.push(`Size=${Math.round((el.fontSize || 14) * 0.78)}`);
    L.push(`${I}Font=(${fp.join(',')})`);
    if (el.letterSpacing) {
      const ls = Math.round(el.letterSpacing);
      if (ls !== 0) L.push(`${I}LetterSpacing=${ls}`);
    }
    // Color
    if (el.color && !isWhiteish(el.color)) {
      L.push(`${I}ColorAndOpacity=(SpecifiedColor=${ueColor(el.color)})`);
    }

    // Justify
    if (el.textAlign === 'center' || el.textAlign === '-webkit-center') L.push(`${I}Justification=Center`);
    else if (el.textAlign === 'right') L.push(`${I}Justification=Right`);

    // text-shadow → UMG shadow offset + color (blur is ignored, since UMG has no blur; alpha carries intensity)
    if (el.textShadow) {
      const s = el.textShadow;
      L.push(`${I}ShadowOffset=(X=${s.offsetX.toFixed(6)},Y=${s.offsetY.toFixed(6)})`);
      L.push(`${I}ShadowColorAndOpacity=${ueColor(s.color)}`);
    }

    L.push(`${I}DisplayLabel="${el.name}"`);
    L.push(`End Object`);
    return L;
  }

  genImage(el) {
    const I = this.I;
    const L = [];
    L.push(`Begin Object Class=/Script/UMG.Image Name="${el.name}"`);

    // Frame-style border → DrawAs=Border + 10x10 white texture + tint
    if (el._isBorderFrame) {
      const asset = el.borderFrameTexturePath.split('/').pop();
      const fullRef = `${el.borderFrameTexturePath}.${asset}`;
      const m = (el.borderFrameMargin || 0.1).toFixed(6);
      const col = el.borderFrameColor || { r: 255, g: 255, b: 255, a: 1 };
      const bparts = [
        'DrawAs=Border',
        'ImageSize=(X=10.000000,Y=10.000000)',
        `Margin=(Left=${m},Top=${m},Right=${m},Bottom=${m})`,
        `TintColor=(SpecifiedColor=${ueColor(col)})`,
        `ResourceObject=/Script/Engine.Texture2D'"${fullRef}"'`
      ];
      L.push(`${I}Brush=(${bparts.join(',')})`);
      if (el.opacity !== undefined && el.opacity < 1) {
        L.push(`${I}RenderOpacity=${el.opacity.toFixed(6)}`);
      }
      L.push(`${I}DisplayLabel="${el.name}"`);
      L.push(`End Object`);
      return L;
    }

    const bp = [];
    const allowRounded = !hasCustomShapeBrush(el);
    if (el.gradientTexturePath) {
      const assetName = el.gradientTexturePath.split('/').pop();
      const fullRef = `${el.gradientTexturePath}.${assetName}`;
      if (allowRounded && (el.engineRoundedCorners || el.borderRadius > 0 || (el.borderColor && el.borderWidth > 0))) {
        bp.push('DrawAs=RoundedBox');
      }
      bp.push(`ImageSize=(X=${el.w.toFixed(6)},Y=${el.h.toFixed(6)})`);
      // gridTintColor: use original low-alpha color as TintColor instead of white
      // This lets UE apply the correct opacity/color via engine-side tinting
      if (el.gridTintColor) {
        bp.push(`TintColor=(SpecifiedColor=${ueColor(el.gridTintColor)})`);
      }
      if (allowRounded && (el.engineRoundedCorners || el.borderRadius > 0 || (el.borderColor && el.borderWidth > 0))) {
        const r = (el.borderRadius || 0).toFixed(6);
        let outline = `CornerRadii=(X=${r},Y=${r},Z=${r},W=${r}),RoundingType=FixedRadius`;
        if (el.borderColor) {
          outline += `,Color=(SpecifiedColor=${ueColor(el.borderColor)}),Width=${(el.borderWidth || 1).toFixed(6)}`;
        } else if (el.bgColor) {
          outline += `,Color=(SpecifiedColor=${ueColor(el.bgColor)})`;
        }
        bp.push(`OutlineSettings=(${outline})`);
      }
      bp.push(`ResourceObject=/Script/Engine.Texture2D'"${fullRef}"'`);
    } else {
      if (allowRounded && el.borderRadius > 0) bp.push('DrawAs=RoundedBox');
      bp.push(`ImageSize=(X=${el.w.toFixed(6)},Y=${el.h.toFixed(6)})`);
      if (el.bgColor) {
        bp.push(`TintColor=(SpecifiedColor=${ueColor(el.bgColor)})`);
      } else if (!el.texturePath) {
        // No bg color AND no texture → user authored a transparent shape
        // (typical: a border-only frame like `.panel-frame { border:2px
        // solid; border-radius:4px; background:none }`). Without an
        // explicit alpha-0 TintColor here, UMG falls back to its default
        // white brush and paints the entire rect solid white over the
        // page bg — the user-reported `.panel-frame` "ful beyaz" bug.
        // Emit a transparent tint so only the OutlineSettings border is
        // visible and the inside stays see-through.
        bp.push('TintColor=(SpecifiedColor=(R=0.000000,G=0.000000,B=0.000000,A=0.000000))');
      }
      if (el.borderRadius > 0) {
        const r = el.borderRadius.toFixed(6);
        let outline = `CornerRadii=(X=${r},Y=${r},Z=${r},W=${r}),RoundingType=FixedRadius`;
        if (el.borderColor) {
          outline += `,Color=(SpecifiedColor=${ueColor(el.borderColor)}),Width=${(el.borderWidth || 1).toFixed(6)}`;
        } else if (el.bgColor) {
          outline += `,Color=(SpecifiedColor=${ueColor(el.bgColor)})`;
        }
        bp.push(`OutlineSettings=(${outline})`);
      }
      if (el.texturePath) {
        const assetName = el.texturePath.split('/').pop();
        bp.push(`ResourceObject=/Script/Engine.Texture2D'"${el.texturePath}.${assetName}"'`);
      }
    }
    L.push(`${I}Brush=(${bp.join(',')})`);

    if (el.opacity !== undefined && el.opacity < 1) {
      L.push(`${I}RenderOpacity=${el.opacity.toFixed(6)}`);
    }
    L.push(`${I}DisplayLabel="${el.name}"`);
    L.push(`End Object`);
    return L;
  }

  genButton(el) {
    const I = this.I;
    const I2 = I + I;
    const L = [];
    const bg = el.bgColor || { r: 40, g: 40, b: 40, a: 1 };
    const hovered = lightenColor(bg, 0.15);
    const pressed = darkenColor(bg, 0.7);
    const disabled = darkenColor(bg, 0.4);
    const allowRounded = !hasCustomShapeBrush(el);
    const r = (el.borderRadius || 0).toFixed(6);
    const cornerStr = `CornerRadii=(X=${r},Y=${r},Z=${r},W=${r})`;
    const sz = `ImageSize=(X=${el.w.toFixed(6)},Y=${el.h.toFixed(6)})`;
    const hasButtonText = !!String(el.text || '').trim();

    const makeState = (c, drawRounded) => {
      let parts = [];
      if (el.gradientTexturePath) {
        // Gradient texture: white tint + texture resource
        const assetName = el.gradientTexturePath.split('/').pop();
        const fullRef = `${el.gradientTexturePath}.${assetName}`;
        if (allowRounded && (el.engineRoundedCorners || el.borderRadius > 0 || (el.borderColor && el.borderWidth > 0))) {
          parts.push('DrawAs=RoundedBox');
        }
        parts.push(`TintColor=(SpecifiedColor=(R=1.000000,G=1.000000,B=1.000000,A=1.000000))`);
        parts.push(sz);
        if (allowRounded && (el.engineRoundedCorners || el.borderRadius > 0 || (el.borderColor && el.borderWidth > 0))) {
          let outline = `${cornerStr},RoundingType=FixedRadius`;
          if (el.borderColor) {
            outline += `,Color=(SpecifiedColor=${ueColor(el.borderColor)}),Width=${(el.borderWidth || 1).toFixed(6)}`;
          } else {
            outline += `,Color=(SpecifiedColor=${ueColor(c)})`;
          }
          parts.push(`OutlineSettings=(${outline})`);
        }
        parts.push(`ResourceObject=/Script/Engine.Texture2D'"${fullRef}"'`);
      } else {
        if (allowRounded && (drawRounded || el.borderRadius > 0 || (el.borderColor && el.borderWidth > 0))) parts.push('DrawAs=RoundedBox');
        parts.push(sz);
        parts.push(`TintColor=(SpecifiedColor=${ueColor(c)})`);
        if (allowRounded && (el.borderRadius > 0 || (el.borderColor && el.borderWidth > 0))) {
          let outline = `${cornerStr},RoundingType=FixedRadius`;
          if (el.borderColor) {
            outline += `,Color=(SpecifiedColor=${ueColor(el.borderColor)}),Width=${(el.borderWidth || 1).toFixed(6)}`;
          } else {
            outline += `,Color=(SpecifiedColor=${ueColor(c)})`;
          }
          parts.push(`OutlineSettings=(${outline})`);
        }
      }
      return `(${parts.join(',')})` ;
    };

    L.push(`Begin Object Class=/Script/UMG.Button Name="${el.name}"`);
    if (hasButtonText) {
      L.push(`${I}Begin Object Class=/Script/UMG.ButtonSlot Name="ButtonSlot_0"`);
      L.push(`${I}End Object`);
      L.push(`${I}Begin Object Name="ButtonSlot_0"`);
      const padL = (el.textPadLeft || 0).toFixed(6);
      const padR = (el.textPadRight || 0).toFixed(6);
      L.push(`${I2}Padding=(Left=${padL},Top=0.000000,Right=${padR},Bottom=0.000000)`);
      L.push(`${I2}HorizontalAlignment=${el.textHAlign || 'HAlign_Center'}`);
      L.push(`${I2}VerticalAlignment=${el.textVAlign || 'VAlign_Center'}`);
      L.push(`${I2}Parent=/Script/UMG.Button'"${el.name}"'`);
      L.push(`${I2}Content=/Script/UMG.TextBlock'"${el.textBlockName}"'`);
      L.push(`${I}End Object`);
    }

    L.push(`${I}WidgetStyle=(Normal=${makeState(bg, false)},Hovered=${makeState(hovered, false)},Pressed=${makeState(pressed, false)},Disabled=${makeState(disabled, true)})`);
    // bUseBrushTransparency=False is needed when RoundedBox with OutlineSettings is used (border-only buttons)
    // Without this, UE ignores the transparent fill area and the border won't work correctly
    const hasBrushBorder = el.borderColor && el.borderWidth > 0;
    if ((hasBrushBorder || el.borderRadius > 0 || el.gradientTexturePath) && allowRounded) {
      L.push(`${I}bUseBrushTransparency=False`);
    }
    if (hasButtonText) L.push(`${I}Slots(0)=/Script/UMG.ButtonSlot'"ButtonSlot_0"'`);
    L.push(`${I}bExpandedInDesigner=True`);
    L.push(`${I}DisplayLabel="${el.name}"`);
    L.push(`End Object`);

    if (!hasButtonText) return L;

    // Button's child TextBlock
    const g1 = generateGUID(), g2 = generateGUID();
    L.push(`Begin Object Class=/Script/UMG.TextBlock Name="${el.textBlockName}"`);
    const escapedBtnText = (el.text || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    L.push(`${I}Text=NSLOCTEXT("[${g1}]", "${g2}", "${escapedBtnText}")`);
    const fp = [];
    if (el.fontWeight) fp.push(`TypefaceFontName="${el.fontWeight}"`);
    fp.push(`Size=${Math.round((el.fontSize || 14) * 0.78)}`);
    L.push(`${I}Font=(${fp.join(',')})`);
    if (el.textColor && !isWhiteish(el.textColor)) {
      L.push(`${I}ColorAndOpacity=(SpecifiedColor=${ueColor(el.textColor)})`);
    }
    L.push(`${I}Justification=Center`);
    if (el.textShadow) {
      const s = el.textShadow;
      L.push(`${I}ShadowOffset=(X=${s.offsetX.toFixed(6)},Y=${s.offsetY.toFixed(6)})`);
      L.push(`${I}ShadowColorAndOpacity=${ueColor(s.color)}`);
    }
    L.push(`${I}Visibility=ESlateVisibility::SelfHitTestInvisible`);
    L.push(`End Object`);

    return L;
  }

  genEditableTextBox(el) {
    const I = this.I;
    const L = [];
    const bg = el.bgColor || { r: 30, g: 30, b: 30, a: 1 };
    const hovered = lightenColor(bg, 0.1);
    const sz = `ImageSize=(X=${el.w.toFixed(6)},Y=${el.h.toFixed(6)})`;
    const margins = 'Margin=(Left=0.000000,Top=0.000000,Right=0.000000,Bottom=0.000000)';

    // DrawAs=RoundedBox with Width=0 outline produces color artifacts at the
    // corners because UMG's edge anti-aliasing needs a non-zero outline to
    // sample against. Use the CSS border width if present, else a minimum of
    // 1px with the outline color matched to the fill so the corners smooth
    // out without visually adding a stroke.
    const outlineWidth = Math.max(1, el.borderWidth || 0);
    const makeImgState = (c) => {
      const parts = [`DrawAs=RoundedBox`, sz, margins, `TintColor=(SpecifiedColor=${ueColor(c)})`];
      if (allowRounded && el.borderRadius > 0) {
        const r = (el.borderRadius || 0).toFixed(6);
        let outline = `CornerRadii=(X=${r},Y=${r},Z=${r},W=${r}),RoundingType=FixedRadius`;
        outline += `,Color=(SpecifiedColor=${ueColor(c)}),Width=${outlineWidth.toFixed(6)}`;
        parts.push(`OutlineSettings=(${outline})`);
      }
      return `(${parts.join(',')})`;
    };

    const textColor = el.textColor || { r: 255, g: 255, b: 255, a: 1 };
    const textStyle = `TextStyle=(Font=(Size=${Math.round((el.fontSize || 14) * 0.78)}),ColorAndOpacity=(SpecifiedColor=${ueColor(textColor)},ColorUseRule=UseColor_Specified))`;

    L.push(`Begin Object Class=/Script/UMG.EditableTextBox Name="${el.name}"`);
    L.push(`${I}WidgetStyle=(BackgroundImageNormal=${makeImgState(bg)},BackgroundImageHovered=${makeImgState(hovered)},BackgroundImageFocused=${makeImgState(bg)},${textStyle})`);
    if (el.placeholder) {
      const g1 = generateGUID(), g2 = generateGUID();
      L.push(`${I}HintText=NSLOCTEXT("[${g1}]", "${g2}", "${el.placeholder.replace(/"/g, '\\"')}")`);
    }
    if (el.isPassword) {
      L.push(`${I}IsPassword=True`);
    }
    L.push(`${I}DisplayLabel="${el.name}"`);
    L.push(`End Object`);
    return L;
  }
}

function stripUndefined(value) {
  if (Array.isArray(value)) {
    return value.map(stripUndefined).filter(v => v !== undefined);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const cleaned = stripUndefined(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value === undefined ? undefined : value;
}

function serializeColorForJson(color) {
  if (!color) return null;
  const ue = colorToUE(color.r, color.g, color.b, color.a);
  return {
    rgba: { r: color.r, g: color.g, b: color.b, a: color.a },
    ueLinear: { r: Number(ue.R), g: Number(ue.G), b: Number(ue.B), a: Number(ue.A) }
  };
}

class WidgetJsonExporter {
  constructor(data) {
    this.data = data;
  }

  toUEFontSize(fontSize) {
    return Math.round((fontSize || 14) * 0.78);
  }

  toUEFloat(value, precision = 6) {
    if (value === undefined || value === null || Number.isNaN(Number(value))) return undefined;
    return Number(Number(value).toFixed(precision));
  }

  toUEInt(value) {
    if (value === undefined || value === null || Number.isNaN(Number(value))) return undefined;
    return Math.round(Number(value));
  }

  getEffectiveCanvasAutoSize(el) {
    return !!(el.ueType === 'TextBlock' && el.autoSize);
  }

  getEffectiveButtonHorizontalAlignment(el) {
    return el.textHAlign || 'HAlign_Center';
  }

  getEffectiveButtonVerticalAlignment(el) {
    return el.textVAlign || 'VAlign_Center';
  }

  getTextJustification(textAlign, fallback = 'Left') {
    if (textAlign === 'center' || textAlign === '-webkit-center') return 'Center';
    if (textAlign === 'right') return 'Right';
    return fallback;
  }

  getEffectiveTextColor(color, omitWhite = true) {
    if (!color) return undefined;
    if (omitWhite && isWhiteish(color)) return undefined;
    return serializeColorForJson(color);
  }

  exportObject() {
    const scrollRegions = this.data.scrollRegions || [];
    const panelGroups = this.data.panelGroups || [];
    const scrollGroupMap = {};
    const panelGroupMap = {};
    scrollRegions.forEach(sr => { scrollGroupMap[sr.id] = []; });
    panelGroups.forEach(pg => { panelGroupMap[pg.id] = []; });

    const rootElements = [];
    this.data.elements.forEach(el => {
      // Same partition precedence as `UEWidgetGenerator.generate`:
      // panelGroup wins over scrollRegionId so panels are hideable as a
      // self-contained unit. Keeping the two exporters in lock-step is
      // mandatory for `validateWidgetJsonParity` to pass.
      if (el.panelGroup && panelGroupMap[el.panelGroup]) {
        panelGroupMap[el.panelGroup].push(el);
      } else if (el.scrollRegionId && scrollGroupMap[el.scrollRegionId]) {
        scrollGroupMap[el.scrollRegionId].push(el);
      } else {
        rootElements.push(el);
      }
    });

    // Add ScrollBox entries — same partition rules as `generate()`:
    //   • Root scroll: always emitted at root.
    //   • Inner scroll WITH children: hosted inside its enclosing panel
    //     when the scroll's source DOM container sat inside a panel,
    //     else inside the root scroll, else at root.
    //   • Inner scroll with NO children: skipped entirely (kept in
    //     lock-step with `generate()` so parity validation passes).
    const _rootScrollJson = scrollRegions.find(sr => sr.isRootScroll);
    scrollRegions.forEach(sr => {
      if (sr.isRootScroll) {
        rootElements.push({ _isScrollBox: true, _scrollRegion: sr, _scrollChildren: scrollGroupMap[sr.id] || [] });
        return;
      }
      const scrollChildren = scrollGroupMap[sr.id] || [];
      if (!scrollChildren.length) return; // drop empty inner scroll
      const entry = { _isScrollBox: true, _scrollRegion: sr, _scrollChildren: scrollChildren };
      if (sr.panelGroup && panelGroupMap[sr.panelGroup]) {
        panelGroupMap[sr.panelGroup].push(entry);
      } else if (_rootScrollJson) {
        scrollGroupMap[_rootScrollJson.id].push(entry);
      } else {
        rootElements.push(entry);
      }
    });
    // Add PanelCanvas entries — same hosting rules as `generate`:
    //   • Panel with `parentId`: nest inside the parent panel's children
    //     (rendered as a CanvasPanel-inside-CanvasPanel by recursion in
    //     `serializePanelCanvas`).
    //   • Panel without `parentId`: hosted inside the root ScrollBox when
    //     the page overflows, else at root canvas level.
    panelGroups.forEach(pg => {
      const panelChildren = panelGroupMap[pg.id] || [];
      const entry = { _isPanelCanvas: true, _panelGroup: pg, _panelChildren: panelChildren };
      // Same hosting precedence as the T3D path — see the long comment
      // there. Mirrors `pg.scrollContextId` → scroll children → panel
      // ancestor → root scroll → root canvas.
      if (pg.scrollContextId && scrollGroupMap[pg.scrollContextId]) {
        scrollGroupMap[pg.scrollContextId].push(entry);
      } else if (pg.parentId && panelGroupMap[pg.parentId]) {
        panelGroupMap[pg.parentId].push(entry);
      } else if (_rootScrollJson) {
        scrollGroupMap[_rootScrollJson.id].push(entry);
      } else {
        rootElements.push(entry);
      }
    });
    // Rebuild root scroll entry's _scrollChildren after inner scrolls were pushed
    if (_rootScrollJson) {
      const rsEntry = rootElements.find(e => e._isScrollBox && e._scrollRegion === _rootScrollJson);
      if (rsEntry) rsEntry._scrollChildren = scrollGroupMap[_rootScrollJson.id] || [];
    }

    // Stable-sort by effective z-index (matches generate() ordering).
    // Panel containers and scroll containers carry their OWN effective
    // z-index now (stamped at traversal time from the source element's
    // CSS z-index or inherited zContext) so they sort correctly against
    // un-z-indexed bg overlays at root. Falling back to 0 when the field
    // is missing keeps backward compatibility with older cached data.
    const _zOf = (e) => {
      if (e._isScrollBox) return (e._scrollRegion.zIndex !== undefined ? e._scrollRegion.zIndex : 0);
      if (e._isPanelCanvas) return (e._panelGroup && e._panelGroup.zIndex !== undefined ? e._panelGroup.zIndex : 0);
      return (e.zIndex !== undefined ? e.zIndex : 0);
    };
    const sortedRootJson = rootElements
      .map((el, i) => ({ el, i }))
      .sort((a, b) => {
        const az = _zOf(a.el);
        const bz = _zOf(b.el);
        return az !== bz ? az - bz : a.i - b.i;
      })
      .map(x => x.el);

    const rootChildrenJson = sortedRootJson.map((el, index) => {
      if (el._isScrollBox) {
        return this.serializeScrollBox(el._scrollRegion, el._scrollChildren, index);
      }
      if (el._isPanelCanvas) {
        return this.serializePanelCanvas(el._panelGroup, el._panelChildren, index);
      }
      return this.serializeElement(el, index);
    });

    return {
      schemaVersion: 'widget-generator-plugin-v1',
      generator: {
        name: 'Widget Generator',
        engineVersion: 'UE5'
      },
      root: {
        type: 'CanvasPanel',
        // Suggested asset name for the generated UMG Widget Blueprint and
        // related export artefacts (zip filename, default Blueprint name).
        // Derived from <title>, body[id], or the first meaningful root class.
        // Empty string when no usable identifier was found — the plugin
        // should fall back to its own default name in that case.
        suggestedAssetName: this.data.pageName || '',
        resolution: { width: this.data.resW, height: this.data.resH },
        contentSize: { width: this.data.rootW, height: this.data.rootH },
        pageBackgroundColor: serializeColorForJson(this.data.pageBgColor),
        visibility: 'SelfHitTestInvisible',
        selfHitTestInvisible: true,
        lockedInDesigner: true,
        children: rootChildrenJson
      },
      textures: (this.data.textures || []).map(tex => stripUndefined({
        name: tex.name,
        suggestedPath: tex.suggestedPath,
        isGradient: !!tex.isGradient,
        isIcon: !!tex.isIcon,
        isExternalUrl: !!tex.isExternalUrl
      }))
    };
  }

  serializeScrollBox(sr, children, index, parentW, parentH) {
    const pw = parentW !== undefined ? parentW : this.data.resW;
    const ph = parentH !== undefined ? parentH : this.data.resH;
    const ld = computeCanvasLayoutData({ x: sr.x, y: sr.y, w: sr.w, h: sr.h }, pw, ph);
    return stripUndefined({
      id: sr.id,
      type: 'ScrollBox',
      visibility: 'Visible',
      canvasSlot: {
        anchors: {
          minimum: { x: ld.anchors.minX, y: ld.anchors.minY },
          maximum: { x: ld.anchors.maxX, y: ld.anchors.maxY }
        },
        offsets: {
          left: this.toUEFloat(ld.offsets.left),
          top: this.toUEFloat(ld.offsets.top),
          right: this.toUEFloat(ld.offsets.right),
          bottom: this.toUEFloat(ld.offsets.bottom)
        },
        position: { x: this.toUEFloat(sr.x), y: this.toUEFloat(sr.y) },
        size: { width: this.toUEFloat(sr.w), height: this.toUEFloat(sr.h) },
        zOrder: sr.zIndex !== undefined ? Math.round(sr.zIndex) : index
      },
      scrollBox: {
        orientation: 'Vertical',
        contentWidth: this.toUEFloat(sr.w),
        contentHeight: this.toUEFloat(sr.contentH)
      },
      children: children
        .map((el, i) => ({ el, i }))
        .sort((a, b) => {
          // Same _zOf rules as the root sort: panels and scrolls carry
          // stamped effective z-index now, falling back to 0 when missing.
          const _zOfChild = (e) => e._isScrollBox
            ? (e._scrollRegion.zIndex !== undefined ? e._scrollRegion.zIndex : 0)
            : (e._isPanelCanvas
              ? (e._panelGroup && e._panelGroup.zIndex !== undefined ? e._panelGroup.zIndex : 0)
              : (e.zIndex !== undefined ? e.zIndex : 0));
          const az = _zOfChild(a.el);
          const bz = _zOfChild(b.el);
          return az !== bz ? az - bz : a.i - b.i;
        })
        .map(({ el }, i) => {
          if (el._isScrollBox) return this.serializeScrollBox(el._scrollRegion, el._scrollChildren, i, sr.w, sr.contentH);
          if (el._isPanelCanvas) return this.serializePanelCanvas(el._panelGroup, el._panelChildren, i, sr.w, sr.contentH);
          return this.serializeElement(el, i, sr.w, sr.contentH);
        })
    });
  }

  // Serializes a `data-ue-panel` container into a JSON CanvasPanel entry
  // matching the T3D `genPanelCanvasPanel` structure: the panel itself
  // occupies a slot in the parent canvas at its measured bbox; child
  // widgets are placed inside with PANEL-RELATIVE coordinates (parent canvas
  // for layout-data computation is the panel itself, so its width/height
  // are passed as `parentW/parentH` for the children).
  // `parentOffsetX/Y` are the ABSOLUTE coords of the immediately-enclosing
  // panel/scroll container, used ONLY to convert this panel's own slot
  // (anchors/offsets/position) into parent-relative space. They default
  // to 0 for a panel sitting at root canvas (whose coords are already
  // root-relative).
  //
  // The panel's own coords (`pg.x`, `pg.y`) and its children's coords
  // (`child.x`, `child.y`) ALL stay absolute throughout the recursion —
  // each call subtracts its OWN absolute panel offset from its children
  // to produce panel-local slot positions. An earlier version of this
  // method pre-translated `pg` to parent-relative before recursing, which
  // broke nested-panel coords because the recursive call then subtracted
  // a parent-relative panel offset from absolute child coords (the inner
  // panel's children landed at random offsets — exactly the prison-lobby
  // `LeftPanel` content-misplacement bug).
  serializePanelCanvas(pg, children, index, parentW, parentH, parentOffsetX = 0, parentOffsetY = 0) {
    const pw = parentW !== undefined ? parentW : this.data.resW;
    const ph = parentH !== undefined ? parentH : this.data.resH;
    // Slot coordinates: parent-relative position of THIS panel inside
    // whatever container is hosting it.
    const slotX = pg.x - parentOffsetX;
    const slotY = pg.y - parentOffsetY;
    const ld = computeCanvasLayoutData({ x: slotX, y: slotY, w: pg.w, h: pg.h }, pw, ph);
    const sortedChildren = children
      .map((c, i) => ({ c, i }))
      .sort((a, b) => {
        const az = a.c.zIndex !== undefined ? a.c.zIndex : 0;
        const bz = b.c.zIndex !== undefined ? b.c.zIndex : 0;
        return az !== bz ? az - bz : a.i - b.i;
      })
      .map(x => x.c);
    // Children translation uses THIS panel's ABSOLUTE coord. Children's
    // own coords are also absolute, so subtraction gives panel-local.
    const offsetX = pg.x;
    const offsetY = pg.y;
    const panelDefaultOpen = !!pg.defaultOpen;
    const panelDefaultVisibility = panelDefaultOpen ? 'SelfHitTestInvisible' : 'Collapsed';
    return stripUndefined({
      id: 'Panel_' + pg.name,
      type: 'CanvasPanel',
      visibility: panelDefaultVisibility,
      selfHitTestInvisible: true,
      lockedInDesigner: true,
      panel: {
        sourceName: pg.name,
        defaultOpen: panelDefaultOpen,
        // Initial runtime visibility for the imported panel widget.
        defaultVisibility: panelDefaultVisibility,
        // Target visibility values for toggle flows. Closed panels should
        // reopen as pass-through canvases so their children stay interactive.
        openVisibility: 'SelfHitTestInvisible',
        closedVisibility: 'Collapsed'
      },
      canvasSlot: {
        anchors: {
          minimum: { x: ld.anchors.minX, y: ld.anchors.minY },
          maximum: { x: ld.anchors.maxX, y: ld.anchors.maxY }
        },
        offsets: {
          left: this.toUEFloat(ld.offsets.left),
          top: this.toUEFloat(ld.offsets.top),
          right: this.toUEFloat(ld.offsets.right),
          bottom: this.toUEFloat(ld.offsets.bottom)
        },
        position: { x: this.toUEFloat(slotX), y: this.toUEFloat(slotY) },
        size: { width: this.toUEFloat(pg.w), height: this.toUEFloat(pg.h) },
        zOrder: pg.zIndex !== undefined ? Math.round(pg.zIndex) : index
      },
      children: sortedChildren.map((child, i) => {
        // Three child shapes are possible inside a panel: regular widget
        // entries (translate coords + delegate to serializeElement);
        // scroll-region entries (`_isScrollBox: true`) hosted in the panel
        // because their source scroll container sat inside the panel —
        // we delegate to serializeScrollBox with a panel-relative copy of
        // the sr; nested-panel entries (`_isPanelCanvas: true`). All
        // cases pass the panel's own w/h as the parent dimensions so
        // anchors/offsets resolve in panel-local coordinate space.
        if (child._isScrollBox) {
          const sr = child._scrollRegion;
          const translatedSr = { ...sr, x: sr.x - offsetX, y: sr.y - offsetY };
          return this.serializeScrollBox(translatedSr, child._scrollChildren || [], i, pg.w, pg.h);
        }
        if (child._isPanelCanvas) {
          const innerPg = child._panelGroup;
          // Pass innerPg AS-IS (absolute coords). The recursive call will
          // subtract `offsetX/offsetY` (this panel's absolute coords) when
          // computing its own slot, and use innerPg.x as the offset for
          // translating ITS children. This keeps coord math correct at
          // any nesting depth.
          return this.serializePanelCanvas(innerPg, child._panelChildren || [], i, pg.w, pg.h, offsetX, offsetY);
        }
        const translatedChild = { ...child, x: child.x - offsetX, y: child.y - offsetY };
        return this.serializeElement(translatedChild, i, pg.w, pg.h);
      })
    });
  }

  exportString() {
    return JSON.stringify(this.exportObject(), null, 2);
  }

  serializeBrushState({ tintColor = null, texturePath = null, drawAs = null, imageSize = null, outline = null, margins = null }) {
    return stripUndefined({
      tintColor: tintColor ? serializeColorForJson(tintColor) : undefined,
      texturePath: texturePath || undefined,
      drawAs,
      imageSize,
      outline,
      margins
    });
  }

  buildOutline(el, widthOverride = null, fallbackColor = null) {
    const outlineColor = el.borderColor || fallbackColor || null;
    return stripUndefined({
      cornerRadii: {
        x: this.toUEFloat(el.borderRadius || 0),
        y: this.toUEFloat(el.borderRadius || 0),
        z: this.toUEFloat(el.borderRadius || 0),
        w: this.toUEFloat(el.borderRadius || 0)
      },
      roundingType: 'FixedRadius',
      color: outlineColor ? serializeColorForJson(outlineColor) : undefined,
      width: el.borderColor ? this.toUEFloat(widthOverride !== null ? widthOverride : el.borderWidth) : undefined
    });
  }

  serializeImageBrush(el) {
    if (el._isBorderFrame) {
      const m = el.borderFrameMargin || 0.1;
      return this.serializeBrushState({
        tintColor: el.borderFrameColor,
        texturePath: el.borderFrameTexturePath,
        drawAs: 'Border',
        imageSize: { width: 10, height: 10 },
        margins: { left: m, top: m, right: m, bottom: m }
      });
    }
    const hasGradient = !!el.gradientTexturePath;
    const allowRounded = !hasCustomShapeBrush(el);
    const drawAs = hasGradient
      ? ((allowRounded && (el.engineRoundedCorners || el.borderRadius > 0 || (el.borderColor && el.borderWidth > 0))) ? 'RoundedBox' : undefined)
      : ((allowRounded && el.borderRadius > 0) ? 'RoundedBox' : undefined);
    const fallback = el.bgColor || null;
    const outline = hasGradient
      ? ((allowRounded && (el.engineRoundedCorners || el.borderRadius > 0 || (el.borderColor && el.borderWidth > 0))) ? this.buildOutline(el, null, fallback) : undefined)
      : ((allowRounded && el.borderRadius > 0) ? this.buildOutline(el, null, fallback) : undefined);
    const texturePath = el.texturePath || el.gradientTexturePath || undefined;
    // For non-gradient, non-textured Images with NO bg color (border-only
    // frames like `.panel-frame`), force a transparent tint so plugins
    // that fall back to UMG's default white brush don't paint a solid
    // white plate over the page background — same reason as the T3D
    // exporter's alpha-0 TintColor in `genImage`.
    let tintColor;
    if (hasGradient) {
      tintColor = el.gridTintColor || undefined;
    } else if (el.bgColor) {
      tintColor = el.bgColor;
    } else if (!el.texturePath) {
      tintColor = { r: 0, g: 0, b: 0, a: 0 };
    } else {
      tintColor = undefined;
    }

    return this.serializeBrushState({
      tintColor,
      texturePath,
      drawAs,
      imageSize: { width: this.toUEFloat(el.w), height: this.toUEFloat(el.h) },
      outline
    });
  }

  serializeButtonState(el, mode) {
    const bg = el.bgColor || { r: 40, g: 40, b: 40, a: 1 };
    const hasGradient = !!el.gradientTexturePath;
    const allowRounded = !hasCustomShapeBrush(el);
    const gradientRounded = allowRounded && (el.engineRoundedCorners || el.borderRadius > 0 || (el.borderColor && el.borderWidth > 0));
    const nonGradientDrawAs = (allowRounded && (mode === 'disabled' || el.borderRadius > 0 || (el.borderColor && el.borderWidth > 0)))
      ? 'RoundedBox'
      : undefined;

    // stateColor mirrors the `c` parameter in genButton.makeState()
    let stateColor;
    if (mode === 'hovered') stateColor = lightenColor(bg, 0.15);
    else if (mode === 'pressed') stateColor = darkenColor(bg, 0.7);
    else if (mode === 'disabled') stateColor = darkenColor(bg, 0.4);
    else stateColor = bg;

    // tintColor: for gradients = white (texture supplies color), for solids = stateColor
    const tintColor = hasGradient ? { r: 255, g: 255, b: 255, a: 1 } : stateColor;

    return this.serializeBrushState({
      tintColor,
      texturePath: hasGradient ? el.gradientTexturePath : undefined,
      drawAs: hasGradient ? (gradientRounded ? 'RoundedBox' : undefined) : nonGradientDrawAs,
      imageSize: { width: this.toUEFloat(el.w), height: this.toUEFloat(el.h) },
      outline: hasGradient
        ? (gradientRounded ? this.buildOutline(el, null, stateColor) : undefined)
        : ((allowRounded && (el.borderRadius > 0 || (el.borderColor && el.borderWidth > 0))) ? this.buildOutline(el, null, stateColor) : undefined)
    });
  }

  serializeComboBoxState(el, mode) {
    const bg = el.bgColor || { r: 30, g: 30, b: 30, a: 1 };
    const tintColor = mode === 'hovered' ? lightenColor(bg, 0.15) : bg;
    return this.serializeBrushState({
      tintColor,
      outline: el.borderColor && el.borderWidth > 0 ? this.buildOutline(el, el.borderWidth * 0.5) : undefined
    });
  }

  serializeEditableTextState(el, mode) {
    const bg = el.bgColor || { r: 30, g: 30, b: 30, a: 1 };
    const tintColor = mode === 'hovered' ? lightenColor(bg, 0.1) : bg;
    const outline = el.borderRadius > 0 ? {
      cornerRadii: {
        x: this.toUEFloat(el.borderRadius), y: this.toUEFloat(el.borderRadius),
        z: this.toUEFloat(el.borderRadius), w: this.toUEFloat(el.borderRadius)
      },
      roundingType: 'FixedRadius',
      color: serializeColorForJson(tintColor),
      // Match genEditableTextBox: Width=max(1,borderWidth) to smooth RoundedBox AA
      width: Math.max(1, el.borderWidth || 0)
    } : undefined;
    return this.serializeBrushState({
      tintColor,
      drawAs: 'RoundedBox',
      imageSize: { width: this.toUEFloat(el.w), height: this.toUEFloat(el.h) },
      margins: { left: 0, top: 0, right: 0, bottom: 0 },
      outline
    });
  }

  serializeElement(el, index, parentW, parentH) {
    const pw = parentW !== undefined ? parentW : this.data.resW;
    const ph = parentH !== undefined ? parentH : this.data.resH;
    const ld = computeCanvasLayoutData(el, pw, ph);
    const base = {
      id: el.name,
      type: el.ueType,
      // HTML-derived rename hint. The plugin can use this to give the imported
      // UMG widget a semantic name (e.g. rename `Button_0` to `Button_cta`).
      // Multiple widgets emitted from the same source element share the same
      // hint — the plugin disambiguates by `type` + traversal order.
      suggestedWidgetName: el.suggestedWidgetName || undefined,
      canvasSlot: {
        anchors: {
          minimum: { x: ld.anchors.minX, y: ld.anchors.minY },
          maximum: { x: ld.anchors.maxX, y: ld.anchors.maxY }
        },
        offsets: {
          left: this.toUEFloat(ld.offsets.left),
          top: this.toUEFloat(ld.offsets.top),
          right: this.toUEFloat(ld.offsets.right),
          bottom: this.toUEFloat(ld.offsets.bottom)
        },
        position: { x: this.toUEFloat(el.x), y: this.toUEFloat(el.y) },
        size: { width: this.toUEFloat(el.w), height: this.toUEFloat(el.h) },
        autoSize: this.getEffectiveCanvasAutoSize(el),
        zOrder: el.zIndex !== undefined ? Math.round(el.zIndex) : index
      },
      tooltip: el.tooltip || undefined,
      renderTransform: (el.renderAngle || el.renderScale) ? stripUndefined({
        angle: el.renderAngle || undefined,
        scale: el.renderScale ? { x: el.renderScale.x.toFixed(6), y: el.renderScale.y.toFixed(6) } : undefined,
        pivot: { x: '0.500000', y: '0.500000' }
      }) : undefined,
      // CSS @keyframes animations resolved against this widget. See
      // `_extractElementAnimations` for the full schema. Plugin generates
      // one `UWidgetAnimation` per entry per widget (UMG has no shared-
      // animation concept like CSS class application). Omitted entirely
      // when the source element has no animation-name.
      animations: (el.animations && el.animations.length) ? el.animations : undefined,
      visibility: getUeVisibilityStateForWidget(el),
      // CSS `pointer-events: none` → UMG `bIsHitTestVisible = False`.
      // Plugin sets the widget's `bIsHitTestVisible` flag accordingly so
      // translucent overlay decorations (shines, vignettes, scanlines)
      // don't swallow clicks meant for buttons below them. Field is
      // `interactivity.hitTestVisible` (boolean, defaults to true when
      // omitted) for forward-compat with future interactivity flags.
      // Image and TextBlock are decorative-only → always HitTestInvisible
      interactivity: isInteractiveUeWidgetType(el.ueType)
        ? undefined
        : { hitTestVisible: false },
      style: undefined,
      children: []
    };

    switch (el.ueType) {
      case 'TextBlock':
        base.style = stripUndefined({
          textColor: this.getEffectiveTextColor(el.color, true)
        });
        base.text = {
          value: el.text || '',
          fontSize: this.toUEFontSize(el.fontSize),
          fontWeight: el.fontWeight || undefined,
          fontFamily: el.fontFamily || undefined,
          justification: this.getTextJustification(el.textAlign),
          autoSize: !!el.autoSize,
          letterSpacing: el.letterSpacing ? (this.toUEInt(el.letterSpacing) || undefined) : undefined,
          shadow: el.textShadow ? {
            offset: { x: this.toUEFloat(el.textShadow.offsetX), y: this.toUEFloat(el.textShadow.offsetY) },
            color: serializeColorForJson(el.textShadow.color)
          } : undefined
        };
        break;
      case 'Image':
        base.style = stripUndefined({
          renderOpacity: (el.opacity !== undefined && el.opacity < 1) ? this.toUEFloat(el.opacity) : undefined
        });
        base.image = {
          resourcePath: el.texturePath || el.gradientTexturePath || el.borderFrameTexturePath || undefined,
          brush: this.serializeImageBrush(el)
        };
        break;
      case 'Button':
        {
        const hasButtonText = !!String(el.text || '').trim();
        base.button = {
          text: el.text || '',
          textBlockName: hasButtonText ? el.textBlockName : undefined,
          fontSize: this.toUEFontSize(el.fontSize),
          fontWeight: el.fontWeight || undefined,
          fontFamily: el.fontFamily || undefined,
          horizontalAlignment: this.getEffectiveButtonHorizontalAlignment(el),
          verticalAlignment: this.getEffectiveButtonVerticalAlignment(el),
          padding: {
            left: this.toUEFloat(el.textPadLeft || 0),
            top: 0,
            right: this.toUEFloat(el.textPadRight || 0),
            bottom: 0
          },
          useBrushTransparency: !((el.borderColor && el.borderWidth > 0) || el.borderRadius > 0 || el.gradientTexturePath),
          // `toggleTarget` (when set) names the panel this button is meant
          // to toggle. The plugin can read this to optionally pre-create
          // the OnClicked → SetVisibility wiring in the imported Blueprint
          // (or just leave a documentation note for the developer).
          toggleTarget: el.toggleTarget ? ('Panel_' + el.toggleTarget) : undefined,
          states: {
            normal: this.serializeButtonState(el, 'normal'),
            hovered: this.serializeButtonState(el, 'hovered'),
            pressed: this.serializeButtonState(el, 'pressed'),
            disabled: this.serializeButtonState(el, 'disabled')
          }
        };
        base.button = stripUndefined(base.button);
        if (hasButtonText) {
          base.children.push(stripUndefined({
            id: el.textBlockName,
            type: 'TextBlock',
            text: {
              value: el.text || '',
              fontSize: this.toUEFontSize(el.fontSize),
              fontWeight: el.fontWeight || undefined,
              fontFamily: el.fontFamily || undefined,
              justification: 'Center',
              shadow: el.textShadow ? {
                offset: { x: this.toUEFloat(el.textShadow.offsetX), y: this.toUEFloat(el.textShadow.offsetY) },
                color: serializeColorForJson(el.textShadow.color)
              } : undefined
            },
            style: stripUndefined({
              textColor: this.getEffectiveTextColor(el.textColor, true)
            })
          }));
        }
        break;
        }
      case 'EditableTextBox':
        {
          const effectiveTextColor = el.textColor || { r: 255, g: 255, b: 255, a: 1 };
        base.input = {
          placeholder: el.placeholder || undefined,
          isPassword: el.isPassword || undefined,
          fontSize: this.toUEFontSize(el.fontSize),
          textStyle: stripUndefined({
            fontSize: this.toUEFontSize(el.fontSize),
            textColor: serializeColorForJson(effectiveTextColor)
          }),
          states: {
            normal: this.serializeEditableTextState(el, 'normal'),
            hovered: this.serializeEditableTextState(el, 'hovered'),
            focused: this.serializeEditableTextState(el, 'focused')
          }
        };
        }
        break;
      case 'CheckBox': {
        // `hasCustomStyle` flips true when EITHER `background-color` OR
        // `accent-color` was set in CSS — the plugin uses this to decide
        // whether to emit a custom `FCheckBoxStyle` or fall back to the
        // engine default. `accentColor` is the resolved tint for the
        // CheckedImage (the visible tick), see `genCheckBox` for the T3D
        // counterpart that consumes the same field.
        //
        // Backward-compat with plugins that haven't been updated to read
        // `accentColor` yet: when the author only set `accent-color` in
        // CSS (no `background-color`), copy the accent into `bgColor` as
        // a fallback so OLD plugins still tint the checkbox in the
        // brand color (UncheckedImage will be accent-tinted, which is
        // imperfect but preserves the orange-ness the user expected
        // pre-update). NEW plugins read `accentColor` directly and
        // restore the correct semantics (transparent unchecked, accent
        // checked). Without this fallback, the user-reported regression
        // happens: hasCustomStyle flips true → plugin tries to emit
        // WidgetStyle from a missing bgColor → black/null tint.
        const effectiveBgColor = el.bgColor || el.accentColor || null;
        base.checkBox = stripUndefined({
          checked: !!el.checked,
          hasCustomStyle: !!(el.bgColor || el.accentColor),
          bgColor: effectiveBgColor ? serializeColorForJson(effectiveBgColor) : undefined,
          accentColor: el.accentColor ? serializeColorForJson(el.accentColor) : undefined,
          // Marker so an updated plugin can distinguish "author actually
          // set bg" from "we forwarded the accent into bg for compat".
          // Old plugins ignore unknown fields safely. New plugins use
          // `bgColor` only when `bgIsAccentFallback` is false, otherwise
          // they pull from `accentColor` and treat the unchecked image
          // as transparent.
          bgIsAccentFallback: (!el.bgColor && !!el.accentColor) ? true : undefined,
          borderColor: el.borderColor ? serializeColorForJson(el.borderColor) : undefined,
          borderWidth: el.borderWidth || undefined,
          borderRadius: el.borderRadius || undefined
        });
        break;
      }
      case 'ComboBoxString':
        {
          const effectiveTextColor = el.textColor || { r: 255, g: 255, b: 255, a: 1 };
        base.comboBox = {
          options: el.options || [],
          selectedOption: el.selectedOption || undefined,
          fontSize: this.toUEFontSize(el.fontSize),
          itemTextColor: serializeColorForJson(effectiveTextColor),
          foregroundColor: serializeColorForJson(effectiveTextColor),
          states: {
            normal: this.serializeComboBoxState(el, 'normal'),
            hovered: this.serializeComboBoxState(el, 'hovered'),
            pressed: this.serializeComboBoxState(el, 'pressed')
          }
        };
        }
        break;
      case 'Slider':
        base.slider = stripUndefined({
          value: el.value !== undefined ? Number(el.value.toFixed(6)) : 0,
          stepSize: el.stepSize ? Number(el.stepSize.toFixed(6)) : undefined,
          barColor: el.barColor ? serializeColorForJson(el.barColor) : undefined,
          fillColor: el.fillColor ? serializeColorForJson(el.fillColor) : undefined,
          thumbColor: el.thumbColor ? serializeColorForJson(el.thumbColor) : undefined,
          // Optional thumb styling captured from `::-webkit-slider-thumb`
          // / `::-moz-range-thumb`. The plugin should stamp these onto
          // `WidgetStyle.NormalThumbImage` (and the hovered/disabled
          // variants) — when absent, fall back to the previous behavior
          // (TintColor-only thumb, no outline / radius).
          thumbBorderColor: el.thumbBorderColor ? serializeColorForJson(el.thumbBorderColor) : undefined,
          thumbBorderWidth: el.thumbBorderWidth || undefined,
          thumbBorderRadius: el.thumbBorderRadius || undefined,
          thumbAngle: el.thumbAngle || undefined,
          thumbSize: (el.thumbW && el.thumbH) ? {
            width: Number((+el.thumbW).toFixed(6)),
            height: Number((+el.thumbH).toFixed(6))
          } : undefined,
          barThickness: Number(Math.max((el.h || 20) * 0.3, 4).toFixed(6))
        });
        break;
      case 'ProgressBar':
        base.progressBar = stripUndefined({
          percent: el.percent !== undefined ? Number(el.percent.toFixed(6)) : 0,
          bgColor: el.bgColor ? serializeColorForJson(el.bgColor) : undefined,
          fillColor: el.fillColor ? serializeColorForJson(el.fillColor) : undefined
        });
        break;
      case 'ExpandableArea':
        base.header = stripUndefined({
          text: el.summaryText || '',
          fontSize: this.toUEFontSize(el.summaryFontSize),
          fontWeight: el.summaryFontWeight || undefined,
          textColor: el.summaryColor ? serializeColorForJson(el.summaryColor) : undefined,
          backgroundColor: el.summaryBgColor ? serializeColorForJson(el.summaryBgColor) : undefined,
          borderColor: el.summaryBorderColor ? serializeColorForJson(el.summaryBorderColor) : undefined,
          borderWidth: el.summaryBorderWidth ? Number(el.summaryBorderWidth.toFixed(6)) : undefined,
          borderRadius: el.summaryBorderRadius ? Number(el.summaryBorderRadius.toFixed(6)) : undefined,
          padding: ((el.summaryPadLeft || el.summaryPadRight) ? {
            left: Number((el.summaryPadLeft || 0).toFixed(6)),
            right: Number((el.summaryPadRight || 0).toFixed(6))
          } : undefined),
          arrowText: el.summaryArrowText || undefined,
          arrowColor: el.summaryArrowColor ? serializeColorForJson(el.summaryArrowColor) : undefined,
          indicator: (
            String(el.summaryCollapsedArrowText || '').trim() ||
            String(el.summaryExpandedArrowText || '').trim()
          ) ? stripUndefined({
            placement: 'right',
            source: 'summary::after',
            collapsed: stripUndefined({
              text: el.summaryCollapsedArrowText || undefined,
              color: el.summaryCollapsedArrowColor ? serializeColorForJson(el.summaryCollapsedArrowColor) : undefined
            }),
            expanded: stripUndefined({
              text: el.summaryExpandedArrowText || undefined,
              color: el.summaryExpandedArrowColor ? serializeColorForJson(el.summaryExpandedArrowColor) : undefined
            }),
            activeState: el.isExpanded ? 'expanded' : 'collapsed'
          }) : undefined,
          rect: el.summaryRect ? {
            x: Number((el.summaryRect.x || 0).toFixed(6)),
            y: Number((el.summaryRect.y || 0).toFixed(6)),
            w: Number((el.summaryRect.w || 0).toFixed(6)),
            h: Number((el.summaryRect.h || 0).toFixed(6))
          } : undefined
        });
        base.isExpanded = !!el.isExpanded;
        base.children = (el.bodyElements || []).map((child, i) => this.serializeElement(child, i, el.w, el.h));
        break;
      default:
        break;
    }

    return stripUndefined(base);
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatJsonUEFloat(value, precision = 6) {
  return Number(value || 0).toFixed(precision);
}

function formatJsonUEColor(color) {
  if (!color || !color.ueLinear) return '(R=0.000000,G=0.000000,B=0.000000,A=1.000000)';
  return `(R=${formatJsonUEFloat(color.ueLinear.r)},G=${formatJsonUEFloat(color.ueLinear.g)},B=${formatJsonUEFloat(color.ueLinear.b)},A=${formatJsonUEFloat(color.ueLinear.a)})`;
}

function formatJsonTextureRef(texturePath) {
  const assetName = String(texturePath || '').split('/').pop();
  return `/Script/Engine.Texture2D'"${texturePath}.${assetName}"'`;
}

function escapeForNsLocText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function escapeForQuotedString(value) {
  return String(value || '').replace(/"/g, '\\"');
}

function formatJsonRoundedOutline(outline) {
  if (!outline) return '';
  let result = `CornerRadii=(X=${formatJsonUEFloat(outline.cornerRadii?.x)},Y=${formatJsonUEFloat(outline.cornerRadii?.y)},Z=${formatJsonUEFloat(outline.cornerRadii?.z)},W=${formatJsonUEFloat(outline.cornerRadii?.w)}),RoundingType=FixedRadius`;
  if (outline.color) {
    result += `,Color=(SpecifiedColor=${formatJsonUEColor(outline.color)})`;
    if (outline.width !== undefined && outline.width !== null) {
      result += `,Width=${formatJsonUEFloat(outline.width)}`;
    }
  }
  return result;
}

function formatJsonComboOutline(outline) {
  if (!outline) return '';
  return `CornerRadii=(X=${formatJsonUEFloat(outline.cornerRadii?.x)},Y=${formatJsonUEFloat(outline.cornerRadii?.y)},Z=${formatJsonUEFloat(outline.cornerRadii?.z)},W=${formatJsonUEFloat(outline.cornerRadii?.w)}),Color=(SpecifiedColor=${formatJsonUEColor(outline.color)}),Width=${formatJsonUEFloat(outline.width)},RoundingType=FixedRadius`;
}

function buildButtonStateString(state) {
  const s = state || {};
  const parts = [];
  if (s.drawAs === 'RoundedBox') parts.push('DrawAs=RoundedBox');
  if (s.texturePath) {
    parts.push(`TintColor=(SpecifiedColor=${formatJsonUEColor(s.tintColor)})`);
    parts.push(`ImageSize=(X=${formatJsonUEFloat(s.imageSize?.width)},Y=${formatJsonUEFloat(s.imageSize?.height)})`);
    if (s.outline) parts.push(`OutlineSettings=(${formatJsonRoundedOutline(s.outline)})`);
    parts.push(`ResourceObject=${formatJsonTextureRef(s.texturePath)}`);
  } else {
    if (s.imageSize) parts.push(`ImageSize=(X=${formatJsonUEFloat(s.imageSize.width)},Y=${formatJsonUEFloat(s.imageSize.height)})`);
    if (s.tintColor) parts.push(`TintColor=(SpecifiedColor=${formatJsonUEColor(s.tintColor)})`);
    if (s.outline) parts.push(`OutlineSettings=(${formatJsonRoundedOutline(s.outline)})`);
  }
  return `(${parts.join(',')})`;
}

function buildImageBrushString(image) {
  const brush = image?.brush || {};
  const parts = [];
  if (brush.drawAs === 'RoundedBox') parts.push('DrawAs=RoundedBox');
  else if (brush.drawAs === 'Border') parts.push('DrawAs=Border');
  if (brush.imageSize) parts.push(`ImageSize=(X=${formatJsonUEFloat(brush.imageSize.width)},Y=${formatJsonUEFloat(brush.imageSize.height)})`);
  if (brush.margins) parts.push(`Margin=(Left=${formatJsonUEFloat(brush.margins.left)},Top=${formatJsonUEFloat(brush.margins.top)},Right=${formatJsonUEFloat(brush.margins.right)},Bottom=${formatJsonUEFloat(brush.margins.bottom)})`);
  if (brush.tintColor) parts.push(`TintColor=(SpecifiedColor=${formatJsonUEColor(brush.tintColor)})`);
  if (brush.outline) parts.push(`OutlineSettings=(${formatJsonRoundedOutline(brush.outline)})`);
  if (image?.resourcePath) parts.push(`ResourceObject=${formatJsonTextureRef(image.resourcePath)}`);
  return `Brush=(${parts.join(',')})`;
}

function buildEditableTextStateString(state) {
  const s = state || {};
  let result = `(DrawAs=RoundedBox,ImageSize=(X=${formatJsonUEFloat(s.imageSize?.width)},Y=${formatJsonUEFloat(s.imageSize?.height)}),Margin=(Left=0.000000,Top=0.000000,Right=0.000000,Bottom=0.000000),TintColor=(SpecifiedColor=${formatJsonUEColor(s.tintColor)})`;
  if (s.outline) {
    result += `,OutlineSettings=(${formatJsonRoundedOutline(s.outline)})`;
  }
  result += ')';
  return result;
}

function buildComboBoxStateString(state) {
  const s = state || {};
  const parts = [`TintColor=(SpecifiedColor=${formatJsonUEColor(s.tintColor)})`];
  if (s.outline) parts.push(`OutlineSettings=(${formatJsonComboOutline(s.outline)})`);
  return `(${parts.join(',')})`;
}

function getObjectBlock(widgetCode, className, objectName) {
  const startNeedle = `Begin Object Class=/Script/UMG.${className} Name="${objectName}"`;
  const lines = String(widgetCode || '').split(/\r?\n/);
  const startIndex = lines.findIndex(line => line.includes(startNeedle));
  if (startIndex < 0) return '';

  let depth = 0;
  const block = [];
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('Begin Object')) depth++;
    if (depth > 0) block.push(line);
    if (line.trim() === 'End Object') {
      depth--;
      if (depth === 0) break;
    }
  }

  return block.join('\n');
}

function getCanvasSlotBlock(widgetCode, index) {
  const rx = new RegExp(`Begin Object Name="CanvasPanelSlot_${index}"[\\s\\S]*?End Object`);
  return widgetCode.match(rx)?.[0] || '';
}

function getCanvasSlotBlockByContentId(widgetCode, contentId) {
  // Tempered greedy: (?:(?!End Object)[\s\S])*? prevents crossing a slot boundary
  // before the Content= line is found, so a TextBlock slot's bAutoSize=True
  // cannot bleed into an adjacent Image slot's match.
  const rx = new RegExp(
    `Begin Object Name="CanvasPanelSlot_\\d+"` +
    `(?:(?!End Object)[\\s\\S])*?` +
    `Content=/Script/UMG\\.[A-Za-z]+'"${escapeRegExp(contentId)}"'` +
    `[\\s\\S]*?End Object`
  );
  return widgetCode.match(rx)?.[0] || '';
}

function validateWidgetJsonParity(widgetCode, jsonObject) {
  const issues = [];
  const actualChildren = jsonObject.root?.children || [];

  actualChildren.forEach((jsonEl, index) => {
    // ScrollBox / ExpandableArea have their own nested structure; validate block existence only.
    // ExpandableArea is implemented as a CanvasPanel container (see genExpandableArea), so we
    // look for the CanvasPanel block by name.
    if (jsonEl.type === 'ScrollBox') {
      const block = getObjectBlock(widgetCode, 'ScrollBox', jsonEl.id);
      if (!block) issues.push(`Missing ScrollBox block for ${jsonEl.id}`);
      return;
    }
    if (jsonEl.type === 'ExpandableArea') {
      const block = getObjectBlock(widgetCode, 'CanvasPanel', jsonEl.id);
      if (!block) issues.push(`Missing ExpandableArea (CanvasPanel) block for ${jsonEl.id}`);
      return;
    }
    // `data-ue-panel` containers are emitted as their own CanvasPanel
    // blocks. We verify the block exists, the slot's anchor/offset
    // geometry matches, and the recorded `Visibility` line is present.
    // Children inside the panel use panel-relative coords (the JSON
    // exporter's `serializePanelCanvas` already translates them) so they
    // are NOT validated against the root widget code here — that would
    // require reaching into the panel's nested CanvasPanelSlot blocks
    // and the existing helpers don't support that yet. Catching slot/
    // visibility drift on the panel container is enough to detect
    // exporter divergence in practice.
    if (jsonEl.type === 'CanvasPanel' && jsonEl.panel) {
      const block = getObjectBlock(widgetCode, 'CanvasPanel', jsonEl.id);
      if (!block) {
        issues.push(`Missing Panel CanvasPanel block for ${jsonEl.id}`);
        return;
      }
      const expectedVis = jsonEl.panel.defaultVisibility === 'SelfHitTestInvisible'
        ? 'Visibility=ESlateVisibility::SelfHitTestInvisible'
        : jsonEl.panel.defaultVisibility === 'Visible'
          ? 'Visibility=ESlateVisibility::Visible'
          : 'Visibility=ESlateVisibility::Collapsed';
      if (!block.includes(expectedVis)) {
        issues.push(`Panel default visibility drift for ${jsonEl.id}`);
      }
      // Validate the slot in the parent canvas matches the JSON layout.
      const slotBlockPanel = getCanvasSlotBlockByContentId(widgetCode, jsonEl.id);
      if (!slotBlockPanel) {
        issues.push(`Missing CanvasPanelSlot for panel ${jsonEl.id}`);
      } else {
        const a = jsonEl.canvasSlot?.anchors || { minimum: { x: 0, y: 0 }, maximum: { x: 0, y: 0 } };
        const expectedLayout = `LayoutData=(Offsets=(Left=${formatJsonUEFloat(jsonEl.canvasSlot?.offsets?.left)},Top=${formatJsonUEFloat(jsonEl.canvasSlot?.offsets?.top)},Right=${formatJsonUEFloat(jsonEl.canvasSlot?.offsets?.right)},Bottom=${formatJsonUEFloat(jsonEl.canvasSlot?.offsets?.bottom)}),Anchors=(Minimum=(X=${formatJsonUEFloat(a.minimum.x)},Y=${formatJsonUEFloat(a.minimum.y)}),Maximum=(X=${formatJsonUEFloat(a.maximum.x)},Y=${formatJsonUEFloat(a.maximum.y)})))`;
        if (!slotBlockPanel.includes(expectedLayout)) {
          issues.push(`Panel canvas slot layout drift for ${jsonEl.id}`);
        }
      }
      return;
    }

    const slotBlock = getCanvasSlotBlockByContentId(widgetCode, jsonEl.id) || getCanvasSlotBlock(widgetCode, index);
    if (!slotBlock) {
      issues.push(`Missing CanvasPanelSlot for ${jsonEl.id}`);
      return;
    }

    const a = jsonEl.canvasSlot?.anchors || { minimum: { x: 0, y: 0 }, maximum: { x: 0, y: 0 } };
    const expectedLayout = `LayoutData=(Offsets=(Left=${formatJsonUEFloat(jsonEl.canvasSlot?.offsets?.left)},Top=${formatJsonUEFloat(jsonEl.canvasSlot?.offsets?.top)},Right=${formatJsonUEFloat(jsonEl.canvasSlot?.offsets?.right)},Bottom=${formatJsonUEFloat(jsonEl.canvasSlot?.offsets?.bottom)}),Anchors=(Minimum=(X=${formatJsonUEFloat(a.minimum.x)},Y=${formatJsonUEFloat(a.minimum.y)}),Maximum=(X=${formatJsonUEFloat(a.maximum.x)},Y=${formatJsonUEFloat(a.maximum.y)})))`;
    if (!slotBlock.includes(expectedLayout)) {
      issues.push(`Canvas slot layout drift for ${jsonEl.id}`);
    }

    const hasAutoSizeLine = slotBlock.includes('bAutoSize=True');
    if (hasAutoSizeLine !== !!jsonEl.canvasSlot?.autoSize) {
      issues.push(`Canvas slot autoSize drift for ${jsonEl.id}`);
    }

    if (jsonEl.type === 'TextBlock') {
      const block = getObjectBlock(widgetCode, 'TextBlock', jsonEl.id);
      if (!block) {
        issues.push(`Missing TextBlock block for ${jsonEl.id}`);
        return;
      }
      const rt = jsonEl.renderTransform;
      const hasRT = block.includes('RenderTransform=(');
      if (hasRT !== !!rt) issues.push(`RenderTransform presence drift for ${jsonEl.id}`);
      if (rt) {
        const rtParts = [];
        if (rt.scale) rtParts.push(`Scale=(X=${formatJsonUEFloat(rt.scale.x)},Y=${formatJsonUEFloat(rt.scale.y)})`);
        if (rt.angle !== undefined) rtParts.push(`Angle=${formatJsonUEFloat(rt.angle)}`);
        if (!block.includes(`RenderTransform=(${rtParts.join(',')})`)) issues.push(`RenderTransform value drift for ${jsonEl.id}`);
      }
      if (!block.includes(`", "${escapeForNsLocText(jsonEl.text?.value)}")`)) issues.push(`Text value drift for ${jsonEl.id}`);
      if (!block.includes(`Size=${jsonEl.text?.fontSize}`)) issues.push(`Text font size drift for ${jsonEl.id}`);
      if (!!jsonEl.text?.fontWeight !== block.includes('TypefaceFontName=')) issues.push(`Text font weight drift for ${jsonEl.id}`);
      if (jsonEl.text?.fontWeight && !block.includes(`TypefaceFontName="${jsonEl.text.fontWeight}"`)) issues.push(`Text font weight value drift for ${jsonEl.id}`);
      if (!!jsonEl.text?.letterSpacing !== block.includes('LetterSpacing=')) issues.push(`Text letter spacing drift for ${jsonEl.id}`);
      if (jsonEl.text?.letterSpacing !== undefined && !block.includes(`LetterSpacing=${jsonEl.text.letterSpacing}`)) issues.push(`Text letter spacing value drift for ${jsonEl.id}`);
      const hasTextColor = block.includes('ColorAndOpacity=(SpecifiedColor=');
      if (hasTextColor !== !!jsonEl.style?.textColor) issues.push(`Text color presence drift for ${jsonEl.id}`);
      if (jsonEl.style?.textColor && !block.includes(`ColorAndOpacity=(SpecifiedColor=${formatJsonUEColor(jsonEl.style.textColor)})`)) issues.push(`Text color value drift for ${jsonEl.id}`);
      const justification = jsonEl.text?.justification || 'Left';
      if (justification === 'Center' && !block.includes('Justification=Center')) issues.push(`Text justification drift for ${jsonEl.id}`);
      if (justification === 'Right' && !block.includes('Justification=Right')) issues.push(`Text justification drift for ${jsonEl.id}`);
      if (justification === 'Left' && block.includes('Justification=')) issues.push(`Unexpected text justification in widget code for ${jsonEl.id}`);
      const hasShadowLine = block.includes('ShadowOffset=');
      if (hasShadowLine !== !!jsonEl.text?.shadow) issues.push(`Text shadow presence drift for ${jsonEl.id}`);
      if (jsonEl.text?.shadow) {
        const s = jsonEl.text.shadow;
        if (!block.includes(`ShadowOffset=(X=${formatJsonUEFloat(s.offset?.x)},Y=${formatJsonUEFloat(s.offset?.y)})`)) issues.push(`Text shadow offset drift for ${jsonEl.id}`);
        if (!block.includes(`ShadowColorAndOpacity=${formatJsonUEColor(s.color)}`)) issues.push(`Text shadow color drift for ${jsonEl.id}`);
      }
    }

    if (jsonEl.type === 'Image') {
      const block = getObjectBlock(widgetCode, 'Image', jsonEl.id);
      if (!block) {
        issues.push(`Missing Image block for ${jsonEl.id}`);
        return;
      }
      const rt = jsonEl.renderTransform;
      const hasRT = block.includes('RenderTransform=(');
      if (hasRT !== !!rt) issues.push(`RenderTransform presence drift for ${jsonEl.id}`);
      if (rt) {
        const rtParts = [];
        if (rt.scale) rtParts.push(`Scale=(X=${formatJsonUEFloat(rt.scale.x)},Y=${formatJsonUEFloat(rt.scale.y)})`);
        if (rt.angle !== undefined) rtParts.push(`Angle=${formatJsonUEFloat(rt.angle)}`);
        if (!block.includes(`RenderTransform=(${rtParts.join(',')})`)) issues.push(`RenderTransform value drift for ${jsonEl.id}`);
      }
      if (!block.includes(buildImageBrushString(jsonEl.image))) issues.push(`Image brush drift for ${jsonEl.id}`);
      const expectedOpacity = jsonEl.style?.renderOpacity;
      const hasOpacityLine = block.includes('RenderOpacity=');
      if (hasOpacityLine !== (expectedOpacity !== undefined)) issues.push(`Image opacity presence drift for ${jsonEl.id}`);
      if (expectedOpacity !== undefined && !block.includes(`RenderOpacity=${formatJsonUEFloat(expectedOpacity)}`)) issues.push(`Image opacity value drift for ${jsonEl.id}`);
    }

    if (jsonEl.type === 'Button') {
      const block = getObjectBlock(widgetCode, 'Button', jsonEl.id);
      if (!block) {
        issues.push(`Missing Button block for ${jsonEl.id}`);
        return;
      }
      const rt = jsonEl.renderTransform;
      const hasRT = block.includes('RenderTransform=(');
      if (hasRT !== !!rt) issues.push(`RenderTransform presence drift for ${jsonEl.id}`);
      if (rt) {
        const rtParts = [];
        if (rt.scale) rtParts.push(`Scale=(X=${formatJsonUEFloat(rt.scale.x)},Y=${formatJsonUEFloat(rt.scale.y)})`);
        if (rt.angle !== undefined) rtParts.push(`Angle=${formatJsonUEFloat(rt.angle)}`);
        if (!block.includes(`RenderTransform=(${rtParts.join(',')})`)) issues.push(`RenderTransform value drift for ${jsonEl.id}`);
      }
      const child = jsonEl.children?.[0];
      if (child) {
        const padding = jsonEl.button?.padding || {};
        const expectedPadding = `Padding=(Left=${formatJsonUEFloat(padding.left)},Top=0.000000,Right=${formatJsonUEFloat(padding.right)},Bottom=0.000000)`;
        if (!block.includes(expectedPadding)) issues.push(`Button padding drift for ${jsonEl.id}`);
        if (!block.includes(`HorizontalAlignment=${jsonEl.button?.horizontalAlignment}`)) issues.push(`Button horizontal alignment drift for ${jsonEl.id}`);
        if (!block.includes(`VerticalAlignment=${jsonEl.button?.verticalAlignment}`)) issues.push(`Button vertical alignment drift for ${jsonEl.id}`);
      }
      if (!block.includes(`WidgetStyle=(Normal=${buildButtonStateString(jsonEl.button?.states?.normal)},Hovered=${buildButtonStateString(jsonEl.button?.states?.hovered)},Pressed=${buildButtonStateString(jsonEl.button?.states?.pressed)},Disabled=${buildButtonStateString(jsonEl.button?.states?.disabled)})`)) issues.push(`Button widget style drift for ${jsonEl.id}`);
      const hasBrushTransparencyFalse = block.includes('bUseBrushTransparency=False');
      if (hasBrushTransparencyFalse !== (jsonEl.button?.useBrushTransparency === false)) issues.push(`Button brush transparency drift for ${jsonEl.id}`);

      if (child) {
        const childBlock = getObjectBlock(widgetCode, 'TextBlock', child.id);
        if (!childBlock) {
          issues.push(`Missing Button child TextBlock for ${jsonEl.id}`);
        } else {
          if (!childBlock.includes(`", "${escapeForQuotedString(child.text?.value)}")`)) issues.push(`Button child text value drift for ${jsonEl.id}`);
          if (!childBlock.includes(`Size=${child.text?.fontSize}`)) issues.push(`Button child font size drift for ${jsonEl.id}`);
          if (!!child.text?.fontWeight !== childBlock.includes('TypefaceFontName=')) issues.push(`Button child font weight drift for ${jsonEl.id}`);
          if (child.text?.fontWeight && !childBlock.includes(`TypefaceFontName="${child.text.fontWeight}"`)) issues.push(`Button child font weight value drift for ${jsonEl.id}`);
          const childHasColor = childBlock.includes('ColorAndOpacity=(SpecifiedColor=');
          if (childHasColor !== !!child.style?.textColor) issues.push(`Button child text color presence drift for ${jsonEl.id}`);
          if (child.style?.textColor && !childBlock.includes(`ColorAndOpacity=(SpecifiedColor=${formatJsonUEColor(child.style.textColor)})`)) issues.push(`Button child text color value drift for ${jsonEl.id}`);
          if (!childBlock.includes('Justification=Center')) issues.push(`Button child justification drift for ${jsonEl.id}`);
          const hasChildShadow = childBlock.includes('ShadowOffset=');
          if (hasChildShadow !== !!child.text?.shadow) issues.push(`Button child shadow presence drift for ${jsonEl.id}`);
          if (child.text?.shadow) {
            const s = child.text.shadow;
            if (!childBlock.includes(`ShadowOffset=(X=${formatJsonUEFloat(s.offset?.x)},Y=${formatJsonUEFloat(s.offset?.y)})`)) issues.push(`Button child shadow offset drift for ${jsonEl.id}`);
            if (!childBlock.includes(`ShadowColorAndOpacity=${formatJsonUEColor(s.color)}`)) issues.push(`Button child shadow color drift for ${jsonEl.id}`);
          }
        }
      }
    }

    if (jsonEl.type === 'EditableTextBox') {
      const block = getObjectBlock(widgetCode, 'EditableTextBox', jsonEl.id);
      if (!block) {
        issues.push(`Missing EditableTextBox block for ${jsonEl.id}`);
        return;
      }
      const textColor = jsonEl.input?.textStyle?.textColor;
      const expectedStyle = `WidgetStyle=(BackgroundImageNormal=${buildEditableTextStateString(jsonEl.input?.states?.normal)},BackgroundImageHovered=${buildEditableTextStateString(jsonEl.input?.states?.hovered)},BackgroundImageFocused=${buildEditableTextStateString(jsonEl.input?.states?.focused)},TextStyle=(Font=(Size=${jsonEl.input?.textStyle?.fontSize}),ColorAndOpacity=(SpecifiedColor=${formatJsonUEColor(textColor)},ColorUseRule=UseColor_Specified)))`;
      if (!block.includes(expectedStyle)) issues.push(`EditableTextBox widget style drift for ${jsonEl.id}`);
      const hasHint = block.includes('HintText=NSLOCTEXT(');
      if (hasHint !== !!jsonEl.input?.placeholder) issues.push(`EditableTextBox placeholder presence drift for ${jsonEl.id}`);
      if (jsonEl.input?.placeholder && !block.includes(`", "${escapeForQuotedString(jsonEl.input.placeholder)}")`)) issues.push(`EditableTextBox placeholder value drift for ${jsonEl.id}`);
      const hasIsPassword = block.includes('IsPassword=True');
      if (hasIsPassword !== !!jsonEl.input?.isPassword) issues.push(`EditableTextBox IsPassword drift for ${jsonEl.id}`);
    }

    if (jsonEl.type === 'ComboBoxString') {
      const block = getObjectBlock(widgetCode, 'ComboBoxString', jsonEl.id);
      if (!block) {
        issues.push(`Missing ComboBoxString block for ${jsonEl.id}`);
        return;
      }
      const options = jsonEl.comboBox?.options || [];
      options.forEach((opt, optIndex) => {
        if (!block.includes(`DefaultOptions(${optIndex})="${String(opt).replace(/"/g, '\\"')}"`)) {
          issues.push(`ComboBox option drift for ${jsonEl.id}`);
        }
      });
      const hasSelected = block.includes('SelectedOption=');
      if (hasSelected !== !!jsonEl.comboBox?.selectedOption) issues.push(`ComboBox selected option presence drift for ${jsonEl.id}`);
      if (jsonEl.comboBox?.selectedOption && !block.includes(`SelectedOption="${String(jsonEl.comboBox.selectedOption).replace(/"/g, '\\"')}"`)) issues.push(`ComboBox selected option value drift for ${jsonEl.id}`);
      if (!block.includes(`WidgetStyle=(ComboButtonStyle=(ButtonStyle=(Normal=${buildComboBoxStateString(jsonEl.comboBox?.states?.normal)},Hovered=${buildComboBoxStateString(jsonEl.comboBox?.states?.hovered)},Pressed=${buildComboBoxStateString(jsonEl.comboBox?.states?.pressed)})))`)) issues.push(`ComboBox widget style drift for ${jsonEl.id}`);
      if (!block.includes(`Font=(Size=${jsonEl.comboBox?.fontSize})`)) issues.push(`ComboBox font size drift for ${jsonEl.id}`);
      if (!block.includes(`ItemStyle=(TextColor=(SpecifiedColor=${formatJsonUEColor(jsonEl.comboBox?.itemTextColor)}))`)) issues.push(`ComboBox item text color drift for ${jsonEl.id}`);
      if (!block.includes(`ForegroundColor=(SpecifiedColor=${formatJsonUEColor(jsonEl.comboBox?.foregroundColor)})`)) issues.push(`ComboBox foreground color drift for ${jsonEl.id}`);
    }

    if (jsonEl.type === 'CheckBox') {
      const block = getObjectBlock(widgetCode, 'CheckBox', jsonEl.id);
      if (!block) issues.push(`Missing CheckBox block for ${jsonEl.id}`);
    }

    if (jsonEl.type === 'Slider') {
      const block = getObjectBlock(widgetCode, 'Slider', jsonEl.id);
      if (!block) {
        issues.push(`Missing Slider block for ${jsonEl.id}`);
        return;
      }
      if (jsonEl.slider?.value !== undefined && !block.includes(`Value=${formatJsonUEFloat(jsonEl.slider.value)}`)) issues.push(`Slider value drift for ${jsonEl.id}`);
      if (jsonEl.slider?.stepSize && !block.includes(`StepSize=${formatJsonUEFloat(jsonEl.slider.stepSize)}`)) issues.push(`Slider stepSize drift for ${jsonEl.id}`);
    }

    if (jsonEl.type === 'ProgressBar') {
      const block = getObjectBlock(widgetCode, 'ProgressBar', jsonEl.id);
      if (!block) {
        issues.push(`Missing ProgressBar block for ${jsonEl.id}`);
        return;
      }
      if (jsonEl.progressBar?.percent !== undefined && !block.includes(`Percent=${formatJsonUEFloat(jsonEl.progressBar.percent)}`)) issues.push(`ProgressBar percent drift for ${jsonEl.id}`);
    }
  });

  return issues;
}

// ==================== APP CONTROLLER ====================

class App {
  constructor() {
    this.urlInput = document.getElementById('urlInput');
    this.htmlInput = document.getElementById('htmlInput');
    this.ueOutput = document.getElementById('ueOutput');
    this.generateBtn = document.getElementById('generateBtn');
    this.downloadJsonBtn = document.getElementById('downloadJsonBtn');
    this.copyBtn = document.getElementById('copyBtn');
    this.downloadBtn = document.getElementById('downloadBtn');
    this.openFileBtn = document.getElementById('openFileBtn');
    this.htmlFileInput = document.getElementById('htmlFileInput');
    this.assetFolderInput = document.getElementById('assetFolderInput');
    this.loadExampleBtn = document.getElementById('loadExampleBtn');
    this.clearBtn = document.getElementById('clearBtn');
    this.resolutionSelect = document.getElementById('resolutionSelect');
    this.customRes = document.getElementById('customRes');
    this.customWidth = document.getElementById('customWidth');
    this.customHeight = document.getElementById('customHeight');
    this.previewFrame = document.getElementById('previewFrame');
    this.previewToggle = document.getElementById('previewToggle');
    this.loadingOverlay = document.getElementById('loadingOverlay');
    this.loadingElapsed = document.getElementById('loadingElapsed');
    this.analysisSummary = document.getElementById('analysisSummary');
    this.fontSummary = document.getElementById('fontSummary');
    this.fontList = document.getElementById('fontList');
    this.texturePanel = document.getElementById('texturePanel');
    this.textureList = document.getElementById('textureList');
    this.enableLogsChk = document.getElementById('enableLogsChk');
    this.debugPanel = document.getElementById('debugPanel');
    this.debugLogEl = document.getElementById('debugLog');
    this.debugCollapseBtn = document.getElementById('debugCollapseBtn');
    this.statusDot = document.getElementById('statusDot');
    this.statusText = document.getElementById('statusText');
    this.toast = document.getElementById('toast');
    this.previewOpen = true;
    this.lastTextures = [];
    this.lastWidgetJson = '';
    // Cache for algorithm-only changes (avoid re-analyzing HTML)
    this._cachedHtml = null;
    this._cachedData = null;
    this._cachedSessionId = null;
    this._cachedResolutionKey = null;
    this._generateTimer = null;
    this._isGenerating = false;
    this._pendingAutoGenerate = false;
    this._hasGeneratedOnce = false;
    this._lastGeneratedSnapshot = null;
    this._debugLines = [];
    this._debugRunStartedAt = 0;
    this._debugStage = 'idle';
    this._generateWatchdog = null;
    this._debugPanelCollapsed = false;
  }

  isLoggingEnabled() {
    return !!(this.enableLogsChk && this.enableLogsChk.checked);
  }

  refreshDebugPanelState() {
    if (!this.debugPanel || !this.debugLogEl) return;
    const enabled = this.isLoggingEnabled();
    this.debugPanel.classList.toggle('logs-disabled', !enabled);
    this.debugPanel.classList.toggle('collapsed', !!this._debugPanelCollapsed);
    if (this.debugCollapseBtn) {
      this.debugCollapseBtn.textContent = this._debugPanelCollapsed ? 'Expand' : 'Collapse';
    }
    if (!enabled) {
      this.debugLogEl.textContent = 'Logs disabled.';
      return;
    }
    this.debugLogEl.textContent = this._debugLines.length ? this._debugLines.join('\n') : 'Ready.';
    this.debugLogEl.scrollTop = this.debugLogEl.scrollHeight;
  }

  clearDebugLog() {
    this._debugLines = [];
    this.refreshDebugPanelState();
  }

  setDebugPanelCollapsed(collapsed) {
    this._debugPanelCollapsed = !!collapsed;
    this.refreshDebugPanelState();
  }

  toggleDebugPanelCollapsed() {
    this.setDebugPanelCollapsed(!this._debugPanelCollapsed);
  }

  debugLog(message) {
    if (!this.isLoggingEnabled()) return;
    const elapsed = this._debugRunStartedAt ? ((performance.now() - this._debugRunStartedAt) / 1000).toFixed(1) : '0.0';
    const line = `[${elapsed}s] ${message}`;
    this._debugLines.push(line);
    if (this._debugLines.length > 250) this._debugLines = this._debugLines.slice(-250);
    if (this.debugLogEl) {
      this.debugLogEl.textContent = this._debugLines.join('\n');
      this.debugLogEl.scrollTop = this.debugLogEl.scrollHeight;
    }
  }

  setDebugStage(stage) {
    this._debugStage = stage;
    this.debugLog(`Stage: ${stage}`);
  }

  init() {
    this.generateBtn.addEventListener('click', () => this.handleGenerate());
    this.downloadJsonBtn.addEventListener('click', () => this.handleDownloadJson());
    this.copyBtn.addEventListener('click', () => this.handleCopy());
    this.downloadBtn.addEventListener('click', () => this.handleDownload());
    this.openFileBtn.addEventListener('click', () => this.htmlFileInput.click());
    this.htmlFileInput.addEventListener('change', (e) => this.handleFileSelected(e));
    this.loadExampleBtn.addEventListener('click', () => this.loadExample());
    this.clearBtn.addEventListener('click', () => this.handleClear());
    const dlTexBtn = document.getElementById('downloadAllTexturesBtn');
    if (dlTexBtn) dlTexBtn.addEventListener('click', () => this.downloadAllTextures());
    const dlJsonPkg = document.getElementById('downloadJsonPackageBtn');
    if (dlJsonPkg) dlJsonPkg.addEventListener('click', () => this.downloadJsonPackage());
    if (this.enableLogsChk) {
      this.enableLogsChk.addEventListener('change', () => this.refreshDebugPanelState());
    }
    if (this.debugCollapseBtn) {
      this.debugCollapseBtn.addEventListener('click', () => this.toggleDebugPanelCollapsed());
    }
    // Resolution / custom dimension changes used to auto-regenerate via
    // `scheduleAutoGenerate()`. This was annoying because every digit typed
    // into the custom-width box re-ran a full HTML analysis (which can be
    // slow on large pages with many baked textures). Now we just mark the
    // Generate button as having "pending changes" — it lights up amber and
    // shows a small hint until the user clicks it explicitly.
    this.resolutionSelect.addEventListener('change', () => {
      this.customRes.classList.toggle('visible', this.resolutionSelect.value === 'custom');
      this.markPendingChanges();
    });
    this.customWidth.addEventListener('input', () => this.markPendingChanges());
    this.customHeight.addEventListener('input', () => this.markPendingChanges());
    this.previewToggle.addEventListener('click', () => this.togglePreview());

    // HTML Input collapse — toggles `.code-collapsed` on `.panel-left`.
    // The CSS handles hiding the textarea + source bar; the JS just
    // flips state and (when expanding) gives the textarea focus back.
    const collapseBtn = document.getElementById('collapseCodeBtn');
    const panelLeft = document.getElementById('panelLeft');
    if (collapseBtn && panelLeft) {
      this._setCodeCollapsed = (next) => {
        panelLeft.classList.toggle('code-collapsed', !!next);
        if (!next) {
          // Restore focus on expand so the user can keep typing
          // immediately. Skipping when collapsing keeps the
          // visible-cursor jitter out of the preview pane.
          try { this.htmlInput.focus({ preventScroll: true }); } catch {}
        }
      };
      collapseBtn.addEventListener('click', () => {
        this._setCodeCollapsed(!panelLeft.classList.contains('code-collapsed'));
      });
    }

    // Live Preview fullscreen toggle. Clicking the button (or pressing
    // Esc while fullscreen) flips a class that the stylesheet promotes
    // into a viewport-pinned overlay. Implemented as a class-toggle
    // (rather than the native Fullscreen API) so the iframe srcdoc
    // stays loaded — entering/exiting fullscreen never re-renders the
    // user's preview.
    const fsBtn = document.getElementById('previewFullscreenBtn');
    const previewSection = document.getElementById('previewSection');
    if (fsBtn && previewSection) {
      const setFs = (next) => {
        previewSection.classList.toggle('fullscreen', !!next);
        fsBtn.textContent = next ? '⛶ Exit' : '⛶ Fullscreen';
      };
      fsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setFs(!previewSection.classList.contains('fullscreen'));
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && previewSection.classList.contains('fullscreen')) {
          setFs(false);
        }
      });
    }

    this.refreshDebugPanelState();

    // Render-effect toggles: changing them invalidates the analyzer cache
    // because the textures/baked effects are produced during analyze(). They
    // ALSO no longer auto-run analyze; we only mark Generate as pending so
    // the user keeps full control over when the (potentially expensive)
    // re-analysis runs.
    const renderShadowsChk = document.getElementById('renderShadowsChk');
    const renderGradientsChk = document.getElementById('renderGradientsChk');
    const renderFontIconsChk = document.getElementById('renderFontIconsChk');
    const renderAnimationsChk = document.getElementById('renderAnimationsChk');
    const _onRenderToggle = () => {
      this._cachedHtml = null;
      this._cachedData = null;
      this.markPendingChanges();
    };
    if (renderShadowsChk) renderShadowsChk.addEventListener('change', _onRenderToggle);
    if (renderGradientsChk) renderGradientsChk.addEventListener('change', _onRenderToggle);
    if (renderFontIconsChk) renderFontIconsChk.addEventListener('change', _onRenderToggle);
    if (renderAnimationsChk) renderAnimationsChk.addEventListener('change', _onRenderToggle);

    let debounce;
    this.htmlInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => this.updatePreview(), 500);
    });
    this.urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.htmlFileInput.click();
      }
    });

    this.setStatus('ready', 'Ready — paste HTML and click Generate');
  }

  normalizeUrl(rawUrl) {
    const value = (rawUrl || '').trim();
    if (!value) return '';
    if (/^file:\/\//i.test(value)) return value;
    return /^https?:\/\//i.test(value) ? value : `https://${value}`;
  }

  deriveBaseHref(url) {
    const normalized = this.normalizeUrl(url);
    if (!normalized) return '';
    if (/^file:\/\//i.test(normalized)) {
      return normalized.replace(/[^/]*$/, '');
    }
    try {
      return new URL('.', normalized).href;
    } catch {
      return normalized.replace(/[^/]*$/, '');
    }
  }

  deriveHtmlBaseDirFromFileUrl(rawUrl, selectedRootName = '') {
    const value = (rawUrl || '').trim();
    if (!/^file:\/\//i.test(value)) return '';
    let decoded = value.replace(/^file:\/+/i, '');
    decoded = decoded.replace(/\\/g, '/');
    const parts = decoded.split('/').filter(Boolean);
    if (!parts.length) return '';
    parts.pop(); // html file name

    if (selectedRootName) {
      const idx = parts.findIndex(p => p.toLowerCase() === selectedRootName.toLowerCase());
      if (idx >= 0) {
        return parts.slice(idx + 1).join('/');
      }
    }

    return parts.length ? parts[parts.length - 1] : '';
  }

  injectBaseHref(html, url) {
    const baseHref = this.deriveBaseHref(url);
    const baseTag = `<base href="${baseHref.replace(/"/g, '&quot;')}">`;
    if (/<base\s/i.test(html)) return html;
    if (/<head[^>]*>/i.test(html)) {
      return html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
    }
    if (/<html[^>]*>/i.test(html)) {
      return html.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`);
    }
    return `<!DOCTYPE html><html><head>${baseTag}</head><body>${html}</body></html>`;
  }

  isRelativeLocalAssetRef(ref) {
    const value = normalizeLocalAssetPath(ref || '').trim();
    if (!value) return false;
    if (/^(?:[a-z]+:|\/\/|#)/i.test(value)) return false;
    return true;
  }

  resolveFileUrlInAssetMap(fileUrl, assetMap) {
    let path = stripAssetUrlSuffix(fileUrl).replace(/^file:\/\/\/?/i, '').replace(/\\/g, '/');
    try { path = decodeURIComponent(path); } catch {}
    const parts = path.split('/').filter(Boolean);
    // Try progressively shorter suffixes until we find a match in the map
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/');
      if (assetMap.has(suffix)) return suffix;
    }
    return null;
  }

  resolveRelativeAssetPath(ref, baseDir = '') {
    ref = normalizeLocalAssetPath(ref);
    const cleanBase = baseDir ? `${baseDir.replace(/^\/+|\/+$/g, '')}/` : '';
    try {
      return new URL(ref, `https://local.widget/${cleanBase}`).pathname.replace(/^\/+/, '');
    } catch {
      return `${cleanBase}${ref}`.replace(/^\/+/, '');
    }
  }

  async replaceAsync(input, regex, replacer) {
    const matches = [];
    input.replace(regex, (...args) => {
      matches.push(args);
      return args[0];
    });

    let output = input;
    for (const match of matches.reverse()) {
      const full = match[0];
      const offset = match[match.length - 2];
      const replacement = await replacer(...match);
      output = output.slice(0, offset) + replacement + output.slice(offset + full.length);
    }
    return output;
  }

  async buildFolderAssetMap(dirHandle, prefix = '', map = new Map()) {
    for await (const [name, handle] of dirHandle.entries()) {
      const relPath = `${prefix}${name}`;
      if (handle.kind === 'file') {
        map.set(relPath.replace(/\\/g, '/'), handle);
      } else if (handle.kind === 'directory') {
        await this.buildFolderAssetMap(handle, `${relPath}/`, map);
      }
    }
    return map;
  }

  buildFileAssetMap(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return { map: new Map(), rootName: '' };
    const firstPath = files[0].webkitRelativePath || files[0].name;
    const rootName = firstPath.split('/')[0] || '';
    const map = new Map();

    for (const file of files) {
      const rel = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
      const stripped = rel.startsWith(`${rootName}/`) ? rel.slice(rootName.length + 1) : rel;
      map.set(stripped, file);
    }

    return { map, rootName };
  }

  async promptForAssetFolderFiles() {
    return new Promise((resolve, reject) => {
      const input = this.assetFolderInput;
      if (!input) {
        reject(new Error('Folder picker is unavailable.'));
        return;
      }

      const onChange = () => {
        input.removeEventListener('change', onChange);
        const files = input.files ? Array.from(input.files) : [];
        input.value = '';
        if (!files.length) {
          reject(new Error('No folder selected.'));
          return;
        }
        resolve(this.buildFileAssetMap(files));
      };

      input.addEventListener('change', onChange, { once: true });
      input.click();
    });
  }

  findHtmlBaseDirInAssetMap(htmlFileName, htmlFileSize, assetMap) {
    const nameLower = htmlFileName.toLowerCase();
    const candidates = [];
    for (const [key, entry] of assetMap) {
      const keyLower = key.toLowerCase();
      if (keyLower === nameLower || keyLower.endsWith('/' + nameLower)) {
        candidates.push({ key, entry });
      }
    }
    if (candidates.length === 0) return null;
    // Single match — use it directly
    if (candidates.length === 1) {
      const lastSlash = candidates[0].key.lastIndexOf('/');
      return lastSlash >= 0 ? candidates[0].key.slice(0, lastSlash) : '';
    }
    // Multiple matches — disambiguate by file size
    for (const cand of candidates) {
      const f = cand.entry;
      const size = (typeof f.size === 'number') ? f.size : -1;
      if (size === htmlFileSize) {
        const lastSlash = cand.key.lastIndexOf('/');
        return lastSlash >= 0 ? cand.key.slice(0, lastSlash) : '';
      }
    }
    // Still ambiguous — pick the shortest path (most likely the direct child)
    candidates.sort((a, b) => a.key.length - b.key.length);
    const lastSlash = candidates[0].key.lastIndexOf('/');
    return lastSlash >= 0 ? candidates[0].key.slice(0, lastSlash) : '';
  }

  async rewriteCssTextWithAssets(cssText, baseDir, assetMap, blobCache) {
    let output = cssText;

    output = await this.replaceAsync(output, /url\((['"]?)([^'")]+)\1\)/gi, async (full, quote, ref) => {
      if (this.isRelativeLocalAssetRef(ref)) {
        const logicalPath = this.resolveRelativeAssetPath(ref, baseDir);
        const blobUrl = await this.createBlobUrlForAsset(logicalPath, assetMap, blobCache);
        return blobUrl ? `url("${blobUrl}")` : full;
      }
      if (/^file:\/\//i.test(ref)) {
        const mapKey = this.resolveFileUrlInAssetMap(ref, assetMap);
        if (mapKey) {
          const blobUrl = await this.createBlobUrlForAsset(mapKey, assetMap, blobCache);
          if (blobUrl) return `url("${blobUrl}")`;
        }
      }
      return full;
    });

    output = await this.replaceAsync(output, /@import\s+(?:url\()?['"]([^'"]+)['"]\)?/gi, async (full, ref) => {
      if (this.isRelativeLocalAssetRef(ref)) {
        const logicalPath = this.resolveRelativeAssetPath(ref, baseDir);
        const blobUrl = await this.createBlobUrlForAsset(logicalPath, assetMap, blobCache);
        return blobUrl ? full.replace(ref, blobUrl) : full;
      }
      if (/^file:\/\//i.test(ref)) {
        const mapKey = this.resolveFileUrlInAssetMap(ref, assetMap);
        if (mapKey) {
          const blobUrl = await this.createBlobUrlForAsset(mapKey, assetMap, blobCache);
          if (blobUrl) return full.replace(ref, blobUrl);
        }
      }
      return full;
    });

    return output;
  }

  async createBlobUrlForAsset(logicalPath, assetMap, blobCache) {
    const normalized = normalizeLocalAssetPath(logicalPath);
    if (blobCache.has(normalized)) return blobCache.get(normalized);
    let entry = assetMap.get(normalized);

    // Fallback 1: case-insensitive lookup
    if (!entry) {
      const normLower = normalized.toLowerCase();
      for (const [key, val] of assetMap) {
        if (key.toLowerCase() === normLower) { entry = val; break; }
      }
    }

    // Fallback 2: suffix match (match by filename or partial path suffix)
    if (!entry) {
      const normLower = normalized.toLowerCase();
      for (const [key, val] of assetMap) {
        const keyLower = key.toLowerCase();
        if (keyLower.endsWith('/' + normLower) || normLower.endsWith('/' + keyLower) || keyLower === normLower) {
          entry = val; break;
        }
      }
    }

    if (!entry) {
      console.warn('[AssetRewrite] Not found in map:', normalized, '| Map keys sample:', [...assetMap.keys()].slice(0, 10));
      return null;
    }

    const file = typeof entry.getFile === 'function' ? await entry.getFile() : entry;
    let blobUrl = null;

    if (/\.css$/i.test(normalized)) {
      const cssText = await file.text();
      const baseDir = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/') + 1) : '';
      const rewritten = await this.rewriteCssTextWithAssets(cssText, baseDir, assetMap, blobCache);
      blobUrl = URL.createObjectURL(new Blob([rewritten], { type: file.type || 'text/css' }));
    } else if (/\.js$/i.test(normalized)) {
      const jsText = await file.text();
      blobUrl = URL.createObjectURL(new Blob([jsText], { type: file.type || 'text/javascript' }));
    } else {
      blobUrl = URL.createObjectURL(file);
    }

    blobCache.set(normalized, blobUrl);
    return blobUrl;
  }

  htmlLikelyHasRelativeAssets(html) {
    // Detect relative paths OR local file:/// URLs that need folder-based resolution
    return /(src|href|poster)\s*=\s*["'](?![a-z]+:|\/\/|#)[^"']+["']/i.test(html) ||
      /url\((?!['"]?(?:[a-z]+:|\/\/|#))/i.test(html) ||
      /(?:src|href|poster)\s*=\s*["']file:\/\/\//i.test(html) ||
      /url\(\s*['"]?file:\/\/\//i.test(html);
  }

  async rewriteHtmlWithLocalAssets(html, assetMap, htmlBaseDir = '') {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const blobCache = new Map();
    // Track created blob URLs on the instance so the next file load / clear
    // can revoke them and prevent unbounded memory growth.
    this._activeBlobUrls = this._activeBlobUrls || [];

    console.log('[AssetRewrite] htmlBaseDir:', htmlBaseDir, '| assetMap size:', assetMap.size,
      '| keys:', [...assetMap.keys()].slice(0, 15));

    // Remove <base> tags with file:/// hrefs — they cause wrong path resolution in srcdoc
    for (const base of doc.querySelectorAll('base[href]')) {
      const href = base.getAttribute('href') || '';
      if (/^file:\/\//i.test(href)) {
        console.log('[AssetRewrite] Removing file:// base tag:', href);
        base.remove();
      }
    }

    const attrSelectors = [
      ['img[src]', 'src'],
      ['source[src]', 'src'],
      ['video[src]', 'src'],
      ['audio[src]', 'src'],
      ['video[poster]', 'poster'],
      ['script[src]', 'src'],
      ['link[href]', 'href']
    ];

    for (const [selector, attr] of attrSelectors) {
      for (const el of doc.querySelectorAll(selector)) {
        const ref = el.getAttribute(attr);
        if (this.isRelativeLocalAssetRef(ref)) {
          const logicalPath = this.resolveRelativeAssetPath(ref, htmlBaseDir);
          const blobUrl = await this.createBlobUrlForAsset(logicalPath, assetMap, blobCache);
          if (blobUrl) {
            el.setAttribute(attr, blobUrl);
          } else {
            console.warn('[AssetRewrite] FAILED relative:', ref, '→ resolved:', logicalPath);
          }
        } else if (/^file:\/\//i.test(ref)) {
          const mapKey = this.resolveFileUrlInAssetMap(ref, assetMap);
          if (mapKey) {
            const blobUrl = await this.createBlobUrlForAsset(mapKey, assetMap, blobCache);
            if (blobUrl) {
              el.setAttribute(attr, blobUrl);
            } else {
              console.warn('[AssetRewrite] FAILED file:// (blob):', ref, '→ mapKey:', mapKey);
            }
          } else {
            console.warn('[AssetRewrite] FAILED file:// (lookup):', ref);
          }
        } else if (ref && !/^(https?:|data:|blob:)/i.test(ref)) {
          console.warn('[AssetRewrite] SKIPPED (not relative, not file://):', ref);
        }
      }
    }

    for (const el of doc.querySelectorAll('[srcset]')) {
      const srcset = el.getAttribute('srcset') || '';
      const parts = srcset.split(',').map(s => s.trim()).filter(Boolean);
      const rewritten = [];
      for (const part of parts) {
        const segs = part.split(/\s+/);
        const ref = segs[0];
        if (this.isRelativeLocalAssetRef(ref)) {
          const logicalPath = this.resolveRelativeAssetPath(ref, htmlBaseDir);
          const blobUrl = await this.createBlobUrlForAsset(logicalPath, assetMap, blobCache);
          if (blobUrl) segs[0] = blobUrl;
        } else if (/^file:\/\//i.test(ref)) {
          const mapKey = this.resolveFileUrlInAssetMap(ref, assetMap);
          if (mapKey) {
            const blobUrl = await this.createBlobUrlForAsset(mapKey, assetMap, blobCache);
            if (blobUrl) segs[0] = blobUrl;
          }
        }
        rewritten.push(segs.join(' '));
      }
      el.setAttribute('srcset', rewritten.join(', '));
    }

    for (const styleEl of doc.querySelectorAll('style')) {
      styleEl.textContent = await this.rewriteCssTextWithAssets(styleEl.textContent || '', htmlBaseDir, assetMap, blobCache);
    }

    for (const el of doc.querySelectorAll('[style]')) {
      const rewritten = await this.rewriteCssTextWithAssets(el.getAttribute('style') || '', htmlBaseDir, assetMap, blobCache);
      el.setAttribute('style', rewritten);
    }

    // === Runtime asset resolver — for JS-injected <img> / <video> / <audio> ===
    //
    // Static HTML attributes were just rewritten to blob URLs above, but
    // page scripts that build DOM at runtime (e.g. medieval-ui's
    // `slot.innerHTML = '<img src="items.png">'` inside `buildInventory()`)
    // use the ORIGINAL relative path which resolves against the iframe's
    // srcdoc base (the parent document) and 404s. This produces the
    // canonical "icons gelmiyor / hepsi aynı görünüyor" symptom: layout
    // slots render but the image content is missing or replaced with the
    // browser's broken-image placeholder, which Generator then bakes as a
    // transparent / placeholder texture.
    //
    // Fix: inject a script at the TOP of <head> that:
    //   1. Stashes a `pathBasename → blobUrl` map on `window.__assetMap`.
    //      We index by both the full logical path AND the bare filename
    //      so `<img src="items.png">` and `<img src="./icons/items.png">`
    //      both resolve correctly.
    //   2. Patches the `HTMLImageElement.prototype.src` setter (and
    //      similar for video/audio/source) to redirect resolution
    //      through the map. Scripts setting `img.src = "items.png"`
    //      get the blob URL transparently.
    //   3. Installs a MutationObserver to catch elements created by
    //      `innerHTML` (the `setAttribute('src', ...)` parser path
    //      bypasses the property setter). Each newly-inserted IMG /
    //      VIDEO / AUDIO / SOURCE has its src rewritten if it matches
    //      a known asset key.
    //
    // The map is built ONCE here from `blobCache` and inlined as JSON
    // into the injected script. The blob URLs themselves were already
    // pushed to `this._activeBlobUrls` so they survive the analyze pass
    // and get revoked together at the next file-load.
    const runtimeAssetMap = {};
    for (const [logicalPath, blobUrl] of blobCache.entries()) {
      if (!blobUrl) continue;
      runtimeAssetMap[logicalPath] = blobUrl;
      // Index by bare filename too — most commonly how scripts reference assets.
      const basename = logicalPath.split('/').pop();
      if (basename && !runtimeAssetMap[basename]) {
        runtimeAssetMap[basename] = blobUrl;
      }
      // Also index by `./filename` and `filename`-without-leading-slash.
      const noLeading = logicalPath.replace(/^\.?\//, '');
      if (noLeading && !runtimeAssetMap[noLeading]) {
        runtimeAssetMap[noLeading] = blobUrl;
      }
    }

    if (Object.keys(runtimeAssetMap).length > 0) {
      const runtimeResolver = `(function(){
  var __MAP = ${JSON.stringify(runtimeAssetMap)};
  function __resolve(src) {
    if (!src || typeof src !== 'string') return src;
    if (/^(blob:|data:|https?:|\\/\\/|file:)/i.test(src)) return src;
    var cleaned = src.replace(/^\\.?\\//, '');
    if (__MAP[src]) return __MAP[src];
    if (__MAP[cleaned]) return __MAP[cleaned];
    var basename = cleaned.split('/').pop();
    if (basename && __MAP[basename]) return __MAP[basename];
    return src;
  }
  window.__assetMap = __MAP;
  window.__resolveAsset = __resolve;

  // Patch the property setters so direct \`img.src = "..."\` works.
  function __patchProto(proto, attr) {
    if (!proto) return;
    var desc = Object.getOwnPropertyDescriptor(proto, attr);
    if (!desc || !desc.set) return;
    Object.defineProperty(proto, attr, {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: function(v) { desc.set.call(this, __resolve(v)); }
    });
  }
  __patchProto(HTMLImageElement.prototype, 'src');
  if (window.HTMLSourceElement) __patchProto(HTMLSourceElement.prototype, 'src');
  if (window.HTMLVideoElement) {
    __patchProto(HTMLVideoElement.prototype, 'src');
    __patchProto(HTMLVideoElement.prototype, 'poster');
  }
  if (window.HTMLAudioElement) __patchProto(HTMLAudioElement.prototype, 'src');

  // \`innerHTML\` / parser path bypasses the setter — use MutationObserver
  // to catch newly-added <img>/<video>/<audio>/<source> elements. We
  // also rewrite their child resources by querying the inserted subtree.
  function __rewriteEl(el) {
    if (!el || el.nodeType !== 1) return;
    var attrs = ['src', 'poster'];
    for (var i = 0; i < attrs.length; i++) {
      var a = attrs[i];
      if (el.hasAttribute && el.hasAttribute(a)) {
        var v = el.getAttribute(a);
        var r = __resolve(v);
        if (r !== v) el.setAttribute(a, r);
      }
    }
  }
  function __rewriteSubtree(root) {
    if (!root) return;
    __rewriteEl(root);
    if (root.querySelectorAll) {
      var nodes = root.querySelectorAll('img,source,video,audio,[poster]');
      for (var i = 0; i < nodes.length; i++) __rewriteEl(nodes[i]);
    }
  }
  var __obs = new MutationObserver(function(muts) {
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type === 'childList') {
        for (var j = 0; j < m.addedNodes.length; j++) __rewriteSubtree(m.addedNodes[j]);
      } else if (m.type === 'attributes' && (m.attributeName === 'src' || m.attributeName === 'poster')) {
        __rewriteEl(m.target);
      }
    }
  });
  function __startObserve() {
    var root = document.documentElement || document.body || document;
    __obs.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'poster'] });
    __rewriteSubtree(document);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', __startObserve);
    // Also observe early so head-time scripts that inject content are caught.
    __startObserve();
  } else {
    __startObserve();
  }
})();`;

      const resolverScript = doc.createElement('script');
      resolverScript.textContent = runtimeResolver;
      const head = doc.head || doc.documentElement;
      // Insert AT THE TOP so it runs before user scripts that build DOM at parse time.
      head.insertBefore(resolverScript, head.firstChild);
    }

    // Record blob URLs created in this pass for later revocation
    for (const url of blobCache.values()) {
      if (url) this._activeBlobUrls.push(url);
    }

    const doctype = '<!DOCTYPE html>';
    return `${doctype}\n${doc.documentElement.outerHTML}`;
  }

  revokeActiveBlobUrls() {
    // Drop any inlined data: URLs we cached against now-stale blob URLs.
    // The data URLs themselves are valid forever, but once their source blob
    // is revoked the cache key is meaningless and the entries just leak
    // memory across file loads.
    try { _bgUrlInlineCache.clear(); } catch {}
    if (!this._activeBlobUrls || !this._activeBlobUrls.length) return;
    for (const url of this._activeBlobUrls) {
      try { URL.revokeObjectURL(url); } catch {}
    }
    this._activeBlobUrls = [];
  }

  async handleFileSelected(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    // Revoke blobs from the previous file (prevents memory leak across loads)
    this.revokeActiveBlobUrls();

    this.setStatus('processing', 'Loading local file...');
    this.loadingOverlay.classList.add('active');
    this.generateBtn.disabled = true;

    try {
      const html = await file.text();
      let finalHtml = html;
      let assetsResolved = false;
      const baseSource = this.urlInput.value.trim();
      const fallbackHtmlBaseDir = this.deriveHtmlBaseDirFromFileUrl(baseSource);

      if (this.htmlLikelyHasRelativeAssets(html)) {
        try {
          this.showToast('Choose the folder that contains this HTML file so local assets can be resolved.');
          let assetMap = null;
          let rootName = '';

          if (this.assetFolderInput) {
            const picked = await this.promptForAssetFolderFiles();
            assetMap = picked.map;
            rootName = picked.rootName;
          } else if (window.showDirectoryPicker) {
            const dirHandle = await window.showDirectoryPicker();
            assetMap = await this.buildFolderAssetMap(dirHandle);
            rootName = dirHandle.name || '';
          }

          if (assetMap && assetMap.size) {
            // Primary: find the HTML file inside the selected folder to derive base dir
            let htmlBaseDir = this.findHtmlBaseDirInAssetMap(file.name, file.size, assetMap);
            console.log('[FileLoad] findHtmlBaseDirInAssetMap result:', htmlBaseDir,
              '| file.name:', file.name, '| file.size:', file.size, '| rootName:', rootName);
            // Fallback: derive from URL input if the HTML file wasn't found in the folder
            if (htmlBaseDir === null) {
              htmlBaseDir = this.deriveHtmlBaseDirFromFileUrl(baseSource, rootName) || fallbackHtmlBaseDir;
              console.log('[FileLoad] Using fallback htmlBaseDir:', htmlBaseDir);
            }
            finalHtml = await this.rewriteHtmlWithLocalAssets(html, assetMap, htmlBaseDir);
            assetsResolved = true;
          }
        } catch (e) {
          if (e && e.name !== 'AbortError') {
            console.warn('Local asset folder selection failed:', e);
          }
        }
      }

      if (!assetsResolved && /^file:\/\//i.test(baseSource)) {
        finalHtml = this.injectBaseHref(finalHtml, baseSource);
      }

      this.htmlInput.value = finalHtml;
      this.updatePreview();
      this.showToast(assetsResolved ? `Loaded local file with assets: ${file.name}` : `Loaded local file: ${file.name}`, 'success');
      this.setStatus('ready', 'Local file loaded');
    } catch (e) {
      console.error(e);
      this.showToast(`Could not load file: ${e.message}`);
      this.setStatus('error', `Error: ${e.message}`);
    } finally {
      this.htmlFileInput.value = '';
      this.loadingOverlay.classList.remove('active');
      this.generateBtn.disabled = false;
    }
  }

  getResolution() {
    const v = this.resolutionSelect.value;
    if (v === 'custom') {
      return { w: parseInt(this.customWidth.value) || 1920, h: parseInt(this.customHeight.value) || 1080 };
    }
    const [w, h] = v.split('x').map(Number);
    return { w, h };
  }

  getResolutionKey() {
    const { w, h } = this.getResolution();
    return `${w}x${h}`;
  }

  scheduleAutoGenerate() {
    clearTimeout(this._generateTimer);
    if (!this.htmlInput.value.trim()) return;
    this._generateTimer = setTimeout(() => {
      if (this._isGenerating) {
        this._pendingAutoGenerate = true;
        return;
      }
      this.handleGenerate();
    }, 250);
  }

  // The Generate button has two visual states. Default: purple, idle. Pending:
  // amber, gently pulsing, with a small "Changes pending — click to apply"
  // hint that lives in a row UNDERNEATH the button (so the button width
  // doesn't grow when the badge appears). We only flip into pending after at
  // least one successful Generate run so a fresh page load doesn't pulse for
  // nothing. handleGenerate() always clears it on success.
  // The pending state is driven by a snapshot of the settings that produced
  // the LAST successful generate — when the current settings match that
  // snapshot the badge is automatically cleared, so flipping a toggle and
  // flipping it back returns the button to its idle state without requiring
  // another Generate click.
  captureGenerateSettingsSnapshot() {
    const renderShadowsChk = document.getElementById('renderShadowsChk');
    const renderGradientsChk = document.getElementById('renderGradientsChk');
    const renderFontIconsChk = document.getElementById('renderFontIconsChk');
    const renderAnimationsChk = document.getElementById('renderAnimationsChk');
    const { w, h } = this.getResolution();
    return JSON.stringify({
      renderShadows: !renderShadowsChk || renderShadowsChk.checked,
      renderGradients: !renderGradientsChk || renderGradientsChk.checked,
      renderFontIcons: !!(renderFontIconsChk && renderFontIconsChk.checked),
      renderAnimations: !renderAnimationsChk || renderAnimationsChk.checked,
      w, h
    });
  }

  refreshPendingChangesState() {
    if (!this.generateBtn || !this._hasGeneratedOnce) return;
    const current = this.captureGenerateSettingsSnapshot();
    if (current === this._lastGeneratedSnapshot) {
      this.clearPendingChanges();
    } else {
      this._setPendingChangesUI(true);
    }
  }

  _setPendingChangesUI(on) {
    if (!this.generateBtn) return;
    const bar = document.getElementById('generateBar');
    if (on) {
      this.generateBtn.classList.add('has-pending-changes');
      if (bar) bar.classList.add('has-pending-changes');
    } else {
      this.generateBtn.classList.remove('has-pending-changes');
      if (bar) bar.classList.remove('has-pending-changes');
    }
  }

  markPendingChanges() {
    if (!this.generateBtn) return;
    if (!this._hasGeneratedOnce) return;
    this.refreshPendingChangesState();
  }

  clearPendingChanges() {
    this._setPendingChangesUI(false);
  }

  async handleGenerate() {
    let html = this.htmlInput.value.trim();
    if (!html && this.urlInput.value.trim()) {
      if (/^file:\/\//i.test(this.urlInput.value.trim())) {
        this.htmlFileInput.click();
        this.showToast('Select the local HTML file with the File picker.');
        return;
      }
      this.showToast('Remote website loading is disabled. Use the File button for local HTML.');
      return;
    }
    if (!html) { this.showToast('Please paste HTML code or choose a local HTML file first.'); return; }

    const renderShadowsChk = document.getElementById('renderShadowsChk');
    const renderGradientsChk = document.getElementById('renderGradientsChk');
    const renderFontIconsChk = document.getElementById('renderFontIconsChk');
    const renderAnimationsChk = document.getElementById('renderAnimationsChk');
    const renderOpts = {
      renderShadows: !renderShadowsChk || renderShadowsChk.checked,
      renderGradients: !renderGradientsChk || renderGradientsChk.checked,
      renderFontIcons: !!(renderFontIconsChk && renderFontIconsChk.checked),
      renderAnimations: !renderAnimationsChk || renderAnimationsChk.checked
    };
    const { w, h } = this.getResolution();
    this._isGenerating = true;
    this._debugRunStartedAt = performance.now();
    this.clearDebugLog();
    if (this.isLoggingEnabled()) this.setDebugPanelCollapsed(false);
    this.debugLog(`Generate requested | resolution=${w}x${h}`);
    this.debugLog(`Render options | shadows=${renderOpts.renderShadows} gradients=${renderOpts.renderGradients} fontIcons=${renderOpts.renderFontIcons} animations=${renderOpts.renderAnimations}`);
    clearInterval(this._generateWatchdog);
    if (this.isLoggingEnabled()) {
      this._generateWatchdog = setInterval(() => {
        this.debugLog(`Still running | stage=${this._debugStage}`);
      }, 2000);
    }

    // Fresh session ID per conversion — prevents texture name conflicts
    SESSION_ID = generateSessionId();
    this.debugLog(`Session created | ${SESSION_ID}`);

    this.setDebugStage('Analyzing HTML');
    this.setStatus('processing', 'Analyzing HTML...');
    this.loadingOverlay.classList.add('active');
    this.startLoadingTimer();
    this.generateBtn.disabled = true;

    try {
      const analyzer = new HTMLAnalyzer(w, h, this.isLoggingEnabled()
        ? { ...renderOpts, progress: (message) => this.debugLog(`[Analyzer] ${message}`) }
        : renderOpts);
      const data = await analyzer.analyze(html);
      this.debugLog(`Analyze finished | elements=${data.elements.length} textures=${(data.textures || []).length} panels=${(data.panelGroups || []).length}`);

      // Cache tracking (kept so other code paths can invalidate on option changes)
      this._cachedHtml = html;
      this._cachedSessionId = SESSION_ID;
      this._cachedResolutionKey = this.getResolutionKey();
      this._cachedData = {
        ...data,
        _cacheVersion: ANALYSIS_CACHE_VERSION,
        _rawElements: JSON.parse(JSON.stringify(data.elements))
      };

      this.setDebugStage('Generating UE Widget code');
      this.setStatus('processing', 'Generating UE Widget code...');
      const generator = new UEWidgetGenerator(data);
      const jsonExporter = new WidgetJsonExporter(data);
      const jsonObject = jsonExporter.exportObject();
      this.debugLog(`JSON export finished | rootType=${jsonObject?.root?.type || 'unknown'}`);
      const output = generator.generate();
      this.debugLog(`T3D export finished | outputChars=${output.length}`);
      const parityIssues = validateWidgetJsonParity(output, jsonObject);
      if (parityIssues.length) {
        this.debugLog(`Parity failed | ${parityIssues[0]}`);
        throw new Error(`JSON parity check failed: ${parityIssues[0]}`);
      }
      this.debugLog('Parity check passed');

      this.lastWidgetJson = JSON.stringify(jsonObject, null, 2);
      // Cache the HTML-derived page name so download buttons can use it for
      // file naming. Falls back to the legacy `Widget_*` defaults below when
      // the analyser couldn't extract anything usable from the page.
      this.lastPageName = data.pageName || '';
      this.ueOutput.value = output;
      this.downloadJsonBtn.disabled = false;
      this.copyBtn.disabled = false;
      this.downloadBtn.disabled = false;

      // Auto-collapse the (often massive) HTML paste area after a
      // successful conversion so the user can immediately see the
      // preview / output / texture panel without manual scroll. The
      // collapse is reversible — clicking Expand re-shows the
      // textarea exactly as it was. Skipped silently if the helper
      // wasn't wired (older `init()` order or missing button).
      if (typeof this._setCodeCollapsed === 'function') {
        this._setCodeCollapsed(true);
      }

      this.updateSummary(data.elements, data.usedFonts || [], data, jsonObject);
      this.setDebugStage('Updating textures');
      this.debugLog(`Updating textures | count=${(data.textures || []).length}`);
      await this.updateTextures(data.textures);
      this.debugLog('Texture update finished');
      const scrollRegions = data.scrollRegions || [];
      const hasRootScroll = scrollRegions.some(sr => sr.isRootScroll);
      const innerScrollCount = scrollRegions.filter(sr => !sr.isRootScroll).length;
      const scrollNote = hasRootScroll ? ` + root scroll${innerScrollCount ? ` + ${innerScrollCount} inner ScrollBox` : ''}` : (innerScrollCount ? ` (${innerScrollCount} ScrollBox)` : '');
      // Extra container/animation context for the status line so the user
      // sees the full UMG-side scope at a glance, not just leaf widgets:
      // panels become `UCanvasPanel` containers, animations become
      // `UWidgetAnimation` assets — both invisible from `elements.length`
      // alone since they're synthesized later in the pipeline.
      const panelCount = (data.panelGroups || []).length;
      const panelNote = panelCount > 0 ? ` + ${panelCount} CanvasPanel${panelCount === 1 ? '' : 's'}` : '';
      let animTotal = 0;
      data.elements.forEach(e => { if (e.animations && e.animations.length) animTotal += e.animations.length; });
      const animNote = animTotal > 0 ? ` + ${animTotal} animation${animTotal === 1 ? '' : 's'}` : '';
      this.setStatus('ready', `Done — ${data.elements.length} widgets generated${scrollNote}${panelNote}${animNote}`);
      const toastAnim = animTotal > 0 ? ` (${animTotal} animation${animTotal === 1 ? '' : 's'})` : '';
      this.showToast(`✓ ${data.elements.length} widgets generated successfully${toastAnim}`, 'success');
      this.setDebugStage('Completed');
      this.debugLog(`Generate completed successfully | widgets=${data.elements.length}`);
      this._hasGeneratedOnce = true;
      // Capture the settings snapshot AFTER a successful run so toggling a
      // setting and toggling it back is recognised as "no real change".
      this._lastGeneratedSnapshot = this.captureGenerateSettingsSnapshot();
      this.clearPendingChanges();
    } catch (e) {
      console.error(e);
      this.setDebugStage('Error');
      this.debugLog(`ERROR | ${e.message}`);
      this.setStatus('error', `Error: ${e.message}`);
      this.showToast(`Error: ${e.message}`);
      // On error we keep the pending-changes badge so the user can fix the
      // input and retry without losing the visual reminder that settings
      // changed but didn't apply yet.
    } finally {
      clearInterval(this._generateWatchdog);
      this._generateWatchdog = null;
      this.setDebugPanelCollapsed(true);
      this._isGenerating = false;
      this.loadingOverlay.classList.remove('active');
      this.stopLoadingTimer();
      this.generateBtn.disabled = false;
      if (this._pendingAutoGenerate) {
        this._pendingAutoGenerate = false;
        this.scheduleAutoGenerate();
      }
    }
  }

  startLoadingTimer() {
    this._loadingStartedAt = performance.now();
    if (this.loadingElapsed) this.loadingElapsed.textContent = '0.0s';
    clearInterval(this._loadingTimerId);
    this._loadingTimerId = setInterval(() => {
      if (!this.loadingElapsed) return;
      const secs = (performance.now() - this._loadingStartedAt) / 1000;
      this.loadingElapsed.textContent = secs < 10
        ? `${secs.toFixed(1)}s`
        : `${Math.round(secs)}s`;
    }, 100);
  }

  stopLoadingTimer() {
    clearInterval(this._loadingTimerId);
    this._loadingTimerId = null;
  }

  handleCopy() {
    navigator.clipboard.writeText(this.ueOutput.value).then(() => {
      this.showToast('✓ Copied to clipboard — paste in UE Widget Blueprint', 'success');
    });
  }

  // Compose a download filename from the HTML-derived page name. Returns
  // `${prefix}${pageName}${suffix}` when a usable page name exists, otherwise
  // returns the supplied `fallback` (the legacy fixed name) so users with no
  // <title>/id/class still get a sensible default.
  _exportFilename(prefix, suffix, fallback) {
    const name = (this.lastPageName || '').trim();
    if (!name) return fallback;
    return `${prefix}${name}${suffix}`;
  }

  handleDownload() {
    const blob = new Blob([this.ueOutput.value], { type: 'text/plain' });
    downloadBlob(blob, this._exportFilename('', '_Widget.txt', 'Widget_Output.txt'));
  }

  handleDownloadJson() {
    if (!this.lastWidgetJson) {
      this.showToast('Generate a widget first.');
      return;
    }
    const blob = new Blob([this.lastWidgetJson], { type: 'application/json' });
    downloadBlob(blob, this._exportFilename('', '_Layout.json', 'Widget_Layout.json'));
  }

  handleClear() {
    clearTimeout(this._generateTimer);
    this.revokeActiveBlobUrls();
    this.urlInput.value = '';
    this.htmlInput.value = '';
    this.ueOutput.value = '';
    this.lastWidgetJson = '';
    this.lastPageName = '';
    this.downloadJsonBtn.disabled = true;
    this.copyBtn.disabled = true;
    this.downloadBtn.disabled = true;
    this.lastTextures = [];
    this._cachedHtml = null;
    this._cachedData = null;
    this._cachedSessionId = null;
    this._cachedResolutionKey = null;
    this._pendingAutoGenerate = false;
    this._hasGeneratedOnce = false;
    this._lastGeneratedSnapshot = null;
    this.clearPendingChanges();
    this.analysisSummary.innerHTML = '';
    if (this.fontList) this.fontList.innerHTML = '';
    if (this.fontSummary) this.fontSummary.style.display = 'none';
    this.texturePanel.style.display = 'none';
    this.previewFrame.srcdoc = '';
    this.previewFrame.src = 'about:blank';
    this.setStatus('ready', 'Ready');
  }

  loadExample() {
    this.urlInput.value = '';
    this.htmlInput.value = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Panel Toggle Test</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; }
  body {
    font-family: 'Segoe UI', Arial, sans-serif;
    background: linear-gradient(135deg, #1a1a2e 0%, #2d1b4e 50%, #1a1a2e 100%);
    color: #f8f8f8;
    padding: 24px;
  }
  h1 { font-size: 28px; margin-bottom: 18px; color: #ffd700; }
  .toolbar { display: flex; gap: 12px; margin-bottom: 24px; }
  .btn {
    padding: 12px 24px;
    background: #5a3a8e;
    color: #fff;
    border: 2px solid #ffd700;
    border-radius: 8px;
    font-size: 16px;
    font-weight: bold;
    cursor: pointer;
  }
  .btn:hover { background: #7050a0; }
  .panel {
    position: absolute;
    background: rgba(20, 20, 40, 0.92);
    border: 2px solid #ffd700;
    border-radius: 12px;
    padding: 20px;
    color: #fff;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
  }
  .panel h2 { font-size: 22px; margin-bottom: 12px; color: #ffd700; }
  .panel p { font-size: 14px; line-height: 1.5; margin-bottom: 8px; }
  .item-list { list-style: none; }
  .item-list li {
    padding: 8px 12px;
    background: rgba(255, 215, 0, 0.08);
    border-radius: 4px;
    margin-bottom: 6px;
    font-size: 13px;
  }
  #inventory-panel {
    display: none;
    left: 40px; top: 140px; width: 320px; height: 280px;
  }
  #stats-panel {
    display: block;
    left: 400px; top: 140px; width: 280px; height: 240px;
  }
  #settings-panel {
    display: none;
    left: 720px; top: 140px; width: 300px; height: 220px;
  }
  .close-btn {
    position: absolute;
    top: 8px; right: 12px;
    background: transparent;
    color: #ffd700;
    border: 1px solid #ffd700;
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 12px;
    cursor: pointer;
  }
</style>
</head>
<body>
  <h1>UE Widget Generator - Panel Toggle Test</h1>

  <div class="toolbar">
    <button class="btn" data-ue-toggle="Inventory">Open Inventory</button>
    <button class="btn" data-ue-toggle="Stats">Toggle Stats</button>
    <button class="btn" data-ue-toggle="Settings">Settings</button>
  </div>

  <div id="inventory-panel" class="panel" data-ue-panel="Inventory">
    <button class="close-btn" data-ue-toggle="Inventory">X</button>
    <h2>Inventory</h2>
    <ul class="item-list">
      <li>Iron Sword (+12 ATK)</li>
      <li>Healing Potion (x3)</li>
      <li>Leather Armor</li>
      <li>Magic Scroll</li>
    </ul>
  </div>

  <div id="stats-panel" class="panel" data-ue-panel="Stats" data-ue-panel-default="open">
    <button class="close-btn" data-ue-toggle="Stats">X</button>
    <h2>Player Stats</h2>
    <p><strong>Level:</strong> 14</p>
    <p><strong>HP:</strong> 230 / 250</p>
    <p><strong>MP:</strong> 80 / 120</p>
    <p><strong>STR:</strong> 22</p>
    <p><strong>DEX:</strong> 18</p>
  </div>

  <div id="settings-panel" class="panel" data-ue-panel="Settings">
    <button class="close-btn" data-ue-toggle="Settings">X</button>
    <h2>Settings</h2>
    <p>Master Volume</p>
    <p>Music Volume</p>
    <p>SFX Volume</p>
    <p>Resolution: 1920x1080</p>
  </div>

  <script>
    document.querySelectorAll('[data-ue-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetName = btn.getAttribute('data-ue-toggle');
        const panel = document.querySelector(\`[data-ue-panel="\${targetName}"]\`);
        if (!panel) return;
        const visible = window.getComputedStyle(panel).display !== 'none';
        panel.style.display = visible ? 'none' : 'block';
      });
    });
  <\/script>
</body>
</html>`;
    this.updatePreview();
    this.showToast('Example HTML loaded');
    return;
    this.htmlInput.value = `<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.tailwindcss.com"><\/script>
</head>
<body class="bg-[#0b0e12]">
  <div class="min-h-screen w-full p-8 text-white">
    <div class="mx-auto max-w-5xl">
      <div class="rounded-[28px] border border-white/10 bg-gradient-to-b from-[#161b22] to-[#111419] p-6 shadow-[0_18px_60px_rgba(0,0,0,0.35)]">
        <div class="flex justify-between">
          <div>
            <p class="text-sm text-white/50">Streamer Dashboard</p>
            <h1 class="text-3xl font-semibold">Yayın Kontrol Paneli</h1>
          </div>
          <div class="flex gap-2">
            <div class="px-3 py-1 rounded-full bg-green-500/10 text-green-300">● Canlı</div>
            <button class="px-3 py-1 rounded-xl bg-white/5">Duraklat</button>
            <button class="px-3 py-1 rounded-xl bg-red-500/10 text-red-300">Kapat</button>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-4 mt-6">
          <div class="p-4 rounded-2xl bg-white/5">
            <p class="text-sm text-white/50">Toplam Kazanç</p>
            <div class="text-2xl">$4,240</div>
          </div>
          <div class="p-4 rounded-2xl bg-white/5">
            <p class="text-sm text-white/50">Donate</p>
            <div class="text-2xl">$860</div>
          </div>
          <div class="p-4 rounded-2xl bg-white/5">
            <p class="text-sm text-white/50">Abone</p>
            <div class="text-2xl">$2,140</div>
          </div>
        </div>
        <div class="mt-6 p-4 rounded-2xl bg-white/5">
          <p class="text-sm text-white/50">Yayın Süresi</p>
          <div class="text-4xl">03:06:12</div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
    this.updatePreview();
    this.showToast('Example HTML loaded');
  }

  updatePreview() {
    const html = this.htmlInput.value;
    if (html.trim()) {
      this.previewFrame.srcdoc = html;
    }
  }

  togglePreview() {
    this.previewOpen = !this.previewOpen;
    this.previewFrame.style.display = this.previewOpen ? 'block' : 'none';
    this.previewToggle.classList.toggle('open', this.previewOpen);
  }

  updateSummary(elements, usedFonts = [], data = null, jsonObject = null) {
    const counts = {};
    const countJsonNode = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type) {
        counts[node.type] = (counts[node.type] || 0) + 1;
        // Account for synthesized child widgets that the T3D emits but the
        // JSON tree encodes as properties (not as separate child nodes).
        // Without this the chip strip undercounts what UE actually imports.
        if (node.type === 'ExpandableArea') {
          // Header text always exists.
          counts['TextBlock'] = (counts['TextBlock'] || 0) + 1;
          const hdr = node.header || {};
          if (String(hdr.arrowText || '').trim() ||
              (hdr.indicator && (hdr.indicator.collapsed || hdr.indicator.expanded))) {
            counts['TextBlock'] = (counts['TextBlock'] || 0) + 1;
          }
          if (hdr.backgroundColor || (hdr.borderColor && hdr.borderWidth)) {
            counts['Image'] = (counts['Image'] || 0) + 1;
          }
          // The EA itself is implemented as a CanvasPanel container in T3D.
          counts['CanvasPanel'] = (counts['CanvasPanel'] || 0) + 1;
        }
        if (node.type === 'ScrollBox') {
          // T3D wraps the ScrollBox content in a SizeBox + inner CanvasPanel.
          counts['SizeBox'] = (counts['SizeBox'] || 0) + 1;
          counts['CanvasPanel'] = (counts['CanvasPanel'] || 0) + 1;
        }
      }
      if (Array.isArray(node.children)) node.children.forEach(countJsonNode);
    };
    // Prefer counting from the FINAL exported JSON tree instead of the raw
    // analyzer `elements[]`. The analyzer list is an intermediate form and
    // can diverge from the actual exported hierarchy (panel/scroll synthesis,
    // button child labels, nested container children, etc.). Counting the
    // JSON tree keeps the chip strip aligned with what the user sees in the
    // saved JSON file and what the importer actually receives.
    if (jsonObject && jsonObject.root && Array.isArray(jsonObject.root.children)) {
      jsonObject.root.children.forEach(countJsonNode);
    } else {
      // Fallback for older call sites: count the raw analyzer leaf widgets.
      elements.forEach(e => { counts[e.ueType] = (counts[e.ueType] || 0) + 1; });
      if (data) {
        const panelCount = (data.panelGroups || []).length;
        if (panelCount > 0) counts['CanvasPanel'] = (counts['CanvasPanel'] || 0) + panelCount;
        const scrollCount = (data.scrollRegions || []).length;
        if (scrollCount > 0) counts['ScrollBox'] = (counts['ScrollBox'] || 0) + scrollCount;
      }
    }
    // CSS @keyframes animations: total entries across all widgets (each
    // entry maps to one `UWidgetAnimation` asset on the plugin side).
    let animCount = 0;
    elements.forEach(e => { if (e.animations && e.animations.length) animCount += e.animations.length; });
    // Prefer rendering "WidgetAnimation" as the LAST chip so the strip
    // visually groups widget types first, animation count after — easier
    // to scan when both are present.
    const orderedEntries = Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]));
    const chipsHtml = orderedEntries.map(([t, c]) =>
      `<div class="analysis-chip"><span class="count">${c}</span>${t}</div>`
    ).join('');
    const animChip = animCount > 0
      ? `<div class="analysis-chip analysis-chip-anim" title="${animCount} CSS @keyframes animation${animCount === 1 ? '' : 's'} exported as per-widget animations[] entries"><span class="count">${animCount}</span>WidgetAnimation</div>`
      : '';
    this.analysisSummary.innerHTML = chipsHtml + animChip;

    if (this.fontSummary && this.fontList) {
      if (usedFonts.length) {
        this.fontSummary.style.display = 'block';
        const esc = v => String(v == null ? '' : v)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
        const typeLabel = {
          googleFonts: 'Google Fonts specimen',
          googleFontsSearch: 'Google Fonts search',
          iconFont: 'Icon library'
        };
        this.fontList.innerHTML = usedFonts.map(font => {
          // Back-compat: accept plain strings too
          const data = typeof font === 'string' ? { name: font } : (font || { name: '' });
          const safeName = esc(data.name);
          if (data.url) {
            const safeUrl = esc(data.url);
            const tip = typeLabel[data.type] ? `${safeName} — ${typeLabel[data.type]}` : safeName;
            return `<a class="font-chip font-chip-linked" href="${safeUrl}" target="_blank" rel="noopener noreferrer" title="${tip}">${safeName}</a>`;
          }
          return `<span class="font-chip" title="${safeName}">${safeName}</span>`;
        }).join('');
      } else {
        this.fontSummary.style.display = 'none';
        this.fontList.innerHTML = '';
      }
    }
  }

  formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  getDataUrlByteSize(dataUrl) {
    const base64 = dataUrl.split(',')[1];
    if (!base64) return 0;
    const padding = (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    return Math.floor((base64.length * 3) / 4) - padding;
  }

  getImageDimensions(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ w: 0, h: 0 });
      img.src = dataUrl;
    });
  }

  async updateTextures(textures) {
    this.lastTextures = textures;
    // The panel hosts BOTH the texture grid AND the "JSON Package"
    // download button. Hiding the entire panel when no textures were
    // baked left the JSON Package button orphaned and looked like a
    // bug to end users (their report: "panel açılmayınca bug gibi
    // algılıyor son kullanıcı"). Always show the panel after a
    // successful generation; only the Textures-ZIP button + the
    // texture list collapse when the bake produced nothing.
    this.texturePanel.style.display = 'block';
    const dlTexBtn = document.getElementById('downloadAllTexturesBtn');
    const totalSizeEl = document.getElementById('textureTotalSize');
    if (!textures.length) {
      if (dlTexBtn) dlTexBtn.style.display = 'none';
      if (totalSizeEl) totalSizeEl.textContent = '';
      this.textureList.innerHTML =
        '<div style="padding:14px 12px;font-size:11px;color:var(--text-tertiary);text-align:center;">' +
        'No textures generated for this layout — solid colors only.<br>' +
        'JSON Package below still contains the full widget tree.' +
        '</div>';
      return;
    }
    if (dlTexBtn) dlTexBtn.style.display = '';

    // Convert any non-data URL (external https, blob:, file://) to a data URL so
    // it can survive outside the blob/srcdoc context and be included in zip exports.
    const urlToDataUrl = (url) => new Promise(resolve => {
      if (!url || /^data:/.test(url)) { resolve(url); return; }
      // Try fetch first (works for blob: and same-origin file:)
      fetch(url).then(r => r.blob()).then(b => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => resolve(null);
        fr.readAsDataURL(b);
      }).catch(() => {
        // Fallback: draw via HTMLImageElement → canvas (handles cross-origin blobs)
        const img = new Image();
        img.onload = () => {
          try {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth || 1; c.height = img.naturalHeight || 1;
            c.getContext('2d').drawImage(img, 0, 0);
            resolve(c.toDataURL('image/png'));
          } catch { resolve(null); }
        };
        img.onerror = () => resolve(null);
        img.src = url;
      });
    });

    for (const t of textures) {
      if (/^data:/.test(t.url || '')) continue; // already a data URL
      try {
        const dataUrl = await urlToDataUrl(t.url);
        if (dataUrl) t.url = dataUrl;
        else if (t.isExternalUrl && t.externalSrc) {
          // Last resort for external: fetch via externalSrc
          const dataUrl2 = await urlToDataUrl(t.externalSrc);
          if (dataUrl2) t.url = dataUrl2;
        }
      } catch(e) {
        console.warn('Could not resolve texture URL:', t.url, e);
      }
    }

    for (const t of textures) {
      const filter = normalizeTextureCssFilter(t.cssFilter);
      if (!filter || t._cssFilterApplied) continue;
      try {
        const filtered = await applyCssFilterToDataUrl(t.url, filter);
        if (filtered) {
          t.url = filtered;
          t._cssFilterApplied = true;
          t.cssFilter = filter;
        }
      } catch (e) {
        console.warn('Could not apply CSS texture filter:', t.cssFilter, e);
      }
    }

    // Compute per-image size & dimensions
    let totalBytes = 0;
    const infos = [];
    for (const t of textures) {
      const bytes = this.getDataUrlByteSize(t.url);
      const dims = await this.getImageDimensions(t.url);
      totalBytes += bytes;
      infos.push({ bytes, dims });
    }

    // Update total size in header
    const totalEl = document.getElementById('textureTotalSize');
    if (totalEl) totalEl.textContent = `(${textures.length} file${textures.length !== 1 ? 's' : ''} · ${this.formatFileSize(totalBytes)})`;

    this.textureList.innerHTML = textures.map((t, i) => {
      const info = infos[i];
      const sizeStr = this.formatFileSize(info.bytes);
      const dimStr = info.dims.w ? `${info.dims.w}×${info.dims.h}` : '';
      const metaStr = [dimStr, sizeStr].filter(Boolean).join(' · ');
      return `
      <div class="texture-item">
        <img class="texture-thumb" src="${t.url}" alt="${t.name}" onerror="this.style.display='none'">
        <div class="texture-info">
          <div class="name">${t.name} ${
            t.isGradient ? '<span style="color:var(--accent);font-size:10px;">GRADIENT</span>' :
            t.isIcon ? '<span style="color:#a78bfa;font-size:10px;">ICON</span>' :
            t.isExternalUrl ? '<span style="color:#34d399;font-size:10px;">IMAGE</span>' : ''
          }</div>
          <div class="path">Import → ${t.suggestedPath}</div>
          <div style="font-size:10px;color:var(--text-tertiary);margin-top:2px;font-family:var(--font-mono);">${metaStr}</div>
        </div>
        <a class="btn" href="${t.url}" download="${t.name}" target="_blank">⬇</a>
      </div>`;
    }).join('') + `
      <div style="padding:12px 20px;font-size:11px;color:var(--text-tertiary);border-top:1px solid var(--border);">
        📁 Import all to <code style="color:var(--accent);">/Game/UI/Textures/</code> in Unreal before pasting widget code.
      </div>
    `;
  }

  buildTexturePackageEntries(textures) {
    const seenNames = new Map();
    return textures.map(t => {
      const relFolder = (t.suggestedPath || '/Game/UI/Textures/' + t.name)
        .replace(/^\//, '')
        .replace(/\/[^/]+$/, '');
      let finalName = t.name;

      if (seenNames.has(t.name)) {
        const count = seenNames.get(t.name) + 1;
        seenNames.set(t.name, count);
        const dotIdx = t.name.lastIndexOf('.');
        finalName = dotIdx >= 0
          ? t.name.slice(0, dotIdx) + `_${count}` + t.name.slice(dotIdx)
          : t.name + `_${count}`;
      } else {
        seenNames.set(t.name, 0);
      }

      return { ...t, relFolder, finalName };
    });
  }

  collectZipEntries(includeJson = false) {
    const zipEntries = [];
    const skippedEntries = [];

    if (includeJson && this.lastWidgetJson) {
      zipEntries.push({ path: 'Widget_Layout.json', text: this.lastWidgetJson });
    }

    const textureEntries = this.buildTexturePackageEntries(this.lastTextures || []);
    for (const entry of textureEntries) {
      // Only `data:<mime>;base64,<payload>` URLs carry zip-able bytes.
      // Everything else is skipped:
      //   - External `https://…` references (no bytes to embed; the user
      //     must re-host or re-import these manually in Unreal anyway).
      //   - Non-base64 data URLs (e.g. `data:image/svg+xml,<svg>…` —
      //     URL-encoded plaintext, NOT base64). Passing the suffix to
      //     `atob` throws `String contains an invalid character` and
      //     aborts the whole zip build, killing the JSON Package
      //     download. Strict regex match avoids that.
      const url = entry.url || '';
      const m = /^data:[^;,]*;base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
      const base64 = m ? m[1].replace(/\s+/g, '') : null;
      if (!base64) {
        skippedEntries.push(entry.finalName);
        continue;
      }
      const zipPath = entry.relFolder ? `${entry.relFolder}/${entry.finalName}` : entry.finalName;
      zipEntries.push({ path: zipPath, base64 });
    }

    return { zipEntries, skippedEntries };
  }

  downloadJsonPackage() {
    if (!this.lastWidgetJson) {
      this.showToast('No JSON data to package. Generate a widget first.'); return;
    }
    const { zipEntries, skippedEntries } = this.collectZipEntries(true);
    const blob = createZipBlob(zipEntries);
    downloadBlob(blob, this._exportFilename('', '_JSON_Package.zip', 'UE_JSON_Package.zip'));

    const packedTextureCount = Math.max(0, zipEntries.length - 1);
    const skippedNote = skippedEntries.length ? ` (${skippedEntries.length} skipped)` : '';
    this.showToast(`JSON Package: Widget_Layout.json + ${packedTextureCount} texture(s)${skippedNote}`, 'success');
  }

  downloadAllTextures() {
    if (!this.lastTextures || !this.lastTextures.length) {
      this.showToast('No textures to download'); return;
    }
    const { zipEntries, skippedEntries } = this.collectZipEntries(false);
    if (!zipEntries.length) {
      this.lastTextures.forEach((t, i) => {
        setTimeout(() => {
          const a = document.createElement('a');
          a.href = t.url;
          a.download = t.name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }, i * 300);
      });
      this.showToast('Textures could not be packed, downloading individually instead.');
      return;
    }

    const blob = createZipBlob(zipEntries);
    downloadBlob(blob, this._exportFilename('', '_Textures.zip', 'UE_Textures.zip'));
    const skippedNote = skippedEntries.length ? ` (${skippedEntries.length} skipped)` : '';
    this.showToast(`${zipEntries.length} texture(s) zipped!${skippedNote}`, 'success');
  }

  setStatus(state, text) {
    this.statusDot.className = 'status-dot ' + state;
    this.statusText.textContent = text;
  }

  showToast(msg, type) {
    this.toast.textContent = msg;
    this.toast.className = 'toast show' + (type ? ` ${type}` : '');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this.toast.className = 'toast'; }, 3000);
  }
}

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
});
