// `bolt start` configuration (§5.11.6): one decoded set of `BOLT_*` names plus four flags. Anything wrong here refuses
// to start (a thrown `ConfigError`); what depends on the workspace (mail, files, secrets, turnstile, AI models) is
// checked at activation, against the manifest, by `server.ts`.
import { isIP } from 'node:net';

export class ConfigError extends Error {
	constructor(message: string) { super(message); this.name = 'ConfigError'; }
}

/** One optional facility's selection: a provider name from the host's registered factories (L-BOLT-908). */
export type Provider = { provider: string; endpoint?: string; credential?: string };
export const FACILITIES = ['AI_SYS_1', 'AI_SYS_2', 'AI_EMBED', 'GEO', 'RENDER', 'WEB', 'WHATSAPP', 'TELEGRAM', 'EMAIL_IN'] as const;
export type Facility = (typeof FACILITIES)[number];
/** Each facility's registered factories; any other name refuses to start. */
export const REGISTERED: { readonly [F in Facility]: readonly string[] } = {
	AI_SYS_1: ['openai', 'decisions'], AI_SYS_2: ['openai'], AI_EMBED: ['openai'], GEO: ['nominatim'], RENDER: [], WEB: ['public'], WHATSAPP: ['baileys'], TELEGRAM: ['bot'], EMAIL_IN: ['resend'],
};
export type AiModel = string | { model: string; inputs?: number; tokens?: number };
export type Modality = 'text' | 'image' | 'file';
const MODALITIES = new Set(['text', 'image', 'file']);

export type Config = {
	artifact: string; host: string; port: number;
	database: { url: string } | { pglite: string };
	publicUrl: string;
	files: { provider: 'local'; root: string } | { provider: 's3'; endpoint: string; credential: string } | null;
	masterKey: Buffer | null; opsKey: Buffer | null;
	mail: string | null;
	providers: { readonly [F in Facility]?: Provider };
	/**
	 * The AI facility (P35, P39): `sys1` the `BOLT_AI_SYS_1_MODEL` id (`BOLT_AI_SYS_1_PROVIDER=openai`: a structured-output
	 * chat model; `decisions`: OpenRouter's Decisions API, `BOLT_AI_SYS_1_ENDPOINT` its full URL); `sys2` each model class → model id
	 * (`BOLT_AI_SYS_2_MODELS`); `embed` each embedding name → model (`BOLT_AI_EMBED_MODELS`); `modalities` the operator's
	 * declarations (`BOLT_AI_SYS_2_MODALITIES`, `BOLT_AI_EMBED_MODALITIES`), read only where the provider publishes none.
	 */
	ai: { sys1: string | null; sys2: { readonly [modelClass: string]: string }; embed: { readonly [embedding: string]: AiModel };
		modalities: { sys2: readonly Modality[] | null; embed: readonly Modality[] | null } };
	vapid: { publicKey: string; privateKey: string } | null;
	turnstile: { siteKey: string; secret: string } | null;
	telemetryRetainHours: number;
	/** `BOLT_ENVIRONMENT` (`production`, `staging`, `development`, …): every other than production shows the shell's badge. */
	environment: string | null;
	/** `--trust-proxy`, `--accept`, `--founder`, `--seed`. */
	trustProxy: readonly string[]; accept: boolean; founder: string | null; seed: string | null;
	/**
	 * `--dev` or `BOLT_DEV=1` (L-BOLT-366): `bolt start` as `bolt dev` (the dev mail sink, destructive steps accepted, the
	 * dev Turnstile) and connections may reach a provider on this machine (`*.localhost`). Refused unless the public origin
	 * is loopback and `BOLT_ENVIRONMENT` is not `production`.
	 */
	dev: boolean;
};

