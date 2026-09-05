import { Context, Effect, Layer, Schema } from 'effect';
import type { WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';
import { registerWorkspaceShape } from '#lib/authoring/schema-registry.js';
import { withSystemCollections } from '#lib/runtime/schema/system-collections.js';

const isString = Schema.is(Schema.String);
const isBigint = Schema.is(Schema.BigInt);
const isObjectLike = Schema.is(
	Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Array(Schema.Unknown)])
);

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
	if (isString(cause) && cause.length > 0) return cause;
	if (isObjectLike(cause)) {
		if (seen.has(cause)) return 'A cyclic failure occurred';
		const nextSeen = new Set(seen).add(cause);
		const tag = Reflect.get(cause, '_tag');
		const message = Reflect.get(cause, 'message');
		const nested = Reflect.get(cause, 'cause');
		// Phase wrappers are Error instances whose generated message serializes a native nested Error as
		// `{}`. Prefer the attributable inner message while retaining the wrapper's phase and collection,
		// otherwise Studio reports only that settlement failed and hides the line that actually broke.
		if (isString(tag) && nested !== undefined && nested !== cause) {
			const phase = Reflect.get(cause, 'phase');
			const step = Reflect.get(cause, 'step');
			const collection = Reflect.get(cause, 'collection');
			const site = [phase, step, collection].filter((value) => isString(value)).join(' ');
			return `${tag}${site === '' ? '' : ` (${site})`}: ${describeCauseAt(nested, nextSeen)}`;
		}
		/**
		 * A schema failure says which value was wrong, not merely that one was.
		 *
		 * Effect's schema errors carry a generic `message` — "Schema validation failed" — and put the
		 * whole story in `issues`. Preferring the message meant a settle-phase refusal reached the
		 * operator as those three words with the offending path, the expectation and the actual value
		 * all discarded. A payroll that computed 290 payslips and then refused to persist them reported
		 * exactly as much as one that had refused for any other reason.
		 */
		// Effect v4 names it `issue`, singular, and nests the list inside it; v3 exposed `issues` at the
		// top. Both are read, because getting this wrong is silent — the branch simply never fires and
		// the generic sentence survives, which is the failure it exists to prevent.
		const nestedIssue = Reflect.get(cause, 'issue');
		const issues =
			Reflect.get(cause, 'issues') ??
			(isObjectLike(nestedIssue)
				? (Reflect.get(nestedIssue, 'issues') ?? [nestedIssue])
				: undefined);
		if (Array.isArray(issues) && issues.length > 0) {
			const described = issues.slice(0, 3).map((issue: unknown) => {
				if (!isObjectLike(issue)) return String(issue);
				const path = Reflect.get(issue, 'path');
				const where =
					Array.isArray(path) && path.length > 0 ? `${path.map(String).join('.')}: ` : '';
				const detail = Reflect.get(issue, 'message');
				return `${where}${isString(detail) && detail.length > 0 ? detail : JSON.stringify(issue)}`;
			});
			const more =
				issues.length > described.length ? ` (+${issues.length - described.length} more)` : '';
			const headline =
				isString(message) && message.length > 0 ? message : 'Schema validation failed';
			return `${isString(tag) ? `${tag}: ` : ''}${headline} — ${described.join('; ')}${more}`;
		}
		/**
		 * A tagged error that died building itself still knows where it was built.
		 *
		 * `new SomeTaggedError({ message: '' })` against a `NonEmptyString` field throws a plain `Error`
		 * reading "Schema validation failed" with no `_tag` and no properties — so every `instanceof`
		 * downstream misses it, it lands in the generic 500, and the failure it was wrapping is gone.
		 * The one thing it does carry is a stack whose first non-Effect frame is the construction site.
		 * Naming that frame turns "Schema validation failed" from a dead end into a file and a line,
		 * which is the difference between this being diagnosable and not.
		 */
		if (cause instanceof Error && cause.message === 'Schema validation failed') {
			const frame = (cause.stack ?? '')
				.split('\n')
				.slice(1)
				.map((line) => line.trim())
				// Effect appears under three names depending on where this runs: `/effect/dist/` in a host
				// process, a `dependency-effect-*.mjs` chunk inside a compiled tenant bundle, and the two
				// frames its constructor always contributes. Skipping only the first named the library
				// rather than the caller, which is the one thing this branch exists to avoid.
				.find(
					(line) =>
						line !== '' &&
						!line.includes('/effect/dist/') &&
						!/dependency-effect-[^/]*\.mjs/u.test(line) &&
						!/\bat (Schema\.make|new out)\b/u.test(line) &&
						// `at new SomeError` is the failing constructor itself. The caller is the next frame, and
						// the caller is the only one that says which site passed the value.
						!/\bat new [A-Z]/u.test(line)
				);
			return frame === undefined
				? 'Schema validation failed while constructing a tagged error; its cause was lost'
				: `Schema validation failed while constructing a tagged error (${frame}); its cause was lost`;
		}
		if (isString(message) && message.length > 0) {
			return isString(tag) ? `${tag}: ${message}` : message;
		}
		if (isString(tag) && tag.length > 0) {
			const detail = JSON.stringify(cause, (_key, value: unknown) =>
				isBigint(value) ? value.toString() : value
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
		// `schema('time_entries', …)` names a collection and nothing else, so the shape primitive needs
		// the collection list from somewhere. This is where it becomes known, and it is the definition
		// *after* the runtime-owned collections joined it — so a shape and a query resolve one list.
		registerWorkspaceShape(definition);
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
