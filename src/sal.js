// ============================================================================
// SAL — stati di avanzamento lavori nell'area riservata (29/10/2026, impostazione approvata da Filippo il 29/10).
// Computo del contratto, misure scritte dall'ufficio, conto automatico in euro e in percentuale, SAL con chiusura e
// impronta SHA-256, Excel con formule vere e documento da stampare:
//   GET  /sal?t=<gettone>&c=<cantiere>[&s=avanzamento|sal|contratto|computo]   → pagina
//   POST /sal/api   {t, c, azione, id?, dati?}   → RPC sal_* (contesto, contratto, misura, misura_togli, bozza, emetti, stato)
//   GET  /sal/excel?t=<gettone>&c=<cantiere>[&id=<sal>]        → file .xlsx scritto qui, senza librerie
//   GET  /sal/documento?t=<gettone>&id=<sal>[&originale=1]     → documento del SAL da stampare (o il file originale)
//   GET  /sal/pdf?t=<gettone>&c=<cantiere>[&id=<sal>]          → PDF da firmare, scritto qui senza librerie (fase 3, 30/10/2026)
//   POST /sal/firmato/carica?t=&id=&nome=&chi=                  → copia firmata (PDF o .p7m) nell'archivio del cantiere
//   GET  /sal/firmato?t=<gettone>&id=<sal>                      → scarica la copia firmata
//   /sal/sub/…                                                  → contabilità dei subappaltatori (subappalti.js, 09/11/2026)
// Il database decide tutto: chi entra (impostazioni.sal_attivo), calcolo, numeri, impronta, versioni.
// Il relay non conserva nulla. Si spegne anche con la variabile del Worker SAL = "off".
// ============================================================================
import { portaleSub, SUB_APP, SUB_STILE } from "./subappalti.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GETTONE = /^[0-9a-f]{64}$/;
const SCHEDE = ["avanzamento", "sal", "contratto", "computo", "subappalti"];

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
        u("crono_attivita_id", r, t);
        return r;
      });
    }
  } else if (azione === "misura") {
    u("id"); u("voce_id"); u("rettifica_di");
    s("data", 10); s("luogo", 160); s("descrizione", 300); s("autore", 120);
    ["pu", "l", "w", "h", "q", "pct"].forEach((k) => s(k, 20));
    if (d.meno === true) o.meno = true;
  } else if (azione === "bozza") {
    s("periodo_a", 10); s("note", 1000); s("tipo", 10); s("data_fine_lavori", 10); s("data_collaudo", 10); s("collaudo_tipo", 10);
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
    s("autore", 120); s("variante_descrizione", 300); s("variante_data", 10); s("importo_contratto", 20);
  } else if (azione === "traguardo_raggiunto") {
    s("data", 10);
  } else if (azione === "computo_confronto") {
    ["da", "a"].forEach((k) => { if (/^[0-9]{1,4}$/.test(String(d[k] || ""))) o[k] = Number(d[k]); });
  } else if (azione === "proposta") {
    s("azione", 12); u("voce_id");
    s("data", 10); s("luogo", 160); s("descrizione", 300); s("autore", 120); s("motivo", 300);
    ["pu", "l", "w", "h", "q", "pct"].forEach((k) => s(k, 20));
    if (d.meno === true) o.meno = true;
  } else if (azione === "curva_prepara") {
    if (d.rifai === true) o.rifai = true;
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
  if (sotto === "/sal/pdf") return pdf(request, env, base, inUrl, h);
  if (sotto === "/sal/firmato/carica") return caricaFirmato(request, env, inUrl, h);
  if (sotto === "/sal/firmato") return scaricaFirmato(request, env, base, inUrl, h);
  if (sotto === "/sal/documento") return documento(request, env, base, inUrl, h);
  // 10/11/2026 (Filippo): pagina «Subappaltatori» a sé, aperta dal pulsante nella pagina del cantiere
  if (sotto === "/sal/subappaltatori") return rottaSubappaltatori(request, env, base, inUrl, h);
  if (sotto.startsWith("/sal/sub/")) return portaleSub(request, env, base, inUrl, h, { salPdf, salXlsx, preparaLogo });
  if (sotto !== "/sal") return new Response("Not Found", { status: 404 });
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const m = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  if (!m) return Response.redirect(inUrl.origin + base + "/", 303);
  const tok = m[0].toLowerCase();
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase().replace(/[^0-9a-f-]/g, "").slice(0, 36);
  if (!UUID.test(c)) return Response.redirect(inUrl.origin + base + "/?t=" + tok, 303);
  const torna = base + "/?t=" + tok + "&c=" + c;
  // 10/11/2026: i subappaltatori hanno la loro pagina; i vecchi collegamenti alla scheda vanno lì
  if (inUrl.searchParams.get("s") === "subappalti") return Response.redirect(inUrl.origin + base + "/sal/subappaltatori?t=" + tok + "&c=" + c, 303);
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
  if (["contesto", "contratto", "misura", "bozza", "curva_prepara", "traguardo_raggiunto", "computo_confronto"].indexOf(az) !== -1) {
    if (!UUID.test(c)) return json({ esito: "errore" }, 400);
    if (az === "contesto") r = await chiama("sal_contesto", { p_token: tok, p_commessa: c });
    else if (az === "contratto") r = await chiama("sal_contratto_salva", { p_token: tok, p_commessa: c, p_dati: dati });
    else if (az === "misura") r = await chiama("sal_misura_salva", { p_token: tok, p_commessa: c, p_dati: dati });
    else if (az === "curva_prepara") r = await chiama("sal_curva_prepara", { p_token: tok, p_commessa: c, p_rifai: dati.rifai === true });
    else if (az === "traguardo_raggiunto") {
      const n = Number(b.id);
      if (!Number.isInteger(n) || n <= 0) return json({ esito: "errore" }, 400);
      r = await chiama("sal_traguardo_raggiunto", { p_token: tok, p_commessa: c, p_id: n, p_data: dati.data || null });
    } else if (az === "computo_confronto") {
      if (!dati.da || !dati.a) return json({ esito: "errore" }, 400);
      r = await chiama("sal_computo_confronto", { p_token: tok, p_commessa: c, p_da: dati.da, p_a: dati.a });
    }
    else r = await chiama("sal_bozza_salva", { p_token: tok, p_commessa: c, p_dati: dati });
  } else if (["misura_togli", "emetti", "stato", "proposta"].indexOf(az) !== -1) {
    if (!UUID.test(id)) return json({ esito: "errore" }, 400);
    if (az === "misura_togli") r = await chiama("sal_misura_annulla", { p_token: tok, p_id: id, p_motivo: dati.motivo || "" });
    else if (az === "proposta") {
      if (["conferma", "scarta"].indexOf(dati.azione || "") === -1) return json({ esito: "errore" }, 400);
      r = await chiama("sal_proposta_azione", { p_token: tok, p_id: id, p_azione: dati.azione, p_dati: dati });
    }
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
    else r = await chiama("computo_import_azione", { p_token: tok, p_commessa: c, p_id: n, p_azione: az === "computo_conferma" ? "conferma" : "annulla",
      p_autore: dati.autore || null, p_dati: az === "computo_conferma" ? dati : null });
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
  r.logo = await preparaLogo(r.logo_impresa);
  const file = salXlsx(r);
  const nome = String(r.nome_file || "TIX SAL.xlsx");
  const ascii = nome.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "") || "TIX SAL.xlsx";
  return new Response(metodo === "HEAD" ? null : file, { status: 200, headers: {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(nome),
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" } });
}

// ---------------------------------------------------------------------------- PDF da firmare e copia firmata (fase 3, 30/10/2026)
function nomeScarico(nome, ripiego) {
  return nome.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "") || ripiego;
}
async function pdf(request, env, base, inUrl, h) {
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
  r.logo = await preparaLogo(r.logo_impresa);
  const file = salPdf(r);
  const nome = String(r.nome_file || "TIX SAL.xlsx").replace(/\.xlsx$/i, "") + ".pdf";
  return new Response(metodo === "HEAD" ? null : file, { status: 200, headers: {
    "Content-Type": "application/pdf",
    "Content-Disposition": 'attachment; filename="' + nomeScarico(nome, "TIX SAL.pdf") + '"; filename*=UTF-8\'\'' + encodeURIComponent(nome),
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" } });
}

// La copia firmata (a mano e scansionata, o con firma digitale: .pdf o .p7m) va nell'archivio del cantiere,
// «documenti/<cantiere>/sal/…», e si cancella con il cantiere. Il database ne tiene percorso, nome e impronta SHA-256.
async function caricaFirmato(request, env, inUrl, h) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  const tok = String(inUrl.searchParams.get("t") || "").toLowerCase();
  const id = String(inUrl.searchParams.get("id") || "").toLowerCase();
  const nome = String(inUrl.searchParams.get("nome") || "").replace(/[\u0000-\u001f\\/]+/g, " ").trim().slice(0, 180);
  const chi = String(inUrl.searchParams.get("chi") || "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 120);
  if (!GETTONE.test(tok)) return json({ esito: "gettone" }, 403);
  if (!UUID.test(id)) return json({ esito: "errore" }, 400);
  const est = ((/\.(pdf|p7m)$/i.exec(nome) || [])[1] || "").toLowerCase();
  if (!est) return json({ esito: "formato", messaggio: "Carica il SAL firmato in PDF (anche con firma digitale: .pdf o .p7m)." }, 400);
  if (Number(request.headers.get("Content-Length") || 0) > MAX_FILE) return json({ esito: "grande", messaggio: "Il file è troppo grande (massimo 18 MB)." }, 413);
  // prima il controllo dell'accesso, poi il file
  const info = await h.rpc(env, "sal_firmato_info", { p_token: tok, p_sal: id }, 10000).catch(() => null);
  if (!info) return json({ esito: "incerto" }, 503);
  if (info.esito !== "ok") return json({ esito: String(info.esito), messaggio: info.messaggio || "" }, info.esito === "gettone" ? 403 : 400);
  if (info.chiuso) return json({ esito: "chiuso", messaggio: "Il cantiere è chiuso." });
  if (!info.emesso || !UUID.test(String(info.commessa_id || ""))) return json({ esito: "errore", messaggio: "La copia firmata si carica su un SAL emesso." });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return json({ esito: "vuoto", messaggio: "Il file è vuoto." }, 400);
  if (bytes.length > MAX_FILE) return json({ esito: "grande", messaggio: "Il file è troppo grande (massimo 18 MB)." }, 413);
  if (est === "pdf" && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "%PDF") return json({ esito: "formato", messaggio: "Il file non è un PDF." }, 400);
  const ora = new Date();
  const giorno = ora.getUTCFullYear() + String(ora.getUTCMonth() + 1).padStart(2, "0") + String(ora.getUTCDate()).padStart(2, "0");
  const doc = info.tipo === "finale" ? "conto-finale" : info.tipo === "svincolo" ? "svincolo" : "sal-" + (Number(info.numero) || 0);
  const percorso = "documenti/" + info.commessa_id + "/sal/" + doc + "-v" + (Number(info.versione) || 1) + "-firmato-" + giorno + "-" + casuale() + "." + est;
  const supabaseUrl = env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const up = await fetch(supabaseUrl + "/storage/v1/object/wa-media/" + percorso, {
      method: "POST",
      headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY,
                 "Content-Type": est === "pdf" ? "application/pdf" : "application/pkcs7-mime", "x-upsert": "false" },
      body: bytes, signal: ctrl.signal
    });
    if (!up.ok) return json({ esito: "archivio", messaggio: "Il file non si è salvato: riprova tra un minuto." }, 502);
  } catch (e) {
    return json({ esito: "archivio", messaggio: "Il file non si è salvato: riprova tra un minuto." }, 502);
  } finally { clearTimeout(timer); }
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (x) => x.toString(16).padStart(2, "0")).join("");
  const r = await h.rpc(env, "sal_firmato_registra", { p_token: tok, p_sal: id, p_path: percorso, p_nome: nome || null, p_byte: bytes.length,
    p_sha256: sha, p_autore: chi || null }, 10000).catch(() => null);
  if (!r) return json({ esito: "incerto" }, 503);
  if (r.esito !== "ok") return json({ esito: String(r.esito), messaggio: r.messaggio || "" });
  // la copia sostituita non serve più: si toglie dall'archivio (solo se è davvero di questo cantiere)
  const vecchio = String(info.path || "");
  if (vecchio && vecchio !== percorso && vecchio.indexOf("documenti/" + info.commessa_id + "/sal/") === 0 && !/\.\./.test(vecchio)) {
    await fetch(supabaseUrl + "/storage/v1/object/wa-media/" + vecchio.split("/").map(encodeURIComponent).join("/"), {
      method: "DELETE", headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
  }
  return json({ esito: "ok", sha256: sha });
}

async function scaricaFirmato(request, env, base, inUrl, h) {
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const m = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  if (!m) return Response.redirect(inUrl.origin + base + "/", 303);
  const tok = m[0].toLowerCase();
  const id = String(inUrl.searchParams.get("id") || "").toLowerCase();
  if (!UUID.test(id)) return new Response("Not Found", { status: 404 });
  const info = await h.rpc(env, "sal_firmato_info", { p_token: tok, p_sal: id }, 10000).catch(() => null);
  if (!info) return h.risposta(h.foglio(base, "SAL", "", '<p class="err">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p>'), 503);
  if (info.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (info.esito !== "ok" || !info.path) return h.risposta(h.foglio(base, "SAL", "", '<p class="err">Copia firmata non trovata.</p>'), 404);
  const supabaseUrl = env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co";
  const f = await fetch(supabaseUrl + "/storage/v1/object/wa-media/" + String(info.path).split("/").map(encodeURIComponent).join("/"), {
    headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
  if (!f || !f.ok) return h.risposta(h.foglio(base, "SAL", "", '<p class="err">Il file non si legge dall’archivio: riprova tra un minuto.</p>'), 502);
  const nome = String(info.nome || String(info.path).split("/").pop());
  return new Response(metodo === "HEAD" ? null : f.body, { status: 200, headers: {
    "Content-Type": /\.p7m$/i.test(info.path) ? "application/pkcs7-mime" : "application/pdf",
    "Content-Disposition": 'attachment; filename="' + nomeScarico(nome, "SAL firmato.pdf") + '"; filename*=UTF-8\'\'' + encodeURIComponent(nome),
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" } });
}

function titoloDoc(sal, N) {
  if (sal.tipo === "sub" && sal.titolo) return String(sal.titolo);
  const t = sal.tipo === "finale" ? "Conto finale dei lavori" : sal.tipo === "svincolo" ? "Svincolo delle ritenute di garanzia" : "Stato di avanzamento lavori n. " + N;
  return t + (Number(sal.versione) > 1 ? " (versione " + sal.versione + ")" : "");
}

// Il PDF si scrive a mano, come l'Excel: font Helvetica del lettore PDF (codifica WinAnsi), A4 orizzontale, niente librerie.
// Larghezze dei caratteri 32–126 di Helvetica e Helvetica-Bold (metriche standard); le lettere accentate usano quella della lettera base.
const HW = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611,
  722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HWB = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611,
  722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const WIN = { 0x20AC: 128, 0x201A: 130, 0x201E: 132, 0x2026: 133, 0x2018: 145, 0x2019: 146, 0x201C: 147, 0x201D: 148, 0x2022: 149, 0x2013: 150, 0x2014: 151, 0x2122: 153, 0x2212: 45 };
const LARG_WIN = { 128: 556, 130: 222, 132: 333, 133: 1000, 145: 222, 146: 222, 147: 333, 148: 333, 149: 350, 150: 556, 151: 1000, 153: 1000,
  160: 278, 171: 556, 176: 400, 178: 333, 179: 333, 183: 278, 187: 556 };
// Il PDF va scritto entro pochi millisecondi (limite del Worker): larghezze in tabella, nessuna normalizzazione per i testi solo ASCII.
function codWin(u) {
  if ((u >= 32 && u < 127) || (u >= 160 && u <= 255)) return u;
  if (WIN[u]) return WIN[u];
  return u === 9 || u === 10 || u === 13 ? 32 : 63;
}
const nfc = (s) => { const t = String(s == null ? "" : s); return /[^\x00-\x7f]/.test(t) ? t.normalize("NFC") : t; };
function winAnsi(s) {
  const t = nfc(s), out = [];
  for (let i = 0; i < t.length; i++) {
    const u = t.charCodeAt(i);
    if (u >= 0xD800 && u <= 0xDBFF && i + 1 < t.length) { i++; out.push(63); } else out.push(codWin(u));
  }
  return out;
}
function largCod(c, gr) {
  if (c >= 32 && c <= 126) return (gr ? HWB : HW)[c - 32];
  if (LARG_WIN[c]) return LARG_WIN[c];
  if (c >= 192) {
    const b = String.fromCharCode(c).normalize("NFD").charCodeAt(0);
    if (b >= 32 && b <= 126) return (gr ? HWB : HW)[b - 32];
  }
  return 556;
}
const LW = [0, 1].map((g) => Float64Array.from({ length: 256 }, (_, c) => largCod(c, g === 1)));
function largTesto(s, corpo, gr) {
  const t = nfc(s), L = LW[gr ? 1 : 0];
  let w = 0;
  for (let i = 0; i < t.length; i++) {
    const u = t.charCodeAt(i);
    if (u >= 0xD800 && u <= 0xDBFF && i + 1 < t.length) { i++; w += L[63]; } else w += L[codWin(u)];
  }
  return w * corpo / 1000;
}
// il pezzo iniziale più lungo che sta in «w» (almeno un carattere)
function taglia(s, w, corpo, gr) {
  const t = nfc(s), L = LW[gr ? 1 : 0], k = corpo / 1000;
  let x = 0;
  for (let i = 0; i < t.length; i++) {
    const u = t.charCodeAt(i), doppio = u >= 0xD800 && u <= 0xDBFF && i + 1 < t.length;
    x += L[doppio ? 63 : codWin(u)] * k;
    if (x > w) return t.slice(0, i > 0 ? i : (doppio ? 2 : 1));
    if (doppio) i++;
  }
  return t;
}
function pdfStringa(s) {
  if (typeof s === "string" && /^[\x20-\x27\x2a-\x5b\x5d-\x7e]*$/.test(s)) return "(" + s + ")";
  let o = "(";
  for (const c of winAnsi(s)) {
    if (c === 40 || c === 41 || c === 92) o += "\\" + String.fromCharCode(c);
    else if (c < 32 || c > 126) o += "\\" + c.toString(8).padStart(3, "0");
    else o += String.fromCharCode(c);
  }
  return o + ")";
}
const grpIt = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
function eurIt(n) { const x = num(n); if (x === null) return ""; const p = Math.abs(x).toFixed(2).split("."); return (x < 0 && Math.abs(x) >= 0.005 ? "-" : "") + grpIt(p[0]) + "," + p[1]; }
function qtIt(n) {
  const x0 = num(n); if (x0 === null) return "";
  const x = Math.round(x0 * 1000) / 1000, p = Math.abs(x).toFixed(3).replace(/\.?0+$/, "").split(".");
  return (x < 0 ? "-" : "") + grpIt(p[0]) + (p[1] ? "," + p[1] : "");
}
function pcIt(n) { const x = num(n); return x === null ? "" : x.toFixed(2).replace(".", ",") + "%"; }
function dataIt(s) { if (!s) return ""; const p = String(s).slice(0, 10).split("-"); return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : String(s); }

// 10/11/2026 (Filippo): il logo TIX (marchio-tix.png dell'app, 405×160) in alto a sinistra di ogni pagina dei PDF del SAL e
// della contabilità dei subappaltatori, al posto della scritta «TIX™». Colori e trasparenza già compressi (zlib) per il PDF.
const LOGO_PDF = {"w":405,"h":160,"rgb":"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","alfa":"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"};
let LOGO_BIN = null;
function logoBin() {
  if (!LOGO_BIN) LOGO_BIN = { rgb: atob(LOGO_PDF.rgb), alfa: atob(LOGO_PDF.alfa) };
  return LOGO_BIN;
}

// ---------------------------------------------------------------------------- loghi nei file (10/11/2026)
// Filippo: «oltre al logo TIX che sarebbe meglio se fosse messo a piè pagina in basso a destra, deve sempre comparire il logo
// dell'impresa, cioè dell'utente che ha acquistato il servizio». Il logo dell'impresa cliente arriva dal database
// (logo_impresa: URL https:// o data:image/) e si prepara qui, prima di fare PDF ed Excel: PNG (letto qui, con la trasparenza)
// o JPEG; qualsiasi problema = niente logo e al suo posto il nome dell'impresa.
const LOGO_TIX_PNG = "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";
let LOGO_TIX_BYTE = null;
function logoTixPng() {
  if (!LOGO_TIX_BYTE) { const s = atob(LOGO_TIX_PNG); LOGO_TIX_BYTE = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) LOGO_TIX_BYTE[i] = s.charCodeAt(i); }
  return LOGO_TIX_BYTE;
}
function binStr(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  return s;
}
async function zlibFlusso(u8, comprimi) {
  const t = comprimi ? new CompressionStream("deflate") : new DecompressionStream("deflate");
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(t)).arrayBuffer());
}
async function pngPerPdf(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8, w = 0, h = 0, bit = 0, col = -1, inter = 0, pal = null, trns = null;
  const idat = [];
  while (p + 12 <= b.length) {
    const n = dv.getUint32(p), t = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (p + 12 + n > b.length) break;
    const dati = b.subarray(p + 8, p + 8 + n);
    if (t === "IHDR") { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); bit = b[p + 16]; col = b[p + 17]; inter = b[p + 20]; }
    else if (t === "PLTE") pal = dati;
    else if (t === "tRNS") trns = dati;
    else if (t === "IDAT") idat.push(dati);
    else if (t === "IEND") break;
    p += 12 + n;
  }
  const can = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[col];
  if (!w || !h || !can || inter !== 0 || w * h > 4000000 || !idat.length) return null;
  if (col === 3 ? [1, 2, 4, 8].indexOf(bit) === -1 || !pal : bit !== 8) return null;
  let tot = 0;
  for (const x of idat) tot += x.length;
  const z = new Uint8Array(tot);
  let o = 0;
  for (const x of idat) { z.set(x, o); o += x.length; }
  const raw = await zlibFlusso(z, false);
  const riga = Math.ceil(w * can * bit / 8), bpp = Math.max(1, (can * bit) >> 3);
  if (raw.length < h * (riga + 1)) return null;
  const pix = new Uint8Array(h * riga);
  let prec = new Uint8Array(riga);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (riga + 1)], src = raw.subarray(y * (riga + 1) + 1, (y + 1) * (riga + 1)), cur = pix.subarray(y * riga, (y + 1) * riga);
    for (let x = 0; x < riga; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, bb = prec[x], c = x >= bpp ? prec[x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += bb;
      else if (f === 3) v += (a + bb) >> 1;
      else if (f === 4) { const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? bb : c; }
      cur[x] = v & 255;
    }
    prec = cur;
  }
  const rgb = new Uint8Array(w * h * 3), alfa = new Uint8Array(w * h);
  let trasp = false;
  for (let y = 0; y < h; y++) {
    const r0 = y * riga;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let R, G, B, A = 255;
      if (col === 3) {
        const bp = x * bit, k = (pix[r0 + (bp >> 3)] >> (8 - bit - (bp & 7))) & ((1 << bit) - 1);
        R = pal[k * 3] || 0; G = pal[k * 3 + 1] || 0; B = pal[k * 3 + 2] || 0;
        if (trns && k < trns.length) A = trns[k];
      } else if (col === 0) { R = G = B = pix[r0 + x]; }
      else if (col === 4) { R = G = B = pix[r0 + x * 2]; A = pix[r0 + x * 2 + 1]; }
      else if (col === 2) { R = pix[r0 + x * 3]; G = pix[r0 + x * 3 + 1]; B = pix[r0 + x * 3 + 2]; }
      else { R = pix[r0 + x * 4]; G = pix[r0 + x * 4 + 1]; B = pix[r0 + x * 4 + 2]; A = pix[r0 + x * 4 + 3]; }
      rgb[i * 3] = R; rgb[i * 3 + 1] = G; rgb[i * 3 + 2] = B; alfa[i] = A;
      if (A !== 255) trasp = true;
    }
  }
  return { w, h, filtro: "FlateDecode", colori: "DeviceRGB", dati: binStr(await zlibFlusso(rgb, true)), alfa: trasp ? binStr(await zlibFlusso(alfa, true)) : null };
}
function jpegPerPdf(b) {
  let p = 2;
  while (p + 9 < b.length) {
    if (b[p] !== 0xFF) { p++; continue; }
    const m = b[p + 1];
    if (m === 0xFF) { p++; continue; }
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { p += 2; continue; }
    const len = (b[p + 2] << 8) | b[p + 3];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      const h = (b[p + 5] << 8) | b[p + 6], w = (b[p + 7] << 8) | b[p + 8], nc = b[p + 9];
      if (!w || !h || (nc !== 1 && nc !== 3)) return null;
      return { w, h, filtro: "DCTDecode", colori: nc === 1 ? "DeviceGray" : "DeviceRGB", dati: binStr(b), alfa: null };
    }
    p += 2 + len;
  }
  return null;
}
export async function preparaLogo(url) {
  try {
    const u = String(url || "").trim();
    let b = null;
    if (/^data:image\/(png|jpe?g);base64,/i.test(u)) {
      const s = atob(u.slice(u.indexOf(",") + 1));
      b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    } else if (/^https:\/\//i.test(u)) {
      const ctrl = new AbortController();
      const tm = setTimeout(() => ctrl.abort(), 6000);
      try {
        const r = await fetch(u, { signal: ctrl.signal });
        if (!r.ok) return null;
        b = new Uint8Array(await r.arrayBuffer());
      } finally { clearTimeout(tm); }
    }
    if (!b || b.length < 32 || b.length > 3000000) return null;
    const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47, jpg = b[0] === 0xFF && b[1] === 0xD8;
    const pdf = png ? await pngPerPdf(b) : jpg ? jpegPerPdf(b) : null;
    if (!pdf) return null;
    return { w: pdf.w, h: pdf.h, ext: png ? "png" : "jpeg", file: b, pdf };
  } catch (e) {
    return null;
  }
}

export function salPdf(d) {
  const W = 842, H = 595, M = 32, BASSO = M + 30;
  // 10/11/2026 (Filippo): «deve sempre comparire il logo dell'impresa» → in testata il logo dell'impresa cliente (d.logo, preparato
  // da preparaLogo), alto al massimo 24 pt e largo al massimo 150 pt, oppure il suo nome; il logo TIX va a piè di pagina, a destra.
  const TH = 16, TW = Math.round(TH * LOGO_PDF.w / LOGO_PDF.h * 100) / 100;
  const li = d.logo && d.logo.pdf ? d.logo : null;
  const nomeImpresa = String(d.azienda_nome || "").trim();
  let LIW = 0, LIH = 0;
  if (li) { LIH = 24; LIW = LIH * li.w / li.h; if (LIW > 150) { LIW = 150; LIH = LIW * li.h / li.w; } }
  const sal = d.sal || {}, co = d.conto || {}, cm = d.computo || {}, ca = d.cantiere || {};
  const tipo = sal.tipo || co.tipo || "sal";
  const bozza = sal.stato === "bozza" || sal.stato === "anteprima";
  const N = Number(sal.numero) || 1;
  const voci = (Array.isArray(d.voci) ? d.voci : []).filter((v) => num(v.qt) || num(v.qn) || num(v.qp));
  const alt = Array.isArray(d.altre_voci) ? d.altre_voci : [];
  // contabilità del subappaltatore (subappalti.js): stesso documento, con etichette, conto e firme suoi
  const sub = tipo === "sub", et = sal.etichette || {};
  const titolo = titoloDoc(sal, N) + (sub ? "" : " — proposta dell’impresa");
  const f2 = (n) => String(Math.round(n * 100) / 100);
  const pagine = [];
  let p = null, y = 0;
  const op = (s) => p.push(s);
  const testo = (x, yy, s, corpo, gr, colore) => {
    if (s === null || s === undefined || s === "") return;
    op((colore || "0 g") + " BT /" + (gr ? "F2" : "F1") + " " + corpo + " Tf " + f2(x) + " " + f2(yy) + " Td " + pdfStringa(s) + " Tj ET");
  };
  const destra = (xr, yy, s, corpo, gr, colore) => testo(xr - largTesto(s, corpo, gr), yy, s, corpo, gr, colore);
  const linea = (x1, y1, x2, y2, sp, colore) => op((colore || "0.7 G") + " " + (sp || 0.5) + " w " + f2(x1) + " " + f2(y1) + " m " + f2(x2) + " " + f2(y2) + " l S");
  const fondo = (x, yy, w, hh, colore) => op(colore + " " + f2(x) + " " + f2(yy) + " " + f2(w) + " " + f2(hh) + " re f");
  // a capo per parole; con «max» si ferma appena sa che il testo non ci sta (le descrizioni dei computi possono essere lunghissime)
  const aCapo = (s, w, corpo, gr, max) => {
    const parole = String(s == null ? "" : s).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    const sp = largTesto(" ", corpo, gr), righe = [];
    let r = "", rw = 0;
    for (const pa of parole) {
      const pw = largTesto(pa, corpo, gr);
      if (!r) { r = pa; rw = pw; }
      else if (rw + sp + pw <= w) { r += " " + pa; rw += sp + pw; }
      else { righe.push(r); r = pa; rw = pw; if (max && righe.length > max) { r = ""; break; } }
    }
    if (r) righe.push(r);
    for (let i = 0; i < righe.length; i++) if (largTesto(righe[i], corpo, gr) > w) righe[i] = taglia(righe[i], w, corpo, gr);
    if (max && righe.length > max) {
      righe.length = max;
      righe[max - 1] = taglia(righe[max - 1], Math.max(0, w - largTesto("…", corpo, gr)), corpo, gr) + "…";
    }
    return righe.length ? righe : [""];
  };
  const nuova = () => {
    p = []; pagine.push(p); y = H - M;
    let xt = M;
    if (li) {
      op("q " + f2(LIW) + " 0 0 " + f2(LIH) + " " + M + " " + f2(y - 24 + (24 - LIH) / 2) + " cm /Li Do Q");
      xt = M + LIW + 12;
    } else if (nomeImpresa) {
      testo(M, y - 16, nomeImpresa, 11, true, "0 g");
      xt = M + largTesto(nomeImpresa, 11, true) + 12;
    }
    testo(xt, y - 15, titolo, 8.5, true, "0.29 0.12 0.53 rg");
    destra(W - M, y - 15, (ca.nome || "") + (ca.impresa ? " · " + ca.impresa : ""), 8, false, "0.35 g");
    linea(M, y - 30, W - M, y - 30, 0.6, "0.57 0.27 0.86 RG");
    y -= 41;
  };
  const serve = (alt0) => { if (y - alt0 < BASSO) nuova(); };

  // ---- prima pagina: titolo e dati
  nuova();
  if (bozza) {
    fondo(M, y - 16, W - 2 * M, 16, "1 0.95 0.9 rg");
    testo(M + 6, y - 11.5, "BOZZA — non ancora emessa: non ha numero definitivo né impronta, non va firmata.", 8.5, true, "0.6 0.2 0 rg");
    y -= 24;
  }
  for (const r of aCapo(titolo, W - 2 * M, 15, true)) { testo(M, y - 14, r, 15, true, "0.24 0.1 0.43 rg"); y -= 19; }
  y -= 4;
  const tipoC = { a_misura: "a misura", a_corpo: "a corpo", misto: "a corpo e a misura" }[cm.tipo_contratto] || "";
  const sx = [[et.impresa || "Impresa", ca.impresa], ["Cantiere", ca.nome], ["Ubicazione", ca.ubicazione], [et.committente || "Committente", ca.committente],
    ["Direzione Lavori", ca.dl], ["CUP / CIG", [ca.cup, ca.cig].filter(Boolean).join(" / ")]];
  const periodo = tipo === "svincolo"
    ? [(sal.collaudo_tipo === "cre" ? "Certificato di regolare esecuzione" : "Collaudo"), dataIt(sal.data_collaudo)]
    : tipo === "finale" ? ["Fine dei lavori", dataIt(sal.data_fine_lavori || sal.periodo_a)]
    : ["Lavori", "dal " + dataIt(sal.periodo_da) + " al " + dataIt(sal.periodo_a)];
  const dx = sub
    ? [["Contratto del subappalto", num(cm.importo_contratto) ? eurIt(cm.importo_contratto) + " €" : ""],
       ["Ritenuta a garanzia", pcIt(cm.ritenuta_pct || 0)], periodo,
       ["Approvata", bozza ? "non ancora" : (sal.emesso_il || "") + (sal.emesso_da ? " da " + sal.emesso_da : "")]]
    : [["Contratto", [tipoC, num(cm.importo_contratto) !== null ? eurIt(cm.importo_contratto) + " €" : ""].filter(Boolean).join(", ")],
    ["Ribasso · ritenuta · anticipazione", pcIt(cm.ribasso_pct || 0) + " · " + pcIt(cm.ritenuta_pct || 0) + " · " + pcIt(cm.anticipazione_pct || 0)],
    ["Computo", "versione " + (cm.versione || "") + (cm.variante_n ? " (variante n. " + cm.variante_n + (cm.variante_descrizione ? ": " + cm.variante_descrizione : "") + ")" : "")],
    periodo,
    ["Emesso", bozza ? "non ancora" : (sal.emesso_il || "") + (sal.emesso_da ? " da " + sal.emesso_da : "")],
    ["Versione", String(Number(sal.versione) || 1)]];
  const colW = (W - 2 * M) / 2 - 10;
  let ys = y, yd = y;
  for (const [et, v] of sx) { if (!v) continue; testo(M, ys - 8, et, 7, false, "0.42 g"); for (const r of aCapo(v, colW - 110, 8.5, true, 2)) { testo(M + 110, ys - 8, r, 8.5, true); ys -= 11; } ys -= 1; }
  const x2 = M + colW + 20;
  for (const [et, v] of dx) { if (!v) continue; testo(x2, yd - 8, et, 7, false, "0.42 g"); for (const r of aCapo(v, colW - 130, 8.5, false, 2)) { testo(x2 + 130, yd - 8, r, 8.5, false); yd -= 11; } yd -= 1; }
  y = Math.min(ys, yd) - 8;

  // ---- voci (il documento dello svincolo non le ripete)
  const col = [[26, "N.", "s"], [70, "Tariffa", "s"], [268, "Descrizione", "s"], [40, "U.M.", "s"], [70, "Q. precedente", "d"], [70, "Q. periodo", "d"],
    [70, "Q. a oggi", "d"], [74, "Prezzo €", "d"], [90, "Importo a oggi €", "d"]];
  const xs = []; { let x = M; for (const c of col) { xs.push(x); x += c[0]; } }
  const intestazione = () => {
    fondo(M, y - 14, W - 2 * M, 14, "0.94 0.91 0.98 rg");
    col.forEach((c, i) => { if (c[2] === "d") destra(xs[i] + c[0] - 3, y - 10, c[1], 7, true, "0.29 0.12 0.53 rg"); else testo(xs[i] + 3, y - 10, c[1], 7, true, "0.29 0.12 0.53 rg"); });
    y -= 16;
  };
  if (tipo !== "svincolo") {
    serve(60);
    testo(M, y - 10, "Lavori a oggi" + (voci.length ? " (" + voci.length + (voci.length === 1 ? " voce con lavori)" : " voci con lavori)") : ": nessuna voce con lavori"), 10, true, "0.24 0.1 0.43 rg");
    y -= 16;
    if (voci.length) {
      intestazione();
      let capCorrente = null, totIt = 0, totIn = 0;
      for (const v of voci) {
        const cn = v.cn || "";
        const righeD = aCapo(v.d || v.db || "", col[2][0] - 6, 7.5, false, 2);
        const alt0 = righeD.length * 9 + 4 + (cn !== capCorrente ? 14 : 0);
        if (y - alt0 < BASSO) { nuova(); intestazione(); capCorrente = null; }
        if (cn !== capCorrente) {
          capCorrente = cn;
          fondo(M, y - 12, W - 2 * M, 12, "0.95 0.95 0.95 rg");
          testo(M + 3, y - 9, cn, 7.5, true, "0.14 0.19 0.16 rg");
          y -= 14;
        }
        const yb = y - 8;
        testo(xs[0] + 3, yb, String(v.nr == null ? "" : v.nr), 7.5);
        testo(xs[1] + 3, yb, aCapo(v.t || "", col[1][0] - 6, 7.5, false, 1)[0], 7.5);
        righeD.forEach((r, i) => testo(xs[2] + 3, yb - i * 9, r, 7.5));
        testo(xs[3] + 3, yb, v.u || "", 7.5);
        destra(xs[4] + col[4][0] - 3, yb, qtIt(v.qp), 7.5);
        destra(xs[5] + col[5][0] - 3, yb, qtIt(v.qn), 7.5);
        destra(xs[6] + col[6][0] - 3, yb, qtIt(v.qt), 7.5, true);
        destra(xs[7] + col[7][0] - 3, yb, eurIt(v.p), 7.5);
        destra(xs[8] + col[8][0] - 3, yb, eurIt(v.it), 7.5, true);
        y -= righeD.length * 9 + 4;
        linea(M, y + 1, W - M, y + 1, 0.3, "0.85 G");
        totIt += num(v.it) || 0; totIn += num(v.in) || 0;
      }
      serve(16);
      fondo(M, y - 14, W - 2 * M, 14, "0.94 0.91 0.98 rg");
      testo(xs[2] + 3, y - 10, "Totale lavori a oggi (di cui in questo periodo " + eurIt(Math.round(totIn * 100) / 100) + " €)", 8, true);
      destra(W - M - 3, y - 10, eurIt(Math.round(totIt * 100) / 100), 8, true);
      y -= 22;
    }
  }

  // ---- altre voci
  if (alt.length && tipo !== "svincolo") {
    serve(40);
    testo(M, y - 10, sub ? "Ore in economia di questa contabilità (dal Diario del cantiere)" : "Altre voci di questo documento (economie e noli, prezzo già netto)", 10, true, "0.24 0.1 0.43 rg");
    y -= 16;
    for (const a of alt) {
      const righe = aCapo((a.tipo && !sub ? { economia: "Economia", nolo: "Nolo", altro: "Altro" }[a.tipo] + ": " : "") + (a.descrizione || ""), 430, 7.5, false, 2);
      serve(righe.length * 9 + 4);
      righe.forEach((r, i) => testo(M + 3, y - 8 - i * 9, r, 7.5));
      destra(M + 520, y - 8, qtIt(a.quantita) + " " + (a.unita || ""), 7.5);
      destra(M + 610, y - 8, eurIt(a.prezzo), 7.5);
      destra(W - M - 3, y - 8, eurIt(Math.round((num(a.quantita) || 0) * (num(a.prezzo) || 0) * 100) / 100), 7.5, true);
      y -= righe.length * 9 + 4;
      linea(M, y + 1, W - M, y + 1, 0.3, "0.85 G");
    }
    y -= 8;
  }

  // ---- conto
  const tr = co.traguardo && co.traguardo.modo === "percentuale" ? co.traguardo : null;
  const lavPer = co.lavori_periodo != null ? num(co.lavori_periodo) : Math.round(voci.reduce((t, v) => t + (num(v.in) || 0), 0) * 100) / 100;
  const rc = [];
  if (sub) {
    rc.push(["Lavori a oggi", co.lavori, true, "di cui in questo periodo " + eurIt(lavPer) + " €"]);
    // S2 (11/11/2026): ore in economia del sub; la ritenuta si calcola sul totale
    if (num(co.altre_voci)) {
      rc.push(["+ Economie a oggi", co.altre_voci, false, num(co.altre_voci_sal) ? "di cui in questa contabilità " + eurIt(co.altre_voci_sal) + " €" : ""]);
      rc.push(["= Totale a oggi", co.netto, true]);
    }
    if (num(co.ritenuta)) { rc.push(["− Ritenuta a garanzia " + pcIt(co.ritenuta_pct || 0), co.ritenuta]); rc.push(["= Spettanza a oggi", co.spettanza, true]); }
    rc.push(["− Contabilità già approvate", co.precedenti]);
  } else if (tr) rc.push(["Traguardo «" + (tr.nome || "") + "»: " + pcIt(tr.percentuale) + " del contratto", (num(co.netto) || 0) - (num(co.altre_voci) || 0), false, "in tutto " + pcIt(tr.cumulata)]);
  else {
    rc.push(["Lavori a misura a oggi", co.lavori_misura]);
    if (num(co.lavori_corpo)) rc.push(["Lavori a corpo a oggi", co.lavori_corpo]);
    rc.push(["Totale lavori a oggi", co.lavori, true, tipo === "svincolo" ? "" : "di cui in questo periodo " + eurIt(lavPer) + " €"]);
    rc.push(["− Ribasso " + pcIt(co.ribasso_pct || 0), co.ribasso]);
    rc.push(["+ Oneri della sicurezza", co.sicurezza, false, { nei_prezzi: "compresi nei prezzi", voci: "nelle voci non ribassabili", proporzionale: "in proporzione ai lavori" }[co.sicurezza_modo] || ""]);
  }
  if (!sub) {
    if (num(co.altre_voci)) rc.push(["+ Altre voci a oggi (economie e noli)", co.altre_voci]);
    rc.push(["= Lavori netti a oggi", co.netto, true]);
    rc.push([tipo === "svincolo" ? "− Ritenuta a garanzia: non si trattiene più (svincolo)" : "− Ritenuta a garanzia " + pcIt(co.ritenuta_pct || 0), co.ritenuta, false,
      tipo === "finale" ? "trattenuta fino allo svincolo" : ""]);
    if (num(co.recupero) || num(co.anticipazione)) rc.push(["− Recupero dell’anticipazione" + (tipo === "sal" ? "" : " (per intero)"), co.recupero]);
    rc.push(["= Spettanza a oggi", co.spettanza, true]);
    rc.push(["− SAL già emessi", co.precedenti]);
  }
  const fin = sub ? "IMPORTO DI QUESTA CONTABILITÀ" : tipo === "finale" ? "SALDO DEL CONTO FINALE, RITENUTE ESCLUSE" : tipo === "svincolo" ? "RITENUTE DA SVINCOLARE" : "IMPORTO DI QUESTO SAL";
  serve(rc.length * 14 + 60);
  testo(M, y - 10, "Conto", 10, true, "0.24 0.1 0.43 rg");
  y -= 16;
  const cw = 470;
  for (const [et, v, forte, sub] of rc) {
    if (forte) fondo(M, y - 13, cw, 13, "0.98 0.97 1 rg");
    testo(M + 4, y - 9.5, et, 8.5, !!forte);
    if (sub) testo(M + 4 + largTesto(et, 8.5, !!forte) + 6, y - 9.5, sub, 7, false, "0.42 g");
    destra(M + cw - 4, y - 9.5, eurIt(v) + " €", 8.5, !!forte);
    y -= 14;
    linea(M, y + 1, M + cw, y + 1, 0.3, "0.88 G");
  }
  fondo(M, y - 18, cw, 18, "0.96 0.94 1 rg");
  linea(M, y, M + cw, y, 1.2, "0.57 0.27 0.86 RG");
  testo(M + 4, y - 12.5, fin, 9.5, true, "0.24 0.1 0.43 rg");
  destra(M + cw - 4, y - 12.5, eurIt(co.dovuto) + " € + IVA", 10, true, "0.24 0.1 0.43 rg");
  y -= 26;
  const note = ["Importi in euro, IVA esclusa: TIX non calcola l’IVA. Tutto è calcolato a oggi e poi si toglie quanto già emesso."];
  if (tipo === "finale") note.push("Conto finale: l’anticipazione si recupera per intero. Le ritenute di garanzia trattenute (" + eurIt(co.ritenute_trattenute != null ? co.ritenute_trattenute : co.ritenuta) +
    " €) si svincolano dopo il collaudo o il certificato di regolare esecuzione.");
  if (tipo === "svincolo") note.push("Svincolo dopo " + (sal.collaudo_tipo === "cre" ? "il certificato di regolare esecuzione" : "il collaudo") + (sal.data_collaudo ? " del " + dataIt(sal.data_collaudo) : "") +
    ": la ritenuta non si trattiene più. Ritenute svincolate: " + eurIt(co.ritenute_trattenute) + " €.");
  if (sal.note) note.push("Note: " + sal.note);
  for (const n of note) for (const r of aCapo(n, W - 2 * M, 7.5)) { serve(10); testo(M, y - 8, r, 7.5, false, "0.3 g"); y -= 10; }
  y -= 10;

  // ---- firme
  serve(96);
  const bw = (W - 2 * M - 30) / 2;
  const firme = Array.isArray(sal.firme) && sal.firme.length === 2 ? sal.firme : ["Per l’impresa: data, timbro e firma", "Visto della Direzione Lavori: data e firma"];
  [[M, firme[0], sal.firma_impresa], [M + bw + 30, firme[1], sal.firma_dl]].forEach(([x, et, nome]) => {
    op("0.6 G 0.6 w " + f2(x) + " " + f2(y - 80) + " " + f2(bw) + " 80 re S");
    testo(x + 6, y - 12, et, 8, true, "0.3 g");
    if (nome) testo(x + 6, y - 26, nome, 9);
    linea(x + 6, y - 66, x + bw - 6, y - 66, 0.4, "0.75 G");
  });
  y -= 90;

  // ---- piede di ogni pagina
  const imp = bozza ? "Bozza: l’impronta SHA-256 si registra all’emissione." : sal.sha ? "Impronta SHA-256 del documento registrato in TIX: " + sal.sha : "";
  pagine.forEach((pg, i) => {
    p = pg;
    linea(M, M + 22, W - M, M + 22, 0.4, "0.8 G");
    testo(M, M + 12, sub ? "Contabilità del subappaltatore preparata con TIX™: misure scritte dal subappaltatore e approvate dall’impresa appaltatrice."
      : "Documento preparato dall’impresa con TIX™: la verifica e l’approvazione spettano alla Direzione Lavori.", 7, false, "0.42 g");
    // 10/11/2026 (Filippo): logo TIX a piè di pagina, in basso a destra; il numero di pagina alla sua sinistra
    op("q " + f2(TW) + " 0 0 " + TH + " " + f2(W - M - TW) + " " + f2(M - 1) + " cm /Lg Do Q");
    destra(W - M - TW - 10, M + 5, "Pagina " + (i + 1) + " di " + pagine.length, 7, false, "0.42 g");
    if (imp) testo(M, M + 3, imp, 6.5, false, "0.42 g");
  });

  // ---- file PDF
  const oggetti = [];
  const agg = (s) => { oggetti.push(s); return oggetti.length; };
  const dataPdf = "D:" + String(sal.periodo_a || "2026-01-01").slice(0, 10).replace(/-/g, "") + "120000Z";
  agg("<< /Type /Catalog /Pages 2 0 R >>");
  agg("PAGINE");
  agg("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  agg("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  agg("<< /Title " + pdfStringa(titoloDoc(sal, N) + " - " + (ca.nome || "")) + " /Author " + pdfStringa(ca.impresa || "") +
    " /Creator (TIX) /Producer (TIX) /CreationDate (" + dataPdf + ") /ModDate (" + dataPdf + ") >>");
  // logo TIX: trasparenza (SMask) e colori, una volta sola per tutte le pagine
  const lg = logoBin();
  const lgA = agg("<< /Type /XObject /Subtype /Image /Width " + LOGO_PDF.w + " /Height " + LOGO_PDF.h +
    " /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length " + lg.alfa.length + " >>\nstream\n" + lg.alfa + "\nendstream");
  const lgI = agg("<< /Type /XObject /Subtype /Image /Width " + LOGO_PDF.w + " /Height " + LOGO_PDF.h +
    " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask " + lgA + " 0 R /Length " + lg.rgb.length + " >>\nstream\n" + lg.rgb + "\nendstream");
  // logo dell'impresa cliente (PNG con eventuale trasparenza, oppure JPEG)
  let liI = 0;
  if (li) {
    const q = li.pdf;
    const liA = q.alfa ? agg("<< /Type /XObject /Subtype /Image /Width " + q.w + " /Height " + q.h +
      " /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length " + q.alfa.length + " >>\nstream\n" + q.alfa + "\nendstream") : 0;
    liI = agg("<< /Type /XObject /Subtype /Image /Width " + q.w + " /Height " + q.h + " /ColorSpace /" + q.colori + " /BitsPerComponent 8 /Filter /" + q.filtro +
      (liA ? " /SMask " + liA + " 0 R" : "") + " /Length " + q.dati.length + " >>\nstream\n" + q.dati + "\nendstream");
  }
  const figli = [];
  for (const pg of pagine) {
    const flusso = pg.join("\n");
    const c = agg("<< /Length " + flusso.length + " >>\nstream\n" + flusso + "\nendstream");
    figli.push(agg("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + W + " " + H + "] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << /Lg " + lgI + " 0 R" +
      (liI ? " /Li " + liI + " 0 R" : "") + " >> >> /Contents " + c + " 0 R >>"));
  }
  oggetti[1] = "<< /Type /Pages /Kids [" + figli.map((n) => n + " 0 R").join(" ") + "] /Count " + figli.length + " >>";
  // dopo l'intestazione (con i 4 byte «binari» del commento) è tutto ASCII: si codifica in un colpo solo
  const testa = [0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A, 0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]; // "%PDF-1.4\n%âãÏÓ\n"
  const parti = [], pos = [];
  let lun = testa.length;
  oggetti.forEach((o, i) => { const s = (i + 1) + " 0 obj\n" + o + "\nendobj\n"; pos.push(lun); parti.push(s); lun += s.length; });
  parti.push("xref\n0 " + (oggetti.length + 1) + "\n0000000000 65535 f \n" + pos.map((x) => String(x).padStart(10, "0") + " 00000 n \n").join("") +
    "trailer\n<< /Size " + (oggetti.length + 1) + " /Root 1 0 R /Info 5 0 R >>\nstartxref\n" + lun + "\n%%EOF\n");
  const tutto = parti.join("");
  let corpo = new TextEncoder().encode(tutto);
  if (corpo.length !== tutto.length) { corpo = new Uint8Array(tutto.length); for (let i = 0; i < tutto.length; i++) corpo[i] = tutto.charCodeAt(i) & 0xFF; }
  const b = new Uint8Array(testa.length + corpo.length);
  b.set(testa, 0); b.set(corpo, testa.length);
  return b;
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
  xml(scelto, hf) {
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
      (hf ? '<pageMargins left="0.4" right="0.4" top="1" bottom="0.85" header="0.3" footer="0.3"/>'
          : '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>') +
      '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' +
      // 10/11/2026: testata e piè di pagina con i loghi (immagini nel disegno VML del foglio, rId1 nelle sue relazioni)
      (hf ? "<headerFooter>" + hf + '</headerFooter><legacyDrawingHF r:id="rId1"/>' : "") + "</worksheet>";
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
  const tipo = sal.tipo || co.tipo || "sal";
  // 10/11/2026: niente più «TIX™ ·» nel titolo: il logo TIX è a piè di pagina, quello dell'impresa in testata
  R.c(1, 1, titoloDoc(sal, N) + (tipo === "sub" ? "" : " — proposta dell’impresa"), S.TIT);
  R.c(2, 1, (ca.nome || "") + (ca.ubicazione ? " · " + ca.ubicazione : "") + (ca.impresa ? " · " + ca.impresa : ""), S.LAB);
  R.c(4, 1, "Dati del SAL", S.HDR); R.c(4, 2, "", S.HDR);
  const righeDati = [["SAL n.", N, S.INT], ["Versione", Number(sal.versione) || 1, S.INT], ["Stato", STATI[sal.stato] || sal.stato || "", S.TXT],
    ["Lavori dal", seriale(sal.periodo_da), S.DATA], ["Lavori al", seriale(sal.periodo_a), S.DATA]]
    .concat(tipo === "finale" ? [["Fine dei lavori", seriale(sal.data_fine_lavori), S.DATA]] : [])
    .concat(tipo === "svincolo" ? [[sal.collaudo_tipo === "cre" ? "Certificato di regolare esecuzione" : "Collaudo", seriale(sal.data_collaudo), S.DATA]] : [])
    .concat([["Emesso", sal.emesso_il ? sal.emesso_il + (sal.emesso_da ? " da " + sal.emesso_da : "") : "non ancora", S.TXT],
    ["Impronta SHA-256 del documento del SAL", sal.sha || "si assegna all’emissione", S.TXT],
    ].concat(tipo === "sub"
      ? [["Subappaltatore", ca.impresa || "", S.TXT], ["Impresa appaltatrice", ca.committente || "", S.TXT]]
      : [["Committente", ca.committente || "", S.TXT], ["Direzione Lavori", ca.dl || "", S.TXT]]));
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
  const rAvp = riga(tipo === "sub" ? "+ Economie delle contabilità precedenti" : "+ Altre voci dei SAL precedenti", sto.length ? "SUM(Storico!$L$5:$L$" + stoFine + ")" : "0", avPrec, avPrec);
  const rAvsF = rr; // la formula delle altre voci di questo SAL punta alla tabella sotto: si scrive dopo
  rr++;
  const rNet = riga(tipo === "sub" ? "= Totale a oggi (lavori ed economie)" : "= Lavori netti a oggi", trag ? "ROUND(B" + rBase + "*B" + rCum + "/100,2)+B" + rAvp + "+B" + rAvsF
    : "B" + rLav + "-B" + rRibI + "+B" + rSic + "+B" + rAvp + "+B" + rAvsF, num(co.netto) || 0, num(co.netto) || 0, S.EURB);
  // svincolo: la ritenuta non si trattiene più; conto finale e svincolo: l'anticipazione si recupera tutta
  const rRitI = riga(tipo === "svincolo" ? "− Ritenuta a garanzia: non si trattiene più (svincolo)" : "− Ritenuta a garanzia",
    tipo === "svincolo" ? "0" : "ROUND(B" + rNet + "*B" + rRit + "/100,2)", num(co.ritenuta) || 0, num(co.ritenuta) || 0);
  const rAntI = riga("   Anticipazione", "ROUND(B" + rBase + "*B" + rAnt + "/100,2)", antic, antic);
  const rRec = riga("− Recupero dell’anticipazione" + (tipo === "sal" ? "" : " (per intero)"),
    tipo === "sal" ? "IF(AND(B" + rAntI + ">0,B" + rBase + ">0),MAX(0,MIN(B" + rAntI + ",ROUND(B" + rAntI + "*B" + rNet + "/B" + rBase + ",2))),0)" : "B" + rAntI,
    num(co.recupero) || 0, num(co.recupero) || 0);
  const rSp = riga("= Spettanza a oggi", "B" + rNet + "-B" + rRitI + "-B" + rRec, num(co.spettanza) || 0, num(co.spettanza) || 0, S.EURB);
  const rPrev = riga(tipo === "sub" ? "− Contabilità già approvate" : "− SAL già emessi", sto.length ? "SUM(Storico!$M$5:$M$" + stoFine + ")" : "0", num(co.precedenti) || 0, num(co.precedenti) || 0);
  riga(tipo === "sub" ? "= IMPORTO DI QUESTA CONTABILITÀ (+ IVA)" : tipo === "finale" ? "= SALDO DEL CONTO FINALE, RITENUTE ESCLUSE (+ IVA)" : tipo === "svincolo" ? "= RITENUTE DA SVINCOLARE (+ IVA)" : "= IMPORTO DI QUESTO SAL (+ IVA)",
    "B" + rSp + "-B" + rPrev, num(co.dovuto) || 0, num(co.dovuto) || 0, S.GRANDE);
  rr++;
  R.c(rr, 1, "Importi in euro, IVA esclusa: TIX non calcola l’IVA (10%, 22%, inversione contabile o scissione dei pagamenti dipendono dal caso). " +
    "Le celle della colonna B sono formule che leggono i fogli Avanzamento, Libretto e Storico; la colonna C riporta i numeri registrati da TIX e la differenza deve essere zero.", S.NOTA);
  R.unioni.push("A" + rr + ":D" + rr); R.alte.set(rr, 40); rr += 2;
  // altre voci di questo SAL
  R.c(rr, 1, tipo === "sub" ? "Ore in economia di questa contabilità (dal Diario del cantiere)" : "Altre voci di questo SAL (economie e noli, prezzo già netto)", S.HDR);
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
  if (!alt.length) { R.c(rr, 1, tipo === "sub" ? "Nessuna ora in economia in questa contabilità." : "Nessuna altra voce in questo SAL.", S.NOTA); rr++; }
  R.c(rAvsF, 1, tipo === "sub" ? "+ Economie di questa contabilità" : "+ Altre voci di questo SAL", S.TXT);
  R.c(rAvsF, 2, avSal, S.EUR, alt.length ? "SUM(G" + avDa + ":G" + avA + ")" : "0");
  R.c(rAvsF, 3, avSal, S.EUR); R.c(rAvsF, 4, 0, S.EUR, "B" + rAvsF + "-C" + rAvsF);
  rr++;
  R.c(rr, 1, "Preparato con TIX™. La verifica e l’approvazione spettano alla Direzione Lavori.", S.NOTA);

  // ---- pacchetto xlsx
  const fogli = [R, A, L, T];
  const dataDoc = (String(sal.periodo_a || "2026-01-01").slice(0, 10) || "2026-01-01") + "T00:00:00Z";
  const f = [];
  const add = (n, testo) => f.push({ n, d: ENC.encode(testo) });
  // 10/11/2026 (Filippo): in testata il logo dell'impresa cliente (o il suo nome), a piè di pagina a destra il logo TIX.
  // Sono immagini di testata e piè di pagina: si vedono in stampa, nell'anteprima di stampa e in «Layout di pagina».
  const li = d.logo && d.logo.file && (d.logo.ext === "png" || d.logo.ext === "jpeg") ? d.logo : null;
  const nomeImp = String(d.azienda_nome || "").trim();
  let liW = 0, liH = 0;
  if (li) { liH = 36; liW = liH * li.w / li.h; if (liW > 180) { liW = 180; liH = liW * li.h / li.w; } }
  const tH = 18, tW = Math.round(tH * LOGO_PDF.w / LOGO_PDF.h * 100) / 100;
  const hf = (li ? "<oddHeader>" + xe("&L&G") + "</oddHeader>" : nomeImp ? "<oddHeader>" + xe("&L&B&12" + nomeImp.replace(/&/g, "&&")) + "</oddHeader>" : "") +
    "<oddFooter>" + xe("&LPagina &P di &N&R&G") + "</oddFooter>";
  const forma = (id, sp, w, h, rid, tit) => '<v:shape id="' + id + '" o:spid="_x0000_s' + sp + '" type="#_x0000_t75" style="position:absolute;margin-left:0;margin-top:0;width:' +
    (Math.round(w * 100) / 100) + "pt;height:" + (Math.round(h * 100) / 100) + 'pt;z-index:' + (id === "LH" ? 1 : 2) + '"><v:imagedata o:relid="' + rid + '" o:title="' + tit + '"/><o:lock v:ext="edit" rotation="t"/></v:shape>';
  const vml = (n) => '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">' +
    '<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="' + n + '"/></o:shapelayout>' +
    '<v:shapetype id="_x0000_t75" coordsize="21600,21600" o:spt="75" o:preferrelative="t" path="m@4@5l@4@11@9@11@9@5xe" filled="f" stroked="f"><v:stroke joinstyle="miter"/><v:formulas>' +
    ["if lineDrawn pixelLineWidth 0", "sum @0 1 0", "sum 0 0 @1", "prod @2 1 2", "prod @3 21600 pixelWidth", "prod @3 21600 pixelHeight", "sum @0 0 1", "prod @6 1 2",
      "prod @7 21600 pixelWidth", "sum @8 21600 0", "prod @7 21600 pixelHeight", "sum @10 21600 0"].map((e) => '<v:f eqn="' + e + '"/>').join("") +
    '</v:formulas><v:path o:extrusionok="f" gradientshapeok="t" o:connecttype="rect"/><o:lock v:ext="edit" aspectratio="t"/></v:shapetype>' +
    (li ? forma("LH", n * 1024 + 1, liW, liH, "rId1", "Logo dell'impresa") : "") + forma("RF", n * 1024 + 2, tW, tH, "rId2", "TIX") + "</xml>";
  add("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/><Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
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
    "<dc:title>" + xe(titoloDoc(sal, N) + " - " + (ca.nome || "")) + "</dc:title><dc:creator>TIX</dc:creator>" +
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
  fogli.forEach((x, i) => add("xl/worksheets/sheet" + (i + 1) + ".xml", x.xml(i === 0, hf)));
  // loghi: un disegno VML per foglio (testata e piè di pagina), le immagini in xl/media
  if (li) f.push({ n: "xl/media/logo-impresa." + li.ext, d: li.file });
  f.push({ n: "xl/media/logo-tix.png", d: logoTixPng() });
  fogli.forEach((x, i) => {
    const n = i + 1;
    add("xl/worksheets/_rels/sheet" + n + ".xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawing' + n + '.vml"/></Relationships>');
    add("xl/drawings/vmlDrawing" + n + ".vml", vml(n));
    add("xl/drawings/_rels/vmlDrawing" + n + ".vml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      (li ? '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo-impresa.' + li.ext + '"/>' : "") +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo-tix.png"/></Relationships>');
  });
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
    "<style>" + STILE + SUB_STILE + "</style></head><body>" +
    "<header>" + (d.logo_html || '<div class="marchio">TIX · Diario di cantiere</div>') +
    '<div class="centro"><h1>SAL</h1><p>' + e(cant.nome || "") + (cant.ubicazione ? " &middot; " + e(cant.ubicazione) : "") + "</p></div>" + logoImpresa + "</header>" +
    '<main><a class="indietro" href="' + e(torna) + '">&larr; Torna al cantiere</a>' +
    (d.chiuso ? '<div class="avviso">Cantiere chiuso: il SAL resta consultabile, non si scrivono misure nuove.</div>' : "") +
    '<div id="sal-testa"></div>' +
    '<nav class="sal-tab" role="tablist" aria-label="Sezioni del SAL">' +
    '<button type="button" role="tab" data-s="avanzamento">Avanzamento</button><button type="button" role="tab" data-s="sal">SAL</button>' +
    '<button type="button" role="tab" data-s="contratto">Contratto</button><button type="button" role="tab" data-s="computo">Computo</button>' +
    '<button type="button" role="tab" data-s="subappalti" id="tab-sub" hidden>Subappaltatori &rsaquo;</button></nav>' +
    '<section id="sal-corpo" class="sal-corpo" aria-live="polite"></section>' +
    '<p class="nota">TIX™ prepara il SAL dell’impresa: la verifica e l’approvazione spettano alla Direzione Lavori. ' +
    'Gli importi sono visibili solo a chi entra nell’area riservata dell’impresa e non vengono mai mandati a nessuno da TIX.</p>' +
    '<noscript><p class="nota"><b>Per usare il SAL serve JavaScript attivo nel browser.</b></p></noscript></main>' +
    '<dialog id="dlg" aria-labelledby="dlg-t"><form method="dialog" id="dlg-f" novalidate><div class="dl-t"><h2 id="dlg-t"></h2><p id="dlg-s"></p></div>' +
    '<div class="dl-c" id="dlg-c"></div><p class="msg" id="dlg-m" aria-live="polite"></p>' +
    '<div class="dl-b"><button type="button" class="no" id="dlg-no">Chiudi</button><button type="submit" class="si" id="dlg-si">Salva</button></div></form></dialog>' +
    '<div id="sal-avviso" class="sal-toast" role="status" hidden></div>' +
    "<script>window.SAL_C=" + cfg + ";window.SAL_D=" + dati + ";</script><script>" + SUB_APP + "</script><script>" + APP + "</script></body></html>";
}

// ---------------------------------------------------------------------------- pagina «Subappaltatori» (10/11/2026)
// Filippo: «Io devo avere un'icona con scritto subappaltatori»: il pulsante nella pagina del cantiere (subIniezione in
// subappalti.js) apre questa pagina, con l'elenco dei subappaltatori di quel cantiere. Stessa app della scheda (SUB_APP),
// da sola; il database decide chi entra (sub_pulsante → _sub_accesso: SAL acceso, subappalti_attivo, cantiere non cancellato).
async function rottaSubappaltatori(request, env, base, inUrl, h) {
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const m = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  if (!m) return Response.redirect(inUrl.origin + base + "/", 303);
  const tok = m[0].toLowerCase();
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase().replace(/[^0-9a-f-]/g, "").slice(0, 36);
  if (!UUID.test(c)) return Response.redirect(inUrl.origin + base + "/?t=" + tok, 303);
  const torna = base + "/?t=" + tok + "&c=" + c;
  if (env.SUBAPPALTI === "off") return Response.redirect(inUrl.origin + torna, 303);
  const d = await h.rpc(env, "sub_pulsante", { p_token: tok, p_commessa: c }, 15000).catch(() => null);
  if (!d) {
    return h.risposta(h.foglio(base, "Subappaltatori", "", '<p class="err">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p>' +
      '<p class="piede"><a href="' + h.esc(torna) + '">&larr; Torna al cantiere</a></p>'), 503);
  }
  if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (d.esito !== "ok" || d.attiva !== true) return Response.redirect(inUrl.origin + torna, 303);
  return new Response(metodo === "HEAD" ? null : paginaSubappaltatori(base, tok, c, d, h), { status: 200, headers: h.headers() });
}

function paginaSubappaltatori(base, tok, c, d, h) {
  const e = h.esc;
  const cant = d.cantiere || {};
  const torna = base + "/?t=" + tok + "&c=" + c;
  const logoImpresa = d.logo_impresa
    ? '<div class="dx"><div class="logo-impresa"><img src="' + e(d.logo_impresa) + '" alt="' + e(d.azienda_nome || "") + '"></div></div>'
    : '<div class="dx"></div>';
  const cfg = JSON.stringify({ u: base + "/sal", t: tok, c: c, torna: torna, s: "subappalti", solo: true }).replace(/</g, "\\u003c");
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">' +
    "<title>Subappaltatori - " + e(cant.nome || "") + "</title>" + h.testa(base) +
    // colore dei subappalti (terracotta) al posto del viola del SAL
    "<style>" + STILE + SUB_STILE + ":root{--sal:#B5523B;--sal-s:#8A3A27;--sal-c:#FBF0EC;--sal-b:#EBC9BE}</style></head><body>" +
    "<header>" + (d.logo_html || '<div class="marchio">TIX · Diario di cantiere</div>') +
    '<div class="centro"><h1>Subappaltatori</h1><p>' + e(cant.nome || "") + (cant.ubicazione ? " &middot; " + e(cant.ubicazione) : "") + "</p></div>" + logoImpresa + "</header>" +
    '<main><a class="indietro" href="' + e(torna) + '">&larr; Torna al cantiere</a>' +
    (d.chiuso ? '<div class="avviso">Cantiere chiuso: i subappalti restano da consultare, non si scrivono misure nuove.</div>' : "") +
    '<section id="sal-corpo" class="sal-corpo" aria-live="polite"></section>' +
    '<p class="nota">Prezzi e contabilità dei subappaltatori si vedono solo nell’area riservata dell’impresa. Ogni subappaltatore, con il suo link, vede solo le sue voci. ' +
    'TIX non manda niente a nessuno: il link lo mandi tu.</p>' +
    '<noscript><p class="nota"><b>Per usare questa pagina serve JavaScript attivo nel browser.</b></p></noscript></main>' +
    '<div id="sal-avviso" class="sal-toast" role="status" hidden></div>' +
    "<script>window.SAL_C=" + cfg + ";</script><script>" + SUB_APP + "</script></body></html>";
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
  // proposte dal cantiere (fase 2) e curva prevista / reale
  ".pr-el{list-style:none;margin:0;padding:0}.pr-it{border:1px solid var(--sal-b);border-radius:12px;padding:10px 12px;margin:0 0 10px;background:#FCFAFF}" +
  ".pr-t{font-size:.86rem;color:#5b5470}.pr-it blockquote{margin:6px 0;padding:6px 10px;border-left:3px solid #25D366;background:#F6FFF9;border-radius:6px;font-size:.92rem}" +
  ".pr-v{font-size:.92rem}.pr-q{font-weight:800;color:#3d1a6e}.pr-dm{font-weight:800;color:var(--avv)}.pr-f a{margin-right:10px;color:var(--sal-s);font-weight:700;font-size:.88rem}" +
  ".curva svg{display:block;width:100%;height:auto}.cu-l{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:.88rem;margin:8px 0 0}" +
  ".cu-p::before,.cu-r::before{content:\"\";display:inline-block;width:20px;height:0;vertical-align:middle;margin-right:6px}" +
  ".cu-p::before{border-top:2px dashed #8a94a0}.cu-r::before{border-top:3px solid var(--sal)}" +
  // fase 3: varianti, traguardi dal cronoprogramma, copia firmata
  "dialog.largo{width:min(980px,96vw)}dialog table.av th{position:static}.b.ok{border-color:#0B5E37;color:#0B5E37;background:#E6F6EC}" +
  ".tg .tg-cr{grid-column:1/-1;margin:-2px 0 6px;font-size:.82rem;color:#5b5470}.tg .tg-cr .b{min-height:32px;padding:0 10px;margin-left:8px}" +
  ".sc-cr{display:flex;gap:8px;align-items:flex-start;font-weight:600;padding:8px 10px;border:1px solid #E1E6E3;border-radius:10px;cursor:pointer}.sc-cr small{display:block;font-weight:400;color:#6b7280}" +
  ".ver{list-style:none;margin:0;padding:0}.ver li{padding:6px 0;border-top:1px solid #eee;font-size:.9rem}.ver li .b{min-height:34px;margin-left:8px}" +
  "table.cf tr.cf-nuova td{background:#F0FBF4}table.cf tr.cf-tolta td{background:#FEF2F2;color:#7f1d1d}" +
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
var scheda=C.s||ls('sal_scheda')||'avanzamento';if(scheda==='subappalti')scheda='avanzamento';if(!K||!CL||!(CL.voci||[]).length)scheda=C.s||'computo';
var IMP=null,impId=D.import?D.import.id:null,impTutte=false,impTimer=null,impGiri=0;
var filtro='tutte',cerca='';
var chiusi={};

function tutto(){K=D.computo||null;CL=D.calcolo||null;CO=CL?CL.conto:null;testa();schede();corpo();}

function testa(){
  var h='';
  if(D.avviso)h+='<a class="s-avv" href="#" data-vai="sal">'+es(D.avviso.testo)+'</a>';
  if(CO){var p=Math.max(0,Math.min(100,Number(CO.pct)||0));
    var F=D.fase||{},tb=D.bozza?(D.bozza.tipo||'sal'):'',t3='Prossimo SAL',s3=regola();
    var prox=D.bozza?'n. '+D.bozza.numero+(D.bozza.versione>1?' (v. '+D.bozza.versione+')':'')+' in preparazione':(D.prossimo?'n. '+D.prossimo.numero:'');
    if(tb==='finale'||tb==='svincolo'){t3=tb==='finale'?'Conto finale':'Svincolo delle ritenute';prox='in preparazione';s3='';}
    else if(F.svincolo){t3='Contabilità';prox='chiusa';s3='conto finale e svincolo emessi';}
    else if(F.finale){t3='Conto finale';prox='emesso';s3='lavori finiti il '+di(F.finale.data_fine_lavori||F.finale.periodo_a);}
    h+='<div class="s-cifre"><div class="s-cifra"><small>Contratto</small><b>'+eur(CO.base_contratto)+' €</b><span>computo v. '+es(K.versione)+': '+eur(CO.importo_computo)+' €</span></div>'+
      '<div class="s-cifra"><small>Fatto a oggi</small><b>'+eur(CO.lavori)+' €</b><span>'+pc(CO.pct)+' del computo</span><div class="s-barra"><i style="width:'+p.toFixed(1)+'%"></i></div></div>'+
      '<div class="s-cifra"><small>'+t3+'</small><b>'+es(prox)+'</b><span>'+es(s3)+'</span></div></div>';}
  $('#sal-testa').innerHTML=h;
}
function regola(){if(!K)return '';var c=K.cadenza_sal;return c==='mensile'?'SAL mensile':c==='soglia'?'ogni '+eur(K.soglia_sal_importo)+' € di lavori':c==='traguardi'?'a traguardi':c==='fine_lavori'?'unico a fine lavori':'regola dei SAL da scegliere';}
function schede(){[].forEach.call(document.querySelectorAll('.sal-tab button'),function(b){b.setAttribute('aria-selected',b.getAttribute('data-s')===scheda?'true':'false');});}
function corpo(){var el=$('#sal-corpo');
  if(scheda==='subappalti'){if(window.SUB_MOSTRA)window.SUB_MOSTRA(el);else el.innerHTML='';return;}
  if(scheda==='avanzamento')el.innerHTML=avanzamento();else if(scheda==='sal')el.innerHTML=salTab();else if(scheda==='contratto')el.innerHTML=contratto();else el.innerHTML=computo();
  if(scheda==='contratto')legaContratto();if(scheda==='avanzamento')curvaSegui();}

// ---------------- avanzamento
function voceVisibile(v){
  if(filtro==='lavori'&&!(Number(v.qt)||Number(v.qp)))return false;
  if(filtro==='oltre'&&!v.oltre)return false;
  if(cerca){var s=(v.nr+' '+(v.t||'')+' '+(v.d||'')+' '+(v.dl||'')).toLowerCase();var p=cerca.split(/\s+/);for(var i=0;i<p.length;i++)if(p[i]&&s.indexOf(p[i])<0)return false;}
  return true;}
// ---------------- proposte dal cantiere (fase 2)
function proposteHtml(){var pp=D.proposte||[];if(!pp.length)return '';
  var h='<div class="pann"><h2>Proposte dal cantiere ('+pp.length+')</h2><p class="nota" style="margin:0 0 10px">TIX le ha lette nei messaggi WhatsApp (sezioni LAV e SAL) e nei rapportini dell’ufficio. Entrano nel SAL solo quelle che confermi.</p><ul class="pr-el">';
  pp.forEach(function(p){
    var cosa=p.q!=null?'<span class="pr-q">'+qt(p.q)+' '+es(p.u||'')+'</span>':(p.pct!=null?'<span class="pr-q">'+pc(p.pct)+' a oggi</span>':'<span class="pr-dm">quantità da misurare</span>');
    h+='<li class="pr-it"><div class="pr-t"><b>'+di(p.data)+'</b> · '+es(p.autore||'')+' · '+(p.fonte==='rapportino'?'rapportino dell’ufficio':'WhatsApp')+'</div>'+
      '<blockquote>«'+es(p.testo||'')+'»</blockquote>'+
      '<div class="pr-v"><b>Voce '+es(p.nr)+'</b> · '+es(p.dl||p.d||'')+'<br>'+cosa+(p.luogo?' · '+es(p.luogo):'')+(p.stato_lav?' · '+es(String(p.stato_lav).replace('_',' ')):'')+'</div>'+
      ((p.foto||[]).length?'<div class="pr-f">'+p.foto.map(function(f,i){return '<a href="'+es(f)+'" target="_blank" rel="noopener noreferrer">&#128247; foto '+(i+1)+'</a>';}).join('')+'</div>':'')+
      (D.chiuso?'':'<div class="riga-b"><button type="button" class="b pr" data-pconf="'+es(p.id)+'">Conferma</button><button type="button" class="b" data-pcorr="'+es(p.id)+'">Correggi</button><button type="button" class="b ro" data-pscarta="'+es(p.id)+'">Scarta</button></div>')+'</li>';});
  return h+'</ul></div>';}
function proposta(id){var a=D.proposte||[];for(var i=0;i<a.length;i++)if(a[i].id===id)return a[i];return null;}

// ---------------- curva dei lavori previsti contro quelli reali
var MESI=['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'],curvaChiesta=false,curvaGiri=0;
function curvaHtml(){var cu=D.curva;if(!cu||!cu.punti||!cu.punti.length)return '';
  var pts=cu.punti,base=Number(cu.base)||0,conPrev=pts.some(function(p){return p[1]!=null;});
  // il disegno ha la larghezza dello schermo (sul telefono le scritte restano leggibili)
  var W=Math.round(Math.min(640,Math.max(300,(window.innerWidth||640)-64))),H=W<480?190:230,ml=40,mr=10,mt=10,mb=28,t0=Date.parse(pts[0][0]),t1=Date.parse(pts[pts.length-1][0]);if(!(t1>t0))t1=t0+864e5;
  var ymax=base;pts.forEach(function(p){if(p[1]!=null)ymax=Math.max(ymax,Number(p[1]));if(p[2]!=null)ymax=Math.max(ymax,Number(p[2]));});ymax=ymax>0?ymax*1.04:1;
  var x=function(d){return ml+(Date.parse(d)-t0)/(t1-t0)*(W-ml-mr);},y=function(v){return mt+(1-v/ymax)*(H-mt-mb);};
  var s='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Lavori previsti e lavori fatti nel tempo">';
  [0,25,50,75,100].forEach(function(q){var v=base*q/100,yy=y(v).toFixed(1);s+='<line x1="'+ml+'" x2="'+(W-mr)+'" y1="'+yy+'" y2="'+yy+'" stroke="#E6E9E7"/><text x="'+(ml-6)+'" y="'+(Number(yy)+4)+'" font-size="11" text-anchor="end" fill="#6b7280">'+q+'%</text>';});
  var mesi=pts.filter(function(p){return /-(28|29|30|31)$/.test(p[0])&&p[0]!==cu.oggi;}),passo=Math.max(1,Math.ceil(mesi.length/(W<480?4:8)));
  mesi.forEach(function(p,i){if(i%passo)return;var d=new Date(p[0]+'T12:00:00');s+='<text x="'+x(p[0]).toFixed(1)+'" y="'+(H-10)+'" font-size="11" text-anchor="middle" fill="#6b7280">'+MESI[d.getMonth()]+(d.getMonth()===0||i===0?' '+String(d.getFullYear()).slice(2):'')+'</text>';});
  var xo=x(cu.oggi).toFixed(1);s+='<line x1="'+xo+'" x2="'+xo+'" y1="'+mt+'" y2="'+(H-mb)+'" stroke="#C9B6EC" stroke-dasharray="3 3"/><text x="'+xo+'" y="'+(mt+10)+'" font-size="11" text-anchor="middle" fill="#6B2FB3">oggi</text>';
  var linea=function(i,stile){var d=pts.filter(function(p){return p[i]!=null;}).map(function(p,k){return (k?'L':'M')+x(p[0]).toFixed(1)+' '+y(Number(p[i])).toFixed(1);}).join(' ');return d?'<path d="'+d+'" fill="none" '+stile+'/>':'';};
  if(conPrev)s+=linea(1,'stroke="#8a94a0" stroke-width="2" stroke-dasharray="6 4"');
  s+=linea(2,'stroke="#9146DB" stroke-width="3" stroke-linejoin="round"')+'</svg>';
  var po=cu.previsto_oggi,fo=Number(cu.reale_oggi)||0,h='<div class="pann curva"><h2>Andamento: lavori previsti e lavori fatti</h2>'+s+
    '<div class="cu-l">'+(conPrev?'<span class="cu-p">Previsto dal cronoprogramma</span>':'')+'<span class="cu-r">Fatto (misure confermate)</span></div>'+
    '<div class="s-cifre" style="margin-top:10px">'+(po!=null?'<div class="s-cifra"><small>Previsto a oggi</small><b>'+eur(po)+' €</b><span>'+pc(base?po/base*100:0)+' del computo</span></div>':'')+
    '<div class="s-cifra"><small>Fatto a oggi</small><b>'+eur(fo)+' €</b><span>'+pc(base?fo/base*100:0)+' del computo</span></div>'+
    (po!=null?'<div class="s-cifra"><small>'+(fo>=po?'Avanti di':'Indietro di')+'</small><b>'+eur(Math.abs(fo-po))+' €</b><span>rispetto al cronoprogramma</span></div>':'')+'</div>';
  if(cu.pesi==='importi')h+='<p class="nota" style="margin-bottom:0">Previsto: gli importi delle voci del computo distribuiti sulle attività del cronoprogramma ('+es(cu.voci_collegate)+' voci collegate da TIX; il resto in proporzione alla durata). <a href="#" id="cu-rifai">Rifai il collegamento</a></p>';
  else if(cu.pesi==='durata'||cu.pesi==='in_corso')h+='<p class="nota" style="margin-bottom:0">Previsto provvisorio, in proporzione alla durata delle attività: TIX sta collegando le voci del computo alle attività del cronoprogramma (meno di un minuto).</p>';
  else h+='<p class="nota" style="margin-bottom:0">Per vedere i lavori previsti carica il cronoprogramma del cantiere: <a href="'+es(C.torna.replace('/?t=','/cronoprogramma?t='))+'">Cronoprogramma</a>.</p>';
  return h+'</div>';}
function curvaSegui(){var cu=D.curva;if(!cu||D.chiuso)return;
  if(cu.pesi==='durata'&&cu.programma&&!curvaChiesta){curvaChiesta=true;api('curva_prepara',{dati:{}}).then(function(r){if(r&&r.esito==='ok'&&r.stato!=='fatto')setTimeout(curvaAttendi,20000);});}
  else if(cu.pesi==='in_corso'&&!curvaGiri)setTimeout(curvaAttendi,20000);}
function curvaAttendi(){if(++curvaGiri>9)return;ricarica().then(function(){if(D.curva&&D.curva.pesi==='in_corso')setTimeout(curvaAttendi,20000);});}

function avanzamento(){
  if(!K||!CL||!(CL.voci||[]).length)return '<div class="pann"><h2>Prima serve il computo</h2><p>Per misurare l’avanzamento il cantiere deve avere il computo metrico del contratto. Apri la scheda «Computo».</p></div>';
  var h=proposteHtml()+curvaHtml()+'<div class="pann"><div class="strum"><input type="search" id="cerca" placeholder="Cerca una voce: numero, tariffa o parole" value="'+es(cerca)+'" autocomplete="off">'+
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
function finestra(t,s,c,etich,fn,rosso,largo){$('#dlg-t').textContent=t;$('#dlg-s').textContent=s||'';$('#dlg-c').innerHTML=c;$('#dlg-m').textContent='';
  var b=$('#dlg-si');b.textContent=etich||'Salva';b.className='si'+(rosso?' rosso':'');b.disabled=false;b.hidden=!fn;dlgAzione=fn;var d=$('#dlg');d.classList.toggle('largo',!!largo);if(d.showModal)d.showModal();else d.setAttribute('open','');}
function chiudi(){var d=$('#dlg');if(d.close)d.close();else d.removeAttribute('open');}
function salvando(p){var b=$('#dlg-si');b.disabled=true;$('#dlg-m').textContent='';
  return p.then(function(r){b.disabled=false;if(r&&r.esito==='ok'){chiudi();return ricarica().then(function(){return r;});}$('#dlg-m').textContent=errore(r);return null;});}

function misura(v,m,prop){
  if(D.chiuso){avviso('Il cantiere è chiuso.');return;}
  m=m||{};var oggi=D.oggi;var dims=m.pu!=null||m.l!=null||m.w!=null||m.h!=null;
  // proposta dal cantiere: si parte da quello che dice il messaggio e si può cambiare anche la voce
  if(prop&&!m.prefill)m={data:prop.data,q:prop.q,pct:prop.pct,luogo:prop.luogo,descrizione:prop.descrizione,prefill:1};
  var c=(prop?'<p class="nota" style="margin:0">Dal cantiere: «'+es(prop.testo||'')+'»</p><label>Voce del computo<select id="m-voce">'+
      (CL.voci||[]).map(function(x){return '<option value="'+es(x.id)+'"'+(x.id===v.id?' selected':'')+'>'+es(x.nr)+' · '+es(x.d)+' ('+es(x.u)+')</option>';}).join('')+'</select></label>':'')+
    '<p class="nota" style="margin:0">'+es(v.dl||v.d)+'<br>Prezzo '+eur(v.p)+' € / '+es(v.u)+' · contratto '+qt(v.qc)+' · a oggi '+qt(v.qt)+(v.pct!=null?' ('+pc(v.pct)+')':'')+'</p>'+
    '<label>Giorno<input type="date" id="m-data" max="'+es(oggi)+'" value="'+es(m.data||oggi)+'"></label>';
  if(v.perc&&Number(v.qc)>0){var att=Number(v.qc)>0?(Number(v.qt)||0)/Number(v.qc)*100:0;
    c+='<label>Avanzamento della voce a oggi <small>(in %, ora '+pc(att)+')</small><input type="text" id="m-pct" inputmode="decimal" placeholder="es. 40" value="'+(m.pct!=null?es(String(m.pct).replace('.',',')):'')+'"></label>'+
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
  finestra((prop?'Conferma la proposta · ':(m.id?'Modifica misura · ':'Nuova misura · '))+v.nr+' '+v.d,v.oltre?'Attenzione: questa voce è già oltre il computo.':'',c,prop?'Conferma la misura':'Salva la misura',function(){
    var d={voce_id:v.id,data:$('#m-data').value,luogo:$('#m-luogo').value,descrizione:$('#m-descr').value,autore:$('#m-autore').value};
    if(m.id)d.id=m.id;ls('sal_autore',d.autore);
    if($('#m-pct')){d.pct=$('#m-pct').value;}
    else if(document.querySelector('input[name=m-modo]:checked').value==='d'){d.pu=$('#m-pu').value;d.l=$('#m-l').value;d.w=$('#m-w').value;d.h=$('#m-h').value;d.meno=$('#m-meno').checked;}
    else{d.q=$('#m-q').value;d.meno=$('#m-meno').checked;}
    if(prop){d.azione='conferma';return salvando(api('proposta',{id:prop.id,dati:d})).then(function(r){if(r)avviso('Misura confermata: '+qt(r.quantita)+' '+v.u);});}
    return salvando(api('misura',{dati:d})).then(function(r){if(r)avviso('Misura salvata: '+qt(r.quantita)+' '+v.u);});});
  if(prop)$('#m-voce').addEventListener('change',function(){var nv=voce(this.value);if(!nv)return;
    var cur={data:$('#m-data').value,luogo:$('#m-luogo').value,descrizione:$('#m-descr').value,prefill:1};chiudi();misura(nv,cur,prop);});
  var ri=function(){var a=['m-pu','m-l','m-w','m-h'].map(function(i){var x=$('#'+i);return x?nu(x.value):null;});var t=1,uno=false;a.forEach(function(x){if(x!==null&&!isNaN(x)){t*=x;uno=true;}});
    var el=$('#m-calc');if(el)el.textContent=uno?'Quantità: '+qt(Math.round(t*100)/100)+' '+v.u:'';};
  ['m-pu','m-l','m-w','m-h'].forEach(function(i){var x=$('#'+i);if(x)x.addEventListener('input',ri);});ri();
  [].forEach.call(document.querySelectorAll('input[name=m-modo]'),function(r){r.addEventListener('change',function(){var d=this.value==='d';$('#m-lq').hidden=d;$('#m-ld').hidden=!d;});});
}

// ---------------- SAL
function statoSal(s){return {emesso:['Emesso','em'],firmato_impresa:['Firmato dall’impresa','fi'],visto_dl:['Visto dalla DL','ok'],sostituito:['Sostituito','no'],annullato:['Annullato','no']}[s]||[s,'no'];}
function nomeDoc(tp,n,v){return (tp==='finale'?'Conto finale':tp==='svincolo'?'Svincolo delle ritenute':'SAL n. '+n)+(v>1?' (v. '+v+')':'');}
function contoHtml(co){if(!co)return '';var tr=co.traguardo&&co.traguardo.modo==='percentuale'?co.traguardo:null,tp=co.tipo||'sal';
  var r=function(t,v,cl,sub){return '<tr'+(cl?' class="'+cl+'"':'')+'><td>'+t+(sub?' <span class="sub">'+sub+'</span>':'')+'</td><td class="n">'+eur(v)+' €</td></tr>';};
  var h='<table class="conto">';
  if(tr){h+=r('Traguardo «'+es(tr.nome)+'»: '+pc(tr.percentuale)+' del contratto',Number(co.netto)-Number(co.altre_voci),'','in tutto '+pc(tr.cumulata)+' di '+eur(co.base_contratto)+' €');
    h+=r('Per informazione: lavori misurati a oggi',co.lavori,'','');}
  else{h+=r('Lavori a misura a oggi',co.lavori_misura);if(Number(co.lavori_corpo))h+=r('Lavori a corpo a oggi',co.lavori_corpo);
    h+=r('Totale lavori a oggi',co.lavori,'tot','di cui in questo periodo '+eur(co.lavori_periodo)+' €');
    h+=r('− Ribasso '+pc(co.ribasso_pct),co.ribasso);
    h+=r('+ Oneri della sicurezza',co.sicurezza,'',co.sicurezza_modo==='nei_prezzi'?'compresi nei prezzi':co.sicurezza_modo==='voci'?'nelle voci non ribassabili':'in proporzione ai lavori');}
  if(Number(co.altre_voci))h+=r('+ Altre voci a oggi (economie e noli)',co.altre_voci,'',Number(co.altre_voci_sal)?'di cui in questo SAL '+eur(co.altre_voci_sal)+' €':'');
  h+=r('= Lavori netti a oggi',co.netto,'tot')+r(tp==='svincolo'?'− Ritenuta a garanzia: non si trattiene più (svincolo)':'− Ritenuta a garanzia '+pc(co.ritenuta_pct),co.ritenuta,'',tp==='finale'?'trattenuta fino allo svincolo':'');
  if(Number(co.anticipazione))h+=r('− Recupero dell’anticipazione'+(tp==='sal'?'':' (per intero)'),co.recupero,'','anticipazione '+eur(co.anticipazione)+' €');
  h+=r('= Spettanza a oggi',co.spettanza,'tot')+r('− SAL già emessi',co.precedenti);
  h+='<tr class="fin"><td>'+(tp==='finale'?'Saldo del conto finale (ritenute escluse)':tp==='svincolo'?'Ritenute da svincolare':'Importo di questo SAL')+'</td><td class="n">'+eur(co.dovuto)+' € + IVA</td></tr></table>';
  if(tp==='finale')h+='<p class="nota">Ritenute di garanzia trattenute: <b>'+eur(co.ritenute_trattenute)+' €</b>. Si svincolano dopo il collaudo o il certificato di regolare esecuzione.</p>';
  return h;}
function salTab(){
  if(!K||!CL||!(CL.voci||[]).length)return '<div class="pann"><h2>Prima serve il computo</h2><p>Apri la scheda «Computo».</p></div>';
  var h='',b=D.bozza,F=D.fase||{},xl=C.u+'/excel?t='+C.t+'&c='+C.c,pf=C.u+'/pdf?t='+C.t+'&c='+C.c,dis=D.chiuso?' disabled':'',av=D.avviso;
  // traguardo preso dal cronoprogramma: l'attività risulta conclusa
  if(av&&av.tipo==='traguardo_crono'&&!D.chiuso)h+='<div class="pann"><h2>Traguardo dal cronoprogramma</h2><p>'+es(av.testo)+'</p><div class="campi"><label>Raggiunto il<input type="date" id="tgr-d" max="'+es(D.oggi)+'" value="'+es(av.data||D.oggi)+'"></label></div>'+
    '<div class="riga-b"><button type="button" class="b pr" data-tgr="'+es(av.traguardo_id)+'">Segna il traguardo raggiunto</button></div></div>';
  if(b){var trs=D.traguardi||[],tp=b.tipo||'sal';
    h+='<div class="pann"><h2>'+nomeDoc(tp,b.numero,b.versione)+' — bozza</h2>'+
      (b.versione>1&&b.motivo?'<p class="avviso">Nuova versione: '+es(b.motivo)+'</p>':'')+
      (tp==='finale'?'<p>Il conto finale chiude la contabilità: tutte le misure fino alla fine dei lavori, l’anticipazione recuperata per intero, le ritenute trattenute fino allo svincolo.</p>':
       tp==='svincolo'?'<p>Dopo il collaudo, o il certificato di regolare esecuzione, la ritenuta non si trattiene più: questo documento chiede le ritenute trattenute nei SAL e nel conto finale.</p>':'')+
      '<div class="campi">'+
      (tp==='finale'?'<label>Lavori finiti il<input type="date" id="b-fine" min="'+es(b.periodo_da)+'" max="'+es(D.oggi)+'" value="'+es(b.data_fine_lavori||b.periodo_a)+'"'+dis+'></label>':
       tp==='svincolo'?'<label>Documento<select id="b-ct"'+dis+'><option value="collaudo"'+(b.collaudo_tipo!=='cre'?' selected':'')+'>collaudo</option><option value="cre"'+(b.collaudo_tipo==='cre'?' selected':'')+'>certificato di regolare esecuzione</option></select></label>'+
         '<label>Del<input type="date" id="b-dc" min="'+es(b.periodo_a)+'" max="'+es(D.oggi)+'" value="'+es(b.data_collaudo||'')+'"'+dis+'></label>':
       '<label>Lavori dal<input type="date" value="'+es(b.periodo_da)+'" disabled></label><label>Lavori fino al<input type="date" id="b-a" min="'+es(b.periodo_da)+'" max="'+es(D.oggi)+'" value="'+es(b.periodo_a)+'"'+dis+'></label>'+
         (trs.length?'<label>Traguardo<select id="b-tg"'+dis+'><option value="">nessuno</option>'+trs.filter(function(t){return !t.sal;}).map(function(t){return '<option value="'+t.id+'"'+(String(b.traguardo_id)===String(t.id)?' selected':'')+'>'+es(t.nome)+(t.modo==='percentuale'?' ('+pc(t.percentuale)+' del contratto)':'')+'</option>';}).join('')+'</select></label>':''))+'</div>'+
      (tp!=='svincolo'&&CL.misure_dopo?'<p class="nota">'+CL.misure_dopo+(CL.misure_dopo===1?' misura è':' misure sono')+' dopo il '+di(b.periodo_a)+': '+(tp==='finale'?(CL.misure_dopo===1?'non entra':'non entrano')+' nel conto finale. Se il lavoro è stato fatto prima, correggi la data; se no, togli la misura.':(CL.misure_dopo===1?'entrerà':'entreranno')+' nel SAL successivo.')+'</p>':'')+
      '<h3>Conto</h3>'+contoHtml(CO)+
      (tp==='svincolo'?'':'<h3>Altre voci <small>(economie e noli, prezzo già netto)</small></h3><div id="b-av">'+(b.altre_voci||[]).map(rigaAv).join('')+'</div>'+
        (D.chiuso?'':'<button type="button" class="b" id="b-av-agg">+ Aggiungi una riga</button>'))+
      '<label style="margin-top:10px">Note <small>(facoltative, vanno nel documento)</small><textarea id="b-note" maxlength="1000"'+dis+'>'+es(b.note||'')+'</textarea></label>'+
      '<div class="riga-b">'+(D.chiuso?'':'<button type="button" class="b" id="b-salva">Salva la bozza</button>')+
      '<a class="b" href="'+es(C.u+'/documento?t='+C.t+'&id='+b.id)+'" target="_blank" rel="noopener">Anteprima del documento</a>'+
      '<a class="b" href="'+es(pf)+'">Anteprima PDF</a><a class="b ex" href="'+es(xl)+'">Scarica in Excel</a>'+
      (D.chiuso?'':'<button type="button" class="b pr" id="b-emetti">Emetti '+(tp==='finale'?'il conto finale':tp==='svincolo'?'lo svincolo':'il SAL n. '+b.numero)+'</button><button type="button" class="b ro" id="b-scarta">Scarta la bozza</button>')+'</div></div>';}
  else if(F.svincolo){h+='<div class="pann"><h2>Contabilità chiusa</h2><p>Conto finale e svincolo delle ritenute sono emessi: per questo cantiere non si preparano altri SAL. Documenti e copie firmate restano qui sotto.</p></div>';}
  else if(F.finale){var fi=F.finale;
    h+='<div class="pann"><h2>Svincolo delle ritenute di garanzia</h2><p>Conto finale emesso: lavori finiti il '+di(fi.data_fine_lavori||fi.periodo_a)+'. Ritenute trattenute: <b>'+eur(fi.ritenute)+' €</b>. '+
      'Dopo il collaudo, o il certificato di regolare esecuzione, prepara lo svincolo.</p>'+
      (D.chiuso?'':'<div class="campi"><label>Documento<select id="s-ct"><option value="collaudo">collaudo</option><option value="cre">certificato di regolare esecuzione</option></select></label>'+
        '<label>Del<input type="date" id="s-dc" min="'+es(fi.periodo_a)+'" max="'+es(D.oggi)+'"></label></div><div class="riga-b"><button type="button" class="b pr" id="b-svincolo">Prepara lo svincolo</button></div>')+'</div>';}
  else{var p=D.prossimo||{};
    h+='<div class="pann"><h2>Prossimo SAL: n. '+es(p.numero)+(p.versione>1?' (versione '+p.versione+')':'')+'</h2><p>Lavori dal '+di(p.periodo_da)+' al '+di(p.periodo_a)+' (si può cambiare nella bozza). '+
      'Con «Prepara» TIX mette nel SAL tutte le misure confermate fino a quel giorno.</p><h3>Situazione a oggi</h3>'+contoHtml(CO)+
      '<div class="riga-b">'+(D.chiuso?'':'<button type="button" class="b pr" id="b-nuova">Prepara il SAL n. '+es(p.numero)+'</button>')+'<a class="b ex" href="'+es(xl)+'">Scarica in Excel (situazione a oggi)</a></div></div>';
    if(!D.chiuso)h+='<div class="pann"><h2>Fine dei lavori: conto finale</h2><p>Quando i lavori sono finiti, il conto finale chiude la contabilità: mette tutte le misure fino a quel giorno, recupera per intero l’anticipazione e lascia le ritenute fino allo svincolo, dopo il collaudo.</p>'+
      '<div class="campi"><label>Lavori finiti il<input type="date" id="f-fine" max="'+es(D.oggi)+'" value="'+es(D.oggi)+'"></label></div><div class="riga-b"><button type="button" class="b" id="b-finale">Prepara il conto finale</button></div></div>';}
  var wa=D.whatsapp||[];
  if(wa.length)h+='<div class="pann"><h2>Dal cantiere, sezione SAL di WhatsApp</h2><p class="nota" style="margin-top:0">Promemoria: messaggi arrivati dopo l’ultimo SAL. Non entrano nel conto da soli.</p>'+
    wa.map(function(w){return '<div class="wa">'+es(w.testo)+'<br><small>'+es(w.il)+'</small></div>';}).join('')+'</div>';
  var el=D.sal||[];
  h+='<div class="pann"><h2>SAL emessi</h2>';
  if(!el.length)h+='<p class="nota" style="margin:0">Ancora nessuno.</p>';
  else{var ultimo=null;el.forEach(function(s){if(['emesso','firmato_impresa','visto_dl'].indexOf(s.stato)>=0&&(!ultimo||s.numero>ultimo.numero))ultimo=s;});
    h+='<div class="sal-el">';el.forEach(function(s){var st=statoSal(s.stato),vivo=['emesso','firmato_impresa','visto_dl'].indexOf(s.stato)>=0,tps=s.tipo||'sal',nm=es(nomeDoc(tps,s.numero,1));
      h+='<div class="sal-c"><div class="r1"><b>'+es(nomeDoc(tps,s.numero,s.versione))+'</b><span class="st '+st[1]+'">'+es(st[0])+'</span>'+
        '<span>'+(tps==='finale'?'lavori finiti il '+di(s.data_fine_lavori||s.periodo_a):tps==='svincolo'?(s.collaudo_tipo==='cre'?'certificato di regolare esecuzione':'collaudo')+' del '+di(s.data_collaudo):'lavori dal '+di(s.periodo_da)+' al '+di(s.periodo_a))+'</span>'+
        '<span class="imp" style="margin-left:auto">'+eur(s.dovuto)+' € + IVA</span></div>'+
        '<p class="nota" style="margin:6px 0">Emesso il '+es(s.emesso_il||'')+' da '+es(s.emesso_da||'')+(s.firma_impresa?' · firmato da '+es(s.firma_impresa)+' il '+es(s.firma_impresa_il):'')+
        (s.firma_dl?' · visto DL: '+es(s.firma_dl)+' il '+es(s.firma_dl_il)+(s.firma_dl_nota?' («'+es(s.firma_dl_nota)+'»)':''):'')+
        (s.motivo&&!vivo?' · '+es(s.motivo):'')+(s.firmato_nome?' · copia firmata «'+es(s.firmato_nome)+'» caricata il '+es(s.firmato_il||'')+(s.firmato_da?' da '+es(s.firmato_da):''):'')+'</p><div class="riga-b">'+
        '<a class="b" href="'+es(C.u+'/documento?t='+C.t+'&id='+s.id)+'" target="_blank" rel="noopener">Documento</a>'+
        '<a class="b" href="'+es(pf+'&id='+s.id)+'">PDF da firmare</a>'+
        '<a class="b ex" href="'+es(xl+'&id='+s.id)+'">Excel</a>'+
        (s.firmato_nome?'<a class="b ok" href="'+es(C.u+'/firmato?t='+C.t+'&id='+s.id)+'">Copia firmata</a>':'')+
        (!D.chiuso&&vivo?'<label class="b">'+(s.firmato_nome?'Sostituisci la copia firmata':'Carica la copia firmata')+'<input type="file" class="f-firm" data-id="'+s.id+'" accept=".pdf,.p7m" hidden></label>':'')+
        (!D.chiuso&&s.stato==='emesso'?'<button type="button" class="b" data-st="firmato" data-id="'+s.id+'" data-n="'+nm+'">Segna firmato dall’impresa</button>':'')+
        (!D.chiuso&&(s.stato==='emesso'||s.stato==='firmato_impresa')?'<button type="button" class="b" data-st="visto" data-id="'+s.id+'" data-n="'+nm+'">Segna visto dalla DL</button>':'')+
        (!D.chiuso&&ultimo&&ultimo.id===s.id&&s.stato!=='visto_dl'?'<button type="button" class="b" data-st="riemetti" data-id="'+s.id+'" data-n="'+nm+'">Riemetti con correzioni</button><button type="button" class="b ro" data-st="annulla" data-id="'+s.id+'" data-n="'+nm+'">Annulla</button>':'')+
        '</div></div>';});h+='</div>';}
  return h+'</div>';}
function rigaAv(a){a=a||{};var dis=D.chiuso?' disabled':'';
  return '<div class="av-r"><label>Tipo<select class="a-t"'+dis+'>'+[['economia','Economia'],['nolo','Nolo'],['altro','Altro']].map(function(o){return '<option value="'+o[0]+'"'+(a.tipo===o[0]?' selected':'')+'>'+o[1]+'</option>';}).join('')+'</select></label>'+
    '<label>Descrizione<input type="text" class="a-d" maxlength="300" value="'+es(a.descrizione||'')+'"'+dis+'></label><label>U.M.<input type="text" class="a-u" maxlength="20" value="'+es(a.unita||'')+'"'+dis+'></label>'+
    '<label>Quantità<input type="text" class="a-q" inputmode="decimal" value="'+(a.quantita!=null?es(String(a.quantita).replace('.',',')):'')+'"'+dis+'></label>'+
    '<label>Prezzo €<input type="text" class="a-p" inputmode="decimal" value="'+(a.prezzo!=null?es(String(a.prezzo).replace('.',',')):'')+'"'+dis+'></label>'+
    (D.chiuso?'':'<button type="button" class="b ro x" data-avx="1" aria-label="Togli la riga">×</button>')+'</div>';}
function datiBozza(){var tp=(D.bozza&&D.bozza.tipo)||'sal',d={note:$('#b-note').value};
  if(tp==='sal'){d.periodo_a=$('#b-a').value;var tg=$('#b-tg');if(tg)d.traguardo_id=tg.value;}
  if(tp==='finale')d.data_fine_lavori=$('#b-fine').value;
  if(tp==='svincolo'){d.data_collaudo=$('#b-dc').value;d.collaudo_tipo=$('#b-ct').value;}
  if(tp!=='svincolo'){d.altre_voci=[];
    [].forEach.call(document.querySelectorAll('#b-av .av-r'),function(r){var x={tipo:$('.a-t',r).value,descrizione:$('.a-d',r).value,unita:$('.a-u',r).value,quantita:$('.a-q',r).value,prezzo:$('.a-p',r).value};
      if(x.descrizione||x.quantita||x.prezzo)d.altre_voci.push(x);});}
  return d;}
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
    (D.traguardi||[]).map(rigaTg).join('')+'</div>'+(D.chiuso?'':'<div class="riga-b" style="margin-top:4px"><button type="button" class="b" id="c-tg-agg">+ Aggiungi un traguardo</button>'+
      ((D.cardini||[]).length?'<button type="button" class="b" id="c-tg-crono">+ Dal cronoprogramma ('+(D.cardini||[]).length+')</button>':'')+'</div>')+'</div>'+
    '<h3>Differenza tra computo e contratto</h3><p class="nota" style="margin-top:0">'+diff()+'</p>'+
    '<label>Nota sulla differenza <small>(es. «oneri e lavori in economia previsti a parte»)</small><textarea id="c-nota" maxlength="600"'+d2+'>'+es(k.nota_differenza||'')+'</textarea></label>'+
    '<p class="msg" id="c-msg" style="margin:8px 0 0"></p><div class="riga-b">'+(D.chiuso?'':'<button type="button" class="b pr" id="c-salva">Salva la scheda contratto</button>')+'</div></div>';
  return h;}
function rigaTg(t){t=t||{};var usato=!!t.sal,d=D.chiuso?' disabled':'',du=(usato||D.chiuso)?' disabled':'',cr=t.crono;
  return '<div class="tg" data-id="'+es(t.id||'')+'" data-crono="'+es(t.crono_attivita_id||'')+'"><label>Nome<input type="text" class="t-n" maxlength="120" placeholder="es. fine strutture" value="'+es(t.nome||'')+'"'+d+'></label>'+
    '<label>Come si calcola<select class="t-m"'+du+'><option value="misura"'+(t.modo!=='percentuale'?' selected':'')+'>a misura</option><option value="percentuale"'+(t.modo==='percentuale'?' selected':'')+'>% del contratto</option></select></label>'+
    '<label>%<input type="text" class="t-p" inputmode="decimal" value="'+(t.percentuale!=null?es(String(t.percentuale).replace('.',',')):'')+'"'+du+'></label>'+
    '<label>Prevista<input type="date" class="t-dp" value="'+es(t.data_prevista||'')+'"'+d+'></label><label>Raggiunta il<input type="date" class="t-r" max="'+es(D.oggi)+'" value="'+es(t.raggiunto_il||'')+'"'+d+'></label>'+
    (usato?'<span class="st ok x">SAL n. '+t.sal+'</span>':(D.chiuso?'':'<button type="button" class="b ro x" data-tgx="1" aria-label="Togli il traguardo">×</button>'))+
    (cr?'<p class="tg-cr">Dal cronoprogramma: «'+es(cr.nome)+'», fine prevista '+di(cr.data)+(cr.fatto?(cr.fine_reale?' · concluso il '+di(cr.fine_reale):' · concluso')+
      (t.raggiunto_il||D.chiuso?'':'<button type="button" class="b" data-tgset="'+es(cr.fine_reale||D.oggi)+'">Segna raggiunto</button>'):'')+'</p>':'')+'</div>';}
function diff(){var k=K||{},s=CO?Number(CO.importo_computo):Number(k.importo_computo||0),ct=Number(k.importo_contratto||0);
  if(!ct)return 'Scrivi l’importo del contratto per confrontarlo con la somma del computo.';
  var d=Math.round((ct-s)*100)/100;if(Math.abs(d)<0.01)return '<span class="ok-v">Le somme tornano:</span> computo e contratto valgono entrambi '+eur(ct)+' €.';
  return '<span class="ko-v">Differenza di '+eur(d)+' € ('+pc(s?d/s*100:0)+')</span>: computo '+eur(s)+' €, contratto '+eur(ct)+' €. Non blocca niente, ma conviene scrivere da cosa dipende.';}
function legaContratto(){
  [].forEach.call(document.querySelectorAll('input[name=c-cad]'),function(r){r.addEventListener('change',function(){$('#c-l-soglia').hidden=this.value!=='soglia';if(this.value==='traguardi')$('#c-trag').hidden=false;});});}
function salvaContratto(){var d={tipo_contratto:$('#c-tipo').value,importo_contratto:$('#c-imp').value,ribasso_pct:$('#c-rib').value,ritenuta_pct:$('#c-rit').value,anticipazione_pct:$('#c-ant').value,
  oneri_sicurezza:$('#c-sic').value,sicurezza_modo:$('#c-smodo').value,data_contratto:$('#c-dc').value,termine_ultimazione:$('#c-tu').value,nota_differenza:$('#c-nota').value,
  cadenza_sal:(document.querySelector('input[name=c-cad]:checked')||{}).value||'',soglia_sal_importo:$('#c-soglia').value,traguardi:[]};
  [].forEach.call(document.querySelectorAll('#c-tg .tg'),function(r){var t={id:r.getAttribute('data-id'),nome:$('.t-n',r).value,modo:$('.t-m',r).value,percentuale:$('.t-p',r).value,data_prevista:$('.t-dp',r).value,raggiunto_il:$('.t-r',r).value,
      crono_attivita_id:r.getAttribute('data-crono')||''};
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
  if(k.variante_n)h+='<p class="avviso">Variante n. '+es(k.variante_n)+(k.variante_descrizione?': '+es(k.variante_descrizione):'')+(k.variante_data?' del '+di(k.variante_data):'')+'.</p>';
  if(k.versioni&&k.versioni.length>1)h+='<h3>Versioni</h3><ul class="ver">'+k.versioni.map(function(v){
      return '<li><b>v. '+es(v.versione)+'</b> · '+es(v.stato)+' · '+es(v.creato_il)+
        (v.variante_n?' · <span class="ko-v">variante n. '+es(v.variante_n)+'</span>'+(v.variante_descrizione?': '+es(v.variante_descrizione):'')+(v.variante_data?' del '+di(v.variante_data):''):'')+
        (v.importo_computo!=null?' · computo '+eur(v.importo_computo)+' €':'')+
        (v.versione>1?'<button type="button" class="b" data-conf="'+(v.versione-1)+','+v.versione+'">Confronta con la v. '+(v.versione-1)+'</button>':'')+'</li>';}).join('')+
    '</ul><p class="nota">Una variante diventa sempre una versione nuova: le vecchie restano, con i SAL emessi su di loro.</p>';
  h+='</div>';
  return h;}

// ---------------- caricamento del computo: file → lettura → anteprima → Conferma / Annulla
function caricaHtml(senza){
  if(D.chiuso)return senza?'<div class="pann"><h2>Computo metrico</h2><p>Il cantiere non ha un computo.</p></div>':'';
  if(D.carica_attivo===false)return senza?'<div class="pann"><h2>Computo metrico</h2><p>Il caricamento del computo è sospeso in questo momento: riprova più tardi.</p></div>':'';
  if(D.fase&&D.fase.finale)return K&&K.bloccato?'<div class="pann"><p class="nota" style="margin:0">Il conto finale è emesso: il computo non cambia più.</p></div>':'';
  var vr=!!(K&&K.bloccato);
  var h='<div class="pann k-car"><h2>'+(senza?'Carica il computo metrico':vr?'Carica una variante del computo':'Carica un computo aggiornato')+'</h2>',s=IMP?IMP.stato:'';
  if(!IMP||['errore','annullato','confermato','scaduto','errore_locale'].indexOf(s)>=0){
    h+='<p>'+(senza?'Carica il computo in Excel o in PDF, anche esportato da PriMus. TIX legge voci, quantità e prezzi e ti mostra il controllo delle somme: nulla cambia finché non premi «Conferma».'
        :vr?'Ci sono già SAL emessi: il file nuovo diventa una <b>variante</b>, cioè la versione '+(Number(K.versione)+1)+' del computo. Prima di confermare vedi il confronto voce per voce con la versione di oggi. '+
          'Misure, traguardi e collegamento della curva passano alla versione nuova; i SAL già emessi non cambiano.'
        :'Il file nuovo diventa la versione '+(Number(K.versione)+1)+' del computo e la versione '+es(K.versione)+' resta in archivio. Prima di confermare vedi l’anteprima con il controllo delle somme.')+'</p>'+
      '<div class="riga-b" style="margin:0"><label class="b pr" for="k-file">Scegli il file del computo</label></div>'+
      '<input type="file" id="k-file" accept=".xlsx,.xlsm,.xls,.ods,.csv,.pdf,.dcf" hidden>'+
      '<p class="nota" style="margin-bottom:0">Excel (.xlsx, .xls) o PDF, fino a 18 MB. Da PriMus: esporta il computo in Excel oppure stampalo in PDF (il file .dcf si apre solo con PriMus). '+
        (D.carica_ai?'Anche un PDF scansionato o un formato diverso: lo legge l’intelligenza artificiale, e tu controlli l’anteprima.':'Un PDF scansionato non si legge.')+'</p>';
    if(s==='errore')h+='<div class="k-err">Non sono riuscito a leggere «'+es(IMP.nome_file||'il file')+'»: '+es(IMP.errore||'errore sconosciuto')+'.</div>';
    if(s==='errore_locale')h+='<div class="k-err">'+es(IMP.msg)+'</div>';
  } else if(s==='invio'||s==='ricevuto'||s==='in_lettura'){
    h+='<p class="k-att"><span class="giro" aria-hidden="true"></span>'+(s==='invio'?'Invio di «'+es(IMP.nome_file)+'»…':'Sto leggendo «'+es(IMP.nome_file||'il file')+'»: di solito ci vuole meno di un minuto.')+'</p>';
  } else if(s==='pronto')h+=anteprima(IMP);
  return h+'</div>';}
function anteprima(r){
  var rp=r.riepilogo||{},cn=rp.conteggi||{},b=r.blocchi||{},vv=r.voci||[],tf=rp.totale_file,so=Number(rp.somma)||0,hatf=tf!==null&&tf!==undefined&&tf!=='';
  var h='<p style="margin:0 0 8px"><b>Anteprima di «'+es(r.nome_file||'')+'»</b> · '+(/^ai/.test(r.modo||'')?'letto con l’intelligenza artificiale: controlla bene':'letto dal file')+'</p>'+
    '<div class="s-cifre"><div class="s-cifra"><small>Voci</small><b>'+es(cn.voci!=null?cn.voci:vv.length)+'</b><span>'+(Number(cn.righe)?es(cn.righe)+' righe di misura':'senza righe di misura')+'</span></div>'+
    '<div class="s-cifra"><small>Capitoli</small><b>'+es((r.capitoli||[]).length)+'</b></div>'+
    '<div class="s-cifra"><small>Somma delle voci</small><b>'+eur(so)+' €</b><span>'+(hatf?'nel file: '+eur(tf)+' €':'totale non scritto nel file')+'</span></div></div>';
  if(hatf){var d=Math.round((Number(tf)-so)*100)/100;h+='<p>'+(Math.abs(d)<=0.05?'<span class="ok-v">Le somme tornano con il totale scritto nel file.</span>':'<span class="ko-v">La somma delle voci è diversa dal totale del file di '+eur(Math.abs(d))+' €.</span>')+'</p>';}
  if((r.avvisi||[]).length)h+='<ul class="k-avv">'+r.avvisi.map(function(a){return '<li>'+es(a)+'</li>';}).join('')+'</ul>';
  var stop='',cf=r.confronto,vr=!!r.variante;
  if(b.bozza)stop='C’è una bozza del SAL aperta: scartala (scheda «SAL») prima di cambiare computo.';
  else if((b.misure_senza_voce||[]).length)stop='Le voci n. '+b.misure_senza_voce.join(', ')+' hanno già delle misure ma nel file nuovo non ci sono con lo stesso numero e la stessa unità: togli quelle misure oppure correggi il file.';
  if(cf)h+='<h3>Confronto con la versione '+es(b.attuale?b.attuale.versione:'di oggi')+'</h3><div class="s-cifre"><div class="s-cifra"><small>Computo di oggi</small><b>'+eur(cf.totale_a)+' €</b><span>'+es(cf.voci_a)+' voci</span></div>'+
    '<div class="s-cifra"><small>Computo nuovo</small><b>'+eur(cf.totale_b)+' €</b><span>'+es(cf.voci_b)+' voci</span></div>'+
    '<div class="s-cifra"><small>Differenza</small><b>'+(Number(cf.differenza)>0?'+':'')+eur(cf.differenza)+' €</b><span>'+(cf.pct!=null?pc(cf.pct):'')+'</span></div></div>'+
    '<p>'+es(cf.nuove)+(Number(cf.nuove)===1?' voce nuova':' voci nuove')+' · '+es(cf.tolte)+(Number(cf.tolte)===1?' tolta':' tolte')+' · '+es(cf.cambiate)+(Number(cf.cambiate)===1?' cambiata':' cambiate')+' (quantità, prezzo o unità)</p>'+
    tabConfronto(cf.righe,impTutte?0:30);
  if(b.attuale)h+='<p class="nota">Con «Conferma» diventa la versione '+(Number(b.attuale.versione)+1)+' del computo'+(vr?' (variante)':'')+'. La versione '+es(b.attuale.versione)+' ('+es(b.attuale.voci)+' voci) resta in archivio'+
    (Number(b.misure)?'; le '+es(b.misure)+' misure già scritte passano alle voci con lo stesso numero':'')+'. '+(vr?'Regola dei SAL e traguardi restano quelli di oggi; l’importo del contratto è quello che scrivi qui sotto.':'Dati del contratto, regola dei SAL e traguardi restano quelli di oggi.')+'</p>';
  if(vr&&!stop){var vimp=K&&K.importo_contratto!=null&&cf?Math.round((Number(K.importo_contratto)+Number(cf.differenza)*(1-Number(K.ribasso_pct||0)/100))*100)/100:null;
    h+='<h3>Atto della variante</h3><div class="campi"><label>Atto <small>(es. «Perizia di variante n. 1»)</small><input type="text" id="k-vd" maxlength="300"></label>'+
      '<label>Data dell’atto<input type="date" id="k-vdata" max="'+es(D.oggi)+'"></label>'+
      '<label>Nuovo importo del contratto <small>(€)</small><input type="text" id="k-vimp" inputmode="decimal" value="'+(vimp!=null?es(String(vimp).replace('.',',')):'')+'"></label></div>'+
      '<p class="nota">Importo proposto: quello di oggi ('+eur(K&&K.importo_contratto)+' €) più la differenza del computo'+(Number(K&&K.ribasso_pct)?' con il ribasso del '+pc(K.ribasso_pct):'')+'. Correggilo se l’atto dice un’altra cifra.</p>';}
  var righe=impTutte?vv:vv.slice(0,40);
  h+='<table class="av"><thead><tr><th class="t">N.</th><th class="t">Tariffa</th><th class="t">Descrizione</th><th class="t">U.M.</th><th>Quantità</th><th>Prezzo</th><th>Importo</th></tr></thead><tbody>'+
    righe.map(function(x){var np=x[5]===null||x[5]===undefined,imp=np?null:Math.round(Number(x[4])*Number(x[5])*100)/100;
      return '<tr class="v kv'+(x[7]?' alt':'')+'"><td class="t" data-l="N.">'+es(x[0])+'</td><td class="t" data-l="Tariffa">'+es(x[1]||'')+'</td><td class="t"><span class="vd">'+es(x[2]||'')+'</span>'+
        (x[7]?'<span class="vs">voce alternativa: non entra nella somma</span>':'')+'</td><td class="t" data-l="U.M.">'+es(x[3]||'')+'</td><td data-l="Quantità">'+qt(x[4])+'</td>'+
        '<td data-l="Prezzo">'+(np?'—':eur(x[5]))+'</td><td data-l="Importo">'+(imp===null?'—':eur(imp))+'</td></tr>';}).join('')+'</tbody></table>';
  if(!impTutte&&vv.length>40)h+='<div class="riga-b"><button type="button" class="b" id="k-tutte">Mostra tutte le '+vv.length+' voci</button></div>';
  if(stop)h+='<div class="k-err">'+es(stop)+'</div>';
  h+='<div class="campi" style="margin-top:12px"><label>Chi conferma <small>(nome e cognome)</small><input type="text" id="k-chi" maxlength="120" autocomplete="name" value="'+es(ls('sal_autore'))+'"></label></div>'+
    '<div class="riga-b">'+(stop?'':'<button type="button" class="b pr" id="k-conferma">'+(vr?'Conferma la variante':'Conferma il computo')+'</button>')+'<button type="button" class="b ro" id="k-annulla">Annulla</button></div>';
  return h;}
// confronto voce per voce: [nr, stato, tariffa, descrizione, u. prima, u. dopo, q. prima, q. dopo, prezzo prima, prezzo dopo, importo prima, importo dopo, differenza]
function tabConfronto(rr,max){if(!rr||!rr.length)return '<p class="nota">Nessuna voce cambiata.</p>';var v=max?rr.slice(0,max):rr;
  var fr=function(a,b,f){return a===null||a===undefined?f(b):b===null||b===undefined?f(a):(Number(a)===Number(b)?f(b):f(a)+' → '+f(b));};
  return '<table class="av cf"><thead><tr><th class="t">N.</th><th class="t">Voce</th><th class="t">Cosa</th><th>Quantità</th><th>Prezzo</th><th>Importo</th><th>Differenza</th></tr></thead><tbody>'+
    v.map(function(x){return '<tr class="kv cf-'+es(x[1])+'"><td class="t" data-l="N.">'+es(x[0])+'</td><td class="t"><span class="vd">'+es(x[3]||'')+'</span><span class="vs">'+es(x[2]||'')+
        (x[4]&&x[5]&&x[4]!==x[5]?' · unità '+es(x[4])+' → '+es(x[5]):' · '+es(x[5]||x[4]||''))+'</span></td><td class="t" data-l="Cosa">'+({nuova:'nuova',tolta:'tolta',cambiata:'cambiata'}[x[1]]||'')+'</td>'+
        '<td data-l="Quantità">'+fr(x[6],x[7],qt)+'</td><td data-l="Prezzo">'+fr(x[8],x[9],eur)+'</td><td data-l="Importo">'+fr(x[10],x[11],eur)+'</td>'+
        '<td data-l="Differenza"><b>'+(Number(x[12])>0?'+':'')+eur(x[12])+'</b></td></tr>';}).join('')+'</tbody></table>'+
    (max&&rr.length>max?'<div class="riga-b"><button type="button" class="b" id="k-tutte">Mostra tutte le '+rr.length+' voci cambiate</button></div>':'');}
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
// copia firmata del SAL (PDF firmato a mano e scansionato, o firmato digitalmente: .pdf o .p7m)
document.addEventListener('change',function(ev){var i=ev.target;if(!i.classList||!i.classList.contains('f-firm'))return;var f=i.files&&i.files[0],id=i.getAttribute('data-id');i.value='';if(!f)return;
  if(!/\.(pdf|p7m)$/i.test(f.name)){avviso('Carica il SAL firmato in PDF (.pdf o .p7m).');return;}
  if(f.size>18*1024*1024){avviso('Il file è troppo grande (massimo 18 MB).');return;}
  avviso('Invio della copia firmata…');
  fetch(C.u+'/firmato/carica?t='+encodeURIComponent(C.t)+'&id='+encodeURIComponent(id)+'&nome='+encodeURIComponent(f.name)+'&chi='+encodeURIComponent(ls('sal_autore')),{method:'POST',headers:{'Content-Type':f.type||'application/octet-stream'},body:f})
    .then(function(r){return r.json();}).catch(function(){return {esito:'incerto'};})
    .then(function(r){if(r&&r.esito==='ok'){avviso('Copia firmata salvata.');ricarica();}else avviso((r&&r.messaggio)||errore(r));});});

// ---------------- eventi
document.addEventListener('click',function(ev){var t=ev.target.closest?ev.target.closest('button,a,tr'):null;if(!t)return;
  if(t.id==='tab-sub'){location.href=C.u+'/subappaltatori?t='+C.t+'&c='+C.c;return;}
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
  if(t.id==='b-finale'){t.disabled=true;api('bozza',{dati:{tipo:'finale',data_fine_lavori:$('#f-fine').value}}).then(function(r){if(r&&r.esito==='ok'){avviso('Bozza del conto finale pronta.');ricarica();}else{t.disabled=false;avviso(errore(r));}});return;}
  if(t.id==='b-svincolo'){t.disabled=true;api('bozza',{dati:{tipo:'svincolo',data_collaudo:$('#s-dc').value,collaudo_tipo:$('#s-ct').value}}).then(function(r){if(r&&r.esito==='ok'){avviso('Bozza dello svincolo pronta.');ricarica();}else{t.disabled=false;avviso(errore(r));}});return;}
  if(t.hasAttribute('data-tgr')){t.disabled=true;api('traguardo_raggiunto',{id:t.getAttribute('data-tgr'),dati:{data:($('#tgr-d')||{}).value||''}}).then(function(r){if(r&&r.esito==='ok'){avviso('Traguardo segnato raggiunto.');ricarica();}else{t.disabled=false;avviso(errore(r));}});return;}
  if(t.hasAttribute('data-tgset')){var rg=t.closest('.tg');if(rg){$('.t-r',rg).value=t.getAttribute('data-tgset');avviso('Data messa: salva la scheda contratto.');}return;}
  if(t.id==='c-tg-crono'){var gia={};[].forEach.call(document.querySelectorAll('#c-tg .tg'),function(r){gia[r.getAttribute('data-crono')]=1;});
    var lista=(D.cardini||[]).filter(function(c){return !gia[c.id];});
    if(!lista.length){avviso('I traguardi del cronoprogramma sono già tutti nella lista.');return;}
    finestra('Traguardi dal cronoprogramma','Scegli quelli che fanno scattare un SAL: entrano nella lista con la data del cronoprogramma. Poi salva la scheda contratto.',
      lista.map(function(c){return '<label class="sc-cr"><input type="checkbox" value="'+es(c.id)+'"> <span>'+es(c.nome)+' <small>fine prevista '+di(c.data)+(c.fatto?' · concluso':'')+'</small></span></label>';}).join(''),'Aggiungi',
      function(){[].forEach.call(document.querySelectorAll('#dlg-c input:checked'),function(i){var c=(D.cardini||[]).filter(function(x){return x.id===i.value;})[0];
          if(c)$('#c-tg').insertAdjacentHTML('beforeend',rigaTg({nome:String(c.nome||'').slice(0,120),modo:'misura',data_prevista:c.data,crono_attivita_id:c.id,crono:c}));});
        $('#c-trag').hidden=false;chiudi();avviso('Traguardi aggiunti: salva la scheda contratto.');});return;}
  if(t.hasAttribute('data-conf')){var pp=t.getAttribute('data-conf').split(',');t.disabled=true;
    api('computo_confronto',{dati:{da:pp[0],a:pp[1]}}).then(function(r){t.disabled=false;if(!r||r.esito!=='ok'){avviso(errore(r));return;}var cf=r.confronto||{};
      finestra('Computo: versione '+r.da+' → versione '+r.a,r.variante?'Variante n. '+r.variante.n+(r.variante.descrizione?': '+r.variante.descrizione:'')+(r.variante.data?' del '+di(r.variante.data):''):'',
        '<div class="s-cifre"><div class="s-cifra"><small>Versione '+es(r.da)+'</small><b>'+eur(cf.totale_a)+' €</b></div><div class="s-cifra"><small>Versione '+es(r.a)+'</small><b>'+eur(cf.totale_b)+' €</b></div>'+
        '<div class="s-cifra"><small>Differenza</small><b>'+(Number(cf.differenza)>0?'+':'')+eur(cf.differenza)+' €</b><span>'+(cf.pct!=null?pc(cf.pct):'')+'</span></div></div>'+
        (Number(r.contratto_da)!==Number(r.contratto_a)?'<p>Importo del contratto: '+eur(r.contratto_da)+' € → '+eur(r.contratto_a)+' €</p>':'')+
        '<p>'+es(cf.nuove)+(Number(cf.nuove)===1?' voce nuova':' voci nuove')+' · '+es(cf.tolte)+(Number(cf.tolte)===1?' tolta':' tolte')+' · '+es(cf.cambiate)+(Number(cf.cambiate)===1?' cambiata':' cambiate')+'</p>'+tabConfronto(cf.righe,0),'',null,false,true);});return;}
  if(t.id==='b-scarta'){var b0=D.bozza;finestra('Scartare la bozza ('+nomeDoc(b0.tipo||'sal',b0.numero,b0.versione)+')?','Le misure restano: torneranno nella prossima bozza. Si perdono solo le altre voci e le note di questa bozza.','','Scarta la bozza',
      function(){return salvando(api('stato',{id:b0.id,dati:{azione:'scarta'}})).then(function(r){if(r)avviso('Bozza scartata.');});},true);return;}
  if(t.id==='b-emetti'){var b1=D.bozza,tp1=b1.tipo||'sal',nm1=tp1==='finale'?'il conto finale':tp1==='svincolo'?'lo svincolo delle ritenute':'il SAL n. '+b1.numero;salvaBozza().then(function(ok){if(!ok)return;var co=CO||{};
      finestra('Emettere '+nm1+'?','Importo: '+eur(co.dovuto)+' € + IVA'+(tp1==='finale'?' · lavori finiti il '+di(D.bozza.data_fine_lavori):tp1==='svincolo'?'':' · lavori fino al '+di(D.bozza.periodo_a)),
        '<p class="nota" style="margin:0">Con l’emissione il SAL riceve l’impronta SHA-256 e non si modifica più. Se la DL chiede correzioni prima del visto, si riemette come versione 2; dopo il visto le correzioni vanno nel SAL successivo. TIX non manda niente a nessuno: il documento lo consegni tu.</p>'+
        '<label>Emesso da <small>(nome e cognome)</small><input type="text" id="e-nome" maxlength="120" autocomplete="name" value="'+es(ls('sal_autore'))+'"></label>','Emetti',
        function(){var nm=$('#e-nome').value;ls('sal_autore',nm);return salvando(api('emetti',{id:D.bozza.id,dati:{autore:nm}})).then(function(r){if(r)avviso(tp1==='finale'?'Conto finale emesso.':tp1==='svincolo'?'Svincolo emesso.':'SAL emesso.');});});});return;}
  if(t.hasAttribute('data-pconf')||t.hasAttribute('data-pcorr')){var pr=proposta(t.getAttribute('data-pconf')||t.getAttribute('data-pcorr'));if(!pr)return;
    var pv=voce(pr.voce_id)||(CL.voci||[])[0];
    if(t.hasAttribute('data-pcorr')||(pr.q==null&&pr.pct==null)){if(pv)misura(pv,null,pr);return;}
    t.disabled=true;api('proposta',{id:pr.id,dati:{azione:'conferma',autore:ls('sal_autore')}}).then(function(r){
      if(r&&r.esito==='ok'){avviso('Misura confermata: '+qt(r.quantita)+' '+(pv?pv.u:''));ricarica();}else{t.disabled=false;avviso(errore(r));}});return;}
  if(t.hasAttribute('data-pscarta')){var ps=t.getAttribute('data-pscarta');
    finestra('Scartare la proposta?','Non entra nel SAL; resta nello storico come scartata.','<label>Motivo <small>(facoltativo)</small><input type="text" id="ps-mot" maxlength="300" placeholder="es. lavoro già misurato"></label>','Scarta',
      function(){return salvando(api('proposta',{id:ps,dati:{azione:'scarta',motivo:$('#ps-mot').value,autore:ls('sal_autore')}})).then(function(r){if(r)avviso('Proposta scartata.');});},true);return;}
  if(t.id==='cu-rifai'){ev.preventDefault();api('curva_prepara',{dati:{rifai:true}}).then(function(r){if(r&&r.esito==='ok'){avviso('Collegamento in corso: meno di un minuto.');curvaGiri=0;ricarica().then(function(){setTimeout(curvaAttendi,20000);});}else avviso(errore(r));});return;}
  if(t.id==='k-tutte'){impTutte=true;corpo();return;}
  if(t.id==='k-conferma'||t.id==='k-annulla'){var conf=t.id==='k-conferma',chi=$('#k-chi')?$('#k-chi').value:'';if(conf&&chi)ls('sal_autore',chi);t.disabled=true;
    var dk={autore:chi};if(conf&&$('#k-vd')){dk.variante_descrizione=$('#k-vd').value;dk.variante_data=$('#k-vdata').value;dk.importo_contratto=$('#k-vimp').value;}
    api(conf?'computo_conferma':'computo_annulla',{id:impId,dati:dk}).then(function(r){
      if(r&&r.esito==='ok'){clearTimeout(impTimer);IMP=null;impId=null;impTutte=false;
        avviso(!conf?'Caricamento annullato.':r.variante?'Variante n. '+r.variante+' confermata: versione '+r.versione+' del computo.':'Computo caricato: versione '+r.versione+', '+r.voci+' voci.');if(conf)ricarica();else corpo();}
      else{t.disabled=false;avviso(errore(r));}});return;}
  if(t.id==='c-salva'){salvaContratto();return;}
  if(t.id==='c-tg-agg'){$('#c-tg').insertAdjacentHTML('beforeend',rigaTg({}));return;}
  if(t.hasAttribute('data-tgx')){t.parentNode.parentNode.removeChild(t.parentNode);return;}
  if(t.hasAttribute('data-st')){var az=t.getAttribute('data-st'),sid=t.getAttribute('data-id'),nn=t.getAttribute('data-n');
    if(az==='firmato'||az==='visto'){finestra(az==='firmato'?nn+': firmato dall’impresa':nn+': visto dalla Direzione Lavori','Si segna solo nell’area riservata: TIX non manda niente.',
        '<label>'+(az==='firmato'?'Firmato da':'Nome del Direttore dei Lavori')+'<input type="text" id="f-nome" maxlength="120"></label><label>Il giorno<input type="date" id="f-data" max="'+es(D.oggi)+'" value="'+es(D.oggi)+'"></label>'+
        (az==='visto'?'<label>Nota della DL <small>(facoltativa)</small><input type="text" id="f-nota" maxlength="600"></label>':''),'Salva',
        function(){var d={azione:az,nome:$('#f-nome').value,data:$('#f-data').value};if($('#f-nota'))d.nota=$('#f-nota').value;return salvando(api('stato',{id:sid,dati:d})).then(function(r){if(r)avviso('Salvato.');});});}
    else{finestra(az==='riemetti'?'Riemettere «'+nn+'» con correzioni?':'Annullare «'+nn+'»?',
        az==='riemetti'?'Nasce la versione successiva in bozza, con le stesse misure da correggere. La versione di prima resta archiviata con la sua impronta.':'Il SAL resta archiviato come annullato; le sue misure tornano libere per il prossimo SAL.',
        '<label>Motivo<textarea id="r-mot" maxlength="600" placeholder="es. la DL ha chiesto di rimisurare la voce 12"></textarea></label><label>Chi lo fa <small>(nome e cognome)</small><input type="text" id="r-nome" maxlength="120" value="'+es(ls('sal_autore'))+'"></label>',
        az==='riemetti'?'Riemetti':'Annulla',function(){return salvando(api('stato',{id:sid,dati:{azione:az,motivo:$('#r-mot').value,nome:$('#r-nome').value}})).then(function(r){if(r){avviso(az==='riemetti'?'Versione nuova pronta in bozza.':'SAL annullato.');}});},az==='annulla');}
    return;}
});
document.addEventListener('submit',function(ev){if(ev.target.id!=='dlg-f')return;ev.preventDefault();if(dlgAzione)dlgAzione();});
document.addEventListener('input',function(ev){if(ev.target.id==='cerca'){cerca=ev.target.value.toLowerCase().trim();var pos=ev.target.selectionStart;corpo();var c=$('#cerca');if(c){c.focus();try{c.setSelectionRange(pos,pos);}catch(e){}}}});
tutto();
if(impId)impSegui();
})();`;
