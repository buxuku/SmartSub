# 编译烟测用的 boom 样本库（Windows）。优先 MSVC（经 vswhere 找到 vcvars64），缺省退回 MinGW gcc。
# 用法：./build.ps1 -Out <输出目录>
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'

$Out = [System.IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$src = Join-Path $PSScriptRoot 'boom.c'

# 名称 → 宏
$variants = [ordered]@{
  'boom-ill'      = @('BOOM_ILL')
  'boom-segv'     = @()
  'boom-abort'    = @('BOOM_ABORT')
  'boom-ill-init' = @('BOOM_ILL', 'BOOM_ON_LOAD')
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = $null
if (Test-Path $vswhere) {
  $vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
}

if ($vs) {
  Write-Host "使用 MSVC: $vs"
  $vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
  $lines = @('@echo off', "call `"$vcvars`" >nul", 'if errorlevel 1 exit /b 1')
  foreach ($name in $variants.Keys) {
    # /MD：与真实 addon（CMake 默认）一样用动态 CRT，abort() 走系统的 ucrtbase
    $defs = ($variants[$name] | ForEach-Object { "/D$_" }) -join ' '
    $lines += "cl /nologo /LD /MD $defs `"$src`" /Fe:`"$Out\$name.node`" /Fo:`"$Out\$name.obj`""
    $lines += 'if errorlevel 1 exit /b 1'
  }
  $bat = Join-Path $Out 'build-boom.bat'
  $lines | Set-Content -Encoding ascii $bat
  & $bat
  if ($LASTEXITCODE -ne 0) { throw "cl 编译失败: $LASTEXITCODE" }
} else {
  Write-Host '没有找到 MSVC，退回 MinGW gcc'
  foreach ($name in $variants.Keys) {
    $defs = $variants[$name] | ForEach-Object { "-D$_" }
    & gcc -shared @defs -o "$Out\$name.node" $src
    if ($LASTEXITCODE -ne 0) { throw "gcc 编译失败: $name" }
  }
}

Get-ChildItem $Out -Filter *.node | Format-Table Name, Length
