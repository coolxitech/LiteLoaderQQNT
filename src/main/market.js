const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
// HTTP 客户端与镜像策略在 net.js；加载器更新检查与 release 资产解析在 update.js，
// 本模块只负责插件市场（列表 / 已安装 / 安装 / 卸载）。
const { fetchBufferWithMirror } = require("./net.js");
// 插件目录扫描逻辑与 store / bootstrap 共用（manifests.js 只依赖 fs / path，不引入 electron）
const { readManifests, findManifest } = require("./manifests.js");

// 插件市场数据源与并发上限（镜像列表与超时参数在 net.js）
const LIST_URL = "https://raw.githubusercontent.com/LiteLoaderQQNT/Plugin-List/v4/plugins.json";
const MANIFEST_URL = (repo, branch) => `https://raw.githubusercontent.com/${repo}/${branch}/manifest.json`;
const PACKAGE_URL = (repo, branch) => `https://raw.githubusercontent.com/${repo}/${branch}/package.json`;
const CONCURRENCY = 10;

// 进程内缓存：refresh=false 且已有缓存时直接返回
let list_cache = null;
// 并发合并：同一时刻只允许一次真实拉取
let list_pending = null;

// 限制并发上限的 map，保持结果顺序
async function mapLimit(items, limit, handler) {
    const results = new Array(items.length);
    let index = 0;
    const worker = async () => {
        while (index < items.length) {
            const current = index++;
            results[current] = await handler(items[current], current);
        }
    };
    const size = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: size }, worker));
    return results;
}

// 把 package.json 的 author 字段规范成 manifest 的 authors 结构
function normalizeAuthors(author) {
    if (!author) return undefined;
    const list = Array.isArray(author) ? author : [author];
    const authors = list
        .map((item) => {
            if (typeof item === "string") return { name: item, link: "" };
            if (item && typeof item === "object") {
                return { name: item.name ?? "", link: item.link ?? item.url ?? item.email ?? "" };
            }
            return null;
        })
        .filter((item) => item && item.name);
    return authors.length ? authors : undefined;
}

// 拉取单个仓库的插件清单：先 manifest.json，404 时回退 package.json 的 liteloader_manifest
async function fetchPluginManifest(repo, branch) {
    try {
        const manifest_response = await fetchBufferWithMirror(MANIFEST_URL(repo, branch));
        if (manifest_response.statusCode === 200) {
            try { return { manifest: JSON.parse(manifest_response.body.toString("utf-8")), error: null }; }
            catch (error) { return { manifest: null, error: `manifest.json 解析失败：${error.message}` }; }
        }
        const package_response = await fetchBufferWithMirror(PACKAGE_URL(repo, branch));
        if (package_response.statusCode === 200) {
            let pkg;
            try { pkg = JSON.parse(package_response.body.toString("utf-8")); }
            catch (error) { return { manifest: null, error: `package.json 解析失败：${error.message}` }; }
            const manifest = pkg?.liteloader_manifest;
            if (manifest && typeof manifest === "object") {
                // 老格式插件把清单放在 package.json 里，缺失的字段用 package.json 补齐
                manifest.version ??= pkg.version;
                manifest.description ??= pkg.description;
                manifest.authors ??= normalizeAuthors(pkg.author);
                return { manifest, error: null };
            }
            return { manifest: null, error: "未找到 manifest.json 或 package.json 的 liteloader_manifest" };
        }
        return { manifest: null, error: `manifest.json HTTP ${manifest_response.statusCode}，package.json HTTP ${package_response.statusCode}` };
    }
    catch (error) {
        return { manifest: null, error: error.message };
    }
}

async function fetchPluginList() {
    const response = await fetchBufferWithMirror(LIST_URL);
    if (response.statusCode !== 200) throw new Error(`插件列表 HTTP ${response.statusCode}`);
    let items;
    try { items = JSON.parse(response.body.toString("utf-8")); }
    catch (error) { throw new Error(`插件列表解析失败：${error.message}`); }
    if (!Array.isArray(items)) throw new Error("插件列表格式不正确");
    const data = await mapLimit(items, CONCURRENCY, async (item) => {
        const repo = typeof item?.repo === "string" ? item.repo : "";
        const branch = typeof item?.branch === "string" && item.branch ? item.branch : "main";
        if (!repo) return { repo, branch, manifest: null, error: "插件列表条目缺少 repo" };
        const { manifest, error } = await fetchPluginManifest(repo, branch);
        return { repo, branch, manifest, error };
    });
    return { success: true, data };
}

