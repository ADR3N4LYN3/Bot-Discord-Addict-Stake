// detectors/telegram.js
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';
import { alreadySeen } from '../lib/store.js';
import { buildPayloadFromUrl, publishDiscord } from '../lib/publisher.js';
import { extractCodeFromUrl, inferBonusRecord } from '../lib/parser.js';
import { DateTime } from 'luxon';
import { initOCR, extractCodeFromImage, extractCodeFromVideo, cleanupFile, isAlreadyProcessed, markAsProcessed } from '../lib/ocr.js';
import fs from 'fs';
import path from 'path';

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

  // Normalise la liste de canaux (usernames sans @, et IDs -100... ou numériques)
  const channelsRaw = (cfg.channels || '').split(',').map(s => s.trim()).filter(Boolean);
  const handles = new Set();
  const ids = new Set();
  for (const r of channelsRaw) {
    // Reconnaître les IDs : -100..., ou purement numérique
    if (/^-?\d+$/.test(r)) {
      // Normaliser l'ID : retirer le préfixe -100 s'il existe
      let normalizedId = r;
      if (normalizedId.startsWith('-100')) {
        normalizedId = normalizedId.slice(4); // retire "-100"
      }
      ids.add(normalizedId);
    } else {
      handles.add(r.replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '').toLowerCase());
    }
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

  console.log('[telegram] Configured channels:',
    handles.size || ids.size ? `handles=[${[...handles]}], ids=[${[...ids]}]` : 'ALL CHATS');

  // Initialiser l'OCR pour la détection des codes dans les images/vidéos
  await initOCR();

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

      if (debug) {
        console.log('[telegram] Entity:', {
          type,
          offset: ent.offset,
          length: ent.length
        });
      }

      // Support des spoilers (contenu masqué)
      if (type === 'MessageEntitySpoiler') {
        const start = ent.offset ?? 0;
        const end = start + (ent.length ?? 0);
        const spoilerTextRaw = caption.substring(start, end);
        const spoilerText = spoilerTextRaw.trim();

        if (debug) {
          console.log('[telegram] Spoiler found:');
          console.log('[telegram]   Raw:', JSON.stringify(spoilerTextRaw));
          console.log('[telegram]   Trimmed:', JSON.stringify(spoilerText));
          console.log('[telegram]   Length:', spoilerText.length);
          console.log('[telegram]   Matches regex:', /^[a-zA-Z0-9]{10,30}$/.test(spoilerText));
        }

        // Le code est dans le spoiler (alphanumérique, 10-30 caractères)
        if (spoilerText && /^[a-zA-Z0-9]{10,30}$/.test(spoilerText)) {
          if (debug) console.log('[telegram] Valid code found in spoiler:', spoilerText);
          return { code: spoilerText, conditions };
        } else if (debug) {
          console.log('[telegram] Spoiler content does not match code pattern (expected 10-30 alphanumeric chars)');
        }
      }
    }

    if (debug) console.log('[telegram] No valid bonus code found in spoilers');
    return null;
  }

  async function getChatInfo(event, message) {
    let chatIdStr = '';
    let usernameLower = '';

    try {
      const chat = await event.getChat();

      if (debug) {
        console.log('[telegram] getChatInfo: chat.id=', chat?.id, 'chat.username=', chat?.username);
      }

      if (chat?.id !== undefined) {
        chatIdStr = String(chat.id);
      }
      if (chat?.username) {
        usernameLower = String(chat.username).toLowerCase();
      }
    } catch (err) {
      if (debug) {
        console.log('[telegram] getChatInfo error:', err.message);
      }
    }

    // Si chat.id est vide, essayer les fallbacks
    if (!chatIdStr) {
      if (debug) {
        console.log('[telegram] No chat.id, trying fallback: peerId=', message?.peerId);
      }

      // Méthode 1: channelId
      if (message?.peerId?.channelId) {
        chatIdStr = String(message.peerId.channelId);
      }
      // Méthode 2: chatId
      else if (message?.peerId?.chatId) {
        chatIdStr = String(message.peerId.chatId);
      }
      // Méthode 3: userId
      else if (message?.peerId?.userId) {
        chatIdStr = String(message.peerId.userId);
      }

      if (debug) {
        console.log('[telegram] Fallback chatIdStr=', chatIdStr);
      }
    }

    return { chatIdStr, usernameLower };
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
   * Remplace les templates {DATE_FR}, {MONTH_FR} et {RANK_MIN} dans le titre/intro
   */
  function replaceTemplates(text, rankMin = 'Bronze') {
    const now = DateTime.now().setZone('Europe/Paris').setLocale('fr');
    const dateFR = now.toFormat('cccc dd LLLL yyyy').toUpperCase();
    const monthFR = now.toFormat('LLLL yyyy').toUpperCase();
    return text
      .replace(/{DATE_FR}/g, dateFR)
      .replace(/{MONTH_FR}/g, monthFR)
      .replace(/{RANK_MIN}/g, rankMin);
  }

  // -------- Handler principal

  const handler = async (event, kind) => {
    const message = event.message;
    if (!message || !NewMessage) return;

    const { chatIdStr, usernameLower } = await getChatInfo(event, message);
    const caption = message.message || '';
    console.log(`[telegram] ${kind} in ${chatIdStr || usernameLower} -> msgId=${message.id}`);

    if (debug) {
      console.log('[telegram] Detected chatIdStr=', chatIdStr, 'usernameLower=', usernameLower);
      console.log('[telegram] Filter active:', handles.size || ids.size ? 'YES' : 'NO');
    }

    // Filtre pour n'écouter que les canaux configurés
    if (handles.size || ids.size) {
      const ok = (usernameLower && handles.has(usernameLower)) || (chatIdStr && ids.has(chatIdStr));
      if (debug) {
        console.log('[telegram] Channel filter check: ok=', ok);
        console.log('[telegram]   username match:', usernameLower && handles.has(usernameLower));
        console.log('[telegram]   id match:', chatIdStr && ids.has(chatIdStr));
      }
      if (!ok) return;
    }

    // Détection du canal pour appliquer la bonne logique
    const hasRainsTEAMMention = /@RainsTEAM/i.test(caption);

    if (debug) {
      console.log('[telegram] RainsTEAM detection: mention=', hasRainsTEAMMention);
    }

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

            // Construire l'URL et publier (format simple pour VIP Notices)
            const url = `https://stake.com?bonus=${encodeURIComponent(code)}`;
            const payload = buildPayloadFromUrl(url, {
              rankMin: 'Bronze',
              code: code,
              title: title,
              description: description,
              useSimpleFormat: true
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

    // -------- SYSTÈMES GÉNÉRIQUES : spoilers + OCR (pour tous les canaux non traités ci-dessus)
    // SYSTÈME 1: Spoilers textuels (code masqué dans le texte)
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
        console.log('[telegram] Spoiler bonus publié ->', bonus.code);
      } catch (e) {
        console.error('[telegram] parse/publish error:', e.message);
      }
      return; // Bonus traité, on s'arrête ici
    }

    // SYSTÈME 2: OCR - détection des codes dans les images/vidéos
    if (message.media) {
      const mediaType = message.media.className || message.media._;

      // Détecter les photos
      if (mediaType === 'MessageMediaPhoto') {
        // Vérifier si déjà traité (cache)
        if (isAlreadyProcessed(`photo:${message.id}`)) {
          if (debug) console.log('[telegram] OCR: photo already processed');
          return;
        }

        try {
          if (debug) console.log('[telegram] OCR: processing photo...');

          // Télécharger la photo
          const photoPath = path.join('/tmp', `tg_photo_${Date.now()}_${message.id}.jpg`);
          await tg.downloadMedia(message.media, { outputFile: photoPath });

          // Extraire le code avec OCR
          const result = await extractCodeFromImage(photoPath);

          // Nettoyer le fichier
          cleanupFile(photoPath);

          if (result.code) {
            // Dédup
            const key = `tg:${chatIdStr || 'x'}:${message.id}`;
            if (await alreadySeen(key)) return;

            markAsProcessed(`photo:${message.id}`);

            if (debug) console.log('[telegram] OCR: code found in photo:', result.code);

            // Extraire les conditions depuis le caption
            const conditions = extractConditions(caption);

            // Publier sur Discord
            const url = `https://stake.com/settings/offers?type=drop&code=${encodeURIComponent(result.code)}&currency=usdc&modal=redeemBonus`;
            const payload = buildPayloadFromUrl(url, { rankMin: 'Bronze', conditions, code: result.code });
            const channel = await client.channels.fetch(channelId);
            await publishDiscord(channel, payload, { pingSpoiler: true });
            console.log('[telegram] OCR photo bonus publié ->', result.code, `(confidence: ${result.confidence.toFixed(1)}%)`);
            return;
          } else {
            if (debug) console.log('[telegram] OCR: no code found in photo');
          }
        } catch (e) {
          console.error('[telegram] OCR photo error:', e.message);
        }
      }

      // Détecter les vidéos
      if (mediaType === 'MessageMediaDocument' && message.media.document?.mimeType?.startsWith('video/')) {
        // Vérifier si déjà traité (cache)
        if (isAlreadyProcessed(`video:${message.id}`)) {
          if (debug) console.log('[telegram] OCR: video already processed');
          return;
        }

        try {
          if (debug) console.log('[telegram] OCR: processing video...');

          // Télécharger la vidéo
          const videoPath = path.join('/tmp', `tg_video_${Date.now()}_${message.id}.mp4`);
          await tg.downloadMedia(message.media, { outputFile: videoPath });

          // Extraire le code avec OCR
          const result = await extractCodeFromVideo(videoPath);

          // Nettoyer le fichier
          cleanupFile(videoPath);

          if (result.code) {
            // Dédup
            const key = `tg:${chatIdStr || 'x'}:${message.id}`;
            if (await alreadySeen(key)) return;

            markAsProcessed(`video:${message.id}`);

            if (debug) console.log('[telegram] OCR: code found in video:', result.code);

            // Extraire les conditions depuis le caption
            const conditions = extractConditions(caption);

            // Publier sur Discord
            const url = `https://stake.com/settings/offers?type=drop&code=${encodeURIComponent(result.code)}&currency=usdc&modal=redeemBonus`;
            const payload = buildPayloadFromUrl(url, { rankMin: 'Bronze', conditions, code: result.code });
            const channel = await client.channels.fetch(channelId);
            await publishDiscord(channel, payload, { pingSpoiler: true });
            console.log('[telegram] OCR video bonus publié ->', result.code, `(confidence: ${result.confidence.toFixed(1)}%, ${result.framesProcessed} frames)`);
            return;
          } else {
            if (debug) console.log('[telegram] OCR: no code found in video (processed', result.framesProcessed, 'frames)');
          }
        } catch (e) {
          console.error('[telegram] OCR video error:', e.message);
        }
      }
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
