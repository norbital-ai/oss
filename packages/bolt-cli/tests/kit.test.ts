// Kit edge cases: the generated verb catalogue owns erase, and member setup is never a counted statement.
import { expect, it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import { VERBS } from '../../bolt/src/engine/callables/index.ts';
import { decodeProjectedManifest } from '../../bolt/src/engine/manifest.ts';
import { ActRefused } from '../../bolt/src/decl/errors.ts';
import { TestWorkspace } from '../src/test/effect.ts';
const manifest = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			customers: { description: 'A customer', label: 'name', fields: { name: { kind: 'text' } } }
		},
		relationships: {},
		exposures: {
			customers: {
				read: { customers: { fields: 'all' } },
				create: { columns: { customers: ['name'] } }
			}
		},
		policies: { reader: { description: 'Reads customers', grants: { customers: { read: true } } } },
		automations: {},
		integrations: {},
		teams: {},
		connections: {},
		envoys: {},
		mcp: {},
		apps: {},
		groups: {},
		kiosks: {},
		customFields: {},
		agent: { skills: {} }
	})
);
it.effect('dispatches generated verbs through the host catalogue and records typed refusals', () =>
	Effect.gen(function* () {
		const t = yield* TestWorkspace;
		expect(VERBS).toContain('erase');
		const created = yield* t.as(t.admin).act('customers.create', [{ name: 'Acme' }]);
		expect(created.kind).toBe('committed');
		if (created.kind !== 'committed') throw new Error('the create did not commit');
		const record = created.records.find((record) => record.model === 'customers');
		if (record === undefined || record.model !== 'customers')
			throw new Error('the create returned no customer');
		const id = record.id;
		expect(
			yield* Effect.flip(t.as(t.member(['reader'])).act('customers.erase', { target: id }))
		).toMatchObject({ _tag: 'ActRefused', code: 'forbidden' });
		expect(yield* t.as(t.admin).act('customers.erase', { target: id })).toMatchObject({
			kind: 'committed'
		});
		expect(
			(yield* t.db.read([{ text: 'SELECT count(*)::int AS n FROM customers', params: [] }]))[0]
				?.rows
		).toEqual([{ n: 0 }]);
		const failure = yield* Effect.flip(
			t.as(t.member(['reader'])).act('customers.create', [{ name: 'Beta' }])
		);
		expect(failure).toBeInstanceOf(ActRefused);
		expect(failure).toMatchObject({ _tag: 'ActRefused', code: 'forbidden' });
	}).pipe(Effect.provide(TestWorkspace.layer({ manifest })))
);
it.effect(
	'serializes new members before the next database statement without charging member setup',
	() =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const users = Array.from({ length: 4 }, () => t.member(['reader']));
			t.count.reset();
			const results = yield* Effect.all(
				users.map((member) =>
					t.db.read([{ text: 'SELECT id FROM sys_user WHERE id = $1', params: [member.id] }])
				),
				{ concurrency: 'unbounded' }
			);
			expect(results.map(([result]) => result?.rows[0]?.['id'])).toEqual(
				users.map((member) => member.id)
			);
			expect(t.count.reads).toBe(4);
			expect(t.count.writes).toBe(0);
		}).pipe(Effect.provide(TestWorkspace.layer({ manifest })))
);
