# Linux二进制文件离线部署研究报告

## 任务概述
研究Linux系统（x86_64/aarch64）下Clash Premium、Clash Meta（mihomo）内核的离线二进制部署方案。

---

## 一、国内CDN加速GitHub Release直链

### 1.1 常用国内代理服务

| 代理服务 | 地址格式 | 适用场景 |
|---------|---------|---------|
| ghproxy.com | `https://ghproxy.com/https://github.com/...` | wget/curl直接下载 |
| ghps.cc | `https://ghps.cc/https://github.com/...` | 备用加速 |
| mirror.ghproxy.com | `https://mirror.ghproxy.com/https://github.com/...` | 镜像加速 |
| gh.api.99988866.xyz | `https://gh.api.99988866.xyz/...` | API代理 |

### 1.2 Mihomo官方Release直链（国内加速版）

**x86_64架构下载命令：**
```bash
# 使用ghproxy加速
curl -L -o mihomo-linux-amd64-v1.18.8.gz \
  "https://ghproxy.com/https://github.com/MetaCubeX/mihomo/releases/download/v1.18.8/mihomo-linux-amd64-v1.18.8.gz"

# 备用加速
curl -L -o mihomo-linux-amd64-v1.18.8.gz \
  "https://ghps.cc/https://github.com/MetaCubeX/mihomo/releases/download/v1.18.8/mihomo-linux-amd64-v1.18.8.gz"
```

**aarch64架构下载命令：**
```bash
curl -L -o mihomo-linux-arm64-v1.18.8.gz \
  "https://ghproxy.com/https://github.com/MetaCubeX/mihomo/releases/download/v1.18.8/mihomo-linux-arm64-v1.18.8.gz"
```

**解压安装：**
```bash
gunzip mihomo-linux-amd64-v1.18.8.gz
chmod +x mihomo-linux-amd64-v1.18.8
sudo mv mihomo-linux-amd64-v1.18.8 /usr/local/bin/mihomo
```

---

## 二、离线部署案例

### 案例1：Ubuntu 22.04 x86_64 完整离线部署

**适用环境：** Ubuntu 20.04/22.04 LTS, Debian 11/12

**步骤1：创建工作目录**
```bash
sudo mkdir -p /etc/mihomo
sudo mkdir -p /var/log/mihomo
sudo mkdir -p /usr/local/bin
```

**步骤2：下载并安装二进制文件**
```bash
# 下载mihomo v1.18.8 (稳定版)
cd /tmp
curl -L -o mihomo.gz \
  "https://ghproxy.com/https://github.com/MetaCubeX/mihomo/releases/download/v1.18.8/mihomo-linux-amd64-v1.18.8.gz"

# 解压
gunzip mihomo.gz
chmod +x mihomo-linux-amd64-v1.18.8
sudo mv mihomo-linux-amd64-v1.18.8 /usr/local/bin/mihomo

# 创建软链接
sudo ln -sf /usr/local/bin/mihomo /usr/local/bin/clash
```

**步骤3：配置文件准备**
```bash
# 创建配置目录
sudo mkdir -p /etc/mihomo

# 创建初始配置文件
sudo tee /etc/mihomo/config.yaml << 'EOF'
# Mihomo配置模板
mixed-port: 7890
allow-lan: true
bind-address: '*'
mode: rule
log-level: info
external-controller: 0.0.0.0:9090

# DNS配置
dns:
  enable: true
  listen: 0.0.0.0:1053
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver:
    - 223.5.5.5
    - 119.29.29.29
    - 8.8.8.8

# 代理提供商（需手动添加）
proxies: []
proxy-groups: []
rules: []
EOF

sudo chmod 644 /etc/mihomo/config.yaml
```

**步骤4：设置权限**
```bash
# 授予网络绑定权限（允许非root绑定低端口）
sudo setcap cap_net_bind_service=+ep /usr/local/bin/mihomo

# 创建mihomo用户（可选）
sudo useradd -r -s /bin/false mihomo 2>/dev/null || true
sudo chown -R root:root /etc/mihomo
sudo chown -R root:root /var/log/mihomo
```

**步骤5：创建systemd服务**
```bash
sudo tee /etc/systemd/system/mihomo.service << 'EOF'
[Unit]
Description=Mihomo Proxy Service
Documentation=https://wiki.metacubex.one/
After=network.target nss-lookup.target

[Service]
Type=simple
ExecStart=/usr/local/bin/mihomo -d /etc/mihomo -f /etc/mihomo/config.yaml
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=3
StandardOutput=append:/var/log/mihomo/mihomo.log
StandardError=append:/var/log/mihomo/mihomo.log

# 安全限制
LimitNOFILE=1048576
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/etc/mihomo /var/log/mihomo

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
```

