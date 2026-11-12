import { expect, layer } from '@effect/vitest';
import { Deferred, Effect, Queue, Schema, Stream } from 'effect';
import { TestWorkspace, type Kit } from '../../bolt-cli/src/test/index.ts';
import { checkRules } from '../../bolt-cli/src/compiler/check/rules.ts';
import { exposure } from '../src/engine/access/exposure.ts';
import { lower_read } from '../src/engine/query/engine.ts';
import { Live } from '../src/engine/services.ts';
import { patched } from '../src/page/bolt.ts';
import { dynamic_read } from '../src/protocol/read-request.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { Frame } from '../src/protocol/wire.ts';
import type { Json } from '../src/decl/values.ts';
import { manifest as base } from './write-fixture.ts';

const HELPER = '10000000-0000-4000-8000-000000000001';
const VISIT = '20000000-0000-4000-8000-000000000001';
const NOTE = '30000000-0000-4000-8000-000000000001';
const INLINE = '40000000-0000-4000-8000-000000000001';
const APPROVAL = '50000000-0000-4000-8000-000000000001';
const NAMED_VISIT = '60000000-0000-4000-8000-000000000001';
const VisitRow = Schema.Struct({ id: Schema.String, number: Schema.String, $label: Schema.String });
const page = <A>(row: Schema.Decoder<A>) => Schema.Struct({
	rows: Schema.Array(row), next: Schema.optionalKey(Schema.NullOr(Schema.String)),
	total: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
});
const decode_visits = Schema.decodeUnknownEffect(Schema.Struct({ visits: page(VisitRow) }), { onExcessProperty: 'error' });
const decode_named_visits = Schema.decodeUnknownEffect(Schema.Struct({ named_visits: page(VisitRow) }), { onExcessProperty: 'error' });
const decode_notes = Schema.decodeUnknownEffect(Schema.Struct({ notes: page(Schema.Struct({
	id: Schema.String, title: Schema.String, visit: Schema.NullOr(VisitRow)
})) }), { onExcessProperty: 'error' });
const decode_inline = Schema.decodeUnknownEffect(Schema.Struct({ inline: page(Schema.Struct({
	id: Schema.String, profile: Schema.Struct({ name: Schema.String })
})) }), { onExcessProperty: 'error' });
const decode_approvals = Schema.decodeUnknownEffect(Schema.Struct({ approval_request: page(Schema.Struct({
	id: Schema.String, collection_name: Schema.String, $label: Schema.String
})) }), { onExcessProperty: 'error' });
const approval = (t: Pick<Kit, 'db'>) => t.db.write({
	text: `INSERT INTO approval_request (id, collection_name, record_id, action, status, step, steps, step_names, approver_teams, approver_users, superseder_teams, created_at)
	VALUES ($1, 'visits', $2, 'update', 'APPROVED', 0, 1, '[]', '[]', '[]', '[]', now()) ON CONFLICT (id) DO NOTHING`, params: [APPROVAL, VISIT]
});
const manifest: EngineManifest = {
	...base,
	models: {
		helpers: {
			description: 'Helpers', fields: { name: { kind: 'text' }, code: { kind: 'text' }, visible: { kind: 'bool' } }
		},
		visits: {
			description: 'Visits', record_label: "record.number + ' · ' + record.helper.name", fields: { number: { kind: 'text' } }
		},
		named_visits: {
			description: 'Visits whose helper is exposed by a named output',
			record_label: "record.number + ' · ' + record.helper.name", fields: { number: { kind: 'text' } }
		},
		notes: { description: 'Notes', fields: { title: { kind: 'text' } } },
		inline: {
			description: 'Inline labels', record_label: 'record.profile.name',
			fields: { profile: { kind: 'object', fields: { name: { kind: 'text' } } } }
		}
	},
	relationships: { 'visits.helper': { to: 'helpers' }, 'named_visits.helper': { to: 'helpers' }, 'notes.visit': { to: 'visits' } },
	exposures: {
		helpers: { outputs: { default: { helpers: { fields: 'all' } } }, update: { columns: { helpers: ['name'] } } },
		visits: {
			outputs: {
				default: { visits: { fields: ['number'] }, 'visits.helper': { fields: ['name'] } },
				directory: { visits: { fields: ['number'] }, 'visits.helper': { fields: ['name'] } },
				hidden: { visits: { fields: ['number'] }, 'visits.helper': { fields: ['code'] } },
				plain: { visits: { fields: ['number'] } }
			}
		},
		named_visits: { outputs: {
			default: { named_visits: { fields: ['number'] } },
			directory: { named_visits: { fields: ['number'] }, 'named_visits.helper': { fields: ['name'] } }
		} },
		notes: { outputs: { default: {
			notes: { fields: ['title'] }, 'notes.visit': { fields: ['number'] }, 'notes.visit.helper': { fields: ['name'] }
		} } },
		inline: { outputs: { default: { inline: { fields: ['profile'] } } } }
	},
	policies: {
		visible: { description: 'Visit and nested helper, no helper root grant', grants: {
			visits: { outputs: { default: true } }, notes: { outputs: { default: true } }, approval_request: { outputs: { default: true } }
		} },
		named: { description: 'Named visit output only', grants: {
			visits: { outputs: { directory: true } }, approval_request: { outputs: { default: true } }
		} },
		named_only: { description: 'Related label through a named output only', grants: {
			named_visits: { outputs: { directory: true } }
		} },
		default_only: { description: 'Default output hides the label relation', grants: {
			named_visits: { outputs: { default: true } }
		} },
		hidden: { description: 'The helper name is outside this output', grants: {
			visits: { outputs: { hidden: true } }, approval_request: { outputs: { default: true } }
		} },
		plain: { description: 'No helper layer', grants: { visits: { outputs: { plain: true } }, approval_request: { outputs: { default: true } } } },
		blocked: { description: 'The helper row is outside the layer scope', grants: {
			visits: { outputs: { default: { scopes: { 'visits.helper': { visible: { eq: false } } } } } },
			approval_request: { outputs: { default: true } }
		} }
	},
	teams: {}
};

