// 设置界面共用的小工具：默认资源地址与版本号比较


// 默认插件图标（.png）
export const default_icon = `local://root/src/common/static/default.png`;

// 默认插件缩略图（.svg）
export const default_thumb = `local://root/src/common/static/default.svg`;

// 版本号归一化：去掉 v 前缀与空白
export function normalizeVersion(version) {
    return String(version ?? "").trim().replace(/^v/i, "");
}

// 版本号比较：按 . 与 - 切段，纯数字段按数值比，其余按字符串比；a 大于 b 返回 1
export function compareVersion(a, b) {
    const left_parts = normalizeVersion(a).split(/[.-]/);
    const right_parts = normalizeVersion(b).split(/[.-]/);
    const length = Math.max(left_parts.length, right_parts.length);
    for (let index = 0; index < length; index++) {
        const left = left_parts[index] ?? "0";
        const right = right_parts[index] ?? "0";
        if (left == right) continue;

        const left_number = /^\d+$/.test(left);
        const right_number = /^\d+$/.test(right);
        if (left_number && right_number) return Number(left) > Number(right) ? 1 : -1;
        if (left_number != right_number) return left_number ? 1 : -1;
        return left > right ? 1 : -1;
    }
    return 0;
}
