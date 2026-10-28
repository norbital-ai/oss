import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Writes } from '../src/engine/services.ts';
import { rollbackPlan } from '../src/engine/approvals/rollback.ts';
import { restorePreview } from '../src/engine/write/restore.ts';
import { TestWorkspace } from '../src/test/index.ts';

const manifest: EngineManifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		folders: { description: 'A folder', label: 'name', fields: { name: { kind: 'text' } } },
		documents: { description: 'A document', label: 'name', fields: { name: { kind: 'text' } } }
	},
	relationships: {
		'documents.folder': { to: 'folders', optional: true, onDelete: 'setNull' }
	},
	exposures: {
		folders: {
			read: { folders: { fields: 'all' } },
			create: { columns: { folders: ['name'] } },
			delete: {}
		},
		documents: {
			read: { documents: { fields: 'all' } },
			create: { columns: { documents: ['name', 'folder'] } },
			update: { columns: { documents: ['name', 'folder'] } }
		}
	},
	policies: {},
	teams: {},
	integrations: {},
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};
const Folder = Schema.Struct({ id: Schema.String, name: Schema.String, revision: Schema.Number });
const Document = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	folder: Schema.NullOr(Schema.String),
	revision: Schema.Number
});
const fixture = Effect.gen(function* () {
	const context = yield* Layer.build(
		TestWorkspace.layer({
			manifest,
			now: '2026-10-24T08:00:00.000Z'
		})
	);
	const t = Context.get(context, TestWorkspace),
		writes = Context.get(context, Writes),
		admin = t.as(t.admin).authority;
	const bindings = {
		now: t.clock.now(),
		today: t.clock.now().slice(0, 10),
		tz: 'UTC'
	};
	const act = (model: 'folders' | 'documents', verb: 'create' | 'delete', input: Json) => {
		const key = randomUUID();
		return writes.act({
			model,
			verb,
			input,
			authority: admin,
			key,
			issuedAt: bindings.now,
			invocationId: key,
			mode: { _tag: 'Direct' },
			bindings
		});
	};
	const create = Effect.fnUntraced(function* (model: 'folders' | 'documents', input: Json) {
		const { outcome } = yield* act(model, 'create', [input]);
		if (outcome.kind !== 'committed') throw new Error(JSON.stringify(outcome));
		const record = outcome.records.find((row) => row.model === model);
		if (record === undefined) throw new Error('Created record required');
		return record.id;
	});
	const folder = yield* create('folders', { name: 'Folder A' }),
		document = yield* create('documents', { name: 'Document B', folder });
	const folderRow = () =>
		t.db.one(Folder, {
			text: 'SELECT id,name,revision FROM folders WHERE id=$1',
			params: [folder]
		});
	const documentRow = () =>
		t.db
			.one(Document, {
				text: 'SELECT id,name,folder,revision FROM documents WHERE id=$1',
				params: [document]
			})
			.pipe(Effect.map(Option.getOrThrow));
	return {
		t,
		admin,
		bindings,
		act,
		folder,
		document,
		folderRow,
		documentRow
	};
});

// A rejected provisional delete restoring its rows and nulled references is native-referential-actions'; this file owns
// what an ordinary restore and a rollback skip when the referenced row stays deleted.
describe('restore skips a reference to a row that stays deleted', () => {
	it.live('a restore preview and a rollback without history leave the reference unset', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture;
				expect((yield* f.act('folders', 'delete', [{ target: f.folder }])).outcome.kind).toBe(
					'committed'
				);
				const previewed = yield* restorePreview(
					{ manifest, db: f.t.db },
					{ model: 'documents', record: f.document, revision: 1 },
					f.admin,
					f.bindings
				);
				if (!previewed.ok) throw new Error(JSON.stringify(previewed.outcome));
				expect(previewed.preview.changes).toEqual([]);
				expect(previewed.preview.skipped).toEqual([
					{ field: 'folder', current: null, restored: f.folder, reason: 'deletedTarget' }
				]);
				yield* f.t.db.write({
					text: 'DELETE FROM bolt_history WHERE collection=$1 AND record=$2',
					params: ['folders', f.folder]
				});
				const plan = yield* rollbackPlan(
					manifest,
					f.t.db,
					[
						{ model: 'folders', id: f.folder, op: 'delete', before: 1 },
						{ model: 'documents', id: f.document, op: 'update', before: 1 }
					],
					f.bindings
				);
				expect(plan.writes).toEqual([]);
				expect(plan.skipped).toEqual(
					expect.arrayContaining([
						{ model: 'folders', id: f.folder, field: '*', reason: 'noHistory' },
						{ model: 'documents', id: f.document, field: 'folder', reason: 'deletedTarget' }
					])
				);
				expect(Option.isNone(yield* f.folderRow())).toBe(true);
				expect(yield* f.documentRow()).toMatchObject({ folder: null, revision: 2 });
			})
		)
	);
});
