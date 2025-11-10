// lib/parser.js
import { BONUS_TYPES } from '../config/types.js';

/**
 * Extrait la valeur du paramètre ?code=... d'une URL playstake.club,
 * en gérant les cas Telegram (t.me/iv?url=...), URLs nues/protocol-relative,
 * et la ponctuation collée.
 */
export function extractCodeFromUrl(raw) {
  if (!raw) return null;

  // Normalisation rapide
  let s = String(raw).trim()
    .replace(/[)\]\}.,;!?]+$/, ''); // ponctuation collée

  // protocol-relative ou "nue"
  if (/^\/\//.test(s)) s = 'https:' + s;
  if (/^playstake\.club\b/i.test(s)) s = 'https://' + s;

  // Déroule l'éventuel wrapper t.me/iv?url=...
  try {
    const tmp = new URL(s);
    if (tmp.hostname === 't.me' && tmp.pathname === '/iv' && tmp.searchParams.has('url')) {
      s = tmp.searchParams.get('url') || s;
    }
  } catch { /* on continue */ }

  // Parse "propre"
  let u;
  try {
    u = new URL(s);
  } catch {
    // Fallback tolérant
    const m = /(?:^|[?#&])code=([A-Za-z0-9_-]{3,128})/i.exec(s);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Domaine attendu
  const host = u.hostname.replace(/^www\./i, '').toLowerCase();
  if (host !== 'playstake.club') return null;

  // 1) Query
  for (const [k, v] of u.searchParams.entries()) {
    if (k.toLowerCase() === 'code' && v) {
      const val = decodeURIComponent(v);
      if (/^[A-Za-z0-9_-]{3,128}$/.test(val)) return val;
    }
  }

  // 2) Fragment (#code=...)
  if (u.hash) {
    const frag = u.hash.slice(1);
    const m = /(?:^|[?#&])code=([A-Za-z0-9_-]{3,128})/i.exec(frag);
    if (m) return decodeURIComponent(m[1]);
  }

  // 3) Secours regex
  const m = /(?:^|[?#&])code=([A-Za-z0-9_-]{3,128})/i.exec(s);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Déduit le "type" de bonus (weekly/monthly/etc.) depuis le texte/url/code
 * selon vos patterns de BONUS_TYPES.
 */
export function inferBonusRecord({ text = '', url = '', code = '' }) {
  const s = `${text} ${url} ${code}`.toLowerCase();
  for (const rec of BONUS_TYPES) {
    if (rec.patterns.some(re => re.test(s))) return rec;
  }
  return null;
}
