// Collaudo dei movimenti del portale in Chromium (telefono emulato, tocco reale via CDP).
// Dal 10/10/2026 i movimenti sono accesi di norma: ?movimenti=0 (cookie gl_mov=0) li spegne su un telefono,
// la variabile del Worker MOVIMENTI=off li spegne per tutti (qui simulata dal comando /__prova/movimenti del server di prova).
import { chromium } from "playwright";
import { TOKEN, CID } from "./pagine.mjs";

const BASE = "http://127.0.0.1:8787";
const esiti = [];
function ok(nome, cond, nota) { esiti.push([cond ? "OK " : "KO ", nome, nota || ""]); if (!cond) process.exitCode = 1; }

// 0. livello HTTP (senza browser): chi vede i movimenti e quale cookie viene impostato
const chiedi = async (percorso, cookie) => {
  const r = await fetch(BASE + percorso, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" });
  return { stato: r.status, corpo: await r.text(), setCookie: r.headers.get("set-cookie") || "" };
};
const conMov = (r) => r.corpo.includes("@view-transition");
{
  const pag = "/?t=" + TOKEN;
  let r = await chiedi(pag);
  ok("HTTP: senza parametri e senza cookie i movimenti ci sono", r.stato === 200 && conMov(r) && r.setCookie === "", r.stato + " set-cookie=" + r.setCookie);
  r = await chiedi(pag + "&movimenti=0");
  ok("HTTP: ?movimenti=0 spegne e lascia il cookie gl_mov=0 (90 giorni)", !conMov(r) && /gl_mov=0;/.test(r.setCookie) && /Max-Age=7776000/.test(r.setCookie), r.setCookie);
  r = await chiedi(pag, "gl_mov=0");
  ok("HTTP: cookie gl_mov=0 senza parametro: spenti, nessun nuovo cookie", !conMov(r) && r.setCookie === "");
  r = await chiedi(pag, "a=1; gl_mov=0; b=2");
  ok("HTTP: gl_mov=0 in mezzo ad altri cookie: spenti", !conMov(r));
  r = await chiedi(pag, "gl_mov=1");
  ok("HTTP: vecchio cookie gl_mov=1 (quello della prova): accesi", conMov(r));
  r = await chiedi(pag + "&movimenti=1", "gl_mov=0");
  ok("HTTP: ?movimenti=1 prevale sul cookie spento e lo riaccende", conMov(r) && /gl_mov=1;/.test(r.setCookie), r.setCookie);
  r = await chiedi(pag, "gl_mov=2; xgl_mov=0");
  ok("HTTP: cookie non valido o con nome simile: restano accesi", conMov(r));
  r = await chiedi("/?t=" + "0".repeat(64));
  ok("HTTP: collegamento non attivo: pagina d'errore senza movimenti", r.stato === 200 && !conMov(r) && /Collegamento non attivo/.test(r.corpo));
  r = await chiedi("/?movimenti=0");
  ok("HTTP: schermata d'ingresso senza gettone: nessun errore e nessun cookie", r.stato === 200 && r.setCookie === "" && !conMov(r));
}

const browser = await chromium.launch({ headless: true, executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: "it-IT" });
const page = await ctx.newPage();
const errori = [];
page.on("pageerror", (e) => errori.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errori.push("console: " + m.text()); });
await page.addInitScript(() => {
  window.__vt = 0; window.__reveal = null;
  const orig = document.startViewTransition ? document.startViewTransition.bind(document) : null;
  if (orig) document.startViewTransition = function (cb) { window.__vt++; return orig(cb); };
  window.addEventListener("pagereveal", (e) => { window.__reveal = !!e.viewTransition; });
});

// 1. elenco SENZA alcun parametro: dal 10/10/2026 i movimenti sono accesi di norma
await page.goto(BASE + "/?t=" + TOKEN, { waitUntil: "load" });
ok("senza parametri nessun cookie impostato", !(await ctx.cookies()).some((c) => c.name === "gl_mov"));
ok("stile dei movimenti presente", await page.evaluate(() => !![...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => r.cssText.includes("view-transition")); } catch (e) { return false; } })));
ok("supporto View Transitions nel browser", await page.evaluate(() => typeof document.startViewTransition === "function"));
const nomi = await page.$$eval("a.cantiere", (as) => as.map((a) => a.style.viewTransitionName));
ok("nomi di transizione sulle schede dei cantieri", nomi[0] === "c-" + CID && nomi.slice(0, 5).every((n) => n.startsWith("c-")) && nomi[5] === "", nomi.join(","));
ok("entrata a cascata sulle schede", await page.$$eval("a.cantiere.gl-entra", (as) => as.length) === 6);
ok("ritardo crescente", await page.$$eval("a.cantiere", (as) => as[2].style.animationDelay) === "120ms");