**步骤6：环境变量配置**
```bash
# 系统级环境变量
sudo tee /etc/profile.d/mihomo-proxy.sh << 'EOF'
# Mihomo代理环境变量
export http_proxy=http://127.0.0.1:7890
export https_proxy=http://127.0.0.1:7890
export no_proxy=localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
EOF

# 用户级环境变量（推荐）
tee ~/.bashrc.d/mihomo-proxy.sh << 'EOF'
# Mihomo代理环境变量
export http_proxy=http://127.0.0.1:7890
export https_proxy=http://127.0.0.1:7890
export ALL_PROXY=socks5://127.0.0.1:7890
export no_proxy=localhost,127.0.0.1,::1,.local
EOF
```

**步骤7：启动服务**
```bash
sudo systemctl enable mihomo
sudo systemctl start mihomo
sudo systemctl status mihomo
```

---

### 案例2：CentOS 8/RHEL 8 aarch64 (ARM64) 部署

**适用环境：** CentOS 8, Rocky Linux 8/9, AlmaLinux 8/9 (ARM64架构)

**步骤1：安装依赖**
```bash
sudo yum install -y curl gzip tar
```

**步骤2：下载ARM64版本**
```bash
cd /tmp
curl -L -o mihomo-linux-arm64.gz \
  "https://ghproxy.com/https://github.com/MetaCubeX/mihomo/releases/download/v1.18.8/mihomo-linux-arm64-v1.18.8.gz"

gunzip mihomo-linux-arm64.gz
chmod +x mihomo-linux-arm64-v1.18.8
sudo mv mihomo-linux-arm64-v1.18.8 /usr/local/bin/mihomo
```

**步骤3：权限设置**
```bash
# 授予网络权限
sudo setcap cap_net_bind_service=+ep /usr/local/bin/mihomo

# 验证权限
getcap /usr/local/bin/mihomo
# 输出: /usr/local/bin/mihomo = cap_net_bind_service+ep
```

**步骤4：SELinux配置（重要）**
```bash
# 查看SELinux状态
getenforce

# 如为Enforcing，需要添加策略
sudo setsebool -P nis_enabled 1

# 或创建自定义策略（推荐）
sudo tee /etc/selinux/local/mihomo.te << 'EOF'
module mihomo 1.0;

require {
    type unconfined_t;
    type unconfined_service_t;
    class capability { net_bind_service net_admin };
    class unix_stream_socket { create connect };
}

allow unconfined_service_t self:capability { net_bind_service net_admin };
EOF

# 编译并加载策略
checkmodule -M -m -o /tmp/mihomo.mod /etc/selinux/local/mihomo.te
semodule_package -o /tmp/mihomo.pp -m /tmp/mihomo.mod
sudo semodule -i /tmp/mihomo.pp
```

**步骤5：systemd服务（CentOS优化版）**
```bash
sudo tee /etc/systemd/system/mihomo.service << 'EOF'
[Unit]
Description=Mihomo Proxy Service
Documentation=https://wiki.metacubex.one/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/mihomo -d /etc/mihomo -f /etc/mihomo/config.yaml
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5
StartLimitInterval=60s
StartLimitBurst=3

# 日志配置
StandardOutput=journal
StandardError=journal
SyslogIdentifier=mihomo

# 资源限制
LimitNOFILE=65536
LimitNPROC=4096

# 环境变量
Environment="http_proxy="
Environment="https_proxy="

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable mihomo
```

---

### 案例3：Alpine Linux x86_64 轻量级部署

**适用环境：** Alpine Linux 3.16+, Docker容器, 轻量级服务器

**步骤1：安装必要工具**
```bash
apk add --no-cache curl ca-certificates
```

**步骤2：下载并安装**
```bash
cd /tmp
curl -L -o mihomo.gz \
  "https://ghproxy.com/https://github.com/MetaCubeX/mihomo/releases/download/v1.18.8/mihomo-linux-amd64-compatible-v1.18.8.gz"

gunzip mihomo.gz
chmod +x mihomo-linux-amd64-compatible-v1.18.8
mv mihomo-linux-amd64-compatible-v1.18.8 /usr/local/bin/mihomo
```

