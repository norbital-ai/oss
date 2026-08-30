import { Context, Effect, Layer, Result, Schema } from 'effect';
import {
	EffectId,
	MAX_SYNC_HELD_IDS,
	type SyncAdvanceRequest,
	type SyncAdvanceResponse,
	type SyncConnectRequest,
	type SyncConnectEvaluation
} from '@norbital-ai/bolt-protocol';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import * as Database from '#lib/runtime/facilities/database.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import type { Subject } from '#lib/runtime/identity/identity.js';
import * as TenantScope from '#lib/runtime/tenant.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { changelogSince } from './changelog.js';
import { advanceSubscription } from './delta-engine.js';
import { contentDigest, heldCoordinatesOf, heldIdsOf } from './digest.js';
import { describeSyncQuery, resolveSyncQuery } from './resolver.js';

class SyncInputError extends Schema.TaggedError<SyncInputError>()('Bolt.Sync.InputError', {
	message: Schema.NonEmptyString
}) {
	readonly retryable = false;
}

export type Interface = Readonly<{
	readonly connect: (
		effectId: EffectId,
		actor: Subject,
		subject: Subject,
		impersonatedTeam: string | null,
		request: SyncConnectRequest
	) => Effect.Effect<SyncConnectEvaluation, unknown>;
	readonly advance: (
		effectId: EffectId,
		request: SyncAdvanceRequest
	) => Effect.Effect<SyncAdvanceResponse, unknown>;
}>;

