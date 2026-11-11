const path = require("path");
const fs = require("fs");
const market = require("./market.js");
// 更新检查与 release 资产解析在 update.js（net.js 提供镜像优先的下载），market.js 只管插件市场
const update = require("./update.js");
// manifests.js 只依赖 fs / path，可在纯 Node 下 require（本模块因此仍能离线自测）
const { findManifest } = require("./manifests.js");

const default_config = require("../common/static/config.json");

// 推荐插件：固定仓库，从 GitHub release 资产的 zip 包安装（market.install 内部走镜像）。
// 版本策略：优先解析最新 release；API 不可用时回退到下面固定的 v1.0.0 直链，并校验该版本的 sha256。
const RECOMMENDED = [
    {
        slug: "webui",
        repo: "coolxitech/LiteLoaderQQNT-WebUI",
        asset: /\.zip$/i,
        fallback: {
            version: "v1.0.0",
            url: "https://github.com/coolxitech/LiteLoaderQQNT-WebUI/releases/download/v1.0.0/webui.zip",
            sha256: "e6be1887ceeb1cf0ec5502d9c51f132b0f717fcf67254aa0e2631a5e999b51ee"
        }
    }
];

const RECOMMENDED_SLUGS = RECOMMENDED.map((item) => item.slug);

// 判断推荐插件是否已经存在：三种情形都算「已安装」，只补标记、不联网下载。
// 1) LiteLoader.plugins 里已加载（目录里有可识别清单，加载器扫描时已登记）
// 2) plugins/<slug>/manifest.json 直接存在
// 3) plugins 下某个子目录的 manifest.slug 命中（目录名可能与 slug 不同）
function isPluginInstalled(LiteLoader, plugins_dir, slug) {
    if (LiteLoader?.plugins?.[slug]) return true;
    if (!plugins_dir) return false;
    if (fs.existsSync(path.join(plugins_dir, slug, "manifest.json"))) return true;
    // 第三步的目录遍历交给 manifests.findManifest（与 store / market 同一实现，
    // 坏清单跳过而不是抛错）
    return findManifest(plugins_dir, slug) !== null;
}

// 解析本次要安装的版本：优先最新 release，但必须带 API 提供的 digest 才采用。
// 下载要经第三方镜像（TLS 在镜像侧终止），没有官方 sha256 就等于「无校验地把远程代码装进 QQ 进程执行」，
// 所以 release 缺 digest 时不降级，而是回退到可校验的硬编码固定版本直链 + 硬编码 sha256。
// 返回 null 表示两条路都不通，调用方只打日志、不写 recommended_installed（下次启动会重试）。
async function resolveCandidate(slug, item) {
    const { repo, asset, fallback } = item;
    // update.resolveReleaseAsset 由 update.js 恒导出，不再做 typeof 守卫；
    // 解析失败（success=false）与抛异常都只打日志，统一落到下方固定版本兜底
    try {
        const release = await update.resolveReleaseAsset(repo, asset);
        // sha256 是采用最新 release 的必要条件，缺了就只打日志、继续走下方兜底
        if (release?.success && release.url && release.sha256) {
            return {
                version: release.version ?? null,
                url: release.url,
                sha256: release.sha256,
                source: "latest"
            };
        }
        if (release?.success && release.url) {
            console.log(`[Bootstrap] ${slug} 最新 release（${release.version ?? "未知版本"}）未提供 sha256，为保持可校验性回退固定版本 ${fallback?.version ?? "未知"}`);
        }
        else {
            console.log(`[Bootstrap] ${slug} 解析最新 release 失败：${release?.message ?? "未知错误"}，回退到固定版本 ${fallback?.version ?? "未知"}`);
        }
    }
    catch (error) {
        console.log(`[Bootstrap] ${slug} 解析最新 release 异常：${error?.message ?? error}，回退到固定版本 ${fallback?.version ?? "未知"}`);
    }
    if (!fallback?.url) return null;
    return { version: fallback.version ?? null, url: fallback.url, sha256: fallback.sha256 ?? null, source: "fallback" };
}

// 用户删除推荐插件时调用：把推荐项记入 recommended_installed，
// 避免 main.js 清空 deleting_plugins 之后、下次启动又被自动装回来。
exports.markDismissed = (LiteLoader, slugs) => {
    try {
        if (!Array.isArray(slugs) || !slugs.length) return;
        const config = LiteLoader?.api?.config?.get("LiteLoader", default_config);
        if (!config) return;
        const installed = Array.isArray(config.recommended_installed) ? config.recommended_installed.slice() : [];
        let changed = !Array.isArray(config.recommended_installed);
        for (const slug of slugs) {
            if (!RECOMMENDED_SLUGS.includes(slug)) continue;
            if (installed.includes(slug)) continue;
            installed.push(slug);
            changed = true;
        }
        if (changed) {
            config.recommended_installed = installed;
            LiteLoader.api.config.set("LiteLoader", config);
        }
    }
    catch (error) {
        console.log(`[Bootstrap] 标记推荐插件失败：${error?.message ?? error}`);
    }
};

