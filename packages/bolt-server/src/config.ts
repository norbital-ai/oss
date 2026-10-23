// `bolt start` configuration (§5.11.6): one decoded set of `BOLT_*` names plus four flags. Anything wrong here refuses
// to start (a thrown `ConfigError`); what depends on the workspace (mail, files, secrets, turnstile, AI models) is
// checked at activation, against the manifest, by `server.ts`.
import {
	Config as EffectConfig,
	ConfigProvider,
	Effect,
	Option,
	Redacted,
	Result,
	Schema
} from 'effect';
import { isIP } from 'node:net';
import { SINCH_REGIONS, type TransactionalConfig } from '@norbital-ai/providers';

export class ConfigError extends Schema.TaggedError<ConfigError>()('ConfigError', {
	message: Schema.String
}) {}

/** One optional facility's selection: a provider name from the host's registered factories (L-BOLT-908). */
export type Provider = { provider: string; endpoint?: string; credential?: string };
const FACILITIES = [
	'AI_SYS_1',
	'AI_SYS_2',
	'AI_EMBED',
	'AI_SPEECH',
	'GEO',
	'CONVERT',
	'WEB'
] as const;
export type Facility = (typeof FACILITIES)[number];
/** Each facility's registered factories; any other name refuses to start. */
const REGISTERED: { readonly [F in Facility]: readonly string[] } = {
	AI_SYS_1: ['openai', 'decisions'],
	AI_SYS_2: ['openai'],
	AI_EMBED: ['openai'],
	GEO: ['nominatim'],
	// `ctx.ai.transcribe` / `ctx.ai.speak`: OpenRouter (ENDPOINT default its API), a model per capability
	AI_SPEECH: ['openrouter'],
	// `ctx.convert.document`: Norbital Convert (oss/services/convert), ENDPOINT its URL and CREDENTIAL an API key it accepts
	// integration instances are not facilities: an instance's provider and credentials are chosen at pairing, never env
	CONVERT: ['norbital'],
	WEB: ['public']
};
export type AiModel = string | { model: string; inputs?: number; tokens?: number };
type Modality = 'text' | 'image' | 'file';
const MODALITIES = new Set(['text', 'image', 'file']);

export type Config = {
	artifact: string;
	host: string;
	port: number;
	database: { url: string } | { pglite: string };
	publicUrl: string;
	files:
		| { provider: 'local'; root: string }
		| { provider: 's3'; endpoint: string; credential: string }
		| null;
	masterKey: Buffer | null;
	opsKey: Buffer | null;
	/** Host Google app shared by Gmail and Calendar where the workspace declares none of its own. */
	googleOAuth: { id: string; secret: string } | null;
	/**
	 * `BOLT_TRANSACTIONAL_EMAIL` (`resend` or `sinch`) and `BOLT_TRANSACTIONAL_PHONE` (`twilio`, `sinch` or `none`) with
	 * their providers' keys: the host's own messaging (sign-in codes, invitations; `mail.ts`). `null` when neither is set;
	 * `local` is a loopback origin outside production, where a host without it prints every message to its log.
	 */
	transactional: TransactionalConfig | null;
	mode: 'production' | 'local' | 'dev';
	providers: { readonly [F in Facility]?: Provider };
	/**
	 * The AI facility (P35, P39): `sys1` the `BOLT_AI_SYS_1_MODEL` id (`BOLT_AI_SYS_1_PROVIDER=openai`: a structured-output
	 * chat model; `decisions`: OpenRouter's Decisions API, `BOLT_AI_SYS_1_ENDPOINT` its full URL); `sys2` each model class → model id
	 * (`BOLT_AI_SYS_2_MODELS`); `embed` each embedding name → model (`BOLT_AI_EMBED_MODELS`); `modalities` the operator's
	 * declarations (`BOLT_AI_SYS_2_MODALITIES`, `BOLT_AI_EMBED_MODALITIES`), read only where the provider publishes none.
	 */
	ai: {
		sys1: string | null;
		sys2: { readonly [modelClass: string]: string };
		embed: { readonly [embedding: string]: AiModel };
		modalities: { sys2: readonly Modality[] | null; embed: readonly Modality[] | null };
	};
	/**
	 * `ctx.ai.transcribe` and `ctx.ai.speak` (`BOLT_AI_SPEECH_*`): the endpoint and key, `BOLT_AI_TRANSCRIBE_MODEL` (an
	 * audio-input chat model), `BOLT_AI_SPEAK_MODEL` (an `/audio/speech` model) and `BOLT_AI_SPEAK_VOICE`; null when unset.
	 */
	speech: {
		endpoint: string;
		credential: string;
		transcribe: string | null;
		speak: string | null;
		voice: string | null;
	} | null;
	vapid: { publicKey: string; privateKey: string } | null;
	/** `BOLT_APNS_KEYS`: each Apple team's provider-token key (its id and `.p8` PEM), by team id; `{}` sends no APNs. */
	apns: { readonly [teamId: string]: { readonly keyId: string; readonly key: string } };
	turnstile: { siteKey: string; secret: string } | null;
	/** `BOLT_ENVIRONMENT` (`production`, `staging`, `development`, …): every other than production shows the shell's badge. */
	environment: string | null;
	/** `--trust-proxy`, `--accept`, `--founder`, `--seed`. */
	trustProxy: readonly string[];
	accept: boolean;
	founder: string | null;
	seed: string | null;
	/**
	 * `--dev` or `BOLT_DEV=1` (L-BOLT-366): `bolt start` as `bolt dev` (the dev mail sink, destructive steps accepted, the
	 * dev Turnstile) and connections may reach a provider on this machine (`*.localhost`). Refused unless the public origin
	 * is loopback and `BOLT_ENVIRONMENT` is not `production`.
	 */
};

