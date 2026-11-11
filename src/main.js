const store = require("./main/store.js");
const { installHook } = require("./main/hook.js");
const { loadAllPlugins } = require("./main/loader.js");
const { Runtime } = require("./main/runtime.js");
const bootstrap = require("./main/bootstrap.js");

installHook();
loadAllPlugins();

const config = LiteLoader.api.config.get("LiteLoader", require("./common/static/config.json"));
// 先记下待删除项：下面的 deletePlugin 会把 deleting_plugins 清空，
// 推荐插件需要在这个时间点被标记为「用户已删除」，否则下次启动会被自动装回。
const deleting_slugs = Object.keys(config.deleting_plugins ?? {});
bootstrap.markDismissed(LiteLoader, deleting_slugs);
for (const slug of deleting_slugs) store.deletePlugin(slug, [true, true], true);
for (const slug in config.installing_plugins) store.installPlugin(slug);
for (const plugin of Object.values(LiteLoader.plugins)) {
    if (plugin.disabled || plugin.incompatible || !plugin.path.injects.main) continue;
    try { Runtime.registerPlugin(plugin, require(plugin.path.injects.main)); }
    catch (error) { console.log(`[Main] [${plugin.manifest.slug}]: `, error); }
}

// 推荐插件引导：异步执行，不 await，装完需要重启 QQ 才生效
bootstrap.ensureRecommendedPlugins(LiteLoader).catch((error) => console.log("[Bootstrap]", error));

if (!globalThis.qwqnt) {
    const main_path = "./application.asar/app_launcher/index.js";
    require(require("path").join(process.resourcesPath, "app", main_path));
    setImmediate(() => global.launcher.installPathPkgJson.main = main_path);
}