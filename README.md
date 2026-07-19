# surge-vless-bridge (anytls fork)

[中文文档](./README.zh-CN.md) · [Modifications vs upstream](./MODIFICATIONS.md)

A Node.js CLI that turns a **Clash/mihomo (or legacy base64) subscription** into
Surge Mac proxies:

- **vless (reality)** nodes → local `sing-box` configs exposed to Surge as
  `external` proxies (Surge Mac has no native vless).
- **anytls** nodes → **native Surge `anytls` proxies** written straight into the
  profile (Surge Mac 6.4.3+ / iOS 5.17.0+ support anytls).
- **Multiple subscriptions** are merged into one Surge policy group, with
  automatic de-duplication of colliding node names.

It fetches your subscription(s), generates the per-node artifacts, backs up your
Surge profile, and rewrites a managed `# vless start … # vless end` block plus a
policy group — so every node works through Surge's rules, groups, and dashboard.

> This is a fork of [`chen86860/surge-vless-bridge`](https://github.com/chen86860/surge-vless-bridge)
> that adds anytls, Clash-YAML parsing, and multi-subscription merging. See
> [`MODIFICATIONS.md`](./MODIFICATIONS.md) for the full diff of behaviour.

## Prerequisites

- **Node.js ≥ 20**
- **[sing-box](https://github.com/SagerNet/sing-box)** installed (`brew install sing-box`) — used for vless nodes
- **Surge Mac 6.4.3+** with a profile containing `[Proxy]` and `[Proxy Group]` sections (needed for native anytls)

## Install

This fork is **not published to npm**; install it from the repo. The package has
**zero runtime dependencies** and ships a prebuilt `dist/`, so no build step is
needed on the target machine:

```bash
git clone <this-repo-url> surge-vless-bridge
cd surge-vless-bridge
npm install -g .
```

Verify:

```bash
surge-vless-bridge version
```

> Copying the folder (without `node_modules/`) to another machine and running
> `npm install -g .` works too — that's the intended way to reuse it.
>
> To hack on the source instead, see [Development](#development).

## Quick Start

**1. Generate a config template** (already includes a sane `addressResolver` DoH block):

```bash
surge-vless-bridge init
```

Writes `~/.config/surge-vless-bridge/config.json` and prints the exact path.

**2. Edit the config** — fill in your subscription(s) and Surge profile path:

```jsonc
{
  "subscriptionUrl": [
    "https://your-provider.com/subscribe/token"
  ],
  "surgeConfigPath": "/Users/you/Library/Application Support/Surge/Profiles/MyProfile.conf",
  "policyGroupName": "VLESS",
  "portStart": 2081,
  "addressResolver": { "strategy": "doh" }
}
```

- **`subscriptionUrl`** — one URL string, a comma-separated string, or an array
  to merge several subscriptions.
- **`surgeConfigPath`** — absolute path to your Surge profile. Find it via the
  Surge menu-bar icon → **Switch Profile** → **Show in Finder**, or:
  ```bash
  ls ~/Library/Application\ Support/Surge/Profiles/
  ```

**3. Sync:**

```bash
surge-vless-bridge sync
# → Synced 15 nodes (3 vless via sing-box, 12 anytls native).
```

**4. Reload the profile in Surge** (or quit & reopen) so it picks up the new
proxies, then optionally check:

```bash
surge-vless-bridge doctor
```

## How nodes are routed

| Subscription node type | Output |
| ---------------------- | ------ |
| `vless` (reality/tls)  | `sing-box[<port>].json` in `outputDir` + a Surge `external` proxy line with a DoH-resolved `addresses=` |
| `anytls`               | A native Surge `Name = anytls, server, port, password=…, sni=…, skip-cert-verify=true` line |
| other (ss/trojan/…)    | Skipped (reported in the `sync` summary) |

anytls nodes have no sing-box config, so `sync` also records their lines in
`<outputDir>/anytls-nodes.json`; `rebuild` reads that sidecar so it never drops
them.

## Airport traffic panel (optional)

`sync` also writes `<outputDir>/airport-traffic.js` — a Surge panel script that
shows each subscription's traffic usage (used / total / expiry) in the Surge
dashboard. It re-fetches the subscription with a Clash UA to read the
`subscription-userinfo` header (some panels hide it from Surge's UA), and labels
each airport by its `content-disposition` filename.

Your private subscription URLs are baked only into this generated local file —
never into the repo (which ships just the generator).

To enable it, either add the lines `sync` prints to your Surge profile, or set
`panelInjectPath` in your config to have `sync` inject them automatically:

```ini
[Panel]
AirportTraffic = script-name=AirportTraffic, update-interval=3600

[Script]
AirportTraffic = type=generic, script-path=/Users/you/.config/surge-vless-bridge/nodes/airport-traffic.js
```

With `"panelInjectPath": "/path/to/Active.conf"`, every `sync` upserts these two
entries into that profile idempotently (backing it up first, preserving existing
scripts). Point it at your **active** profile — panels only display from the
profile Surge actually loads.

## Config File

Default path: `~/.config/surge-vless-bridge/config.json`.

**Required**

| Field             | Description                                                  |
| ----------------- | ------------------------------------------------------------ |
| `subscriptionUrl` | Subscription URL(s): string, comma-separated string, or array |
| `surgeConfigPath` | Absolute path to your Surge profile                          |

**Optional**

| Field             | Default                                | Description                                            |
| ----------------- | -------------------------------------- | ------------------------------------------------------ |
| `policyGroupName` | `"VLESS"`                              | Surge `url-test` policy group to populate              |
| `portStart`       | `2081`                                 | First local SOCKS port; each vless node takes the next |
| `singBoxBinary`   | auto-detected via `which sing-box`     | Path to the `sing-box` binary                          |
| `outputDir`       | `~/.config/surge-vless-bridge/nodes`   | Where sing-box configs + `anytls-nodes.json` are written |
| `backupDir`       | `~/.config/surge-vless-bridge/backups` | Where Surge profile backups are stored                 |
| `requestHeaders`  | Clash UA (`clash-verge/v1.7.0`)        | Headers used to fetch the subscription                 |
| `panelInjectPath` | `""` (off)                             | Surge `.conf` to auto-inject the traffic panel's `[Panel]`/`[Script]` into; empty = just print the snippet |
| `addressResolver` | `{ "strategy": "doh" }` (from `init`)  | How proxy server domains are resolved for `addresses=` |

`addressResolver.strategy`:

| Strategy | Description                                                                                |
| -------- | ------------------------------------------------------------------------------------------ |
| `doh`    | Resolve via `dohEndpoint` (default `https://1.1.1.1/dns-query`), fall back to `dnsServers`. **Recommended** — avoids Surge Fake-IP. |
| `dns`    | Resolve with `dnsServers` (e.g. `["1.1.1.1", "8.8.8.8"]`).                                  |
| `system` | Node.js system DNS. May return Surge Fake-IP if Surge hijacks your resolver.                |
| `off`    | Do not write `addresses=` at all.                                                          |

> **Why DoH is the default:** Surge's enhanced mode hijacks system DNS to
> Fake-IP addresses (`198.18.0.0/15`). If those get pinned into a proxy's
> `addresses=`, the node can't connect. DoH (or `dns`) resolves the real IP.
> `filterSurgeFakeIp` (default `true`) additionally drops any `198.18.x.x` result.

Runtime overrides:

```bash
surge-vless-bridge sync --subscription-url "https://a/sub,https://b/sub" --group-name VLESS
```

## Commands

| Command                      | Description                                                        |
| ---------------------------- | ----------------------------------------------------------------- |
| `surge-vless-bridge init`    | Create a config template (with DoH pre-filled)                    |
| `surge-vless-bridge sync`    | Fetch subscription(s) → vless via sing-box + anytls native → update Surge |
| `surge-vless-bridge rebuild` | Rebuild the Surge block from local sing-box configs + anytls sidecar (no network) |
| `surge-vless-bridge restore` | Restore the latest (or a given) Surge profile backup              |
| `surge-vless-bridge doctor`  | Validate config, paths, subscription count, and Surge markers     |

---

## Development

```bash
git clone <this-repo-url> surge-vless-bridge
cd surge-vless-bridge
npm install          # dev toolchain (tsc/tsx) only; no runtime deps
```

In a repo checkout the config defaults to `./.surge-vless-bridge.json` (not the
global path). Run without building via `tsx`:

```bash
npm run sync
npm run doctor
```

Rebuild the committed `dist/` after editing `src/`:

```bash
npm run build
npm install -g .     # re-install the global command from the fresh build
```
