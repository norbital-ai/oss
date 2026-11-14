// A delete's transform carries rows of other models into the delete's own commit: straight to storage (no callback,
// effect or write trigger of their model), under its native rules and history, in its one statement or not at all. A held delete commits only its request: its rows stay, marked, and what it
// carries waits; the approving decision deletes them with everything carried, and a rejection restores nothing.
import { randomUUID } from 'node:crypto';
import { expect, layer } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { Authority, EngineActor, Outcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { compile_authority } from '../src/engine/access/authority.ts';
import { Approvals, Reads, Callables } from '../src/engine/services.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { manifest as base } from './write-fixture.ts';
import { one_act } from './support/act-one.ts';

const requesterId = '0199a000-0000-7000-8000-000000000011',
	managerId = '0199a000-0000-7000-8000-000000000012';
const manifest: EngineManifest = {
	...base,
	models: {
		entries: {
			description: 'Entries',
			record_label: 'record.name',
			fields: { name: { kind: 'text' } }
		},
		ledger: {
			description: 'Ledger',
			record_label: 'record.source',
			fields: { source: { kind: 'text' }, carrier: { kind: 'text', optional: true } },
			unique: [{ fields: ['source'], name: 'ledger_source_key' }]
		}
	},
	relationships: {},
	exposures: {
		entries: {
			outputs: { default: { entries: { fields: 'all' } } },
			create: { columns: { entries: ['name'] } },
			delete: { transform: true }
		},
		ledger: {
			outputs: { default: { ledger: { fields: 'all' } } },
			create: { columns: { ledger: ['source', 'carrier'] }, transform: true, effect: true }
		}
	},
	policies: {
		requester: {
			description: 'Requests',
			grants: { entries: { outputs: { default: {} }, create: {}, delete: { verdict: true } } }
		},
		reviewer: {
			description: 'Reviews',
			grants: { approval_request: { outputs: { default: {} } }, entries: { outputs: { default: {} } } }
		}
	},
	teams: { requesters: { policies: ['requester'] }, managers: { policies: ['reviewer'] } },
	automations: {
		heard: { description: 'Hears deletes', policies: ['reviewer'], on: [{ model: 'entries', verbs: ['delete'] }] },
		posted: { description: 'Hears postings', policies: ['reviewer'], on: [{ model: 'ledger', verbs: ['create'] }] }
	}
};
const source = `export default { model: {
	entries: { bodies: {
		delete: function* (changes, ctx) {
			const rows = changes.map(({ before }) => before);
			const at = rows.findIndex((row) => row.name === 'refuse');
			if (at >= 0) return yield* ctx.refuse('This entry stays.', { row: at });
			// one read for the whole batch: a row a later run already counted stays
			const { ledger } = yield* ctx.query({ ledger: { where: { source: { in: rows.map((row) => 'counted ' + row.name) } } } });
			const counted = rows.findIndex((row) => ledger.rows.some((entry) => entry.source === 'counted ' + row.name));
			if (counted >= 0) return yield* ctx.refuse('A later run already counted it.', { row: counted, field: 'name' });
			return {
				with: { ledger: { create: [...rows.map((row) => ({ source: 'undo ' + row.name })), { source: 'batch of ' + rows.length }] } },
				on_approved: { ledger: { create: rows.map((row) => ({ source: 'approved ' + row.name })) } }
			};
		}
	} },
	ledger: { bodies: {
		create: function* (changes) {
			return changes.map(({ set }) => ({ ...set, carrier: 'callback' }));
		}
	} }
}, policy: { requester: { grants: { entries: { delete: { verdict: function* (_rows, ctx) {
	return ctx.approve({ steps: [{ name: 'Manager', teams: ['managers'] }] });
} } } } } } };`;
const member = (id: string, team: string): Extract<EngineActor, { kind: 'member' }> => ({
	kind: 'member',
	id,
	email: null,
	phone: null,
	external: false,
	teams: [team],
	team_path: [team],
	admin: false,
	party: null
});
const workspace = Layer.unwrap(
	program(source).pipe(
		Effect.map((guest) => TestWorkspace.layer({ manifest, guest, now: '2026-11-07T08:00:00.000Z' }))
	)
);
const fixture = Effect.gen(function* () {
	const t = yield* TestWorkspace,
		writes = yield* Callables,
		reads = yield* Reads,
		approvals = yield* Approvals;
	yield* t.db.write({
		text: "INSERT INTO sys_user (id,name,kind,team) VALUES ($1,'Requester','staff','requesters'),($2,'Manager','staff','managers') ON CONFLICT (id) DO NOTHING",
		params: [requesterId, managerId]
	});
	const requester: Authority = yield* compile_authority(
			manifest,
			{ actor: member(requesterId, 'requesters'), policies: ['requester'], admin: false },
			requesterId
		),
		manager: Authority = yield* compile_authority(
			manifest,
			{ actor: member(managerId, 'managers'), policies: ['reviewer'], admin: false },
			managerId
		),
		admin: Authority = { ...requester, admin: true };
	const act = (verb: 'create' | 'delete', input: Json, authority = admin) => {
		const key = randomUUID(),
			now = t.clock.now();
		return writes
			.acts(one_act({
				model: 'entries',
				verb,
				input,
				authority,
				key,
				issuedAt: now,
				invocationId: key,
				bindings: { now, today: now.slice(0, 10), tz: 'UTC' }
			}))
			.pipe(Effect.map((result) => result.outcome));
	};
	const make = (...names: string[]) =>
		Effect.gen(function* () {
			expect(yield* act('create', names.map((name) => ({ name })))).toMatchObject({ kind: 'committed' });
			return yield* t.db.rows(Schema.Struct({ id: Schema.String }), {
				text: 'SELECT id::text FROM entries WHERE name IN (SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY name',
				params: [names]
			});
		});
	const targets = (rows: readonly { readonly id: string }[]) => rows.map(({ id }) => ({ target: id }));
	const decide = (request_id: string, decision: 'approve' | 'reject') =>
		approvals.decide({
			request_id,
			decision,
			authority: manager,
			now: t.clock.now(),
			...(decision === 'reject' ? { reason: 'No' } : {})
		});
	const entries = (...names: string[]) =>
		t.db
			.rows(Schema.Struct({ name: Schema.String }), {
				text: 'SELECT name FROM entries WHERE name IN (SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY name',
				params: [names]
			})
			.pipe(Effect.map((rows) => rows.map((row) => row.name)));
	const ledger = (...sources: string[]) =>
		t.db.rows(Schema.Struct({ source: Schema.String, carrier: Schema.NullOr(Schema.String) }), {
			text: 'SELECT source, carrier FROM ledger WHERE source IN (SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY source',
			params: [sources]
		});
	const history = (...sources: string[]) =>
		t.db.rows(Schema.Struct({ op: Schema.String, source: Schema.String }), {
			text: `SELECT h.op, l.source FROM bolt_history h JOIN ledger l ON l.id = h.record
				WHERE h.collection = 'ledger' AND l.source IN (SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY l.source`,
			params: [sources]
		});
	/** The row as `authority` reads it, with its `$approval`. */
	const read = (id: string, authority: Authority) => {
		const now = t.clock.now();
		return reads
			.run([{ kind: 'get', model: 'entries', id, select: { fields: null, relations: {} } }], { as: 'caller', authority }, { now, today: now.slice(0, 10), tz: 'UTC' })
			.pipe(Effect.map(([row]) => row));
	};
	const heard = (id: string) =>
		t.db.rows(Schema.Struct({ verb: Schema.String, records: Schema.Array(Schema.String) }), {
			text: `SELECT trigger->>'verb' AS verb, ARRAY(SELECT jsonb_array_elements_text(trigger->'records')) AS records
			FROM sys_run WHERE automation = 'heard' AND trigger->'records' ? $1`,
			params: [id]
		});
	// the ledger's model effect and write trigger: carried rows queue neither
	const ledgerRuns = t.db
		.rows(Schema.Struct({ automation: Schema.String }), {
			text: "SELECT automation FROM sys_run WHERE automation IN ('posted', 'ledger.effect.create')",
			params: []
		})
		.pipe(Effect.map((rows) => rows.length));
	return { t, requester, manager, act, make, targets, decide, entries, ledger, history, read, heard, ledgerRuns };
});
const held = (outcome: Outcome) => {
	if (outcome.kind !== 'pending_approval') throw new Error(JSON.stringify(outcome));
	return outcome.request_id;
};

layer(workspace, { excludeTestServices: true })('delete.transform', (it) => {
	it.effect('carries its rows into the delete commit with history, skipping their transform, effect and write trigger', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const rows = yield* f.make('annual');
			const before = yield* f.ledgerRuns;
			expect(yield* f.act('delete', f.targets(rows))).toMatchObject({ kind: 'committed' });
			expect(yield* f.entries('annual')).toEqual([]);
			expect(yield* f.ledger('undo annual', 'approved annual')).toEqual([
				{ source: 'approved annual', carrier: null },
				{ source: 'undo annual', carrier: null }
			]);
			expect(yield* f.ledgerRuns).toBe(before);
			expect(yield* f.history('undo annual')).toEqual([{ op: 'create', source: 'undo annual' }]);
		})
	);

	it.effect('writes nothing when the transform refuses', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const rows = yield* f.make('kept', 'refuse');
			expect(yield* f.act('delete', f.targets(rows))).toMatchObject({
				kind: 'refused',
				message: 'This entry stays.',
				row: 1
			});
			expect(yield* f.entries('kept', 'refuse')).toEqual(['kept', 'refuse']);
			expect(yield* f.ledger('undo kept', 'undo refuse')).toEqual([]);
		})
	);

	it.effect('guards with a read of the whole batch, refusing at the row and field', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const rows = yield* f.make('paid', 'payable');
			yield* f.t.db.write({ text: "INSERT INTO ledger (id, source) VALUES ($1::uuid, 'counted payable')", params: [randomUUID()] });
			expect(yield* f.act('delete', f.targets(rows))).toMatchObject({
				kind: 'refused',
				message: 'A later run already counted it.',
				row: 1,
				field: 'name'
			});
			expect(yield* f.entries('paid', 'payable')).toEqual(['paid', 'payable']);
		})
	);

	it.effect('deletes nothing when a carried row breaks a native unique rule', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const rows = yield* f.make('poison');
			yield* f.t.db.write({ text: "INSERT INTO ledger (id, source) VALUES ($1::uuid, 'undo poison')", params: [randomUUID()] });
			expect(yield* f.act('delete', f.targets(rows))).toMatchObject({ kind: 'refused' });
			expect(yield* f.entries('poison')).toEqual(['poison']);
			expect(yield* f.ledger('undo poison', 'approved poison')).toEqual([{ source: 'undo poison', carrier: null }]);
		})
	);

	it.effect('carries one row per deleted row in one statement', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const names = Array.from({ length: 25 }, (_, i) => `bulk ${String(i).padStart(2, '0')}`);
			const rows = yield* f.make(...names);
			f.t.count.reset();
			expect(yield* f.act('delete', f.targets(rows))).toMatchObject({ kind: 'committed' });
			expect(f.t.count.writes).toBe(1);
			expect(yield* f.entries(...names)).toEqual([]);
			expect((yield* f.ledger(...names.map((name) => `undo ${name}`))).length).toBe(25);
			// the transform saw the whole batch once
			expect(yield* f.ledger('batch of 25')).toEqual([{ source: 'batch of 25', carrier: null }]);
		})
	);

	it.effect('a held delete commits only its request and deletes on approval, with what it carries', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const rows = yield* f.make('sick', 'leave');
			f.t.count.reset();
			const request = held(yield* f.act('delete', f.targets(rows), f.requester));
			expect(f.t.count.writes).toBe(1);
			expect(yield* f.entries('sick', 'leave')).toEqual(['leave', 'sick']);
			expect(yield* f.ledger('undo sick', 'approved sick', 'batch of 2')).toEqual([]);
			for (const authority of [f.requester, f.manager])
				expect(yield* f.read(rows[0]?.id ?? '', authority)).toMatchObject({
					$approval: { request_id: request, state: 'Pending', pending_delete: true }
				});
			expect(yield* f.heard(rows[0]?.id ?? '')).toEqual([]);
			expect(yield* f.decide(request, 'approve')).toMatchObject({ status: 'Approved' });
			expect(yield* f.entries('sick', 'leave')).toEqual([]);
			// the decision's own delete emits the write event, once
			expect(yield* f.heard(rows[0]?.id ?? '')).toEqual([
				{ verb: 'delete', records: rows.map((row) => row.id).toSorted() }
			]);
			expect(yield* f.ledger('undo sick', 'approved sick', 'batch of 2')).toEqual([
				{ source: 'approved sick', carrier: null },
				{ source: 'batch of 2', carrier: null },
				{ source: 'undo sick', carrier: null }
			]);
			expect(yield* f.ledgerRuns).toBe(0);
			expect(yield* f.history('undo sick')).toEqual([{ op: 'create', source: 'undo sick' }]);
		})
	);

	it.effect('refuses a held delete at once when its transform refuses', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const rows = yield* f.make('refuse');
			expect(yield* f.act('delete', f.targets(rows), f.requester)).toMatchObject({
				kind: 'refused',
				message: 'This entry stays.'
			});
		})
	);

	it.effect('restores nothing when a held delete is rejected', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const rows = yield* f.make('unpaid');
			const request = held(yield* f.act('delete', f.targets(rows), f.requester));
			expect(yield* f.decide(request, 'reject')).toMatchObject({ status: 'Rejected' });
			expect(yield* f.entries('unpaid')).toEqual(['unpaid']);
			expect(yield* f.ledger('undo unpaid', 'approved unpaid')).toEqual([]);
			expect(yield* f.read(rows[0]?.id ?? '', f.requester)).not.toHaveProperty('$approval');
		})
	);
});
