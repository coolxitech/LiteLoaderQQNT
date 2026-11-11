const { ipcRenderer, contextBridge } = require("electron");

const sendSync = (method, args) => ipcRenderer.sendSync("LiteLoader.LiteLoader.LiteLoader", method, args);
const exposeInMainWorld = (key, value) => contextBridge.executeInMainWorld({
    func: key => key in globalThis,
    args: [key]
}) || contextBridge.exposeInMainWorld(key, value);

module.exports.LiteLoader = {
    ...sendSync([], []),
    api: {
        config: {
            get: async (...args) => sendSync(["api", "config", "get"], args),
            set: async (...args) => sendSync(["api", "config", "set"], args)
        },
        plugin: {
            install: async (...args) => sendSync(["api", "plugin", "install"], args),
            delete: async (...args) => sendSync(["api", "plugin", "delete"], args),
            disable: async (...args) => sendSync(["api", "plugin", "disable"], args),
            // 插件市场走 ipcRenderer.invoke（异步），不能用 sendSync
            market: {
                list: async (refresh) => ipcRenderer.invoke("LiteLoader.Market.list", refresh),
                installed: async () => ipcRenderer.invoke("LiteLoader.Market.installed"),
                install: async (slug, url) => ipcRenderer.invoke("LiteLoader.Market.install", slug, url),
                uninstall: async (slug, removeData) => ipcRenderer.invoke("LiteLoader.Market.uninstall", slug, removeData)
            }
        },
        // 加载器自身版本检测也走异步 invoke（内部经镜像请求 GitHub）
        update: {
            check: async (refresh) => ipcRenderer.invoke("LiteLoader.Update.check", refresh)
        },
        openExternal: async (...args) => sendSync(["api", "openExternal"], args),
        openPath: async (...args) => sendSync(["api", "openPath"], args)
    }
}

exposeInMainWorld("LiteLoader", module.exports.LiteLoader);