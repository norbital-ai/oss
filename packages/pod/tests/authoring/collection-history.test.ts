import { describe, expect, it } from 'vitest';
import { text } from 'drizzle-orm/pg-core';
import { defineModel, defineModels, defineRuntimeRegistry } from '$lib/authoring/filesystem.js';
import { getTableMeta } from '$lib/authoring/schema/table.js';
import { nonTemporalCollections, schemaPostDdlSql } from '$lib/vite/schema-functions-sql.js';
import { NON_TEMPORAL_SYSTEM_COLLECTIONS } from '@norbital-ai/platform-utils/system/workspace-schema';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';

function manifestWithHistory(
	entries: Readonly<Record<string, boolean | undefined>>
): NorbitalManifest {
	return {
		version: 1,
		collections: Object.fromEntries(
			Object.entries(entries).map(([name, history]) => [
				name,
				{
					collection_name: name,
					description: null,
					record_label: null,
					icon: null,
					extensions: { indexes: [], history },
					hooks: {},
					pipelines: {},
					system: null
				}
			])
		),
		relationships: {},
		apps: {},
		handlers: {},
		automations: {}
	};
}

/** The exempt-table list inside one of the post-DDL `DO` blocks. */
function exemptList(sql: string, block: string): string {
	const match = sql.match(
		new RegExp(`\\$${block}\\$[\\s\\S]*?relname NOT IN \\(\\s*([^)]*?)\\s*\\)`)
	);
	if (!match) throw new Error(`No exempt list found in $${block}$`);
	return match[1];
}

describe('per-collection temporal history', () => {
	it('carries a model\u2019s history opt-out onto its table metadata', () => {
		const registry = defineRuntimeRegistry({
			models: defineModels({
				transcripts: defineModel({ body: text() }, { recordLabel: 'body', history: false }),
				orders: defineModel({ reference: text() }, { recordLabel: 'reference' })
			}),
			relationships: () => ({})
		});

		expect(getTableMeta(registry.tables.transcripts)?.history).toBe(false);
		expect(getTableMeta(registry.tables.orders)?.history).toBeUndefined();
	});

	it('collects the opt-out from the system definitions and the tenant manifest alike', () => {
		expect([...NON_TEMPORAL_SYSTEM_COLLECTIONS].sort()).toEqual(['audit_event', 'chat_session']);

		const names = nonTemporalCollections(
			manifestWithHistory({ transcripts: false, orders: undefined })
		);
		expect(names.has('transcripts')).toBe(true);
		expect(names.has('orders')).toBe(false);
		for (const system of NON_TEMPORAL_SYSTEM_COLLECTIONS) expect(names.has(system)).toBe(true);
	});

	it('exempts only those from the history refresh, and every system collection from the ops guard', () => {
		const sql = schemaPostDdlSql(
			nonTemporalCollections(manifestWithHistory({ transcripts: false }))
		);

		const versioning = exemptList(sql, 'refresh_versioning');
		expect(versioning).toContain(`'transcripts'`);
		expect(versioning).toContain(`'chat_session'`);
		// The ~17 system collections that do keep a history relation must stay inside the drift
		// repair; exempting all of them is what let their history tables go unrepaired.
		expect(versioning).not.toContain(`'user'`);
		expect(versioning).not.toContain(`'approval_request'`);

		const opsGuard = exemptList(sql, 'refresh_ops_guards');
		expect(opsGuard).toContain(`'user'`);
		expect(opsGuard).toContain(`'approval_request'`);
		expect(opsGuard).not.toContain(`'transcripts'`);
	});
});
