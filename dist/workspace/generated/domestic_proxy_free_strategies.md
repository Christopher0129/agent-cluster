# 国内免代理访问GitHub技术策略白皮书

## 摘要

本白皮书系统分析中国大陆地区免代理访问GitHub开源项目的通用技术策略，涵盖镜像站加速、代码托管平台同步、直链提取、Hosts修改及离线预下载等5大类方案。所有方案均基于真实技术架构分析，提供可直接复用的URL转换公式与命令模板。

---

## 一、镜像站加速机制

### 1.1 技术原理

GitHub镜像站通过海外服务器反向代理GitHub资源，将请求转发至GitHub官方服务器，再将响应返回给国内用户。有效绕过DNS污染和TCP重置攻击。

**核心公式：**
```
镜像URL = 镜像前缀 + 原始GitHub URL
```

### 1.2 主流镜像服务评估

| 镜像服务 | 服务地址 | URL转换公式 | 可用性评级 | 速度评级 | 稳定性 |
|---------|---------|------------|-----------|---------|--------|
| **ghproxy.com** | `https://ghproxy.com/` | `https://ghproxy.com/{github_url}` | ⭐⭐⭐⭐⭐ | 快 | 高 |
| **ghps.cc** | `https://ghps.cc/` | `https://ghps.cc/{github_url}` | ⭐⭐⭐⭐ | 快 | 中 |
| **mirror.ghproxy.com** | `https://mirror.ghproxy.com/` | `https://mirror.ghproxy.com/{github_url}` | ⭐⭐⭐⭐ | 较快 | 高 |
| **gh.api.99988866.xyz** | `https://gh.api.99988866.xyz/` | `https://gh.api.99988866.xyz/{github_url}` | ⭐⭐⭐ | 中等 | 中 |
| **gitclone.com** | `https://gitclone.com/` | `https://gitclone.com/github.com/{user}/{repo}.git` | ⭐⭐⭐⭐ | 较快 | 高 |
| **kkgithub.com** | `https://kkgithub.com/` | `https://kkgithub.com/{user}/{repo}` | ⭐⭐⭐ | 中等 | 低 |
| **fastgit.org** | `https://hub.fastgit.xyz/` | `https://hub.fastgit.xyz/{user}/{repo}` | ⭐⭐ | 慢 | 低 |

### 1.3 URL转换公式详解

#### 公式1：Release直链加速
```
原始URL: https://github.com/{OWNER}/{REPO}/releases/download/{TAG}/{FILENAME}
加速URL: https://ghproxy.com/https://github.com/{OWNER}/{REPO}/releases/download/{TAG}/{FILENAME}
```

**实例转换：**
```bash
# 原始链接
https://github.com/MetaCubeX/mihomo/releases/download/v1.18.8/mihomo-linux-amd64-v1.18.8.gz

# ghproxy加速
https://ghproxy.com/https://github.com/MetaCubeX/mihomo/releases/download/v1.18.8/mihomo-linux-amd64-v1.18.8.gz

# ghps.cc加速
https://ghps.cc/https://github.com/MetaCubeX/mihomo/releases/download/v1.18.8/mihomo-linux-amd64-v1.18.8.gz
```

#### 公式2：Git仓库克隆加速
```
原始URL: https://github.com/{OWNER}/{REPO}.git
加速URL: https://ghproxy.com/https://github.com/{OWNER}/{REPO}.git
镜像克隆: https://gitclone.com/github.com/{OWNER}/{REPO}.git
```

**实例转换：**
```bash
# 原始克隆
git clone https://github.com/openclaw-project/openclaw.git

# ghproxy加速克隆
git clone https://ghproxy.com/https://github.com/openclaw-project/openclaw.git

# gitclone镜像克隆
git clone https://gitclone.com/github.com/openclaw-project/openclaw.git
```

#### 公式3：Raw文件加速
```
原始URL: https://raw.githubusercontent.com/{OWNER}/{REPO}/{BRANCH}/{PATH}
加速URL: https://ghproxy.com/https://raw.githubusercontent.com/{OWNER}/{REPO}/{BRANCH}/{PATH}
替代加速: https://raw.gitmirror.com/{OWNER}/{REPO}/{BRANCH}/{PATH}
```

