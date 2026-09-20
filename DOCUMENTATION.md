# AI Usage Monitor

Documentation complète du projet `token-dashboard`.

## 1. Résumé

AI Usage Monitor est un tableau de bord local qui transforme les données de consommation de Codex et OpenCode en métriques lisibles :

- nombre de sessions ;
- tokens d'entrée ;
- tokens mis en cache ;
- tokens de sortie ;
- tokens de raisonnement ;
- total de tokens ;
- répartition par modèle, plateforme et projet ;
- coûts estimés ;
- coût payé selon les abonnements configurés ;
- taux de cache et économie estimée ;
- activité par jour et par heure ;
- limites Codex sur cinq heures et sur la semaine ;
- historique des limites Codex ;
- état des sources Codex et OpenCode ;
- tarifs par modèle ;
- solde ADtention lorsqu'il est disponible.

L'application est volontairement locale. Les fichiers de sessions sont lus sur la machine, les données normalisées sont stockées dans SQLite localement et l'interface est servie par un serveur HTTP Node.js écoutant sur `127.0.0.1`.

## 2. Objectif produit

Le projet répond à trois questions :

1. Combien de tokens ont été utilisés ?
2. Où se trouve la consommation et quel coût représente-t-elle ?
3. Quelles plateformes, modèles, projets et périodes expliquent ce résultat ?

Le projet privilégie une lecture rapide, des filtres prévisibles, des calculs explicables et la conservation locale des données.

### Utilisateurs visés

- développeurs utilisant Codex ;
- développeurs utilisant OpenCode ;
- équipes techniques qui veulent suivre leur usage local ;
- utilisateurs qui ne veulent pas envoyer leurs historiques de sessions à un service tiers.

### Positionnement visuel

L'interface cherche une apparence calme, précise et experte. Elle évite les dashboards SaaS génériques, les gradients décoratifs, le glassmorphism, les néons et les animations inutiles.

## 3. Démarrage rapide

### Prérequis

- Node.js `22.5` ou plus récent ;
- Git pour le clonage et la fonction de mise à jour intégrée ;
- Codex installé et utilisé pour disposer de données Codex ;
- OpenCode installé et utilisé pour disposer de données OpenCode.

Le projet utilise les API natives de Node.js. Il n'a aucune dépendance npm déclarée et ne nécessite donc pas de `npm install` pour fonctionner.

### Cloner le projet

```powershell
git clone https://github.com/Noe-Briffa/token-dashboard.git
cd token-dashboard
```

### Windows

Double-cliquer sur `start.bat`.

Le script :

1. se place dans le dossier du projet ;
2. vérifie la présence de Node.js ;
3. lance `node src/server.js --open` ;
4. ouvre le navigateur ;
5. conserve la fenêtre ouverte pour afficher les erreurs éventuelles.

### macOS et Linux

```sh
./start.sh
```

Le script vérifie Node.js puis démarre le serveur avec l'option `--open`.

### Commandes npm

```powershell
npm start
npm run start:open
npm run collect
npm test
```

| Commande | Fonction |
| --- | --- |
| `npm start` | Démarre le serveur sans ouvrir automatiquement le navigateur. |
| `npm run start:open` | Démarre le serveur et ouvre le navigateur. |
| `npm run collect` | Importe Codex dans SQLite sans démarrer l'interface. |
| `npm test` | Lance les tests natifs Node.js. |

### Choisir un port

Par défaut, le serveur utilise un port libre et affiche l'URL choisie.

```powershell
$env:PORT=4318
npm start
```

L'interface est alors accessible à une adresse semblable à :

```text
http://127.0.0.1:4318
```

## 4. Architecture générale

```text
Fichiers Codex ~/.codex/sessions/*.jsonl
                    |
                    v
              collectCodex()
                    |
                    |
Base OpenCode ~/.local/share/opencode/opencode.db
                    |
                    v
             collectOpenCode()
                    |
                    v
          data/usage.sqlite local
                    |
                    v
              src/server.js
                    |
        --------------------------
        |                        |
        v                        v
  API JSON locale        Fichiers public/
                               |
                               v
                         public/app.js
                               |
                               v
                         Dashboard HTML
```

### Technologies

- Node.js en mode ESM ;
- serveur `node:http` natif ;
- SQLite via `node:sqlite` et `DatabaseSync` ;
- HTML, CSS et JavaScript sans framework frontend ;
- SVG généré directement côté navigateur pour les donuts et l'historique des quotas ;
- Git pour la mise à jour optionnelle depuis l'interface ;
- API OpenAI pour les limites Codex ;
- API ADtention pour le solde et les impressions rémunérées.

