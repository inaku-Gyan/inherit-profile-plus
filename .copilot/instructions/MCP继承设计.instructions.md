---
description: "Use when: 实现或评审 MCP 服务器继承功能、理解 mcp.json 继承机制、排查 MCP 继承相关问题、扩展继承到新资源类型时参考设计模式"
---

# inherit-profile-plus — MCP 服务器继承设计

> **状态**：📋 设计已定稿（2026-10-22），**尚未实现**。实现时按本文档执行。
> **决策**：冲突策略 **A（子级整体覆盖）**；多父级合并 **后者覆盖前者**（按 `parents` 数组顺序）。

---

## 一、背景与现状

### 1.1 当前状态

- **MCP 服务器继承目前不支持**。`src/` 下无任何 `mcp`/`MCP`/`Mcp` 相关代码。
- 扩展当前只继承两类资源：
  1. **设置**（`settings.json`）— `subtractSettings(父, 子)` 差集 + 标记块
  2. **扩展**（`extensions.json`）— `collectInheritedExtensions` 7 步全量对账
- MCP 服务器配置存储在 `<profile>/mcp.json`（VS Code 1.102+ 一等资源，源码 `mcpResource: joinPath(location, 'mcp.json')`），**完全未被继承逻辑处理**。

### 1.2 mcp.json 文件格式

```jsonc
{
  // VS Code 官方格式（1.102+，profile 级 / .vscode/mcp.json）
  "servers": {
    "my-server": {
      "type": "stdio",        // stdio | sse | http
      "command": "npx",
      "args": ["-y", "@some/mcp-server"],
      "env": { "KEY": "value" },
      "cwd": "..."            // 可选
    }
  }
}
```

> ⚠️ **格式差异**：VS Code 的 `mcp.json` 用 `"servers"` 顶层键；Claude 风格 `.mcp.json` / 插件清单用 `"mcpServers"`。**本设计只处理 profile 级 `mcp.json`（`servers` 键）**。工作区级 `.vscode/mcp.json` / `.mcp.json` 属于项目随仓库同步，不在 Profile 继承范围内。

### 1.3 关键差异：为什么不能复用 `flattenSettings`

`mcp.json` 的顶层是 `servers` 对象，每个 server 是 `{name: config}` 的 map。**server 名是 map 的 key，不是嵌套设置**，所以**不能**用 `flattenSettings` 递归拍平——那会把 `my-server` 的 `command`/`args` 等字段错误地展开成 `servers.my-server.command`，破坏 VS Code 语义。

需要 MCP 专属的差集逻辑（见 三.1）。

---

## 二、冲突处理策略（已定稿）

### 2.1 父子级同名 server：策略 A（子级整体覆盖）

| 场景 | 行为 |
|------|------|
| 父级有、子级 own 没有的 server | **整体继承**（写入子级 mcp.json 继承块） |
| 子级 own 有同名 server | **整个 server 不继承**，子级配置完全生效（父级不覆盖） |
| 子级 own 有、父级没有的 server | **保留子级 own（不清理）** |

> **补充规则（2026-10-23 明确）**：**子集有、父级没有 → 保留**。子级自己独有的 server 必须原样保留，**绝不因父级没有同名 server 而被继承逻辑误删**。这是对"父级有子级没有→继承"的对称补充——继承只做**加法**（补父级有而子级缺的），不做**减法**（不删子级独有或子级显式定义的）。

- 优点：语义清晰、实现简单、与设置继承心智一致（"子级显式定义即覆盖"）
- 缺点：子级想"只改 env、其余继承父级"做不到（如需此能力，后续演进到策略 B/C）
- **台账**：`_originallyOwnMcpServers` 记录子级 own 的 server 名，保证父级同名 server 永不覆盖子级显式值

### 2.2 多父级同名 server：后者覆盖前者

与设置继承的 `mergeFlattenedSettings` 一致：按 `parents` 数组顺序遍历，**后面的父级赢**。

```ts
// 伪代码
let merged: Record<string, McpServerConfig> = {};
for (const parentName of parentNames) {
  const servers = await readMcpServers(path.join(profiles[parentName], "mcp.json"));
  merged = { ...merged, ...servers }; // 后者覆盖前者
}
```

### 2.3 与设置/扩展继承的对比

| 资源 | 冲突策略 | 台账 |
|------|---------|------|
| 设置 | 子级显式定义即排除（子级赢） | 无（天然差集） |
| 扩展 | 子级 own 转 inherited + 版本比较 | `_originallyOwnExtensions` / `optedOutExtensions` |
| **MCP** | **子级整体覆盖（子级赢）** | **`_originallyOwnMcpServers` / `_optedOutMcpServers`** |

---

## 三、实现设计

### 3.1 新增文件 `src/mcpInheritance.ts`

核心函数（全部可独立单测，不依赖 vscode，仿 `profileSettings.ts` 风格）：

