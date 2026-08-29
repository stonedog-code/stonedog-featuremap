/**
 * Two projects, because the tiers answer different questions and must be
 * runnable apart: `unit` is hermetic, `integration` reads the real maps on this
 * workstation and skips (loudly) where they are absent.
 */
const shared = {
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
  transform: {
    // NodeNext, matching tsconfig.json. With "bundler" here the suite resolved
    // imports the shipped package cannot -- a green run over a resolution
    // nobody gets at build time.
    "^.+\\.tsx?$": ["ts-jest", { useESM: true, tsconfig: { module: "NodeNext", moduleResolution: "NodeNext" } }],
  },
}

module.exports = {
  projects: [
    { ...shared, displayName: "unit", testMatch: ["<rootDir>/src/**/__tests__/**/*.test.ts"] },
    { ...shared, displayName: "integration", testMatch: ["<rootDir>/test/integration/**/*.test.ts"] },
  ],
}
