// `load_host`: a host file that throws while loading names its own failure, not a missing default export.
import { describe, expect, it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, Exit, FileSystem, Path } from 'effect';
import { load_host } from '../src/node/host.ts';
import { hostModule } from '../src/node/host-module.ts';
import { off, type Facilities, type SandboxLimits } from '../src/facilities/index.ts';
import { memory_audit } from '../../bolt-cli/src/test/audit.ts';

const facilities = (): Facilities => ({
	storage: {
		database: {
			read: async () => [],
			write: async () => ({ rows: [], affected: 0 }),
			transaction: async () => []
		},
		files: {
			put: async (bytes, meta) => ({ key: 'file', bytes: bytes.length, mime: meta.mime, sha256: 'hash' }),
			get: async () => new Uint8Array([1]),
			url: async (key) => `https://files.example/${key}`,
			remove: async () => {},
			download: async () => ({ key: 'file', name: 'file.txt', bytes: 1, mime: 'text/plain', sha256: 'hash' })
		}
	},
	logs: { runtime: { write: () => {}, query: async () => [] }, audit: memory_audit().port },
	transactional: { mail: { send: async () => ({ provider_id: 'sent' }) }, sms: off, phone: off, push: off, challenge: off, fixed_codes: true },
	intelligence: { system1: off, system2: off, embed: off },
	ports: { webhooks: off, websockets: off, outbound: off },
	sandbox: off,
	keys: { seal: async (bytes) => bytes, open: async (bytes) => bytes }
});

describe('host module boundary', () => {
	it('rejects empty groups and non-callable nested members while loading', () => {
		expect(() => hostModule({ default: { storage: {}, logs: {}, transactional: {}, intelligence: {}, ports: {}, sandbox: {}, keys: {} } })).toThrow();
		const valid = facilities();
		expect(() => hostModule({ default: { ...valid, storage: { ...valid.storage, files: { ...valid.storage.files, get: 'not a callback' } } } })).toThrow();
	});

	it('retains callback receivers and validates their answers when called', async () => {
		const valid = facilities();
		const original: Facilities['storage']['files'] = {
			...valid.storage.files,
			async url(key) {
				expect(this).toBe(original);
				return `https://files.example/${key}`;
			}
		};
		const signal = new AbortController().signal;
		const loaded = hostModule({ default: { ...valid, storage: { ...valid.storage, files: original } } });
		expect(await loaded.facilities.storage.files.url('file', 60, signal)).toBe('https://files.example/file');
		const malformed = hostModule({ default: { ...valid, storage: { ...valid.storage, files: { ...original, get: async () => 'not bytes' } } } });
		await expect(malformed.facilities.storage.files.get('file', 10, signal)).rejects.toThrow();
	});

	it('validates optional serving callbacks and ignores completion return values', async () => {
		const original = {
			convert: { targets: ['pdf'], convert: async () => 'not bytes' },
			async close() {
				expect(this).toBe(original);
				return 'host cleanup result';
			}
		};
		const loaded = hostModule({ default: facilities(), serving: original });
		if (loaded.serving.convert === undefined || loaded.serving.close === undefined) throw new Error('Serving capabilities were lost');
		await expect(loaded.serving.convert.convert({ markdown: '# Report' }, 'pdf', {}, new AbortController().signal)).rejects.toThrow();
		expect(await loaded.serving.close()).toBeUndefined();
	});

	it('retains sandbox limits and decodes the canonical process result', async () => {
		const calls: SandboxLimits[] = [];
		const sandbox: Exclude<Facilities['sandbox'], typeof off> = {
			exec: async (_command, files, limits) => {
				calls.push(limits);
				return { exit_code: 7, stdout: 'out', stderr: 'err', files };
			}
		};
		const loaded = hostModule({ default: { ...facilities(), sandbox } });
		if ('_tag' in loaded.facilities.sandbox) throw new Error('Sandbox capability was lost');
		const files = new Map([['note.txt', new Uint8Array([1])]]);
		const limits = { cpu_ms: 25, memory_mib: 64, wall_ms: 100 };
		expect(await loaded.facilities.sandbox.exec('exit 7', files, limits, new AbortController().signal)).toEqual({ exit_code: 7, stdout: 'out', stderr: 'err', files });
		expect(calls).toEqual([limits]);
	});
});

describe('load_host', () => {
	it.live('reports why a host file failed to load, and a missing default export as such', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem,
				path = yield* Path.Path;
			const dir = yield* fs.makeTempDirectoryScoped();
			const throwing = path.join(dir, 'throwing.host.mjs'),
				empty = path.join(dir, 'empty.host.mjs');
			yield* fs.writeFileString(throwing, "throw new Error('BOLT_X is required');\n");
			yield* fs.writeFileString(empty, 'export default {};\n');
			const failure = (file: string) =>
				load_host(file).pipe(
					Effect.scoped,
					Effect.exit,
					Effect.map((exit) => (Exit.isFailure(exit) ? String(exit.cause) : 'loaded'))
				);
			const thrown = yield* failure(throwing);
			expect(thrown).toContain('could not load: BOLT_X is required');
			expect(thrown).not.toContain('must default-export');
			expect(yield* failure(empty)).toContain('must default-export its Facilities');
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
	);
});