const KNOWN = new Set([
	'BOLT_ARTIFACT', 'BOLT_HOST', 'BOLT_PORT', 'BOLT_DATABASE_URL', 'BOLT_PGLITE_DIR', 'BOLT_PUBLIC_URL',
	'BOLT_FILES_PROVIDER', 'BOLT_FILES_ENDPOINT', 'BOLT_FILES_CREDENTIAL', 'BOLT_MASTER_KEY', 'BOLT_OPS_KEY', 'BOLT_MAIL',
	...FACILITIES.flatMap((f) => [`BOLT_${f}_PROVIDER`, `BOLT_${f}_ENDPOINT`, `BOLT_${f}_CREDENTIAL`]),
	'BOLT_AI_SYS_1_MODEL', 'BOLT_AI_SYS_2_MODELS', 'BOLT_AI_EMBED_MODELS', 'BOLT_AI_SYS_2_MODALITIES', 'BOLT_AI_EMBED_MODALITIES', 'BOLT_VAPID_PUBLIC_KEY', 'BOLT_VAPID_PRIVATE_KEY', 'BOLT_TURNSTILE_SITE_KEY', 'BOLT_TURNSTILE_SECRET',
	'BOLT_TELEMETRY_RETAIN_HOURS', 'BOLT_ENVIRONMENT', 'BOLT_DEV',
]);

const LOOPBACK = (host: string) => host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';

/** A 32-byte key as 64 hex digits or base64; anything else fails boot (§5.11.4). */
function key32(name: string, v: string | undefined): Buffer | null {
	if (v === undefined) return null;
	const b = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
	if (b.length !== 32) throw new ConfigError(`${name} is not a 32-byte key (64 hex digits or base64)`);
	return b;
}

function cidrs(list: string): string[] {
	return list.split(',').map((s) => s.trim()).filter((s) => s !== '').map((c) => {
		const [net, bits] = c.split('/') as [string, string | undefined];
		const v = isIP(net);
		const max = v === 6 ? 128 : 32;
		if (v === 0 || (bits !== undefined && !(/^\d+$/.test(bits) && Number(bits) <= max))) throw new ConfigError(`--trust-proxy: '${c}' is not a CIDR`);
		return c;
	});
}

