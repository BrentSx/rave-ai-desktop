// Local JARVIS bridge: starts the Python bridge (jarvis.serve) as a child process
// and talks to it over HTTP. Everything personal (memory, Google tokens) lives on
// this PC behind this bridge; the renderer only ever reaches it through the main
// process, so no secrets touch the UI.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

function projectRoot(config) {
  if (config.server && config.server.cwd) return config.server.cwd;
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.resolve(process.env.PORTABLE_EXECUTABLE_DIR, "..", "..");
  }
  if (!app.isPackaged) return path.resolve(__dirname, "..", "..");
  return path.resolve(path.dirname(app.getPath("exe")), "..", "..");
}

class JarvisManager {
  constructor(config) {
    this.config = config;
    this.cfg = config.jarvis || {};
    this.base = (this.cfg.url || "http://127.0.0.1:8900").replace(/\/+$/, "");
    this.proc = null;
    this.managed = false;
    this.logStream = null;
    this.bootPromise = null;
  }

  get enabled() {
    return this.cfg.enabled !== false;
  }

  url(p) {
    return `${this.base}${p}`;
  }

  async probe(timeoutMs = 2000) {
    try {
      const res = await fetch(this.url("/health"), { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }

  boot() {
    if (!this.enabled) return Promise.resolve({ ready: false, disabled: true });
    if (!this.bootPromise) this.bootPromise = this._boot();
    return this.bootPromise;
  }

  async _boot() {
    if (await this.probe()) return { ready: true, managed: false };
    if (this.cfg.autostart === false) {
      return { ready: false, error: "The JARVIS bridge isn't running." };
    }
    try {
      this._spawn();
    } catch (e) {
      return { ready: false, error: `Could not start the JARVIS bridge: ${e.message}` };
    }
    const deadline = Date.now() + (this.cfg.startTimeoutMs || 30000);
    while (Date.now() < deadline) {
      if (this.proc && this.proc.exitCode !== null) {
        return { ready: false, error: `The JARVIS bridge exited (code ${this.proc.exitCode}). See ${this.logPath}` };
      }
      if (await this.probe(1500)) return { ready: true, managed: true };
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { ready: false, error: "The JARVIS bridge did not become ready in time." };
  }

  get logPath() {
    return path.join(app.getPath("userData"), "jarvis-bridge.log");
  }

  // A Google OAuth client shipped with the app (publisher sets it once). When
  // present, end users never create their own — they just click Connect.
  bundledGoogleClient() {
    const candidates = [
      this.cfg.googleClientFile,
      path.join(__dirname, "..", "config", "google_client.json"),
    ].filter(Boolean);
    for (const p of candidates) {
      try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
    }
    return null;
  }

  _spawn() {
    const cwd = projectRoot(this.config);
    const command = this.cfg.command || "py";
    const args = this.cfg.args || ["-3.14", "-u", "-m", "jarvis.serve"];
    if (!fs.existsSync(cwd)) throw new Error(`project folder not found: ${cwd}`);
    const port = (() => {
      try { return new URL(this.base).port || "8900"; } catch { return "8900"; }
    })();
    const env = { ...process.env, PYTHONUNBUFFERED: "1", JARVIS_BRIDGE_PORT: port };
    const bundled = this.bundledGoogleClient();
    if (bundled) env.JARVIS_GOOGLE_CLIENT_FILE = bundled;
    this.logStream = fs.createWriteStream(this.logPath, { flags: "w" });
    this.proc = spawn(command, args, { cwd, windowsHide: true, env });
    this.managed = true;
    this.proc.stdout.pipe(this.logStream);
    this.proc.stderr.pipe(this.logStream);
    this.proc.on("error", (e) => {
      try { this.logStream.write(`\n[spawn error] ${e.message}\n`); } catch {}
    });
  }

  stop() {
    if (!this.managed || !this.proc || this.proc.exitCode !== null) return;
    const pid = this.proc.pid;
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      else this.proc.kill("SIGTERM");
    } catch { /* best effort */ }
  }

  // --- HTTP helpers -------------------------------------------------------
  async getJson(p, timeout = 8000) {
    const res = await fetch(this.url(p), { signal: AbortSignal.timeout(timeout) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.detail || `bridge error (${res.status})`);
    return data;
  }

  async postJson(p, body, timeout = 8000) {
    const res = await fetch(this.url(p), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeout),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.detail || `bridge error (${res.status})`);
    return data;
  }

  status() { return this.getJson("/status"); }
  toggle(name, on) { return this.postJson("/toggle", { name, on }); }
  // OAuth opens a browser and waits for the user — give it a long timeout.
  connectGoogle() { return this.postJson("/connect/google", {}, 300000); }
  disconnectGoogle() { return this.postJson("/disconnect/google", {}); }
  saveGoogleClient(clientJson) { return this.postJson("/google/client", { client_json: clientJson }); }
  memoryList() { return this.getJson("/memory"); }
  memoryForget(query) { return this.postJson("/memory/forget", { query }); }
  confirmRespond(id, approve) { return this.postJson("/confirm", { id, approve }); }

  /**
   * Streams an assistant chat. onEvent(type, data) fires for each SSE event
   * (start / status / confirm / done / error). Resolves when the stream ends.
   */
  async streamChat(payload, signal, onEvent) {
    let res;
    try {
      res = await fetch(this.url("/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (e) {
      if (signal && signal.aborted) return;
      throw new Error("Can't reach the JARVIS bridge. Is it running?");
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || data.detail || `bridge error (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let type = "message";
          const dataLines = [];
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) continue;
            if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          if (!dataLines.length) continue;
          let data;
          try { data = JSON.parse(dataLines.join("\n")); } catch { continue; }
          onEvent(type, data);
        }
      }
    } catch (e) {
      if (signal && signal.aborted) return;
      throw new Error("The connection to the JARVIS bridge was lost.");
    }
  }
}

module.exports = { JarvisManager };
