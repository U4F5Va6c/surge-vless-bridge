"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodeSubscription = void 0;
const decodeSubscription = (raw) => Buffer.from(raw, 'base64').toString('utf8');
exports.decodeSubscription = decodeSubscription;
//# sourceMappingURL=decode-subscription.js.map