// 插件加载器启动后自动安装推荐插件：先检测是否已存在，只对缺失的插件从 release 包安装。
// 约定：只装一次（结果记在 recommended_installed），用户禁用/删除过的插件不再装回，
// 任何失败都只打日志，绝不阻塞或影响 QQ 启动。
exports.ensureRecommendedPlugins = async (LiteLoader) => {
    try {
        const config = LiteLoader?.api?.config?.get("LiteLoader", default_config);
        if (!config) return;
        if (!config.auto_install_recommended) return;
        // 插件加载器被全局关闭时不要下载插件
        if (config.enable_plugins === false) return;
        const plugins_dir = LiteLoader?.path?.plugins;
        if (!plugins_dir) return;
        // 防御性拷贝：getPluginConfig 会把默认配置里的数组按引用带出来，不能就地修改共享的默认对象
        const installed = Array.isArray(config.recommended_installed) ? config.recommended_installed.slice() : [];
        const disabled = Array.isArray(config.disabled_plugins) ? config.disabled_plugins : [];
        const deleting = config.deleting_plugins && typeof config.deleting_plugins === "object" ? config.deleting_plugins : {};
        let changed = !Array.isArray(config.recommended_installed);
        // 只回写本函数负责的字段：config 是入口处的快照，而安装窗口实测 2–16 秒（最坏约 64 秒），
        // 期间用户在设置页开关/删除插件的改动若被整份旧配置回写就会静默丢失。
        // getPluginConfig 返回的是「文件内容与默认配置合并后的新对象」，重新读一次再回写是安全的。
        const save = () => {
            const latest = LiteLoader.api.config.get("LiteLoader", default_config);
            if (!latest) return;
            latest.recommended_installed = installed;
            LiteLoader.api.config.set("LiteLoader", latest);
        };
        for (const item of RECOMMENDED) {
            const { slug } = item;
            if (installed.includes(slug)) continue;
            // 尊重用户选择：手动禁用或正在删除的插件不自动装回
            if (disabled.includes(slug)) {
                console.log(`[Bootstrap] ${slug} 已被用户禁用，跳过自动安装`);
                continue;
            }
            // 防御性兜底：正常时序下走不到这里——main.js 在调用本函数之前已用
            // store.deletePlugin(..., true) 清空了 deleting_plugins，"用户已删除" 真正生效的标记
            // 由上面的 markDismissed 写进 recommended_installed 承担。
            if (Object.prototype.hasOwnProperty.call(deleting, slug)) {
                console.log(`[Bootstrap] ${slug} 已被用户删除，跳过自动安装`);
                continue;
            }
            // 插件已存在（已加载 / 目录里有清单 / 某子目录的 slug 命中）说明装过了，只补标记，不重复下载
            if (isPluginInstalled(LiteLoader, plugins_dir, slug)) {
                console.log(`[Bootstrap] ${slug} 已安装，跳过自动安装（只补标记）`);
                installed.push(slug);
                changed = true;
                continue;
            }
            const candidate = await resolveCandidate(slug, item);
            if (!candidate) {
                console.log(`[Bootstrap] ${slug} 最新 release 与固定版本兜底地址都不可用，本次跳过，下次启动重试`);
                continue;
            }
            const version_text = `${candidate.version ?? "未知版本"}${candidate.source === "fallback" ? "（固定兜底版本）" : "（最新 release）"}`;
            let result;
            try {
                result = await market.install(LiteLoader, slug, candidate.url, { expectedSha256: candidate.sha256 });
            }
            catch (error) {
                // 不写 recommended_installed，下次启动会再试一次
                console.log(`[Bootstrap] ${slug} 安装 ${version_text} 失败：${error?.message ?? error}`);
                continue;
            }
            if (result?.success) {
                installed.push(slug);
                save();
                console.log(`[Bootstrap] ${slug} ${version_text} 安装成功，重启 QQ 后生效`);
            }
            else {
                // 本次不重试；不写标记，下次启动会再试
                console.log(`[Bootstrap] ${slug} 安装 ${version_text} 失败：${result?.message ?? "未知错误"}`);
            }
        }
        if (changed) save();
    }
    catch (error) {
        console.log(`[Bootstrap] 推荐插件处理异常：${error?.message ?? error}`);
    }
};
