// A write's `on_approved` rows follow its approval: at once when no approval holds it, in the approving decision's one
// commit when one does (the decision asks the callback again), never when it is rejected. `with` rows are held with it.
import { randomUUID } from 'node:crypto';
import { expect, layer } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { Authority, EngineActor, Outcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { compile_authority } from '../src/engine/access/authority.ts';
import { Approvals, Writes } from '../src/engine/services.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { manifest as base } from './write-fixture.ts';

const requesterId = '0199a000-0000-7000-8000-000000000001',
	managerId = '0199a000-0000-7000-8000-000000000002';
const manifest: EngineManifest = {
	...base,
	models: {
		leaves: {
			description: 'Leaves',
			record_label: 'record.name',
			fields: { name: { kind: 'text' }, note: { kind: 'text', optional: true } }
		},
		steps: {
			description: 'A step',
			record_label: 'record.label',
			fields: { label: { kind: 'text' } }
		},
		holds: {
			description: 'Holds',
			record_label: 'record.name',
			fields: { name: { kind: 'text' } }
		},
		postings: {
			description: 'Postings',
			record_label: 'record.source',
			fields: { source: { kind: 'text' }, carrier: { kind: 'text', optional: true } }
		}
	},
	relationships: { 'steps.leaf': { to: 'leaves', inverse: 'steps', owned: true } },
	exposures: {
		leaves: {
			outputs: { default: { leaves: { fields: 'all' } } },
			create: { columns: { leaves: ['name'], 'leaves.steps': ['label'] }, transform: true },
			update: { columns: { leaves: ['note'] }, transform: true }
		},
		holds: {
			outputs: { default: { holds: { fields: 'all' } } },
			create: { columns: { holds: ['name'] } }
		},
		postings: {
			outputs: { default: { postings: { fields: 'all' } } },
			create: { columns: { postings: ['source', 'carrier'] }, transform: true }
		}
	},
	policies: {
		requester: {
			description: 'Requests',
			grants: { leaves: { outputs: { default: true }, create: { verdict: true } } }
		},
		reviewer: {
			description: 'Reviews',
			grants: {
				leaves: { outputs: { default: true }, update: {} },
				approval_request: { outputs: { default: true } }
			}
		}
	},
	teams: { requesters: { policies: ['requester'] }, managers: { policies: ['reviewer'] } }
};
const source = `export default { model: {
	leaves: { bodies: {
		create: function* (changes, ctx) {
            const rows = changes.map(({ after }) => after);
			if (ctx.approving && rows.some((row) => row.name === 'refused on approval')) return yield* ctx.refuse('Not on approval.');
			if (rows.some((row) => row.name === 'stepped') && rows.some((row) => (row.steps ?? []).length !== 2)) return yield* ctx.refuse('Steps went missing.');
			return {
				sets: changes.map(({ set }) => set),
				with: { holds: { create: rows.map((row) => ({ name: 'hold ' + row.name })) } },
				on_approved: { postings: { create: rows.map((row) => ({ source: row.name })) } }
			};
		},
		update: function* (changes) {
			return { sets: changes.map(({ set }) => set), on_approved: { postings: { create: [{ source: 'edit' }] } } };
		}
	} },
	postings: { bodies: {
		create: function* (changes, ctx) {
            const rows = changes.map(({ set }) => set);
			if (rows.some((row) => row.source === 'posting refused')) return yield* ctx.refuse('This posting refuses.');
			return rows.map((row) => ({ ...row, carrier: ctx.carried_by }));
		}
	} }
}, policy: { requester: { grants: { leaves: { create: { verdict: function* (_rows, ctx) {
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
		writes = yield* Writes,
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
		);
	const act = (verb: 'create' | 'update', input: Json, authority = requester) => {
		const key = randomUUID(),
			now = t.clock.now();
		return writes
			.act({
				model: 'leaves',
				verb,
				input,
				authority,
				key,
				issuedAt: now,
				invocationId: key,
				mode: { _tag: 'Direct' },
				bindings: { now, today: now.slice(0, 10), tz: 'UTC' }
			})
			.pipe(Effect.map((result) => result.outcome));
	};
	const decide = (request_id: string, decision: 'approve' | 'reject', reason?: string) =>
		approvals.decide({
			request_id,
			decision,
			authority,
			now: t.clock.now(),
			...(reason === undefined ? {} : { reason })
		});
	const names = (table: 'holds' | 'leaves', like: string) =>
		t.db
			.rows(Schema.Struct({ name: Schema.String }), {
				text: `SELECT name FROM ${table} WHERE name LIKE $1 ORDER BY name`,
				params: [like]
			})
			.pipe(Effect.map((rows) => rows.map((row) => row.name)));
	const postings = (...sources: string[]) =>
		t.db.rows(Schema.Struct({ source: Schema.String, carrier: Schema.NullOr(Schema.String) }), {
			text: 'SELECT source, carrier FROM postings WHERE source IN (SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY source',
			params: [sources]
		});
	const state = (request_id: string) =>
		t.db.value(Schema.String, {
			text: 'SELECT state FROM bolt_approvals WHERE id = $1::uuid',
			params: [request_id]
		});
	const idOf = (name: string) =>
		t.db.value(Schema.String, {
			text: 'SELECT id::text FROM leaves WHERE name = $1',
			params: [name]
		});
	return { requester, manager, act, decide, names, postings, state, idOf };
});
const held = (outcome: Outcome) => {
	if (outcome.kind !== 'pending_approval') throw new Error(JSON.stringify(outcome));
	return outcome.request_id;
};

layer(workspace, { excludeTestServices: true })('on_approved', (it) => {
	it.effect('waits while the write is held, then commits in the approving decision', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const request = held(yield* f.act('create', [{ name: 'annual' }]));
			// `with` is part of the held write; `on_approved` is not written yet
			expect(yield* f.names('holds', 'hold annual')).toEqual(['hold annual']);
			expect(yield* f.postings('annual')).toEqual([]);
			expect(yield* f.decide(request, 'approve')).toMatchObject({ status: 'Approved' });
			expect(yield* f.postings('annual')).toEqual([{ source: 'annual', carrier: 'leaves' }]);
		})
	);

	it.effect('leaves the request pending and writes nothing when anything it carries refuses', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			for (const [name, message] of [
				['refused on approval', 'Not on approval.'],
				['posting refused', 'This posting refuses.']
			] as const) {
				const request = held(yield* f.act('create', [{ name }]));
				expect(yield* f.decide(request, 'approve')).toMatchObject({ kind: 'refused', message });
				expect(yield* f.state(request)).toBe('Pending');
				expect(yield* f.postings(name)).toEqual([]);
			}
		})
	);

	it.effect('is never written when the write is rejected, and its with rows roll back', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const request = held(yield* f.act('create', [{ name: 'sick' }]));
			expect(yield* f.decide(request, 'reject', 'No')).toMatchObject({ status: 'Rejected' });
			expect(yield* f.names('leaves', 'sick')).toEqual([]);
			expect(yield* f.names('holds', 'hold sick')).toEqual([]);
			expect(yield* f.postings('sick')).toEqual([]);
		})
	);

	it.effect('is never written when the requester withdraws, and its with rows roll back', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const request = held(yield* f.act('create', [{ name: 'unpaid' }]));
			expect(yield* f.decide(request, 'withdraw', undefined, f.requester)).toMatchObject({
				status: 'Withdrawn'
			});
			expect(yield* f.names('leaves', 'unpaid')).toEqual([]);
			expect(yield* f.names('holds', 'hold unpaid')).toEqual([]);
			expect(yield* f.postings('unpaid')).toEqual([]);
		})
	);

	it.effect(
		'waits too for an approver change to the held record, which the decision asks again',
		() =>
			Effect.gen(function* () {
				const f = yield* fixture;
				const request = held(yield* f.act('create', [{ name: 'edited' }]));
				const target = yield* f.idOf('edited');
				expect(
					yield* f.act('update', [{ target, set: { note: 'checked' } }], f.manager)
				).toMatchObject({ kind: 'committed' });
				expect(yield* f.postings('edit', 'edited')).toEqual([]);
				expect(yield* f.decide(request, 'approve')).toMatchObject({ status: 'Approved' });
				expect(yield* f.postings('edit', 'edited')).toEqual([
					{ source: 'edited', carrier: 'leaves' }
				]);
			})
	);

	it.effect('waits too when an update of the held record changes nothing', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const request = held(yield* f.act('create', [{ name: 'idle' }]));
			const target = yield* f.idOf('idle');
			// no column moves, so it is no write; what its body carries must not post ahead of the decision
			yield* f.act('update', [{ target, set: { name: 'idle' } }], { ...f.requester, admin: true });
			expect(yield* f.postings('edit', 'idle')).toEqual([]);
			expect(yield* f.decide(request, 'reject', 'No')).toMatchObject({ status: 'Rejected' });
			expect(yield* f.postings('edit', 'idle')).toEqual([]);
			expect(yield* f.postings('idle')).toEqual([]);
		})
	);

	it.effect('asks a held create again with its owned children, as they now stand', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			const request = held(
				yield* f.act('create', [{ name: 'stepped', steps: [{ label: 'one' }, { label: 'two' }] }])
			);
			expect(yield* f.decide(request, 'approve')).toMatchObject({ status: 'Approved' });
			expect(yield* f.postings('stepped')).toEqual([{ source: 'stepped', carrier: 'leaves' }]);
		})
	);

	it.effect('commits with the write when no approval holds it', () =>
		Effect.gen(function* () {
			const f = yield* fixture;
			expect(
				yield* f.act('create', [{ name: 'direct' }], { ...f.requester, admin: true })
			).toMatchObject({ kind: 'committed' });
			expect(yield* f.postings('direct')).toEqual([{ source: 'direct', carrier: 'leaves' }]);
		})
	);
});
