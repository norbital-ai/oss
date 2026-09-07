import { Effect } from 'effect';
import { getErrorMessage, toError } from '@norbital-ai/std';
import type { CustomTypeRenderer, CustomTypeRendererState } from '@norbital-ai/ui/data-renderer';

const loading: CustomTypeRendererState = { status: 'loading' };

/**
 * A custom type's own renderer, keyed by the type name its columns declare and loaded when a
 * `DataRenderer` first reads that exact kind.
 *
 * `custom('leave_event')` is a jsonb column whose shape only its author knows, so the type ships
 * the component that reads it. Without these every custom field falls through to the JSON dump.
 *
 * A load that fails is a state, never a placeholder: the failure is recorded with its sentence and
 * logged as an error, so a chunk that 404s or a module that throws while evaluating reads as
 * "renderer for pay_calendar failed to load: …" on the field and in the console, not as
 * "Loading field…" for as long as the page is open. A module without a default
 * export is the same failure with its own sentence.
 */
export const createCustomTypeRendererResolver = (
	loaders: Readonly<Record<string, () => Promise<CustomTypeRenderer>>> // repository-health:allow EFF2 -- Vite dynamic imports are native Promises and this resolver adapts every loader into Effect.tryPromise immediately.
): ((kind: string) => CustomTypeRendererState | undefined) => {
	const states = $state<Record<string, CustomTypeRendererState>>({});
	const requested = new Set<string>();
	const settle = (kind: string, state: CustomTypeRendererState): void => {
		Object.assign(states, { [kind]: state });
	};
	return (kind) => {
		const current = states[kind];
		if (current) return current;
		const load = loaders[kind];
		if (!load) return undefined;
		if (!requested.has(kind)) {
			requested.add(kind);
			void Effect.runPromise(
				Effect.tryPromise(load).pipe(
					Effect.flatMap((renderer) =>
						renderer == null
							? Effect.fail(new Error('the module has no default export'))
							: Effect.succeed(renderer)
					),
					Effect.tap((renderer) => Effect.sync(() => settle(kind, { status: 'ready', renderer }))),
					Effect.catch((failure) =>
						Effect.sync(() => {
							// `tryPromise` wraps the rejection; its own message is "An error occurred in
							// Effect.tryPromise", and the sentence a person needs is the cause's.
							const error = toError(failure.cause ?? failure);
							console.error(
								`[bolt] renderer for ${kind} failed to load: ${getErrorMessage(error)}`
							);
							settle(kind, { status: 'failed', error });
						})
					)
				)
			);
		}
		return states[kind] ?? loading;
	};
};
