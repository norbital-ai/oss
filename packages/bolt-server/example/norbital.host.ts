// An example untethered host file (plan 01): copy it beside a workspace's `src/` as `norbital.host.ts`, and `bolt dev`
// and `bolt-server` serve that workspace with it. This one reads its settings from `BOLT_*` variables and composes
// bolt-server's own adapters (`@norbital-ai/bolt-server`; imported from source here so the example type-checks in place).
// The host file is host code: Bolt reads none of these variables.
//
// - `BOLT_PUBLIC_URL` (required): the origin, `https://` unless its host is loopback.
// - Exactly one of `BOLT_DATABASE_URL` and `BOLT_PGLITE_DIR`; `BOLT_AUDIT_DIR` (required), a separate durable directory.
// - `BOLT_MASTER_KEY` (required): 32 bytes as 64 hex digits or base64; it seals the tenant's secrets.
// - `BOLT_FILES_PROVIDER` `local` (`BOLT_FILES_ENDPOINT` a directory) or `s3` (`BOLT_FILES_ENDPOINT` the bucket URL,
//   `BOLT_FILES_CREDENTIAL` `<access key id>:<secret>`).
// - `BOLT_TRANSACTIONAL_EMAIL` (required) `resend` (`BOLT_RESEND_API_KEY`, optional `BOLT_RESEND_FROM`) or `log`;
//   `BOLT_TRANSACTIONAL_PHONE` `twilio` (`BOLT_TWILIO_ACC_SID`, `BOLT_TWILIO_AUTH_TOKEN`), `log` or `none` (default).
// - `BOLT_<F>_PROVIDER` / `_ENDPOINT` / `_CREDENTIAL` for `AI_SYS_1` (`openai`, `decisions`), `AI_SYS_2`, `AI_EMBED`
//   (`openai`), `GEO` (`nominatim`), `CONVERT` (`norbital`) and `WEB` (`public`), with `BOLT_AI_SYS_1_MODEL`,
//   `BOLT_AI_SYS_2_MODELS` and `BOLT_AI_EMBED_MODELS` (JSON maps); speech is
//   `BOLT_AI_SPEECH_ENDPOINT` + `_CREDENTIAL` with `BOLT_AI_TRANSCRIBE_MODEL`, `BOLT_AI_SPEAK_MODEL`, `BOLT_AI_SPEAK_VOICE`
//   (speech is off unless both models are set).
// - Optional pairs: `BOLT_GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`, `BOLT_VAPID_PUBLIC_KEY`/`_PRIVATE_KEY`,
//   `BOLT_TURNSTILE_SITE_KEY`/`_SECRET`; `BOLT_APNS_KEYS` (JSON by team id); `BOLT_ENVIRONMENT` (the shell's badge).
import { Effect, Exit, Layer, ManagedRuntime, Option, Schema, Scope } from 'effect';
import { FetchHttpClient } from 'effect/http';
import * as NodeServices from '@effect/platform-node/NodeServices';
import pg from 'pg';
import { TenantDb } from '@norbital-ai/bolt/engine';
import type { Facilities, Serving } from '@norbital-ai/bolt/facilities';
import { PgliteDb, PostgresDb, tenantDbPort } from '@norbital-ai/bolt/node';
import { host, type Facility, type HostSettings, type Provider } from '../src/index.ts';

const env = (name: string): string | undefined => {
	const value = process.env[name]?.trim();
	return value === undefined || value === '' ? undefined : value;
};
const required = (name: string): string => {
	const value = env(name);
	if (value === undefined) throw new Error(`${name} is required`);
	return value;
};
const both = (a: string, b: string): [string, string] | null => {
	const x = env(a),
		y = env(b);
	if ((x === undefined) !== (y === undefined)) throw new Error(`set both ${a} and ${b}, or neither`);
	return x === undefined || y === undefined ? null : [x, y];
};
const json = <A>(name: string, schema: Schema.Decoder<A>, empty: string): A => {
	const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(schema))(env(name) ?? empty);
	if (Option.isNone(decoded)) throw new Error(`${name} does not match its JSON schema`);
	return decoded.value;
};

const masterKey = (() => {
	const v = required('BOLT_MASTER_KEY');
	const b = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
	if (b.length !== 32) throw new Error('BOLT_MASTER_KEY is not a 32-byte key (64 hex digits or base64)');
	return b;
})();
const publicUrl = new URL(required('BOLT_PUBLIC_URL'));
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname);
if (publicUrl.protocol !== 'https:' && !(publicUrl.protocol === 'http:' && loopback))
	throw new Error('BOLT_PUBLIC_URL must be https:// unless its host is loopback');

const providers: { [F in Facility]?: Provider } = {};
for (const f of ['AI_SYS_1', 'AI_SYS_2', 'AI_EMBED', 'GEO', 'CONVERT', 'WEB'] as const) {
	const provider = env(`BOLT_${f}_PROVIDER`),
		endpoint = env(`BOLT_${f}_ENDPOINT`),
		credential = env(`BOLT_${f}_CREDENTIAL`);
	if (provider !== undefined)
		providers[f] = {
			provider,
			...(endpoint === undefined ? {} : { endpoint }),
			...(credential === undefined ? {} : { credential })
		};
}
if ((providers.AI_SYS_1 === undefined) !== (providers.AI_SYS_2 === undefined))
	throw new Error('set both BOLT_AI_SYS_1_PROVIDER and BOLT_AI_SYS_2_PROVIDER, or neither');

