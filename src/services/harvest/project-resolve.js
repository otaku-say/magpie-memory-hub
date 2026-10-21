/**
 * 模块职责: 基于工作目录 (cwd) 与配置推导生效的项目命名空间 (ARCH-3)
 * 依赖: 无外部依赖
 * 被依赖: src/services/harvest/*, gateway_harvest.hooks.js
 */

/**
 * ARCH-3: 根据网关上下文注入的 cwd 智能推导生效的项目名 (project)。
 * 核心契约：
 * 1. 仅当配置显式开启 auto 模式 (options.project === "auto") 时生效；
 * 2. 规范化路径分隔符（Windows 反斜杠转正斜杠，去除尾随斜杠）；
 * 3. 提取末级基名（basename）；
 * 4. 排除系统与开发环境通用无区分度根目录（如 root, home, users, tmp, var, workspace, work, src, app, desktop, documents, downloads）；
 * 5. 校验名称长度（>= 2）与合法标识符字符（/^[a-zA-Z0-9._-]+$/）；
 * 6. 截断至最长 64 字符（契合 VARCHAR 64 限制）。
 */
export function deriveProjectFromCwd(cwd, configuredProject) {
  // 容错兼容：若调用方反转传参 (例如 deriveProjectFromCwd("auto", "/path/to/project"))
  if (cwd === "auto" && typeof configuredProject === "string" && (configuredProject.includes("/") || configuredProject.includes("\\"))) {
    const tmp = cwd;
    cwd = configuredProject;
    configuredProject = tmp;
  }
  const explicit = String(configuredProject || "").trim();
  if (explicit !== "auto") {
    return explicit || "global";
  }
  if (!cwd || typeof cwd !== "string") {
    return "global";
  }
  const norm = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm.split("/").filter(Boolean).pop() || "";
  const GENERIC_DIRS = new Set([
    "root", "home", "users", "tmp", "var", "workspace", "work",
    "src", "app", "desktop", "documents", "downloads"
  ]);
  if (!base || base.length < 2 || GENERIC_DIRS.has(base.toLowerCase()) || !/^[a-zA-Z0-9._-]+$/.test(base)) {
    return "global";
  }
  return base.slice(0, 64);
}

export function deriveProject(configuredProject, cwd) {
  return deriveProjectFromCwd(cwd, configuredProject);
}
