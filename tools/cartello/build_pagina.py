#!/usr/bin/env python3
"""Assembla la pagina del generatore (cartello.html) e la Edge Function (cartello-edge-index.ts)."""
import json, os, re, hashlib

BASE = os.path.dirname(os.path.abspath(__file__))
ris = json.load(open(f'{BASE}/risorse.json'))
motore = open(f'{BASE}/src/motore.js', encoding='utf-8').read()
stampa = open(f'{BASE}/src/stampa.js', encoding='utf-8').read()
pagina = open(f'{BASE}/src/pagina.html', encoding='utf-8').read()
negativo = open(f'{BASE}/logo-orizzontale-negativo.svg', encoding='utf-8').read()

# marchio negativo inline nella testata (senza dichiarazione XML, commento e titolo)
neg = re.sub(r'^.*?<svg', '<svg', negativo, flags=re.S)
neg = re.sub(r'<title>.*?</title>', '', neg, flags=re.S)
neg = neg.replace('width="317.78" height="100.00"', 'height="40"').strip()

sicuro = lambda t: re.sub(r'</(script)', r'<\\/\1', t, flags=re.I).replace('<!--', '<\\!--')
ris_json = sicuro(json.dumps(ris, ensure_ascii=False))
for seg in ('__LOGO_INTERNO__', '__MOTORE__', '__STAMPA__', '__RISORSE__'):
    assert pagina.count(seg) == 1, seg
html = (pagina
        .replace('__LOGO_INTERNO__', ris['logoSvgInterno'])
        .replace('__MOTORE__', sicuro(motore))
        .replace('__STAMPA__', sicuro(stampa))
        .replace('__RISORSE__', ris_json))
open(f'{BASE}/cartello.html', 'w', encoding='utf-8').write(html)

ts = open(f'{BASE}/src/cartello-edge.template.ts', encoding='utf-8').read()
assert '__PAGINA_HTML__' not in ts
open(f'{BASE}/cartello-edge-index.ts', 'w', encoding='utf-8').write(ts)

h = hashlib.md5(html.encode()).hexdigest()
print(f'cartello.html: {len(html.encode())} byte, md5 {h}')
print(f'cartello-edge-index.ts: {len(ts.encode())} byte, md5 {hashlib.md5(ts.encode()).hexdigest()}')