### Structure des fichiers

```text
token-dashboard/
├── public/
│   ├── index.html       Structure de la page
│   ├── app.js           Chargement API, filtres et rendu
│   └── style.css        Design responsive et thèmes
├── src/
│   ├── server.js        Serveur HTTP, API et requêtes SQLite
│   ├── collector.js     Schéma SQLite et collecteurs
│   └── cli.js           Import Codex en ligne de commande
├── test/
│   ├── collector.test.js
│   └── server-start.test.js
├── data/
│   └── usage.sqlite     Base locale générée, ignorée par Git
├── start.bat            Démarrage Windows
├── start.sh             Démarrage macOS/Linux
├── package.json         Scripts et contrainte Node.js
├── README.md            Guide rapide
├── PRODUCT.md           Intention produit
├── DESIGN.md            Système visuel
└── DOCUMENTATION.md     Ce document
```

## 5. Serveur local

Le serveur est implémenté dans `src/server.js` avec le module natif `node:http`.

### Adresse réseau

Le serveur écoute uniquement sur :

```text
127.0.0.1
```

Cela signifie qu'il n'est pas exposé directement aux autres machines du réseau local. Cette décision constitue la principale frontière de sécurité de l'application.

### Démarrage

Au démarrage :

1. le dossier `data/` est créé s'il n'existe pas ;
2. `data/usage.sqlite` est ouvert ;
3. le schéma et les migrations SQLite sont appliqués ;
4. le serveur commence à répondre ;
5. une première collecte est lancée environ une seconde après l'écoute ;
6. le navigateur peut charger l'interface avant la fin de cette collecte initiale.

Cette séquence évite que l'interface reste inaccessible pendant une collecte longue.

### Fichiers statiques servis

- `/` -> `public/index.html` ;
- `/app.js` -> `public/app.js` ;
- `/style.css` -> `public/style.css`.

Toutes les réponses JSON et tous les fichiers statiques utilisent `Cache-Control: no-store` afin d'éviter de conserver une version obsolète du dashboard ou des métriques.

## 6. Collecte Codex

### Source

Codex est lu depuis :

```text
~/.codex/sessions
```

L'authentification locale est lue depuis :

```text
~/.codex/auth.json
```

Le chemin est construit avec le dossier utilisateur courant. Il n'est donc pas codé en dur sur un nom de compte Windows ou macOS.

### Découverte des fichiers

Le collecteur parcourt récursivement `~/.codex/sessions` et récupère les fichiers terminant par `.jsonl`.

Si le dossier n'existe pas, le collecteur renvoie zéro fichier et ne supprime pas les anciennes données SQLite. Cela protège l'historique contre une absence temporaire du dossier source.

### Parsing JSONL

Chaque ligne est analysée comme un objet JSON. Les lignes invalides sont ignorées afin qu'une ligne corrompue ne rende pas tout le fichier inutilisable.

Le parser cherche notamment :

- `session_meta` pour l'identifiant, le dossier projet, l'origine et l'heure de création ;
- `turn_context` pour le modèle actif ;
- `payload.info.total_token_usage` pour les snapshots de tokens.

### Calcul des deltas

Codex écrit des compteurs cumulés. Le collecteur ne somme donc pas directement tous les snapshots. Il calcule la différence entre deux snapshots successifs pour éviter de compter plusieurs fois les mêmes tokens.

Les catégories suivies sont :

- `input_tokens` ;
- `cached_input_tokens` ;
- `output_tokens` ;
- `reasoning_output_tokens` ;
- `total_tokens`.

Si un compteur cumulé redescend, le snapshot précédent est remplacé et aucun delta négatif n'est importé.

### Découpage temporel

Les deltas sont regroupés par :

- jour calendaire ;
- heure ;
- modèle.

Les jours et heures sont calculés dans le fuseau `Europe/Paris`.

Une session qui change de modèle ou qui traverse plusieurs jours peut donc produire plusieurs lignes normalisées dans la base locale.

### Gestion des reprises et forks

Les fichiers de reprise peuvent contenir des compteurs qui recommencent à partir d'une valeur déjà observée. Les identifiants sont scoppés au fichier source afin d'éviter les collisions et les deltas sont calculés par fichier.

Les fichiers sans activité réelle ne créent pas de fausses sessions utiles.

### Plateforme et agent

Les sessions Codex sont enregistrées avec :

- plateforme : `codex` ;
- fournisseur : `openai` ;
- agent : `Codex Desktop` si l'origine le permet ;
- sinon agent : `Codex CLI`.