const KNOWN = new Set([
	'BOLT_ARTIFACT',
	'BOLT_HOST',
	'BOLT_PORT',
	'BOLT_DATABASE_URL',
	'BOLT_PGLITE_DIR',
	'BOLT_PUBLIC_URL',
	'BOLT_FILES_PROVIDER',
	'BOLT_FILES_ENDPOINT',
	'BOLT_FILES_CREDENTIAL',
	'BOLT_MASTER_KEY',
	'BOLT_OPS_KEY',
	'BOLT_GOOGLE_OAUTH_CLIENT_ID',
	'BOLT_GOOGLE_OAUTH_CLIENT_SECRET',
	'BOLT_TRANSACTIONAL_EMAIL',
	'BOLT_TRANSACTIONAL_PHONE',
	'BOLT_RESEND_API_KEY',
	'BOLT_RESEND_FROM',
	'BOLT_TWILIO_ACC_SID',
	'BOLT_TWILIO_AUTH_TOKEN',
	'BOLT_SINCH_MAILGUN_KEY',
	'BOLT_SINCH_MAILGUN_DOMAIN',
	'BOLT_SINCH_SMS_PLAN_ID',
	'BOLT_SINCH_SMS_TOKEN',
	'BOLT_SINCH_SMS_FROM',
	'BOLT_SINCH_VERIFICATION_KEY',
	'BOLT_SINCH_VERIFICATION_SECRET',
	'BOLT_SINCH_REGION',
	...FACILITIES.flatMap((f) => [
		`BOLT_${f}_PROVIDER`,
		`BOLT_${f}_ENDPOINT`,
		`BOLT_${f}_CREDENTIAL`
	]),
	'BOLT_AI_SYS_1_MODEL',
	'BOLT_AI_TRANSCRIBE_MODEL',
	'BOLT_AI_SPEAK_MODEL',
	'BOLT_AI_SPEAK_VOICE',
	'BOLT_AI_SYS_2_MODELS',
	'BOLT_AI_EMBED_MODELS',
	'BOLT_AI_SYS_2_MODALITIES',
	'BOLT_AI_EMBED_MODALITIES',
	'BOLT_VAPID_PUBLIC_KEY',
	'BOLT_VAPID_PRIVATE_KEY',
	'BOLT_APNS_KEYS',
	'BOLT_TURNSTILE_SITE_KEY',
	'BOLT_TURNSTILE_SECRET',
	'BOLT_ENVIRONMENT',
	'BOLT_DEV'
]);

