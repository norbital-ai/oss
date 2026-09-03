import {
	EnvironmentName,
	GATEWAY_SECRET_VARIABLE,
	ReleaseId,
	SYSTEM_SIGNATURE_HEADER,
	SYSTEM_TIMESTAMP_HEADER,
	TenantId,
	type FacilityBindings
} from '@norbital-ai/bolt-protocol';
import {
	ServerConfiguration,
	dispatchSystemCommand,
	makeConfigBinding,
	startLocalApplication,
	startLocalDatabase,
	startLocalFiles,
	systemCommandHeaders,
	type RunningApplication,
	type StartedLocalDatabase,
	type StartedLocalFiles
} from '@norbital-ai/bolt-server';
import { Effect, Redacted } from 'effect';
import { catalogAi } from './catalog-ai.js';
import { loadPublicSeed, type PublicSeedQuery, type PublicSeedRows } from './load-public-seed.js';

const DEFAULT_ENVIRONMENT = 'test';
const DEFAULT_INVOCATION_TIMEOUT_MILLIS = 60_000;
const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 16_384;

type StartedHost = {
	readonly baseUrl: string;
	readonly address: RunningApplication['address'];
	readonly stop: () => Promise<void>;
};

export type GuestCommandAuthority = 'system' | 'bearer';

export type GuestCommandInput = {
	readonly baseUrl: string;
	readonly command: string;
	readonly input: unknown;
	readonly authority: GuestCommandAuthority;
	readonly gatewaySecret: string;
	readonly tenantId: string;
	readonly credential?: string;
};

export type GuestCommandResult = {
	readonly status: number;
	readonly value: unknown;
};

export type WithSelfHostInput = {
	readonly bundlePath: string;
	readonly tenantId: string;
	readonly releaseId?: string;
	readonly environment?: string;
	readonly gatewaySecret?: string;
	readonly secretsKey?: string;
	readonly seed?: {
		readonly stages: readonly string[];
		readonly rows: PublicSeedRows | string;
		readonly mapParameters?: (value: unknown) => unknown;
	};
	readonly founder?: { readonly email: string; readonly claimId: string } | false;
	readonly host?: string;
	readonly invocationTimeoutMillis?: number;
	readonly requestBodyLimitBytes?: number;
	readonly files?: boolean;
	/** Any `FacilityBindings['ai']`. Default is the catalog test double, not a vendor lock. */
	readonly ai?: FacilityBindings['ai'];
};

export type SelfHostSession = {
	readonly baseUrl: string;
	readonly address: RunningApplication['address'];
	readonly query: PublicSeedQuery;
	readonly credential: string | undefined;
	readonly gatewaySecret: string;
	readonly tenantId: string;
	readonly scope: FacilityBindings['scope'];
	readonly files: StartedLocalFiles | undefined;
	readonly guestCommand: (
		command: string,
		input: unknown,
		authority: GuestCommandAuthority
	) => Promise<GuestCommandResult>;
	readonly stop: () => Promise<void>;
};

type FounderMode =
	| { readonly kind: 'skip' }
	| { readonly kind: 'run'; readonly email: string; readonly claimId: string };

type SeedMode =
	| { readonly kind: 'none' }
	| {
			readonly kind: 'load';
			readonly stages: readonly string[];
			readonly rows: PublicSeedRows | string;
			readonly mapParameters?: (value: unknown) => unknown;
	  };

type FilesMode = { readonly kind: 'none' } | { readonly kind: 'memory' };

/** Keep JS arrays; JSON.stringify only non-array objects (uuid[] / text[] stay arrays). */
export const jsonSqlParameter = (value: unknown): unknown => {
	if (Array.isArray(value)) return value;
	return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
};

const asRecord = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`${label} was not an object: ${JSON.stringify(value)}`);
	}
	return value as Readonly<Record<string, unknown>>;
};

const founderMode = (input: WithSelfHostInput): FounderMode => {
	const founder = input.founder;
	if (founder === false) return { kind: 'skip' };
	if (founder === undefined) {
		return {
			kind: 'run',
			email: `${input.tenantId}-founder@example.test`,
			claimId: `${input.tenantId}-founder`
		};
	}
	return { kind: 'run', email: founder.email, claimId: founder.claimId };
};

const seedMode = (input: WithSelfHostInput): SeedMode => {
	if (input.seed === undefined) return { kind: 'none' };
	return {
		kind: 'load',
		stages: input.seed.stages,
		rows: input.seed.rows,
		...(input.seed.mapParameters !== undefined
			? { mapParameters: input.seed.mapParameters }
			: {})
	};
};