### Correction de projet spécifique

Le collecteur contient un override explicite pour un handoff ChatGPT référencé qui ne contient pas les bonnes métadonnées projet. Ce chemin est réattribué au projet ePortfolio.

Cet override est volontairement local au code actuel et ne constitue pas un système général de détection de projet.

## 7. Collecte OpenCode

### Source

OpenCode est lu depuis :

```text
~/.local/share/opencode/opencode.db
```

La base source est ouverte en lecture seule. Le dashboard ne modifie pas la base OpenCode.

Si le fichier est absent, OpenCode apparaît comme `non connecté` et l'application continue de fonctionner avec Codex ou les données déjà présentes.

### Tables lues

Le collecteur lit principalement :

- `session` ;
- `project` ;
- `message` si cette table existe.

Les informations de session incluent notamment :

- identifiant ;
- projet ;
- parent ;
- agent ;
- modèle ;
- coût rapporté ;
- temps de création et de mise à jour ;
- compteurs de tokens.

### Modèles et fournisseurs

OpenCode peut stocker le modèle sous forme de texte simple ou de JSON. Le collecteur tente de récupérer :

- `id` du modèle ;
- `providerID` du fournisseur ;
- variante éventuelle.

En cas de JSON invalide, le texte brut est utilisé comme identifiant de modèle.

### Agrégation des messages

Lorsque la table `message` est disponible, les tokens sont agrégés avec davantage de précision :

- par `modelID` ;
- par fournisseur ;
- par jour Europe/Paris ;
- par heure Europe/Paris.

Les tokens de cache sont lus depuis `tokens.cache.read`.

Le total est pris depuis `tokens.total` lorsqu'il existe. Sinon il est recalculé avec :

```text
input + cache read + output + reasoning
```

Si l'agrégation des messages échoue, le collecteur utilise les compteurs agrégés de la session comme solution de repli.

### Projection locale

La projection OpenCode est reconstruite à chaque collecte :

1. les anciennes lignes `platform='opencode'` sont supprimées ;
2. les sessions actuelles sont importées ;
3. les sessions supprimées de la base source disparaissent aussi du dashboard.

Ce choix évite de conserver des sessions fantômes.

## 8. Base SQLite

La base locale est :

```text
data/usage.sqlite
```

Elle utilise le mode WAL (`Write-Ahead Logging`) et est ignorée par Git. Les fichiers temporaires SQLite `-wal` et `-shm` peuvent être présents pendant l'exécution.

### Table `sessions`

Cette table contient la projection normalisée des sources.

| Colonne | Rôle |
| --- | --- |
| `id` | Identifiant normalisé unique. |
| `platform` | `codex` ou `opencode`. |
| `provider` | Fournisseur du modèle. |
| `agent` | Agent ayant produit la session. |
| `source_path` | Fichier ou identifiant source. |
| `project` | Projet associé. |
| `model` | Modèle utilisé. |
| `started_at` | Début de la ligne normalisée. |
| `ended_at` | Fin de la ligne normalisée. |
| `duration_seconds` | Durée estimée. |
| `input_tokens` | Tokens d'entrée. |
| `cached_input_tokens` | Tokens d'entrée servis par le cache. |
| `output_tokens` | Tokens de sortie. |
| `reasoning_tokens` | Tokens de raisonnement. |
| `total_tokens` | Total normalisé. |
| `estimated_cost_usd` | Ancienne colonne conservée par compatibilité de schéma. |
| `reported_cost_usd` | Coût rapporté par la source lorsqu'il existe. |
| `updated_at` | Heure de mise à jour de la projection. |

### Table `model_pricing`

Cette table contient les prix saisis pour chaque couple plateforme/modèle.

| Colonne | Rôle |
| --- | --- |
| `platform` | Plateforme concernée. |
| `model` | Modèle concerné. |
| `input_usd_per_million` | Prix des tokens d'entrée. |
| `cached_input_usd_per_million` | Prix des tokens d'entrée cache. |
| `output_usd_per_million` | Prix des tokens de sortie. |
| `reasoning_usd_per_million` | Prix des tokens de raisonnement. |
| `provider` | Fournisseur du modèle. |
| `pricing_unit` | Unité, actuellement `per_1M_tokens`. |
| `updated_at` | Dernière modification. |

Des colonnes historiques existent également pour certains anciens formats de tarification.

### Table `limits_history`

Cette table conserve l'historique des quotas Codex :

- date de mesure ;
- plan ;
- pourcentage restant sur cinq heures ;
- pourcentage restant sur la semaine.

