# 本地改造说明（fork of surge-vless-bridge v1.0.8）

在上游 `chen86860/surge-vless-bridge` 基础上做了以下增强，用于同时把
**vless（reality）** 和 **anytls** 两类节点接入 Surge。

## 新增能力

1. **解析 Clash / mihomo YAML 订阅**（`src/utils/parse-clash.ts`）
   - 零依赖，自己解析单行 flow-map（`- { name: ..., type: ... }`）。
   - 面板对 Clash UA 会下发**全部协议**的节点（含 anytls），比 v2ray base64（只含 vless）更全。
   - 默认请求 UA 已改为 `clash-verge/v1.7.0`（见 `configuration.ts`）。
   - 仍兼容旧的 base64/`vless://` 订阅（自动按格式判别）。

2. **按协议分流**
   - `vless` → 生成 sing-box 配置，走 Surge `external` 代理（沿用原逻辑）。
   - `anytls` → 直接写成 Surge **原生** `anytls` 代理行
     （`Name = anytls, server, port, password=…, sni=…, skip-cert-verify=true`）。

3. **多订阅合并**
   - `subscriptionUrl` 支持字符串、逗号分隔字符串或数组；多个订阅的节点会合并，
     重名自动追加 ` 2`/` 3` 后缀（`src/utils/policy-name.ts`）。
   - CLI：`--subscription-url a,b,c`。

4. **rebuild 不丢 anytls**
   - anytls 没有独立 sing-box 配置，sync 时会把它们写到
     `<outputDir>/anytls-nodes.json` 侧车文件，`rebuild` 时一并恢复。

5. **机场流量面板**（`src/utils/panel-script.ts`）
   - `sync` 会在 `<outputDir>/airport-traffic.js` 生成一个 Surge 面板脚本，
     用 Clash UA 拉订阅、读 `subscription-userinfo` 头，在 Surge 仪表盘显示
     已用/总额/剩余/到期，机场名自动取自 `content-disposition`。
   - 订阅 URL 只注入本地生成文件（私有），**不进仓库**；仓库里只有生成器。
   - 在 Surge 配置里加 `[Panel]` + `[Script]`（`type=generic`）即可挂载，
     `sync` 结束会打印需要粘贴的配置行。

## 配置示例（`~/.config/surge-vless-bridge/config.json`）

```json
{
  "subscriptionUrl": [
    "https://面板A/subscribe/xxxx",
    "https://面板B/subscribe/yyyy"
  ],
  "surgeConfigPath": "/path/to/Your.conf",
  "policyGroupName": "VLESS",
  "portStart": 2081,
  "addressResolver": { "strategy": "doh" }
}
```

> `addressResolver.strategy = "doh"` 很重要：Surge 增强模式会把本机 DNS 劫持成
> Fake-IP（198.18.x.x），用 DoH 解析才能拿到真实 IP 填进 `addresses=`。

## 在其它机器复用

本包**零运行时依赖**，`dist/` 已随仓库提交，因此免构建：

```bash
# 方式一：拷贝目录（不含 node_modules）后
cd surge-vless-bridge && npm install -g .

# 方式二：git clone 后同样
npm install -g .
```

需要改代码时：`npm install`（装 tsc）→ 改 `src/` → `npm run build` → `npm install -g .`。

## 与上游的对应改动文件

- `src/utils/parse-clash.ts`（新）— Clash flow-map 解析
- `src/utils/clash-vless-to-outbound.ts`（新）— Clash vless → sing-box outbound
- `src/utils/build-anytls-line.ts`（新）— Clash anytls → Surge 原生行
- `src/utils/policy-name.ts`（新）— 名称清洗 + 全局去重
- `src/parse.ts`（改）— 多订阅拉取 + 格式判别 + 分流
- `src/surge.ts`（改）— vless/anytls 分别生成、合并写入、anytls 侧车
- `src/configuration.ts`（改）— 默认 Clash UA、示例配置
- `src/types/cli-config.ts`（改）— `subscriptionUrl: string | string[]`
- `src/cli.ts`（改）— 输出分类统计、帮助文案