const filesMode = (input: WithSelfHostInput): FilesMode =>
	input.files === true ? { kind: 'memory' } : { kind: 'none' };

const mappedQuery =
	(query: PublicSeedQuery, mapParameters: ((value: unknown) => unknown) | undefined): PublicSeedQuery =>
	(statement, parameters) => {
		if (mapParameters === undefined) return query(statement, parameters);
		return query(statement, (parameters ?? []).map(mapParameters));
	};

const authorityHeaders = (input: GuestCommandInput): Readonly<Record<string, string>> => {
	switch (input.authority) {
		case 'system': {
			const signed = Effect.runSync(
				systemCommandHeaders(
					Redacted.make(input.gatewaySecret),
					input.command,
					input.tenantId,
					input.input
				)
			);
			return {
				[SYSTEM_SIGNATURE_HEADER]: signed[SYSTEM_SIGNATURE_HEADER]?.[0] ?? '',
				[SYSTEM_TIMESTAMP_HEADER]: signed[SYSTEM_TIMESTAMP_HEADER]?.[0] ?? ''
			};
		}
		case 'bearer': {
			if (input.credential === undefined || input.credential.length === 0) {
				throw new Error('bearer guestCommand requires a credential');
			}
			return { Authorization: `Bearer ${input.credential}` };
		}
		default: {
			const _exhaustive: never = input.authority;
			throw new Error(`unhandled guestCommand authority: ${String(_exhaustive)}`);
		}
	}
};

const parseCommandBody = (text: string): unknown => {
	if (text.length === 0) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
};

/** POST `/_bolt/command/:command`. System uses signed headers; bearer uses the session credential. */
export const guestCommand = async (input: GuestCommandInput): Promise<GuestCommandResult> => {
	const response = await fetch(
		`${input.baseUrl}/_bolt/command/${encodeURIComponent(input.command)}`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json', ...authorityHeaders(input) },
			body: JSON.stringify(input.input)
		}
	);
	return { status: response.status, value: parseCommandBody(await response.text()) };
};

const requireFounderCredential = (founder: unknown): string => {
	const admitted = asRecord(founder, 'identity.bootstrapFounder');
	if (admitted.admitted !== true || typeof admitted.credential !== 'string') {
		throw new Error(`identity.bootstrapFounder failed: ${JSON.stringify(founder)}`);
	}
	if (admitted.credential.length === 0) {
		throw new Error('identity.bootstrapFounder returned an empty credential');
	}
	return admitted.credential;
};

const admitFounder = async (input: {
	readonly baseUrl: string;
	readonly bundlePath: string;
	readonly facilities: FacilityBindings;
	readonly scope: FacilityBindings['scope'];
	readonly gatewaySecret: string;
	readonly email: string;
	readonly claimId: string;
}): Promise<string> => {
	const founderInput = { email: input.email, claimId: input.claimId };
	const founderHttp = await guestCommand({
		baseUrl: input.baseUrl,
		command: 'identity.bootstrapFounder',
		input: founderInput,
		authority: 'system',
		gatewaySecret: input.gatewaySecret,
		tenantId: String(input.scope.tenantId)
	});
	const founder =
		founderHttp.status >= 200 && founderHttp.status < 300
			? founderHttp.value
			: (
					await dispatchSystemCommand({
						bundlePath: input.bundlePath,
						facilities: input.facilities,
						scope: input.scope,
						gatewaySecret: input.gatewaySecret,
						command: 'identity.bootstrapFounder',
						input: { email: input.email, claimId: input.claimId },
						invocationId: `identity.bootstrapFounder:${input.claimId}`
					})
				).value;
	return requireFounderCredential(founder);
};

const releaseHeld = async (held: {
	readonly host: StartedHost | undefined;
	readonly files: StartedLocalFiles | undefined;
	readonly database: StartedLocalDatabase;
}): Promise<void> => {
	if (held.host !== undefined) await held.host.stop();
	if (held.files !== undefined) await held.files.close();
	await held.database.close();
};