Un point est enregistré au maximum toutes les quinze minutes et les points de plus de trente jours sont supprimés.

### Table `app_settings`

Cette table conserve les réglages internes, notamment l'activation du traitement abonnement OpenAI/Codex.

Les valeurs sont stockées en texte et initialisées automatiquement à la création de la base.

### Repartir de zéro

Pour supprimer l'historique local :

1. arrêter le serveur ;
2. supprimer `data/usage.sqlite` ;
3. redémarrer l'application.

La base et son schéma seront recréés automatiquement.

## 9. Interface utilisateur

L'interface est une page HTML unique dans `public/index.html`. Le rendu est piloté par `public/app.js` et les styles sont dans `public/style.css`.

### En-tête

L'en-tête affiche :

- le nom `AI Usage Monitor` ;
- l'état et l'heure de la dernière actualisation ;
- le bouton de mise à jour Git lorsqu'une version distante est détectée ;
- le sélecteur de thème ;
- le bouton `Actualiser`.

### Filtres

Les contrôles disponibles sont :

- métrique : `Tokens` ou `Coût` ;
- mode de coût : `Estimation API` ou `Coût payé` ;
- période : 7, 14, 30, 90, 180 ou 365 derniers jours ;
- période personnalisée avec date de début et date de fin ;
- seuil minimum de tokens en millions.

La valeur par défaut du seuil est `10`, soit `10 M tokens`.

Le seuil filtre les modèles, plateformes et projets qui n'atteignent pas le minimum. Il s'applique à l'affichage des répartitions et non à la suppression des données en base.

Les filtres plateforme, agent, modèle et projet existent dans le code et peuvent être remplis par les interactions de l'interface, notamment en cliquant sur les légendes des donuts.

### Métriques principales

Le bandeau de métriques affiche :

- nombre de sessions sur la période ;
- total de tokens ;
- taux de prompt cache, séparé entre Codex et OpenCode ;
- modèle principal ;
- estimation API ou coût payé selon le mode choisi.

Les valeurs sont recalculées à partir de la réponse `/api/data` et du filtre de période courant.

### Prompt cache

Pour Codex, le taux est calculé comme :

```text
cached_input_tokens / input_tokens
```

Pour OpenCode, le taux est calculé comme :

```text
cached_input_tokens / (input_tokens + cached_input_tokens)
```

L'économie estimée utilise la différence entre le prix d'entrée normal et le prix d'entrée cache.

### Donuts

Trois graphiques circulaires affichent la répartition selon :

1. modèle ;
2. plateforme ;
3. projet.

Chaque légende est interactive. Cliquer sur un élément active le filtre correspondant. Cliquer à nouveau ou utiliser l'action `Tous` retire le filtre.

Les couleurs de modèles connus sont stables. Les nouveaux modèles reçoivent une couleur calculée à partir d'un hash stable afin d'éviter que les couleurs changent à chaque rendu.

### Répartition des tokens

Cette section sépare les tokens en quatre catégories :

- input ;
- cache ;
- output ;
- raisonnement.

Elle affiche une barre de proportion pour les tokens et une seconde barre pour le coût du mode sélectionné.

Les infobulles indiquent la valeur absolue et le pourcentage de chaque catégorie.

### Graphique temporel

Le graphique affiche les tokens ou le coût sur la période sélectionnée.

Granularités disponibles :

- jour ;
- semaine ;
- mois.

Les barres sont empilées par modèle. Les infobulles affichent le détail des modèles, le total et l'estimation API lorsque les données existent.

Lorsque l'affichage est en tokens, l'estimation API est affichée au-dessus des barres. Lorsque l'affichage est en coût, le nombre de tokens est affiché au-dessus.

### Heatmap d'activité

La heatmap représente `7 x 24`, soit 168 cellules :

- lignes : lundi à dimanche ;
- colonnes : heures de `00 h` à `23 h` ;
- fuseau : Europe/Paris.

Elle affiche :

- tokens par cellule ;
- sessions par cellule ;
- total par jour ;
- total par heure ;
- total sur la période ;
- pic journalier et horaire.

Les couleurs représentent des niveaux d'activité. Les seuils visuels sont actuellement basés sur 20, 40, 60 et 80 millions de tokens, avec une échelle relative pour les totaux de lignes et de colonnes.

### Limites Codex

Le bandeau des limites affiche :

- fenêtre de cinq heures ;
- fenêtre hebdomadaire ;
- pourcentage restant ;
- heure de reset ;
- plan lorsque l'API le fournit.

Sous `20 %` restant, la limite est signalée comme basse.

