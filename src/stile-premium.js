// Restyling «premium» del portale (24/10/2026, bozza da approvare da Filippo): un solo strato di stile aggiunto in
// fondo all'<head> di ogni pagina HTML del portale (accesso, elenco e schede dei cantieri che arrivano dal database,
// agenda, rapportini, cronoprogramma, data certa, nuovo cantiere). Cambia SOLO l'aspetto: testi, collegamenti e
// funzioni restano gli stessi, e il database non si tocca. Stesse regole del sito: fondo bianco neutro, schede
// sollevate con ombre a più livelli, vetro smerigliato sulle barre, caratteri di sistema (San Francisco su Apple),
// passaggi di 250-300 ms. Il tema scuro c'è dove c'era già (accesso e pagine dell'area riservata); l'elenco e le
// schede restano chiari come oggi. Interruttore d'emergenza: variabile del Worker PREMIUM=off (tutto come prima).

const C = "cubic-bezier(.16,1,.3,1)";
const OMBRA_1 = "0 1px 2px rgba(16,27,43,.05),0 8px 20px -14px rgba(16,27,43,.20),0 0 0 1px rgba(16,27,43,.03)";
const OMBRA_2 = "0 1px 2px rgba(16,27,43,.05),0 20px 40px -20px rgba(16,27,43,.28),0 0 0 1px rgba(16,27,43,.03)";
const OMBRA_SU = "0 2px 6px rgba(16,27,43,.06),0 26px 50px -22px rgba(16,27,43,.36),0 0 0 1px rgba(16,27,43,.04)";
const RIFLESSO = "linear-gradient(180deg,rgba(255,255,255,.7),rgba(255,255,255,0) 44%)";
const LUCIDO = "linear-gradient(180deg,rgba(255,255,255,.24),rgba(255,255,255,.06) 48%,rgba(255,255,255,0) 52%)";
const NAVY = "linear-gradient(168deg,#22395A 0%,#172840 55%,#121F33 100%)";
const SCHEDE = ["g", "r", "d", "f", "p", "x", "a", "c", "s"];
// scheda attiva del cantiere: stessi selettori del database (prima e dopo che le frecce avvolgono la riga), un po' più forti
const ATTIVA = SCHEDE.map((k) => "html body #tb-" + k + ":checked~nav label[for=tb-" + k + "],html body #tb-" + k + ":checked~.schede-w label[for=tb-" + k + "]").join(",");
const ATTIVA_CNT = SCHEDE.map((k) => "html body #tb-" + k + ":checked~nav label[for=tb-" + k + "] .cnt,html body #tb-" + k + ":checked~.schede-w label[for=tb-" + k + "] .cnt").join(",");
// pagine con la scheda centrale e l'icona dell'app (accesso, password, crea accesso): hanno già il tema scuro
const AREA = "body:has(>main>.card>img[src$=\"/icona-192.png\"])";
// pagine Persone del cantiere e Rubrica (src/persone-cantiere.js, 26/10/2026): testata .testa e tema scuro loro
const PAG = "body:has(>header.testa)";
const RIFLESSO_SCURO = "linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,0) 46%)";

