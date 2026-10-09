# Rave AI Desktop

A Windows desktop chat client for the Rave AI API, built with Electron.

* Chat UI with a sidebar of saved chats. Replies stream in as they're generated.
* Markdown, syntax-highlighted code blocks with a copy button, and source chips for document/web answers
* **Documents** and **Web** toggles (`use_rag` / `use_web`)
* **Model dropdown** (top bar) to switch between installed models at runtime.
  The list comes from `config/models.json` on the server; add models there (see
  `docs/setup.md`). Switching needs an admin API key.
* Accounts: create one with a username, password and your **API key**. The key is
  checked against the server before the account is created.

## Run / build

```powershell
cd desktop
npm install          # first time only
npm start            # run in development
npm run build        # -> dist\RaveAI.exe (single portable file)
```

**Auto-start:** opening the app starts the Rave AI server automatically (shows a
brief loading screen while the model loads) and stops it again when you close the
app. If a server is already running, the app attaches to it instead. Configure or
disable this under `server` in `config/app.config.json` (`"autostart": false` to
turn it off and run `run.bat` yourself).

### Running as a client of a hosted server

The app is a normal HTTP client, so the server can live on another machine (a
spare PC, a home server, or this PC exposed via Cloudflare Tunnel — see
`cloudflare/README.md`). On the **client** PC, create `%APPDATA%\Rave AIpp.config.json`:

```json
{ "defaultServerUrl": "https://api.example.com" }
```

When the server URL is not localhost, the app **does not start a local server** —
it just connects to the hosted one. On the **server** machine, run `run.bat` (or
let its own copy of the app auto-start it). Each client signs in with its own API
key against that server.

## Where data is stored

Everything lives in `%APPDATA%\Rave AI\`:

| File | Contents |
|------|----------|
| `users.json` | Local accounts: scrypt password hashes, API keys **encrypted with Windows DPAPI** |
| `session.json` | "Keep me signed in" token (encrypted) |
| `chats/<user>.json` | Chat history |
| `prefs/<user>.json` | Documents/Web toggle state |
| `app.config.json` | Optional config override (see below) |

API keys are only decrypted in the app's main process, and the UI code never sees them.
Data encrypted with DPAPI can only be read by the same Windows user on the same PC.

## Connecting sign-in to a website later

Sign-in goes through a swappable **auth provider** (`src/auth/`):

* `local.js`: accounts stored on this PC (the default)
* `remote.js`: accounts on your website, ready to use once the website exists

Switching needs no rebuild. Create `%APPDATA%\Rave AI\app.config.json`:

```json
{
  "defaultServerUrl": "https://api.example.com",
  "auth": { "mode": "remote", "remoteBaseUrl": "https://rave.example.com" }
}
```

To make it the default for everyone, change `desktop/config/app.config.json` and rebuild.

### Website API contract

Your website needs to implement these endpoints (JSON in and out):

| Method & path | Body / headers | Success response |
|---------------|----------------|------------------|
| `POST /auth/signup` | `{username, email, password, apiKey}` | `201 {token, user, apiKey?, serverUrl?}` |
| `POST /auth/login` | `{username, password}` | `200 {token, user, apiKey?, serverUrl?}` |
| `GET /auth/me` | `Authorization: Bearer <token>` | `200 {user, apiKey?, serverUrl?}` |
| `PATCH /auth/me` | `Authorization: Bearer <token>`, `{apiKey?, serverUrl?}` | `200 {user, apiKey?, serverUrl?}` |
| `POST /auth/logout` | `Authorization: Bearer <token>` | `204` |

* `user` = `{id, username, email}`
* Errors: any 4xx status with `{"detail": "message"}`. The message is shown to the user.
* `apiKey` / `serverUrl` in responses are optional. If the website returns them,
  they override what the user typed. This lets the website issue and rotate Rave
  AI API keys itself (e.g. one limited `chat` key per account via
  `scripts/manage_keys.py`), so users don't need to know a key at all.
* `token` is any opaque session token. The app stores it encrypted and sends it
  back as a Bearer token.

## Project layout

```text
desktop/
├── src/
│   ├── main.js        window, IPC, chat streaming, chat storage
│   ├── preload.js     the only bridge exposed to the UI (window.rave)
│   ├── api.js         Rave AI REST client (SSE streaming)
│   ├── store.js       JSON files + DPAPI encryption
│   └── auth/          local.js, remote.js, common.js, index.js
├── renderer/          index.html, styles.css, app.js (+ vendor/, generated)
├── config/app.config.json
├── assets/            icon.png, icon.ico
└── scripts/copy-vendor.js
```
