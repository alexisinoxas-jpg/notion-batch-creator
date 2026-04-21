# notion-batch-creator

Automate que corre a diario y, para cada concepto en **DB2 "💡 Conceptos & Ángulos"** con `Status = Para editar`:

1. Lee los campos `Por qué`, `Estructura` y `SCRIPT + ANÁLISIS`.
2. Llama a OpenAI (`gpt-4o-mini`) para generar **objetivo del test** e **hipótesis** (1 línea cada uno).
3. Crea una página nueva en **DB3 "📦 Batches / Campañas"** con:
   - `Name` = `N - <nombre concepto>` (N = siguiente número disponible)
   - `Status` = `Backlog`
   - `brief & Audios` (relación) apuntando al concepto de DB2
   - `objetivo del test` e `hipótesis` rellenados
4. Cambia el `Status` de la página DB2 a `Lanzado` para que no se reprocese.

## Setup (una sola vez)

### 1. Token de Notion
Reusa la integración de `meta-notion-sync`. Verifica en Notion → abre DB2 y DB3 → `···` → `Connections` → que tu integración tenga acceso **con permiso de edición** en ambas.

### 2. Clave de OpenAI
Genera una en https://platform.openai.com/api-keys. Recomendado ponerle **límite de gasto** bajo (ej. $2/mes) en Settings → Limits.

### 3. Crear el repo en GitHub
```bash
cd C:\Users\alexi\notion-batch-creator
git init
git add .
git commit -m "feat: initial notion-batch-creator"
git branch -M main
git remote add origin https://github.com/alexisinoxas-jpg/notion-batch-creator.git
git push -u origin main
```
(Crea primero el repo vacío en github.com — privado.)

### 4. Añadir secretos en GitHub
Repo → `Settings` → `Secrets and variables` → `Actions` → `New repository secret`:
- `NOTION_TOKEN` → tu token de integración Notion
- `OPENAI_API_KEY` → tu clave de OpenAI

### 5. Probar manualmente
Repo → `Actions` → `notion-batch-creator` → `Run workflow`.
Revisa los logs. Si todo OK, quedará corriendo a las 07:00 UTC todos los días.

## Ejecutar en local

```bash
# crea .env a partir de .env.example y completa las claves
node index.js
```

## Estructura esperada en Notion

**DB2 – Conceptos & Ángulos** debe tener:
- `Name` (title)
- `Status` (status o select) con valores: `Para editar`, `Lanzado` (y los que ya uses)
- `Por qué` (rich_text)
- `Estructura` (rich_text)
- `SCRIPT + ANÁLISIS` (rich_text)

**DB3 – Batches / Campañas** debe tener:
- `Name` (title) — se rellenará con `N - <concepto>`
- `Status` (status o select) con valor `Backlog`
- `brief & Audios` (relation → DB2)
- `objetivo del test` (rich_text)
- `hipótesis` (rich_text)

Si algún campo tiene otro nombre o tipo, edita las constantes al inicio de `index.js`.
