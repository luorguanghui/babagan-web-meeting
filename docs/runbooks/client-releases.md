# Windows / Android 客户端发布

网页和原生客户端分别发布：网页部署继续更新会议界面；发布新的 Windows ZIP / 安装器及 Android APK 后，客户端从同域名的签名清单发现更新。服务器只需要已固定的**公钥**，不需要任何签名私钥。

## 文件和信任边界

客户端稳定清单为：

- `https://meet.babagan.cloud/downloads/clients/windows/stable.json`
- `https://meet.babagan.cloud/downloads/clients/android/stable.json`

`scripts/prepare-client-release.mjs` 输出以下内容，整个目录作为一次发布上传：

```text
clients/
  windows/<版本>/client.zip
  windows/<版本>/BabaganClientSetup-<版本>.exe
  windows/stable.json
  android/<版本>/Babagan.apk
  android/stable.json
  release-manifest.json
  release-proof.json
  catalog.json
```

两个 `stable.json` 与 `release-manifest.json` 都是 RSA-3072 / SHA-256 签名信封：`schema`、`keyId`、`payloadBase64`、`signatureBase64`。发布器直接验证 `payloadBase64` 解码后的原始字节，不重新序列化后验签。完整 manifest 的已签名内容包含 `product: babagan-client-release`、发布序号、源码提交和三个安装文件的严格相对路径、大小、SHA-256；因此 Windows 首次安装器也在签名保护范围内。未签名的 `catalog.json` 必须与该 manifest 推导出的下载信息完全一致。

服务器固定使用受信任检出的 `scripts/client-update-public-key.json`，**不要使用上传包携带的公钥**。签名私钥保留在现有外部密钥目录；不要重新生成发布身份。Android APK 必须继续使用现有 Android 签名证书，这与更新清单的 RSA 私钥是两套独立身份。

## 首次启用持久下载目录

此步骤只需在引入下载卷时执行一次。默认宿主目录是 `/opt/babagan-web-meeting/var/downloads`；`infra/client-downloads.override.yml` 只向 `web` 容器添加 `/srv/downloads:ro` 挂载。此挂载会遮盖镜像内同一路径，所以先复制**当前运行容器中的完整下载目录**，包括原生分享组件、旧安装器以及 `runtime/`，再启用挂载。不要用空目录直接覆盖。

下面以 Debian 服务器的既有项目为例。保持实际运行的 Compose 文件链和生产 env 文件；不得用基础 compose 文件覆盖现有部署覆盖项。命令中的 `docker cp` 从运行中的只读下载目录取种子，`cp -a -n` 保留宿主目录已有文件，不删除或覆盖它们。

```bash
set -euo pipefail
cd /opt/babagan-web-meeting
web_id="$(sudo docker ps --filter label=com.docker.compose.project=babagan-meeting \
  --filter label=com.docker.compose.service=web --format '{{.ID}}')"
test -n "$web_id"
test "$(printf '%s\n' "$web_id" | wc -l)" -eq 1
active_files="$(sudo docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$web_id")"
test -n "$active_files"
IFS=',' read -r -a file_list <<< "$active_files"
compose_files=()
for file in "${file_list[@]}"; do
  test -f "$file"
  compose_files+=(-f "$file")
done

sudo install -d -m 0755 /opt/babagan-web-meeting/var
seed="$(sudo mktemp -d /opt/babagan-web-meeting/var/download-seed.XXXXXX)"
sudo docker cp "$web_id:/srv/downloads/." "$seed/"
sudo install -d -m 0755 /opt/babagan-web-meeting/var/downloads
sudo cp -a -n "$seed/." /opt/babagan-web-meeting/var/downloads/

sudo docker compose --env-file infra/.env.production "${compose_files[@]}" \
  -f /opt/babagan-web-meeting/infra/client-downloads.override.yml config --quiet
sudo docker compose --env-file infra/.env.production "${compose_files[@]}" \
  -f /opt/babagan-web-meeting/infra/client-downloads.override.yml \
  up -d --no-deps --no-build web
```

保留这份种子备份，记录时间、原容器 ID、实际 Compose 文件链及下载目录大小。若环境使用其他 env 路径或 `CLIENT_DOWNLOADS_ROOT`，以上命令和发布命令需使用同一配置。下载目录及其父目录只能由受信任的部署账户写入；Web 容器只读挂载。发布器拒绝路径上的符号链接、Windows junction / reparse point，但不能防止拥有相同宿主目录写权限的管理员同时修改目录。

