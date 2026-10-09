const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { app, BrowserWindow, ipcMain, shell, Menu } = require("electron");

const { RaveApi, normalizeServerUrl } = require("./api");
const { createAuthProvider, AuthError } = require("./auth");
const { ServerManager } = require("./server");
const { JarvisManager } = require("./jarvis");
const { readJson, writeJson } = require("./store");

// --- configuration ------------------------------------------------------
// Bundled defaults, overridable by %APPDATA%\Rave AI\app.config.json
// (so a built .exe can be pointed at a website login without rebuilding).
function loadConfig() {
  const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "app.config.json"), "utf8"));
  const override = readJson("app.config.json", {});
  return { ...bundled, ...override, auth: { ...bundled.auth, ...(override.auth || {}) } };
}

let config;
let auth;
let serverManager = null;
let jarvisManager = null;
let session = null; // { user, apiKey, serverUrl }
let api = null;
let win = null;
const streams = new Map(); // requestId -> AbortController

function setSession(s) {
  session = s;
  api = s ? new RaveApi(s.serverUrl, s.apiKey) : null;
}

function requireSession() {
  if (!session) throw new AuthError("You're signed out.");
}

// The servers the UI offers for quick switching: config presets + any this
// account has saved a key for + whatever is active now, de-duplicated.
function knownServers() {
  const presets = (config.knownServers || []).map((u) => String(u).replace(/\/+$/, ""));
  const saved = (typeof auth.listServers === "function" ? auth.listServers(session.user.id) : [])
    .map((s) => ({ url: String(s.url).replace(/\/+$/, ""), hasKey: true }));
  const byUrl = new Map();
  for (const u of presets) byUrl.set(u, { url: u, hasKey: false });
  for (const s of saved) byUrl.set(s.url, { url: s.url, hasKey: true });
  const active = String(session.serverUrl).replace(/\/+$/, "");
  if (!byUrl.has(active)) byUrl.set(active, { url: active, hasKey: true });
  return [...byUrl.values()].map((s) => ({ ...s, active: s.url === active }));
}

// --- chats (stored per user) -----------------------------------------------
const chatsFile = () => `chats/${session.user.id}.json`;
const loadChats = () => readJson(chatsFile(), []);
const saveChats = (chats) => writeJson(chatsFile(), chats);
const summary = (c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt });

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function titleFrom(text) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 48 ? `${t.slice(0, 48)}…` : t;
}

