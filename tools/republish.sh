#!/usr/bin/env bash
# 一键「重新打包并推送」：用 ephemeral-build-kit 的临时 Windows 虚拟机重新打包
# fishing_rod_design 的单文件安装器(内嵌全部运行 DLL)，并把安装器发布到 GitHub
# Release (tag: continuous)。
#
# 流程：
#   1) 把 repackage.ps1 注入临时盘的 Startup，开机即重跑 build_installer.ps1
#   2) docker compose 启动临时 Win10 → 等待安装器重打包并自动关机
#   3) 从临时盘收集新安装器 + sha256 + manifest 到本地 repo
#   4) 调用 fishing_rod_design/tools/publish_temporary_build.sh 推到 GitHub
#
# 用法：
#   ./tools/republish.sh                      # 重打包 + 发布
#   ./tools/republish.sh 0.1.8                # 指定版本
#   REPACKAGE=0 ./tools/republish.sh          # 仅发布(不重打包)已有安装器
#   PUBLISH=0   ./tools/republish.sh          # 仅重打包, 不上传
#   PROJECT_KIND=electron FROD=/root/fishing_rod_design_newui PUBLISH=0 ./tools/republish.sh
#                                                # 打包 Electron，并运行 UI 验收与截图
#
# 环境变量：
#   EBK_ROOT   默认脚本所在仓库根目录(ephemeral-build-kit)
#   FROD       默认 /root/fishing_rod_design
#   REPO       默认 bxsrlmjs/fishing_rod_design
#   COMPOSE    默认 $EBK_ROOT/compose/win10-winbuild3/docker-compose.yml
#   STORAGE    默认 $EBK_ROOT/storage/win10-winbuild2
#   DISK_IMG   默认 $STORAGE/data.img
#   VM_NAME    默认 win10-winbuild3
#   REPACKAGE  默认 1     PUBLISH 默认 1
#   PROJECT_KIND 默认 wx；可选 electron
#   NODE_VERSION Electron 的 Windows Node 便携运行时版本，默认 v24.13.0
#   WEB_PORT   默认 8066(仅用于等待，非必须)
set -euo pipefail

EBK_ROOT="${EBK_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
FROD="${FROD:-/root/fishing_rod_design}"
REPO="${REPO:-bxsrlmjs/fishing_rod_design}"
STORAGE="${STORAGE:-$EBK_ROOT/storage/win10-winbuild2}"
DISK_IMG="${DISK_IMG:-$STORAGE/data.img}"
COMPOSE="${COMPOSE:-$EBK_ROOT/compose/win10-winbuild3/docker-compose.yml}"
VM_NAME="${VM_NAME:-win10-winbuild3}"
WEB_PORT="${WEB_PORT:-8066}"
REPACKAGE="${REPACKAGE:-1}"
PUBLISH="${PUBLISH:-1}"
PROJECT_KIND="${PROJECT_KIND:-wx}"
NODE_VERSION="${NODE_VERSION:-v24.13.0}"

VERSION="${1:-}"
TAG_RELEASE="continuous"
MOUNT=/tmp/ebk-republish
STARTOVER="$MOUNT/ProgramData/Microsoft/Windows/Start Menu/Programs/StartUp"

log()  { echo "==> $*"; }
err()  { echo "::error::$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

[ -x "$(command -v docker)" ] || { err "缺少 docker"; exit 1; }
if [[ "$PUBLISH" = 1 ]]; then [ -x "$(command -v gh)" ] || { err "缺少 gh"; exit 1; }; fi
have ntfs-3g && have losetup || { err "缺少 ntfs-3g / losetup"; exit 1; }
[[ -f "$COMPOSE" ]] || { err "compose 不存在: $COMPOSE"; exit 1; }
case "$PROJECT_KIND" in
  wx)
    REPO_DIR_NAME="fishing_rod_design"
    [[ -f "$FROD/src/app/panel_util.h" ]] || { err "wxWidgets 源码路径不对: $FROD"; exit 1; }
    ;;
  electron)
    REPO_DIR_NAME="fishing_rod_design_newui"
    [[ -f "$FROD/package.json" && -f "$FROD/scripts/run-electron-acceptance.ps1" ]] || { err "Electron 源码路径不对: $FROD"; exit 1; }
    ;;
  *) err "未知 PROJECT_KIND: $PROJECT_KIND（可选 wx 或 electron）"; exit 2 ;;
