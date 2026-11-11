const { fetchBufferWithMirror } = require("./net.js");

// 加载器自身更新检查 + release 资产解析（原 market.js 下半部分）。
// 与 net.js 同样的硬约束：不 require("electron")、不 require("./store.js")，
// 保证本模块可在纯 Node 下被 require（离线自测与静态检查都依赖这一点）。

// 加载器自身版本检测：GitHub API 优先（走镜像），无 release 时回退上游仓库，再回退解析 releases 页面。
// 结果缓存 10 分钟，避免每次打开设置都请求。
const UPDATE_CACHE_MS = 10 * 60 * 1000;
const UPDATE_FALLBACK_REPO = "LiteLoaderQQNT/LiteLoaderQQNT";
let update_cache = null;
let update_pending = null;

// 从 package.json 的 repository.url 解析出 owner/name
function parseRepo(repo_url) {
    const match = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?]|$)/.exec(String(repo_url ?? ""));
    return match ? `${match[1]}/${match[2]}` : UPDATE_FALLBACK_REPO;
}

// 拉某个仓库的最新 release：API 优先，失败回退 releases 页面 HTML
async function fetchLatestRelease(repo) {
    let api_status = null;
    try {
        const response = await fetchBufferWithMirror(`https://api.github.com/repos/${repo}/releases/latest`, { trust_mirror_404: false });
        api_status = response.statusCode;
        if (api_status === 200) {
            const data = JSON.parse(response.body.toString("utf-8"));
            if (data?.tag_name) {
                return {
                    version: String(data.tag_name),
                    url: data.html_url ?? `https://github.com/${repo}/releases/latest`
                };
            }
        }
    }
    catch { /* 网络层失败，下面走 HTML 兜底 */ }
    // 404 说明该仓库确实没有 release，直接判负，避免再为它拉一次 HTML（会白等超时）
    if (api_status === 404) return null;
    try {
        const response = await fetchBufferWithMirror(`https://github.com/${repo}/releases/latest`);
        if (response.statusCode === 200) {
            const tag = /\/releases\/tag\/([^"?#\s]+)/.exec(response.body.toString("utf-8"))?.[1];
            if (tag) return { version: tag, url: `https://github.com/${repo}/releases/tag/${tag}` };
        }
    }
    catch { /* 忽略，返回 null */ }
    return null;
}

exports.checkUpdate = async (LiteLoader, refresh = false) => {
    if (!refresh && update_cache && Date.now() - update_cache.at < UPDATE_CACHE_MS) return update_cache.value;
    if (update_pending) return update_pending;
    update_pending = (async () => {
        const repo = parseRepo(LiteLoader?.package?.liteloader?.repository?.url);
        // 配置仓库没有 release 时（例如维护分支）回退到上游仓库
        const repos = repo === UPDATE_FALLBACK_REPO ? [repo] : [repo, UPDATE_FALLBACK_REPO];
        for (const candidate of repos) {
            const release = await fetchLatestRelease(candidate);
            if (release) return { success: true, version: release.version, url: release.url, repo: candidate };
        }
        return { success: false, message: "检查更新失败：未找到可用的 release 信息" };
    })();
    const result = await update_pending.finally(() => { update_pending = null; });
    if (result.success) update_cache = { at: Date.now(), value: result };
    return result;
};

// 仓库名白名单：只允许 owner/name 形式，避免拼出越界的 API 路径
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
// release 资产的官方校验值格式：sha256:<64 位 hex>
const SHA256_DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/i;

function parseDigestSha256(digest) {
    const match = SHA256_DIGEST_PATTERN.exec(String(digest ?? ""));
    return match ? match[1].toLowerCase() : null;
}

function isHttpUrl(url) {
    return typeof url === "string" && /^https?:\/\//i.test(url);
}

// 解析仓库最新 release 里指定资产：返回版本号、下载地址与官方 sha256，
// 供安装推荐插件时做来源与完整性绑定。与 checkUpdate 不同，这里不做 HTML 兜底：
// 拿不到 API 数据就明确失败，避免装到非 release 产物上。
exports.resolveReleaseAsset = async (repo, asset_pattern) => {
    try {
        if (typeof repo !== "string" || !REPO_NAME_PATTERN.test(repo)) {
            return { success: false, message: `仓库名不合法：${repo}` };
        }
        if (!(asset_pattern instanceof RegExp)) {
            return { success: false, message: "资产名匹配规则必须是正则表达式" };
        }
        const api_url = `https://api.github.com/repos/${repo}/releases/latest`;
        // 仍走镜像优先 + 直连兜底，只额外声明 GitHub API 的响应格式；
        // 镜像对 api 路径的 404 不算数（可能只是该镜像不支持 api），只有直连的 404 才是终局
        const response = await fetchBufferWithMirror(api_url, {
            headers: { "accept": "application/vnd.github+json" },
            trust_mirror_404: false
        });
        if (response.statusCode !== 200) {
            return { success: false, message: `获取最新 release 失败：HTTP ${response.statusCode}` };
        }
        let data;
        try { data = JSON.parse(response.body.toString("utf-8")); }
        catch (error) { return { success: false, message: `release 数据解析失败：${error.message}` }; }
        if (!data?.tag_name) return { success: false, message: "release 数据缺少 tag_name" };
        const assets = Array.isArray(data.assets) ? data.assets : [];
        let matched = null;
        for (const asset of assets) {
            // 带 g 标志的正则会在 test 后保留 lastIndex，每次匹配前重置
            asset_pattern.lastIndex = 0;
            if (!asset_pattern.test(String(asset?.name ?? ""))) continue;
            // 下载地址不是 http(s) 说明该资产不可用，继续找下一个匹配项
            if (!isHttpUrl(asset.browser_download_url)) continue;
            matched = asset;
            break;
        }
        if (!matched) {
            const names = assets.map((asset) => asset?.name).filter(Boolean).join("、") || "无资产";
            return { success: false, message: `release ${data.tag_name} 中没有匹配 ${asset_pattern} 的资产，现有资产：${names}` };
        }
        return {
            success: true,
            version: String(data.tag_name),
            url: String(matched.browser_download_url),
            sha256: parseDigestSha256(matched.digest),
            size: Number(matched.size) || 0
        };
    }
    catch (error) {
        return { success: false, message: `解析 release 资产失败：${error.message}` };
    }
};
