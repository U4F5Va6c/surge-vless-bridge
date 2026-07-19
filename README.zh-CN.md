# surge-vless-bridge（anytls 增强版）

[English README](./README.md) · [相对上游的改动](./MODIFICATIONS.md)

一个 Node.js CLI，把 **Clash/mihomo（或旧版 base64）订阅**转换成 Surge Mac 可用的代理：

- **vless（reality）** 节点 → 生成本地 `sing-box` 配置，作为 Surge `external` 代理接入（Surge Mac 不原生支持 vless）。
- **anytls** 节点 → 直接写成 Surge **原生 `anytls` 代理**（需 Surge Mac 6.4.3+ / iOS 5.17.0+）。
- **多个订阅**会合并进同一个策略组，重名节点自动去重（追加 ` 2`/` 3` 后缀）。

它会拉取订阅、生成各节点产物、备份 Surge 配置，并重写一段受管的
`# vless start … # vless end` 区块与策略组——让所有节点都能通过 Surge 的规则、
策略组和面板使用。

> 本项目 fork 自 [`chen86860/surge-vless-bridge`](https://github.com/chen86860/surge-vless-bridge)，
> 增加了 anytls、Clash-YAML 解析与多订阅合并。完整行为差异见
> [`MODIFICATIONS.md`](./MODIFICATIONS.md)。

## 前置条件

- **Node.js ≥ 20**
- 已安装 **[sing-box](https://github.com/SagerNet/sing-box)**（`brew install sing-box`）—— vless 节点需要
- **Surge Mac 6.4.3+**，配置文件含 `[Proxy]` 与 `[Proxy Group]` 区块（anytls 原生代理需要）

## 安装

本增强版**未发布到 npm**，直接从仓库安装。该包**零运行时依赖**且已提交预构建的
`dist/`，因此目标机器**无需构建**：

```bash
git clone <本仓库地址> surge-vless-bridge
cd surge-vless-bridge
npm install -g .
```

验证：

```bash
surge-vless-bridge version
```

> 把整个目录（不含 `node_modules/`）拷到另一台机器再 `npm install -g .` 同样可用
> ——这正是推荐的多机复用方式。要改源码请看 [本地开发](#本地开发)。

## 快速开始

**1. 生成配置模板**（已自带 DoH 解析配置）：

```bash
surge-vless-bridge init
```

配置写入 `~/.config/surge-vless-bridge/config.json` 并打印路径。

**2. 编辑配置** —— 填入订阅与 Surge 配置路径：

```jsonc
{
  "subscriptionUrl": [
    "https://你的机场/subscribe/token"
  ],
  "surgeConfigPath": "/Users/you/Library/Application Support/Surge/Profiles/MyProfile.conf",
  "policyGroupName": "VLESS",
  "portStart": 2081,
  "addressResolver": { "strategy": "doh" }
}
```

- **`subscriptionUrl`** —— 可填单个字符串、逗号分隔字符串，或数组（多订阅合并）。
- **`surgeConfigPath`** —— Surge 配置文件绝对路径。获取方式：菜单栏 Surge 图标 →
  **切换配置** → **在访达中显示**，或：
  ```bash
  ls ~/Library/Application\ Support/Surge/Profiles/
  ```

**3. 同步：**

```bash
surge-vless-bridge sync
# → Synced 15 nodes (3 vless via sing-box, 12 anytls native).
```

**4. 在 Surge 中重新加载配置**（或退出重开），让它读到新节点，然后可选检查：

```bash
surge-vless-bridge doctor
```

## 节点如何分流

| 订阅节点类型          | 产物 |
| --------------------- | ---- |
| `vless`（reality/tls）| `outputDir` 下的 `sing-box[<端口>].json` + 一行 Surge `external` 代理（`addresses=` 用 DoH 解析真实 IP） |
| `anytls`              | 一行 Surge 原生 `名称 = anytls, server, port, password=…, sni=…, skip-cert-verify=true` |
| 其它（ss/trojan/…）   | 跳过（在 `sync` 摘要里提示数量） |

anytls 没有独立的 sing-box 配置，因此 `sync` 会把它们的行额外记录到
`<outputDir>/anytls-nodes.json`；`rebuild` 会读取该侧车文件，保证不丢失。

## 机场流量面板（可选）

`sync` 还会生成 `<outputDir>/airport-traffic.js` —— 一个 Surge 面板脚本，在 Surge
仪表盘显示每个订阅的流量使用（已用 / 总额 / 到期）。它用 Clash UA 重新拉订阅、
读取 `subscription-userinfo` 头（有的面板对 Surge UA 不回传该头），机场名自动取自
`content-disposition`。

你的私有订阅 URL 只会写进这个本地生成文件，**不会进入仓库**（仓库里只有生成器）。

启用方式：把 `sync` 打印的配置行加到你的 Surge 配置里：

```ini
[Panel]
AirportTraffic = script-name=AirportTraffic, update-interval=3600

[Script]
AirportTraffic = type=generic, script-path=/Users/you/.config/surge-vless-bridge/nodes/airport-traffic.js
```

## 配置文件

默认路径：`~/.config/surge-vless-bridge/config.json`。

**必填**

| 字段              | 说明                                            |
| ----------------- | ----------------------------------------------- |
| `subscriptionUrl` | 订阅地址：字符串 / 逗号分隔字符串 / 数组         |
| `surgeConfigPath` | Surge 配置文件的绝对路径                        |

**选填**

| 字段              | 默认值                                 | 说明                                       |
| ----------------- | -------------------------------------- | ------------------------------------------ |
| `policyGroupName` | `"VLESS"`                              | 要写入的 Surge `url-test` 策略组名称       |
| `portStart`       | `2081`                                 | 起始本地端口，每个 vless 节点依次递增      |
| `singBoxBinary`   | 自动检测（`which sing-box`）           | `sing-box` 可执行文件路径                  |
| `outputDir`       | `~/.config/surge-vless-bridge/nodes`   | sing-box 配置与 `anytls-nodes.json` 保存目录 |
| `backupDir`       | `~/.config/surge-vless-bridge/backups` | Surge 配置备份目录                         |
| `requestHeaders`  | Clash UA（`clash-verge/v1.7.0`）       | 拉取订阅时使用的请求头                     |
| `addressResolver` | `{ "strategy": "doh" }`（由 `init` 生成） | 为 `addresses=` 解析代理服务器域名的方式 |

`addressResolver.strategy` 可选：

| 策略     | 说明                                                                              |
| -------- | --------------------------------------------------------------------------------- |
| `doh`    | 用 `dohEndpoint`（默认 `https://1.1.1.1/dns-query`）解析，失败回退 `dnsServers`。**推荐**，绕开 Surge Fake-IP。 |
| `dns`    | 用 `dnsServers`（如 `["1.1.1.1", "8.8.8.8"]`）解析。                              |
| `system` | Node.js 系统 DNS。若 Surge 劫持了系统解析可能拿到 Fake-IP。                        |
| `off`    | 完全不写入 `addresses=`。                                                         |

> **为什么默认用 DoH：** Surge 增强模式会把系统 DNS 劫持成 Fake-IP（`198.18.0.0/15`）。
> 一旦这种假 IP 被写进代理的 `addresses=`，节点就连不上。DoH（或 `dns`）能解析出真实 IP。
> `filterSurgeFakeIp`（默认 `true`）还会额外过滤掉任何 `198.18.x.x` 结果。

命令行临时覆盖：

```bash
surge-vless-bridge sync --subscription-url "https://a/sub,https://b/sub" --group-name VLESS
```

## 命令说明

| 命令                         | 说明                                                             |
| ---------------------------- | ---------------------------------------------------------------- |
| `surge-vless-bridge init`    | 生成配置模板（已预填 DoH）                                       |
| `surge-vless-bridge sync`    | 拉取订阅 → vless 走 sing-box + anytls 原生 → 更新 Surge          |
| `surge-vless-bridge rebuild` | 仅用本地 sing-box 配置 + anytls 侧车重建区块（不访问网络）       |
| `surge-vless-bridge restore` | 恢复最近一次（或指定的）Surge 配置备份                          |
| `surge-vless-bridge doctor`  | 检查配置、路径、订阅数量及 Surge 必需区块                       |

---

## 本地开发

```bash
git clone <本仓库地址> surge-vless-bridge
cd surge-vless-bridge
npm install          # 仅安装 tsc/tsx 等开发工具；无运行时依赖
```

在仓库目录里，配置默认写到当前目录的 `./.surge-vless-bridge.json`（而非全局路径）。
用 `tsx` 直接跑源码、无需构建：

```bash
npm run sync
npm run doctor
```

改完 `src/` 后重建已提交的 `dist/`：

```bash
npm run build
npm install -g .     # 用新构建重新安装全局命令
```