Les états possibles incluent notamment :

- connecté ;
- non connecté ;
- session expirée ;
- clé API sans quota ChatGPT applicable ;
- réseau inaccessible ;
- service indisponible ;
- limite de requêtes atteinte ;
- réponse sans fenêtres de quota.

En cas d'échec après un succès, les dernières valeurs connues peuvent être affichées comme anciennes avec leur âge.

### Historique des limites

L'historique est masqué par défaut et peut être affiché avec le bouton prévu dans le bandeau des limites.

La courbe est affichée uniquement après l'accumulation d'au moins quatre points. Elle contient les deux séries cinq heures et hebdomadaire sur les sept derniers jours disponibles.

La préférence d'affichage est conservée dans `localStorage` sous `usage-monitor-history`.

### Tarifs des modèles

La section repliable `Prix des modèles` permet de saisir, en USD par million de tokens :

- input ;
- cache ;
- output ;
- reasoning.

Les tarifs sont enregistrés dans SQLite. Modifier les prix recalcule les coûts sans réimporter les sessions.

Les nouveaux modèles détectés sont ajoutés automatiquement avec des prix nuls. Cela évite de bloquer l'import, mais le coût reste nul ou incomplet jusqu'à la saisie des tarifs.

### Sources

La section `Sources` affiche pour chaque plateforme :

- un indicateur de connexion ;
- le nom de la plateforme ;
- le nombre de sessions lorsqu'elle est connectée.

OpenCode peut être non connecté sans empêcher l'affichage des données Codex.

### Thèmes

Trois choix sont disponibles :

- système ;
- clair ;
- sombre.

Le choix est enregistré dans `localStorage` sous `usage-monitor-theme`. Le thème système suit `prefers-color-scheme`.

### Responsive et accessibilité

Le design prévoit :

- une largeur maximale de 1360 pixels ;
- des marges de 24 pixels sur desktop et 16 pixels sur mobile ;
- des contrôles d'au moins 36 pixels de hauteur ;
- un focus clavier visible ;
- des libellés et valeurs en complément des couleurs ;
- une réduction des transitions avec `prefers-reduced-motion`.

## 10. Actualisation des données

### Chargement simple

Un chargement simple appelle :

```text
GET /api/data
```

Il relit la base locale avec les filtres actifs, mais ne relance pas les collecteurs.

### Actualisation complète

Une actualisation complète appelle d'abord :

```text
POST /api/refresh
```

Puis elle recharge `/api/data`.

`/api/refresh` exécute :

```text
collectCodex(db)
collectOpenCode(db)
```

### Actualisation automatique actuelle

L'interface relance une actualisation complète toutes les quinze secondes :

```javascript
setInterval(() => {
  load(true);
  loadLimits();
  checkVersion();
}, 15000);
```

Cela permet d'afficher automatiquement les nouvelles sessions sans cliquer sur `Actualiser`.

Une promesse partagée évite de lancer plusieurs collectes simultanées lorsque deux actualisations se chevauchent.

### Limites Codex et cache réseau

Les quotas Codex disposent d'un cache côté collecteur de cinq minutes pour éviter de contacter trop souvent l'API OpenAI.

Le frontend ne demande réellement de nouvelles limites qu'au maximum toutes les soixante secondes, sauf lors d'une demande forcée.

Le solde ADtention dispose d'un cache de quinze secondes.

## 11. API HTTP

Toutes les routes sont locales et renvoient du JSON pour les endpoints API.

### `POST /api/refresh`

Relance les collecteurs Codex et OpenCode.

Réponse indicative :

```json
{
  "codex": {
    "platform": "codex",
    "imported": 12,
    "sourceSessions": 8,
    "source": ".../.codex/sessions"
  },
  "opencode": {
    "platform": "opencode",
    "status": "connected",
    "imported": 4,
    "sourceSessions": 3,
    "source": ".../opencode.db"
  }
}
```

### `GET /api/data`

Retourne le dashboard filtré.

Paramètres pris en charge :

| Paramètre | Rôle |
| --- | --- |
| `period` | Nombre de jours si aucune date de début n'est fournie. |
| `from` | Date minimale. |
| `to` | Date maximale. |
| `platform` | Filtre exact de plateforme. |
| `agent` | Filtre exact d'agent. |
| `model` | Filtre exact de modèle. |
| `project` | Filtre partiel de projet avec `LIKE`. |

La réponse contient notamment :

- `summary` ;
- `daily` ;
- `activity` ;
- `models` ;
- `platforms` ;
- `projects` ;
- `options` ;
- `pricing` ;
- `range` ;
- `sources` ;
- `activityVersion`.

