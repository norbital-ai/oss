import { Effect, Predicate } from 'effect';
import type { ActFailure, UiContext } from '../client/contract.js';
import { bolt_of } from '../client/context.js';
import { fork } from '../effect/index.js';
import { notify } from './outcome.js';

/** What a held or queued write answers; any other success is a commit. */
const held = (value: unknown): value is { kind: 'pending_approval' | 'running' } =>
	Predicate.hasProperty(value, 'kind') && (value.kind === 'pending_approval' || value.kind === 'running');

const failed = (error: ActFailure) =>
	error._tag === 'ActRefused' || error._tag === 'ProtocolFailed'
		? { kind: 'refused' as const, message: error.message }
		: { kind: error._tag === 'ActConflict' ? ('conflict' as const) : ('unknown' as const) };

/**
 * A page's writes in one call each (call it while the component initializes): `const save = use_act(ctx)`, then
 * `save.run(ctx.act({ … }), { saved, then })`. `pending` is true while one runs, and a second run waits for it to end
 * (ignored). The commit, the hold or the typed failure is toasted in the shared words (`saved` replaces "Saved"); `then`
 * receives the success. A fiber ends with the mounted edge.
 */
export function use_act(ctx: UiContext) {
	let pending = $state(false);
	return {
		get pending() {
			return pending;
		},
		run<A, E extends ActFailure>(
			effect: Effect.Effect<A, E>,
			options: { readonly saved?: string; readonly then?: (success: A) => void } = {}
		): void {
			if (pending) return;
			const bolt = bolt_of(ctx);
			pending = true;
			fork(
				effect.pipe(
					Effect.tap((success) =>
						Effect.sync(() => {
							notify(bolt, held(success) ? success : { kind: 'committed' }, options.saved);
							options.then?.(success);
						})
					),
					Effect.catch((error: E) => Effect.sync(() => notify(bolt, failed(error)))),
					Effect.ensuring(
						Effect.sync(() => {
							pending = false;
						})
					)
				)
			);
		}
	};
}
