import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { text, uuid } from 'drizzle-orm/pg-core';
import { norbitalTableInternal, type TableExclusion } from '$lib/authoring/schema/table.js';
import { workspaceExclusionsDdl } from '$lib/vite/workspace-exclusions-sql.js';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';

/** Minimal manifest carrying exactly the exclusions under test. */
function manifestWith(
	entries: Readonly<Record<string, readonly TableExclusion[]>>
): NorbitalManifest {
	return {
		version: 1,
		collections: Object.fromEntries(
			Object.entries(entries).map(([name, exclusions]) => [
				name,
				{
					collection_name: name,
					description: null,
					record_label: null,
					icon: null,
					extensions: { indexes: [], exclusions },
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

const EFFECTIVE_RANGE_EXPR =
	"daterange((effective_range->>'start')::date, (effective_range->>'end')::date, '[)')";

const CONTRIBUTION_TREATMENT_EXCLUSION: TableExclusion = {
	name: 'contribution_treatments_no_overlap',
	elements: [
		{ expr: 'component_type_id', with: '=' },
		{ expr: 'statutory_contribution_id', with: '=' },
		{ expr: EFFECTIVE_RANGE_EXPR, with: '&&' }
	]
};

describe('workspaceExclusionsDdl', () => {
	it('emits a guarded DO block per exclusion', () => {
		const ddl = workspaceExclusionsDdl(
			manifestWith({ contribution_treatments: [CONTRIBUTION_TREATMENT_EXCLUSION] })
		);

		expect(ddl).toBe(
			[
				'-- Workspace EXCLUDE constraints (generated; drizzle cannot express these).',
				'DO $excl$',
				'BEGIN',
				"  IF to_regclass('public.contribution_treatments') IS NOT NULL",
				"     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contribution_treatments_no_overlap') THEN",
				'    ALTER TABLE contribution_treatments ADD CONSTRAINT contribution_treatments_no_overlap',
				`      EXCLUDE USING gist (component_type_id WITH =, statutory_contribution_id WITH =, ${EFFECTIVE_RANGE_EXPR} WITH &&);`,
				'  END IF;',
				'END $excl$;',
				''
			].join('\n')
		);
	});

	it('never emits an unconditional DROP/ADD pair', () => {
		const ddl = workspaceExclusionsDdl(
			manifestWith({ contribution_treatments: [CONTRIBUTION_TREATMENT_EXCLUSION] })
		);
		expect(ddl).not.toContain('DROP CONSTRAINT');
	});

	it('renders the optional predicate and index method', () => {
		const ddl = workspaceExclusionsDdl(
			manifestWith({
				pay_period: [
					{
						name: 'pay_period_active_no_overlap',
						using: 'gist',
						elements: [{ expr: 'employee_id', with: '=' }],
						where: "status <> 'VOID'"
					}
				]
			})
		);
		expect(ddl).toContain(
			"      EXCLUDE USING gist (employee_id WITH =) WHERE (status <> 'VOID');"
		);
	});

	it('separates multiple exclusions with a blank line', () => {
		const ddl = workspaceExclusionsDdl(
			manifestWith({
				a_table: [{ name: 'a_one', elements: [{ expr: 'x', with: '=' }] }],
				b_table: [{ name: 'b_one', elements: [{ expr: 'y', with: '=' }] }]
			})
		);
		expect(ddl.match(/DO \$excl\$/g)).toHaveLength(2);
		expect(ddl).toContain('END $excl$;\n\nDO $excl$');
	});

	it('returns empty output when the workspace declares none', () => {
		expect(workspaceExclusionsDdl(manifestWith({ plain: [] }))).toBe('');
	});

	it('rejects an unsafe constraint name', () => {
		expect(() =>
			workspaceExclusionsDdl(
				manifestWith({ t: [{ name: 'bad"; DROP TABLE t; --', elements: [{ expr: 'x', with: '=' }] }] })
			)
		).toThrow(/snake_case identifier/);
	});

	it('rejects an element that would terminate the dollar-quoted block', () => {
		expect(() =>
			workspaceExclusionsDdl(
				manifestWith({ t: [{ name: 't_bad', elements: [{ expr: '$excl$', with: '=' }] }] })
			)
		).toThrow(/\$excl\$/);
	});
});

describe('table index extensions', () => {
	it('carries name, method, opclass, expression members and predicate into drizzle', () => {
		const table = norbitalTableInternal(
			'contribution_treatments',
			{ component_type_id: uuid(), effective_range: text(), status: text() },
			{
				indexes: [
					{
						name: 'contribution_treatments_effective_idx',
						method: 'gist',
						columns: [
							'component_type_id',
							{ expr: "daterange((effective_range->>'start')::date, NULL, '[)')" }
						],
						opclass: { component_type_id: 'gist_uuid_ops' },
						where: "status = 'ACTIVE'"
					}
				]
			}
		);

		const authored = getTableConfig(table).indexes.find(
			(idx) => idx.config.name === 'contribution_treatments_effective_idx'
		);
		expect(authored).toBeDefined();
		expect(authored!.config.method).toBe('gist');
		expect(authored!.config.unique).toBe(false);
		expect(authored!.config.where).toBeDefined();

		const [first, second] = authored!.config.columns;
		// Column member: opclass is recorded on the indexed column, not on the index.
		expect((first as { name?: string }).name).toBe('component_type_id');
		expect((first as { indexConfig?: { opClass?: string } }).indexConfig?.opClass).toBe(
			'gist_uuid_ops'
		);
		// Expression member: passed through as raw SQL, which drizzle-kit serializes verbatim.
		expect((second as { name?: string }).name).toBeUndefined();
		expect(JSON.stringify(second)).toContain("daterange((effective_range->>'start')::date");
	});

	it('builds a plain unique index when nothing extra is declared', () => {
		const table = norbitalTableInternal(
			'plain_model',
			{ code: text() },
			{ indexes: [{ columns: ['code'], unique: true }] }
		);
		const unique = getTableConfig(table).indexes.filter((idx) => idx.config.unique);
		expect(unique).toHaveLength(1);
		expect(unique[0]!.config.columns.map((c) => (c as { name?: string }).name)).toEqual(['code']);
	});

	it('refuses an expression index without an explicit name', () => {
		expect(() =>
			norbitalTableInternal(
				'unnamed_expr',
				{ code: text() },
				{ indexes: [{ columns: [{ expr: 'lower(code)' }] }] }
			)
		).toThrow(/explicit `name`/);
	});

	it('refuses an unknown index column', () => {
		expect(() =>
			norbitalTableInternal('bad_column', { code: text() }, { indexes: [{ columns: ['nope'] }] })
		).toThrow(/Unknown index column "bad_column.nope"/);
	});
});
