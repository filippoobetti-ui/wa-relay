// ============================================================================
// CAMPI MANCANTI IN ROSSO (14/11/2026, campi-rossi-1, chat B3). Regola di Filippo per TUTTI i moduli dell'app, presenti e futuri:
// se per inviare manca qualcosa, la casella (o il riquadro, l'elenco, l'icona) dove manca si segna in rosso con una riga che dice
// cosa scrivere, e la pagina porta al primo campo da completare. Il rosso sparisce appena si scrive o si sceglie.
//
// Uso nel browser (dopo aver messo CAMPI_ROSSI_CSS nello <style> e CAMPI_ROSSI_JS in uno <script> prima dello script della pagina):
//   crControlla([{ el: elemento, testo: 'Scrivi la descrizione' }, { el: riquadro, ok: function(){ return ...; }, testo: '...' }])
//     → true se è tutto a posto; altrimenti segna in rosso tutti quelli che mancano e restituisce false
//   crSegna(elemento, testo)   segna un solo campo (per esempio quello indicato dal server con r.campo)
//   crPulisci(contenitore)     toglie i segni rossi
// Un elemento che non è una casella (div, tabella, elenco di caselle, pulsante) viene contornato di rosso.
// ============================================================================

export const CAMPI_ROSSI_CSS =
  ".cr-err{border-color:#B3261E!important;background:#FDF1F0!important;box-shadow:0 0 0 3px rgba(179,38,30,.16)!important}" +
  ".cr-box{outline:2px solid #B3261E!important;outline-offset:3px;border-radius:10px;background:rgba(253,241,240,.6)}" +
  ".cr-msg{display:block;color:#B3261E;font-size:.8rem;font-weight:700;line-height:1.3;margin:4px 0 2px;text-align:left}" +
  ".cr-msg::before{content:'\\26A0\\FE0E  '}";

export const CAMPI_ROSSI_JS = String.raw`
function crCasella(el){return !!(el&&el.matches&&el.matches('input:not([type=checkbox]):not([type=radio]):not([type=hidden]),select,textarea'));}
function crSegna(el,testo){if(!el)return;var c=crCasella(el);el.classList.add(c?'cr-err':'cr-box');el.setAttribute('aria-invalid','true');
 var dopo=el.nextElementSibling;if(dopo&&dopo.classList&&dopo.classList.contains('cr-msg'))dopo.remove();
 var m=document.createElement('span');m.className='cr-msg';m.setAttribute('role','alert');m.textContent=testo||'Da compilare';el.insertAdjacentElement('afterend',m);}
function crTogli(el){if(!el||!el.classList)return;el.classList.remove('cr-err','cr-box');el.removeAttribute('aria-invalid');var d=el.nextElementSibling;if(d&&d.classList&&d.classList.contains('cr-msg'))d.remove();}
function crPulisci(root){(root||document).querySelectorAll('.cr-err,.cr-box').forEach(crTogli);}
function crControlla(regole){var primo=null;
 (regole||[]).forEach(function(r){if(!r||!r.el)return;var ok=r.ok?!!r.ok(r.el):String(r.el.value==null?'':r.el.value).trim()!=='';
  if(ok)crTogli(r.el);else{crSegna(r.el,r.testo);if(!primo)primo=r.el;}});
 if(primo){try{primo.scrollIntoView({block:'center',behavior:'smooth'});}catch(e){primo.scrollIntoView();}if(crCasella(primo))try{primo.focus({preventScroll:true});}catch(e){}}
 return !primo;}
function crSuCambio(e){var t=e.target;if(!t||!t.classList)return;if(t.classList.contains('cr-err'))crTogli(t);
 var b=t.closest&&t.closest('.cr-box');if(b)crTogli(b);}
document.addEventListener('input',crSuCambio,true);document.addEventListener('change',crSuCambio,true);
`;
