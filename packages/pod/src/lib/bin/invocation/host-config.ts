import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { postgresDb } from '../../host/db.js';
import { consoleMessaging } from '../../host/facilities.js';
import { localFileStorage } from '../../host/file-storage.js';
import { devIdentity } from '../../host/identity.js';
import { intervalQueue } from '../../host/interval-queue.js';
import type {
	HostDbAdapter,
	HostIdentityDescriptor,
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
	/** Where this workspace is reachable. `pod dev` derives it from the bind address. */
	readonly publicUrl: string;
	/**
	 * Transports the compiled workspace's channels name, for `pod dev` to echo to the console.
	 *
	 * Only the Core development emulation reads this. A real host declares its transports because it
	 * holds the sockets; a development run holds none, so it stands in for every transport the
	 * workspace declares and logs what would have been sent — the same bargain `devIdentity` and
	 * console channel delivery already make.
	 */
	readonly channelTransports?: readonly string[];
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
	const publicUrl = (value as SelfHostedPodHostConfig).publicUrl as unknown;
	// Identity is either a live provider or a named descriptor the runner binds; both are objects, so
	// the shape check has to accept either rather than insisting on `authenticate`.
	const identityShaped =
		typeof identity === 'object' &&
		identity != null &&
		((typeof (identity as HostIdentityProvider).authenticate === 'function' &&
			typeof (identity as HostIdentityProvider).name === 'string') ||
			typeof (identity as HostIdentityDescriptor).provider === 'string');
	return (
		identityShaped &&
		typeof publicUrl === 'string' &&
		publicUrl.trim().length > 0 &&
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
			publicUrl: input.publicUrl,
			fileStorage: localFileStorage({
				directory: path.join(input.root, '.norbital', 'storage')
			}),
			messaging: consoleMessaging({
				channels: ['email'],
				transports: input.channelTransports ?? []
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
				`${filename} must default-export definePodHost({ mode: 'core' }) or definePodHost({ mode: 'self-hosted', db, identity, publicUrl, ... }). A self-hosted host needs all three: db, identity (a provider or emailOtp({ secret })), and publicUrl.`
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
