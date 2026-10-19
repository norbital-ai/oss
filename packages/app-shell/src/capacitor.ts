import type { AppConfig } from './config.ts';

/** The `NorbitalShell` plugin configuration the native navigation policy and push registration read. */
type ShellPluginConfig = {
	readonly host: string;
	readonly workspace?: string;
	readonly pinned: boolean;
	readonly allowNavigation: ReadonlyArray<string>;
	readonly teamId: string;
	readonly apsEnvironment: 'development' | 'production';
};

/** The subset of Capacitor's `CapacitorConfig` this shell writes as `capacitor.config.json`. */
type CapacitorConfig = {
	readonly appId: string;
	readonly appName: string;
	readonly webDir: string;
	readonly backgroundColor?: string;
	readonly appendUserAgent: string;
	readonly android: { readonly path: string; readonly useLegacyBridge: false };
	readonly ios: { readonly path: string };
	readonly server: {
		readonly url: string;
		readonly appStartPath?: string;
		readonly allowNavigation: ReadonlyArray<string>;
		readonly errorPath: string;
		readonly cleartext?: true;
	};
	readonly plugins: {
		readonly Keyboard: { readonly resize: 'native' };
		readonly NorbitalShell: ShellPluginConfig;
	};
};

const USER_AGENT = 'NorbitalApp/1';
const OFFLINE_PAGE = 'offline.html';

/** True when the host is a development server reached over plain HTTP. */
export const cleartext = (config: AppConfig) => new URL(config.host).protocol === 'http:';

/** The address the app opens: the pinned workspace page, or the host. */
const start = (config: AppConfig) => new URL(config.workspace ?? config.host);

/** True when the WebView also trusts the host's subdomains: an unpinned app on a named host (an IP has none). */
const subdomains = (config: AppConfig) =>
	config.workspace === undefined && !/^[\d.]+$|^\[/.test(new URL(config.host).hostname);

const shellPluginConfig = (config: AppConfig): ShellPluginConfig => ({
	host: config.host,
	...(config.workspace === undefined ? {} : { workspace: config.workspace }),
	pinned: config.workspace !== undefined,
	allowNavigation: config.allowNavigation ?? [],
	teamId: config.ios.teamId,
	apsEnvironment: config.ios.apsEnvironment
});

/**
 * The Capacitor configuration for an app. The native projects live beside it in `ios/` and `android/`, the
 * offline fallback in `www/`. Capacitor routes by host mask (`*.` matches one label); an origin on a non-default port
 * or plain HTTP also needs its explicit origin rule for Android's bridge. An unpinned app adds the host's subdomains.
 */
export const capacitorConfig = (config: AppConfig): CapacitorConfig => {
	const origin = start(config);
	const port = origin.port === '' ? '' : `:${origin.port}`;
	const wildcard = subdomains(config);
	const background = config.splash?.color ?? config.themeColor;
	return {
		appId: config.id,
		appName: config.name,
		webDir: 'www',
		...(background === undefined ? {} : { backgroundColor: background }),
		appendUserAgent: USER_AGENT,
		android: { path: 'android', useLegacyBridge: false },
		ios: { path: 'ios' },
		server: {
			url: config.workspace ?? config.host,
			allowNavigation: [
				origin.hostname,
				...(wildcard ? [`*.${origin.hostname}`] : []),
				...(origin.protocol === 'https:' && origin.port === ''
					? []
					: [
							origin.origin,
							...(wildcard ? [`${origin.protocol}//*.${origin.hostname}${port}`] : [])
						]),
				...(config.allowNavigation ?? [])
			],
			errorPath: OFFLINE_PAGE,
			...(cleartext(config) ? { cleartext: true } : {})
		},
		plugins: {
			Keyboard: { resize: 'native' },
			NorbitalShell: shellPluginConfig(config)
		}
	};
};

/**
 * Android's copy: Capacitor Android also registers `server.url` as a WebView origin rule, which may not carry a path —
 * a refused rule silently drops its native bridge — so Android loads the origin and starts at the path. iOS keeps the
 * full address: Capacitor iOS reads `appStartPath` as a bundled file.
 */
export const androidCapacitorConfig = (config: AppConfig): CapacitorConfig => {
	const base = capacitorConfig(config);
	const origin = start(config);
	return {
		...base,
		server: {
			...base.server,
			url: origin.origin,
			...(origin.pathname === '/' ? {} : { appStartPath: origin.pathname })
		}
	};
};
