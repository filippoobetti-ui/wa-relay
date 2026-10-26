// ============================================================================
// SCARICA IN EXCEL — area riservata (26/10/2026, richiesta di Filippo; NON pubblicato).
// Nella pagina di un cantiere c'è il pulsante «Scarica in Excel»: si sceglie cosa (ore in economia, DDT e forniture,
// presenze) e il periodo, e si scarica un file che Excel apre direttamente.
//   GET /esporta?t=<gettone>&c=<cantiere>&tipo=ore|ddt|presenze&dal=AAAA-MM-GG&al=AAAA-MM-GG → file .csv
// Il database decide tutto (RPC esporta_excel_cantiere): accesso, periodo (al massimo due anni), righe e nome del file.
// Il relay non conserva nulla. Si spegne con la variabile ESPORTA_EXCEL = "off".
// ============================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATA = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function errore(h, base, tok, c, testo, stato) {
  const torna = base + "/?t=" + tok + (UUID.test(c) ? "&c=" + c : "");
  return h.risposta(h.foglio(base, "Scarica in Excel", "File non preparato",
    "<p>" + h.esc(testo) + '</p><p><a href="' + h.esc(torna) + '">Torna al cantiere</a></p>'), stato || 200);
}

export async function portaleEsporta(request, env, base, inUrl, h) {
  if (env.ESPORTA_EXCEL === "off") return new Response("Not Found", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  if (!env.SUPABASE_SERVICE_KEY) {
    return new Response("Servizio non configurato.", { status: 503, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
  }
  const m = String(inUrl.searchParams.get("t") || "").match(/[0-9a-fA-F]{64}/);
  if (!m) return Response.redirect(inUrl.origin + base + "/", 303);
  const tok = m[0].toLowerCase();
  const c = String(inUrl.searchParams.get("c") || "").toLowerCase().replace(/[^0-9a-f-]/g, "").slice(0, 36);
  if (!UUID.test(c)) return Response.redirect(inUrl.origin + base + "/?t=" + tok, 303);
  const tipo = String(inUrl.searchParams.get("tipo") || "");
  if (["ore", "ddt", "presenze"].indexOf(tipo) === -1) return errore(h, base, tok, c, "Scegli cosa scaricare: ore in economia, DDT e forniture o presenze.", 400);
  const dal = DATA.test(inUrl.searchParams.get("dal") || "") ? inUrl.searchParams.get("dal") : "";
  const al = DATA.test(inUrl.searchParams.get("al") || "") ? inUrl.searchParams.get("al") : "";

  const r = await h.rpc(env, "esporta_excel_cantiere", { p_token: tok, p_commessa: c, p_tipo: tipo, p_dal: dal, p_al: al }, 20000).catch(() => null);
  if (!r) return errore(h, base, tok, c, "Il servizio non risponde in questo momento. Riprova tra qualche minuto.", 503);
  if (r.esito === "gettone") return Response.redirect(inUrl.origin + base + "/", 303);
  if (r.esito === "periodo") return errore(h, base, tok, c, "Controlla le date: la prima non può essere dopo la seconda, e si scaricano al massimo due anni per volta.", 400);
  if (r.esito !== "ok" || typeof r.csv !== "string") return errore(h, base, tok, c, "Non è stato possibile preparare il file per questo cantiere.", 400);

  const nome = String(r.nome_file || "TIX.csv");
  const ascii = nome.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "") || "TIX.csv";
  return new Response(request.method === "HEAD" ? null : "\uFEFF" + r.csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=UTF-8",
      "Content-Disposition": 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(nome),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

// Pulsante e finestra nella pagina del cantiere (dopo le schede).
export function esportaIniezione(base, token, commessa) {
  const cfg = JSON.stringify({ u: base + "/esporta", t: token, c: commessa });
  const stile = "<style>" +
    ".gl-xl-barra{max-width:960px;margin:10px auto 0;padding:0 12px;text-align:right}" +
    ".gl-xl-b{display:inline-flex;align-items:center;gap:8px;min-height:38px;padding:0 16px;border:1px solid #1D6F42;border-radius:10px;background:#E8F4EC;color:#1D6F42;font:inherit;font-size:.92rem;font-weight:700;cursor:pointer}" +
    ".gl-xl-b:hover,.gl-xl-b:focus-visible{background:#1D6F42;color:#fff;outline:none}" +
    ".gl-xl-ov{position:fixed;inset:0;z-index:9999;background:rgba(10,18,28,.55);display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}" +
    ".gl-xl-bx{background:#fff;color:#1b1f1d;border-radius:14px;max-width:440px;width:100%;padding:20px 20px 16px;box-shadow:0 10px 40px rgba(0,0,0,.35)}" +
    ".gl-xl-bx h3{margin:0 0 6px;font-size:1.1rem;color:#1B2F4A}.gl-xl-bx p{margin:0 0 12px;font-size:.88rem;color:#5b6560;line-height:1.45}" +
    ".gl-xl-bx label.op{display:flex;gap:10px;align-items:center;padding:9px 10px;border:1px solid #dfe5e2;border-radius:10px;margin:0 0 8px;cursor:pointer;font-size:.95rem}" +
    // il portale dà a tutte le etichette maiuscolo e colore, e a tutti i campi larghezza piena: qui si tolgono
    ".gl-xl-bx label{text-transform:none;letter-spacing:normal;color:inherit;font-weight:600;margin:0}" +
    ".gl-xl-bx label.op{margin:0 0 8px;justify-content:flex-start}.gl-xl-bx label.op input{width:auto;flex:none;margin:0;accent-color:#1D6F42}" +
    ".gl-xl-dt{display:flex;gap:10px;margin:6px 0 4px}.gl-xl-dt label{display:block;flex:1;font-size:.84rem;font-weight:600}" +
    ".gl-xl-dt input{display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:8px;border:1px solid #c9d1cd;border-radius:8px;font:inherit;background:#fff;color:#1b1f1d}" +
    ".gl-xl-az{display:flex;gap:10px;justify-content:flex-end;margin-top:14px}" +
    ".gl-xl-az button{padding:10px 16px;border-radius:10px;border:1px solid #c9d1cd;background:#fff;color:#1b1f1d;font:inherit;font-weight:600;cursor:pointer}" +
    ".gl-xl-az button.pr{background:#1D6F42;border-color:#1D6F42;color:#fff}" +
    "@media (prefers-color-scheme:dark){.gl-xl-bx{background:#1a201d;color:#eef2f0}.gl-xl-bx h3{color:#cfe0ff}.gl-xl-bx label.op{border-color:#3a4540}.gl-xl-dt input{background:#111513;color:#eef2f0;border-color:#3a4540}.gl-xl-az button{background:#232b27;color:#eef2f0;border-color:#3a4540}.gl-xl-b{background:#163322;color:#bfe8cf}}" +
    "</style>";
  const script = "<script>" + String.raw`(function(){try{
var CFG=` + cfg + String.raw`;
function d2(n){return (n<10?'0':'')+n;}
function iso(d){return d.getFullYear()+'-'+d2(d.getMonth()+1)+'-'+d2(d.getDate());}
function apri(){
  var oggi=new Date(),primo=new Date(oggi.getFullYear(),oggi.getMonth(),1);
  var ov=document.createElement('div');ov.className='gl-xl-ov';
  ov.innerHTML='<div class="gl-xl-bx" role="dialog" aria-modal="true" aria-label="Scarica in Excel"><h3>Scarica in Excel</h3>'+
    '<p>Un file per questo cantiere, da aprire con Excel o con un altro foglio di calcolo.</p>'+
    '<label class="op"><input type="radio" name="gl-xl-t" value="ore" checked> Ore in economia</label>'+
    '<label class="op"><input type="radio" name="gl-xl-t" value="ddt"> DDT e forniture</label>'+
    '<label class="op"><input type="radio" name="gl-xl-t" value="presenze"> Presenze e timbrature</label>'+
    '<div class="gl-xl-dt"><label>Dal<input type="date" id="gl-xl-dal" value="'+iso(primo)+'"></label><label>Al<input type="date" id="gl-xl-al" value="'+iso(oggi)+'"></label></div>'+
    '<div class="gl-xl-az"><button type="button" data-a="chiudi">Chiudi</button><button type="button" class="pr" data-a="scarica">Scarica</button></div></div>';
  ov.addEventListener('click',function(e){
    var a=e.target&&e.target.getAttribute&&e.target.getAttribute('data-a');
    if(e.target===ov||a==='chiudi'){ov.parentNode.removeChild(ov);return;}
    if(a==='scarica'){
      var t=ov.querySelector('input[name="gl-xl-t"]:checked');
      var u=CFG.u+'?t='+CFG.t+'&c='+encodeURIComponent(CFG.c)+'&tipo='+(t?t.value:'ore')+
        '&dal='+encodeURIComponent(ov.querySelector('#gl-xl-dal').value||'')+'&al='+encodeURIComponent(ov.querySelector('#gl-xl-al').value||'');
      window.location.href=u;
    }
  });
  document.body.appendChild(ov);
}
var barra=document.createElement('div');barra.className='gl-xl-barra';
barra.innerHTML='<button type="button" class="gl-xl-b">&#128202; Scarica in Excel</button>';
barra.firstChild.addEventListener('click',apri);
var nav=document.querySelector('nav.schede');
if(nav&&nav.parentNode){nav.parentNode.insertBefore(barra,nav.nextSibling);}else{document.body.insertBefore(barra,document.body.firstChild);}
}catch(e){}})();` + "</script>";
  return stile + script;
}
