// ============================================================================
// FIRMATORE DI TIX (09/11/2026, firma-1, chat «Analisi economica» / Progetti). Pezzo comune per Costruttivi dei fornitori
// (tipo 'progetto_costruttivo'), poi Preventivi ('preventivo_offerta', chat 02B) e SAL ('sal'). Scelte di Filippo: firmano solo le
// persone indicate (si sceglie il nome, niente codice; resta scritto anche l'accesso usato), firma nel punto toccato sulla pagina
// oppure «In fondo all'ultima pagina», firma digitale qualificata subito, timbro unico per l'impresa, una firma per persona.
// La firma semplice la mette il BROWSER (pdf.js per vedere la pagina, pdf-lib per scrivere il PDF, tutte e due gratis da cdnjs):
// il Worker riceve solo la copia firmata, controlla che sia un PDF (o un .p7m / PDF firmato digitalmente), ricalcola l'impronta fino
// a 5 MB e la salva in wa-media; il database (firma_registra) controlla regole, persona e impronta dell'originale.
//   GET  /firma/firma-tix.js                       → modulo del browser: window.TIXFirma.apri({...})
//   GET  /firma/impostazioni?t=…&c=…               → pagina «Firme e timbro» (chi può firmare, firme, timbro)
//   POST /firma/azione  {t, c, azione: "prepara", tipo, rif_id} | {azione: "firmatario_salva", dati} | {azione: "firmatario_togli", id, chi}
//   POST /firma/immagine  X-Firma-Dati {t, c, cosa: firma|timbro, id?, nome?, qualifica?, chi, mime, byte, sha256}; corpo = PNG/JPG
//   GET  /firma/immagine?t=…&c=…&cosa=firma|timbro[&id=…]  → l'immagine, SOLO all'ufficio della stessa impresa
//   POST /firma/salva  X-Firma-Dati {t, c, tipo, rif_id, firmatario_id, esito, nota, pagina, posizione, sha256_originale, sha256,
//                      byte, nome, qualificata}; corpo = copia firmata (PDF, oppure .p7m / PDF PAdES se qualificata)
//   GET  /firma/file?t=…&c=…&id=<firma>[&scarica=1] → la copia firmata
// File: wa-media/firme/<azienda>/immagini/AAAAMMGG-<12 esadecimali>.png|jpg e wa-media/firme/<azienda>/documenti/….pdf|p7m.
// Interruttori: impostazioni.firma_attiva (no / prova / si) e FIRMA = "off" nel Worker.
// ============================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERIFICA_MAX = 5 * 1024 * 1024;
const TIPI = ["progetto_costruttivo", "preventivo_offerta", "sal"];

function supabaseUrl(env) { return env.SUPABASE_URL || "https://rvigugiufrjmzedjstuz.supabase.co"; }
function json(o, stato) {
  return new Response(JSON.stringify(o), { status: stato || 200, headers: {
    "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
}
function testo(x, max) { return String(x == null ? "" : x).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max); }
function nota(x) { return String(x == null ? "" : x).replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ").trim().slice(0, 2000); }
function casuale(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); }
function esadecimale(buf) { return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join(""); }
function daB64url(s) {
  const b = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4));
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return new TextDecoder().decode(u);
}
function percorsoStorage(p) { return String(p).split("/").map(encodeURIComponent).join("/"); }
function parametri(inUrl) {
  const s = inUrl.searchParams;
  const m = String(s.get("t") || "").match(/[0-9a-fA-F]{64}/);
  const c = String(s.get("c") || "").toLowerCase().replace(/[^0-9a-f-]/g, "").slice(0, 36);
  return { tok: m ? m[0].toLowerCase() : "", c };
}
function giorno() {
  const o = new Date();
  return o.getUTCFullYear() + String(o.getUTCMonth() + 1).padStart(2, "0") + String(o.getUTCDate()).padStart(2, "0");
}
function leggiDati(request) {
  const g = String(request.headers.get("X-Firma-Dati") || "");
  if (!g || g.length > 16000 || !/^[A-Za-z0-9_-]+$/.test(g)) return null;
  try { const d = JSON.parse(daB64url(g)); return d && typeof d === "object" ? d : null; } catch (e) { return null; }
}
function contiene(bytes, testoAscii) {   // cerca una parola ASCII nel file (per «/ByteRange» dei PDF firmati), a pezzi da 4 MB
  const passo = 4 * 1024 * 1024, dec = new TextDecoder("latin1");
  for (let i = 0; i < bytes.length; i += passo - testoAscii.length) {
    if (dec.decode(bytes.subarray(i, Math.min(bytes.length, i + passo))).indexOf(testoAscii) !== -1) return true;
  }
  return false;
}
async function caricaArchivio(env, percorso, bytes, mime) {
  const svc = env.SUPABASE_SERVICE_KEY;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const up = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorsoStorage(percorso), {
      method: "POST", headers: { Authorization: "Bearer " + svc, apikey: svc, "Content-Type": mime, "x-upsert": "false" }, body: bytes, signal: ctrl.signal });
    return up.ok;
  } catch (e) { return false; } finally { clearTimeout(timer); }
}
async function togliArchivio(env, percorso) {
  if (!/^firme\/[0-9a-f-]{36}\/(immagini|documenti)\/[0-9]{8}-[0-9a-f]{12}\.(png|jpg|pdf|p7m)$/.test(String(percorso || ""))) return false;
  try {
    const r = await fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorsoStorage(percorso), {
      method: "DELETE", headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } });
    return r.ok;
  } catch (e) { return false; }
}
async function leggiArchivio(env, percorso) {
  return fetch(supabaseUrl(env) + "/storage/v1/object/wa-media/" + percorsoStorage(percorso), {
    headers: { Authorization: "Bearer " + env.SUPABASE_SERVICE_KEY, apikey: env.SUPABASE_SERVICE_KEY } }).catch(() => null);
}