const filesProvider = required('BOLT_FILES_PROVIDER');
const files: HostSettings['files'] =
	filesProvider === 'local'
		? { provider: 'local', root: required('BOLT_FILES_ENDPOINT') }
		: filesProvider === 's3'
			? {
					provider: 's3',
					endpoint: required('BOLT_FILES_ENDPOINT'),
					credential: required('BOLT_FILES_CREDENTIAL')
				}
			: (() => {
					throw new Error(`BOLT_FILES_PROVIDER is local or s3, not '${filesProvider}'`);
				})();

const email = required('BOLT_TRANSACTIONAL_EMAIL'),
	phone = env('BOLT_TRANSACTIONAL_PHONE') ?? 'none';
const transactional: HostSettings['transactional'] = {
	email:
		email === 'log'
			? { provider: 'log' }
			: email === 'resend'
				? {
						provider: 'resend',
						key: required('BOLT_RESEND_API_KEY'),
						from: env('BOLT_RESEND_FROM') ?? `noreply@${publicUrl.hostname}`
					}
				: (() => {
						throw new Error(`BOLT_TRANSACTIONAL_EMAIL is resend or log, not '${email}'`);
					})(),
	phone:
		phone === 'none'
			? null
			: phone === 'log'
				? { provider: 'log' }
				: phone === 'twilio'
					? {
							provider: 'twilio',
							accountSid: required('BOLT_TWILIO_ACC_SID'),
							authToken: required('BOLT_TWILIO_AUTH_TOKEN')
						}
					: (() => {
							throw new Error(`BOLT_TRANSACTIONAL_PHONE is twilio, log or none, not '${phone}'`);
						})()
};

const speechKey = both('BOLT_AI_SPEECH_ENDPOINT', 'BOLT_AI_SPEECH_CREDENTIAL'),
	transcribeModel = env('BOLT_AI_TRANSCRIBE_MODEL'),
	speakModel = env('BOLT_AI_SPEAK_MODEL');
const google = both('BOLT_GOOGLE_OAUTH_CLIENT_ID', 'BOLT_GOOGLE_OAUTH_CLIENT_SECRET');
const vapid = both('BOLT_VAPID_PUBLIC_KEY', 'BOLT_VAPID_PRIVATE_KEY');
const turnstile = both('BOLT_TURNSTILE_SITE_KEY', 'BOLT_TURNSTILE_SECRET');
const settings: HostSettings = {
	publicUrl: publicUrl.origin,
	auditDir: required('BOLT_AUDIT_DIR'),
	files,
	masterKey,
	googleOAuth: google === null ? null : { id: google[0], secret: google[1] },
	transactional,
	providers,
	ai: {
		sys1: env('BOLT_AI_SYS_1_MODEL') ?? null,
		sys2: json('BOLT_AI_SYS_2_MODELS', Schema.Record(Schema.String, Schema.NonEmptyString), '{}'),
		embed: json(
			'BOLT_AI_EMBED_MODELS',
			Schema.Record(
				Schema.String,
				Schema.Union([
					Schema.NonEmptyString,
					Schema.Struct({
						model: Schema.NonEmptyString,
						inputs: Schema.optionalKey(Schema.Number),
						tokens: Schema.optionalKey(Schema.Number)
					})
				])
			),
			'{}'
		)
	},
	speech:
		// the speech facility is both calls: one model alone leaves it off
		speechKey === null || transcribeModel === undefined || speakModel === undefined
			? null
			: {
					endpoint: speechKey[0],
					credential: speechKey[1],
					transcribe: transcribeModel,
					speak: speakModel,
					voice: env('BOLT_AI_SPEAK_VOICE') ?? null
				},
	vapid: vapid === null ? null : { publicKey: vapid[0], privateKey: vapid[1] },
	apns: json(
		'BOLT_APNS_KEYS',
		Schema.Record(Schema.String, Schema.Struct({ keyId: Schema.NonEmptyString, key: Schema.NonEmptyString })),
		'{}'
	),
	turnstile: turnstile === null ? null : { siteKey: turnstile[0], secret: turnstile[1] },
	environment: env('BOLT_ENVIRONMENT') ?? null
};

const databaseUrl = env('BOLT_DATABASE_URL'),
	pglite = env('BOLT_PGLITE_DIR');
if ((databaseUrl === undefined) === (pglite === undefined))
	throw new Error('set exactly one of BOLT_DATABASE_URL and BOLT_PGLITE_DIR');
const database =
	databaseUrl === undefined
		? PgliteDb.layer(pglite)
		: Layer.unwrap(
				Effect.map(
					Effect.acquireRelease(
						Effect.sync(
							() =>
								new pg.Pool({
									connectionString: databaseUrl,
									...(new URL(databaseUrl).searchParams.has('sslmode') ? {} : { ssl: true }),
									max: 10
								})
						),
						(pool) => Effect.promise(() => pool.end())
					),
					PostgresDb.layer
				)
			);

// the host's resources live until bolt-server or `bolt dev` stops and calls `serving.close`
const runtime = ManagedRuntime.make(
	Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, database)
);
const scope = await runtime.runPromise(Scope.make());
const served = await runtime.runPromise(
	Effect.gen(function* () {
		const db = yield* TenantDb;
		return yield* host(settings, tenantDbPort(db), {
			...(pglite === undefined ? {} : { pglite }),
			log: (line) => console.log(`[host] ${line}`)
		});
	}).pipe(Scope.provide(scope))
);

export default served.facilities satisfies Facilities;
export const serving: Serving = {
	...served.serving,
	close: () => runtime.runPromise(Scope.close(scope, Exit.void)).then(() => runtime.dispose())
};