重建后检查容器的 `/srv/downloads` 挂载为只读，分别请求一个旧安装器和一个运行时文件并比对原 SHA-256。`scripts/update.sh` 会沿用运行容器的 Compose 链；后续手动部署也必须包含此 override。覆盖文件设置 `create_host_path: false`，路径缺失时应报错，不能悄悄创建空下载目录。

运行时文件继续存放于宿主 `downloads/runtime/`。Windows WebView2 的固定版本、文件名、大小和 SHA-256 以 `apps/desktop/windows/runtime-artifacts.json` 为准；Node / FFmpeg 沿用现有固定镜像和来源记录。客户端发布器只处理 `downloads/clients/`，不会替换或清理运行时文件。

## 构建和签名下一版本

1. 更新 `apps/desktop/windows/Package.cs` 的 `Version`，同步 `AssemblyInfo.cs` 的三个程序集版本字段。
2. 更新 `apps/android/app/build.gradle` 的 `versionName`，并增加 `versionCode`。Android 安装升级同时要求版本号和 APK 证书符合现有安装。
3. 提交所有源码变更，保持干净检出。两个平台必须来自同一源码提交。选择比服务器已有清单更大的全局 `sequence`，并将同一序号传给 Windows 构建和清单准备工具。
4. 在具备既有构建工具和密钥的 Windows 发布机器运行；路径示例需要换成现有私钥/证书路径，密码使用外部文件，不放入命令参数明文或仓库。

```powershell
$releaseSequence = 4 # 当前线上序号为 3；后续每次发布继续递增
./scripts/build-desktop-client.ps1 -Sequence $releaseSequence
./scripts/build-android-client.ps1 -Configuration Release `
  -SigningStore 'C:/private/Babagan.p12' `
  -SigningAlias babagan -SigningPasswordFile 'C:/private/password.txt'

# 如未使用既有默认私钥位置，只指定原有私钥；不要初始化新身份。
$env:BABAGAN_CLIENT_UPDATE_KEY = 'C:/private/client-updates-private.pem'
node scripts/prepare-client-release.mjs --sequence $releaseSequence `
  --destination "output/client-releases/$releaseSequence"
```

`output/client-releases/<序号>` 是上传目录，其内容对应上面的 `clients/` 根目录。不要只上传 `stable.json`，不要在已发布版本目录中替换 ZIP / EXE / APK。内容有变更时必须使用新版本号。网页自身更新不要求重建原生安装包；涉及宿主桥接、权限或原生行为的修改需要对应客户端新版本。

## 服务器验证与发布

将完整准备目录上传到服务目录以外的独立 staging，例如 `/opt/babagan-web-meeting/var/client-staging/4`。不要直接解包进生产下载目录。服务器需要 Python 3.10+ 与 `openssl`；脚本只用 Python 标准库，不安装操作系统依赖。

生产主检出不一定等于当前网页发布版本。应使用部署记录指向的受信任源码目录中的发布器与公钥；下面从现有发布记录定位它，不使用待发布包中的代码或公钥。首次下载卷迁移已经完成，后续客户端发布无需重启网页容器。

```bash
python3 --version
openssl version
release_source="$(sudo python3 -c 'import json,pathlib; r=json.load(open("/opt/babagan-web-meeting/var/releases/current-update.json")); print(pathlib.Path(r["rollbackScript"]).parent / "source")')"
sudo python3 "$release_source/scripts/publish-client-release.py" /opt/babagan-web-meeting/var/client-staging/4 \
  --public-key "$release_source/scripts/client-update-public-key.json" \
  --downloads-root /opt/babagan-web-meeting/var/downloads --dry-run

sudo python3 "$release_source/scripts/publish-client-release.py" /opt/babagan-web-meeting/var/client-staging/4 \
  --public-key "$release_source/scripts/client-update-public-key.json" \
  --downloads-root /opt/babagan-web-meeting/var/downloads
