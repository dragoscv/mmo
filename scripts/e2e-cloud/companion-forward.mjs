#!/usr/bin/env node
/**
 * Runs ON the cloud E2E VM: listens on 127.0.0.1:<COMPANION_LOCAL_PORT> (default 17899) and
 * forwards HTTP + WebSocket upgrades to COMPANION_TUNNEL_URL (a Cloudflare quick tunnel to the
 * workstation's MMO Server). The paired device row keeps its loopback api_url
 * (http://127.0.0.1:17899), so the web app on the VM and the browser both reach the real
 * companion without any write to the `devices` table.
 *
 * The Host header becomes the tunnel host, so the companion's loopback-only public routes
 * (Host must be localhost) stay closed to the internet; token routes work as usual.
 */
import http from "node:http";
import https from "node:https";
import tls from "node:tls";

const target = new URL(process.env.COMPANION_TUNNEL_URL ?? "");
const port = Number(process.env.COMPANION_LOCAL_PORT ?? 17899);
const agent = new https.Agent({ keepAlive: true, maxSockets: 64 });
let n = 0;

const server = http.createServer((req, res) => {
    const headers = { ...req.headers, host: target.host };
    const up = https.request(
        { host: target.hostname, port: 443, servername: target.hostname, method: req.method, path: req.url, headers, agent },
        (r) => {
            res.writeHead(r.statusCode ?? 502, r.headers);
            r.pipe(res);
        },
    );
    up.setTimeout(60_000, () => up.destroy(new Error("upstream timeout")));
    up.on("error", (e) => {
        console.log(`[fwd] ${req.method} ${req.url?.split("?")[0]} -> error ${e.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end(`companion-forward: ${e.message}`);
    });
    if (++n % 200 === 1) console.log(`[fwd] request #${n} ${req.method} ${req.url?.split("?")[0]}`);
    req.pipe(up);
});

server.on("upgrade", (req, sock, head) => {
    const up = tls.connect(443, target.hostname, { servername: target.hostname }, () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`, `host: ${target.host}`];
        for (const [k, v] of Object.entries(req.headers)) {
            if (k === "host") continue;
            for (const x of [].concat(v)) lines.push(`${k}: ${x}`);
        }
        up.write(lines.join("\r\n") + "\r\n\r\n");
        if (head?.length) up.write(head);
        up.pipe(sock);
        sock.pipe(up);
    });
    up.on("error", () => sock.destroy());
    sock.on("error", () => up.destroy());
});

server.listen(port, "127.0.0.1", () => console.log(`[fwd] 127.0.0.1:${port} -> ${target.origin}`));
