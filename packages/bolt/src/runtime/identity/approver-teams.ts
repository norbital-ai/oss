import { Effect, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { ilike } from 'drizzle-orm';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import type { WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';
import * as Database from '#lib/runtime/facilities/database.js';
import { composer, executeBuilt } from '#lib/runtime/persistence.js';

const { team: teamTable } = SYSTEM_MODEL_TABLES;

/** Treats a configured team name as an exact case-insensitive ILIKE value. */
const escapeLikePattern = (value: string): string =>
	value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

/** The only serialized approval declaration. Its concrete flow remains live server-side code. */
const ApprovalRoute = Schema.Struct({
	flow: Schema.Literal(true),
	superceded_by: Schema.Array(Schema.NonEmptyString)
});

/** Configured non-admin superseding teams, deduplicated case-insensitively. */
export const declaredApproverTeams = (definition: WorkspaceDefinition): ReadonlyArray<string> => {
	const byFoldedName = new Map<string, string>();
	const configuredTeams = definition.policies.flatMap((policy) =>
		(policy.grants ?? []).flatMap((grant) =>
			Schema.is(ApprovalRoute)(grant.approval) ? grant.approval.superceded_by : []
		)
	);
	for (const configured of configuredTeams) {
		const name = configured.trim();
		const folded = name.toLocaleLowerCase();
		if (!byFoldedName.has(folded)) byFoldedName.set(folded, name);
	}
	return [...byFoldedName.values()];
};

/**
 * Makes sure every configured superseding team has a row.
 *
 * Flow approver names are produced by live TypeScript and are checked at authoring time against the
 * generated `TeamName` union. They are not serialized into the manifest. `superceded_by` is static,
 * so activation can also make that operational binding visible. A failed row insertion is reported
 * and stepped over; it does not take the whole release down.
 */
export const reconcileApproverTeams = Effect.fn('Bolt.reconcileApproverTeams')(function* (
	effectId: EffectId,
	definition: WorkspaceDefinition
) {
	const database = yield* Database.Service;
	const created: Array<string> = [];
	for (const name of declaredApproverTeams(definition)) {
		// Team-name matching is folded throughout the runtime while the database unique index is
		// case-sensitive, so an exact-name upsert would permit two operationally identical rows.
		const inserted = yield* Effect.gen(function* () {
			const existing = yield* executeBuilt(
				EffectId.make(`${effectId}:approval-superseder-team-check:${name.toLocaleLowerCase()}`),
				database,
				composer
					.select({ id: teamTable.id })
					.from(teamTable)
					.where(ilike(teamTable.name, escapeLikePattern(name)))
					.limit(1)
			);
			if (existing.rows.length > 0) return undefined;
			return yield* executeBuilt(
				EffectId.make(`${effectId}:approval-superseder-team:${name.toLocaleLowerCase()}`),
				database,
				composer
					.insert(teamTable)
					.values({ id: globalThis.crypto.randomUUID(), name })
					.returning({ name: teamTable.name })
			);
		}).pipe(
			Effect.catch((failure) =>
				Effect.logWarning(
					`activation: could not reconcile configured approval superseder team "${name}": ${failure.message}.`
				).pipe(Effect.as(undefined))
			)
		);
		if (inserted !== undefined && inserted.rows[0] !== undefined) {
			created.push(name);
			yield* Effect.logInfo(
				`activation: created empty approval superseder team "${name}" because it was absent from "team"`
			);
		}
	}
	return created;
});