const LOOPBACK = (host: string) =>
	host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';

/** A 32-byte key as 64 hex digits or base64; anything else fails boot (§5.11.4). */
function key32(name: string, v: string | undefined): Buffer | null {
	if (v === undefined) return null;
	const b = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
	if (b.length !== 32)
		throw new ConfigError({ message: `${name} is not a 32-byte key (64 hex digits or base64)` });
	return b;
}

function cidrs(list: string): string[] {
	return list
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s !== '')
		.map((c) => {
			const [net = '', bits] = c.split('/');
			const v = isIP(net);
			const max = v === 6 ? 128 : 32;
			if (v === 0 || (bits !== undefined && !(/^\d+$/.test(bits) && Number(bits) <= max)))
				throw new ConfigError({ message: `--trust-proxy: '${c}' is not a CIDR` });
			return c;
		});
}

/** Each provider key and the selections it serves (`email.resend`, `phone.twilio`, …): any other selection makes it a mistake. */
const OWNERS: readonly [RegExp, readonly string[]][] = [
	[/^BOLT_RESEND_/, ['email.resend']],
	[/^BOLT_TWILIO_/, ['phone.twilio']],
	[/^BOLT_SINCH_MAILGUN_/, ['email.sinch']],
	[/^BOLT_SINCH_(SMS|VERIFICATION)_/, ['phone.sinch']],
	[/^BOLT_SINCH_REGION$/, ['email.sinch', 'phone.sinch']]
];

/**
 * `BOLT_TRANSACTIONAL_EMAIL` / `BOLT_TRANSACTIONAL_PHONE` and their keys, checked at start: a selected provider needs its
 * keys (optional parts whole or not at all), and a key no selection uses is a mistake, not a fallback.
 */
function transactional(
	get: (k: string) => string | undefined,
	host: string
): TransactionalConfig | null {
	const email = get('BOLT_TRANSACTIONAL_EMAIL'),
		phone = get('BOLT_TRANSACTIONAL_PHONE') ?? 'none';
	if (email !== undefined && email !== 'resend' && email !== 'sinch')
		throw new ConfigError({
			message: `BOLT_TRANSACTIONAL_EMAIL is resend or sinch, not '${email}'`
		});
	if (phone !== 'twilio' && phone !== 'sinch' && phone !== 'none')
		throw new ConfigError({
			message: `BOLT_TRANSACTIONAL_PHONE is twilio, sinch or none, not '${phone}'`
		});
	const chosen = [`email.${email}`, `phone.${phone}`];
	for (const k of KNOWN) {
		const owners = OWNERS.find(([re]) => re.test(k))?.[1];
		if (owners !== undefined && get(k) !== undefined && !owners.some((o) => chosen.includes(o)))
			throw new ConfigError({
				message: `${k} is set but no selection uses it (${owners.map((o) => `BOLT_TRANSACTIONAL_${(o.split('.')[0] ?? '').toUpperCase()}=${o.split('.')[1]}`).join(' or ')})`
			});
	}
	const whole = (names: readonly string[], what: string) => {
		const given = names.filter((name) => get(name) !== undefined);
		if (given.length !== 0 && given.length !== names.length)
			throw new ConfigError({ message: `${what} needs ${names.join(', ')} together` });
		return given.length === names.length;
	};
	const needs = (name: string, what: string): string => {
		const value = get(name);
		if (value === undefined) throw new ConfigError({ message: `${what} needs ${name}` });
		return value;
	};
	const decodedRegion = Schema.decodeUnknownOption(Schema.Literals(SINCH_REGIONS))(
		get('BOLT_SINCH_REGION') ?? 'us'
	);
	if (Option.isNone(decodedRegion))
		throw new ConfigError({ message: `BOLT_SINCH_REGION is one of ${SINCH_REGIONS.join(', ')}` });
	const region = decodedRegion.value,
		c: TransactionalConfig = {};
	if (email === 'resend')
		c.email = {
			provider: 'resend',
			key: needs('BOLT_RESEND_API_KEY', 'BOLT_TRANSACTIONAL_EMAIL=resend'),
			from: get('BOLT_RESEND_FROM') ?? `noreply@${host}`
		};
	if (email === 'sinch')
		c.email = {
			provider: 'sinch',
			key: needs('BOLT_SINCH_MAILGUN_KEY', 'BOLT_TRANSACTIONAL_EMAIL=sinch'),
			domain: needs('BOLT_SINCH_MAILGUN_DOMAIN', 'BOLT_TRANSACTIONAL_EMAIL=sinch'),
			region
		};
	if (phone === 'twilio') {
		const accountSid = needs('BOLT_TWILIO_ACC_SID', 'BOLT_TRANSACTIONAL_PHONE=twilio'),
			authToken = needs('BOLT_TWILIO_AUTH_TOKEN', 'BOLT_TRANSACTIONAL_PHONE=twilio');
		if (!/^AC\w+$/.test(accountSid))
			throw new ConfigError({ message: 'BOLT_TWILIO_ACC_SID is a Twilio account SID (AC…)' });
		c.phone = { provider: 'twilio', accountSid, authToken };
	}
	if (phone === 'sinch') {
		const sms = whole(
			['BOLT_SINCH_SMS_PLAN_ID', 'BOLT_SINCH_SMS_TOKEN', 'BOLT_SINCH_SMS_FROM'],
			'Sinch SMS'
		);
		c.phone = {
			provider: 'sinch',
			region,
			verification: {
				key: needs('BOLT_SINCH_VERIFICATION_KEY', 'BOLT_TRANSACTIONAL_PHONE=sinch'),
				secret: needs('BOLT_SINCH_VERIFICATION_SECRET', 'BOLT_TRANSACTIONAL_PHONE=sinch')
			},
			...(sms
				? {
						sms: {
							planId: needs('BOLT_SINCH_SMS_PLAN_ID', 'Sinch SMS'),
							token: needs('BOLT_SINCH_SMS_TOKEN', 'Sinch SMS'),
							from: needs('BOLT_SINCH_SMS_FROM', 'Sinch SMS')
						}
					}
				: {})
		};
	}

	return c.email === undefined && c.phone === undefined ? null : c;
}