export function decodeConfig(env: { readonly [name: string]: string | undefined }, argv: readonly string[] = []): Config {
	const unknown = Object.keys(env).filter((k) => k.startsWith('BOLT_') && !KNOWN.has(k));
	if (unknown.length > 0) throw new ConfigError(`unknown configuration: ${unknown.sort().join(', ')}`);
	const get = (k: string) => { const v = env[k]; return v === undefined || v.trim() === '' ? undefined : v.trim(); };

	const flags = { trustProxy: [] as string[], accept: false, founder: null as string | null, seed: null as string | null, dev: false };
	for (const a of argv) {
		const [flag, value] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
		if (flag === '--accept' && value === undefined) flags.accept = true;
		else if (flag === '--dev' && value === undefined) flags.dev = true;
		else if (flag === '--trust-proxy' && value !== undefined) flags.trustProxy = cidrs(value);
		else if (flag === '--founder' && value !== undefined && /^[^@\s]+@[^@\s]+$/.test(value)) flags.founder = value;
		else if (flag === '--seed' && value !== undefined && value !== '') flags.seed = value;
		else throw new ConfigError(`unknown or malformed flag '${a}'`);
	}

	const artifact = get('BOLT_ARTIFACT');
	if (artifact === undefined) throw new ConfigError('BOLT_ARTIFACT is required');
	const port = Number(get('BOLT_PORT') ?? 3100);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new ConfigError('BOLT_PORT is not a port');

	const url = get('BOLT_DATABASE_URL'), pglite = get('BOLT_PGLITE_DIR');
	if ((url === undefined) === (pglite === undefined)) throw new ConfigError('set exactly one of BOLT_DATABASE_URL and BOLT_PGLITE_DIR');

	const origin = get('BOLT_PUBLIC_URL');
	if (origin === undefined) throw new ConfigError('BOLT_PUBLIC_URL is required');
	let pub: URL;
	try { pub = new URL(origin); } catch { throw new ConfigError('BOLT_PUBLIC_URL is not a URL'); }
	if (pub.pathname !== '/' || pub.search !== '' || pub.hash !== '' || pub.username !== '' || /\/./.test(origin.replace(/^[a-z]+:\/\//i, '')))
		throw new ConfigError('BOLT_PUBLIC_URL is an origin: scheme, host and optional port, no path');
	if (pub.protocol !== 'https:' && !(pub.protocol === 'http:' && LOOPBACK(pub.hostname)))
		throw new ConfigError('BOLT_PUBLIC_URL must be https:// unless its host is loopback (PRESERVATION R2)');

	const devRaw = get('BOLT_DEV');
	if (devRaw !== undefined && devRaw !== '1' && devRaw !== '0') throw new ConfigError('BOLT_DEV is 1 or 0');
	flags.dev ||= devRaw === '1';
	if (flags.dev && (!LOOPBACK(pub.hostname) || get('BOLT_ENVIRONMENT') === 'production'))
		throw new ConfigError('--dev (BOLT_DEV) runs only on a loopback BOLT_PUBLIC_URL, never with BOLT_ENVIRONMENT=production');

	const filesProvider = get('BOLT_FILES_PROVIDER');
	let files: Config['files'] = null;
	if (filesProvider === 'local') {
		const root = get('BOLT_FILES_ENDPOINT');
		if (root === undefined) throw new ConfigError('BOLT_FILES_PROVIDER=local needs BOLT_FILES_ENDPOINT, a directory');
		files = { provider: 'local', root };
	} else if (filesProvider === 's3') {
		const endpoint = get('BOLT_FILES_ENDPOINT'), credential = get('BOLT_FILES_CREDENTIAL');
		if (endpoint === undefined || !/^https?:\/\//.test(endpoint)) throw new ConfigError('BOLT_FILES_PROVIDER=s3 needs BOLT_FILES_ENDPOINT, the bucket URL');
		if (credential === undefined || !/^[^:]+:.+$/.test(credential)) throw new ConfigError('BOLT_FILES_PROVIDER=s3 needs BOLT_FILES_CREDENTIAL as <access key id>:<secret>');
		files = { provider: 's3', endpoint, credential };
	} else if (filesProvider !== undefined) throw new ConfigError(`BOLT_FILES_PROVIDER '${filesProvider}' is not registered on this host (local, s3)`);

	const providers: { [F in Facility]?: Provider } = {};
	for (const f of FACILITIES) {
		const provider = get(`BOLT_${f}_PROVIDER`), endpoint = get(`BOLT_${f}_ENDPOINT`), credential = get(`BOLT_${f}_CREDENTIAL`);
		if (provider === undefined) {
			if (endpoint !== undefined || credential !== undefined) throw new ConfigError(`BOLT_${f}_ENDPOINT/CREDENTIAL without BOLT_${f}_PROVIDER`);
			continue;
		}
		if (!REGISTERED[f].includes(provider)) throw new ConfigError(`BOLT_${f}_PROVIDER '${provider}' is not registered on this host (${REGISTERED[f].join(', ') || 'none'})`);
		providers[f] = { provider, ...(endpoint === undefined ? {} : { endpoint }), ...(credential === undefined ? {} : { credential }) };
	}

	// both systems or neither (P35); embeddings only beside them
	if ((providers.AI_SYS_1 === undefined) !== (providers.AI_SYS_2 === undefined))
		throw new ConfigError('the AI facility needs both BOLT_AI_SYS_1_PROVIDER (sys_1) and BOLT_AI_SYS_2_PROVIDER (sys_2), or neither');
	if (providers.AI_EMBED !== undefined && providers.AI_SYS_2 === undefined) throw new ConfigError('BOLT_AI_EMBED_PROVIDER needs BOLT_AI_SYS_1_PROVIDER and BOLT_AI_SYS_2_PROVIDER');
	const sys1 = get('BOLT_AI_SYS_1_MODEL') ?? null;
	if (providers.AI_SYS_1 !== undefined && sys1 === null) throw new ConfigError('BOLT_AI_SYS_1_PROVIDER needs BOLT_AI_SYS_1_MODEL, the sys_1 model id');
	if (providers.AI_SYS_1?.provider === 'decisions' && (providers.AI_SYS_1.endpoint === undefined || providers.AI_SYS_1.credential === undefined))
		throw new ConfigError('BOLT_AI_SYS_1_PROVIDER=decisions needs BOLT_AI_SYS_1_ENDPOINT, the Decisions API URL, and BOLT_AI_SYS_1_CREDENTIAL');
	const map = <V>(name: string, ok: (v: unknown) => boolean, shape: string): { readonly [k: string]: V } => {
		const raw = get(name);
		if (raw === undefined) return {};
		let parsed: unknown;
		try { parsed = JSON.parse(raw); } catch { throw new ConfigError(`${name} is not JSON`); }
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !Object.values(parsed).every(ok)) throw new ConfigError(`${name} maps ${shape}`);
		return parsed as { readonly [k: string]: V };
	};
	const id = (v: unknown) => typeof v === 'string' && v !== '';
	const sys2 = map<string>('BOLT_AI_SYS_2_MODELS', id, 'each model class to a model id');
	const embed = map<AiModel>('BOLT_AI_EMBED_MODELS', (v) => id(v) || (typeof v === 'object' && v !== null && typeof (v as { model?: unknown }).model === 'string'),
		'each embedding name to a model id or { model, inputs?, tokens? }');
	const modalities = (name: string): Modality[] | null => {
		const raw = get(name);
		if (raw === undefined) return null;
		const list = raw.split(',').map((x) => x.trim()).filter((x) => x !== '');
		if (!list.every((x) => MODALITIES.has(x))) throw new ConfigError(`${name} is a comma list of text, image, file`);
		return list as Modality[];
	};

	const vpub = get('BOLT_VAPID_PUBLIC_KEY'), vpriv = get('BOLT_VAPID_PRIVATE_KEY');
	if ((vpub === undefined) !== (vpriv === undefined)) throw new ConfigError('set both BOLT_VAPID_PUBLIC_KEY and BOLT_VAPID_PRIVATE_KEY, or neither');
	const tsite = get('BOLT_TURNSTILE_SITE_KEY'), tsecret = get('BOLT_TURNSTILE_SECRET');
	if ((tsite === undefined) !== (tsecret === undefined)) throw new ConfigError('set both BOLT_TURNSTILE_SITE_KEY and BOLT_TURNSTILE_SECRET, or neither');
	const retain = Number(get('BOLT_TELEMETRY_RETAIN_HOURS') ?? 72);
	if (!Number.isInteger(retain) || retain < 1) throw new ConfigError('BOLT_TELEMETRY_RETAIN_HOURS is a positive integer');

	return {
		artifact, host: get('BOLT_HOST') ?? '127.0.0.1', port,
		database: url !== undefined ? { url } : { pglite: pglite! },
		publicUrl: pub.origin, files,
		masterKey: key32('BOLT_MASTER_KEY', get('BOLT_MASTER_KEY')), opsKey: key32('BOLT_OPS_KEY', get('BOLT_OPS_KEY')),
		mail: get('BOLT_MAIL') ?? null, providers,
		ai: { sys1, sys2, embed, modalities: { sys2: modalities('BOLT_AI_SYS_2_MODALITIES'), embed: modalities('BOLT_AI_EMBED_MODALITIES') } },
		vapid: vpub === undefined ? null : { publicKey: vpub, privateKey: vpriv! },
		turnstile: tsite === undefined ? null : { siteKey: tsite, secret: tsecret! },
		telemetryRetainHours: retain, environment: get('BOLT_ENVIRONMENT') ?? null, ...flags,
	};
}
