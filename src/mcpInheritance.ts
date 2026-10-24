/**
 * =============================================================================
 * inherit-profile-plus — MCP 服务器继承核心逻辑
 * =============================================================================
 *
 * 用途（Purpose）:
 *   实现 VS Code Profile 之间的 MCP 服务器（mcp.json）继承逻辑。
 *   子 Profile 可以声明一个或多个父 Profile，自动继承其 MCP 服务器配置。
 *
 * 工作机制（How it works）:
 *   1. 读取父 Profile 和子 Profile 的 mcp.json 的 servers map
 *   2. 用 subtractMcpServers() 剔除子中已有的 server（子覆盖父）
 *   3. 将缺失的父 server 写入 inherited 标记块（带起始/结束标记）
 *
 * 冲突策略（Conflict strategy A — 子级整体覆盖）:
 *   - 父级有、子级 own 没有的 server → 整体继承
 *   - 子级 own 有同名 server → 整个 server 不继承，子级配置完全生效（父级不覆盖）
 *   - 子级 own 有、父级没有的 server → 保留子级 own（不清理）
 *   - 多父级同名 server → 后者覆盖前者（按 parents 数组顺序）
 *
 * 依赖关系（Dependencies）:
 *   - import { ... } from "./profileSettings" — 标记常量 + JSONC 工具函数
 *   - fs/promises — 文件读写
 *
 * 对外提供的 API（Exports）:
 *   - McpServerConfig (interface)                      MCP server 配置类型
 *   - readMcpServers(mcpPath)                          [async] 读取 mcp.json 的 servers map
 *   - subtractMcpServers(parent, own)                  差集：父级有、子级 own 没有的 server
 *   - stripInheritedMcpBlocks(raw)                     剥离继承块
 *   - buildInheritedMcpBlock(servers, tab)             构建继承块
 *   - hasInheritedMcpMarkers(raw)                      判断是否有继承标记
 *   - isMcpDocument(raw)                               校验 mcp.json 是否为合法对象
 *   - resolveParentMcpPaths(names, profiles)           解析父级 mcp.json 路径
 */

import * as path from "path";
import * as fs from "fs/promises";
import { parse as parseJSONC, parseTree, findNodeAtLocation } from "jsonc-parser";
import {
  INHERITED_SETTINGS_START_MARKER,
  INHERITED_SETTINGS_END_MARKER,
  WARNING_COMMENT,
  WARNING_EXPLAIN,
  findTabValue,
  insertBeforeClose,
  isBalancedJsonc,
  splitRawSettingsByClosingBrace,
  stripInheritedSettingsBlocks,
} from "./profileSettings";

/**
 * MCP server 配置类型（对应 mcp.json 中 servers 下每个 server 的配置）。
 * 保留未知字段，避免丢失 VS Code 未来新增的字段。
 */
export interface McpServerConfig {
  type?: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  [key: string]: any; // 保留未知字段
}

/**
 * 读取 mcp.json 的 servers map。
 * 容错：文件不存在 → {}；损坏 → {}（调用方据此跳过，不当作空配置清空）。
 *
 * @param mcpPath mcp.json 的绝对路径。
 * @returns servers map（server 名 → 配置）。
 */
export async function readMcpServers(
  mcpPath: string,
): Promise<Record<string, McpServerConfig>> {
  try {
    const raw = await fs.readFile(mcpPath, "utf8");
    if (!isBalancedJsonc(raw)) {
      console.warn(
        `[mcp-inheritance] \`${mcpPath}\` is structurally unbalanced. ` +
          `Returning empty servers map so callers can skip it.`,
      );
      return {};
    }
    const parsed = parseJSONC(raw) as Record<string, any>;
    const servers = parsed?.servers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      return {};
    }
    return servers as Record<string, McpServerConfig>;
  } catch (error) {
    // 文件不存在（ENOENT）或不可读 → 空 map
    return {};
  }
}

/**
 * 差集：父级有、子级 own 没有的 server。
 * 子级显式定义同名 server → 不继承（子级赢）。
 *
 * @param parentServers 父级合并后的 servers map。
 * @param ownServers 子级 own 的 servers map（已剥离继承块）。
 * @returns 应继承的 servers map（父级有、子级 own 没有的）。
 */
export function subtractMcpServers(
  parentServers: Record<string, McpServerConfig>,
  ownServers: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(parentServers)) {
    if (!(name in ownServers)) {
      result[name] = config;
    }
  }
  return result;
}

/**
 * 判断原始 mcp.json 文本中是否包含继承标记块（START 或 END marker）。
 */
export function hasInheritedMcpMarkers(raw: string): boolean {
  return (
    raw.includes(INHERITED_SETTINGS_START_MARKER) ||
    raw.includes(INHERITED_SETTINGS_END_MARKER)
  );
}

