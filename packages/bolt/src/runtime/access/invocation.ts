import { Effect, Schema } from 'effect';
import type * as Identity from '#lib/runtime/identity/identity.js';
import type { RowPredicate } from './predicate.js';
import {
	afterHookElevation,
	maskWithPredicate,
	policyHashSource,
	type PolicyHashSource
} from './policy-surface.js';

export type Decision = Readonly<{
	readonly allowed: boolean;
	readonly reason: string;
}>;

/** Carries access denied through the typed access failure channel without losing diagnostic context. */
export class AccessDenied extends Schema.TaggedError<AccessDenied>()(
	'Bolt.AccessControl.AccessDenied',
	{
		action: Schema.NonEmptyString,
		resource: Schema.NonEmptyString,
		reason: Schema.NonEmptyString
	}
) {
	readonly category = 'access-denied' as const;
	/**
	 * The sentence is an own field, not a getter. These errors are `Error` subclasses whose
	 * `message` is an own property the base constructor writes empty — a getter on the subclass is
	 * shadowed by it, and the caller would see `''` even though `reason` already names the refusal
	 * (`write authorization ${id} refused the prepared record`). Copying `reason` here is the same
	 * seam `MutationQuarantined` and `NestingLimitExceeded` already pay: the typed channel is
	 * correct; the sentence has to survive crossing out of it as `.message`.
	 */
	readonly message = `${this.reason} (${this.action} on ${this.resource})`;
}

/** The read grant frozen for one invocation. */
type AuthorizedRead = Readonly<{
	readonly predicate: RowPredicate;
	readonly policyHashSource: PolicyHashSource;
	readonly mask: (
		value: Readonly<Record<string, Schema.Json>>
	) => Readonly<Record<string, Schema.Json>>;
}>;

type WriteAction = 'create' | 'update' | 'delete';
type WriteElevation = 'none' | 'after';

/** AccessControl's part of the unconditional write authorization sequence. */
type WriteAccessPlan = Readonly<{
	readonly action: WriteAction;
	readonly resource: string;
	readonly predicate: RowPredicate;
	readonly authorization: Schema.Json | undefined;
	readonly approval: Schema.Json | undefined;
}>;

/** One request's policy cache. */
export type Invocation = Readonly<{
	readonly authorize: (
		subject: Identity.Subject,
		action: string,
		resource: string
	) => Effect.Effect<void, AccessDenied>;
	readonly predicate: (subject: Identity.Subject, action: string, resource: string) => RowPredicate;
	readonly mask: (
		subject: Identity.Subject,
		action: string,
		resource: string,
		value: Readonly<Record<string, Schema.Json>>
	) => Readonly<Record<string, Schema.Json>>;
	readonly read: (
		subject: Identity.Subject,
		resource: string
	) => Effect.Effect<AuthorizedRead, AccessDenied>;
	readonly write: (
		subject: Identity.Subject,
		action: WriteAction,
		resource: string,
		submitted: Readonly<Record<string, unknown>>,
		elevation?: WriteElevation
	) => Effect.Effect<WriteAccessPlan, AccessDenied>;
	readonly policyHashSource: (
		subject: Identity.Subject,
		action: string,
		resource: string
	) => PolicyHashSource;
}>;

type InvocationSubjectEvaluator = Readonly<{
	readonly decision: (action: string, resource: string) => Decision;
	readonly predicate: (action: string, resource: string) => RowPredicate;
}>;

type InvocationSubjectState = Readonly<{
	readonly evaluator: InvocationSubjectEvaluator;
	readonly predicates: Map<string, RowPredicate>;
	readonly decisions: Map<string, Decision>;
	readonly reads: Map<string, AuthorizedRead | AccessDenied>;
}>;

const subjectValueKey = (subject: Identity.Subject): string =>
	JSON.stringify({
		userId: subject.userId,
		tenantId: subject.tenantId,
		teamPath: [...subject.teamPath],
		policies: [...subject.policies].toSorted(),
		system: subject.system ?? false,
		email: subject.email ?? null,
		admin: subject.admin ?? false,
		impersonatedBy: subject.impersonatedBy ?? null
	});

const freezeSubject = (subject: Identity.Subject): Identity.Subject =>
	Object.freeze({
		...subject,
		teamPath: Object.freeze([...subject.teamPath]),
		policies: Object.freeze([...subject.policies])
	});

