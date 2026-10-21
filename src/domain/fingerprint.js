/**
 * 模块职责：文本指纹生成与语义规范化
 * 依赖：无
 * 被依赖：src/tools/**, src/services/**, tools.js
 */

/** 语义规范化：小写、去标点与多余空白，使同一事实的不同写法落到同一指纹 */
export function normalize(text) {
  return String(text == null ? "" : text)
    .toLowerCase()
    .replace(/[\s]+/g, "")
    .replace(/[`'"“”‘’.,;:!?()\[\]{}<>|\\/+=*&^%$#@~·—－_,，。；：！？（）【】《》「」]/g, "");
}


/** FNV-1a 双轮 64bit → 32 位十六进制指纹（同步、确定性） */
export function fingerprint(text) {
  const s = normalize(text);
  const fnv = (seed) => {
    let h = BigInt(seed);
    const prime = 1099511628211n;
    const mask = (1n << 64n) - 1n;
    for (let i = 0; i < s.length; i++) {
      h ^= BigInt(s.charCodeAt(i));
      h = (h * prime) & mask;
    }
    return h.toString(16).padStart(16, "0");
  };
  return (fnv(14695981039346656037n) + fnv(1099511628211n)).slice(0, 32);
}
