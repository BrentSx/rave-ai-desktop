// Small JSON-file storage in the app's user-data folder (%APPDATA%\Rave AI).
// Secrets (API keys, session tokens) are encrypted with Electron safeStorage,
// which uses Windows DPAPI: only this Windows user account can decrypt them.
const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");

function dataPath(...parts) {
  return path.join(app.getPath("userData"), ...parts);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(dataPath(file), "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const target = dataPath(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, target);
}

function removeFile(file) {
  fs.rmSync(dataPath(file), { force: true });
}

function encrypt(text) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure storage is not available on this system");
  }
  return safeStorage.encryptString(text).toString("base64");
}

function decrypt(b64) {
  return safeStorage.decryptString(Buffer.from(b64, "base64"));
}

module.exports = { dataPath, readJson, writeJson, removeFile, encrypt, decrypt };
