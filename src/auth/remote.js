// Website-backed accounts. Enable with { "auth": { "mode": "remote", "remoteBaseUrl": "https://rave.example.com" } }
// in app.config.json. The website must implement the contract below (see desktop/README.md).
//
//   POST {base}/auth/signup   {username, email, password, apiKey}  -> 201 {token, user, apiKey?, serverUrl?}
//   POST {base}/auth/login    {username, password}                 -> 200 {token, user, apiKey?, serverUrl?}
//   GET  {base}/auth/me       Authorization: Bearer <token>        -> 200 {user, apiKey?, serverUrl?}
//   POST {base}/auth/logout   Authorization: Bearer <token>        -> 204
//   PATCH {base}/auth/me      Authorization: Bearer <token>  {apiKey?, serverUrl?} -> 200 {user, apiKey?, serverUrl?}
//
//   user = {id, username, email}. Errors: any 4xx with {"detail": "message"}.
//   If the website returns apiKey/serverUrl, those override what the user typed,
//   so the website can issue and rotate API keys centrally.
const { readJson, writeJson, removeFile, encrypt, decrypt } = require("../store");
const { AuthError, validateSignup, publicUser } = require("./common");

class RemoteAuthProvider {
  constructor({ remoteBaseUrl, defaultServerUrl }) {
    if (!remoteBaseUrl) throw new Error("auth.remoteBaseUrl must be set for remote auth");
    this.mode = "remote";
    this.base = remoteBaseUrl.replace(/\/+$/, "");
    this.defaultServerUrl = defaultServerUrl;
    this.token = null;
  }

  async _call(method, path, body, token) {
    let res;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new AuthError(`Can't reach the sign-in server at ${this.base}.`);
    }
    if (res.status === 204) return {};
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new AuthError(data.detail || `Sign-in server error (${res.status})`);
    return data;
  }

  // The API key and server URL are cached locally (encrypted) per user.
  _cache(userId, apiKey, serverUrl) {
    const all = readJson("remote-keys.json", {});
    const prev = all[userId] || {};
    all[userId] = {
      apiKeyEnc: apiKey ? encrypt(apiKey) : prev.apiKeyEnc,
      serverUrl: serverUrl || prev.serverUrl || this.defaultServerUrl,
    };
    writeJson("remote-keys.json", all);
    return { apiKey: decrypt(all[userId].apiKeyEnc), serverUrl: all[userId].serverUrl };
  }

  _session(data, typedKey, typedServer) {
    const user = publicUser(data.user);
    const { apiKey, serverUrl } = this._cache(user.id, data.apiKey || typedKey, data.serverUrl || typedServer);
    return { user, apiKey, serverUrl };
  }

  async signup({ username, email, password, apiKey, serverUrl }) {
    validateSignup({ username, email, password, apiKey });
    const data = await this._call("POST", "/auth/signup", { username, email, password, apiKey });
    this.token = data.token;
    return this._session(data, apiKey, serverUrl);
  }

  async login({ username, password }) {
    const data = await this._call("POST", "/auth/login", { username, password });
    this.token = data.token;
    return this._session(data);
  }

  async remember() {
    if (this.token) writeJson("session.json", { remote: true, tokenEnc: encrypt(this.token) });
  }

  async restore() {
    const s = readJson("session.json", null);
    if (!s || !s.remote) return null;
    try {
      this.token = decrypt(s.tokenEnc);
      return this._session(await this._call("GET", "/auth/me", null, this.token));
    } catch {
      removeFile("session.json");
      this.token = null;
      return null;
    }
  }

  async logout() {
    if (this.token) await this._call("POST", "/auth/logout", null, this.token).catch(() => {});
    this.token = null;
    removeFile("session.json");
  }

  async updateConnection(userId, { apiKey, serverUrl }) {
    const data = await this._call("PATCH", "/auth/me", { apiKey, serverUrl }, this.token);
    return this._session(data, apiKey, serverUrl);
  }
}

module.exports = { RemoteAuthProvider };
