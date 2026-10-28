// A native transaction opens one request after all guarded stages have succeeded on its leased connection.
import { Effect, Schema } from 'effect';
import { canonical, sha256Hex } from '@norbital-ai/store';
import { encodeWire } from '@norbital-ai/std/wire';
import type { Authority, Bindings, Captured } from '../contracts.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import type { EngineError } from '../errors.ts';
import type { EngineManifest } from '../manifest.ts';
import { BoltError } from '../../protocol/errors.ts';
import type { HeldRecord, StepsSnapshot } from '../write/act.ts';
import { CommitAnswer } from '../write/commit.ts';
import { answer, Chain, gate, GATED, type ReadGuards } from '../write/sql.ts';
import { nextDue } from '../runs/queue.ts';
import { approvalHook } from './approvals.ts';
import { readGuardBaseline } from './read-guards.ts';

type TransactionApproval = {
	readonly route: StepsSnapshot;
	readonly root: {
		readonly model: string;
		readonly id: string;
		readonly op: 'create' | 'update' | 'delete';
	};
	readonly captured: readonly Captured[];
	readonly authority: Authority;
	readonly bindings: Bindings;
	readonly seed: string;
	readonly sourceEpoch: string;
	readonly readGuards?: ReadGuards;
};
type Checkpoint = {
	readonly c: string;
	readonly id: string;
	readonly revision: number;
	readonly op: Captured['op'];
	readonly cause: 'direct' | 'derived';
	readonly erased: false;
	readonly o: Captured['old'];
	readonly n: Captured['new'];
};

/** Checkpoints use each row's earliest pre-image; its final staged revision is the pending receipt. */
export const transactionApproval = Effect.fn('Approvals.transaction')(function* (
	manifest: EngineManifest,
	db: TenantDbShape,
	input: TransactionApproval
): Effect.fn.Return<{ requestId: string; answer: CommitAnswer }, EngineError> {
	const images = new Map<string, { first: Captured; last: Captured; direct: boolean }>();
	for (const captured of input.captured) {
		const key = `${captured.model}/${captured.id}`;
		const previous = images.get(key);
		images.set(key, {
			first: previous?.first ?? captured,
			last: captured,
			direct:
				previous?.direct === true || captured.cause === 'direct' || captured.cause === 'cascade'
		});
	}
	const changes = [...images.values()].map(({ first, last, direct }): Checkpoint => ({
		c: first.model,
		id: first.id,
		// approvalHook's checkpoint subtracts one from update/delete; retain the earliest observation here.
		revision:
			first.old !== null && typeof first.old['revision'] === 'number'
				? first.old['revision'] + 1
				: first.revision,
		op: first.old === null ? 'create' : last.new === null ? 'delete' : 'update',
		cause: direct ? 'direct' : 'derived',
		erased: false,
		o: first.old,
		n: last.new
	}));
	const routed = yield* approvalHook(manifest, db).route({
		model: input.root.model,
		record: input.root.id,
		action: input.root.op,
		authority: input.authority,
		bindings: input.bindings,
		seed: input.seed,
		snapshot: input.route,
		records: changes
			.filter((change) => change.cause === 'direct')
			.map((change): HeldRecord => ({
				id: change.id,
				action: change.op === 'create' ? 'create' : change.op === 'delete' ? 'delete' : 'update',
				values: change.n ?? change.o ?? {}
			}))
	});
	if ('kind' in routed)
		return yield* Effect.fail(
			BoltError.make(
				'invalidInput',
				'admission',
				'The transaction approval route could not be admitted.'
			)
		);
	const chain = new Chain();
	const key = `transaction-approval:${input.seed}`;
	const digest = sha256Hex(canonical([input.route, changes]));
	gate(chain, key, digest, input.bindings.now);
	chain.cte(
		'allp',
		`SELECT * FROM jsonb_to_recordset(${chain.p(changes)}::jsonb)
		AS x(c text,id text,revision int,op text,cause text,erased boolean,o jsonb,n jsonb)`
	);
	routed.pieces(chain, null);
	// Every staged history revision belongs to the group, including intermediate updates and derived changes.
	chain.cte(
		'transaction_history',
		`UPDATE bolt_history h SET request=${chain.p(routed.requestId)}::uuid
		FROM jsonb_to_recordset(${chain.p(input.captured.map(({ model, id, revision, old }) => ({ model, id, revision, after: old !== null && typeof old['revision'] === 'number' ? old['revision'] : 0 })))}::jsonb)
		AS x(model text,id text,revision int,after int)
		WHERE h.collection=x.model AND h.record::text=x.id AND h.revision>x.after AND h.revision<=x.revision AND ${GATED} RETURNING h.record`
	);
	const records = [...images.values()]
		.filter((image) => image.direct)
		.map(({ last }) => ({
			model: last.model,
			id: last.id,
			revision: last.revision
		}));
	const outcome = { kind: 'pendingApproval', requestId: routed.requestId, records };
	const statement =
		chain.sql(`${answer(chain, key, digest, `${chain.p(encodeWire(outcome))}::jsonb`)},
		'[]'::jsonb AS captured, ${nextDue(chain)} AS next_due, '[]'::jsonb AS changed_instances`);
	const guards = input.readGuards;
	const statements = [
		statement,
		...(guards === undefined
			? []
			: [readGuardBaseline(routed.requestId, guards, input.sourceEpoch)])
	];
	const results = yield* db.transaction({
		statements,
		lock: {
			tables: [
				...new Set([
					'bolt_approvals',
					'approval_request',
					...changes.map((change) => change.c),
					...(guards?.tables ?? [])
				])
			].sort(),
			mode: 'SHARE ROW EXCLUSIVE'
		}
	});
	const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(CommitAnswer))(
		results[0]?.rows ?? []
	).pipe(Effect.mapError((error) => BoltError.make('badAnswer', 'commit', error.message, error)));
	const settled = decoded[0];
	if (settled === undefined)
		return yield* Effect.fail(
			BoltError.make('badAnswer', 'commit', 'The transaction approval returned no receipt.')
		);
	return { requestId: routed.requestId, answer: settled };
});