// slug 会作为插件目录名使用，必须拒绝路径穿越：
// - 只允许字母数字与 . _ -，且首字符不能是点（排除 "."、".."、".hidden" 这类隐藏目录）；
//   该字符集本身已排除 "/"、"\"、":"，因此 "a/b"、"a\b"、"C:x" 都会被拒绝；
// - 末字符不能是点或空格：Windows 会静默剥离目录名尾部的点/空格，实际落盘目录名与 slug
//   不一致会导致「装好了却检测不到」并反复重装。
const SLUG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
function isSafeSlug(slug) {
    if (typeof slug !== "string" || !slug) return false;
    if (!SLUG_PATTERN.test(slug)) return false;
    return !/[. ]$/.test(slug);
}

// zip 解压与 zip-slip 校验统一由 store.js 的 extractPluginZip 提供，
// 这里不在顶层 require：store.js 顶层会 require("electron") 并立即加载 major.node，
// 顶层引入会让本模块无法在纯 Node 下被 require（离线自测/静态检查都依赖这一点）。

// 在插件目录下按 manifest.json 的 slug 查找插件路径（找不到返回 null）
function findPluginPath(plugins_dir, slug) {
    if (!plugins_dir) return null;
    return findManifest(plugins_dir, slug)?.dir ?? null;
}

// 插件列表：refresh=false 命中缓存，refresh=true 强制重拉
exports.list = async (LiteLoader, refresh = false) => {
    if (!refresh && list_cache) return list_cache;
    if (list_pending) return list_pending;
    list_pending = fetchPluginList().then(
        (result) => {
            list_cache = result;
            return result;
        },
        (error) => ({ success: false, message: `获取插件列表失败：${error.message}` })
    ).finally(() => { list_pending = null; });
    return list_pending;
};

// 已安装插件：扫描插件目录的 manifest.json，并并入已加载的插件
exports.installed = async (LiteLoader) => {
    const plugins_dir = LiteLoader?.path?.plugins;
    const result = [];
    const seen = new Set();
    if (plugins_dir) {
        // 目录不存在 / 清单损坏的条目由 readManifests 跳过，这里只做去重
        for (const { manifest } of readManifests(plugins_dir)) {
            if (!manifest?.slug || seen.has(manifest.slug)) continue;
            seen.add(manifest.slug);
            result.push({ slug: manifest.slug, version: manifest.version ?? null });
        }
    }
    // 并入已加载的插件，按 slug 去重
    for (const [slug, plugin] of Object.entries(LiteLoader?.plugins ?? {})) {
        if (seen.has(slug)) continue;
        seen.add(slug);
        result.push({ slug, version: plugin?.manifest?.version ?? null });
    }
    return result;
};

