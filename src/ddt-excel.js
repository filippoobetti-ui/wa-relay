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
  const stile = "<style>" +
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
  const script = "<script>(function(){try{\nvar CFG=" + cfg + ";\n" +
    "var XLSXURL='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';\n" +
    "function el(t,c,h){var e=document.createElement(t);if(c)e.className=c;if(h!=null)e.innerHTML=h;return e;}\n" +
    "function esc(s){return String(s==null?'':s).replace(/[&<>\"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c];});}\n" +
    "function post(azione,dati){return fetch(CFG.u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:CFG.t,c:CFG.c,azione:azione,dati:dati||{}})}).then(function(r){return r.json();});}\n" +
    "function lib(){return window.XLSX?Promise.resolve():new Promise(function(ok,ko){var s=document.createElement('script');s.src=XLSXURL;s.onload=ok;s.onerror=function(){ko(new Error('lib'));};document.head.appendChild(s);});}\n" +
    "function norm(s){return String(s==null?'':s).toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();}\n" +
    "var CAMPI=[{k:'fornitore',n:'Fornitore',o:1,p:['fornitore','ditta fornitrice','ragione sociale','mittente','ditta','cedente']},\n" +
    " {k:'numero',n:'Numero del DDT',o:1,p:['numero ddt','n ddt','nr ddt','ddt n','num ddt','numero documento','n documento','nr documento','numero bolla','n bolla','numero','num','nr','n']},\n" +
    " {k:'data',n:'Data del DDT',o:1,p:['data ddt','data documento','data bolla','data consegna','data']},\n" +
    " {k:'materiale',n:'Materiale',p:['materiale','descrizione','articolo','merce','prodotto','descrizione merce']},\n" +
    " {k:'quantita',n:'Quantità',p:['quantita','qta','q ta','qt','quantitativo']},\n" +
    " {k:'cantiere',n:'Cantiere',p:['cantiere','commessa','destinazione','luogo di destinazione','cantiere di destinazione']},\n" +
    " {k:'riferimento',n:'Riferimento ordine',p:['ordine','rif ordine','riferimento ordine','n ordine','riferimento']}];\n" +
    "function punteggio(h,c){var x=norm(h);if(!x)return 0;for(var i=0;i<c.p.length;i++){if(x===c.p[i])return 100-i;}for(var j=0;j<c.p.length;j++){if(c.p[j].length>2&&(' '+x+' ').indexOf(' '+c.p[j]+' ')!==-1)return 50-j;}return 0;}\n" +
    "function testa(rows){var best=null;for(var r=0;r<Math.min(rows.length,20);r++){var h=rows[r]||[],tot=0,m={};CAMPI.forEach(function(c){var bi=-1,bp=0;h.forEach(function(v,i){var p=punteggio(v,c);if(p>bp){bp=p;bi=i;}});if(bi>=0){m[c.k]=bi;tot+=c.o?2:1;}});if(tot>=3&&(!best||tot>best.tot))best={r:r,m:m,tot:tot};}return best;}\n" +
    "function giorno(v){if(v instanceof Date&&!isNaN(v))return v.getFullYear()+'-'+('0'+(v.getMonth()+1)).slice(-2)+'-'+('0'+v.getDate()).slice(-2);if(typeof v==='number'&&v>20000&&v<80000){var d=new Date(Math.round((v-25569)*86400000));return d.getUTCFullYear()+'-'+('0'+(d.getUTCMonth()+1)).slice(-2)+'-'+('0'+d.getUTCDate()).slice(-2);}return String(v==null?'':v).trim();}\n" +
    "function hex(buf){return crypto.subtle.digest('SHA-256',buf).then(function(h){return Array.from(new Uint8Array(h)).map(function(b){return('0'+b.toString(16)).slice(-2);}).join('');});}\n" +
    "var P=document.getElementById('p-d');if(!P)return;\n" +
    "P.querySelectorAll('.scheda[data-mid^=\"excel:\"] .r .t').forEach(function(t){if(!t.querySelector('.gl-dx-seg'))t.appendChild(el('span','gl-dx-seg','da Excel'));});\n" +
    "if(P.querySelector('.gl-dx-b'))return;\n" +
    "var B=el('button','gl-dx-b','&#128229; Importa DDT da Excel');B.type='button';P.insertBefore(B,P.firstChild);B.addEventListener('click',apri);\n" +
    "function apri(){var ov=el('div','gl-dx-ov'),bx=el('div','gl-dx-bx');ov.appendChild(bx);document.body.appendChild(ov);var F=null;\n" +
    " function chiudi(ricarica){if(ov.parentNode)ov.parentNode.removeChild(ov);document.removeEventListener('keydown',tasto);if(ricarica)location.reload();}\n" +
    " function tasto(e){if(e.key==='Escape')chiudi(false);}document.addEventListener('keydown',tasto);\n" +
    " function passo1(msg){bx.innerHTML='<h3>Importa DDT da Excel</h3><p>Carica il riepilogo dei DDT così come te l’ha mandato la segreteria: Excel (.xlsx, .xls), .csv o .ods. Il file si legge qui sul tuo dispositivo; prima di salvare vedi tutte le righe.</p>'+\n" +
    "  '<input type=\"file\" id=\"gl-dx-f\" accept=\".xlsx,.xls,.csv,.ods\"><div id=\"gl-dx-es\">'+(msg?'<p class=\"gl-dx-err\">'+esc(msg)+'</p>':'')+'</div><h4>Importazioni recenti</h4><div id=\"gl-dx-el\"><p class=\"gl-dx-nota\">Carico…</p></div><div class=\"gl-dx-az\"><button type=\"button\" id=\"gl-dx-no\">Chiudi</button></div>';\n" +
    "  bx.querySelector('#gl-dx-no').onclick=function(){chiudi(false);};elenco();\n" +
    "  bx.querySelector('#gl-dx-f').onchange=function(){var f=this.files&&this.files[0];if(!f)return;if(f.size>15*1024*1024){passo1('Il file è troppo grande: massimo 15 MB.');return;}\n" +
    "   bx.querySelector('#gl-dx-es').innerHTML='<p class=\"gl-dx-nota\">Leggo il file…</p>';\n" +
    "   Promise.all([lib(),f.arrayBuffer()]).then(function(x){var buf=x[1],wb=window.XLSX.read(buf,{type:'array',cellDates:true}),best=null;\n" +
    "    wb.SheetNames.forEach(function(nm){var rows=window.XLSX.utils.sheet_to_json(wb.Sheets[nm],{header:1,raw:true,defval:''}),t=testa(rows);if(t&&(!best||t.tot>best.t.tot))best={t:t,rows:rows,foglio:nm};});\n" +
    "    if(!best){passo1('Non trovo le intestazioni delle colonne (fornitore, numero, data): controlla che il file abbia una riga di titoli.');return;}\n" +
    "    return hex(buf).then(function(sha){F={nome:f.name,sha:sha,rows:best.rows,t:best.t,foglio:best.foglio};passo2();});\n" +
    "   }).catch(function(){passo1('Non riesco a leggere il file: prova a salvarlo di nuovo in Excel (.xlsx).');});};}\n" +
    " function elenco(){post('elenco').then(function(r){var c=bx.querySelector('#gl-dx-el');if(!c)return;var l=r&&r.importazioni||[];if(!l.length){c.innerHTML='<p class=\"gl-dx-nota\">Nessuna importazione per ora.</p>';return;}\n" +
    "  c.innerHTML=l.map(function(z){return '<div class=\"gl-dx-st\"><span><b>'+esc(z.nome_file||'file')+'</b> &middot; '+z.nuovi+(z.nuovi===1?' DDT':' DDT')+' &middot; '+esc(z.il)+(z.autore?' &middot; '+esc(z.autore):'')+(z.annullata?' &middot; <i>annullata</i>':'')+'</span>'+(z.annullabile?'<button type=\"button\" data-a=\"'+z.id+'\">Annulla</button>':'')+'</div>';}).join('');\n" +
    "  c.querySelectorAll('button[data-a]').forEach(function(b){b.onclick=function(){if(!confirm('Annullo questa importazione? I DDT ancora senza foto spariscono dal registro; le aggiunte al diario restano registrate.'))return;b.disabled=true;post('annulla',{id:b.getAttribute('data-a')}).then(function(r){if(r&&r.esito==='ok'){alert('Tolti '+r.tolti+' DDT.');chiudi(true);}else{b.disabled=false;alert(r&&r.messaggio?r.messaggio:'Non riuscito: riprova.');}});};});}).catch(function(){});}\n" +
    " function passo2(){var h=F.rows[F.t.r]||[],opz='<option value=\"-1\">(nessuna colonna)</option>'+h.map(function(v,i){return '<option value=\"'+i+'\">'+esc(String(v||'colonna '+(i+1)))+'</option>';}).join('');\n" +
    "  var dati=F.rows.slice(F.t.r+1).filter(function(r){return r&&r.some(function(v){return String(v).trim()!=='';});});\n" +
    "  bx.innerHTML='<h3>Importa DDT da Excel</h3><p><b>'+esc(F.nome)+'</b> &middot; foglio «'+esc(F.foglio)+'» &middot; '+dati.length+' righe</p><h4>Le colonne</h4><p class=\"gl-dx-nota\">TIX le ha riconosciute dai titoli: controlla quelle segnate.</p><div class=\"gl-dx-map\">'+\n" +
    "   CAMPI.map(function(c){var i=F.t.m[c.k];return '<div class=\"'+(i==null&&c.o?'inc':'')+'\"><label for=\"gl-dx-c-'+c.k+'\">'+c.n+(c.o?' *':'')+'</label><select id=\"gl-dx-c-'+c.k+'\">'+opz+'</select></div>';}).join('')+'</div>'+\n" +
    "   '<div id=\"gl-dx-es\"></div><div class=\"gl-dx-az\"><button type=\"button\" id=\"gl-dx-ind\">Cambia file</button><button type=\"button\" class=\"pr\" id=\"gl-dx-va\">Controlla le righe</button></div>';\n" +
    "  CAMPI.forEach(function(c){var s=bx.querySelector('#gl-dx-c-'+c.k);s.value=String(F.t.m[c.k]==null?-1:F.t.m[c.k]);s.onchange=function(){s.parentNode.className='';};});\n" +
    "  bx.querySelector('#gl-dx-ind').onclick=function(){passo1('');};\n" +
    "  bx.querySelector('#gl-dx-va').onclick=function(){var m={};CAMPI.forEach(function(c){m[c.k]=+bx.querySelector('#gl-dx-c-'+c.k).value;});\n" +
    "   if(m.fornitore<0||m.numero<0||m.data<0){bx.querySelector('#gl-dx-es').innerHTML='<p class=\"gl-dx-err\">Scegli almeno le colonne Fornitore, Numero e Data.</p>';return;}\n" +
    "   var righe=[];F.rows.forEach(function(r,i){if(i<=F.t.r||!r||!r.some(function(v){return String(v).trim()!=='';}))return;var o={n:i+1};CAMPI.forEach(function(c){var v=m[c.k]>=0?r[m[c.k]]:'';o[c.k]=c.k==='data'?giorno(v):(v instanceof Date?giorno(v):String(v==null?'':v).trim());});righe.push(o);});\n" +
    "   if(righe.length>500){bx.querySelector('#gl-dx-es').innerHTML='<p class=\"gl-dx-err\">Il file ha '+righe.length+' righe: al massimo 500 per volta. Dividilo.</p>';return;}\n" +
    "   var bt=this;bt.disabled=true;bt.textContent='Controllo…';post('analizza',{righe:righe}).then(function(r){bt.disabled=false;bt.textContent='Controlla le righe';\n" +
    "    if(!r||r.esito!=='ok'){bx.querySelector('#gl-dx-es').innerHTML='<p class=\"gl-dx-err\">'+esc(r&&r.messaggio?r.messaggio:'Il controllo non è riuscito: riprova tra un minuto.')+'</p>';return;}passo3(righe,r);}).catch(function(){bt.disabled=false;bt.textContent='Controlla le righe';});};}\n" +
    " function passo3(righe,R){var per={};righe.forEach(function(x){per[x.n]=x;});var nu=[],pr=[],co=[];R.righe.forEach(function(e){(e.stato==='nuovo'?nu:e.stato==='presente'?pr:co).push(e);});\n" +
    "  var opzC='<option value=\"\">Scegli il cantiere…</option>'+(R.cantieri||[]).map(function(c){return '<option value=\"'+esc(c.id)+'\">'+esc(c.nome)+'</option>';}).join('');\n" +
    "  function rigaT(e,extra){var x=per[e.n]||{};return '<tr><td>'+e.n+'</td><td>'+esc(x.fornitore)+'</td><td>'+esc(x.numero)+'</td><td>'+esc(e.data?e.data.split('-').reverse().join('/'):x.data)+'</td><td>'+esc(x.materiale)+(x.quantita?' &middot; '+esc(x.quantita):'')+'</td><td>'+esc(e.cantiere||x.cantiere||'')+'</td>'+(extra||'')+'</tr>';}\n" +
    "  var th='<tr><th>Riga</th><th>Fornitore</th><th>N.</th><th>Data</th><th>Materiale</th><th>Cantiere</th>';\n" +
    "  bx.innerHTML='<h3>Importa DDT da Excel</h3><div class=\"gl-dx-chips\"><span class=\"n\">'+nu.length+' nuovi</span><span class=\"p\">'+pr.length+' già presenti</span><span class=\"c\">'+co.length+' da controllare</span></div>'+\n" +
    "   (nu.length?'<h4>Nuovi: si caricano</h4><div class=\"gl-dx-wrap\"><table class=\"gl-dx-tab\">'+th+'<th></th></tr>'+nu.map(function(e){return rigaT(e,'<td><input type=\"checkbox\" data-n=\"'+e.n+'\" checked aria-label=\"Carica la riga '+e.n+'\"></td>');}).join('')+'</table></div>':'')+\n" +
    "   (co.length?'<h4>Da controllare</h4><p class=\"gl-dx-nota\">Se manca solo il cantiere, sceglilo e la riga si carica. Le altre vanno corrette nel file.</p><div class=\"gl-dx-wrap\"><table class=\"gl-dx-tab\">'+th+'<th>Perché</th></tr>'+co.map(function(e){var sel=/cantiere/.test(e.motivo||'')?'<select data-c=\"'+e.n+'\">'+opzC+'</select>':'';return rigaT(e,'<td class=\"m\">'+esc(e.motivo||'')+sel+'</td>');}).join('')+'</table></div>':'')+\n" +
    "   (pr.length?'<h4>Già presenti: non si caricano due volte</h4><div class=\"gl-dx-wrap\"><table class=\"gl-dx-tab\">'+th+'<th>Perché</th></tr>'+pr.map(function(e){return rigaT(e,'<td class=\"m\">'+esc(e.motivo||'')+'</td>');}).join('')+'</table></div>':'')+\n" +
    "   '<h4>Chi fa l’importazione</h4><input type=\"text\" id=\"gl-dx-aut\" placeholder=\"Nome e cognome\" maxlength=\"120\" autocomplete=\"name\">'+\n" +
    "   '<p class=\"gl-dx-nota\" style=\"margin-top:8px\">I DDT entrano nel registro del loro cantiere con il segno «da Excel», senza foto: se la foto della bolla arriva dopo da WhatsApp, si aggancia da sola. Nei giorni già chiusi il diario non cambia: il DDT va nell’«Integrazione al diario» di quel giorno.</p>'+\n" +
    "   '<div id=\"gl-dx-es\"></div><div class=\"gl-dx-az\"><button type=\"button\" id=\"gl-dx-ind\">Indietro</button><button type=\"button\" class=\"pr\" id=\"gl-dx-si\">Conferma e salva</button></div>';\n" +
    "  bx.querySelector('#gl-dx-ind').onclick=passo2;\n" +
    "  bx.querySelector('#gl-dx-si').onclick=function(){var es=bx.querySelector('#gl-dx-es'),aut=bx.querySelector('#gl-dx-aut').value.trim();if(!aut){es.innerHTML='<p class=\"gl-dx-err\">Scrivi chi fa l’importazione (nome e cognome).</p>';return;}\n" +
    "   var scelte=[];bx.querySelectorAll('input[data-n]:checked').forEach(function(i){var x=per[+i.getAttribute('data-n')];if(x)scelte.push(x);});\n" +
    "   bx.querySelectorAll('select[data-c]').forEach(function(s){if(s.value){var x=per[+s.getAttribute('data-c')];if(x){var y={};for(var k in x)y[k]=x[k];y.commessa_id=s.value;scelte.push(y);}}});\n" +
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
