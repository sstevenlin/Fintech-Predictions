const { createDefaultPreset } = require("ts-jest");

const tsJestTransformCfg = createDefaultPreset().transform;

/** @type {import("jest").Config} **/
module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.(t|j)sx?$": "ts-jest", // Tell ts-jest to also try parsing JS components from excluded modules
  },
  transformIgnorePatterns: [
    // Ignore node_modules transpilations EXACTLY EXCEPT for polymarket
    "/node_modules/(?!@polymarket/.*)"
  ],
};