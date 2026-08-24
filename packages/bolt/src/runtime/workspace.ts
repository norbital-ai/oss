import { Context, Effect, Layer, Schema } from 'effect';
import type { WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';
import { withSystemCollections } from '#lib/runtime/schema/system-collections.js';

/** Carries workspace lookup error through the typed runtime failure channel without losing diagnostic context. */
export class WorkspaceLookupError extends Schema.TaggedError<WorkspaceLookupError>()(
	'Bolt.Workspace.LookupError',
	{
		kind: Schema.Literals(['collection', 'app', 'automation', 'envoy', 'integration', 'policy']),
		name: Schema.NonEmptyString
	}
) {
	readonly category = 'workspace-lookup' as const;
	readonly retryable = false;
}

/** Carries invocation routing failures through the shared runtime channel without flattening authorization status. */
export class DispatchError extends Schema.TaggedError<DispatchError>()('Bolt.Dispatch.Error', {
	code: Schema.NonEmptyString,
	message: Schema.NonEmptyString
}) {
	readonly category = 'dispatch' as const;
	readonly retryable = false;

	/**
	 * Builds a dispatch failure from an arbitrary cause. `message` is `NonEmptyString`, so a cause
	 * whose own message is empty — every tagged error raised through `Effect.runPromise` — used to
	 * make the constructor itself throw, replacing the real failure with "Schema validation failed".
	 */
	static from(code: string, cause: unknown): DispatchError {
		return new DispatchError({ code, message: describeCause(cause) });
	}
}

/** Renders any thrown value as a non-empty, attributable sentence. */
const describeCauseAt = (cause: unknown, seen: ReadonlySet<object>): string => {
	if (typeof cause === 'string' && cause.length > 0) return cause;
	if (cause !== null && typeof cause === 'object') {
		if (seen.has(cause)) return 'A cyclic failure occurred';
		const nextSeen = new Set(seen).add(cause);
		const tag = Reflect.get(cause, '_tag');
		const message = Reflect.get(cause, 'message');
		const nested = Reflect.get(cause, 'cause');
		// Phase wrappers are Error instances whose generated message serializes a native nested Error as
		// `{}`. Prefer the attributable inner message while retaining the wrapper's phase and collection,
		// otherwise Studio reports only that settlement failed and hides the line that actually broke.
		if (typeof tag === 'string' && nested !== undefined && nested !== cause) {
			const phase = Reflect.get(cause, 'phase');
			const step = Reflect.get(cause, 'step');
			const collection = Reflect.get(cause, 'collection');
			const site = [phase, step, collection].filter((value) => typeof value === 'string').join(' ');
			return `${tag}${site === '' ? '' : ` (${site})`}: ${describeCauseAt(nested, nextSeen)}`;
		}
		if (typeof message === 'string' && message.length > 0) {
			return typeof tag === 'string' ? `${tag}: ${message}` : message;
		}
		if (typeof tag === 'string' && tag.length > 0) {
			const detail = JSON.stringify(cause, (_key, value: unknown) =>
				typeof value === 'bigint' ? value.toString() : value
			);
			return detail === undefined || detail === '{}' ? tag : `${tag}: ${detail}`;
		}
	}
	if (cause instanceof Error && cause.message.length > 0) return cause.message;
	const rendered = String(cause);
	return rendered.length > 0 && rendered !== '[object Object]'
		? rendered
		: 'An unattributed failure occurred';
};

export const describeCause = (cause: unknown): string => describeCauseAt(cause, new Set());

export type Interface = Readonly<{
	readonly definition: WorkspaceDefinition;
	readonly collection: (
		name: string
	) => Effect.Effect<WorkspaceDefinition['collections'][number], WorkspaceLookupError>;
	readonly app: (
		name: string
	) => Effect.Effect<WorkspaceDefinition['apps'][number], WorkspaceLookupError>;
	readonly automation: (
		name: string
	) => Effect.Effect<WorkspaceDefinition['automations'][number], WorkspaceLookupError>;
	readonly envoy: (
		name: string
	) => Effect.Effect<WorkspaceDefinition['envoys'][number], WorkspaceLookupError>;
	readonly integration: (
		name: string
	) => Effect.Effect<WorkspaceDefinition['integrations'][number], WorkspaceLookupError>;
	readonly policy: (
		name: string
	) => Effect.Effect<WorkspaceDefinition['policies'][number], WorkspaceLookupError>;
	readonly capabilities: () => ReadonlyArray<string>;
}>;

/** Identifies the runtime service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/Workspace');

/** Owns lookup behavior at the runtime boundary so validation and typed semantics stay consistent for every caller. */
const WorkspaceValues = {
	lookup: <A>(
		kind: WorkspaceLookupError['kind'],
		values: ReadonlyArray<A>,
		nameOf: (value: A) => string
	) =>
		Effect.fn(`Workspace.${kind}`)(function* (name: string) {
			const found = values.find((value) => nameOf(value) === name);
			if (found === undefined) return yield* new WorkspaceLookupError({ kind, name });
			return found;
		})
};
const lookup = WorkspaceValues.lookup;

/**
 * Owns layer behavior at the runtime boundary so validation and typed semantics stay consistent for
 * every caller. Runtime-owned collections join the authored ones here, so lookup, the where
 * compiler, and access evaluation all see one collection list.
 */
export const layer = (authored: WorkspaceDefinition) =>
	Layer.sync(Service, () => {
		const definition = withSystemCollections(authored);
		return Service.of({
			definition,
			collection: lookup('collection', definition.collections, ({ name }) => name),
			app: lookup('app', definition.apps, ({ name }) => name),
			automation: lookup('automation', definition.automations, ({ name }) => name),
			envoy: lookup('envoy', definition.envoys, ({ name }) => name),
			integration: lookup('integration', definition.integrations, ({ name }) => name),
			policy: lookup('policy', definition.policies, ({ name }) => name),
			capabilities: () => [...definition.requiredFacilities]
		});
	});