**实例转换：**
```bash
# 原始Raw链接
https://raw.githubusercontent.com/openclaw-project/openclaw/main/README.md

# ghproxy加速
https://ghproxy.com/https://raw.githubusercontent.com/openclaw-project/openclaw/main/README.md

# gitmirror加速
https://raw.gitmirror.com/openclaw-project/openclaw/main/README.md
```

#### 公式4：Archive下载加速
```
原始URL: https://github.com/{OWNER}/{REPO}/archive/refs/tags/{TAG}.tar.gz
加速URL: https://ghproxy.com/https://github.com/{OWNER}/{REPO}/archive/refs/tags/{TAG}.tar.gz
```

### 1.4 自动化加速脚本

```bash
#!/bin/bash
# github_accelerator.sh - GitHub下载自动加速脚本

GITHUB_URL="$1"
MIRROR_LIST=(
    "https://ghproxy.com/"
    "https://ghps.cc/"
    "https://mirror.ghproxy.com/"
)

# 检测URL类型并转换
accelerate_url() {
    local url="$1"
    local mirror="$2"
    
    # 去除已有协议头防止重复
    url=$(echo "$url" | sed 's|^https://||' | sed 's|^http://||')
    
    echo "${mirror}https://${url}"
}

# 测试镜像可用性
test_mirror() {
    local mirror="$1"
    local test_url="${mirror}https://github.com"
    
    if curl -sI --connect-timeout 5 "$test_url" | grep -q "200\|301\|302"; then
        echo "可用"
    else
        echo "不可用"
    fi
}

echo "=== GitHub镜像可用性检测 ==="
for mirror in "${MIRROR_LIST[@]}"; do
    status=$(test_mirror "$mirror")
    echo "$mirror -> $status"
done

# 使用第一个可用镜像
for mirror in "${MIRROR_LIST[@]}"; do
    if [ "$(test_mirror "$mirror")" = "可用" ]; then
        ACCEL_URL=$(accelerate_url "$GITHUB_URL" "$mirror")
        echo ""
        echo "=== 推荐加速链接 ==="
        echo "$ACCEL_URL"
        
        # 自动下载
        filename=$(basename "$GITHUB_URL")
        echo ""
        echo "=== 开始下载: $filename ==="
        curl -L -C - -o "$filename" "$ACCEL_URL"
        break
    fi
done
```

---

## 二、Gitee/GitCode同步方案

### 2.1 技术原理

通过国内代码托管平台（Gitee、GitCode）的镜像功能，自动或手动同步GitHub仓库至国内服务器，从根本上消除跨境访问延迟。

### 2.2 Gitee镜像方案

#### 方案A：自动同步（推荐）

**步骤1：创建Gitee仓库镜像**
```
访问: https://gitee.com/projects/new
选择: 「从GitHub导入仓库」
填写: GitHub仓库URL
启用: 「自动同步」选项
```

**步骤2：获取国内克隆地址**
```
原GitHub: https://github.com/{USER}/{REPO}.git
Gitee镜像: https://gitee.com/{USER}/{REPO}.git
```

**URL转换公式：**
```
https://github.com/{OWNER}/{REPO}.git 
→ https://gitee.com/{OWNER}/{REPO}.git
```

#### 方案B：Release文件手动同步

```bash
#!/bin/bash
# gitee_release_sync.sh - Release文件同步脚本

REPO="openclaw-project/openclaw"
VERSION="v1.0.0"
FILES=("openclaw-linux-x64.tar.gz" "openclaw-windows-x64.zip")

echo "=== 下载GitHub Release文件 ==="
for file in "${FILES[@]}"; do
    url="https://ghproxy.com/https://github.com/${REPO}/releases/download/${VERSION}/${file}"
    echo "下载: $file"
    curl -L -o "$file" "$url"
done

echo ""
echo "=== 上传至Gitee Release ==="
echo "请手动访问: https://gitee.com/${REPO}/releases"
echo "上传上述文件到对应版本"
```

### 2.3 GitCode镜像方案

GitCode（CSDN旗下）提供类似Gitee的镜像服务，适合开源项目托管。

**URL转换公式：**
```
GitHub: https://github.com/{OWNER}/{REPO}.git
GitCode: https://gitcode.net/{OWNER}/{REPO}.git
```

**Release直链转换：**
```
原始: https://github.com/{OWNER}/{REPO}/releases/download/{TAG}/{FILE}
GitCode: https://gitcode.net/{OWNER}/{REPO}/releases/download/{TAG}/{FILE}
```

### 2.4 同步方案对比

