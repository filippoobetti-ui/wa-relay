// ---------------------------------------------------------------------------
// Importa DDT da Excel (13/11/2026, ddt-excel-1, chat 02). Richiesta di Filippo: a fine mese la segreteria dell'appaltante
// manda il riepilogo dei DDT in Excel; i DDT che non sono arrivati da WhatsApp si caricano da qui.
// - Nella scheda DDT del cantiere: pulsante «Importa DDT da Excel» → finestra: il file (.xlsx, .xls, .csv, .ods) si legge nel
//   browser (SheetJS da cdnjs, come la Rubrica e i subappaltatori), TIX propone le colonne, si controllano le righe
//   (nuovi / già presenti / da controllare), si conferma. Il database fa tutto il resto (ddt_excel).
//   POST {base}/ddt/excel  { t, c, azione: "analizza" | "salva" | "annulla" | "elenco", dati }
// - Sulle schede dei DDT arrivati da Excel compare il segno «da Excel».
// Interruttore nel database: impostazioni.ddt_excel_attivo (no / prova / si); DDT_EXCEL = "off" toglie tutto.
// ---------------------------------------------------------------------------

// 14/11/2026 (campi-rossi, regola di Filippo per tutti i moduli): i campi che mancano si segnano in rosso (src/campi-rossi.js).
import { CAMPI_ROSSI_CSS, CAMPI_ROSSI_JS } from "./campi-rossi.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonRisposta(oggetto, stato) {
  return new Response(JSON.stringify(oggetto), {
    status: stato || 200,
    headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" }
  });
}

export async function ddtExcelPulsante(env, h, token, commessa) {
  try {
    const r = await h.rpc(env, "ddt_excel", { p_token: token, p_commessa: commessa, p_azione: "stato", p_dati: {} }, 6000);
    return r && r.esito === "ok" && r.attiva === true ? r : null;
  } catch (e) { return null; }
}

export async function portaleDdtExcel(request, env, h) {
  if (env.DDT_EXCEL === "off") return new Response("Not Found", { status: 404 });
  if (!env.SUPABASE_SERVICE_KEY) return jsonRisposta({ esito: "non_configurato" }, 503);
  if (request.method !== "POST") return jsonRisposta({ esito: "metodo_non_consentito" }, 405);
  if (!/^application\/json\b/i.test(request.headers.get("Content-Type") || "")) return jsonRisposta({ esito: "errore" }, 415);
  let b;
  try { const t = await request.text(); if (t.length > 600000) return jsonRisposta({ esito: "errore", messaggio: "File troppo grande: dividilo." }, 413); b = JSON.parse(t); } catch (e) { b = null; }
  if (!b || typeof b !== "object") return jsonRisposta({ esito: "richiesta_non_valida" }, 400);
  const t = String(b.t || "").toLowerCase();
  const c = String(b.c || "").toLowerCase();
  const azione = String(b.azione || "");
  if (!/^[0-9a-f]{64}$/.test(t)) return jsonRisposta({ esito: "gettone" }, 403);
  if (!UUID.test(c) || ["analizza", "salva", "annulla", "elenco"].indexOf(azione) === -1) return jsonRisposta({ esito: "richiesta_non_valida" }, 400);
  const d = b.dati && typeof b.dati === "object" ? b.dati : {};
  const s = (v, n) => String(v == null ? "" : v).slice(0, n);
  let dati = {};
  if (azione === "annulla") dati = { id: s(d.id, 15), autore: s(d.autore, 120) };
  if (azione === "analizza" || azione === "salva") {
    const righe = Array.isArray(d.righe) ? d.righe.slice(0, 500).map((x, i) => ({
      n: Number.isFinite(Number(x && x.n)) ? Math.trunc(Number(x.n)) : i + 1,
      cantiere: s(x && x.cantiere, 200), commessa_id: UUID.test(s(x && x.commessa_id, 40)) ? s(x.commessa_id, 40) : "",
      fornitore: s(x && x.fornitore, 160), numero: s(x && x.numero, 60), data: s(x && x.data, 30),
      materiale: s(x && x.materiale, 1000), quantita: s(x && x.quantita, 120), riferimento: s(x && x.riferimento, 200) })) : [];
    dati = { righe };
    if (azione === "salva") { dati.autore = s(d.autore, 120); dati.nome_file = s(d.nome_file, 200); dati.sha256 = /^[0-9a-f]{64}$/.test(s(d.sha256, 64)) ? s(d.sha256, 64) : ""; }
  }
  const r = await h.rpc(env, "ddt_excel", { p_token: t, p_commessa: c, p_azione: azione, p_dati: dati }, 30000).catch(() => null);
  if (r === null || typeof r !== "object") return jsonRisposta({ esito: "incerto" }, 502);
  return jsonRisposta(r, r.esito === "gettone" ? 403 : 200);
}

