import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";

export async function GET(request: NextRequest) {
    const session = await auth();
    const params = request.nextUrl.searchParams;

    const hostname = params.get("hostname") || "";
    const os = params.get("os") || "";
    const port = params.get("port") || "17899";
    const apiUrl = params.get("apiUrl") || "";
    const state = params.get("state") || "";
    const callbackUrl = params.get("callbackUrl") || "";
    const isAuthenticated = !!session?.user?.id;
    // Auto-authorize: when the signed-in user lands here from their own
    // companion (the companion opened the browser, the user just signed
    // in with Google), forcing a separate "Authorize this device" click
    // is friction with no real benefit — the only attack it blocks is a
    // link that points the callbackUrl at a malicious local listener,
    // which would also require that listener to already be running on
    // the user's machine. We mint the token immediately; the small
    // residual risk is acceptable for a one-shot LAN flow.
    const confirmed = true;

    // Security: validate callbackUrl is localhost only
    const isLocalCallback =
        callbackUrl.startsWith("http://localhost:") ||
        callbackUrl.startsWith("http://127.0.0.1:");

    // XSS hardening: JSON.stringify by itself does NOT escape `<`, so a
    // crafted query param like `apiUrl=]}</script><script>...` could
    // break out of the inline <script> below. Apply the canonical
    // escape for embedding JSON in HTML (<, >, &, U+2028, U+2029) so
    // every dynamic value below is safe regardless of caller intent.
    const safeJson = (v: unknown) =>
        JSON.stringify(v)
            .replace(/</g, "\\u003c")
            .replace(/>/g, "\\u003e")
            .replace(/&/g, "\\u0026")
            .replace(/\u2028/g, "\\u2028")
            .replace(/\u2029/g, "\\u2029");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MMO — Connecting</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: #0a0a0a; color: #fafafa;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex; align-items: center; justify-content: center;
            min-height: 100vh;
        }
        .container { text-align: center; padding: 40px; max-width: 360px; }
        .spinner {
            width: 44px; height: 44px;
            border: 3px solid #262626; border-top-color: #a855f7;
            border-radius: 50%;
            animation: spin 0.7s linear infinite;
            margin: 0 auto 20px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .icon { font-size: 52px; margin-bottom: 16px; }
        h2 { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
        p { color: #71717a; font-size: 13px; line-height: 1.5; }
        .success { color: #22c55e; }
        .error { color: #ef4444; }
        .name { color: #a855f7; font-weight: 600; }
    </style>
</head>
<body>
    <div class="container" id="root">
        <div class="spinner"></div>
        <p id="status">Initializing...</p>
    </div>
    <script>
        var AUTH = ${isAuthenticated};
        var CONFIRMED = ${confirmed};
        var REG = ${safeJson({ hostname, os, port: Number(port), apiUrl })};
        var STATE = ${safeJson(state)};
        var CALLBACK = ${safeJson(isLocalCallback ? callbackUrl : "")};
        var WEB_APP_URL = ${safeJson(request.nextUrl.origin)};

        function escHtml(s) {
            return String(s == null ? "" : s).replace(/[&<>"']/g, function(c) {
                return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
            });
        }

        (async function() {
            var root = document.getElementById("root");
            var status = document.getElementById("status");

            if (!AUTH) {
                status.textContent = "Redirecting to Google\\u2026";
                try {
                    var r = await fetch("/api/auth/csrf");
                    var d = await r.json();
                    var form = document.createElement("form");
                    form.method = "POST";
                    form.action = "/api/auth/signin/google";
                    form.innerHTML =
                        '<input type="hidden" name="csrfToken" value="' + d.csrfToken + '">' +
                        '<input type="hidden" name="callbackUrl" value="' + location.href + '">';
                    document.body.appendChild(form);
                    form.submit();
                } catch (e) {
                    root.innerHTML = '<div class="icon">\\u2717</div><h2 class="error">Auth Failed</h2><p>' + escHtml(e.message) + '</p>';
                }
                return;
            }

            if (!CONFIRMED) {
                // Device-name guess for the prompt; matches server-side fallback.
                var prettyOs = REG.os === "win32" ? "Windows" : REG.os === "darwin" ? "macOS" : REG.os === "linux" ? "Linux" : (REG.os || "unknown OS");
                var prettyName = REG.hostname && REG.hostname !== "unknown" ? REG.hostname : prettyOs + " device";
                root.innerHTML =
                    '<div class="icon">\\u{1F511}</div>' +
                    '<h2>Authorize this device?</h2>' +
                    '<p style="margin-top:10px">A companion app is asking to sign in as you and sync your library.</p>' +
                    '<div style="margin:18px 0;padding:14px;background:#171717;border:1px solid #262626;border-radius:8px;text-align:left;font-size:12px;line-height:1.6">' +
                        '<div><span style="color:#71717a">Device:</span> <span class="name">' + escHtml(prettyName) + '</span></div>' +
                        '<div><span style="color:#71717a">OS:</span> ' + escHtml(prettyOs) + '</div>' +
                        '<div><span style="color:#71717a">Local URL:</span> <code style="font-size:11px">' + escHtml(REG.apiUrl) + '</code></div>' +
                    '</div>' +
                    '<div style="display:flex;gap:8px;justify-content:center">' +
                        '<button id="cancelBtn" style="padding:9px 18px;background:#262626;color:#fafafa;border:0;border-radius:6px;cursor:pointer;font-size:13px">Cancel</button>' +
                        '<button id="okBtn" style="padding:9px 18px;background:#a855f7;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">Authorize</button>' +
                    '</div>' +
                    '<p style="margin-top:14px;font-size:11px;color:#52525b">Only authorize devices you recognize. The companion will receive a token that can read and write your library.</p>';
                document.getElementById("cancelBtn").addEventListener("click", function() {
                    root.innerHTML = '<div class="icon">\\u2717</div><h2>Cancelled</h2><p>You can close this tab.</p>';
                });
                document.getElementById("okBtn").addEventListener("click", function() {
                    var u = new URL(window.location.href);
                    u.searchParams.set("confirm", "1");
                    window.location.replace(u.toString());
                });
                return;
            }

            status.textContent = "Registering device\\u2026";
            try {
                var resp = await fetch("/api/devices/auto-register", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(REG),
                });
                if (!resp.ok) throw new Error("Registration failed (" + resp.status + ")");

                var data = await resp.json();

                if (CALLBACK) {
                    // Redirect to companion's local callback with credentials
                    var cbParams = new URLSearchParams({
                        state: STATE,
                        token: data.token || "",
                        deviceId: data.deviceId || "",
                        userName: data.userName || "",
                        userEmail: data.userEmail || "",
                        userImage: data.userImage || "",
                        webAppUrl: WEB_APP_URL,
                    });
                    status.textContent = "Redirecting to companion app\\u2026";
                    window.location.href = CALLBACK + "?" + cbParams.toString();
                } else {
                    root.innerHTML =
                        '<div class="icon success">\\u2713</div>' +
                        '<h2>Connected!</h2>' +
                        '<p>Signed in as <span class="name">' + escHtml(data.userName || data.userEmail || "user") + '</span></p>' +
                        '<p style="margin-top:12px;font-size:11px;color:#3f3f46">You can close this tab.</p>';
                }
            } catch (e) {
                root.innerHTML = '<div class="icon">\\u2717</div><h2 class="error">Registration Failed</h2><p>' + escHtml(e.message) + '</p>';
            }
        })();
    </script>
</body>
</html>`;

    return new NextResponse(html, {
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            // Defence in depth: page mints credentials, so block embedding
            // (clickjack on Authorize button) and stop the local-callback URL
            // (which carries the token in the query string) from leaking via
            // the Referer header to anything the local app subsequently loads.
            "X-Frame-Options": "DENY",
            "Content-Security-Policy": "frame-ancestors 'none'",
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-store",
        },
    });
}
