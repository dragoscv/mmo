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

    // Security: validate callbackUrl is localhost only
    const isLocalCallback =
        callbackUrl.startsWith("http://localhost:") ||
        callbackUrl.startsWith("http://127.0.0.1:");

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
        var REG = ${JSON.stringify({ hostname, os, port: Number(port), apiUrl })};
        var STATE = ${JSON.stringify(state)};
        var CALLBACK = ${JSON.stringify(isLocalCallback ? callbackUrl : "")};
        var WEB_APP_URL = ${JSON.stringify(request.nextUrl.origin)};

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
                    root.innerHTML = '<div class="icon">\\u2717</div><h2 class="error">Auth Failed</h2><p>' + e.message + '</p>';
                }
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
                        '<p>Signed in as <span class="name">' + (data.userName || data.userEmail || "user") + '</span></p>' +
                        '<p style="margin-top:12px;font-size:11px;color:#3f3f46">You can close this tab.</p>';
                }
            } catch (e) {
                root.innerHTML = '<div class="icon">\\u2717</div><h2 class="error">Registration Failed</h2><p>' + e.message + '</p>';
            }
        })();
    </script>
</body>
</html>`;

    return new NextResponse(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
    });
}
