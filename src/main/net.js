const http = require("http");
const https = require("https");

// HTTP 客户端与镜像策略的唯一实现（原 market.js 上半部分）。
// 硬约束：这里不 require("electron")、也不 require("./store.js")——
// market.js / update.js / bootstrap.js 依赖「能在纯 Node 下被 require 做离线自测」的性质。
// 对外只暴露 fetchBufferWithMirror：market 与 update 的调用点都只需要「镜像优先 + 直连兜底」这一层，
// fetchBuffer 是它内部的单次请求实现，不导出以免被绕过镜像策略直接调用。

// 前缀式镜像：镜像地址 + 原始完整 URL。
// 下列镜像按实测结论排序，已移除的镜像是因为返回 403、请求超时或域名解析失败（不是 SSL 握手失败）：
// - gh-proxy.com：唯一同时支持 release 下载与 api.github.com 的镜像，首选；
// - ghfast.top：仅能代理 release 下载，代理 api.github.com 会返回 403；
// - ghproxy.net：不稳定，仅作兜底。
// 全部镜像失败后再回退直连。
const MIRRORS = [
    "https://gh-proxy.com/",
    "https://ghfast.top/",
    "https://ghproxy.net/"
];
const REQUEST_TIMEOUT = 8000;
const MAX_BODY_SIZE = 128 * 1024 * 1024;
const REDIRECT_CODES = [301, 302, 303, 307, 308];

// 发起一次 HTTP(S) 请求，跟随重定向；只有网络层错误才 reject，
// HTTP 状态码（含 404）通过 statusCode 返回给调用方判断。
// options.headers 为可选的附加请求头，与内置头合并且优先于内置头（如 GitHub API 需要的 accept）。
function fetchBuffer(url, options = {}) {
    const { timeout = REQUEST_TIMEOUT, redirect = 5, limit = MAX_BODY_SIZE, headers = {} } = options;
    return new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(url); }
        catch { return reject(new Error(`无效的 URL：${url}`)); }
        if (!["http:", "https:"].includes(parsed.protocol)) {
            return reject(new Error(`不支持的协议：${parsed.protocol}`));
        }
        const client = parsed.protocol === "http:" ? http : https;
        let settled = false;
        const done = (fn, value) => {
            if (settled) return;
            settled = true;
            fn(value);
        };
        const request = client.get(parsed, {
            headers: {
                "user-agent": "LiteLoaderQQNT",
                "accept": "*/*",
                ...headers
            }
        }, (response) => {
            const status_code = response.statusCode ?? 0;
            const location = response.headers.location;
            if (REDIRECT_CODES.includes(status_code) && location && redirect > 0) {
                response.resume();
                let next_url;
                try { next_url = new URL(location, parsed).toString(); }
                catch { return done(reject, new Error(`无效的重定向地址：${location}`)); }
                return fetchBuffer(next_url, { timeout, redirect: redirect - 1, limit, headers })
                    .then((result) => done(resolve, result), (error) => done(reject, error));
            }
            if (status_code !== 200) {
                response.resume();
                return done(resolve, { statusCode: status_code, body: Buffer.alloc(0) });
            }
            const chunks = [];
            let size = 0;
            response.on("data", (chunk) => {
                size += chunk.length;
                if (size > limit) {
                    request.destroy(new Error(`响应体超过上限（${limit} 字节）`));
                    return;
                }
                chunks.push(chunk);
            });
            response.on("end", () => done(resolve, { statusCode: status_code, body: Buffer.concat(chunks) }));
            response.on("error", (error) => done(reject, new Error(`读取响应失败：${error.message}`)));
        });
        request.on("error", (error) => done(reject, new Error(`请求失败：${error.message}`)));
        request.setTimeout(timeout, () => request.destroy(new Error(`请求超时（${timeout}ms）`)));
    });
}

// 依次尝试候选地址，返回第一个 200 应答：
// - 顺序为「镜像优先（gh-proxy.com 首选）→ 直连」，符合国内网络默认走镜像的预期；
// - 404 视为上游的明确答复（代理会原样透传），默认直接返回，避免为确实缺失的文件把候选全部打满；
// - options.trust_mirror_404=false 时镜像的 404 不再算数，只认直连的 404：
//   api.github.com 这类路径在部分镜像上会直接返回 404（例如 ghfast.top 代理 api 返 403/404），
//   若首个镜像的 404 就终止，直连本来可用也会被判失败；
// - 其余状态码（403/429/5xx）继续尝试下一个候选，全部失败时返回第一个记录到的应答以报出真实状态码。
exports.fetchBufferWithMirror = async (url, options = {}) => {
    const { trust_mirror_404 = true, ...request_options } = options;
    const candidates = [
        ...MIRRORS.map((mirror) => ({ url: mirror + url, mirror: true })),
        { url, mirror: false }
    ];
    let first_error = null;
    let fallback_response = null;
    for (const candidate of candidates) {
        let response;
        try { response = await fetchBuffer(candidate.url, request_options); }
        catch (error) {
            first_error ??= error;
            continue;
        }
        if (response.statusCode === 200) return response;
        if (response.statusCode === 404) {
            if (trust_mirror_404 || !candidate.mirror) return response;
        }
        fallback_response ??= response;
    }
    if (fallback_response) return fallback_response;
    throw first_error ?? new Error(`请求失败：${url}`);
};
