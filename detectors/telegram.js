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
   * Récupère le premier lien playstake "bonus" depuis un message,
   * en priorisant l’entity "Here" (MessageEntityTextUrl), puis preview, boutons, texte.
   * Retourne { url, code } ou null.
   */
  function getStakeBonus(message) {
    const caption = message.message || '';
    const candidates = [];

    // Entities (cas "Here")
    for (const ent of message.entities || []) {
      const type = ent.className || ent._;
      if (type === 'MessageEntityTextUrl' && ent.url) candidates.push(ent.url);
      else if (type === 'MessageEntityUrl') {
        const start = ent.offset ?? 0, end = start + (ent.length ?? 0);
        candidates.push(caption.substring(start, end));
      }
    }

    // Preview
    if (message.media?.webpage?.url) candidates.push(message.media.webpage.url);

    // Boutons inline
    for (const row of message.replyMarkup?.rows || [])
      for (const btn of row.buttons || [])
        if (btn?.url) candidates.push(btn.url);

    // Texte brut
    candidates.push(...(caption.match(/https?:\/\/\S+/g) || []));
    candidates.push(...(caption.match(/\bplaystake\.club\/\S+/gi) || [])); // URLs nues

    // Sélectionne le 1er lien bonus valide avec code
    for (const raw of candidates) {
      const n = normalizeUrl(raw);
      if (!n) continue;
      try {
        const u = new URL(n);
        if (!isStakeHost(u.hostname)) continue;
        if (!/\/bonus(\b|\/|\?)/i.test(u.pathname + (u.search || ''))) continue;
        const code = extractCodeFromUrl(n);
        if (code) return { url: n, code };
      } catch { /* continue */ }
    }
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

    // Dédup (canal + message + type d'event)
    const key = `tg:${chatIdStr || 'x'}:${message.id}:${kind}`;
    if (await alreadySeen(key)) return;

    if (debug) console.log('[telegram] lien trouvé:', bonus.url, 'code=', bonus.code);

    // Publication Discord (template viendra ensuite dans buildPayloadFromUrl)
    try {
      const payload = buildPayloadFromUrl(bonus.url, { rankMin: 'Bronze' });
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