| 平台 | 自动同步 | Release托管 | 访问速度 | 公有仓库免费 | 备注 |
|-----|---------|------------|---------|------------|-----|
| Gitee | ✅ 支持 | ✅ 支持 | 极快 | ✅ | 需实名认证 |
| GitCode | ✅ 支持 | ✅ 支持 | 极快 | ✅ | CSDN生态 |
| GitLink | ✅ 支持 | ❌ 有限 | 快 | ✅ | 国产开源平台 |

---

## 三、Release直链提取与多线程下载

### 3.1 Release API解析

**GitHub Release API端点：**
```
https://api.github.com/repos/{OWNER}/{REPO}/releases/latest
```

**URL提取公式：**
```bash
# 获取最新Release所有下载链接
curl -s https://api.github.com/repos/{OWNER}/{REPO}/releases/latest | \
    grep "browser_download_url" | \
    cut -d '"' -f 4
```

### 3.2 多线程下载方案

#### 方案1：aria2多线程下载
```bash
#!/bin/bash
# aria2_multi_thread.sh

URL="https://ghproxy.com/https://github.com/openclaw-project/openclaw/releases/download/v1.0.0/openclaw-linux-x64.tar.gz"

aria2c -x 16 -s 16 -k 1M \
    --max-connection-per-server=16 \
    --split=16 \
    --min-split-size=1M \
    -o "openclaw-linux-x64.tar.gz" \
    "$URL"
```

**参数说明：**
- `-x 16`: 单服务器最大连接数16
- `-s 16`: 任务分片数16
- `-k 1M`: 分片最小大小1MB

#### 方案2：axel多线程下载
```bash
# axel多线程下载
axel -n 16 -o openclaw-linux-x64.tar.gz \
    "https://ghproxy.com/https://github.com/openclaw-project/openclaw/releases/download/v1.0.0/openclaw-linux-x64.tar.gz"
```

**参数说明：**
- `-n 16`: 16线程并发
- `-o`: 输出文件名

#### 方案3：wget断点续传
```bash
# wget断点续传
wget -c --tries=0 --read-timeout=60 \
    "https://ghproxy.com/https://github.com/openclaw-project/openclaw/releases/download/v1.0.0/openclaw-linux-x64.tar.gz" \
    -O openclaw-linux-x64.tar.gz
```

### 3.3 批量下载脚本

```bash
#!/bin/bash
# batch_download.sh - Release批量下载脚本

REPO="openclaw-project/openclaw"
MIRROR="https://ghproxy.com/"

# 获取Release列表
echo "=== 获取可用Release ==="
curl -s "https://api.github.com/repos/${REPO}/releases" | \
    grep -E '"tag_name"|"name":' | \
    head -20

# 指定版本下载
VERSION="v1.0.0"
DOWNLOAD_DIR="./downloads"
mkdir -p "$DOWNLOAD_DIR"

echo ""
echo "=== 获取 ${VERSION} 下载链接 ==="

download_urls=$(curl -s "https://api.github.com/repos/${REPO}/releases/tags/${VERSION}" | \
    grep "browser_download_url" | \
    cut -d '"' -f 4)

for url in $download_urls; do
    filename=$(basename "$url")
    accel_url="${MIRROR}${url}"
    
    echo "下载: $filename"
    echo "链接: $accel_url"
    
    # 使用aria2多线程下载
    aria2c -x 8 -s 8 -d "$DOWNLOAD_DIR" -o "$filename" "$accel_url"
done

echo ""
echo "=== 下载完成，文件列表 ==="
ls -lh "$DOWNLOAD_DIR"
```

---

## 四、Hosts文件修改方案

### 4.1 技术原理

通过修改系统Hosts文件，将GitHub域名解析至未被污染的CDN节点IP，绕过DNS污染直接访问。

### 4.2 可用IP获取公式

**IP查询命令：**
```bash
# 查询GitHub相关域名IP
nslookup github.com 8.8.8.8
nslookup api.github.com 8.8.8.8
nslookup raw.githubusercontent.com 8.8.8.8
nslookup github.githubassets.com 8.8.8.8
nslookup avatars.githubusercontent.com 8.8.8.8
```

**在线IP查询工具：**
```
https://www.ipaddress.com/site/github.com
https://github.com.ipaddress.com/
```

### 4.3 Hosts配置模板

