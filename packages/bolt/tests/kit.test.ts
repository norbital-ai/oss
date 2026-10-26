// Kit edge cases: the generated verb catalogue owns erase, and member setup is never a counted statement.
import { expect, it } from '@effect/vitest';
import { Effect, Layer, Result } from 'effect';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { VERBS } from '../src/engine/callables/index.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { ActRefused } from '../src/decl/errors.ts';
import { TestWorkspace } from '../src/test/effect.ts';
import { auditFromAbi } from '../src/engine/audit.ts';
const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			customers: { description: 'A customer', label: 'name', fields: { name: { kind: 'text' } } }
		},
		relationships: {},
		collections: {
			customers: { read: { fields: 'all' }, create: { input: { columns: ['name'] } } }
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
		const created = yield* t.as(t.admin).act('customers.create', { name: 'Acme' });
		expect(created.kind).toBe('committed');
		if (created.kind !== 'committed') throw new Error('the create did not commit');
		const record = created.records.find((record) => record.collection === 'customers');
		if (record === undefined || record.collection !== 'customers')
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
			t.as(t.member(['reader'])).act('customers.create', { name: 'Beta' })
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
		}).pipe(
			Effect.provide(
				TestWorkspace.layer({
					manifest,
					// This fixture measures member setup without a background audit-recovery worker.
					ports: auditFromAbi(undefined).pipe(Layer.provide(NodeCrypto.layer))
				})
			)
		)
);
