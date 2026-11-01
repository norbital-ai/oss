import { randomUUID } from 'node:crypto';
import { expect, layer } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { Writes } from '../src/engine/services.ts';
import { dynamicRead } from '../src/protocol/read-request.ts';
import { exposure } from '../src/engine/access/exposure.ts';
import { manifest as base } from './write-fixture.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { Json } from '../src/decl/values.ts';

const manifest: EngineManifest = {
	...base,
	models: {
		entries: {
			description: 'People',
			record_label: "'PERSON ' + record.code + ' · ' + record.display_name",
			fields: {
				code: { kind: 'seq', pattern: 'P-{0000}' },
				first_name: { kind: 'text' },
				last_name: { kind: 'text' }
			},
			computed: {
				display_name: {
					kind: 'text',
					expr: { concat: [{ field: 'first_name' }, ' ', { field: 'last_name' }] }
				}
			}
		}
	},
	relationships: {},
	exposures: {
		entries: {
			read: { entries: { fields: 'all' } },
			outputs: {
				public: { entries: { fields: ['first_name'] } },
				directory: { entries: { fields: ['code', 'display_name'] } }
			},
			create: { columns: { entries: ['first_name', 'last_name'] } },
			update: { columns: { entries: ['first_name', 'last_name'] } }
		}
	},
	policies: {
		public: {
			description: 'Names only',
			grants: { entries: { outputs: { public: true } }, approval_request: { read: true } }
		},
		directory: {
			description: 'Named output only',
			grants: { entries: { outputs: { directory: true } }, approval_request: { read: true } }
		},
		blocked: {
			description: 'The label fields are visible but the target row is not',
			grants: {
				entries: { outputs: { directory: { entries: { where: { code: { eq: 'P-NONE' } } } } } },
				approval_request: { read: true }
			}
		}
	},
	teams: {}
};

layer(TestWorkspace.layer({ manifest }), { excludeTestServices: true })(
	'materialized record labels',
	(it) => {
		it.effect(
			'indexes CEL identifiers without search.text, updates them on writes, and protects hidden dependencies',
			() =>
				Effect.gen(function* () {
					const t = yield* TestWorkspace,
						writes = yield* Writes;
					const admin = t.as(t.admin);
					const act = (verb: 'create' | 'update', input: Json) => {
						const key = randomUUID(),
							now = t.clock.now();
						return writes.act({
							model: 'entries',
							verb,
							input,
							authority: admin.authority,
							key,
							issuedAt: now,
							invocationId: key,
							mode: { _tag: 'Direct' },
							bindings: { now, today: now.slice(0, 10), tz: 'UTC' }
						});
					};
					const outcome = (yield* act('create', [{ first_name: 'Ada', last_name: 'Lovelace' }]))
						.outcome;
					if (outcome.kind !== 'committed') throw new Error(JSON.stringify(outcome));
					const id = outcome.records[0]?.id;
					if (id === undefined) throw new Error('Missing entry');
					const search = (text: string) =>
						admin.query(
							dynamicRead({ entries: { search: text, fields: ['code', 'display_name'] } })
						);
					const stored = yield* t.db.rows(
						Schema.Struct({ code: Schema.String, bolt_record_label: Schema.String }),
						{
							text: 'SELECT code, bolt_record_label FROM entries WHERE id::text = $1',
							params: [id]
						}
					);
					expect(stored).toEqual([
						{ code: 'P-0001', bolt_record_label: 'PERSON P-0001 · Ada Lovelace' }
					]);
					const request = randomUUID();
					yield* t.db.write({
						text: `INSERT INTO approval_request
						(id, collection_name, record_id, action, status, step, steps, step_names, approver_teams, approver_users, superseder_teams, created_at)
						VALUES ($1, 'entries', $2, 'update', 'APPROVED', 0, 1, '[]', '[]', '[]', '[]', now())`,
						params: [request, id]
					});
					const approvalSearch = (text: string, caller = admin) =>
						caller.query(
							dynamicRead({ approval_request: { search: text, fields: ['collection_name'] } })
						);
					expect((yield* approvalSearch('Lovelace')).approval_request?.rows).toEqual([
						{ id: request, collection_name: 'entries', $label: 'PERSON P-0001 · Ada Lovelace' }
					]);
					expect((yield* search('PERSON')).entries?.rows).toMatchObject([
						{ id, display_name: 'Ada Lovelace' }
					]);
					expect(exposure(manifest, admin.authority).entries?.search).toEqual(['$label']);
					expect(
						yield* t.db.value(Schema.Boolean, {
							text: "SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'entries' AND indexdef ILIKE '%using gin%')",
							params: []
						})
					).toBe(true);
					yield* act('update', [{ target: id, set: { last_name: 'Byron' } }]);
					expect((yield* approvalSearch('Lovelace')).approval_request?.rows).toEqual([]);
					expect((yield* approvalSearch('Byron')).approval_request?.rows).toEqual([
						{ id: request, collection_name: 'entries', $label: 'PERSON P-0001 · Ada Byron' }
					]);
					expect((yield* search('Lovelace')).entries?.rows).toEqual([]);
					expect((yield* search('PERSON Byron')).entries?.rows).toMatchObject([
						{ id, display_name: 'Ada Byron' }
					]);
					const publicReader = t.as(t.member(['public']));
					expect(
						(yield* approvalSearch('Byron', t.as(t.member(['blocked'])))).approval_request?.rows
					).toEqual([]);
					expect((yield* approvalSearch('Byron', publicReader)).approval_request?.rows).toEqual([]);
					expect(
						(yield* approvalSearch('Byron', t.as(t.member(['directory'])))).approval_request?.rows
					).toEqual([
						{ id: request, collection_name: 'entries', $label: 'PERSON P-0001 · Ada Byron' }
					]);
					expect(exposure(manifest, publicReader.authority).entries?.record_label).toBeUndefined();
					expect(exposure(manifest, publicReader.authority).entries?.label).toEqual([]);
					const restricted = yield* publicReader.query(
						dynamicRead({ entries: { output: 'public', search: 'Byron', fields: ['first_name'] } })
					);
					expect(restricted.entries?.rows).toEqual([]);
				})
		);
	}
);
