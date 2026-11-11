# LiteLoaderQQNT

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/LiteLoaderQQNT/LiteLoaderQQNT?logo=github)](https://github.com/LiteLoaderQQNT/LiteLoaderQQNT/releases)
[![Follow on Telegram](https://img.shields.io/badge/Follow-Telegram-blue?logo=telegram)](https://t.me/LiteLoaderQQNT)

> 轻量 · 简洁 · 开源 · 福瑞

LiteLoaderQQNT 是 QQNT 的插件加载器，一般在 QQNT 的环境内简称为 LiteLoader。它可以让你自由地为 QQNT 添加各种插件，实现美化主题、增加功能等各种功能。详情查看 LiteLoaderQQNT 官网：<https://liteloaderqqnt.github.io>。

> [!CAUTION]
> QQ 安全中心可能会将 LiteLoaderQQNT 当作“非法外挂工具”并下线您的设备，还有可能封禁您的账号。**请谨慎使用 LiteLoaderQQNT。**

## 安装

> [!NOTE]
> 新安装方式采用「影子 `app.asar`」注入：只新增一个 Electron 优先加载的入口文件，**不修改 QQ 的任何现有文件**，因此不再需要 `dbghelp.dll` 或修补 `QQNT.dll`，也不会触发「文件已损坏」校验。卸载即完全还原。

### 下载 LiteLoaderQQNT 本体

你需要先下载 LiteLoaderQQNT 到任意位置，以下有两种方式：

- Release （稳定版）：前往 [Release](https://github.com/LiteLoaderQQNT/LiteLoaderQQNT/releases) 页，下载 `LiteLoaderQQNT.zip` 文件解压到任意位置。
- Clone （最新提交）：使用 Git 工具将 LiteLoaderQQNT 仓库 Clone 到本地任意位置。

    ```bash
    git clone --depth 1 https://github.com/LiteLoaderQQNT/LiteLoaderQQNT.git
    ```

### 使用 LiteLoaderQQNT-Installer 安装

前往 [LiteLoaderQQNT-Installer](https://github.com/coolxitech/LiteLoaderQQNT_Installer) 下载安装器，运行安装器按提示完成安装。

### 更改插件数据目录 （可选）

默认情况下，数据与插件存放在「文档」目录下的 `LiteloaderQQNT`（如 `C:\Users\<用户名>\Documents\LiteloaderQQNT`，由 `app.asar` 启动时自动注入）。如需改到别处，设置 `LITELOADERQQNT_PROFILE` 环境变量即可覆盖（该变量存在时优先使用，不写入注册表）。

### 检查是否安装成功

- 运行 QQNT 并打开设置，查看左侧列表是否出现 LiteLoaderQQNT 选项（最可靠）。
- 也可用终端运行 `QQ.exe --enable-logging` 查看日志；注意 `[Main]` / `[Preload]` / `[Renderer]` 前缀日志只在插件报错时输出，正常加载时主要靠设置页确认。

如果有显示，即安装成功，玩的开心！

### 卸载

使用 LiteLoaderQQNT-Installer 卸载即可完全还原（被校验文件从未被改动）。

### QQ 升级后

QQ 升级会新建版本目录，本体与数据不受影响。重新运行 LiteLoaderQQNT-Installer 安装一次即可。

## 插件

### 正常操作

在设置界面即可看到安装/卸载插件功能；也可以使用社区开发的插件市场类插件（例如 [plugin-list-viewer](https://github.com/ltxhhz/LL-plugin-list-viewer)），在其中进行操作。

### 手动操作

将插件目录移动到插件数据目录下的 `plugins` 文件夹内以安装（默认在「文档」目录下的 `LiteloaderQQNT\plugins`；若设置了 `LITELOADERQQNT_PROFILE` 则为该目录下的 `plugins`），在 `plugins` 目录中删除对应目录以卸载（插件数据在 `data` 目录下对应目录）。

### 寻找

可以通过以下方式寻找插件：

- 官网首页
- 第三方插件市场
- GitHub 搜索

官方维护着一份插件列表，收录了已知的大部分插件，可在官网首页中查看详情。此外，还有一份 [JSON 格式的插件列表](https://github.com/LiteLoaderQQNT/Plugin-List/blob/v4/plugins.json)。

## 开发

详见[官方文档](https://liteloaderqqnt.github.io/docs/introduction.html)。

## 许可证

LiteLoaderQQNT 采用 [MIT 许可证](./LICENSE) 进行开源。
