import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  buildInheritedMcpBlock,
  hasInheritedMcpMarkers,
  insertMcpBlockBeforeClose,
  isMcpDocument,
  readMcpServers,
  readOwnMcpServers,
  stripInheritedMcpBlocks,
  subtractMcpServers,
  resolveParentMcpPaths,
} from "../../mcpInheritance";
import {
  INHERITED_SETTINGS_START_MARKER,
  INHERITED_SETTINGS_END_MARKER,
} from "../../profileSettings";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "inherit-profile-mcp-"));
}

/** 构造一个带继承块的 mcp.json 文本。 */
function mcpWithBlock(ownServers: string, inheritedServers: string): string {
  return (
    "{\n" +
    '  "servers": {\n' +
    (ownServers ? ownServers + ",\n" : "") +
    "    " +
    INHERITED_SETTINGS_START_MARKER +
    "\n" +
    inheritedServers +
    "\n" +
    "    " +
    INHERITED_SETTINGS_END_MARKER +
    "\n" +
    "  }\n" +
    "}\n"
  );
}

suite("mcpInheritance", () => {
  // -------------------------------------------------------------------------
  // subtractMcpServers — 冲突策略 A（子级整体覆盖）
  // -------------------------------------------------------------------------

  test("subtractMcpServers: 父级有、子级没有 → 继承", () => {
    const parent = {
      "git-mcp": { command: "npx", args: ["-y", "@git/mcp"] },
      "senseaudio": { command: "uvx", args: ["senseaudio"] },
    };
    const own = {
      "ida-pro-mcp": { command: "uvx", args: ["ida-pro-mcp"] },
    };
    const result = subtractMcpServers(parent, own);
    assert.deepStrictEqual(Object.keys(result).sort(), ["git-mcp", "senseaudio"]);
  });

  test("subtractMcpServers: 子级有同名 → 不继承（子级赢）", () => {
    const parent = {
      "firefox-devtools": { command: "npx", args: ["-y", "@mozilla/firefox-devtools-mcp"] },
    };
    const own = {
      "firefox-devtools": { command: "npx", args: ["-y", "@mozilla/firefox-devtools-mcp", "--marionette-port", "2828"] },
    };
    const result = subtractMcpServers(parent, own);
    assert.deepStrictEqual(result, {}); // 同名 → 不继承
  });

  test("subtractMcpServers: 子级有、父级没有 → 保留（不清理）", () => {
    const parent = {
      "git-mcp": { command: "npx", args: ["-y", "@git/mcp"] },
    };
    const own = {
      "ida-pro-mcp": { command: "uvx", args: ["ida-pro-mcp"] },
    };
    const result = subtractMcpServers(parent, own);
    // 只返回应继承的（父级有、子级没有的），子级 own 不在结果里（保留在文件里）
    assert.deepStrictEqual(result, { "git-mcp": { command: "npx", args: ["-y", "@git/mcp"] } });
  });

  test("subtractMcpServers: 多父级同名 → 后者覆盖前者（调用方已合并）", () => {
    // 模拟两个父级合并后的结果（后者覆盖前者）
    const parent = {
      "firefox-devtools": { command: "npx", args: ["--marionette-port", "2828", "--tool-preset", "developer"] },
    };
    const own = {};
    const result = subtractMcpServers(parent, own);
    assert.deepStrictEqual(result, parent);
  });

  // -------------------------------------------------------------------------
  // stripInheritedMcpBlocks
  // -------------------------------------------------------------------------

  test("stripInheritedMcpBlocks 剥离单个继承块", () => {
    const raw = mcpWithBlock(
      '"ida-pro-mcp": { "command": "uvx", "args": ["ida-pro-mcp"] }',
      '"git-mcp": { "command": "npx", "args": ["-y", "@git/mcp"] }',
    );
    const { cleaned, removedCount } = stripInheritedMcpBlocks(raw);
    assert.strictEqual(removedCount, 1);
    assert.ok(!cleaned.includes(INHERITED_SETTINGS_START_MARKER));
    assert.ok(!cleaned.includes(INHERITED_SETTINGS_END_MARKER));
    assert.ok(cleaned.includes("ida-pro-mcp")); // own 保留
    assert.ok(!cleaned.includes("git-mcp")); // inherited 被剥离
  });

  test("stripInheritedMcpBlocks 无标记 → 原样返回", () => {
    const raw = '{\n  "servers": {\n    "a": { "command": "x" }\n  }\n}\n';
    const { cleaned, removedCount } = stripInheritedMcpBlocks(raw);
    assert.strictEqual(removedCount, 0);
    assert.strictEqual(cleaned, raw);
  });

  test("stripInheritedMcpBlocks 剥离多个堆叠块", () => {
    const raw =
      '{\n  "servers": {\n' +
      "    " + INHERITED_SETTINGS_START_MARKER + "\n" +
      '    "a": { "command": "x" }\n' +
      "    " + INHERITED_SETTINGS_END_MARKER + "\n" +
      "    " + INHERITED_SETTINGS_START_MARKER + "\n" +
      '    "b": { "command": "y" }\n' +
      "    " + INHERITED_SETTINGS_END_MARKER + "\n" +
      "  }\n}\n";
    const { cleaned, removedCount } = stripInheritedMcpBlocks(raw);
    assert.strictEqual(removedCount, 2);
    assert.ok(!cleaned.includes("a"));
    assert.ok(!cleaned.includes("b"));
  });

  // -------------------------------------------------------------------------
  // hasInheritedMcpMarkers
  // -------------------------------------------------------------------------

  test("hasInheritedMcpMarkers 检测到标记", () => {
    const raw = mcpWithBlock("", '"a": { "command": "x" }');
    assert.strictEqual(hasInheritedMcpMarkers(raw), true);
  });

  test("hasInheritedMcpMarkers 无标记返回 false", () => {
    assert.strictEqual(hasInheritedMcpMarkers('{\n  "servers": {}\n}\n'), false);
  });

  // -------------------------------------------------------------------------
  // buildInheritedMcpBlock
  // -------------------------------------------------------------------------

  test("buildInheritedMcpBlock 包含标记和 server 条目", () => {
    const block = buildInheritedMcpBlock(
      { "git-mcp": { command: "npx", args: ["-y", "@git/mcp"] } },
      "    ",
    );
    assert.ok(block.includes(INHERITED_SETTINGS_START_MARKER));
    assert.ok(block.includes(INHERITED_SETTINGS_END_MARKER));
    assert.ok(block.includes('"git-mcp"'));
    assert.ok(block.includes('"command"'));
  });

  test("buildInheritedMcpBlock 空 servers → 只有标记", () => {
    const block = buildInheritedMcpBlock({}, "    ");
    assert.ok(block.includes(INHERITED_SETTINGS_START_MARKER));
    assert.ok(block.includes(INHERITED_SETTINGS_END_MARKER));
  });

  // -------------------------------------------------------------------------
  // isMcpDocument
  // -------------------------------------------------------------------------

  test("isMcpDocument 合法对象 → true", () => {
    assert.strictEqual(isMcpDocument('{\n  "servers": {}\n}\n'), true);
  });

  test("isMcpDocument 数组顶层 → false", () => {
    assert.strictEqual(isMcpDocument('[\n  "a"\n]\n'), false);
  });

  test("isMcpDocument 不平衡 → false", () => {
    assert.strictEqual(isMcpDocument('{\n  "servers": {\n}\n'), false);
  });

  // -------------------------------------------------------------------------
  // insertMcpBlockBeforeClose
  // -------------------------------------------------------------------------

  test("insertMcpBlockBeforeClose 插入到 servers 对象内", () => {
    const raw = '{\n  "servers": {\n    "own": { "command": "x" }\n  }\n}\n';
    const block = buildInheritedMcpBlock(
      { "git-mcp": { command: "npx", args: ["-y", "@git/mcp"] } },
      "    ",
    );
    const merged = insertMcpBlockBeforeClose(raw, block);
    assert.ok(merged !== null);
    assert.ok(merged!.includes("own"));
    assert.ok(merged!.includes("git-mcp"));
    assert.ok(isMcpDocument(merged!));
  });

  test("insertMcpBlockBeforeClose 空文件创建 servers 对象", () => {
    const raw = "{\n}\n";
    const block = buildInheritedMcpBlock(
      { "git-mcp": { command: "npx", args: ["-y", "@git/mcp"] } },
      "    ",
    );
    const merged = insertMcpBlockBeforeClose(raw, block);
    assert.ok(merged !== null);
    assert.ok(merged!.includes('"servers"'));
    assert.ok(merged!.includes("git-mcp"));
    assert.ok(isMcpDocument(merged!));
  });

  test("insertMcpBlockBeforeClose 保持 servers 闭合括号缩进（Bug 1 回归）", () => {
    const raw = '{\n  "servers": {\n    "own": { "command": "x" }\n  }\n}\n';
    const block = buildInheritedMcpBlock({ "git-mcp": { command: "npx" } }, "    ");
    const merged = insertMcpBlockBeforeClose(raw, block)!;
    // servers 的闭合 `}` 必须缩进 2 空格（与 "servers" 键同级），不能顶格
    assert.ok(
      merged.includes("\n  }\n}"),
      `servers 闭合括号缩进错误：\n${merged}`,
    );
    // 顶层只能有一个闭合 `}`
    assert.strictEqual((merged.match(/^}/gm) ?? []).length, 1);
  });

  test("insertMcpBlockBeforeClose 拒绝损坏文件（双顶层闭合）", () => {
    const broken = '{\n  "servers": {\n    "own": { "command": "x" }\n  }\n}\n}\n';
    const block = buildInheritedMcpBlock({ "git-mcp": { command: "npx" } }, "    ");
    assert.strictEqual(insertMcpBlockBeforeClose(broken, block), null);
  });

  test("insertMcpBlockBeforeClose 拒绝不平衡文件", () => {
    const broken = '{\n  "servers": {\n    "own": { "command": "x" }\n';
    const block = buildInheritedMcpBlock({ "git-mcp": { command: "npx" } }, "    ");
    assert.strictEqual(insertMcpBlockBeforeClose(broken, block), null);
  });

  test("stripInheritedMcpBlocks 清理 servers 内尾逗号（Bug 2 回归）", () => {
    const raw =
      '{\n  "servers": {\n    "own": { "command": "x" },\n' +
      "    // --- INHERITED SETTINGS MARKER START --- //\n" +
      '    "git-mcp": { "command": "npx" },\n' +
      "    // --- INHERITED SETTINGS MARKER END --- //\n" +
      "  }\n}\n";
    const { cleaned, removedCount } = stripInheritedMcpBlocks(raw);
    assert.strictEqual(removedCount, 1);
    // 剥离后 own 后面不能残留尾逗号
    assert.ok(
      !/"own":\s*\{[^}]*\}\s*,/.test(cleaned),
      `尾逗号未清理：\n${cleaned}`,
    );
    assert.ok(isMcpDocument(cleaned));
  });

  // -------------------------------------------------------------------------
  // readMcpServers / readOwnMcpServers（真实文件）
  // -------------------------------------------------------------------------

  test("readMcpServers 读取 servers map", async () => {
    const dir = makeTempDir();
    try {
      const mcpPath = path.join(dir, "mcp.json");
      fs.writeFileSync(
        mcpPath,
        '{\n  "servers": {\n    "a": { "command": "x" }\n  }\n}\n',
        "utf8",
      );
      const servers = await readMcpServers(mcpPath);
      assert.deepStrictEqual(servers, { a: { command: "x" } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readMcpServers 文件不存在 → 空 map", async () => {
    const dir = makeTempDir();
    try {
      const servers = await readMcpServers(path.join(dir, "missing.json"));
      assert.deepStrictEqual(servers, {});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readOwnMcpServers 剥离继承块，只返回 own server", async () => {
    const dir = makeTempDir();
    try {
      const mcpPath = path.join(dir, "mcp.json");
      fs.writeFileSync(
        mcpPath,
        mcpWithBlock(
          '"own": { "command": "x" }',
          '"inherited": { "command": "y" }',
        ),
        "utf8",
      );
      const own = await readOwnMcpServers(mcpPath);
      assert.deepStrictEqual(Object.keys(own), ["own"]); // inherited 被剥离
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readOwnMcpServers 文件不存在 → 空 map", async () => {
    const dir = makeTempDir();
    try {
      const own = await readOwnMcpServers(path.join(dir, "missing.json"));
      assert.deepStrictEqual(own, {});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // opt-out 回归（Bug 10）：opt-out 的 server 必须视为"子级已有"，
  // 否则会被父级重新继承回来
  // -------------------------------------------------------------------------

  test("opt-out 的 server 不会被父级重新继承（Bug 10 回归）", () => {
    const parent = {
      "git-mcp": { command: "npx", args: ["-y", "@git/mcp"] },
      "senseaudio": { command: "uvx", args: ["senseaudio"] },
    };
    const own = {}; // 子级文件里没有 git-mcp（用户 opt-out 了）
    const optedOut = ["git-mcp"];

    // 修复前：own 不含 git-mcp → subtract 认为"子级没有" → 重新继承（bug）
    const buggy = subtractMcpServers(parent, own);
    assert.ok("git-mcp" in buggy, "修复前确实会重新继承（复现 bug）");

    // 修复后：把 optedOut 并入 own 集合 → 不再继承
    const ownOrOptedOut: Record<string, any> = { ...own };
    for (const name of optedOut) {
      ownOrOptedOut[name] = true;
    }
    const fixed = subtractMcpServers(parent, ownOrOptedOut);
    assert.ok(!("git-mcp" in fixed), "opt-out 的 server 不应被继承");
    assert.ok("senseaudio" in fixed, "未 opt-out 的 server 仍应继承");
  });

  // -------------------------------------------------------------------------
  // resolveParentMcpPaths
  // -------------------------------------------------------------------------

  test("resolveParentMcpPaths 解析父级 mcp.json 路径", () => {
    const profiles = {
      Base: "C:/users/base",
      Dev: "C:/users/dev",
    };
    const paths = resolveParentMcpPaths(["Base", "Dev"], profiles);
    assert.deepStrictEqual(paths, [
      path.join("C:/users/base", "mcp.json"),
      path.join("C:/users/dev", "mcp.json"),
    ]);
  });

  test("resolveParentMcpPaths 跳过不存在的 profile", () => {
    const profiles = { Base: "C:/users/base" };
    const paths = resolveParentMcpPaths(["Base", "Missing"], profiles);
    assert.deepStrictEqual(paths, [path.join("C:/users/base", "mcp.json")]);
  });
});