**步骤3：创建OpenRC服务（Alpine使用OpenRC而非systemd）**
```bash
tee /etc/init.d/mihomo << 'EOF'
#!/sbin/openrc-run

description="Mihomo Proxy Service"
depend() {
    need net
    after firewall
}

command="/usr/local/bin/mihomo"
command_args="-d /etc/mihomo -f /etc/mihomo/config.yaml"
command_background=true
pidfile="/run/${RC_SVCNAME}.pid"
output_log="/var/log/mihomo/mihomo.log"
error_log="/var/log/mihomo/mihomo.log"

start_pre() {
    checkpath -d -m 0755 -o root:root /var/log/mihomo
    checkpath -f -m 0644 -o root:root /etc/mihomo/config.yaml
}
EOF

chmod +x /etc/init.d/mihomo
```

**步骤4：配置目录结构**
```bash
mkdir -p /etc/mihomo
mkdir -p /var/log/mihomo

# 创建最小配置文件
cat > /etc/mihomo/config.yaml << 'EOF'
port: 7890
socks-port: 7891
allow-lan: true
mode: rule
log-level: info
external-controller: 127.0.0.1:9090
proxies: []
proxy-groups: []
rules: []
EOF
```

**步骤5：启动服务**
```bash
rc-update add mihomo default
rc-service mihomo start
rc-service mihomo status
```

---

## 三、systemd服务配置模板大全

### 3.1 基础模板（通用）
```ini
[Unit]
Description=Mihomo Proxy Service
After=network.target nss-lookup.target

[Service]
Type=simple
ExecStart=/usr/local/bin/mihomo -d /etc/mihomo -f /etc/mihomo/config.yaml
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 3.2 高级安全模板
```ini
[Unit]
Description=Mihomo Proxy Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mihomo
Group=mihomo
ExecStart=/usr/local/bin/mihomo -d /etc/mihomo -f /etc/mihomo/config.yaml
ExecReload=/bin/kill -HUP $MAINPID

# 重启策略
Restart=on-failure
RestartSec=5
StartLimitInterval=60s
StartLimitBurst=3

# 文件描述符限制
LimitNOFILE=65536

# 安全加固
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/etc/mihomo /var/log/mihomo /var/lib/mihomo
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true

# 能力设置
AmbientCapabilities=CAP_NET_BIND_SERVICE CAP_NET_ADMIN
CapabilityBoundingSet=CAP_NET_BIND_SERVICE CAP_NET_ADMIN

# 日志
StandardOutput=append:/var/log/mihomo/mihomo.log
StandardError=append:/var/log/mihomo/mihomo.log

[Install]
WantedBy=multi-user.target
```

### 3.3 Docker兼容模板
```ini
[Unit]
Description=Mihomo Proxy Service
After=docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/etc/mihomo
ExecStart=/usr/local/bin/mihomo -f /etc/mihomo/config.yaml
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=10

# 网络命名空间（可选）
# PrivateNetwork=yes
# JoinsNamespaceOf=docker.service

[Install]
WantedBy=multi-user.target
```

---

## 四、关键权限设置指令

### 4.1 网络权限（必需）
```bash
# 授予绑定低端口权限
sudo setcap cap_net_bind_service=+ep /usr/local/bin/mihomo

# 验证
getcap /usr/local/bin/mihomo
```

### 4.2 网络管理权限（TUN模式需要）
```bash
# 如需TUN模式，需要额外权限
sudo setcap cap_net_bind_service,cap_net_admin=+ep /usr/local/bin/mihomo

# 或使用文件ACL
sudo setfacl -m u:mihomo:rx /usr/local/bin/mihomo
```

### 4.3 用户和组创建
```bash
# 创建专用用户
sudo useradd -r -s /bin/false -M mihomo

# 设置目录权限
sudo mkdir -p /etc/mihomo /var/log/mihomo /var/lib/mihomo
sudo chown -R mihomo:mihomo /var/log/mihomo /var/lib/mihomo
sudo chmod 755 /etc/mihomo
sudo chmod 644 /etc/mihomo/config.yaml
```

---

## 五、环境变量配置

### 5.1 系统级代理设置
```bash
# /etc/profile.d/proxy.sh
export http_proxy=http://127.0.0.1:7890
export https_proxy=http://127.0.0.1:7890
export ftp_proxy=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
export FTP_PROXY=http://127.0.0.1:7890
export ALL_PROXY=socks5://127.0.0.1:7890
export NO_PROXY=localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.local
```

### 5.2 用户级代理设置
```bash
# ~/.bashrc 或 ~/.zshrc 添加
proxy_on() {
    export http_proxy=http://127.0.0.1:7890
    export https_proxy=http://127.0.0.1:7890
    export all_proxy=socks5://127.0.0.1:7890
    echo "Proxy enabled"
}

