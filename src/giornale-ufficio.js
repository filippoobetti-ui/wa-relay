// ---------------------------------------------------------------------------
// Giornale modificabile dall'ufficio (23/10/2026, richiesta di Filippo): nella scheda «Giornale» del cantiere
// - «Correggi», rosso, accanto ad «Apri il file» (o sotto il testo se la voce non ha file);
// - «+ Aggiungi una voce di oggi» in cima alla scheda.
// Regole (le decide il database, giornale_ufficio):
// - prima della chiusura del diario (22:00 del giorno della voce) la correzione cambia il testo e il diario della sera
//   mostra anche il testo mandato dal cantiere;
// - dopo la chiusura il diario non si tocca: la correzione resta registrata a parte e va nell'email del sabato;
// - una voce nuova si aggiunge solo per oggi e prima delle 22:00, segnata «Ufficio — nome».
// Il relay non conserva nulla: gira la richiesta al database e restituisce l'esito.
//
// 02/11/2026 (aggiunte-giorni-passati-1): «+ Aggiungi a questo giorno» su ogni giorno chiuso del Diario (i giorni passati e
// oggi dopo le 22:00). Il diario sigillato non cambia: l'aggiunta, con foto o PDF, entra nell'«Integrazione al diario del
// GG/MM/AAAA», documento a parte con versioni e impronte, che resta sotto quel giorno (database: giornale_aggiunte_portale,
// stesso accesso di «Correggi»; il giorno e l'integrazione li disegna documenti_giorno_html). Un DDT va anche nella scheda DDT.
//   POST {base}/giornale/ufficio       { t, c, azione: "aggiungi_giorno" | "file_togli", dati }   (oltre alle azioni di prima)
//   POST {base}/giornale/ufficio/file?t=…&c=…&data=AAAA-MM-GG&nome=…   corpo = il file: foto o PDF, al massimo 10 MB
//   GET  {base}/giornale/integrazione?t=…&c=…&id=<n>[&originale=1]     documento da stampare, o il testo registrato
// Un file per richiesta: prima il controllo dell'accesso e del giorno, poi il tipo letto dai primi byte, l'archivio privato
// wa-media (documenti/<cantiere>/integrazioni/<giorno>/…) e l'impronta SHA-256, calcolata qui e registrata nel database.
// Interruttore: AGGIUNTE_GIORNI = "off" toglie pulsanti e caricamenti (le integrazioni già fatte restano leggibili).
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AZIONI = ["stato", "leggi", "correggi", "aggiungi"];
const GIORNO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const MAX_FILE = 10 * 1024 * 1024;

function jsonRisposta(oggetto, stato) {
  return new Response(JSON.stringify(oggetto), {
    status: stato || 200,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }
  });
}

function supabaseUrl(env) {
  return env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co";
}
function casuale() {
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
// Il tipo si legge dai primi byte del file, non dal nome né da quello che dichiara il browser.
function tipoFile(b) {
  const s = (da, a) => String.fromCharCode.apply(null, Array.from(b.subarray(da, a)));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", est: "jpg" };
  if (b.length >= 8 && s(0, 8) === "\x89PNG\r\n\x1a\n") return { mime: "image/png", est: "png" };
  if (b.length >= 12 && s(0, 4) === "RIFF" && s(8, 12) === "WEBP") return { mime: "image/webp", est: "webp" };
  if (b.length >= 5 && s(0, 5) === "%PDF-") return { mime: "application/pdf", est: "pdf" };
  if (b.length >= 12 && s(4, 8) === "ftyp") {
    const marca = s(8, 12);
    if (["heic", "heix", "hevc", "hevx", "heim", "heis"].indexOf(marca) !== -1) return { mime: "image/heic", est: "heic" };
    if (["mif1", "msf1", "heif"].indexOf(marca) !== -1) return { mime: "image/heif", est: "heif" };
  }
  return null;
}
function nomeBreve(nome) {
  return String(nome || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\.[a-z0-9]{1,5}$/, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "") || "allegato";
}
// Toglie dall'archivio un file delle integrazioni di questo cantiere (mai altro).
async function togliFile(env, percorso, c) {
  const p = String(percorso || "");
  if (!UUID.test(c) || p.indexOf("documenti/" + c.toLowerCase() + "/integrazioni/") !== 0 || p.indexOf("..") !== -1) return false;
  try {
    const r = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + p.split("/").map(encodeURIComponent).join("/"), {
      method: "DELETE", headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } });
    return r.ok;
  } catch (e) { return false; }
}

