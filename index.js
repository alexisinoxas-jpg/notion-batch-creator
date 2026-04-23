// notion-batch-creator
// Dos flujos sobre DB2 (Conceptos):
//
// 1) Status = "Para editar"  → genera objetivo+hipótesis con OpenAI, crea Batch en DB3
//    con Status "Backlog" enlazado vía "Brief & Audios", y pasa el concepto a "Lanzado".
//
// 2) Status = "En desarrollo" Y "Drive Brief" vacío → crea carpeta en Drive (dentro de
//    BRIEF), sub-carpetas "AUDIOS <titulo>" y "VIDEOS EDITADOS", y guarda la URL en
//    "Drive Brief".

const crypto = require("node:crypto");

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GDRIVE_SERVICE_ACCOUNT_JSON = process.env.GDRIVE_SERVICE_ACCOUNT_JSON;

const DB2_ID = "310ca875e528807a8f7dfb4d8e369f97"; // Conceptos & Ángulos
const DB3_ID = "310ca875e528803b8300c74760eadedc"; // Batches / Campañas
const GDRIVE_BRIEF_FOLDER_ID = "15LSwFbAeSB5fOhF6uta7XJnquPjkEWC1";

const STATUS_TRIGGER = "Para editar";
const STATUS_DONE = "Lanzado";
const STATUS_NEW_BATCH = "Backlog";
const STATUS_DRIVE_TRIGGER = "En desarrollo";

const RELATION_FIELD = "Brief & Audios";
const OBJETIVO_FIELD = "Objetivo del test";
const HIPOTESIS_FIELD = "Hipótesis";
const DRIVE_BRIEF_FIELD = "Drive Brief";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

let STATUS_TYPE_DB2 = "status";
let STATUS_TYPE_DB3 = "status";
let TITLE_FIELD_DB3 = "Name";
let DRIVE_BRIEF_TYPE = "rich_text";

async function notion(path, options = {}) {
  const res = await fetch(`${NOTION_API}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion ${options.method || "GET"} ${path} -> ${res.status}: ${text}`);
  }
  return res.json();
}

async function detectSchemas() {
  const [db2, db3] = await Promise.all([
    notion(`/databases/${DB2_ID}`),
    notion(`/databases/${DB3_ID}`)
  ]);
  if (!db2.properties["Status"]) throw new Error("DB2: no encuentro propiedad 'Status'");
  if (!db3.properties["Status"]) throw new Error("DB3: no encuentro propiedad 'Status'");
  STATUS_TYPE_DB2 = db2.properties["Status"].type;
  STATUS_TYPE_DB3 = db3.properties["Status"].type;
  for (const [name, prop] of Object.entries(db3.properties)) {
    if (prop.type === "title") { TITLE_FIELD_DB3 = name; break; }
  }
  const driveProp = db2.properties[DRIVE_BRIEF_FIELD];
  if (driveProp) DRIVE_BRIEF_TYPE = driveProp.type;
  console.log(`Status DB2: ${STATUS_TYPE_DB2} | DB3: ${STATUS_TYPE_DB3} | Title DB3: "${TITLE_FIELD_DB3}" | Drive Brief: ${DRIVE_BRIEF_TYPE}`);
}

function statusFilter(type, value) {
  return { property: "Status", [type]: { equals: value } };
}

function statusValue(type, value) {
  return { [type]: { name: value } };
}

async function queryAll(dbId, filter) {
  const results = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const data = await notion(`/databases/${dbId}/query`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

function getTitle(page) {
  for (const v of Object.values(page.properties)) {
    if (v.type === "title") {
      return v.title.map(t => t.plain_text).join("").trim();
    }
  }
  return "";
}

function getRichText(page, name) {
  const p = page.properties[name];
  if (!p || p.type !== "rich_text") return "";
  return p.rich_text.map(t => t.plain_text).join("").trim();
}

async function nextBatchNumber() {
  const pages = await queryAll(DB3_ID);
  let max = 0;
  for (const p of pages) {
    const m = getTitle(p).match(/^\s*(?:batch\s+)?(\d+)\s*-/i);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

async function generateIA(concept) {
  const prompt = `Eres asistente de un media buyer de Meta Ads para ISYRA (nicho caída capilar, Chile).
A partir del siguiente concepto creativo, genera:
1) "objetivo": el objetivo del test en UNA sola línea (máx 140 caracteres).
2) "hipotesis": la hipótesis en UNA sola línea (máx 140 caracteres).

Responde SOLO con JSON válido (sin markdown, sin texto extra), formato exacto:
{"objetivo":"...","hipotesis":"..."}

CONCEPTO:
Nombre: ${concept.name}
Por qué: ${concept.porque || "(no especificado)"}
Estructura: ${concept.estructura || "(no especificado)"}
Script + análisis: ${concept.script || "(no especificado)"}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.6
    })
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  return {
    objetivo: String(parsed.objetivo || "").trim().slice(0, 500),
    hipotesis: String(parsed.hipotesis || "").trim().slice(0, 500)
  };
}

async function createBatch(concept, number, objetivo, hipotesis) {
  const name = `Batch ${number} - ${concept.name}`;
  const body = {
    parent: { database_id: DB3_ID },
    properties: {
      [TITLE_FIELD_DB3]: { title: [{ text: { content: name } }] },
      "Status": statusValue(STATUS_TYPE_DB3, STATUS_NEW_BATCH),
      [RELATION_FIELD]: { relation: [{ id: concept.id }] },
      [OBJETIVO_FIELD]: { rich_text: [{ text: { content: objetivo } }] },
      [HIPOTESIS_FIELD]: { rich_text: [{ text: { content: hipotesis } }] }
    }
  };
  return notion("/pages", { method: "POST", body: JSON.stringify(body) });
}

async function setDb2Status(pageId, value) {
  return notion(`/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: { Status: statusValue(STATUS_TYPE_DB2, value) }
    })
  });
}

