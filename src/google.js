// ============================================================================
// GOOGLE per wa-relay — tappa B0 (10/11/2026)
// Collegamento a Google Drive e Fogli Google con l'«account di servizio» di TIX (utente robot), al posto della
// connessione di info@ che oggi usa Make. Serve alla tappa B (foto, DDT, ore in economia).
//
// La chiave: segreto GOOGLE_SA_KEY del Worker, cioè il file JSON dell'account di servizio, incollato per intero
// da Filippo nel pannello Cloudflare. Qui si legge solo in memoria e non si scrive mai da nessuna parte:
// /stato mostra soltanto se c'è e l'indirizzo del robot.
//
// Come funziona: un «biglietto» firmato con la chiave (JWT RS256, WebCrypto) si scambia con Google per un
// gettone valido 1 ora, tenuto in memoria per 50 minuti. Tutte le chiamate a Drive usano supportsAllDrives,
// perché i file stanno nel Drive condiviso «TIX — archivio dati» (0AATAt3dbkXq1Uk9PVA).
//
// Senza chiave, o se Google non risponde, ogni funzione lancia un errore: chi la usa (la tappa B) lascia il
// lavoro a Make, come per tutti gli altri pezzi.
// ============================================================================

export const GOOGLE_DRIVE_TIX = "0AATAt3dbkXq1Uk9PVA";
const SCOPI = "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets";
const DRIVE = "https://www.googleapis.com/drive/v3";
const CARICA = "https://www.googleapis.com/upload/drive/v3";
const FOGLI = "https://sheets.googleapis.com/v4/spreadsheets";
const CARTELLA = "application/vnd.google-apps.folder";
const LIMITE_SEMPLICE = 5 * 1024 * 1024;     // sopra i 5 MB si carica «a riprese» (resumable)

let _gettone = { valore: "", scade: 0, chi: "" };

function leggiChiave(env) {
  const grezza = env && env.GOOGLE_SA_KEY;
  if (!grezza) throw new Error("GOOGLE_SA_KEY mancante");
  let k;
  try { k = JSON.parse(grezza); } catch (e) { throw new Error("GOOGLE_SA_KEY non è un JSON valido"); }
  if (!k || !k.client_email || !k.private_key) throw new Error("GOOGLE_SA_KEY senza client_email o private_key");
  return k;
}

function b64url(dati) {
  let bin = "";
  const b = dati instanceof Uint8Array ? dati : new TextEncoder().encode(String(dati));
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemInByte(pem) {
  const corpo = String(pem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(corpo);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function conTempo(url, init, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 20000);
  try { return await fetch(url, Object.assign({}, init || {}, { signal: ctrl.signal })); }
  finally { clearTimeout(t); }
}

// Gettone d'accesso (in memoria 50 minuti)
export async function googleGettone(env, forza) {
  const k = leggiChiave(env);
  const ora = Math.floor(Date.now() / 1000);
  if (!forza && _gettone.valore && _gettone.chi === k.client_email && _gettone.scade > ora + 60) return _gettone.valore;
  const aud = k.token_uri || "https://oauth2.googleapis.com/token";
  const testa = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const corpo = b64url(JSON.stringify({ iss: k.client_email, scope: SCOPI, aud, iat: ora, exp: ora + 3600 }));
  const chiave = await crypto.subtle.importKey("pkcs8", pemInByte(k.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const firma = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", chiave, new TextEncoder().encode(testa + "." + corpo)));
  const r = await conTempo(aud, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + testa + "." + corpo + "." + b64url(firma)
  }, 15000);
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || !d.access_token) throw new Error("Google non dà il gettone: " + r.status + " " + String((d && (d.error_description || d.error)) || "").slice(0, 160));
  _gettone = { valore: d.access_token, scade: ora + Math.min(Number(d.expires_in) || 3600, 3000), chi: k.client_email };
  return _gettone.valore;
}

async function chiama(env, url, init, ms) {
  const g = await googleGettone(env);
  const h = Object.assign({ Authorization: "Bearer " + g }, (init && init.headers) || {});
  const r = await conTempo(url, Object.assign({}, init || {}, { headers: h }), ms);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error("Google " + r.status + " " + t.slice(0, 200));
  }
  return r;
}

function q(s) { return "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'"; }

// Cartella con quel nome dentro la cartella madre (come il modulo Make «Cerca cartella del giorno»): {id, name} o null
export async function driveCercaCartella(env, nome, madre) {
  const filtro = "name = " + q(nome) + " and " + q(madre) + " in parents and mimeType = " + q(CARTELLA) + " and trashed = false";
  const url = DRIVE + "/files?q=" + encodeURIComponent(filtro) + "&fields=" + encodeURIComponent("files(id,name,webViewLink)")
    + "&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives";
  const d = await (await chiama(env, url)).json();
  return d && Array.isArray(d.files) && d.files.length ? d.files[0] : null;
}

// Nuova cartella dentro la madre (come il modulo Make «Crea cartella del giorno», non condivisa): {id, name, webViewLink}
export async function driveCreaCartella(env, nome, madre) {
  const r = await chiama(env, DRIVE + "/files?supportsAllDrives=true&fields=" + encodeURIComponent("id,name,webViewLink"), {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ name: nome, mimeType: CARTELLA, parents: [madre] })
  });
  return await r.json();
}

