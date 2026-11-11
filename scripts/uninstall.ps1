<#
uninstall.ps1 —— 卸载 LiteLoaderQQNT（影子 app.asar 方案，P4）

默认只删除 versions\<curVersion>\resources\app.asar，即 100% 回滚。
被签名文件（resources\app\package.json、application.asar、wrapper.node、major.node、
QQNT.dll）从未被改动，无需还原。

用法:
  .\uninstall.ps1 [-QQRoot <QQNT安装根>] [-RemoveBody] [-RemoveData] [-Force]

  -RemoveBody  顺带删除 <QQRoot>\resources\app\LiteLoaderQQNT（本体源码拷贝）
  -RemoveData  顺带删除 %APPDATA%\LiteLoaderQQNT（data/plugins）
  -Force       跳过删除前的交互确认
#>

[CmdletBinding()]
param(
    [string]$QQRoot,
    [switch]$RemoveBody,
    [switch]$RemoveData,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

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
    $finalAsar = Join-Path $versionDir 'resources\app.asar'
    $bodyDest = Join-Path $root 'resources\app\LiteLoaderQQNT'
    $dataDest = if ($env:APPDATA) { Join-Path $env:APPDATA 'LiteLoaderQQNT' } else { $null }

    $targets = @()
    if (Test-Path -LiteralPath $finalAsar) {
        $targets += "删除 $finalAsar"
    }
    if ($RemoveBody -and (Test-Path -LiteralPath $bodyDest)) {
        $targets += "删除 $bodyDest"
    }
    if ($RemoveData -and $dataDest -and (Test-Path -LiteralPath $dataDest)) {
        $targets += "删除 $dataDest"
    }

    if ($targets.Count -eq 0) {
        Write-Host "没有需要删除的内容。"
        Write-Host "默认回滚目标: $finalAsar"
        exit 0
    }

    Write-Host "将执行:"
    foreach ($target in $targets) {
        Write-Host "  $target"
    }

    Request-Confirmation "确认删除以上内容? [y/N]"

    if (Test-Path -LiteralPath $finalAsar) {
        Remove-Item -LiteralPath $finalAsar -Force
        Write-Host "已删除: $finalAsar"
    }

    if ($RemoveBody -and (Test-Path -LiteralPath $bodyDest)) {
        Remove-Item -LiteralPath $bodyDest -Recurse -Force
        Write-Host "已删除: $bodyDest"
    }

    if ($RemoveData -and $dataDest -and (Test-Path -LiteralPath $dataDest)) {
        Remove-Item -LiteralPath $dataDest -Recurse -Force
        Write-Host "已删除: $dataDest"
    }

    Write-Host "卸载完成。"
} catch {
    [Console]::Error.WriteLine("错误: " + $_.Exception.Message)
    exit 1
}
