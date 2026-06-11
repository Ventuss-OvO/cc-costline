[English](README.md) | [中文](README.zh-CN.md) | [日本語](README.ja.md) | [Français](README.fr.md)

# cc-costline

Statusline mejorada para [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — añade seguimiento de costos, límites de uso y ranking en tu terminal.

![Captura de pantalla cc-costline](screenshot.png)

```
14.6k $2.42 · 40% Opus 4.6 / 5h:45% · 7d:8% · 30d:$866 / #2 $67.0
```

## Instalación

```bash
npm i -g cc-costline && cc-costline install
```

Abre una nueva sesión de Claude Code y verás la statusline mejorada. Requiere Node.js >= 22.

### Actualizar

npm no actualiza automáticamente los paquetes globales. Ejecuta esto cuando quieras la última versión:

```bash
npm i -g cc-costline@latest
```

## Funcionalidades

| Segmento | Ejemplo | Descripción |
|----------|---------|-------------|
| Tokens / Costo / Contexto | `14.6k $2.42 · 40% Opus 4.6` | Tokens de la sesión, costo, uso de contexto y modelo |
| Límites de uso | `5h:45% · 7d:8%` | Utilización de Claude a 5 horas y 7 días (coloreado como el contexto). Al 100%, muestra cuenta regresiva: `5h:-03:20` |
| Costo del período | `30d:$866` | Costo acumulado (configurable: 7d, 30d o both) |
| Ranking | `#2 $67.0` | Posición en [ccclub](https://github.com/mazzzystar/ccclub) (si está instalado) |

### Colores

- **Contexto y límites de uso** — verde (< 60%) → naranja (60-79%) → rojo (≥ 80%)
- **Posición en ranking** — 1.o: dorado, 2.o: blanco, 3.o: naranja, resto: cian
- **Costo del período** — amarillo

### Integraciones opcionales

- **Límites de uso de Claude** — lee automáticamente las credenciales OAuth del llavero de macOS. Solo ejecuta `claude login`.
- **Ranking ccclub** — instala [ccclub](https://github.com/mazzzystar/ccclub) (`npm i -g ccclub && ccclub init`). El ranking aparece automáticamente.

Ambas funcionan sin configuración: si no están disponibles, el segmento se oculta silenciosamente.

## Comandos

```bash
cc-costline install              # Configurar la integración con Claude Code
cc-costline uninstall            # Eliminar de la configuración
cc-costline refresh              # Recalcular manualmente la caché de costos
cc-costline config --period 7d   # Mostrar costo de 7 días (por defecto)
cc-costline config --period 30d  # Mostrar costo de 30 días
cc-costline config --period both # Mostrar ambos períodos
```

## Cómo funciona

1. `install` configura `~/.claude/settings.json` — establece el comando de statusline y añade hooks de fin de sesión. Tu configuración existente se conserva.
2. `render` es llamado por Claude Code en cada turno. Lee los totales de tokens desde stdin cuando Claude Code los proporciona, y después lee tres cachés (sin HTTP, sin escaneo completo del directorio):
   - **Costo local** → `~/.cc-costline/cache.json`
   - **Límites de uso** → `<os.tmpdir()>/sl-claude-usage`
   - **Ranking ccclub** → `<os.tmpdir()>/sl-ccclub-rank`
3. Si alguna caché está obsoleta, `render` lanza un subproceso desacoplado `cc-costline refresh-bg` que actualiza los datos en segundo plano. `<os.tmpdir()>/sl-refresh.lock` evita actualizaciones concurrentes entre múltiples ventanas de Claude Code, y `<os.tmpdir()>/sl-refresh.last` limita los spawns a uno cada 30 s. Los nombres de archivo `sl-*` llevan un sufijo por usuario, evitando colisiones en un `/tmp` compartido de Linux.
4. La actualización en segundo plano respeta los TTLs por fuente:
   - **Costo local** (TTL 2 min): escaneo incremental — caché por archivo (`mtime+size`), reutiliza entradas sin cambios (~25 ms típico vs ~2 s en frío con 1000+ archivos jsonl)
   - **Límites de uso** (retry 5 min, sensible al token): obtiene de `api.anthropic.com/api/oauth/usage`. Detecta la rotación del token OAuth para reintentar inmediatamente (nuevo token = nueva cuota de límite). Los datos obsoletos persisten ante fallos.
   - **Ranking ccclub** (retry 90 s): obtiene de `ccclub.dev/api/rank`
5. `refresh` también puede ejecutarse manualmente para recalcular la caché local de costos; los hooks de fin de sesión usan `refresh-bg` para precalentar todas las cachés sin bloquear Claude Code.

<details>
<summary>Tabla de precios</summary>

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

## Licencia

MIT