layer(TestWorkspace.layer({ manifest, seed: {
	helpers: [{ id: HELPER, name: 'Ada', code: 'H1', visible: true }],
	visits: [{ id: VISIT, number: 'V1', helper: HELPER }],
	named_visits: [{ id: NAMED_VISIT, number: 'N1', helper: HELPER }],
	notes: [{ id: NOTE, title: 'Follow up', visit: VISIT }],
	inline: [{ id: INLINE, profile: { name: 'Nested' } }]
} }), { excludeTestServices: true })('one-hop record labels', (it) => {
	it.effect('reads current relation labels without a separate target-root grant, and keeps inline labels materialized', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace, viewer = yield* t.as(t.member(['visible']));
			expect(checkRules(manifest, { automations: [] }, (role, name) => `${role}/${name}`)
				.filter((finding) => finding.code === 'model/label')).toEqual([]);
			expect((yield* Effect.result(viewer.query(dynamic_read({ helpers: { fields: ['name'] } }))))._tag).toBe('Failure');
			expect((yield* viewer.query(dynamic_read({ visits: { fields: ['number'], search: 'Ada' } }))
				.pipe(Effect.flatMap(decode_visits))).visits.rows)
				.toEqual([{ id: VISIT, number: 'V1', $label: 'V1 · Ada' }]);
			expect((yield* viewer.query(dynamic_read({ notes: { fields: ['title'], visit: { fields: ['number'] } } }))
				.pipe(Effect.flatMap(decode_notes))).notes.rows)
				.toEqual([{ id: NOTE, title: 'Follow up', visit: { id: VISIT, number: 'V1', $label: 'V1 · Ada' } }]);
			expect((yield* (yield* t.as(t.admin)).query(dynamic_read({ inline: { fields: ['profile'], search: 'Nested' } }))
				.pipe(Effect.flatMap(decode_inline))).inline.rows)
				.toEqual([{ id: INLINE, profile: { name: 'Nested' } }]);
			const columns = yield* t.db.read([{
				text: `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('visits', 'inline') AND column_name = 'bolt_record_label' ORDER BY table_name`, params: []
			}]);
			expect(columns[0]?.rows).toEqual([{ table_name: 'inline' }]);
			for (const [policy, output] of [['hidden', 'hidden'], ['plain', 'plain'], ['blocked', 'default']] as const) {
				const reader = yield* t.as(t.member([policy]));
				expect((yield* reader.query(dynamic_read({ visits: { output, fields: ['number'] } }))
					.pipe(Effect.flatMap(decode_visits))).visits.rows)
					.toEqual([{ id: VISIT, number: 'V1', $label: VISIT }]);
				expect((yield* reader.query(dynamic_read({ visits: { output, fields: ['number'], search: 'Ada' } }))
					.pipe(Effect.flatMap(decode_visits))).visits.rows).toEqual([]);
				if (policy !== 'blocked') expect((yield* exposure(manifest, reader.authority)).visits?.record_label).toBeUndefined();
			}
		})
	);
	it.effect('a named output exposes a valid label hidden by the default output', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const named = yield* t.as(t.member(['named_only'])), hidden = yield* t.as(t.member(['default_only']));
			expect(checkRules(manifest, { automations: [] }, (role, name) => `${role}/${name}`)
				.filter((finding) => finding.code === 'model/label')).toEqual([]);
			expect((yield* Effect.result(named.query(dynamic_read({ helpers: { fields: ['name'] } }))))._tag).toBe('Failure');
			expect((yield* named.query(dynamic_read({ named_visits: { output: 'directory', fields: ['number'] } }))
				.pipe(Effect.flatMap(decode_named_visits))).named_visits.rows)
				.toEqual([{ id: NAMED_VISIT, number: 'N1', $label: 'N1 · Ada' }]);
			expect((yield* named.query(dynamic_read({ named_visits: { output: 'directory', fields: ['number'], search: 'Ada' } }))
				.pipe(Effect.flatMap(decode_named_visits))).named_visits.rows)
				.toEqual([{ id: NAMED_VISIT, number: 'N1', $label: 'N1 · Ada' }]);
			expect((yield* hidden.query(dynamic_read({ named_visits: { fields: ['number'] } }))
				.pipe(Effect.flatMap(decode_named_visits))).named_visits.rows)
				.toEqual([{ id: NAMED_VISIT, number: 'N1', $label: NAMED_VISIT }]);
			expect((yield* hidden.query(dynamic_read({ named_visits: { fields: ['number'], search: 'Ada' } }))
				.pipe(Effect.flatMap(decode_named_visits))).named_visits.rows).toEqual([]);
			expect((yield* exposure(manifest, named.authority)).named_visits?.record_label)
				.toBe("record.number + ' · ' + record.helper.name");
			expect((yield* exposure(manifest, hidden.authority)).named_visits?.record_label).toBeUndefined();
		})
	);
	it.effect('approval labels and search use each granted target output and never expose a hidden dependency', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			yield* approval(t);
			for (const policy of ['visible', 'named', 'hidden', 'plain', 'blocked']) {
				const reader = yield* t.as(t.member([policy]));
				const rows = (yield* reader.query(dynamic_read({ approval_request: { fields: ['collection_name'], search: 'Ada' } }))
					.pipe(Effect.flatMap(decode_approvals))).approval_request.rows;
				expect(rows).toEqual(policy === 'visible' || policy === 'named'
					? [{ id: APPROVAL, collection_name: 'visits', $label: 'V1 · Ada' }] : []);
				if (policy !== 'visible' && policy !== 'named')
					expect((yield* reader.query(dynamic_read({ approval_request: { fields: ['collection_name'] } }))
						.pipe(Effect.flatMap(decode_approvals))).approval_request.rows)
						.toEqual([{ id: APPROVAL, collection_name: 'visits', $label: VISIT }]);
			}
		})
	);
	it.effect('a related-row write refreshes the retained label and lexical search without an explicit relation selection', () =>
		Effect.scoped(Effect.gen(function* () {
			const t = yield* TestWorkspace, live = yield* Live, viewer = yield* t.as(t.member(['visible']));
			yield* approval(t);
			const frames = yield* Queue.unbounded<Frame>(), hello = yield* Deferred.make<string>();
			yield* live.connect(viewer.authority).pipe(Stream.runForEach((frame) =>
				Effect.gen(function* () {
					yield* Queue.offer(frames, frame);
					if (frame.t === 'hello') yield* Deferred.succeed(hello, frame.conn);
				})
			), Effect.forkScoped);
			const conn = yield* Deferred.await(hello);
			yield* live.register(conn, 'label', { read: (yield* lower_read(manifest, 'query', [{ visits: { fields: ['number'] } }])) });
			let current: Json | undefined;
			const next = Effect.gen(function* () {
				for (;;) {
					const frame = yield* Queue.take(frames);
					if (frame.t === 'answer' && frame.view === 'label') return current = frame.value;
					if (frame.t === 'patch' && frame.view === 'label') return current = patched(current, frame.ops);
				}
			});
			expect(yield* next.pipe(Effect.flatMap(decode_visits))).toMatchObject({ visits: { rows: [{ id: VISIT, $label: 'V1 · Ada' }] } });
			// `helpers` is this file's own manifest, outside the registered type corpus
			const rename: Readonly<Record<string, Json>> = { 'helpers.update': [{ target: { id: HELPER, revision: 1 }, set: { name: 'Grace' } }] };
			yield* (yield* t.as(t.admin)).act(rename);
			yield* live.settled;
			expect(yield* next.pipe(Effect.flatMap(decode_visits))).toMatchObject({ visits: { rows: [{ id: VISIT, $label: 'V1 · Grace' }] } });
			expect((yield* viewer.query(dynamic_read({ visits: { fields: ['number'], search: 'Ada' } }))
				.pipe(Effect.flatMap(decode_visits))).visits.rows).toEqual([]);
			expect((yield* viewer.query(dynamic_read({ visits: { fields: ['number'], search: 'Grace' } }))
				.pipe(Effect.flatMap(decode_visits))).visits.rows)
				.toEqual([{ id: VISIT, number: 'V1', $label: 'V1 · Grace' }]);
			expect((yield* viewer.query(dynamic_read({ approval_request: { fields: ['collection_name'], search: 'Grace' } }))
				.pipe(Effect.flatMap(decode_approvals))).approval_request.rows)
				.toEqual([{ id: APPROVAL, collection_name: 'visits', $label: 'V1 · Grace' }]);
		}))
	);
	it.effect('authoring refuses unknown and multi-hop label dependencies', () =>
		Effect.sync(() => {
			const visits = manifest.models['visits'];
			if (visits === undefined) throw new Error('Missing visit source');
			const cases: readonly { source: EngineManifest; message: string }[] = [
				{ source: { ...manifest, models: { ...manifest.models, visits: { ...visits, record_label: 'record.helper.missing' } } }, message: 'unknown field' },
				{ source: {
					...manifest, models: { ...manifest.models, visits: { ...visits, record_label: 'record.helper.supervisor.name' } },
					relationships: { ...manifest.relationships, 'helpers.supervisor': { to: 'helpers', optional: true } }
				}, message: 'more than one relation' }
			];
			for (const { source, message } of cases)
				expect(checkRules(source, { automations: [] }, (role, name) => `${role}/${name}`)
					.some((finding) => finding.code === 'model/label' && finding.message.includes(message))).toBe(true);
		})
	);
});
