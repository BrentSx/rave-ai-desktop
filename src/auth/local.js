// Local accounts, stored on this PC only.
//   users.json   usernames, scrypt password hashes, encrypted API keys
//   session.json "keep me signed in" token (encrypted)
const crypto = require("crypto");
const { readJson, writeJson, removeFile, encrypt, decrypt } = require("../store");
const { AuthError, validateSignup, publicUser } = require("./common");

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return { salt, hash: hash.toString("hex") };
}

function verifyPassword(password, record) {
  const { hash } = hashPassword(password, record.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(record.hash, "hex"));
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class LocalAuthProvider {
  constructor() {
    this.mode = "local";
  }

  _users() {
    return readJson("users.json", { users: [] }).users;
  }

  _save(users) {
    writeJson("users.json", { users });
  }

  _find(users, username) {
    return users.find((u) => u.username.toLowerCase() === String(username).trim().toLowerCase());
  }

  _session(record) {
    return { user: publicUser(record), apiKey: decrypt(record.apiKeyEnc), serverUrl: record.serverUrl };
  }

  async signup({ username, email, password, apiKey, serverUrl }) {
    validateSignup({ username, email, password, apiKey });
    const users = this._users();
    if (this._find(users, username)) throw new AuthError("That username is already taken.");
    const keyEnc = encrypt(apiKey.trim());
    const record = {
      id: `usr_${crypto.randomBytes(8).toString("hex")}`,
      username: username.trim(),
      email: (email || "").trim(),
      password: hashPassword(password),
      apiKeyEnc: keyEnc,
      serverUrl,
      servers: { [serverUrl]: keyEnc },   // remember a key per server, for quick switching
      createdAt: new Date().toISOString(),
    };
    users.push(record);
    this._save(users);
    return this._session(record);
  }

  async login({ username, password }) {
    const record = this._find(this._users(), username || "");
    if (!record || !verifyPassword(password || "", record.password)) {
      await sleep(600); // slow down guessing
      throw new AuthError("Incorrect username or password.");
    }
    return this._session(record);
  }

  /** Persist a "keep me signed in" session. */
  async remember(userId) {
    const token = crypto.randomBytes(32).toString("hex");
    const users = this._users();
    const record = users.find((u) => u.id === userId);
    if (!record) return;
    record.sessionHash = sha256(token);
    this._save(users);
    writeJson("session.json", { userId, tokenEnc: encrypt(token) });
  }

  async restore() {
    const s = readJson("session.json", null);
    if (!s) return null;
    try {
      const record = this._users().find((u) => u.id === s.userId);
      if (record && record.sessionHash && record.sessionHash === sha256(decrypt(s.tokenEnc))) {
        return this._session(record);
      }
    } catch {
      /* fall through */
    }
    removeFile("session.json");
    return null;
  }

  async logout(userId) {
    removeFile("session.json");
    const users = this._users();
    const record = users.find((u) => u.id === userId);
    if (record) {
      delete record.sessionHash;
      this._save(users);
    }
  }

  async updateConnection(userId, { apiKey, serverUrl }) {
    const users = this._users();
    const record = users.find((u) => u.id === userId);
    if (!record) throw new AuthError("Account not found.");
    const url = serverUrl || record.serverUrl;
    record.servers = record.servers || {};
    // Use the new key, else the key already remembered for this server, else the current one.
    const keyEnc = apiKey ? encrypt(apiKey.trim()) : (record.servers[url] || record.apiKeyEnc);
    record.serverUrl = url;
    record.apiKeyEnc = keyEnc;
    record.servers[url] = keyEnc;        // remember it for next time
    this._save(users);
    return this._session(record);
  }

  /** URLs this account already has a saved key for (most-recently-used not tracked; insertion order). */
  listServers(userId) {
    const record = this._users().find((u) => u.id === userId);
    if (!record) return [];
    const servers = record.servers || (record.serverUrl ? { [record.serverUrl]: record.apiKeyEnc } : {});
    return Object.keys(servers).map((url) => ({ url, active: url === record.serverUrl }));
  }

  /** Decrypted saved key for a given server URL, or null. */
  getServerKey(userId, url) {
    const record = this._users().find((u) => u.id === userId);
    if (!record || !record.servers || !record.servers[url]) return null;
    try {
      return decrypt(record.servers[url]);
    } catch {
      return null;
    }
  }
}

module.exports = { LocalAuthProvider };
