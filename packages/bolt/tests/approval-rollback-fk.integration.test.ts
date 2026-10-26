import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Approvals, Writes } from '../src/engine/services.ts';
import { rollbackPlan } from '../src/engine/approvals/rollback.ts';
import { restorePreview } from '../src/engine/write/restore.ts';
import { TestWorkspace } from '../src/test/index.ts';
import { program } from './support/guest-fixture.ts';

const manifest: EngineManifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		folders: { description: 'A folder', label: 'name', fields: { name: { kind: 'text' } } },
		documents: { description: 'A document', label: 'name', fields: { name: { kind: 'text' } } }
	},
	relationships: {
		'documents.folder': { to: 'folders', optional: true, onDelete: 'setNull' }
	},
	collections: {
		folders: {
			read: { fields: 'all' },
			create: { input: { columns: ['name'] } },
			delete: {}
		},
		documents: {
			read: { fields: 'all' },
			create: { input: { columns: ['name', 'folder'] } },
			update: { input: { columns: ['name', 'folder'] } }
		}
	},
	policies: {
		requester: {
			description: 'Requests folder deletion',
			grants: {
				folders: { read: true, history: true, delete: { approval: true } },
				documents: { read: true, history: true }
			}
		},
		reviewer: {
			description: 'Reviews folder deletion',
			grants: { folders: { read: true }, documents: { read: true } }
		}
	},
	teams: { requesters: ['requester'], reviewers: ['reviewer'] },
	integrations: {},
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};
const source = `export default { policy: { requester: { grants: { folders: {
	delete: { approval: (write, flow) => flow.step('Review deletion', {teams:['reviewers']}) }
} } } } };`;
const Folder = Schema.Struct({ id: Schema.String, name: Schema.String, revision: Schema.Number });
const Document = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	folder: Schema.NullOr(Schema.String),
	revision: Schema.Number
});
const Checkpoint = Schema.Struct({
	collection: Schema.String,
	id: Schema.String,
	op: Schema.Literals(['create', 'update', 'delete']),
	before: Schema.NullOr(Schema.Number)
});

