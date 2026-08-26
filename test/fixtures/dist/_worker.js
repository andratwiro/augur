// A stub standing in for the emitted deploy entry, so scripts/wrangler-preflight.mjs can
// exercise its .assetsignore rule against a fixture that does not need a build first.
export default { fetch: () => new Response("fixture") };
