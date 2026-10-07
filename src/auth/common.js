class AuthError extends Error {}

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateSignup({ username, email, password, apiKey }) {
  if (!USERNAME_RE.test(String(username || "").trim())) {
    throw new AuthError("Username must be 3–32 characters: letters, numbers, . _ -");
  }
  if (email && !EMAIL_RE.test(String(email).trim())) throw new AuthError("That email address doesn't look right.");
  if (!password || password.length < 8) throw new AuthError("Password must be at least 8 characters.");
  if (!apiKey || !String(apiKey).trim()) throw new AuthError("An API key is required.");
}

function publicUser(u) {
  return { id: u.id, username: u.username, email: u.email || "" };
}

module.exports = { AuthError, validateSignup, publicUser };
