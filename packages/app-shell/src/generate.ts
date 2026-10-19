import { Effect, FileSystem, Path } from 'effect';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { androidCapacitorConfig, capacitorConfig, cleartext } from './capacitor.ts';
import { loadApp, type AppConfig } from './config.ts';
import { AppShellFailure, probe, stream } from './process.ts';

/**
 * The Capacitor packages every app installs, at the versions the native templates and the runtime bundle are built
 * against. `init` writes them into the app's `package.json`; Capacitor's CLI discovers the plugins from there.
 */
export const NATIVE_PACKAGES = {
	'@capacitor/cli': '8.5.2',
	'@capacitor/core': '8.5.2',
	'@capacitor/ios': '8.5.2',
	'@capacitor/android': '8.5.2',
	'@capacitor/app': '8.1.2',
	'@capacitor/browser': '8.0.3',
	'@capacitor/keyboard': '8.0.6',
	'@capacitor/local-notifications': '8.3.1',
	'@capacitor-community/background-geolocation': '1.2.26'
} as const;

/** The debug build's copy of `android.debugCa`, a raw resource. */
const DEBUG_CA = 'norbital_debug_ca';

/** Generated output, beside the config file and never committed. */
export const NATIVE_DIR = '.native';

const escapeXml = (value: string) =>
	value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
/** Android string resources also treat `'`, `"`, `\` and a leading `@` / `?` specially. */
const escapeAndroidString = (value: string) =>
	escapeXml(value.replaceAll('\\', '\\\\'))
		.replaceAll('&apos;', "\\'")
		.replaceAll('&quot;', '\\"')
		.replace(/^([@?])/, '\\$1');

const plistString = (key: string, value: string) =>
	`\t<key>${key}</key>\n\t<string>${escapeXml(value)}</string>\n`;
const permission = (name: string) =>
	`    <uses-permission android:name="android.permission.${name}" />\n`;

/** The background colour behind icons, splash and the offline page. */
const backgroundColor = (config: AppConfig) =>
	(config.splash?.color ?? config.themeColor ?? '#FFFFFF').toUpperCase();

