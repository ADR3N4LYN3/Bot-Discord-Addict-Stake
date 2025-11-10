# 🎁 Bot Discord Addict - Stake Bonus Codes

Bot Discord qui détecte automatiquement les codes bonus Stake depuis Telegram et les publie sur Discord.

## 📋 Fonctionnalités

- ✅ Détection automatique des codes bonus depuis les canaux Telegram
- ✅ Publication automatique sur Discord avec embed stylisé
- ✅ Détection des différents types de bonus (Weekly, Monthly, Pre-Monthly, Post-Monthly, Top Players)
- ✅ Système de déduplication (évite les doublons)
- ✅ Support des messages édités sur Telegram
- ✅ Bouton cliquable pour accéder au bonus

## 🚀 Installation

### Prérequis

- Node.js 16.9.0 ou supérieur
- Un bot Discord
- Des credentials Telegram API

### 1. Cloner le repository

```bash
git clone https://github.com/ADR3N4LYN3/Bot-Discord-Addict-Stake.git
cd Bot-Discord-Addict-Stake
```

### 2. Installer les dépendances

```bash
npm install
```

### 3. Configuration

Copier le fichier `.env.example` en `.env` et remplir les valeurs :

```bash
cp .env.example .env
```

#### Variables obligatoires :

- `DISCORD_TOKEN` : Token de votre bot Discord
- `CHANNEL_ID` : ID du channel Discord où publier les codes
- `TG_API_ID` : API ID Telegram (obtenu sur https://my.telegram.org)
- `TG_API_HASH` : API Hash Telegram
- `TG_CHANNELS` : Liste des canaux Telegram à surveiller (séparés par des virgules)

#### Obtenir les credentials Telegram :

1. Aller sur https://my.telegram.org
2. Se connecter avec son numéro de téléphone
3. Cliquer sur "API development tools"
4. Créer une nouvelle application
5. Copier l'`API ID` et l'`API Hash`

#### Variables optionnelles :

- `PING_ROLE_ID` : ID du rôle à mentionner
- `TG_STRING_SESSION` : Session Telegram (générée au premier lancement)
- `BONUS_BASE_URL` : URL de base pour les liens bonus
- `BUTTON_LABEL_TEXT` : Texte du bouton
- `BONUS_IMAGE_URL` : URL de l'image de l'embed
- `DEBUG_TELEGRAM` : Mode debug (0 ou 1)
- `TG_HEALTH_PING` : Envoyer un message de santé au démarrage (0 ou 1)

### 4. Premier lancement

Au premier lancement, le bot vous demandera :
- Votre numéro de téléphone
- Le code de vérification reçu par SMS/Telegram
- Votre mot de passe 2FA (si activé)

Une fois connecté, une `TG_STRING_SESSION` sera générée et affichée dans la console. Copiez-la dans votre fichier `.env` pour ne plus avoir à vous reconnecter.

## 📦 Utilisation

### Lancer le bot

```bash
npm start
```

### En production (avec PM2)

```bash
pm2 start index.js --name stake-bonus-bot
pm2 save
```

## 🎯 Types de bonus détectés

Le bot détecte automatiquement les types suivants :

- **Weekly** : Bonus hebdomadaire
- **Monthly** : Bonus mensuel
- **Pre-Monthly** : Bonus pré-mensuel
- **Post-Monthly** : Bonus post-mensuel
- **Top Players** : Bonus réservé aux Top VIP

## 📝 Structure du projet

```
.
├── config/
│   └── types.js          # Configuration des types de bonus
├── detectors/
│   └── telegram.js       # Détecteur Telegram
├── lib/
│   ├── parser.js         # Parser de codes bonus
│   ├── publisher.js      # Publication sur Discord
│   ├── store.js          # Gestion de la base de données
│   └── util.js           # Utilitaires
├── scripts/
│   ├── parse-test.js     # Test du parser
│   └── send-test.js      # Test de publication
├── index.js              # Point d'entrée
├── package.json
└── .env                  # Configuration (à créer)
```

## 🔒 Sécurité

- Ne jamais partager votre fichier `.env`
- Ne jamais commit vos tokens/credentials
- Garder votre `TG_STRING_SESSION` privée

## 📄 Licence

MIT

## 👤 Auteur

ADR3N4LYN3
