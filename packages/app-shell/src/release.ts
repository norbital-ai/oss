import { Config, Console, Effect, FileSystem, Option, Path } from 'effect';
import type { AppConfig } from './config.ts';
import { capacitor, generate, NATIVE_DIR } from './generate.ts';
import { uploadToInternalTrack } from './play.ts';
import { AppShellFailure, stream } from './process.ts';

export type Platform = 'ios' | 'android';
export const PLATFORMS: ReadonlyArray<Platform> = ['ios', 'android'];

export const env = (name: string) =>
	Effect.gen(function* () {
		return Option.getOrUndefined(yield* Config.option(Config.string(name)));
	});

/** A store build serves its host (and its workspace, when pinned) over HTTPS; the development exception is for `run` only. */
const refuseCleartext = (config: AppConfig) => {
	const plain = [config.host, config.workspace].find(
		(address) => address !== undefined && new URL(address).protocol !== 'https:'
	);
	return plain === undefined
		? Effect.void
		: Effect.fail(new AppShellFailure({ message: `A store build needs https, not ${plain}.` }));
};

/** Every variable in `names`, or a failure naming the missing ones and what they are for. */
const required = Effect.fn('AppShell.required')(function* (
	names: ReadonlyArray<string>,
	purpose: string
) {
	const values = yield* Effect.forEach(names, env);
	const missing = names.filter((_, index) => values[index] === undefined);
	if (missing.length > 0)
		return yield* new AppShellFailure({ message: `${purpose} needs ${missing.join(', ')}.` });
	return values.map((value) => value ?? '');
});

export const APP_STORE_CONNECT = [
	'APP_STORE_CONNECT_KEY_ID',
	'APP_STORE_CONNECT_ISSUER_ID',
	'APP_STORE_CONNECT_KEY_FILE'
] as const;
export const ANDROID_SIGNING = [
	'ANDROID_KEYSTORE_FILE',
	'ANDROID_KEYSTORE_PASSWORD',
	'ANDROID_KEY_ALIAS',
	'ANDROID_KEY_PASSWORD'
] as const;
export const GOOGLE_PLAY = ['GOOGLE_PLAY_SERVICE_ACCOUNT_FILE'] as const;

/** `xcodebuild` authentication with an App Store Connect API key; optional for a local export, required to upload. */
const appStoreConnectFlags = Effect.fn('AppShell.appStoreConnectFlags')(function* (
	upload: boolean
) {
	const values = yield* Effect.forEach(APP_STORE_CONNECT, env);
	if (!upload && values.every((value) => value === undefined)) return [];
	const [id, issuer, file] = yield* required(APP_STORE_CONNECT, 'App Store Connect authentication');
	return [
		'-authenticationKeyPath',
		file ?? '',
		'-authenticationKeyID',
		id ?? '',
		'-authenticationKeyIssuerID',
		issuer ?? ''
	];
});

/** `xcodebuild -exportArchive` options: an App Store Connect distribution, exported locally or uploaded. */
export const exportOptions = (config: AppConfig, destination: 'export' | 'upload') =>
	[
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		'<dict>',
		'\t<key>method</key>',
		'\t<string>app-store-connect</string>',
		'\t<key>destination</key>',
		`\t<string>${destination}</string>`,
		'\t<key>teamID</key>',
		`\t<string>${config.ios.teamId}</string>`,
		'\t<key>signingStyle</key>',
		'\t<string>automatic</string>',
		'\t<key>uploadSymbols</key>',
		'\t<true/>',
		'\t<key>manageAppVersionAndBuildNumber</key>',
		'\t<false/>',
		'</dict>',
		'</plist>',
		''
	].join('\n');

