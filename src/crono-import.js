// ============================================================================
// CRONOPROGRAMMA DA FILE (14/10/2026, «VAI» di Filippo delle 16:18). Si carica un file e il cronoprogramma
// entra nel Giornale Lavori da solo, dopo una conferma. Due strade, stessa lettura e stessa conferma:
//  • WhatsApp: documento o foto con «cronoprogramma» (o «gantt», «programma lavori») nella didascalia o nel nome
//    del file, oppure un file .xer / .mpp. Il database sceglie il cantiere (nome nella didascalia, altrimenti quello
//    scelto in chat) e controlla che chi scrive possa farlo (crono_import_da_whatsapp). Il file NON va a Make.
//    Appena letto, chi l'ha mandato riceve il riepilogo con «✅ Conferma / ❌ Annulla» (id CRONO_IMP_<n>_OK / _NO).
//  • Area riservata: /cronoprogramma?t=…&c=… (pagina con caricamento e conferma), /cronoprogramma/carica (file),
//    /cronoprogramma/stato (avanzamento della lettura), /cronoprogramma/azione (conferma / annulla).
// La lettura la fa la funzione crono-import (Supabase), svegliata dal database. Finché non si conferma non cambia nulla;
// alla conferma nasce una nuova versione e la precedente resta in archivio («superato»).
// Spegnimento: impostazioni.crono_import_attivo = 'no' (database) oppure variabile CRONO_IMPORT=off (relay).
// ============================================================================

const GETTONE = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BYTE = 18 * 1024 * 1024;
const PAROLE = /crono|gantt|programma\s+(dei\s+)?lavori|diagramma\s+(dei\s+)?lavori|planning\s+lavori/i;

// ---------------------------------------------------------------------------- WhatsApp
export function cronoImportCandidato(msg) {
  if (!msg || (msg.type !== "document" && msg.type !== "image")) return false;
  const m = msg[msg.type] || {};
  const nome = String(m.filename || "");
  const did = String(m.caption || "");
  if (/\.(mpp|xer)$/i.test(nome)) return true;
  return PAROLE.test(did) || (msg.type === "document" && PAROLE.test(nome));
}

export function cronoImportIdPulsante(msg) {
  if (!msg || msg.type !== "interactive" || !msg.interactive) return "";
  const it = msg.interactive;
  const id = String((it.button_reply && it.button_reply.id) || (it.list_reply && it.list_reply.id) || "");
  return /^CRONO_IMP_[0-9]+_(OK|NO)$/.test(id) ? id : "";
}

async function rispondi(env, h, value, tel, msgId, testo) {
  const phoneId = (value && value.metadata && value.metadata.phone_number_id) || (await h.config(env)).phone_number_id;
  if (!phoneId || !testo) return { ok: false, status: 0, testo: "phone_number_id" };
  return h.invia(phoneId, env.WHATSAPP_TOKEN, {
    messaging_product: "whatsapp", recipient_type: "individual", to: tel, type: "text",
    context: msgId ? { message_id: msgId } : undefined, text: { body: String(testo).slice(0, 1000), preview_url: false }
  });
}

// Ritorna true se il messaggio è stato preso qui (non prosegue verso la chat unica / Make).
export async function cronoImportGestisci(msg, value, env, h) {
  const tel = String(msg.from || "");
  if (!tel || !env.SUPABASE_SERVICE_KEY || !env.WHATSAPP_TOKEN) return false;
  const m = msg[msg.type] || {};
  const media = msg._media || {};
  const r = await h.rpc(env, "crono_import_da_whatsapp", {
    p_telefono: tel, p_message_id: msg.id || null, p_storage_path: media.storage_path || null,
    p_mime: media.mime || m.mime_type || null, p_nome_file: m.filename || null, p_didascalia: m.caption || null,
    p_byte: Number(media.bytes) || null
  }, 8000);
  if (!r || r.esito === "non_mio") return false;
  if (r.esito === "doppio") return true;
  let inv = null;
  try { inv = await rispondi(env, h, value, tel, msg.id, r.testo); } catch (e) { inv = { ok: false, status: 0, testo: String((e && e.message) || e) }; }
  await h.log(env, tel, msg.id, "crono_import", r.esito + (r.id ? " #" + r.id : "") + (r.cantiere ? " · " + r.cantiere : "") +
    " · " + String(m.filename || m.caption || "").slice(0, 120) + (inv && !inv.ok ? " · invio " + inv.status + " " + inv.testo : ""));
  return true;
}

