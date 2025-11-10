import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { buildPayloadFromUrl, publishDiscord } from '../lib/publisher.js';

const url = process.argv[2] || 'https://playstake.club/bonus?code=BoostWeekly16A25';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  try {
    const channel = await client.channels.fetch(process.env.CHANNEL_ID);
    const payload = buildPayloadFromUrl(url, { rankMin: 'Bronze' });
    await publishDiscord(channel, payload, { roleId: process.env.PING_ROLE_ID });
    console.log('✅ Envoyé:', payload.kind, payload.code);
  } catch (e) {
    console.error('❌ Test failed:', e);
  } finally {
    process.exit(0);
  }
});

client.login(process.env.DISCORD_TOKEN);
