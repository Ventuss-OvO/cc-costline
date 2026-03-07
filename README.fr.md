[English](README.md) | [中文](README.zh-CN.md) | [日本語](README.ja.md) | [Español](README.es.md)

# cc-costline

Statusline enrichie pour [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — ajoute le suivi des coûts, les limites d'utilisation, l'utilisation de Zhipu GLM et le classement dans votre terminal.

![Capture d'écran cc-costline](screenshot.png)

```
526.3k $16.3 · 57% glm-4.7 / 7d:$137 / ZHIPU:124.0M ~ $74.4 · 5h:27% · MCP:10/100 · M:380.5M ~ $228
```

## Installation

```bash
npm i -g cc-costline && cc-costline install
```

Ouvrez une nouvelle session Claude Code et la statusline enrichie apparaîtra. Nécessite Node.js >= 22.

## Fonctionnalités

| Segment | Exemple | Description |
|---------|---------|-------------|
| Tokens ~ Coût / Contexte | `526.3k ~ $16.3 / 57% glm-4.7` | Nombre de tokens, coût, utilisation du contexte et modèle |
| Limites d'utilisation | `5h: 27%` | Utilisation Claude sur 5 heures (colorée comme le contexte) |
| Coût périodique | `7d: $137` ou `30d: $246` | Coût cumulé local (configurable : none/7d/30d/both) |
| Utilisation Zhipu GLM | `ZHIPU:124.0M ~ $74.4 · 5h:27% · MCP:10/100 · M:380.5M ~ $228` | Utilisation 24h, quota 5h, MCP mensuel, mois à ce jour |
| Classement | `#2/22 $67.0` | Rang [ccclub](https://github.com/mazzzystar/ccclub) (si installé) |

### Détails de l'utilisation Zhipu GLM

| Affichage | Exemple | Description |
|-----------|---------|-------------|
| Utilisation modèle 24h | `ZHIPU:124.0M ~ $74.4` | Total des tokens 24h et coût estimé |
| Quota 5h | `5h:27%` ou `5h:2:30` | Utilisation des tokens 5h, affiche le compte à rebours quand ≥100% |
| MCP mensuel | `MCP:10/100` | Appels d'outils MCP mensuels (search-prime + web-reader + zread) |
| Mois à ce jour | `M:380.5M ~ $228` | Utilisation cumulée du 1er à aujourd'hui |

### Exemples de statusline

#### Par défaut (period=7d, showResetTime=false)
```
526.3k $16.3 · 57% glm-4.7 / 7d:$137 / ZHIPU:124.0M ~ $74.4 · 5h:27% · MCP:10/100 · M:380.5M ~ $228
```

#### Minimal (period=none, showZhipu=false)
```
526.3k $16.3 · 57% glm-4.7 / 5h:27%
```

#### Complet (period=both, showResetTime=true)
```
526.3k $16.3 · 57% glm-4.7 / 7d:$137 · 30d:$246 / ZHIPU:124.0M ~ $74.4 · 5h:27% (17:16) · MCP:10/100 · M:380.5M ~ $228
```

#### Quota dépassé (5h > 100%)
```
526.3k $16.3 · 57% glm-4.7 / ZHIPU:124.0M ~ $74.4 · 5h:2:30 · MCP:10/100 · M:380.5M ~ $228
```
→ `5h:2:30` affiche le compte à rebours jusqu'au rafraîchissement (reste 2h 30m)

### Couleurs

- **Contexte et limites** — vert (< 60 %) → orange (60-79 %) → rouge (≥ 80 %)
- **Rang au classement** — 1er : or, 2e : blanc, 3e : orange, autres : bleu
- **Coût périodique** — jaune

### Intégrations optionnelles

- **Limites d'utilisation Claude** — lit automatiquement les identifiants OAuth depuis le trousseau macOS. Il suffit de lancer `claude login`.
- **Utilisation Zhipu GLM** — lit `ANTHROPIC_AUTH_TOKEN` et `ANTHROPIC_BASE_URL` depuis `~/.claude/settings.json` (config compatible avec Zhipu).
- **Classement ccclub** — installez [ccclub](https://github.com/mazzzystar/ccclub) (`npm i -g ccclub && ccclub init`). Le rang s'affiche automatiquement.

Toutes fonctionnent sans configuration : si indisponibles, le segment est masqué silencieusement.

## Commandes

```bash
cc-costline install              # Configurer l'intégration Claude Code
cc-costline uninstall            # Supprimer des paramètres
cc-costline refresh              # Recalculer manuellement le cache des coûts

# Configurer la période d'affichage
cc-costline config --period none   # Masquer les coûts 7d/30d
cc-costline config --period 7d     # Afficher uniquement le coût 7j
cc-costline config --period 30d    # Afficher uniquement le coût 30j
cc-costline config --period both   # Afficher à la fois 7j et 30j

# Configuration de l'utilisation Zhipu
cc-costline config --zhipu true    # Afficher l'utilisation Zhipu (par défaut)
cc-costline config --zhipu false   # Masquer l'utilisation Zhipu
cc-costline config --reset-time true   # Afficher l'heure de rafraîchissement du quota 5h
cc-costline config --reset-time false  # Masquer l'heure de rafraîchissement (par défaut)
```

## Fonctionnement

1. **install** configure `~/.claude/settings.json` — définit la commande statusline et ajoute des hooks de fin de session pour le rafraîchissement automatique. Vos paramètres existants sont préservés.
2. **render** lit le JSON stdin de Claude Code et le cache des coûts, puis produit la statusline formatée.
3. **refresh** parcourt `~/.claude/projects/**/*.jsonl`, extrait l'utilisation des tokens, applique la tarification par modèle et écrit dans `~/.cc-costline/cache.json`.
4. **L'utilisation Claude** est récupérée depuis `api.anthropic.com/api/oauth/usage` avec un cache fichier de 60 s dans `/tmp/sl-claude-usage`.
5. **L'utilisation Zhipu GLM** est récupérée depuis les APIs Zhipu (`/api/monitor/usage/model-usage`, `/api/monitor/usage/quota/limit`) avec un cache fichier de 60 s dans `/tmp/sl-zhipu-usage`.
6. **Le rang ccclub** est récupéré depuis `ccclub.dev/api/rank` avec un cache fichier de 120 s dans `/tmp/sl-ccclub-rank`.

<details>
<summary>Grille tarifaire Claude</summary>

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

<details>
<summary>Grille tarifaire Zhipu GLM</summary>

Prix par million de tokens (USD), source [LiteLLM](https://github.com/BerriAI/litellm) :

| Modèle | Entrée | Sortie | Lecture cache |
|--------|-------:|-------:|--------------:|
| zai/glm-4.7 | 0,60 $ | 2,20 $ | 0,11 $ |
| zai/glm-4.6 | 0,60 $ | 2,20 $ | 0,11 $ |
| zai/glm-4.5-air | 0,20 $ | 1,10 $ | - |
| zai/glm-5 | 1,00 $ | 3,20 $ | 0,20 $ |

**Note** : Le calcul des coûts utilise le prix d'entrée de manière uniforme (0,60 $/M), sans distinction entre les tokens d'entrée/sortie.

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
- [LiteLLM](https://github.com/BerriAI/litellm) — base de données unifiée de tarification des modèles
- [Zhipu AI](https://open.bigmodel.cn/) — service de modèles GLM

## Licence

MIT
