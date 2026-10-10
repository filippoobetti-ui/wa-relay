// Server locale di collaudo: passa ogni richiesta alla VERA portaleRoute del worker (copia index.mjs),
// con fetch verso Supabase sostituita dalle pagine di prova. Cosi' si collauda esattamente il codice che andra' in produzione.
import http from "node:http";
import { elenco, cantiere, TOKEN } from "./pagine.mjs";
const mod = await import("./index.mjs") /* copia di src/index.js con in coda: export { portaleRoute, portaleMovimenti, PORTALE_MOVIMENTI_STILE, PORTALE_MOVIMENTI_SCRIPT }; */;
const { portaleRoute } = mod;

globalThis.fetch = async (url, init) => {
  if (String(url).includes("/rest/v1/rpc/dashboard_html")) {
    const body = JSON.parse(init.body || "{}");
    const html = body.p_commessa ? cantiere() : elenco();
    const valido = body.p_token === TOKEN;
    return new Response(JSON.stringify(valido ? html : "<!DOCTYPE html><html><body>Collegamento non attivo</body></html>"), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response("no", { status: 502 });
};

const env = { SUPABASE_SERVICE_KEY: "prova", ASSETS: { fetch: async () => new Response(null, { status: 404 }) } };

const server = http.createServer(async (req, res) => {
  try {
    // comando di prova (esiste solo in questo server): /__prova/movimenti?v=off imposta MOVIMENTI=off, v=on la toglie
    const cmd = req.url.match(/^\/__prova\/movimenti\?v=(off|on)$/);
    if (cmd) {
      if (cmd[1] === "off") env.MOVIMENTI = "off"; else delete env.MOVIMENTI;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("MOVIMENTI=" + (env.MOVIMENTI || "(non impostata)"));
      return;
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const request = new Request("https://app.ilgiornalelavori.test" + req.url, { method: req.method, headers });
    const r = await portaleRoute(request, env, "");
    const out = {};
    r.headers.forEach((v, k) => { if (k.toLowerCase() === "set-cookie") return; out[k] = v; });
    const sc = r.headers.get("set-cookie");
    if (sc) out["set-cookie"] = sc.replace("; Secure", ""); // in locale siamo su http
    res.writeHead(r.status, out);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("errore server di prova: " + (e && e.stack || e));
  }
});
server.listen(8787, "127.0.0.1", () => console.log("server di prova su http://127.0.0.1:8787/"));
