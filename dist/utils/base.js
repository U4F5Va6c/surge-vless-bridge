"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toBoolean = void 0;
const toBoolean = (value) => {
    if (!value) {
        return false;
    }
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};
exports.toBoolean = toBoolean;
//# sourceMappingURL=base.js.map