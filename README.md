# Token Dashboard

Token Dashboard est un tableau de bord local principalement conçu pour OpenCode. Il peut aussi lire la consommation Codex, mais plusieurs fonctions avancées, notamment les vues par agent et le suivi des skills, ne sont disponibles qu'avec OpenCode. Les sessions restent sur ta machine : elles sont lues localement, stockées dans SQLite, puis affichées dans une interface servie par Node sur `http://127.0.0.1`.

## Démarrage rapide

Prérequis : Node.js 22.5 ou plus récent (`node --version`) et Git.

```powershell
git clone https://github.com/Noe-Briffa/token-dashboard.git
cd token-dashboard
```

Sous Windows, double-clique sur `start.bat`. Sous macOS ou Linux, lance `./start.sh`. Le navigateur s'ouvre sur l'adresse locale du dashboard.

Tu peux aussi démarrer le serveur depuis un terminal :

```powershell
# ouvre le navigateur automatiquement
npm run start:open

# démarre le serveur sans ouvrir le navigateur
npm start

# utilise un port fixe
$env:PORT=4318; npm start
```

## Application Windows

La version Tauri ouvre le dashboard dans WebView2 et ajoute une icône dans la zone de notification.

```powershell
npm run tauri:dev
```

Fermer la fenêtre masque l'application dans le tray. Le menu contextuel permet de rouvrir le dashboard ou de quitter complètement l'application.

Pour générer l'installateur :

```powershell
npm run tauri:build
```

Le fichier `.exe` apparaît dans `src-tauri/target/release/bundle/`. La version web et la version Tauri utilisent la même base Windows, située dans `%APPDATA%\ai-usage-monitor\data\usage.sqlite`. Les tarifs et l'historique des limites y sont conservés.

Le serveur classique utilise le serveur HTTP et SQLite intégrés à Node. Tauri lance ce même serveur dans un processus Node, puis l'affiche dans WebView2. Le script `npm run desktop` reste disponible pour l'ancienne version Electron.

### Mettre à jour l'application installée

La version Tauri ne se met pas encore à jour automatiquement.

1. Ferme l'application.
2. Télécharge le dernier installateur `.exe` depuis les GitHub Releases du projet.
3. Lance l'installateur dans le même dossier.
4. Rouvre l'application.

L'installateur remplace les fichiers de l'application. Les sessions, les tarifs et l'historique restent dans `%APPDATA%\ai-usage-monitor\data\usage.sqlite`.

### Publier une version

La construction de l'application demande Rust et Cargo. Ces outils ne sont pas nécessaires pour utiliser un installateur déjà créé.

1. Mets à jour la version dans `src-tauri/tauri.conf.json` et `src-tauri/Cargo.toml`.
2. Lance `cargo check` depuis `src-tauri/`.
3. Génère l'installateur avec `npm run tauri:build`.
4. Publie le fichier `.exe` de `src-tauri/target/release/bundle/` dans une GitHub Release.

## Fonctionnalités

Le dashboard affiche les tokens par jour, semaine ou mois, ainsi que leur répartition par modèle, plateforme et projet. Il donne accès aux sessions détaillées et aux coûts estimés à partir des tarifs saisis dans « Prix des modèles ».

Les périodes de 14, 30, 90, 180 et 365 jours sont disponibles, avec une période personnalisée. Le thème suit le système par défaut, avec un choix clair ou sombre dans l'en-tête.

Un bandeau affiche les limites Codex en temps réel pour la fenêtre de 5 heures et la fenêtre hebdomadaire. Il indique le pourcentage restant et l'heure de réinitialisation. Les données sont rafraîchies toutes les 15 secondes et lorsque tu reviens sur l'onglet.

L'historique des limites est lu dans SQLite pendant la récupération des limites temps réel. Le dashboard peut donc afficher les points déjà enregistrés avant la fin de la requête réseau.

Les appels explicites aux skills OpenCode sont regroupés par jour et par agent. Ces vues, comme les matrices d'activité par agent, nécessitent OpenCode. Les limites d'affichage des skills, modèles et projets sont réglables séparément dans l'interface.

`npm run collect` importe les données sans lancer le dashboard.

## Données et confidentialité

Codex est lu depuis `~/.codex/sessions`. OpenCode est lu depuis `~/.local/share/opencode/opencode.db` lorsque le fichier existe. Si la base OpenCode est absente, sa source est signalée comme non connectée et le reste du dashboard continue de fonctionner.

Les limites Codex viennent de ta session ChatGPT locale (`~/.codex/auth.json`) via le backend OpenAI. Le token n'est pas écrit dans les logs. Si la session a expiré, le bandeau l'indique et tu peux relancer Codex pour la renouveler.

La base locale se trouve dans `data/usage.sqlite` et reste ignorée par Git. Les tarifs saisis dans le dashboard y sont conservés. Pour repartir de zéro, arrête l'application puis supprime ce fichier. Il sera recréé au prochain lancement.

## Dépannage

Si Node est trop ancien, mets-le à jour vers la version 22.5 ou plus récente. Le pilote SQLite intégré ne démarre pas avec une version antérieure.

Si le navigateur ne s'ouvre pas, recopie dans ton navigateur l'adresse `http://127.0.0.1:...` affichée dans la console.

Si aucune session n'apparaît, vérifie que `~/.codex/sessions` existe sur la machine. Les imports sont idempotents et peuvent être relancés sans créer de doublons.

## Tests

```powershell
npm test
```
