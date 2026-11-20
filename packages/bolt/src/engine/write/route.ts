// Approval routing and resubmit re-evaluation for planned writes.
import { Effect, Option } from 'effect';
import { BoltError } from '../../protocol/errors.ts';
import { reviewChange } from '../approvals/review.ts';
import type { DeleteArm, Outcome, WriteArm } from '../contracts.ts';
import type { EngineError } from '../errors.ts';
import { judge } from './admit.ts';
import type { Commit } from './commit.ts';
import {
	APPROVED,
	holdRefs,
	k,
	refused,
	type DraftPlan,
	type DraftWrite,
	type HeldRecord,
	type Judgement,
	type PlanInput,
	type PreparedPlan,
	type RoutedPlan,
	type StoppedPlan
} from './shared.ts';

export const routeChanges = Effect.fn('Bolt.routeChanges')(function* (
	context: PlanInput,
	prepared: PreparedPlan,
	draft: DraftPlan
): Effect.fn.Return<RoutedPlan | StoppedPlan, EngineError> {
	const { e, r, cat, pre, own } = context;
	const m = e.manifest,
		auth = r.authority,
		b = r.bindings;
	const { submitted } = context,
		{ flow, readTables, fingerprints } = prepared,
		{ writes, unchanged } = draft;
	let guest = prepared.guest;
	const stop = (outcome: Outcome): StoppedPlan => ({ guest, outcome });
	let approval: Commit['approval'], resubmit: Commit['resubmit'];
	const records = (model: string): HeldRecord[] =>
		writes
			.filter(({ write }) => write.model === model)
			.map(({ write }) => ({
				id: write.id,
				action: write.op,
				values: {
					...pre.get(k(write.model, write.id)),
					...(write.op === 'create' ? write.values : write.op === 'update' ? write.set : {}),
					id: write.id
				}
			}));
	const checked: DraftWrite[] = [...writes];
	for (const item of submitted)
		if (
			!auth.admin &&
			item.parent === undefined &&
			item.change.op === 'update' &&
			!checked.some(({ write }) => write.model === item.change.model && write.id === item.change.id)
		) {
			const row = pre.get(k(item.change.model, item.change.id));
			if (row !== undefined)
				checked.push({
					item,
					write: {
						model: item.change.model,
						id: item.change.id,
						op: 'update',
						set: {},
						revision: Number(row['revision'])
					}
				});
		}
	const held = yield* context.held(holdRefs(m, cat, pre, checked.map(({ write }) => write)));
	const idle = yield* context.held(unchanged.map(({ model, id }) => [model, id] as const));
	if (held.length > 0 || idle.length > 0)
		writes.splice(
			0,
			writes.length,
			...writes.filter(({ item }) => !item.change.path.includes(APPROVED))
		);
	if (r.readGuards !== undefined && held.length > 0)
		return stop(
			refused(
				'locked',
				'A guarded automation write cannot join or resubmit an existing approval request.'
			)
		);
	const saving = held.filter(
		(request) => request.state === 'ChangesRequested' && request.requester
	);
	if (saving.length > 1)
		return stop(refused('approval_split', 'One act cannot resubmit several approval requests.'));
	if (saving[0] !== undefined) {
		if (e.approval === undefined)
			return yield* BoltError.make('no_approval', 'admission', 'No approval flow is wired.');
		const request = saving[0];
		const reviewed = yield* reviewChange(m, cat, own, b, request, writes, {
			readTables,
			fingerprints
		}).pipe(
			Effect.map(Option.some),
			Effect.catchIf(
				(error) => error instanceof BoltError && error.code === 'conflict',
				() => Effect.succeedNone
			)
		);
		if (Option.isNone(reviewed))
			return stop({ kind: 'conflict', records: [{ model: request.model, id: request.record }] });
		const { change, needs } = reviewed.value;
		const verb = request.action;
		if (change.before === null && verb !== 'create')
			return stop({ kind: 'conflict', records: [{ model: request.model, id: request.record }] });
		if (change.after === null && verb !== 'delete')
			return stop(refused('not_found', 'The approval record does not exist.'));
		const values = change.after ?? change.before ?? {};
		const admits = (arm: WriteArm | DeleteArm) =>
			!('columns' in arm) ||
			needs.every((need) =>
				need.field === undefined
					? Object.hasOwn(arm.columns, need.path)
					: arm.columns[need.path]?.includes(need.field) === true
			);
		const judged = auth.admin
			? { guest: false, verdict: { kind: 'allow' } satisfies Judgement }
			: yield* judge(
					e,
					own,
					auth,
					b,
					`${r.invocationId}:resubmit:${request.id}`,
					request.model,
					verb,
					(auth.models[request.model]?.[verb] ?? []).filter(admits),
					[change],
					{ tables: readTables, fingerprints }
				);
		guest ||= judged.guest;
		if (judged.verdict.kind === 'refuse') return stop(judged.verdict.outcome);
		const snapshot =
			judged.verdict.kind === 'approve' ? judged.verdict.flow : { kind: 'allow' as const };
		guest = true;
		resubmit = yield* e.approval.resubmit({
			request: request.id,
			authority: auth,
			bindings: b,
			snapshot,
			changed: writes.map(({ write }) => ({
				model: write.model,
				id: write.id,
				fields:
					write.op === 'delete'
						? []
						: Object.keys(write.op === 'create' ? write.values : write.set)
			})),
			records:
				records(request.model).length > 0
					? records(request.model)
					: [{ id: request.record, action: request.action, values }]
		});
	} else if (flow !== undefined && held[0] !== undefined) {
		return stop({
			kind: 'refused',
			code: 'locked',
			message: 'Under approval: your change needs its own approval. Decide this request first.',
			data: { request_id: held[0].id }
		});
	} else if (flow !== undefined) {
		if (e.approval === undefined)
			return yield* BoltError.make('no_approval', 'admission', 'No approval flow is wired.');
		const root = checked.find(
			({ item }) => item.parent === undefined && item.change.model === r.model
		)?.write;
		if (root === undefined || writes.length === 0)
			return stop(refused('forbidden', 'No root record admits this approval.'));
		const route = yield* e.approval.route({
			model: r.model,
			record: root.id,
			action: root.op,
			authority: auth,
			bindings: b,
			seed: `${r.invocationId}:${r.key}`,
			snapshot: flow,
			records: records(r.model)
		});
		if ('kind' in route) return stop(route);
		approval = route;
	}
	return { guest, approval, resubmit };
});