/**
 * 剥离 mcp.json 中的继承标记块。
 *
 * 复用 settings 的标记机制（INHERITED_SETTINGS_START_MARKER / END_MARKER），
 * 因此直接复用 {@link stripInheritedSettingsBlocks} 的清理逻辑——它按标记
 * 剥离，不关心块内是设置还是 MCP server。
 *
 * @param raw 原始 mcp.json 文本。
 * @returns 剥离后的文本 + 移除的块数。
 */
export function stripInheritedMcpBlocks(raw: string): {
  cleaned: string;
  removedCount: number;
} {
  // 复用 profileSettings 的剥离逻辑（标记机制一致）
  const { cleaned, removedCount } = stripInheritedSettingsBlocks(raw);
  if (removedCount === 0) {
    return { cleaned, removedCount };
  }
  // ⚠️ stripInheritedSettingsBlocks 是给 settings 顶层设计的，剥离 servers
  // 对象内的块后会留下尾逗号（`"own": {...},` 后直接跟 `}`）。JSONC 虽容忍，
  // 但 VS Code 写回时可能出问题，这里清理 servers 对象内的尾逗号。
  return { cleaned: removeTrailingCommaBeforeServersClose(cleaned), removedCount };
}

/**
 * 移除 `servers` 对象闭合 `}` 前的尾逗号。
 *
 * 剥离继承块后，`servers` 内最后一个 own server 后面可能残留 `,`。
 * 用 jsonc-parser 定位 servers 节点，检查其闭合 `}` 前最后一个有意义字符
 * 是否为 `,`，是则删除。
 *
 * @param raw 已剥离继承块的 mcp.json 文本。
 * @returns 清理尾逗号后的文本；无法定位时原样返回。
 */
function removeTrailingCommaBeforeServersClose(raw: string): string {
  const tree = parseTree(raw);
  if (!tree) {
    return raw;
  }
  const serversNode = findNodeAtLocation(tree, ["servers"]);
  if (!serversNode || serversNode.type !== "object") {
    return raw;
  }
  const closeIndex = serversNode.offset + serversNode.length - 1;
  // 从闭合 `}` 往前找最后一个非空白字符
  let i = closeIndex - 1;
  while (i >= 0 && /\s/.test(raw[i])) {
    i--;
  }
  if (i >= 0 && raw[i] === ",") {
    return raw.slice(0, i) + raw.slice(i + 1);
  }
  return raw;
}

/**
 * 构建 MCP 继承块（带起始/结束标记）。
 *
 * @param servers 要写入继承块的 servers map。
 * @param tab 缩进序列（空格/制表符）。
 * @returns 原始 MCP 继承块文本。
 */
export function buildInheritedMcpBlock(
  servers: Record<string, McpServerConfig>,
  tab: string,
): string {
  const entries = Object.entries(servers)
    .map(
      ([name, config]) =>
        `${tab}${JSON.stringify(name)}: ${JSON.stringify(config)}`,
    )
    .join(",\n");

  return (
    tab +
    INHERITED_SETTINGS_START_MARKER +
    "\n" +
    tab +
    WARNING_COMMENT +
    "\n" +
    tab +
    WARNING_EXPLAIN +
    "\n" +
    entries +
    (entries ? ",\n" : "") +
    tab +
    INHERITED_SETTINGS_END_MARKER +
    "\n"
  );
}

/**
 * 校验 mcp.json 是否为合法的对象文档（顶层必须是 `{`）。
 * 复用 isSettingsDocument 的语义（mcp.json 顶层是对象）。
 *
 * @param raw 原始 mcp.json 文本。
 * @returns `true` 如果是合法的对象文档。
 */
export function isMcpDocument(raw: string): boolean {
  if (!isBalancedJsonc(raw)) return false;
  const firstNonWhitespace = raw.search(/\S/);
  return firstNonWhitespace !== -1 && raw[firstNonWhitespace] === "{";
}

/**
 * 解析父级 mcp.json 路径，保留顺序，静默跳过不在 profiles 中的名字。
 *
 * @param parentProfileNames 父 Profile 名列表（inheritProfile.parents）。
 * @param profiles Profile 名 → 目录映射。
 * @returns 每个父 Profile 的 mcp.json 绝对路径。
 */
export function resolveParentMcpPaths(
  parentProfileNames: readonly string[],
  profiles: Readonly<Record<string, string>>,
): string[] {
  const mcpPaths: string[] = [];
  for (const name of parentProfileNames) {
    const dir = profiles[name];
    if (dir) {
      mcpPaths.push(path.join(dir, "mcp.json"));
    }
  }
  return mcpPaths;
}

