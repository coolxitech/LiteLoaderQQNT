"use strict";

// build-app-asar.js —— 零依赖 asar 打包工具（影子 app.asar，方案 P4）
//
// 用法:
//   node build-app-asar.js <appDir> [-o <out.asar>]
//
//   <appDir>  QQ 的 …\resources\app 目录（内含被签名的 package.json，只读、绝不改写）
//   -o        输出路径；缺省为 <脚本目录>\..\release\app.asar（release 不存在则创建）
//
// 打包逻辑照抄 docs/INJECTION.md §5.4 那套已验证的零依赖 Node 脚本，只做输入输出参数化：
// 头布局 uint32@0=4、uint32@4=8+align4(jsonLen)、uint32@8=4+align4(jsonLen)、uint32@12=jsonLen，
// JSON 从 16 起、pad 到 4 对齐，data 区从 16+align4(jsonLen) 起；offset 是相对 data 区起点的十进制字符串。

const fs = require("fs");
const path = require("path");

// 影子入口，逐字写入 asar（不要改）：
//  - app.setAppPath 把 appPath 从影子 app.asar 复位到真实 app 目录，否则 QQ 报
//    Cannot find module ...\app.asar\application\background.js；
//  - LITELOADERQQNT_PROFILE 让 data/plugins 落到用户可写位置，不写注册表；
//  - 从 resourcesPath（<QQNT>\versions\<ver>\resources）反推 QQNT 安装根，再 require 本体。
const INDEX_JS = String.raw`const { app } = require("electron");
const path = require("path");

// Electron 会把 appPath 设为影子 app.asar，QQ 自研 launcher 据此找 application\background.js，
// 必须先复位到真实 app 目录，否则报 Cannot find module ...\app.asar\application\background.js。
app.setAppPath(path.join(process.resourcesPath, "app"));

// data/plugins 默认放到「文档」目录下（与旧版一致），不写注册表。
if (!process.env.LITELOADERQQNT_PROFILE) {
    process.env.LITELOADERQQNT_PROFILE = path.join(require("os").homedir(), "Documents", "LiteloaderQQNT");
}

// 从 resourcesPath 反推 QQNT 安装根：resourcesPath = <QQNT>\versions\<ver>\resources。
const qqntRoot = path.dirname(path.dirname(path.dirname(process.resourcesPath)));
require(path.join(qqntRoot, "resources", "app", "LiteLoaderQQNT", "src", "main.js"));
`;

function printHelp() {
    console.error("用法: node build-app-asar.js <appDir> [-o <out.asar>]");
}

function parseArgs(argv) {
    let appDir = null;
    let out = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "-o" || arg === "--out") {
            if (i + 1 >= argv.length) {
                console.error("缺少 -o 的参数值");
                process.exit(1);
            }
            out = argv[++i];
        } else if (arg === "-h" || arg === "--help") {
            printHelp();
            process.exit(0);
        } else if (appDir === null) {
            appDir = arg;
        } else {
            console.error("未知参数: " + arg);
            printHelp();
            process.exit(1);
        }
    }
    if (!appDir) {
        console.error("缺少 <appDir>");
        printHelp();
        process.exit(1);
    }
    if (!out) {
        out = path.resolve(__dirname, "..", "release", "app.asar");
    }
    return { appDir: path.resolve(appDir), out: path.resolve(out) };
}

// 按 §5.4 的 asar 头格式把 entries 打成 image，返回落盘前已自洽的结构。
function buildAsar(entries) {
    const sorted = entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const files = {};
    let cursor = 0;
    const blobs = [];
    for (const entry of sorted) {
        files[entry.name] = { size: entry.data.length, offset: String(cursor) };
        blobs.push(entry.data);
        cursor += entry.data.length;
    }

    const tree = { files };
    const json = Buffer.from(JSON.stringify(tree), "utf8");
    const pad = (4 - (json.length % 4)) % 4;

    const header = Buffer.alloc(16 + json.length + pad);
    header.writeUInt32LE(4, 0);
    header.writeUInt32LE(json.length + pad + 8, 4);
    header.writeUInt32LE(json.length + pad + 4, 8);
    header.writeUInt32LE(json.length, 12);
    json.copy(header, 16);

    const data = Buffer.concat(blobs);
    const image = Buffer.concat([header, data]);
    const dataStart = 16 + json.length + pad;
    const sum = Object.values(files).reduce((acc, entry) => acc + entry.size, 0);

    if (dataStart + data.length !== image.length) {
        throw new Error("data 区间长度不符");
    }
    if (sum !== image.length - dataStart) {
        throw new Error("sum(entry.size) != filesize - data_start");
    }
    return { image, sum, dataStart, fileCount: blobs.length };
}

// 落盘后重读校验：三个 uint32 与 JSON 起点必须自洽，header JSON 必须可解析。
function verifyAsar(buffer) {
    if (buffer.length < 16) {
        throw new Error("文件过短，无法读取 asar 头");
    }
    const at = (offset) => buffer.readUInt32LE(offset);
    if (at(0) !== 4) {
        throw new Error("uint32@0 应为 4");
    }
    if (at(4) !== at(8) + 4) {
        throw new Error("uint32@4 应为 header pickle 大小");
    }
    const jsonLen = at(12);
    const pad = (4 - (jsonLen % 4)) % 4;
    if (at(8) !== jsonLen + pad + 4) {
        throw new Error("uint32@8 与 json 长度不自洽");
    }
    if (buffer.length < 16 + jsonLen) {
        throw new Error("文件过短，无法读取 header JSON");
    }
    JSON.parse(buffer.subarray(16, 16 + jsonLen).toString("utf8"));
}

function main() {
    const { appDir, out } = parseArgs(process.argv.slice(2));

    const appPkgPath = path.join(appDir, "package.json");
    if (!fs.existsSync(appPkgPath)) {
        console.error("找不到 package.json: " + appPkgPath);
        process.exit(1);
    }

    let sourcePkg;
    try {
        const raw = fs.readFileSync(appPkgPath, "utf8");
        sourcePkg = JSON.parse(raw.replace(/^\uFEFF/, ""));
    } catch (error) {
        console.error("读取/解析 package.json 失败: " + error.message);
        process.exit(1);
    }

    // 深拷贝后只改 main；name/productName/version/buildVersion 等字段原样保留。
    const pkg = JSON.parse(JSON.stringify(sourcePkg));
    pkg.main = "./index.js";
    const version = String(pkg.version);

    const entries = [
        { name: "index.js", data: Buffer.from(INDEX_JS, "utf8") },
        { name: "package.json", data: Buffer.from(JSON.stringify(pkg, null, 2) + "\n", "utf8") }
    ];

    const built = buildAsar(entries);

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, built.image);
    fs.writeFileSync(out + ".version", version, "utf8");

    // 落盘后重新解析一遍，确认头部与数据区自洽。
    const check = fs.readFileSync(out);
    verifyAsar(check);

    const selfCheckPassed = built.sum === check.length - built.dataStart;
    console.log("out: " + out);
    console.log("size: " + check.length + " bytes");
    console.log("files: " + built.fileCount);
    console.log("version: " + version);
    console.log(
        "self-check: sum(entry.size) == filesize - data_start => " +
            selfCheckPassed +
            " (" + built.sum + " == " + (check.length - built.dataStart) + ")"
    );
    if (!selfCheckPassed) {
        process.exit(1);
    }
}

main();
