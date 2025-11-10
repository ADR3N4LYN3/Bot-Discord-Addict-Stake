// detectors/telegram.js
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';
import { alreadySeen } from '../lib/store.js';
import { buildPayloadFromUrl, publishDiscord } from '../lib/publisher.js';
import { extractCodeFromUrl } from '../lib/parser.js';

// Import des events avec compatibilité de versions GramJS
import * as TEventsIndex from 'telegram/events/index.js';
let TEvents = { ...TEventsIndex };
try {
  if (!('NewMessage' in TEvents)) {
    const tmp = await import('telegram/events'); // certaines versions exposent ici
    TEvents = { ...TEvents, ...tmp };
  }
} catch { /* ignore */ }

const NewMessage = TEvents.NewMessage;
const EditedCtor = TEvents.MessageEdited || TEvents.EditedMessage || null;

export default async function useTelegramDetector(client, channelId, pingRoleId, cfg) {
  const apiId = Number(cfg.apiId);
  const apiHash = cfg.apiHash;
  const string = process.env.TG_STRING_SESSION || '';
  const debug = process.env.DEBUG_TELEGRAM === '1';

  // Normalise la liste de canaux (usernames sans @, et IDs -100...)
  const channelsRaw = (cfg.channels || '').split(',').map(s => s.trim()).filter(Boolean);
  const handles = new Set();
  const ids = new Set();
  for (const r of channelsRaw) {
    if (/^-100\d+$/.test(r)) ids.add(r);
    else handles.add(r.replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '').toLowerCase());
  }

  // Connexion Telegram
  const tg = new TelegramClient(new StringSession(string), apiId, apiHash, { connectionRetries: 5 });
  await tg.start({
    phoneNumber: () => input.text('Numéro de téléphone: '),
    password:   () => input.text('Mot de passe (2FA si activée): '),
    phoneCode:  () => input.text('Code reçu: '),
    onError: (err) => console.error(err),
  });
  console.log('[telegram] connecté');

  // Sauvegarde éventuelle de la string session
  const saved = tg.session.save();
  if (!process.env.TG_STRING_SESSION || process.env.TG_STRING_SESSION !== saved) {
    console.log('[telegram] String session:', saved);
  }

  if (debug) {
    console.log('[telegram] watching:',
      handles.size || ids.size ? `handles=[${[...handles]}], ids=[${[...ids]}]` : 'ALL CHATS');
  }

  // Health ping (optionnel)
  if (process.env.TG_HEALTH_PING === '1') {
    try {
      const ch = await client.channels.fetch(channelId);
      await ch.send(`🟢 Watcher Telegram OK — listening ${handles.size + ids.size ? 'to configured chats' : 'to all chats'}.`);
    } catch (e) { console.error('health ping error:', e.message); }
  }

  // -------- Helpers

  const isStakeHost = (h) => h.replace(/^www\./i, '').toLowerCase() === 'playstake.club';

  const normalizeUrl = (u) => {
    if (!u) return null;
    u = String(u).trim().replace(/[)\]\}.,;!?]+$/, ''); // ponctuation collée
    if (/^\/\//.test(u)) u = 'https:' + u;             // protocol-relative
    if (/^playstake\.club\b/i.test(u)) u = 'https://' + u; // "nue" -> https
    try {
      const parsed = new URL(u);
      if (parsed.hostname === 't.me' && parsed.pathname === '/iv' && parsed.searchParams.has('url')) {
        return normalizeUrl(parsed.searchParams.get('url'));
      }
    } catch { /* ignore */ }
    return u;
  };

  /**
   * Extrait les conditions du bonus depuis le texte du message
   * Format attendu : "Value: $X", "Total Drop Limit: $X,XXX", etc.
   * Retourne un tableau de { label, value }
   */
  function extractConditions(text) {
    const conditions = [];

    if (debug) {
      console.log('[telegram] Extracting conditions from text:', text.substring(0, 500));
    }

    // Pattern flexible pour capturer "Label: Value" (avec ou sans début de ligne)
    const pattern = /([A-Za-z\s]+):\s*([^\n]+)/g;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      const label = match[1].trim();
      const value = match[2].trim();

      // Filtrer les labels qui ressemblent à des conditions de bonus
      // et ignorer les URLs
      if (label && value && !/^https?:/i.test(value) && !/^https?:/i.test(label)) {
        if (debug) console.log('[telegram] Found condition:', label, ':', value);
        conditions.push({ label, value });
      }
    }

    if (debug) console.log('[telegram] Total conditions extracted:', conditions.length);
    return conditions;
  }

  /**
   * Récupère le premier lien playstake "bonus" depuis un message,
   * en priorisant l'entity "Here" (MessageEntityTextUrl), puis preview, boutons, texte.
   * Retourne { url, code, conditions } ou null.
   */
  function getStakeBonus(message) {
    const caption = message.message || '';
    const candidates = [];

    if (debug) {
      console.log('[telegram] Message text:', caption.substring(0, 200));
      console.log('[telegram] Entities count:', (message.entities || []).length);
    }

    // Extraire les conditions depuis le texte
    const conditions = extractConditions(caption);

    // Entities (cas "Here" et spoilers)
    for (const ent of message.entities || []) {
      const type = ent.className || ent._;
      if (debug) console.log('[telegram] Entity type:', type);

      if (type === 'MessageEntityTextUrl' && ent.url) {
        candidates.push(ent.url);
        if (debug) console.log('[telegram] Found TextUrl:', ent.url);
      }
      else if (type === 'MessageEntityUrl') {
        const start = ent.offset ?? 0, end = start + (ent.length ?? 0);
        const url = caption.substring(start, end);
        candidates.push(url);
        if (debug) console.log('[telegram] Found Url:', url);
      }
      // Support des spoilers (contenu masqué)
      else if (type === 'MessageEntitySpoiler') {
        const start = ent.offset ?? 0, end = start + (ent.length ?? 0);
        const spoilerText = caption.substring(start, end);
        if (debug) console.log('[telegram] Found Spoiler content:', spoilerText);
        // Chercher des URLs dans le spoiler
        const spoilerUrls = spoilerText.match(/https?:\/\/\S+/g) || [];
        const spoilerStakeUrls = spoilerText.match(/\bplaystake\.club\/\S+/gi) || [];
        candidates.push(...spoilerUrls, ...spoilerStakeUrls);
      }
    }

    // Preview
    if (message.media?.webpage?.url) {
      candidates.push(message.media.webpage.url);
      if (debug) console.log('[telegram] Found webpage URL:', message.media.webpage.url);
    }

    // Boutons inline
    for (const row of message.replyMarkup?.rows || [])
      for (const btn of row.buttons || [])
        if (btn?.url) {
          candidates.push(btn.url);
          if (debug) console.log('[telegram] Found button URL:', btn.url);
        }

    // Texte brut
    const textUrls = caption.match(/https?:\/\/\S+/g) || [];
    const stakeUrls = caption.match(/\bplaystake\.club\/\S+/gi) || [];
    candidates.push(...textUrls, ...stakeUrls);

    if (debug) console.log('[telegram] Total candidates:', candidates.length);

    // Sélectionne le 1er lien bonus valide avec code
    for (const raw of candidates) {
      const n = normalizeUrl(raw);
      if (!n) continue;
      try {
        const u = new URL(n);
        if (!isStakeHost(u.hostname)) continue;
        if (!/\/bonus(\b|\/|\?)/i.test(u.pathname + (u.search || ''))) continue;
        const code = extractCodeFromUrl(n);
        if (code) {
          if (debug) console.log('[telegram] Valid bonus found! URL:', n, 'Code:', code);
          return { url: n, code, conditions };
        }
      } catch { /* continue */ }
    }

    // Si aucun lien complet trouvé, chercher un code brut (dans les spoilers par exemple)
    if (debug) console.log('[telegram] No URL found, searching for raw codes...');

    // Chercher dans les spoilers et le texte des codes qui ressemblent à des codes Stake
    const allText = [caption, ...candidates].join(' ');
    const rawCodeMatch = allText.match(/\b[a-zA-Z0-9]{10,30}\b/g);

    if (rawCodeMatch && rawCodeMatch.length > 0) {
      // Tester chaque code potentiel
      for (const potentialCode of rawCodeMatch) {
        // Ignorer les codes qui sont clairement pas des codes bonus
        if (/^https?|^www\./i.test(potentialCode)) continue;

        // Construire une URL fictive pour tester avec extractCodeFromUrl
        const testUrl = `https://playstake.club/bonus?code=${potentialCode}`;
        const extractedCode = extractCodeFromUrl(testUrl);

        if (extractedCode === potentialCode) {
          if (debug) console.log('[telegram] Valid raw code found:', potentialCode);
          return { url: testUrl, code: potentialCode, conditions };
        }
      }
    }

    if (debug) console.log('[telegram] No valid bonus link or code found in message');
    return null;
  }

  async function getChatInfo(event, message) {
    try {
      const chat = await event.getChat();
      return {
        chatIdStr: chat?.id !== undefined ? String(chat.id) : '',
        usernameLower: chat?.username ? String(chat.username).toLowerCase() : ''
      };
    } catch {
      return { chatIdStr: message?.peerId?.channelId?.toString?.() || '', usernameLower: '' };
    }
  }

  // -------- Handler principal

  const handler = async (event, kind) => {
    const message = event.message;
    if (!message || !NewMessage) return;

    const { chatIdStr, usernameLower } = await getChatInfo(event, message);
    console.log(`[telegram] ${kind} in ${chatIdStr || usernameLower} -> msgId=${message.id}`);

    // (Réactive le filtre si tu veux restreindre)
    // if (handles.size || ids.size) {
    //   const ok = (usernameLower && handles.has(usernameLower)) || (chatIdStr && ids.has(chatIdStr));
    //   if (!ok) return;
    // }

    // Récupération du lien bonus
    const bonus = getStakeBonus(message);
    if (!bonus) return;

    // Dédup (canal + message seulement, sans le type d'event pour éviter les doublons NEW/EDIT)
    const key = `tg:${chatIdStr || 'x'}:${message.id}`;
    if (await alreadySeen(key)) return;

    if (debug) console.log('[telegram] lien trouvé:', bonus.url, 'code=', bonus.code);

    // Publication Discord (template viendra ensuite dans buildPayloadFromUrl)
    try {
      const payload = buildPayloadFromUrl(bonus.url, { rankMin: 'Bronze', conditions: bonus.conditions });
      const channel = await client.channels.fetch(channelId);
      await publishDiscord(channel, payload, { pingSpoiler: true });
      console.log('[telegram] bonus publié ->', payload.kind, payload.code);
    } catch (e) {
      console.error('[telegram] parse/publish error:', e.message);
    }
  };

  // -------- Branchement des events
  tg.addEventHandler(ev => handler(ev, 'NEW'), new NewMessage({}));
  if (EditedCtor) {
    tg.addEventHandler(ev => handler(ev, 'EDIT'), new EditedCtor({}));
  } else {
    console.warn('[telegram] EditedMessage event not available in this GramJS version; edit events disabled.');
  }
}
