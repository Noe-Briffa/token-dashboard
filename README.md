# AI Usage Monitor

Petit tableau de bord local pour suivre ta consommation Codex et OpenCode. Tout reste sur ta machine : les sessions sont lues en local, stockées dans SQLite, et le dashboard tourne sur http://127.0.0.1 avec un port affiché au démarrage.

## Démarrage rapide

Préreqis : Node.js 22.5 ou plus récent (`node --version`) et git.

```powershell
git clone https://github.com/Noe-Briffa/token-dashboard.git
cd token-dashboard
```

Ensuite, au choix :

Double-clic (le plus simple) : `start.bat` sous Windows, `./start.sh` sous Mac ou Linux. Le navigateur s'ouvre tout seul sur la bonne adresse.

Ou en ligne de commande :

```powershell
npm run start:open
# sans ouverture auto du navigateur :
npm start
# pour forcer un port fixe :
$env:PORT=4318; npm start
```

## Application Windows

Pour lancer la version desktop avec une fenêtre intégrée et une icône dans la zone de notification :

```powershell
npm run desktop
```

La fermeture de la fenêtre masque l'application dans le tray. Le menu clic droit permet de rouvrir le dashboard ou de quitter complètement l'application.

Pour générer l'installateur Windows :

```powershell
npm run build:win
```

L'installateur est créé dans `release/`. Sous Windows, la version web et la version desktop partagent la base `%APPDATA%\ai-usage-monitor\data\usage.sqlite`, y compris les tarifs et l'historique des limites.

Le serveur classique utilise seulement le serveur HTTP et le pilote SQLite fournis avec Node. La version desktop utilise Electron et ses dépendances de packaging.

## Ce que tu y trouves

Tokens par jour, semaine ou mois, répartition par modèle et par plateforme, sessions détaillées, coûts estimés via les tarifs que tu saisis dans "Prix des modèles". Les périodes 14, 30, 90, 180 et 365 jours sont disponibles, plus une période personnalisée. Le thème suit le système par défaut, avec un choix clair ou sombre dans l'en-tête.

Un bandeau affiche tes limites Codex en temps réel : fenêtre 5 heures et fenêtre hebdo, en pourcent restant avec l'heure de reset. Il se rafraîchit toutes les 15 secondes et quand tu reviens sur l'onglet.

`npm run collect` fait un import sans lancer le dashboard.

## Données

Codex est lu depuis `~/.codex/sessions`. OpenCode est lu depuis `~/.local/share/opencode/opencode.db` quand le fichier existe, sinon la source s'affiche comme non connectée et le reste continue de marcher.

Les limites Codex viennent de ta session ChatGPT locale (`~/.codex/auth.json`), lue via le backend OpenAI. Ton token ne quitte jamais la machine autrement que pour cette requête, et il n'est jamais écrit dans les logs. Si la session a expiré, le bandeau l'indique, relance Codex pour la renouveler.

La base locale vit dans `data/usage.sqlite` (ignorée par git). Les tarifs saisis dans le dashboard sont conservés dedans. Pour repartir de zéro, arrête l'app et supprime ce fichier, il sera recréé au prochain lancement.

## Dépannage

Node trop vieux : mets à jour vers Node 22.5 ou plus récent, sinon le pilote SQLite intégré refuse de démarrer.

Le navigateur ne s'ouvre pas : recopie l'adresse `http://127.0.0.1:...` affichée dans la console.

Aucune session : vérifie que `~/.codex/sessions` existe sur cette machine. Les imports sont idempotents, tu peux relancer sans risque de doublons.

## Tests

```powershell
npm test
```