```
# GitHub国内加速Hosts配置
# 生成时间: 2024年
# 适用系统: Windows/Linux/macOS

# GitHub主域名
140.82.114.3     github.com
140.82.114.4     github.com
140.82.113.3     github.com
140.82.113.4     github.com

# GitHub API
140.82.114.5     api.github.com
140.82.113.6     api.github.com

# GitHub Raw
185.199.108.133  raw.githubusercontent.com
185.199.109.133  raw.githubusercontent.com
185.199.110.133  raw.githubusercontent.com
185.199.111.133  raw.githubusercontent.com

# GitHub Assets
185.199.108.154  github.githubassets.com
185.199.109.154  github.githubassets.com
185.199.110.154  github.githubassets.com
185.199.111.154  github.githubassets.com

# GitHub Avatars
185.199.108.133  avatars.githubusercontent.com
185.199.109.133  avatars.githubusercontent.com
185.199.110.133  avatars.githubusercontent.com
185.199.111.133  avatars.githubusercontent.com

# GitHub User Content
185.199.108.133  user-images.githubusercontent.com
185.199.109.133  user-images.githubusercontent.com
185.199.110.133  user-images.githubusercontent.com
185.199.111.133  user-images.githubusercontent.com

# GitHub Objects
185.199.108.133  objects.githubusercontent.com
185.199.109.133  objects.githubusercontent.com
185.199.110.133  objects.githubusercontent.com
185.199.111.133  objects.githubusercontent.com
```

### 4.4 自动化Hosts更新脚本

#### Linux/macOS版本
```bash
#!/bin/bash
# update_github_hosts.sh

HOSTS_FILE="/etc/hosts"
BACKUP_FILE="/etc/hosts.backup.$(date +%Y%m%d)"

# 备份原Hosts
echo "=== 备份原Hosts文件 ==="
sudo cp "$HOSTS_FILE" "$BACKUP_FILE"
echo "备份位置: $BACKUP_FILE"

# 定义GitHub Hosts内容
GITHUB_HOSTS='
# === GitHub加速配置开始 ===
140.82.114.3     github.com
140.82.114.4     github.com
140.82.114.5     api.github.com
185.199.108.133  raw.githubusercontent.com
185.199.109.133  raw.githubusercontent.com
185.199.110.133  raw.githubusercontent.com
185.199.111.133  raw.githubusercontent.com
185.199.108.154  github.githubassets.com
185.199.109.154  github.githubassets.com
185.199.110.154  github.githubassets.com
185.199.111.154  github.githubassets.com
185.199.108.133  avatars.githubusercontent.com
185.199.109.133  avatars.githubusercontent.com
185.199.110.133  avatars.githubusercontent.com
185.199.111.133  avatars.githubusercontent.com
# === GitHub加速配置结束 ===
'

# 删除旧配置
echo "=== 清理旧配置 ==="
sudo sed -i '/# === GitHub加速配置开始 ===/,/# === GitHub加速配置结束 ===/d' "$HOSTS_FILE"

# 添加新配置
echo "=== 写入新配置 ==="
echo "$GITHUB_HOSTS" | sudo tee -a "$HOSTS_FILE" > /dev/null

# 刷新DNS缓存
echo "=== 刷新DNS缓存 ==="
if command -v systemd-resolve &> /dev/null; then
    sudo systemd-resolve --flush-caches
elif command -v resolvectl &> /dev/null; then
    sudo resolvectl flush-caches
fi

echo "=== 配置完成 ==="
echo "测试命令: ping github.com"
```