/** Archive the iOS project and export it: an IPA under `.native/out/ios/export`, or an upload to App Store Connect. */
const ios = Effect.fn('AppShell.ios')(function* (
	appDir: string,
	config: AppConfig,
	destination: 'export' | 'upload'
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const project = path.join(appDir, NATIVE_DIR, 'ios', 'App');
	const out = path.join(appDir, NATIVE_DIR, 'out', 'ios');
	const archive = path.join(out, 'App.xcarchive');
	const options = path.join(out, 'ExportOptions.plist');
	const auth = yield* appStoreConnectFlags(destination === 'upload');
	yield* fs.makeDirectory(out, { recursive: true });
	yield* stream(
		'xcodebuild',
		[
			'-project',
			'App.xcodeproj',
			'-scheme',
			'App',
			'-configuration',
			'Release',
			'-destination',
			'generic/platform=iOS',
			'-archivePath',
			archive,
			'archive',
			'-allowProvisioningUpdates',
			...auth
		],
		{ cwd: project, timeout: '60 minutes' }
	);
	yield* fs.writeFileString(options, exportOptions(config, destination));
	yield* stream(
		'xcodebuild',
		[
			'-exportArchive',
			'-archivePath',
			archive,
			'-exportOptionsPlist',
			options,
			'-exportPath',
			path.join(out, 'export'),
			'-allowProvisioningUpdates',
			...auth
		],
		{ cwd: project, timeout: '30 minutes' }
	);
	yield* Console.log(
		destination === 'upload'
			? `Uploaded ${config.id} ${config.version} (${config.build}) to App Store Connect.`
			: `IPA: ${path.join(out, 'export')}`
	);
});

/** A signed release bundle from the upload key in the environment. */
const androidBundle = Effect.fn('AppShell.androidBundle')(function* (appDir: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const [keystore] = yield* required(ANDROID_SIGNING, 'Android release signing');
	if (!(yield* fs.exists(keystore ?? '')))
		return yield* new AppShellFailure({
			message: `ANDROID_KEYSTORE_FILE ${keystore} does not exist.`
		});
	const project = path.join(appDir, NATIVE_DIR, 'android');
	yield* stream('./gradlew', ['bundleRelease'], { cwd: project, timeout: '60 minutes' });
	const bundle = path.join(
		project,
		'app',
		'build',
		'outputs',
		'bundle',
		'release',
		'app-release.aab'
	);
	if (!(yield* fs.exists(bundle)))
		return yield* new AppShellFailure({ message: `gradle produced no ${bundle}` });
	yield* Console.log(`AAB: ${bundle}`);
	return bundle;
});

/** `build`: regenerate, then a signed IPA and/or AAB per platform. */
export const build = Effect.fn('AppShell.build')(function* (
	appDir: string,
	platforms: ReadonlyArray<Platform>
) {
	const config = yield* generate(appDir);
	yield* refuseCleartext(config);
	for (const platform of platforms)
		if (platform === 'ios') yield* ios(appDir, config, 'export');
		else yield* androidBundle(appDir);
});

/** `deploy`: regenerate, build, and upload — TestFlight / App Store Connect, and Google Play's internal track. */
export const deploy = Effect.fn('AppShell.deploy')(function* (
	appDir: string,
	platforms: ReadonlyArray<Platform>
) {
	const config = yield* generate(appDir);
	yield* refuseCleartext(config);
	for (const platform of platforms) {
		if (platform === 'ios') {
			yield* ios(appDir, config, 'upload');
			continue;
		}
		const [accountFile] = yield* required(GOOGLE_PLAY, 'Google Play upload');
		const bundleFile = yield* androidBundle(appDir);
		const versionCode = yield* uploadToInternalTrack({
			packageName: config.id,
			bundleFile,
			accountFile: accountFile ?? ''
		});
		yield* Console.log(`Released ${config.id} versionCode ${versionCode} to the internal track.`);
	}
});

/** `run`: regenerate, then build, install and launch on a simulator / emulator (Capacitor picks or prompts). */
export const run = Effect.fn('AppShell.run')(function* (
	appDir: string,
	platform: Platform,
	target: string | undefined
) {
	yield* generate(appDir);
	yield* capacitor(
		appDir,
		['run', platform, '--no-sync', ...(target === undefined ? [] : ['--target', target])],
		'30 minutes'
	);
});