```ts
// MCP server 配置类型
export interface McpServerConfig {
  type?: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  [key: string]: any; // 保留未知字段
}

// 读取 mcp.json 的 servers map（容错：文件不存在 → {}；损坏 → {}）
export async function readMcpServers(mcpPath: string): Promise<Record<string, McpServerConfig>>

// 差集：父级有、子级 own 没有的 server（子级显式定义同名 → 不继承）
export function subtractMcpServers(
  parentServers: Record<string, McpServerConfig>,
  ownServers: Record<string, McpServerConfig>,
): Record<string, McpServerConfig>

// 剥离继承块（复用 stripInheritedSettingsBlocks 的标记机制）
export function stripInheritedMcpBlocks(raw: string): { cleaned: string; removedCount: number }

// 构建继承块（复用 buildInheritedSettingsBlock 的格式）
export function buildInheritedMcpBlock(servers: Record<string, McpServerConfig>, tab: string): string

// 判断是否有继承标记
export function hasInheritedMcpMarkers(raw: string): boolean

// 校验 mcp.json 是否为合法对象（仿 isSettingsDocument，但顶层键是 servers）
export function isMcpDocument(raw: string): boolean
```

### 3.2 继承标记块格式

`mcp.json` 是 JSONC（VS Code 允许注释），沿用 settings 的标记机制：

```jsonc
{
  "servers": {
    // --- INHERITED SETTINGS MARKER START (from Base) ---
    "git-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@git/mcp"]
    },
    // --- INHERITED SETTINGS MARKER END ---
    "my-own-server": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

> ⚠️ 复用 `INHERITED_SETTINGS_START_MARKER` / `INHERITED_SETTINGS_END_MARKER` 常量（`profileSettings.ts`），保证与 settings 的清理逻辑一致（`stripInheritedSettingsBlocks` 可复用或仿写）。

### 3.3 元数据台账（存 settings.json 扁平 key）

与扩展元数据一致，存 `settings.json` 的 `inheritProfile.*` 扁平 key：

| key | 用途 |
|-----|------|
| `inheritProfile._originallyOwnMcpServers` | 子级原本 own 的 server 名列表（防父级覆盖） |
| `inheritProfile._optedOutMcpServers` | 用户主动跳过的 server 名列表 |

**必须**：
1. 加入 `setKeysForSync`（跨设备备份）— `extension.ts` 的 `context.globalState.setKeysForSync([...])`
2. 加入 `settingsSync.ignoredSettings` — `extension.ts` 的 `INHERIT_PROFILE_SYNC_KEYS` 数组
3. 写入用**扁平 key**（防 Settings Sync 节点锁定，与 parents 同款教训）

### 3.4 接入现有同步流程

在 `profiles.ts` 的 `applyInheritedSettings` 和 `syncProfileByName` 中，设置继承之后、扩展继承之前插入 MCP 继承步骤：

```
1. 设置继承（现有）
2. MCP 继承（新增）：
   a. 读父级 mcp.json 的 servers（合并所有父级，后者覆盖前者）
   b. 读子级 own servers（剥离继承块 + 剔除 _optedOutMcpServers）
   c. subtractMcpServers(父级, 子级own) → 应继承的
   d. removeInheritedMcpFromFile(mcpPath)  // 删旧块
   e. writeInheritedMcp(mcpPath, inherited) // 写新块
   f. 回写 _originallyOwnMcpServers / _optedOutMcpServers 到 settings.json