export async function cronoImportRispostaGestisci(msg, value, env, h) {
  const id = cronoImportIdPulsante(msg);
  const tel = String(msg.from || "");
  if (!id || !tel || !env.SUPABASE_SERVICE_KEY || !env.WHATSAPP_TOKEN) return false;
  const r = await h.rpc(env, "crono_import_risposta", { p_telefono: tel, p_id_pulsante: id }, 15000);
  if (!r || r.esito === "non_mio") return false;
  try { await rispondi(env, h, value, tel, msg.id, r.testo); } catch (e) {}
  await h.log(env, tel, msg.id, "crono_import_risposta", id + " · " + r.esito + (r.dettaglio ? " · " + String(r.dettaglio).slice(0, 200) : ""));
  return true;
}

// Riepilogo da confermare (o avviso di errore) a chi ha mandato il file: lo chiama il database via /admin
// (crono_import_scrivi, crono_import_sveglia) appena la lettura è finita. Testo e pulsanti li prepara il database.
export async function cronoImportAvvisa(env, id, h) {
  const esito = { id: Number(id) || 0, inviato: false, dettaglio: "" };
  if (!esito.id) { esito.dettaglio = "id"; return esito; }
  if (!env.SUPABASE_SERVICE_KEY || !env.WHATSAPP_TOKEN || env.CRONO_IMPORT === "off") { esito.dettaglio = "configurazione"; return esito; }
  const cfg = await h.config(env);
  if (!cfg.phone_number_id) { esito.dettaglio = "phone_number_id"; return esito; }
  let r = null;
  try { r = await h.rpc(env, "crono_import_payload", { p_id: esito.id }, 10000); }
  catch (e) { esito.dettaglio = "payload: " + String((e && e.message) || e); return esito; }
  const tel = r && String(r.telefono || "").replace(/[^0-9]/g, "");
  if (!r || !tel || !r.payload || typeof r.payload !== "object") { esito.dettaglio = "niente da mandare"; return esito; }
  const payload = r.payload;
  payload.messaging_product = "whatsapp";
  payload.to = tel;
  try {
    const inv = await h.invia(cfg.phone_number_id, env.WHATSAPP_TOKEN, payload);
    esito.inviato = inv.ok; esito.dettaglio = inv.status + " " + inv.testo;
  } catch (e) { esito.dettaglio = String((e && e.message) || e); }
  try { await h.rpc(env, "crono_import_segna", { p_id: esito.id, p_ok: esito.inviato, p_dettaglio: esito.dettaglio.slice(0, 200) }, 5000); } catch (e) {}
  await h.log(env, tel, null, esito.inviato ? "crono_import_avviso" : "crono_import_avviso_errore", "#" + esito.id + " · " + esito.dettaglio.slice(0, 250));
  return esito;
}

// ---------------------------------------------------------------------------- area riservata
function json(o, stato) {
  return new Response(JSON.stringify(o), {
    status: stato || 200,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }
  });
}

function estensione(nome) {
  const m = /\.(pdf|xml|xer|xlsx|xlsm|xls|ods|csv|tsv|txt|jpe?g|png|webp|mpp)$/i.exec(String(nome || ""));
  return m ? "." + m[1].toLowerCase().replace("jpeg", "jpg") : "";
}

function casuale() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