### `GET /api/limits`

Récupère les quotas Codex auprès du backend ChatGPT avec le token lu dans `~/.codex/auth.json`.

Le token n'est pas écrit dans les logs par l'application.

La réponse normalisée ressemble à :

```json
{
  "status": "connected",
  "plan": "plus",
  "primary": {
    "remaining": 75,
    "resetsAt": "2026-05-22T14:16:34.000Z"
  },
  "secondary": {
    "remaining": 82,
    "resetsAt": "2026-05-26T20:20:37.000Z"
  },
  "fetchedAt": "2026-09-20T12:00:00.000Z"
}
```

### `GET /api/limits/history`

Retourne l'historique des limites.

Paramètre :

- `days`, limité entre 1 et 30, avec une valeur par défaut de 7.

Réponse :

```json
{
  "points": [
    {
      "t": "2026-09-20T10:00:00.000Z",
      "p": 80,
      "s": 65
    }
  ]
}
```

### `POST /api/pricing`

Enregistre les prix des modèles.

Corps attendu :

```json
{
  "pricing": [
    {
      "platform": "codex",
      "model": "gpt-5.6-codex",
      "input": "1.25",
      "cached": "0.125",
      "output": "5",
      "reasoning": "5"
    }
  ]
}
```

Les valeurs doivent être numériques et supérieures ou égales à zéro. L'enregistrement met à jour les lignes Codex et OpenCode du modèle afin que le même modèle conserve une tarification cohérente dans l'interface.

### `GET /api/adtention/balance`

Récupère le solde ADtention à partir de l'identifiant local présent dans le fichier OpenCode KV :

```text
~/.local/state/opencode/kv.json
```

L'API appelée est :

```text
https://api.adtention.ai/v1/balance?publisher_id=...
```

En cas d'échec, le dashboard peut afficher une ancienne valeur locale `adtention:balance` lorsqu'elle existe.

### `GET /api/version`

Retourne :

- un timestamp basé sur les fichiers frontend ;
- le commit Git local ;
- la version de la structure heatmap.

Cette route permet au navigateur de détecter qu'une nouvelle version frontend est disponible.

### `GET /api/update`

Il n'existe pas de mise à jour GET. La mise à jour utilise :

```text
POST /api/update
```

Le serveur exécute localement :

```text
git pull --ff-only
```

L'action est volontairement fast-forward only : elle n'écrase pas un historique local avec un merge automatique.

### Gestion des erreurs

Les exceptions serveur sont renvoyées en JSON avec HTTP `400` :

```json
{
  "error": "message d'erreur"
}
```

## 12. Calculs de coûts

### Estimation API

La formule générale est :

```text
(
  input_tokens * prix_input
  + cached_input_tokens * prix_cache
  + output_tokens * prix_output
  + reasoning_tokens * prix_reasoning
) / 1 000 000
```

Les prix sont stockés en USD par million de tokens.

Si aucun prix n'est défini, la valeur correspondante vaut zéro. L'interface affiche alors une indication de prix manquant selon le contexte.

### Coût payé

Lorsque le réglage d'abonnement est actif :

- les sessions Codex sont considérées comme couvertes ;
- les sessions OpenCode utilisant un modèle OpenAI reconnu sont considérées comme couvertes ;
- les autres sessions utilisent l'estimation tarifaire.

Le dashboard permet donc de comparer le coût théorique API avec le coût effectivement attribué à l'utilisateur.

### Économie du cache

L'économie de cache est estimée avec :

```text
cached_input_tokens * (prix_input - prix_cache) / 1 000 000
```

Ce calcul dépend des prix saisis et ne constitue pas une facture officielle.

### Coût rapporté par OpenCode

OpenCode peut fournir un coût rapporté dans sa base source. Il est conservé dans `reported_cost_usd` lors de l'import. Les agrégations principales du dashboard utilisent cependant les formules de tarification locale afin de garder les modes API et payé cohérents avec les prix configurés.

## 13. Limites, sécurité et confidentialité

### Ce qui reste local

Les éléments suivants restent sur la machine :

- fichiers de sessions Codex ;
- base OpenCode lue localement ;
- SQLite du dashboard ;
- prix saisis ;
- historique des quotas ;
- préférences de thème et d'historique.

### Requêtes externes

L'application contacte des services externes uniquement pour les fonctions qui le nécessitent :

- backend ChatGPT pour les limites Codex ;
- API ADtention pour le solde ;
- API GitHub pour détecter un commit plus récent ;
- GitHub via `git pull` lorsque l'utilisateur clique sur la mise à jour.