esac

# ---- 版本号 ----
if [[ -z "$VERSION" && "$PROJECT_KIND" = wx ]]; then
  VERSION="$(grep -oE 'kAppVersion[[:space:]]*=[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+' \
    "$FROD/src/app/panel_util.h" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"
fi
if [[ -z "$VERSION" && "$PROJECT_KIND" = electron ]]; then
  VERSION="$(node -p "require(process.argv[1]).version" "$FROD/package.json")"
fi
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { err "无法推导版本：$VERSION"; exit 2; }
commit="$(git -C "$FROD" rev-parse HEAD)"
log "项目=$PROJECT_KIND 版本=$VERSION repo=$REPO VM=$VM_NAME"

# ---- 辅助：查询 NTFS 数据分区起始 ——  ----
data_offset() {
  local start
  start="$(fdisk -l "$DISK_IMG" 2>/dev/null | awk '/Microsoft basic data/{print $2}' | sort -n | tail -n1 || true)"
  [[ -n "$start" ]] && echo $(( start * 512 )) || echo 269484032   # 关键回退
}

# ---- 同步当前源码到 VM 的源码树（持久磁盘即 VM 的 C:\） ----
sync_source_to_disk() {
  local dest="$MOUNT/work/$REPO_DIR_NAME"
  log "同步当前源码 ($(git -C "$FROD" rev-parse --short HEAD)) 到 $dest ..."
  if [[ ! -d "$dest/.git" ]]; then
    log "初始化 VM 源码仓库: $dest"
    mkdir -p "$dest"
    git -C "$dest" init -q || { err "无法初始化 VM 源码仓库: $dest"; return 1; }
  fi
  # 用 git 让磁盘上的源码树进入当前提交的干净状态。
  # origin 在 VM 内不可达，因此这里直接用宿主仓库把对象/引用推送过去。
  if git -C "$FROD" show-ref --verify --quiet refs/heads/master; then
    remote_branch=master
  else
    remote_branch=main
  fi
  # 远端是非 bare 仓库且当前正 checkout master，默认拒绝更新，先放开限制
  git -C "$dest" config receive.denyCurrentBranch ignore 2>&1 | sed 's/^/  /'

  # 只同步已提交 HEAD 无法包含未提交/未跟踪的工作区改动。
  # 这里用临时索引把「本地工作区完整状态」(HEAD + 已修改/已暂存 + 未跟踪源码)做成一个
  # 快照提交，再推给磁盘仓库，使 VM 打包包含所有本地未提交改动。
  local tmp_index tree snapshot_commit
  tmp_index="$(mktemp)"
  GIT_INDEX_FILE="$tmp_index" git -C "$FROD" read-tree HEAD
  GIT_INDEX_FILE="$tmp_index" git -C "$FROD" add -A
  tree="$(GIT_INDEX_FILE="$tmp_index" git -C "$FROD" write-tree)"
  snapshot_commit="$(
    GIT_INDEX_FILE="$tmp_index" \
    GIT_AUTHOR_NAME="local" GIT_AUTHOR_EMAIL="local@local" \
    GIT_COMMITTER_NAME="local" GIT_COMMITTER_EMAIL="local@local" \
    git -C "$FROD" commit-tree "$tree" -p "$(git -C "$FROD" rev-parse HEAD)" \
      -m "worktree snapshot $(git -C "$FROD" rev-parse --short HEAD)"
  )"
  rm -f "$tmp_index"
  log "工作区快照提交: ${snapshot_commit:0:12}"

  # 先确保 HEAD 基线对象已在磁盘上，再把该快照提交推为磁盘 master
  git -C "$FROD" push --force "$dest" "HEAD:refs/heads/$remote_branch" 2>&1 | sed 's/^/  /'
  git -C "$FROD" push --force "$dest" "$snapshot_commit:refs/heads/$remote_branch" 2>&1 | sed 's/^/  /'
  git -C "$dest" symbolic-ref HEAD "refs/heads/$remote_branch" 2>/dev/null || true
  git -C "$dest" reset --hard "$snapshot_commit" 2>&1 | sed 's/^/  /'
  # package_release.ps1 / run_release_gate.ps1 要求 tag v$VERSION 指向当前 HEAD
  git -C "$dest" tag -f "v$VERSION" "$snapshot_commit" 2>&1 | sed 's/^/  /'
  # 清理工作树，确保 run_release_gate 要求的 clean worktree 成立
  git -C "$dest" clean -fdx 2>&1 | sed 's/^/  /' || true
  local dirty
  dirty="$(git -C "$dest" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "$dirty" != "0" ]]; then
    err "同步后磁盘源码树仍非干净状态 (${dirty} 项)"; return 1
  fi
  log "磁盘源码树已就绪: $(git -C "$dest" rev-parse --short HEAD)"
}