async function carica(request, env, inUrl, h) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  const tok = String(inUrl.searchParams.get("t") || "").toLowerCase();
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase();
  const nome = String(inUrl.searchParams.get("nome") || "").replace(/[\u0000-\u001f\\/]+/g, " ").trim().slice(0, 180);
  if (!GETTONE.test(tok)) return json({ esito: "gettone" }, 403);
  if (!UUID.test(c)) return json({ esito: "errore" }, 400);
  const dichiarati = Number(request.headers.get("Content-Length") || 0);
  if (dichiarati > MAX_BYTE) return json({ esito: "grande", messaggio: "Il file è troppo grande (massimo 18 MB)." }, 413);
  if (/\.mpp$/i.test(nome)) return json({ esito: "mpp", messaggio: "I file .mpp si aprono solo con Microsoft Project: da Project fai File → Salva con nome → XML (oppure stampa in PDF) e carica quel file." });
  // prima il controllo dell'accesso, poi il file (chi non ha accesso non scrive nulla nell'archivio)
  const ctx = await h.rpc(env, "crono_import_contesto", { p_token: tok, p_commessa: c }, 10000).catch(() => null);
  if (!ctx) return json({ esito: "incerto" }, 503);
  if (ctx.esito !== "ok") return json({ esito: String(ctx.esito) }, ctx.esito === "gettone" ? 403 : 400);
  if (ctx.chiuso) return json({ esito: "chiuso", messaggio: "Il cantiere è chiuso." });
  if (ctx.attivo === false) return json({ esito: "spento", messaggio: "Il caricamento del cronoprogramma è sospeso in questo momento." });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return json({ esito: "vuoto", messaggio: "Il file è vuoto." }, 400);
  if (bytes.length > MAX_BYTE) return json({ esito: "grande", messaggio: "Il file è troppo grande (massimo 18 MB)." }, 413);
  const ora = new Date();
  const percorso = "crono/" + ora.getUTCFullYear() + "/" + String(ora.getUTCMonth() + 1).padStart(2, "0") + "/" +
    String(ora.getUTCDate()).padStart(2, "0") + "/" + casuale() + estensione(nome);
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
  const r = await h.rpc(env, "crono_import_da_portale", { p_token: tok, p_commessa: c, p_storage_path: percorso, p_mime: mime, p_nome_file: nome || null, p_byte: bytes.length }, 10000).catch(() => null);
  if (!r) return json({ esito: "incerto" }, 503);
  if (r.esito !== "ok") return json({ esito: String(r.esito), messaggio: r.messaggio || "" });
  return json({ esito: "ok", id: r.id });
}

export async function portaleCronoprogramma(request, env, base, inUrl, h) {
  if (!env.SUPABASE_SERVICE_KEY) {
    return new Response("Servizio non configurato.", { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  }
  const sotto = inUrl.pathname.slice(base.length);
  if (env.CRONO_IMPORT === "off" && sotto !== "/cronoprogramma") return json({ esito: "spento", messaggio: "Il caricamento del cronoprogramma è sospeso." });
  if (sotto === "/cronoprogramma/carica") return carica(request, env, inUrl, h);
  if (sotto === "/cronoprogramma/stato") {
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
    const tok = String(inUrl.searchParams.get("t") || "").toLowerCase();
    const c = String(inUrl.searchParams.get("c") || "").toLowerCase();
    const id = Number(inUrl.searchParams.get("id"));
    if (!GETTONE.test(tok)) return json({ esito: "gettone" }, 403);
    if (!UUID.test(c) || !Number.isInteger(id) || id <= 0) return json({ esito: "errore" }, 400);
    const r = await h.rpc(env, "crono_import_stato", { p_token: tok, p_commessa: c, p_id: id }, 10000).catch(() => null);
    return r ? json(r) : json({ esito: "incerto" }, 503);
  }
  if (sotto === "/cronoprogramma/azione") {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || "")) return json({ esito: "errore" }, 415);
    let b = null;
    try { const t = await request.text(); if (t.length > 2000) return json({ esito: "errore" }, 413); b = JSON.parse(t); } catch (e) { b = null; }
    if (!b || typeof b !== "object") return json({ esito: "errore" }, 400);
    const tok = String(b.t || "").toLowerCase();
    const c = String(b.c || "").toLowerCase();
    const id = Number(b.id);
    const az = String(b.azione || "");
    if (!GETTONE.test(tok)) return json({ esito: "gettone" }, 403);
    if (!UUID.test(c) || !Number.isInteger(id) || id <= 0 || (az !== "conferma" && az !== "annulla")) return json({ esito: "errore" }, 400);
    const r = await h.rpc(env, "crono_import_azione", { p_token: tok, p_commessa: c, p_id: id, p_azione: az }, 20000).catch(() => null);
    return r ? json(r) : json({ esito: "incerto" }, 503);
  }
  if (sotto !== "/cronoprogramma") return new Response("Not Found", { status: 404 });
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const m = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  if (!m) return Response.redirect(inUrl.origin + base + "/", 303);
  const tok = m[0].toLowerCase();
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase().replace(/[^0-9a-f-]/g, "").slice(0, 36);
  const torna = base + "/?t=" + tok;
  if (!UUID.test(c)) return Response.redirect(inUrl.origin + torna, 303);
  const d = await h.rpc(env, "crono_import_contesto", { p_token: tok, p_commessa: c }, 15000).catch(() => null);
  if (!d) {
    return h.risposta(h.foglio(base, "Cronoprogramma", "", '<p class="err">Il servizio non risponde in questo momento. Riprova tra qualche minuto.</p><p class="piede"><a href="' + torna + '">&larr; Torna ai cantieri</a></p>'), 503);
  }
  if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (d.esito !== "ok") return Response.redirect(inUrl.origin + torna, 303);
  const apri = Number(inUrl.searchParams.get("i")) || 0;
  return new Response(metodo === "HEAD" ? null : paginaCrono(base, tok, c, d, h, env.CRONO_IMPORT === "off", apri), { status: 200, headers: h.headers() });
}

