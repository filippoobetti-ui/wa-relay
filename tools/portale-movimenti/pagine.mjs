// Pagine di prova con la stessa struttura delle pagine vere del portale (dashboard_html del 09/10/2026):
// elenco (schede a.cantiere) e cantiere (intestazione, radio tb-*, nav.schede, section.pann, script di pagina).
export const TOKEN = "a".repeat(64);
export const CID = "e4dbe85f-a505-4fe5-9b51-4a13143d6699";

const STILE = `:root{--accento:#0A7D48;--bordo:#d5dcd8;--sfondo:#F4F6F5}*{box-sizing:border-box}body{margin:0;padding:0 0 32px;background:var(--sfondo);color:#111;line-height:1.45;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif}header{background:#052A21;color:#fff;padding:16px 20px 18px}header h1{margin:0;font-size:1.15rem}header p{margin:4px 0 0;font-size:.85rem;opacity:.9}main{max-width:620px;margin:0 auto;padding:16px 16px 0}header .agg{font-size:.78rem;opacity:.85;margin-top:8px;display:flex;align-items:center;flex-wrap:wrap;gap:8px}header .agg a{display:inline-block;padding:7px 14px;border:1px solid rgba(255,255,255,.6);border-radius:999px;color:#fff;font-weight:700;text-decoration:none;font-size:.85rem}a.cantiere{display:block;text-decoration:none;color:inherit;background:#fff;border:1px solid var(--bordo);border-radius:12px;padding:14px 16px;margin-bottom:12px}a.cantiere:active{background:#e8f5ee}.riga{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.nome{font-weight:700;font-size:1.05rem;color:var(--accento)}.voce{background:#fff;border:1px solid var(--bordo);border-radius:10px;padding:10px 12px;margin-bottom:8px}a.link{display:inline-flex;align-items:center;min-height:40px;padding:0 14px;margin:8px 8px 0 0;border:1px solid var(--bordo);border-radius:8px;background:#F4F6F5;text-decoration:none;font-weight:600;font-size:.9rem;color:var(--accento)}a.indietro{display:inline-flex;align-items:center;min-height:44px;padding:0 12px 0 0;margin:-8px 0 4px;font-size:.95rem;color:var(--accento);text-decoration:none}.tbr{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}nav.schede{display:flex;gap:6px;overflow-x:auto;margin:0 -16px 14px;padding:10px 16px;background:#fff;border-bottom:1px solid var(--bordo);position:sticky;top:0;z-index:2;scrollbar-width:none}nav.schede label{flex-shrink:0;display:inline-flex;align-items:center;gap:6px;min-height:40px;padding:0 14px;margin:0;border-radius:999px;border:1px solid var(--bordo);background:#fff;color:#23302A;font-weight:600;font-size:.9rem;cursor:pointer;white-space:nowrap}.pann{display:none}#tb-g:checked~nav label[for=tb-g],#tb-r:checked~nav label[for=tb-r],#tb-d:checked~nav label[for=tb-d],#tb-f:checked~nav label[for=tb-f],#tb-p:checked~nav label[for=tb-p],#tb-x:checked~nav label[for=tb-x],#tb-s:checked~nav label[for=tb-s]{background:var(--accento);border-color:var(--accento);color:#fff}#tb-g:checked~#p-g,#tb-r:checked~#p-r,#tb-d:checked~#p-d,#tb-f:checked~#p-f,#tb-p:checked~#p-p,#tb-x:checked~#p-x,#tb-s:checked~#p-s{display:block}.totale{background:#052A21;color:#fff;border-radius:12px;padding:12px 14px;margin-bottom:10px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.totale .v{font-size:1.35rem;font-weight:700}.num{font-variant-numeric:tabular-nums;font-weight:700}.griglia{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.griglia a{display:block;position:relative}.griglia img{display:block;width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:8px;background:#DDE3E0}`;

const SCRIPT_PAGINA = `<script>(function(){try{var h=(location.hash||"").slice(1),e=h&&document.getElementById("tb-"+h);if(e)e.checked=true;var rs=document.querySelectorAll(".tbr");for(var i=0;i<rs.length;i++){rs[i].addEventListener("change",function(){history.replaceState(null,"","#"+this.id.slice(3));window.scrollTo(0,0);});}var a=document.querySelectorAll(".agg a");for(var j=0;j<a.length;j++){a[j].addEventListener("click",function(ev){var c=document.querySelector(".tbr:checked");if(c){ev.preventDefault();location.href=this.getAttribute("href")+"#"+c.id.slice(3);location.reload();}});}}catch(x){}})();</script>`;

function testa(titolo) {
  return `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${titolo}</title><style>${STILE}</style></head><body>`;
}

