// scripts/list-channels.js
import 'dotenv/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
const stringSession = process.env.TG_STRING_SESSION || '';

if (!apiId || !apiHash) {
  console.error('❌ TG_API_ID et TG_API_HASH requis dans .env');
  process.exit(1);
}

const client = new TelegramClient(new StringSession(stringSession), apiId, apiHash, {
  connectionRetries: 5
});

await client.start({
  phoneNumber: () => input.text('Numéro de téléphone: '),
  password: () => input.text('Mot de passe (2FA): '),
  phoneCode: () => input.text('Code reçu: '),
  onError: (err) => console.error(err),
});

console.log('✅ Connecté à Telegram\n');

const dialogs = await client.getDialogs({ limit: 100 });

console.log('📋 Liste des canaux et groupes:\n');
console.log(''.padEnd(80, '='));

for (const dialog of dialogs) {
  const entity = dialog.entity;

  // Filtrer pour afficher seulement les canaux/groupes
  if (entity.className === 'Channel' || entity.className === 'Chat') {
    const id = entity.id?.toString() || 'N/A';
    const username = entity.username ? `@${entity.username}` : '';
    const title = entity.title || 'Sans titre';
    const type = entity.broadcast ? '📡 Canal' : '👥 Groupe';

    console.log(`${type} | ${title}`);
    console.log(`  ID: ${id}`);
    if (username) console.log(`  Username: ${username}`);
    console.log(''.padEnd(80, '-'));
  }
}

console.log('\n💡 Utilise l\'ID (format: -100XXXXXXXXXX) ou le username dans TG_CHANNELS');
process.exit(0);
