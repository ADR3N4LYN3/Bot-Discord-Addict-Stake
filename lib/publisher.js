import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { DateTime } from 'luxon';
import { extractCodeFromUrl, inferBonusRecord } from './parser.js';

function renderTitle(tpl) {
  const dateFR = DateTime.now().setZone('Europe/Paris').setLocale('fr')
    .toFormat('cccc dd LLLL yyyy').toUpperCase();
  return (tpl || '🎁 Bonus Stake').replace('{DATE_FR}', dateFR);
}

function renderIntro(tpl, rankMin) {
  return (tpl || 'Bonus détecté :').replace('{RANK_MIN}', rankMin);
}

export function buildPayloadFromUrl(url, { rankMin = 'Bronze', conditions = [] } = {}) {
  const buttonLabel = (process.env.BUTTON_LABEL_TEXT || '🎁 Lien du code').slice(0, 80);
  const imageUrl = (process.env.BONUS_IMAGE_URL || 'https://cdn.discordapp.com/attachments/1290178652327252009/1413168626780995704/Logo_Bonus_v2.png?ex=68baf358&is=68b9a1d8&hm=c0c8233270bfb2a6a9ed0467c5f9028f6a25d9ab9fcc063c4ced03ac369c9924&').trim() || null;

  const code = extractCodeFromUrl(url);
  if (!code) throw new Error('Paramètre code= introuvable');

  const rec = inferBonusRecord({ url, code }) || { kind: 'unknown', title: 'Bonus Stake', intro: '' };

  // URLs pour les deux boutons
  const linkUrlStakeCom = `https://stake.com/settings/offers?type=drop&code=${encodeURIComponent(code)}&currency=usdc&modal=redeemBonus`;
  const linkUrlStakeBet = `https://stake.bet/settings/offers?type=drop&code=${encodeURIComponent(code)}&currency=usdc&modal=redeemBonus`;

  const embed = new EmbedBuilder()
    .setColor(0x5865F2);

  if (imageUrl) embed.setImage(imageUrl);

  // Ajouter les conditions comme description si elles existent
  if (conditions && conditions.length > 0) {
    console.log('[publisher] Adding conditions to embed:', conditions);
    const conditionsText = conditions
      .map(c => `**${c.label}:** ${c.value}`)
      .join('\n');
    embed.setDescription(conditionsText);
  } else {
    console.log('[publisher] No conditions to display');
  }

  // Deux boutons : stake.bet en premier, puis stake.com
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setURL(linkUrlStakeBet)
      .setLabel('🎁 Stake.bet'),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setURL(linkUrlStakeCom)
      .setLabel('🎁 Stake.com')
  );

  return { embeds: [embed], components: [row], kind: rec.kind, code };
}

export async function publishDiscord(
  channel,
  payload,
  { roleId, pingSpoiler = true, pingEveryone = true } = {}
) {
  let content = '';
  let allowedMentions = { parse: [] };

  if (pingEveryone) {
    // vrai ping (notif)
    content = '@everyone';
    allowedMentions = { parse: ['everyone'] };
  } else if (roleId) {
    // ping rôle (notif)
    content = `<@&${roleId}>`;
    allowedMentions = { roles: [roleId] };
  } else if (pingSpoiler) {
    // faux ping : affichage ||@everyone||, aucune notif
    content = '||@everyone||';
    allowedMentions = { parse: [] };
  }

  return channel.send({ content, allowedMentions, ...payload });
}