/** Builds a fresh invocation memo around one service-owned policy evaluator. */
export const createInvocationFactory = (
	prepare: (subject: Identity.Subject) => InvocationSubjectEvaluator
): (() => Invocation) =>
	() => {
		const keysByObject = new WeakMap<object, string>();
		const subjects = new Map<string, InvocationSubjectState>();
		const stateFor = (input: Identity.Subject): InvocationSubjectState => {
			let key = keysByObject.get(input);
			if (key === undefined) {
				key = subjectValueKey(input);
				keysByObject.set(input, key);
			}
			const existing = subjects.get(key);
			if (existing !== undefined) return existing;
			const evaluator = prepare(freezeSubject(input));
			const state: InvocationSubjectState = {
				evaluator,
				predicates: new Map(),
				decisions: new Map(),
				reads: new Map()
			};
			subjects.set(key, state);
			return state;
		};
		const coordinate = (action: string, resource: string): string => `${action}\u0000${resource}`;
		const evaluated = <Value>(
			cache: Map<string, Value>,
			evaluate: (action: string, resource: string) => Value,
			action: string,
			resource: string
		): Value => {
			const key = coordinate(action, resource);
			const existing = cache.get(key);
			if (existing !== undefined) return existing;
			const value = evaluate(action, resource);
			cache.set(key, value);
			return value;
		};
		const authorize = (
			subject: Identity.Subject,
			action: string,
			resource: string
		): Effect.Effect<void, AccessDenied> => {
			const state = stateFor(subject);
			const decision = evaluated(state.decisions, state.evaluator.decision, action, resource);
			return decision.allowed
				? Effect.void
				: Effect.fail(new AccessDenied({ action, resource, reason: decision.reason }));
		};
		const predicate = (subject: Identity.Subject, action: string, resource: string) => {
			const state = stateFor(subject);
			return evaluated(state.predicates, state.evaluator.predicate, action, resource);
		};
		const mask = (
			subject: Identity.Subject,
			action: string,
			resource: string,
			value: Readonly<Record<string, Schema.Json>>
		) => maskWithPredicate(predicate(subject, action, resource), action, value);
		const read = (
			subject: Identity.Subject,
			resource: string
		): Effect.Effect<AuthorizedRead, AccessDenied> => {
			const state = stateFor(subject);
			const key = coordinate('read', resource);
			const cached = state.reads.get(key);
			if (cached !== undefined)
				return cached instanceof AccessDenied ? Effect.fail(cached) : Effect.succeed(cached);
			const decision = evaluated(state.decisions, state.evaluator.decision, 'read', resource);
			const compiled = evaluated(state.predicates, state.evaluator.predicate, 'read', resource);
			if (!decision.allowed || !compiled.allowed) {
				const denied = new AccessDenied({
					action: 'read',
					resource,
					reason: decision.allowed ? compiled.reason : decision.reason
				});
				state.reads.set(key, denied);
				return Effect.fail(denied);
			}
			const authorized: AuthorizedRead = {
				predicate: compiled,
				policyHashSource: policyHashSource('read', resource, compiled),
				mask: (value) => maskWithPredicate(compiled, 'read', value)
			};
			state.reads.set(key, authorized);
			return Effect.succeed(authorized);
		};
		const write = (
			subject: Identity.Subject,
			action: WriteAction,
			resource: string,
			submitted: Readonly<Record<string, unknown>>,
			elevation: WriteElevation = 'none'
		): Effect.Effect<WriteAccessPlan, AccessDenied> => {
			const state = stateFor(subject);
			const source = evaluated(state.predicates, state.evaluator.predicate, action, resource);
			if (elevation === 'none') {
				const decision = evaluated(state.decisions, state.evaluator.decision, action, resource);
				if (!decision.allowed || !source.allowed)
					return Effect.fail(
						new AccessDenied({
							action,
							resource,
							reason: decision.allowed ? source.reason : decision.reason
						})
					);
				if (
					action !== 'delete' &&
					source.fields !== undefined &&
					Object.keys(submitted).some((field) => !source.fields?.includes(field))
				)
					return Effect.fail(
						new AccessDenied({
							action,
							resource,
							reason: `${action} includes fields outside the matching policy grant`
						})
					);
			}
			const planned = elevation === 'after' ? afterHookElevation(source) : source;
			return Effect.succeed({
				action,
				resource,
				predicate: planned,
				authorization: elevation === 'after' ? undefined : source.authorization,
				approval: source.approval
			});
		};
		return {
			authorize,
			predicate,
			mask,
			read,
			write,
			policyHashSource: (subject, action, resource) =>
				policyHashSource(action, resource, predicate(subject, action, resource))
		};
	};
