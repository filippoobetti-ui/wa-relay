// Collaudo locale del blocco dei numeri rimossi (09/10/2026): esegue la VERA processAndForward del worker
// (copia index.mjs) con Supabase, Meta e Make sostituiti da finti servizi in memoria.
//   cp src/index.js tools/rimozione/index.mjs
//   printf '\nexport { processAndForward };\n' >> tools/rimozione/index.mjs
//   cd tools/rimozione && node collaudo.mjs
import { processAndForward } from "./index.mjs";

const RIMOSSO = "393775371209", PRESENTE = "393313898967", RIPRISTINATO = "393999999999";
const esiti = [];
function ok(nome, cond, nota) { esiti.push([cond ? "OK " : "KO ", nome, nota || ""]); if (!cond) process.exitCode = 1; }

// finto database: elenco dei rimossi + avviso (una volta ogni 24 ore, qui simulato con un contatore)
const db = { rimossi: [RIMOSSO, RIPRISTINATO], avvisati: {}, log: [], muto: false, rpc: [] };
const chiamate = { make: [], meta: [], supabase: [] };

globalThis.fetch = async (url, init) => {
  const u = String(url);
  const corpo = init && init.body ? String(init.body) : "";
  if (u.includes("/rest/v1/rpc/")) {
    const nome = u.split("/rest/v1/rpc/")[1];
    db.rpc.push(nome);
    if (db.muto) throw new Error("db muto");
    const p = corpo ? JSON.parse(corpo) : {};
    if (nome === "persone_rimosse_numeri") return new Response(JSON.stringify(db.rimossi), { status: 200 });
    if (nome === "persona_rimossa_avviso") {
      const tel = String(p.p_telefono || "");
      if (tel === RIPRISTINATO || db.rimossi.indexOf(tel) === -1) return new Response(JSON.stringify({ rimossa: false }), { status: 200 });
      const avvisa = !db.avvisati[tel];
      db.avvisati[tel] = true;
      return new Response(JSON.stringify({ rimossa: true, avvisa, testo: "⛔ Il tuo accesso al Giornale Lavori è stato disattivato dall'impresa (Brenta Lavori S.r.l.).", lingua: "it", nome: "Filippo Obetti" }), { status: 200 });
    }
    if (nome === "chat_unica_config") return new Response(JSON.stringify({ numeri: [], url: "", chiave: "" }), { status: 200 });
    if (nome === "chat_unica_log") { db.log.push(p); return new Response("null", { status: 200 }); }
    return new Response("{}", { status: 200 });
  }
  if (u.includes("graph.facebook.com")) { chiamate.meta.push(JSON.parse(corpo)); return new Response('{"messages":[{"id":"wamid.x"}]}', { status: 200 }); }
  if (u.includes("hook.make.test")) { chiamate.make.push(JSON.parse(corpo)); return new Response("Accepted", { status: 200 }); }
  return new Response("no", { status: 502 });
};

const env = { MAKE_WEBHOOK_URL: "https://hook.make.test/monolite", SUPABASE_SERVICE_KEY: "prova", SUPABASE_URL: "https://db.test", WHATSAPP_TOKEN: "prova" };
const notifica = (mittenti) => JSON.stringify({ entry: [{ id: "1", changes: [{ field: "messages", value: {
  metadata: { phone_number_id: "1267155263156299" },
  contacts: mittenti.map((t) => ({ wa_id: t, profile: { name: "n" } })),
  messages: mittenti.map((t, i) => ({ from: t, id: "wamid." + t + "." + i, timestamp: "1791580000", type: "text", text: { body: "ciao " + i } }))
} }] }] });

// 1. messaggio di una persona presente: va a Make come sempre, nessuna chiamata di blocco
await processAndForward(notifica([PRESENTE]), env);
ok("presente: inoltrato a Make", chiamate.make.length === 1 && chiamate.make[0].messages[0].from === PRESENTE);
ok("presente: nessun avviso", chiamate.meta.length === 0);
ok("presente: elenco rimossi letto una volta", db.rpc.filter((x) => x === "persone_rimosse_numeri").length === 1);

// 2. messaggio di una persona rimossa: fermato, letto, avviso mandato una volta
await processAndForward(notifica([RIMOSSO]), env);
ok("rimosso: NON inoltrato a Make", chiamate.make.length === 1);
ok("rimosso: segnato come letto + avviso", chiamate.meta.length === 2 && chiamate.meta[0].status === "read" && chiamate.meta[1].to === RIMOSSO && chiamate.meta[1].text.body.startsWith("⛔"));
ok("rimosso: registrato nel log", db.log.length === 1 && db.log[0].p_tipo === "rimosso" && /avviso inviato/.test(db.log[0].p_dettaglio));
ok("rimosso: elenco in memoria (nessuna seconda lettura entro 60 s)", db.rpc.filter((x) => x === "persone_rimosse_numeri").length === 1);

// 3. secondo messaggio dello stesso rimosso: fermato senza nuovo avviso
await processAndForward(notifica([RIMOSSO]), env);
ok("rimosso 2a volta: fermato", chiamate.make.length === 1);
ok("rimosso 2a volta: solo «letto», nessun nuovo avviso", chiamate.meta.length === 3 && chiamate.meta[2].status === "read");

// 4. notifica con due messaggi (rimosso + presente): passa solo quello del presente
await processAndForward(notifica([RIMOSSO, PRESENTE]), env);
ok("misto: a Make va solo il presente", chiamate.make.length === 2 && chiamate.make[1].messages.length === 1 && chiamate.make[1].messages[0].from === PRESENTE);

// 5. numero nell'elenco ma gia' ripristinato nel database (meno di 60 s): il messaggio prosegue
await processAndForward(notifica([RIPRISTINATO]), env);
ok("ripristinato di fresco: inoltrato a Make", chiamate.make.length === 3 && chiamate.make[2].messages[0].from === RIPRISTINATO);
const nLettureFinora = db.rpc.filter((x) => x === "persone_rimosse_numeri").length;
await processAndForward(notifica([PRESENTE]), env);
ok("ripristinato: l'elenco viene riletto subito dopo", db.rpc.filter((x) => x === "persone_rimosse_numeri").length === nLettureFinora + 1);

// 6. database muto: vale l'ultima lista letta, il rimosso resta fermo (senza avviso), il presente passa
const makePrima = chiamate.make.length, metaPrima = chiamate.meta.length;
db.muto = true;
await processAndForward(notifica([RIMOSSO, PRESENTE]), env);
ok("db muto: rimosso fermo, presente inoltrato", chiamate.make.length === makePrima + 1 && chiamate.make[makePrima].messages[0].from === PRESENTE);
ok("db muto: nessun avviso tentato", chiamate.meta.length === metaPrima);
db.muto = false;

// 7. interruttore RIMOZIONE=off: tutto a Make come prima
const makeOff = chiamate.make.length;
await processAndForward(notifica([RIMOSSO]), { ...env, RIMOZIONE: "off" });
ok("RIMOZIONE=off: il rimosso va a Make", chiamate.make.length === makeOff + 1);

for (const [s, n, nota] of esiti) console.log(s + n + (nota ? "   [" + nota + "]" : ""));
console.log(esiti.filter((e) => e[0] === "KO ").length + " problemi su " + esiti.length + " controlli");
