"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeBinaryFile = exports.writeTextFile = exports.readJsonFile = exports.readTextFile = exports.pathExists = void 0;
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const pathExists = async (path) => {
    try {
        await (0, promises_1.access)(path, node_fs_1.constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
};
exports.pathExists = pathExists;
const readTextFile = async (path) => (0, promises_1.readFile)(path, 'utf8');
exports.readTextFile = readTextFile;
const readJsonFile = async (path) => JSON.parse(await (0, exports.readTextFile)(path));
exports.readJsonFile = readJsonFile;
const writeTextFile = async (path, value) => {
    await (0, promises_1.mkdir)((0, node_path_1.dirname)(path), { recursive: true });
    await (0, promises_1.writeFile)(path, value, 'utf8');
};
exports.writeTextFile = writeTextFile;
const writeBinaryFile = async (path, value) => {
    await (0, promises_1.writeFile)(path, value);
};
exports.writeBinaryFile = writeBinaryFile;
//# sourceMappingURL=fs.js.map