// Carica un file (Uint8Array) nella cartella (come il modulo Make «Carica su Drive»): {id, name, webViewLink}
export async function driveCarica(env, nome, mime, dati, cartella) {
  const meta = { name: nome, parents: [cartella] };
  const tipo = mime || "application/octet-stream";
  const campi = "&fields=" + encodeURIComponent("id,name,webViewLink");
  if (dati.length <= LIMITE_SEMPLICE) {
    const confine = "tix" + crypto.randomUUID().replace(/-/g, "");
    const enc = new TextEncoder();
    const prima = enc.encode("--" + confine + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(meta)
      + "\r\n--" + confine + "\r\nContent-Type: " + tipo + "\r\n\r\n");
    const dopo = enc.encode("\r\n--" + confine + "--");
    const corpo = new Uint8Array(prima.length + dati.length + dopo.length);
    corpo.set(prima, 0); corpo.set(dati, prima.length); corpo.set(dopo, prima.length + dati.length);
    const r = await chiama(env, CARICA + "/files?uploadType=multipart&supportsAllDrives=true" + campi, {
      method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + confine }, body: corpo
    }, 60000);
    return await r.json();
  }
  const avvio = await chiama(env, CARICA + "/files?uploadType=resumable&supportsAllDrives=true" + campi, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": tipo, "X-Upload-Content-Length": String(dati.length) },
    body: JSON.stringify(meta)
  });
  const dove = avvio.headers.get("Location");
  if (!dove) throw new Error("Google: caricamento a riprese senza indirizzo");
  const r = await conTempo(dove, { method: "PUT", headers: { "Content-Type": tipo }, body: dati }, 120000);
  if (!r.ok) throw new Error("Google caricamento " + r.status + " " + (await r.text().catch(() => "")).slice(0, 200));
  return await r.json();
}