const CANTIERI = [
  ["Acqua Vera", CID], ["Fabbricato 3 Di Rorai", "5e460087-1e71-4a6e-a8dc-fedb4ad68d52"],
  ["Fabbricato 2 Di Rorai", "3a9aac00-f7b3-426e-98d4-0fb7d1633795"], ["Via Faggin 9", "9558d720-5355-4014-8377-658d0bfe83d7"],
  ["Vicolo Castelfidardo 24", "728ffb18-d06a-4797-81ab-c7969ca59150"]
];

export function elenco() {
  const schede = CANTIERI.map(([n, id]) =>
    `<a class="cantiere" href="?t=${TOKEN}&amp;c=${id}"><div class="riga"><div><div class="nome">${n}</div><div class="az">Brenta</div></div><div class="stato">Oggi niente</div></div><div class="cifre"><span><b>3</b> giornate</span></div></a>`).join("");
  return testa("Il Giornale Lavori - Tutte le aziende") +
    `<header><h1>Tutte le aziende</h1><p class="agg"><span>Aggiornato il 09/10/2026 21:41</span><a href="?t=${TOKEN}">Ricarica</a></p></header><main>` +
    schede + `<a class="cantiere" href="https://img.test/badge"><div class="riga"><div><div class="nome">Tesserini</div></div></div></a>` +
    `<div class="piede">Tocca un cantiere.</div></main></body></html>`;
}

export function cantiere() {
  const voci = (n) => Array.from({ length: n }, (_, i) => `<div class="voce"><div class="meta"><span class="ora">09:${10 + i}</span></div><div class="testo">Voce ${i + 1}</div></div>`).join("");
  const foto = Array.from({ length: 6 }, (_, i) => `<a href="https://img.test/${i}.jpg" target="_blank" aria-label="Foto delle 09:0${i}"><img src="https://img.test/${i}.jpg" alt=""><span>09:0${i}</span></a>`).join("");
  const ids = ["g", "r", "d", "f", "p", "x", "c", "s"];
  const radios = ids.map((k) => `<input type="radio" name="scheda" id="tb-${k}" class="tbr"${k === "g" ? " checked" : ""}>`).join("");
  const labels = `<label for="tb-g">Giornale <span class="cnt">10</span></label><label for="tb-r">Rapportini <span class="cnt">2</span></label><label for="tb-d">DDT <span class="cnt">0</span></label><label for="tb-f">Foto <span class="cnt">20</span></label><label for="tb-p">Presenze <span class="cnt">0</span></label><label for="tb-x">Documenti <span class="cnt">9</span></label><label for="tb-c">Cronoprogramma</label><label for="tb-s">SAL</label>`;
  return testa("Acqua Vera - Il Giornale Lavori") +
    `<header><h1>Acqua Vera</h1><p>Brenta Lavori srl &middot; San Giorgio in Bosco Padova</p><p class="agg"><span>Aggiornato il 09/10/2026 21:41</span><a href="?t=${TOKEN}&amp;c=${CID}">Ricarica</a></p></header>` +
    `<main><a class="indietro" href="?t=${TOKEN}">&larr; Tutti i cantieri</a>` + radios +
    `<nav class="schede" aria-label="Sezioni del cantiere">${labels}</nav>` +
    `<section class="pann" id="p-g" aria-label="Giornale">${voci(12)}</section>` +
    `<section class="pann" id="p-r" aria-label="Rapportini"><div class="totale"><div><div class="e">Ore in economia, mese corrente</div><div class="v num">16,50 h</div></div><div><div class="e">Totale cantiere</div><div class="v num">16,50 h</div></div></div>${voci(2)}</section>` +
    `<section class="pann" id="p-d" aria-label="DDT"><div class="vuoto">Nessun DDT.</div></section>` +
    `<section class="pann" id="p-f" aria-label="Foto"><div class="griglia">${foto}</div></section>` +
    `<section class="pann" id="p-p" aria-label="Presenze"><div class="vuoto">Nessuna timbratura.</div></section>` +
    `<section class="pann" id="p-x" aria-label="Documenti"><div class="scheda">Documenti</div></section>` +
    `<section class="pann" id="p-c" aria-label="Cronoprogramma"><style>#tb-c:checked~nav label[for=tb-c]{background:var(--accento);border-color:var(--accento);color:#fff}#tb-c:checked~#p-c{display:block}</style><div class="totale"><div><div class="e">Avanzamento lavori</div><div class="v num">0,1%</div></div></div></section>` +
    `<section class="pann" id="p-s" aria-label="SAL"><div class="vuoto">In preparazione.</div></section>` +
    `<div class="piede">Le voci nascono dai messaggi WhatsApp.</div></main>` + SCRIPT_PAGINA + `</body></html>`;
}