export type StartFlags = {
	readonly port?: number;
	readonly trustProxy?: string;
	readonly accept?: boolean;
	readonly founder?: string;
	readonly seed?: string;
	readonly dev?: boolean;
};
function decodeValues(
	values: Readonly<Record<string, string | undefined>>,
	options: StartFlags
): Config {
	const get = (name: string) => {
		const value = values[name];
		return value === undefined || value.trim() === '' ? undefined : value.trim();
	};
	const flags = {
		trustProxy: options.trustProxy === undefined ? [] : cidrs(options.trustProxy),
		accept: options.accept ?? false,
		founder: options.founder ?? null,
		seed: options.seed ?? null,
		dev: options.dev ?? false
	};

	const artifact = get('BOLT_ARTIFACT');
	if (artifact === undefined) throw new ConfigError({ message: 'BOLT_ARTIFACT is required' });
	const port = options.port ?? Number(get('BOLT_PORT') ?? 3100);
	if (!Number.isInteger(port) || port < 0 || port > 65_535)
		throw new ConfigError({ message: 'BOLT_PORT is not a port' });

	const url = get('BOLT_DATABASE_URL'),
		pglite = get('BOLT_PGLITE_DIR');
	if ((url === undefined) === (pglite === undefined))
		throw new ConfigError({ message: 'set exactly one of BOLT_DATABASE_URL and BOLT_PGLITE_DIR' });

	const origin = get('BOLT_PUBLIC_URL');
	if (origin === undefined) throw new ConfigError({ message: 'BOLT_PUBLIC_URL is required' });
	const parsedPublicUrl = Result.try(() => new URL(origin));
	if (Result.isFailure(parsedPublicUrl))
		throw new ConfigError({ message: 'BOLT_PUBLIC_URL is not a URL' });
	const pub = parsedPublicUrl.success;
	if (
		pub.pathname !== '/' ||
		pub.search !== '' ||
		pub.hash !== '' ||
		pub.username !== '' ||
		/\/./.test(origin.replace(/^[a-z]+:\/\//i, ''))
	)
		throw new ConfigError({
			message: 'BOLT_PUBLIC_URL is an origin: scheme, host and optional port, no path'
		});
	if (pub.protocol !== 'https:' && !(pub.protocol === 'http:' && LOOPBACK(pub.hostname)))
		throw new ConfigError({
			message: 'BOLT_PUBLIC_URL must be https:// unless its host is loopback (PRESERVATION R2)'
		});

	const devRaw = get('BOLT_DEV');
	if (devRaw !== undefined && devRaw !== '1' && devRaw !== '0')
		throw new ConfigError({ message: 'BOLT_DEV is 1 or 0' });
	flags.dev ||= devRaw === '1';
	if (flags.dev && (!LOOPBACK(pub.hostname) || get('BOLT_ENVIRONMENT') === 'production'))
		throw new ConfigError({
			message:
				'--dev (BOLT_DEV) runs only on a loopback BOLT_PUBLIC_URL, never with BOLT_ENVIRONMENT=production'
		});

	const filesProvider = get('BOLT_FILES_PROVIDER');
	let files: Config['files'] = null;
	if (filesProvider === 'local') {
		const root = get('BOLT_FILES_ENDPOINT');
		if (root === undefined)
			throw new ConfigError({
				message: 'BOLT_FILES_PROVIDER=local needs BOLT_FILES_ENDPOINT, a directory'
			});
		files = { provider: 'local', root };
	} else if (filesProvider === 's3') {
		const endpoint = get('BOLT_FILES_ENDPOINT'),
			credential = get('BOLT_FILES_CREDENTIAL');
		if (endpoint === undefined || !/^https?:\/\//.test(endpoint))
			throw new ConfigError({
				message: 'BOLT_FILES_PROVIDER=s3 needs BOLT_FILES_ENDPOINT, the bucket URL'
			});
		if (credential === undefined || !/^[^:]+:.+$/.test(credential))
			throw new ConfigError({
				message: 'BOLT_FILES_PROVIDER=s3 needs BOLT_FILES_CREDENTIAL as <access key id>:<secret>'
			});
		files = { provider: 's3', endpoint, credential };
	} else if (filesProvider !== undefined)
		throw new ConfigError({
			message: `BOLT_FILES_PROVIDER '${filesProvider}' is not registered on this host (local, s3)`
		});

	const providers: { [F in Facility]?: Provider } = {};
	for (const f of FACILITIES) {
		const provider = get(`BOLT_${f}_PROVIDER`),
			endpoint = get(`BOLT_${f}_ENDPOINT`),
			credential = get(`BOLT_${f}_CREDENTIAL`);
		if (provider === undefined) {
			if (endpoint !== undefined || credential !== undefined)
				throw new ConfigError({
					message: `BOLT_${f}_ENDPOINT/CREDENTIAL without BOLT_${f}_PROVIDER`
				});
			continue;
		}
		if (!REGISTERED[f].includes(provider))
			throw new ConfigError({
				message: `BOLT_${f}_PROVIDER '${provider}' is not registered on this host (${REGISTERED[f].join(', ') || 'none'})`
			});
		providers[f] = {
			provider,
			...(endpoint === undefined ? {} : { endpoint }),
			...(credential === undefined ? {} : { credential })
		};
	}

	if (
		providers.CONVERT !== undefined &&
		(providers.CONVERT.endpoint === undefined || providers.CONVERT.credential === undefined)
	)
		throw new ConfigError({
			message:
				"BOLT_CONVERT_PROVIDER needs BOLT_CONVERT_ENDPOINT, the service's URL, and BOLT_CONVERT_CREDENTIAL, its API key"
		});
	// both systems or neither (P35); embeddings only beside them
	if ((providers.AI_SYS_1 === undefined) !== (providers.AI_SYS_2 === undefined))
		throw new ConfigError({
			message:
				'the AI facility needs both BOLT_AI_SYS_1_PROVIDER (sys_1) and BOLT_AI_SYS_2_PROVIDER (sys_2), or neither'
		});
	if (providers.AI_EMBED !== undefined && providers.AI_SYS_2 === undefined)
		throw new ConfigError({
			message: 'BOLT_AI_EMBED_PROVIDER needs BOLT_AI_SYS_1_PROVIDER and BOLT_AI_SYS_2_PROVIDER'
		});
	const sys1 = get('BOLT_AI_SYS_1_MODEL') ?? null;
	if (providers.AI_SYS_1 !== undefined && sys1 === null)
		throw new ConfigError({
			message: 'BOLT_AI_SYS_1_PROVIDER needs BOLT_AI_SYS_1_MODEL, the sys_1 model id'
		});
	if (
		providers.AI_SYS_1?.provider === 'decisions' &&
		(providers.AI_SYS_1.endpoint === undefined || providers.AI_SYS_1.credential === undefined)
	)
		throw new ConfigError({
			message:
				'BOLT_AI_SYS_1_PROVIDER=decisions needs BOLT_AI_SYS_1_ENDPOINT, the Decisions API URL, and BOLT_AI_SYS_1_CREDENTIAL'
		});
	const jsonMap = <A>(name: string, schema: Schema.Decoder<A>): A => {
		const raw = get(name) ?? '{}';
		const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(schema))(raw);
		if (Option.isNone(decoded))
			throw new ConfigError({ message: `${name} does not match its JSON schema` });
		return decoded.value;
	};
	const sys2 = jsonMap('BOLT_AI_SYS_2_MODELS', Schema.Record(Schema.String, Schema.NonEmptyString));
	const embed = jsonMap(
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
		)
	);

	const modalities = (name: string): readonly Modality[] | null => {
		const raw = get(name);
		if (raw === undefined) return null;
		const list = raw
			.split(',')
			.map((x) => x.trim())
			.filter((x) => x !== '');
		if (!list.every((x) => MODALITIES.has(x)))
			throw new ConfigError({ message: `${name} is a comma list of text, image, file` });
		return Schema.decodeUnknownSync(Schema.Array(Schema.Literals(['text', 'image', 'file'])))(list);
	};

	const transcribe = get('BOLT_AI_TRANSCRIBE_MODEL') ?? null,
		speak = get('BOLT_AI_SPEAK_MODEL') ?? null,
		voice = get('BOLT_AI_SPEAK_VOICE') ?? null;
	const sp = providers.AI_SPEECH;
	if (sp === undefined && (transcribe ?? speak ?? voice) !== null)
		throw new ConfigError({
			message:
				'BOLT_AI_TRANSCRIBE_MODEL, BOLT_AI_SPEAK_MODEL and BOLT_AI_SPEAK_VOICE need BOLT_AI_SPEECH_PROVIDER=openrouter'
		});
	if (sp !== undefined && sp.credential === undefined)
		throw new ConfigError({
			message: 'BOLT_AI_SPEECH_PROVIDER needs BOLT_AI_SPEECH_CREDENTIAL, the API key'
		});
	if (sp !== undefined && transcribe === null && speak === null)
		throw new ConfigError({
			message: 'BOLT_AI_SPEECH_PROVIDER needs BOLT_AI_TRANSCRIBE_MODEL or BOLT_AI_SPEAK_MODEL'
		});

	const googleId = get('BOLT_GOOGLE_OAUTH_CLIENT_ID'),
		googleSecret = get('BOLT_GOOGLE_OAUTH_CLIENT_SECRET');
	if ((googleId === undefined) !== (googleSecret === undefined))
		throw new ConfigError({
			message:
				'set both BOLT_GOOGLE_OAUTH_CLIENT_ID and BOLT_GOOGLE_OAUTH_CLIENT_SECRET, or neither'
		});
	const vpub = get('BOLT_VAPID_PUBLIC_KEY'),
		vpriv = get('BOLT_VAPID_PRIVATE_KEY');
	if ((vpub === undefined) !== (vpriv === undefined))
		throw new ConfigError({
			message: 'set both BOLT_VAPID_PUBLIC_KEY and BOLT_VAPID_PRIVATE_KEY, or neither'
		});
	const apns = jsonMap(
		'BOLT_APNS_KEYS',
		Schema.Record(
			Schema.String,
			Schema.Struct({ keyId: Schema.NonEmptyString, key: Schema.NonEmptyString })
		)
	);
	const tsite = get('BOLT_TURNSTILE_SITE_KEY'),
		tsecret = get('BOLT_TURNSTILE_SECRET');
	if ((tsite === undefined) !== (tsecret === undefined))
		throw new ConfigError({
			message: 'set both BOLT_TURNSTILE_SITE_KEY and BOLT_TURNSTILE_SECRET, or neither'
		});

	return {
		artifact,
		host: get('BOLT_HOST') ?? '127.0.0.1',
		port,
		database: url !== undefined ? { url } : { pglite: pglite ?? '' },
		publicUrl: pub.origin,
		files,
		masterKey: key32('BOLT_MASTER_KEY', get('BOLT_MASTER_KEY')),
		opsKey: key32('BOLT_OPS_KEY', get('BOLT_OPS_KEY')),
		googleOAuth: googleId === undefined ? null : { id: googleId, secret: googleSecret ?? '' },
		transactional: transactional(get, pub.hostname),
		mode: flags.dev
			? 'dev'
			: LOOPBACK(pub.hostname) && get('BOLT_ENVIRONMENT') !== 'production'
				? 'local'
				: 'production',
		providers,
		ai: {
			sys1,
			sys2,
			embed,
			modalities: {
				sys2: modalities('BOLT_AI_SYS_2_MODALITIES'),
				embed: modalities('BOLT_AI_EMBED_MODALITIES')
			}
		},
		speech:
			sp === undefined
				? null
				: {
						endpoint: sp.endpoint ?? 'https://openrouter.ai/api/v1',
						credential: sp.credential ?? '',
						transcribe,
						speak,
						voice
					},
		vapid: vpub === undefined ? null : { publicKey: vpub, privateKey: vpriv ?? '' },
		apns,
		turnstile: tsite === undefined ? null : { siteKey: tsite, secret: tsecret ?? '' },
		environment: get('BOLT_ENVIRONMENT') ?? null,
		trustProxy: flags.trustProxy,
		accept: flags.accept,
		founder: flags.founder,
		seed: flags.seed
	};
}

const secretName = (name: string) => /(?:KEYS?|SECRET|TOKEN|CREDENTIAL|ACC_SID)$/.test(name);
/** Configuration reads belong to Effect Config; secret reads stay redacted until the native adapter consumes them. */
export const BoltConfig = (flags: StartFlags = {}) =>
	Effect.gen(function* () {
		const provider = yield* ConfigProvider.ConfigProvider;
		const keys = (
			path: readonly string[]
		): Effect.Effect<readonly string[], ConfigProvider.SourceError> =>
			Effect.gen(function* () {
				const node = yield* provider.load(path);
				if (node === undefined) return [];
				const own = node.value === undefined ? [] : [path.join('_')];
				if (node._tag !== 'Record') return own;
				const children = yield* Effect.forEach(
					[...node.keys].filter(
						(name) => path.length !== 0 || name === 'BOLT' || name.startsWith('BOLT_')
					),
					(name) => keys([...path, name])
				);
				return [...own, ...children.flat()];
			});
		const unknown = (yield* keys([])).filter(
			(name) => name.startsWith('BOLT_') && !KNOWN.has(name)
		);
		if (unknown.length > 0)
			return yield* Effect.fail(
				new ConfigError({ message: `unknown configuration: ${unknown.sort().join(', ')}` })
			);
		const entries = yield* Effect.forEach([...KNOWN], (name) =>
			(secretName(name)
				? EffectConfig.option(EffectConfig.redacted(name)).pipe(
						Effect.map((value) => (Option.isNone(value) ? undefined : Redacted.value(value.value)))
					)
				: EffectConfig.option(EffectConfig.string(name)).pipe(Effect.map(Option.getOrUndefined))
			).pipe(Effect.map((value) => [name, value] as const))
		);
		return yield* Effect.try({
			try: () => decodeValues(Object.fromEntries(entries), flags),
			catch: (error) =>
				error instanceof ConfigError ? error : new ConfigError({ message: String(error) })
		});
	});
