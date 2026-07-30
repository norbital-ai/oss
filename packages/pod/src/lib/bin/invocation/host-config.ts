import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { postgresDb } from '../../host/db.js';
import { localFileStorage } from '../../host/file-storage.js';
import { devIdentity } from '../../host/identity.js';
import { intervalQueue } from '../../host/interval-queue.js';
import type {
	HostDbAdapter,
	HostIdentityProvider,
	PodHostConfig,
	SelfHostedPodHostConfig
} from '../../host/types.js';

/** Config filenames tried in order. `.ts` first: Node strips types natively on the supported range. */
const CONFIG_FILENAMES = ['pod.host.ts', 'pod.host.js', 'pod.host.mjs'] as const;

export type HostConfigInput = {
	readonly root: string;
	readonly development: boolean;
	readonly databaseUrl: string;
	readonly orgId: string;
	readonly orgName: string;
	readonly adminId: string;
};

export type ResolvedHostConfig = {
	readonly config: SelfHostedPodHostConfig;
	/** Where the configuration came from, for the startup banner. */
	readonly source: string;
};

type LoadedHostConfig = {
	readonly config: PodHostConfig;
	readonly source: string;
};

function isHostConfig(value: unknown): value is PodHostConfig {
	if (typeof value !== 'object' || value == null) return false;
	const mode = (value as { mode?: unknown }).mode;
	if (mode === 'core') return true;
	if (mode !== 'self-hosted') return false;
	const identity = (value as SelfHostedPodHostConfig).identity as unknown;
	const db = (value as SelfHostedPodHostConfig).db as unknown;
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

/**
 * Local Core emulation used only by `pod dev`.
 */
function coreDevelopmentHostConfig(input: HostConfigInput, source: string): ResolvedHostConfig {
	return {
		source: `${source} (Core development emulation)`,
		config: {
			mode: 'self-hosted',
			db: postgresDb({ url: input.databaseUrl }),
			identity: devIdentity({
				userId: input.adminId,
				organizationId: input.orgId,
				organizationName: input.orgName
			}),
			fileStorage: localFileStorage({
				directory: path.join(input.root, '.norbital', 'storage')
			}),
			// `pod dev` is a single short-lived process, so a timer is the honest fit. A deployed
			// workspace configures a durable queue in its own `pod.host.ts`.
			queue: intervalQueue()
		}
	};
}

/**
 * Resolve an explicit deployment target. Core workspaces may be emulated by `pod dev`, but
 * production `pod start` requires a complete self-hosted configuration.
 */
export async function loadHostConfig(input: HostConfigInput): Promise<ResolvedHostConfig> {
	const loaded = await loadHostConfigFile(input.root);
	if (!loaded) {
		throw new Error(
			'Missing pod.host.ts. Declare definePodHost({ mode: "core" }) or a complete mode: "self-hosted" host.'
		);
	}
	if (loaded.config.mode === 'self-hosted') {
		return { config: loaded.config, source: loaded.source };
	}
	if (input.development) return coreDevelopmentHostConfig(input, loaded.source);
	throw new Error(
		`${loaded.source} targets Core and cannot run with \`pod start\`. Deploy it to Core or configure mode: "self-hosted" with real providers.`
	);
}

/**
 * The workspace's own `pod.host.ts`, or `null` when it has none.
 *
 * Separate from `loadHostConfig` because `pod migrate` and `pod seed` need one thing out of the
 * configuration — which database to open — and do not need a resolved runtime host.
 */
export async function loadHostConfigFile(root: string): Promise<LoadedHostConfig | null> {
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
				`${filename} must default-export definePodHost({ mode: 'core' }) or definePodHost({ mode: 'self-hosted', db, identity, ... }).`
			);
		}
		return { config: exported, source: filename };
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
	if (!loaded) {
		throw new Error(
			'Missing pod.host.ts. Declare whether this workspace targets Core or is self-hosted.'
		);
	}
	return loaded.config.mode === 'self-hosted' ? loaded.config.db.connectionString : fallbackUrl;
}
