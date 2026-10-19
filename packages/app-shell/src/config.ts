import { Effect, FileSystem, Path, Schema } from 'effect';
import { pathToFileURL } from 'node:url';

/** An app configuration that does not decode, or a config file that does not load. */
export class AppConfigInvalid extends Schema.TaggedError<AppConfigInvalid>()('AppConfigInvalid', {
	message: Schema.String
}) {}

/** Hosts a development build may reach over plain HTTP: the machine itself (`*.localhost` is loopback by RFC 6761,
 * as a local host's tenant subdomains are) and the Android emulator's host alias. */
const DEVELOPMENT_HOSTS: ReadonlyArray<string> = ['localhost', '127.0.0.1', '10.0.2.2'];
const development = (host: string) =>
	DEVELOPMENT_HOSTS.includes(host) || host.endsWith('.localhost');

/** Why `value` cannot be an app address named `field`, or `undefined` when it can. */
const addressProblem = (field: string, value: string): string | undefined => {
	const url = URL.parse(value);
	if (url === null) return `${field} must be an absolute URL`;
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && development(url.hostname)))
		return `${field} must use https (http is allowed only for ${DEVELOPMENT_HOSTS.join(', ')} and *.localhost)`;
	if (url.username !== '' || url.password !== '') return `${field} must not carry credentials`;
	if (url.search !== '' || url.hash !== '') return `${field} must not carry a query or fragment`;
	return undefined;
};

/** Why `value` cannot be a host origin, or `undefined` when it can. */
const hostProblem = (value: string): string | undefined =>
	addressProblem('host', value) ??
	(URL.parse(value)?.origin === value
		? undefined
		: 'host must be an origin: lowercase scheme, host and optional port, with no path or trailing slash');

/**
 * True when `url` is on an origin `host` trusts: the host origin itself, or the same scheme and port on a subdomain
 * of the host's hostname. The native layers and the device runtime apply the same rule.
 */
export const onHost = (host: URL, url: URL): boolean =>
	url.protocol === host.protocol &&
	url.port === host.port &&
	(url.hostname === host.hostname || url.hostname.endsWith(`.${host.hostname}`));

const Hex = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/));
const Purpose = Schema.NonEmptyString;
/** A host name, or `*.` and a host name for its subdomains. */
const Host = Schema.String.check(
	Schema.isPattern(
		/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
	)
);

const Fields = Schema.Struct({
	/** The iOS bundle id and the Android application id. Java package rules: dot-separated identifiers. */
	id: Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/)),
	name: Schema.NonEmptyString,
	description: Schema.String,
	/** The store version, `major.minor.patch`. */
	version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/)),
	/** The monotonically increasing build number (iOS CFBundleVersion, Android versionCode). */
	build: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
	/** A 1024×1024 PNG, relative to the app directory. */
	icon: Schema.NonEmptyString,
	splash: Schema.optionalKey(
		Schema.Struct({ color: Hex, image: Schema.optionalKey(Schema.NonEmptyString) })
	),
	themeColor: Schema.optionalKey(Hex),
	/** The server the app belongs to, as an origin: a Norbital platform origin or a self-hosted Bolt server. */
	host: Schema.String.check(Schema.makeFilter(hostProblem)),
	/**
	 * Pins the app to one workspace page, path included, e.g. `https://t-abc.workspaces.norbital.ai/apps/cleaner`.
	 * Unset, the app starts at `host` and moves between every workspace on it.
	 */
	workspace: Schema.optionalKey(
		Schema.String.check(Schema.makeFilter((value: string) => addressProblem('workspace', value)))
	),
	/** Extra hosts the WebView may stay on; everything else opens in the system browser. */
	allowNavigation: Schema.optionalKey(Schema.Array(Host)),
	capabilities: Schema.Struct({
		location: Schema.optionalKey(Schema.Struct({ background: Schema.Boolean, purpose: Purpose })),
		notifications: Schema.optionalKey(Schema.Boolean),
		camera: Schema.optionalKey(Schema.Struct({ purpose: Purpose }))
	}),
	ios: Schema.Struct({
		teamId: Schema.String.check(Schema.isPattern(/^[A-Z0-9]{10}$/)),
		apsEnvironment: Schema.Literals(['development', 'production'])
	}),
	android: Schema.Struct({
		/** A PEM certificate authority the debug build also trusts (a local HTTPS host); release builds never carry it. */
		debugCa: Schema.optionalKey(Schema.NonEmptyString)
	})
});

export const AppConfig = Fields.check(
	Schema.makeFilter((config: typeof Fields.Type) =>
		config.workspace === undefined || onHost(new URL(config.host), new URL(config.workspace))
			? undefined
			: `workspace ${config.workspace} is not on host ${config.host} or one of its subdomains`
	)
);
export type AppConfig = typeof AppConfig.Type;

/** Types a `norbital.app.ts` default export; the CLI validates it when it loads the file. */
export const defineApp = (config: typeof AppConfig.Encoded): typeof AppConfig.Encoded => config;

const decodeApp = (input: unknown) =>
	Schema.decodeUnknownEffect(AppConfig)(input).pipe(
		Effect.mapError((error) => new AppConfigInvalid({ message: error.message }))
	);

const CONFIG_FILES = ['norbital.app.ts', 'norbital.app.json'] as const;

const Module = Schema.Struct({ default: Schema.Unknown });

/** The decoded configuration of the app in `directory`. */
export const loadApp = Effect.fn('AppShell.loadApp')(
	function* (directory: string) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		for (const name of CONFIG_FILES) {
			const file = path.join(directory, name);
			if (!(yield* fs.exists(file))) continue;
			const input =
				name === 'norbital.app.json'
					? yield* fs
							.readFileString(file)
							.pipe(
								Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown)))
							)
					: yield* Effect.tryPromise((): Promise<unknown> => import(pathToFileURL(file).href)).pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Module)),
							Effect.map((module) => module.default)
						);
			return yield* decodeApp(input).pipe(
				Effect.mapError((error) => new AppConfigInvalid({ message: `${file}: ${error.message}` }))
			);
		}
		return yield* new AppConfigInvalid({
			message: `${directory} has no ${CONFIG_FILES.join(' or ')}; run \`norbital-app init\`.`
		});
	},
	Effect.mapError((error) =>
		error instanceof AppConfigInvalid ? error : new AppConfigInvalid({ message: error.message })
	)
);