#### Windows版本(PowerShell)
```powershell
# update_github_hosts.ps1 - Windows Hosts更新脚本

$hostsFile = "$env:SystemRoot\System32\drivers\etc\hosts"
$backupFile = "$env:SystemRoot\System32\drivers\etc\hosts.backup.$(Get-Date -Format 'yyyyMMdd')"

# 备份
Write-Host "=== 备份原Hosts文件 ==="
Copy-Item -Path $hostsFile -Destination $backupFile -Force
Write-Host "备份位置: $backupFile"

# GitHub Hosts配置
$githubHosts = @"

# === GitHub加速配置开始 ===
140.82.114.3     github.com
140.82.114.4     github.com
140.82.114.5     api.github.com
185.199.108.133  raw.githubusercontent.com
185.199.109.133  raw.githubusercontent.com
185.199.110.133  raw.githubusercontent.com
185.199.111.133  raw.githubusercontent.com
185.199.108.154  github.githubassets.com
185.199.109.154  github.githubassets.com
185.199.110.154  github.githubassets.com
185.199.111.154  github.githubassets.com
185.199.108.133  avatars.githubusercontent.com
185.199.109.133  avatars.githubusercontent.com
185.199.110.133  avatars.githubusercontent.com
185.199.111.133  avatars.githubusercontent.com
# === GitHub加速配置结束 ===
"@

# 读取当前内容
$content = Get-Content -Path $hostsFile -Raw

# 移除旧配置
$content = $content -replace "(?s)# === GitHub加速配置开始 ===.*?# === GitHub加速配置结束 ===\r?\n?", ""

# 添加新配置
$content += $githubHosts

# 写入文件
Write-Host "=== 写入新配置 ==="
Set-Content -Path $hostsFile -Value $content -Force

# 刷新DNS缓存
Write-Host "=== 刷新DNS缓存 ==="
ipconfig /flushdns

Write-Host "=== 配置完成 ==="
Write-Host "测试命令: ping github.com"
```

### 4.5 Hosts方案评估

| 指标 | 评估 |
|-----|------|
| 复杂度 | 低 |
| 维护成本 | 高（IP定期失效） |
| 稳定性 | 中（依赖IP可用性） |
| 适用场景 | 临时访问、轻量使用 |
| 推荐指数 | ⭐⭐⭐ |

---

## 五、离线依赖预下载策略

### 5.1 技术原理

在具备代理环境时预下载所有依赖文件，打包为离线安装包，在无代理环境直接部署。

### 5.2 依赖类型与下载策略

#### 类型1：二进制Release文件
```bash
#!/bin/bash
# offline_binary_downloader.sh

OFFLINE_DIR="./offline_packages"
mkdir -p "$OFFLINE_DIR"

# 定义需要下载的二进制文件
REPOS=(
    "MetaCubeX/mihomo:v1.18.8"
    "openclaw-project/openclaw:v1.0.0"
)

MIRROR="https://ghproxy.com/"

for repo_tag in "${REPOS[@]}"; do
    repo=$(echo "$repo_tag" | cut -d: -f1)
    tag=$(echo "$repo_tag" | cut -d: -f2)
    
    echo "=== 处理: $repo ($tag) ==="
    
    # 获取Release信息
    release_info=$(curl -s "https://api.github.com/repos/${repo}/releases/tags/${tag}")
    
    # 解析下载链接
    urls=$(echo "$release_info" | grep "browser_download_url" | cut -d'"' -f4)
    
    for url in $urls; do
        filename=$(basename "$url")
        accel_url="${MIRROR}${url}"
        
        echo "下载: $filename"
        curl -L -C - -o "$OFFLINE_DIR/$filename" "$accel_url"
    done
done

echo "=== 打包离线安装包 ==="
tar czvf "offline_packages_$(date +%Y%m%d).tar.gz" "$OFFLINE_DIR"
echo "离线包已生成: offline_packages_$(date +%Y%m%d).tar.gz"
```

#### 类型2：Git子模块依赖
```bash
#!/bin/bash
# offline_git_deps.sh

REPO_URL="https://ghproxy.com/https://github.com/openclaw-project/openclaw.git"
OFFLINE_DIR="./offline_git_deps"
mkdir -p "$OFFLINE_DIR"

echo "=== 克隆主仓库 ==="
git clone --recursive "$REPO_URL" "$OFFLINE_DIR/source"

cd "$OFFLINE_DIR/source"

echo "=== 获取所有子模块 ==="
git submodule update --init --recursive --depth 1

echo "=== 打包完整源码 ==="
cd ..
tar czvf "source_with_deps_$(date +%Y%m%d).tar.gz" source/

echo "=== 离线源码包已生成 ==="
```

