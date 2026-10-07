// Client for the Rave AI REST API (/api/v1). Runs in the main process only,
// so the API key never reaches the UI.

class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

function normalizeServerUrl(url) {
  let u = String(url || "").trim().replace(/\/+$/, "");
  if (!u) throw new ApiError("Server URL is required");
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  try {
    new URL(u);
  } catch {
    throw new ApiError("Server URL is not valid");
  }
  return u.replace(/\/api\/v1$/, "");
}

function friendlyError(status, detail) {
  if (status === 401) return "The API key was rejected by the server.";
  if (status === 403) return detail || "This API key doesn't have permission for that.";
  if (status === 429) return "Rate limit reached. Wait a moment and try again.";
  if (status === 413) return "That message is too large.";
  if (status === 503) return detail === "Model is not loaded"
    ? "The AI model isn't loaded on the server." : (detail || "The server is busy. Try again shortly.");
  if (status === 422) return Array.isArray(detail) ? detail.map((d) => d.msg).join("; ") : String(detail);
  return detail ? String(detail) : `Server error (${status})`;
}

class RaveApi {
  constructor(serverUrl, apiKey) {
    this.base = normalizeServerUrl(serverUrl);
    this.apiKey = apiKey;
  }

  url(p) {
    return `${this.base}/api/v1${p}`;
  }

  headers(json = true) {
    const h = { Authorization: `Bearer ${this.apiKey}` };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  async request(method, p, body, { timeout = 15000, auth = true } = {}) {
    let res;
    try {
      res = await fetch(this.url(p), {
        method,
        headers: auth ? this.headers(body !== undefined) : {},
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      throw new ApiError(`Can't reach the Rave AI server at ${this.base}. Is it running?`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(friendlyError(res.status, data.detail), res.status);
    return data;
  }

  health() {
    return this.request("GET", "/health", undefined, { timeout: 5000, auth: false });
  }

  /** Confirms the key works; returns model info. */
  verifyKey() {
    return this.request("GET", "/model");
  }

  listModels() {
    return this.request("GET", "/models");
  }

  /** Switch the active model. Loading a model can take a while, so a long timeout. */
  switchModel(id) {
    return this.request("POST", "/models/active", { id }, { timeout: 300000 });
  }

  /**
   * Streams a chat completion. Calls onEvent(type, data) for each SSE event
   * ("start", "token", "done", "error"). Resolves when the stream ends.
   */
  async streamChat(payload, signal, onEvent) {
    let res;
    try {
      res = await fetch(this.url("/chat/stream"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal,
      });
    } catch (e) {
      if (signal && signal.aborted) return;
      throw new ApiError(`Can't reach the Rave AI server at ${this.base}. Is it running?`);
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(friendlyError(res.status, data.detail), res.status);
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
            if (line.startsWith(":")) continue; // keep-alive comment
            if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          if (!dataLines.length) continue;
          let data;
          try {
            data = JSON.parse(dataLines.join("\n"));
          } catch {
            continue;
          }
          onEvent(type, data);
        }
      }
    } catch (e) {
      if (signal && signal.aborted) return;
      throw new ApiError("The connection to the server was lost.");
    }
  }
}

module.exports = { RaveApi, ApiError, normalizeServerUrl };