3. 扩展继承（现有）
```

**防御（复用 settings 侧教训）**：
- 父级目录无法解析 → 跳过本次 MCP 对账，保留现有继承块（不删不写）
- 声明了父级却算不出任何 server → 若文件有僵尸标记块则清理自愈，否则跳过
- 写入前 `isMcpDocument` 校验，失败拒绝写入（1.8.4 教训）
- 写入用 `writeManagedFile`（原子写 + 自写跟踪 + 磁盘标记）

### 3.5 监听器

`profileWatchers.ts` 新增 `resolveParentMcpPaths`（仿 `resolveParentExtensionsPaths`），把父级 `mcp.json` 加入监听路径，父级 MCP 变更时触发级联对账。

```ts
export function resolveParentMcpPaths(
  parentProfileNames: readonly string[],
  profiles: Readonly<Record<string, string>>,
): string[] {
  return parentProfileNames
    .map((name) => profiles[name])
    .filter((dir): dir is string => !!dir)
    .map((dir) => path.join(dir, "mcp.json"));
}
```

### 3.6 配置开关

`package.json` 新增配置项：

```jsonc
"inheritProfile.inheritMcp": {
  "type": "boolean",
  "default": true,
  "description": "Whether to inherit MCP servers from parent profiles."
}
```

在 `applyInheritedSettings` / `syncProfileByName` 中读取，`false` 时跳过 MCP 继承步骤。

### 3.7 与云同步的交互（`mcp同步.md` 已提示）

- 继承写入子 profile 的 `mcp.json` 后，VS Code 云同步会照常把继承结果同步走（无法区分手动配的 vs 继承来的）
- 元数据台账加入 `setKeysForSync` 跨设备备份
- 同一 server 在不同机器配置不同（如 `command` 路径不同）时，云同步 + 继承叠加可能覆盖，属于已知边界

---

## 四、测试计划

### 4.1 单测（`src/test/unit/mcpInheritance.test.ts`）

- `readMcpServers`：文件不存在 → {}；损坏 → {}；正常解析 servers map
- `subtractMcpServers`：父级有子级无 → 继承；子级有同名 → 不继承；子级有父级无 → 保留
- `stripInheritedMcpBlocks`：剥离继承块；无标记 → 原样；孤儿标记 → 告警
- `buildInheritedMcpBlock`：格式正确、缩进正确
- `isMcpDocument`：合法/非法/双顶层闭合

### 4.2 集成测试（`src/test/integration/`）

- 父级配 MCP → 子级 reconcile 后继承
- 子级显式定义同名 server → 父级不覆盖
- 多父级同名 → 后者覆盖前者
- 父级删除 server → 子级继承块清理
- 配置 `inheritMcp: false` → 跳过

---

## 五、实现清单（Checklist）

- [x] 新增 `src/mcpInheritance.ts`（核心函数）
- [x] `src/profiles.ts`：`applyInheritedSettings` / `syncProfileByName` 接入 MCP 步骤
- [x] `resolveParentMcpPaths`（放在 `mcpInheritance.ts`）
- [x] `src/profileWatchers.ts`：父级 mcp.json 加入监听
- [x] `src/extension.ts`：`INHERIT_PROFILE_SYNC_KEYS` 加 `_optedOutMcpServers`
- [x] `package.json`：新增 `inheritProfile.inheritMcp` 配置项
- [x] 单测 `src/test/unit/mcpInheritance.test.ts`（26 个）
- [x] 集成测试（2 个）
- [x] 更新 `结构.instructions.md`（文件树 + 函数表）
- [x] 更新 `mcp同步.md`（三、MCP 继承 从"待实现"改为"已实现"）
- [x] 更新 `Dependencies of the plugin.instructions.md`（一.5 mcp.json 从"功能缺口"改为"已纳入继承"）
- [x] 更新 `vscode-dependency-check.instructions.md`（注意事项中 mcp.json 缺口说明）

---

## 五之二、实现中发现的 Bug（2026-10-23 集成测试实测）

> 以下 bug 均在实现后通过单测/集成测试暴露并修复，记录以备回归。

| # | 严重度 | 问题 | 根因 | 修复 |
|---|:---:|------|------|------|
| 1 | 🔴 高 | `servers` 闭合 `}` 顶格、缩进丢失 | `insertBeforeClose` 返回末尾带 `\n`，直接拼 `}` 导致缩进丢失 | `insertMcpBlockBeforeClose` 用 `getLineIndent` 补回 `servers` 键层级缩进 |
| 2 | 🔴 高 | 剥离继承块后 `servers` 内残留尾逗号 | `stripInheritedSettingsBlocks` 为 settings 顶层设计，不清理对象内尾逗号 | 新增 `removeTrailingCommaBeforeServersClose` |
| 3 | 🟡 中 | `_originallyOwnMcpServers` 只写不读（死数据） | 策略 A 下"子级 own 永不覆盖"，无需记录 own 列表 | 移除该台账写入，仅保留 `_optedOutMcpServers` |
| 4 | 🔴 高 | opt-out 的 server 被父级重新继承（opt-out 完全失效） | `readOwnMcpServers` 剔除 optedOut 后，`subtractMcpServers` 认为"子级没有"→ 重新继承 | 把 optedOut 名字并入 own 集合参与差集计算（`ownOrOptedOut`） |
| 5 | 🔴 高 | 父级只配 MCP、无可继承 settings 时，MCP 继承被整体跳过 | `applyInheritedSettings` 的"继承设置为空"分支提前 `return`，MCP 步骤在其后 | 把 MCP 继承移到该提前 return **之前** |
| 6 | 🔴 高 | "移除继承"命令不清理 MCP 继承块 | `removeCurrentProfileInheritedSettings` 的扩展清理块在 extensions.json 不可读时提前 `return`，MCP 清理在其后 | 把 MCP 清理移到扩展清理**之前** |
| 7 | 🟡 中 | 损坏文件（双顶层闭合）仍被插入继承块 | `insertMcpBlockBeforeClose` 未校验输入 | 开头加 `isMcpDocument(raw)` 校验，失败返回 `null` |

**教训**：
- 复用 settings 的标记/剥离逻辑时，必须验证**对象内嵌套块**场景（settings 是顶层块，MCP 是 `servers` 内块）
- 新增继承资源时，检查所有**提前 return 分支**——`applyInheritedSettings` 和 `removeCurrentProfileInheritedSettings` 都有"异常时提前返回"的防御，新步骤若放在其后会被静默跳过
- opt-out 语义：**"用户主动跳过"必须视为"子级已有"**，否则差集逻辑会把它重新继承回来

---

## 六、相关文档

- `mcp同步.md`（项目根）— MCP 配置存储与云同步机制
- `Dependencies of the plugin.instructions.md`（`.copilot/instructions/`）— 一.5 mcp.json（🔴 高脆弱度，功能缺口）
- `vscode开发经验.instructions.md`（`.copilot/instructions/`）— 二、VS Code MCP（配置格式 + 排障）