#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Assistente vocale del Giornale Lavori — centralino v3 (11/10/2026, piano 2).

Percorso di una chiamata:
  WhatsApp → Meta (SIP/TLS, Opus/SRTP) → Kamailio → rtpengine (toglie solo la cifratura SRTP,
  l'audio resta Opus) → questo programma (SIP su UDP 127.0.0.1:5070, RTP Opus).

Per ogni chiamata:
  - ASCOLTA: Opus → PCM 24 kHz → OpenAI Realtime, che risponde SOLO con il testo (nessuna voce OpenAI);
  - PARLA: ogni frase va al relay /centralino/tts, che usa la voce giusta per la lingua
    (Alexandra di ElevenLabs; Anila di Microsoft Azure per l'albanese) → PCM 24 kHz → Opus → RTP;
  - INTERRUZIONI: se chi chiama parla mentre l'assistente parla, l'audio in uscita si ferma subito;
  - CHIUSURA: quando l'AI chiama la funzione termina_chiamata, la chiamata si chiude dopo l'ultima frase.

Nessuna chiave dei fornitori su questo server: per ogni chiamata il relay consegna una chiave OpenAI
temporanea e fa da tramite verso le voci. Configurazione: /etc/gl/centralino.json
  {"token": "<token del centralino>", "relay": "https://wa-relay.filippo-obetti.workers.dev"}
Prova completa senza chiamate: python3 gl_voce.py --prova
"""
import asyncio
import base64
import ctypes
import ctypes.util
import http.client
import json
import os
import random
import re
import socket
import ssl
import struct
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

VERSIONE = "gl-voce 3.0 (11/10/2026)"

try:  # websockets >= 13 (Debian 13: python3-websockets)
    from websockets.asyncio.client import connect as ws_connect
    WS_HEADER = "additional_headers"
except ImportError:  # versioni vecchie
    from websockets.client import connect as ws_connect  # type: ignore
    WS_HEADER = "extra_headers"


def log(*parti):
    print(time.strftime("%H:%M:%S"), *parti, flush=True)


CONF = json.load(open(os.environ.get("GL_CONF", "/etc/gl/centralino.json")))
TOKEN = str(CONF["token"])
RELAY = str(CONF.get("relay", "https://wa-relay.filippo-obetti.workers.dev")).rstrip("/")
SIP_IP = str(CONF.get("sip_ip", "127.0.0.1"))
SIP_PORTA = int(CONF.get("sip_porta", 5070))
RTP_MIN = int(CONF.get("rtp_min", 41000))
RTP_MAX = int(CONF.get("rtp_max", 41998))
MAX_CHIAMATE = int(CONF.get("max_chiamate", 6))
FILE_STATO = str(CONF.get("stato", "/run/gl-voce/attive"))

FRAME = 960                 # 20 ms di PCM 16 bit mono a 24 kHz
SILENZIO = b"\0" * FRAME
PASSO_TS = 960              # l'orologio RTP di Opus è sempre 48 kHz: 20 ms = 960
INVIO_AI = 4800             # 100 ms di audio per ogni invio a OpenAI
SALUTI_PREDEFINITI = {
    "it": "Ciao, sono l'assistente del Giornale Lavori. Come posso aiutarti?",
    "sq": "Përshëndetje, jam asistentja e Giornale Lavori. Si mund t'ju ndihmoj?",
}


# ---------------------------------------------------------------------------- Opus (libopus via ctypes)
class Opus:
    APPLICAZIONE_VOIP = 2048

    def __init__(self):
        nome = ctypes.util.find_library("opus") or "libopus.so.0"
        lib = ctypes.CDLL(nome)
        lib.opus_decoder_create.restype = ctypes.c_void_p
        lib.opus_decoder_create.argtypes = [ctypes.c_int32, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
        lib.opus_decode.restype = ctypes.c_int
        lib.opus_decode.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int32,
                                    ctypes.POINTER(ctypes.c_int16), ctypes.c_int, ctypes.c_int]
        lib.opus_decoder_destroy.argtypes = [ctypes.c_void_p]
        lib.opus_encoder_create.restype = ctypes.c_void_p
        lib.opus_encoder_create.argtypes = [ctypes.c_int32, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
        lib.opus_encode.restype = ctypes.c_int32
        lib.opus_encode.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int16), ctypes.c_int,
                                    ctypes.c_char_p, ctypes.c_int32]
        lib.opus_encoder_destroy.argtypes = [ctypes.c_void_p]
        lib.opus_encoder_ctl.restype = ctypes.c_int
        self.lib = lib


OPUS = None


class Decoder:
    def __init__(self):
        err = ctypes.c_int(0)
        self.st = OPUS.lib.opus_decoder_create(24000, 1, ctypes.byref(err))
        if not self.st or err.value != 0:
            raise RuntimeError("opus_decoder_create %d" % err.value)
        self.buf = (ctypes.c_int16 * 5760)()

    def decodifica(self, pacchetto):
        """Pacchetto Opus → PCM 24 kHz; None = pacchetto perso (ricostruzione)."""
        if pacchetto is None:
            n = OPUS.lib.opus_decode(self.st, None, 0, self.buf, 480, 0)
        else:
            n = OPUS.lib.opus_decode(self.st, pacchetto, len(pacchetto), self.buf, 2880, 0)
        if n <= 0:
            return b""
        return ctypes.string_at(self.buf, n * 2)

    def chiudi(self):
        if self.st:
            OPUS.lib.opus_decoder_destroy(self.st)
            self.st = None


class Encoder:
    def __init__(self):
        err = ctypes.c_int(0)
        self.st = OPUS.lib.opus_encoder_create(24000, 1, Opus.APPLICAZIONE_VOIP, ctypes.byref(err))
        if not self.st or err.value != 0:
            raise RuntimeError("opus_encoder_create %d" % err.value)
        ctl = OPUS.lib.opus_encoder_ctl
        st = ctypes.c_void_p(self.st)
        ctl(st, ctypes.c_int(4002), ctypes.c_int32(28000))   # bitrate
        ctl(st, ctypes.c_int(4010), ctypes.c_int32(5))       # complessità
        ctl(st, ctypes.c_int(4012), ctypes.c_int32(1))       # FEC in banda
        ctl(st, ctypes.c_int(4014), ctypes.c_int32(5))       # perdita pacchetti attesa 5%
        ctl(st, ctypes.c_int(4024), ctypes.c_int32(3001))    # segnale: voce
        ctl(st, ctypes.c_int(4004), ctypes.c_int32(1104))    # banda massima: superwideband
        self.pcm = (ctypes.c_int16 * 480)()
        self.out = ctypes.create_string_buffer(1500)

    def codifica(self, frame):
        ctypes.memmove(self.pcm, frame, FRAME)
        n = OPUS.lib.opus_encode(self.st, self.pcm, 480, self.out, 1500)
        if n <= 0:
            return b""
        return self.out.raw[:n]

    def chiudi(self):
        if self.st:
            OPUS.lib.opus_encoder_destroy(self.st)
            self.st = None


# ---------------------------------------------------------------------------- relay (HTTP)
class Relay:
    def __init__(self, base, token):
        u = urllib.parse.urlsplit(base)
        self.https = u.scheme == "https"
        self.host = u.hostname
        self.porta = u.port or (443 if self.https else 80)
        self.prefisso = u.path.rstrip("/")
        self.token = token
        self.ctx = ssl.create_default_context()

    def connessione(self, timeout):
        if self.https:
            return http.client.HTTPSConnection(self.host, self.porta, timeout=timeout, context=self.ctx)
        return http.client.HTTPConnection(self.host, self.porta, timeout=timeout)

    def intestazioni(self):
        return {"X-GL-Centralino": self.token, "Content-Type": "application/json", "User-Agent": "gl-voce/3"}

    def json(self, metodo, percorso, corpo=None, timeout=10):
        c = self.connessione(timeout)
        try:
            dati = json.dumps(corpo).encode() if corpo is not None else None
            c.request(metodo, self.prefisso + percorso, body=dati, headers=self.intestazioni())
            r = c.getresponse()
            grezzo = r.read()
            try:
                j = json.loads(grezzo.decode("utf-8") or "{}")
            except ValueError:
                j = {"errore": grezzo[:300].decode("utf-8", "replace")}
            return r.status, j
        finally:
            c.close()

    def tts_tutto(self, testo, lingua, timeout=20):
        """Sintesi completa (per i saluti messi da parte e per la prova)."""
        c = self.connessione(timeout)
        try:
            c.request("POST", self.prefisso + "/centralino/tts",
                      body=json.dumps({"testo": testo, "lingua": lingua}).encode(), headers=self.intestazioni())
            r = c.getresponse()
            dati = r.read()
            return r.status, r.getheader("X-GL-Fornitore", "?"), dati
        finally:
            c.close()


# ---------------------------------------------------------------------------- SIP
COMPATTI = {"v": "via", "f": "from", "t": "to", "i": "call-id", "m": "contact", "l": "content-length",
            "c": "content-type", "k": "supported", "s": "subject", "e": "content-encoding", "o": "event",
            "r": "refer-to", "b": "referred-by", "x": "session-expires", "u": "allow-events"}


class Sip:
    def __init__(self, dati):
        testo = dati.decode("utf-8", "replace")
        testa, _, self.corpo = testo.partition("\r\n\r\n")
        righe = testa.split("\r\n")
        self.prima = righe[0]
        self.h = []
        for r in righe[1:]:
            if not r:
                continue
            if r[0] in " \t" and self.h:
                n, v = self.h[-1]
                self.h[-1] = (n, v + " " + r.strip())
                continue
            n, _, v = r.partition(":")
            n = n.strip().lower()
            self.h.append((COMPATTI.get(n, n), v.strip()))
        p = self.prima.split(" ", 2)
        self.risposta = p[0].upper().startswith("SIP/")
        self.metodo = None if self.risposta else p[0].upper()
        self.ruri = "" if self.risposta else (p[1] if len(p) > 1 else "")
        self.codice = int(p[1]) if self.risposta and len(p) > 1 and p[1].isdigit() else 0

    def get(self, nome):
        for n, v in self.h:
            if n == nome:
                return v
        return ""

    def tutti(self, nome):
        return [v for n, v in self.h if n == nome]

    def cseq(self):
        p = self.get("cseq").split()
        return (int(p[0]) if p and p[0].isdigit() else 0), (p[1].upper() if len(p) > 1 else "")


def dividi(valore):
    """Divide un'intestazione con più valori separati da virgola (fuori da <> e virgolette)."""
    out, cur, ang, virg = [], "", 0, False
    for ch in valore:
        if ch == '"':
            virg = not virg
        if not virg:
            if ch == "<":
                ang += 1
            elif ch == ">":
                ang -= 1
            elif ch == "," and ang == 0:
                if cur.strip():
                    out.append(cur.strip())
                cur = ""
                continue
        cur += ch
    if cur.strip():
        out.append(cur.strip())
    return out


def tag_di(valore):
    resto = valore.split(">", 1)[1] if ">" in valore else valore
    m = re.search(r";\s*tag=([^;,\s]+)", resto, re.I)
    return m.group(1) if m else ""


def uri_di(valore):
    m = re.search(r"<([^>]+)>", valore)
    if m:
        return m.group(1).strip()
    return valore.split(";", 1)[0].strip()


def numero_di(valore):
    m = re.search(r"sips?:\+?([0-9]{6,15})@", valore)
    return m.group(1) if m else ""


def leggi_sdp(sdp):
    ip_sessione, ip_media, porta, pt_opus, in_audio = None, None, None, None, False
    for r in sdp.replace("\r\n", "\n").split("\n"):
        r = r.strip()
        if r.startswith("m="):
            parti = r[2:].split()
            in_audio = bool(parti) and parti[0] == "audio" and porta is None
            if in_audio and len(parti) > 1 and parti[1].isdigit():
                porta = int(parti[1])
        elif r.startswith("c="):
            parti = r[2:].split()
            ip = parti[2] if len(parti) >= 3 else None
            if in_audio:
                ip_media = ip
            elif porta is None:
                ip_sessione = ip
        elif in_audio and r.lower().startswith("a=rtpmap:") and pt_opus is None:
            pt, _, cod = r[9:].partition(" ")
            if cod.lower().startswith("opus/") and pt.strip().isdigit():
                pt_opus = int(pt.strip())
    return (ip_media or ip_sessione), porta, pt_opus


# ---------------------------------------------------------------------------- testo → frasi
FINE_FRASE = re.compile(r"[.!?…;:](?=\s)|\n")
ETICHETTA = re.compile(r"^\s*\[([A-Za-z]{2,3})(?:[-_][A-Za-z]{2,4})?\]\s*")
ETICHETTE_OVUNQUE = re.compile(r"\[[A-Za-z]{2,3}(?:[-_][A-Za-z]{2,4})?\]")
PAROLE_SQ = re.compile(r"\b(është|jam|jeni|për|nuk|faleminderit|mirë|shqip|kantier|punëtor|ju lutem|po|si mund)\b", re.I)


def indovina_lingua(testo, predefinita):
    t = testo.lower()
    if re.search(r"[ëç]", t) or PAROLE_SQ.search(t):
        return "sq"
    return predefinita


def pulisci(testo):
    testo = ETICHETTE_OVUNQUE.sub("", testo)
    testo = re.sub(r"[*_#`>|~]+", " ", testo)
    testo = re.sub(r"^\s*[-•]\s+", "", testo, flags=re.M)
    return re.sub(r"\s+", " ", testo).strip()


def taglio(buf, prima):
    minimo = 8 if prima else 30
    for m in FINE_FRASE.finditer(buf):
        if m.end() >= minimo:
            return m.end()
    if prima and len(buf) > 45:
        m = re.search(r",(?=\s)", buf[30:])
        if m:
            return 30 + m.end()
    if len(buf) > 240:
        i = buf.rfind(" ", 0, 220)
        return i if i > 40 else 220
    return None


# ---------------------------------------------------------------------------- chiamata
class Rtp(asyncio.DatagramProtocol):
    def __init__(self, chiamata):
        self.c = chiamata

    def datagram_received(self, dati, indirizzo):
        try:
            self.c.rtp_ricevuto(dati, indirizzo)
        except Exception as e:  # mai far cadere la chiamata per un pacchetto strano
            log("rtp errore", e)


class Scarta(asyncio.DatagramProtocol):
    def datagram_received(self, dati, indirizzo):
        pass


class Chiamata:
    def __init__(self, app, invite, mittente):
        self.app = app
        self.loop = app.loop
        self.call_id = invite.get("call-id")
        self.invite = invite
        self.mittente = mittente
        self.chiamante = numero_di(invite.get("from")) or "?"
        self.wacid = invite.get("x-wa-meta-wacid")[:80]
        self.lingua = "sq" if invite.get("x-gl-lingua").strip().lower() == "sq" else "it"
        self.lingue_usate = []
        self.mio_tag = "%08x" % random.getrandbits(32)
        self.attiva = True
        self.ack = False
        self.inizio = time.time()
        self.ultimo_rtp = time.time()
        self.ultima_voce = time.time()
        self.motivo = ""
        self.ultima_risposta = b""
        self.cseq_locale = random.randint(1000, 5000)
        self.bye_ok = None
        self.trascrizione = []
        # audio
        self.decoder = Decoder()
        self.encoder = Encoder()
        self.uscita = bytearray()
        self.generazione = 0
        self.coda_tts = asyncio.Queue()
        self.tts_in_corso = False
        self.chiudi_dopo = False
        self.ws = None
        self.coda_ai = asyncio.Queue()
        self.accumulo = bytearray()
        self.prima_della_ai = []     # audio arrivato prima che OpenAI sia pronta (max 3 s)
        self.ultimo_seq = None
        self.risp = None
        self.tts_conn = None
        self.compiti = []
        self.trasporto_rtp = None
        self.trasporto_rtcp = None
        self.remoto = None
        self.pt = None
        self.porta = None
        self.ip = None
        self.sdp_id = random.randint(10 ** 9, 10 ** 10)
        self.ultimo_parlato = time.time()

    # -------------------------------------------------------------- avvio
    async def avvia(self):
        ip, porta_rem, pt = leggi_sdp(self.invite.corpo)
        if not ip or not porta_rem or pt is None:
            self.app.rispondi(self.invite, self.mittente, 488, "Not Acceptable Here")
            log(self.call_id[:12], "SDP senza Opus: 488")
            return False
        self.remoto, self.pt, self.ip = (ip, porta_rem), pt, ip
        if not await self.apri_rtp():
            self.app.rispondi(self.invite, self.mittente, 503, "Service Unavailable")
            return False
        sdp = self.sdp_risposta()
        rr = ["Record-Route: " + v for v in self.invite.tutti("record-route")]
        self.ultima_risposta = self.app.costruisci_risposta(
            self.invite, 200, "OK", self.mio_tag,
            rr + ["Contact: <sip:assistente@%s:%d>" % (SIP_IP, SIP_PORTA),
                  "Allow: INVITE, ACK, BYE, CANCEL, OPTIONS, UPDATE, INFO"],
            sdp, "application/sdp")
        self.app.manda(self.ultima_risposta, self.mittente)
        log(self.call_id[:12], "risposta 200 · chiamante", self.chiamante, "· lingua", self.lingua,
            "· audio", "%s:%d pt %d" % (ip, porta_rem, pt), "· porta", self.porta)
        self.compiti = [
            asyncio.ensure_future(self.ritrasmetti_200()),
            asyncio.ensure_future(self.trasmetti()),
            asyncio.ensure_future(self.sintesi()),
            asyncio.ensure_future(self.ai()),
            asyncio.ensure_future(self.invia_ai()),
            asyncio.ensure_future(self.sorveglia()),
        ]
        saluto = self.app.saluti.get(self.lingua) or (SALUTI_PREDEFINITI.get(self.lingua), b"")
        if saluto and saluto[1]:
            self.uscita.extend(saluto[1])          # saluto già pronto: parte subito
            self.trascrizione.append("AI: " + saluto[0])
        elif saluto and saluto[0]:
            self.coda_tts.put_nowait((self.generazione, saluto[0], self.lingua))
            self.trascrizione.append("AI: " + saluto[0])
        asyncio.ensure_future(self.app.evento("inizio", self.chiamante, "lingua " + self.lingua + " · wacid " + self.wacid))
        return True

    async def apri_rtp(self):
        porte = list(range(RTP_MIN, RTP_MAX, 2))
        random.shuffle(porte)
        for p in porte[:60]:
            if p in self.app.porte_usate:
                continue
            try:
                t1, _ = await self.loop.create_datagram_endpoint(lambda: Rtp(self), local_addr=("0.0.0.0", p))
            except OSError:
                continue
            try:
                t2, _ = await self.loop.create_datagram_endpoint(Scarta, local_addr=("0.0.0.0", p + 1))
            except OSError:
                t1.close()
                continue
            self.trasporto_rtp, self.trasporto_rtcp, self.porta = t1, t2, p
            self.app.porte_usate.add(p)
            return True
        return False

    def sdp_risposta(self):
        return "\r\n".join([
            "v=0", "o=- %d 1 IN IP4 %s" % (self.sdp_id, self.ip), "s=Giornale Lavori", "c=IN IP4 %s" % self.ip, "t=0 0",
            "m=audio %d RTP/AVP %d" % (self.porta, self.pt),
            "a=rtpmap:%d opus/48000/2" % self.pt,
            "a=fmtp:%d useinbandfec=1;stereo=0;sprop-stereo=0" % self.pt,
            "a=ptime:20", "a=sendrecv", ""])

    async def ritrasmetti_200(self):
        attesa = 0.5
        for _ in range(9):
            await asyncio.sleep(attesa)
            if self.ack or not self.attiva:
                return
            self.app.manda(self.ultima_risposta, self.mittente)
            attesa = min(attesa * 2, 4.0)
        if not self.ack:
            log(self.call_id[:12], "ACK mai arrivato")

    # -------------------------------------------------------------- RTP
    def rtp_ricevuto(self, dati, indirizzo):
        if len(dati) < 12 or not self.attiva:
            return
        b0, b1, seq = dati[0], dati[1], struct.unpack("!H", dati[2:4])[0]
        if b0 >> 6 != 2:
            return
        if indirizzo[0] != self.ip:
            return                          # pacchetti da altri indirizzi: ignorati
        if self.remoto != indirizzo:      # l'audio arriva da qui: si risponde qui
            self.remoto = indirizzo
        pt = b1 & 0x7F
        if pt != self.pt:
            return
        off = 12 + 4 * (b0 & 0x0F)
        if b0 & 0x10:
            if len(dati) < off + 4:
                return
            off += 4 + 4 * struct.unpack("!H", dati[off + 2:off + 4])[0]
        fine = len(dati) - (dati[-1] if b0 & 0x20 else 0)
        if off >= fine:
            return
        self.ultimo_rtp = time.time()
        if self.ultimo_seq is not None:
            salto = (seq - self.ultimo_seq) & 0xFFFF
            if salto == 0 or salto > 0x8000:
                return                      # duplicato o fuori ordine
            for _ in range(min(salto - 1, 5)):
                self.accumula(self.decoder.decodifica(None))
        self.ultimo_seq = seq
        self.accumula(self.decoder.decodifica(dati[off:fine]))

    def accumula(self, pcm):
        if not pcm:
            return
        self.accumulo.extend(pcm)
        if len(self.accumulo) >= INVIO_AI:
            pezzo = bytes(self.accumulo)
            self.accumulo.clear()
            if self.ws is None:
                self.prima_della_ai.append(pezzo)
                if len(self.prima_della_ai) > 30:
                    self.prima_della_ai.pop(0)
            else:
                self.coda_ai.put_nowait(pezzo)

    async def trasmetti(self):
        seq = random.randint(0, 0xFFFF)
        ts = random.randint(0, 0xFFFFFFFF)
        ssrc = random.randint(1, 0xFFFFFFFF)
        primo = True
        prossimo = self.loop.time()
        in_attesa = False
        while self.attiva:
            prossimo += 0.02
            pronti = len(self.uscita)
            if in_attesa and (pronti >= 3 * FRAME or (not self.tts_in_corso and self.coda_tts.empty())):
                in_attesa = False
            if pronti >= FRAME and not in_attesa:
                frame = bytes(self.uscita[:FRAME])
                del self.uscita[:FRAME]
                self.ultimo_parlato = time.time()
            elif pronti and not in_attesa and not self.tts_in_corso:
                frame = bytes(self.uscita) + b"\0" * (FRAME - pronti)
                self.uscita.clear()
            else:
                frame = SILENZIO
                if pronti == 0 and self.tts_in_corso:
                    in_attesa = True        # la frase sta arrivando: si aspettano 60 ms di scorta
            pacchetto = self.encoder.codifica(frame)
            if pacchetto and self.remoto and self.trasporto_rtp:
                testa = struct.pack("!BBHII", 0x80, (0x80 if primo else 0) | self.pt, seq, ts, ssrc)
                self.trasporto_rtp.sendto(testa + pacchetto, self.remoto)
                primo = False
            seq = (seq + 1) & 0xFFFF
            ts = (ts + PASSO_TS) & 0xFFFFFFFF
            if self.chiudi_dopo and not self.uscita and not self.tts_in_corso and self.coda_tts.empty():
                self.chiudi_dopo = False
                asyncio.ensure_future(self.riaggancia("l'assistente ha chiuso", 0.6))
            ritardo = prossimo - self.loop.time()
            if ritardo > 0:
                await asyncio.sleep(ritardo)
            elif ritardo < -0.3:
                prossimo = self.loop.time()

    def sta_parlando(self):
        return bool(self.uscita) or self.tts_in_corso or not self.coda_tts.empty()

    def interrompi(self):
        if self.sta_parlando():
            self.generazione += 1
            self.uscita.clear()
            while not self.coda_tts.empty():
                self.coda_tts.get_nowait()
            self.chiudi_dopo = False
            return True
        return False

    # -------------------------------------------------------------- voce (TTS dal relay)
    async def sintesi(self):
        while self.attiva:
            gen, testo, lingua = await self.coda_tts.get()
            if gen != self.generazione or not self.attiva:
                continue
            self.tts_in_corso = True
            try:
                esito = await self.loop.run_in_executor(self.app.pool, self.sintesi_bloccante, gen, testo, lingua)
                stato, fornitore, byte, info = esito
                if stato != 200:
                    log(self.call_id[:12], "voce NON riuscita", stato, fornitore, info)
                    asyncio.ensure_future(self.app.evento("errore", self.chiamante, "voce %s %s %s" % (stato, fornitore, str(info)[:200])))
                elif isinstance(info, float):
                    log(self.call_id[:12], "voce", lingua, fornitore, "primo audio %.0f ms" % (info * 1000), "·", byte // 48, "ms")
            except Exception as e:
                log(self.call_id[:12], "voce errore", e)
            finally:
                self.tts_in_corso = False

    def sintesi_bloccante(self, gen, testo, lingua):
        corpo = json.dumps({"testo": testo, "lingua": lingua}).encode()
        t0 = time.time()
        totale, primo, resto = 0, None, b""
        for tentativo in (1, 2):
            c = self.tts_conn or self.app.relay.connessione(20)
            self.tts_conn = c
            try:
                c.request("POST", self.app.relay.prefisso + "/centralino/tts", body=corpo, headers=self.app.relay.intestazioni())
                r = c.getresponse()
                fornitore = r.getheader("X-GL-Fornitore", "?")
                if r.status != 200:
                    return r.status, fornitore, 0, r.read()[:200]
                while True:
                    if gen != self.generazione or not self.attiva:
                        c.close()
                        self.tts_conn = None
                        return 200, fornitore, totale, "interrotta"
                    pezzo = r.read1(8192) if hasattr(r, "read1") else r.read(4096)
                    if not pezzo:
                        break
                    if primo is None:
                        primo = time.time() - t0
                    pezzo = resto + pezzo
                    n = len(pezzo) & ~1
                    resto = pezzo[n:]
                    if n:
                        self.loop.call_soon_threadsafe(self.aggiungi_audio, gen, pezzo[:n])
                        totale += n
                return 200, fornitore, totale, primo
            except (http.client.HTTPException, OSError) as e:
                try:
                    c.close()
                except Exception:
                    pass
                self.tts_conn = None
                if tentativo == 2 or totale:
                    return 0, "?", totale, str(e)[:200]
        return 0, "?", totale, "nessun tentativo"

    def aggiungi_audio(self, gen, pcm):
        if gen == self.generazione and self.attiva:
            self.uscita.extend(pcm)

    def accoda_frase(self, testo, lingua):
        testo = pulisci(testo)
        if not testo or not re.search(r"\w", testo):
            return
        self.coda_tts.put_nowait((self.generazione, testo, lingua))

    # -------------------------------------------------------------- OpenAI Realtime (solo testo)
    async def ai(self):
        try:
            stato, ses = await self.loop.run_in_executor(
                self.app.pool, lambda: self.app.relay.json("POST", "/centralino/sessione",
                                                           {"chiamante": self.chiamante, "lingua": self.lingua, "wacid": self.wacid}, 12))
        except Exception as e:
            stato, ses = 0, {"errore": str(e)[:200]}
        if stato != 200 or not ses.get("ok"):
            log(self.call_id[:12], "sessione NON ottenuta", stato, ses.get("errore"))
            await self.app.evento("errore", self.chiamante, "sessione %s %s" % (stato, str(ses.get("errore"))[:300]))
            await self.scusa_e_chiudi()
            return
        oa = ses["openai"]
        self.max_secondi = int(ses.get("max_secondi") or 900)
        try:
            self.ws = await asyncio.wait_for(
                ws_connect(oa["url"], max_size=None, ping_interval=20, open_timeout=10,
                           **{WS_HEADER: {"Authorization": "Bearer " + oa["chiave"]}}), 15)
        except Exception as e:
            log(self.call_id[:12], "OpenAI non raggiungibile", e)
            await self.app.evento("errore", self.chiamante, "OpenAI non raggiungibile: " + str(e)[:300])
            self.ws = None
            await self.scusa_e_chiudi()
            return
        try:
            await self.ws.send(json.dumps({"type": "session.update", "session": oa["sessione"]}))
            for pezzo in self.prima_della_ai[-20:]:
                self.coda_ai.put_nowait(pezzo)
            self.prima_della_ai = []
            log(self.call_id[:12], "OpenAI collegata", ses.get("modello", ""))
            async for grezzo in self.ws:
                if not self.attiva:
                    break
                try:
                    ev = json.loads(grezzo)
                except ValueError:
                    continue
                self.evento_ai(ev)
        except Exception as e:
            if self.attiva:
                log(self.call_id[:12], "OpenAI interrotta", e)
                await self.app.evento("errore", self.chiamante, "OpenAI interrotta: " + str(e)[:300])
                await self.scusa_e_chiudi()
        finally:
            ws, self.ws = self.ws, None
            if ws is not None:
                try:
                    await ws.close()
                except Exception:
                    pass

    async def invia_ai(self):
        while self.attiva:
            pezzo = await self.coda_ai.get()
            if pezzo is None or not self.attiva:
                break
            ws = self.ws
            if ws is None:
                continue
            try:
                await ws.send(json.dumps({"type": "input_audio_buffer.append", "audio": base64.b64encode(pezzo).decode()}))
            except Exception:
                pass

    def evento_ai(self, ev):
        tipo = ev.get("type", "")
        if tipo == "input_audio_buffer.speech_started":
            self.ultima_voce = time.time()
            if self.interrompi():
                log(self.call_id[:12], "interrotta dalla persona")
        elif tipo == "input_audio_buffer.speech_stopped":
            self.ultima_voce = time.time()
        elif tipo == "response.created":
            self.risp = {"buf": "", "lingua": None, "frasi": 0, "testo": ""}
        elif tipo == "response.output_text.delta":
            if self.risp is None:
                self.risp = {"buf": "", "lingua": None, "frasi": 0, "testo": ""}
            self.su_testo(ev.get("delta", ""))
        elif tipo == "response.output_text.done":
            self.chiudi_testo()
        elif tipo == "response.function_call_arguments.done":
            if ev.get("name") == "termina_chiamata":
                log(self.call_id[:12], "l'assistente chiude la chiamata")
                self.chiudi_dopo = True
        elif tipo == "response.output_item.done":
            item = ev.get("item") or {}
            if item.get("type") == "function_call" and item.get("name") == "termina_chiamata":
                self.chiudi_dopo = True
        elif tipo == "conversation.item.input_audio_transcription.completed":
            t = str(ev.get("transcript", "")).strip()
            if t:
                self.trascrizione.append("Persona: " + t)
        elif tipo == "response.done":
            r = ev.get("response") or {}
            if r.get("status") == "failed":
                log(self.call_id[:12], "risposta fallita", json.dumps(r.get("status_details"))[:300])
        elif tipo == "error":
            err = ev.get("error") or {}
            log(self.call_id[:12], "OpenAI errore", err.get("code"), str(err.get("message"))[:300])
            asyncio.ensure_future(self.app.evento("errore", self.chiamante, "OpenAI: %s %s" % (err.get("code"), str(err.get("message"))[:300])))
        elif tipo in ("session.updated",):
            log(self.call_id[:12], "sessione OpenAI impostata")

    def su_testo(self, delta):
        r = self.risp
        r["buf"] += delta
        r["testo"] += delta
        if r["lingua"] is None:
            m = ETICHETTA.match(r["buf"])
            if m:
                r["lingua"] = m.group(1).lower()[:2]
                r["buf"] = r["buf"][m.end():]
            elif len(r["buf"]) >= 12 or (r["buf"].strip() and not r["buf"].lstrip().startswith("[")):
                r["lingua"] = indovina_lingua(r["buf"], self.lingua)
            else:
                return
            if r["lingua"] == "al":
                r["lingua"] = "sq"
            if r["lingua"] != self.lingua:
                log(self.call_id[:12], "lingua", self.lingua, "→", r["lingua"])
            self.lingua = r["lingua"]
            if r["lingua"] not in self.lingue_usate:
                self.lingue_usate.append(r["lingua"])
        while True:
            n = taglio(r["buf"], r["frasi"] == 0)
            if n is None:
                break
            frase, r["buf"] = r["buf"][:n], r["buf"][n:]
            self.accoda_frase(frase, r["lingua"])
            r["frasi"] += 1

    def chiudi_testo(self):
        r = self.risp
        if not r:
            return
        if r["lingua"] is None:
            r["lingua"] = indovina_lingua(r["buf"], self.lingua)
            self.lingua = r["lingua"]
        if r["buf"].strip():
            self.accoda_frase(r["buf"], r["lingua"])
        testo = pulisci(r["testo"])
        if testo:
            self.trascrizione.append("AI: " + testo)
        self.risp = None

    # -------------------------------------------------------------- sorveglianza e chiusura
    async def sorveglia(self):
        avvisato = False
        while self.attiva:
            await asyncio.sleep(1)
            ora = time.time()
            if ora - self.ultimo_rtp > 25:
                await self.riaggancia("nessun audio da 25 s", 0)
                return
            if ora - self.inizio > getattr(self, "max_secondi", 900):
                await self.riaggancia("durata massima", 0)
                return
            muto = ora - max(self.ultima_voce, self.ultimo_parlato, self.inizio)
            if self.ws is not None and not self.sta_parlando():
                if muto > 40 and not avvisato:
                    avvisato = True
                    try:
                        await self.ws.send(json.dumps({"type": "response.create", "response": {
                            "instructions": "La persona non parla da un po'. Chiedi con gentilezza, in una frase, se è ancora in linea. Usa la lingua della conversazione e inizia con l'etichetta della lingua."}}))
                    except Exception:
                        pass
                elif muto > 70:
                    await self.riaggancia("silenzio", 0)
                    return
            if muto < 40:
                avvisato = False

    async def scusa_e_chiudi(self):
        if not self.attiva:
            return
        testo = ("Mi dispiace, in questo momento non riesco a rispondere. Scrivi pure in chat WhatsApp a questo numero."
                 if self.lingua != "sq" else
                 "Më vjen keq, tani nuk mund të përgjigjem. Ju lutem shkruani në WhatsApp në këtë numër.")
        self.accoda_frase(testo, self.lingua)
        self.chiudi_dopo = True

    async def riaggancia(self, motivo, attesa):
        if not self.attiva:
            return
        if attesa:
            await asyncio.sleep(attesa)
        if not self.attiva:
            return
        self.motivo = motivo
        log(self.call_id[:12], "chiudo:", motivo)
        await self.manda_bye()
        self.fine(motivo)

    async def manda_bye(self):
        inv = self.invite
        rotte = []
        for v in inv.tutti("record-route"):
            rotte += dividi(v)
        destinazione_uri = uri_di(inv.get("contact")) or uri_di(inv.get("from"))
        self.cseq_locale += 1
        ramo = "z9hG4bK%016x" % random.getrandbits(64)
        righe = ["BYE %s SIP/2.0" % destinazione_uri,
                 "Via: SIP/2.0/UDP %s:%d;branch=%s;rport" % (SIP_IP, SIP_PORTA, ramo),
                 "Max-Forwards: 70",
                 "From: %s" % (inv.get("to") if tag_di(inv.get("to")) else inv.get("to") + ";tag=" + self.mio_tag),
                 "To: %s" % inv.get("from"),
                 "Call-ID: %s" % self.call_id,
                 "CSeq: %d BYE" % self.cseq_locale]
        righe += ["Route: %s" % r for r in rotte]
        righe += ["User-Agent: GL-Voce/3", "Content-Length: 0"]
        dati = ("\r\n".join(righe) + "\r\n\r\n").encode()
        dest = (SIP_IP, 5060)
        if rotte:
            u = uri_di(rotte[0])
            m = re.match(r"sips?:(?:[^@]*@)?\[?([0-9a-fA-F.:]+?)\]?(?::(\d+))?(?:;|$)", u)
            if m:
                dest = (m.group(1), int(m.group(2) or 5060))
        self.bye_ok = asyncio.Event()
        attesa = 0.5
        for _ in range(6):
            self.app.manda(dati, dest)
            try:
                await asyncio.wait_for(self.bye_ok.wait(), attesa)
                return
            except asyncio.TimeoutError:
                attesa = min(attesa * 2, 4)

    def fine(self, motivo):
        if not self.attiva:
            return
        self.attiva = False
        self.motivo = self.motivo or motivo
        for t in self.compiti:
            t.cancel()
        self.coda_ai.put_nowait(None)
        if self.ws is not None:
            asyncio.ensure_future(self.ws.close())
        for t in (self.trasporto_rtp, self.trasporto_rtcp):
            if t:
                t.close()
        self.app.porte_usate.discard(self.porta)
        self.decoder.chiudi()
        self.encoder.chiudi()
        if self.tts_conn:
            try:
                self.tts_conn.close()
            except Exception:
                pass
        durata = int(time.time() - self.inizio)
        log(self.call_id[:12], "fine chiamata:", self.motivo, "·", durata, "s")
        dettaglio = "durata %d s · motivo %s · lingue %s · wacid %s\n%s" % (
            durata, self.motivo, ",".join(self.lingue_usate) or self.lingua, self.wacid, "\n".join(self.trascrizione))
        asyncio.ensure_future(self.app.evento("fine", self.chiamante, dettaglio[:3800]))
        self.app.chiamata_finita(self.call_id)


# ---------------------------------------------------------------------------- server SIP
class App(asyncio.DatagramProtocol):
    def __init__(self, loop):
        self.loop = loop
        self.relay = Relay(RELAY, TOKEN)
        self.pool = ThreadPoolExecutor(max_workers=24)
        self.chiamate = {}
        self.finite = {}
        self.porte_usate = set()
        self.saluti = {}
        self.trasporto = None

    def connection_made(self, trasporto):
        self.trasporto = trasporto

    def manda(self, dati, indirizzo):
        if self.trasporto:
            self.trasporto.sendto(dati, indirizzo)

    def costruisci_risposta(self, req, codice, motivo, mio_tag=None, extra=(), corpo="", tipo=None):
        righe = ["SIP/2.0 %d %s" % (codice, motivo)]
        righe += ["Via: " + v for v in req.tutti("via")]
        righe.append("From: " + req.get("from"))
        to = req.get("to")
        if mio_tag and not tag_di(to):
            to += ";tag=" + mio_tag
        righe.append("To: " + to)
        righe.append("Call-ID: " + req.get("call-id"))
        righe.append("CSeq: " + req.get("cseq"))
        righe += list(extra)
        righe.append("Server: GL-Voce/3")
        dati_corpo = corpo.encode() if corpo else b""
        if dati_corpo:
            righe.append("Content-Type: " + (tipo or "application/sdp"))
        righe.append("Content-Length: %d" % len(dati_corpo))
        return ("\r\n".join(righe) + "\r\n\r\n").encode() + dati_corpo

    def rispondi(self, req, indirizzo, codice, motivo, mio_tag=None, extra=(), corpo="", tipo=None):
        self.manda(self.costruisci_risposta(req, codice, motivo, mio_tag, extra, corpo, tipo), indirizzo)

    def datagram_received(self, dati, indirizzo):
        try:
            if len(dati) < 20 or dati[:4] in (b"\r\n\r\n",):
                return
            msg = Sip(dati)
            if msg.risposta:
                self.risposta_ricevuta(msg)
            else:
                self.richiesta(msg, indirizzo)
        except Exception as e:
            log("SIP errore", e)

    def risposta_ricevuta(self, msg):
        c = self.chiamate.get(msg.get("call-id")) or self.finite.get(msg.get("call-id"))
        _, metodo = msg.cseq()
        if c is not None and metodo == "BYE" and msg.codice >= 200 and c.bye_ok is not None:
            c.bye_ok.set()

    def richiesta(self, msg, indirizzo):
        metodo = msg.metodo
        cid = msg.get("call-id")
        c = self.chiamate.get(cid)
        if metodo == "INVITE":
            if tag_di(msg.get("to")):
                if c is None:
                    self.rispondi(msg, indirizzo, 481, "Call/Transaction Does Not Exist")
                    return
                ip, porta, pt = leggi_sdp(msg.corpo) if msg.corpo else (None, None, None)
                if ip and porta:
                    c.remoto = (ip, porta)
                if pt is not None:
                    c.pt = pt
                c.ack = False
                c.ultima_risposta = self.costruisci_risposta(
                    msg, 200, "OK", None, ["Contact: <sip:assistente@%s:%d>" % (SIP_IP, SIP_PORTA)],
                    c.sdp_risposta() if msg.corpo else "", "application/sdp")
                self.manda(c.ultima_risposta, indirizzo)
                return
            if c is not None:                   # INVITE ripetuto: stessa risposta di prima
                if c.ultima_risposta:
                    self.manda(c.ultima_risposta, indirizzo)
                return
            if cid in self.finite:
                return
            if len(self.chiamate) >= MAX_CHIAMATE:
                self.rispondi(msg, indirizzo, 486, "Busy Here")
                log("chiamata rifiutata: troppe chiamate insieme")
                return
            self.rispondi(msg, indirizzo, 100, "Trying")
            c = Chiamata(self, msg, indirizzo)
            self.chiamate[cid] = c
            self.scrivi_stato()
            asyncio.ensure_future(self.avvia(c))
        elif metodo == "ACK":
            if c is not None:
                c.ack = True
        elif metodo == "BYE":
            self.rispondi(msg, indirizzo, 200, "OK")
            if c is not None:
                c.fine("chi chiama ha riattaccato")
        elif metodo == "CANCEL":
            self.rispondi(msg, indirizzo, 200, "OK")
            if c is not None and not c.ack:
                self.rispondi(c.invite, c.mittente, 487, "Request Terminated", c.mio_tag)
                c.fine("annullata")
        elif metodo in ("OPTIONS", "INFO", "UPDATE", "NOTIFY", "PRACK"):
            self.rispondi(msg, indirizzo, 200, "OK")
        else:
            self.rispondi(msg, indirizzo, 405, "Method Not Allowed")

    async def avvia(self, c):
        try:
            ok = await c.avvia()
        except Exception as e:
            log("avvio chiamata non riuscito", e)
            ok = False
            self.rispondi(c.invite, c.mittente, 500, "Server Internal Error", c.mio_tag)
        if not ok:
            c.attiva = False
            self.chiamate.pop(c.call_id, None)
            self.scrivi_stato()

    def chiamata_finita(self, cid):
        c = self.chiamate.pop(cid, None)
        if c is not None:
            self.finite[cid] = c
            self.loop.call_later(40, self.finite.pop, cid, None)
        self.scrivi_stato()

    def scrivi_stato(self):
        try:
            os.makedirs(os.path.dirname(FILE_STATO), exist_ok=True)
            with open(FILE_STATO, "w") as f:
                f.write("%d\n" % len(self.chiamate))
        except OSError:
            pass

    async def evento(self, tipo, chiamante, dettaglio):
        try:
            await self.loop.run_in_executor(self.pool, lambda: self.relay.json(
                "POST", "/centralino/evento", {"tipo": tipo, "chiamante": chiamante, "dettaglio": dettaglio}, 8))
        except Exception as e:
            log("evento non registrato", tipo, e)

    async def prepara_saluti(self):
        """Saluti sintetizzati in anticipo: all'inizio della chiamata la voce parte senza attese."""
        while True:
            try:
                stato, j = await self.loop.run_in_executor(self.pool, lambda: self.relay.json("GET", "/centralino/saluti", None, 10))
                if stato == 200:
                    for lingua, testo in (j.get("saluti") or {}).items():
                        vecchio = self.saluti.get(lingua)
                        if vecchio and vecchio[0] == testo and vecchio[1]:
                            continue
                        st, forn, pcm = await self.loop.run_in_executor(self.pool, self.relay.tts_tutto, testo, lingua)
                        if st == 200 and len(pcm) > 4800:
                            self.saluti[lingua] = (testo, pcm[: len(pcm) & ~1])
                            log("saluto pronto:", lingua, forn, len(pcm) // 48, "ms")
                        else:
                            self.saluti[lingua] = (testo, b"")
                            log("saluto NON pronto:", lingua, st, forn)
            except Exception as e:
                log("saluti non aggiornati", e)
            await asyncio.sleep(600)


async def principale():
    global OPUS
    OPUS = Opus()
    loop = asyncio.get_running_loop()
    trasporto, app = await loop.create_datagram_endpoint(lambda: App(loop), local_addr=(SIP_IP, SIP_PORTA))
    app.scrivi_stato()
    log(VERSIONE, "in ascolto su %s:%d · relay %s" % (SIP_IP, SIP_PORTA, RELAY))
    asyncio.ensure_future(app.prepara_saluti())
    await asyncio.Event().wait()


async def prova():
    """Controllo completo senza chiamate: relay, voci, chiave OpenAI temporanea, collegamento a OpenAI."""
    global OPUS
    OPUS = Opus()
    loop = asyncio.get_running_loop()
    relay = Relay(RELAY, TOKEN)
    pool = ThreadPoolExecutor(max_workers=4)
    esiti = [VERSIONE]
    e = Encoder()
    d = Decoder()
    pcm = b"".join(struct.pack("<h", int(8000 * __import__("math").sin(i / 10.0))) for i in range(480))
    pac = e.codifica(pcm)
    esiti.append("opus: %d byte → %d byte decodificati" % (len(pac), len(d.decodifica(pac))))
    stato, j = await loop.run_in_executor(pool, lambda: relay.json("GET", "/centralino/saluti", None, 10))
    esiti.append("saluti: %s %s" % (stato, ",".join(sorted((j.get("saluti") or {}).keys()))))
    for lingua, testo in (j.get("saluti") or {}).items():
        t0 = time.time()
        st, forn, dati = await loop.run_in_executor(pool, relay.tts_tutto, testo, lingua)
        esiti.append("voce %s: %s %s %d ms di audio in %.1f s" % (lingua, st, forn, len(dati) // 48, time.time() - t0))
    stato, ses = await loop.run_in_executor(pool, lambda: relay.json("POST", "/centralino/sessione", {"chiamante": "prova", "lingua": "sq"}, 12))
    esiti.append("sessione: %s %s" % (stato, "ok" if ses.get("ok") else ses.get("errore")))
    if ses.get("ok"):
        try:
            oa = ses["openai"]
            ws = await asyncio.wait_for(ws_connect(oa["url"], max_size=None, open_timeout=10,
                                                   **{WS_HEADER: {"Authorization": "Bearer " + oa["chiave"]}}), 15)
            await ws.send(json.dumps({"type": "session.update", "session": oa["sessione"]}))
            tipi = []
            try:
                while True:
                    ev = json.loads(await asyncio.wait_for(ws.recv(), 6))
                    tipi.append(ev.get("type") + ("(" + str((ev.get("error") or {}).get("message"))[:160] + ")" if ev.get("type") == "error" else ""))
                    if ev.get("type") in ("session.updated", "error"):
                        break
            except asyncio.TimeoutError:
                tipi.append("(nessuna risposta in 6 s)")
            await ws.close()
            esiti.append("openai: " + " · ".join(tipi))
        except Exception as ex:
            esiti.append("openai: NON collegata " + str(ex)[:200])
    print("\n".join(esiti), flush=True)
    try:
        await loop.run_in_executor(pool, lambda: relay.json("POST", "/centralino/evento",
                                                            {"tipo": "prova", "chiamante": "centralino", "dettaglio": "\n".join(esiti)}, 8))
    except Exception:
        pass


if __name__ == "__main__":
    if "--prova" in sys.argv:
        asyncio.run(prova())
    else:
        asyncio.run(principale())
