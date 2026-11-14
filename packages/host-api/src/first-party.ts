// The published `@norbital-ai/*` set, one list: oss publication derives its package directories from it and fails on a
// public package it does not name; hosts exempt it from the release-age gate; `bolt templates lock` and `env relock`
// write `FIRST_PARTY_BUNFIG` from it. No imports: oss scripts and the realm CLI read this file as source.

/** Every published `@norbital-ai/*` package. */
export const FIRST_PARTY_PACKAGES = [
	'@norbital-ai/app-shell',
	'@norbital-ai/bolt',
	'@norbital-ai/bolt-cli',
	'@norbital-ai/bolt-server',
	'@norbital-ai/host-api',
	'@norbital-ai/providers',
	'@norbital-ai/store',
	'@norbital-ai/ui'
] as const;

/** The `bunfig.toml` of every bun consumer of the set: template repositories, templates, the realm and Colony's fixtures. */
export const FIRST_PARTY_BUNFIG = `# Written by \`bolt templates lock\` / \`env relock\` from @norbital-ai/host-api FIRST_PARTY_PACKAGES; do not edit.
# Third-party releases younger than a day never resolve: a compromised publish has that long to be noticed.
# The platform's own packages are exactly pinned in package.json, so they skip the gate by name.
[install]
# One layout everywhere: every package at its own node_modules root, never a peer linked into another directory's tree.
linker = "hoisted"
minimumReleaseAge = 86400
minimumReleaseAgeExcludes = [${FIRST_PARTY_PACKAGES.map((name) => JSON.stringify(name)).join(', ')}]
`;
