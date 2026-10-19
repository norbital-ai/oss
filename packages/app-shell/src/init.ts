import { Console, Effect, FileSystem, Path, Schema } from 'effect';
import { fileURLToPath } from 'node:url';
import { NATIVE_PACKAGES } from './generate.ts';
import { AppShellFailure } from './process.ts';

const Own = Schema.Struct({ name: Schema.String, version: Schema.String });

const starterConfig = (
	id: string,
	name: string
) => `import { defineApp } from '@norbital-ai/app-shell';

export default defineApp({
	id: ${JSON.stringify(id)},
	name: ${JSON.stringify(name)},
	description: ${JSON.stringify(`${name} for workspace members.`)},
	version: '1.0.0',
	build: 1,
	icon: './icon.png',
	splash: { color: '#FFFFFF' },
	// The server the app belongs to: a Norbital platform origin, or your self-hosted Bolt server.
	host: 'https://example.norbital.app',
	// Optional: pin the app to one workspace page. Unset, members pick and switch workspaces in the app.
	// workspace: 'https://t-abc.workspaces.example.norbital.app/apps/cleaner',
	capabilities: { notifications: true },
	ios: { teamId: 'ABCDE12345', apsEnvironment: 'production' },
	android: {}
});
`;

/** `init <dir>`: a starter `norbital.app.ts` and a `package.json` pinning the shell and its Capacitor set. */
export const init = Effect.fn('AppShell.init')(
	function* (appDir: string) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const own = yield* fs
			.readFileString(fileURLToPath(new URL('../package.json', import.meta.url)))
			.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Own))));
		const slug = path
			.basename(path.resolve(appDir))
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/g, '');
		const name = path.basename(path.resolve(appDir));
		yield* fs.makeDirectory(appDir, { recursive: true });
		const files = [
			['norbital.app.ts', starterConfig(`com.example.${slug === '' ? 'app' : slug}`, name)],
			[
				'package.json',
				`${JSON.stringify(
					{
						name: slug === '' ? 'app' : slug,
						private: true,
						type: 'module',
						scripts: {
							doctor: 'norbital-app doctor',
							generate: 'norbital-app generate',
							ios: 'norbital-app run --platform ios',
							android: 'norbital-app run --platform android',
							build: 'norbital-app build --platform ios,android',
							deploy: 'norbital-app deploy --platform ios,android'
						},
						dependencies: { [own.name]: own.version, ...NATIVE_PACKAGES }
					},
					null,
					'\t'
				)}\n`
			],
			['.gitignore', '.native/\nnode_modules/\n']
		] as const;
		for (const [name, content] of files) {
			const file = path.join(appDir, name);
			if (yield* fs.exists(file)) {
				yield* Console.log(`kept ${file}`);
				continue;
			}
			yield* fs.writeFileString(file, content);
			yield* Console.log(`wrote ${file}`);
		}
		yield* Console.log(
			[
				'',
				'Next:',
				`  1. Put a 1024×1024 PNG app icon at ${path.join(appDir, 'icon.png')} (no transparency on iOS).`,
				'  2. Set id, name, host (and optionally workspace) and ios.teamId in norbital.app.ts.',
				'  3. Install (pnpm install), then `norbital-app doctor` and `norbital-app run --platform ios`.'
			].join('\n')
		);
	},
	Effect.mapError((error) =>
		error instanceof AppShellFailure ? error : new AppShellFailure({ message: error.message })
	)
);