// --- IPC ----------------------------------------------------------------------
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, args) => {
    try {
      return { ok: true, data: await fn(args || {}) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function registerIpc() {
  handle("app:info", async () => ({
    authMode: auth.mode,
    defaultServerUrl: config.defaultServerUrl,
    serverIsLocal: serverManager.isLocal(),
    serverAutostart: (config.server || {}).autostart !== false,
    jarvisEnabled: jarvisManager.enabled,
    version: app.getVersion(),
  }));

  handle("server:boot", async ({ retry } = {}) => {
    if (retry) serverManager.bootPromise = null;   // allow another attempt after a failure
    const result = await serverManager.boot();
    if (!result.ready) serverManager.bootPromise = null;
    return { ...result, logPath: serverManager.logPath };
  });

  handle("auth:restore", async () => {
    const s = await auth.restore();
    setSession(s);
    return s ? s.user : null;
  });

  handle("auth:signup", async ({ username, email, password, apiKey, serverUrl, remember }) => {
    const url = normalizeServerUrl(serverUrl || config.defaultServerUrl);
    // Check the key against the real server before creating the account.
    await new RaveApi(url, (apiKey || "").trim()).verifyKey();
    const s = await auth.signup({ username, email, password, apiKey, serverUrl: url });
    setSession(s);
    if (remember) await auth.remember(s.user.id);
    return s.user;
  });

  handle("auth:login", async ({ username, password, remember }) => {
    const s = await auth.login({ username, password });
    setSession(s);
    if (remember) await auth.remember(s.user.id);
    return s.user;
  });

  handle("auth:logout", async () => {
    for (const c of streams.values()) c.abort();
    if (session) await auth.logout(session.user.id);
    setSession(null);
  });

  handle("account:get", async () => {
    requireSession();
    const k = session.apiKey;
    return {
      ...session.user,
      serverUrl: session.serverUrl,
      apiKeyHint: `${k.slice(0, 5)}…${k.slice(-4)}`,
      servers: knownServers(),
    };
  });

  handle("account:update-connection", async ({ serverUrl, apiKey }) => {
    requireSession();
    const url = normalizeServerUrl(serverUrl || session.serverUrl);
    const key = (apiKey || "").trim() || session.apiKey;
    await new RaveApi(url, key).verifyKey();
    setSession(await auth.updateConnection(session.user.id, { serverUrl: url, apiKey: apiKey ? key : undefined }));
  });

  // One-click switch to another server. Reuses the key already saved for that URL;
  // if there isn't one, tells the UI to ask for a key (needsKey).
  handle("account:switch-server", async ({ serverUrl, apiKey }) => {
    requireSession();
    const url = normalizeServerUrl(serverUrl);
    let key = (apiKey || "").trim();
    if (!key && typeof auth.getServerKey === "function") key = auth.getServerKey(session.user.id, url) || "";
    if (!key) return { needsKey: true, url };
    await new RaveApi(url, key).verifyKey();
    setSession(await auth.updateConnection(session.user.id, { serverUrl: url, apiKey: key }));
    return { ok: true, url };
  });

  handle("models:list", async () => {
    requireSession();
    return api.listModels();
  });

  handle("models:switch", async ({ id }) => {
    requireSession();
    for (const c of streams.values()) c.abort();   // stop any generation before swapping
    return api.switchModel(id);
  });

  handle("server:status", async () => {
    const probe = api || new RaveApi(config.defaultServerUrl, "");
    try {
      const h = await probe.health();
      return { online: true, modelLoaded: !!h.model_loaded, model: h.model, url: probe.base };
    } catch {
      return { online: false, url: probe.base };
    }
  });

  handle("prefs:get", async () => {
    requireSession();
    return readJson(`prefs/${session.user.id}.json`, { useRag: true, useWeb: false });
  });

  handle("prefs:set", async (prefs) => {
    requireSession();
    writeJson(`prefs/${session.user.id}.json`, { useRag: !!prefs.useRag, useWeb: !!prefs.useWeb });
  });

  handle("chats:list", async () => {
    requireSession();
    return loadChats().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary);
  });

  handle("chats:get", async ({ id }) => {
    requireSession();
    const chat = loadChats().find((c) => c.id === id);
    if (!chat) throw new Error("Chat not found");
    return chat;
  });

  handle("chats:delete", async ({ id }) => {
    requireSession();
    saveChats(loadChats().filter((c) => c.id !== id));
  });

  handle("chats:rename", async ({ id, title }) => {
    requireSession();
    const chats = loadChats();
    const chat = chats.find((c) => c.id === id);
    if (chat && String(title || "").trim()) {
      chat.title = titleFrom(title);
      saveChats(chats);
    }
  });

  handle("chat:send", async ({ chatId, message, useRag, useWeb, assistant }) => {
    requireSession();
    const text = String(message || "").trim();
    if (!text) throw new Error("Message is empty");

    const now = new Date().toISOString();
    const chats = loadChats();
    let chat = chatId && chats.find((c) => c.id === chatId);
    if (!chat) {
      chat = { id: newId("chat"), title: titleFrom(text), conversationId: newId("conv"), createdAt: now, messages: [] };
      chats.push(chat);
    }
    chat.messages.push({ role: "user", content: text, at: now });
    chat.updatedAt = now;
    saveChats(chats);

    const requestId = newId("req");
    const controller = new AbortController();
    streams.set(requestId, controller);
    const client = api;
    const ownerFile = chatsFile();
    const useJarvis = !!assistant && jarvisManager.enabled;

    (async () => {
      let reply = "";
      let sources = [];
      let error = null;
      try {
        if (useJarvis) {
          // The assistant returns one finished reply (no token stream); we forward
          // its progress (status / confirm) and emit the reply as a single token.
          await jarvisManager.streamChat(
            { message: text, session: chat.conversationId },
            controller.signal,
            (type, data) => {
              if (type === "start") {
                send("chat:event", { requestId, chatId: chat.id, type: "start", data: { sources: [] } });
              } else if (type === "status") {
                send("chat:event", { requestId, chatId: chat.id, type: "status", data });
              } else if (type === "confirm") {
                send("chat:event", { requestId, chatId: chat.id, type: "confirm", data });
              } else if (type === "done") {
                reply = data.reply || "";
                send("chat:event", { requestId, chatId: chat.id, type: "token", data: { token: reply } });
              } else if (type === "error") {
                error = data.detail || "The assistant hit a problem.";
              }
            },
          );
        } else {
          await client.streamChat(
            { message: text, conversation_id: chat.conversationId, use_rag: !!useRag, use_web: !!useWeb },
            controller.signal,
            (type, data) => {
              if (type === "start") sources = data.sources || [];
              else if (type === "token") reply += data.token;
              else if (type === "error") error = data.detail || "Generation failed";
              send("chat:event", { requestId, chatId: chat.id, type, data });
            },
          );
        }
      } catch (e) {
        error = e.message;
      } finally {
        streams.delete(requestId);
        const stopped = controller.signal.aborted;
        if (reply.trim()) {
          const latest = readJson(ownerFile, []);
          const c = latest.find((x) => x.id === chat.id);
          if (c) {
            c.messages.push({ role: "assistant", content: reply.trim(), sources, stopped, at: new Date().toISOString() });
            c.updatedAt = new Date().toISOString();
            writeJson(ownerFile, latest);
          }
        }
        send("chat:event", { requestId, chatId: chat.id, type: "end", data: { error, stopped } });
      }
    })();

    return { requestId, chat: summary(chat) };
  });

  // --- JARVIS assistant (local bridge) ---------------------------------------
  handle("jarvis:status", async () => {
    if (!jarvisManager.enabled) return { enabled: false };
    try {
      return { enabled: true, ready: true, ...(await jarvisManager.status()) };
    } catch (e) {
      return { enabled: true, ready: false, error: e.message };
    }
  });

  handle("jarvis:toggle", async ({ name, on }) => jarvisManager.toggle(name, !!on));
  handle("jarvis:connect-google", async () => jarvisManager.connectGoogle());
  handle("jarvis:disconnect-google", async () => jarvisManager.disconnectGoogle());
  handle("jarvis:save-google-client", async ({ clientJson }) => jarvisManager.saveGoogleClient(clientJson));
  handle("jarvis:memory-list", async () => jarvisManager.memoryList());
  handle("jarvis:memory-forget", async ({ query }) => jarvisManager.memoryForget(query));
  handle("jarvis:confirm", async ({ id, approve }) => jarvisManager.confirmRespond(id, !!approve));

  handle("chat:stop", async ({ requestId }) => {
    const c = streams.get(requestId);
    if (c) c.abort();
  });
}

// --- window --------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    title: "Rave AI",
    backgroundColor: "#07080c",
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#07080c", symbolColor: "#8b95ad", height: 38 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Links in answers open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  win.once("ready-to-show", () => win.show());
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    config = loadConfig();
    auth = createAuthProvider(config);
    serverManager = new ServerManager(config);
    serverManager.boot();               // start the API server early, in the background
    jarvisManager = new JarvisManager(config);
    jarvisManager.boot();               // start the local assistant bridge too
    registerIpc();
    createWindow();
  });

  app.on("before-quit", () => {
    if (serverManager) serverManager.stop();   // stop the server we started
    if (jarvisManager) jarvisManager.stop();   // and the assistant bridge
  });

  app.on("window-all-closed", () => app.quit());
}
