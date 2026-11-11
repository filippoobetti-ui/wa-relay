// ============================================================================
// TIPI DI DITTA (10/11/2026, noleggio-1, chat 02B). Fornitore, Subappaltatore e Noleggio con icona e colore approvati
// da Filippo l'08/11 (piano Strumenti/restyling-tix/preventivi-02b/tipi-ditta-02b/01-piano.md):
//   Fornitore = pallet, grigio ardesia #4A5A6A · Subappaltatore = casco con cazzuola, terracotta #B5523B ·
//   Noleggio = escavatore, petrolio dei Mezzi #0B6E79.
// Usato nelle pagine Rubrica e Persone del cantiere (src/persone-cantiere.js) e Preventivi (src/preventivi.js).
// Nel browser: tdChip(tipo, aggiunta) restituisce l'etichetta con l'icona, oppure '' per gli altri rapporti.
// ============================================================================

export const TIPI_DITTA_CSS = ".tdc{display:inline-flex;align-items:center;gap:4px;vertical-align:middle;padding:1px 9px 1px 4px;border-radius:999px;" +
  "font-size:.78rem;font-weight:700;line-height:1.6;white-space:nowrap;color:var(--tdk,#4A5A6A);background:color-mix(in srgb,var(--tdk,#4A5A6A) 13%,#fff)}" +
  ".tdc svg{width:16px;height:16px;flex:none}";

// solo nelle pagine che hanno anche il tema scuro (Rubrica, Persone del cantiere)
export const TIPI_DITTA_CSS_SCURO = "@media (prefers-color-scheme:dark){.tdc{color:color-mix(in srgb,var(--tdk,#4A5A6A) 38%,#fff);background:color-mix(in srgb,var(--tdk,#4A5A6A) 32%,#172231)}}";

export const TIPI_DITTA_JS = String.raw`
var TD={fornitore:{n:'Fornitore',k:'#4A5A6A',i:'<path d="M3 19h18M4 19v-2h16v2M6 17v-2M12 17v-2M18 17v-2"/><rect x="5" y="9" width="6" height="6" rx=".6"/><rect x="13" y="9" width="6" height="6" rx=".6"/><rect x="9" y="3.5" width="6" height="5.5" rx=".6"/>'},
 subappaltatore:{n:'Subappaltatore',k:'#B5523B',i:'<path d="M4 13a8 8 0 0 1 16 0"/><path d="M3 13h18v2H3z"/><path d="M10 5.3V9M14 5.3V9"/><path d="M14.5 17.5l5 3.5M17 16l3.6-1.2-.7 3"/>'},
 noleggio:{n:'Noleggio',k:'#0B6E79',i:'<rect x="2.5" y="15" width="12" height="4" rx="2"/><circle cx="5" cy="17" r=".6"/><circle cx="12" cy="17" r=".6"/><path d="M4 15v-4h5l2 4"/><path d="M9 11l5-6 5 3-2 4"/><path d="M17 12l2.5 3H16"/>'}};
function tdChip(t,agg){var x=TD[t];if(!x)return '';
 return '<span class="tdc" style="--tdk:'+x.k+'"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">'+x.i+'</svg>'+x.n+(agg?' · '+agg:'')+'</span>';}
`;