// --- Google Drive (service account, RS256 JWT, zero-dep) ---

function base64url(input) {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getDriveToken() {
  const creds = JSON.parse(GDRIVE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(JSON.stringify({
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const signInput = `${header}.${claim}`;
  const signature = crypto.createSign("RSA-SHA256").update(signInput).sign(creds.private_key);
  const jwt = `${signInput}.${base64url(signature)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });
  if (!res.ok) throw new Error(`Drive token ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function driveCreateFolder(token, name, parentId) {
  const res = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId]
    })
  });
  if (!res.ok) throw new Error(`Drive create "${name}" ${res.status}: ${await res.text()}`);
  return res.json();
}

async function setDriveBrief(pageId, url) {
  const value = DRIVE_BRIEF_TYPE === "url"
    ? { url }
    : { rich_text: [{ text: { content: url, link: { url } } }] };
  return notion(`/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: { [DRIVE_BRIEF_FIELD]: value }
    })
  });
}

// --- Flujos ---

async function processBatches() {
  console.log(`\n=== Flujo 1: conceptos "${STATUS_TRIGGER}" → crear Batch ===`);
  const pages = await queryAll(DB2_ID, statusFilter(STATUS_TYPE_DB2, STATUS_TRIGGER));
  console.log(`Encontrados: ${pages.length}`);
  if (pages.length === 0) return { ok: 0, fail: 0 };

  let n = await nextBatchNumber();
  console.log(`Siguiente número de batch: ${n}`);

  let ok = 0, fail = 0;
  for (const page of pages) {
    const concept = {
      id: page.id,
      name: getTitle(page),
      porque: getRichText(page, "Por qué"),
      estructura: getRichText(page, "Estructura"),
      script: getRichText(page, "SCRIPT + ANÁLISIS")
    };
    if (!concept.name) { console.log(`⚠️  ${page.id} sin título, saltando`); continue; }
    try {
      console.log(`→ ${concept.name}`);
      const ai = await generateIA(concept);
      console.log(`   objetivo : ${ai.objetivo}`);
      console.log(`   hipótesis: ${ai.hipotesis}`);
      await createBatch(concept, n, ai.objetivo, ai.hipotesis);
      await setDb2Status(page.id, STATUS_DONE);
      console.log(`   ✅ Batch #${n} creado`);
      n++; ok++;
    } catch (err) {
      console.error(`   ❌ ${err.message}`);
      fail++;
    }
  }
  return { ok, fail };
}

async function processDriveFolders() {
  console.log(`\n=== Flujo 2: conceptos "${STATUS_DRIVE_TRIGGER}" sin Drive → crear carpetas ===`);
  if (!GDRIVE_SERVICE_ACCOUNT_JSON) {
    console.log("GDRIVE_SERVICE_ACCOUNT_JSON no configurado, saltando flujo Drive.");
    return { ok: 0, fail: 0 };
  }
  const filter = {
    and: [
      statusFilter(STATUS_TYPE_DB2, STATUS_DRIVE_TRIGGER),
      { property: DRIVE_BRIEF_FIELD, [DRIVE_BRIEF_TYPE]: { is_empty: true } }
    ]
  };
  const pages = await queryAll(DB2_ID, filter);
  console.log(`Encontrados: ${pages.length}`);
  if (pages.length === 0) return { ok: 0, fail: 0 };

  const token = await getDriveToken();
  let ok = 0, fail = 0;
  for (const page of pages) {
    const title = getTitle(page);
    if (!title) { console.log(`⚠️  ${page.id} sin título, saltando`); continue; }
    try {
      console.log(`→ ${title}`);
      const parent = await driveCreateFolder(token, title, GDRIVE_BRIEF_FOLDER_ID);
      await driveCreateFolder(token, `AUDIOS ${title}`, parent.id);
      await driveCreateFolder(token, "VIDEOS EDITADOS", parent.id);
      const url = `https://drive.google.com/drive/folders/${parent.id}`;
      await setDriveBrief(page.id, url);
      console.log(`   ✅ ${url}`);
      ok++;
    } catch (err) {
      console.error(`   ❌ ${err.message}`);
      fail++;
    }
  }
  return { ok, fail };
}

async function main() {
  if (!NOTION_TOKEN) throw new Error("Falta NOTION_TOKEN");
  if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");

  await detectSchemas();

  const results = { batches: { ok: 0, fail: 0 }, drive: { ok: 0, fail: 0 } };
  try { results.batches = await processBatches(); }
  catch (err) { console.error("Flujo Batches falló:", err.message); results.batches.fail++; }
  try { results.drive = await processDriveFolders(); }
  catch (err) { console.error("Flujo Drive falló:", err.message); results.drive.fail++; }

  console.log(`\n=== Resumen ===`);
  console.log(`Batches: ${results.batches.ok} ok, ${results.batches.fail} fail`);
  console.log(`Drive  : ${results.drive.ok} ok, ${results.drive.fail} fail`);
  if (results.batches.fail + results.drive.fail > 0) process.exit(1);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
