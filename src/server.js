// Starts and stops the Rave AI Python API server as a child process, so opening
// the app is all the user needs to do. If a server is already running (e.g. the
// user started run.bat), it attaches to that one and does not manage it.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

function projectRoot(config) {
  if (config.server && config.server.cwd) return config.server.cwd;
  // Portable .exe: electron-builder sets this to the real folder the .exe is in
  // (…\desktop\dist), so the project root is two levels up.
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.resolve(process.env.PORTABLE_EXECUTABLE_DIR, "..", "..");
  }
  if (!app.isPackaged) return path.resolve(__dirname, "..", ".."); // dev: desktop/src -> project
  return path.resolve(path.dirname(app.getPath("exe")), "..", "..");
}

class ServerManager {
  constructor(config) {
    this.config = config;
    this.cfg = config.server || {};
    this.healthUrl = `${config.defaultServerUrl.replace(/\/+$/, "")}${this.cfg.healthPath || "/api/v1/health"}`;
    this.proc = null;
    this.managed = false;         // true only if WE started it (so we only kill our own)
    this.logStream = null;
    this.bootPromise = null;
  }

  isLocal() {
    try {
      const h = new URL(this.healthUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
      return h === "localhost" || h === "127.0.0.1" || h === "::1";
    } catch {
      return false;
    }
  }

  async probe(timeoutMs = 2500) {
    try {
      const res = await fetch(this.healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  // Resolves to { ready, managed, modelLoaded, error }. Starts the server if needed.
  boot() {
    if (!this.bootPromise) this.bootPromise = this._boot();
    return this.bootPromise;
  }

  async _boot() {
    // Already running? Attach, don't manage.
    const existing = await this.probe();
    if (existing) {
      return { ready: true, managed: false, local: this.isLocal(), modelLoaded: !!existing.model_loaded };
    }
    // Hosted elsewhere: this app is a pure client, it never starts a remote server.
    if (!this.isLocal()) {
      return { ready: false, managed: false, local: false,
               error: `The Rave AI server at ${new URL(this.healthUrl).host} isn't reachable.` };
    }
    if (this.cfg.autostart === false) {
      return { ready: false, managed: false, local: true,
               error: "No server is running. Start it with run.bat, or enable autostart." };
    }

    try {
      this._spawn();
    } catch (e) {
      return { ready: false, managed: false, error: `Could not start the server: ${e.message}` };
    }

    // Poll health until ready (model load can take a while on the first run).
    const timeout = this.cfg.startTimeoutMs || 180000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.proc && this.proc.exitCode !== null) {
        return { ready: false, managed: true,
                 error: `The server process exited (code ${this.proc.exitCode}). See ${this.logPath}` };
      }
      const h = await this.probe(2000);
      if (h) return { ready: true, managed: true, local: true, modelLoaded: !!h.model_loaded };
      await new Promise((r) => setTimeout(r, 1500));
    }
    return { ready: false, managed: true, local: true, error: "The server did not become ready in time." };
  }

  get logPath() {
    return path.join(app.getPath("userData"), "server.log");
  }

  _spawn() {
    const cwd = projectRoot(this.config);
    const command = this.cfg.command || "py";
    const args = this.cfg.args || ["-3.14", "-u", "-m", "app"];
    if (!fs.existsSync(cwd)) {
      throw new Error(`project folder not found: ${cwd} (set "server.cwd" in app.config.json)`);
    }

    this.logStream = fs.createWriteStream(this.logPath, { flags: "w" });
    this.proc = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, HF_HUB_DISABLE_SYMLINKS_WARNING: "1", PYTHONUNBUFFERED: "1" },
    });
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
      if (process.platform === "win32") {
        // Kill the whole tree so the child llama-server goes down too.
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      } else {
        this.proc.kill("SIGTERM");
      }
    } catch {
      /* best effort */
    }
  }
}

module.exports = { ServerManager };
