/**
 * Analyzer setup progress window.
 *
 * A small, branded, always-on-top window shown while the companion provisions
 * the managed Python environment and installs the analyzer dependencies. It is
 * purely informational — the user does nothing. The main app continues loading
 * behind it; this window closes itself when setup finishes (or on error after
 * a short delay).
 *
 * Implementation note: the window loads a self-contained HTML document via a
 * data: URL and receives updates through `webContents.executeJavaScript`, so
 * it needs no preload script or IPC channel wiring.
 */

import { BrowserWindow, nativeTheme } from "electron";
import { pushDebugLog } from "./debug-log";

export interface SetupStep {
    id: string;
    label: string;
}

export interface SetupUpdate {
    /** Overall progress 0..1. */
    pct: number;
    /** Current human-readable status line. */
    msg: string;
    /** Optional per-step states for the checklist. */
    steps?: Array<{ id: string; label: string; state: "pending" | "active" | "done" | "error" }>;
    /** When true, the window switches to an error style and stops the spinner. */
    error?: boolean;
}

let win: BrowserWindow | null = null;

function html(dark: boolean): string {
    const bg = dark ? "#0b0b0f" : "#f7f7fa";
    const fg = dark ? "#e8e8ef" : "#1a1a22";
    const sub = dark ? "#9a9aa8" : "#6a6a78";
    const accent = "#7c5cff";
    const track = dark ? "#1e1e28" : "#e4e4ee";
    return `<!doctype html><html><head><meta charset="utf-8"/>
<style>
  :root { color-scheme: ${dark ? "dark" : "light"}; }
  * { box-sizing: border-box; }
  html,body { margin:0; height:100%; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background:${bg}; color:${fg}; -webkit-user-select:none; cursor:default; }
  .wrap { height:100%; display:flex; flex-direction:column; padding:22px 24px; }
  .title { font-size:15px; font-weight:600; display:flex; align-items:center; gap:9px; }
  .dot { width:9px; height:9px; border-radius:50%; background:${accent}; box-shadow:0 0 0 0 ${accent}80; animation:pulse 1.6s infinite; }
  @keyframes pulse { 0%{box-shadow:0 0 0 0 ${accent}66;} 70%{box-shadow:0 0 0 7px ${accent}00;} 100%{box-shadow:0 0 0 0 ${accent}00;} }
  .sub { color:${sub}; font-size:12px; margin-top:6px; line-height:1.4; }
  .bar { height:7px; border-radius:99px; background:${track}; overflow:hidden; margin-top:16px; }
  .fill { height:100%; width:0%; background:linear-gradient(90deg, ${accent}, #56b6ff); border-radius:99px; transition:width .35s ease; }
  .msg { font-size:12px; color:${fg}; margin-top:12px; min-height:16px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  ul.steps { list-style:none; padding:0; margin:16px 0 0; display:flex; flex-direction:column; gap:7px; }
  ul.steps li { display:flex; align-items:center; gap:9px; font-size:12px; color:${sub}; }
  ul.steps li .ico { width:15px; height:15px; flex:0 0 15px; border-radius:50%; border:1.6px solid ${track}; display:flex; align-items:center; justify-content:center; font-size:9px; }
  li.done { color:${fg}; } li.done .ico { background:${accent}; border-color:${accent}; color:#fff; }
  li.active { color:${fg}; } li.active .ico { border-color:${accent}; border-top-color:transparent; animation:spin .8s linear infinite; }
  li.error { color:#ff6b6b; } li.error .ico { border-color:#ff6b6b; color:#ff6b6b; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .foot { margin-top:auto; color:${sub}; font-size:10.5px; }
</style></head><body>
<div class="wrap">
  <div class="title"><span class="dot" id="dot"></span> Setting up MuzicAI analyzer</div>
  <div class="sub">Installing audio analysis & stem-separation engine. This happens once — you don't need to do anything.</div>
  <div class="bar"><div class="fill" id="fill"></div></div>
  <div class="msg" id="msg">Starting…</div>
  <ul class="steps" id="steps"></ul>
  <div class="foot">You can keep using the app while this finishes.</div>
</div>
<script>
  window.__update = function(u){
    try{
      document.getElementById('fill').style.width = Math.max(0,Math.min(100,Math.round((u.pct||0)*100))) + '%';
      if(u.msg) document.getElementById('msg').textContent = u.msg;
      if(u.error){ document.getElementById('dot').style.animation='none'; document.getElementById('dot').style.background='#ff6b6b'; }
      if(Array.isArray(u.steps)){
        var ul=document.getElementById('steps'); ul.innerHTML='';
        u.steps.forEach(function(s){
          var li=document.createElement('li'); li.className=s.state;
          var ico=document.createElement('span'); ico.className='ico';
          ico.textContent = s.state==='done' ? '✓' : (s.state==='error' ? '!' : '');
          li.appendChild(ico);
          var t=document.createElement('span'); t.textContent=s.label; li.appendChild(t);
          ul.appendChild(li);
        });
      }
    }catch(e){}
  };
</script></body></html>`;
}

export function showSetupWindow(parent?: BrowserWindow | null): void {
    if (win && !win.isDestroyed()) return;
    const dark = nativeTheme.shouldUseDarkColors;
    win = new BrowserWindow({
        width: 460,
        height: 340,
        resizable: false,
        minimizable: true,
        maximizable: false,
        fullscreenable: false,
        title: "MuzicAI — Setup",
        alwaysOnTop: true,
        skipTaskbar: false,
        parent: parent ?? undefined,
        backgroundColor: dark ? "#0b0b0f" : "#f7f7fa",
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.removeMenu?.();
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html(dark)))
        .catch((e) => pushDebugLog("warn", "[setup-window] load failed:", e instanceof Error ? e.message : String(e)));
    win.on("closed", () => { win = null; });
}

export function updateSetupWindow(u: SetupUpdate): void {
    if (!win || win.isDestroyed()) return;
    const payload = JSON.stringify(u);
    win.webContents.executeJavaScript(`window.__update && window.__update(${payload});`).catch(() => { /* window may be loading */ });
}

export function closeSetupWindow(delayMs = 0): void {
    if (!win || win.isDestroyed()) return;
    const w = win;
    setTimeout(() => { try { if (!w.isDestroyed()) w.close(); } catch { /* ignore */ } }, delayMs);
}

export function setupWindowOpen(): boolean {
    return !!win && !win.isDestroyed();
}