const fixture = Effect.gen(function* () {
	const context = yield* Layer.build(
		TestWorkspace.layer({
			manifest,
			guest: yield* program(source),
			now: '2026-10-24T08:00:00.000Z'
		})
	);
	const t = Context.get(context, TestWorkspace),
		writes = Context.get(context, Writes),
		approvals = Context.get(context, Approvals),
		admin = t.as(t.admin).authority,
		requester = t.as(
			t.member(['requester'], { teams: ['requesters'], teamPath: ['requesters'] })
		).authority,
		reviewer = t.as(
			t.member(['reviewer'], { teams: ['reviewers'], teamPath: ['reviewers'] })
		).authority;
	const bindings = {
		now: t.clock.now(),
		today: t.clock.now().slice(0, 10),
		tz: 'UTC',
		params: {}
	};
	const act = (
		collection: 'folders' | 'documents',
		verb: 'create' | 'delete',
		input: Json,
		authority = admin
	) => {
		const key = randomUUID();
		return writes.act({
			collection,
			verb,
			input,
			authority,
			key,
			issuedAt: bindings.now,
			invocationId: key,
			mode: { _tag: 'Direct' },
			bindings
		});
	};
	const create = Effect.fnUntraced(function* (collection: 'folders' | 'documents', input: Json) {
		const { outcome } = yield* act(collection, 'create', input);
		if (outcome.kind !== 'committed') throw new Error(JSON.stringify(outcome));
		const record = outcome.records.find((row) => row.collection === collection);
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
		approvals,
		admin,
		requester,
		reviewer,
		bindings,
		act,
		folder,
		document,
		folderRow,
		documentRow
	};
});

describe('approval rollback restores references to recreated rows', () => {
	it.live('rejecting a provisional delete restores the deleted row and its nulled live FK', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture;
				const { outcome } = yield* f.act('folders', 'delete', { target: f.folder }, f.requester);
				if (outcome.kind !== 'pendingApproval') throw new Error(JSON.stringify(outcome));
				expect(Option.isNone(yield* f.folderRow())).toBe(true);
				expect(yield* f.documentRow()).toMatchObject({ folder: null, revision: 2 });
				const checkpoints = yield* f.t.db.value(Schema.Array(Checkpoint), {
					text: 'SELECT records FROM bolt_approvals WHERE id=$1',
					params: [outcome.requestId]
				});
				expect(checkpoints).toEqual(
					expect.arrayContaining([
						{ collection: 'folders', id: f.folder, op: 'delete', before: 1 },
						{ collection: 'documents', id: f.document, op: 'update', before: 1 }
					])
				);
				expect(
					yield* f.approvals.decide({
						requestId: outcome.requestId,
						decision: 'reject',
						reason: 'Keep the folder and its link',
						authority: f.reviewer,
						now: f.bindings.now
					})
				).toMatchObject({ kind: 'decided', status: 'Rejected' });
				expect(Option.getOrThrow(yield* f.folderRow())).toEqual({
					id: f.folder,
					name: 'Folder A',
					revision: 3
				});
				expect(yield* f.documentRow()).toEqual({
					id: f.document,
					name: 'Document B',
					folder: f.folder,
					revision: 3
				});
				const histories = yield* f.t.db.rows(
					Schema.Struct({ collection: Schema.String, restored_from: Schema.Number }),
					{
						text: "SELECT collection,restored_from FROM bolt_history WHERE request=$1 AND cause='restored' ORDER BY collection",
						params: [outcome.requestId]
					}
				);
				expect(histories).toEqual([
					{ collection: 'documents', restored_from: 1 },
					{ collection: 'folders', restored_from: 1 }
				]);
			})
		)
	);

	it.live('ordinary restore preview still skips a reference whose target remains deleted', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture;
				expect((yield* f.act('folders', 'delete', { target: f.folder })).outcome.kind).toBe(
					'committed'
				);
				const previewed = yield* restorePreview(
					{ manifest, db: f.t.db },
					{ collection: 'documents', record: f.document, revision: 1 },
					f.admin,
					f.bindings
				);
				if (!previewed.ok) throw new Error(JSON.stringify(previewed.outcome));
				expect(previewed.preview.changes).toEqual([]);
				expect(previewed.preview.skipped).toEqual([
					{ field: 'folder', current: null, restored: f.folder, reason: 'deletedTarget' }
				]);
				expect(Option.isNone(yield* f.folderRow())).toBe(true);
				expect(yield* f.documentRow()).toMatchObject({ folder: null, revision: 2 });
			})
		)
	);

	it.live('a missing checkpoint without history does not make a reference restorable', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture;
				expect((yield* f.act('folders', 'delete', { target: f.folder })).outcome.kind).toBe(
					'committed'
				);
				yield* f.t.db.write({
					text: 'DELETE FROM bolt_history WHERE collection=$1 AND record=$2',
					params: ['folders', f.folder]
				});
				const plan = yield* rollbackPlan(
					manifest,
					f.t.db,
					[
						{ collection: 'folders', id: f.folder, op: 'delete', before: 1 },
						{ collection: 'documents', id: f.document, op: 'update', before: 1 }
					],
					f.bindings
				);
				expect(plan.writes).toEqual([]);
				expect(plan.skipped).toEqual(
					expect.arrayContaining([
						{ collection: 'folders', id: f.folder, field: '*', reason: 'noHistory' },
						{ collection: 'documents', id: f.document, field: 'folder', reason: 'deletedTarget' }
					])
				);
				expect(Option.isNone(yield* f.folderRow())).toBe(true);
				expect(yield* f.documentRow()).toMatchObject({ folder: null, revision: 2 });
			})
		)
	);
});
