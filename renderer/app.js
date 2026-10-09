/* Rave AI desktop UI. Talks to the main process only through window.rave (preload). */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const icon = (id) => {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
    u.setAttribute("href", `#${id}`);
    s.appendChild(u);
    return s;
  };

  const state = {
    info: null,
    user: null,
    prefs: { useRag: true, useWeb: false },
    assistant: true,   // Rave assistant mode (memory + tools) — on by default when available
    assistantAvailable: false,  // set once we confirm the local bridge is running
    chats: [],
    chatId: null,
    streaming: null, // { requestId, chatId, text, sources, node, body, pending }
    statusTimer: null,
    pendingConfirm: null, // { id }
  };

  // ------------------------------------------------------------------ helpers
  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
  }

  function showError(form, msg) {
    const p = $(".form-error", form);
    p.textContent = msg;
    p.hidden = !msg;
  }

  async function busy(button, label, fn) {
    const old = button.textContent;
    button.disabled = true;
    button.textContent = label;
    try {
      return await fn();
    } finally {
      button.disabled = false;
      button.textContent = old;
    }
  }

  function greeting(name) {
    const h = new Date().getHours();
    const part = h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    return `${part}, ${name}`;
  }

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      if (button) {
        const use = $("use", button);
        if (use) {
          use.setAttribute("href", "#i-check");
          setTimeout(() => use.setAttribute("href", "#i-copy"), 1400);
        }
      }
    } catch {
      toast("Couldn't copy to clipboard");
    }
  }

  // ------------------------------------------------------------------ markdown
  marked.setOptions({ gfm: true, breaks: false });

  function renderMarkdown(target, text) {
    target.innerHTML = DOMPurify.sanitize(marked.parse(text || ""), { USE_PROFILES: { html: true } });
    target.querySelectorAll("pre > code").forEach((code) => {
      const pre = code.parentElement;
      const lang = ((code.className.match(/language-([\w+#.-]+)/) || [])[1] || "").toLowerCase();
      const block = el("div", "code-block");
      const head = el("div", "code-head");
      head.appendChild(el("span", "", lang || "code"));
      const btn = el("button");
      btn.type = "button";
      btn.append(icon("i-copy"), document.createTextNode("Copy"));
      btn.addEventListener("click", () => copyText(code.textContent, btn));
      head.appendChild(btn);
      pre.replaceWith(block);
      block.append(head, pre);
      try {
        if (lang && hljs.getLanguage(lang)) hljs.highlightElement(code);
        else code.innerHTML = hljs.highlightAuto(code.textContent).value;
        code.classList.add("hljs");
      } catch {
        /* plain text is fine */
      }
    });
  }

  // Links inside answers open in the system browser (handled by the main process).
  document.addEventListener("click", (e) => {
    const a = e.target.closest(".md a[href]");
    if (a) {
      e.preventDefault();
      const href = a.getAttribute("href");
      if (/^https?:\/\//i.test(href)) window.open(href);
    }
  });

  // ------------------------------------------------------------------ auth view
  function showAuth() {
    $("#app-view").classList.add("hidden");
    $("#auth-view").classList.remove("hidden");
    clearInterval(state.statusTimer);
    const remote = state.info.authMode === "remote";
    $("#auth-sub").textContent = remote
      ? "Sign in with your Rave AI website account."
      : "Your private AI, on your own hardware.";
    $("#signup-form [name=serverUrl]").value = state.info.defaultServerUrl;
    switchTab("login");
  }

  function switchTab(tab) {
    const login = tab === "login";
    $("#tab-login").classList.toggle("active", login);
    $("#tab-signup").classList.toggle("active", !login);
    $("#login-form").classList.toggle("hidden", !login);
    $("#signup-form").classList.toggle("hidden", login);
    showError($("#login-form"), "");
    showError($("#signup-form"), "");
    setTimeout(() => $(login ? "#login-form [name=username]" : "#signup-form [name=username]").focus(), 0);
  }

  $("#tab-login").addEventListener("click", () => switchTab("login"));
  $("#tab-signup").addEventListener("click", () => switchTab("signup"));

  document.querySelectorAll(".reveal").forEach((b) =>
    b.addEventListener("click", () => {
      const input = b.parentElement.querySelector("input");
      input.type = input.type === "password" ? "text" : "password";
    }),
  );

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    showError(f, "");
    try {
      const user = await busy($("button[type=submit]", f), "Signing in…", () =>
        window.rave.auth.login({
          username: f.username.value,
          password: f.password.value,
          remember: f.remember.checked,
        }),
      );
      f.password.value = "";
      enterApp(user);
    } catch (err) {
      showError(f, err.message);
    }
  });

  $("#signup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    showError(f, "");
    if (f.password.value !== f.confirm.value) return showError(f, "Passwords don't match.");
    try {
      const user = await busy($("button[type=submit]", f), "Verifying API key…", () =>
        window.rave.auth.signup({
          username: f.username.value,
          email: f.email.value,
          password: f.password.value,
          serverUrl: f.serverUrl.value,
          apiKey: f.apiKey.value,
          remember: f.remember.checked,
        }),
      );
      f.reset();
      enterApp(user);
      toast("Account created. Welcome to Rave AI!");
    } catch (err) {
      showError(f, err.message);
    }
  });

  // ------------------------------------------------------------------ app view
  async function enterApp(user) {
    state.user = user;
    $("#auth-view").classList.add("hidden");
    $("#app-view").classList.remove("hidden");
    $("#user-name").textContent = user.username;
    $("#user-avatar").textContent = user.username.slice(0, 1);
    $("#greeting").textContent = greeting(user.username);
    try {
      state.prefs = await window.rave.prefs.get();
    } catch {
      /* defaults */
    }
    syncChips();
    await refreshChats();
    newChat();
    refreshModels();
    refreshStatus();
    updateAssistantAvailability();
    clearInterval(state.statusTimer);
    state.statusTimer = setInterval(refreshStatus, 8000);
  }

  // The assistant needs the local bridge. On a plain client (e.g. a downloaded
  // exe with no backend) it won't be there — degrade quietly to cloud chat.
  async function updateAssistantAvailability() {
    let ready = false;
    try {
      if (state.info && state.info.jarvisEnabled) {
        const s = await window.rave.jarvis.status();
        ready = !!(s && s.enabled && s.ready);
      }
    } catch { /* not available */ }
    state.assistantAvailable = ready;
    const chip = $("#toggle-assistant");
    if (!state.info || !state.info.jarvisEnabled) {
      chip.classList.add("hidden");       // assistant disabled in this build
    } else {
      chip.classList.remove("hidden");
      chip.classList.toggle("disabled", !ready);
      chip.title = ready
        ? "Rave assistant: memory, calendar, email and tools"
        : "Assistant unavailable — the local Rave Assistant service isn't running";
    }
    if (!ready) state.assistant = false;
    syncChips();
  }

  // The status dot and tooltip live on the model picker in the sidebar footer.
  // The picker's label shows the model name (managed by refreshModels).
  function setPickerState(cls, title) {
    const picker = $("#model-picker");
    picker.classList.remove("online", "warn", "offline");
    if (cls) picker.classList.add(cls);
    $("#model-btn").title = title;
  }

  async function refreshStatus() {
    try {
      const s = await window.rave.serverStatus();
      if (!s.online) {
        setPickerState("offline", `Can't reach ${s.url}`);
        if ($("#model-current").textContent === "Connecting…") $("#model-current").textContent = "Server offline";
      } else if (!s.modelLoaded) {
        setPickerState("warn", `Model not loaded — ${s.url}`);
      } else {
        setPickerState("online", `Connected to ${s.url} · click to switch model`);
        if (!models.length) refreshModels();   // server came up after sign-in
      }
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------ chat list
  async function refreshChats() {
    state.chats = await window.rave.chats.list();
    renderChatList();
  }

  function renderChatList() {
    const list = $("#chat-list");
    list.textContent = "";
    if (!state.chats.length) {
      list.appendChild(el("div", "chat-empty", "Your chats will appear here."));
      return;
    }
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const groups = [
      ["Today", (d) => d >= startOfToday],
      ["Previous 7 days", (d) => d >= startOfToday - 7 * 864e5],
      ["Previous 30 days", (d) => d >= startOfToday - 30 * 864e5],
      ["Older", () => true],
    ];
    const used = new Set();
    for (const [name, test] of groups) {
      const items = state.chats.filter((c) => !used.has(c.id) && test(new Date(c.updatedAt)));
      if (!items.length) continue;
      list.appendChild(el("div", "chat-group", name));
      for (const c of items) {
        used.add(c.id);
        list.appendChild(chatItem(c));
      }
    }
  }

  function chatItem(c) {
    const item = el("div", "chat-item" + (c.id === state.chatId ? " active" : ""));
    item.tabIndex = 0;
    item.appendChild(el("span", "t", c.title));
    const actions = el("span", "actions");
    const ren = el("button", "icon-btn");
    ren.title = "Rename";
    ren.appendChild(icon("i-pencil"));
    const del = el("button", "icon-btn");
    del.title = "Delete";
    del.appendChild(icon("i-trash"));
    actions.append(ren, del);
    item.appendChild(actions);

    item.addEventListener("click", (e) => {
      if (!e.target.closest(".actions") && !e.target.closest("input")) openChat(c.id);
    });
    item.addEventListener("keydown", (e) => e.key === "Enter" && openChat(c.id));
    item.addEventListener("dblclick", () => startRename(item, c));
    ren.addEventListener("click", () => startRename(item, c));
    del.addEventListener("click", async () => {
      if (!confirm(`Delete "${c.title}"?`)) return;
      await window.rave.chats.remove({ id: c.id });
      if (state.chatId === c.id) newChat();
      refreshChats();
    });
    return item;
  }

  function startRename(item, c) {
    const input = el("input");
    input.value = c.title;
    item.textContent = "";
    item.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      if (save && input.value.trim() && input.value.trim() !== c.title) {
        await window.rave.chats.rename({ id: c.id, title: input.value });
        if (state.chatId === c.id) $("#chat-title").textContent = input.value.trim();
      }
      refreshChats();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  // ------------------------------------------------------------------ thread
  function setEmpty(empty) {
    $("#main").classList.toggle("empty", empty);
  }

  function newChat() {
    state.chatId = null;
    $("#thread").textContent = "";
    $("#chat-title").textContent = "";
    $("#greeting").textContent = greeting(state.user.username);
    setEmpty(true);
    renderChatList();
    $("#input").focus();
  }

  async function openChat(id) {
    let chat;
    try {
      chat = await window.rave.chats.get({ id });
    } catch (e) {
      return toast(e.message);
    }
    state.chatId = id;
    $("#chat-title").textContent = chat.title;
    const thread = $("#thread");
    thread.textContent = "";
    for (const m of chat.messages) {
      if (m.role === "user") thread.appendChild(userMessage(m.content));
      else thread.appendChild(assistantMessage(m.content, m.sources, m.stopped ? "Stopped" : ""));
    }
    // A reply to this chat may still be streaming in the background.
    if (state.streaming && state.streaming.chatId === id) {
      const s = state.streaming;
      s.node = assistantMessage("", [], "", true);
      s.body = $(".md", s.node);
      thread.appendChild(s.node);
      paintStream();
    }
    markLast();
    setEmpty(false);
    renderChatList();
    scrollToBottom(true);
    $("#input").focus();
  }

  function userMessage(text) {
    const node = el("div", "msg user");
    node.appendChild(el("div", "bubble", text));
    return node;
  }

  function assistantMessage(text, sources, note, streaming = false) {
    const node = el("div", "msg assistant" + (streaming ? " streaming" : ""));
    const mark = el("div", "mark");
    mark.appendChild(icon("logo"));
    const body = el("div", "body");
    const md = el("div", "md");
    if (streaming && !text) md.appendChild(el("span", "thinking", "Thinking…"));
    else renderMarkdown(md, text);
    body.appendChild(md);
    const src = el("div", "sources");
    body.appendChild(src);
    renderSources(src, sources);
    const actions = el("div", "msg-actions");
    const copy = el("button", "icon-btn");
    copy.title = "Copy";
    copy.appendChild(icon("i-copy"));
    copy.addEventListener("click", () => copyText(node.dataset.raw || "", copy));
    actions.appendChild(copy);
    if (note) actions.appendChild(el("span", "note", note));
    body.appendChild(actions);
    node.dataset.raw = text || "";
    node.append(mark, body);
    if (streaming) actions.classList.add("hidden");
    return node;
  }

  function renderSources(container, sources) {
    container.textContent = "";
    for (const s of sources || []) {
      const chip = el("span", "source");
      chip.appendChild(icon(s.type === "web" ? "i-globe" : "i-doc"));
      chip.appendChild(el("span", "", s.type === "web" ? s.title || s.name : s.name));
      chip.title = s.snippet || "";
      if (s.url) {
        chip.dataset.url = s.url;
        chip.addEventListener("click", () => window.open(s.url));
      }
      container.appendChild(chip);
    }
  }

  function markLast() {
    const msgs = document.querySelectorAll("#thread .msg");
    msgs.forEach((m, i) => m.classList.toggle("last", i === msgs.length - 1));
  }

  function nearBottom() {
    const s = $("#scroller");
    return s.scrollHeight - s.scrollTop - s.clientHeight < 120;
  }

  function scrollToBottom(force) {
    const s = $("#scroller");
    if (force || nearBottom()) s.scrollTop = s.scrollHeight;
  }

  // ------------------------------------------------------------------ sending
  function syncComposer() {
    const btn = $("#send-btn");
    const streaming = !!state.streaming;
    btn.classList.toggle("stop", streaming);
    $("use", btn).setAttribute("href", streaming ? "#i-stop" : "#i-send");
    btn.title = streaming ? "Stop" : "Send (Enter)";
    btn.disabled = !streaming && !$("#input").value.trim();
  }

  function autoresize() {
    const t = $("#input");
    t.style.height = "auto";
    t.style.height = `${Math.min(t.scrollHeight, 260)}px`;
  }

  async function send(textOverride) {
    if (state.streaming) return;
    const input = $("#input");
    const text = (textOverride ?? input.value).trim();
    if (!text) return;
    if (textOverride === undefined) {
      input.value = "";
      autoresize();
    }

    const thread = $("#thread");
    if (!state.chatId) thread.textContent = "";
    setEmpty(false);
    thread.appendChild(userMessage(text));
    const node = assistantMessage("", [], "", true);
    thread.appendChild(node);
    markLast();
    scrollToBottom(true);

    state.streaming = { requestId: null, chatId: state.chatId, text: "", sources: [], node, body: $(".md", node), userText: text, early: [] };
    syncComposer();

    let res;
    try {
      res = await window.rave.chat.send({
        chatId: state.chatId,
        message: text,
        useRag: state.prefs.useRag,
        useWeb: state.prefs.useWeb,
        assistant: state.assistant,
      });
    } catch (e) {
      node.remove();
      state.streaming = null;
      showErrorCard(e.message, text);
      syncComposer();
      return;
    }
    const s = state.streaming;
    s.requestId = res.requestId;
    s.chatId = res.chat.id;
    if (!state.chatId) {
      state.chatId = res.chat.id;
      $("#chat-title").textContent = res.chat.title;
    }
    refreshChats();
    // Events that raced ahead of the send() reply
    s.early.splice(0).forEach(handleEvent);
  }

  let paintQueued = false;
  function paintStream() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      const s = state.streaming;
      if (!s || !s.node.isConnected) return;
      const stick = nearBottom();
      if (s.text) renderMarkdown(s.body, s.text);
      renderSources($(".sources", s.node), s.sources);
      if (stick) scrollToBottom(true);
    });
  }

  function handleEvent(evt) {
    const s = state.streaming;
    if (!s) return;
    if (!s.requestId) {
      s.early.push(evt);
      return;
    }
    if (evt.requestId !== s.requestId) return;

    if (evt.type === "start") {
      s.sources = evt.data.sources || [];
      paintStream();
    } else if (evt.type === "status") {
      setStreamStatus(s, evt.data);
    } else if (evt.type === "confirm") {
      askConfirm(evt.data);
    } else if (evt.type === "token") {
      s.text += evt.data.token;
      paintStream();
    } else if (evt.type === "end") {
      finishStream(evt.data);
    }
  }

  const TOOL_LABELS = {
    "memory.search": "Checking memory", "memory.list": "Checking memory",
    "memory.save": "Saving to memory", "memory.forget": "Updating memory",
    "history.search": "Looking back through our chat",
    "calendar.agenda": "Checking your calendar", "calendar.next": "Checking your calendar",
    "calendar.free": "Checking your availability", "calendar.create": "Creating the event",
    "calendar.move": "Rescheduling", "calendar.cancel": "Cancelling the event",
    "email.unread": "Checking your inbox", "email.search": "Searching your email",
    "email.read": "Reading the email", "email.draft": "Drafting the email",
    "email.send": "Sending the email", "email.mark_read": "Updating your inbox",
  };

  // While the assistant works, show what it's doing in place of "Thinking…".
  function setStreamStatus(s, data) {
    if (!s || !s.node || !s.node.isConnected || s.text) return;
    const thinking = $(".thinking", s.body);
    if (!thinking) return;
    if (data.kind === "tool") thinking.textContent = `${TOOL_LABELS[data.name] || "Working on it"}…`;
    else if (data.kind === "thinking" && thinking.textContent !== "Thinking…") {
      /* keep the last tool label until a new one arrives */
    } else if (data.kind === "thinking") thinking.textContent = "Thinking…";
  }

  // ------------------------------------------------------------------ confirmations
  function askConfirm(data) {
    state.pendingConfirm = { id: data.id };
    $("#confirm-text").textContent = data.prompt || "Allow this action?";
    $("#confirm-modal").classList.remove("hidden");
  }
  async function resolveConfirm(approve) {
    const p = state.pendingConfirm;
    state.pendingConfirm = null;
    $("#confirm-modal").classList.add("hidden");
    if (!p) return;
    try {
      await window.rave.jarvis.confirm({ id: p.id, approve });
    } catch (e) {
      toast(e.message);
    }
  }
  $("#confirm-allow").addEventListener("click", () => resolveConfirm(true));
  $("#confirm-deny").addEventListener("click", () => resolveConfirm(false));

  function finishStream({ error, stopped }) {
    const s = state.streaming;
    state.streaming = null;
    syncComposer();
    const visible = s.node.isConnected && state.chatId === s.chatId;
    if (visible) {
      if (!s.text.trim()) {
        s.node.remove();
        if (error) showErrorCard(error, s.userText);
        else if (stopped) toast("Stopped");
      } else {
        const fresh = assistantMessage(s.text.trim(), s.sources, stopped ? "Stopped" : error ? `Interrupted: ${error}` : "");
        s.node.replaceWith(fresh);
      }
      markLast();
    } else if (error) {
      toast(error);
    }
    refreshChats();
    refreshStatus();
  }

  function showErrorCard(message, retryText) {
    const card = el("div", "error-card");
    card.appendChild(el("span", "", message));
    const retry = el("button", "btn");
    retry.append(icon("i-retry"), document.createTextNode("Retry"));
    retry.addEventListener("click", () => {
      card.remove();
      // Remove the failed user bubble; send() re-adds it.
      const users = document.querySelectorAll("#thread .msg.user");
      const last = users[users.length - 1];
      if (last && last.textContent === retryText) last.remove();
      send(retryText);
    });
    card.appendChild(retry);
    $("#thread").appendChild(card);
    scrollToBottom(true);
  }

  window.rave.chat.onEvent(handleEvent);

  const input = $("#input");
  input.addEventListener("input", () => {
    autoresize();
    syncComposer();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    if (state.streaming) {
      if (state.streaming.requestId) window.rave.chat.stop({ requestId: state.streaming.requestId });
    } else {
      send();
    }
  });

  // ------------------------------------------------------------------ toggles
  function syncChips() {
    $("#toggle-assistant").classList.toggle("on", !!state.assistant);
    $("#toggle-rag").classList.toggle("on", !!state.prefs.useRag);
    $("#toggle-web").classList.toggle("on", !!state.prefs.useWeb);
    // In assistant mode the brain-side Documents/Web chips don't apply.
    const off = !!state.assistant;
    $("#toggle-rag").classList.toggle("muted-chip", off);
    $("#toggle-web").classList.toggle("muted-chip", off);
  }
  function toggle(key) {
    state.prefs[key] = !state.prefs[key];
    syncChips();
    window.rave.prefs.set(state.prefs).catch(() => {});
  }
  $("#toggle-rag").addEventListener("click", () => toggle("useRag"));
  $("#toggle-web").addEventListener("click", () => toggle("useWeb"));
  $("#toggle-assistant").addEventListener("click", () => {
    if (!state.assistantAvailable) {
      updateAssistantAvailability();   // re-check in case the bridge just came up
      return toast("The Rave Assistant service isn't running on this machine.");
    }
    state.assistant = !state.assistant;
    syncChips();
  });

  // ------------------------------------------------------------------ model picker
  let models = [];
  let activeModel = null;

  let modelsError = "";

  async function refreshModels() {
    try {
      const data = await window.rave.models.list();
      models = data.models;
      activeModel = data.active;
      modelsError = "";
    } catch (e) {
      models = [];
      modelsError = e.message || "Can't reach the server.";
    }
    const current = models.find((m) => m.id === activeModel);
    if (current) $("#model-current").textContent = current.name;
    return models;
  }

  function renderModelMenu() {
    const menu = $("#model-menu");
    menu.textContent = "";
    if (!models.length) {
      const info = el("div", "model-empty");
      info.textContent = modelsError || "Loading models…";
      menu.appendChild(info);
      const retry = el("button", "model-opt");
      retry.style.justifyContent = "center";
      retry.appendChild(el("div", "mname", "Retry"));
      retry.addEventListener("click", async (e) => {
        e.stopPropagation();
        await refreshModels();
        renderModelMenu();
      });
      menu.appendChild(retry);
      return;
    }
    for (const m of models) {
      const opt = el("button", "model-opt");
      opt.disabled = !m.available || m.id === activeModel;
      const tick = el("span", "tick");
      if (m.id === activeModel) tick.appendChild(icon("i-check"));
      const info = el("div");
      const name = el("div", "mname");
      name.appendChild(document.createTextNode(m.name));
      if (!m.available) {
        const b = el("span", "badge missing", "not downloaded");
        name.appendChild(b);
      }
      info.appendChild(name);
      if (m.notes) info.appendChild(el("div", "mnotes", m.notes));
      opt.append(tick, info);
      opt.addEventListener("click", () => {
        closeModelMenu();
        if (m.available && m.id !== activeModel) switchModel(m);
      });
      menu.appendChild(opt);
    }
  }

  async function openModelMenu() {
    renderModelMenu();                 // show current (or a loading/empty state) right away
    $("#model-menu").classList.remove("hidden");
    $("#model-picker").classList.add("open");
    await refreshModels();             // always fetch fresh when opening
    if (!$("#model-menu").classList.contains("hidden")) renderModelMenu();
  }
  function closeModelMenu() {
    $("#model-menu").classList.add("hidden");
    $("#model-picker").classList.remove("open");
  }

  $("#model-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    if ($("#model-menu").classList.contains("hidden")) openModelMenu();
    else closeModelMenu();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#model-picker")) closeModelMenu();
  });

  async function switchModel(m) {
    if (state.streaming && state.streaming.requestId) {
      window.rave.chat.stop({ requestId: state.streaming.requestId });
    }
    $("#model-btn").classList.add("switching");
    $("#switch-text").textContent = `Loading ${m.name}…`;
    $("#switch-overlay").classList.remove("hidden");
    try {
      await window.rave.models.switch({ id: m.id });
      activeModel = m.id;
      $("#model-current").textContent = m.name;
      toast(`Switched to ${m.name}`);
      refreshModels();
      refreshStatus();
    } catch (e) {
      toast(e.message);
    } finally {
      $("#model-btn").classList.remove("switching");
      $("#switch-overlay").classList.add("hidden");
    }
  }

  // ------------------------------------------------------------------ sidebar
  $("#new-chat").addEventListener("click", newChat);
  $("#collapse-btn").addEventListener("click", () => {
    $("#app-view").classList.add("collapsed");
    $("#expand-btn").classList.remove("hidden");
  });
  $("#expand-btn").addEventListener("click", () => {
    $("#app-view").classList.remove("collapsed");
    $("#expand-btn").classList.add("hidden");
  });

  // ------------------------------------------------------------------ settings
  async function openSettings() {
    const acct = await window.rave.account.get();
    $("#s-username").textContent = acct.username;
    $("#s-email").textContent = acct.email || "—";
    $("#s-mode").textContent = state.info.authMode === "remote" ? "Website account" : "Local account (this PC)";
    $("#s-version").textContent = `Rave AI v${state.info.version}`;
    const f = $("#conn-form");
    f.serverUrl.value = acct.serverUrl;
    f.apiKey.value = "";
    f.apiKey.type = "password";
    f.apiKey.placeholder = `Current key: ${acct.apiKeyHint}`;
    showError(f, "");
    $(".form-ok", f).hidden = true;
    renderServerSwitch(acct.servers || []);
    $("#settings").classList.remove("hidden");
    refreshIntegrations();
  }

  function serverLabel(url) {
    try {
      const h = new URL(url).host;
      if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(h)) return "Local";
      return h;
    } catch {
      return url;
    }
  }

  function renderServerSwitch(servers) {
    const box = $("#server-switch");
    box.textContent = "";
    for (const s of servers) {
      const btn = el("button", "server-chip" + (s.active ? " active" : ""));
      btn.type = "button";
      btn.appendChild(el("span", "sc-label", serverLabel(s.url)));
      if (s.active) btn.appendChild(el("span", "sc-badge", "current"));
      else if (!s.hasKey) btn.appendChild(el("span", "sc-badge dim", "needs key"));
      btn.title = s.url;
      if (!s.active) btn.addEventListener("click", () => switchServer(s.url));
      box.appendChild(btn);
    }
  }

  async function switchServer(url) {
    try {
      const res = await window.rave.account.switchServer({ serverUrl: url });
      if (res && res.needsKey) {
        const f = $("#conn-form");
        f.serverUrl.value = url;
        f.apiKey.value = "";
        f.apiKey.focus();
        toast(`Enter an API key for ${serverLabel(url)}, then Save & verify.`);
        return;
      }
      toast(`Switched to ${serverLabel(url)}`);
      const acct = await window.rave.account.get();
      $("#conn-form").serverUrl.value = acct.serverUrl;
      renderServerSwitch(acct.servers || []);
      refreshStatus();
      refreshModels();
    } catch (e) {
      toast(e.message);
    }
  }
  function closeSettings() {
    $("#settings").classList.add("hidden");
  }

  // ------------------------------------------------------------------ integrations
  let jarvisStatus = null;

  async function refreshIntegrations() {
    const section = $("#integrations-section");
    if (!state.info || !state.info.jarvisEnabled) {
      section.classList.add("hidden");
      return;
    }
    section.classList.remove("hidden");
    try {
      jarvisStatus = await window.rave.jarvis.status();
    } catch (e) {
      jarvisStatus = { ready: false, error: e.message };
    }
    const st = $("#jarvis-state");
    if (!jarvisStatus.ready) {
      st.textContent = jarvisStatus.error || "The local assistant isn't running yet.";
      st.classList.add("warn");
      return;
    }
    st.textContent = jarvisStatus.brain_online ? "Assistant ready." : "Assistant ready (brain offline).";
    st.classList.remove("warn");

    // Google connection — three states: needs setup, ready to authorize, connected.
    const gbtn = $("#google-btn");
    const gstate = $("#google-state");
    gbtn.disabled = false;
    if (!jarvisStatus.google_available) {
      gstate.textContent = "Google libraries not installed";
      gbtn.disabled = true;
    } else if (jarvisStatus.google_connected) {
      gstate.textContent = "Connected";
      gbtn.textContent = "Disconnect";
      gbtn.dataset.action = "disconnect";
    } else if (jarvisStatus.google_has_client) {
      gstate.textContent = "Set up — click Connect to sign in";
      gbtn.textContent = "Connect";
      gbtn.dataset.action = "connect";
    } else {
      gstate.textContent = "Not set up";
      gbtn.textContent = "Set up Google";
      gbtn.dataset.action = "setup";
    }

    // Toggles
    const t = jarvisStatus.toggles || {};
    document.querySelectorAll("#integrations-section [data-int]").forEach((cb) => {
      cb.checked = !!t[cb.dataset.int];
    });

    // Memory count
    $("#mem-count").textContent = jarvisStatus.memory ? `(${jarvisStatus.memory.memories})` : "";
    refreshMemoryList();
  }

  async function refreshMemoryList() {
    const list = $("#mem-list");
    list.textContent = "Loading…";
    try {
      const { memories } = await window.rave.jarvis.memoryList();
      list.textContent = "";
      if (!memories.length) {
        list.appendChild(el("div", "mem-empty", "Nothing remembered yet."));
        return;
      }
      for (const m of memories) {
        const row = el("div", "mem-item");
        row.appendChild(el("span", "mem-kind", m.kind));
        row.appendChild(el("span", "mem-text", m.text));
        const del = el("button", "icon-btn");
        del.title = "Forget";
        del.appendChild(icon("i-trash"));
        del.addEventListener("click", async () => {
          try {
            await window.rave.jarvis.memoryForget({ query: m.text });
            refreshIntegrations();
          } catch (e) { toast(e.message); }
        });
        row.appendChild(del);
        list.appendChild(row);
      }
    } catch (e) {
      list.textContent = e.message;
    }
  }

  $("#google-btn").addEventListener("click", async (e) => {
    const action = e.currentTarget.dataset.action;
    if (action === "setup") return openGoogleSetup();
    if (action === "disconnect") {
      await busy(e.currentTarget, "Disconnecting…", async () => {
        try {
          const res = await window.rave.jarvis.disconnectGoogle();
          toast((res && res.message) || "Google disconnected.");
        } catch (err) { toast(err.message); }
      });
      return refreshIntegrations();
    }
    await runGoogleConnect(e.currentTarget);
    refreshIntegrations();
  });

  // Runs the OAuth browser flow. If no client is set up yet, opens the setup dialog.
  async function runGoogleConnect(btn) {
    try {
      const res = await busy(btn, "Opening browser…", () => window.rave.jarvis.connectGoogle());
      if (res && res.google_connected) { toast("Google connected."); return true; }
      if (res && res.need_client) { openGoogleSetup(); return false; }
      toast((res && res.message) || "Couldn't connect to Google.");
    } catch (err) {
      toast(err.message);
    }
    return false;
  }

  // ---- Google one-time setup dialog ----
  function openGoogleSetup() {
    $("#google-json").value = "";
    $("#google-err").hidden = true;
    $("#google-modal").classList.remove("hidden");
    setTimeout(() => $("#google-json").focus(), 0);
  }
  function closeGoogleSetup() { $("#google-modal").classList.add("hidden"); }
  $("#google-close").addEventListener("click", closeGoogleSetup);
  $("#google-modal").addEventListener("mousedown", (e) => e.target.id === "google-modal" && closeGoogleSetup());

  $("#google-save").addEventListener("click", async (e) => {
    const err = $("#google-err");
    err.hidden = true;
    const clientJson = $("#google-json").value.trim();
    if (!clientJson) { err.textContent = "Paste the OAuth client JSON first."; err.hidden = false; return; }
    try {
      await busy(e.currentTarget, "Saving…", () => window.rave.jarvis.saveGoogleClient({ clientJson }));
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      return;
    }
    closeGoogleSetup();
    toast("Setup saved. Opening Google sign-in…");
    await runGoogleConnect($("#google-btn"));   // straight into the browser consent
    refreshIntegrations();
  });

  document.querySelectorAll("#integrations-section [data-int]").forEach((cb) => {
    cb.addEventListener("change", async () => {
      try {
        jarvisStatus = await window.rave.jarvis.toggle({ name: cb.dataset.int, on: cb.checked });
      } catch (e) {
        toast(e.message);
        cb.checked = !cb.checked;
      }
    });
  });

  $("#mem-refresh").addEventListener("click", refreshIntegrations);

  $("#user-btn").addEventListener("click", openSettings);
  $("#settings-close").addEventListener("click", closeSettings);
  $("#settings").addEventListener("mousedown", (e) => e.target.id === "settings" && closeSettings());

  $("#conn-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    showError(f, "");
    $(".form-ok", f).hidden = true;
    try {
      await busy($("button[type=submit]", f), "Verifying…", () =>
        window.rave.account.updateConnection({ serverUrl: f.serverUrl.value, apiKey: f.apiKey.value }),
      );
      $(".form-ok", f).hidden = false;
      f.apiKey.value = "";
      refreshStatus();
      refreshModels();
      try {
        const acct = await window.rave.account.get();
        renderServerSwitch(acct.servers || []);
      } catch { /* ignore */ }
    } catch (err) {
      showError(f, err.message);
    }
  });

  $("#logout-btn").addEventListener("click", async () => {
    await window.rave.auth.logout();
    closeSettings();
    state.user = null;
    state.streaming = null;
    syncComposer();
    showAuth();
  });

  // ------------------------------------------------------------------ keyboard
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#google-modal").classList.contains("hidden")) return closeGoogleSetup();
    if (e.key === "Escape" && !$("#confirm-modal").classList.contains("hidden")) return resolveConfirm(false);
    if (e.key === "Escape" && !$("#settings").classList.contains("hidden")) closeSettings();
    if (state.user && e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "n") {
      e.preventDefault();
      newChat();
    }
  });

  // ------------------------------------------------------------------ boot
  function hideBoot() {
    $("#boot-view").classList.add("hidden");
  }

  async function proceedAfterServer() {
    hideBoot();
    let user = null;
    try {
      user = await window.rave.auth.restore();
    } catch {
      /* show sign-in */
    }
    if (user) enterApp(user);
    else showAuth();
  }

  function showBootError(res) {
    $("#boot-view").classList.add("failed");
    $("#boot-status").classList.add("hidden");
    $("#boot-error").classList.remove("hidden");
    $("#boot-error-text").textContent = res.error || "The Rave AI server could not be reached.";
    if (res.local === false) {
      $("#boot-hint").textContent =
        `This app is set up as a client of a hosted server (${state.info.defaultServerUrl}). ` +
        "Make sure that server is running and reachable, then Retry.";
    } else if (res.managed) {
      $("#boot-hint").textContent =
        `You can also start it manually by running run.bat in the project folder. Log: ${res.logPath || ""}`;
    } else {
      $("#boot-hint").textContent = "Start the server with run.bat, then Retry.";
    }
  }

  async function bootServer(retry) {
    $("#boot-view").classList.remove("failed", "hidden");
    $("#boot-status").classList.remove("hidden");
    $("#boot-error").classList.add("hidden");
    const hosting = state.info.serverIsLocal && state.info.serverAutostart;
    $("#boot-status").textContent = hosting
      ? (retry ? "Starting the Rave AI server…"
               : "Starting Rave AI… the first launch loads the model, which can take a minute.")
      : `Connecting to the Rave AI server at ${state.info.defaultServerUrl}…`;
    let res;
    try {
      res = await window.rave.serverBoot(retry ? { retry: true } : {});
    } catch (e) {
      res = { ready: false, managed: true, error: e.message };
    }
    if (res.ready) proceedAfterServer();
    else showBootError(res);
  }

  $("#boot-retry").addEventListener("click", () => bootServer(true));
  $("#boot-continue").addEventListener("click", proceedAfterServer);

  (async () => {
    state.info = await window.rave.appInfo();
    bootServer(false);
  })();
})();
