import { Console, Effect, FileSystem, Path, Schema } from 'effect';
import { createRequire } from 'node:module';
import { loadApp } from './config.ts';
import { NATIVE_PACKAGES } from './generate.ts';
import { AppShellFailure, probe } from './process.ts';
import { ANDROID_SIGNING, APP_STORE_CONNECT, env, GOOGLE_PLAY } from './release.ts';

/** `required` blocks `generate` / `run`; `release` blocks `build` / `deploy` only. */
type Check = {
	readonly name: string;
	readonly level: 'required' | 'release';
	readonly problem?: string;
};

const Version = Schema.Struct({ version: Schema.String });

/** What this machine and environment lack for the app in `appDir`, printed as a checklist. */
export const doctor = Effect.fn('AppShell.doctor')(function* (appDir: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const checks: Array<Check> = [];
	const check = (name: string, level: Check['level'], problem: string | undefined) =>
		checks.push(problem === undefined ? { name, level } : { name, level, problem });

	const config = yield* loadApp(appDir).pipe(Effect.result);
	check(
		'norbital.app config',
		'required',
		config._tag === 'Failure' ? config.failure.message : undefined
	);

	const resolve = createRequire(path.join(appDir, 'package.json'));
	for (const [name, expected] of Object.entries(NATIVE_PACKAGES)) {
		const installed = yield* Effect.try(() => resolve.resolve(`${name}/package.json`)).pipe(
			Effect.flatMap((file) => fs.readFileString(file)),
			Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Version))),
			Effect.map((manifest) => manifest.version),
			Effect.catch(() => Effect.succeed(undefined))
		);
		check(
			name,
			'required',
			installed === undefined
				? `not installed; add "${name}": "${expected}" to package.json and install`
				: installed === expected
					? undefined
					: `${installed} installed, the templates are built for ${expected}`
		);
	}

	const macOS = process.platform === 'darwin';
	check(
		'macOS (sips, Xcode)',
		'required',
		macOS ? undefined : 'generate renders icons with sips and iOS builds need Xcode'
	);
	if (macOS) {
		check(
			'Xcode',
			'required',
			(yield* probe('xcodebuild', ['-version'], appDir)) === undefined
				? 'install Xcode, then `sudo xcode-select -s /Applications/Xcode.app`'
				: undefined
		);
		check(
			'iOS simulator',
			'required',
			(yield* probe('xcrun', ['simctl', 'list', 'runtimes'], appDir))?.includes('iOS') === true
				? undefined
				: 'install an iOS simulator runtime (Xcode → Settings → Components)'
		);
	}
	const java = yield* probe('java', ['-version'], appDir);
	const javaMajor = Number(/version "(\d+)/.exec(java ?? '')?.[1] ?? 0);
	check(
		'Java 21+',
		'required',
		javaMajor >= 21 ? undefined : 'install JDK 21 (Android Studio bundles one; set JAVA_HOME)'
	);
	const sdk = (yield* env('ANDROID_HOME')) ?? (yield* env('ANDROID_SDK_ROOT'));
	check(
		'Android SDK',
		'required',
		sdk !== undefined && (yield* fs.exists(sdk))
			? undefined
			: 'install the Android SDK and set ANDROID_HOME'
	);

	const credentials = Effect.fn('AppShell.doctor.credentials')(function* (
		name: string,
		names: ReadonlyArray<string>,
		files: ReadonlyArray<string>
	) {
		const missing: Array<string> = [];
		for (const variable of names) {
			const value = yield* env(variable);
			if (value === undefined) missing.push(variable);
			else if (files.includes(variable) && !(yield* fs.exists(value)))
				missing.push(`${variable} (no file at ${value})`);
		}
		check(name, 'release', missing.length === 0 ? undefined : `set ${missing.join(', ')}`);
	});
	yield* credentials('App Store Connect API key (deploy ios)', APP_STORE_CONNECT, [
		'APP_STORE_CONNECT_KEY_FILE'
	]);
	yield* credentials('Android upload key (build/deploy android)', ANDROID_SIGNING, [
		'ANDROID_KEYSTORE_FILE'
	]);
	yield* credentials('Google Play service account (deploy android)', GOOGLE_PLAY, [
		'GOOGLE_PLAY_SERVICE_ACCOUNT_FILE'
	]);

	for (const item of checks)
		yield* Console.log(
			item.problem === undefined
				? `ok    ${item.name}`
				: `${item.level === 'required' ? 'MISS' : 'miss'}  ${item.name}: ${item.problem}`
		);
	const blocking = checks.filter((item) => item.level === 'required' && item.problem !== undefined);
	if (blocking.length > 0)
		return yield* new AppShellFailure({ message: `${blocking.length} required checks failed` });
});
