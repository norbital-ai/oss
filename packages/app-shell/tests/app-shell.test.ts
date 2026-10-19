import { test } from '@effect/vitest';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Result, Schema } from 'effect';
import { androidCapacitorConfig, capacitorConfig } from '../src/capacitor.ts';
import { AppConfig, defineApp, onHost } from '../src/config.ts';
import {
	NATIVE_PACKAGES,
	nativeManifest,
	renderTemplate,
	runtimeScript,
	templateValues
} from '../src/generate.ts';
import { exportOptions } from '../src/release.ts';

const decode = Schema.decodeUnknownResult(AppConfig);
const sample = defineApp({
	id: 'com.mericlean.cleaner',
	name: "Mericlean Cleaner's App",
	description: 'Jobs for cleaners.',
	version: '1.2.3',
	build: 7,
	icon: './icon.png',
	splash: { color: '#0a7cff' },
	host: 'https://apps.norbital.ai',
	workspace: 'https://apps.norbital.ai/mericlean/apps/cleaner',
	allowNavigation: ['*.stripe.com'],
	capabilities: {
		location: { background: true, purpose: 'Share your route while on a job.' },
		notifications: true,
		camera: { purpose: 'Photograph completed work.' }
	},
	ios: { teamId: 'ABCDE12345', apsEnvironment: 'production' },
	android: {}
});
const app = (overrides: Partial<typeof sample> = {}) => {
	const decoded = decode({ ...sample, ...overrides });
	if (Result.isFailure(decoded)) throw new Error(decoded.failure.message);
	return decoded.success;
};
const refused = (overrides: Partial<typeof sample>) =>
	strictEqual(Result.isFailure(decode({ ...sample, ...overrides })), true);
const unpinned = (overrides: Partial<typeof sample> = {}) => {
	const { workspace: _, ...rest } = { ...sample, ...overrides };
	const decoded = decode(rest);
	if (Result.isFailure(decoded)) throw new Error(decoded.failure.message);
	return decoded.success;
};
const local = { host: 'http://localhost:5173', workspace: 'http://t-abc.localhost:5173/acme' };

test('config admits https workspaces and the development hosts over http only', () => {
	strictEqual(app().workspace, sample.workspace);
	strictEqual(
		app({ host: 'http://localhost:5173', workspace: 'http://localhost:5173/acme' }).workspace,
		'http://localhost:5173/acme'
	);
	strictEqual(
		app({ host: 'http://10.0.2.2:5173', workspace: 'http://10.0.2.2:5173/acme' }).workspace,
		'http://10.0.2.2:5173/acme'
	);
	strictEqual(app(local).workspace, local.workspace);
	refused({ host: 'http://localhost.example', workspace: 'http://localhost.example/acme' });
	refused({ host: 'http://acme.example', workspace: 'http://acme.example/acme' });
	refused({ workspace: 'https://user:secret@apps.norbital.ai/acme' });
	refused({ workspace: 'https://apps.norbital.ai/acme?x=1' });
	refused({ workspace: 'apps.norbital.ai' });
});

test('config requires a host origin; the workspace is optional and must be on the host', () => {
	strictEqual(unpinned().workspace, undefined);
	strictEqual(
		app({ host: 'https://norbital.ai', workspace: 'https://t-abc.workspaces.norbital.ai/apps/x' })
			.host,
		'https://norbital.ai'
	);
	const { host: _, ...hostless } = sample;
	strictEqual(Result.isFailure(decode(hostless)), true);
	refused({ host: 'https://apps.norbital.ai/' });
	refused({ host: 'https://apps.norbital.ai/mericlean' });
	refused({ host: 'http://apps.norbital.ai' });
	refused({ workspace: 'https://other.example/acme' });
	refused({ workspace: 'https://evilapps.norbital.ai/acme' });
	refused({ workspace: 'https://apps.norbital.ai:8443/acme' });
});

test('the host trusts its origin and its subdomains on the same scheme and port only', () => {
	const host = new URL('https://norbital.ai');
	const trusts = (url: string) => onHost(host, new URL(url));
	strictEqual(trusts('https://norbital.ai/x'), true);
	strictEqual(trusts('https://t-abc.workspaces.norbital.ai/x'), true);
	strictEqual(trusts('https://evilnorbital.ai/x'), false);
	strictEqual(trusts('https://norbital.ai.example/x'), false);
	strictEqual(trusts('http://t-abc.norbital.ai/x'), false);
	strictEqual(trusts('https://t-abc.norbital.ai:8443/x'), false);
});

test('config refuses malformed identities, versions and hosts', () => {
	refused({ id: 'cleaner' });
	refused({ id: 'com.mericlean.cleaner-app' });
	refused({ version: '1.2' });
	refused({ build: 0 });
	refused({ allowNavigation: ['https://stripe.com'] });
	refused({ ios: { teamId: 'short', apsEnvironment: 'production' } });
});

