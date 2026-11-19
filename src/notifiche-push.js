// NOTIFICHE SUL TELEFONO (B4, 19/11/2026, push-1). Web push della PWA, ok di Filippo alle 5 condizioni della B12:
//   (1) contenuto cifrato RFC 8291 (aes128gcm) con VAPID (RFC 8292); (2) testo con al massimo il tipo di avviso e il
//   nome del cantiere; (3) nessuna traccia di apertura o clic; (4) promemoria del diario solo se acceso dalla persona
//   (lo filtra il database); (5) sottoscrizioni cancellate con 404/410 (qui) e nelle altre occasioni (database).
// La pagina e la registrazione sono della B15: chiama push_salva / push_spegni / push_stato del database.
// Azioni /admin: push_chiave (chiave pubblica VAPID per la pagina della B15, creata la prima volta),
//                push_giro (manda gli avvisi in coda), push_prova {utente_id} (avviso di prova, solo utenti di prova).
// La chiave privata VAPID si crea qui con WebCrypto e si salva nel vault di Supabase: non esce mai.

const enc = new TextEncoder();

function b64u(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function db64u(s) {
  const t = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "===".slice((t.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function unisci(...parti) {
  let n = 0;
  for (const p of parti) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parti) { out.set(p, o); o += p.length; }
  return out;
}

let _vapid = null; // { privata: CryptoKey, pubblica: "b64u" }

async function vapidChiavi(a) {
  if (_vapid) return _vapid;
  let r = null;
  try { r = await a.rpc("push_vapid", {}, 4000); } catch (e) { r = null; }
  if (r && r.privata && r.pubblica) {
    const jwk = JSON.parse(r.privata);
    const privata = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    _vapid = { privata, pubblica: String(r.pubblica) };
    return _vapid;
  }
  // prima volta: si crea la coppia di chiavi e si salva (se un altro giro l'ha appena salvata, si rilegge quella)
  const coppia = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", coppia.privateKey);
  const pub = b64u(await crypto.subtle.exportKey("raw", coppia.publicKey));
  const s = await a.rpc("push_vapid_salva", { p_privata: JSON.stringify(jwk), p_pubblica: pub }, 5000);
  if (!s || (s.esito !== "ok" && s.esito !== "gia_presente")) throw new Error("chiavi VAPID non salvate");
  _vapid = null;
  if (s.esito === "gia_presente") return vapidChiavi(a);
  _vapid = { privata: coppia.privateKey, pubblica: pub };
  return _vapid;
}

async function vapidIntestazione(endpoint, v) {
  const u = new URL(endpoint);
  const testa = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const corpo = b64u(enc.encode(JSON.stringify({ aud: u.origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:info@tixcantiere.it" })));
  const firma = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, v.privata, enc.encode(testa + "." + corpo));
  return "vapid t=" + testa + "." + corpo + "." + b64u(firma) + ", k=" + v.pubblica;
}

async function hkdf(sale, ikm, info, bit) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: sale, info }, k, bit));
}

// RFC 8291: un solo record aes128gcm
async function cifra(testo, p256dh, auth) {
  const uaPub = db64u(p256dh);
  const segreto = db64u(auth);
  if (uaPub.length !== 65 || segreto.length < 16) throw new Error("chiavi della sottoscrizione non valide");
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const condiviso = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(segreto, condiviso, unisci(enc.encode("WebPush: info\0"), uaPub, asPub), 256);
  const sale = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(sale, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(sale, ikm, enc.encode("Content-Encoding: nonce\0"), 96);
  const chiave = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const chiaro = unisci(enc.encode(testo), new Uint8Array([2]));
  const cifrato = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, chiave, chiaro));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return unisci(sale, rs, new Uint8Array([asPub.length]), asPub, cifrato);
}

// Testi per tipo: al massimo il tipo di avviso e il nome del cantiere (condizione 2 della B12).
const TESTI = {
  prova: ["TIX", "Avviso di prova: le notifiche sul telefono funzionano."],
  diario_promemoria: ["TIX · Diario", "Ricordati di scrivere il diario di oggi{c}."],
  diario_pronto: ["TIX · Diario", "Il diario di oggi è pronto da leggere{c}."],
  agenda: ["TIX · Agenda", "Hai un nuovo appuntamento in agenda{c}."],
  documento: ["TIX", "C'è un nuovo documento da guardare{c}."],
  firma: ["TIX", "C'è un documento da firmare{c}."]
};
function testoDi(tipo, cantiere) {
  const t = TESTI[tipo] || ["TIX", "Hai un nuovo avviso in TIX{c}."];
  const c = cantiere ? " · " + String(cantiere).replace(/[\r\n<>]/g, " ").slice(0, 60) : "";
  return { titolo: t[0], testo: t[1].replace("{c}", c) };
}

async function mandaUno(s, carico, v) {
  const corpo = await cifra(JSON.stringify(carico), s.p256dh, s.auth);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(s.endpoint, {
      method: "POST", signal: ctrl.signal, body: corpo,
      headers: { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400",
        Urgency: "normal", Authorization: await vapidIntestazione(s.endpoint, v) }
    });
    return r.status;
  } finally { clearTimeout(timer); }
}

async function giro(a) {
  let lista = [];
  try { lista = await a.rpc("push_da_inviare", {}, 5000); } catch (e) { return { ok: false, errore: "database" }; }
  if (!Array.isArray(lista) || !lista.length) return { ok: true, avvisi: 0 };
  const v = await vapidChiavi(a);
  let mandati = 0, falliti = 0;
  for (const x of lista) {
    const carico = Object.assign(testoDi(String(x.tipo || ""), x.cantiere), { url: String(x.url || "/") });
    for (const s of Array.isArray(x.sottoscrizioni) ? x.sottoscrizioni : []) {
      let stato = 0;
      try { stato = await mandaUno(s, carico, v); } catch (e) { stato = 0; }
      if (stato >= 200 && stato < 300) mandati++; else falliti++;
      try { await a.rpc("push_esito", { p_coda_id: x.id, p_sottoscrizione_id: s.id, p_stato: stato }, 4000); } catch (e) {}
    }
    try { await a.rpc("push_coda_fatto", { p_coda_id: x.id }, 4000); } catch (e) {}
  }
  return { ok: true, avvisi: lista.length, mandati, falliti };
}

// a = { rpc }
export async function pushAdmin(azione, corpo, a) {
  if (azione === "push_chiave") {
    const v = await vapidChiavi(a);
    return { ok: true, chiave_pubblica: v.pubblica };
  }
  if (azione === "push_giro") return giro(a);
  if (azione === "push_prova") {
    const id = String((corpo && corpo.utente_id) || "");
    if (!/^[0-9a-f-]{36}$/.test(id)) return { ok: false, status: 400, errore: "utente_id non valido" };
    const coda = await a.rpc("push_accoda", { p_utente_id: id, p_tipo: "prova", p_cantiere: null, p_url: "/" }, 4000);
    if (!coda) return { ok: false, errore: "non in coda (interruttore, utente non di prova o nessun telefono iscritto)" };
    return giro(a);
  }
  return null;
}