// POST {base}/giornale/ufficio/file?t=…&c=…&data=AAAA-MM-GG&nome=…  (corpo = il file)
async function caricaFile(request, env, inUrl, h) {
  if (request.method !== "POST") return jsonRisposta({ esito: "metodo_non_consentito" }, 405);
  if (env.AGGIUNTE_GIORNI === "off") return jsonRisposta({ esito: "spento", messaggio: "Le aggiunte ai giorni chiusi sono sospese in questo momento." }, 404);
  if (!env.SUPABASE_SERVICE_KEY) return jsonRisposta({ esito: "non_configurato" }, 503);
  const t = String(inUrl.searchParams.get("t") || "").toLowerCase();
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase();
  const data = String(inUrl.searchParams.get("data") || "");
  const nome = String(inUrl.searchParams.get("nome") || "").replace(/[\u0000-\u001f\\/]+/g, " ").trim().slice(0, 180);
  if (!/^[0-9a-f]{64}$/.test(t)) return jsonRisposta({ esito: "gettone" }, 403);
  if (!UUID.test(c) || !GIORNO.test(data)) return jsonRisposta({ esito: "richiesta_non_valida" }, 400);
  const dichiarati = Number(request.headers.get("Content-Length") || 0);
  if (dichiarati > MAX_FILE) return jsonRisposta({ esito: "grande", messaggio: "Il file è troppo grande: massimo 10 MB." }, 413);
  // prima l'accesso e il giorno, poi il file: chi non può aggiungere non scrive niente nell'archivio
  const ctl = await h.rpc(env, "giornale_aggiunte_portale", { p_token: t, p_commessa: c, p_azione: "file_controlla",
    p_dati: { data, nome, byte: dichiarati || 1 } }, 10000).catch(() => null);
  if (ctl === null || typeof ctl !== "object") return jsonRisposta({ esito: "incerto" }, 502);
  if (ctl.esito !== "ok") return jsonRisposta(ctl, ctl.esito === "gettone" ? 403 : 200);
  const cartella = String(ctl.cartella || "");
  if (cartella !== "documenti/" + c + "/integrazioni/" + data + "/") return jsonRisposta({ esito: "errore" }, 502);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return jsonRisposta({ esito: "vuoto", messaggio: "Il file è vuoto." }, 400);
  if (bytes.length > MAX_FILE) return jsonRisposta({ esito: "grande", messaggio: "Il file è troppo grande: massimo 10 MB." }, 413);
  const tipo = tipoFile(bytes);
  if (!tipo) return jsonRisposta({ esito: "formato", messaggio: "Formato non ammesso: carica una foto (JPG, PNG, WEBP o HEIC) o un PDF." }, 415);
  const ora = new Date();
  const d2 = (n) => String(n).padStart(2, "0");
  const timbro = ora.getUTCFullYear() + d2(ora.getUTCMonth() + 1) + d2(ora.getUTCDate()) + "-" + d2(ora.getUTCHours()) + d2(ora.getUTCMinutes()) + d2(ora.getUTCSeconds());
  const percorso = cartella + timbro + "-" + casuale() + "-" + nomeBreve(nome) + "." + tipo.est;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const up = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorso.split("/").map(encodeURIComponent).join("/"), {
      method: "POST",
      headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY, "Content-Type": tipo.mime, "x-upsert": "false" },
      body: bytes, signal: ctrl.signal
    });
    if (!up.ok) return jsonRisposta({ esito: "archivio", messaggio: "Il file non si è salvato: riprova tra un minuto." }, 502);
  } catch (e) {
    return jsonRisposta({ esito: "archivio", messaggio: "Il file non si è salvato: riprova tra un minuto." }, 502);
  } finally { clearTimeout(timer); }
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (x) => x.toString(16).padStart(2, "0")).join("");
  const r = await h.rpc(env, "giornale_aggiunte_portale", { p_token: t, p_commessa: c, p_azione: "file_registra",
    p_dati: { data, percorso, nome: nome || "allegato." + tipo.est, mime: tipo.mime, byte: bytes.length, sha256: sha } }, 10000).catch(() => null);
  // senza risposta il file resta: è sotto documenti/<cantiere>/, quindi si cancella comunque con i dati del cantiere
  if (r === null || typeof r !== "object") return jsonRisposta({ esito: "incerto" }, 502);
  if (r.esito !== "ok") {
    await togliFile(env, percorso, c);
    return jsonRisposta(r, r.esito === "gettone" ? 403 : 200);
  }
  return jsonRisposta({ esito: "ok", id: r.id, nome: r.nome, mime: tipo.mime, byte: bytes.length, sha256: sha });
}

// Azioni dell'aggiunta (giornale_aggiunte_portale): «aggiungi_giorno» salva l'aggiunta e la versione nuova dell'integrazione,
// «file_togli» toglie un file caricato e non ancora salvato.
async function azioneGiorno(env, h, t, c, azione, d, s) {
  if (env.AGGIUNTE_GIORNI === "off") return jsonRisposta({ esito: "spento", messaggio: "Le aggiunte ai giorni chiusi sono sospese in questo momento." }, 404);
  let dati;
  if (azione === "file_togli") {
    if (!/^[0-9]{1,15}$/.test(String(d.id == null ? "" : d.id))) return jsonRisposta({ esito: "richiesta_non_valida" }, 400);
    dati = { id: Number(d.id) };
  } else {
    const file = Array.isArray(d.file) ? d.file.slice(0, 6).map((x) => String(x)).filter((x) => /^[0-9]{1,15}$/.test(x)).map(Number) : [];
    dati = { data: s(d.data, 10), sezione: s(d.sezione, 10), testo: s(d.testo, 4000), motivo: s(d.motivo, 600), autore: s(d.autore, 120),
             fornitore: s(d.fornitore, 160), numero: s(d.numero, 60), file };
  }
  const r = await h.rpc(env, "giornale_aggiunte_portale", { p_token: t, p_commessa: c, p_azione: azione, p_dati: dati }, 20000).catch(() => null);
  if (r === null || typeof r !== "object") return jsonRisposta({ esito: "incerto" }, 502);
  // il database ha già tolto le righe; qui si tolgono i file dall'archivio (solo quelli delle integrazioni di questo cantiere)
  if (r.esito === "ok" && azione === "file_togli" && r.percorso) await togliFile(env, r.percorso, c);
  if (r.esito === "ok" && Array.isArray(r.da_togliere)) for (const p of r.da_togliere.slice(0, 5)) await togliFile(env, p, c);
  const { percorso, da_togliere, ...risposta } = r;
  return jsonRisposta(risposta);
}