test('capacitor config loads the workspace and keeps navigation on its host and the allowed hosts', () => {
	deepStrictEqual(capacitorConfig(app()), {
		appId: 'com.mericlean.cleaner',
		appName: "Mericlean Cleaner's App",
		webDir: 'www',
		backgroundColor: '#0a7cff',
		appendUserAgent: 'NorbitalApp/1',
		android: { path: 'android', useLegacyBridge: false },
		ios: { path: 'ios' },
		server: {
			url: 'https://apps.norbital.ai/mericlean/apps/cleaner',
			allowNavigation: ['apps.norbital.ai', '*.stripe.com'],
			errorPath: 'offline.html'
		},
		plugins: {
			Keyboard: { resize: 'native' },
			NorbitalShell: {
				host: 'https://apps.norbital.ai',
				workspace: 'https://apps.norbital.ai/mericlean/apps/cleaner',
				pinned: true,
				allowNavigation: ['*.stripe.com'],
				teamId: 'ABCDE12345',
				apsEnvironment: 'production'
			}
		}
	});
	const development = capacitorConfig(app(local));
	deepStrictEqual(development.server.allowNavigation, [
		't-abc.localhost',
		'http://t-abc.localhost:5173',
		'*.stripe.com'
	]);
	strictEqual(development.server.cleartext, true);
	strictEqual(
		capacitorConfig(app({ workspace: 'https://apps.norbital.ai' })).server.appStartPath,
		undefined
	);
	deepStrictEqual(androidCapacitorConfig(app(local)).server.url, 'http://t-abc.localhost:5173');
	deepStrictEqual(androidCapacitorConfig(app(local)).server.appStartPath, '/acme');
});

test('an unpinned app starts at the host and stays on its subdomains', () => {
	const config = capacitorConfig(unpinned());
	strictEqual(config.server.url, 'https://apps.norbital.ai');
	deepStrictEqual(config.server.allowNavigation, [
		'apps.norbital.ai',
		'*.apps.norbital.ai',
		'*.stripe.com'
	]);
	deepStrictEqual(config.plugins.NorbitalShell, {
		host: 'https://apps.norbital.ai',
		pinned: false,
		allowNavigation: ['*.stripe.com'],
		teamId: 'ABCDE12345',
		apsEnvironment: 'production'
	});
	const development = androidCapacitorConfig(unpinned({ host: local.host }));
	strictEqual(development.server.url, 'http://localhost:5173');
	strictEqual(development.server.appStartPath, undefined);
	deepStrictEqual(development.server.allowNavigation, [
		'localhost',
		'*.localhost',
		'http://localhost:5173',
		'http://*.localhost:5173',
		'*.stripe.com'
	]);
	deepStrictEqual(
		capacitorConfig(unpinned({ host: 'http://10.0.2.2:5173' })).server.allowNavigation,
		['10.0.2.2', 'http://10.0.2.2:5173', '*.stripe.com']
	);
});

const templates = fileURLToPath(new URL('../templates', import.meta.url));
const files = (dir: string): Array<string> =>
	readdirSync(dir).flatMap((name) => {
		const file = join(dir, name);
		return statSync(file).isDirectory() ? files(file) : [file];
	});

test('every template placeholder renders and capabilities shape the native declarations', () => {
	const values = templateValues(app());
	for (const file of files(templates).filter((file) => !['.jar', '.png'].includes(extname(file))))
		ok(!/\{\{[A-Z_]+\}\}/.test(renderTemplate(readFileSync(file, 'utf8'), values)), file);
	strictEqual(values.APP_NAME, 'Mericlean Cleaner&apos;s App');
	strictEqual(values.APP_NAME_ANDROID, "Mericlean Cleaner\\'s App");
	ok(values.IOS_INFO?.includes('<string>location</string>'));
	ok(values.IOS_INFO?.includes('NSCameraUsageDescription'));
	ok(values.IOS_ENTITLEMENTS?.includes('<string>production</string>'));
	ok(values.ANDROID_PERMISSIONS?.includes('ACCESS_BACKGROUND_LOCATION'));
	strictEqual(values.ANDROID_PERMISSIONS?.match(/POST_NOTIFICATIONS/g)?.length, 1);
	ok(values.ANDROID_COMPONENTS?.includes('.NoticesService'));

	const bare = templateValues(app({ capabilities: {} }));
	strictEqual(bare.IOS_INFO, '');
	strictEqual(bare.IOS_ENTITLEMENTS, '');
	strictEqual(bare.ANDROID_PERMISSIONS, '');
	strictEqual(bare.ANDROID_COMPONENTS, '');
	strictEqual(bare.ANDROID_DEBUG_TRUST, '');
	ok(
		templateValues(app({ android: { debugCa: './ca.pem' } })).ANDROID_DEBUG_TRUST?.includes(
			'<certificates src="@raw/norbital_debug_ca" />'
		)
	);
	ok(templateValues(app(local)).IOS_INFO?.includes('NSAllowsLocalNetworking'));
});

test('the runtime script scopes the app settings to the bundle', () => {
	const script = runtimeScript(app(), 'void NORBITAL_SHELL;');
	ok(
		script.startsWith(
			'(function () {\nconst NORBITAL_SHELL = {"host":"https://apps.norbital.ai","workspace":"https://apps.norbital.ai/mericlean/apps/cleaner"'
		)
	);
	ok(script.includes('"location":{"background":true},"notifications":true}'));
	ok(script.trimEnd().endsWith('})();'));
});

test('the Capacitor set matches the versions the runtime bundle is built with', () => {
	const manifest: unknown = JSON.parse(
		readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
	);
	const { devDependencies } = Schema.decodeUnknownSync(
		Schema.Struct({ devDependencies: Schema.Record(Schema.String, Schema.String) })
	)(manifest);
	for (const [name, version] of Object.entries(NATIVE_PACKAGES))
		if (name in devDependencies) strictEqual(devDependencies[name], version, name);
	ok(!('@capacitor/cli' in nativeManifest(app()).dependencies));
});

test('export options select App Store Connect and the requested destination', () => {
	ok(exportOptions(app(), 'upload').includes('<string>upload</string>'));
	ok(exportOptions(app(), 'export').includes('<string>ABCDE12345</string>'));
});