// ---------------------------------------------------------------------------- pagina
function dataIt(iso) {
  const p = String(iso || "").slice(0, 10).split("-");
  return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : "";
}

const ICONA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/></svg>';

const STATI = { ricevuto: "in attesa di lettura", in_lettura: "in lettura", pronto: "da confermare", errore: "non letto", confermato: "caricato", annullato: "annullato", scaduto: "scaduto" };

function paginaCrono(base, tok, c, d, h, spentoRelay, apri) {
  const e = h.esc;
  const cant = d.cantiere || {};
  const torna = base + "/?t=" + tok + "&c=" + c + "#c";
  const pr = d.programma;
  const logoImpresa = d.logo_impresa
    ? '<div class="dx"><div class="logo-impresa"><img src="' + e(d.logo_impresa) + '" alt="' + e(d.azienda_nome) + '"></div></div>'
    : '<div class="dx"></div>';
  const tipoPr = pr ? ({ contrattuale: "contrattuale", esecutivo: "esecutivo", aggiornamento: "aggiornato" }[pr.tipo] || pr.tipo) : "";
  const attuale = pr
    ? '<div class="box"><div class="et">Cronoprogramma in uso</div><div class="v">Versione ' + e(pr.versione) + " &middot; " + e(tipoPr) + "</div>" +
      '<div class="k">' + e(pr.righe) + " righe &middot; lavori dal " + e(dataIt(pr.inizio)) + " al " + e(dataIt(pr.fine)) +
      (pr.file_nome ? "<br>File: " + e(pr.file_nome) : "") + (pr.data_documento ? " (del " + e(dataIt(pr.data_documento)) + ")" : "") + "</div></div>"
    : '<div class="box"><div class="et">Cronoprogramma in uso</div><div class="v">Non ancora caricato</div><div class="k">Carica il file qui sotto: da quel momento le date reali si aggiornano da sole con i messaggi del cantiere.</div></div>';
  const imp = Array.isArray(d.importazioni) ? d.importazioni : [];
  let elenco = "";
  for (const x of imp) {
    const st = String(x.stato || "");
    elenco += '<div class="imp"><div><b>' + e(x.nome_file || "file senza nome") + "</b><br><small>" + e(dataIt(x.creato_il)) + " &middot; " +
      (x.canale === "whatsapp" ? "da WhatsApp" : "dall'area riservata") + (x.autore && x.canale === "whatsapp" ? " (" + e(x.autore) + ")" : "") + "</small></div>" +
      '<div class="st"><span class="pl pl-' + e(st) + '">' + e(STATI[st] || st) + "</span>" +
      (st === "pronto" || st === "ricevuto" || st === "in_lettura" || st === "errore" ? '<button type="button" class="apri" data-id="' + e(x.id) + '">Apri</button>' : "") + "</div></div>";
  }
  const dati = JSON.stringify({ base: base, t: tok, c: c, chiuso: d.chiuso === true, apri: apri || 0, torna: torna }).replace(/</g, "\\u003c");
  const bloccato = d.chiuso === true || d.attivo === false || spentoRelay;
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">' +
    "<title>Cronoprogramma - " + e(cant.nome || "") + "</title>" + h.testa(base) +
    "<style>" + STILE + "</style></head><body>" +
    "<header>" + (d.logo_html || '<div class="marchio">TIX · Diario di cantiere</div>') +
    '<div class="centro"><h1>Cronoprogramma</h1><p>' + e(cant.nome || "") + (cant.ubicazione ? " &middot; " + e(cant.ubicazione) : "") + "</p></div>" + logoImpresa + "</header>" +
    '<main><a class="indietro" href="' + e(torna) + '">&larr; Torna al cantiere</a>' +
    attuale +
    (bloccato
      ? '<div class="avviso">' + (d.chiuso ? "Cantiere chiuso: il cronoprogramma resta consultabile, non se ne caricano di nuovi." : "Il caricamento del cronoprogramma è sospeso in questo momento.") + "</div>"
      : '<label class="cr-btn" for="f-file"><span class="ic">' + ICONA + "</span>" + (pr ? "Carica un cronoprogramma aggiornato" : "Carica il cronoprogramma") + "</label>" +
        '<input type="file" id="f-file" accept=".pdf,.xml,.xer,.xlsx,.xls,.xlsm,.ods,.csv,.jpg,.jpeg,.png,.webp,.mpp,application/pdf,image/*">' +
        '<p class="nota" style="margin-top:0">Vanno bene il <b>PDF</b> stampato da Project o da Primavera, il file <b>XML</b> di Project (File → Salva con nome → XML), il file <b>XER</b> o <b>XML</b> di Primavera, un <b>Excel</b> o <b>CSV</b> con nome, inizio e fine delle lavorazioni, oppure una <b>foto</b> nitida. Massimo 18 MB.</p>') +
    '<section id="lavoro" hidden><div class="tit" id="w-tit">Lettura del file</div><div id="w-corpo"></div></section>' +
    (elenco ? '<div class="tit">Ultimi file ricevuti</div>' + elenco : "") +
    '<p class="nota">Il file viene letto in automatico e ti mostriamo cosa abbiamo trovato: <b>nel giornale non cambia nulla finché non premi «Conferma»</b>. ' +
    "Alla conferma il nuovo cronoprogramma diventa quello in uso; quello di prima resta in archivio e le lavorazioni già registrate (con lo stesso nome) tengono date reali e avanzamento.</p>" +
    '<p class="nota">Puoi anche mandarlo su WhatsApp a TIX scrivendo nel messaggio «cronoprogramma» e il nome del cantiere: ricevi lo stesso riepilogo da confermare.</p>' +
    "<noscript><p class=\"nota\"><b>Per caricare il file serve JavaScript attivo nel browser.</b></p></noscript>" +
    "</main><script>var GL_CR=" + dati + ";" + SCRIPT + "</script></body></html>";
}

