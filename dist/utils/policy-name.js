"use strict";
/** Shared helpers for turning raw subscription node names into safe, unique
 * Surge policy names. Used by both the vless (sing-box external) path and the
 * anytls (native Surge) path so their names never collide. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.uniquePolicyName = exports.sanitizePolicyName = void 0;
const POLICY_REGEX_FILTER = /^((?!Remain|Expired|官网|如需|套餐|去除|剩余|距离|Reset|重置|流量).)+$/;
/** Strip characters Surge cannot have in a policy name and drop obvious
 * non-node "info" entries (traffic / expiry lines). */
const sanitizePolicyName = (tag, index) => {
    const candidate = POLICY_REGEX_FILTER.test(tag) ? tag : `node${index + 1}`;
    const sanitized = candidate
        .replace(/[,\n\r=]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return sanitized || `node${index + 1}`;
};
exports.sanitizePolicyName = sanitizePolicyName;
/** Assigns a unique, sanitized name, remembering used names in `seen` so that
 * duplicate names (common when merging multiple subscriptions) get a numeric
 * suffix instead of clobbering each other in Surge. */
const uniquePolicyName = (tag, index, seen) => {
    const base = (0, exports.sanitizePolicyName)(tag, index);
    let name = base;
    let counter = 2;
    while (seen.has(name)) {
        name = `${base} ${counter}`;
        counter += 1;
    }
    seen.add(name);
    return name;
};
exports.uniquePolicyName = uniquePolicyName;
//# sourceMappingURL=policy-name.js.map