// GET {base}/giornale/integrazione?t=…&c=…&id=<n>[&originale=1] — Integrazione al diario da leggere e stampare
async function documentoIntegrazione(request, env, base, inUrl, h) {
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  if (!env.SUPABASE_SERVICE_KEY) return new Response("Servizio non configurato.", { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  const m = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  if (!m) return Response.redirect(inUrl.origin + base + "/", 303);
  const tok = m[0].toLowerCase();
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase();
  const id = String(inUrl.searchParams.get("id") || "");
  if (!UUID.test(c) || !/^[0-9]{1,15}$/.test(id)) return new Response("Not Found", { status: 404 });
  const titolo = "Integrazione al diario";
  const r = await h.rpc(env, "giornale_aggiunte_portale", { p_token: tok, p_commessa: c, p_azione: "documento", p_dati: { id: Number(id) } }, 15000).catch(() => null);
  if (!r) return h.risposta(h.foglio(base, titolo, "", '<p class="err">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p>'), 503);
  if (r.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (r.esito !== "ok" || typeof r.html !== "string" || typeof r.vista !== "string") {
    return h.risposta(h.foglio(base, titolo, "", '<p class="err">Documento non trovato.</p>'), 404);
  }
  const nome = String(r.nome_file || "Integrazione-al-diario.html").replace(/[^A-Za-z0-9._-]+/g, "-");
  // L'originale è il testo registrato, byte per byte: è quello su cui si verifica l'impronta. Esce come
  // application/octet-stream, così lo strato di stile del portale (solo text/html) non lo cambia.
  if (inUrl.searchParams.get("originale") === "1") {
    return new Response(metodo === "HEAD" ? null : r.html, { status: 200, headers: {
      "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="' + nome + '"',
      "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } });
  }
  const e = h.esc;
  const giorno = String(r.data || "").split("-").reverse().join("/");
  const versioni = Array.isArray(r.versioni) ? r.versioni : [];
  const ultima = versioni.length ? versioni[versioni.length - 1] : null;
  const vai = (x) => base + "/giornale/integrazione?t=" + tok + "&c=" + c + "&id=" + x;
  const barra = '<div class="gi-barra">' +
    '<a href="' + e(base + "/?t=" + tok + "&c=" + c) + '">&larr; Torna al Diario</a>' +
    '<button type="button" onclick="window.print()">Stampa o salva in PDF</button>' +
    '<a href="' + e(vai(id) + "&originale=1") + '">Scarica l’originale</a>' +
    (ultima && Number(ultima.versione) > Number(r.versione)
      ? '<p class="gi-av">C’è una versione più recente. <a href="' + e(vai(ultima.id)) + '">Apri la versione ' + e(ultima.versione) + '</a>.</p>' : "") +
    (versioni.length > 1 ? '<p class="gi-nota">Versioni: ' + versioni.map((x) => String(x.id) === id
      ? "<b>" + e(x.versione) + " (questa)</b>" : '<a href="' + e(vai(x.id)) + '">' + e(x.versione) + "</a> del " + e(x.il)).join(" · ") + "</p>" : "") +
    '<p class="gi-nota">Impronta SHA-256 registrata: <code>' + e(r.impronta || "") + "</code>. Foto e PDF si aprono con collegamenti che durano almeno 12 ore: se uno è scaduto, ricarica la pagina.</p></div>";
  const stile = '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">' +
    "<title>" + e("Integrazione al diario del " + giorno + " (versione " + r.versione + ")") + "</title><style>" +
    '.gi-barra{font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:#FFF7EA;border:1px solid #F1D7AE;border-radius:10px;padding:10px 12px;margin:0 0 16px;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;font-size:13px;letter-spacing:normal}' +
    ".gi-barra a{color:#8A4A06;font-weight:700}.gi-barra button{width:auto;font:inherit;font-weight:700;border:1px solid #C27A12;background:#C27A12;color:#fff;border-radius:8px;padding:6px 12px;cursor:pointer}" +
    ".gi-barra p{flex-basis:100%;margin:0}.gi-av{color:#8c1d18;font-weight:700}.gi-nota{color:#5b6560;font-size:12px;overflow-wrap:anywhere}" +
    // il foglio resta bianco e in Helvetica anche con lo strato di stile del portale, che arriva dopo, in fondo alla head
    "html,body{background:#fff!important}body{font-family:Helvetica,Arial,sans-serif!important;letter-spacing:normal!important}" +
    "@media screen{body{max-width:210mm;margin:0 auto!important;padding:14px 12px 28px!important}.piede{position:static!important;margin-top:8mm}}" +
    "@media screen and (max-width:600px){.testa{grid-template-columns:1fr!important}.intest{text-align:left!important}.linea{margin-left:0!important;padding-left:5mm!important}" +
    ".ev .ora{position:static!important;display:block;width:auto!important;text-align:left!important;margin-bottom:1mm}.piede{flex-direction:column;align-items:flex-start!important;gap:4px}}" +
    "@media print{.gi-barra{display:none}}</style>";
  let html = r.vista;
  html = html.indexOf("</head>") !== -1 ? html.replace("</head>", () => stile + "</head>") : stile + html;
  html = html.indexOf("<body>") !== -1 ? html.replace("<body>", () => "<body>" + barra) : barra + html;
  return new Response(metodo === "HEAD" ? null : html, { status: 200, headers: h.headers() });
}

// POST {base}/giornale/ufficio — corpo JSON { t, c, azione, dati }
// (02/11/2026) la stessa funzione serve anche /giornale/ufficio/file e /giornale/integrazione: vedi in cima.
export async function portaleGiornaleUfficio(request, env, h, base, inUrl) {
  const sotto = inUrl ? inUrl.pathname.slice(String(base || "").length) : "/giornale/ufficio";
  if (sotto === "/giornale/integrazione") return documentoIntegrazione(request, env, String(base || ""), inUrl, h);
  if (sotto === "/giornale/ufficio/file") return caricaFile(request, env, inUrl, h);
  if (request.method !== "POST") return jsonRisposta({ esito: "metodo_non_consentito" }, 405);
  if (!env.SUPABASE_SERVICE_KEY) return jsonRisposta({ esito: "non_configurato" }, 503);
  if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || "")) return jsonRisposta({ esito: "errore" }, 415);
  let b;
  try { const t = await request.text(); if (t.length > 12000) return jsonRisposta({ esito: "errore" }, 413); b = JSON.parse(t); } catch (e) { b = null; }
  if (!b || typeof b !== "object") return jsonRisposta({ esito: "richiesta_non_valida" }, 400);
  const t = String(b.t || "").toLowerCase();
  const c = String(b.c || "").toLowerCase();
  const azione = String(b.azione || "");
  if (!/^[0-9a-f]{64}$/.test(t)) return jsonRisposta({ esito: "gettone" }, 403);
  const giorno = azione === "aggiungi_giorno" ? "aggiungi" : azione === "file_togli" ? "file_togli" : "";
  if (!UUID.test(c) || (AZIONI.indexOf(azione) === -1 && !giorno)) return jsonRisposta({ esito: "richiesta_non_valida" }, 400);
  const d = b.dati && typeof b.dati === "object" ? b.dati : {};
  const s = (v, n) => String(v == null ? "" : v).slice(0, n);
  if (giorno) return azioneGiorno(env, h, t, c, giorno, d, s);
  const dati = { mid: s(d.mid, 300), testo: s(d.testo, 4000), motivo: s(d.motivo, 600), autore: s(d.autore, 120), sezione: s(d.sezione, 10) };
  const r = await h.rpc(env, "giornale_ufficio", { p_token: t, p_commessa: c, p_azione: azione, p_dati: dati }, 15000).catch(() => null);
  if (r === null || typeof r !== "object") return jsonRisposta({ esito: "incerto" }, 502);
  return jsonRisposta(r);
}

// Stile e script iniettati nella pagina del cantiere (area riservata). base = "" oppure "/portale".
// aggiunte = false con AGGIUNTE_GIORNI = "off": niente «Aggiungi a questo giorno» (le integrazioni già fatte restano visibili).
export function giornaleUfficioIniezione(base, token, commessa, aggiunte) {
  const cfg = JSON.stringify({ u: base + "/giornale/ufficio", f: base + "/giornale/ufficio/file", v: base + "/giornale/integrazione",
    t: token, c: commessa, ag: aggiunte !== false });
  const stile = "<style>" +
    ".gl-gu-b{display:inline-flex;align-items:center;gap:6px;margin:8px 8px 0 0;padding:0 14px;min-height:36px;border:1px solid #c62828;border-radius:8px;background:#fdecec;color:#c62828;font:inherit;font-size:.9rem;font-weight:700;cursor:pointer;vertical-align:middle}" +
    ".gl-gu-b:hover,.gl-gu-b:focus-visible{background:#c62828;color:#fff;outline:none}" +
    ".gl-gu-add{display:flex;width:100%;align-items:center;justify-content:center;gap:8px;min-height:48px;margin:0 0 12px;border:0;border-radius:12px;background:#C27A12;color:#fff;font:inherit;font-weight:700;font-size:1rem;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.15)}" +
    ".gl-gu-nota{background:#FFF7EA;border-left:4px solid #C27A12;border-radius:10px;padding:8px 12px;margin:0 0 12px;font-size:.88rem;color:#5A3D00}" +
    ".gl-gu-ov{position:fixed;inset:0;z-index:9999;background:rgba(10,18,28,.55);display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}" +
    ".gl-gu-bx{background:#fff;color:#1b1f1d;border-radius:14px;max-width:520px;width:100%;max-height:90vh;overflow:auto;padding:20px 20px 16px;box-shadow:0 10px 40px rgba(0,0,0,.35)}" +
    ".gl-gu-bx h3{margin:0 0 6px;font-size:1.1rem;color:#1B2F4A}.gl-gu-bx p{margin:0 0 10px;font-size:.9rem;line-height:1.45}" +
    ".gl-gu-bx .meta{font-size:.84rem;color:#5b6560;margin:0 0 10px}" +
    ".gl-gu-bx label{display:block;font-size:.85rem;font-weight:600;margin:10px 0 4px}" +
    ".gl-gu-bx textarea,.gl-gu-bx input[type=text],.gl-gu-bx select{display:block;width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #c9d1cd;border-radius:8px;font:inherit;font-size:1rem;background:#fff;color:#1b1f1d}" +
    ".gl-gu-ok{background:#E3F3EA;border-left:4px solid #0A7D48;border-radius:8px;padding:8px 10px;font-size:.86rem;margin:0 0 6px}" +
    ".gl-gu-avv{background:#fdeaea;border-left:4px solid #c62828;border-radius:8px;padding:8px 10px;font-size:.86rem;margin:0 0 6px}" +
    ".gl-gu-stor{font-size:.8rem;color:#5b6560;margin:8px 0 0}.gl-gu-stor div{margin:3px 0}" +
    ".gl-gu-cf{display:inline-flex;align-items:center;gap:4px;margin:8px 8px 0 0;padding:2px 10px;min-height:28px;border:1px solid #E8B04A;border-radius:999px;background:#FFF4E0;color:#8A5300;font-size:.82rem;font-weight:700;vertical-align:middle;cursor:help}.gl-gu-cf.ok{background:#E3F3EA;color:#0A7D48;border-color:#9ED3B5}" +
    ".gl-gu-err{color:#a11;font-size:.88rem;margin:10px 0 0}" +
    ".gl-gu-az{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:14px}" +
    ".gl-gu-az button{padding:10px 16px;border-radius:10px;border:1px solid #c9d1cd;background:#fff;color:#1b1f1d;font:inherit;font-weight:600;cursor:pointer}" +
    ".gl-gu-az button.pr{background:#c62828;border-color:#c62828;color:#fff}.gl-gu-az button.ag{background:#C27A12;border-color:#C27A12;color:#fff}.gl-gu-az button[disabled]{opacity:.55;cursor:wait}" +
    "@media (prefers-color-scheme:dark){.gl-gu-bx{background:#1a201d;color:#eef2f0}.gl-gu-bx h3{color:#cfe0ff}.gl-gu-bx textarea,.gl-gu-bx input[type=text],.gl-gu-bx select{background:#111513;color:#eef2f0;border-color:#3a4540}.gl-gu-az button{background:#232b27;color:#eef2f0;border-color:#3a4540}.gl-gu-ok{background:#123224}.gl-gu-avv{background:#3a1c1c}.gl-gu-nota{background:#3a2f12;color:#f3e2bd}.gl-gu-cf{background:#3a2f12;color:#f3e2bd}.gl-gu-cf.ok{background:#123224;color:#bfe8cf}}" +
    // 02/11/2026 (aggiunte-giorni-passati-1): «Aggiungi a questo giorno», la sua finestra e l'Integrazione al diario nel giorno
    ".gl-ag-b{display:inline-flex;align-items:center;justify-content:center;gap:6px;width:auto;margin:10px 0 4px;padding:0 14px;min-height:40px;border:1px solid #C27A12;border-radius:10px;background:#FFF7EA;color:#8A4A06;font:inherit;font-size:.9rem;font-weight:700;letter-spacing:normal;text-transform:none;cursor:pointer;box-shadow:none}" +
    ".gl-ag-b:hover,.gl-ag-b:focus-visible{background:#C27A12;color:#fff;outline:none}@media (max-width:640px){.gl-ag-b{width:100%}}" +
    ".gl-int{margin:10px 0 6px;padding:10px 12px 12px;border:1px solid #F1D7AE;border-left:4px solid #C27A12;border-radius:12px;background:#FFF9F0}" +
    ".gl-int-t{font-weight:800;color:#8A4A06}.gl-int-s{font-size:.84rem;color:#5b6560;margin:2px 0}" +
    ".gl-int-v{background:#fff;border:1px solid #D9DEE5;border-radius:10px;padding:8px 10px;margin:8px 0 0}" +
    ".gl-int-mot{font-size:.84rem;color:#5b6560;margin-top:4px}.gl-int-no{display:block;font-size:.82rem;color:#a11;margin-top:6px}" +
    ".gl-int-foto{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.gl-int-foto a{display:block;line-height:0}" +
    ".gl-int-foto img{display:block;height:96px;width:auto;max-width:160px;object-fit:cover;border-radius:8px;border:1px solid #D9DEE5;background:#EEF1F5}" +
    ".gl-int a.gl-int-apri{margin-top:10px}.gl-int a.gl-int-apri:not([href]){opacity:.6}" +
    ".gl-ag-dt{display:inline-block;margin-top:8px;padding:2px 10px;border-radius:999px;background:#FFF4E0;border:1px solid #E8B04A;color:#8A5300;font-size:.8rem;font-weight:700}" +
    ".gl-gu-bx.gl-ag-bx{max-width:600px}.gl-gu-bx [hidden]{display:none!important}" +
    ".gl-ag-2{display:grid;grid-template-columns:1fr 1fr;gap:0 10px}@media (max-width:520px){.gl-ag-2{grid-template-columns:1fr}}" +
    ".gl-gu-bx .gl-ag-fac{font-weight:400;color:#666}" +
    ".gl-ag-in{position:absolute!important;width:1px!important;height:1px!important;opacity:0;overflow:hidden;pointer-events:none}" +
    ".gl-gu-bx label.gl-ag-sc{display:inline-flex;align-items:center;gap:6px;margin:2px 0 0;padding:9px 14px;border:1px dashed #C27A12;border-radius:10px;background:#FFF7EA;color:#8A4A06;font-weight:700;cursor:pointer}" +
    ".gl-gu-bx label.gl-ag-sc:hover,.gl-gu-bx label.gl-ag-sc:focus-within{background:#FFEFD6}" +
    ".gl-ag-aiuto{font-size:.8rem;color:#5b6560;margin:6px 0 0}.gl-ag-lista{list-style:none;margin:8px 0 0;padding:0}" +
    ".gl-ag-lista li{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid #dfe5e2;border-radius:8px;margin:0 0 6px;font-size:.88rem}" +
    ".gl-ag-lista .ic{flex:none;width:38px;height:38px;border-radius:6px;background:#EEF1F5;display:flex;align-items:center;justify-content:center;font-size:.66rem;font-weight:800;color:#1B2F4A;overflow:hidden}" +
    ".gl-ag-lista .ic img{width:100%;height:100%;object-fit:cover}" +
    ".gl-ag-lista .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gl-ag-lista .d{color:#5b6560;font-size:.8rem;white-space:nowrap}" +
    ".gl-ag-lista .st{font-size:.78rem;white-space:nowrap;color:#5b6560}.gl-ag-lista .st.ok{color:#0A7D48}.gl-ag-lista .st.no{color:#a11}" +
    ".gl-gu-bx .gl-ag-lista button{flex:none;width:32px;height:32px;min-height:0;margin:0;padding:0;border:1px solid #c9d1cd;border-radius:8px;background:#fff;color:#1b1f1d;font-size:1.1rem;line-height:1;cursor:pointer}" +
    ".gl-ag-pr{font-size:.86rem;color:#1B2F4A;font-weight:600;margin:10px 0 0}" +
    "@media (prefers-color-scheme:dark){.gl-ag-lista li{border-color:#3a4540}.gl-gu-bx label.gl-ag-sc{background:#3a2f12;color:#f3e2bd}.gl-gu-bx .gl-ag-lista button{background:#232b27;color:#eef2f0;border-color:#3a4540}.gl-ag-pr{color:#cfe0ff}.gl-gu-bx .gl-ag-fac{color:#a9b3ae}}" +
    "</style>";
  const script = "<script>" + String.raw`(function(){try{
var CFG=` + cfg + String.raw`,STATO=null;
function el(t,c,h){var e=document.createElement(t);if(c)e.className=c;if(h!=null)e.innerHTML=h;return e;}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(x){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x];});}
function chiama(azione,dati){return fetch(CFG.u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,c:CFG.c,azione:azione,dati:dati||{}})}).then(function(r){return r.json();});}
function autore(){try{return localStorage.getItem('gl_rp_autore')||'';}catch(x){return '';}}
function ricorda(v){try{if(v)localStorage.setItem('gl_rp_autore',v);}catch(x){}}
function chiudi(ov){if(ov&&ov.parentNode)ov.parentNode.removeChild(ov);}
function finestra(){var ov=el('div','gl-gu-ov'),bx=el('div','gl-gu-bx');ov.appendChild(bx);ov.addEventListener('click',function(e){if(e.target===ov)chiudi(ov);});document.body.appendChild(ov);return {ov:ov,bx:bx};}
var STATI_CF={da_mandare:'da mandare',in_invio:'in invio',mandata:'mandata, ancora senza risposta',confermata:'confermata da chi ha scritto',correggi_attesa:'ha scelto «Correggi», si aspetta la frase giusta',corretta:'corretta da chi ha scritto',scaduta:'senza risposta',solo_segno:'non chiesta (traduzione, limite del giorno o diario chiuso): da controllare',errore:'non partita'};
function dIt(s){var p=String(s||'').split('-');return p.length===3?p[2]+'/'+p[1]+'/'+p[0]:'';}
function errore(r){if(!r)return 'Operazione non riuscita. Riprova.';if(r.esito==='gettone')return 'Collegamento non valido o scaduto: ricarica la pagina.';if(r.esito==='chiuso')return 'Il cantiere è chiuso: il diario non si modifica.';if(r.esito==='incerto')return 'Non ho avuto risposta: ricarica la pagina tra un minuto per vedere se è stato salvato.';return r.messaggio||'Operazione non riuscita. Riprova.';}
/* ---------- Correggi ---------- */
function correggi(mid){
 var w=finestra(),bx=w.bx;bx.innerHTML='<h3>Correggi la voce</h3><p>Caricamento…</p>';
 chiama('leggi',{mid:mid}).then(function(r){
  if(!r||r.esito!=='ok'){bx.innerHTML='<h3>Correggi la voce</h3><p class="gl-gu-err">'+esc(errore(r))+'</p><div class="gl-gu-az"><button type="button" class="an">Chiudi</button></div>';bx.querySelector('.an').onclick=function(){chiudi(w.ov);};return;}
  var v=r.voce,ultimo=v.testo,cc=v.correzioni||[];
  for(var i=0;i<cc.length;i++)if(cc[i].dopo_chiusura)ultimo=cc[i].dopo;
  var stor='';
  if(v.testo_trasmesso)stor+='<div>Testo mandato dal cantiere: «'+esc(v.testo_trasmesso)+'»</div>';
  if(v.conferma)stor+='<div>Domanda di TIX a chi ha scritto («Ho capito così?»), '+esc(v.conferma.il)+': '+esc(STATI_CF[v.conferma.stato]||v.conferma.stato)+(v.conferma.testo_mandato?' · testo arrivato: «'+esc(v.conferma.testo_mandato)+'»':'')+'</div>';
  for(var j=0;j<cc.length;j++)stor+='<div>'+esc(cc[j].il)+' · '+esc(cc[j].da)+(cc[j].dopo_chiusura?' (dopo la chiusura)':'')+': «'+esc(cc[j].dopo)+'» — '+esc(cc[j].motivo)+'</div>';
  bx.innerHTML='<h3>Correggi la voce</h3><div class="meta">'+esc(dIt(v.data))+' ore '+esc(v.ora)+' · '+esc(v.sezione)+' · '+esc(v.mittente)+'</div>'+
   (v.chiusa?'<div class="gl-gu-avv">Il diario del '+esc(dIt(v.data))+' è già chiuso e non cambia. La correzione resta registrata a parte, con il testo di prima, chi l’ha fatta e perché, e va nell’email del sabato.</div>':
    '<div class="gl-gu-ok">La correzione entra nel diario di stasera (chiusura alle '+esc(v.ora_chiusura)+'). Sotto resta il testo mandato dal cantiere.</div>')+
   '<label for="gl-gu-t">Testo corretto</label><textarea id="gl-gu-t" rows="5" maxlength="4000"></textarea>'+
   '<label for="gl-gu-m">Motivo della correzione</label><input type="text" id="gl-gu-m" maxlength="300" placeholder="es. l’ora era sbagliata">'+
   '<label for="gl-gu-a">Corretto da <span style="font-weight:400;color:#666">(nome e cognome)</span></label><input type="text" id="gl-gu-a" maxlength="120" autocomplete="name">'+
   (stor?'<div class="gl-gu-stor"><b>Storia della voce</b>'+stor+'</div>':'')+
   '<div class="gl-gu-err" style="display:none"></div><div class="gl-gu-az"><button type="button" class="an">Annulla</button><button type="button" class="pr">Salva la correzione</button></div>';
  var t=bx.querySelector('#gl-gu-t'),m=bx.querySelector('#gl-gu-m'),a=bx.querySelector('#gl-gu-a'),err=bx.querySelector('.gl-gu-err'),pr=bx.querySelector('.pr');
  t.value=ultimo||'';a.value=autore();
  bx.querySelector('.an').onclick=function(){chiudi(w.ov);};
  pr.onclick=function(){
   var tv=t.value.trim(),mv=m.value.trim(),av=a.value.trim();
   function no(x){err.textContent=x;err.style.display='block';}
   if(!tv)return no('Scrivi il testo corretto.');
   if(tv===String(ultimo||'').trim())return no('Il testo è uguale a quello di adesso: cambia qualcosa oppure annulla.');
   if(mv.length<5)return no('Scrivi il motivo della correzione.');
   if(!av)return no('Scrivi chi fa la correzione (nome e cognome).');
   pr.disabled=true;err.style.display='none';ricorda(av);
   chiama('correggi',{mid:mid,testo:tv,motivo:mv,autore:av}).then(function(q){
    if(q&&q.esito==='ok'){location.reload();return;}
    pr.disabled=false;no(errore(q));
   }).catch(function(){pr.disabled=false;no('Connessione assente. Riprova.');});
  };
  setTimeout(function(){try{t.focus();}catch(x){}},50);
 }).catch(function(){bx.innerHTML='<h3>Correggi la voce</h3><p class="gl-gu-err">Connessione assente. Riprova.</p>';});
}
/* ---------- Aggiungi ---------- */
function aggiungi(){
 var w=finestra(),bx=w.bx;
 bx.innerHTML='<h3>Aggiungi una voce di oggi</h3>'+
  '<div class="gl-gu-ok">La voce entra nel diario di oggi e nel PDF di stasera (chiusura alle '+esc(STATO.ora_chiusura)+'), segnata «Ufficio» con il tuo nome.</div>'+
  '<label for="gl-gu-s">Sezione</label><select id="gl-gu-s"><option value="LAV">Lavorazioni</option><option value="NOTE">Note</option><option value="VISITA">Visite</option><option value="SAL">SAL</option></select>'+
  '<label for="gl-gu-t">Testo</label><textarea id="gl-gu-t" rows="5" maxlength="4000" placeholder="es. Getto del solaio del piano 1 completato"></textarea>'+
  '<label for="gl-gu-a">Inserita da <span style="font-weight:400;color:#666">(nome e cognome)</span></label><input type="text" id="gl-gu-a" maxlength="120" autocomplete="name">'+
  '<div class="gl-gu-err" style="display:none"></div><div class="gl-gu-az"><button type="button" class="an">Annulla</button><button type="button" class="ag">Aggiungi la voce</button></div>';
 var s=bx.querySelector('#gl-gu-s'),t=bx.querySelector('#gl-gu-t'),a=bx.querySelector('#gl-gu-a'),err=bx.querySelector('.gl-gu-err'),ag=bx.querySelector('.ag');
 a.value=autore();
 bx.querySelector('.an').onclick=function(){chiudi(w.ov);};
 ag.onclick=function(){
  var tv=t.value.trim(),av=a.value.trim();
  function no(x){err.textContent=x;err.style.display='block';}
  if(!tv)return no('Scrivi il testo della voce.');
  if(!av)return no('Scrivi chi inserisce la voce (nome e cognome).');
  ag.disabled=true;err.style.display='none';ricorda(av);
  chiama('aggiungi',{sezione:s.value,testo:tv,autore:av}).then(function(q){
   if(q&&q.esito==='ok'){location.reload();return;}
   ag.disabled=false;no(errore(q));
  }).catch(function(){ag.disabled=false;no('Connessione assente. Riprova.');});
 };
 setTimeout(function(){try{t.focus();}catch(x){}},50);
}
/* ---------- Aggiungi a questo giorno (02/11/2026): giorni chiusi, con foto e PDF ---------- */
var SEZ=[['LAV','Lavorazioni'],['DDT','Forniture e consegne (DDT)'],['VISITA','Visite'],['NOTE','Note'],['SAL','SAL'],['FIR','Rifiuti']];
var MAXF=5,MAXB=10*1024*1024;
function mis(b){return b>=1048576?String(Math.round(b/104857.6)/10).replace('.',',')+' MB':Math.max(1,Math.round(b/1024))+' KB';}
function tipoOk(f){var n=String(f.name||'').toLowerCase(),t=String(f.type||'').toLowerCase();return /\.(jpe?g|png|webp|heic|heif|pdf)$/.test(n)||/^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/.test(t);}
function eFoto(f){return /^image\/(jpeg|png|webp)$/.test(String(f.type||'').toLowerCase());}
function togliCaricato(id){if(id)chiama('file_togli',{id:id}).catch(function(){});}
function caricaUno(g,x){
 return fetch(CFG.f+'?t='+CFG.t+'&c='+encodeURIComponent(CFG.c)+'&data='+g+'&nome='+encodeURIComponent(x.f.name||'allegato'),{method:'POST',headers:{'Content-Type':x.f.type||'application/octet-stream'},body:x.f})
  .then(function(r){return r.json().catch(function(){return null;});});
}
function aggiungiGiorno(g){
 var gi=dIt(g),oggi=g===STATO.oggi,lista=[],occupato=false;
 var ov=el('div','gl-gu-ov'),bx=el('div','gl-gu-bx gl-ag-bx');ov.appendChild(bx);document.body.appendChild(ov);
 bx.setAttribute('role','dialog');bx.setAttribute('aria-modal','true');bx.setAttribute('aria-label','Aggiungi al diario del '+gi);
 bx.innerHTML='<h3>Aggiungi al diario del '+esc(gi)+'</h3>'+
  '<div class="gl-gu-nota">Il diario '+(oggi?'di oggi è chiuso (alle '+esc(STATO.ora_chiusura)+')':'del '+esc(gi)+' è chiuso')+' e non cambia. Quello che aggiungi va nell’<b>Integrazione al diario del '+esc(gi)+'</b>: un documento a parte, con il tuo nome, la data di oggi e la sua impronta, che resta sempre insieme al diario di quel giorno. Dopo il salvataggio non si modifica.</div>'+
  '<label for="gl-ag-s">Sezione</label><select id="gl-ag-s">'+SEZ.map(function(s){return '<option value="'+s[0]+'">'+s[1]+'</option>';}).join('')+'</select>'+
  '<div class="gl-ag-ddt gl-ag-2" hidden><div><label for="gl-ag-for">Fornitore <span class="gl-ag-fac">(facoltativo)</span></label><input type="text" id="gl-ag-for" maxlength="160" autocomplete="off"></div>'+
  '<div><label for="gl-ag-num">Numero del DDT <span class="gl-ag-fac">(facoltativo)</span></label><input type="text" id="gl-ag-num" maxlength="60" autocomplete="off"></div></div>'+
  '<label for="gl-ag-t">Testo</label><textarea id="gl-ag-t" rows="4" maxlength="4000"></textarea>'+
  '<label>Allegati <span class="gl-ag-fac">(facoltativi)</span></label>'+
  '<label class="gl-ag-sc" for="gl-ag-f">&#128206; Scegli foto o PDF</label><input type="file" id="gl-ag-f" class="gl-ag-in" multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,application/pdf,.pdf">'+
  '<div class="gl-ag-aiuto">Foto (JPG, PNG, WEBP, HEIC) o PDF · fino a 5 file · massimo 10 MB l’uno</div><ul class="gl-ag-lista"></ul>'+
  '<label for="gl-ag-m">Motivo <span class="gl-ag-fac">(facoltativo)</span></label><input type="text" id="gl-ag-m" maxlength="300" placeholder="es. DDT arrivato il '+esc(gi.slice(0,5))+', consegnato in ufficio dopo">'+
  '<label for="gl-ag-a">Aggiunta da <span class="gl-ag-fac">(nome e cognome)</span></label><input type="text" id="gl-ag-a" maxlength="120" autocomplete="name">'+
  '<div class="gl-ag-pr" hidden></div><div class="gl-gu-err" style="display:none"></div>'+
  '<div class="gl-gu-az"><button type="button" class="an">Annulla</button><button type="button" class="ag">Aggiungi al diario</button></div>';
 var s=bx.querySelector('#gl-ag-s'),dd=bx.querySelector('.gl-ag-ddt'),fo=bx.querySelector('#gl-ag-for'),nu=bx.querySelector('#gl-ag-num'),t=bx.querySelector('#gl-ag-t'),fi=bx.querySelector('#gl-ag-f'),ul=bx.querySelector('.gl-ag-lista'),m=bx.querySelector('#gl-ag-m'),a=bx.querySelector('#gl-ag-a'),pr=bx.querySelector('.gl-ag-pr'),err=bx.querySelector('.gl-gu-err'),ag=bx.querySelector('.ag'),an=bx.querySelector('.an');
 a.value=autore();
 function no(x){err.textContent=x;err.style.display='block';}
 function sezione(){var d=s.value==='DDT';dd.hidden=!d;t.placeholder=d?'es. Consegna di 12 m³ di calcestruzzo C25/30 per il solaio del piano 1':'es. Getto del solaio del piano 1 completato';}
 s.addEventListener('change',sezione);sezione();
 function disegna(){
  ul.innerHTML='';
  lista.forEach(function(x,i){
   var li=el('li'),ic=el('span','ic');
   if(x.url){var im=el('img');im.src=x.url;im.alt='';ic.appendChild(im);}else ic.textContent=/\.pdf$/i.test(x.f.name||'')||x.f.type==='application/pdf'?'PDF':'FOTO';
   li.appendChild(ic);li.appendChild(el('span','n',esc(x.f.name||'allegato')));li.appendChild(el('span','d',mis(x.f.size)));
   li.appendChild(el('span','st'+(x.id?' ok':x.err?' no':''),x.id?'&#10003; caricato':x.err?'non caricato':''));
   var b=el('button',null,'&times;');b.type='button';b.title='Togli il file';b.setAttribute('aria-label','Togli '+(x.f.name||'il file'));
   b.onclick=function(){if(occupato)return;togliCaricato(x.id);if(x.url)try{URL.revokeObjectURL(x.url);}catch(e){}lista.splice(i,1);disegna();};
   li.appendChild(b);ul.appendChild(li);
  });
 }
 fi.addEventListener('change',function(){
  err.style.display='none';
  var msg='';
  Array.prototype.slice.call(fi.files||[]).forEach(function(f){
   if(lista.length>=MAXF){msg='Puoi allegare al massimo 5 file.';return;}
   if(!tipoOk(f)){msg='«'+f.name+'»: formato non ammesso. Carica foto (JPG, PNG, WEBP, HEIC) o PDF.';return;}
   if(!f.size){msg='«'+f.name+'» è vuoto.';return;}
   if(f.size>MAXB){msg='«'+f.name+'» è troppo grande: massimo 10 MB.';return;}
   lista.push({f:f,url:eFoto(f)?URL.createObjectURL(f):null,id:null,err:false});
  });
  fi.value='';disegna();if(msg)no(msg);
 });
 function esci(){if(occupato)return;lista.forEach(function(x){togliCaricato(x.id);if(x.url)try{URL.revokeObjectURL(x.url);}catch(e){}});document.removeEventListener('keydown',tasto);chiudi(ov);}
 function tasto(e){if(e.key==='Escape')esci();}
 document.addEventListener('keydown',tasto);
 ov.addEventListener('click',function(e){if(e.target===ov)esci();});
 an.onclick=esci;
 ag.onclick=function(){
  if(occupato)return;
  var tv=t.value.trim(),av=a.value.trim(),i=0;
  err.style.display='none';
  if(!tv){no('Scrivi il testo.');t.focus();return;}
  if(!av){no('Scrivi chi fa l’aggiunta (nome e cognome).');a.focus();return;}
  if(lista.length>MAXF){no('Puoi allegare al massimo 5 file.');return;}
  occupato=true;ag.disabled=true;an.disabled=true;ricorda(av);
  function fine(x){occupato=false;ag.disabled=false;an.disabled=false;pr.hidden=true;no(x);}
  function salva(){
   pr.hidden=false;pr.textContent='Salvo l’aggiunta…';
   var ddt=s.value==='DDT';
   chiama('aggiungi_giorno',{data:g,sezione:s.value,testo:tv,motivo:m.value.trim(),autore:av,fornitore:ddt?fo.value.trim():'',numero:ddt?nu.value.trim():'',file:lista.map(function(x){return x.id;})}).then(function(q){
    if(q&&q.esito==='ok'){try{sessionStorage.setItem('gl_ag_giorno',g);}catch(e){}pr.textContent='Aggiunto all’Integrazione al diario (versione '+q.versione+').';occupato=false;location.reload();return;}
    if(q&&/allegato non è più disponibile/.test(q.messaggio||''))lista.forEach(function(x){x.id=null;});
    fine(errore(q));
   }).catch(function(){fine('Connessione assente. Riprova.');});
  }
  function avanti(){
   while(i<lista.length&&lista[i].id)i++;
   if(i>=lista.length){salva();return;}
   var x=lista[i];
   pr.hidden=false;pr.textContent='Carico il file '+(i+1)+' di '+lista.length+'…';
   caricaUno(g,x).then(function(r){
    if(r&&r.esito==='ok'&&r.id){x.id=r.id;x.err=false;disegna();i++;avanti();return;}
    x.err=true;disegna();fine(r&&r.messaggio?'«'+(x.f.name||'file')+'»: '+r.messaggio:errore(r));
   }).catch(function(){x.err=true;disegna();fine('Connessione assente: «'+(x.f.name||'file')+'» non si è caricato. Riprova.');});
  }
  avanti();
 };
 setTimeout(function(){try{t.focus();}catch(x){}},50);
}
function mettiAggiunte(){
 if(!CFG.ag||!STATO||STATO.chiuso)return;
 document.querySelectorAll('#p-g .gl-dg[data-giorno]').forEach(function(n){
  var g=n.getAttribute('data-giorno');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(g)||!(g<STATO.oggi||(g===STATO.oggi&&STATO.oggi_chiuso)))return;
  if(!n.parentNode||n.parentNode.querySelector(':scope > .gl-ag-b'))return;
  var b=el('button','gl-ag-b','+ Aggiungi a questo giorno');b.type='button';b.title='Aggiungi qualcosa al diario del '+dIt(g);
  b.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();aggiungiGiorno(g);});
  n.insertAdjacentElement('afterend',b);
 });
}
function collegamenti(){
 document.querySelectorAll('.gl-int-apri[data-integrazione]').forEach(function(x){
  var id=x.getAttribute('data-integrazione');if(/^\d+$/.test(id))x.href=CFG.v+'?t='+CFG.t+'&c='+encodeURIComponent(CFG.c)+'&id='+id;
 });
 document.querySelectorAll('#p-d [data-mid^="aggiunta:"]').forEach(function(n){
  var x=n.querySelector(':scope > .gl-ct-b');if(x)x.parentNode.removeChild(x);
  if(!n.querySelector('.gl-ag-dt'))n.appendChild(el('div','gl-ag-dt','Aggiunto dall’ufficio · Integrazione al diario'));
 });
}
function riapri(){
 var g=null;try{g=sessionStorage.getItem('gl_ag_giorno');sessionStorage.removeItem('gl_ag_giorno');}catch(e){}
 if(!g||!/^\d{4}-\d{2}-\d{2}$/.test(g))return;
 var n=document.querySelector('#p-g .gl-dg[data-giorno="'+g+'"]');if(!n)return;
 var d=n.closest('details');if(d)d.open=true;
 var x=n.querySelector('.gl-int')||n.parentNode;
 try{history.scrollRestoration='manual';}catch(e){}
 function vai(){try{window.scrollTo(0,Math.max(0,x.getBoundingClientRect().top+window.pageYOffset-12));var nav=document.querySelector('.schede-w')||document.querySelector('nav.schede'),b=nav?nav.getBoundingClientRect().bottom:0;if(b>0&&b<window.innerHeight/2)window.scrollBy(0,-(b+4));}catch(e){}}
 if(document.readyState==='complete')setTimeout(vai,150);else window.addEventListener('load',function(){setTimeout(vai,150);});
 setTimeout(vai,700);setTimeout(function(){try{history.scrollRestoration='auto';}catch(e){}},1500);
}
/* ---------- tasti nella pagina ---------- */
function mettiTasti(){
 document.querySelectorAll('.voce[data-mid]').forEach(function(n){
  if(n.querySelector('.gl-gu-b'))return;
  var mid=n.getAttribute('data-mid');if(!mid)return;
  var b=el('button','gl-gu-b','&#9998; Correggi');b.type='button';b.title='Correggi il testo della voce';
  var cf=STATO.conferme&&STATO.conferme[mid],sg=null;
  if(cf){var ok=cf==='confermata'||cf==='corretta';sg=el('span','gl-gu-cf'+(ok?' ok':''),ok?(cf==='corretta'?'&#10003; Corretta da chi l’ha scritta':'&#10003; Confermata da chi l’ha scritta'):'&#9888; Da confermare');sg.title=ok?'Chi ha mandato il messaggio ha risposto alla domanda «Ho capito così?»':'La correzione automatica era incerta e chi ha scritto non l’ha confermata: controlla il testo con «Correggi»';}
  b.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();correggi(mid);});
  var file=null,ll=n.querySelectorAll('a.link');
  for(var i=0;i<ll.length;i++){if(/Apri il file/.test(ll[i].textContent||'')){file=ll[i];break;}}
  if(!file&&ll.length)file=ll[ll.length-1];
  if(file)file.insertAdjacentElement('afterend',b);
  else{var tx=n.querySelectorAll(':scope > .testo');if(tx.length)tx[tx.length-1].insertAdjacentElement('afterend',b);else n.appendChild(b);}
  if(sg)b.insertAdjacentElement('afterend',sg);
 });
 var pg=document.getElementById('p-g');
 if(pg&&!pg.querySelector('.gl-gu-add,.gl-gu-nota')){
  var x;
  if(STATO.oggi_chiuso){x=el('div','gl-gu-nota',CFG.ag?'Il diario di oggi è chiuso (alle '+esc(STATO.ora_chiusura)+') e non cambia. Le voci si possono ancora correggere; per aggiungere qualcosa usa «+ Aggiungi a questo giorno» sotto la data del giorno.':'Il diario di oggi è chiuso (alle '+esc(STATO.ora_chiusura)+'). Le voci si possono ancora correggere; per aggiungere qualcosa usa «Nuovo rapportino» nella scheda Rapportini.');}
  else{x=el('button','gl-gu-add','+ Aggiungi una voce di oggi');x.type='button';x.addEventListener('click',aggiungi);}
  pg.insertBefore(x,pg.firstChild);
 }
}
function avvio(){collegamenti();riapri();}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',avvio);else setTimeout(avvio,0);
chiama('stato').then(function(r){if(!r||r.esito!=='ok'||r.chiuso)return;STATO=r;mettiTasti();mettiAggiunte();collegamenti();}).catch(function(){});
}catch(x){}})();
` + "</script>";
  return stile + script;
}