// 2. apertura del cantiere (transizione fra pagine)
await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("a.cantiere")]);
ok("pagina del cantiere raggiunta senza parametro", page.url().includes("c=" + CID) && !page.url().includes("movimenti"));
ok("stile dei movimenti anche sulla pagina del cantiere", await page.evaluate(() => [...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => r.cssText.includes("view-transition")); } catch (e) { return false; } })));
ok("intestazione con il nome della scheda", await page.$eval("header", (h) => h.style.viewTransitionName) === "c-" + CID);
const reveal1 = await page.evaluate(() => window.__reveal);
ok("transizione fra pagine avvenuta (pagereveal con viewTransition)", reveal1 === true, "reveal=" + reveal1);
ok("pillola attiva nominata", await page.$eval('label[for="tb-g"]', (l) => l.style.viewTransitionName) === "tab-attiva");
ok("nessuna transizione nella stessa pagina ancora", await page.evaluate(() => window.__vt) === 0);

// 3. cambio sezione toccando la pillola
await page.tap('label[for="tb-r"]');
await page.waitForTimeout(120);
ok("Rapportini selezionata", await page.$eval("#tb-r", (r) => r.checked));
ok("hash aggiornato dal copione di pagina", await page.evaluate(() => location.hash) === "#r");
ok("direzione avanti", await page.evaluate(() => document.documentElement.getAttribute("data-dir")) === "avanti");
ok("startViewTransition chiamata", await page.evaluate(() => window.__vt) === 1);
ok("pillola attiva spostata", await page.$eval('label[for="tb-r"]', (l) => l.style.viewTransitionName) === "tab-attiva" && await page.$eval('label[for="tb-g"]', (l) => l.style.viewTransitionName) === "");
await page.waitForTimeout(400);
const durante = await page.$eval("#p-r .totale .v", (e) => e.textContent);
await page.waitForTimeout(1200);
const fine = await page.$$eval("#p-r .totale .v", (es) => es.map((e) => e.textContent));
ok("conteggio delle ore in corso dopo il cambio", /^\d+,\d{2} h$/.test(durante) && durante !== "16,50 h", "visto: " + durante);
ok("conteggio finito sul valore esatto", fine[0] === "16,50 h" && fine[1] === "16,50 h", fine.join(" | "));
ok("sezione Rapportini visibile", await page.$eval("#p-r", (s) => getComputedStyle(s).display) === "block");

// 4. trascinamento con il dito (CDP: tocco reale)
const cdp = await ctx.newCDPSession(page);
async function swipe(x0, x1, y) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
  const passi = 6;
  for (let i = 1; i <= passi; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + (x1 - x0) * i / passi, y: y + i }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
const yContenuto = await page.$eval("#p-r .totale", (e) => e.getBoundingClientRect().top + 20);
await swipe(320, 110, yContenuto);
await page.waitForTimeout(150);
ok("trascinando a sinistra si passa a DDT", await page.$eval("#tb-d", (r) => r.checked) && await page.evaluate(() => document.documentElement.getAttribute("data-dir")) === "avanti");
const yDdt = await page.$eval("#p-d .vuoto", (e) => e.getBoundingClientRect().top + 10);
await swipe(80, 300, yDdt);
await page.waitForTimeout(150);
ok("trascinando a destra si torna a Rapportini", await page.$eval("#tb-r", (r) => r.checked) && await page.evaluate(() => document.documentElement.getAttribute("data-dir")) === "indietro");
ok("tre transizioni nella stessa pagina", await page.evaluate(() => window.__vt) === 3);
// un tocco secco (senza spostamento) non cambia sezione
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 200, y: yContenuto }] });
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await page.waitForTimeout(100);
ok("un tocco fermo non cambia sezione", await page.$eval("#tb-r", (r) => r.checked));
// trascinamento sulla riga delle pillole: non cambia sezione (la riga scorre di suo)
const yNav = await page.$eval("nav.schede", (e) => e.getBoundingClientRect().top + 20);
await swipe(320, 110, yNav);
await page.waitForTimeout(150);
ok("trascinare sulla riga delle sezioni non cambia sezione", await page.$eval("#tb-r", (r) => r.checked));