export function ddtExcelIniezione(base, token, commessa) {
  const cfg = JSON.stringify({ u: base + "/ddt/excel", t: token, c: commessa });
  const stile = "<style>" + CAMPI_ROSSI_CSS +
    ".gl-dx-b{display:flex;width:100%;align-items:center;justify-content:center;gap:8px;min-height:46px;margin:0 0 12px;border:1px solid #1B2F4A;border-radius:12px;background:#fff;color:#1B2F4A;font:inherit;font-weight:700;font-size:1rem;cursor:pointer;letter-spacing:normal;text-transform:none;box-shadow:none}" +
    ".gl-dx-b:hover,.gl-dx-b:focus-visible{background:#1B2F4A;color:#fff;outline:none}" +
    ".gl-dx-seg{display:inline-block;margin-left:6px;padding:1px 8px;border-radius:999px;background:#EEF3F9;color:#1B2F4A;font-size:.75rem;font-weight:700;vertical-align:middle}" +
    ".gl-dx-ov{position:fixed;inset:0;z-index:9999;background:rgba(10,18,28,.55);display:flex;align-items:center;justify-content:center;padding:12px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}" +
    ".gl-dx-bx{background:#fff;color:#1b1f1d;border-radius:14px;max-width:720px;width:100%;max-height:92vh;overflow:auto;padding:18px 18px 14px;box-shadow:0 10px 40px rgba(0,0,0,.35)}" +
    ".gl-dx-bx h3{margin:0 0 6px;font-size:1.15rem;color:#1B2F4A}.gl-dx-bx h4{margin:16px 0 6px;font-size:.95rem;color:#1B2F4A}" +
    ".gl-dx-bx p{margin:0 0 8px;font-size:.9rem;line-height:1.45}.gl-dx-nota{font-size:.84rem;color:#5b6560}" +
    ".gl-dx-bx input[type=text],.gl-dx-bx select{display:block;width:100%;box-sizing:border-box;padding:8px 9px;border:1px solid #c9d1cd;border-radius:8px;font:inherit;font-size:.95rem;background:#fff;color:#1b1f1d}" +
    ".gl-dx-bx input[type=file]{display:block;width:100%;margin:6px 0 4px}" +
    ".gl-dx-map{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px 12px}.gl-dx-map label{display:block;font-size:.82rem;font-weight:700;margin:0 0 3px}" +
    ".gl-dx-map .inc select{border-color:#E8B04A;background:#FFF8EA}.gl-dx-map .inc label::after{content:' · da controllare';color:#8A5300;font-weight:600}" +
    ".gl-dx-tab{width:100%;border-collapse:collapse;font-size:.84rem}.gl-dx-tab th,.gl-dx-tab td{text-align:left;padding:5px 6px;border-bottom:1px solid #EEF0F3;vertical-align:top}" +
    ".gl-dx-tab th{color:#5b6560;font-weight:700}.gl-dx-tab td.m{color:#8A5300}.gl-dx-wrap{max-height:240px;overflow:auto;border:1px solid #D9DEE5;border-radius:10px}" +
    ".gl-dx-chips{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0}.gl-dx-chips span{border-radius:999px;padding:4px 12px;font-size:.86rem;font-weight:700}" +
    ".gl-dx-chips .n{background:#E3F3EA;color:#0A7D48}.gl-dx-chips .p{background:#EEF3F9;color:#1B2F4A}.gl-dx-chips .c{background:#FFF4E0;color:#8A5300}" +
    ".gl-dx-err{color:#a11;font-size:.9rem;margin:10px 0 0}.gl-dx-ok{background:#E3F3EA;border-left:4px solid #0A7D48;border-radius:8px;padding:8px 10px;font-size:.9rem;margin:10px 0 0}" +
    ".gl-dx-az{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:14px}" +
    ".gl-dx-az button,.gl-dx-st button{width:auto;padding:9px 14px;border-radius:10px;border:1px solid #c9d1cd;background:#fff;color:#1b1f1d;font:inherit;font-weight:700;cursor:pointer;box-shadow:none}" +
    ".gl-dx-az button.pr{background:#F26A10;border-color:#F26A10;color:#1B2F4A}.gl-dx-az button[disabled]{opacity:.55;cursor:wait}" +
    ".gl-dx-st{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;border:1px solid #D9DEE5;border-radius:10px;padding:7px 10px;margin:0 0 6px;font-size:.86rem}" +
    ".gl-dx-st button{padding:4px 10px;border-color:#c62828;color:#c62828;background:#fdecec;font-size:.8rem}" +
    "@media (prefers-color-scheme:dark){.gl-dx-b{background:#1a201d;color:#eef2f0;border-color:#5b6b80}.gl-dx-bx{background:#1a201d;color:#eef2f0}.gl-dx-bx h3,.gl-dx-bx h4{color:#cfe0ff}" +
    ".gl-dx-bx input[type=text],.gl-dx-bx select{background:#111513;color:#eef2f0;border-color:#3a4540}.gl-dx-az button{background:#232b27;color:#eef2f0;border-color:#3a4540}.gl-dx-seg{background:#232b27;color:#cfe0ff}}" +
    "</style>";
  // 13/11/2026 (ddt-excel-2, dopo la prima prova di Filippo su Aqua Vera): i riepiloghi veri spesso non hanno la colonna del
  // fornitore (il file è tutto di un fornitore) e scrivono il cantiere come indirizzo. Ora: più nomi di colonna riconosciuti; se
  // numero e data si trovano, niente schermata delle colonne; se manca il fornitore lo si chiede una volta sola per tutto il file
  // (proposto dal titolo del file o del foglio); i cantieri non riconosciuti vanno nel cantiere della pagina, cambiabile per gruppo.
  const script = "<script>if(!window.crControlla){" + CAMPI_ROSSI_JS + "\nwindow.crControlla=crControlla;window.crSegna=crSegna;window.crPulisci=crPulisci;}</script>" +
    "<script>(function(){try{\nvar CFG=" + cfg + ";\n" +
    "var XLSXURL='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';\n" +
    "function el(t,c,h){var e=document.createElement(t);if(c)e.className=c;if(h!=null)e.innerHTML=h;return e;}\n" +
    "function esc(s){return String(s==null?'':s).replace(/[&<>\"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c];});}\n" +
    "function post(azione,dati){return fetch(CFG.u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,c:CFG.c,azione:azione,dati:dati||{}})}).then(function(r){return r.json();});}\n" +
    "function lib(){return window.XLSX?Promise.resolve():new Promise(function(ok,ko){var s=document.createElement('script');s.src=XLSXURL;s.onload=ok;s.onerror=function(){ko(new Error('lib'));};document.head.appendChild(s);});}\n" +
    "function norm(s){return String(s==null?'':s).toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();}\n" +
    "var CAMPI=[{k:'fornitore',n:'Fornitore',o:1,p:['fornitore','fornitori','ditta fornitrice','ragione sociale','mittente','emittente','cedente','ditta','azienda','societa','denominazione','nominativo','produttore']},\n" +
    " {k:'numero',n:'Numero del DDT',o:1,p:['numero ddt','n ddt','nr ddt','ddt n','num ddt','n ro ddt','numero documento','n documento','nr documento','n doc','nr doc','doc n','num doc','numero doc','numero bolla','n bolla','nr bolla','bolla n','ddt','documento','doc','bolla','rif ddt','d d t','numero','num','nr','n ro','n']},\n" +
    " {k:'data',n:'Data del DDT',o:1,p:['data ddt','data documento','data doc','data bolla','data consegna','data trasporto','data']},\n" +
    " {k:'materiale',n:'Materiale',p:['materiale','materiali','descrizione','descrizione materiale','descrizione merce','descrizione articolo','articolo','merce','prodotto','tipo materiale','descr']},\n" +
    " {k:'quantita',n:'Quantità',p:['quantita','qta','q ta','qt','quantitativo','peso','peso netto','tonnellate','metri cubi']},\n" +
    " {k:'um',n:'Unità di misura',p:['u m','um','unita di misura','unita','misura']},\n" +
    " {k:'cantiere',n:'Cantiere',p:['cantiere','commessa','cantiere di destinazione','destinazione','luogo di destinazione','luogo','indirizzo','destinazione merce']},\n" +
    " {k:'riferimento',n:'Riferimento ordine',p:['ordine','rif ordine','riferimento ordine','n ordine','nr ordine','riferimento']}];\n" +
    "function punteggio(h,c){var x=norm(h);if(!x)return 0;for(var i=0;i<c.p.length;i++){if(x===c.p[i])return 200-i;}for(var j=0;j<c.p.length;j++){if(c.p[j].length>2&&(' '+x+' ').indexOf(' '+c.p[j]+' ')!==-1)return 100-j;}return 0;}\n" +
    // una colonna va a un solo campo: prima i campi con il punteggio più alto
    "function testa(rows){var best=null;for(var r=0;r<Math.min(rows.length,25);r++){var h=rows[r]||[],cand=[];CAMPI.forEach(function(c){h.forEach(function(v,i){var p=punteggio(v,c);if(p>0)cand.push({k:c.k,i:i,p:p,o:c.o});});});cand.sort(function(a,b){return b.p-a.p;});\n" +
    " var m={},usate={},tot=0;cand.forEach(function(x){if(m[x.k]!=null||usate[x.i])return;m[x.k]=x.i;usate[x.i]=1;tot+=x.o?2:1;});if(tot>=3&&(!best||tot>best.tot))best={r:r,m:m,tot:tot};}return best;}\n" +
    "function giorno(v){if(v instanceof Date&&!isNaN(v))return v.getFullYear()+'-'+('0'+(v.getMonth()+1)).slice(-2)+'-'+('0'+v.getDate()).slice(-2);if(typeof v==='number'&&v>20000&&v<80000){var d=new Date(Math.round((v-25569)*86400000));return d.getUTCFullYear()+'-'+('0'+(d.getUTCMonth()+1)).slice(-2)+'-'+('0'+d.getUTCDate()).slice(-2);}var s=String(v==null?'':v).trim();if(/^\\d{5}$/.test(s)){return giorno(+s);}return s;}\n" +
    "function testo(v){return v instanceof Date?giorno(v):String(v==null?'':v).trim();}\n" +
    "function hex(buf){return crypto.subtle.digest('SHA-256',buf).then(function(h){return Array.from(new Uint8Array(h)).map(function(b){return('0'+b.toString(16)).slice(-2);}).join('');});}\n" +
    // il fornitore proposto: una scritta sopra le intestazioni, oppure il nome del foglio (mai «Foglio1»)
    "function indovinaForn(rows,r,foglio){for(var i=0;i<r;i++){var c=(rows[i]||[]).map(testo).filter(function(x){return x&&!/riepilog|ddt|document|bolle|elenco|periodo|^\\d/i.test(x);});if(c.length)return c[0].slice(0,120);}return /^(foglio|sheet)\\s*\\d*$/i.test(foglio||'')?'':String(foglio||'').slice(0,120);}\n" +
    "var P=document.getElementById('p-d');if(!P)return;\n" +
    "P.querySelectorAll('.scheda[data-mid^=\"excel:\"] .r .t').forEach(function(t){if(!t.querySelector('.gl-dx-seg'))t.appendChild(el('span','gl-dx-seg','da Excel'));});\n" +
    "if(P.querySelector('.gl-dx-b'))return;\n" +
    "var B=el('button','gl-dx-b','&#128229; Importa DDT da Excel');B.type='button';P.insertBefore(B,P.firstChild);B.addEventListener('click',apri);\n" +
    "function apri(){var ov=el('div','gl-dx-ov'),bx=el('div','gl-dx-bx');ov.appendChild(bx);document.body.appendChild(ov);var F=null;\n" +
    " function chiudi(ricarica){if(ov.parentNode)ov.parentNode.removeChild(ov);document.removeEventListener('keydown',tasto);if(ricarica)location.reload();}\n" +
    " function tasto(e){if(e.key==='Escape')chiudi(false);}document.addEventListener('keydown',tasto);\n" +
    " function attesa(t){bx.innerHTML='<h3>Importa DDT da Excel</h3><p class=\"gl-dx-nota\">'+esc(t)+'</p>';}\n" +
    " function passo1(msg){bx.innerHTML='<h3>Importa DDT da Excel</h3><p>Carica il riepilogo dei DDT così com’è: Excel (.xlsx, .xls), .csv o .ods. TIX riconosce da solo le colonne; prima di salvare vedi tutte le righe.</p>'+\n" +
    "  '<input type=\"file\" id=\"gl-dx-f\" accept=\".xlsx,.xls,.csv,.ods\"><div id=\"gl-dx-es\">'+(msg?'<p class=\"gl-dx-err\">'+esc(msg)+'</p>':'')+'</div><h4>Importazioni recenti</h4><div id=\"gl-dx-el\"><p class=\"gl-dx-nota\">Carico…</p></div><div class=\"gl-dx-az\"><button type=\"button\" id=\"gl-dx-no\">Chiudi</button></div>';\n" +
    "  bx.querySelector('#gl-dx-no').onclick=function(){chiudi(false);};elenco();\n" +
    "  bx.querySelector('#gl-dx-f').onchange=function(){var f=this.files&&this.files[0];if(!f)return;if(f.size>15*1024*1024){passo1('Il file è troppo grande: massimo 15 MB.');return;}\n" +
    "   attesa('Leggo il file…');\n" +
    "   Promise.all([lib(),f.arrayBuffer()]).then(function(x){var buf=x[1],wb=window.XLSX.read(buf,{type:'array',cellDates:true}),best=null;\n" +
    "    wb.SheetNames.forEach(function(nm){var rows=window.XLSX.utils.sheet_to_json(wb.Sheets[nm],{header:1,raw:true,defval:''}),t=testa(rows);if(t&&(!best||t.tot>best.t.tot))best={t:t,rows:rows,foglio:nm};});\n" +
    "    if(!best){passo1('Non trovo le intestazioni delle colonne (numero e data del DDT): controlla che il file abbia una riga di titoli.');return;}\n" +
    "    return hex(buf).then(function(sha){F={nome:f.name,sha:sha,rows:best.rows,t:best.t,m:best.t.m,foglio:best.foglio,forn:'',gruppi:{},auto:{},\n" +
    "      prop:indovinaForn(best.rows,best.t.r,best.foglio)};avvia();});\n" +
    "   }).catch(function(){passo1('Non riesco a leggere il file: prova a salvarlo di nuovo in Excel (.xlsx).');});};}\n" +
    " function avvia(){if(F.m.numero==null||F.m.data==null){passo2();return;}if(F.m.fornitore==null&&!F.forn){passoForn();return;}controlla();}\n" +
    " function passoForn(){bx.innerHTML='<h3>Importa DDT da Excel</h3><p><b>'+esc(F.nome)+'</b></p><p>Nel file non c’è la colonna del fornitore: di solito vuol dire che tutti i DDT sono dello stesso fornitore. <b>Di quale fornitore sono?</b></p>'+\n" +
    "   '<input type=\"text\" id=\"gl-dx-fo\" maxlength=\"160\" placeholder=\"Nome del fornitore\" value=\"'+esc(F.prop)+'\"><div id=\"gl-dx-es\"></div>'+\n" +
    "   '<div class=\"gl-dx-az\"><button type=\"button\" id=\"gl-dx-col\">Scegli le colonne a mano</button><button type=\"button\" class=\"pr\" id=\"gl-dx-av\">Avanti</button></div>';\n" +
    "  var i=bx.querySelector('#gl-dx-fo');i.focus();i.addEventListener('keydown',function(e){if(e.key==='Enter')bx.querySelector('#gl-dx-av').click();});\n" +
    "  bx.querySelector('#gl-dx-col').onclick=passo2;\n" +
    "  bx.querySelector('#gl-dx-av').onclick=function(){var v=i.value.trim();if(!window.crControlla([{el:i,testo:'Scrivi il nome del fornitore'}]))return;F.forn=v;controlla();};}\n" +
    " function elenco(){post('elenco').then(function(r){var c=bx.querySelector('#gl-dx-el');if(!c)return;var l=r&&r.importazioni||[];if(!l.length){c.innerHTML='<p class=\"gl-dx-nota\">Nessuna importazione per ora.</p>';return;}\n" +
    "  c.innerHTML=l.map(function(z){return '<div class=\"gl-dx-st\"><span><b>'+esc(z.nome_file||'file')+'</b> &middot; '+z.nuovi+' DDT &middot; '+esc(z.il)+(z.autore?' &middot; '+esc(z.autore):'')+(z.annullata?' &middot; <i>annullata</i>':'')+'</span>'+(z.annullabile?'<button type=\"button\" data-a=\"'+z.id+'\">Annulla</button>':'')+'</div>';}).join('');\n" +
    "  c.querySelectorAll('button[data-a]').forEach(function(b){b.onclick=function(){if(!confirm('Annullo questa importazione? I DDT ancora senza foto spariscono dal registro; le aggiunte al diario restano registrate.'))return;b.disabled=true;post('annulla',{id:b.getAttribute('data-a')}).then(function(r){if(r&&r.esito==='ok'){alert('Tolti '+r.tolti+' DDT.');chiudi(true);}else{b.disabled=false;alert(r&&r.messaggio?r.messaggio:'Non riuscito: riprova.');}});};});}).catch(function(){});}\n" +
    " function passo2(){var h=F.rows[F.t.r]||[],opz='<option value=\"-1\">(nessuna colonna)</option>'+h.map(function(v,i){return '<option value=\"'+i+'\">'+esc(String(testo(v)||'colonna '+(i+1)))+'</option>';}).join('');\n" +
    "  bx.innerHTML='<h3>Importa DDT da Excel</h3><p><b>'+esc(F.nome)+'</b> &middot; foglio «'+esc(F.foglio)+'»</p><h4>Le colonne</h4><p class=\"gl-dx-nota\">Servono almeno numero e data del DDT. Se il file non ha la colonna del fornitore, scrivilo qui sotto.</p><div class=\"gl-dx-map\">'+\n" +
    "   CAMPI.map(function(c){var i=F.m[c.k];return '<div class=\"'+(i==null&&c.o?'inc':'')+'\"><label for=\"gl-dx-c-'+c.k+'\">'+c.n+(c.o&&c.k!=='fornitore'?' *':'')+'</label><select id=\"gl-dx-c-'+c.k+'\">'+opz+'</select></div>';}).join('')+'</div>'+\n" +
    "   '<label class=\"gl-dx-nota\" for=\"gl-dx-fo2\" style=\"display:block;margin-top:10px\">Fornitore di tutte le righe (se non c’è la colonna)</label><input type=\"text\" id=\"gl-dx-fo2\" maxlength=\"160\" value=\"'+esc(F.forn||F.prop)+'\">'+\n" +
    "   '<div id=\"gl-dx-es\"></div><div class=\"gl-dx-az\"><button type=\"button\" id=\"gl-dx-ind\">Cambia file</button><button type=\"button\" class=\"pr\" id=\"gl-dx-va\">Controlla le righe</button></div>';\n" +
    "  CAMPI.forEach(function(c){var s=bx.querySelector('#gl-dx-c-'+c.k);s.value=String(F.m[c.k]==null?-1:F.m[c.k]);s.onchange=function(){s.parentNode.className='';};});\n" +
    "  bx.querySelector('#gl-dx-ind').onclick=function(){passo1('');};\n" +
    "  bx.querySelector('#gl-dx-va').onclick=function(){var m={};CAMPI.forEach(function(c){var v=+bx.querySelector('#gl-dx-c-'+c.k).value;if(v>=0)m[c.k]=v;});var fo=bx.querySelector('#gl-dx-fo2').value.trim(),es=bx.querySelector('#gl-dx-es');\n" +
    "   if(!window.crControlla([{el:bx.querySelector('#gl-dx-c-numero'),ok:function(){return m.numero!=null;},testo:'Scegli la colonna del numero del DDT'},\n" +
    "     {el:bx.querySelector('#gl-dx-c-data'),ok:function(){return m.data!=null;},testo:'Scegli la colonna della data del DDT'},\n" +
    "     {el:bx.querySelector('#gl-dx-fo2'),ok:function(){return m.fornitore!=null||!!fo;},testo:'Scegli la colonna del fornitore oppure scrivi qui il fornitore di tutte le righe'}]))return;\n" +
    "   F.m=m;F.forn=m.fornitore==null?fo:'';F.gruppi={};F.auto={};controlla();};}\n" +
    " function righe(){var m=F.m,out=[];F.rows.forEach(function(r,i){if(i<=F.t.r||!r||!r.some(function(v){return String(v).trim()!=='';}))return;var g=function(k){return m[k]!=null?r[m[k]]:'';};\n" +
    "   var o={n:i+1,fornitore:m.fornitore!=null?testo(g('fornitore')):F.forn,numero:testo(g('numero')),data:giorno(g('data')),materiale:testo(g('materiale')),\n" +
    "     quantita:(testo(g('quantita'))+(testo(g('um'))?' '+testo(g('um')):'')).trim(),cantiere:testo(g('cantiere')),riferimento:testo(g('riferimento'))};\n" +
    "   if(!o.numero&&!o.data&&!o.materiale)return;if(F.gruppi[o.cantiere])o.commessa_id=F.gruppi[o.cantiere];out.push(o);});return out;}\n" +
    " function controlla(){var rr=righe();if(!rr.length){passo1('Nel file non ci sono righe con numero o data del DDT.');return;}if(rr.length>500){passo1('Il file ha '+rr.length+' righe: al massimo 500 per volta. Dividilo.');return;}\n" +
    "  attesa('Controllo '+rr.length+' righe…');\n" +
    "  post('analizza',{righe:rr}).then(function(r){if(!r||r.esito!=='ok'){passo1(r&&r.messaggio?r.messaggio:'Il controllo non è riuscito: riprova tra un minuto.');return;}\n" +
    // cantieri non riconosciuti: la prima volta vanno nel cantiere della pagina (si possono cambiare, per gruppo)
    "   var per={};rr.forEach(function(x){per[x.n]=x;});var nuovi=0;r.righe.forEach(function(e){if(e.stato==='controllare'&&/cantiere/.test(e.motivo||'')){var t=(per[e.n]||{}).cantiere||'';if(t&&!F.gruppi[t]&&!F.auto[t]){F.gruppi[t]=CFG.c;F.auto[t]=1;nuovi++;}}});\n" +
    "   if(nuovi){controlla();return;}passo3(rr,r);}).catch(function(){passo1('Connessione assente: riprova.');});}\n" +
    " function passo3(rr,R){var per={};rr.forEach(function(x){per[x.n]=x;});var nu=[],pr=[],co=[];R.righe.forEach(function(e){(e.stato==='nuovo'?nu:e.stato==='presente'?pr:co).push(e);});\n" +
    "  var cant=R.cantieri||[],opz=function(sel){return cant.map(function(c){return '<option value=\"'+esc(c.id)+'\"'+(c.id===sel?' selected':'')+'>'+esc(c.nome)+'</option>';}).join('');};\n" +
    "  var gr=Object.keys(F.gruppi).map(function(t){var n=rr.filter(function(x){return x.cantiere===t;}).length;return '<div class=\"gl-dx-st\"><span>Nel file «'+esc(t)+'» ('+n+(n===1?' riga':' righe')+')</span><select data-g=\"'+esc(t)+'\" style=\"width:auto;max-width:100%\">'+opz(F.gruppi[t])+'</select></div>';}).join('');\n" +
    "  function rigaT(e,extra){var x=per[e.n]||{};return '<tr><td>'+e.n+'</td><td>'+esc(x.fornitore)+'</td><td>'+esc(x.numero)+'</td><td>'+esc(e.data?e.data.split('-').reverse().join('/'):x.data)+'</td><td>'+esc(x.materiale)+(x.quantita?' &middot; '+esc(x.quantita):'')+'</td><td>'+esc(e.cantiere||'')+'</td>'+(extra||'')+'</tr>';}\n" +
    "  var th='<tr><th>Riga</th><th>Fornitore</th><th>N.</th><th>Data</th><th>Materiale</th><th>Cantiere</th>';\n" +
    "  bx.innerHTML='<h3>Importa DDT da Excel</h3><p class=\"gl-dx-nota\" style=\"margin:0\">'+esc(F.nome)+(F.forn?' &middot; fornitore: <b>'+esc(F.forn)+'</b>':'')+'</p><div class=\"gl-dx-chips\"><span class=\"n\">'+nu.length+' nuovi</span><span class=\"p\">'+pr.length+' già presenti</span><span class=\"c\">'+co.length+' da controllare</span></div>'+\n" +
    "   (gr?'<h4>Cantiere</h4><p class=\"gl-dx-nota\">Nel file il cantiere è scritto così: TIX l’ha messo nel cantiere qui sotto. Cambialo se serve.</p>'+gr:'')+\n" +
    "   (nu.length?'<h4>Nuovi: si caricano</h4><div class=\"gl-dx-wrap\"><table class=\"gl-dx-tab\">'+th+'<th></th></tr>'+nu.map(function(e){return rigaT(e,'<td><input type=\"checkbox\" data-n=\"'+e.n+'\" checked aria-label=\"Carica la riga '+e.n+'\"></td>');}).join('')+'</table></div>':'')+\n" +
    "   (co.length?'<h4>Da controllare: non si caricano</h4><p class=\"gl-dx-nota\">Vanno corrette nel file, poi si ricarica: le righe già caricate non si doppiano.</p><div class=\"gl-dx-wrap\"><table class=\"gl-dx-tab\">'+th+'<th>Perché</th></tr>'+co.map(function(e){return rigaT(e,'<td class=\"m\">'+esc(e.motivo||'')+'</td>');}).join('')+'</table></div>':'')+\n" +
    "   (pr.length?'<h4>Già presenti: non si caricano due volte</h4><div class=\"gl-dx-wrap\"><table class=\"gl-dx-tab\">'+th+'<th>Perché</th></tr>'+pr.map(function(e){return rigaT(e,'<td class=\"m\">'+esc(e.motivo||'')+'</td>');}).join('')+'</table></div>':'')+\n" +
    "   '<h4>Chi fa l’importazione</h4><input type=\"text\" id=\"gl-dx-aut\" placeholder=\"Nome e cognome\" maxlength=\"120\" autocomplete=\"name\">'+\n" +
    "   '<p class=\"gl-dx-nota\" style=\"margin-top:8px\">I DDT entrano nel registro del loro cantiere con il segno «da Excel», senza foto: se la foto della bolla arriva dopo da WhatsApp, si aggancia da sola. Nei giorni già chiusi il diario non cambia: il DDT va nell’«Integrazione al diario» di quel giorno.</p>'+\n" +
    "   '<div id=\"gl-dx-es\"></div><div class=\"gl-dx-az\"><button type=\"button\" id=\"gl-dx-col\">Cambia le colonne</button><button type=\"button\" class=\"pr\" id=\"gl-dx-si\">Conferma e salva</button></div>';\n" +
    "  bx.querySelectorAll('select[data-g]').forEach(function(s){s.onchange=function(){F.gruppi[s.getAttribute('data-g')]=s.value;controlla();};});\n" +
    "  bx.querySelector('#gl-dx-col').onclick=passo2;\n" +
    "  bx.querySelector('#gl-dx-si').onclick=function(){var es=bx.querySelector('#gl-dx-es'),aut=bx.querySelector('#gl-dx-aut').value.trim();es.innerHTML='';\n" +
    "   var nsel=bx.querySelectorAll('input[data-n]:checked').length;\n" +
    "   if(!window.crControlla([{el:bx.querySelector('input[data-n]')?bx.querySelector('input[data-n]').closest('.gl-dx-wrap'):bx.querySelector('.gl-dx-chips'),ok:function(){return nsel>0;},testo:'Non c’è nessuna riga da caricare: spunta almeno un DDT nuovo'},\n" +
    "     {el:bx.querySelector('#gl-dx-aut'),testo:'Scrivi chi fa l’importazione (nome e cognome)'}]))return;\n" +
    "   var scelte=[];bx.querySelectorAll('input[data-n]:checked').forEach(function(i){var x=per[+i.getAttribute('data-n')];if(x)scelte.push(x);});\n" +
    "   if(!scelte.length){es.innerHTML='<p class=\"gl-dx-err\">Non c’è nessuna riga da caricare.</p>';return;}\n" +
    "   var bt=this;bt.disabled=true;bt.textContent='Salvo…';post('salva',{righe:scelte,autore:aut,nome_file:F.nome,sha256:F.sha}).then(function(r){\n" +
    "    if(!r||r.esito!=='ok'){bt.disabled=false;bt.textContent='Conferma e salva';es.innerHTML='<p class=\"gl-dx-err\">'+esc(r&&r.messaggio?r.messaggio:'Il salvataggio non è riuscito: riprova tra un minuto.')+'</p>';return;}\n" +
    "    bx.innerHTML='<h3>Importa DDT da Excel</h3><div class=\"gl-dx-ok\">Salvati <b>'+r.nuovi+'</b> DDT'+(r.saltati?' ('+r.saltati+' saltati perché già presenti)':'')+'.'+(r.giorni_diario?' '+r.giorni_diario+(r.giorni_diario===1?' giorno già chiuso ha':' giorni già chiusi hanno')+' ora l’Integrazione al diario.':'')+'</div>'+\n" +
    "     '<p class=\"gl-dx-nota\" style=\"margin-top:8px\">Se hai sbagliato file, entro 24 ore puoi annullare dall’elenco «Importazioni recenti».</p><div class=\"gl-dx-az\"><button type=\"button\" class=\"pr\" id=\"gl-dx-fine\">Chiudi e aggiorna</button></div>';\n" +
    "    bx.querySelector('#gl-dx-fine').onclick=function(){chiudi(true);};}).catch(function(){bt.disabled=false;bt.textContent='Conferma e salva';es.innerHTML='<p class=\"gl-dx-err\">Connessione assente: riprova.</p>';});};}\n" +
    " passo1('');}\n" +
    "}catch(e){}})();</script>";
  return stile + script;
}