/**
 * 从 mcp.json 剥离继承块后，返回子级 own 的 servers map。
 *
 * ⚠️ 不在此处剔除 optedOut：opt-out 的 server 在差集计算时必须视为"子级已有"
 * （否则会被父级重新继承回来）。调用方应把 optedOut 名字并入 own 集合后再
 * 调用 {@link subtractMcpServers}。
 *
 * @param mcpPath mcp.json 的绝对路径。
 * @returns 子级 own 的 servers map（不含继承块内容）。
 */
export async function readOwnMcpServers(
  mcpPath: string,
): Promise<Record<string, McpServerConfig>> {
  let raw = "";
  try {
    raw = await fs.readFile(mcpPath, "utf8");
  } catch {
    return {}; // 文件不存在 → 无 own server
  }
  const { cleaned } = stripInheritedMcpBlocks(raw);
  const parsed = parseJSONC(cleaned) as Record<string, any>;
  const servers = parsed?.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return {};
  }
  return servers as Record<string, McpServerConfig>;
}

/**
 * 从 mcp.json 剥离继承块，返回剥离后的文本（供写回时用）。
 * 若文件不存在，返回空对象骨架 `{\n}\n`。
 *
 * @param mcpPath mcp.json 的绝对路径。
 * @returns 剥离继承块后的文本。
 */
export async function readRawMcpFile(mcpPath: string): Promise<string> {
  try {
    return await fs.readFile(mcpPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "{\n}\n";
    }
    throw error;
  }
}

/**
 * 将继承块插入 mcp.json 的 servers 对象内。
 *
 * 用 jsonc-parser 的 parseTree 定位 `servers` 节点，在其闭合 `}` 前插入继承块。
 * 若文件没有 servers 对象（空文件 `{\n}\n`），则先创建 servers 对象再插入。
 *
 * @param raw 剥离继承块后的 mcp.json 文本。
 * @param block 要插入的继承块（已带缩进）。
 * @returns 插入后的完整 mcp.json 文本；无法定位时返回 null（调用方拒绝写入）。
 */
export function insertMcpBlockBeforeClose(
  raw: string,
  block: string,
): string | null {
  // 防御：输入本身必须是合法的 mcp.json 对象（顶层 `{`、括号平衡、无双顶层闭合）。
  // 损坏文件绝不在此基础上继续插入，避免把损坏形态固化（1.8.4 教训）。
  if (!isMcpDocument(raw)) {
    return null;
  }
  const tree = parseTree(raw);
  if (!tree) {
    return null; // 无法解析 → 拒绝写入
  }
  const serversNode = findNodeAtLocation(tree, ["servers"]);
  if (!serversNode || serversNode.type !== "object") {
    // 没有 servers 对象 → 需要创建。用 splitRawSettingsByClosingBrace 定位顶层闭合。
    const split = splitRawSettingsByClosingBrace(raw);
    if (!split) {
      return null;
    }
    const [beforeClose, afterClose] = split;
    const tab = findTabValue(raw);
    const serversBlock =
      `${tab}"servers": {\n` +
      block +
      `${tab}}\n`;
    return beforeClose.replace(/\s*$/, "\n") + serversBlock + afterClose;
  }

  // 有 servers 对象 → 在其闭合 `}` 前插入。
  // serversNode.offset 是 `{` 的偏移，serversNode.length 是节点总长（含闭合 `}`）。
  const serversCloseIndex = serversNode.offset + serversNode.length - 1;
  const beforeServersClose = raw.slice(0, serversCloseIndex);
  const afterServersClose = raw.slice(serversCloseIndex);

  // ⚠️ insertBeforeClose 返回的字符串末尾带 `\n`，而 afterServersClose 以 `}`
  // 开头。直接拼接会让 servers 的闭合 `}` 顶格、丢失缩进（虽然 JSONC 仍可解析，
  // 但格式已损坏）。这里给闭合 `}` 补回 servers 键所在层级的缩进。
  const serversIndent = getLineIndent(raw, serversNode.offset);
  const beforeClosePlusBlock = insertBeforeClose(beforeServersClose, block);
  return beforeClosePlusBlock + serversIndent + afterServersClose;
}

/**
 * 获取指定偏移所在行的缩进（行首到第一个非空白字符）。
 * 用于给插入后的闭合括号补回正确缩进。
 *
 * @param raw 原始文本。
 * @param offset 目标偏移（通常是 `{` 的位置）。
 * @returns 该行行首的缩进字符串（无缩进返回空串）。
 */
function getLineIndent(raw: string, offset: number): string {
  const lineStart = raw.lastIndexOf("\n", offset) + 1;
  const line = raw.slice(lineStart, offset);
  const match = line.match(/^[ \t]*/);
  return match ? match[0] : "";
}