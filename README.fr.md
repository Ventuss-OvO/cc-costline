[English](README.md) | [中文](README.zh-CN.md) | [日本語](README.ja.md) | [Español](README.es.md)

# cc-costline

Statusline enrichie pour [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — ajoute le suivi des coûts, les limites d'utilisation et le classement dans votre terminal.

![Capture d'écran cc-costline](screenshot.png)

```
14.6k $2.42 · 40% Opus 4.6 / 5h:45% · 7d:8% · 30d:$866 / #2 $67.0
```

## Installation

```bash
npm i -g cc-costline && cc-costline install
```

Ouvrez une nouvelle session Claude Code et la statusline enrichie apparaîtra. Nécessite Node.js >= 22.

### Mise à jour

npm ne met pas à jour automatiquement les paquets globaux. Lance ceci pour obtenir la dernière version :

```bash
npm i -g cc-costline@latest
```

## Fonctionnalités

| Segment | Exemple | Description |
|---------|---------|-------------|
| Tokens / Coût / Contexte | `14.6k $2.42 · 40% Opus 4.6` | Nombre de tokens, coût, utilisation du contexte et modèle |
| Limites d'utilisation | `5h:45% · 7d:8%` | Utilisation Claude sur 5 heures et 7 jours (colorée comme le contexte). À 100 %, affiche un compte à rebours : `5h:-03:20` |
| Coût périodique | `30d:$866` | Coût cumulé glissant (configurable : 7j, 30j ou both) |
| Classement | `#2 $67.0` | Rang [ccclub](https://github.com/mazzzystar/ccclub) (si installé) |

### Couleurs

- **Contexte et limites** — vert (< 60 %) → orange (60-79 %) → rouge (≥ 80 %)
- **Rang au classement** — 1er : or, 2e : blanc, 3e : orange, autres : cyan
- **Coût périodique** — jaune

### Intégrations optionnelles

- **Limites d'utilisation Claude** — lit automatiquement les identifiants OAuth depuis le trousseau macOS. Il suffit de lancer `claude login`.
- **Classement ccclub** — installez [ccclub](https://github.com/mazzzystar/ccclub) (`npm i -g ccclub && ccclub init`). Le rang s'affiche automatiquement.

Les deux fonctionnent sans configuration : si indisponibles, le segment est masqué silencieusement.

## Commandes

```bash
cc-costline install              # Configurer l'intégration Claude Code
cc-costline uninstall            # Supprimer des paramètres
cc-costline refresh              # Recalculer manuellement le cache des coûts
cc-costline config --period 7d   # Afficher le coût sur 7 jours (par défaut)
cc-costline config --period 30d  # Afficher le coût sur 30 jours
cc-costline config --period both # Afficher les deux périodes
```

## Fonctionnement

1. `install` configure `~/.claude/settings.json` — définit la commande statusline et ajoute des hooks de fin de session. Vos paramètres existants sont préservés.
2. `render` est appelé par Claude Code à chaque tour. Il lit les totaux de tokens depuis stdin quand Claude Code les fournit, puis lit trois caches (aucun HTTP, aucun scan complet du répertoire) :
   - **Coût local** → `~/.cc-costline/cache.json`
   - **Limites d'utilisation** → `<os.tmpdir()>/sl-claude-usage`
   - **Rang ccclub** → `<os.tmpdir()>/sl-ccclub-rank`
3. Si un cache est obsolète, `render` lance un sous-processus détaché `cc-costline refresh-bg` qui rafraîchit les données en arrière-plan. `<os.tmpdir()>/sl-refresh.lock` empêche les rafraîchissements concurrents entre plusieurs fenêtres Claude Code, et `<os.tmpdir()>/sl-refresh.last` limite les spawns à un toutes les 30 s.
4. Le rafraîchissement de fond respecte les TTL de chaque source :
   - **Coût local** (TTL 2 min) : scan incrémental — cache par fichier (`mtime+size`), réutilise les entrées inchangées (~25 ms typique vs ~2 s à froid sur 1000+ fichiers jsonl)
   - **Limites d'utilisation** (retry 5 min, sensible au token) : récupère depuis `api.anthropic.com/api/oauth/usage`. Détecte la rotation du token OAuth pour relancer immédiatement (nouveau token = nouveau quota de débit). Les données périmées persistent en cas d'échec.
   - **Rang ccclub** (retry 90 s) : récupère depuis `ccclub.dev/api/rank`
5. `refresh` peut aussi être exécuté manuellement pour recalculer le cache de coût local ; les hooks de fin de session utilisent `refresh-bg` pour préchauffer tous les caches sans bloquer Claude Code.

<details>
<summary>Grille tarifaire</summary>

Prix par million de tokens (USD) :

| Modèle | Entrée | Sortie | Écriture cache | Lecture cache |
|--------|-------:|-------:|---------------:|--------------:|
| Opus 4.6 | 5 $ | 25 $ | 6,25 $ | 0,50 $ |
| Opus 4.5 | 5 $ | 25 $ | 6,25 $ | 0,50 $ |
| Opus 4.1 | 15 $ | 75 $ | 18,75 $ | 1,50 $ |
| Sonnet 4.5 | 3 $ | 15 $ | 3,75 $ | 0,30 $ |
| Sonnet 4 | 3 $ | 15 $ | 3,75 $ | 0,30 $ |
| Haiku 4.5 | 1 $ | 5 $ | 1,25 $ | 0,10 $ |
| Haiku 3.5 | 0,80 $ | 4 $ | 1,00 $ | 0,08 $ |

Les modèles inconnus utilisent le prix de leur famille, Sonnet par défaut.

</details>

## Développement

```bash
npm test    # Build + exécuter les tests unitaires (node:test, zéro dépendance)
```

## Désinstallation

```bash
cc-costline uninstall
npm uninstall -g cc-costline
```

## Remerciements

- [ccclub](https://github.com/mazzzystar/ccclub) par 碎瓜 ([@mazzzystar](https://github.com/mazzzystar)) — classement Claude Code entre amis

## Licence

MIT
