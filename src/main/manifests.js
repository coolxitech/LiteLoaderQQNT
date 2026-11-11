const path = require("path");
const fs = require("fs");

// 插件目录扫描的公共实现。store / market / bootstrap 三处都要「遍历 plugins 下各子目录读 manifest.json」，
// 过去各写一份，坏条目的处理还不一致。统一到这里，只依赖 fs / path：
// 硬约束是绝对不能 require("electron")（store.js 顶层 require electron 并加载 major.node），
// market.js 与 bootstrap.js 依赖「可在纯 Node 下被 require 做离线自测」的性质，公共函数因此不能放 store.js。

// 读单个 manifest.json：读不到、JSON 非法、解析结果为 null 都视为无效清单返回 null，由调用方跳过
function readManifest(manifest_path) {
    try {
        const manifest = JSON.parse(fs.readFileSync(manifest_path, "utf-8"));
        return manifest ?? null;
    }
    catch { return null; }
}

// 扫描插件目录，收集各子目录的 manifest.json，返回 [{ dir, manifest }]。
// 目录不存在（或不可读）返回 []；单个插件的清单损坏只跳过该条目，不影响其余插件。
exports.readManifests = (plugins_dir) => {
    if (!plugins_dir) return [];
    let dirents = [];
    try { dirents = fs.readdirSync(plugins_dir, { withFileTypes: true }); }
    catch { return []; }
    const result = [];
    for (const dirent of dirents) {
        // 注意：不要用 dirent.path —— 该属性在 Node 21.5 起废弃、Electron 40 内置的新 Node 中已移除
        // （QQNT 9.9.37 实测为 undefined，会抛 ERR_INVALID_ARG_TYPE）。
        // readdirSync 列出的就是 plugins_dir 的直接子项，直接用已知目录拼接即可。
        // 这里也不按 dirent.isDirectory() 过滤：目录软链接（开发时常见的插件目录做法）会判成 false，
        // 读不到 manifest.json 的条目在下面自然被跳过，交给读取结果判断更准确。
        const dir = path.join(plugins_dir, dirent.name);
        const manifest = readManifest(path.join(dir, "manifest.json"));
        if (!manifest) continue;
        result.push({ dir, manifest });
    }
    return result;
};

// 按 manifest 里的 slug 查找插件，返回 { dir, manifest } 或 null。
// 不能只看插件目录名：目录名可能与 slug 不同（手动解压、改名、市场重装后带时间戳后缀等），
// 只有清单里的 slug 才是权威标识。
exports.findManifest = (plugins_dir, slug) => {
    if (!slug) return null;
    for (const entry of exports.readManifests(plugins_dir)) {
        if (entry.manifest?.slug === slug) return entry;
    }
    return null;
};
