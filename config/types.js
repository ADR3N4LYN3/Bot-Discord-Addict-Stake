// Ordre = priorité
export const BONUS_TYPES = [
  { kind: 'post-monthly',
    patterns: [/post[-_ ]?monthly/i],
    title: '➡️ POST-MONTHLY',
    intro: `Profitez d'un bonus EXCEPTIONNEL en étant **{RANK_MIN}** minimum` },
  { kind: 'pre-monthly',
    patterns: [/pre[-_ ]?monthly/i],
    title: '➡️ PRE-MONTHLY',
    intro: `Profitez d'un bonus PRE-MONTHLY spécial` },
  { kind: 'top-players',
    patterns: [/top[-_ ]?vip/i, /top[-_ ]?players/i],
    title: '➡️ TOP PLAYERS',
    intro: `🎖️ Bonus réservé aux **Top Players / Top VIPs**` },
  { kind: 'monthly',
    patterns: [/\bmonthly\b/i, /mensuel/i, /month/i],
    title: '➡️ MONTHLY',
    intro: `Profitez d'un bonus mensuel en ayant joué sur Stake pendant le mois\n\n*Si le lien ne fonctionne pas, c'est que vous avez des Recharges dans VIP -> Recharge*` },
  { kind: 'weekly',
    patterns: [/\bweekly\b/i, /hebdo/i, /hebdomadaire/i, /week/i],
    title: '➡️ WEEKLY · {DATE_FR}',
    intro: `Profitez d'un bonus hebdomadaire en étant **{RANK_MIN}** minimum et en ayant joué cette semaine` }
];
