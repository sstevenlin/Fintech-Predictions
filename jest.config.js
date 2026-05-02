/** @type {import("jest").Config} **/
module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.(t|j)sx?$": "ts-jest",
  },
  transformIgnorePatterns: [
    "/node_modules/(?!@polymarket/.*)"
  ],
  testPathPattern: "\\.(test|spec)\\.(ts|js)$",
};