// 安装插件：下载 zip 到临时目录 → 解压到系统临时暂存目录 → 校验清单 → 换入 plugins/<slug>
// options.expectedSha256 非空时先校验安装包哈希，不匹配则不落盘解压。
// 关键顺序保证：任何一步失败都不会动到用户已安装的 plugins/<slug>。
exports.install = async (LiteLoader, slug, url, options = {}) => {
    if (!isSafeSlug(slug)) return { success: false, message: `插件 slug 不合法：${slug}` };
    if (typeof url !== "string" || !url) return { success: false, message: "插件下载地址为空" };
    const plugins_dir = LiteLoader?.path?.plugins;
    if (!plugins_dir) return { success: false, message: "未找到插件目录" };
    let temp_zip = null;
    let staging = null;
    try {
        // 惰性引入：store.js 顶层依赖 electron 与 major.node，这里才真正需要解压实现
        const store = require("./store.js");
        const response = await fetchBufferWithMirror(url);
        if (response.statusCode !== 200) {
            return { success: false, message: `下载插件失败：HTTP ${response.statusCode}` };
        }
        temp_zip = path.join(os.tmpdir(), `liteloader-market-${Date.now()}-${process.pid}.zip`);
        fs.writeFileSync(temp_zip, response.body);
        // 完整性校验：只在调用方给出期望哈希时启用，返回后由 finally 删除临时 zip
        if (options.expectedSha256) {
            const actual = crypto.createHash("sha256").update(response.body).digest("hex");
            if (actual.toLowerCase() !== String(options.expectedSha256).toLowerCase()) {
                return { success: false, message: `安装包校验失败：期望 ${options.expectedSha256}，实际 ${actual}` };
            }
        }
        const dest_dir = path.join(plugins_dir, slug);
        // 防御：LITELOADERQQNT_PROFILE 被置空时 plugins 目录可能退化成相对路径，
        // 而换入阶段要递归删除目标目录，绝不能在相对路径上执行（须早于任何落盘动作）
        if (!path.isAbsolute(dest_dir)) {
            return { success: false, message: "插件目录不是绝对路径，已拒绝操作" };
        }
        fs.mkdirSync(plugins_dir, { recursive: true });
        // 先解压到系统临时目录，校验通过后再换入：
        // 暂存目录必须放在 os.tmpdir()，不能放在 plugins_dir 内，否则带 manifest.json 的暂存目录
        // 会被 scanPluginDirectory 误扫成一个插件。
        staging = fs.mkdtempSync(path.join(os.tmpdir(), "liteloader-plugin-"));
        const result = store.extractPluginZip(temp_zip, staging);
        if (!result?.success) {
            return { success: false, message: `安装插件失败：${result?.message ?? "解压失败"}` };
        }
        // 落盘校验：只认暂存目录里真实产出的清单，避免把「解压成功但产出为空」的包记成已安装
        let manifest;
        try { manifest = JSON.parse(fs.readFileSync(path.join(staging, "manifest.json"), "utf-8")); }
        catch (error) { return { success: false, message: `安装包 manifest.json 非法：${error.message}` }; }
        if (manifest?.slug !== slug) {
            return { success: false, message: `安装包 slug（${manifest?.slug ?? "缺失"}）与目标（${slug}）不一致` };
        }
        // 校验全部通过才换入：先清空目标目录避免新旧文件混杂，再整目录拷贝
        // （cpSync 可跨盘，不能用 renameSync）
        fs.rmSync(dest_dir, { recursive: true, force: true });
        fs.cpSync(staging, dest_dir, { recursive: true });
        return { success: true };
    }
    catch (error) {
        return { success: false, message: `安装插件失败：${error.message}` };
    }
    finally {
        if (temp_zip) {
            try { fs.rmSync(temp_zip, { force: true }); }
            catch { /* 临时文件清理失败不影响结果 */ }
        }
        if (staging) {
            try { fs.rmSync(staging, { recursive: true, force: true }); }
            catch { /* 暂存目录清理失败不影响结果 */ }
        }
    }
};

// 卸载插件：删除插件目录，removeData 为真时同时删除数据目录
exports.uninstall = async (LiteLoader, slug, removeData = false) => {
    if (!isSafeSlug(slug)) return { success: false, message: `插件 slug 不合法：${slug}` };
    try {
        const plugin_dir = LiteLoader?.plugins?.[slug]?.path?.plugin ?? findPluginPath(LiteLoader?.path?.plugins, slug);
        if (!plugin_dir) return { success: false, message: `未找到插件：${slug}` };
        if (!fs.existsSync(plugin_dir)) return { success: false, message: `插件目录不存在：${plugin_dir}` };
        fs.rmSync(plugin_dir, { recursive: true, force: true });
        // 通知 bootstrap 记账：用户主动删掉的推荐插件下次启动不许再自动装回。
        // 惰性 require 避免顶层引入依赖；此时 bootstrap 已加载完成，不构成循环初始化。
        // bootstrap 的 markDismissed 对非推荐 slug 会直接跳过，对普通插件调用无副作用。
        try { require("./bootstrap.js").markDismissed(LiteLoader, [slug]); }
        catch { /* 记账失败不影响卸载结果 */ }
        if (removeData) {
            const data_dir = path.join(LiteLoader?.path?.data ?? "", slug);
            fs.rmSync(data_dir, { recursive: true, force: true });
        }
        return { success: true };
    }
    catch (error) {
        return { success: false, message: `卸载插件失败：${error.message}` };
    }
};
