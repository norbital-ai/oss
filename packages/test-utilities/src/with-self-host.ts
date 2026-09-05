import {
	EnvironmentName,
	GATEWAY_SECRET_VARIABLE,
	ReleaseId,
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
	makeWebConnectorBinding,
	type RunningApplication,
	type StartedLocalDatabase,
	type StartedLocalFiles
} from '@norbital-ai/bolt-server';
import { Redacted, Schema } from 'effect';
import { asRecord, systemHeaders } from './guest-http.js';
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
	/** Portable connector providers, including a fixture or the public HTTPS page reader. */
	readonly connector?: FacilityBindings['connector'];
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
	return Schema.is(Schema.Record(Schema.String, Schema.Unknown))(value)
		? JSON.stringify(value)
		: value;
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
		...(input.seed.mapParameters !== undefined ? { mapParameters: input.seed.mapParameters } : {})
	};
};

const filesMode = (input: WithSelfHostInput): FilesMode =>
	input.files === true ? { kind: 'memory' } : { kind: 'none' };

const mappedQuery =
	(
		query: PublicSeedQuery,
		mapParameters: ((value: unknown) => unknown) | undefined
	): PublicSeedQuery =>
	(statement, parameters) => {
		if (mapParameters === undefined) return query(statement, parameters);
		return query(statement, (parameters ?? []).map(mapParameters));
	};