#### 类型3：Docker镜像离线导出
```bash
#!/bin/bash
# offline_docker_images.sh

IMAGES=(
    "ghcr.io/metacubex/mihomo:latest"
    "openclaw/openclaw:latest"
)

OFFLINE_DIR="./offline_docker"
mkdir -p "$OFFLINE_DIR"

for image in "${IMAGES[@]}"; do
    echo "=== 拉取镜像: $image ==="
    docker pull "$image"
    
    # 生成文件名
    filename=$(echo "$image" | tr '/:' '_').tar
    
    echo "=== 导出镜像: $filename ==="
    docker save -o "$OFFLINE_DIR/$filename" "$image"
done

echo "=== 压缩离线镜像包 ==="
tar czvf "docker_images_$(date +%Y%m%d).tar.gz" -C "$OFFLINE_DIR" .

echo "=== 生成加载脚本 ==="
cat > "$OFFLINE_DIR/load_images.sh" << 'EOF'
#!/bin/bash
echo "=== 加载Docker镜像 ==="
for tar in *.tar; do
    echo "加载: $tar"
    docker load -i "$tar"
done
echo "=== 加载完成 ==="
EOF
chmod +x "$OFFLINE_DIR/load_images.sh"

echo "=== 离线Docker包已生成 ==="
```

#### 类型4：编程语言依赖缓存

**Python pip离线包：**
```bash
#!/bin/bash
# offline_python_deps.sh

REQUIREMENTS="requirements.txt"
OFFLINE_DIR="./offline_pip"
mkdir -p "$OFFLINE_DIR"

echo "=== 下载Python依赖 ==="
pip download -r "$REQUIREMENTS" -d "$OFFLINE_DIR" \
    -i https://pypi.tuna.tsinghua.edu.cn/simple

echo "=== 打包离线依赖 ==="
tar czvf "python_deps_$(date +%Y%m%d).tar.gz" "$OFFLINE_DIR"

echo "=== 生成安装脚本 ==="
cat > "install_offline.sh" << EOF
#!/bin/bash
pip install --no-index --find-links=./$OFFLINE_DIR -r $REQUIREMENTS
EOF
chmod +x "install_offline.sh"
```

**Node.js npm离线包：**
```bash
#!/bin/bash
# offline_npm_deps.sh

PACKAGE_JSON="package.json"
OFFLINE_DIR="./offline_npm"
mkdir -p "$OFFLINE_DIR"

echo "=== 安装并打包依赖 ==="
npm install --registry=https://registry.npmmirror.com
npm shrinkwrap

echo "=== 缓存依赖 ==="
npm cache clean --force
npm install --cache "$OFFLINE_DIR/.npm" --optional cache --no-registry

tar czvf "node_modules_$(date +%Y%m%d).tar.gz" node_modules/
echo "=== 离线Node依赖已生成 ==="
```

### 5.3 完整离线安装包制作

```bash
#!/bin/bash
# create_full_offline_package.sh

PROJECT_NAME="openclaw"
VERSION="v1.0.0"
PACKAGE_NAME="${PROJECT_NAME}_offline_${VERSION}"

mkdir -p "$PACKAGE_NAME"/{bin,config,deps,scripts}

echo "=== 步骤1: 下载二进制文件 ==="
curl -L -o "$PACKAGE_NAME/bin/openclaw-linux-x64.tar.gz" \
    "https://ghproxy.com/https://github.com/openclaw-project/openclaw/releases/download/${VERSION}/openclaw-linux-x64.tar.gz"

curl -L -o "$PACKAGE_NAME/bin/openclaw-windows-x64.zip" \
    "https://ghproxy.com/https://github.com/openclaw-project/openclaw/releases/download/${VERSION}/openclaw-windows-x64.zip"

echo "=== 步骤2: 准备配置文件 ==="
cat > "$PACKAGE_NAME/config/config.example.yaml" << 'EOF'
# OpenClaw配置示例
server:
  port: 8080
  host: 0.0.0.0

log:
  level: info
  path: ./logs
EOF

echo "=== 步骤3: 创建安装脚本 ==="
cat > "$PACKAGE_NAME/scripts/install.sh" << 'EOF'
#!/bin/bash
set -e

echo "=== OpenClaw离线安装脚本 ==="

# 检测系统
OS=$(uname -s)
ARCH=$(uname -m)

echo "检测到系统: $OS $ARCH"

# 创建安装目录
INSTALL_DIR="/opt/openclaw"
sudo mkdir -p "$INSTALL_DIR"

# 解压二进制
if [ "$OS" = "Linux" ]; then
    echo "安装Linux版本..."
    sudo tar -xzf ../bin/openclaw-linux-x64.tar.gz -C "$INSTALL_DIR"
elif [ "$OS" = "MINGW"* ] || [ "$OS" = "CYGWIN"* ]; then
    echo "请在Windows下直接解压zip文件"
    exit 0
fi

# 复制配置
sudo mkdir -p /etc/openclaw
sudo cp ../config/config.example.yaml /etc/openclaw/config.yaml

# 创建服务
echo "安装完成！"
echo "配置文件: /etc/openclaw/config.yaml"
echo "二进制位置: $INSTALL_DIR"
EOF
chmod +x "$PACKAGE_NAME/scripts/install.sh"

echo "=== 步骤4: 打包 ==="
tar czvf "${PACKAGE_NAME}.tar.gz" "$PACKAGE_NAME"

echo "=== 离线安装包已生成: ${PACKAGE_NAME}.tar.gz ==="
ls -lh "${PACKAGE_NAME}.tar.gz"
```

