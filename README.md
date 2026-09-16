# AI Usage Monitor

Local dashboard for Codex usage. Reads `~/.codex/sessions`, stores normalized
session totals in SQLite, serves dashboard at `http://127.0.0.1:<port>` (port aléatoire affiché au démarrage).

## Run

```powershell
npm start
# port aléatoire à chaque lancement, affiché dans la console
# pour forcer un port fixe :
$env:PORT=4318; npm start
```

No package install required: Node's built-in HTTP server and SQLite driver are used.
`npm run collect` performs one import without starting dashboard.

## Current scope

- Codex Desktop and CLI JSONL sessions
- Session, model, project, duration, input/cache/output/reasoning/total tokens
- Prix USD par modèle, sauvegardés dans SQLite depuis dashboard
- SQLite import is idempotent; active sessions update on next refresh

OpenCode is deliberately not guessed. Add its local database/log format as a
separate collector when a sample exists.

## Prix et sources

Ouvrir « Prix des modèles » dans dashboard et saisir les tarifs USD par million
de tokens. Un prix absent affiche `—`. Codex est connecté; OpenCode est visible
comme source future sans lecture de données non vérifiées.
