// Library root. Import from here when using autobahn-cli as a dependency.
// The client lives in the workspace package packages/client, bundled into this package.
export * from "@maschinenlesbar.org/autobahn-client";
// The version is the CLI's (apps/cli/package.json): the client has none of its own.
export { VERSION } from "./cli/version.js";
