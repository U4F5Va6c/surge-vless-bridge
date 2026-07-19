"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const configuration_1 = require("./configuration");
const surge_1 = require("./surge");
const main = async () => {
    const { config } = await (0, configuration_1.loadCliConfig)({ cwd: process.cwd() });
    const result = await (0, surge_1.syncSubscriptionToSurge)(config);
    console.log(`Synced ${result.count} nodes.`);
    console.log(`Backup saved to ${result.backupPath}`);
};
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
});
//# sourceMappingURL=index.js.map