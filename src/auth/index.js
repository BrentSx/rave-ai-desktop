// Picks the account provider from app.config.json ("local" now, "remote" = website later).
const { LocalAuthProvider } = require("./local");
const { RemoteAuthProvider } = require("./remote");
const { AuthError } = require("./common");

function createAuthProvider(config) {
  const mode = (config.auth && config.auth.mode) || "local";
  if (mode === "remote") {
    return new RemoteAuthProvider({
      remoteBaseUrl: config.auth.remoteBaseUrl,
      defaultServerUrl: config.defaultServerUrl,
    });
  }
  return new LocalAuthProvider();
}

module.exports = { createAuthProvider, AuthError };