const STILE =
  ":root{--accento:#0A7D48;--bordo:#d5dcd8;--sfondo:#F4F6F5;--cr:#1F5E8C;--cr-c:#EAF2F9}" +
  '*{box-sizing:border-box}body{margin:0;padding:0 0 40px;background:var(--sfondo);color:#111;line-height:1.45;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif}' +
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
  "main{max-width:720px;margin:0 auto;padding:16px 16px 0}" +
  // 31/10/2026 (Filippo): sul computer la pagina è larga fino a 1000 px, come le schede del cantiere
  "@media screen and (min-width:760px){main{max-width:min(1000px,calc(100vw - 48px))}}@media screen and (min-width:900px){main{max-width:min(1000px,calc(100vw - 200px))}}" +
  "a.indietro{display:inline-flex;align-items:center;min-height:44px;padding:0 12px 0 0;margin:-8px 0 4px;font-size:.95rem;font-weight:800;color:#0A7D48;text-decoration:none}" +
  ".box{background:#fff;border:1px solid var(--bordo);border-radius:12px;padding:12px 14px;margin:0 0 14px}.box .et{font-size:.78rem;color:#4A524E;text-transform:uppercase;letter-spacing:.04em}.box .v{font-weight:700;font-size:1.05rem}.box .k{font-size:.86rem;color:#4A524E;margin-top:2px;overflow-wrap:anywhere}" +
  ".avviso{background:#fff;border-left:4px solid #C27A12;border-radius:10px;padding:10px 14px;margin:0 0 12px;font-size:.92rem}" +
  ".cr-btn{display:flex;width:100%;align-items:center;justify-content:center;gap:10px;min-height:54px;margin:0 0 10px;border:0;border-radius:12px;background:var(--cr);color:#fff;font-weight:700;font-size:1.02rem;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.15)}" +
  ".cr-btn .ic{width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center}.cr-btn svg{width:20px;height:20px}" +
  ".cr-btn:focus-within{outline:3px solid #052A21;outline-offset:2px}#f-file{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden}" +
  ".tit{font-size:.92rem;color:var(--cr);font-weight:700;margin:16px 0 8px;padding-bottom:4px;border-bottom:2px solid var(--cr)}" +
  ".imp{background:#fff;border:1px solid var(--bordo);border-radius:12px;padding:10px 14px;margin-bottom:8px;display:flex;justify-content:space-between;gap:10px;align-items:center}.imp b{overflow-wrap:anywhere}.imp small{color:#4A524E}" +
  ".imp .st{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:none}" +
  ".pl{display:inline-block;border-radius:999px;padding:0 8px;font-size:.74rem;font-weight:700;white-space:nowrap;background:#EEF0EF;color:#4A524E}" +
  ".pl-pronto{background:#FFF4DC;color:#7A5300}.pl-confermato{background:#E3F3EA;color:#0B5E37}.pl-errore{background:#fdeaea;color:#8c1d18}.pl-in_lettura,.pl-ricevuto{background:var(--cr-c);color:var(--cr)}" +
  "button.apri,.az button{min-height:36px;padding:0 14px;border-radius:8px;border:1px solid var(--bordo);background:#fff;color:#23302A;font:inherit;font-size:.86rem;font-weight:600;cursor:pointer}" +
  ".az{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 4px}.az button.si{background:var(--accento);border-color:var(--accento);color:#fff;min-height:46px;font-size:.98rem;padding:0 20px}.az button.no{color:#8c1d18;border-color:#f0c9c6;min-height:46px}" +
  ".az button:disabled{opacity:.5;cursor:default}" +
  ".att{background:#fff;border:1px solid var(--bordo);border-radius:12px;padding:14px;font-size:.92rem}.att .giro{display:inline-block;width:16px;height:16px;border:3px solid var(--cr-c);border-top-color:var(--cr);border-radius:50%;vertical-align:-3px;margin-right:8px}" +
  "@media (prefers-reduced-motion:no-preference){.att .giro{animation:giro 1s linear infinite}}@keyframes giro{to{transform:rotate(360deg)}}" +
  ".ris{background:#fff;border:1px solid var(--bordo);border-radius:12px;padding:12px 14px}.ris b{overflow-wrap:anywhere}.ris .num{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:6px 0 10px}" +
  ".ris .num div{background:var(--sfondo);border-radius:10px;padding:8px;text-align:center}.ris .num b{display:block;font-size:1.3rem;font-variant-numeric:tabular-nums}.ris .num small{font-size:.76rem;color:#4A524E}" +
  ".ris .av{border-left:4px solid #C27A12;background:#FFF7EA;border-radius:8px;padding:6px 10px;margin:6px 0;font-size:.86rem}" +
  ".tab{width:100%;border-collapse:collapse;font-size:.86rem;margin-top:8px;table-layout:fixed}.tab td{padding:6px;border-top:1px solid #EEF0EF;vertical-align:top}.tab .d{font-size:.78rem;font-weight:400;font-variant-numeric:tabular-nums;color:#4A524E;margin-top:1px}" +
  '@media print{.box::before,.att::before,.ris::before{display:none!important}.box,.att,.ris{border:1.5px solid #1B2F4A!important}}' +
  '@media print{html body .box,html body .att,html body .ris{border:2px solid transparent!important;background:linear-gradient(#fff,#fff) padding-box,linear-gradient(135deg,#1B2F4A,#F26A10) border-box!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;box-shadow:none!important}}' +
  '@media print{html body .box,html body .att,html body .ris{box-decoration-break:clone;-webkit-box-decoration-break:clone}}' +
  // 30/10/2026 sera (Filippo): linea sfumata blu TIX → arancione sui riquadri della pagina
  '.box,.att,.ris{position:relative;border-color:transparent!important}.box::before,.att::before,.ris::before{content:"";position:absolute;inset:-1px;background:linear-gradient(135deg,#1B2F4A,#F26A10);padding:2px;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;border-radius:inherit}@media (prefers-color-scheme:dark){.box::before,.att::before,.ris::before{background:linear-gradient(135deg,#6F8FBF,#F26A10)}}' +
  ".tab tr.r td{font-weight:700}.tab tr.c td.n::before{content:'\\25C6  ';color:#C27A12}.tab td.n{overflow-wrap:anywhere}" +
  ".err{border-left:4px solid #8c1d18;background:#fdeaea;border-radius:10px;padding:10px 14px;font-size:.92rem}" +
  ".ok{border-left:4px solid var(--accento);background:#E3F3EA;border-radius:10px;padding:10px 14px;font-size:.95rem}" +
  ".nota{font-size:.82rem;color:#5b6560;margin:14px 2px 0;line-height:1.5}" +
  "details.tutte summary{cursor:pointer;color:var(--cr);font-weight:600;margin-top:8px}";

