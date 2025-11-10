import 'dotenv/config';
import { Client, GatewayIntentBits, ActivityType, Events } from 'discord.js';
import { initStore } from './lib/store.js';
import useTelegramDetector from './detectors/telegram.js';

const {
  DISCORD_TOKEN, CHANNEL_ID, PING_ROLE_ID,
  TG_API_ID, TG_API_HASH, TG_SESSION, TG_CHANNELS
} = process.env;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ⬇️ Utilise 'clientReady' via Events.ClientReady (compatible v14 et prêt pour v15)
client.once(Events.ClientReady, async (c) => {
  console.log(`🚀 Connecté en tant que ${c.user.tag}`);

  try {
    await c.user.setPresence({
      status: 'online',
      activities: [{ name: 'Écoute et poste des bonus !', type: ActivityType.Playing }]
    });
  } catch (e) {
    console.error('Presence error:', e);
  }

  await initStore();

  if (TG_API_ID && TG_API_HASH) {
    await useTelegramDetector(client, CHANNEL_ID, PING_ROLE_ID, {
      apiId: TG_API_ID, apiHash: TG_API_HASH, session: TG_SESSION, channels: TG_CHANNELS
    });
    console.log('[telegram] détecteur chargé');
  } else {
    console.log('[telegram] non configuré (ajoute TG_API_ID/TG_API_HASH)');
  }
});

process.on('unhandledRejection', (err) => console.error('UnhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('UncaughtException:', err));

client.login(DISCORD_TOKEN);
