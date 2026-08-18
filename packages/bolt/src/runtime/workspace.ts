import { Context, Effect, Layer, Schema } from 'effect';
import type { WorkspaceDefinition } from '../authoring/workspace-schema.js';
import { withSystemCollections } from './schema/system-collections.js';

/** Carries workspace lookup error through the typed runtime failure channel without losing diagnostic context. */
export class WorkspaceLookupError extends Schema.TaggedError<WorkspaceLookupError>()(
	'Bolt.Workspace.LookupError',
	{
		kind: Schema.Literals(['collection', 'app', 'agent', 'automation', 'channel', 'integration', 'policy']),
		name: Schema.NonEmptyString
	}
) {
	readonly category = 'workspace-lookup' as const;
	readonly retryable = false;
}

/** Carries invocation routing failures through the shared runtime channel without flattening authorization status. */
export class DispatchError extends Schema.TaggedError<DispatchError>()(
	'Bolt.Dispatch.Error',
	{
		code: Schema.NonEmptyString,
		message: Schema.NonEmptyString
	}
) {
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
export const describeCause = (cause: unknown): string => {
	if (typeof cause === 'string' && cause.length > 0) return cause;
	if (cause instanceof Error && cause.message.length > 0) return cause.message;
	if (cause !== null && typeof cause === 'object') {
		const tag = Reflect.get(cause, '_tag');
		const message = Reflect.get(cause, 'message');
		if (typeof message === 'string' && message.length > 0) {
			return typeof tag === 'string' ? `${tag}: ${message}` : message;
		}
		if (typeof tag === 'string' && tag.length > 0) {
			const detail = JSON.stringify(cause, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
			return detail === undefined || detail === '{}' ? tag : `${tag}: ${detail}`;
		}
	}
	const rendered = String(cause);
	return rendered.length > 0 && rendered !== '[object Object]' ? rendered : 'An unattributed failure occurred';
};

export type Interface = Readonly<{
	readonly definition: WorkspaceDefinition;
	readonly collection: (name: string) => Effect.Effect<WorkspaceDefinition['collections'][number], WorkspaceLookupError>;
	readonly app: (name: string) => Effect.Effect<WorkspaceDefinition['apps'][number], WorkspaceLookupError>;
	readonly agent: (name: string) => Effect.Effect<WorkspaceDefinition['agents'][number], WorkspaceLookupError>;
	readonly automation: (name: string) => Effect.Effect<WorkspaceDefinition['automations'][number], WorkspaceLookupError>;
	readonly channel: (name: string) => Effect.Effect<WorkspaceDefinition['channels'][number], WorkspaceLookupError>;
	readonly integration: (name: string) => Effect.Effect<WorkspaceDefinition['integrations'][number], WorkspaceLookupError>;
	readonly policy: (name: string) => Effect.Effect<WorkspaceDefinition['policies'][number], WorkspaceLookupError>;
	readonly capabilities: () => ReadonlyArray<string>;
}>;

/** Identifies the runtime service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/Workspace');

/** Owns lookup behavior at the runtime boundary so validation and typed semantics stay consistent for every caller. */
const WorkspaceValues = {
	lookup: <A>(kind: WorkspaceLookupError['kind'], values: ReadonlyArray<A>, nameOf: (value: A) => string) => Effect.fn(`Workspace.${kind}`)(function* (name: string) {
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
			agent: lookup('agent', definition.agents, ({ name }) => name),
			automation: lookup('automation', definition.automations, ({ name }) => name),
			channel: lookup('channel', definition.channels, ({ name }) => name),
			integration: lookup('integration', definition.integrations, ({ name }) => name),
			policy: lookup('policy', definition.policies, ({ name }) => name),
			capabilities: () => [...definition.requiredFacilities]
		});
	});

export * as Workspace from './workspace.js';
