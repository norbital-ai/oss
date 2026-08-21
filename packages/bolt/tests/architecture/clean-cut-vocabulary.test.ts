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

/**
 * The old names still occur in one place on purpose: the forward migration that renames an existing
 * database in place. They are lineage there, not live runtime vocabulary. Everything else is an
 * actual cutover remnant, so this test scans executable source while keeping the migration's exact
 * old-name budget visible.
 */
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

	it('confines old persisted identifiers to the explicit rename lineage', () => {
		const schemaPlan = readFileSync(join(sourceRoot, 'compiler/schema-plan.ts'), 'utf8');
		const start = schemaPlan.indexOf("id: 'bolt:envoy-0000-rename-from-channel'");
		const end = schemaPlan.indexOf("id: 'bolt:envoy-registrations'", start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);

		const lineage = schemaPlan.slice(start, end);
		const outsideLineage = `${schemaPlan.slice(0, start)}${schemaPlan.slice(end)}`;
		expect(occurrences(lineage, /\bbolt_channel_registrations\b/g)).toBe(2);
		expect(occurrences(lineage, /\bbolt_channel_receipts\b/g)).toBe(2);
		expect(occurrences(lineage, /\bbolt_channel_inbound\b/g)).toBe(2);
		expect(occurrences(lineage, /\bbolt_channel_receipts_window\b/g)).toBe(1);
		expect(occurrences(lineage, /\bchannel_name\b/g)).toBe(3);
		expect(
			occurrences(
				outsideLineage,
				/\bbolt_channel_(?:registrations|receipts|inbound|receipts_window)\b|\bchannel_name\b/g
			)
		).toBe(0);
	});

	it('preserves every legitimate channel sense protected from the envoy rename', () => {
		const schemaPlan = readFileSync(join(sourceRoot, 'compiler/schema-plan.ts'), 'utf8');
		const transportIdentity = readFileSync(
			join(sourceRoot, 'runtime/envoys/transport-identity.ts'),
			'utf8'
		);
		const protocol = readFileSync(protocolFacilities, 'utf8');
		const replica = readFileSync(join(sourceRoot, 'client/replica/pglite-sql.ts'), 'utf8');
		const clientRuntime = readFileSync(join(sourceRoot, 'client/runtime.ts'), 'utf8');

		// Person address book.
		expect(schemaPlan).toContain(
			'alter table bolt_auth_user add column if not exists channels jsonb'
		);
		expect(transportIdentity).toContain('bolt_auth_user.channels');
		// Deliberately deferred protocol wire field.
		expect(protocol).toContain('VerifyInbound: { channel: Schema.NonEmptyString');
		expect(protocol).toContain('Send: { channel: Schema.NonEmptyString');
		// Browser/PostgreSQL channel vocabulary is unrelated to envoy identity.
		expect(replica).toContain('BroadcastChannel');
		expect(replica).toContain('readonly listen?:');
		expect(clientRuntime).toContain("query('select pg_notify($1, $2)'");
	});
});
