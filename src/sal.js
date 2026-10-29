// ============================================================================
// SAL — stati di avanzamento lavori nell'area riservata (29/10/2026, impostazione approvata da Filippo il 29/10).
// Computo del contratto, misure scritte dall'ufficio, conto automatico in euro e in percentuale, SAL con chiusura e
// impronta SHA-256, Excel con formule vere e documento da stampare:
//   GET  /sal?t=<gettone>&c=<cantiere>[&s=avanzamento|sal|contratto|computo]   → pagina
//   POST /sal/api   {t, c, azione, id?, dati?}   → RPC sal_* (contesto, contratto, misura, misura_togli, bozza, emetti, stato)
//   GET  /sal/excel?t=<gettone>&c=<cantiere>[&id=<sal>]        → file .xlsx scritto qui, senza librerie
//   GET  /sal/documento?t=<gettone>&id=<sal>[&originale=1]     → documento del SAL da stampare (o il file originale)
// Il database decide tutto: chi entra (impostazioni.sal_attivo), calcolo, numeri, impronta, versioni.
// Il relay non conserva nulla. Si spegne anche con la variabile del Worker SAL = "off".
// ============================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GETTONE = /^[0-9a-f]{64}$/;
const SCHEDE = ["avanzamento", "sal", "contratto", "computo"];

function json(o, stato) {
  return new Response(JSON.stringify(o), {
    status: stato || 200,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }
  });
}

async function leggiCorpo(request) {
  if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || "")) return { errore: 415 };
  try {
    const t = await request.text();
    if (t.length > 40000) return { errore: 413 };
    const b = JSON.parse(t);
    return b && typeof b === "object" ? b : { errore: 400 };
  } catch (e) { return { errore: 400 }; }
}

// Solo i campi attesi, con la lunghezza massima: il database controlla comunque tutto.
function pulisci(azione, d) {
  const o = {};
  if (!d || typeof d !== "object") return o;
  const s = (k, n, da, a) => { const x = (da || d)[k]; if (x !== undefined && x !== null) (a || o)[k] = String(x).slice(0, n); };
  const u = (k, a, da) => { const x = String((da || d)[k] || "").toLowerCase(); if (UUID.test(x)) (a || o)[k] = x; };
  if (azione === "contratto") {
    ["tipo_contratto", "sicurezza_modo", "cadenza_sal"].forEach((k) => s(k, 16));
    ["importo_contratto", "ribasso_pct", "oneri_sicurezza", "ritenuta_pct", "anticipazione_pct", "soglia_sal_importo"].forEach((k) => s(k, 20));
    s("data_contratto", 10); s("termine_ultimazione", 10); s("nota_differenza", 600);
    if (Array.isArray(d.traguardi)) {
      o.traguardi = d.traguardi.slice(0, 30).filter((t) => t && typeof t === "object").map((t) => {
        const r = {};
        if (/^[0-9]{1,18}$/.test(String(t.id || ""))) r.id = String(t.id);
        s("nome", 120, t, r); s("modo", 12, t, r); s("percentuale", 10, t, r); s("data_prevista", 10, t, r); s("raggiunto_il", 10, t, r);
        return r;
      });
    }
  } else if (azione === "misura") {
    u("id"); u("voce_id"); u("rettifica_di");
    s("data", 10); s("luogo", 160); s("descrizione", 300); s("autore", 120);
    ["pu", "l", "w", "h", "q", "pct"].forEach((k) => s(k, 20));
    if (d.meno === true) o.meno = true;
  } else if (azione === "bozza") {
    s("periodo_a", 10); s("note", 1000);
    if (d.traguardo_id !== undefined) o.traguardo_id = /^[0-9]{1,18}$/.test(String(d.traguardo_id || "")) ? String(d.traguardo_id) : "";
    if (Array.isArray(d.altre_voci)) {
      o.altre_voci = d.altre_voci.slice(0, 60).filter((a) => a && typeof a === "object").map((a) => {
        const r = {}; s("tipo", 10, a, r); s("descrizione", 300, a, r); s("unita", 20, a, r); s("quantita", 20, a, r); s("prezzo", 20, a, r); return r;
      });
    }
  } else if (azione === "emetti") {
    s("autore", 120);
  } else if (azione === "stato") {
    s("nome", 120); s("data", 10); s("nota", 600); s("motivo", 600);
  } else if (azione === "misura_togli") {
    s("motivo", 300);
  } else if (azione === "computo_conferma" || azione === "computo_annulla") {
    s("autore", 120);
  }
  return o;
}

// ---------------------------------------------------------------------------- caricamento del computo (29/10/2026)
// Il file va nell'archivio (wa-media, «documenti/<cantiere>/computo/…»), poi lo legge la funzione computo-import:
// la pagina mostra l'anteprima con il controllo delle somme e nulla cambia finché l'ufficio non conferma.
const MAX_FILE = 18 * 1024 * 1024;
function estensione(nome) {
  const m = /\.(pdf|xlsx|xlsm|xls|ods|csv|dcf|xpwe|docx?)$/i.exec(String(nome || ""));
  return m ? "." + m[1].toLowerCase() : "";
}
function casuale() {
  const b = new Uint8Array(10);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
async function caricaComputo(request, env, inUrl, h) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  const tok = String(inUrl.searchParams.get("t") || "").toLowerCase();
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase();
  const nome = String(inUrl.searchParams.get("nome") || "").replace(/[\u0000-\u001f\\/]+/g, " ").trim().slice(0, 180);
  if (!GETTONE.test(tok)) return json({ esito: "gettone" }, 403);
  if (!UUID.test(c)) return json({ esito: "errore" }, 400);
  if (Number(request.headers.get("Content-Length") || 0) > MAX_FILE) return json({ esito: "grande", messaggio: "Il file è troppo grande (massimo 18 MB)." }, 413);
  // prima il controllo dell'accesso, poi il file (chi non ha accesso non scrive nulla nell'archivio)
  const ctx = await h.rpc(env, "computo_import_contesto", { p_token: tok, p_commessa: c }, 10000).catch(() => null);
  if (!ctx) return json({ esito: "incerto" }, 503);
  if (ctx.esito !== "ok") return json({ esito: String(ctx.esito) }, ctx.esito === "gettone" ? 403 : 400);
  if (ctx.chiuso) return json({ esito: "chiuso", messaggio: "Il cantiere è chiuso." });
  if (ctx.attivo === false) return json({ esito: "spento", messaggio: "Il caricamento del computo è sospeso in questo momento." });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return json({ esito: "vuoto", messaggio: "Il file è vuoto." }, 400);
  if (bytes.length > MAX_FILE) return json({ esito: "grande", messaggio: "Il file è troppo grande (massimo 18 MB)." }, 413);
  const ora = new Date();
  const giorno = ora.getUTCFullYear() + String(ora.getUTCMonth() + 1).padStart(2, "0") + String(ora.getUTCDate()).padStart(2, "0");
  const percorso = "documenti/" + c + "/computo/" + giorno + "-" + casuale() + estensione(nome);
  const mime = String(request.headers.get("Content-Type") || "application/octet-stream").split(";")[0].trim().slice(0, 120) || "application/octet-stream";
  const supabaseUrl = env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const up = await fetch(supabaseUrl + "/storage/v1/object/wa-media/" + percorso, {
      method: "POST",
      headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY, "Content-Type": mime, "x-upsert": "false" },
      body: bytes, signal: ctrl.signal
    });
    if (!up.ok) return json({ esito: "archivio", messaggio: "Il file non si è salvato: riprova tra un minuto." }, 502);
  } catch (e) {
    return json({ esito: "archivio", messaggio: "Il file non si è salvato: riprova tra un minuto." }, 502);
  } finally { clearTimeout(timer); }
  const r = await h.rpc(env, "computo_import_da_portale", { p_token: tok, p_commessa: c, p_storage_path: percorso, p_mime: mime, p_nome_file: nome || null, p_byte: bytes.length }, 10000).catch(() => null);
  if (!r) return json({ esito: "incerto" }, 503);
  if (r.esito !== "ok") return json({ esito: String(r.esito), messaggio: r.messaggio || "" });
  return json({ esito: "ok", id: r.id });
}