proxy_off() {
    unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
    echo "Proxy disabled"
}
```

### 5.3 服务内环境变量
```ini
# 在systemd服务文件[Service]段添加
Environment="http_proxy="
Environment="https_proxy="
Environment="HTTP_PROXY="
Environment="HTTPS_PROXY="
```

---

## 六、常用管理命令

### 6.1 服务管理
```bash
# 启动/停止/重启
sudo systemctl start mihomo
sudo systemctl stop mihomo
sudo systemctl restart mihomo

# 重载配置（不中断服务）
sudo systemctl reload mihomo
# 或
sudo kill -HUP $(pgrep mihomo)

# 查看状态
sudo systemctl status mihomo
sudo journalctl -u mihomo -f

# 开机自启
sudo systemctl enable mihomo
sudo systemctl disable mihomo
```

### 6.2 验证安装
```bash
# 检查版本
mihomo -v

# 测试配置文件
mihomo -t -f /etc/mihomo/config.yaml

# 前台运行调试
mihomo -d /etc/mihomo -f /etc/mihomo/config.yaml
```

### 6.3 网络测试
```bash
# 测试代理
curl -x http://127.0.0.1:7890 -I https://www.google.com

# 测试SOCKS5
curl --socks5 127.0.0.1:7890 -I https://www.google.com

# 查看端口监听
ss -tlnp | grep mihomo
netstat -tlnp | grep mihomo
```

---

## 七、离线包制作指南

### 7.1 创建完整离线安装包
```bash
#!/bin/bash
# make_offline_pkg.sh
VERSION="v1.18.8"
ARCH="amd64"
PKG_DIR="mihomo-offline-${VERSION}-${ARCH}"

mkdir -p ${PKG_DIR}/{bin,config,systemd,scripts}

# 下载二进制
curl -L -o ${PKG_DIR}/bin/mihomo.gz \
  "https://ghproxy.com/https://github.com/MetaCubeX/mihomo/releases/download/${VERSION}/mihomo-linux-${ARCH}-${VERSION}.gz"

# 创建安装脚本
cat > ${PKG_DIR}/install.sh << 'INSTALL_EOF'
#!/bin/bash
set -e

echo "Installing Mihomo..."

# 解压
gunzip -c bin/mihomo.gz > /usr/local/bin/mihomo
chmod +x /usr/local/bin/mihomo

# 设置权限
setcap cap_net_bind_service=+ep /usr/local/bin/mihomo

# 复制配置
mkdir -p /etc/mihomo /var/log/mihomo
cp config/config.yaml /etc/mihomo/

# 安装服务
cp systemd/mihomo.service /etc/systemd/system/
systemctl daemon-reload

echo "Installation complete!"
echo "Run: sudo systemctl start mihomo"
INSTALL_EOF

chmod +x ${PKG_DIR}/install.sh

# 打包
tar czvf ${PKG_DIR}.tar.gz ${PKG_DIR}
echo "Offline package created: ${PKG_DIR}.tar.gz"
```

---

## 八、故障排查

### 8.1 常见问题

| 问题 | 原因 | 解决方案 |
|-----|------|---------|
| Permission denied | 缺少执行权限 | `chmod +x /usr/local/bin/mihomo` |
| bind: permission denied | 未授权低端口 | `setcap cap_net_bind_service=+ep ...` |
| 服务启动失败 | 配置错误 | `mihomo -t -f /etc/mihomo/config.yaml` |
| 无法连接外网 | 规则配置错误 | 检查proxies和rules配置 |

### 8.2 调试模式
```bash
# 前台运行查看日志
sudo mihomo -d /etc/mihomo -f /etc/mihomo/config.yaml

# 详细日志
sudo mihomo -d /etc/mihomo -f /etc/mihomo/config.yaml -l debug
```

---

## 九、总结

本报告提供了3个完整的Linux离线部署案例：
1. **Ubuntu/Debian x86_64** - 通用桌面/服务器部署
2. **CentOS/RHEL aarch64** - 企业级ARM服务器部署  
3. **Alpine Linux** - 轻量级/容器环境部署

关键操作已重点标注，所有命令均可直接复制复用。建议生产环境使用高级安全模板，并配合专用mihomo用户运行。

---

*报告生成时间: 2024年*
*适用版本: mihomo v1.18.8*