// Sposta nel cestino (solo per le prove: i file veri non si cancellano mai da qui)
export async function driveCestino(env, id) {
  await chiama(env, DRIVE + "/files/" + encodeURIComponent(id) + "?supportsAllDrives=true", {
    method: "PATCH", headers: { "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify({ trashed: true })
  });
  return true;
}

// Nomi delle schede di un foglio Google (per controllare l'accesso senza scrivere)
export async function fogliSchede(env, idFoglio) {
  const r = await chiama(env, FOGLI + "/" + encodeURIComponent(idFoglio) + "?fields=" + encodeURIComponent("properties.title,sheets.properties.title"));
  const d = await r.json();
  return { titolo: d && d.properties ? d.properties.title : "", schede: (d && d.sheets ? d.sheets : []).map((s) => s.properties.title) };
}

// Prima riga (intestazioni) di una scheda
export async function fogliIntestazioni(env, idFoglio, scheda) {
  const r = await chiama(env, FOGLI + "/" + encodeURIComponent(idFoglio) + "/values/" + encodeURIComponent(scheda + "!1:1"));
  const d = await r.json();
  return d && Array.isArray(d.values) && d.values.length ? d.values[0].map((x) => String(x)) : [];
}

// Aggiunge una riga in fondo alla scheda (come i moduli Make «Aggiungi riga», USER_ENTERED + INSERT_ROWS)
export async function fogliAggiungiRiga(env, idFoglio, scheda, valori) {
  const url = FOGLI + "/" + encodeURIComponent(idFoglio) + "/values/" + encodeURIComponent(scheda + "!A1")
    + ":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS";
  const r = await chiama(env, url, {
    method: "POST", headers: { "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify({ values: [valori] })
  });
  return await r.json();
}

// Riga per /stato: mai la chiave, solo se c'è e l'indirizzo del robot
export function googleStato(env) {
  if (!env || !env.GOOGLE_SA_KEY) return "GOOGLE (Drive e Fogli per la tappa B): chiave GOOGLE_SA_KEY assente";
  try {
    const k = leggiChiave(env);
    return "GOOGLE (Drive e Fogli per la tappa B): chiave presente · robot " + k.client_email;
  } catch (e) {
    return "GOOGLE (Drive e Fogli per la tappa B): chiave presente ma non valida (" + e.message + ")";
  }
}

// Prova completa, chiamata da /admin azione «google_prova». Non tocca niente di vero:
// 1) gettone; 2) cartella «TIX — prova wa-relay <data>» nella cartella madre scelta (di base la radice del Drive «TIX — archivio dati»);
// 3) un file di testo dentro; 4) se corpo.cestino = true, cartella e file nel cestino; 5) lettura (senza scrivere)
// delle schede dei fogli in corpo.fogli. Ritorna gli esiti passo per passo.
export async function googleProva(env, corpo) {
  const esiti = [];
  const passo = async (nome, f) => {
    const t = Date.now();
    try { const v = await f(); esiti.push({ passo: nome, ok: true, ms: Date.now() - t, risultato: v }); return v; }
    catch (e) { esiti.push({ passo: nome, ok: false, ms: Date.now() - t, errore: String((e && e.message) || e).slice(0, 300) }); return null; }
  };
  const madre = String((corpo && corpo.madre) || GOOGLE_DRIVE_TIX);
  const g = await passo("gettone", async () => { await googleGettone(env, true); return "ok"; });
  if (!g) return { esiti };
  const nome = "TIX — prova wa-relay " + new Date().toISOString().slice(0, 16).replace("T", " ");
  const giaCe = await passo("cerca cartella", () => driveCercaCartella(env, nome, madre));
  const cart = giaCe || await passo("crea cartella", () => driveCreaCartella(env, nome, madre));
  let file = null;
  if (cart && cart.id) {
    await passo("ritrova cartella", () => driveCercaCartella(env, nome, madre));
    file = await passo("carica file", () => driveCarica(env, "prova.txt", "text/plain",
      new TextEncoder().encode("Prova di wa-relay (tappa B0): si può cancellare.\n"), cart.id));
    if (corpo && corpo.cestino === true) {
      if (file && file.id) await passo("file nel cestino", () => driveCestino(env, file.id));
      await passo("cartella nel cestino", () => driveCestino(env, cart.id));
    }
  }
  const fogli = Array.isArray(corpo && corpo.fogli) ? corpo.fogli.slice(0, 5) : [];
  for (const id of fogli) await passo("foglio " + String(id).slice(0, 8) + "…", () => fogliSchede(env, String(id)));
  return { esiti };
}