export async function portaleSal(request, env, base, inUrl, h) {
  if (env.SAL === "off") return new Response("Not Found", { status: 404 });
  if (!env.SUPABASE_SERVICE_KEY) {
    return new Response("Servizio non configurato.", { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  }
  const sotto = inUrl.pathname.slice(base.length);
  if (sotto === "/sal/api") return api(request, env, h);
  if (sotto === "/sal/computo/carica") return caricaComputo(request, env, inUrl, h);
  if (sotto === "/sal/excel") return excel(request, env, base, inUrl, h);
  if (sotto === "/sal/documento") return documento(request, env, base, inUrl, h);
  if (sotto !== "/sal") return new Response("Not Found", { status: 404 });
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const m = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  if (!m) return Response.redirect(inUrl.origin + base + "/", 303);
  const tok = m[0].toLowerCase();
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase().replace(/[^0-9a-f-]/g, "").slice(0, 36);
  if (!UUID.test(c)) return Response.redirect(inUrl.origin + base + "/?t=" + tok, 303);
  const torna = base + "/?t=" + tok + "&c=" + c;
  const d = await h.rpc(env, "sal_contesto", { p_token: tok, p_commessa: c }, 20000).catch(() => null);
  if (!d) {
    return h.risposta(h.foglio(base, "SAL", "", '<p class="err">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p>' +
      '<p class="piede"><a href="' + h.esc(torna) + '">&larr; Torna al cantiere</a></p>'), 503);
  }
  if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (d.esito !== "ok") return Response.redirect(inUrl.origin + torna, 303);
  const s = SCHEDE.indexOf(inUrl.searchParams.get("s") || "") !== -1 ? inUrl.searchParams.get("s") : "";
  return new Response(metodo === "HEAD" ? null : paginaSal(base, tok, c, d, s, h), { status: 200, headers: h.headers() });
}

async function api(request, env, h) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  const b = await leggiCorpo(request);
  if (b.errore) return json({ esito: "errore" }, b.errore);
  const tok = String(b.t || "").toLowerCase();
  if (!GETTONE.test(tok)) return json({ esito: "gettone" }, 403);
  const c = String(b.c || "").toLowerCase();
  const id = String(b.id || "").toLowerCase();
  const az = String(b.azione || "");
  const dati = pulisci(az, b.dati);
  let r = null;
  const chiama = (nome, corpo) => h.rpc(env, nome, corpo, 25000).catch(() => null);
  if (["contesto", "contratto", "misura", "bozza"].indexOf(az) !== -1) {
    if (!UUID.test(c)) return json({ esito: "errore" }, 400);
    if (az === "contesto") r = await chiama("sal_contesto", { p_token: tok, p_commessa: c });
    else if (az === "contratto") r = await chiama("sal_contratto_salva", { p_token: tok, p_commessa: c, p_dati: dati });
    else if (az === "misura") r = await chiama("sal_misura_salva", { p_token: tok, p_commessa: c, p_dati: dati });
    else r = await chiama("sal_bozza_salva", { p_token: tok, p_commessa: c, p_dati: dati });
  } else if (["misura_togli", "emetti", "stato"].indexOf(az) !== -1) {
    if (!UUID.test(id)) return json({ esito: "errore" }, 400);
    if (az === "misura_togli") r = await chiama("sal_misura_annulla", { p_token: tok, p_id: id, p_motivo: dati.motivo || "" });
    else if (az === "emetti") r = await chiama("sal_emetti", { p_token: tok, p_sal: id, p_dati: dati });
    else {
      const sa = String((b.dati || {}).azione || "");
      if (["scarta", "firmato", "visto", "riemetti", "annulla"].indexOf(sa) === -1) return json({ esito: "errore" }, 400);
      r = await chiama("sal_stato", { p_token: tok, p_sal: id, p_azione: sa, p_dati: dati });
    }
  } else if (["computo_stato", "computo_conferma", "computo_annulla"].indexOf(az) !== -1) {
    const n = Number(b.id);
    if (!UUID.test(c) || !Number.isInteger(n) || n <= 0) return json({ esito: "errore" }, 400);
    if (az === "computo_stato") r = await chiama("computo_import_stato", { p_token: tok, p_commessa: c, p_id: n });
    else r = await chiama("computo_import_azione", { p_token: tok, p_commessa: c, p_id: n, p_azione: az === "computo_conferma" ? "conferma" : "annulla", p_autore: dati.autore || null });
  } else {
    return json({ esito: "errore" }, 400);
  }
  return r ? json(r) : json({ esito: "incerto" });
}

// ---------------------------------------------------------------------------- documento del SAL
async function documento(request, env, base, inUrl, h) {
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const m = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  if (!m) return Response.redirect(inUrl.origin + base + "/", 303);
  const tok = m[0].toLowerCase();
  const id = String(inUrl.searchParams.get("id") || "").toLowerCase();
  if (!UUID.test(id)) return new Response("Not Found", { status: 404 });
  const r = await h.rpc(env, "sal_documento", { p_token: tok, p_sal: id }, 20000).catch(() => null);
  if (!r) return h.risposta(h.foglio(base, "SAL", "", '<p class="err">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p>'), 503);
  if (r.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (r.esito !== "ok" || typeof r.html !== "string") return h.risposta(h.foglio(base, "SAL", "", '<p class="err">Documento non trovato.</p>'), 404);
  const nome = "SAL-n" + (Number(r.numero) || 0) + "-v" + (Number(r.versione) || 1) + (r.stato === "bozza" ? "-bozza" : "") + ".html";
  // L'originale è il testo registrato all'emissione, byte per byte: è quello su cui si verifica l'impronta.
  if (inUrl.searchParams.get("originale") === "1" && r.stato !== "bozza") {
    return new Response(metodo === "HEAD" ? null : r.html, { status: 200, headers: {
      "Content-Type": "text/html; charset=UTF-8", "Content-Disposition": 'attachment; filename="' + nome + '"',
      "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } });
  }
  const e = h.esc;
  const c = UUID.test(String(r.commessa_id || "")) ? String(r.commessa_id) : "";
  const succ = UUID.test(String(r.successivo || "")) ? String(r.successivo) : "";
  const barra = '<div class="sd-barra">' +
    (c ? '<a href="' + e(base + "/sal?t=" + tok + "&c=" + c + "&s=sal") + '">&larr; Torna al SAL</a>' : "") +
    '<button type="button" onclick="window.print()">Stampa o salva in PDF</button>' +
    (c ? '<a href="' + e(base + "/sal/excel?t=" + tok + "&c=" + c + "&id=" + id) + '">Scarica in Excel</a>' : "") +
    (r.stato !== "bozza" ? '<a href="' + e(base + "/sal/documento?t=" + tok + "&id=" + id + "&originale=1") + '">Scarica l’originale</a>' : "") +
    (r.stato === "sostituito" && succ ? '<p class="sd-av">Questa versione è stata sostituita. <a href="' + e(base + "/sal/documento?t=" + tok + "&id=" + succ) + '">Apri la versione successiva</a>.</p>' : "") +
    (r.stato === "annullato" ? '<p class="sd-av">Questo SAL è stato annullato.</p>' : "") +
    (r.stato === "bozza" ? '<p class="sd-av">Anteprima della bozza: non ha ancora numero definitivo né impronta.</p>'
      : '<p class="sd-nota">Impronta SHA-256 registrata: <code>' + e(r.impronta || "") + "</code></p>") + "</div>";
  const stile = '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">' +
    "<title>" + e(nome.replace(/\.html$/, "").replace(/-/g, " ")) + "</title><style>" +
    '.sd-barra{font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:#F6F0FF;border:1px solid #DCC8F5;border-radius:10px;padding:10px 12px;margin:0 0 16px;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;font-size:13px}' +
    ".sd-barra a{color:#6B2FB3;font-weight:700}.sd-barra button{font:inherit;font-weight:700;border:1px solid #9146DB;background:#9146DB;color:#fff;border-radius:8px;padding:6px 12px;cursor:pointer}" +
    ".sd-barra p{flex-basis:100%;margin:0}.sd-av{color:#8c1d18;font-weight:700}.sd-nota{color:#5b6560;font-size:12px;overflow-wrap:anywhere}@media print{.sd-barra{display:none}}</style>";
  let html = r.html;
  html = html.indexOf("</head>") !== -1 ? html.replace("</head>", () => stile + "</head>") : stile + html;
  html = html.indexOf("<body>") !== -1 ? html.replace("<body>", () => "<body>" + barra) : barra + html;
  return new Response(metodo === "HEAD" ? null : html, { status: 200, headers: h.headers() });
}

// ---------------------------------------------------------------------------- Excel
async function excel(request, env, base, inUrl, h) {
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const m = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  if (!m) return Response.redirect(inUrl.origin + base + "/", 303);
  const tok = m[0].toLowerCase();
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase();
  const id = String(inUrl.searchParams.get("id") || "").toLowerCase();
  if (!UUID.test(c)) return new Response("Not Found", { status: 404 });
  const r = await h.rpc(env, "sal_excel_dati", { p_token: tok, p_commessa: c, p_sal: UUID.test(id) ? id : null }, 25000).catch(() => null);
  if (!r) return h.risposta(h.foglio(base, "SAL", "", '<p class="err">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p>'), 503);
  if (r.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (r.esito !== "ok") return h.risposta(h.foglio(base, "SAL", "", '<p class="err">' + h.esc(r.messaggio || "File non preparato.") + "</p>"), 400);
  const file = salXlsx(r);
  const nome = String(r.nome_file || "TIX SAL.xlsx");
  const ascii = nome.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "") || "TIX SAL.xlsx";
  return new Response(metodo === "HEAD" ? null : file, { status: 200, headers: {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(nome),
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" } });
}

// Il file è sempre uguale per gli stessi dati (date fisse dentro lo zip), così un SAL emesso dà sempre lo stesso Excel.
// Ogni formula porta anche il valore già calcolato (per le anteprime che non ricalcolano); Excel ricalcola all'apertura.
const ENC = new TextEncoder();
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

function zipStore(files) {
  const parti = [], centrali = []; let off = 0;
  for (const f of files) {
    const nome = ENC.encode(f.n), d = f.d, crc = crc32(d);
    const l = new Uint8Array(30 + nome.length), lv = new DataView(l.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true); lv.setUint16(12, 0x5C21, true); lv.setUint32(14, crc, true); lv.setUint32(18, d.length, true);
    lv.setUint32(22, d.length, true); lv.setUint16(26, nome.length, true); lv.setUint16(28, 0, true); l.set(nome, 30);
    const cd = new Uint8Array(46 + nome.length), cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0x5C21, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, d.length, true); cv.setUint32(24, d.length, true); cv.setUint16(28, nome.length, true);
    cv.setUint32(42, off, true); cd.set(nome, 46);
    parti.push(l, d); centrali.push(cd); off += l.length + d.length;
  }
  let lc = 0; for (const x of centrali) lc += x.length;
  const fine = new Uint8Array(22), fv = new DataView(fine.buffer);
  fv.setUint32(0, 0x06054b50, true); fv.setUint16(8, files.length, true); fv.setUint16(10, files.length, true);
  fv.setUint32(12, lc, true); fv.setUint32(16, off, true);
  const tutto = [...parti, ...centrali, fine];
  let n = 0; for (const x of tutto) n += x.length;
  const out = new Uint8Array(n); let p = 0; for (const x of tutto) { out.set(x, p); p += x.length; }
  return out;
}

function xe(s) {
  return String(s == null ? "" : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function colonna(n) { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function seriale(iso) {
  const p = String(iso || "").slice(0, 10).split("-").map(Number);
  if (p.length !== 3 || !p[0]) return null;
  return (Date.UTC(p[0], p[1] - 1, p[2]) - Date.UTC(1899, 11, 30)) / 86400000;
}
function num(x) { const n = Number(x); return x === null || x === undefined || x === "" || !Number.isFinite(n) ? null : n; }

// stili (indici di cellXfs)
const S = { TIT: 1, HDR: 2, TXT: 3, EUR: 4, QTA: 5, PCT: 6, DATA: 7, CAP: 8, SUB: 9, TOT: 10, LAB: 11, GRANDE: 12, WRAP: 13, EURB: 14,
  NOTA: 15, TOTLAB: 16, SUBLAB: 17, INT: 18, AVV: 19, PCTB: 20, EURN: 21, TXTN: 22, PCTN: 23 };
const STILI = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="4"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="#,##0.00##"/>' +
  '<numFmt numFmtId="166" formatCode="0.00%"/><numFmt numFmtId="167" formatCode="dd/mm/yyyy"/></numFmts>' +
  '<fonts count="6"><font><sz val="10"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="14"/><color rgb="FF4A1F86"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="10"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="12"/><color rgb="FF4A1F86"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><i/><sz val="9"/><color rgb="FF666666"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="10"/><color rgb="FF9A4B00"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFEFE7FB"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF1F3F2"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFDCC8F5"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
  '<border><left style="thin"><color rgb="FFD3D3D3"/></left><right style="thin"><color rgb="FFD3D3D3"/></right>' +
  '<top style="thin"><color rgb="FFD3D3D3"/></top><bottom style="thin"><color rgb="FFD3D3D3"/></bottom><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="24">' +
  [[0, 0, 0, 0, ""], [0, 1, 0, 0, ""], [0, 2, 2, 1, 'wrapText="1" vertical="center"'], [0, 0, 0, 1, 'vertical="top"'],
   [164, 0, 0, 1, 'vertical="top"'], [165, 0, 0, 1, 'vertical="top"'], [166, 0, 0, 1, 'vertical="top"'], [167, 0, 0, 1, 'vertical="top"'],
   [0, 2, 3, 1, ""], [164, 2, 3, 1, ""], [164, 2, 4, 1, ""], [0, 2, 0, 0, ""], [164, 3, 4, 1, ""], [0, 0, 0, 1, 'wrapText="1" vertical="top"'],
   [164, 2, 0, 1, ""], [0, 4, 0, 0, 'wrapText="1" vertical="top"'], [0, 2, 4, 1, ""], [0, 2, 3, 1, ""], [1, 0, 0, 1, 'vertical="top"'],
   [0, 5, 0, 1, 'wrapText="1" vertical="top"'], [166, 2, 4, 1, ""], [164, 0, 0, 0, ""], [0, 0, 0, 0, 'wrapText="1" vertical="top"'],
   [166, 0, 0, 0, ""]]
    .map(([nf, fo, fi, bo, al]) => '<xf numFmtId="' + nf + '" fontId="' + fo + '" fillId="' + fi + '" borderId="' + bo + '" xfId="0"' +
      ' applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"' + (al ? ' applyAlignment="1"><alignment ' + al + "/></xf>" : "/>")).join("") +
  '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

class Foglio {
  constructor(nome) { this.nome = nome; this.r = new Map(); this.larg = []; this.unioni = []; this.blocco = 0; this.alte = new Map(); }
  // v: numero, testo o null; f: formula (senza «=»), con v come valore già calcolato
  c(riga, col, v, st, f) {
    if (!this.r.has(riga)) this.r.set(riga, new Map());
    this.r.get(riga).set(col, { v, st: st || 0, f });
  }
  xml(scelto) {
    let righe = "";
    for (const riga of [...this.r.keys()].sort((a, b) => a - b)) {
      const celle = this.r.get(riga);
      let x = "";
      for (const col of [...celle.keys()].sort((a, b) => a - b)) {
        const { v, st, f } = celle.get(col);
        const ref = colonna(col) + riga;
        const s = st ? ' s="' + st + '"' : "";
        if (f) {
          if (typeof v === "number" && Number.isFinite(v)) x += '<c r="' + ref + '"' + s + "><f>" + xe(f) + "</f><v>" + v + "</v></c>";
          else if (v === null || v === undefined || v === "") x += '<c r="' + ref + '"' + s + "><f>" + xe(f) + "</f></c>";
          else x += '<c r="' + ref + '"' + s + ' t="str"><f>' + xe(f) + "</f><v>" + xe(v) + "</v></c>";
        } else if (typeof v === "number" && Number.isFinite(v)) {
          x += '<c r="' + ref + '"' + s + "><v>" + v + "</v></c>";
        } else if (v !== null && v !== undefined && v !== "") {
          x += '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + xe(v) + "</t></is></c>";
        } else if (st) {
          x += '<c r="' + ref + '"' + s + "/>";
        }
      }
      const alt = this.alte.get(riga);
      righe += '<row r="' + riga + '"' + (alt ? ' ht="' + alt + '" customHeight="1"' : "") + ">" + x + "</row>";
    }
    const cols = this.larg.map((w, i) => w ? '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>' : "").join("");
    const vista = '<sheetView workbookViewId="0"' + (scelto ? ' tabSelected="1"' : "") + ">" +
      (this.blocco ? '<pane ySplit="' + this.blocco + '" topLeftCell="A' + (this.blocco + 1) + '" activePane="bottomLeft" state="frozen"/>' : "") + "</sheetView>";
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews>' + vista + '</sheetViews><sheetFormatPr defaultRowHeight="14"/>' +
      (cols ? "<cols>" + cols + "</cols>" : "") + "<sheetData>" + righe + "</sheetData>" +
      (this.unioni.length ? '<mergeCells count="' + this.unioni.length + '">' + this.unioni.map((u) => '<mergeCell ref="' + u + '"/>').join("") + "</mergeCells>" : "") +
      '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>' +
      '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>';
  }
}

const TIPI_AV = { economia: "Economia", nolo: "Nolo", altro: "Altro" };
const STATI = { bozza: "Bozza (non emesso)", anteprima: "Anteprima (nessun SAL in preparazione)", emesso: "Emesso", firmato_impresa: "Firmato dall’impresa",
  visto_dl: "Visto dalla Direzione Lavori", sostituito: "Sostituito da una versione successiva", annullato: "Annullato" };

export function salXlsx(d) {
  const sal = d.sal || {}, co = d.conto || {}, cm = d.computo || {}, ca = d.cantiere || {};
  const voci = Array.isArray(d.voci) ? d.voci : [];
  const lib = Array.isArray(d.libretto) ? d.libretto : [];
  const sto = Array.isArray(d.storico) ? d.storico : [];
  const alt = Array.isArray(d.altre_voci) ? d.altre_voci : [];
  const N = Number(sal.numero) || 1;
  const trag = co.traguardo && co.traguardo.modo === "percentuale" ? co.traguardo : null;
  const somma = (a, k, filtro) => a.reduce((t, x) => t + (filtro && !filtro(x) ? 0 : (num(x[k]) || 0)), 0);
  const r2 = (x) => Math.round(x * 100) / 100;

  // ---- Libretto delle misure
  const L = new Foglio("Libretto");
  L.larg = [11, 8, 13, 22, 26, 30, 9, 9, 9, 9, 12, 7, 18];
  L.c(1, 1, "Libretto delle misure — fino al SAL n. " + N, S.TIT);
  L.c(2, 1, "Ogni riga è una misura confermata dall’ufficio. Se ci sono le dimensioni, la quantità è il loro prodotto (formula). Le misure in meno hanno la quantità negativa.", S.NOTA);
  L.unioni.push("A2:M2"); L.alte.set(2, 26);
  ["Data", "N. voce", "Tariffa", "Voce", "Luogo", "Descrizione", "Parti uguali", "Lunghezza", "Larghezza", "H / peso", "Quantità", "SAL n.", "Scritta da"]
    .forEach((t, i) => L.c(4, i + 1, t, S.HDR));
  L.blocco = 4;
  let rl = 5;
  for (const m of lib) {
    L.c(rl, 1, seriale(m.data), S.DATA); L.c(rl, 2, num(m.nr), S.INT); L.c(rl, 3, m.t || "", S.TXT); L.c(rl, 4, m.d || "", S.TXT);
    L.c(rl, 5, m.luogo || "", S.WRAP);
    L.c(rl, 6, (m.descrizione || "") + (m.pct != null && m.pct !== "" ? (m.descrizione ? " · " : "") + "avanzamento a corpo: " + String(m.pct).replace(".", ",") + " punti %" : ""), S.WRAP);
    const dims = ["pu", "l", "w", "h"].map((k) => num(m[k]));
    dims.forEach((x, i) => L.c(rl, 7 + i, x, S.QTA));
    const q = num(m.q);
    if (dims.some((x) => x !== null)) L.c(rl, 11, q, S.QTA, (q < 0 ? "-" : "") + "ROUND(PRODUCT(G" + rl + ":J" + rl + "),2)");
    else L.c(rl, 11, q, S.QTA);
    L.c(rl, 12, num(m.sal), S.INT); L.c(rl, 13, m.da || "", S.TXT);
    rl++;
  }
  if (!lib.length) L.c(5, 1, "Nessuna misura.", S.NOTA);

  // ---- Avanzamento per voce
  const A = new Foglio("Avanzamento");
  A.larg = [7, 13, 46, 7, 11, 11, 13, 11, 11, 11, 13, 13, 13, 9, 8, 11, 26];
  A.c(1, 1, "Avanzamento per voce — SAL n. " + N + " (lavori fino al " + String(sal.periodo_a || "").split("-").reverse().join("/") + ")", S.TIT);
  A.c(2, 1, (ca.nome || "") + (ca.impresa ? " · " + ca.impresa : ""), S.LAB);
  A.c(3, 1, "Q. precedente e Q. periodo sono somme del foglio «Libretto» (SUMIFS sul numero della voce e sul numero del SAL in Riepilogo!B5). Gli importi sono quantità × prezzo, arrotondati al centesimo.", S.NOTA);
  A.unioni.push("A3:Q3"); A.alte.set(3, 26);
  ["N.", "Tariffa", "Descrizione", "U.M.", "Prezzo", "Q. contratto", "Importo contratto", "Q. precedente", "Q. periodo", "Q. a oggi",
   "Importo precedente", "Importo a oggi", "Importo periodo", "% contratto", "A corpo", "Ribassabile", "Note"].forEach((t, i) => A.c(5, i + 1, t, S.HDR));
  A.alte.set(5, 30);
  A.blocco = 5;
  let ra = 6;
  const capitoli = [];
  const perCap = new Map();
  for (const v of voci) { const k = Number(v.cap); if (!perCap.has(k)) { perCap.set(k, []); capitoli.push({ o: k, n: v.cn || "Senza capitolo" }); } perCap.get(k).push(v); }
  const primaVoce = ra;
  for (const cap of capitoli) {
    A.c(ra, 1, cap.o === 9999 ? "" : "Cap. " + cap.o, S.CAP);
    A.c(ra, 2, "", S.CAP); A.c(ra, 3, cap.n, S.CAP);
    for (let k = 4; k <= 17; k++) A.c(ra, k, "", S.CAP);
    ra++;
    const da = ra;
    const lista = perCap.get(cap.o);
    for (const v of lista) {
      const p = num(v.p) || 0, qc = num(v.qc) || 0, qp = num(v.qp) || 0, qn = num(v.qn) || 0;
      A.c(ra, 1, num(v.nr), S.INT); A.c(ra, 2, v.t || "", S.TXT); A.c(ra, 3, v.d || v.db || "", S.WRAP); A.c(ra, 4, v.u || "", S.TXT);
      A.c(ra, 5, p, S.EUR); A.c(ra, 6, qc, S.QTA);
      A.c(ra, 7, num(v.ic), S.EUR, "ROUND(F" + ra + "*E" + ra + ",2)");
      A.c(ra, 8, qp, S.QTA, "SUMIFS(Libretto!$K:$K,Libretto!$B:$B,$A" + ra + ",Libretto!$L:$L,\"<\"&Riepilogo!$B$5)");
      A.c(ra, 9, qn, S.QTA, "SUMIFS(Libretto!$K:$K,Libretto!$B:$B,$A" + ra + ",Libretto!$L:$L,Riepilogo!$B$5)");
      A.c(ra, 10, num(v.qt), S.QTA, "H" + ra + "+I" + ra);
      A.c(ra, 11, num(v.ip), S.EUR, "ROUND(H" + ra + "*E" + ra + ",2)");
      A.c(ra, 12, num(v.it), S.EUR, "ROUND(J" + ra + "*E" + ra + ",2)");
      A.c(ra, 13, num(v.in), S.EUR, "L" + ra + "-K" + ra);
      A.c(ra, 14, qc > 0 ? (qp + qn) / qc : "", S.PCT, "IF(F" + ra + ">0,J" + ra + "/F" + ra + ",\"\")");
      A.c(ra, 15, v.corpo ? "sì" : "no", S.TXT); A.c(ra, 16, v.rib === false ? "no" : "sì", S.TXT);
      A.c(ra, 17, v.oltre ? "oltre il computo: possibile variante o lavoro extra" : "", v.oltre ? S.AVV : S.TXT);
      ra++;
    }
    const a = ra - 1;
    A.c(ra, 1, "", S.SUBLAB); A.c(ra, 2, "", S.SUBLAB); A.c(ra, 3, "Totale " + cap.n, S.SUBLAB);
    for (const [k, campo] of [[7, "ic"], [11, "ip"], [12, "it"], [13, "in"]]) {
      const L1 = colonna(k);
      A.c(ra, k, r2(somma(lista, campo)), S.SUB, "SUBTOTAL(9," + L1 + da + ":" + L1 + a + ")");
    }
    for (const k of [4, 5, 6, 8, 9, 10, 14, 15, 16, 17]) A.c(ra, k, "", S.SUB);
    ra++;
  }
  const ultima = ra - 1;
  const rTot = ra;
  A.c(rTot, 1, "", S.TOTLAB); A.c(rTot, 2, "", S.TOTLAB); A.c(rTot, 3, "TOTALE", S.TOTLAB);
  const totIc = r2(somma(voci, "ic")), totIt = r2(somma(voci, "it"));
  for (const [k, val] of [[7, totIc], [11, r2(somma(voci, "ip"))], [12, totIt], [13, r2(somma(voci, "in"))]]) {
    const L1 = colonna(k);
    A.c(rTot, k, val, S.TOT, "SUBTOTAL(9," + L1 + primaVoce + ":" + L1 + ultima + ")");
  }
  A.c(rTot, 14, totIc > 0 ? totIt / totIc : "", S.PCTB, "IF(G" + rTot + ">0,L" + rTot + "/G" + rTot + ",\"\")");
  for (const k of [4, 5, 6, 8, 9, 10, 15, 16, 17]) A.c(rTot, k, "", S.TOT);
  const AV =(col) => "Avanzamento!$" + col + "$" + primaVoce + ":$" + col + "$" + ultima;

  // ---- Storico dei SAL
  const T = new Foglio("Storico");
  T.larg = [7, 8, 20, 11, 11, 11, 14, 14, 13, 13, 14, 13, 15, 66];
  T.c(1, 1, "Storico dei SAL emessi prima di questo", S.TIT);
  T.c(2, 1, "Solo i SAL in vigore (emessi, firmati o vistati). Le versioni sostituite e i SAL annullati non contano.", S.NOTA);
  T.unioni.push("A2:N2");
  ["SAL n.", "Versione", "Stato", "Dal", "Al", "Emesso il", "Lavori a oggi", "Netto a oggi", "Ritenuta", "Recupero anticipazione", "Spettanza a oggi",
   "Altre voci del SAL", "Importo del SAL (+ IVA)", "Impronta SHA-256 del documento"].forEach((t, i) => T.c(4, i + 1, t, S.HDR));
  T.alte.set(4, 30);
  T.blocco = 4;
  let rt = 5;
  for (const x of sto) {
    T.c(rt, 1, num(x.numero), S.INT); T.c(rt, 2, num(x.versione), S.INT); T.c(rt, 3, STATI[x.stato] || x.stato || "", S.TXT);
    T.c(rt, 4, seriale(x.periodo_da), S.DATA); T.c(rt, 5, seriale(x.periodo_a), S.DATA); T.c(rt, 6, seriale(x.data_sal), S.DATA);
    T.c(rt, 7, num(x.lavori), S.EUR); T.c(rt, 8, num(x.netto), S.EUR); T.c(rt, 9, num(x.ritenuta), S.EUR); T.c(rt, 10, num(x.recupero), S.EUR);
    T.c(rt, 11, r2((num(x.netto) || 0) - (num(x.ritenuta) || 0) - (num(x.recupero) || 0)), S.EUR, "H" + rt + "-I" + rt + "-J" + rt);
    T.c(rt, 12, num(x.altre_voci_sal), S.EUR); T.c(rt, 13, num(x.dovuto), S.EUR); T.c(rt, 14, x.sha || "", S.TXT);
    rt++;
  }
  const stoFine = rt - 1;
  if (!sto.length) { T.c(5, 1, "Nessun SAL emesso prima di questo.", S.NOTA); rt = 6; }

  // ---- Riepilogo
  const R = new Foglio("Riepilogo");
  R.larg = [52, 18, 18, 14, 4, 12, 40, 8, 12, 12, 14];
  R.c(1, 1, "TIX™ · Stato di avanzamento lavori n. " + N + (Number(sal.versione) > 1 ? " (versione " + sal.versione + ")" : "") + " — proposta dell’impresa", S.TIT);
  R.c(2, 1, (ca.nome || "") + (ca.ubicazione ? " · " + ca.ubicazione : "") + (ca.impresa ? " · " + ca.impresa : ""), S.LAB);
  R.c(4, 1, "Dati del SAL", S.HDR); R.c(4, 2, "", S.HDR);
  const righeDati = [["SAL n.", N, S.INT], ["Versione", Number(sal.versione) || 1, S.INT], ["Stato", STATI[sal.stato] || sal.stato || "", S.TXT],
    ["Lavori dal", seriale(sal.periodo_da), S.DATA], ["Lavori al", seriale(sal.periodo_a), S.DATA],
    ["Emesso", sal.emesso_il ? sal.emesso_il + (sal.emesso_da ? " da " + sal.emesso_da : "") : "non ancora", S.TXT],
    ["Impronta SHA-256 del documento del SAL", sal.sha || "si assegna all’emissione", S.TXT],
    ["Committente", ca.committente || "", S.TXT], ["Direzione Lavori", ca.dl || "", S.TXT]];
  let rr = 5;
  for (const [et, v, st] of righeDati) { R.c(rr, 1, et, S.TXT); R.c(rr, 2, v, st); rr++; }
  rr++;
  R.c(rr, 1, "Contratto", S.HDR); R.c(rr, 2, "", S.HDR); rr++;
  const rBase = rr; R.c(rr, 1, "Importo del contratto (base per % e anticipazione)", S.TXT); R.c(rr, 2, num(co.base_contratto), S.EUR); rr++;
  const rImpC = rr; R.c(rr, 1, "Importo del computo (lavori, versione " + (cm.versione || "") + ")", S.TXT); R.c(rr, 2, totIc, S.EUR, "Avanzamento!G" + rTot); rr++;
  const rRib = rr; R.c(rr, 1, "Ribasso (%)", S.TXT); R.c(rr, 2, num(co.ribasso_pct) || 0, S.QTA); rr++;
  const rOneri = rr; R.c(rr, 1, "Oneri della sicurezza (" + ({ nei_prezzi: "compresi nei prezzi, non si aggiungono", proporzionale: "in proporzione ai lavori", voci: "nelle voci non ribassabili" }[co.sicurezza_modo] || "") + ")", S.TXT);
  R.c(rr, 2, num(co.oneri_sicurezza), S.EUR); rr++;
  const rRit = rr; R.c(rr, 1, "Ritenuta a garanzia (%)", S.TXT); R.c(rr, 2, num(co.ritenuta_pct) || 0, S.QTA); rr++;
  const rAnt = rr; R.c(rr, 1, "Anticipazione (%)", S.TXT); R.c(rr, 2, num(co.anticipazione_pct) || 0, S.QTA); rr++;
  let rCum = 0;
  if (trag) { rCum = rr; R.c(rr, 1, "Traguardo «" + (trag.nome || "") + "»: quota del contratto in tutto, con i traguardi precedenti (%)", S.WRAP); R.c(rr, 2, num(trag.cumulata) || 0, S.QTA); rr++; }
  rr++;
  R.c(rr, 1, "Conto del SAL", S.HDR); R.c(rr, 2, "Importo (formula)", S.HDR); R.c(rr, 3, "Registrato da TIX", S.HDR); R.c(rr, 4, "Differenza", S.HDR);
  R.alte.set(rr, 28); rr++;
  // valori per il confronto (dal database) e valori già calcolati per le formule
  const lavMis = num(co.lavori_misura) || 0, lavCor = num(co.lavori_corpo) || 0, lav = num(co.lavori) || 0;
  const lavPer = co.lavori_periodo != null ? num(co.lavori_periodo) : r2(somma(voci, "in"));
  const nonRib = co.non_ribassabili != null ? num(co.non_ribassabili) : r2(somma(voci, "it", (v) => v.rib === false));
  const avSal = num(co.altre_voci_sal) || 0, avPrec = co.altre_voci_prec != null ? num(co.altre_voci_prec) : r2((num(co.altre_voci) || 0) - avSal);
  const antic = co.anticipazione != null ? num(co.anticipazione) : r2((num(co.base_contratto) || 0) * (num(co.anticipazione_pct) || 0) / 100);
  const riga = (et, f, v, db, st) => {
    R.c(rr, 1, et, st === S.GRANDE ? S.TOTLAB : S.TXT);
    R.c(rr, 2, v, st || S.EUR, f);
    if (db !== undefined) { R.c(rr, 3, db, S.EUR); R.c(rr, 4, 0, S.EUR, "B" + rr + "-C" + rr); }
    return rr++;
  };
  const rMis = riga("Lavori a misura a oggi (prezzi di contratto)", "SUMIFS(" + AV("L") + "," + AV("O") + ",\"no\")", lavMis, lavMis);
  const rCor = riga("Lavori a corpo a oggi", "SUMIFS(" + AV("L") + "," + AV("O") + ",\"sì\")", lavCor, lavCor);
  const rLav = riga("Totale lavori a oggi", "B" + rMis + "+B" + rCor, lav, lav, S.EURB);
  riga("   di cui in questo periodo", "SUMIFS(" + AV("M") + "," + AV("O") + ",\"<>\")", lavPer, lavPer);
  const rNr = riga("   di cui non ribassabili", "SUMIFS(" + AV("L") + "," + AV("P") + ",\"no\")", nonRib, nonRib);
  const rRibI = riga("− Ribasso", trag ? "0" : "ROUND((B" + rLav + "-B" + rNr + ")*B" + rRib + "/100,2)", num(co.ribasso) || 0, num(co.ribasso) || 0);
  const rSic = riga("+ Oneri della sicurezza", trag || co.sicurezza_modo !== "proporzionale" ? "0" : "IF(B" + rImpC + ">0,ROUND(B" + rOneri + "*MIN(1,B" + rLav + "/B" + rImpC + "),2),0)",
    num(co.sicurezza) || 0, num(co.sicurezza) || 0);
  const rAvp = riga("+ Altre voci dei SAL precedenti", sto.length ? "SUM(Storico!$L$5:$L$" + stoFine + ")" : "0", avPrec, avPrec);
  const rAvsF = rr; // la formula delle altre voci di questo SAL punta alla tabella sotto: si scrive dopo
  rr++;
  const rNet = riga("= Lavori netti a oggi", trag ? "ROUND(B" + rBase + "*B" + rCum + "/100,2)+B" + rAvp + "+B" + rAvsF
    : "B" + rLav + "-B" + rRibI + "+B" + rSic + "+B" + rAvp + "+B" + rAvsF, num(co.netto) || 0, num(co.netto) || 0, S.EURB);
  const rRitI = riga("− Ritenuta a garanzia", "ROUND(B" + rNet + "*B" + rRit + "/100,2)", num(co.ritenuta) || 0, num(co.ritenuta) || 0);
  const rAntI = riga("   Anticipazione", "ROUND(B" + rBase + "*B" + rAnt + "/100,2)", antic, antic);
  const rRec = riga("− Recupero dell’anticipazione", "IF(AND(B" + rAntI + ">0,B" + rBase + ">0),MAX(0,MIN(B" + rAntI + ",ROUND(B" + rAntI + "*B" + rNet + "/B" + rBase + ",2))),0)",
    num(co.recupero) || 0, num(co.recupero) || 0);
  const rSp = riga("= Spettanza a oggi", "B" + rNet + "-B" + rRitI + "-B" + rRec, num(co.spettanza) || 0, num(co.spettanza) || 0, S.EURB);
  const rPrev = riga("− SAL già emessi", sto.length ? "SUM(Storico!$M$5:$M$" + stoFine + ")" : "0", num(co.precedenti) || 0, num(co.precedenti) || 0);
  riga("= IMPORTO DI QUESTO SAL (+ IVA)", "B" + rSp + "-B" + rPrev, num(co.dovuto) || 0, num(co.dovuto) || 0, S.GRANDE);
  rr++;
  R.c(rr, 1, "Importi in euro, IVA esclusa: TIX non calcola l’IVA (10%, 22%, inversione contabile o scissione dei pagamenti dipendono dal caso). " +
    "Le celle della colonna B sono formule che leggono i fogli Avanzamento, Libretto e Storico; la colonna C riporta i numeri registrati da TIX e la differenza deve essere zero.", S.NOTA);
  R.unioni.push("A" + rr + ":D" + rr); R.alte.set(rr, 40); rr += 2;
  // altre voci di questo SAL
  R.c(rr, 1, "Altre voci di questo SAL (economie e noli, prezzo già netto)", S.HDR);
  ["Tipo", "U.M.", "Quantità", "", "Prezzo", "Importo"].forEach((t, i) => R.c(rr, 2 + i, t, i === 3 ? 0 : S.HDR));
  rr++;
  const avDa = rr;
  for (const a of alt) {
    const q = num(a.quantita) || 0, p = num(a.prezzo) || 0;
    R.c(rr, 1, a.descrizione || "", S.WRAP); R.c(rr, 2, TIPI_AV[a.tipo] || a.tipo || "", S.TXT); R.c(rr, 3, a.unita || "", S.TXT);
    R.c(rr, 4, q, S.QTA); R.c(rr, 6, p, S.EUR); R.c(rr, 7, r2(q * p), S.EUR, "ROUND(D" + rr + "*F" + rr + ",2)");
    rr++;
  }
  const avA = rr - 1;
  if (!alt.length) { R.c(rr, 1, "Nessuna altra voce in questo SAL.", S.NOTA); rr++; }
  R.c(rAvsF, 1, "+ Altre voci di questo SAL", S.TXT);
  R.c(rAvsF, 2, avSal, S.EUR, alt.length ? "SUM(G" + avDa + ":G" + avA + ")" : "0");
  R.c(rAvsF, 3, avSal, S.EUR); R.c(rAvsF, 4, 0, S.EUR, "B" + rAvsF + "-C" + rAvsF);
  rr++;
  R.c(rr, 1, "Preparato con TIX™. La verifica e l’approvazione spettano alla Direzione Lavori.", S.NOTA);

  // ---- pacchetto xlsx
  const fogli = [R, A, L, T];
  const dataDoc = (String(sal.periodo_a || "2026-01-01").slice(0, 10) || "2026-01-01") + "T00:00:00Z";
  const f = [];
  const add = (n, testo) => f.push({ n, d: ENC.encode(testo) });
  add("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    fogli.map((x, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join("") +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>');
  add("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>');
  add("docProps/core.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    "<dc:title>" + xe("SAL n. " + N + " - " + (ca.nome || "")) + "</dc:title><dc:creator>TIX</dc:creator>" +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + dataDoc + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + dataDoc + "</dcterms:modified></cp:coreProperties>");
  add("docProps/app.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>TIX</Application></Properties>');
  add("xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<bookViews><workbookView activeTab="0"/></bookViews><sheets>' +
    fogli.map((x, i) => '<sheet name="' + x.nome + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join("") +
    '</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>');
  add("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    fogli.map((x, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join("") +
    '<Relationship Id="rId' + (fogli.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  add("xl/styles.xml", STILI);
  fogli.forEach((x, i) => add("xl/worksheets/sheet" + (i + 1) + ".xml", x.xml(i === 0)));
  return zipStore(f);
}

// ---------------------------------------------------------------------------- pagina
export function paginaSal(base, tok, c, d, scheda, h) {
  const e = h.esc;
  const cant = d.cantiere || {};
  const torna = base + "/?t=" + tok + "&c=" + c;
  const logoImpresa = d.logo_impresa
    ? '<div class="dx"><div class="logo-impresa"><img src="' + e(d.logo_impresa) + '" alt="' + e(d.azienda_nome || "") + '"></div></div>'
    : '<div class="dx"></div>';
  const cfg = JSON.stringify({ u: base + "/sal", t: tok, c: c, torna: torna, s: scheda || "" }).replace(/</g, "\\u003c");
  const dati = JSON.stringify(d).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">' +
    "<title>SAL - " + e(cant.nome || "") + "</title>" + h.testa(base) +
    "<style>" + STILE + "</style></head><body>" +
    "<header>" + (d.logo_html || '<div class="marchio">TIX · Diario di cantiere</div>') +
    '<div class="centro"><h1>SAL</h1><p>' + e(cant.nome || "") + (cant.ubicazione ? " &middot; " + e(cant.ubicazione) : "") + "</p></div>" + logoImpresa + "</header>" +
    '<main><a class="indietro" href="' + e(torna) + '">&larr; Torna al cantiere</a>' +
    (d.chiuso ? '<div class="avviso">Cantiere chiuso: il SAL resta consultabile, non si scrivono misure nuove.</div>' : "") +
    '<div id="sal-testa"></div>' +
    '<nav class="sal-tab" role="tablist" aria-label="Sezioni del SAL">' +
    '<button type="button" role="tab" data-s="avanzamento">Avanzamento</button><button type="button" role="tab" data-s="sal">SAL</button>' +
    '<button type="button" role="tab" data-s="contratto">Contratto</button><button type="button" role="tab" data-s="computo">Computo</button></nav>' +
    '<section id="sal-corpo" class="sal-corpo" aria-live="polite"></section>' +
    '<p class="nota">TIX™ prepara il SAL dell’impresa: la verifica e l’approvazione spettano alla Direzione Lavori. ' +
    'Gli importi sono visibili solo a chi entra nell’area riservata dell’impresa e non vengono mai mandati a nessuno da TIX.</p>' +
    '<noscript><p class="nota"><b>Per usare il SAL serve JavaScript attivo nel browser.</b></p></noscript></main>' +
    '<dialog id="dlg" aria-labelledby="dlg-t"><form method="dialog" id="dlg-f" novalidate><div class="dl-t"><h2 id="dlg-t"></h2><p id="dlg-s"></p></div>' +
    '<div class="dl-c" id="dlg-c"></div><p class="msg" id="dlg-m" aria-live="polite"></p>' +
    '<div class="dl-b"><button type="button" class="no" id="dlg-no">Chiudi</button><button type="submit" class="si" id="dlg-si">Salva</button></div></form></dialog>' +
    '<div id="sal-avviso" class="sal-toast" role="status" hidden></div>' +
    "<script>window.SAL_C=" + cfg + ";window.SAL_D=" + dati + ";</script><script>" + APP + "</script></body></html>";
}

const STILE =
  ":root{--sal:#9146DB;--sal-s:#6B2FB3;--sal-c:#F6F0FF;--sal-b:#DCC8F5;--bordo:#d5dcd8;--sfondo:#F4F6F5;--avv:#9A4B00;--avv-c:#FFF4E5}" +
  '*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;padding:0 0 40px;background:var(--sfondo);color:#111;line-height:1.45;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif}' +
  "header{background:#052A21;color:#fff;padding:16px 20px 18px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;column-gap:16px}" +
  "header .logo{display:block;height:44px;width:auto}header .marchio{font-weight:800;font-size:1.05rem}" +
  "header .centro{grid-column:2;grid-row:1;text-align:center}header .centro p{margin:4px 0 0;font-size:.88rem;opacity:.9}" +
  "@keyframes gl-argento{0%{background-position:0% 50%}100%{background-position:100% 50%}}" +
  "header h1{margin:0;font-size:clamp(1.4rem,3vw,1.9rem);letter-spacing:-.01em;background:linear-gradient(90deg,#9AA6AB 0%,#E9EEF0 22%,#FFFFFF 38%,#C9D3D6 55%,#F4F7F8 72%,#9AA6AB 100%);background-size:250% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent}" +
  "@media (prefers-reduced-motion:no-preference){header h1{animation:gl-argento 3.5s ease-in-out infinite alternate}}" +
  "header .dx{grid-column:3;grid-row:1;justify-self:end}" +
  "header .logo-impresa{display:inline-block;background:#fff;border-radius:12px;padding:8px 14px;box-shadow:0 2px 10px rgba(0,0,0,.12)}" +
  "header .logo-impresa img{display:block;height:52px;width:auto;max-width:240px;object-fit:contain}" +
  "@media (max-width:640px){header{grid-template-columns:1fr auto}header .centro{grid-column:1/-1;grid-row:2;margin-top:12px}header .dx{grid-column:2}header .logo{height:36px}header .logo-impresa img{height:40px}}" +
  "main{max-width:1180px;margin:0 auto;padding:16px 16px 0}" +
  "a.indietro{display:inline-flex;align-items:center;min-height:44px;padding:0 12px 0 0;margin:-8px 0 4px;font-size:.95rem;font-weight:800;color:#0A7D48;text-decoration:none}" +
  ".avviso{background:#fff;border-left:4px solid var(--avv);border-radius:10px;padding:10px 14px;margin:0 0 12px;font-size:.92rem}" +
  ".nota{font-size:.82rem;color:#5b6560;margin:14px 0}" +
  // testa: tre cifre
  ".s-cifre{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin:0 0 12px}" +
  ".s-cifra{background:#fff;border:1px solid var(--sal-b);border-radius:14px;padding:12px 14px;box-shadow:0 1px 2px rgba(16,27,43,.05)}" +
  ".s-cifra small{display:block;color:#5b5470;font-size:.74rem;text-transform:uppercase;letter-spacing:.05em;font-weight:700}" +
  ".s-cifra b{display:block;font-size:1.25rem;color:#1d1530;margin-top:2px;font-variant-numeric:tabular-nums}.s-cifra span{font-size:.85rem;color:#5b5470}" +
  ".s-barra{height:8px;border-radius:99px;background:#e9e1f7;overflow:hidden;margin-top:6px}.s-barra i{display:block;height:100%;background:linear-gradient(90deg,#B07CF0,var(--sal))}" +
  ".s-avv{display:block;background:var(--avv-c);border-left:4px solid #C27A12;border-radius:10px;padding:10px 14px;margin:0 0 12px;color:#5A3D00;font-size:.92rem;font-weight:700}" +
  // schede
  ".sal-tab{display:flex;gap:6px;overflow-x:auto;margin:0 0 12px;padding:4px;background:#fff;border:1px solid var(--bordo);border-radius:14px;position:sticky;top:0;z-index:5}" +
  ".sal-tab button{flex:1 0 auto;min-height:44px;padding:0 16px;border:0;border-radius:10px;background:transparent;font:inherit;font-weight:700;color:#3b4252;cursor:pointer}" +
  ".sal-tab button[aria-selected=true]{background:var(--sal);color:#fff;box-shadow:0 2px 8px rgba(145,70,219,.35)}" +
  ".pann{background:#fff;border:1px solid var(--bordo);border-radius:14px;padding:14px 16px;margin:0 0 14px}" +
  ".pann h2{font-size:1.02rem;margin:0 0 10px;color:var(--sal-s)}.pann h3{font-size:.95rem;margin:14px 0 8px;color:#23302A}" +
  ".riga-b{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 0}" +
  ".b{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:42px;padding:0 14px;border-radius:10px;border:1px solid var(--sal);background:#fff;color:var(--sal-s);font:inherit;font-weight:700;cursor:pointer;text-decoration:none}" +
  ".b.pr{background:var(--sal);color:#fff}.b.ex{border-color:#1D6F42;color:#1D6F42;background:#E8F4EC}.b.ro{border-color:#b91c1c;color:#b91c1c}.b:disabled{opacity:.5;cursor:default}" +
  // avanzamento
  ".strum{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 10px}" +
  ".strum input[type=search]{flex:1 1 240px;min-height:44px;padding:0 12px;border:1px solid var(--bordo);border-radius:10px;font:inherit;background:#fff}" +
  ".filtri{display:flex;gap:4px;flex-wrap:wrap}.filtri button{min-height:40px;padding:0 12px;border:1px solid var(--bordo);border-radius:99px;background:#fff;font:inherit;font-size:.88rem;cursor:pointer}" +
  ".filtri button[aria-pressed=true]{background:var(--sal-c);border-color:var(--sal);color:var(--sal-s);font-weight:700}" +
  "table.av{width:100%;border-collapse:collapse;font-size:.86rem;font-variant-numeric:tabular-nums}" +
  "table.av th{position:sticky;top:56px;background:#FAF7FF;color:#4A1F86;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;text-align:right;padding:6px;border-bottom:2px solid var(--sal-b);z-index:2}" +
  "table.av th.t,table.av td.t{text-align:left}table.av td{padding:7px 6px;border-bottom:1px solid #EEF0EF;text-align:right;vertical-align:top}" +
  "table.av tr.v{cursor:pointer}table.av tr.v:hover td{background:#FBF8FF}table.av tr.cap td{background:#F1F3F2;font-weight:800;color:#23302A;text-align:left;cursor:pointer}" +
  "table.av tr.cap td .ci{float:right;font-weight:700;color:#5b5470;font-variant-numeric:tabular-nums}" +
  "table.av tr.oltre td{background:#FFF8EE}.tag-o{display:inline-block;margin-top:2px;font-size:.72rem;font-weight:800;color:var(--avv);background:var(--avv-c);border-radius:6px;padding:1px 6px}" +
  ".pb{display:inline-block;width:56px;height:6px;border-radius:99px;background:#eee;vertical-align:middle;margin-left:6px;overflow:hidden}.pb i{display:block;height:100%;background:var(--sal)}" +
  ".vd{font-weight:700;color:#1d1530}.vs{display:block;color:#6b7280;font-size:.78rem;font-weight:400}" +
  "@media (max-width:760px){table.av thead{display:none}table.av,table.av tbody,table.av tr,table.av td{display:block;width:100%}" +
  "table.av tr.v{border:1px solid #ECEEED;border-radius:12px;margin:0 0 8px;padding:8px 10px;background:#fff}table.av tr.oltre{background:#FFF8EE}" +
  "table.av td{border:0;padding:2px 0;text-align:left}table.av td[data-l]::before{content:attr(data-l) \": \";color:#6b7280;font-size:.78rem}" +
  "table.av tr.v td[data-l]{display:inline-block;width:50%;vertical-align:top}" +
  "table.av td.nas{display:none}table.av tr.cap{margin:12px 0 6px}table.av tr.cap td{border-radius:10px;padding:10px}table.av tr.cap td .ci{float:none;display:block;margin-top:2px}" +
  ".sal-tab button{padding:0 8px;font-size:.88rem;flex:1 1 auto}}" +
  ".mis{list-style:none;margin:0;padding:0}.mis li{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;padding:8px 0;border-top:1px solid #eee;font-size:.9rem}" +
  ".mis li .q{font-weight:800;font-variant-numeric:tabular-nums}.mis li .sp{flex:1}.mis li.neg .q{color:#b91c1c}" +
  // conto
  "table.conto{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}table.conto td{padding:7px 4px;border-bottom:1px solid #EEF0EF}" +
  "table.conto td.n{text-align:right;white-space:nowrap}table.conto tr.tot td{font-weight:800;background:#FAF7FF}" +
  "table.conto tr.fin td{font-weight:900;font-size:1.08rem;background:var(--sal-c);color:#3d1a6e;border-top:2px solid var(--sal)}table.conto .sub{color:#6b7280;font-size:.82rem}" +
  ".sal-el{display:grid;gap:10px}.sal-c{border:1px solid var(--bordo);border-radius:12px;padding:12px}.sal-c .r1{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center}" +
  ".st{font-size:.76rem;font-weight:800;padding:3px 9px;border-radius:99px;background:#eee;color:#333}.st.em{background:var(--sal-c);color:var(--sal-s)}.st.fi{background:#FFF4DC;color:#7A4A00}.st.ok{background:#E6F6EC;color:#0B5E37}.st.no{background:#F3F4F6;color:#6b7280}" +
  ".imp{font-weight:900;font-size:1.05rem;font-variant-numeric:tabular-nums}" +
  // moduli
  ".campi{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px 14px}" +
  "label{display:block;font-size:.86rem;font-weight:700;color:#23302A}label small{font-weight:400;color:#6b7280}" +
  "input,select,textarea{display:block;width:100%;margin-top:4px;min-height:42px;padding:8px 10px;border:1px solid #c9d1cd;border-radius:10px;font:inherit;font-weight:400;background:#fff;color:#111}" +
  "textarea{min-height:60px}input[type=checkbox],input[type=radio]{display:inline-block;width:auto;min-height:0;margin:0 6px 0 0;vertical-align:middle;accent-color:var(--sal)}" +
  ".scelte{display:grid;gap:6px;margin:4px 0}.scelte label{font-weight:600;display:flex;align-items:center;padding:8px 10px;border:1px solid #E1E6E3;border-radius:10px;cursor:pointer}" +
  ".tg{display:grid;grid-template-columns:2fr 1.2fr .8fr 1fr 1fr auto;gap:6px;align-items:end;margin:0 0 6px}.tg button{min-height:42px}" +
  ".av-r{display:grid;grid-template-columns:1fr 3fr .8fr 1fr 1fr auto;gap:6px;align-items:end;margin:0 0 6px}" +
  "@media (max-width:760px){.tg,.av-r{grid-template-columns:1fr 1fr}.tg .x,.av-r .x{grid-column:span 2}}" +
  ".ok-v{color:#0B5E37;font-weight:800}.ko-v{color:var(--avv);font-weight:800}" +
  ".wa{border-left:3px solid #25D366;padding:6px 10px;margin:6px 0;background:#F6FFF9;border-radius:6px;font-size:.9rem}.wa small{color:#6b7280}" +
  // finestra
  "dialog{border:0;border-radius:16px;padding:0;width:min(560px,94vw);max-height:92vh;box-shadow:0 20px 60px rgba(0,0,0,.35)}dialog::backdrop{background:rgba(10,18,28,.55)}" +
  ".dl-t{padding:16px 18px 6px;border-bottom:1px solid #eee}.dl-t h2{margin:0;font-size:1.08rem;color:var(--sal-s)}.dl-t p{margin:4px 0 8px;font-size:.86rem;color:#5b6560}" +
  ".dl-c{padding:12px 18px;display:grid;gap:10px;overflow:auto;max-height:60vh}.dl-b{display:flex;justify-content:flex-end;gap:8px;padding:10px 18px 16px}" +
  ".dl-b button{min-height:44px;padding:0 18px;border-radius:10px;border:1px solid #c9d1cd;background:#fff;font:inherit;font-weight:700;cursor:pointer}.dl-b .si{background:var(--sal);border-color:var(--sal);color:#fff}" +
  ".dl-b .si.rosso{background:#b91c1c;border-color:#b91c1c}.msg{margin:0 18px;color:#b91c1c;font-weight:700;font-size:.9rem;min-height:1em}" +
  ".dims{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}.calc{font-size:.9rem;color:#4A1F86;font-weight:700}" +
  ".sal-toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:#1d1530;color:#fff;padding:10px 16px;border-radius:12px;font-weight:700;z-index:50;box-shadow:0 8px 30px rgba(0,0,0,.3)}" +
  // caricamento del computo
  ".k-car{border:2px dashed var(--sal-b);background:#FCFAFF}.k-car p{margin:0 0 10px}" +
  ".giro{display:inline-block;width:18px;height:18px;border:3px solid var(--sal-b);border-top-color:var(--sal);border-radius:50%;animation:giro 1s linear infinite;vertical-align:middle;margin-right:8px}" +
  "@keyframes giro{to{transform:rotate(360deg)}}.k-att{font-weight:700;color:#3d1a6e;padding:6px 0}" +
  ".k-err{background:#FEF2F2;border-left:4px solid #b91c1c;border-radius:10px;padding:10px 14px;color:#7f1d1d;font-weight:700;margin:8px 0}" +
  ".k-avv{margin:8px 0;padding:0 0 0 18px;color:var(--avv);font-weight:700;font-size:.9rem}.k-avv li{margin:3px 0}" +
  "table.av tr.kv{cursor:default}table.av tr.kv.alt td{color:#6b7280}" +
  ":root{color-scheme:light}";

const APP = String.raw`(function(){"use strict";
var C=window.SAL_C,D=window.SAL_D;
var $=function(s,r){return (r||document).querySelector(s);};
function vuoto(n){return n===null||n===undefined||n===''||!isFinite(Number(n));}
function grp(s){return s.replace(/\B(?=(\d{3})+(?!\d))/g,'.');}
function eur(n){if(vuoto(n))return '';var x=Number(n),p=Math.abs(x).toFixed(2).split('.');return (x<0&&Math.abs(x)>=0.005?'-':'')+grp(p[0])+','+p[1];}
function qt(n){if(vuoto(n))return '';var x=Math.round(Number(n)*1000)/1000,p=Math.abs(x).toFixed(3).replace(/\.?0+$/,'').split('.');return (x<0?'-':'')+grp(p[0])+(p[1]?','+p[1]:'');}
function pc(n){if(vuoto(n))return '';return Number(n).toFixed(2).replace('.',',')+'%';}
function es(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function di(s){if(!s)return '';var p=String(s).slice(0,10).split('-');return p[2]+'/'+p[1]+'/'+p[0];}
function nu(s){if(s===null||s===undefined)return null;var t=String(s).trim().replace(/\s/g,'');if(t==='')return null;if(t.indexOf(',')>=0)t=t.replace(/\./g,'').replace(',','.');var n=Number(t);return isFinite(n)?n:NaN;}
function ls(k,v){try{if(v===undefined)return localStorage.getItem(k)||'';localStorage.setItem(k,v);}catch(e){return '';}}
function avviso(t){var a=$('#sal-avviso');a.textContent=t;a.hidden=false;clearTimeout(avviso.h);avviso.h=setTimeout(function(){a.hidden=true;},3500);}
function api(azione,extra){var b={t:C.t,c:C.c,azione:azione};extra=extra||{};for(var k in extra)b[k]=extra[k];
  return fetch(C.u+'/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})
    .then(function(r){return r.json();}).catch(function(){return {esito:'incerto'};});}
function ricarica(){return api('contesto').then(function(r){if(r&&r.esito==='ok'){D=r;tutto();}else if(r&&(r.esito==='gettone'||r.esito==='spento')){location.href=C.torna;}});}
function errore(r){if(!r)return 'Il servizio non risponde: riprova.';if(r.esito==='chiuso')return 'Il cantiere è chiuso.';if(r.esito==='incerto')return 'Non sappiamo se è andata a buon fine: ricarica la pagina e controlla.';return r.messaggio||'Non è stato possibile salvare.';}
var K=D.computo||null,CL=D.calcolo||null,CO=CL?CL.conto:null;
var scheda=C.s||ls('sal_scheda')||'avanzamento';if(!K||!CL||!(CL.voci||[]).length)scheda=C.s||'computo';
var IMP=null,impId=D.import?D.import.id:null,impTutte=false,impTimer=null,impGiri=0;
var filtro='tutte',cerca='';
var chiusi={};

function tutto(){K=D.computo||null;CL=D.calcolo||null;CO=CL?CL.conto:null;testa();schede();corpo();}

function testa(){
  var h='';
  if(D.avviso)h+='<a class="s-avv" href="#" data-vai="sal">'+es(D.avviso.testo)+'</a>';
  if(CO){var p=Math.max(0,Math.min(100,Number(CO.pct)||0));
    var prox=D.bozza?'n. '+D.bozza.numero+(D.bozza.versione>1?' (v. '+D.bozza.versione+')':'')+' in preparazione':(D.prossimo?'n. '+D.prossimo.numero:'');
    h+='<div class="s-cifre"><div class="s-cifra"><small>Contratto</small><b>'+eur(CO.base_contratto)+' €</b><span>computo v. '+es(K.versione)+': '+eur(CO.importo_computo)+' €</span></div>'+
      '<div class="s-cifra"><small>Fatto a oggi</small><b>'+eur(CO.lavori)+' €</b><span>'+pc(CO.pct)+' del computo</span><div class="s-barra"><i style="width:'+p.toFixed(1)+'%"></i></div></div>'+
      '<div class="s-cifra"><small>Prossimo SAL</small><b>'+es(prox)+'</b><span>'+es(regola())+'</span></div></div>';}
  $('#sal-testa').innerHTML=h;
}
function regola(){if(!K)return '';var c=K.cadenza_sal;return c==='mensile'?'SAL mensile':c==='soglia'?'ogni '+eur(K.soglia_sal_importo)+' € di lavori':c==='traguardi'?'a traguardi':c==='fine_lavori'?'unico a fine lavori':'regola dei SAL da scegliere';}
function schede(){[].forEach.call(document.querySelectorAll('.sal-tab button'),function(b){b.setAttribute('aria-selected',b.getAttribute('data-s')===scheda?'true':'false');});}
function corpo(){var el=$('#sal-corpo');
  if(scheda==='avanzamento')el.innerHTML=avanzamento();else if(scheda==='sal')el.innerHTML=salTab();else if(scheda==='contratto')el.innerHTML=contratto();else el.innerHTML=computo();
  if(scheda==='contratto')legaContratto();}

// ---------------- avanzamento
function voceVisibile(v){
  if(filtro==='lavori'&&!(Number(v.qt)||Number(v.qp)))return false;
  if(filtro==='oltre'&&!v.oltre)return false;
  if(cerca){var s=(v.nr+' '+(v.t||'')+' '+(v.d||'')+' '+(v.dl||'')).toLowerCase();var p=cerca.split(/\s+/);for(var i=0;i<p.length;i++)if(p[i]&&s.indexOf(p[i])<0)return false;}
  return true;}
function avanzamento(){
  if(!K||!CL||!(CL.voci||[]).length)return '<div class="pann"><h2>Prima serve il computo</h2><p>Per misurare l’avanzamento il cantiere deve avere il computo metrico del contratto. Apri la scheda «Computo».</p></div>';
  var h='<div class="pann"><div class="strum"><input type="search" id="cerca" placeholder="Cerca una voce: numero, tariffa o parole" value="'+es(cerca)+'" autocomplete="off">'+
    '<div class="filtri"><button type="button" data-f="tutte" aria-pressed="'+(filtro==='tutte')+'">Tutte</button><button type="button" data-f="lavori" aria-pressed="'+(filtro==='lavori')+'">Con lavori</button>'+
    '<button type="button" data-f="oltre" aria-pressed="'+(filtro==='oltre')+'">Oltre il computo</button></div></div>'+
    '<p class="nota" style="margin:0 0 8px">Tocca una voce per scrivere una misura. '+(D.bozza?'Il periodo del SAL n. '+D.bozza.numero+' arriva al '+di(D.bozza.periodo_a)+'.':'Le quantità «periodo» sono quelle non ancora in un SAL.')+'</p>'+
    '<table class="av"><thead><tr><th class="t">Voce</th><th>Prezzo</th><th>Contratto</th><th>Prima</th><th>Periodo</th><th>A oggi</th><th>%</th><th>Importo a oggi</th></tr></thead>';
  var caps=CL.capitoli||[],per={};(CL.voci||[]).forEach(function(v){(per[v.cap]=per[v.cap]||[]).push(v);});
  var n=0;
  caps.forEach(function(cap){var lista=(per[cap.o]||[]).filter(voceVisibile);if(!lista.length)return;
    var ch=chiusi[cap.o]&&!cerca&&filtro==='tutte';
    h+='<tbody><tr class="cap" data-cap="'+cap.o+'"><td colspan="8">'+(ch?'▸ ':'▾ ')+es(cap.n)+'<span class="ci">'+eur(cap.it)+' / '+eur(cap.ic)+' € · '+pc(cap.pct)+'</span></td></tr>';
    if(!ch)lista.forEach(function(v){n++;var p=Math.max(0,Math.min(100,Number(v.pct)||0));
      h+='<tr class="v'+(v.oltre?' oltre':'')+'" data-v="'+es(v.id)+'"><td class="t"><span class="vd">'+es(v.nr)+' · '+es(v.d)+'</span><span class="vs">'+es(v.t||'')+' · '+es(v.u)+(v.perc?(v.u==='a corpo'?', in %':' · a corpo, in %'):'')+'</span>'+(v.oltre?'<span class="tag-o">oltre il computo</span>':'')+'</td>'+
        '<td data-l="Prezzo">'+eur(v.p)+'</td><td data-l="Contratto">'+qt(v.qc)+'</td><td data-l="Prima">'+qt(v.qp)+'</td><td data-l="Periodo">'+qt(v.qn)+(v.dopo?' <small>(+'+v.dopo+' dopo)</small>':'')+'</td>'+
        '<td data-l="A oggi"><b>'+qt(v.qt)+'</b></td><td data-l="%">'+(v.pct!=null?pc(v.pct)+'<span class="pb"><i style="width:'+p+'%"></i></span>':'')+'</td><td data-l="Importo a oggi"><b>'+eur(v.it)+'</b></td></tr>';});
    h+='</tbody>';});
  h+='</table>'+(n||Object.keys(chiusi).length?'':'<p class="nota">Nessuna voce con questi filtri.</p>')+'</div>';
  var ms=D.misure||[];
  h+='<div class="pann"><h2>Misure non ancora in un SAL ('+ms.length+')</h2>';
  if(!ms.length)h+='<p class="nota" style="margin:0">Nessuna. Tocca una voce qui sopra per scriverne una.</p>';
  else{h+='<ul class="mis">';ms.forEach(function(m){var v=voce(m.voce_id)||{};
    h+='<li class="'+(Number(m.q)<0?'neg':'')+'"><span>'+di(m.data)+'</span><span><b>'+es(m.nr)+'</b> '+es(v.d||'')+'</span><span class="sp">'+es([m.luogo,m.descrizione].filter(Boolean).join(' — '))+'</span>'+
      '<span class="q">'+qt(m.q)+' '+es(v.u||'')+'</span>'+(m.da?'<small>'+es(m.da)+'</small>':'')+
      (D.chiuso?'':'<button type="button" class="b" data-mod="'+es(m.id)+'">Modifica</button><button type="button" class="b ro" data-togli="'+es(m.id)+'">Togli</button>')+'</li>';});h+='</ul>';}
  return h+'</div>';
}
function voce(id){var a=(CL&&CL.voci)||[];for(var i=0;i<a.length;i++)if(a[i].id===id)return a[i];return null;}

// ---------------- finestra
var dlgAzione=null;
function finestra(t,s,c,etich,fn,rosso){$('#dlg-t').textContent=t;$('#dlg-s').textContent=s||'';$('#dlg-c').innerHTML=c;$('#dlg-m').textContent='';
  var b=$('#dlg-si');b.textContent=etich||'Salva';b.className='si'+(rosso?' rosso':'');b.disabled=false;dlgAzione=fn;var d=$('#dlg');if(d.showModal)d.showModal();else d.setAttribute('open','');}
function chiudi(){var d=$('#dlg');if(d.close)d.close();else d.removeAttribute('open');}
function salvando(p){var b=$('#dlg-si');b.disabled=true;$('#dlg-m').textContent='';
  return p.then(function(r){b.disabled=false;if(r&&r.esito==='ok'){chiudi();return ricarica().then(function(){return r;});}$('#dlg-m').textContent=errore(r);return null;});}

function misura(v,m){
  if(D.chiuso){avviso('Il cantiere è chiuso.');return;}
  m=m||{};var oggi=D.oggi;var dims=m.pu!=null||m.l!=null||m.w!=null||m.h!=null;
  var c='<p class="nota" style="margin:0">'+es(v.dl||v.d)+'<br>Prezzo '+eur(v.p)+' € / '+es(v.u)+' · contratto '+qt(v.qc)+' · a oggi '+qt(v.qt)+(v.pct!=null?' ('+pc(v.pct)+')':'')+'</p>'+
    '<label>Giorno<input type="date" id="m-data" max="'+es(oggi)+'" value="'+es(m.data||oggi)+'"></label>';
  if(v.perc&&Number(v.qc)>0){var att=Number(v.qc)>0?(Number(v.qt)||0)/Number(v.qc)*100:0;
    c+='<label>Avanzamento della voce a oggi <small>(in %, ora '+pc(att)+')</small><input type="text" id="m-pct" inputmode="decimal" placeholder="es. 40"></label>'+
      '<p class="nota" style="margin:0">Si registra solo la differenza rispetto a quanto già misurato.</p>';}
  else{c+='<div class="scelte"><label><input type="radio" name="m-modo" value="q"'+(dims?'':' checked')+'> Scrivo la quantità</label><label><input type="radio" name="m-modo" value="d"'+(dims?' checked':'')+'> Scrivo le misure (la quantità si calcola)</label></div>'+
      '<label id="m-lq"'+(dims?' hidden':'')+'>Quantità <small>('+es(v.u)+')</small><input type="text" id="m-q" inputmode="decimal" value="'+(m.q!=null&&!dims?es(String(Math.abs(m.q)).replace('.',',')):'')+'"></label>'+
      '<div id="m-ld"'+(dims?'':' hidden')+'><div class="dims"><label>Parti uguali<input type="text" id="m-pu" inputmode="decimal" value="'+(m.pu!=null?es(String(m.pu).replace('.',',')):'')+'"></label>'+
      '<label>Lunghezza<input type="text" id="m-l" inputmode="decimal" value="'+(m.l!=null?es(String(m.l).replace('.',',')):'')+'"></label>'+
      '<label>Larghezza<input type="text" id="m-w" inputmode="decimal" value="'+(m.w!=null?es(String(m.w).replace('.',',')):'')+'"></label>'+
      '<label>H / peso<input type="text" id="m-h" inputmode="decimal" value="'+(m.h!=null?es(String(m.h).replace('.',',')):'')+'"></label></div><p class="calc" id="m-calc"></p></div>'+
      '<label><input type="checkbox" id="m-meno"'+(Number(m.q)<0?' checked':'')+'> Misura in meno <small>(toglie quantità già misurate: scrivi il motivo)</small></label>';}
  c+='<label>Luogo <small>(facoltativo)</small><input type="text" id="m-luogo" maxlength="160" placeholder="es. plinti asse B, piano terra" value="'+es(m.luogo||'')+'"></label>'+
    '<label>Descrizione o motivo <small>(obbligatorio per una misura in meno)</small><input type="text" id="m-descr" maxlength="300" value="'+es(m.descrizione||'')+'"></label>'+
    '<label>Scritta da <small>(nome e cognome)</small><input type="text" id="m-autore" maxlength="120" autocomplete="name" value="'+es(ls('sal_autore'))+'"></label>';
  finestra((m.id?'Modifica misura · ':'Nuova misura · ')+v.nr+' '+v.d,v.oltre?'Attenzione: questa voce è già oltre il computo.':'',c,'Salva la misura',function(){
    var d={voce_id:v.id,data:$('#m-data').value,luogo:$('#m-luogo').value,descrizione:$('#m-descr').value,autore:$('#m-autore').value};
    if(m.id)d.id=m.id;ls('sal_autore',d.autore);
    if($('#m-pct')){d.pct=$('#m-pct').value;}
    else if(document.querySelector('input[name=m-modo]:checked').value==='d'){d.pu=$('#m-pu').value;d.l=$('#m-l').value;d.w=$('#m-w').value;d.h=$('#m-h').value;d.meno=$('#m-meno').checked;}
    else{d.q=$('#m-q').value;d.meno=$('#m-meno').checked;}
    return salvando(api('misura',{dati:d})).then(function(r){if(r)avviso('Misura salvata: '+qt(r.quantita)+' '+v.u);});});
  var ri=function(){var a=['m-pu','m-l','m-w','m-h'].map(function(i){var x=$('#'+i);return x?nu(x.value):null;});var t=1,uno=false;a.forEach(function(x){if(x!==null&&!isNaN(x)){t*=x;uno=true;}});
    var el=$('#m-calc');if(el)el.textContent=uno?'Quantità: '+qt(Math.round(t*100)/100)+' '+v.u:'';};
  ['m-pu','m-l','m-w','m-h'].forEach(function(i){var x=$('#'+i);if(x)x.addEventListener('input',ri);});ri();
  [].forEach.call(document.querySelectorAll('input[name=m-modo]'),function(r){r.addEventListener('change',function(){var d=this.value==='d';$('#m-lq').hidden=d;$('#m-ld').hidden=!d;});});
}

// ---------------- SAL
function statoSal(s){return {emesso:['Emesso','em'],firmato_impresa:['Firmato dall’impresa','fi'],visto_dl:['Visto dalla DL','ok'],sostituito:['Sostituito','no'],annullato:['Annullato','no']}[s]||[s,'no'];}
function contoHtml(co){if(!co)return '';var tr=co.traguardo&&co.traguardo.modo==='percentuale'?co.traguardo:null;
  var r=function(t,v,cl,sub){return '<tr'+(cl?' class="'+cl+'"':'')+'><td>'+t+(sub?' <span class="sub">'+sub+'</span>':'')+'</td><td class="n">'+eur(v)+' €</td></tr>';};
  var h='<table class="conto">';
  if(tr){h+=r('Traguardo «'+es(tr.nome)+'»: '+pc(tr.percentuale)+' del contratto',Number(co.netto)-Number(co.altre_voci),'','in tutto '+pc(tr.cumulata)+' di '+eur(co.base_contratto)+' €');
    h+=r('Per informazione: lavori misurati a oggi',co.lavori,'','');}
  else{h+=r('Lavori a misura a oggi',co.lavori_misura);if(Number(co.lavori_corpo))h+=r('Lavori a corpo a oggi',co.lavori_corpo);
    h+=r('Totale lavori a oggi',co.lavori,'tot','di cui in questo periodo '+eur(co.lavori_periodo)+' €');
    h+=r('− Ribasso '+pc(co.ribasso_pct),co.ribasso);
    h+=r('+ Oneri della sicurezza',co.sicurezza,'',co.sicurezza_modo==='nei_prezzi'?'compresi nei prezzi':co.sicurezza_modo==='voci'?'nelle voci non ribassabili':'in proporzione ai lavori');}
  if(Number(co.altre_voci))h+=r('+ Altre voci a oggi (economie e noli)',co.altre_voci,'',Number(co.altre_voci_sal)?'di cui in questo SAL '+eur(co.altre_voci_sal)+' €':'');
  h+=r('= Lavori netti a oggi',co.netto,'tot')+r('− Ritenuta a garanzia '+pc(co.ritenuta_pct),co.ritenuta);
  if(Number(co.anticipazione))h+=r('− Recupero dell’anticipazione',co.recupero,'','anticipazione '+eur(co.anticipazione)+' €');
  h+=r('= Spettanza a oggi',co.spettanza,'tot')+r('− SAL già emessi',co.precedenti);
  h+='<tr class="fin"><td>Importo di questo SAL</td><td class="n">'+eur(co.dovuto)+' € + IVA</td></tr></table>';
  return h;}
function salTab(){
  if(!K||!CL||!(CL.voci||[]).length)return '<div class="pann"><h2>Prima serve il computo</h2><p>Apri la scheda «Computo».</p></div>';
  var h='',b=D.bozza,xl=C.u+'/excel?t='+C.t+'&c='+C.c;
  if(b){var trs=D.traguardi||[];
    h+='<div class="pann"><h2>SAL n. '+b.numero+(b.versione>1?' (versione '+b.versione+')':'')+' — bozza</h2>'+
      (b.versione>1&&b.motivo?'<p class="avviso">Nuova versione: '+es(b.motivo)+'</p>':'')+
      '<div class="campi"><label>Lavori dal<input type="date" value="'+es(b.periodo_da)+'" disabled></label><label>Lavori fino al<input type="date" id="b-a" min="'+es(b.periodo_da)+'" max="'+es(D.oggi)+'" value="'+es(b.periodo_a)+'"'+(D.chiuso?' disabled':'')+'></label>'+
      (trs.length?'<label>Traguardo<select id="b-tg"'+(D.chiuso?' disabled':'')+'><option value="">nessuno</option>'+trs.filter(function(t){return !t.sal;}).map(function(t){return '<option value="'+t.id+'"'+(String(b.traguardo_id)===String(t.id)?' selected':'')+'>'+es(t.nome)+(t.modo==='percentuale'?' ('+pc(t.percentuale)+' del contratto)':'')+'</option>';}).join('')+'</select></label>':'')+'</div>'+
      (CL.misure_dopo?'<p class="nota">'+CL.misure_dopo+(CL.misure_dopo===1?' misura è':' misure sono')+' dopo il '+di(b.periodo_a)+': entreranno nel SAL successivo.</p>':'')+
      '<h3>Conto</h3>'+contoHtml(CO)+
      '<h3>Altre voci di questo SAL <small>(economie e noli, prezzo già netto)</small></h3><div id="b-av">'+(b.altre_voci||[]).map(rigaAv).join('')+'</div>'+
      (D.chiuso?'':'<button type="button" class="b" id="b-av-agg">+ Aggiungi una riga</button>')+
      '<label style="margin-top:10px">Note del SAL <small>(facoltative, vanno nel documento)</small><textarea id="b-note" maxlength="1000"'+(D.chiuso?' disabled':'')+'>'+es(b.note||'')+'</textarea></label>'+
      '<div class="riga-b">'+(D.chiuso?'':'<button type="button" class="b" id="b-salva">Salva la bozza</button>')+
      '<a class="b" href="'+es(C.u+'/documento?t='+C.t+'&id='+b.id)+'" target="_blank" rel="noopener">Anteprima del documento</a>'+
      '<a class="b ex" href="'+es(xl)+'">Scarica in Excel</a>'+
      (D.chiuso?'':'<button type="button" class="b pr" id="b-emetti">Emetti il SAL n. '+b.numero+'</button><button type="button" class="b ro" id="b-scarta">Scarta la bozza</button>')+'</div></div>';}
  else{var p=D.prossimo||{};
    h+='<div class="pann"><h2>Prossimo SAL: n. '+es(p.numero)+(p.versione>1?' (versione '+p.versione+')':'')+'</h2><p>Lavori dal '+di(p.periodo_da)+' al '+di(p.periodo_a)+' (si può cambiare nella bozza). '+
      'Con «Prepara» TIX mette nel SAL tutte le misure confermate fino a quel giorno.</p><h3>Situazione a oggi</h3>'+contoHtml(CO)+
      '<div class="riga-b">'+(D.chiuso?'':'<button type="button" class="b pr" id="b-nuova">Prepara il SAL n. '+es(p.numero)+'</button>')+'<a class="b ex" href="'+es(xl)+'">Scarica in Excel (situazione a oggi)</a></div></div>';}
  var wa=D.whatsapp||[];
  if(wa.length)h+='<div class="pann"><h2>Dal cantiere, sezione SAL di WhatsApp</h2><p class="nota" style="margin-top:0">Promemoria: messaggi arrivati dopo l’ultimo SAL. Non entrano nel conto da soli.</p>'+
    wa.map(function(w){return '<div class="wa">'+es(w.testo)+'<br><small>'+es(w.il)+'</small></div>';}).join('')+'</div>';
  var el=D.sal||[];
  h+='<div class="pann"><h2>SAL emessi</h2>';
  if(!el.length)h+='<p class="nota" style="margin:0">Ancora nessuno.</p>';
  else{var ultimo=null;el.forEach(function(s){if(['emesso','firmato_impresa','visto_dl'].indexOf(s.stato)>=0&&(!ultimo||s.numero>ultimo.numero))ultimo=s;});
    h+='<div class="sal-el">';el.forEach(function(s){var st=statoSal(s.stato),vivo=['emesso','firmato_impresa','visto_dl'].indexOf(s.stato)>=0;
      h+='<div class="sal-c"><div class="r1"><b>SAL n. '+s.numero+(s.versione>1?' (v. '+s.versione+')':'')+'</b><span class="st '+st[1]+'">'+es(st[0])+'</span>'+
        '<span>lavori dal '+di(s.periodo_da)+' al '+di(s.periodo_a)+'</span><span class="imp" style="margin-left:auto">'+eur(s.dovuto)+' € + IVA</span></div>'+
        '<p class="nota" style="margin:6px 0">Emesso il '+es(s.emesso_il||'')+' da '+es(s.emesso_da||'')+(s.firma_impresa?' · firmato da '+es(s.firma_impresa)+' il '+es(s.firma_impresa_il):'')+
        (s.firma_dl?' · visto DL: '+es(s.firma_dl)+' il '+es(s.firma_dl_il)+(s.firma_dl_nota?' («'+es(s.firma_dl_nota)+'»)':''):'')+
        (s.motivo&&!vivo?' · '+es(s.motivo):'')+'</p><div class="riga-b">'+
        '<a class="b" href="'+es(C.u+'/documento?t='+C.t+'&id='+s.id)+'" target="_blank" rel="noopener">Documento</a>'+
        '<a class="b ex" href="'+es(xl+'&id='+s.id)+'">Excel</a>'+
        (!D.chiuso&&s.stato==='emesso'?'<button type="button" class="b" data-st="firmato" data-id="'+s.id+'" data-n="'+s.numero+'">Segna firmato dall’impresa</button>':'')+
        (!D.chiuso&&(s.stato==='emesso'||s.stato==='firmato_impresa')?'<button type="button" class="b" data-st="visto" data-id="'+s.id+'" data-n="'+s.numero+'">Segna visto dalla DL</button>':'')+
        (!D.chiuso&&ultimo&&ultimo.id===s.id&&s.stato!=='visto_dl'?'<button type="button" class="b" data-st="riemetti" data-id="'+s.id+'" data-n="'+s.numero+'">Riemetti con correzioni</button><button type="button" class="b ro" data-st="annulla" data-id="'+s.id+'" data-n="'+s.numero+'">Annulla</button>':'')+
        '</div></div>';});h+='</div>';}
  return h+'</div>';}
function rigaAv(a){a=a||{};var dis=D.chiuso?' disabled':'';
  return '<div class="av-r"><label>Tipo<select class="a-t"'+dis+'>'+[['economia','Economia'],['nolo','Nolo'],['altro','Altro']].map(function(o){return '<option value="'+o[0]+'"'+(a.tipo===o[0]?' selected':'')+'>'+o[1]+'</option>';}).join('')+'</select></label>'+
    '<label>Descrizione<input type="text" class="a-d" maxlength="300" value="'+es(a.descrizione||'')+'"'+dis+'></label><label>U.M.<input type="text" class="a-u" maxlength="20" value="'+es(a.unita||'')+'"'+dis+'></label>'+
    '<label>Quantità<input type="text" class="a-q" inputmode="decimal" value="'+(a.quantita!=null?es(String(a.quantita).replace('.',',')):'')+'"'+dis+'></label>'+
    '<label>Prezzo €<input type="text" class="a-p" inputmode="decimal" value="'+(a.prezzo!=null?es(String(a.prezzo).replace('.',',')):'')+'"'+dis+'></label>'+
    (D.chiuso?'':'<button type="button" class="b ro x" data-avx="1" aria-label="Togli la riga">×</button>')+'</div>';}
function datiBozza(){var d={periodo_a:$('#b-a').value,note:$('#b-note').value,altre_voci:[]};var tg=$('#b-tg');if(tg)d.traguardo_id=tg.value;
  [].forEach.call(document.querySelectorAll('#b-av .av-r'),function(r){var x={tipo:$('.a-t',r).value,descrizione:$('.a-d',r).value,unita:$('.a-u',r).value,quantita:$('.a-q',r).value,prezzo:$('.a-p',r).value};
    if(x.descrizione||x.quantita||x.prezzo)d.altre_voci.push(x);});return d;}
function salvaBozza(){return api('bozza',{dati:datiBozza()}).then(function(r){if(r&&r.esito==='ok'){avviso('Bozza salvata.');return ricarica().then(function(){return true;});}avviso(errore(r));return false;});}

// ---------------- contratto
function contratto(){
  var k=K||{},bl=k.bloccato,dis=(bl||D.chiuso)?' disabled':'',d2=D.chiuso?' disabled':'';
  var sel=function(id,v,ops,d){return '<select id="'+id+'"'+(d||'')+'>'+ops.map(function(o){return '<option value="'+o[0]+'"'+(String(v||'')===o[0]?' selected':'')+'>'+o[1]+'</option>';}).join('')+'</select>';};
  var n=function(x){return x===null||x===undefined?'':String(x).replace('.',',');};
  var h='<div class="pann"><h2>Scheda contratto</h2>'+(bl?'<p class="avviso">Ci sono già SAL emessi: importo, ribasso, sicurezza, ritenuta e anticipazione restano quelli. Si possono cambiare regola dei SAL, traguardi, date e note.</p>':'')+
    '<div class="campi"><label>Tipo di contratto'+sel('c-tipo',k.tipo_contratto,[['','—'],['a_misura','a misura'],['a_corpo','a corpo'],['misto','a corpo e a misura']],d2)+'</label>'+
    '<label>Importo del contratto <small>(€)</small><input type="text" id="c-imp" inputmode="decimal" value="'+n(k.importo_contratto)+'"'+dis+'></label>'+
    '<label>Ribasso <small>(%)</small><input type="text" id="c-rib" inputmode="decimal" value="'+n(k.ribasso_pct)+'"'+dis+'></label>'+
    '<label>Ritenuta a garanzia <small>(%)</small><input type="text" id="c-rit" inputmode="decimal" value="'+n(k.ritenuta_pct)+'"'+dis+'></label>'+
    '<label>Anticipazione <small>(%)</small><input type="text" id="c-ant" inputmode="decimal" value="'+n(k.anticipazione_pct)+'"'+dis+'></label>'+
    '<label>Oneri della sicurezza <small>(€, mai ribassati)</small><input type="text" id="c-sic" inputmode="decimal" value="'+n(k.oneri_sicurezza)+'"'+dis+'></label>'+
    '<label>Come si pagano gli oneri'+sel('c-smodo',k.sicurezza_modo||'nei_prezzi',[['nei_prezzi','già compresi nei prezzi (non si aggiungono)'],['proporzionale','in proporzione ai lavori fatti'],['voci','con voci del computo non ribassabili']],dis)+'</label>'+
    '<label>Data del contratto<input type="date" id="c-dc" value="'+es(k.data_contratto||'')+'"'+d2+'></label>'+
    '<label>Termine dei lavori<input type="date" id="c-tu" value="'+es(k.termine_ultimazione||'')+'"'+d2+'></label></div>'+
    '<h3>Regola dei SAL</h3><div class="scelte">'+
    [['mensile','Mensile: un SAL per ogni mese di lavori'],['soglia','A soglia d’importo: un SAL ogni volta che i lavori superano una cifra'],['traguardi','A traguardi: un SAL quando si finisce una parte dell’opera'],['fine_lavori','Unico a fine lavori']]
      .map(function(o){return '<label><input type="radio" name="c-cad" value="'+o[0]+'"'+(k.cadenza_sal===o[0]?' checked':'')+d2+'> '+o[1]+'</label>';}).join('')+'</div>'+
    '<label id="c-l-soglia"'+(k.cadenza_sal==='soglia'?'':' hidden')+'>Soglia <small>(€ di lavori non ancora contabilizzati)</small><input type="text" id="c-soglia" inputmode="decimal" value="'+n(k.soglia_sal_importo)+'"'+d2+'></label>'+
    '<div id="c-trag"'+((k.cadenza_sal==='traguardi'||(D.traguardi||[]).length)?'':' hidden')+'><h3>Traguardi</h3><p class="nota" style="margin-top:0">«A misura»: il SAL conta le quantità fatte. «% del contratto»: il SAL vale una quota fissa del contratto (es. 20% a fine strutture).</p><div id="c-tg">'+
    (D.traguardi||[]).map(rigaTg).join('')+'</div>'+(D.chiuso?'':'<button type="button" class="b" id="c-tg-agg">+ Aggiungi un traguardo</button>')+'</div>'+
    '<h3>Differenza tra computo e contratto</h3><p class="nota" style="margin-top:0">'+diff()+'</p>'+
    '<label>Nota sulla differenza <small>(es. «oneri e lavori in economia previsti a parte»)</small><textarea id="c-nota" maxlength="600"'+d2+'>'+es(k.nota_differenza||'')+'</textarea></label>'+
    '<p class="msg" id="c-msg" style="margin:8px 0 0"></p><div class="riga-b">'+(D.chiuso?'':'<button type="button" class="b pr" id="c-salva">Salva la scheda contratto</button>')+'</div></div>';
  return h;}
function rigaTg(t){t=t||{};var usato=!!t.sal,d=D.chiuso?' disabled':'',du=(usato||D.chiuso)?' disabled':'';
  return '<div class="tg" data-id="'+es(t.id||'')+'"><label>Nome<input type="text" class="t-n" maxlength="120" placeholder="es. fine strutture" value="'+es(t.nome||'')+'"'+d+'></label>'+
    '<label>Come si calcola<select class="t-m"'+du+'><option value="misura"'+(t.modo!=='percentuale'?' selected':'')+'>a misura</option><option value="percentuale"'+(t.modo==='percentuale'?' selected':'')+'>% del contratto</option></select></label>'+
    '<label>%<input type="text" class="t-p" inputmode="decimal" value="'+(t.percentuale!=null?es(String(t.percentuale).replace('.',',')):'')+'"'+du+'></label>'+
    '<label>Prevista<input type="date" class="t-dp" value="'+es(t.data_prevista||'')+'"'+d+'></label><label>Raggiunta il<input type="date" class="t-r" max="'+es(D.oggi)+'" value="'+es(t.raggiunto_il||'')+'"'+d+'></label>'+
    (usato?'<span class="st ok x">SAL n. '+t.sal+'</span>':(D.chiuso?'':'<button type="button" class="b ro x" data-tgx="1" aria-label="Togli il traguardo">×</button>'))+'</div>';}
function diff(){var k=K||{},s=CO?Number(CO.importo_computo):Number(k.importo_computo||0),ct=Number(k.importo_contratto||0);
  if(!ct)return 'Scrivi l’importo del contratto per confrontarlo con la somma del computo.';
  var d=Math.round((ct-s)*100)/100;if(Math.abs(d)<0.01)return '<span class="ok-v">Le somme tornano:</span> computo e contratto valgono entrambi '+eur(ct)+' €.';
  return '<span class="ko-v">Differenza di '+eur(d)+' € ('+pc(s?d/s*100:0)+')</span>: computo '+eur(s)+' €, contratto '+eur(ct)+' €. Non blocca niente, ma conviene scrivere da cosa dipende.';}
function legaContratto(){
  [].forEach.call(document.querySelectorAll('input[name=c-cad]'),function(r){r.addEventListener('change',function(){$('#c-l-soglia').hidden=this.value!=='soglia';if(this.value==='traguardi')$('#c-trag').hidden=false;});});}
function salvaContratto(){var d={tipo_contratto:$('#c-tipo').value,importo_contratto:$('#c-imp').value,ribasso_pct:$('#c-rib').value,ritenuta_pct:$('#c-rit').value,anticipazione_pct:$('#c-ant').value,
  oneri_sicurezza:$('#c-sic').value,sicurezza_modo:$('#c-smodo').value,data_contratto:$('#c-dc').value,termine_ultimazione:$('#c-tu').value,nota_differenza:$('#c-nota').value,
  cadenza_sal:(document.querySelector('input[name=c-cad]:checked')||{}).value||'',soglia_sal_importo:$('#c-soglia').value,traguardi:[]};
  [].forEach.call(document.querySelectorAll('#c-tg .tg'),function(r){var t={id:r.getAttribute('data-id'),nome:$('.t-n',r).value,modo:$('.t-m',r).value,percentuale:$('.t-p',r).value,data_prevista:$('.t-dp',r).value,raggiunto_il:$('.t-r',r).value};
    if(t.nome||t.percentuale)d.traguardi.push(t);});
  var b=$('#c-salva');b.disabled=true;$('#c-msg').textContent='';
  api('contratto',{dati:d}).then(function(r){b.disabled=false;if(r&&r.esito==='ok'){avviso('Scheda contratto salvata.');ricarica();}else $('#c-msg').textContent=errore(r);});}

// ---------------- computo
function computo(){var k=K,senza=!k||!Number(k.voci_n);
  var h=caricaHtml(senza);
  if(senza)return h+(D.chiuso?'':'<p class="nota">Intanto puoi compilare la scheda «Contratto».</p>');
  h+='<div class="pann"><h2>Computo metrico · versione '+es(k.versione)+'</h2><p class="nota" style="margin-top:0">'+es(k.fonte||'')+(k.file_nome?' · file '+es(k.file_nome):'')+'</p>'+
    '<div class="s-cifre"><div class="s-cifra"><small>Voci</small><b>'+es(k.voci_n)+'</b></div><div class="s-cifra"><small>Capitoli</small><b>'+es(k.capitoli_n)+'</b></div><div class="s-cifra"><small>Righe di misura</small><b>'+es(k.righe_n)+'</b></div></div>'+
    '<h3>Controllo delle somme</h3><table class="conto"><tr><td>Somma del computo (voci comprese)</td><td class="n">'+eur(CO&&CO.importo_computo)+' €</td></tr>'+
    '<tr><td>Importo del contratto</td><td class="n">'+eur(k.importo_contratto)+(k.importo_contratto!=null?' €':'')+'</td></tr></table><p>'+diff()+'</p>'+
    (k.nota_differenza?'<p class="nota">Nota: '+es(k.nota_differenza)+'</p>':'')+
    '<p>'+(!Number(k.righe_n)?'<span class="sub">Il file non aveva le righe di misura: si controllano i totali delle voci.</span>':Number(k.scarti)===0?'<span class="ok-v">Righe di misura e quantità tornano voce per voce.</span>':'<span class="ko-v">'+es(k.scarti)+' voci hanno righe di misura che non tornano con la quantità.</span>')+'</p>';
  if(CL&&CL.capitoli&&CL.capitoli.length){h+='<h3>Capitoli</h3><table class="conto">';var tot=Number(CO.importo_computo)||0;
    CL.capitoli.forEach(function(c){h+='<tr><td>'+es(c.n)+'</td><td class="n">'+eur(c.ic)+' €</td><td class="n sub">'+pc(tot?Number(c.ic)/tot*100:0)+'</td></tr>';});h+='</table>';}
  if(k.versioni&&k.versioni.length>1)h+='<h3>Versioni</h3><p class="nota" style="margin-top:0">'+k.versioni.map(function(v){return 'v. '+v.versione+' ('+v.stato+', '+v.creato_il+')';}).join(' · ')+'. Una variante diventa sempre una versione nuova: le vecchie restano.</p>';
  h+='</div>';
  return h;}

// ---------------- caricamento del computo: file → lettura → anteprima → Conferma / Annulla
function caricaHtml(senza){
  if(D.chiuso)return senza?'<div class="pann"><h2>Computo metrico</h2><p>Il cantiere non ha un computo.</p></div>':'';
  if(D.carica_attivo===false)return senza?'<div class="pann"><h2>Computo metrico</h2><p>Il caricamento del computo è sospeso in questo momento: riprova più tardi.</p></div>':'';
  if(K&&K.bloccato)return '<div class="pann"><p class="nota" style="margin:0">Ci sono già SAL emessi: il computo non si sostituisce più. Le varianti, con il confronto tra le versioni, arrivano a breve.</p></div>';
  var h='<div class="pann k-car"><h2>'+(senza?'Carica il computo metrico':'Carica un computo aggiornato')+'</h2>',s=IMP?IMP.stato:'';
  if(!IMP||['errore','annullato','confermato','scaduto','errore_locale'].indexOf(s)>=0){
    h+='<p>'+(senza?'Carica il computo in Excel o in PDF, anche esportato da PriMus. TIX legge voci, quantità e prezzi e ti mostra il controllo delle somme: nulla cambia finché non premi «Conferma».'
        :'Il file nuovo diventa la versione '+(Number(K.versione)+1)+' del computo e la versione '+es(K.versione)+' resta in archivio. Prima di confermare vedi l’anteprima con il controllo delle somme.')+'</p>'+
      '<div class="riga-b" style="margin:0"><label class="b pr" for="k-file">Scegli il file del computo</label></div>'+
      '<input type="file" id="k-file" accept=".xlsx,.xlsm,.xls,.ods,.csv,.pdf,.dcf" hidden>'+
      '<p class="nota" style="margin-bottom:0">Excel (.xlsx, .xls) o PDF, fino a 18 MB. Da PriMus: esporta il computo in Excel oppure stampalo in PDF (il file .dcf si apre solo con PriMus). Un PDF scansionato non si legge.</p>';
    if(s==='errore')h+='<div class="k-err">Non sono riuscito a leggere «'+es(IMP.nome_file||'il file')+'»: '+es(IMP.errore||'errore sconosciuto')+'.</div>';
    if(s==='errore_locale')h+='<div class="k-err">'+es(IMP.msg)+'</div>';
  } else if(s==='invio'||s==='ricevuto'||s==='in_lettura'){
    h+='<p class="k-att"><span class="giro" aria-hidden="true"></span>'+(s==='invio'?'Invio di «'+es(IMP.nome_file)+'»…':'Sto leggendo «'+es(IMP.nome_file||'il file')+'»: di solito ci vuole meno di un minuto.')+'</p>';
  } else if(s==='pronto')h+=anteprima(IMP);
  return h+'</div>';}
function anteprima(r){
  var rp=r.riepilogo||{},cn=rp.conteggi||{},b=r.blocchi||{},vv=r.voci||[],tf=rp.totale_file,so=Number(rp.somma)||0,hatf=tf!==null&&tf!==undefined&&tf!=='';
  var h='<p style="margin:0 0 8px"><b>Anteprima di «'+es(r.nome_file||'')+'»</b> · '+(r.modo==='ai'?'letto con l’intelligenza artificiale: controlla bene':'letto dal file')+'</p>'+
    '<div class="s-cifre"><div class="s-cifra"><small>Voci</small><b>'+es(cn.voci!=null?cn.voci:vv.length)+'</b><span>'+(Number(cn.righe)?es(cn.righe)+' righe di misura':'senza righe di misura')+'</span></div>'+
    '<div class="s-cifra"><small>Capitoli</small><b>'+es((r.capitoli||[]).length)+'</b></div>'+
    '<div class="s-cifra"><small>Somma delle voci</small><b>'+eur(so)+' €</b><span>'+(hatf?'nel file: '+eur(tf)+' €':'totale non scritto nel file')+'</span></div></div>';
  if(hatf){var d=Math.round((Number(tf)-so)*100)/100;h+='<p>'+(Math.abs(d)<=0.05?'<span class="ok-v">Le somme tornano con il totale scritto nel file.</span>':'<span class="ko-v">La somma delle voci è diversa dal totale del file di '+eur(Math.abs(d))+' €.</span>')+'</p>';}
  if((r.avvisi||[]).length)h+='<ul class="k-avv">'+r.avvisi.map(function(a){return '<li>'+es(a)+'</li>';}).join('')+'</ul>';
  var stop='';
  if(b.sal_emessi)stop='Ci sono già SAL emessi: il computo non si sostituisce più.';
  else if(b.bozza)stop='C’è una bozza del SAL aperta: scartala (scheda «SAL») prima di cambiare computo.';
  else if((b.misure_senza_voce||[]).length)stop='Le voci n. '+b.misure_senza_voce.join(', ')+' hanno già delle misure ma nel file nuovo non ci sono con lo stesso numero e la stessa unità: togli quelle misure oppure correggi il file.';
  if(b.attuale)h+='<p class="nota">Con «Conferma» diventa la versione '+(Number(b.attuale.versione)+1)+' del computo. La versione '+es(b.attuale.versione)+' ('+es(b.attuale.voci)+' voci) resta in archivio'+
    (Number(b.misure)?'; le '+es(b.misure)+' misure già scritte passano alle voci con lo stesso numero':'')+'. Dati del contratto, regola dei SAL e traguardi restano quelli di oggi.</p>';
  var righe=impTutte?vv:vv.slice(0,40);
  h+='<table class="av"><thead><tr><th class="t">N.</th><th class="t">Tariffa</th><th class="t">Descrizione</th><th class="t">U.M.</th><th>Quantità</th><th>Prezzo</th><th>Importo</th></tr></thead><tbody>'+
    righe.map(function(x){var np=x[5]===null||x[5]===undefined,imp=np?null:Math.round(Number(x[4])*Number(x[5])*100)/100;
      return '<tr class="v kv'+(x[7]?' alt':'')+'"><td class="t" data-l="N.">'+es(x[0])+'</td><td class="t" data-l="Tariffa">'+es(x[1]||'')+'</td><td class="t"><span class="vd">'+es(x[2]||'')+'</span>'+
        (x[7]?'<span class="vs">voce alternativa: non entra nella somma</span>':'')+'</td><td class="t" data-l="U.M.">'+es(x[3]||'')+'</td><td data-l="Quantità">'+qt(x[4])+'</td>'+
        '<td data-l="Prezzo">'+(np?'—':eur(x[5]))+'</td><td data-l="Importo">'+(imp===null?'—':eur(imp))+'</td></tr>';}).join('')+'</tbody></table>';
  if(!impTutte&&vv.length>40)h+='<div class="riga-b"><button type="button" class="b" id="k-tutte">Mostra tutte le '+vv.length+' voci</button></div>';
  if(stop)h+='<div class="k-err">'+es(stop)+'</div>';
  h+='<div class="campi" style="margin-top:12px"><label>Chi conferma <small>(nome e cognome)</small><input type="text" id="k-chi" maxlength="120" autocomplete="name" value="'+es(ls('sal_autore'))+'"></label></div>'+
    '<div class="riga-b">'+(stop?'':'<button type="button" class="b pr" id="k-conferma">Conferma il computo</button>')+'<button type="button" class="b ro" id="k-annulla">Annulla</button></div>';
  return h;}
function impMostra(){if(scheda==='computo')corpo();}
function impSegui(){clearTimeout(impTimer);if(!impId)return;
  api('computo_stato',{id:impId}).then(function(r){
    if(!r||r.esito!=='ok'){if(r&&r.esito==='sconosciuto'){IMP=null;impId=null;impMostra();return;}if(++impGiri<120)impTimer=setTimeout(impSegui,4000);return;}
    IMP=r;impMostra();
    if((r.stato==='ricevuto'||r.stato==='in_lettura')&&++impGiri<150)impTimer=setTimeout(impSegui,2500);});}
function impCarica(f){
  if(!f)return;
  if(f.size>18*1024*1024){IMP={stato:'errore_locale',msg:'Il file è troppo grande (massimo 18 MB).'};impMostra();return;}
  clearTimeout(impTimer);IMP={stato:'invio',nome_file:f.name};impTutte=false;impMostra();
  fetch(C.u+'/computo/carica?t='+encodeURIComponent(C.t)+'&c='+encodeURIComponent(C.c)+'&nome='+encodeURIComponent(f.name),{method:'POST',headers:{'Content-Type':f.type||'application/octet-stream'},body:f})
    .then(function(r){return r.json();}).catch(function(){return {esito:'incerto'};})
    .then(function(r){if(r&&r.esito==='ok'){impId=r.id;impGiri=0;IMP={stato:'ricevuto',nome_file:f.name};impMostra();impTimer=setTimeout(impSegui,2000);}
      else{IMP={stato:'errore_locale',msg:(r&&r.messaggio)||errore(r)};impMostra();}});}
document.addEventListener('change',function(ev){if(ev.target.id!=='k-file')return;var f=ev.target.files&&ev.target.files[0];ev.target.value='';impCarica(f);});

// ---------------- eventi
document.addEventListener('click',function(ev){var t=ev.target.closest?ev.target.closest('button,a,tr'):null;if(!t)return;
  if(t.matches('.sal-tab button')){scheda=t.getAttribute('data-s');ls('sal_scheda',scheda);schede();corpo();return;}
  if(t.hasAttribute('data-vai')){ev.preventDefault();scheda=t.getAttribute('data-vai');schede();corpo();return;}
  if(t.hasAttribute('data-f')){filtro=t.getAttribute('data-f');corpo();return;}
  if(t.matches('tr.cap')){var o=t.getAttribute('data-cap');chiusi[o]=!chiusi[o];corpo();return;}
  if(t.matches('tr.v')){var v=voce(t.getAttribute('data-v'));if(v)misura(v);return;}
  if(t.hasAttribute('data-mod')){var id=t.getAttribute('data-mod'),m=(D.misure||[]).filter(function(x){return x.id===id;})[0];if(m){var vv=voce(m.voce_id);if(vv)misura(vv,m);}return;}
  if(t.hasAttribute('data-togli')){var idt=t.getAttribute('data-togli');
    finestra('Togliere la misura?','La misura non entra nel SAL; resta nello storico come tolta, con il motivo.','<label>Motivo <small>(facoltativo)</small><input type="text" id="t-mot" maxlength="300" placeholder="es. inserita due volte"></label>','Togli la misura',
      function(){return salvando(api('misura_togli',{id:idt,dati:{motivo:$('#t-mot').value}})).then(function(r){if(r)avviso('Misura tolta.');});},true);return;}
  if(t.id==='dlg-no'){chiudi();return;}
  if(t.id==='b-nuova'){t.disabled=true;api('bozza',{dati:{}}).then(function(r){if(r&&r.esito==='ok'){avviso('Bozza del SAL pronta.');ricarica();}else{t.disabled=false;avviso(errore(r));}});return;}
  if(t.id==='b-salva'){salvaBozza();return;}
  if(t.id==='b-av-agg'){$('#b-av').insertAdjacentHTML('beforeend',rigaAv({}));return;}
  if(t.hasAttribute('data-avx')){t.parentNode.parentNode.removeChild(t.parentNode);return;}
  if(t.id==='b-scarta'){var b0=D.bozza;finestra('Scartare la bozza del SAL n. '+b0.numero+'?','Le misure restano: torneranno nella prossima bozza. Si perdono solo le altre voci e le note di questa bozza.','','Scarta la bozza',
      function(){return salvando(api('stato',{id:b0.id,dati:{azione:'scarta'}})).then(function(r){if(r)avviso('Bozza scartata.');});},true);return;}
  if(t.id==='b-emetti'){var b1=D.bozza;salvaBozza().then(function(ok){if(!ok)return;var co=CO||{};
      finestra('Emettere il SAL n. '+b1.numero+'?','Importo: '+eur(co.dovuto)+' € + IVA · lavori fino al '+di(D.bozza.periodo_a),
        '<p class="nota" style="margin:0">Con l’emissione il SAL riceve l’impronta SHA-256 e non si modifica più. Se la DL chiede correzioni prima del visto, si riemette come versione 2; dopo il visto le correzioni vanno nel SAL successivo. TIX non manda niente a nessuno: il documento lo consegni tu.</p>'+
        '<label>Emesso da <small>(nome e cognome)</small><input type="text" id="e-nome" maxlength="120" autocomplete="name" value="'+es(ls('sal_autore'))+'"></label>','Emetti il SAL',
        function(){var nm=$('#e-nome').value;ls('sal_autore',nm);return salvando(api('emetti',{id:D.bozza.id,dati:{autore:nm}})).then(function(r){if(r)avviso('SAL emesso.');});});});return;}
  if(t.id==='k-tutte'){impTutte=true;corpo();return;}
  if(t.id==='k-conferma'||t.id==='k-annulla'){var conf=t.id==='k-conferma',chi=$('#k-chi')?$('#k-chi').value:'';if(conf&&chi)ls('sal_autore',chi);t.disabled=true;
    api(conf?'computo_conferma':'computo_annulla',{id:impId,dati:{autore:chi}}).then(function(r){
      if(r&&r.esito==='ok'){clearTimeout(impTimer);IMP=null;impId=null;impTutte=false;avviso(conf?'Computo caricato: versione '+r.versione+', '+r.voci+' voci.':'Caricamento annullato.');if(conf)ricarica();else corpo();}
      else{t.disabled=false;avviso(errore(r));}});return;}
  if(t.id==='c-salva'){salvaContratto();return;}
  if(t.id==='c-tg-agg'){$('#c-tg').insertAdjacentHTML('beforeend',rigaTg({}));return;}
  if(t.hasAttribute('data-tgx')){t.parentNode.parentNode.removeChild(t.parentNode);return;}
  if(t.hasAttribute('data-st')){var az=t.getAttribute('data-st'),sid=t.getAttribute('data-id'),nn=t.getAttribute('data-n');
    if(az==='firmato'||az==='visto'){finestra(az==='firmato'?'SAL n. '+nn+': firmato dall’impresa':'SAL n. '+nn+': visto dalla Direzione Lavori','Si segna solo nell’area riservata: TIX non manda niente.',
        '<label>'+(az==='firmato'?'Firmato da':'Nome del Direttore dei Lavori')+'<input type="text" id="f-nome" maxlength="120"></label><label>Il giorno<input type="date" id="f-data" max="'+es(D.oggi)+'" value="'+es(D.oggi)+'"></label>'+
        (az==='visto'?'<label>Nota della DL <small>(facoltativa)</small><input type="text" id="f-nota" maxlength="600"></label>':''),'Salva',
        function(){var d={azione:az,nome:$('#f-nome').value,data:$('#f-data').value};if($('#f-nota'))d.nota=$('#f-nota').value;return salvando(api('stato',{id:sid,dati:d})).then(function(r){if(r)avviso('Salvato.');});});}
    else{finestra(az==='riemetti'?'Riemettere il SAL n. '+nn+' con correzioni?':'Annullare il SAL n. '+nn+'?',
        az==='riemetti'?'Nasce la versione successiva in bozza, con le stesse misure da correggere. La versione di prima resta archiviata con la sua impronta.':'Il SAL resta archiviato come annullato; le sue misure tornano libere per il prossimo SAL.',
        '<label>Motivo<textarea id="r-mot" maxlength="600" placeholder="es. la DL ha chiesto di rimisurare la voce 12"></textarea></label><label>Chi lo fa <small>(nome e cognome)</small><input type="text" id="r-nome" maxlength="120" value="'+es(ls('sal_autore'))+'"></label>',
        az==='riemetti'?'Riemetti':'Annulla il SAL',function(){return salvando(api('stato',{id:sid,dati:{azione:az,motivo:$('#r-mot').value,nome:$('#r-nome').value}})).then(function(r){if(r){avviso(az==='riemetti'?'Versione nuova pronta in bozza.':'SAL annullato.');}});},az==='annulla');}
    return;}
});
document.addEventListener('submit',function(ev){if(ev.target.id!=='dlg-f')return;ev.preventDefault();if(dlgAzione)dlgAzione();});
document.addEventListener('input',function(ev){if(ev.target.id==='cerca'){cerca=ev.target.value.toLowerCase().trim();var pos=ev.target.selectionStart;corpo();var c=$('#cerca');if(c){c.focus();try{c.setSelectionRange(pos,pos);}catch(e){}}}});
tutto();
if(impId)impSegui();
})();`;
