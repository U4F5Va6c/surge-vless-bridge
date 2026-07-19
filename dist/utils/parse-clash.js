"use strict";
/**
 * Minimal, dependency-free parser for the `proxies:` section of a Clash /
 * mihomo (Clash.Meta) YAML subscription.
 *
 * Panels such as xboard/v2board emit every proxy as a single-line *flow map*:
 *
 *   proxies:
 *     - { name: 'US1', type: anytls, server: a.b.c, port: 443, alpn: [h2, http/1.1], reality-opts: { public-key: xxx } }
 *
 * We only need those flow-map lines, so instead of pulling in a full YAML
 * dependency we tokenize the inline map ourselves. Keeping the package
 * dependency-free means it can be copied to another machine and run straight
 * from `dist/` without `npm install`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseClashProxies = exports.looksLikeClashYaml = void 0;
/** Split a flow-collection body on top-level commas, ignoring commas nested
 * inside quotes, `[...]` or `{...}`. */
const splitTopLevel = (body) => {
    const parts = [];
    let depth = 0;
    let quote = null;
    let current = '';
    for (let i = 0; i < body.length; i += 1) {
        const ch = body[i];
        if (quote) {
            current += ch;
            if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === '[' || ch === '{') {
            depth += 1;
        }
        else if (ch === ']' || ch === '}') {
            depth -= 1;
        }
        if (ch === ',' && depth === 0) {
            parts.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim() !== '') {
        parts.push(current);
    }
    return parts;
};
const unquote = (value) => {
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            const inner = trimmed.slice(1, -1);
            // YAML single-quote escaping doubles the quote character.
            return first === "'" ? inner.replace(/''/g, "'") : inner;
        }
    }
    return trimmed;
};
/** Parse a single YAML flow scalar / collection value. */
const parseScalar = (raw) => {
    const value = raw.trim();
    if (value.startsWith('[') && value.endsWith(']')) {
        const inner = value.slice(1, -1).trim();
        if (inner === '') {
            return [];
        }
        return splitTopLevel(inner).map((item) => parseScalar(item));
    }
    if (value.startsWith('{') && value.endsWith('}')) {
        return parseFlowMap(value.slice(1, -1));
    }
    if (value.startsWith('"') || value.startsWith("'")) {
        return unquote(value);
    }
    if (value === 'true')
        return true;
    if (value === 'false')
        return false;
    if (value === 'null' || value === '~' || value === '')
        return null;
    // Only treat as a number when it round-trips exactly; keeps things like
    // ports numeric while leaving version-ish / id-ish strings untouched.
    if (/^-?\d+(\.\d+)?$/.test(value)) {
        const num = Number(value);
        if (String(num) === value) {
            return num;
        }
    }
    return value;
};
/** Parse the body (without the surrounding braces) of a flow map. */
const parseFlowMap = (body) => {
    const result = {};
    for (const part of splitTopLevel(body)) {
        const trimmed = part.trim();
        if (trimmed === '') {
            continue;
        }
        // Split on the first ": " (or trailing ":") that is at top level.
        const idx = findKeySeparator(trimmed);
        if (idx === -1) {
            continue;
        }
        const key = unquote(trimmed.slice(0, idx));
        const value = trimmed.slice(idx + 1);
        result[key] = parseScalar(value);
    }
    return result;
};
/** Locate the `:` that separates a flow-map key from its value, skipping any
 * inside quotes/brackets. */
const findKeySeparator = (text) => {
    let depth = 0;
    let quote = null;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (quote) {
            if (ch === quote)
                quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '[' || ch === '{')
            depth += 1;
        else if (ch === ']' || ch === '}')
            depth -= 1;
        else if (ch === ':' && depth === 0) {
            // Require a following space or end-of-string so `http/1.1` style values
            // are not mistaken for a key separator.
            if (i + 1 >= text.length || text[i + 1] === ' ') {
                return i;
            }
        }
    }
    return -1;
};
/** Return true when the text looks like a Clash/mihomo YAML config. */
const looksLikeClashYaml = (text) => /^\s*proxies\s*:/m.test(text);
exports.looksLikeClashYaml = looksLikeClashYaml;
/**
 * Extract every proxy from the `proxies:` section of a Clash YAML document.
 * Only single-line flow-map entries (`- { ... }`) are understood, which is the
 * format every mainstream panel emits.
 */
const parseClashProxies = (yamlText) => {
    const lines = yamlText.split('\n');
    const proxies = [];
    let inProxies = false;
    for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        if (!inProxies) {
            if (/^\s*proxies\s*:\s*$/.test(line)) {
                inProxies = true;
            }
            continue;
        }
        // A new top-level key (no indentation, ends the proxies block).
        if (/^\S/.test(line) && !/^\s*-/.test(line)) {
            break;
        }
        const match = line.match(/^\s*-\s*(\{.*\})\s*$/);
        if (!match) {
            continue;
        }
        const proxy = parseScalar(match[1]);
        if (proxy && typeof proxy === 'object' && proxy.name) {
            proxies.push(proxy);
        }
    }
    return proxies;
};
exports.parseClashProxies = parseClashProxies;
//# sourceMappingURL=parse-clash.js.map