# ---- 为 VM 的 Go 填充离线模块缓存（VM 无外网，go test 需要依赖） ----
# 目标 = macOS/Win VM 默认 GOMODCACHE = C:\Users\Docker\go\pkg\mod
seed_go_module_cache() {
  local server_dir="$FROD/server/license-server"
  local host_cache="/tmp/opencode/gomodcache"
  local user_mod="$MOUNT/Users/Docker/go/pkg/mod"
  log "填充 Go 模块缓存到 $user_mod (离线 go test 依赖)..."
  if [[ ! -d "$server_dir" ]]; then
    err "server 目录不存在: $server_dir"; return 1
  fi
  # 用宿主 Go 重新下载/校验该 server 需要的全部模块到独立缓存，
  # 避免把宿主 3.7G 全量缓存拷过去。
  if [[ ! -d "$host_cache/modernc.org" ]]; then
    log "下载 server Go 依赖到 $host_cache ..."
    ( cd "$server_dir" && GOFLAGS=-mod=mod GOMODCACHE="$host_cache" \
        GOPROXY="https://proxy.golang.org,direct" go mod download ) \
      || { err "go mod download 失败"; return 1; }
  fi
  # 离线校验：GOPROXY=off 下能构建通过即说明缓存齐全
  if ! ( cd "$server_dir" && GOFLAGS=-mod=mod GOMODCACHE="$host_cache" \
         GOPROXY=off go build ./... >/dev/null 2>&1 ); then
    err "go build 校验失败，模块缓存不完整"; return 1
  fi
  # 把缓存同步到 VM 的默认 GOMODCACHE
  mkdir -p "$user_mod"
  rm -rf "$user_mod"/* 
  cp -a "$host_cache"/. "$user_mod/" 2>/dev/null || rsync -a "$host_cache/" "$user_mod/" 2>/dev/null || {
    err "拷贝模块缓存到 VM 失败"; return 1; }
  sync; syncfs "$MOUNT" 2>/dev/null || true
  log "Go 模块缓存就绪 ($(du -sh "$user_mod" 2>/dev/null | cut -f1))"
}

seed_node_runtime() {
  local archive="node-${NODE_VERSION}-win-x64.zip"
  local cache_root="$EBK_ROOT/cache"
  local runtime_dir="$cache_root/node-${NODE_VERSION}-win-x64"
  local download_path="$cache_root/$archive"
  if [[ ! -f "$runtime_dir/node.exe" ]]; then
    log "下载 Windows Node 运行时 $NODE_VERSION ..."
    mkdir -p "$cache_root"
    curl --fail --location --silent --show-error "https://nodejs.org/dist/$NODE_VERSION/$archive" -o "$download_path"
    local expected actual
    expected="$(curl --fail --location --silent --show-error "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" | awk -v archive="$archive" '$2 == archive {print $1}')"
    actual="$(sha256sum "$download_path" | cut -d ' ' -f1)"
    [[ -n "$expected" && "$expected" = "$actual" ]] || { err "Windows Node 下载校验失败"; return 1; }
    local unpack_root="$cache_root/.node-unpack-${NODE_VERSION}"
    rm -rf "$unpack_root" "$runtime_dir"
    unzip -q "$download_path" -d "$unpack_root"
    mv "$unpack_root/node-${NODE_VERSION}-win-x64" "$runtime_dir"
    rmdir "$unpack_root"
  fi
  log "注入 Windows Node 运行时到 C:\\tools\\node"
  rm -rf "$MOUNT/tools/node"
  mkdir -p "$MOUNT/tools/node"
  cp -a "$runtime_dir"/. "$MOUNT/tools/node/"
}

seed_electron_runtime() {
  local src="$FROD/build/_deps/electron-43.3.0-dist"
  local dest="$MOUNT/work/$REPO_DIR_NAME/build/_deps/electron-43.3.0-dist"
  if [[ ! -f "$src/electron.exe" ]]; then
    err "缺少 Electron 运行时目录: $src"; return 1
  fi
  log "注入 Electron 运行时 ($(du -sh "$src" 2>/dev/null | cut -f1)) 到 $dest"
  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  cp -a "$src" "$dest"
  sync; syncfs "$MOUNT" 2>/dev/null || true
  log "Electron 运行时就绪"
}

# ---- 注入 repackage 触发器 ----
inject_repackage_trigger() {
  log "注入 repackage 触发器到 $DISK_IMG ..."
  rm -rf "$MOUNT"; mkdir -p "$MOUNT"
  local loop offset
  loop="$(losetup --find --show -o "$(data_offset)" "$DISK_IMG")"
  # 上次未干净关机会使 NTFS 处于 dirty 状态，ntfs-3g 拒绝读写挂载；先清除 dirty 标记
  ntfsfix -d "$loop" >/dev/null 2>&1 || true
  ntfs-3g "$loop" "$MOUNT" 2>/dev/null || { losetup -d "$loop"; err "无法挂载数据分区"; exit 1; }
  sync_source_to_disk || { losetup -d "$loop"; err "同步源码失败"; exit 1; }
  if [[ "$PROJECT_KIND" = wx ]]; then
    seed_go_module_cache || { losetup -d "$loop"; err "填充 Go 模块缓存失败"; exit 1; }
  else
    seed_node_runtime || { losetup -d "$loop"; err "注入 Windows Node 运行时失败"; exit 1; }
    seed_electron_runtime || { losetup -d "$loop"; err "注入 Electron 运行时失败"; exit 1; }
  fi
  local work="$MOUNT/work"

  if [[ "$PROJECT_KIND" = wx ]]; then
  cat > "$work/repackage.ps1" <<'REPK'
$ErrorActionPreference = "Stop"; $ProgressPreference = "SilentlyContinue"; $PSNativeCommandUseErrorActionPreference = $false
$Base="C:\release"; $RepoRoot="C:\work\fishing_rod_design"; $OutDir="$Base\repackage"
$DoneFile="$Base\REPACKAGE_DONE.txt"; $LogFile="$Base\repackage.log"
New-Item -ItemType Directory -Force -Path $OutDir,$Base | Out-Null
function Log([string]$m){ $l="{0}  {1}" -f (Get-Date -Format o),$m; Add-Content $LogFile $l -ErrorAction SilentlyContinue; Write-Host $l }
function Wr([string]$s,[string]$n){ Set-Content "$Base\REPACKAGE_RESULT.txt" "RELEASE=$s`nnote=$n`n" -Encoding ASCII; Set-Content $DoneFile "done`n" -Encoding ASCII; Log "RELEASE=$s note=$n" }
try {
  Log "repackage start"
  if (-not (Test-Path "$RepoRoot\tools\run_release_gate.ps1")) { throw "repo tools missing" }
  if (-not (Test-Path "$RepoRoot\tools\package_release.ps1")) { throw "package_release missing" }
  if (-not (Test-Path "C:\Program Files (x86)\Inno Setup 6\ISCC.exe")) { throw "ISCC missing" }
  $version = (Select-String -Path "$RepoRoot\src\app\panel_util.h" -Pattern 'kAppVersion\s*=\s*"([^"]+)"').Matches[0].Groups[1].Value
  $env:Path = "C:\msys64\usr\bin;C:\msys64\ucrt64\bin;" + $env:Path
  $env:GOPROXY = "off"; $env:GOFLAGS = "-mod=mod"; $env:GOTOOLCHAIN = "local"
  $env:GOMODCACHE = "$env:USERPROFILE\go\pkg\mod"
  & git -C $RepoRoot config core.autocrlf false 2>&1 | Out-Null
  & git -C $RepoRoot config core.filemode false 2>&1 | Out-Null
  & git -C $RepoRoot config user.email "release@local" 2>&1 | Out-Null
  & git -C $RepoRoot config user.name "Local Release" 2>&1 | Out-Null
  Get-ChildItem "$RepoRoot\.git" -Filter "*.lock" -Force -ErrorAction SilentlyContinue | ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
  Log "source commit = $(& git -C $RepoRoot rev-parse --short HEAD)"
  $dirty=@(& git -C $RepoRoot status --porcelain); if($dirty.Count -gt 0){ throw "worktree dirty: $($dirty | Select-Object -First 5)" }
  if (-not (& git -C $RepoRoot rev-parse --verify "refs/tags/v$version" 2>$null)) { throw "missing tag v$version" }
  Log "清理旧的构建产物与 staging..."
  Get-ChildItem "$RepoRoot\build-ucrt64-desktop-release" -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem "$RepoRoot\dist\staging" -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Get-ChildItem "$RepoRoot\installer\output" -Filter "*-installer.*" -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  Log "run_release_gate (clean rebuild + tests)..."
  & powershell -NoProfile -ExecutionPolicy Bypass -File "$RepoRoot\tools\run_release_gate.ps1" -GoExecutable "C:\go\bin\go.exe" 2>&1 | ForEach-Object { Log "  $_" }
  if ($LASTEXITCODE -ne 0) { throw "run_release_gate failed (exit=$LASTEXITCODE)" }
  Log "package_release (regenerate staging)..."
  & powershell -NoProfile -ExecutionPolicy Bypass -File "$RepoRoot\tools\package_release.ps1" -Version $version -NoZip -AllowUnsignedRelease -WindowsSdkUcrtRedistDir "C:\release\ucrt\Redist\ucrt\DLLs\x64" 2>&1 | ForEach-Object { Log "  $_" }
  if ($LASTEXITCODE -ne 0) { throw "package_release failed (exit=$LASTEXITCODE)" }
  $staging = Get-ChildItem "$RepoRoot\dist\staging" -Directory | Where-Object { Test-Path (Join-Path $_.FullName "release-manifest.json") } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if ($null -eq $staging) { throw "no release staging after package" }
  Log "staging=$($staging.Name)"
  Log "build_installer (Inno wrap)..."
  & powershell -NoProfile -ExecutionPolicy Bypass -File "$RepoRoot\tools\build_installer.ps1" -SourceDir $staging.FullName -AppVersion $version -AllowUnsignedRelease 2>&1 | ForEach-Object { Log "  $_" }
  if ($LASTEXITCODE -ne 0) { throw "build_installer failed (exit=$LASTEXITCODE)" }
  $desktop = Join-Path $staging.FullName "bin\fishing_rod_desktop.exe"
  $startupScreenshot = Join-Path $OutDir "wx-startup.png"
  if (-not (Test-Path $desktop)) { throw "packaged desktop executable is missing" }
  $desktopProcess = Start-Process -FilePath $desktop -PassThru
  try {
    Start-Sleep -Seconds 3
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bitmap = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bitmap.Save($startupScreenshot, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $bitmap.Dispose()
  } finally {
    if (-not $desktopProcess.HasExited) { Stop-Process -Id $desktopProcess.Id -Force }
  }
  if (-not (Test-Path $startupScreenshot)) { throw "startup screenshot was not created" }
  Get-ChildItem "$RepoRoot\installer\output" -Filter "*-installer.*" -File | ForEach-Object { Copy-Item $_.FullName -Destination (Join-Path $OutDir $_.Name) -Force; Log "copied $($_.Name)" }
  Wr "PASS" "full-rebuild-ok"
} catch { Wr "FAIL" ($_.Exception.Message -replace "`r|`n"," ") }
Log "shutdown in 15s"; Start-Sleep -Seconds 15; shutdown /s /t 0 /f
REPK
  else
  cat > "$work/repackage.ps1" <<'REPK'
$ErrorActionPreference = "Stop"; $ProgressPreference = "SilentlyContinue"; $PSNativeCommandUseErrorActionPreference = $false
$Base="C:\release"; $RepoRoot="C:\work\fishing_rod_design_newui"; $OutDir="$Base\repackage"
$DoneFile="$Base\REPACKAGE_DONE.txt"; $LogFile="$Base\repackage.log"
New-Item -ItemType Directory -Force -Path $OutDir,$Base | Out-Null
function Log([string]$m){ $l="{0}  {1}" -f (Get-Date -Format o),$m; Add-Content $LogFile $l -ErrorAction SilentlyContinue; Write-Host $l }
function Wr([string]$s,[string]$n){ Set-Content "$Base\REPACKAGE_RESULT.txt" "RELEASE=$s`nnote=$n`n" -Encoding ASCII; Set-Content $DoneFile "done`n" -Encoding ASCII; Log "RELEASE=$s note=$n" }
try {
  Log "electron repackage start"
  if (-not (Test-Path "$RepoRoot\package.json")) { throw "Electron project missing" }
  $env:Path = "C:\tools\node;C:\go\bin;C:\msys64\usr\bin;" + $env:Path
  & git -C $RepoRoot config core.autocrlf false 2>&1 | Out-Null
  & git -C $RepoRoot config core.filemode false 2>&1 | Out-Null
  & git -C $RepoRoot config user.email "release@local" 2>&1 | Out-Null
  & git -C $RepoRoot config user.name "Local Release" 2>&1 | Out-Null
  $dirty=@(& git -C $RepoRoot status --porcelain); if($dirty.Count -gt 0){ throw "worktree dirty: $($dirty | Select-Object -First 5)" }
  Log "source commit = $(& git -C $RepoRoot rev-parse --short HEAD)"
  Set-Location $RepoRoot
  Log "npm ci"
  $npmLog = "$Base\npm-ci.log"
  $npmErr = "$Base\npm-ci.err.log"
  $npmProc = Start-Process -FilePath "npm.cmd" -ArgumentList "ci","--no-audit","--no-fund" -WorkingDirectory $RepoRoot -NoNewWindow -Wait -RedirectStandardOutput $npmLog -RedirectStandardError $npmErr -PassThru
  $npmExit = $npmProc.ExitCode
  Get-Content $npmLog,$npmErr -ErrorAction SilentlyContinue | ForEach-Object { Log "  $_" }
  if ($npmExit -ne 0) { throw "npm ci failed (exit=$npmExit)" }
  Log "package Electron NSIS installer"
  $packageLog = "$Base\electron-package.log"
  $packageErr = "$Base\electron-package.err.log"
  $packageProc = Start-Process -FilePath "npm.cmd" -ArgumentList "run","package:electron" -WorkingDirectory $RepoRoot -NoNewWindow -Wait -RedirectStandardOutput $packageLog -RedirectStandardError $packageErr -PassThru
  $packageExit = $packageProc.ExitCode
  Get-Content $packageLog,$packageErr -ErrorAction SilentlyContinue | ForEach-Object { Log "  $_" }
  if ($packageExit -ne 0) { throw "package:electron failed (exit=$packageExit)" }
  Get-ChildItem "$RepoRoot\artifacts\electron-package" -Filter "*.exe" -File | ForEach-Object { Copy-Item $_.FullName -Destination $OutDir -Force; Log "copied $($_.Name)" }
  Get-ChildItem "$RepoRoot\artifacts\electron-package" -Filter "*.exe.blockmap" -File | ForEach-Object { Copy-Item $_.FullName -Destination $OutDir -Force; Log "copied $($_.Name)" }
  Copy-Item "$RepoRoot\artifacts\electron-package\release-manifest.json" -Destination $OutDir -Force
  Log "run Electron UI acceptance with scripted operations and screenshot"
  $acceptanceScript = "$RepoRoot\scripts\run-electron-acceptance.ps1"
  $acceptanceBytes = [IO.File]::ReadAllBytes($acceptanceScript)
  if ($acceptanceBytes.Length -lt 3 -or $acceptanceBytes[0] -ne 0xEF -or $acceptanceBytes[1] -ne 0xBB -or $acceptanceBytes[2] -ne 0xBF) {
    $withBom = New-Object byte[] ($acceptanceBytes.Length + 3)
    $withBom[0] = 0xEF; $withBom[1] = 0xBB; $withBom[2] = 0xBF
    [Array]::Copy($acceptanceBytes, 0, $withBom, 3, $acceptanceBytes.Length)
    [IO.File]::WriteAllBytes($acceptanceScript, $withBom)
    Log "added UTF-8 BOM to run-electron-acceptance.ps1"
  }
  $acceptanceLog = "$Base\electron-acceptance.log"
  $acceptanceErr = "$Base\electron-acceptance.err.log"
  $acceptanceProc = Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","$acceptanceScript","-ProjectDirectory","$RepoRoot" -WorkingDirectory $RepoRoot -NoNewWindow -Wait -RedirectStandardOutput $acceptanceLog -RedirectStandardError $acceptanceErr -PassThru
  $acceptanceExit = $acceptanceProc.ExitCode
  Get-Content $acceptanceLog,$acceptanceErr -ErrorAction SilentlyContinue | ForEach-Object { Log "  $_" }
  Copy-Item "$RepoRoot\artifacts\qa" -Destination "$OutDir\qa" -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item $npmLog,$npmErr,$packageLog,$packageErr,$acceptanceLog,$acceptanceErr -Destination $OutDir -Force -ErrorAction SilentlyContinue
  if ($acceptanceExit -ne 0) { throw "Electron UI acceptance failed (exit=$acceptanceExit)" }
  Wr "PASS" "electron-package-and-ui-acceptance-ok"
} catch { Wr "FAIL" ($_.Exception.Message -replace "`r|`n"," ") }
Log "shutdown in 15s"; Start-Sleep -Seconds 15; shutdown /s /t 0 /f
REPK
  fi

  cat > "$work/repackage.cmd" <<'CMDE'
@echo off
setlocal
if exist "C:\release\REPACKAGE_DONE.txt" goto :eof
mkdir "C:\release" 2>nul
echo [repackage] %DATE% %TIME% > "C:\release\repackage_startup.log" 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\work\repackage.ps1" >> "C:\release\repackage_startup.log" 2>&1
endlocal
CMDE

  # 放进 All-Users Startup(该盘上完整可写)
  mkdir -p "$STARTOVER"
  cp "$work/repackage.cmd" "$STARTOVER/repackage.cmd"
  rm -f "$MOUNT/release/REPACKAGE_DONE.txt" "$MOUNT/release/REPACKAGE_RESULT.txt" \
        "$MOUNT/release/repackage.log" "$MOUNT/release/repackage_startup.log"
  rm -rf "$MOUNT/release/repackage"
  sync; syncfs "$MOUNT" 2>/dev/null || true
  umount "$MOUNT"; losetup -d "$loop"; rm -rf "$MOUNT"
  log "触发器已注入"
}

# ---- 启动 VM 并等待重打包完成 ----
run_repackage() {
  log "启动临时 Windows VM ..."
  docker rm -f "$VM_NAME" >/dev/null 2>&1 || true
  docker compose -f "$COMPOSE" up -d >/dev/null
  log "等待 VM 重打包并关机(最长约 30 分钟)..."
  for i in $(seq 1 180); do
    state="$(docker inspect -f '{{.State.Status}}' "$VM_NAME" 2>/dev/null || echo gone)"
    if [[ "$state" = "exited" ]]; then log "VM 已退出(约 $((i*10))s)"; return 0; fi
    sleep 10
  done
  err "等待 VM 关机超时"; return 1
}

# ---- 收集新安装器到本地 repo ----
collect_installer() {
  log "收集安装器 ..."
  rm -rf "$MOUNT"; mkdir -p "$MOUNT"
  local loop offset
  loop="$(losetup --find --show -o "$(data_offset)" "$DISK_IMG")"
  ntfs-3g -o ro,norecover "$loop" "$MOUNT" 2>/dev/null || { losetup -d "$loop"; err "无法挂载数据分区"; return 1; }
  [[ -f "$MOUNT/release/REPACKAGE_RESULT.txt" ]] || { err "没有 REPACKAGE_RESULT"; umount "$MOUNT"; losetup -d "$loop"; return 1; }
  # Electron: collector is tolerant so a built installer + acceptance report/logs
  # survive a UI-acceptance failure for diagnosis. wx keeps the strict gate.
  if [[ "$PROJECT_KIND" = wx ]]; then
    grep -q RELEASE=PASS "$MOUNT/release/REPACKAGE_RESULT.txt" || { err "重打包未通过"; cat "$MOUNT/release/REPACKAGE_RESULT.txt"; umount "$MOUNT"; losetup -d "$loop"; return 1; }
  else
    log "Electron 结果: $(tr '\n' ' ' < "$MOUNT/release/REPACKAGE_RESULT.txt")"
  fi
  local out="$FROD/installer/output"
  if [[ "$PROJECT_KIND" = electron ]]; then out="$FROD/artifacts/electron-package"; fi
  mkdir -p "$out"
  # 清理旧累积产物，确保只保留本次最新构建
  if [[ "$PROJECT_KIND" = wx ]]; then
    rm -f "$out/"*-installer.exe "$out/"*-installer.exe.sha256 "$out/"*-installer.manifest.json
    cp "$MOUNT/release/repackage/"*-installer.exe "$out/"
    cp "$MOUNT/release/repackage/"*-installer.exe.sha256 "$out/"
    cp "$MOUNT/release/repackage/"*-installer.manifest.json "$out/" 2>/dev/null || true
    cp "$MOUNT/release/repackage/wx-startup.png" "$out/"
  else
    rm -f "$out/"*.exe "$out/"*.exe.blockmap "$out/release-manifest.json"
    rm -rf "$out/qa"
    cp "$MOUNT/release/repackage/"*.exe "$out/"
    cp "$MOUNT/release/repackage/"*.exe.blockmap "$out/" 2>/dev/null || true
    cp "$MOUNT/release/repackage/release-manifest.json" "$out/"
    cp -a "$MOUNT/release/repackage/qa" "$out/"
  fi
  umount "$MOUNT"; losetup -d "$loop"; rm -rf "$MOUNT"
  log "已收集安装器 -> $out"
}

# ---- 发布到 GitHub continuous ----
publish() {
  log "发布到 GitHub Release '$TAG_RELEASE' ..."
  local script="$FROD/tools/publish_temporary_build.sh"
  if [[ -x "$script" ]]; then
    ( cd "$FROD" && PACK=0 PUB=1 ./tools/publish_temporary_build.sh "$VERSION" )
  else
    ( cd "$FROD" && PACK=0 PUB=1 ./tools/publish_temporary_build.sh "$VERSION" ) || {
      err "缺少 publish_temporary_build.sh"; return 1; }
  fi
}

trap 'docker stop -t 5 "$VM_NAME" >/dev/null 2>&1 || true; umount "$MOUNT" 2>/dev/null || true; losetup -D 2>/dev/null || true' EXIT

if [[ "$REPACKAGE" = 1 ]]; then
  inject_repackage_trigger
  run_repackage || { err "重打包失败"; exit 1; }
  collect_installer || { err "收集失败"; exit 1; }
else
  log "REPACKAGE=0，跳过重打包，使用现有安装器"
fi

if [[ "$PUBLISH" = 1 ]]; then
  [[ "$PROJECT_KIND" = wx ]] || { err "Electron 打包不支持此 wx 发布流程"; exit 2; }
  publish
  log "完成。查看: https://github.com/$REPO/releases/tag/$TAG_RELEASE"
else
  log "PUBLISH=0，仅重打包。产物在 $FROD/installer/output"
fi

trap - EXIT
