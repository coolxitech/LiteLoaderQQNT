<#
install.ps1 —— 安装 LiteLoaderQQNT（影子 app.asar 方案，P4）

只新增文件、不改任何被签名文件（resources\app\package.json、application.asar、
wrapper.node、major.node、QQNT.dll 一个字节都不动）。回滚只需运行 uninstall.ps1。

用法:
  .\install.ps1 [-QQRoot <QQNT安装根>] [-AppAsar <预构建app.asar>] [-Force]

  -QQRoot   QQNT 安装根（含 versions\config.json）。缺省自动探测。
  -AppAsar  预构建 app.asar 路径；缺省为 <脚本目录>\..\release\app.asar。
  -Force    跳过交互确认；并在本机无 Node 且版本不匹配时，允许使用不匹配的预构建 asar。
#>

[CmdletBinding()]
param(
    [string]$QQRoot,
    [string]$AppAsar,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# 仓库根（scripts 的上一级），本体源码从这里读取。
$script:RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$script:BuildScript = Join-Path $PSScriptRoot 'build-app-asar.js'

function Resolve-QQRoot {
    param([string]$Explicit)

    if ($Explicit) {
        $candidate = $Explicit.Trim()
        if (-not (Test-Path -LiteralPath (Join-Path $candidate 'versions\config.json'))) {
            throw "指定的 -QQRoot 无效：找不到 $candidate\versions\config.json"
        }
        return (Resolve-Path -LiteralPath $candidate).Path
    }

    $candidates = @(
        'D:\Program Files\Tencent\QQNT',
        'C:\Program Files\Tencent\QQNT',
        'C:\Program Files (x86)\Tencent\QQNT'
    )

    # 注册表卸载信息（只读）：DisplayName 匹配 *QQ* 的 InstallLocation。
    $hives = @(
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    $registryLocations = @(
        foreach ($hive in $hives) {
            if (Test-Path -LiteralPath $hive) {
                Get-ChildItem -LiteralPath $hive -ErrorAction SilentlyContinue | ForEach-Object {
                    $props = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
                    if ($props) {
                        $displayName = $props.DisplayName
                        $installLocation = $props.InstallLocation
                        if ($displayName -and ($displayName -like '*QQ*') -and $installLocation) {
                            $installLocation
                        }
                    }
                }
            }
        }
    )

    foreach ($candidate in (@($candidates) + @($registryLocations))) {
        if ($candidate) {
            $configPath = Join-Path $candidate 'versions\config.json'
            if (Test-Path -LiteralPath $configPath) {
                return (Resolve-Path -LiteralPath $candidate).Path
            }
        }
    }

    throw "未找到 QQNT 安装根（未找到 versions\config.json）。请用 -QQRoot 显式指定。"
}

function Request-Confirmation {
    param([string]$Message)

    if ($script:Force) { return }
    try {
        $answer = Read-Host $Message
    } catch {
        throw "非交互环境无法确认；请改用 -Force 跳过确认。"
    }
    if ($answer -notmatch '^(y|Y|yes|YES)$') {
        throw "已取消。"
    }
}

try {
    $root = Resolve-QQRoot -Explicit $QQRoot

    $configPath = Join-Path $root 'versions\config.json'
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $curVersion = $config.curVersion
    if (-not $curVersion) {
        throw "versions\config.json 缺少 curVersion 字段"
    }

    $versionDir = Join-Path $root ("versions\" + $curVersion)
    $appDir = Join-Path $versionDir 'resources\app'
    $appPkgJson = Join-Path $appDir 'package.json'
    if (-not (Test-Path -LiteralPath $appPkgJson)) {
        throw "未找到应用入口 package.json: $appPkgJson"
    }

    $targetPkg = Get-Content -LiteralPath $appPkgJson -Raw | ConvertFrom-Json
    $targetVersion = [string]$targetPkg.version
    if (-not $targetVersion) {
        throw "目标 package.json 缺少 version 字段"
    }

    $bodyDest = Join-Path $root 'resources\app\LiteLoaderQQNT'
    $finalAsar = Join-Path $versionDir 'resources\app.asar'

    # ---- 准备 asar ----
    if ($AppAsar) {
        $asarPath = [System.IO.Path]::GetFullPath($AppAsar)
    } else {
        $asarPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\release\app.asar'))
    }

    $asarReady = $false
    if (Test-Path -LiteralPath $asarPath) {
        $sidecarPath = "$asarPath.version"
        if (Test-Path -LiteralPath $sidecarPath) {
            $sideVersion = (Get-Content -LiteralPath $sidecarPath -Raw).Trim()
            if ($sideVersion -eq $targetVersion) {
                $asarReady = $true
            }
        }
    }

    $node = Get-Command node -ErrorAction SilentlyContinue

    if (-not $asarReady) {
        if ($node) {
            $tmpAsar = Join-Path ([System.IO.Path]::GetTempPath()) ("LiteLoader-app-" + [Guid]::NewGuid().ToString('N') + ".asar")
            Write-Host "app.asar 版本不匹配或缺失，正在用 Node 重新生成: $tmpAsar"
            & $node.Source $BuildScript $appDir -o $tmpAsar
            if ($LASTEXITCODE -ne 0) {
                throw "生成 app.asar 失败（node 退出码 $LASTEXITCODE）"
            }
            $asarPath = $tmpAsar
            $asarReady = $true
        } else {
            if (-not $Force) {
                throw "版本不匹配且本机无 Node，请提供匹配版本的 app.asar 或加 -Force"
            }
            if (-not (Test-Path -LiteralPath $asarPath)) {
                throw "预构建 app.asar 不存在（$asarPath），且本机无 Node 无法生成"
            }
            Write-Warning "使用版本不匹配的预构建 app.asar（已指定 -Force，可能导致 QQ 无法启动）"
            $asarReady = $true
        }
    }

    # ---- 打印计划并确认 ----
    Write-Host "QQNT 安装根   : $root"
    Write-Host "当前版本目录  : $versionDir"
    Write-Host "目标版本      : $targetVersion"
    Write-Host "本体写入位置  : $bodyDest"
    Write-Host "影子 asar 落位: $finalAsar"
    Write-Host "使用的 asar   : $asarPath"

    Request-Confirmation "将同步本体并落位 app.asar，是否继续? [y/N]"

    # ---- 同步本体（先删旧目录再复制；绝不复制 data/plugins/docs/.git/scripts/release）----
    if (Test-Path -LiteralPath $bodyDest) {
        Remove-Item -LiteralPath $bodyDest -Recurse -Force
    }
    New-Item -ItemType Directory -Path $bodyDest -Force | Out-Null

    Copy-Item -LiteralPath (Join-Path $script:RepoRoot 'src') -Destination $bodyDest -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $script:RepoRoot 'package.json') -Destination $bodyDest -Force
    Copy-Item -LiteralPath (Join-Path $script:RepoRoot 'LICENSE') -Destination $bodyDest -Force

    # ---- 落位 asar（被签名文件一个字节都不动）----
    Copy-Item -LiteralPath $asarPath -Destination $finalAsar -Force

    # ---- 校验打印 ----
    $pkgHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $appPkgJson).Hash
    $asarSize = (Get-Item -LiteralPath $finalAsar).Length

    Write-Host ""
    Write-Host "安装完成。"
    Write-Host "目标 package.json sha256: $pkgHash"
    Write-Host "app.asar 大小: $asarSize 字节"
    Write-Host "回滚: 运行 .\scripts\uninstall.ps1（或直接删除 $finalAsar）"
} catch {
    [Console]::Error.WriteLine("错误: " + $_.Exception.Message)
    exit 1
}