// ---------------------------------------------------------------------------- rotte
export async function portaleFirma(request, env, base, inUrl, h) {
  if (env.FIRMA === "off") return new Response("Not Found", { status: 404 });
  const sotto = inUrl.pathname.slice(base.length).replace(/\/+$/, "");
  if (sotto === "/firma/firma-tix.js") {
    return new Response(request.method === "HEAD" ? null : FIRMA_JS, { status: 200, headers: {
      "Content-Type": "application/javascript; charset=UTF-8", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" } });
  }
  if (!env.SUPABASE_SERVICE_KEY) return new Response("Servizio non configurato.", { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  if (sotto === "/firma/azione") return azione(request, env, h);
  if (sotto === "/firma/salva") return salva(request, env, h);
  if (sotto === "/firma/immagine") return request.method === "POST" ? immagineCarica(request, env, h) : immagineServi(request, env, inUrl, h);
  if (sotto === "/firma/file") return fileFirmato(request, env, base, inUrl, h);
  if (sotto === "/firma/impostazioni") return impostazioni(request, env, base, inUrl, h);
  return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
}

async function azione(request, env, h) {
  if (request.method !== "POST") return json({ esito: "metodo_non_consentito" }, 405);
  if (Number(request.headers.get("Content-Length") || 0) > 20000) return json({ esito: "richiesta_non_valida" }, 413);
  let d = null;
  try { d = await request.json(); } catch (e) { d = null; }
  if (!d || typeof d !== "object") return json({ esito: "richiesta_non_valida" }, 400);
  const tok = /^[0-9a-fA-F]{64}$/.test(String(d.t || "")) ? String(d.t).toLowerCase() : "";
  const c = String(d.c || "").toLowerCase();
  if (!tok) return json({ esito: "gettone" }, 403);
  if (!UUID.test(c)) return json({ esito: "richiesta_non_valida" }, 400);
  const a = String(d.azione || "");
  let r = null;
  if (a === "prepara") {
    if (TIPI.indexOf(String(d.tipo || "")) === -1) return json({ esito: "richiesta_non_valida" }, 400);
    r = await h.rpc(env, "firma_prepara", { p_token: tok, p_commessa: c, p_tipo: String(d.tipo), p_rif: testo(d.rif_id, 80) }, 15000).catch(() => null);
  } else if (a === "firmatario_salva") {
    const x = d.dati && typeof d.dati === "object" ? d.dati : {};
    const dati = { nome: testo(x.nome, 120), chi: testo(x.chi, 120) };
    if (x.id) dati.id = testo(x.id, 40);
    if ("qualifica" in x) dati.qualifica = testo(x.qualifica, 80);
    r = await h.rpc(env, "firma_firmatario_salva", { p_token: tok, p_commessa: c, p_dati: dati }, 15000).catch(() => null);
  } else if (a === "firmatario_togli") {
    const id = String(d.id || "").toLowerCase();
    if (!UUID.test(id)) return json({ esito: "richiesta_non_valida" }, 400);
    r = await h.rpc(env, "firma_firmatario_togli", { p_token: tok, p_commessa: c, p_id: id, p_chi: testo(d.chi, 120) }, 15000).catch(() => null);
  } else {
    return json({ esito: "richiesta_non_valida" }, 400);
  }
  if (!r || typeof r !== "object") return json({ esito: "incerto", messaggio: "Il servizio non risponde: riprova tra un minuto." }, 503);
  return json(r, r.esito === "gettone" ? 403 : 200);
}

// immagine della firma di una persona o del timbro: PNG o JPG fino a 1 MB, impronta controllata, poi registrata nel database
async function immagineCarica(request, env, h) {
  const d = leggiDati(request);
  if (!d) return json({ esito: "richiesta_non_valida", messaggio: "Richiesta non valida: ricarica la pagina." }, 400);
  const tok = /^[0-9a-fA-F]{64}$/.test(String(d.t || "")) ? String(d.t).toLowerCase() : "";
  const c = String(d.c || "").toLowerCase();
  const cosa = d.cosa === "timbro" ? "timbro" : d.cosa === "firma" ? "firma" : "";
  if (!tok) return json({ esito: "gettone" }, 403);
  if (!UUID.test(c) || !cosa) return json({ esito: "richiesta_non_valida", messaggio: "Richiesta non valida: ricarica la pagina." }, 400);
  const byte = Number(d.byte), sha = String(d.sha256 || "").toLowerCase(), mime = d.mime === "image/jpeg" ? "image/jpeg" : d.mime === "image/png" ? "image/png" : "";
  const ctl = await h.rpc(env, "firma_immagine_controlla", { p_token: tok, p_commessa: c, p_dati: { byte, mime } }, 10000).catch(() => null);
  if (!ctl || typeof ctl !== "object") return json({ esito: "incerto", messaggio: "Il servizio non risponde: riprova tra un minuto." }, 502);
  if (ctl.esito !== "ok") return json(ctl, ctl.esito === "gettone" ? 403 : 200);
  if (!/^[0-9a-f]{64}$/.test(sha)) return json({ esito: "errore", messaggio: "Manca l'impronta dell'immagine: ricarica la pagina." }, 400);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length !== byte || bytes.length > Number(ctl.max_byte || 1048576)) return json({ esito: "incompleto", messaggio: "L'immagine non è arrivata intera: riprova." }, 400);
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if ((mime === "image/png" && !png) || (mime === "image/jpeg" && !jpg)) return json({ esito: "formato", messaggio: "Il file non è un'immagine PNG o JPG." }, 415);
  if (esadecimale(await crypto.subtle.digest("SHA-256", bytes)) !== sha) return json({ esito: "impronta", messaggio: "L'immagine non è arrivata intera: riprova." }, 400);
  const percorso = String(ctl.cartella || "") + giorno() + "-" + casuale(6) + "." + (png ? "png" : "jpg");
  if (!/^firme\/[0-9a-f-]{36}\/immagini\//.test(percorso)) return json({ esito: "errore", messaggio: "Richiesta non valida: ricarica la pagina." }, 502);
  if (!(await caricaArchivio(env, percorso, bytes, mime))) return json({ esito: "archivio", messaggio: "L'immagine non si è salvata: riprova tra un minuto." }, 502);
  const dati = { percorso, sha256: sha, mime, chi: testo(d.chi, 120) };
  let r;
  if (cosa === "timbro") {
    r = await h.rpc(env, "firma_timbro_salva", { p_token: tok, p_commessa: c, p_dati: dati }, 15000).catch(() => null);
  } else {
    if (d.id) dati.id = testo(d.id, 40);
    if (d.nome) dati.nome = testo(d.nome, 120);
    if ("qualifica" in d) dati.qualifica = testo(d.qualifica, 80);
    r = await h.rpc(env, "firma_firmatario_salva", { p_token: tok, p_commessa: c, p_dati: dati }, 15000).catch(() => null);
  }
  if (!r || typeof r !== "object") return json({ esito: "incerto", messaggio: "Non so se l'immagine è stata registrata: ricarica la pagina." }, 502);
  if (r.esito !== "ok") { await togliArchivio(env, percorso); return json(r, r.esito === "gettone" ? 403 : 200); }
  return json(r);
}

async function immagineServi(request, env, inUrl, h) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
  const p = parametri(inUrl);
  const cosa = inUrl.searchParams.get("cosa") === "timbro" ? "timbro" : "firma";
  const id = String(inUrl.searchParams.get("id") || "").toLowerCase();
  if (!p.tok || !UUID.test(p.c) || (cosa === "firma" && !UUID.test(id))) return new Response("Not Found", { status: 404 });
  const info = await h.rpc(env, "firma_immagine_info", { p_token: p.tok, p_commessa: p.c, p_cosa: cosa, p_id: cosa === "firma" ? id : null }, 10000).catch(() => null);
  if (!info || info.esito !== "ok") return new Response("Not Found", { status: 404 });
  const perc = String(info.percorso || "");
  if (perc.indexOf("firme/" + info.azienda_id + "/immagini/") !== 0 || perc.indexOf("..") !== -1) return new Response("Not Found", { status: 404 });
  const f = await leggiArchivio(env, perc);
  if (!f || !f.ok) return new Response("Not Found", { status: 404 });
  return new Response(request.method === "HEAD" ? null : f.body, { status: 200, headers: {
    "Content-Type": info.mime === "image/jpeg" ? "image/jpeg" : "image/png", "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" } });
}

// la copia firmata: PDF firmato da TIX, oppure (qualificata) .p7m o PDF con firma digitale (/ByteRange)
async function salva(request, env, h) {
  if (request.method !== "POST") return json({ esito: "metodo_non_consentito" }, 405);
  const d = leggiDati(request);
  if (!d) return json({ esito: "richiesta_non_valida", messaggio: "Richiesta non valida: ricarica la pagina." }, 400);
  const tok = /^[0-9a-fA-F]{64}$/.test(String(d.t || "")) ? String(d.t).toLowerCase() : "";
  const c = String(d.c || "").toLowerCase();
  if (!tok) return json({ esito: "gettone" }, 403);
  if (!UUID.test(c) || TIPI.indexOf(String(d.tipo || "")) === -1) return json({ esito: "richiesta_non_valida", messaggio: "Richiesta non valida: ricarica la pagina." }, 400);
  const qual = d.qualificata === true;
  const byte = Number(d.byte), sha = String(d.sha256 || "").toLowerCase();
  const dichiarati = Number(request.headers.get("Content-Length") || 0);
  if (!Number.isFinite(byte) || byte <= 0) return json({ esito: "vuoto", messaggio: "Il file firmato è vuoto." }, 400);
  if (dichiarati && dichiarati !== byte) return json({ esito: "incompleto", messaggio: "Il file non è arrivato intero: riprova." }, 400);
  const ctl = await h.rpc(env, "firma_salva_controlla", { p_token: tok, p_commessa: c,
    p_dati: { tipo: d.tipo, rif_id: testo(d.rif_id, 80), byte, qualificata: qual } }, 10000).catch(() => null);
  if (!ctl || typeof ctl !== "object") return json({ esito: "incerto", messaggio: "Il servizio non risponde: riprova tra un minuto." }, 502);
  if (ctl.esito !== "ok") return json(ctl, ctl.esito === "gettone" ? 403 : 200);
  if (!/^[0-9a-f]{64}$/.test(sha)) return json({ esito: "errore", messaggio: "Manca l'impronta del file firmato: riprova." }, 400);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length !== byte || bytes.length > Number(ctl.max_byte || 0)) return json({ esito: "incompleto", messaggio: "Il file non è arrivato intero: riprova." }, 400);
  const testa = String.fromCharCode.apply(null, Array.from(bytes.subarray(0, 1024)));
  const pdf = testa.indexOf("%PDF-") !== -1;
  let est = "pdf";
  if (!qual) {
    if (!pdf) return json({ esito: "formato", messaggio: "La copia firmata non è un PDF: riprova." }, 415);
  } else if (bytes[0] === 0x30) {
    est = "p7m";
  } else if (!pdf || !contiene(bytes, "/ByteRange")) {
    return json({ esito: "formato", messaggio: "Nel file non c'è una firma digitale: carica il .p7m oppure il PDF firmato (PAdES) che ti dà il programma di firma." }, 415);
  }
  if (bytes.length <= VERIFICA_MAX && esadecimale(await crypto.subtle.digest("SHA-256", bytes)) !== sha) {
    return json({ esito: "impronta", messaggio: "Il file non è arrivato intero: riprova." }, 400);
  }
  const percorso = String(ctl.cartella || "") + giorno() + "-" + casuale(6) + "." + est;
  if (!/^firme\/[0-9a-f-]{36}\/documenti\//.test(percorso)) return json({ esito: "errore", messaggio: "Richiesta non valida: ricarica la pagina." }, 502);
  if (!(await caricaArchivio(env, percorso, bytes, est === "p7m" ? "application/pkcs7-mime" : "application/pdf"))) {
    return json({ esito: "archivio", messaggio: "La copia firmata non si è salvata: riprova tra un minuto." }, 502);
  }
  const pos = d.posizione && typeof d.posizione === "object" ? {
    x: Math.round(Number(d.posizione.x) || 0), y: Math.round(Number(d.posizione.y) || 0),
    w: Math.round(Number(d.posizione.w) || 0), h: Math.round(Number(d.posizione.h) || 0), rot: Math.round(Number(d.posizione.rot) || 0) } : null;
  const r = await h.rpc(env, "firma_registra", { p_token: tok, p_commessa: c, p_dati: {
    tipo: d.tipo, rif_id: testo(d.rif_id, 80), firmatario_id: testo(d.firmatario_id, 40), esito: testo(d.esito, 80), nota: nota(d.nota),
    pagina: Number.isFinite(Number(d.pagina)) ? Math.round(Number(d.pagina)) : null, posizione: pos, sha256_originale: String(d.sha256_originale || "").toLowerCase(),
    percorso, sha256: sha, byte: bytes.length, nome: testo(d.nome, 200).replace(/[\\/]+/g, " "), qualificata: qual } }, 15000).catch(() => null);
  if (!r || typeof r !== "object") return json({ esito: "incerto", messaggio: "Non so se la firma è stata registrata: ricarica la pagina prima di riprovare." }, 502);
  if (r.esito !== "ok") { await togliArchivio(env, percorso); return json(r, r.esito === "gettone" ? 403 : 200); }
  return json(r);
}

async function fileFirmato(request, env, base, inUrl, h) {
  const metodo = request.method;
  if (metodo !== "GET" && metodo !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
  const p = parametri(inUrl);
  const id = String(inUrl.searchParams.get("id") || "").toLowerCase();
  const scarica = inUrl.searchParams.get("scarica") === "1";
  const e = h.esc;
  const indietro = '<a class="btn" href="' + e(base + "/?t=" + p.tok + "&c=" + p.c) + '">Torna al cantiere</a>';
  if (!p.tok) return Response.redirect(inUrl.origin + base + "/", 303);
  if (!UUID.test(p.c) || !UUID.test(id)) return h.risposta(h.foglio(base, "Copia firmata non trovata", "", indietro), 404);
  const info = await h.rpc(env, "firma_file_info", { p_token: p.tok, p_commessa: p.c, p_id: id }, 10000).catch(() => null);
  if (!info || typeof info !== "object") return h.risposta(h.foglio(base, "Copia firmata", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (info.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (info.esito !== "ok") return h.risposta(h.foglio(base, "Copia firmata non trovata", "", indietro), 404);
  const perc = String(info.percorso || "");
  if (perc.indexOf("firme/" + info.azienda_id + "/documenti/") !== 0 || perc.indexOf("..") !== -1) return h.risposta(h.foglio(base, "Copia firmata non trovata", "", indietro), 404);
  const f = await leggiArchivio(env, perc);
  if (!f || !f.ok) return h.risposta(h.foglio(base, "Copia firmata", "Il file non si legge dall'archivio in questo momento: riprova tra un minuto.", indietro), 502);
  const p7m = info.mime === "application/pkcs7-mime";
  const nome = String(info.nome || (p7m ? "firmato.p7m" : "firmato.pdf"));
  const ascii = nome.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "") || (p7m ? "firmato.p7m" : "firmato.pdf");
  const hd = { "Content-Type": p7m ? "application/pkcs7-mime" : "application/pdf",
    "Content-Disposition": (scarica || p7m ? "attachment" : "inline") + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(nome),
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" };
  const lun = f.headers.get("Content-Length");
  if (lun && /^[0-9]+$/.test(lun)) hd["Content-Length"] = lun;
  return new Response(metodo === "HEAD" ? null : f.body, { status: 200, headers: hd });
}

// ---------------------------------------------------------------------------- pagina «Firme e timbro»
async function impostazioni(request, env, base, inUrl, h) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
  const p = parametri(inUrl);
  if (!p.tok) return Response.redirect(inUrl.origin + base + "/", 303);
  if (!UUID.test(p.c)) return Response.redirect(inUrl.origin + base + "/?t=" + p.tok, 303);
  const torna = inUrl.searchParams.get("da") === "costruttivi" ? base + "/costruttivi?t=" + p.tok + "&c=" + p.c : base + "/?t=" + p.tok + "&c=" + p.c;
  const indietro = '<p><a href="' + h.esc(torna) + '">Torna indietro</a></p>';
  const d = await h.rpc(env, "firma_impostazioni", { p_token: p.tok, p_commessa: p.c }, 15000).catch(() => null);
  if (!d || typeof d !== "object") return h.risposta(h.foglio(base, "Firme e timbro", "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", indietro), 503);
  if (d.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (d.esito !== "ok") return h.risposta(h.foglio(base, "Firme e timbro", "Questa pagina non è disponibile.", indietro), 404);
  return h.risposta(paginaImpostazioni(base, h, p, d, torna, inUrl.searchParams.get("da") === "costruttivi"));
}

function quando(ts) {
  const s = String(ts || "");
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(s) ? s.slice(8, 10) + "/" + s.slice(5, 7) + "/" + s.slice(0, 4) + (/T[0-9]{2}:[0-9]{2}/.test(s) ? " alle " + s.slice(11, 16) : "") : "";
}

function paginaImpostazioni(base, h, p, d, torna, daCostruttivi) {
  const e = h.esc;
  const img = (cosa, id, sha) => base + "/firma/immagine?t=" + p.tok + "&c=" + p.c + "&cosa=" + cosa + (id ? "&id=" + id : "") + "&v=" + encodeURIComponent(String(sha || "").slice(0, 8));
  const firmatari = Array.isArray(d.firmatari) ? d.firmatari : [];
  const lista = firmatari.length ? firmatari.map((f) => '<div class="fi-p"><div class="fi-img">' +
      (f.ha_firma ? '<img alt="Firma di ' + e(f.nome) + '" src="' + e(img("firma", f.id, f.creato_il)) + '">' : '<span>Firma non ancora caricata</span>') + '</div>' +
      '<div class="fi-dati"><b>' + e(f.nome) + '</b>' + (f.qualifica ? '<span class="fi-q">' + e(f.qualifica) + '</span>' : "") +
      '<small>indicata da ' + e(f.creato_da || "") + ' il ' + e(quando(f.creato_il)) + '</small></div>' +
      '<div class="fi-az"><button type="button" class="btn sm sec" data-cambia="' + e(f.id) + '" data-nome="' + e(f.nome) + '">' + (f.ha_firma ? "Cambia la firma" : "Aggiungi la firma") + '</button>' +
      '<button type="button" class="btn sm togli" data-togli="' + e(f.id) + '" data-nome="' + e(f.nome) + '">Togli</button></div></div>').join("")
    : '<p class="fi-vuoto">Nessuna persona indicata. Aggiungi qui sotto chi può firmare per l\'impresa: il titolare e i delegati.</p>';
  const t = d.timbro && typeof d.timbro === "object" ? d.timbro : null;
  const cfg = JSON.stringify({ b: base, t: p.tok, c: p.c }).replace(/</g, "\\u003c");
  return '<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light">' +
    "<title>Firme e timbro - TIX · Diario di cantiere</title>" + h.testa(base) + "<style>" + STILE_IMP + "</style></head><body><main>" +
    '<a class="fi-torna" href="' + e(torna) + '">‹ ' + (daCostruttivi ? "Torna ai Costruttivi dei fornitori" : "Torna al cantiere") + '</a>' +
    '<div class="fi-card"><p class="fi-sop">' + e(d.impresa || "") + '</p><h1>Firme e timbro dell\'impresa</h1>' +
    (d.modo === "prova" ? '<p class="fi-prova">In prova: questa pagina la vede solo l\'accesso «Tutte le aziende»</p>' : "") +
    '<div class="fi-info"><b>Chi può firmare per l\'impresa.</b> Qui indichi le persone che possono firmare i documenti con TIX, per esempio i costruttivi dei fornitori, ' +
    'e carichi la firma di ognuna e il timbro dell\'impresa. Quando si firma si sceglie il nome dall\'elenco; resta scritto anche da quale accesso è partita la firma. ' +
    'Le immagini di firme e timbro le vede solo l\'ufficio dell\'impresa: mai i professionisti, i fornitori o altre imprese.</div>' +
    '<h2>Chi può firmare</h2><div class="fi-lista">' + lista + '</div>' +
    '<section class="fi-box" id="nuovo"><h3>Aggiungi una persona che può firmare</h3>' +
    '<div class="fi-campi"><label>Nome e cognome<input id="fi-nome" maxlength="120" autocomplete="off" placeholder="es. Mario Rossi"></label>' +
    '<label>Qualifica<input id="fi-qual" maxlength="80" list="fi-qualifiche" placeholder="es. Titolare"></label></div>' +
    '<datalist id="fi-qualifiche"><option value="Titolare"><option value="Legale rappresentante"><option value="Delegato"><option value="Direttore tecnico"><option value="Responsabile di commessa"></datalist>' +
    '<p class="fi-sotto">La firma la puoi disegnare qui col dito o col mouse, oppure caricarla da un\'immagine. Si può anche aggiungere dopo.</p>' +
    '<div class="fi-firma" data-pad="nuovo"></div>' +
    '<p class="fi-msg" id="fi-msg-nuovo" role="status"></p><div class="fi-bot"><button type="button" class="btn pr" id="fi-salva-nuovo">Aggiungi</button></div></section>' +
    '<h2>Timbro dell\'impresa</h2><section class="fi-box"><div class="fi-timbro">' +
    (t ? '<div class="fi-img fi-img-t"><img alt="Timbro" src="' + e(img("timbro", "", t.sha256)) + '"></div><p class="fi-sotto">Caricato da ' + e(t.caricato_da || "") + ' il ' + e(quando(t.caricato_il)) + '.</p>'
       : '<p class="fi-sotto">Il timbro non è ancora caricato. Fotografa o scansiona il timbro su un foglio bianco: TIX toglie lo sfondo bianco da solo.</p>') +
    '</div><label class="btn sec">' + (t ? "Cambia il timbro" : "Carica il timbro") + '<input type="file" id="fi-timbro" accept="image/png,image/jpeg" hidden></label>' +
    '<p class="fi-msg" id="fi-msg-timbro" role="status"></p></section>' +
    '<div class="fi-chi"><label for="fi-chi">Il tuo nome</label><input id="fi-chi" maxlength="120" autocomplete="name" placeholder="Resta scritto chi ha fatto le modifiche"></div>' +
    '</div></main>' +
    '<dialog class="fi-dlg" id="fi-dlg"><form method="dialog"><h3 id="fi-dlg-tit">Firma</h3><div class="fi-firma" data-pad="cambia"></div>' +
    '<p class="fi-msg" id="fi-msg-cambia" role="status"></p><div class="fi-bot"><button value="no" class="btn tenue">Annulla</button><button type="button" class="btn pr" id="fi-salva-cambia">Salva la firma</button></div></form></dialog>' +
    "<script>var CFG=" + cfg + ";" + SCRIPT_IMP + "</script></body></html>";
}

const STILE_IMP =
  ":root{--navy:#1B2F4A;--pr:#3F4A9E;--pr-s:#2C3577;--pr-f:#EEF0FA;--pr-b:#C9CDEC;--t:#17212E;--s:#5B6672;--l:rgba(16,27,43,.11);--ro:#B3261E;--ro-b:#F2B8B5;--ok:#146C43}" +
  "*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;color:var(--t);font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,system-ui,sans-serif;background:#F8FAFC}" +
  "main{max-width:900px;margin:0 auto;padding:16px 16px 48px}" +
  ".fi-torna{display:inline-block;margin:0 0 12px;padding:6px 14px;border-radius:999px;border:1px solid var(--l);background:#fff;color:var(--navy);font-weight:600;text-decoration:none}" +
  ".fi-card{background:#fff;border-radius:16px;padding:18px;box-shadow:0 1px 2px rgba(16,27,43,.05),0 8px 20px -14px rgba(16,27,43,.2)}" +
  ".fi-sop{margin:0;color:var(--s);font-size:.88rem}h1{margin:4px 0 8px;font-size:1.45rem;color:var(--navy)}h2{margin:22px 0 10px;font-size:1.05rem;color:var(--navy)}h3{margin:0 0 10px;font-size:1rem;color:var(--navy)}" +
  ".fi-prova{display:inline-block;margin:0 0 10px;padding:3px 10px;border:1px dashed var(--pr-b);border-radius:999px;background:var(--pr-f);color:var(--pr-s);font-size:.8rem;font-weight:600}" +
  ".fi-info{padding:12px 14px;border-radius:14px;border:1px solid var(--pr-b);background:var(--pr-f);font-size:.9rem;line-height:1.5}.fi-info b{color:var(--pr-s)}" +
  ".fi-lista{display:flex;flex-direction:column;gap:10px}.fi-vuoto{margin:0;color:var(--s)}" +
  ".fi-p{display:grid;grid-template-columns:180px minmax(0,1fr) auto;gap:10px 14px;align-items:center;padding:10px 12px;border:1px solid var(--l);border-radius:14px}" +
  ".fi-img{height:64px;border:1px dashed var(--l);border-radius:10px;display:flex;align-items:center;justify-content:center;background:#fff;overflow:hidden}.fi-img img{max-width:100%;max-height:60px}.fi-img span{font-size:.78rem;color:var(--s)}" +
  ".fi-img-t{width:160px;height:120px}.fi-img-t img{max-height:116px}" +
  ".fi-dati{display:flex;flex-direction:column;gap:2px}.fi-dati b{font-size:1rem}.fi-q{color:var(--pr-s);font-size:.84rem;font-weight:600}.fi-dati small{color:var(--s);font-size:.78rem}" +
  ".fi-az{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}" +
  ".fi-box{margin-top:14px;padding:14px;border:1px solid var(--pr-b);border-radius:14px;background:linear-gradient(180deg,#F7F8FD,#fff 60%)}" +
  ".fi-campi{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.fi-campi label,.fi-chi label{display:flex;flex-direction:column;gap:4px;font-size:.84rem;font-weight:700;color:var(--navy)}" +
  "input:not([type=file]){min-height:38px;padding:0 10px;border:1px solid rgba(16,27,43,.18);border-radius:10px;font:inherit;font-size:.92rem}" +
  ".fi-sotto{margin:10px 0;font-size:.86rem;color:var(--s);line-height:1.45}" +
  ".fi-firma .tab{display:flex;gap:6px;margin:0 0 8px}.fi-firma .tab button{padding:5px 12px;border-radius:999px;border:1px solid var(--l);background:#fff;font:inherit;font-size:.84rem;font-weight:600;cursor:pointer}.fi-firma .tab button.on{background:var(--navy);color:#fff;border-color:var(--navy)}" +
  ".fi-firma canvas{width:100%;max-width:520px;height:170px;border:1.5px dashed var(--pr-b);border-radius:12px;background:#fff;touch-action:none;display:block}" +
  ".fi-firma .riga{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px;font-size:.82rem;color:var(--s)}.fi-firma .anteprima{max-width:260px;max-height:90px;border:1px dashed var(--l);border-radius:8px;display:block;margin-top:6px;background:#fff}" +
  ".fi-timbro{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin:0 0 10px}" +
  ".fi-chi{margin-top:18px;max-width:420px}.fi-chi label{gap:4px}" +
  ".fi-msg{margin:8px 0 0;font-size:.9rem;font-weight:600;color:var(--ro);min-height:1px}.fi-msg.ok{color:var(--ok)}.fi-bot{display:flex;justify-content:flex-end;gap:10px;margin-top:10px}" +
  ".btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:40px;padding:0 16px;border-radius:12px;border:1px solid var(--navy);background:#fff;color:var(--navy);font:inherit;font-weight:700;font-size:.9rem;text-decoration:none;cursor:pointer}" +
  ".btn.pr{border-color:var(--pr);background:var(--pr);color:#fff}.btn.pr:disabled{opacity:.6;cursor:wait}.btn.sec{border-color:var(--pr);color:var(--pr-s);background:var(--pr-f)}" +
  ".btn.sm{min-height:32px;padding:0 12px;font-size:.82rem;border-radius:10px}.btn.togli{border-color:var(--ro-b);color:var(--ro)}.btn.tenue{border-color:rgba(16,27,43,.16);color:var(--t)}" +
  ".fi-dlg{max-width:600px;width:calc(100vw - 32px);border:0;border-radius:16px;padding:18px}.fi-dlg::backdrop{background:rgba(16,27,43,.45)}" +
  "@media (max-width:680px){.fi-p{grid-template-columns:minmax(0,1fr)}.fi-az{justify-content:flex-start}.fi-campi{grid-template-columns:minmax(0,1fr)}}";

// Disegno o caricamento della firma, timbro con lo sfondo bianco tolto, tutto ridotto a PNG nel browser prima di mandarlo.
const SCRIPT_IMP = String.raw`(function(){try{
var D=document;function $(i){return D.getElementById(i);}
function leggiChi(){try{return localStorage.getItem('tix_pg_chi')||'';}catch(e){return '';}}
function scriviChi(v){try{if(v)localStorage.setItem('tix_pg_chi',v);}catch(e){}}
function b64url(s){var u=unescape(encodeURIComponent(s));return btoa(u).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function esa(buf){return Array.prototype.map.call(new Uint8Array(buf),function(x){return ('0'+x.toString(16)).slice(-2);}).join('');}
var chi=$('fi-chi');if(chi&&!chi.value)chi.value=leggiChi();
function nome(){var v=(chi&&chi.value||'').trim();if(!v){chi.focus();return '';}scriviChi(v);return v;}
// immagine → PNG: ridotta (lato lungo 1200 px), bianchi resi trasparenti, ritagliata sul disegno
function aPng(src,trasparente){return new Promise(function(ok,ko){var im=new Image();im.onload=function(){var k=Math.min(1,1200/Math.max(im.width,im.height));
var w=Math.max(1,Math.round(im.width*k)),hh=Math.max(1,Math.round(im.height*k));var cv=D.createElement('canvas');cv.width=w;cv.height=hh;var g=cv.getContext('2d');g.drawImage(im,0,0,w,hh);
var dati=g.getImageData(0,0,w,hh),p=dati.data,x0=w,y0=hh,x1=-1,y1=-1;for(var y=0;y<hh;y++)for(var x=0;x<w;x++){var i=(y*w+x)*4;
if(trasparente&&p[i]>215&&p[i+1]>215&&p[i+2]>215)p[i+3]=0;if(p[i+3]>20){if(x<x0)x0=x;if(y<y0)y0=y;if(x>x1)x1=x;if(y>y1)y1=y;}}
if(x1<0){ko(new Error('vuota'));return;}g.putImageData(dati,0,0);var m=6;x0=Math.max(0,x0-m);y0=Math.max(0,y0-m);x1=Math.min(w-1,x1+m);y1=Math.min(hh-1,y1+m);
var out=D.createElement('canvas');out.width=x1-x0+1;out.height=y1-y0+1;out.getContext('2d').drawImage(cv,x0,y0,out.width,out.height,0,0,out.width,out.height);
out.toBlob(function(b){b?ok(b):ko(new Error('png'));},'image/png');};im.onerror=function(){ko(new Error('immagine'));};im.src=src;});}
function daFile(f){return new Promise(function(ok,ko){if(!/^image\/(png|jpeg)$/.test(f.type)){ko(new Error('formato'));return;}if(f.size>15*1048576){ko(new Error('grande'));return;}
var r=new FileReader();r.onload=function(){ok(r.result);};r.onerror=function(){ko(new Error('lettura'));};r.readAsDataURL(f);});}
function manda(cosa,blob,extra){return blob.arrayBuffer().then(function(buf){return crypto.subtle.digest('SHA-256',buf).then(function(h){
var d={t:CFG.t,c:CFG.c,cosa:cosa,mime:'image/png',byte:buf.byteLength,sha256:esa(h)};for(var k in extra)d[k]=extra[k];
return fetch(CFG.b+'/firma/immagine',{method:'POST',headers:{'X-Firma-Dati':b64url(JSON.stringify(d)),'Content-Type':'image/png'},body:buf}).then(function(r){return r.json().catch(function(){return {esito:'errore'};});});});});}
// riquadro della firma: «Disegna» (canvas) oppure «Carica un'immagine»
var PAD={};
function costruisci(box){var k=box.getAttribute('data-pad');box.innerHTML='<div class="tab"><button type="button" class="on" data-m="d">Disegna la firma</button><button type="button" data-m="c">Carica un\'immagine</button></div>'+
'<div data-p="d"><canvas width="1040" height="340" aria-label="Disegna qui la firma"></canvas><div class="riga"><button type="button" class="btn sm tenue" data-pulisci>Ricomincia</button><span>Firma col dito o col mouse dentro il riquadro.</span></div></div>'+
'<div data-p="c" hidden><input type="file" accept="image/png,image/jpeg"><div class="riga"><span>PNG o JPG della firma su sfondo bianco: TIX toglie lo sfondo da solo.</span></div><img class="anteprima" alt="" hidden></div>';
var st={modo:'d',segni:0,blob:null};PAD[k]=st;var cv=box.querySelector('canvas'),g=cv.getContext('2d');g.lineWidth=5;g.lineCap='round';g.lineJoin='round';g.strokeStyle='#14224a';var giu=false;
function pt(ev){var r=cv.getBoundingClientRect();return [(ev.clientX-r.left)*cv.width/r.width,(ev.clientY-r.top)*cv.height/r.height];}
cv.addEventListener('pointerdown',function(ev){giu=true;cv.setPointerCapture(ev.pointerId);var p=pt(ev);g.beginPath();g.moveTo(p[0],p[1]);g.lineTo(p[0]+0.1,p[1]+0.1);g.stroke();st.segni++;});
cv.addEventListener('pointermove',function(ev){if(!giu)return;var p=pt(ev);g.lineTo(p[0],p[1]);g.stroke();});
['pointerup','pointercancel','pointerleave'].forEach(function(t){cv.addEventListener(t,function(){giu=false;});});
box.querySelector('[data-pulisci]').addEventListener('click',function(){g.clearRect(0,0,cv.width,cv.height);st.segni=0;});
box.querySelectorAll('[data-m]').forEach(function(b){b.addEventListener('click',function(){st.modo=b.getAttribute('data-m');box.querySelectorAll('[data-m]').forEach(function(x){x.classList.toggle('on',x===b);});
box.querySelectorAll('[data-p]').forEach(function(x){x.hidden=x.getAttribute('data-p')!==st.modo;});});});
var fi=box.querySelector('input[type=file]'),an=box.querySelector('.anteprima');fi.addEventListener('change',function(){var f=fi.files&&fi.files[0];st.blob=null;an.hidden=true;if(!f)return;
daFile(f).then(function(u){return aPng(u,true);}).then(function(b){st.blob=b;an.src=URL.createObjectURL(b);an.hidden=false;}).catch(function(){alert('Questa immagine non si legge: usa un PNG o un JPG.');});});
st.prendi=function(){if(st.modo==='c')return Promise.resolve(st.blob);if(!st.segni)return Promise.resolve(null);return aPng(cv.toDataURL('image/png'),false).catch(function(){return null;});};}
D.querySelectorAll('[data-pad]').forEach(costruisci);
// nuova persona
$('fi-salva-nuovo').addEventListener('click',function(){var m=$('fi-msg-nuovo'),b=this;m.className='fi-msg';m.textContent='';var n=$('fi-nome').value.trim(),q=$('fi-qual').value.trim();
if(!n){m.textContent='Scrivi il nome e cognome.';$('fi-nome').focus();return;}var c=nome();if(!c){m.textContent='Scrivi il tuo nome in fondo alla pagina.';return;}b.disabled=true;
PAD.nuovo.prendi().then(function(blob){if(blob)return manda('firma',blob,{nome:n,qualifica:q,chi:c});
return fetch(CFG.b+'/firma/azione',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,c:CFG.c,azione:'firmatario_salva',dati:{nome:n,qualifica:q,chi:c}})}).then(function(r){return r.json();});})
.then(function(r){if(r&&r.esito==='ok'){location.reload();return;}b.disabled=false;m.textContent=(r&&r.messaggio)||'Non è andata: riprova.';}).catch(function(){b.disabled=false;m.textContent='Non è andata: controlla la connessione e riprova.';});});
// cambia la firma di una persona
var dlg=$('fi-dlg'),cId='';
D.querySelectorAll('[data-cambia]').forEach(function(b){b.addEventListener('click',function(){cId=b.getAttribute('data-cambia');$('fi-dlg-tit').textContent='Firma di '+(b.getAttribute('data-nome')||'');
var box=dlg.querySelector('[data-pad]');costruisci(box);$('fi-msg-cambia').textContent='';$('fi-salva-cambia').disabled=false;if(typeof dlg.showModal==='function')dlg.showModal();else dlg.setAttribute('open','');});});
$('fi-salva-cambia').addEventListener('click',function(){var m=$('fi-msg-cambia'),b=this;m.textContent='';var c=nome();if(!c){m.textContent='Scrivi il tuo nome in fondo alla pagina.';return;}b.disabled=true;
PAD.cambia.prendi().then(function(blob){if(!blob){b.disabled=false;m.textContent='Disegna la firma o carica un\'immagine.';return null;}return manda('firma',blob,{id:cId,chi:c});})
.then(function(r){if(!r)return;if(r.esito==='ok'){location.reload();return;}b.disabled=false;m.textContent=r.messaggio||'Non è andata: riprova.';}).catch(function(){b.disabled=false;m.textContent='Non è andata: controlla la connessione e riprova.';});});
// togli una persona
D.querySelectorAll('[data-togli]').forEach(function(b){b.addEventListener('click',function(){var c=nome();if(!c){alert('Scrivi il tuo nome in fondo alla pagina.');return;}
if(!confirm('Togliere '+(b.getAttribute('data-nome')||'')+' da chi può firmare? Le firme già fatte restano.'))return;b.disabled=true;
fetch(CFG.b+'/firma/azione',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,c:CFG.c,azione:'firmatario_togli',id:b.getAttribute('data-togli'),chi:c})})
.then(function(r){return r.json();}).then(function(r){if(r&&r.esito==='ok'){location.reload();return;}b.disabled=false;alert((r&&r.messaggio)||'Non è andata: riprova.');}).catch(function(){b.disabled=false;alert('Non è andata: controlla la connessione e riprova.');});});});
// timbro
var ti=$('fi-timbro');if(ti)ti.addEventListener('change',function(){var m=$('fi-msg-timbro'),f=ti.files&&ti.files[0];m.className='fi-msg';m.textContent='';if(!f)return;var c=nome();if(!c){m.textContent='Scrivi il tuo nome in fondo alla pagina.';ti.value='';return;}
m.className='fi-msg ok';m.textContent='Preparo il timbro…';daFile(f).then(function(u){return aPng(u,true);}).then(function(b){return manda('timbro',b,{chi:c});})
.then(function(r){if(r&&r.esito==='ok'){location.reload();return;}m.className='fi-msg';m.textContent=(r&&r.messaggio)||'Non è andata: riprova.';}).catch(function(){m.className='fi-msg';m.textContent='Questa immagine non si legge: usa un PNG o un JPG.';});ti.value='';});
}catch(err){}})();`;

// ---------------------------------------------------------------------------- modulo del browser: window.TIXFirma
// TIXFirma.apri({ base, t, c, tipo, rif_id, pdf: <indirizzo del PDF originale>, impostazioni: <indirizzo di «Firme e timbro»>, onFatto })
// Pagina vista con pdf.js; tocco = centro del riquadro di firma; «In fondo all'ultima pagina» = angolo in basso a destra.
// Il riquadro è una pagina PDF a parte (pdf-lib) incollata con drawPage nel punto scelto, ruotata come la pagina se ha /Rotate.
const FIRMA_JS = String.raw`(function(){if(window.TIXFirma)return;
var PDFJS='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',PDFJSW='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',PDFLIB='https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';
var W=230,H=96,MARGINE=24,MARGINE_GIU=62;
function carica(u){return new Promise(function(ok,ko){var s=document.createElement('script');s.src=u;s.onload=ok;s.onerror=function(){ko(new Error('script'));};document.head.appendChild(s);});}
function librerie(){var p=[];if(!window.pdfjsLib)p.push(carica(PDFJS));if(!window.PDFLib)p.push(carica(PDFLIB));return Promise.all(p).then(function(){window.pdfjsLib.GlobalWorkerOptions.workerSrc=PDFJSW;});}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function esa(buf){return Array.prototype.map.call(new Uint8Array(buf),function(x){return ('0'+x.toString(16)).slice(-2);}).join('');}
function b64url(s){var u=unescape(encodeURIComponent(s));return btoa(u).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function wa(s){return String(s==null?'':s).replace(/[\r\n\t]+/g,' ').replace(/[^\x20-\x7E\xA0-\xFF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u20AC]/g,'?');}
function ora(){var d=new Date(),p=function(n){return ('0'+n).slice(-2);};return p(d.getDate())+'/'+p(d.getMonth()+1)+'/'+d.getFullYear()+' alle '+p(d.getHours())+':'+p(d.getMinutes());}
function righe(font,size,testo,larg,max){var parole=wa(testo).split(' '),out=[],cur='';for(var i=0;i<parole.length;i++){var prova=cur?cur+' '+parole[i]:parole[i];
if(font.widthOfTextAtSize(prova,size)<=larg){cur=prova;}else{if(cur)out.push(cur);cur=parole[i];if(out.length>=max)break;}}if(out.length<max&&cur)out.push(cur);
if(out.length>max)out=out.slice(0,max);var tutto=out.join(' ');if(tutto.length<wa(testo).trim().length&&out.length){var u=out[out.length-1];while(u.length&&font.widthOfTextAtSize(u+'…',size)>larg)u=u.slice(0,-1);out[out.length-1]=u+'…';}return out;}
var STILE='.tf-ov{position:fixed;inset:0;z-index:9999;background:rgba(16,27,43,.55);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:16px}'+
'.tf-w{background:#fff;border-radius:16px;max-width:1100px;width:100%;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;color:#17212E;box-shadow:0 24px 60px -20px rgba(16,27,43,.6)}'+
'.tf-w h3{margin:0 0 4px;color:#1B2F4A;font-size:1.15rem}.tf-sub{margin:0 0 12px;color:#5B6672;font-size:.88rem}'+
'.tf-g{display:grid;grid-template-columns:320px minmax(0,1fr);gap:16px}.tf-col label,.tf-lab{display:block;font-size:.84rem;font-weight:700;color:#1B2F4A;margin:10px 0 4px}'+
'.tf-col select,.tf-col textarea{width:100%;min-height:38px;padding:6px 10px;border:1px solid rgba(16,27,43,.18);border-radius:10px;font:inherit;font-size:.9rem}.tf-col textarea{min-height:90px;resize:vertical}'+
'.tf-es label{display:flex;gap:8px;align-items:center;font-weight:600;color:#17212E;margin:4px 0;cursor:pointer}.tf-es input{width:18px;height:18px;accent-color:#3F4A9E}'+
'.tf-tab{display:flex;gap:6px;margin:0 0 10px;flex-wrap:wrap}.tf-tab button{padding:6px 12px;border-radius:999px;border:1px solid rgba(16,27,43,.14);background:#fff;font:inherit;font-size:.84rem;font-weight:600;cursor:pointer}.tf-tab button.on{background:#1B2F4A;color:#fff;border-color:#1B2F4A}'+
'.tf-vis{position:relative;border:1px solid rgba(16,27,43,.12);border-radius:12px;background:#F5F7FA;overflow:auto;max-height:70vh;text-align:center}.tf-vis canvas{display:inline-block;cursor:crosshair;max-width:none;box-shadow:0 1px 4px rgba(0,0,0,.15);margin:8px}'+
'.tf-box{position:absolute;border:2px solid #3F4A9E;background:rgba(63,74,158,.12);border-radius:4px;pointer-events:none;font-size:11px;color:#2C3577;font-weight:700;display:flex;align-items:center;justify-content:center}'+
'.tf-nav{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}.tf-nav span{font-size:.86rem;color:#5B6672}'+
'.tf-b{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:0 14px;border-radius:12px;border:1px solid #1B2F4A;background:#fff;color:#1B2F4A;font:inherit;font-weight:700;font-size:.88rem;cursor:pointer;text-decoration:none}'+
'.tf-b.pr{background:#3F4A9E;border-color:#3F4A9E;color:#fff}.tf-b:disabled{opacity:.55;cursor:not-allowed}.tf-b.sec{border-color:#3F4A9E;color:#2C3577;background:#EEF0FA}'+
'.tf-msg{margin:10px 0 0;font-size:.9rem;font-weight:600;color:#B3261E;min-height:1px}.tf-msg.ok{color:#146C43}.tf-av{margin:8px 0 0;padding:8px 10px;border-radius:10px;background:#FFF4DC;border:1px solid #F0CF8A;color:#8A4B00;font-size:.84rem}'+
'.tf-fine{display:flex;justify-content:flex-end;gap:10px;margin-top:14px;flex-wrap:wrap}'+
'@media (max-width:860px){.tf-g{grid-template-columns:minmax(0,1fr)}.tf-vis{max-height:60vh}}';
function apri(o){var ov=document.createElement('div');ov.className='tf-ov';ov.innerHTML='<style>'+STILE+'</style><div class="tf-w" role="dialog" aria-modal="true"><h3>Firma</h3><p class="tf-sub">Carico il documento…</p></div>';
document.body.appendChild(ov);var w=ov.querySelector('.tf-w');function chiudi(){if(ov.parentNode)ov.parentNode.removeChild(ov);}
function errore(m){w.innerHTML='<h3>Firma</h3><p class="tf-msg">'+esc(m)+'</p><div class="tf-fine"><button type="button" class="tf-b" data-x>Chiudi</button></div>';w.querySelector('[data-x]').onclick=chiudi;}
fetch(o.base+'/firma/azione',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:o.t,c:o.c,azione:'prepara',tipo:o.tipo,rif_id:o.rif_id})})
.then(function(r){return r.json();}).then(function(P){if(!P||P.esito!=='ok'){errore((P&&P.messaggio)||'Questo documento non si può firmare adesso.');return;}
var doc=P.documento||{},fs=P.firmatari||[];
if(!fs.length){w.innerHTML='<h3>Prima indica chi può firmare</h3><p class="tf-sub">Nella pagina «Firme e timbro» indichi le persone che possono firmare per l\'impresa e carichi la loro firma e il timbro.</p>'+
'<div class="tf-fine"><button type="button" class="tf-b" data-x>Chiudi</button><a class="tf-b pr" href="'+esc(o.impostazioni)+'">Apri «Firme e timbro»</a></div>';w.querySelector('[data-x]').onclick=chiudi;return;}
var solo=!!doc.p7m,stato={modo:solo?'q':'s',pag:1,sel:null,pdf:null,orig:null,n:0,vp:null,rot:0};
w.innerHTML='<h3>'+esc(doc.dicitura||'Firma')+'</h3><p class="tf-sub">'+esc(doc.titolo||'')+'</p>'+
'<div class="tf-tab">'+(solo?'':'<button type="button" class="on" data-m="s">Firma con TIX</button>')+'<button type="button" data-m="q"'+(solo?' class="on"':'')+'>Firma digitale qualificata</button></div>'+
'<div class="tf-g"><div class="tf-col"><span class="tf-lab">Esito</span><div class="tf-es">'+(doc.esiti||[]).map(function(e,i){return '<label><input type="radio" name="tf-es" value="'+esc(e)+'"'+(i===0?' checked':'')+'> '+esc(e)+'</label>';}).join('')+'</div>'+
'<div data-nota hidden><label for="tf-nota">Osservazioni</label><textarea id="tf-nota" maxlength="2000" placeholder="Vanno sulla copia firmata e le vede chi la riceve"></textarea></div>'+
'<label for="tf-chi">Chi firma</label><select id="tf-chi">'+fs.map(function(f){return '<option value="'+esc(f.id)+'" data-firma="'+(f.ha_firma?'1':'')+'">'+esc(f.nome+(f.qualifica?' — '+f.qualifica:''))+'</option>';}).join('')+'</select>'+
'<p class="tf-av" data-senza hidden>Per questa persona non c\'è ancora l\'immagine della firma: sul foglio ci sarà solo il nome. La puoi aggiungere in <a href="'+esc(o.impostazioni)+'">«Firme e timbro»</a>.</p>'+
(P.timbro?'':'<p class="tf-av">Il timbro dell\'impresa non è ancora caricato: lo aggiungi in <a href="'+esc(o.impostazioni)+'">«Firme e timbro»</a>.</p>')+
'<div data-q'+(solo?'':' hidden')+'><p class="tf-sub" style="margin-top:12px">'+(solo?'Questo documento è già un file firmato digitalmente (.p7m): TIX non può scriverci sopra. ':'')+'Scarica il file, firmalo con la tua firma digitale (chiavetta o firma remota) e carica qui il file firmato, .p7m oppure PDF firmato.</p>'+
'<a class="tf-b sec" href="'+esc(o.pdf+'&scarica=1')+'">Scarica il file da firmare</a><label for="tf-file">File firmato</label><input type="file" id="tf-file" accept=".p7m,.pdf,application/pdf,application/pkcs7-mime"></div>'+
'</div><div data-s'+(solo?' hidden':'')+'><div class="tf-nav"><button type="button" class="tf-b" data-pr>‹</button><span data-pn>Pagina 1</span><button type="button" class="tf-b" data-ps>›</button>'+
'<button type="button" class="tf-b sec" data-fondo>In fondo all\'ultima pagina</button></div><p class="tf-sub" style="margin:0 0 6px">Tocca sulla pagina il punto dove mettere firma e timbro.</p><div class="tf-vis" data-vis><canvas></canvas></div></div></div>'+
'<p class="tf-msg" data-msg role="status"></p><div class="tf-fine"><button type="button" class="tf-b" data-x>Annulla</button><button type="button" class="tf-b pr" data-firma>Firma e salva</button></div>';
var q=function(s){return w.querySelector(s);},msg=q('[data-msg]'),cv=q('canvas'),vis=q('[data-vis]');q('[data-x]').onclick=chiudi;
function aggNota(){var e=(w.querySelector('input[name=tf-es]:checked')||{}).value;q('[data-nota]').hidden=!((doc.nota_per||[]).indexOf(e)!==-1);}
w.querySelectorAll('input[name=tf-es]').forEach(function(r){r.addEventListener('change',aggNota);});aggNota();
function aggChi(){var op=q('#tf-chi').selectedOptions[0];q('[data-senza]').hidden=!op||op.getAttribute('data-firma')==='1';}q('#tf-chi').addEventListener('change',aggChi);aggChi();
w.querySelectorAll('[data-m]').forEach(function(b){b.addEventListener('click',function(){stato.modo=b.getAttribute('data-m');w.querySelectorAll('[data-m]').forEach(function(x){x.classList.toggle('on',x===b);});
q('[data-s]').hidden=stato.modo!=='s';q('[data-q]').hidden=stato.modo!=='q';msg.textContent='';});});
// originale: si scarica una volta, se ne controlla l'impronta
var origP=fetch(o.pdf,{credentials:'same-origin'}).then(function(r){if(!r.ok)throw new Error('file');return r.arrayBuffer();}).then(function(buf){return crypto.subtle.digest('SHA-256',buf).then(function(h){
if(esa(h)!==String(doc.sha256||'').toLowerCase())throw new Error('impronta');stato.orig=buf;return buf;});});
function disegnaBox(){var vecchio=vis.querySelector('.tf-box');if(vecchio)vecchio.remove();if(!stato.sel||stato.sel.pag!==stato.pag)return;var b=document.createElement('div');b.className='tf-box';b.textContent='Firma e timbro';
var k=cv.clientWidth/cv.width;b.style.left=(cv.offsetLeft+stato.sel.left*k)+'px';b.style.top=(cv.offsetTop+(stato.sel.bottom-stato.sel.h)*k)+'px';b.style.width=(stato.sel.w*k)+'px';b.style.height=(stato.sel.h*k)+'px';vis.appendChild(b);}
function pagina(n){return stato.pdf.getPage(n).then(function(pg){var v1=pg.getViewport({scale:1});var larg=Math.max(260,vis.clientWidth-40);var sc=Math.min(2,larg/v1.width);
var vp=pg.getViewport({scale:sc});cv.width=Math.round(vp.width);cv.height=Math.round(vp.height);stato.vp=vp;stato.rot=pg.rotate||0;stato.pag=n;q('[data-pn]').textContent='Pagina '+n+' di '+stato.n;
return pg.render({canvasContext:cv.getContext('2d'),viewport:vp}).promise.then(disegnaBox);});}
function scegli(cx,cy){var sc=stato.vp.scale,w0=W*sc,h0=H*sc;var left=Math.min(Math.max(0,cx-w0/2),cv.width-w0),bottom=Math.min(Math.max(h0,cy+h0/2),cv.height);
var pp=stato.vp.convertToPdfPoint(left,bottom);stato.sel={pag:stato.pag,left:left,bottom:bottom,w:w0,h:h0,x:pp[0],y:pp[1],rot:stato.rot};disegnaBox();msg.textContent='';}
if(!solo){librerie().then(function(){return origP;}).then(function(buf){return window.pdfjsLib.getDocument({data:new Uint8Array(buf.slice(0))}).promise;}).then(function(pdf){stato.pdf=pdf;stato.n=pdf.numPages;return pagina(1);})
.catch(function(e){msg.textContent=e&&e.message==='impronta'?'Il file scaricato non è quello registrato: ricarica la pagina.':'Il PDF non si apre qui: usa «Firma digitale qualificata».';});}
cv.addEventListener('click',function(ev){if(!stato.vp)return;var r=cv.getBoundingClientRect();scegli((ev.clientX-r.left)*cv.width/r.width,(ev.clientY-r.top)*cv.height/r.height);});
q('[data-pr]').onclick=function(){if(stato.pdf&&stato.pag>1)pagina(stato.pag-1);};q('[data-ps]').onclick=function(){if(stato.pdf&&stato.pag<stato.n)pagina(stato.pag+1);};
q('[data-fondo]').onclick=function(){if(!stato.pdf)return;pagina(stato.n).then(function(){var sc=stato.vp.scale;scegli(cv.width-(W/2+MARGINE)*sc,cv.height-(H/2+MARGINE_GIU)*sc);});};
function dati(){var e=(w.querySelector('input[name=tf-es]:checked')||{}).value,n=(q('#tf-nota').value||'').trim();
if(!e){msg.textContent='Scegli l\'esito.';return null;}if((doc.nota_per||[]).indexOf(e)!==-1&&!n){msg.textContent='Scrivi le osservazioni.';q('#tf-nota').focus();return null;}
var op=q('#tf-chi').selectedOptions[0];return {esito:e,nota:n,firmatario_id:op.value,firmatario:op.textContent,ha_firma:op.getAttribute('data-firma')==='1'};}
function immagine(cosa,id){return fetch(o.base+'/firma/immagine?t='+o.t+'&c='+o.c+'&cosa='+cosa+(id?'&id='+id:''),{credentials:'same-origin'}).then(function(r){return r.ok?r.arrayBuffer():null;}).catch(function(){return null;});}
function incolla(docPdf,buf){if(!buf)return Promise.resolve(null);var b=new Uint8Array(buf);return (b[0]===0x89?docPdf.embedPng(buf):docPdf.embedJpg(buf)).catch(function(){return null;});}
/* logo-timbro-1 (10/11/2026, Filippo: il logo TIX su ogni file che si stampa): marchio TIX vero in basso a destra del riquadro; se non si carica resta la scritta TIX */
function marchio(){return fetch(o.base+'/marchio-tix.png',{credentials:'same-origin'}).then(function(r){return r.ok?r.arrayBuffer():null;}).catch(function(){return null;});}
function timbra(d){var L=window.PDFLib;return Promise.all([L.PDFDocument.load(stato.orig,{ignoreEncryption:true,updateMetadata:false}),L.PDFDocument.create(),immagine('timbro'),d.ha_firma?immagine('firma',d.firmatario_id):Promise.resolve(null),marchio()])
.then(function(a){var out=a[0],st=a[1],bt=a[2],bf=a[3],bm=a[4];return Promise.all([st.embedFont(L.StandardFonts.Helvetica),st.embedFont(L.StandardFonts.HelveticaBold),incolla(st,bt),incolla(st,bf),incolla(st,bm)]).then(function(f){
var fR=f[0],fB=f[1],it=f[2],ifi=f[3],im=f[4],pg=st.addPage([W,H]),blu=L.rgb(0.17,0.21,0.47),gr=L.rgb(0.36,0.4,0.45);
pg.drawRectangle({x:0.5,y:0.5,width:W-1,height:H-1,color:L.rgb(1,1,1),opacity:0.9,borderColor:blu,borderWidth:1});
var x0=8;if(it){var s=Math.min(66/it.width,66/it.height);pg.drawImage(it,{x:8+(66-it.width*s)/2,y:(H-it.height*s)/2,width:it.width*s,height:it.height*s});x0=82;}
var larg=W-x0-6;pg.drawText(wa(doc.dicitura||'Firma'),{x:x0,y:H-11,size:6.5,font:fR,color:gr});pg.drawText(righe(fB,8.5,d.esito,larg,1)[0]||'',{x:x0,y:H-21,size:8.5,font:fB,color:blu});
var y=H-30;if(d.nota){righe(fR,6.3,'Osservazioni: '+d.nota,larg,2).forEach(function(r){pg.drawText(r,{x:x0,y:y,size:6.3,font:fR,color:L.rgb(0.1,0.1,0.1)});y-=7.5;});}
if(ifi){var s2=Math.min(larg/ifi.width,Math.max(14,y-24)/ifi.height,1);pg.drawImage(ifi,{x:x0,y:24,width:ifi.width*s2,height:ifi.height*s2});}
pg.drawText(righe(fB,7.2,d.firmatario,larg,1)[0]||'',{x:x0,y:16,size:7.2,font:fB,color:L.rgb(0.1,0.1,0.1)});pg.drawText(wa(ora()),{x:x0,y:9,size:6.3,font:fR,color:gr});
if(im){var hm=9,lm=im.width*(hm/im.height);pg.drawImage(im,{x:W-6-lm,y:3,width:lm,height:hm});}
pg.drawText(wa('Impronta originale '+String(doc.sha256||'').slice(0,16)+'…'+(im?'':' · TIX')),{x:x0,y:3,size:5,font:fR,color:gr});
return st.save().then(function(sb){return out.embedPdf(sb);}).then(function(e){var p=out.getPage(stato.sel.pag-1);p.drawPage(e[0],{x:stato.sel.x,y:stato.sel.y,width:W,height:H,rotate:L.degrees(stato.sel.rot||0)});return out.save({useObjectStreams:false});});});});}
function invia(bytes,d,qual,nome){return crypto.subtle.digest('SHA-256',bytes).then(function(h){
var dd={t:o.t,c:o.c,tipo:o.tipo,rif_id:o.rif_id,firmatario_id:d.firmatario_id,esito:d.esito,nota:d.nota,qualificata:qual,sha256_originale:String(doc.sha256||'').toLowerCase(),sha256:esa(h),byte:bytes.byteLength,nome:nome,
pagina:qual?null:stato.sel.pag,posizione:qual?null:{x:stato.sel.x,y:stato.sel.y,w:W,h:H,rot:stato.sel.rot||0}};
return fetch(o.base+'/firma/salva',{method:'POST',headers:{'X-Firma-Dati':b64url(JSON.stringify(dd)),'Content-Type':'application/octet-stream'},body:bytes}).then(function(r){return r.json().catch(function(){return {esito:'errore'};});});});}
function fine(r){if(r&&r.esito==='ok'){msg.className='tf-msg ok';msg.textContent='Firmato. Aggiorno la pagina…';setTimeout(function(){chiudi();if(o.onFatto)o.onFatto(r);},900);return;}
bott.disabled=false;msg.textContent=(r&&r.messaggio)||'Non è andata: riprova.';}
var bott=q('[data-firma]');bott.onclick=function(){msg.className='tf-msg';msg.textContent='';var d=dati();if(!d)return;
var nomeBase=String(doc.nome||'documento').replace(/\.(pdf|p7m)$/i,'');
if(stato.modo==='q'){var f=q('#tf-file').files&&q('#tf-file').files[0];if(!f){msg.textContent='Scegli il file firmato.';return;}bott.disabled=true;msg.className='tf-msg ok';msg.textContent='Carico il file firmato…';
origP.catch(function(){return null;}).then(function(){return f.arrayBuffer();}).then(function(b){return invia(b,d,true,f.name);}).then(fine).catch(function(){bott.disabled=false;msg.className='tf-msg';msg.textContent='Non è andata: controlla la connessione e riprova.';});return;}
if(!stato.orig||!stato.pdf){msg.textContent='Il documento non è ancora pronto: aspetta un momento.';return;}if(!stato.sel){msg.textContent='Tocca sulla pagina il punto dove mettere firma e timbro, oppure «In fondo all\'ultima pagina».';return;}
bott.disabled=true;msg.className='tf-msg ok';msg.textContent='Metto firma e timbro…';
timbra(d).then(function(bytes){msg.textContent='Salvo la copia firmata…';return invia(bytes,d,false,nomeBase+' - firmato.pdf');}).then(fine)
.catch(function(){bott.disabled=false;msg.className='tf-msg';msg.textContent='Non sono riuscito a scrivere sul PDF: se è protetto usa «Firma digitale qualificata».';});};
}).catch(function(){errore('Il servizio non risponde: riprova tra un minuto.');});}
window.TIXFirma={apri:apri};})();`;

// Solo per il banco di prova locale (pagine con dati inventati, senza database).
export function firmaJsProva() { return FIRMA_JS; }
export function firmaImpostazioniProva(base, h, p, d) { return paginaImpostazioni(base, h, p, d, base + "/costruttivi?t=" + p.tok + "&c=" + p.c, true); }