/** Start/stop form for existing wrappers. */
export const startSelfHostSession = async (input: WithSelfHostInput): Promise<SelfHostSession> => {
	const tenantId = input.tenantId;
	const releaseId = input.releaseId ?? tenantId;
	const environment = input.environment ?? DEFAULT_ENVIRONMENT;
	const gatewaySecret = input.gatewaySecret ?? `${tenantId}-gateway`;
	const secretsKey = input.secretsKey ?? `${tenantId}-secrets`;
	const scope = {
		tenantId: TenantId.make(tenantId),
		environment: EnvironmentName.make(environment),
		releaseId: ReleaseId.make(releaseId)
	};
	const previousGatewaySecret = process.env[GATEWAY_SECRET_VARIABLE];
	process.env[GATEWAY_SECRET_VARIABLE] = gatewaySecret;
	const restoreGatewaySecret = (): void => {
		if (previousGatewaySecret === undefined) {
			delete process.env[GATEWAY_SECRET_VARIABLE];
			return;
		}
		process.env[GATEWAY_SECRET_VARIABLE] = previousGatewaySecret;
	};

	const database = await startLocalDatabase();
	const held: {
		host: StartedHost | undefined;
		files: StartedLocalFiles | undefined;
		database: StartedLocalDatabase;
	} = { host: undefined, files: undefined, database };
	try {
		const filesChoice = filesMode(input);
		switch (filesChoice.kind) {
			case 'memory':
				held.files = await startLocalFiles();
				break;
			case 'none':
				break;
			default: {
				const _exhaustive: never = filesChoice;
				throw new Error(`unhandled files mode: ${JSON.stringify(_exhaustive)}`);
			}
		}

		const facilities: FacilityBindings = {
			scope,
			database: database.binding,
			ai: input.ai ?? catalogAi(),
			...(held.files !== undefined ? { files: held.files.binding } : {}),
			config: makeConfigBinding({
				[GATEWAY_SECRET_VARIABLE]: gatewaySecret,
				BOLT_SECRETS_KEY: secretsKey
			})
		};

		await dispatchSystemCommand({
			bundlePath: input.bundlePath,
			facilities,
			scope,
			gatewaySecret,
			command: 'schema.migrate',
			input: {},
			invocationId: `schema.migrate:${String(scope.releaseId)}`
		});

		const seed = seedMode(input);
		const query = mappedQuery(
			database.query,
			seed.kind === 'load' ? seed.mapParameters : undefined
		);
		switch (seed.kind) {
			case 'none':
				break;
			case 'load':
				await loadPublicSeed({
					stages: seed.stages,
					rows: seed.rows,
					query
				});
				break;
			default: {
				const _exhaustive: never = seed;
				throw new Error(`unhandled seed mode: ${JSON.stringify(_exhaustive)}`);
			}
		}

		const { tasks: _tasks, ...bound } = facilities;
		const application = await startLocalApplication({
			configuration: ServerConfiguration.make({
				host: input.host ?? '127.0.0.1',
				port: 0,
				bundlePath: input.bundlePath,
				scope,
				mode: 'development',
				drainTimeoutMillis: 1_000,
				invocationTimeoutMillis: input.invocationTimeoutMillis ?? DEFAULT_INVOCATION_TIMEOUT_MILLIS,
				requestBodyLimitBytes: input.requestBodyLimitBytes ?? DEFAULT_REQUEST_BODY_LIMIT_BYTES,
				gatewaySecret: Redacted.make(gatewaySecret)
			}),
			facilities: bound
		});
		held.host = {
			baseUrl: application.baseUrl,
			address: application.address,
			stop: () => application.stop()
		};

		const founder = founderMode(input);
		let credential: string | undefined;
		switch (founder.kind) {
			case 'skip':
				credential = undefined;
				break;
			case 'run':
				credential = await admitFounder({
					baseUrl: held.host.baseUrl,
					bundlePath: input.bundlePath,
					facilities,
					scope,
					gatewaySecret,
					email: founder.email,
					claimId: founder.claimId
				});
				break;
			default: {
				const _exhaustive: never = founder;
				throw new Error(`unhandled founder mode: ${JSON.stringify(_exhaustive)}`);
			}
		}

		const started = held.host;
		const files = held.files;
		let stopped = false;
		const stop = async (): Promise<void> => {
			if (stopped) return;
			stopped = true;
			try {
				await releaseHeld({ host: started, files, database });
			} finally {
				restoreGatewaySecret();
			}
		};

		return {
			baseUrl: started.baseUrl,
			address: started.address,
			query,
			credential,
			gatewaySecret,
			tenantId,
			scope,
			files,
			guestCommand: (command, commandInput, authority) =>
				guestCommand({
					baseUrl: started.baseUrl,
					command,
					input: commandInput,
					authority,
					gatewaySecret,
					tenantId,
					...(credential !== undefined ? { credential } : {})
				}),
			stop
		};
	} catch (error) {
		try {
			await releaseHeld(held);
		} finally {
			restoreGatewaySecret();
		}
		throw error;
	}
};

/** Callback form — always stops. */
export const withSelfHost = async <A>(
	input: WithSelfHostInput,
	body: (session: SelfHostSession) => Promise<A>
): Promise<A> => {
	const session = await startSelfHostSession(input);
	try {
		return await body(session);
	} finally {
		await session.stop();
	}
};
