import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));
const protocolFacilities = fileURLToPath(
	new URL('../../../bolt-protocol/src/facilities.ts', import.meta.url)
);

const sourceFiles = (root: string): readonly string[] =>
	readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return /\.(?:ts|svelte)$/.test(entry.name) ? [path] : [];
	});

const occurrences = (source: string, pattern: RegExp): number => source.match(pattern)?.length ?? 0;

describe('clean-cut vocabulary', () => {
	it('keeps deleted channel-agent identifiers out of live source', () => {
		const schemaPlanPath = join(sourceRoot, 'compiler/schema-plan.ts');
		const liveSource = sourceFiles(sourceRoot)
			.filter((path) => path !== schemaPlanPath)
			.map((path) => readFileSync(path, 'utf8'))
			.join('\n');

		expect(
			occurrences(
				liveSource,
				/\bbolt_channel_(?:registrations|receipts|inbound)\b|\bchannel_name\b|\bChannelPrincipal\b|\bchannelPrincipal\b/g
			)
		).toBe(0);
		expect(existsSync(join(sourceRoot, 'runtime/channels/channel-principal.ts'))).toBe(false);
		expect(existsSync(join(sourceRoot, 'runtime/channels/channels.ts'))).toBe(false);
		expect(existsSync(join(sourceRoot, 'runtime/envoys/envoys.ts'))).toBe(true);
	});

	it('contains no persisted compatibility vocabulary', () => {
		const source = sourceFiles(sourceRoot)
			.map((path) => readFileSync(path, 'utf8'))
			.join('\n');
		expect(
			occurrences(
				source,
				/\bbolt_channel_(?:registrations|receipts|inbound|receipts_window)\b|\bchannel_name\b/g
			)
		).toBe(0);
	});

	it('preserves every legitimate channel sense protected from the envoy rename', () => {
		const schemaPlan = readFileSync(join(sourceRoot, 'compiler/schema-plan.ts'), 'utf8');
		const systemModels = readFileSync(join(sourceRoot, 'authoring/system-models.ts'), 'utf8');
		const transportIdentity = readFileSync(
			join(sourceRoot, 'runtime/envoys/transport-identity.ts'),
			'utf8'
		);
		const protocol = readFileSync(protocolFacilities, 'utf8');
		const replica = readFileSync(join(sourceRoot, 'client/replica/pglite-sql.ts'), 'utf8');
		const clientRuntime = readFileSync(join(sourceRoot, 'client/runtime.ts'), 'utf8');

		// Person address book.
		expect(systemModels).toContain('channels: jsonb()');
		expect(schemaPlan).not.toContain('alter table user');
		expect(transportIdentity).toContain('user.channels');
		// Deliberately deferred protocol wire field.
		expect(protocol).toContain('VerifyInbound: { channel: Schema.NonEmptyString');
		expect(protocol).toContain('Send: { channel: Schema.NonEmptyString');
		// Browser/PostgreSQL channel vocabulary is unrelated to envoy identity.
		expect(replica).toContain('BroadcastChannel');
		expect(replica).toContain('listen(\n\t\tchannel: string,');
		expect(clientRuntime).toContain("replicaStatement('select pg_notify($1, $2)'");
	});
});