```

`--dry-run` 验证全部签名、严格 schema、公钥身份、平台和同域固定路径、大小/哈希、目录边界、既有版本不可变性及发布序号；不创建下载目录、锁或状态文件。它是某一时刻的预检，正式发布会加排他锁并重新检查目标。可通过 `--public-key` 指定**可信部署来源**的公钥文件，通过 `--openssl` 指定 OpenSSL 可执行文件。

正式发布按以下顺序进行：

1. 验证三份签名、全部文件和 unsigned catalog 与 signed manifest 的一致性。
2. 获取宿主排他锁，恢复任何上次未完成的事务，再检查当前版本/序号。
3. 先复制不可变版本文件，在复制过程中再次检查 SHA-256 / 大小，完成 `fsync` 后以不覆盖目标的原子链接发布。相同路径相同内容可重复执行；相同路径不同内容直接失败。
4. 在下载目录外保存已同步落盘的旧元数据备份和事务日志，再逐文件原子替换 manifest、proof、两个平台清单；`catalog.json` 最后替换。
5. 写入提交状态并归档日志，返回发布序号和两个平台版本。

各个 HTTP 清单文件的替换是原子的，两个独立 URL 不具有跨文件同时切换保证。短暂读到不同平台的不同发布序号不会指向未完成的安装包：所有对应版本文件已先落盘。目录不支持硬链接时，发布会失败并保持旧清单，不能换成直接覆盖生产文件的复制操作。Debian 常规本地文件系统支持此流程；不要将此目录放在未经验证的网络文件系统上。

发布后下载两份公共稳定清单和 catalog，比对 staging 文件的 SHA-256；再检查 catalog 指向的安装器/APK 的大小和 SHA-256。确认反向代理/CDN 没有长期缓存 `stable.json` 与 `catalog.json`。原生客户端检查更新后，观察验证完成、下载以及空闲后应用更新。无需重启 Web 容器即可看到宿主目录新文件。

## 中断恢复及错误版本处理

状态默认保存在 `/opt/babagan-web-meeting/var/.downloads-client-publisher/`，不在公开下载目录内。`pending.json` 包含旧元数据的备份；`history/` 保留提交与回滚记录。发布进程正常捕获到失败时立即恢复旧元数据。进程被强制终止或主机断电后，下次正式发布会先恢复未提交事务；也可单独执行：

```bash
sudo python3 "$release_source/scripts/publish-client-release.py" \
  --public-key "$release_source/scripts/client-update-public-key.json" \
  --downloads-root /opt/babagan-web-meeting/var/downloads --recover-only
```

有 pending 事务时，dry-run 会明确拒绝，不会偷偷修复。恢复失败时保留日志，先处理磁盘/权限故障，再重试。锁是操作系统锁，进程退出会释放；不要通过删除 `publish.lock` 绕过正在运行的发布器。备份和未被引用的新版本文件均保留，脚本从不递归删除下载目录。

服务器拒绝降低序号或版本号；已发出的序号不能用于不同内容。已经成功发布但有业务缺陷的客户端，应修复后发布**更高版本、更高序号**。不能把旧 feed 复制回来作为常规回滚，因为客户端会记住已接受序号。Windows 本地新版本启动健康检查失败时可恢复前一个本地版本，同时保留序号防重放；这与服务器事务回滚是两个机制。

## 用户体验与验收边界

- Windows 客户端会检查签名清单并安排更新，会议/共享期间暂停大文件下载和版本切换，空闲后应用。首次安装器仍需要用户主动运行。
- Android 会自动发现、验证和下载兼容更新，并在空闲且前台时提交安装。Android 的“允许此来源安装应用”和系统安装确认仍可能需要用户操作，不能宣称无人值守静默升级。
- 更新清单的 RSA 签名证明更新来源和内容完整性，**不等于 Windows Authenticode 代码签名或受信任 CA 证书**。当前未解决的 Windows SmartScreen / 未知发布者提示不能标为已解决。
- 构建通过、验签通过和服务器发布通过，不等于真实设备的端到端升级验收。Android 真机/可用模拟器实际安装、Windows 旧版升级、会议期间延迟和恢复都需分别留下测试证据。

本地发布器回归测试（新建隔离测试密钥，不访问正式私钥）：

```powershell
python scripts/publish-client-release.test.py
```

Windows 测试会自动尝试 PATH 上的 OpenSSL 或 Git for Windows 自带的 `C:/Program Files/Git/usr/bin/openssl.exe`；也可设置 `OPENSSL`。覆盖签名与安装文件篡改、路径越界/junction、不可变版本冲突、序号回退、并发锁、dry-run、复制期间内容变化、写入失败回滚以及真实子进程突然退出后的恢复。
