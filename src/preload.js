// The only bridge between the UI and the main process. The UI never sees the API key.
const { contextBridge, ipcRenderer } = require("electron");

const call = (channel) => async (args) => {
  const res = await ipcRenderer.invoke(channel, args);
  if (!res.ok) throw new Error(res.error);
  return res.data;
};

contextBridge.exposeInMainWorld("rave", {
  appInfo: call("app:info"),
  serverBoot: call("server:boot"),
  auth: {
    restore: call("auth:restore"),
    signup: call("auth:signup"),
    login: call("auth:login"),
    logout: call("auth:logout"),
  },
  account: {
    get: call("account:get"),
    updateConnection: call("account:update-connection"),
  },
  models: { list: call("models:list"), switch: call("models:switch") },
  serverStatus: call("server:status"),
  prefs: { get: call("prefs:get"), set: call("prefs:set") },
  chats: {
    list: call("chats:list"),
    get: call("chats:get"),
    remove: call("chats:delete"),
    rename: call("chats:rename"),
  },
  chat: {
    send: call("chat:send"),
    stop: call("chat:stop"),
    onEvent: (cb) => ipcRenderer.on("chat:event", (_e, payload) => cb(payload)),
  },
});
