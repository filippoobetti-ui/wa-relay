#!/usr/bin/env python3
"""Prepara risorse.json per il generatore del cartello:
- marchio Il Giornale Lavori come tracciati (per il PDF vettoriale) e come markup interno (per l'SVG);
- font Roboto (sottoinsieme latino) in base64;
- matrice del QR del sito.
"""
import base64, json, os, re, xml.etree.ElementTree as ET

BASE = os.path.dirname(os.path.abspath(__file__))
NS = '{http://www.w3.org/2000/svg}'

svg_txt = open(f'{BASE}/logo-orizzontale.svg', encoding='utf-8').read()
root = ET.fromstring(svg_txt)
assert root.get('viewBox') == '0 0 317.78 100.00'

def parse_transform(t):
    """Restituisce una funzione (x,y)->(x',y') per translate/scale concatenati (SVG: si applica da destra)."""
    ops = re.findall(r'(translate|scale)\(([^)]*)\)', t or '')
    def f(x, y):
        for name, args in reversed(ops):
            nums = [float(v) for v in re.split(r'[ ,]+', args.strip()) if v]
            if name == 'translate':
                tx = nums[0]; ty = nums[1] if len(nums) > 1 else 0.0
                x, y = x + tx, y + ty
            else:
                sx = nums[0]; sy = nums[1] if len(nums) > 1 else sx
                x, y = x * sx, y * sy
        return x, y
    return f

TOK = re.compile(r'[MLHVQZmlhvqz]|-?(?:\d+\.?\d*|\.\d+)')

def parse_path(d, tf):
    toks = TOK.findall(d)
    i = 0; cmd = None; cx = cy = 0.0; sx = sy = 0.0
    out = []
    def P(x, y):
        X, Y = tf(x, y); return [round(X, 3), round(Y, 3)]
    while i < len(toks):
        t = toks[i]
        if t.isalpha():
            cmd = t; i += 1
            if cmd in 'Zz':
                out.append(['h']); cx, cy = sx, sy; continue
            if i >= len(toks): break
        if cmd == 'M':
            cx, cy = float(toks[i]), float(toks[i+1]); i += 2; sx, sy = cx, cy
            out.append(['m', *P(cx, cy)]); cmd = 'L'  # coppie successive = L
        elif cmd == 'L':
            cx, cy = float(toks[i]), float(toks[i+1]); i += 2
            out.append(['l', *P(cx, cy)])
        elif cmd == 'H':
            cx = float(toks[i]); i += 1; out.append(['l', *P(cx, cy)])
        elif cmd == 'V':
            cy = float(toks[i]); i += 1; out.append(['l', *P(cx, cy)])
        elif cmd == 'Q':
            qx, qy = float(toks[i]), float(toks[i+1]); x2, y2 = float(toks[i+2]), float(toks[i+3]); i += 4
            c1x = cx + 2/3 * (qx - cx); c1y = cy + 2/3 * (qy - cy)
            c2x = x2 + 2/3 * (qx - x2); c2y = y2 + 2/3 * (qy - y2)
            out.append(['c', *P(c1x, c1y), *P(c2x, c2y), *P(x2, y2)])
            cx, cy = x2, y2
        else:
            raise ValueError(f'comando non gestito: {cmd}')
    return out

tracciati = []
def visita(el, tf):
    for ch in el:
        tag = ch.tag.replace(NS, '')
        if tag == 'g':
            visita(ch, lambda x, y, a=parse_transform(ch.get('transform')), b=tf: b(*a(x, y)))
        elif tag == 'path':
            tracciati.append({'fill': ch.get('fill'), 'rule': ch.get('fill-rule', 'nonzero'), 'cmds': parse_path(ch.get('d'), tf)})
        elif tag == 'rect':
            x, y = float(ch.get('x')), float(ch.get('y')); w, h = float(ch.get('width')), float(ch.get('height'))
            X, Y = tf(x, y); X2, Y2 = tf(x + w, y + h)
            fill = ch.get('fill'); op = float(ch.get('opacity', '1'))
            if op < 1:  # fonde con il bianco: il PDF non usa trasparenze
                r, g, b = int(fill[1:3], 16), int(fill[3:5], 16), int(fill[5:7], 16)
                mix = lambda c: round(c * op + 255 * (1 - op))
                fill = '#%02X%02X%02X' % (mix(r), mix(g), mix(b))
            tracciati.append({'fill': fill, 'rect': [round(X, 3), round(Y, 3), round(X2 - X, 3), round(Y2 - Y, 3), float(ch.get('rx', '0'))]})
visita(root, lambda x, y: (x, y))

# markup interno (senza <svg>): tutto ciò che sta dentro il tag radice, senza <title>
interno = re.sub(r'^.*?<svg[^>]*>', '', svg_txt, flags=re.S)
interno = re.sub(r'</svg>\s*$', '', interno, flags=re.S)
interno = re.sub(r'<title>.*?</title>', '', interno, flags=re.S).strip()

b64 = lambda p: base64.b64encode(open(p, 'rb').read()).decode()
ris = {
    'logoTracciati': tracciati,
    'logoSvgInterno': interno,
    'font': {'regolare': b64(f'{BASE}/Roboto_400Regular.sub.ttf'), 'grassetto': b64(f'{BASE}/Roboto_700Bold.sub.ttf')},
    'qr': json.load(open(f'{BASE}/qr.json')),
}
json.dump(ris, open(f'{BASE}/risorse.json', 'w'))
print('tracciati:', len(tracciati), 'comandi:', sum(len(t.get('cmds', [])) for t in tracciati))
print('interno:', len(interno), 'car.;', 'font:', len(ris['font']['regolare']), len(ris['font']['grassetto']), 'car. base64;', 'qr:', ris['qr']['n'])