### Token Codex

Le token est lu depuis le fichier d'authentification local et placé dans l'en-tête de la requête OpenAI. Il n'est pas affiché dans l'interface et n'est pas écrit dans les logs applicatifs.

### Limites de sécurité

- le serveur n'a pas de système d'authentification ;
- la protection repose sur l'écoute loopback ;
- les corps JSON n'ont pas de limite de taille explicite ;
- l'endpoint de mise à jour peut exécuter `git pull` dans le répertoire du projet ;
- si le serveur est modifié pour écouter sur une adresse réseau, une authentification devra être ajoutée avant toute exposition.

## 14. Tests

Les tests utilisent `node:test` et `node:assert/strict`. Aucun framework de test externe n'est requis.

Commande :

```powershell
npm test
```

### Couverture actuelle

Les tests couvrent notamment :

- migration d'une ancienne table `sessions` ;
- import Codex ;
- normalisation des sessions ;
- coûts rapportés et coûts calculés ;
- import OpenCode ;
- cache OpenCode ;
- reconstruction de la projection OpenCode ;
- absence de base OpenCode ;
- normalisation des limites Codex ;
- erreurs réseau, authentification, service et rate limit ;
- cache des quotas ;
- historique limité et purge à trente jours ;
- reprises Codex avec compteurs cumulés ;
- découpage entre jours Europe/Paris ;
- override de projet ;
- ajout automatique des modèles aux tarifs ;
- démarrage du serveur avant la fin de la collecte ;
- présence des 168 cellules de heatmap.

### Résultat connu au dernier contrôle

```text
14 tests
14 réussites
0 échec
```

### Ce qui n'est pas couvert automatiquement

- rendu visuel navigateur complet ;
- responsive réel sur plusieurs tailles d'écran ;
- endpoint pricing par tests dédiés ;
- endpoint update par tests dédiés ;
- endpoint ADtention réel ;
- tests end-to-end du bouton d'actualisation ;
- tests du navigateur pour les thèmes et les interactions des donuts.

## 15. Dépannage

### Node.js trop ancien

Symptôme : le serveur ne démarre pas ou `node:sqlite` est indisponible.

Solution : installer Node.js `22.5` ou plus récent.

```powershell
node --version
```

### Le navigateur ne s'ouvre pas

Lancer :

```powershell
npm start
```

Puis ouvrir manuellement l'URL `http://127.0.0.1:PORT` affichée dans la console.

### Aucune donnée Codex

Vérifier que le dossier existe :

```text
~/.codex/sessions
```

Puis lancer :

```powershell
npm run collect
```

Les fichiers JSONL sans activité utile peuvent ne rien produire.

### OpenCode non connecté

Vérifier le fichier :

```text
~/.local/share/opencode/opencode.db
```

L'absence de ce fichier n'est pas bloquante pour Codex.

### Limites Codex indisponibles

Les causes possibles sont :

- absence de `~/.codex/auth.json` ;
- session ChatGPT expirée ;
- réseau inaccessible ;
- réponse OpenAI sans fenêtres ;
- limite de requêtes atteinte.

Relancer Codex peut renouveler la session locale.

### Les coûts sont à zéro

Ouvrir `Prix des modèles` et saisir les tarifs input, cache, output et reasoning pour les modèles utilisés.

Les tarifs sont conservés dans SQLite. Ils n'ont pas besoin d'être saisis à chaque démarrage.

### Repartir d'une base vide

Arrêter le serveur, supprimer `data/usage.sqlite`, puis redémarrer.

### L'interface semble ancienne après une mise à jour

Le serveur envoie `Cache-Control: no-store` et l'interface surveille la version des assets. Si nécessaire, effectuer un rechargement forcé du navigateur.

## 16. Limites fonctionnelles connues

### Pas de tableau de sessions dans l'interface actuelle

Le README historique mentionne des sessions détaillées. La version actuelle du frontend ne présente plus de tableau ou de route dédiée aux détails individuels. Les sessions restent néanmoins présentes dans SQLite et servent aux agrégations.

### Collecte fréquente

L'actualisation automatique relance les deux collecteurs toutes les quinze secondes. Codex peut reconstruire sa projection à partir des fichiers JSONL et OpenCode peut reconstruire sa projection depuis la base source. Sur un historique très volumineux, cela peut augmenter les lectures disque.

### Schéma OpenCode externe

Le collecteur dépend de la structure de la base OpenCode. Si OpenCode change ses tables ou ses colonnes, l'import peut basculer vers `not_connected` ou vers une agrégation de repli.

