/**
 * local_state.js —— 插件在宿主本地的持久状态。
 *
 * 为什么需要它：
 *   宿主（Bun）**没有写 options 的 API**（已实测：input.magpie.option/options 是
 *   provider 鉴权用的布尔开关，与插件配置无关；第二个参数 options 只读）。
 *   但宿主有文件系统，而官方镜像里 HOME=/config/home 位于唯一的持久卷 /config 内，
 *   所以写在这里的内容**容器重建也不丢**。
 *
 * 目前存两类东西：
 *   1. secrets[数据库名] —— 由 create_database 自动生成、**只在创建时返回一次**的
 *      Secret Key。捕获后存在这里，用户就不必再手动填。
 *   2. actions —— 设置页信标的执行记录（由 page_actions.js 使用）。
 *
 * 安全：文件权限 0600；只写不含其它敏感信息；绝不打印到日志。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STATE_DIRNAME = ".magpie-memory-hub";
export const STATE_FILENAME = "state.json";

/** 状态文件路径；拿不到 HOME 时返回 null（调用方需容错）。 */
export function statePath() {
  try {
    return path.join(os.homedir(), STATE_DIRNAME, STATE_FILENAME);
  } catch (e) {
    return null;
  }
}

/** 读状态。任何异常都退化为空状态，绝不让调用方崩。 */
export function readState() {
  const p = statePath();
  if (!p) return { secrets: {}, actions: {}, gateway_harvest: {}, _ok: false };
  try {
    if (!fs.existsSync(p)) return { secrets: {}, actions: {}, gateway_harvest: {}, _ok: true, _missing: true };
    const o = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!o || typeof o !== "object") return { secrets: {}, actions: {}, gateway_harvest: {}, _ok: true };
    return {
      secrets: o.secrets && typeof o.secrets === "object" ? o.secrets : {},
      actions: o.actions && typeof o.actions === "object" ? o.actions : {},
      gateway_harvest: o.gateway_harvest && typeof o.gateway_harvest === "object" ? o.gateway_harvest : {},
      _ok: true,
    };
  } catch (e) {
    return { secrets: {}, actions: {}, gateway_harvest: {}, _ok: false, _err: String(e && e.message || e) };
  }
}

/** 原子写状态（先写临时文件再 rename）。返回是否成功。 */
export function writeState(state) {
  const p = statePath();
  if (!p) return false;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const out = Object.assign({}, state, {
      secrets: state.secrets && typeof state.secrets === "object" ? state.secrets : {},
      actions: state.actions && typeof state.actions === "object" ? state.actions : {},
      gateway_harvest: state.gateway_harvest && typeof state.gateway_harvest === "object" ? state.gateway_harvest : {},
    });
    delete out._ok;
    delete out._missing;
    delete out._err;
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, p);
    try { fs.chmodSync(p, 0o600); } catch (e) { /* 某些文件系统不支持，忽略 */ }
    return true;
  } catch (e) {
    return false;
  }
}

/** 读回 gateway_harvest 增量状态 */
export function lookupGatewayHarvest() {
  const st = readState();
  return st.gateway_harvest || {};
}

/** 保存 gateway_harvest 增量状态 */
export function rememberGatewayHarvest(harvestState) {
  const st = readState();
  st.gateway_harvest = Object.assign({}, st.gateway_harvest || {}, harvestState || {});
  return writeState(st);
}

/** 记住某个数据库的 Secret Key —— 只在内存里传一次，落盘即刻。 */
export function rememberSecret(database, secret) {
  if (!database || !secret) return false;
  const st = readState();
  st.secrets[database] = { v: String(secret), at: Date.now() };
  return writeState(st);
}

/** 取回某个数据库的 Secret Key；没有则返回 ""。 */
export function lookupSecret(database) {
  if (!database) return "";
  const st = readState();
  const e = st.secrets[database];
  if (!e) return "";
  return typeof e === "string" ? e : (e && e.v) || "";
}

/** 记录设置页信标的执行结果（供 page_actions.js 用）。 */
export function rememberAction(id, info) {
  const st = readState();
  st.actions[id] = Object.assign({ at: Date.now() }, info || {});
  // 只保留最近 30 条
  const keys = Object.keys(st.actions);
  if (keys.length > 30) {
    keys.sort((a, b) => (st.actions[a].at || 0) - (st.actions[b].at || 0));
    for (const k of keys.slice(0, keys.length - 30)) delete st.actions[k];
  }
  return writeState(st);
}

/** 读回某次信标的执行结果。 */
export function lookupAction(id) {
  const st = readState();
  return st.actions[id] || null;
}

/** 记住本次真正使用的数据库实例名（NCB 可能自动加账号前缀或后缀）。 */
export function rememberDatabase(name) {
  if (!name) return false;
  const st = readState();
  st.current = String(name);
  return writeState(st);
}

/** 取回上次真正使用的数据库实例名。 */
export function lookupDatabase() {
  const st = readState();
  return st.current || "";
}

/** 已记录 Secret Key 的数据库名清单（不含任何密钥值）。 */
export function knownDatabases() {
  const st = readState();
  return Object.keys(st.secrets);
}
