const path = require("path");
const fs = require("fs");
const electron = require("electron");
const { readManifests } = require("./manifests.js");
const default_config = require("../common/static/config.json");

const AdmZip = (() => {
    const major_node = path.join(process.resourcesPath, "./app/major.node");
    require(major_node).load("internal_admzip", module);
    return module.exports.admZip.default;
})();

function showErrorDialog(title, message) {
    const showDialog = () => electron.dialog.showMessageBox(null, {
        type: "error",
        title: "LiteLoaderQQNT",
        message: `${title}\n${message}`
    });
    electron.app.isReady() ? showDialog() : electron.app.once("ready", showDialog);
}

function getDestPath(manifest_text) {
    const { slug } = JSON.parse(manifest_text);
    let dest_path = path.join(LiteLoader.path.plugins, slug);
    if (slug in LiteLoader.plugins) LiteLoader.api.plugin.delete(slug, [false, false], false);
    if (fs.existsSync(dest_path)) dest_path += `_${Date.now()}`;
    return dest_path;
}

// 条目名统一成正斜杠、去掉 "./" 前缀
function normalizeEntryName(entry_name) {
    return String(entry_name ?? "").replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

// 解压条目的相对路径安全校验：拒绝 ..、绝对路径、盘符路径
function isSafeEntryPath(relative) {
    if (!relative) return false;
    if (relative.startsWith("/") || relative.startsWith("\\")) return false;
    if (/^[a-zA-Z]:/.test(relative)) return false;
    return !relative.split(/[\\/]+/).includes("..");
}

// 二次校验：最终落盘路径必须仍在目标目录内
function isInsideDirectory(parent, child) {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// 把插件 zip 解压到 dest_dir（不负责清理 dest_dir，由调用方决定）：
// - 根部没有 manifest.json 时剥掉最外层目录（GitHub 归档的 repo-branch/）
// - 跳过 .github 目录、拒绝 .. / 绝对路径 / 盘符路径，二次校验落盘路径仍在 dest_dir 内
// - 落盘结束后校验根级 manifest.json 是否真的产生，没有则判定为无效插件包
// 返回 { success: true } 或 { success: false, message }，异常不向外抛。
// 注意：本函数同时被 store.installPlugin（拖入 zip / 清单手动安装）与 market.install（市场安装）复用，
// 因此手动安装也会跳过 .github 目录并做 zip-slip 校验（相对旧的 extractAllTo 是有意收紧）。
exports.extractPluginZip = (zip_path, dest_dir) => {
    try {
        const zip = new AdmZip(zip_path);
        const entries = zip.getEntries();
        // 根部没有 manifest.json 说明压缩包内有一层根目录（GitHub 归档的 repo-branch/），需要剥掉第一段
        const has_root_manifest = entries.some((entry) =>
            !entry.isDirectory && normalizeEntryName(entry.entryName) === "manifest.json"
        );
        fs.mkdirSync(dest_dir, { recursive: true });
        for (const entry of entries) {
            let name = normalizeEntryName(entry.entryName);
            if (!name) continue;
            if (!has_root_manifest) name = name.split("/").slice(1).join("/");
            if (!name) continue;
            // 跳过 .github 目录（开发用文件，安装时不需要）
            if (name.split("/").includes(".github")) continue;
            if (!isSafeEntryPath(name)) continue;
            const target = path.join(dest_dir, name);
            if (!isInsideDirectory(dest_dir, target)) continue;
            if (entry.isDirectory) {
                fs.mkdirSync(target, { recursive: true });
                continue;
            }
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, entry.getData());
        }
        // 过滤后仍没有根级 manifest.json，说明这个包不是有效插件包，不能算安装成功
        if (!fs.existsSync(path.join(dest_dir, "manifest.json"))) {
            return { success: false, message: "压缩包内未找到根级 manifest.json，可能不是有效的插件包" };
        }
        return { success: true };
    }
    catch (err) {
        return { success: false, message: err.message };
    }
}

exports.installPlugin = (plugin_path) => {
    const extname = path.extname(plugin_path);
    const basename = path.basename(plugin_path);
    const dirname = path.dirname(plugin_path);
    try {
        if (extname.toLowerCase() == ".zip") {
            const plugin_zip = new AdmZip(plugin_path);
            // 只认根部的 manifest.json：带外层目录的归档包在这里就失败，不做剥层兜底
            const manifest_entry = plugin_zip.getEntry("manifest.json");
            const manifest_text = plugin_zip.readAsText(manifest_entry);
            const dest_path = getDestPath(manifest_text);
            const result = exports.extractPluginZip(plugin_path, dest_path);
            if (!result.success) throw new Error(result.message);
            return true;
        }
        if (basename.toLowerCase() == "manifest.json") {
            const manifest_text = fs.readFileSync(plugin_path, "utf-8");
            fs.cpSync(dirname, getDestPath(manifest_text), { recursive: true });
            return true;
        }
    }
    catch (err) { showErrorDialog("安装插件时报错，请检查并手动安装", err.message); }
    return false;
}

exports.deletePlugin = (slug, [self, data], now) => {
    const config = LiteLoader.api.config.get("LiteLoader", default_config);
    const plugin = config.deleting_plugins[slug];
    if (now) {
        if (self && plugin.self) fs.rmSync(plugin.self, { recursive: true, force: true });
        if (data && plugin.data) fs.rmSync(plugin.data, { recursive: true, force: true });
        delete config.deleting_plugins[slug];
    } else {
        config.deleting_plugins[slug] = {
            self: self ? LiteLoader.plugins[slug]?.path?.plugin ?? null : null,
            data: data ? LiteLoader.plugins[slug]?.path?.data ?? null : null
        };
        if (!(self || data)) delete config.deleting_plugins[slug];
    }
    LiteLoader.api.config.set("LiteLoader", config);
}

exports.disablePlugin = (slug, enabled) => {
    // 第二个参数语义是「是否启用」：true 启用（从 disabled_plugins 移除），false 禁用（加入 disabled_plugins）。
    // 为兼容插件 API（LiteLoader.api.plugin.disable），保留 disablePlugin 名称与参数位置不变。
    const config = LiteLoader.api.config.get("LiteLoader", default_config);
    config.disabled_plugins = enabled ?
        config.disabled_plugins.filter(item => item != slug) :
        config.disabled_plugins.concat(slug);
    LiteLoader.api.config.set("LiteLoader", config);
}

exports.setPluginConfig = (slug, config) => {
    try {
        const config_path = path.join(LiteLoader.path.data, slug, "config.json");
        fs.mkdirSync(path.dirname(config_path), { recursive: true });
        fs.writeFileSync(config_path, JSON.stringify(config, null, 4), "utf-8");
        return true;
    }
    catch { return false; }
}

exports.getPluginConfig = (slug, config) => {
    try {
        const config_path = path.join(LiteLoader.path.data, slug, "config.json");
        if (fs.existsSync(config_path)) {
            const content = fs.readFileSync(config_path, "utf-8");
            return Object.assign({}, config, JSON.parse(content));
        }
        else {
            exports.setPluginConfig(slug, config);
            return Object.assign({}, config, {});
        }
    }
    catch { return config; }
}

exports.scanPluginDirectory = () => {
    // 先确保插件目录存在：加载器启动流程依赖这一步顺手把目录建出来
    fs.mkdirSync(LiteLoader.path.plugins, { recursive: true });
    // 扫描实现与 market / bootstrap 共用 manifests.readManifests（只依赖 fs / path，
    // 因此可以放在独立模块里被纯 Node 自测），这里只把结果映射回本函数原有的 { path, manifest } 结构。
    // 行为变化（有意）：旧实现遇到损坏的 manifest.json 会直接抛错并中断 LiteLoader 启动，
    // 现在统一为跳过该条目，坏插件只影响它自己，不再拖垮整个加载器。
    return readManifests(LiteLoader.path.plugins).map(plugin => ({
        path: plugin.dir,
        manifest: plugin.manifest
    }));
}