/** Every `{{KEY}}` the native templates use, for one app. */
export const templateValues = (config: AppConfig): Readonly<Record<string, string>> => {
	const { location, notifications, camera } = config.capabilities;
	const androidPermissions = [
		...(location === undefined ? [] : ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION']),
		...(location?.background
			? [
					'ACCESS_BACKGROUND_LOCATION',
					'FOREGROUND_SERVICE',
					'FOREGROUND_SERVICE_LOCATION',
					'POST_NOTIFICATIONS'
				]
			: []),
		...(notifications
			? ['POST_NOTIFICATIONS', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_SPECIAL_USE']
			: []),
		...(camera === undefined ? [] : ['CAMERA'])
	];
	return {
		APP_ID: config.id,
		APP_NAME: escapeXml(config.name),
		APP_NAME_ANDROID: escapeAndroidString(config.name),
		VERSION: config.version,
		BUILD: String(config.build),
		TEAM_ID: config.ios.teamId,
		BACKGROUND_COLOR: backgroundColor(config),
		IOS_INFO: [
			...(location === undefined
				? []
				: [plistString('NSLocationWhenInUseUsageDescription', location.purpose)]),
			...(location?.background
				? [
						plistString('NSLocationAlwaysAndWhenInUseUsageDescription', location.purpose),
						'\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>location</string>\n\t</array>\n'
					]
				: []),
			...(camera === undefined ? [] : [plistString('NSCameraUsageDescription', camera.purpose)]),
			...(cleartext(config)
				? [
						// development only: local IPs, and `localhost` with its subdomains (a local host's tenants)
						'\t<key>NSAppTransportSecurity</key>\n\t<dict>\n\t\t<key>NSAllowsLocalNetworking</key>\n\t\t<true/>\n' +
							'\t\t<key>NSExceptionDomains</key>\n\t\t<dict>\n\t\t\t<key>localhost</key>\n\t\t\t<dict>\n' +
							'\t\t\t\t<key>NSIncludesSubdomains</key>\n\t\t\t\t<true/>\n' +
							'\t\t\t\t<key>NSExceptionAllowsInsecureHTTPLoads</key>\n\t\t\t\t<true/>\n\t\t\t</dict>\n\t\t</dict>\n\t</dict>\n'
					]
				: [])
		].join(''),
		IOS_ENTITLEMENTS: notifications
			? `\t<key>aps-environment</key>\n\t<string>${config.ios.apsEnvironment}</string>\n`
			: '',
		ANDROID_PERMISSIONS: [
			...[...new Set(androidPermissions)].map(permission),
			...(camera === undefined
				? []
				: [
						'    <uses-feature android:name="android.hardware.camera" android:required="false" />\n'
					])
		].join(''),
		ANDROID_DEBUG_TRUST:
			config.android.debugCa === undefined
				? ''
				: [
						'    <debug-overrides>',
						'        <trust-anchors>',
						'            <certificates src="system" />',
						`            <certificates src="@raw/${DEBUG_CA}" />`,
						'        </trust-anchors>',
						'    </debug-overrides>',
						''
					].join('\n'),
		ANDROID_COMPONENTS: notifications
			? [
					'',
					'        <service',
					'            android:name=".NoticesService"',
					'            android:exported="false"',
					'            android:foregroundServiceType="specialUse">',
					'            <property',
					'                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"',
					'                android:value="Delivers workspace notices while the app is closed, without a third-party push service." />',
					'        </service>',
					''
				].join('\n')
			: ''
	};
};

/** Substitutes every `{{KEY}}` present in `values`; unknown keys stay visible so a test can catch them. */
export const renderTemplate = (text: string, values: Readonly<Record<string, string>>) =>
	text.replaceAll(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => values[key] ?? match);

/** The settings the device runtime reads, written around its bundle. */
const runtimeConfig = (config: AppConfig) => ({
	host: config.host,
	...(config.workspace === undefined ? {} : { workspace: config.workspace }),
	allowNavigation: config.allowNavigation ?? [],
	...(config.capabilities.location === undefined
		? {}
		: { location: { background: config.capabilities.location.background } }),
	notifications: config.capabilities.notifications ?? false
});

/** The injected document-start script: the app's settings in scope of the runtime bundle, nothing global. */
export const runtimeScript = (config: AppConfig, bundle: string) =>
	`(function () {\nconst NORBITAL_SHELL = ${JSON.stringify(runtimeConfig(config))};\n${bundle}\n})();\n`;

/** The Capacitor project manifest: the plugins Capacitor's CLI registers into both native projects. */
export const nativeManifest = (config: AppConfig) => ({
	name: config.id.replaceAll('.', '-').toLowerCase(),
	private: true,
	dependencies: Object.fromEntries(
		Object.entries(NATIVE_PACKAGES).filter(([name]) => name !== '@capacitor/cli')
	)
});

const BINARY = new Set(['.jar', '.png']);
const ANDROID_ICONS = [
	['mdpi', 48],
	['hdpi', 72],
	['xhdpi', 96],
	['xxhdpi', 144],
	['xxxhdpi', 192]
] as const;
const packageFile = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/** Copy `from` into `to`, rendering every text file. */
const renderTree = Effect.fn('AppShell.renderTree')(function* (
	from: string,
	to: string,
	values: Readonly<Record<string, string>>
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	for (const relative of yield* fs.readDirectory(from, { recursive: true })) {
		const source = path.join(from, relative);
		if ((yield* fs.stat(source)).type !== 'File') continue;
		const target = path.join(to, relative);
		yield* fs.makeDirectory(path.dirname(target), { recursive: true });
		if (BINARY.has(path.extname(relative))) yield* fs.copyFile(source, target);
		else
			yield* fs.writeFileString(target, renderTemplate(yield* fs.readFileString(source), values));
		if (path.basename(relative) === 'gradlew') yield* fs.chmod(target, 0o755);
	}
});

const sips = (args: ReadonlyArray<string>, cwd: string) =>
	stream('sips', args, { cwd, timeout: '30 seconds' });

/**
 * Icons and splash screens from the config's 1024px PNG with macOS `sips`, so the shell adds no image dependency.
 * iOS gets an opaque 1024 icon (App Store rejects alpha); Android gets legacy and adaptive launcher icons.
 */
const renderImages = Effect.fn('AppShell.renderImages')(function* (
	appDir: string,
	native: string,
	config: AppConfig
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const icon = path.resolve(appDir, config.icon);
	const splash = path.resolve(appDir, config.splash?.image ?? config.icon);
	for (const file of [icon, splash])
		if (!(yield* fs.exists(file)))
			return yield* new AppShellFailure({ message: `${file} does not exist` });
	if ((yield* probe('sips', ['--help'], appDir)) === undefined)
		return yield* new AppShellFailure({
			message: 'Icons are rendered with macOS `sips`; run `norbital-app generate` on a Mac.'
		});
	const size = yield* probe('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', icon], appDir);
	if (size === undefined || !/pixelWidth: 1024\b[\s\S]*pixelHeight: 1024\b/.test(size))
		return yield* new AppShellFailure({ message: `${config.icon} must be a 1024×1024 PNG` });
	const pad = backgroundColor(config).slice(1);
	const scratch = yield* fs.makeTempDirectoryScoped({ prefix: 'norbital-app-images-' });
	const ios = path.join(native, 'ios', 'App', 'App', 'Assets.xcassets');
	const res = path.join(native, 'android', 'app', 'src', 'main', 'res');

	const flat = path.join(scratch, 'icon.jpg');
	yield* sips(['-s', 'format', 'jpeg', '-s', 'formatOptions', '100', icon, '--out', flat], appDir);
	yield* sips(
		[
			'-s',
			'format',
			'png',
			flat,
			'--out',
			path.join(ios, 'AppIcon.appiconset', 'AppIcon-1024.png')
		],
		appDir
	);

	const mark = path.join(scratch, 'mark.png');
	yield* sips(['-Z', '1024', splash, '--out', mark], appDir);
	const splashes = [
		[path.join(ios, 'Splash.imageset', 'splash.png'), 2732, 2732],
		[path.join(res, 'drawable', 'splash.png'), 1920, 1080],
		[path.join(res, 'drawable-port-xxhdpi', 'splash.png'), 1920, 1080],
		[path.join(res, 'drawable-land-xxhdpi', 'splash.png'), 1080, 1920]
	] as const;
	for (const [target, height, width] of splashes) {
		yield* fs.makeDirectory(path.dirname(target), { recursive: true });
		const fitted = path.join(scratch, `mark-${width}x${height}.png`);
		const side = Math.round(Math.min(width, height) * 0.4);
		yield* sips(['-Z', String(side), mark, '--out', fitted], appDir);
		yield* sips(
			['-p', String(height), String(width), '--padColor', pad, fitted, '--out', target],
			appDir
		);
	}

	for (const [density, side] of ANDROID_ICONS) {
		const folder = path.join(res, `mipmap-${density}`);
		yield* fs.makeDirectory(folder, { recursive: true });
		for (const name of ['ic_launcher.png', 'ic_launcher_round.png'])
			yield* sips(
				['-z', String(side), String(side), icon, '--out', path.join(folder, name)],
				appDir
			);
		// Adaptive foreground: 108dp canvas, the icon inside the 72dp safe zone, the background colour around it.
		const canvas = Math.round((side * 108) / 48);
		const inner = path.join(scratch, `foreground-${density}.png`);
		yield* sips(
			[
				'-z',
				String(Math.round((canvas * 72) / 108)),
				String(Math.round((canvas * 72) / 108)),
				icon,
				'--out',
				inner
			],
			appDir
		);
		yield* sips(
			[
				'-p',
				String(canvas),
				String(canvas),
				'--padColor',
				pad,
				inner,
				'--out',
				path.join(folder, 'ic_launcher_foreground.png')
			],
			appDir
		);
	}
});

/** `@capacitor/cli`'s entry, resolved from the app's own dependencies. */
const capacitorCli = Effect.fn('AppShell.capacitorCli')(function* (appDir: string) {
	const path = yield* Path.Path;
	return yield* Effect.try({
		try: () =>
			path.join(
				path.dirname(
					createRequire(path.join(appDir, 'package.json')).resolve('@capacitor/cli/package.json')
				),
				'bin',
				'capacitor'
			),
		catch: () =>
			new AppShellFailure({
				message: `@capacitor/cli is not installed in ${appDir}; run \`pnpm install\` there.`
			})
	});
});

/** Run Capacitor's CLI in the generated project. */
export const capacitor = Effect.fn('AppShell.capacitor')(function* (
	appDir: string,
	args: ReadonlyArray<string>,
	timeout: `${number} minutes`
) {
	const path = yield* Path.Path;
	const cli = yield* capacitorCli(appDir);
	yield* stream(process.execPath, [cli, ...args], { cwd: path.join(appDir, NATIVE_DIR), timeout });
});

/**
 * Render `<appDir>/.native/{ios,android,www}` from the package templates and the app's config, embed the environment
 * runtime, draw icons, then let Capacitor sync plugins, web assets and its config into both projects. Everything under
 * `.native/` is regenerated from scratch: edit the config, never the projects.
 */
export const generate = Effect.fn('AppShell.generate')(function* (appDir: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const config = yield* loadApp(appDir);
	const native = path.join(appDir, NATIVE_DIR);
	const values = templateValues(config);
	yield* Effect.forEach(['ios', 'android', 'www'], (name) =>
		fs.remove(path.join(native, name), { recursive: true, force: true })
	);
	yield* renderTree(packageFile('../templates'), native, values);
	yield* fs.writeFileString(path.join(native, '.gitignore'), '*\n');
	yield* fs.writeFileString(
		path.join(native, 'capacitor.config.json'),
		`${JSON.stringify(capacitorConfig(config), null, '\t')}\n`
	);
	yield* fs.writeFileString(
		path.join(native, 'package.json'),
		`${JSON.stringify(nativeManifest(config), null, '\t')}\n`
	);

	const bundle = packageFile('./runtime/norbital-shell.js');
	if (!(yield* fs.exists(bundle)))
		return yield* new AppShellFailure({
			message: `${bundle} is missing; build @norbital-ai/app-shell first.`
		});
	const script = runtimeScript(config, yield* fs.readFileString(bundle));
	for (const target of [
		path.join(native, 'ios', 'App', 'App', 'norbital-shell.js'),
		path.join(native, 'android', 'app', 'src', 'main', 'assets', 'norbital-shell.js')
	]) {
		yield* fs.makeDirectory(path.dirname(target), { recursive: true });
		yield* fs.writeFileString(target, script);
	}

	if (config.android.debugCa !== undefined) {
		const raw = path.join(native, 'android', 'app', 'src', 'debug', 'res', 'raw');
		yield* fs.makeDirectory(raw, { recursive: true });
		yield* fs.copyFile(
			path.resolve(appDir, config.android.debugCa),
			path.join(raw, `${DEBUG_CA}.pem`)
		);
	}
	yield* Effect.scoped(renderImages(appDir, native, config));
	yield* capacitor(appDir, ['sync'], '10 minutes');
	yield* fs.writeFileString(
		path.join(native, 'android', 'app', 'src', 'main', 'assets', 'capacitor.config.json'),
		`${JSON.stringify(androidCapacitorConfig(config), null, '\t')}\n`
	);
	return config;
});