// Script della pagina: caricamento, attesa della lettura, riepilogo, conferma. Nessuna libreria esterna.
const SCRIPT = String.raw`(function(){
var D=GL_CR,q=function(s){return document.querySelector(s)};
var sez=q('#lavoro'),corpo=q('#w-corpo'),tit=q('#w-tit'),inp=q('#f-file'),timer=null,idCorrente=0,giri=0;
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function dIt(s){s=String(s||'').slice(0,10).split('-');return s.length===3?s[2]+'/'+s[1]+'/'+s[0]:''}
function mostra(t,h){sez.hidden=false;tit.textContent=t;corpo.innerHTML=h;sez.scrollIntoView({behavior:'smooth',block:'start'})}
function attesa(t){mostra('Lettura del file','<div class="att"><span class="giro" aria-hidden="true"></span>'+esc(t)+'</div>')}
function errore(t){mostra('Lettura del file','<div class="err">'+esc(t)+'</div>')}
function u(p){return D.base+p+'?t='+D.t+'&c='+D.c}
if(inp)inp.addEventListener('change',function(){
  var f=inp.files&&inp.files[0];inp.value='';if(!f)return;
  if(/\.mpp$/i.test(f.name)){errore('I file .mpp si aprono solo con Microsoft Project: da Project fai File → Salva con nome → XML (oppure stampa in PDF) e carica quel file.');return}
  if(f.size>18*1024*1024){errore('Il file è troppo grande (massimo 18 MB).');return}
  if(!f.size){errore('Il file è vuoto.');return}
  attesa('Invio di «'+f.name+'»…');
  fetch(u('/cronoprogramma/carica')+'&nome='+encodeURIComponent(f.name),{method:'POST',headers:{'Content-Type':f.type||'application/octet-stream'},body:f})
  .then(function(r){return r.json().catch(function(){return{esito:'incerto'}})})
  .then(function(r){
    if(r.esito==='ok'){segui(r.id);return}
    if(r.esito==='gettone'){location.href=D.base+'/';return}
    errore(r.messaggio||'Il file non è stato caricato. Riprova tra un minuto.');
  }).catch(function(){errore('Connessione assente: il file non è partito. Riprova.')});
});
function segui(id){idCorrente=id;giri=0;clearTimeout(timer);attesa('File ricevuto. Lo sto leggendo: di solito ci vuole meno di un minuto, per un PDF lungo o una foto anche due o tre.');chiedi()}
function chiedi(){
  fetch(D.base+'/cronoprogramma/stato?t='+D.t+'&c='+D.c+'&id='+idCorrente).then(function(r){return r.json()}).then(function(r){
    if(r.esito!=='ok'){errore('Non riesco a leggere lo stato del file. Ricarica la pagina.');return}
    if(r.stato==='ricevuto'||r.stato==='in_lettura'){
      if(++giri>100){errore('La lettura sta durando troppo. Ricarica la pagina tra qualche minuto: il file resta in lista.');return}
      timer=setTimeout(chiedi,giri<10?3000:6000);return}
    disegna(r);
  }).catch(function(){timer=setTimeout(chiedi,6000)});
}
function disegna(r){
  if(r.stato==='errore'){mostra('File non letto','<div class="err"><b>Non sono riuscito a leggere «'+esc(r.nome_file||'il file')+'»</b>: '+esc(r.errore||'errore sconosciuto')+'.</div><p class="nota">Prova con un altro formato: PDF stampato da Project, Excel con nome, inizio e fine, oppure XML di Project. Nel giornale non è cambiato nulla.</p>');return}
  if(r.stato==='confermato'){mostra('Cronoprogramma caricato','<div class="ok"><b>Fatto: è la versione '+esc(r.versione)+' del cronoprogramma.</b>'+(r.riportate?' '+esc(r.riportate)+' lavorazioni tengono date reali e avanzamento.':'')+'</div><div class="az"><button type="button" class="si" id="b-torna">Vai al cantiere</button></div>');q('#b-torna').onclick=function(){location.href=D.torna};return}
  if(r.stato!=='pronto'){mostra('File','<div class="att">Questo file è '+esc(r.stato)+'.</div>');return}
  var s=r.riepilogo||{},righe=r.righe||[],h='<div class="ris">';
  h+='<div><b>'+esc(r.nome_file||'File')+'</b></div><div class="num"><div><b>'+esc(s.attivita)+'</b><small>lavorazioni</small></div><div><b>'+esc(s.cardini)+'</b><small>traguardi</small></div><div><b>'+esc(s.gruppi)+'</b><small>gruppi</small></div></div>';
  if(s.inizio)h+='<div>Lavori dal <b>'+dIt(s.inizio)+'</b> al <b>'+dIt(s.fine)+'</b></div>';
  (r.avvisi||[]).forEach(function(a){h+='<div class="av">'+esc(a)+'</div>'});
  if(s.versione_in_uso)h+='<p class="nota" style="margin-top:8px">Sostituisce la versione '+esc(s.versione_in_uso)+' ('+esc(s.righe_in_uso)+' righe).'+(s.registrate_in_uso?(s.riportabili===s.registrate_in_uso?(s.registrate_in_uso===1?' La lavorazione già registrata tiene date reali e avanzamento.':' Le '+esc(s.registrate_in_uso)+' lavorazioni già registrate tengono date reali e avanzamento.'):' '+esc(s.riportabili)+' delle '+esc(s.registrate_in_uso)+' lavorazioni già registrate tengono date reali e avanzamento; le altre hanno cambiato nome e ripartono da zero.'):'')+'</p>';
  h+=tabella(righe.slice(0,25));
  if(righe.length>25)h+='<details class="tutte"><summary>Mostra tutte le '+righe.length+' righe</summary>'+tabella(righe.slice(25))+'</details>';
  h+='<div class="az"><button type="button" class="si" id="b-si">✅ Conferma e carica</button><button type="button" class="no" id="b-no">Annulla</button></div></div>';
  mostra('Controlla e conferma',h);
  q('#b-si').onclick=function(){azione('conferma')};q('#b-no').onclick=function(){azione('annulla')};
}
function tabella(rr){var h='<table class="tab"><tbody>';rr.forEach(function(x){var d=x.tipo==='cardine'?(x.fine?'traguardo '+dIt(x.fine):''):(x.inizio?dIt(x.inizio)+' → '+dIt(x.fine)+(x.tipo==='attivita'&&x.durata_gg!=null?' · '+x.durata_gg+' g':''):'');h+='<tr class="'+(x.tipo==='riepilogo'?'r':x.tipo==='cardine'?'c':'a')+'"><td class="n" style="padding-left:'+(6+12*Math.min(6,Math.max(0,(x.livello||1)-1)))+'px">'+esc(x.nome)+(d?'<div class="d">'+d+'</div>':'')+'</td></tr>'});return h+'</tbody></table>'}
function azione(a){
  var b1=q('#b-si'),b2=q('#b-no');if(b1)b1.disabled=true;if(b2)b2.disabled=true;
  fetch(D.base+'/cronoprogramma/azione',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:D.t,c:D.c,id:idCorrente,azione:a})})
  .then(function(r){return r.json()}).then(function(r){
    if(a==='annulla'){mostra('Annullato','<div class="att">Ok, non ho caricato nulla: il cronoprogramma resta quello di prima.</div>');return}
    if(r.esito==='ok'){mostra('Cronoprogramma caricato','<div class="ok"><b>Fatto: è la versione '+esc(r.versione)+' del cronoprogramma, con '+esc(r.righe)+' righe.</b>'+(r.riportate?' '+esc(r.riportate)+' lavorazioni tengono date reali e avanzamento.':'')+' Da adesso si aggiorna con i messaggi del giornale.</div><div class="az"><button type="button" class="si" id="b-torna">Vai al cantiere</button></div>');q('#b-torna').onclick=function(){location.href=D.torna};return}
    errore(r.esito==='stato'?'Questo file non è più da confermare ('+(r.stato||'')+'). Ricarica la pagina.':'Non sono riuscito a caricare il cronoprogramma: riprova tra un minuto.');
  }).catch(function(){if(b1)b1.disabled=false;if(b2)b2.disabled=false;errore('Connessione assente: riprova.')});
}
Array.prototype.forEach.call(document.querySelectorAll('button.apri'),function(b){b.addEventListener('click',function(){segui(Number(b.getAttribute('data-id')))})});
if(D.apri)segui(D.apri);
})();`;
