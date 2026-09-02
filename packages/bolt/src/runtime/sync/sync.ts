import { Context, Effect, Layer, Result, Schema } from 'effect';
import {
	EffectId,
	type SyncAdvanceRequest,
	type SyncAdvanceResponse,
	type SyncAdvanceSubscription,
	type SyncConnectEvaluation,
	type SyncConnectRequest,
	type SyncExtendPrefixEvaluation,
	type SyncExtendPrefixRequest
} from '@norbital-ai/bolt-protocol';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import * as Database from '#lib/runtime/facilities/database.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import type { Subject } from '#lib/runtime/identity/identity.js';
import * as TenantScope from '#lib/runtime/tenant.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { EffectivePlanError } from '#lib/runtime/access/effective-plan.js';
import {
	SyncPrefixResolutionError,
	advanceActivePrefix,
	extendActivePrefix,
	resolveInitialPrefix
} from './delta-engine.js';

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
	) => Effect.Effect<
		SyncConnectEvaluation,
		| Collections.QueryError
		| Database.FacilityError
		| SyncPrefixResolutionError
		| EffectivePlanError
	>;
	readonly advance: (
		effectId: EffectId,
		request: SyncAdvanceRequest
	) => Effect.Effect<
		SyncAdvanceResponse,
		| SyncInputError
		| Identity.AuthenticationError
		| AccessControl.AccessDenied
		| Collections.QueryError
		| Database.FacilityError
		| SyncPrefixResolutionError
		| EffectivePlanError
	>;
	readonly extendPrefix: (
		effectId: EffectId,
		state: SyncAdvanceSubscription,
		request: SyncExtendPrefixRequest
	) => Effect.Effect<
		SyncExtendPrefixEvaluation,
		| Identity.AuthenticationError
		| AccessControl.AccessDenied
		| Collections.QueryError
		| Database.FacilityError
		| SyncPrefixResolutionError
		| EffectivePlanError
	>;
}>;

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
			const outcomes = yield* (yield* Collections.Service).lookupBrowserMutations(
				EffectId.make(`${effectId}:ledger`),
				actor,
				subject,
				impersonatedTeam,
				request.pending
			);
			const results = yield* Effect.forEach(request.queries, (query, index) =>
				resolveInitialPrefix(
					EffectId.make(`${effectId}:query:${index}`),
					subject,
					query.input,
					query.requestedPrefix
				).pipe(
					Effect.map((resolved) => ({
						key: query.queryKey,
						input: query.input,
						planKey: resolved.plan.effectivePlan.fingerprint,
						version: 0,
						prefixKeys: resolved.keys,
						loadedPrefix: resolved.rows.length,
						prefixBytes: resolved.retainedBytes,
						...(impersonatedTeam === null ? {} : { impersonatedTeam }),
						authorityFingerprint: resolved.plan.effectivePlan.authority.fingerprint,
						dependencies: resolved.plan.effectivePlan.dependencies,
						routing: resolved.plan.effectivePlan.routing,
						rows: resolved.rows
					}))
				)
			);
			return { results, outcomes } satisfies SyncConnectEvaluation;
		});

		const lookupOutcomes = Effect.fn('Sync.lookupAdvanceOutcomes')(function* (
			effectId: EffectId,
			request: SyncAdvanceRequest
		) {
			if (request.pending.length === 0) return [];
			if (request.writer === undefined)
				return yield* new SyncInputError({
					message: 'A sync advance carrying pending writes requires the writer credential.'
				});
			const writer = yield* authenticate(
				EffectId.make(`${effectId}:writer`),
				request.writer.credential,
				request.writer.impersonatedTeam
			);
			return yield* (yield* Collections.Service).lookupBrowserMutations(
				EffectId.make(`${effectId}:ledger`),
				writer.actor,
				writer.subject,
				writer.impersonatedTeam,
				request.pending
			);
		});

		const resetReason = (failure: unknown) =>
			failure instanceof SyncPrefixResolutionError
				? failure.reason
				: failure instanceof Identity.AuthenticationError ||
					  failure instanceof AccessControl.AccessDenied
					? ('authority-changed' as const)
					: undefined;

		const advance = Effect.fn('Sync.advance')(function* (
			effectId: EffectId,
			request: SyncAdvanceRequest
		) {
			const outcomes = yield* lookupOutcomes(effectId, request);
			const updates: SyncAdvanceResponse['updates'][number][] = [];
			const resets: SyncAdvanceResponse['resets'][number][] = [];
			for (const [index, state] of request.subscriptions.entries()) {
				const admitted = yield* Effect.result(
					authenticate(
						EffectId.make(`${effectId}:authenticate:${index}`),
						state.credential,
						state.impersonatedTeam
					)
				);
				if (Result.isFailure(admitted)) {
					const reason = resetReason(admitted.failure);
					if (reason !== undefined) {
						resets.push({ subId: state.subId, reason });
						continue;
					}
					return yield* admitted.failure;
				}
				const evaluated = yield* Effect.result(
					advanceActivePrefix(
						EffectId.make(`${effectId}:subscription:${index}`),
						admitted.success.subject,
						state,
						{ changes: request.changes }
					)
				);
				if (Result.isFailure(evaluated)) {
					const reason = resetReason(evaluated.failure);
					if (reason !== undefined) {
						resets.push({ subId: state.subId, reason });
						continue;
					}
					return yield* evaluated.failure;
				}
				if (evaluated.success !== undefined) updates.push(evaluated.success);
			}
			return { updates, resets, outcomes } satisfies SyncAdvanceResponse;
		});

		const extendPrefix = Effect.fn('Sync.extendPrefix')(function* (
			effectId: EffectId,
			state: SyncAdvanceSubscription,
			request: SyncExtendPrefixRequest
		) {
			const admitted = yield* authenticate(
				EffectId.make(`${effectId}:authenticate`),
				state.credential,
				state.impersonatedTeam
			);
			return yield* extendActivePrefix(effectId, admitted.subject, state, request);
		});

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
			advance: (effectId, request) => advance(effectId, request).pipe(Effect.provide(environment)),
			extendPrefix: (effectId, state, request) =>
				extendPrefix(effectId, state, request).pipe(Effect.provide(environment))
		});
	})
);
