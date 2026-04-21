// notion-batch-creator
// Busca páginas en DB2 (Conceptos) con Status = "Para editar",
// genera objetivo + hipótesis con OpenAI,
// crea una página en DB3 (Batches) enlazada vía "brief & Audios" con Status = "Backlog"
// y cambia el Status de la página original en DB2 a "Lanzado".

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const DB2_ID = "310ca875e528807a8f7dfb4d8e369f97"; // Conceptos & Ángulos
const DB3_ID = "310ca875e528803b8300c74760eadedc"; // Batches / Campañas

const STATUS_TRIGGER = "Para editar";
const STATUS_DONE = "Lanzado";
const STATUS_NEW_BATCH = "Backlog";

const RELATION_FIELD = "Brief & Audios";
const OBJETIVO_FIELD = "Objetivo del test";
const HIPOTESIS_FIELD = "Hipótesis";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

let STATUS_TYPE_DB2 = "status";
let STATUS_TYPE_DB3 = "status";
let TITLE_FIELD_DB3 = "Name";

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
  console.log(`Status DB2 tipo: ${STATUS_TYPE_DB2} | DB3 tipo: ${STATUS_TYPE_DB3} | Title DB3: "${TITLE_FIELD_DB3}"`);
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

async function main() {
  if (!NOTION_TOKEN) throw new Error("Falta NOTION_TOKEN");
  if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");

  await detectSchemas();

  console.log(`Buscando conceptos en DB2 con Status = "${STATUS_TRIGGER}"...`);
  const pages = await queryAll(
    DB2_ID,
    statusFilter(STATUS_TYPE_DB2, STATUS_TRIGGER)
  );
  console.log(`Conceptos encontrados: ${pages.length}`);
  if (pages.length === 0) {
    console.log("Nada que procesar. Fin.");
    return;
  }

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
    if (!concept.name) {
      console.log(`⚠️  Página ${page.id} sin título, saltando`);
      continue;
    }
    try {
      console.log(`\n→ ${concept.name}`);
      const ai = await generateIA(concept);
      console.log(`   objetivo : ${ai.objetivo}`);
      console.log(`   hipótesis: ${ai.hipotesis}`);
      await createBatch(concept, n, ai.objetivo, ai.hipotesis);
      await setDb2Status(page.id, STATUS_DONE);
      console.log(`   ✅ Batch #${n} creado y DB2 marcado como "${STATUS_DONE}"`);
      n++;
      ok++;
    } catch (err) {
      console.error(`   ❌ ${err.message}`);
      fail++;
    }
  }
  console.log(`\nResumen: ${ok} creados, ${fail} fallidos.`);
  if (fail > 0) process.exit(1);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