// 5. ritorno all'elenco
await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("a.indietro")]);
ok("tornati all'elenco", !page.url().includes("c="));
const reveal2 = await page.evaluate(() => window.__reveal);
ok("transizione fra pagine anche al ritorno", reveal2 === true, "reveal=" + reveal2);
ok("niente cascata quando arriva una transizione fra pagine", await page.$$eval("a.cantiere.gl-entra", (as) => as.length) === (reveal2 ? 0 : 6));
ok("nessuna scheda rimasta in attesa", await page.$$eval("a.cantiere.gl-attesa", (as) => as.length) === 0);

// 6. riduci animazioni: niente cascata, niente transizioni
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
const p2 = await ctx2.newPage();
await p2.addInitScript(() => { window.__vt = 0; const o = document.startViewTransition.bind(document); document.startViewTransition = function (cb) { window.__vt++; return o(cb); }; });
await p2.goto(BASE + "/?t=" + TOKEN + "&c=" + CID, { waitUntil: "load" });
await p2.tap('label[for="tb-r"]');
await p2.waitForTimeout(100);
ok("riduci animazioni: cambio sezione senza transizione", await p2.$eval("#tb-r", (r) => r.checked) && await p2.evaluate(() => window.__vt) === 0);
ok("riduci animazioni: ore mostrate subito per intero", await p2.$eval("#p-r .totale .v", (e) => e.textContent) === "16,50 h");
await ctx2.close();

// 7. scelta del singolo telefono: ?movimenti=0 spegne (e il cookie lo ricorda), ?movimenti=1 riaccende
const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const p3 = await ctx3.newPage();
await p3.goto(BASE + "/?t=" + TOKEN + "&c=" + CID + "&movimenti=0", { waitUntil: "load" });
ok("?movimenti=0: nessun movimento iniettato", await p3.evaluate(() => !document.querySelector("header").style.viewTransitionName && !document.documentElement.hasAttribute("data-dir")));
ok("?movimenti=0: cookie gl_mov=0 impostato", (await ctx3.cookies()).some((c) => c.name === "gl_mov" && c.value === "0"));
await p3.tap('label[for="tb-d"]');
ok("?movimenti=0: le sezioni funzionano come prima", await p3.$eval("#tb-d", (r) => r.checked));
await p3.goto(BASE + "/?t=" + TOKEN + "&c=" + CID, { waitUntil: "load" });
ok("senza parametro il telefono resta senza movimenti (vale il cookie)", await p3.evaluate(() => !document.querySelector("header").style.viewTransitionName));
await p3.goto(BASE + "/?t=" + TOKEN + "&c=" + CID + "&movimenti=1", { waitUntil: "load" });
ok("?movimenti=1: movimenti di nuovo accesi e cookie gl_mov=1", await p3.$eval("header", (h) => h.style.viewTransitionName) === "c-" + CID && (await ctx3.cookies()).some((c) => c.name === "gl_mov" && c.value === "1"));
await ctx3.close();

// 8. interruttore d'emergenza del Worker (MOVIMENTI=off): spegne per tutti, dal telefono non si scavalca
await fetch(BASE + "/__prova/movimenti?v=off");
{
  const pag = "/?t=" + TOKEN;
  let r = await chiedi(pag);
  ok("MOVIMENTI=off: spenti per tutti", r.stato === 200 && !conMov(r));
  r = await chiedi(pag + "&movimenti=1", "gl_mov=1");
  ok("MOVIMENTI=off: né ?movimenti=1 né il cookie lo scavalcano", r.stato === 200 && !conMov(r));
  r = await chiedi(pag + "&c=" + CID);
  ok("MOVIMENTI=off: anche sulla pagina del cantiere, che resta intera", r.stato === 200 && !conMov(r) && r.corpo.includes('id="tb-r"'));
}
await fetch(BASE + "/__prova/movimenti?v=on");
{ const r = await chiedi("/?t=" + TOKEN); ok("MOVIMENTI tolta: di nuovo accesi", conMov(r)); }

{ const js = errori.filter((e) => !/Failed to load resource/.test(e)); ok("nessun errore JavaScript", js.length === 0, js.join(" / ")); }
await browser.close();
for (const [s, n, nota] of esiti) console.log(s + n + (nota ? "   [" + nota + "]" : ""));
console.log(esiti.filter((e) => e[0] === "KO ").length + " problemi su " + esiti.length + " controlli");
