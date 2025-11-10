// detectors/telegram.js
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';
import { alreadySeen } from '../lib/store.js';
import { buildPayloadFromUrl, publishDiscord } from '../lib/publisher.js';
import { extractCodeFromUrl, inferBonusRecord } from '../lib/parser.js';
import { DateTime } from 'luxon';

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
      // Ignorer : URLs, "Code", et autres labels non pertinents
      if (label && value &&
          !/^https?:/i.test(value) &&
          !/^https?:/i.test(label) &&
          !/^code$/i.test(label)) {
        if (debug) console.log('[telegram] Found condition:', label, ':', value);
        conditions.push({ label, value });
      }
    }

    if (debug) console.log('[telegram] Total conditions extracted:', conditions.length);
    return conditions;
  }

  /**
   * Récupère le code bonus depuis un message StakecomDailyDrops
   * Le code est dans un spoiler (contenu masqué)
   * Retourne { code, conditions } ou null.
   */
  function getStakeBonus(message) {
    const caption = message.message || '';

    if (debug) {
      console.log('[telegram] Message text:', caption.substring(0, 200));
      console.log('[telegram] Entities count:', (message.entities || []).length);
    }

    // Extraire les conditions depuis le texte
    const conditions = extractConditions(caption);

    // Chercher dans les spoilers
    for (const ent of message.entities || []) {
      const type = ent.className || ent._;
      if (debug) console.log('[telegram] Entity type:', type);

      // Support des spoilers (contenu masqué)
      if (type === 'MessageEntitySpoiler') {
        const start = ent.offset ?? 0, end = start + (ent.length ?? 0);
        const spoilerText = caption.substring(start, end).trim();
        if (debug) console.log('[telegram] Found Spoiler content:', spoilerText);

        // Le code est dans le spoiler (alphanumérique, 10-30 caractères)
        if (spoilerText && /^[a-zA-Z0-9]{10,30}$/.test(spoilerText)) {
          if (debug) console.log('[telegram] Valid code found in spoiler:', spoilerText);
          return { code: spoilerText, conditions };
        }
      }
    }

    if (debug) console.log('[telegram] No valid bonus code found in spoilers');
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

  // -------- Cache système pour RainsTEAM (messages séparés: conditions puis code)
  const channelCache = new Map(); // { chatId: { conditions: [...], timestamp: number } }
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  function cleanExpiredCache() {
    const now = Date.now();
    for (const [key, value] of channelCache.entries()) {
      if (now - value.timestamp > CACHE_TTL) {
        channelCache.delete(key);
        if (debug) console.log('[telegram] Cache expired for', key);
      }
    }
  }

  /**
   * Détecte si c'est un message d'annonce RainsTEAM avec conditions
   * Ex: "FINAL BONUS DROP INCOMING!" ou "1st NORMAL DROP INCOMING!"
   */
  function isAnnouncementMessage(text) {
    return /DROP\s+INCOMING/i.test(text);
  }

  /**
   * Détecte si c'est un message "coming soon" à ignorer
   * Ex: "FINAL BONUS DROP IS COMING IN FEW SECONDS!"
   */
  function isComingSoonMessage(text) {
    return /COMING\s+IN\s+FEW\s+SECONDS/i.test(text) || /DROP\s+IS\s+COMING/i.test(text);
  }

  /**
   * Détecte si c'est un code standalone (court, pas de ":", pas d'URL)
   * Ex: "bestchat", "goodluck12"
   */
  function isStandaloneCode(text) {
    const trimmed = text.trim();
    // Doit être court, alphanumérique, sans ":" ni URL
    return trimmed.length > 0 &&
           trimmed.length < 50 &&
           !/[:\/]/.test(trimmed) &&
           /^[a-zA-Z0-9]+$/.test(trimmed);
  }

  /**
   * Cherche les URLs playstake.club dans le message (texte + entities)
   * Retourne la première URL trouvée ou null
   */
  function findPlaystakeUrl(message) {
    const caption = message.message || '';

    // 1. Chercher dans les entities (liens cliquables)
    for (const ent of message.entities || []) {
      const type = ent.className || ent._;
      if (type === 'MessageEntityTextUrl' && ent.url) {
        if (/playstake\.club/i.test(ent.url)) {
          return ent.url;
        }
      }
    }

    // 2. Chercher dans le texte brut
    const urlPattern = /https?:\/\/(?:www\.)?playstake\.club[^\s)]+/gi;
    const match = caption.match(urlPattern);
    if (match) return match[0];

    return null;
  }

  /**
   * Remplace les templates {DATE_FR} et {RANK_MIN} dans le titre/intro
   */
  function replaceTemplates(text, rankMin = 'Bronze') {
    const dateFR = DateTime.now().setZone('Europe/Paris').setLocale('fr')
      .toFormat('cccc dd LLLL yyyy').toUpperCase();
    return text
      .replace(/{DATE_FR}/g, dateFR)
      .replace(/{RANK_MIN}/g, rankMin);
  }

  // -------- Handler principal

  const handler = async (event, kind) => {
    const message = event.message;
    if (!message || !NewMessage) return;

    const { chatIdStr, usernameLower } = await getChatInfo(event, message);
    const caption = message.message || '';
    console.log(`[telegram] ${kind} in ${chatIdStr || usernameLower} -> msgId=${message.id}`);

    // (Réactive le filtre si tu veux restreindre)
    // if (handles.size || ids.size) {
    //   const ok = (usernameLower && handles.has(usernameLower)) || (chatIdStr && ids.has(chatIdStr));
    //   if (!ok) return;
    // }

    // Détection du canal pour appliquer la bonne logique
    // RainsTEAM : les 2 premiers messages contiennent @RainsTEAM, le 3ème (code) non
    const hasRainsTEAMMention = /@RainsTEAM/i.test(caption);

    if (debug) console.log('[telegram] RainsTEAM detection: mention=', hasRainsTEAMMention);

    // -------- SYSTÈME RAINSTEAM : détection par mention @RainsTEAM
    cleanExpiredCache();

    // Cas 1 : Message RainsTEAM avec annonce → stocker conditions
    if (hasRainsTEAMMention && isAnnouncementMessage(caption)) {
      const conditions = extractConditions(caption);
      if (conditions.length > 0) {
        channelCache.set(chatIdStr, { conditions, timestamp: Date.now() });
        if (debug) console.log('[telegram] RainsTEAM announcement: stored', conditions.length, 'conditions');
      }
      return; // Ne pas publier, on attend le code
    }

    // Cas 2 : Message RainsTEAM "coming soon" → ignorer
    if (hasRainsTEAMMention && isComingSoonMessage(caption)) {
      if (debug) console.log('[telegram] RainsTEAM: ignoring "coming soon" message');
      return;
    }

    // Cas 3 : Code standalone + cache existant → c'est le code RainsTEAM
    if (isStandaloneCode(caption)) {
      const cached = channelCache.get(chatIdStr);

      if (cached && cached.conditions) {
        const code = caption.trim();

        // Dédup
        const key = `tg:${chatIdStr || 'x'}:${message.id}`;
        if (await alreadySeen(key)) return;

        if (debug) console.log('[telegram] RainsTEAM: code found with cached conditions:', code);

        // Construire URL et publier
        try {
          const url = `https://stake.com/settings/offers?type=drop&code=${encodeURIComponent(code)}&currency=usdc&modal=redeemBonus`;
          const payload = buildPayloadFromUrl(url, { rankMin: 'Bronze', conditions: cached.conditions, code: code });
          const channel = await client.channels.fetch(channelId);
          await publishDiscord(channel, payload, { pingSpoiler: true });
          console.log('[telegram] RainsTEAM bonus publié ->', code);

          // Nettoyer le cache après publication
          channelCache.delete(chatIdStr);
          return;
        } catch (e) {
          console.error('[telegram] RainsTEAM publish error:', e.message);
          return;
        }
      }
      // Si pas de cache, on continue vers le système classique (peut-être un code dans un spoiler)
    }

    // -------- SYSTÈME VIP NOTICES : Weekly, Monthly, Pre-Monthly, Post-Monthly
    const playstakeUrl = findPlaystakeUrl(message);
    if (playstakeUrl) {
      try {
        const code = extractCodeFromUrl(playstakeUrl);
        if (code) {
          // Dédup
          const key = `tg:${chatIdStr || 'x'}:${message.id}`;
          if (await alreadySeen(key)) return;

          if (debug) console.log('[telegram] VIP Notices: playstake URL found:', playstakeUrl, 'code=', code);

          // Détecter le type de bonus (Weekly, Monthly, etc.)
          const caption = message.message || '';
          const rec = inferBonusRecord({ text: caption, url: playstakeUrl, code });

          if (rec) {
            // Remplacer les templates dans titre et intro
            const title = replaceTemplates(rec.title, 'Bronze');
            const description = replaceTemplates(rec.intro, 'Bronze');

            if (debug) console.log('[telegram] VIP Notices: detected type=', rec.kind, 'title=', title);

            // Construire l'URL et publier
            const url = `https://stake.com/settings/offers?type=drop&code=${encodeURIComponent(code)}&currency=usdc&modal=redeemBonus`;
            const payload = buildPayloadFromUrl(url, {
              rankMin: 'Bronze',
              code: code,
              title: title,
              description: description
            });

            const channel = await client.channels.fetch(channelId);
            await publishDiscord(channel, payload, { pingSpoiler: true });
            console.log('[telegram] VIP Notices bonus publié ->', rec.kind, code);
            return;
          } else {
            if (debug) console.log('[telegram] VIP Notices: bonus type not recognized');
          }
        }
      } catch (e) {
        console.error('[telegram] VIP Notices error:', e.message);
      }
      // Si erreur ou type non reconnu, on continue vers le système classique
    }

    // -------- SYSTÈME EXISTANT (StakecomDailyDrops) : code + conditions dans même message
    const bonus = getStakeBonus(message);
    if (bonus) {
      // Dédup (canal + message seulement, sans le type d'event pour éviter les doublons NEW/EDIT)
      const key = `tg:${chatIdStr || 'x'}:${message.id}`;
      if (await alreadySeen(key)) return;

      if (debug) console.log('[telegram] code trouvé:', bonus.code);

      // Publication Discord
      try {
        const url = `https://stake.com/settings/offers?type=drop&code=${encodeURIComponent(bonus.code)}&currency=usdc&modal=redeemBonus`;
        const payload = buildPayloadFromUrl(url, { rankMin: 'Bronze', conditions: bonus.conditions, code: bonus.code });
        const channel = await client.channels.fetch(channelId);
        await publishDiscord(channel, payload, { pingSpoiler: true });
        console.log('[telegram] StakecomDailyDrops bonus publié ->', bonus.code);
      } catch (e) {
        console.error('[telegram] parse/publish error:', e.message);
      }
      return; // Bonus traité, on s'arrête ici
    }

    // Si on arrive ici, c'est un message non géré
    if (debug) console.log('[telegram] Message ignored (no bonus detected)');
  };

  // -------- Branchement des events
  tg.addEventHandler(ev => handler(ev, 'NEW'), new NewMessage({}));
  if (EditedCtor) {
    tg.addEventHandler(ev => handler(ev, 'EDIT'), new EditedCtor({}));
  } else {
    console.warn('[telegram] EditedMessage event not available in this GramJS version; edit events disabled.');
  }
}
