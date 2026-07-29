import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { postgresDb } from '../../host/db.js';
import { consoleNotifications, stubMaps } from '../../host/facilities.js';
import { localFileStorage } from '../../host/file-storage.js';
import { devIdentity, trustedHeaderIdentity } from '../../host/identity.js';
import type { HostDbAdapter, HostIdentityProvider, PodHostConfig } from '../../host/types.js';

/** Config filenames tried in order. `.ts` first: Node strips types natively on the supported range. */
const CONFIG_FILENAMES = ['pod.config.ts', 'pod.config.js', 'pod.config.mjs'] as const;

export type StandaloneIdentityMode = 'trusted-host' | 'dev';

export type HostConfigInput = {
	readonly root: string;
	readonly identityMode: StandaloneIdentityMode;
	readonly databaseUrl: string;
	readonly host: string;
	readonly port: number;
	readonly orgId: string;
	readonly orgName: string;
	readonly adminId: string;
	readonly trustedHostToken: string;
};

export type ResolvedHostConfig = {
	readonly config: PodHostConfig;
	/** Where the configuration came from, for the startup banner. */
	readonly source: string;
	/** Facilities installed with a placeholder implementation that fails at the point of use. */
	readonly stubbed: readonly string[];
};

function isHostConfig(value: unknown): value is PodHostConfig {
	if (typeof value !== 'object' || value == null) return false;
	const identity = (value as PodHostConfig).identity as unknown;
	const db = (value as PodHostConfig).db as unknown;
	return (
		typeof identity === 'object' &&
		identity != null &&
		typeof (identity as HostIdentityProvider).authenticate === 'function' &&
		typeof (identity as HostIdentityProvider).name === 'string' &&
		typeof db === 'object' &&
		db != null &&
		typeof (db as HostDbAdapter).connect === 'function' &&
		typeof (db as HostDbAdapter).connectionString === 'string'
	);
}

function identityProvider(input: HostConfigInput): HostIdentityProvider {
	if (input.identityMode === 'trusted-host') {
		return trustedHeaderIdentity({ token: input.trustedHostToken });
	}
	return devIdentity({
		userId: input.adminId,
		organizationId: input.orgId,
		organizationName: input.orgName
	});
}

/**
 * The configuration a workspace gets when it has no `pod.config.ts`.
 *
 * `ai` is absent on purpose — it is the trusted host's facility, and a workspace that needs it
 * should be refused here rather than started against a placeholder. `maps` is present but is a
 * placeholder that fails when used rather than when installed, so an address field still accepts
 * typed input; `stubbed` carries it to the banner so the operator learns that on boot instead of
 * from a stack trace later.
 */
export function defaultHostConfig(input: HostConfigInput): ResolvedHostConfig {
	return {
		source: 'built-in defaults',
		stubbed: ['maps'],
		config: {
			db: postgresDb({ url: input.databaseUrl }),
			identity: identityProvider(input),
			fileStorage: localFileStorage({
				directory: path.join(input.root, '.norbital', 'storage'),
				origin: `http://${input.host}:${input.port}`
			}),
			notifications: consoleNotifications(),
			maps: stubMaps(),
			scheduler: { automations: true }
		}
	};
}

/**
 * Load `pod.config.ts` if the workspace has one, otherwise fall back to the defaults.
 *
 * A workspace config replaces the defaults rather than merging with them. Merging would mean a
 * host that deliberately omits a facility silently gets the placeholder instead, and the facility
 * gate — the one place that can tell an operator a workspace will not work here — would stop
 * firing. An explicit config is a complete statement of what this host provides.
 */
export async function loadHostConfig(input: HostConfigInput): Promise<ResolvedHostConfig> {
	const loaded = await loadHostConfigFile(input.root);
	return loaded ?? defaultHostConfig(input);
}

/**
 * The workspace's own `pod.config.ts`, or `null` when it has none.
 *
 * Separate from `loadHostConfig` because `pod migrate` and `pod seed` need one thing out of the
 * configuration — which database to open — and must not have to invent an identity mode or a
 * port to ask for it.
 */
export async function loadHostConfigFile(root: string): Promise<ResolvedHostConfig | null> {
	for (const filename of CONFIG_FILENAMES) {
		const configPath = path.join(root, filename);
		if (!existsSync(configPath)) continue;

		const loaded: unknown = await import(pathToFileURL(configPath).href);
		const exported =
			typeof loaded === 'object' && loaded != null && 'default' in loaded
				? (loaded as { default: unknown }).default
				: undefined;
		if (!isHostConfig(exported)) {
			throw new Error(
				`${filename} must default-export definePodHost({ ... }) with a \`db\` adapter and an identity provider.`
			);
		}
		return { config: exported, source: filename, stubbed: [] };
	}
	return null;
}

/**
 * The database every command should open: the configured adapter's, falling back to the
 * environment. A workspace that points `pod start` at one database must not have `pod migrate`
 * quietly migrate a different one.
 */
export async function resolveDatabaseUrl(root: string, fallbackUrl: string): Promise<string> {
	const loaded = await loadHostConfigFile(root);
	return loaded?.config.db.connectionString ?? fallbackUrl;
}