/** Per-invocation evaluator. No subscription or cursor state survives this service call. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/Sync');

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const identity = yield* Identity.Service;
		const access = yield* AccessControl.Service;
		const tenant = yield* TenantScope.Service;

		const authenticate = Effect.fn('Sync.authenticateStoredCredential')(function* (
			effectId: EffectId,
			credential: string,
			impersonatedTeam: string | undefined
		) {
			const actor = yield* identity.authenticate(effectId, credential);
			if (actor.tenantId !== tenant.tenantId)
				return yield* new Identity.AuthenticationError({ reason: 'invalid' });
			const subject =
				impersonatedTeam === undefined
					? actor
					: yield* access.subjectAsTeam(actor, impersonatedTeam);
			return { actor, subject, impersonatedTeam: impersonatedTeam ?? null };
		});

		const connect = Effect.fn('Sync.connect')(function* (
			effectId: EffectId,
			actor: Subject,
			subject: Subject,
			impersonatedTeam: string | null,
			request: SyncConnectRequest
		) {
			// Ledger first: any answer returned below is necessarily resolved after these terminal writes.
			const outcomes = yield* (yield* Collections.Service).lookupBrowserMutations(
				EffectId.make(`${effectId}:ledger`),
				actor,
				subject,
				impersonatedTeam,
				request.pending
			);
			const moved = yield* changelogSince(EffectId.make(`${effectId}:changelog`), request.head);
			const changedCollections = new Set(moved.collections);
			const results = yield* Effect.forEach(request.queries, (query, index) =>
				Effect.gen(function* () {
					const described = yield* describeSyncQuery(subject, query.input);
					const canSkip =
						!moved.truncated &&
						query.digest !== undefined &&
						(query.digestOnly === true ||
							(query.heldIds !== undefined && query.heldCoordinates !== undefined)) &&
						!described.dependencies.some((collection) => changedCollections.has(collection));
					if (canSkip) {
						return {
							key: query.key,
							input: query.input,
							...(impersonatedTeam === null ? {} : { impersonatedTeam }),
							policyHash: described.policyHash,
							dependencies: described.dependencies,
							policyDependencies: described.policyDependencies,
							routing: described.routing,
							heldIds: query.digestOnly === true ? [] : (query.heldIds ?? []),
							heldCoordinates: query.digestOnly === true ? [] : (query.heldCoordinates ?? []),
							digestOnly: query.digestOnly === true,
							digest: query.digest as string,
							changed: false as const
						};
					}
					const answer = yield* resolveSyncQuery(
						EffectId.make(`${effectId}:resolve:${index}`),
						subject,
						query.input
					);
					const resolvedIds = heldIdsOf(answer);
					const heldCoordinates = heldCoordinatesOf(answer, query.input);
					const digestOnly = resolvedIds.length > MAX_SYNC_HELD_IDS;
					const digest = yield* Effect.promise(() => contentDigest(answer));
					const registration = {
						key: query.key,
						input: query.input,
						...(impersonatedTeam === null ? {} : { impersonatedTeam }),
						policyHash: described.policyHash,
						dependencies: described.dependencies,
						policyDependencies: described.policyDependencies,
						routing: described.routing,
						heldIds: digestOnly ? [] : resolvedIds,
						heldCoordinates: digestOnly ? [] : heldCoordinates,
						digestOnly,
						digest
					};
					return query.digest === digest
						? { ...registration, changed: false as const }
						: { ...registration, changed: true as const, answer };
				})
			);
			return { head: moved.head, results, outcomes };
		});

		const advance = Effect.fn('Sync.advance')(function* (
			effectId: EffectId,
			request: SyncAdvanceRequest
		) {
			let outcomes: SyncAdvanceResponse['outcomes'] = [];
			if (request.pending.length > 0) {
				if (request.writer === undefined)
					return yield* new SyncInputError({
						message: 'A sync advance carrying pending writes requires the writer credential.'
					});
				const writer = yield* authenticate(
					EffectId.make(`${effectId}:writer`),
					request.writer.credential,
					request.writer.impersonatedTeam
				);
				outcomes = yield* (yield* Collections.Service).lookupBrowserMutations(
					EffectId.make(`${effectId}:ledger`),
					writer.actor,
					writer.subject,
					writer.impersonatedTeam,
					request.pending
				);
			}
			const updates: SyncAdvanceResponse['updates'][number][] = [];
			const refused: SyncAdvanceResponse['refused'][number][] = [];
			for (const [index, state] of request.subscriptions.entries()) {
				const admitted = yield* Effect.result(
					authenticate(
						EffectId.make(`${effectId}:authenticate:${index}`),
						state.credential,
						state.impersonatedTeam
					)
				);
				if (Result.isFailure(admitted)) {
					if (admitted.failure instanceof Identity.AuthenticationError) {
						refused.push({ subId: state.subId });
						continue;
					}
					if (admitted.failure instanceof AccessControl.AccessDenied) {
						refused.push({ subId: state.subId });
						continue;
					}
					return yield* admitted.failure;
				}
				const evaluated = yield* Effect.result(
					advanceSubscription(
						EffectId.make(`${effectId}:subscription:${index}`),
						{ state, subject: admitted.success.subject },
						request.changes
					)
				);
				if (Result.isFailure(evaluated)) {
					if (evaluated.failure instanceof AccessControl.AccessDenied) {
						refused.push({ subId: state.subId });
						continue;
					}
					return yield* evaluated.failure;
				}
				if (evaluated.success !== undefined) updates.push(evaluated.success);
			}
			const head = (yield* changelogSince(EffectId.make(`${effectId}:head`), undefined)).head;
			return { head, updates, refused, outcomes };
		});

		// The connect/advance evaluators evaluate through resolver, delta-engine, changelog and
		// ledger helpers that require the runtime services per call; the service's own contract
		// carries no requirement, so the context they need is resolved once here and bound at the
		// boundary.
		const environment = Layer.mergeAll(
			Layer.succeed(Database.Service, yield* Database.Service),
			Layer.succeed(Collections.Service, yield* Collections.Service),
			Layer.succeed(Workspace.Service, yield* Workspace.Service),
			Layer.succeed(AccessControl.Service, access)
		);
		return Service.of({
			connect: (effectId, actor, subject, impersonatedTeam, request) =>
				connect(effectId, actor, subject, impersonatedTeam, request).pipe(
					Effect.provide(environment)
				),
			advance: (effectId, request) => advance(effectId, request).pipe(Effect.provide(environment))
		});
	})
);
