// Durable administrator audit is a host capability, separately stored from rollback history and runtime logs.
import { Context, Crypto, Effect, Layer, PubSub, Schema } from 'effect';
import {
	AuditPage,
	AuditPendingPage,
	AuditRecord,
	type AuditEvent,
	type AuditPendingQuery,
	type AuditPort,
	type AuditQuery
} from '../protocol/audit.ts';
import { BoltError } from '../protocol/errors.ts';
import { Port } from './port.ts';

export type AuditShape = {
	readonly mode: AuditPort['mode'];
	readonly uuid: Effect.Effect<string, BoltError>;
	readonly append: (events: readonly AuditEvent[]) => Effect.Effect<void, BoltError>;
	readonly query: (query: AuditQuery) => Effect.Effect<AuditPage, BoltError>;
	readonly detail: (id: string) => Effect.Effect<AuditRecord | null, BoltError>;
	readonly pending: (query: AuditPendingQuery) => Effect.Effect<AuditPendingPage, BoltError>;
};
const recoverySources = new WeakMap<AuditShape, AuditPort>();
const recoveryBuses = new WeakMap<object, PubSub.PubSub<void>>();
/** Recovery's own appends do not turn an unresolved outcome into an immediate retry loop. */
export const AuditRecoveryActive = Context.Reference<boolean>('bolt/AuditRecoveryActive', {
	defaultValue: () => false
});
export const auditChanges = Effect.fn('Audit.changes')(function* (audit: AuditShape) {
	const source = recoverySources.get(audit) ?? audit;
	let bus = recoveryBuses.get(source);
	if (bus === undefined) {
		const made = yield* PubSub.sliding<void>(1);
		bus = recoveryBuses.get(source) ?? made;
		recoveryBuses.set(source, bus);
	}
	return yield* PubSub.subscribe(bus);
});
export const requestAuditRecovery = Effect.fn('Audit.requestRecovery')(function* (
	audit: AuditShape
) {
	if (yield* AuditRecoveryActive) return;
	const bus = recoveryBuses.get(recoverySources.get(audit) ?? audit);
	if (bus !== undefined) yield* PubSub.publish(bus, undefined);
});
const unavailable = () =>
	Effect.fail(BoltError.make('unavailable', 'facility', 'The host has no audit store configured.'));
export const Audit = Context.Reference<AuditShape>('bolt/Audit', {
	defaultValue: () => ({
		mode: 'disabled',
		uuid: unavailable(),
		append: unavailable,
		query: unavailable,
		detail: unavailable,
		pending: unavailable
	})
});
const call = <A>(work: (signal: AbortSignal) => Promise<A>) =>
	Effect.tryPromise({
		try: work,
		catch: (error) => {
			const failure = Port.failure('audit')(error);
			if (failure._tag === 'FacilityFailure' && failure.kind === 'invalid')
				return BoltError.make('invalid', 'facility', failure.message, error);
			return BoltError.make(
				'unavailable',
				'facility',
				`The audit store failed: ${String(error)}`,
				error
			);
		}
	});
const answer = <A>(schema: Schema.Decoder<A>, value: unknown) =>
	Schema.decodeUnknownEffect(schema)(value).pipe(
		Effect.mapError((error) =>
			BoltError.make(
				'badAnswer',
				'facility',
				`The audit store returned an invalid answer: ${error.message}`,
				error
			)
		)
	);
/** The facility as a value: a host hands it to a verb that may run outside the context that built it. */
export const auditShape = (
	port: AuditPort | undefined
): Effect.Effect<AuditShape, never, Crypto.Crypto> =>
	Effect.gen(function* () {
		const disabled: AuditShape = {
			mode: 'disabled',
			uuid: unavailable(),
			append: unavailable,
			query: unavailable,
			detail: unavailable,
			pending: unavailable
		};
		const crypto = yield* Crypto.Crypto;
		if (port === undefined || port.mode === 'disabled') return disabled;
		const service: AuditShape = {
			mode: port.mode,
			uuid: crypto.randomUUIDv4.pipe(
				Effect.mapError((error) =>
					BoltError.make(
						'unavailable',
						'facility',
						'Audit operation identity generation failed.',
						error
					)
				)
			),
			append: (events) =>
				call((signal) => port.append(events, signal)).pipe(
					Effect.ensuring(requestAuditRecovery(service))
				),
			query: (query) =>
				call((signal) => port.query(query, signal)).pipe(
					Effect.flatMap((value) => answer(AuditPage, value))
				),
			detail: (id) =>
				call((signal) => port.detail(id, signal)).pipe(
					Effect.flatMap((value) => answer(Schema.NullOr(AuditRecord), value))
				),
			pending: (query) =>
				call((signal) => port.pending(query, signal)).pipe(
					Effect.flatMap((value) => answer(AuditPendingPage, value))
				)
		};
		recoverySources.set(service, port);
		return service;
	});
export const auditFromAbi = (
	port: AuditPort | undefined
): Layer.Layer<never, never, Crypto.Crypto> => Layer.effect(Audit, auditShape(port));