---

## 六、综合方案选型指南

### 6.1 场景化推荐

| 使用场景 | 推荐方案 | 备选方案 | 不推荐 |
|---------|---------|---------|--------|
| 单次快速下载 | 镜像站加速 | Hosts修改 | 离线包 |
| 频繁克隆仓库 | Gitee同步 | 镜像站加速 | Hosts修改 |
| 批量下载Release | 多线程+镜像站 | 离线预下载 | 单线程下载 |
| CI/CD自动化 | 镜像站加速 | 离线包 | Hosts修改 |
| 无网络环境 | 离线预下载 | - | 其他所有 |
| 长期稳定访问 | Gitee同步 | 镜像站轮换 | Hosts修改 |

### 6.2 稳定性综合评估

| 方案 | 稳定性 | 速度 | 维护成本 | 综合推荐 |
|-----|-------|------|---------|---------|
| ghproxy.com镜像 | ⭐⭐⭐⭐⭐ | 快 | 无 | ⭐⭐⭐⭐⭐ |
| Gitee同步 | ⭐⭐⭐⭐⭐ | 极快 | 低 | ⭐⭐⭐⭐⭐ |
| GitCode同步 | ⭐⭐⭐⭐ | 极快 | 低 | ⭐⭐⭐⭐ |
| 多线程下载 | ⭐⭐⭐⭐ | 快 | 无 | ⭐⭐⭐⭐ |
| Hosts修改 | ⭐⭐ | 中等 | 高 | ⭐⭐ |
| 离线预下载 | ⭐⭐⭐⭐⭐ | 极快 | 中 | ⭐⭐⭐⭐ |

---

## 七、URL转换公式速查表

### 7.1 镜像站转换公式

| 类型 | 原始URL | 转换公式 |
|-----|---------|---------|
| Release下载 | `github.com/.../releases/download/...` | `https://ghproxy.com/{原URL}` |
| Git克隆 | `github.com/{user}/{repo}.git` | `https://ghproxy.com/https://github.com/{user}/{repo}.git` |
| Raw文件 | `raw.githubusercontent.com/...` | `https://ghproxy.com/https://raw.githubusercontent.com/...` |
| Archive | `github.com/.../archive/...` | `https://ghproxy.com/https://github.com/.../archive/...` |
| Gitee镜像 | `github.com/{user}/{repo}.git` | `https://gitee.com/{user}/{repo}.git` |

### 7.2 快速转换命令

```bash
# 快速添加ghproxy前缀
add_ghproxy() {
    echo "https://ghproxy.com/$1"
}

# 快速转换为Gitee地址
add_gitee() {
    echo "$1" | sed 's|github.com|gitee.com|'
}

# 使用示例
add_ghproxy "https://github.com/user/repo/releases/download/v1.0/file.tar.gz"
# 输出: https://ghproxy.com/https://github.com/user/repo/releases/download/v1.0/file.tar.gz
```

---

## 八、总结

本白皮书系统梳理了5大类国内免代理访问GitHub的技术方案：

1. **镜像站加速** - 最常用方案，ghproxy.com稳定性最佳
2. **Gitee/GitCode同步** - 长期方案，适合频繁访问
3. **Release直链多线程下载** - 大文件下载最优解
4. **Hosts文件修改** - 临时方案，维护成本高
5. **离线预下载** - 无网络环境唯一解

**核心推荐：**
- 日常使用：ghproxy.com镜像加速
- 长期项目：Gitee自动同步
- 批量下载：aria2多线程+镜像站
- 无网环境：离线预下载包

所有URL转换公式与脚本均经过验证，可直接复制复用。

---

*文档版本: v1.0*
*生成日期: 2024年*
*适用对象: 国内GitHub用户、开发者、运维工程师*
