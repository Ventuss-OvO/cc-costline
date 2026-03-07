[English](README.md) | [中文](README.zh-CN.md) | [日本語](README.ja.md) | [Français](README.fr.md)

# cc-costline

Statusline mejorada para [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — añade seguimiento de costos, límites de uso, uso de Zhipu GLM y ranking en tu terminal.

![Captura de pantalla cc-costline](screenshot.png)

```
526.3k $16.3 · 57% glm-4.7 / 7d:$137 / ZHIPU:124.0M ~ $74.4 · 5h:27% · MCP:10/100 · M:380.5M ~ $228
```

## Instalación

```bash
npm i -g cc-costline && cc-costline install
```

Abre una nueva sesión de Claude Code y verás la statusline mejorada. Requiere Node.js >= 22.

## Funcionalidades

| Segmento | Ejemplo | Descripción |
|----------|---------|-------------|
| Tokens ~ Costo / Contexto | `526.3k ~ $16.3 / 57% glm-4.7` | Tokens de la sesión, costo, uso de contexto y modelo |
| Límites de uso | `5h: 27%` | Utilización de Claude a 5 horas (coloreado como el contexto) |
| Costo del período | `7d: $137` o `30d: $246` | Costo acumulado local (configurable: none/7d/30d/both) |
| Uso de Zhipu GLM | `ZHIPU:124.0M ~ $74.4 · 5h:27% · MCP:10/100 · M:380.5M ~ $228` | Uso 24h, cuota 5h, MCP mensual, mes a fecha |
| Ranking | `#2/22 $67.0` | Posición en [ccclub](https://github.com/mazzzystar/ccclub) (si está instalado) |

### Detalles de uso de Zhipu GLM

| Visualización | Ejemplo | Descripción |
|---------------|---------|-------------|
| Uso de modelo 24h | `ZHIPU:124.0M ~ $74.4` | Total de Tokens de 24h y costo estimado |
| Cuota 5h | `5h:27%` o `5h:2:30` | Utilización de Tokens de 5h, muestra cuenta regresiva cuando ≥100% |
| MCP mensual | `MCP:10/100` | Llamadas mensuales de herramientas MCP (search-prime + web-reader + zread) |
| Mes a fecha | `M:380.5M ~ $228` | Uso acumulado desde el 1.er hasta hoy |

### Ejemplos de statusline

#### Por defecto (period=7d, showResetTime=false)
```
526.3k $16.3 · 57% glm-4.7 / 7d:$137 / ZHIPU:124.0M ~ $74.4 · 5h:27% · MCP:10/100 · M:380.5M ~ $228
```

#### Mínimo (period=none, showZhipu=false)
```
526.3k $16.3 · 57% glm-4.7 / 5h:27%
```

#### Completo (period=both, showResetTime=true)
```
526.3k $16.3 · 57% glm-4.7 / 7d:$137 · 30d:$246 / ZHIPU:124.0M ~ $74.4 · 5h:27% (17:16) · MCP:10/100 · M:380.5M ~ $228
```

#### Cuota excedida (5h > 100%)
```
526.3k $16.3 · 57% glm-4.7 / ZHIPU:124.0M ~ $74.4 · 5h:2:30 · MCP:10/100 · M:380.5M ~ $228
```
→ `5h:2:30` muestra cuenta regresiva para el restablecimiento (quedan 2h 30m)

### Colores

- **Contexto y límites de uso** — verde (< 60%) → naranja (60-79%) → rojo (≥ 80%)
- **Posición en ranking** — 1.o: dorado, 2.o: blanco, 3.o: naranja, resto: azul
- **Costo del período** — amarillo

### Integraciones opcionales

- **Límites de uso de Claude** — lee automáticamente las credenciales OAuth del llavero de macOS. Solo ejecuta `claude login`.
- **Uso de Zhipu GLM** — lee `ANTHROPIC_AUTH_TOKEN` y `ANTHROPIC_BASE_URL` de `~/.claude/settings.json` (config compatible con Zhipu).
- **Ranking ccclub** — instala [ccclub](https://github.com/mazzzystar/ccclub) (`npm i -g ccclub && ccclub init`). El ranking aparece automáticamente.

Todas son de configuración cero: si no están disponibles, el segmento se oculta silenciosamente.

## Comandos

```bash
cc-costline install              # Configurar la integración con Claude Code
cc-costline uninstall            # Eliminar de la configuración
cc-costline refresh              # Recalcular manualmente la caché de costos

# Configurar período de visualización
cc-costline config --period none   # Ocultar costo de 7d/30d
cc-costline config --period 7d     # Mostrar solo costo de 7 días
cc-costline config --period 30d    # Mostrar solo costo de 30 días
cc-costline config --period both   # Mostrar ambos 7d y 30d

# Configuración de uso de Zhipu
cc-costline config --zhipu true    # Mostrar uso de Zhipu (por defecto)
cc-costline config --zhipu false   # Ocultar uso de Zhipu
cc-costline config --reset-time true   # Mostrar hora de restablecimiento de cuota 5h
cc-costline config --reset-time false  # Ocultar hora de restablecimiento (por defecto)
```

## Cómo funciona

1. **install** configura `~/.claude/settings.json` — establece el comando de statusline y añade hooks de fin de sesión para la actualización automática. Tu configuración existente se conserva.
2. **render** lee el JSON de stdin de Claude Code y la caché de costos, y genera la statusline formateada.
3. **refresh** escanea `~/.claude/projects/**/*.jsonl`, extrae el uso de tokens, aplica precios por modelo y escribe en `~/.cc-costline/cache.json`.
4. **Uso de Claude** se obtiene de `api.anthropic.com/api/oauth/usage` con una caché de 60 s en `/tmp/sl-claude-usage`.
5. **Uso de Zhipu GLM** se obtiene de las APIs de Zhipu (`/api/monitor/usage/model-usage`, `/api/monitor/usage/quota/limit`) con una caché de 60 s en `/tmp/sl-zhipu-usage`.
6. **Ranking de ccclub** se obtiene de `ccclub.dev/api/rank` con una caché de 120 s en `/tmp/sl-ccclub-rank`.

<details>
<summary>Precios de modelos Claude</summary>

Precios por millón de tokens (USD):

| Modelo | Entrada | Salida | Escritura caché | Lectura caché |
|--------|--------:|-------:|----------------:|--------------:|
| Opus 4.6 | $5 | $25 | $6.25 | $0.50 |
| Opus 4.5 | $5 | $25 | $6.25 | $0.50 |
| Opus 4.1 | $15 | $75 | $18.75 | $1.50 |
| Sonnet 4.5 | $3 | $15 | $3.75 | $0.30 |
| Sonnet 4 | $3 | $15 | $3.75 | $0.30 |
| Haiku 4.5 | $1 | $5 | $1.25 | $0.10 |
| Haiku 3.5 | $0.80 | $4 | $1.00 | $0.08 |

Los modelos desconocidos usan el precio de su familia, Sonnet por defecto.

</details>

<details>
<summary>Precios de modelos Zhipu GLM</summary>

Precios por millón de tokens (USD), fuente [LiteLLM](https://github.com/BerriAI/litellm):

| Modelo | Entrada | Salida | Lectura caché |
|--------|--------:|-------:|--------------:|
| zai/glm-4.7 | $0.60 | $2.20 | $0.11 |
| zai/glm-4.6 | $0.60 | $2.20 | $0.11 |
| zai/glm-4.5-air | $0.20 | $1.10 | - |
| zai/glm-5 | $1.00 | $3.20 | $0.20 |

**Nota**: El cálculo de costos usa el precio de entrada uniformemente ($0.60/M), sin distinción entre tokens de entrada/salida.

</details>

## Desarrollo

```bash
npm test    # Build + ejecutar tests unitarios (node:test, sin dependencias)
```

## Desinstalación

```bash
cc-costline uninstall
npm uninstall -g cc-costline
```

## Agradecimientos

- [ccclub](https://github.com/mazzzystar/ccclub) por 碎瓜 ([@mazzzystar](https://github.com/mazzzystar)) — ranking de Claude Code entre amigos
- [LiteLLM](https://github.com/BerriAI/litellm) — base de datos unificada de precios de modelos
- [Zhipu AI](https://open.bigmodel.cn/) — servicio de modelos GLM

## Licencia

MIT