### JSONL Codex malformé

Les lignes invalides sont ignorées silencieusement. Le reste du fichier peut donc être importé sans signaler chaque ligne corrompue dans l'interface.

### Prix manquants

Un modèle nouvellement découvert reçoit automatiquement des prix nuls. Cela protège la collecte mais donne un coût incomplet tant que la tarification n'est pas saisie.

### Données locales non synchronisées

La base `data/usage.sqlite` est ignorée par Git. Les données de consommation et les prix ne sont donc pas poussés vers GitHub et ne sont pas synchronisés entre plusieurs machines.

## 17. Historique récent du projet

Les dernières évolutions importantes incluent :

- ajout de la heatmap d'activité ;
- amélioration du graphique d'historique des limites ;
- stabilisation des couleurs des modèles ;
- retrait du panneau de sessions de l'interface ;
- ajout des totaux journaliers ;
- ajout d'un seuil minimum de tokens ;
- actualisation automatique complète des tokens toutes les quinze secondes.

Dernier commit connu au moment de cette documentation :

```text
43ff5c2 fix: actualise automatiquement les tokens
```

## 18. Guide d'utilisation courant

### Voir l'usage des sept derniers jours

1. démarrer l'application ;
2. laisser `Tokens` sélectionné ;
3. laisser `7 derniers jours` sélectionné ;
4. lire les métriques principales ;
5. consulter les donuts et le graphique.

### Chercher le coût théorique

1. sélectionner `Coût` ;
2. sélectionner `Estimation API` ;
3. vérifier les tarifs dans `Prix des modèles` ;
4. consulter le coût total et les répartitions.

### Comparer avec le coût payé

1. sélectionner `Coût` ;
2. sélectionner `Coût payé` ;
3. comparer la valeur avec `Estimation API` ;
4. vérifier que les abonnements et modèles OpenAI sont identifiés comme prévu.

### Masquer les petits modèles

Dans le champ de seuil, saisir par exemple :

10
```

Cela affiche les éléments atteignant au moins `10 M tokens` dans les répartitions.

### Explorer un modèle ou un projet

Cliquer sur son élément dans la légende d'un donut. Le dashboard applique alors le filtre correspondant et recalcule toutes les zones dépendantes.

### Examiner les quotas

Lire les deux barres `5 heures` et `Hebdo`. Si le graphique historique est souhaité, cliquer sur `Afficher le graphique`.

### Actualiser immédiatement

Cliquer sur `Actualiser`. L'application relance les collecteurs, recharge les métriques et rafraîchit aussi les quotas forcés.

## 19. Principes de maintenance

Pour préserver le comportement du projet :

- conserver Node.js `>=22.5` ;
- garder les sources externes en lecture seule ;
- ne pas versionner `data/usage.sqlite` ;
- tester les transformations de tokens avant les changements de collecteur ;
- respecter le fuseau Europe/Paris utilisé par les graphiques ;
- conserver la séparation entre collecte, serveur API et rendu frontend ;
- exécuter `npm test` avant une livraison ;
- ne pas exposer le serveur sur le réseau sans ajouter une authentification.

## 20. Fichiers de référence

| Fichier | Responsabilité |
| --- | --- |
| `README.md` | Démarrage rapide et dépannage court. |
| `PRODUCT.md` | Objectif produit, utilisateurs et principes. |
| `DESIGN.md` | Palette, typographie, layout, composants et motion. |
| `src/collector.js` | Collecteurs, normalisation, SQLite et quotas. |
| `src/server.js` | Serveur, API, requêtes et coûts. |
| `src/cli.js` | Collecte Codex hors interface. |
| `public/index.html` | Structure de l'interface. |
| `public/app.js` | Fonctionnement frontend et rendu. |
| `public/style.css` | Design, responsive, thèmes et accessibilité. |
| `test/collector.test.js` | Tests du stockage et des collecteurs. |
| `test/server-start.test.js` | Test de démarrage serveur et heatmap. |
| `start.bat` | Lancement Windows. |
| `start.sh` | Lancement macOS/Linux. |

## Conclusion

AI Usage Monitor est un outil local de lecture et d'explication de la consommation IA. Son architecture reste volontairement simple : des fichiers source locaux, une projection SQLite, un serveur HTTP Node natif et une page frontend sans dépendances.

La valeur principale du projet vient de la normalisation des données hétérogènes Codex/OpenCode, du découpage temporel cohérent Europe/Paris, des calculs de coût configurables et de la visibilité immédiate sur les quotas et les concentrations d'usage.