const authorityHeaders = (input: GuestCommandInput): Readonly<Record<string, string>> => {
	switch (input.authority) {
		case 'system': {
			return systemHeaders(input.command, input.input, input.gatewaySecret, input.tenantId);
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
	// repository-health:allow EFF1 -- a malformed body falls back to the raw text; JSON.parse has no non-throwing form and this is a decode fallback, not Effect error control.
	try {
		return JSON.parse(text);
	} catch {
		/* not JSON — surface the body as the raw text value */
		return text;
	}
};

/** POST `/_bolt/command/:command`. System uses signed headers; bearer uses the session credential. */
export const guestCommand = async (
	// repository-health:allow EFF3 -- public promise-shaped test-harness API consumed by non-Effect suites; native fetch boundary.
	input: GuestCommandInput
): Promise<GuestCommandResult> => {
	// repository-health:allow EFF3 -- continuation of the same native fetch seam.
	// repository-health:allow FETCH1 -- this published isolation harness has no @norbital-ai/std dependency, and the request targets the local host this call just started.
	const response = await fetch(
		`${input.baseUrl}/_bolt/command/${encodeURIComponent(input.command)}`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json', ...authorityHeaders(input) },
			body: JSON.stringify(input.input)
		}
	);
	return { status: response.status, value: parseCommandBody(await response.text()) }; // repository-health:allow EFF3 -- continuation of the same native fetch seam.
};

const requireFounderCredential = (founder: unknown): string => {
	const admitted = asRecord(founder, 'identity.bootstrapFounder');
	if (admitted.admitted !== true || !Schema.is(Schema.String)(admitted.credential)) {
		throw new Error(`identity.bootstrapFounder failed: ${JSON.stringify(founder)}`);
	}
	if (admitted.credential.length === 0) {
		throw new Error('identity.bootstrapFounder returned an empty credential');
	}
	return admitted.credential;
};

type AdmitFounderInput = {
	readonly baseUrl: string;
	readonly bundlePath: string;
	readonly facilities: FacilityBindings;
	readonly scope: FacilityBindings['scope'];
	readonly gatewaySecret: string;
	readonly email: string;
	readonly claimId: string;
};

const admitFounder = async (
	// repository-health:allow EFF3 -- bootstrap fallback over the promise-shaped command seam; not an Effect pipeline.
	input: AdmitFounderInput
): Promise<string> => {
	const founderInput = { email: input.email, claimId: input.claimId };
	const founderHttp = await guestCommand({
		// repository-health:allow EFF3 -- same promise-shaped harness seam.
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
						// repository-health:allow EFF3 -- same promise-shaped harness seam.
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
	// repository-health:allow EFF3 -- teardown over promise-shaped facility finalizers; not an Effect pipeline.
	readonly host: StartedHost | undefined;
	readonly files: StartedLocalFiles | undefined;
	readonly database: StartedLocalDatabase;
}): Promise<void> => {
	if (held.host !== undefined) await held.host.stop(); // repository-health:allow EFF3 -- ordered release of the same promise-shaped finalizers.
	if (held.files !== undefined) await held.files.close(); // repository-health:allow EFF3 -- ordered release of the same promise-shaped finalizers.
	await held.database.close(); // repository-health:allow EFF3 -- ordered release of the same promise-shaped finalizers.
};

/** Start/stop form for existing wrappers. */
export const startSelfHostSession = async (
	// repository-health:allow EFF3 -- public promise-shaped test-harness boot consumed by non-Effect suites; not an Effect pipeline.
	input: WithSelfHostInput
): Promise<SelfHostSession> => {
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

	const database = await startLocalDatabase(); // repository-health:allow EFF3 -- same promise-shaped harness boot.
	const held: {
		host: StartedHost | undefined;
		files: StartedLocalFiles | undefined;
		database: StartedLocalDatabase;
	} = { host: undefined, files: undefined, database };
	// repository-health:allow EFF1 -- boot cleanup releases partially acquired facilities in order and rethrows the original failure; not Effect error control.
	try {
		const filesChoice = filesMode(input);
		switch (filesChoice.kind) {
			case 'memory':
				held.files = await startLocalFiles(); // repository-health:allow EFF3 -- same promise-shaped harness boot.
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
			connector: input.connector ?? makeWebConnectorBinding(),
			...(held.files !== undefined ? { files: held.files.binding } : {}),
			config: makeConfigBinding({
				[GATEWAY_SECRET_VARIABLE]: gatewaySecret,
				BOLT_SECRETS_KEY: secretsKey
			})
		};

		await dispatchSystemCommand({
			// repository-health:allow EFF3 -- same promise-shaped harness boot.
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
					// repository-health:allow EFF3 -- same promise-shaped harness boot.
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
			// repository-health:allow EFF3 -- same promise-shaped harness boot.
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
					// repository-health:allow EFF3 -- same promise-shaped harness boot.
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
			// repository-health:allow EFF3 -- stop returns the promise-shaped teardown contract; not an Effect pipeline.
			if (stopped) return;
			stopped = true;
			// repository-health:allow EFF1 -- try/finally orders releaseHeld before the env restore at the promise boundary; cleanup ordering, not error control.
			try {
				await releaseHeld({ host: started, files, database }); // repository-health:allow EFF3 -- ordered release of the same promise-shaped finalizers.
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
		// repository-health:allow EFF1 -- try/finally orders releaseHeld before the env restore at the promise boundary; cleanup ordering, not error control.
		try {
			await releaseHeld(held); // repository-health:allow EFF3 -- ordered release of the same promise-shaped finalizers.
		} finally {
			restoreGatewaySecret();
		}
		throw error;
	}
};

/** Callback form — always stops. */
export const withSelfHost = async <A>( // repository-health:allow EFF3 -- public promise-shaped test-harness API consumed by non-Effect suites; not an Effect pipeline.
	input: WithSelfHostInput,
	body: (session: SelfHostSession) => Promise<A>
): Promise<A> => {
	const session = await startSelfHostSession(input); // repository-health:allow EFF3 -- same promise-shaped harness boot.
	// repository-health:allow EFF1 -- try/finally guarantees session.stop after the caller's body at the promise boundary; cleanup ordering, not error control.
	try {
		return await body(session); // repository-health:allow EFF3 -- body is the caller's promise-shaped continuation.
	} finally {
		await session.stop(); // repository-health:allow EFF3 -- ordered release of the same promise-shaped finalizers.
	}
};
