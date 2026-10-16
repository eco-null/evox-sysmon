// Tuş görseli: 144x144 SVG halka gösterge → PNG. `sharp` yalnız ilk çizimde yüklenir; böylece
// plugin host handshake'ini (5 sn) native modül yüklemesi beklemeden tamamlar.

export const KEY_SIZE = 144;

const COLORS = Object.freeze({
  background: '#0d0f14',
  track: '#1f2430',
  label: '#8b93a7',
  value: '#f3f4f6',
  ok: '#34d399',
  warn: '#fbbf24',
  hot: '#f87171',
  idle: '#9adcff',
});

export function loadColor(percent) {
  if (typeof percent !== 'number') return COLORS.track;
  if (percent >= 85) return COLORS.hot;
  if (percent >= 60) return COLORS.warn;
  return COLORS.ok;
}

export function tempColor(celsius) {
  if (typeof celsius !== 'number') return COLORS.label;
  if (celsius >= 85) return COLORS.hot;
  if (celsius >= 70) return COLORS.warn;
  return COLORS.idle;
}

export function escapeXml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Metni verilen genişliğe sığdırmak için yazı boyutunu küçültür (yaklaşık glif genişliği).
function fitSize(text, size, maxWidth) {
  const estimate = String(text).length * size * 0.58;
  return estimate > maxWidth ? Math.max(9, Math.floor((size * maxWidth) / estimate)) : size;
}

function text(value, { x, y, size, fill, anchor = 'middle', weight = 600, maxWidth = 124 }) {
  if (!value) return '';
  const fitted = fitSize(value, size, maxWidth);
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Segoe UI, Arial, sans-serif" font-size="${fitted}" font-weight="${weight}" fill="${fill}">${escapeXml(value)}</text>`;
}

/**
 * view: { label, value, percent?, corner?, cornerColor?, sub?, subColor? }
 * percent null ise halka boş kalır (veri yok).
 */
export function buildKeySvg(view) {
  const s = KEY_SIZE;
  const cx = s / 2;
  const cy = 76;
  const r = 38;
  const circumference = 2 * Math.PI * r;
  const percent = typeof view.percent === 'number' ? Math.min(100, Math.max(0, view.percent)) : null;
  const arc = percent == null || percent <= 0 ? ''
    : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${loadColor(percent)}" stroke-width="9" stroke-linecap="round"`
      + ` stroke-dasharray="${((circumference * percent) / 100).toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">`,
    `<rect width="${s}" height="${s}" rx="18" fill="${COLORS.background}"/>`,
    text(view.label, { x: 12, y: 24, size: 15, fill: COLORS.label, anchor: 'start', weight: 700, maxWidth: 70 }),
    text(view.corner, { x: s - 12, y: 24, size: 14, fill: view.cornerColor || COLORS.label, anchor: 'end', maxWidth: 60 }),
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${COLORS.track}" stroke-width="9"/>`,
    arc,
    text(view.value || '—', { x: cx, y: cy + 10, size: 28, fill: COLORS.value, weight: 700, maxWidth: 62 }),
    text(view.sub, { x: cx, y: 134, size: 16, fill: view.subColor || COLORS.label, maxWidth: 128 }),
    '</svg>',
  ].join('');
}

// Görsel çizilemezse tuşa yazılacak kısa metin (host başlığı en fazla 120 karakter).
export function viewText(view) {
  return [view.label, view.value || '—', view.sub].filter(Boolean).join('\n').slice(0, 120);
}

let sharpModule = null;
export async function renderPng(svg) {
  sharpModule ??= import('sharp').then((m) => m.default);
  const sharp = await sharpModule;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}