export const PREMIUM_PORTALE = "<style id=\"tx-premium\">" +
  // 1. colori, caratteri e fondo
  ":root{--sfondo:#F8FAFC;--bordo:rgba(16,27,43,.10)}" +
  "html{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}" +
  "body{font-family:-apple-system,BlinkMacSystemFont,\"SF Pro Text\",\"Inter\",\"Segoe UI Variable Text\",\"Segoe UI\",Roboto,system-ui,sans-serif;letter-spacing:-.006em;" +
  "background:radial-gradient(1100px 600px at 100% -10%,rgba(242,106,16,.05),transparent 60%),radial-gradient(900px 600px at -10% 0%,rgba(27,47,74,.06),transparent 60%),#F8FAFC;background-attachment:fixed}" +
  "h1,h2,h3{letter-spacing:-.02em}" +
  "::selection{background:rgba(242,106,16,.22)}" +
  // 2. testata: blu TIX con riflesso dall'alto
  "header{background:" + "linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,0))," + NAVY + ";border-bottom:1px solid rgba(255,255,255,.08);box-shadow:0 14px 34px -24px rgba(16,27,43,.75)}" +
  "header .logo,header .logo-impresa{border-radius:12px}" +
  "header .agg a{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.22)!important;-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);box-shadow:inset 0 1px 0 rgba(255,255,255,.10);transition:background-color .25s " + C + ",transform .25s " + C + "}" +
  "header .agg a:hover{background:rgba(255,255,255,.16)}" +
  // 3. barra delle sezioni del cantiere: vetro smerigliato
  "html body nav.schede{background:rgba(248,250,252,.74);-webkit-backdrop-filter:saturate(180%) blur(16px);backdrop-filter:saturate(180%) blur(16px);border-bottom:1px solid rgba(16,27,43,.07);box-shadow:0 10px 24px -20px rgba(16,27,43,.45)}" +
  "html body nav.schede label{background:linear-gradient(110deg,rgba(255,255,255,0) 40%,rgba(255,255,255,.75) 46%,rgba(226,232,240,.65) 52%,rgba(255,255,255,0) 58%) 100% 0/260% 100% no-repeat,linear-gradient(180deg,#FFFFFF,#F2F5F8);" +
  "border-color:rgba(16,27,43,.10);color:#1B2F4A;box-shadow:0 1px 2px rgba(16,27,43,.05);transition:transform .25s " + C + ",background-color .25s " + C + ",box-shadow .25s " + C + "}" +
  "html body nav.schede label:hover{box-shadow:0 6px 14px -8px rgba(16,27,43,.35)}" +
  "html body nav.schede .cnt{background:rgba(27,47,74,.08);color:#1B2F4A}" +
  ATTIVA + "{background:linear-gradient(110deg,rgba(255,255,255,0) 40%,rgba(255,255,255,.30) 46%,rgba(255,255,255,.16) 52%,rgba(255,255,255,0) 58%) 100% 0/260% 100% no-repeat,linear-gradient(180deg,#2E4A70,#1B2F4A);" +
  "border-color:#1B2F4A;color:#fff;box-shadow:inset 0 1px 0 rgba(255,255,255,.18),0 8px 18px -8px rgba(27,47,74,.6);text-shadow:none}" +
  ATTIVA_CNT + "{background:rgba(255,255,255,.18);color:#fff}" +
  ".sch-fr.sx{background:linear-gradient(90deg,rgba(248,250,252,.96) 50%,rgba(248,250,252,0))}.sch-fr.dx{background:linear-gradient(270deg,rgba(248,250,252,.96) 50%,rgba(248,250,252,0))}" +
  ".sch-fr span{background:linear-gradient(180deg,#FFA552,#F26A10);box-shadow:inset 0 1px 0 rgba(255,255,255,.4),0 6px 14px -6px rgba(242,106,16,.7)}" +
  // 4. schede e pannelli: sollevati, con ombre a più livelli e riflesso
  "a.cantiere,.voce,.scheda,details.gg,.vuoto,.avviso,.campo,.gl-az,.ag,details.ics-box,.pass-box,.card{background-image:" + RIFLESSO + ";background-repeat:no-repeat}" +
  "a.cantiere,.scheda,details.gg,.gl-az,.ag,.campo,details.ics-box{border-radius:18px;border-color:rgba(16,27,43,.08);box-shadow:" + OMBRA_1 + "}" +
  ".voce{border-radius:14px;border-color:rgba(16,27,43,.08);box-shadow:0 1px 2px rgba(16,27,43,.04)}" +
  ".avviso{border-radius:14px;box-shadow:" + OMBRA_1 + "}" +
  ".vuoto{border-radius:16px;border-color:rgba(16,27,43,.16)}" +
  "a.cantiere{padding:16px 18px;margin-bottom:14px}" +
  "a.cantiere,.gl-az,.ag,.scheda{transition:transform .3s ease-out,box-shadow .3s ease-out,border-color .3s ease-out}" +
  "a.cantiere:hover,.gl-az:hover{transform:translateY(-3px);box-shadow:" + OMBRA_SU + "}" +
  "a.cantiere:hover:active,.gl-az:hover:active{transform:scale(.985)}" +
  ".nome{letter-spacing:-.015em}" +
  ".cifre{border-top-color:rgba(16,27,43,.07)}" +
  ".gl-az{gap:9px}.gl-az .ic{box-shadow:inset 0 1px 0 rgba(255,255,255,.45),0 6px 14px -6px rgba(16,27,43,.45)}" +
  "details.gg>summary{min-height:52px;padding:12px 16px}" +
  ".gg .dentro{border-top-color:rgba(16,27,43,.06)}" +
  ".sez{background:rgba(27,47,74,.07);color:#1B2F4A;border-radius:7px;padding:2px 8px;font-weight:600}" +
  ".totale{background:" + LUCIDO + "," + NAVY + ";border-radius:18px;box-shadow:inset 0 1px 0 rgba(255,255,255,.12)," + OMBRA_2 + "}" +
  ".tit{border-bottom-width:1px;letter-spacing:-.01em}" +
  "a.link{border-radius:12px;background:#fff linear-gradient(180deg,#FFFFFF,#F4F7FA);border-color:rgba(16,27,43,.10);box-shadow:0 1px 2px rgba(16,27,43,.05);transition:transform .25s " + C + ",box-shadow .25s " + C + "}" +
  "a.link:hover{transform:translateY(-1px);box-shadow:0 8px 18px -10px rgba(16,27,43,.4)}" +
  // 5. immagini: angoli molto arrotondati e bordo leggero di contenimento
  ".mini{border-radius:14px;border:0;outline:1px solid rgba(16,27,43,.10);outline-offset:-1px;box-shadow:" + OMBRA_1 + "}" +
  ".griglia{gap:8px}.griglia img{border-radius:14px;outline:1px solid rgba(16,27,43,.08);outline-offset:-1px}" +
  ".griglia a span{border-radius:6px;background:rgba(16,24,38,.6);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}" +
  // 6. campi e pulsanti: bordi morbidi e finitura lucida
  "input,select,textarea{border-radius:12px;transition:border-color .25s " + C + ",box-shadow .25s " + C + "}" +
  "input:focus,select:focus,textarea:focus{outline:none;border-color:#1B2F4A;box-shadow:0 0 0 4px rgba(27,47,74,.12)}" +
  ".card button,.card .btn,.barra button,.ag-btn,dialog .si,.dl-b .si{background-image:" + LUCIDO + ";border-radius:12px;" +
  "box-shadow:inset 0 1px 0 rgba(255,255,255,.22),inset 0 0 0 1px rgba(255,255,255,.08),0 10px 22px -12px rgba(16,27,43,.6);transition:transform .25s " + C + ",box-shadow .25s " + C + ",filter .25s " + C + "}" +
  ".card button:hover,.card .btn:hover,.barra button:hover,.ag-btn:hover,dialog .si:hover{transform:translateY(-1px);filter:brightness(1.06)}" +
  ".card button:active,.card .btn:active,.barra button:active,.ag-btn:active,dialog .si:active{transform:scale(.985)}" +
  "dialog{border-radius:22px!important;box-shadow:0 2px 6px rgba(0,0,0,.08),0 40px 80px -30px rgba(0,0,0,.45)!important}" +
  "dialog::backdrop{-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}" +
  // 7. movimento: entrate a cascata più leggere
  "@keyframes gl-entra{from{opacity:0;transform:translateY(10px)}}" +
  ".gl-entra{animation-duration:.55s!important;animation-timing-function:" + C + "!important}" +
  "@media (prefers-reduced-motion:no-preference){@keyframes tx-entra{from{opacity:0;transform:translateY(8px)}}" +
  ".gl-azioni>.gl-az{animation:tx-entra .5s " + C + " backwards}.gl-azioni>:nth-child(2){animation-delay:.05s}.gl-azioni>:nth-child(3){animation-delay:.1s}.gl-azioni>:nth-child(4){animation-delay:.15s}}" +
  "@media (prefers-reduced-motion:reduce){a.cantiere:hover,.gl-az:hover,a.link:hover{transform:none}}" +
  // 8. accesso e pagine dell'area riservata: scheda di vetro al centro, anche in tema scuro
  AREA + "{background:radial-gradient(900px 520px at 85% -10%,rgba(242,106,16,.10),transparent 60%),radial-gradient(800px 560px at 0% 110%,rgba(27,47,74,.12),transparent 60%),var(--b)}" +
  AREA + "{min-height:100vh;background-attachment:fixed;background-repeat:no-repeat}" +
  AREA + " main{padding-top:64px}" +
  AREA + " .card{background-color:rgba(255,255,255,.78);-webkit-backdrop-filter:saturate(180%) blur(16px);backdrop-filter:saturate(180%) blur(16px);" +
  "border:1px solid rgba(255,255,255,.7);border-radius:24px;padding:28px 24px;box-shadow:" + OMBRA_2 + "}" +
  AREA + " .card>img:first-child{border-radius:20px;box-shadow:0 1px 2px rgba(0,0,0,.06),0 12px 26px -12px rgba(16,27,43,.45)}" +
  AREA + " h1{letter-spacing:-.03em;background:linear-gradient(135deg,#0E1828,#2A3B54 50%,#0E1828);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}" +
  AREA + " input{background:rgba(255,255,255,.9);border-color:rgba(16,27,43,.12)}" +
  AREA + " button,"+ AREA + " .btn{background-color:#1B2F4A;background-image:" + LUCIDO + ",linear-gradient(180deg,#2E4A70,#1B2F4A)}" +
  "@media (prefers-color-scheme:dark){" +
  AREA + "{--b:#0C0D12;--c:#14161D;--l:rgba(255,255,255,.10);background:radial-gradient(900px 520px at 85% -10%,rgba(242,106,16,.10),transparent 60%),radial-gradient(800px 560px at 0% 110%,rgba(60,90,140,.14),transparent 60%),#0C0D12;background-attachment:fixed;background-repeat:no-repeat}" +
  AREA + " .card{background-color:rgba(255,255,255,.04);background-image:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,0) 46%);border-color:rgba(255,255,255,.10);" +
  "box-shadow:0 20px 40px -15px rgba(0,0,0,.5),0 0 1px 1px rgba(255,255,255,.05)}" +
  AREA + " h1{background:linear-gradient(135deg,#FFFFFF,#AEB8C5 55%,#FFFFFF);-webkit-background-clip:text;background-clip:text}" +
  AREA + " input{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.12);color:#ECEFF4}" +
  AREA + " input:focus{border-color:#7FA2D6;box-shadow:0 0 0 4px rgba(127,162,214,.18)}" +
  AREA + " button," + AREA + " .btn{background-image:" + LUCIDO + ",linear-gradient(180deg,#35547E,#22395A);box-shadow:inset 0 0 0 1px rgba(255,255,255,.14),0 10px 24px -12px rgba(0,0,0,.8)}" +
  AREA + " a{color:#9DBBE6}" +
  AREA + " details.wa{border-top-color:rgba(255,255,255,.08)}" +
  "}" +
  // 9. Persone del cantiere e Rubrica (26/10/2026): stesso linguaggio delle altre pagine. Il fondo resta quello della
  // pagina (var(--bg)), così nel tema scuro i testi chiari restano leggibili.
  PAG + "{background:radial-gradient(1100px 600px at 100% -10%,rgba(242,106,16,.05),transparent 60%),radial-gradient(900px 600px at -10% 0%,rgba(27,47,74,.06),transparent 60%),var(--bg);background-attachment:fixed}" +
  PAG + ">header.testa{background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,0))," + NAVY + ";border-bottom:1px solid rgba(255,255,255,.08);box-shadow:0 14px 34px -24px rgba(16,27,43,.75)}" +
  "body:has(#cerca)>header.testa{background:linear-gradient(180deg,rgba(255,255,255,.10),rgba(255,255,255,0)),linear-gradient(135deg,#C2540B,#F26A10)}" +
  PAG + " .testa h1{letter-spacing:-.025em}" +
  PAG + " .riass span{background:rgba(255,255,255,.10);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.12);box-shadow:inset 0 1px 0 rgba(255,255,255,.10)}" +
  PAG + " .p{border-radius:18px;border-color:rgba(16,27,43,.08);background-image:" + RIFLESSO + ";background-repeat:no-repeat;box-shadow:" + OMBRA_1 + ";transition:transform .3s ease-out,box-shadow .3s ease-out}" +
  PAG + " .p:hover{transform:translateY(-2px);box-shadow:" + OMBRA_SU + "}" +
  PAG + " .btn{background-image:linear-gradient(180deg,#FFFFFF,#F4F7FA);border-color:rgba(16,27,43,.12);box-shadow:0 1px 2px rgba(16,27,43,.05);transition:transform .25s " + C + ",box-shadow .25s " + C + ",filter .25s " + C + "}" +
  PAG + " .btn:hover{transform:translateY(-1px);box-shadow:0 8px 18px -10px rgba(16,27,43,.4)}" +
  PAG + " .btn:active{transform:scale(.985)}" +
  PAG + " .btn.pr{background-image:" + LUCIDO + ",linear-gradient(180deg,#FF8A3D,#F26A10);box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 10px 22px -12px rgba(242,106,16,.75)}" +
  PAG + " .btn.wa{background-image:" + LUCIDO + ",linear-gradient(180deg,#27A85D,#1F8F4E);box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 10px 22px -12px rgba(31,143,78,.7)}" +
  PAG + " .btn.pr:hover," + PAG + " .btn.wa:hover{filter:brightness(1.06)}" +
  PAG + " .btn.rosso{background-image:linear-gradient(180deg,#FFFFFF,#FDF3F2);border-color:var(--rosso)}" +
  PAG + " .btn.pr{border-color:var(--arancio)}" + PAG + " .btn.wa{border-color:#1F8F4E}" +
  PAG + " .stato{box-shadow:inset 0 0 0 1px rgba(16,27,43,.05)}" +
  PAG + " .campo{border-radius:12px;box-shadow:none;background-image:none}" +
  PAG + " .campo:focus{outline:none;border-color:#1B2F4A;box-shadow:0 0 0 4px rgba(27,47,74,.12)}" +
  PAG + " .nota{border-radius:14px}" + PAG + " .inv{border-radius:16px}" + PAG + " .qr{border-radius:12px}" +
  PAG + " .velo{-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}" +
  PAG + " .foglio{border-radius:22px 22px 0 0;background-image:" + RIFLESSO + ";background-repeat:no-repeat;box-shadow:0 -2px 6px rgba(0,0,0,.06),0 -30px 60px -30px rgba(0,0,0,.45)}" +
  PAG + " .toast{background:rgba(27,47,74,.86);-webkit-backdrop-filter:saturate(180%) blur(16px);backdrop-filter:saturate(180%) blur(16px);box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 12px 30px -12px rgba(16,27,43,.6)}" +
  PAG + " .tg i{box-shadow:inset 0 1px 2px rgba(0,0,0,.12)}" +
  "@media (prefers-color-scheme:dark){" +
  PAG + " .p," + PAG + " .foglio{background-image:" + RIFLESSO_SCURO + ";border-color:rgba(255,255,255,.08);box-shadow:0 20px 40px -18px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.04)}" +
  PAG + " .btn{background-image:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,0));border-color:rgba(255,255,255,.12);box-shadow:none}" +
  PAG + " .btn.rosso{background-image:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,0));border-color:var(--rosso)}" +
  PAG + " .campo:focus{border-color:#7FA2D6;box-shadow:0 0 0 4px rgba(127,162,214,.18)}" +
  "}" +
  "@media (prefers-reduced-motion:reduce){" + PAG + " .p:hover," + PAG + " .btn:hover{transform:none}}" +
  // 10. pulsanti «Persone del cantiere» e «Scarica in Excel» nella pagina del cantiere, e la finestra di Scarica in Excel
  ".gl-pc-b,.gl-xl-b{width:auto;border-radius:12px;background-image:linear-gradient(180deg,rgba(255,255,255,.75),rgba(255,255,255,0));" +
  "box-shadow:0 1px 2px rgba(16,27,43,.05),0 8px 18px -12px rgba(16,27,43,.35);transition:transform .25s " + C + ",box-shadow .25s " + C + ",background-color .25s " + C + ",color .25s " + C + "}" +
  ".gl-pc-b:hover,.gl-xl-b:hover{transform:translateY(-1px);background-image:" + LUCIDO + ";box-shadow:inset 0 1px 0 rgba(255,255,255,.18),0 10px 22px -12px rgba(16,27,43,.55)}" +
  ".gl-pc-b:active,.gl-xl-b:active{transform:scale(.985)}" +
  ".gl-xl-ov{-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}" +
  ".gl-xl-bx{border-radius:22px;padding:22px 22px 18px;background-image:" + RIFLESSO + ";background-repeat:no-repeat;box-shadow:0 2px 6px rgba(0,0,0,.08),0 40px 80px -30px rgba(0,0,0,.45)}" +
  ".gl-xl-bx h3{letter-spacing:-.02em}" +
  ".gl-xl-bx label.op{border-radius:12px;border-color:rgba(16,27,43,.10);transition:border-color .25s " + C + ",box-shadow .25s " + C + "}" +
  ".gl-xl-bx label.op:has(input:checked){border-color:#1D6F42;box-shadow:0 0 0 3px rgba(29,111,66,.12)}" +
  ".gl-xl-dt input{border-radius:12px}" +
  ".gl-xl-az button{border-radius:12px;background-image:linear-gradient(180deg,#FFFFFF,#F4F7FA);box-shadow:0 1px 2px rgba(16,27,43,.05);transition:transform .25s " + C + ",box-shadow .25s " + C + ",filter .25s " + C + "}" +
  ".gl-xl-az button.pr{background-image:" + LUCIDO + ",linear-gradient(180deg,#27894F,#1D6F42);box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 10px 22px -12px rgba(29,111,66,.75)}" +
  ".gl-xl-az button:hover{transform:translateY(-1px);filter:brightness(1.04)}.gl-xl-az button:active{transform:scale(.985)}" +
  "@media (prefers-color-scheme:dark){.gl-pc-b,.gl-xl-b{background-image:none;box-shadow:0 8px 18px -12px rgba(0,0,0,.6)}" +
  ".gl-xl-bx{background-image:" + RIFLESSO_SCURO + "}.gl-xl-az button{background-image:none}.gl-xl-bx label.op{border-color:#3a4540}}" +
  "@media (prefers-reduced-motion:reduce){.gl-pc-b:hover,.gl-xl-b:hover,.gl-xl-az button:hover{transform:none}}" +
  "</style>";

// Aggiunge lo strato a una risposta HTML del portale (le altre risposte passano intatte).
export function portaleConPremium(risposta, env) {
  if (env && env.PREMIUM === "off") return risposta;
  if (typeof HTMLRewriter === "undefined" || !risposta || !risposta.body) return risposta;
  if ((risposta.headers.get("Content-Type") || "").indexOf("text/html") === -1) return risposta;
  return new HTMLRewriter().on("head", { element(el) { el.append(PREMIUM_PORTALE, { html: true }); } }).transform(risposta);
}
