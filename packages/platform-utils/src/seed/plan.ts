import type { SystemRecordFields } from '../system/column_names.js';
import type { SeedManifest, SeedManifestStep } from './manifest.js';
import { z } from 'zod';
import { typeGuard } from '@norbital-ai/std/schema';

const looseRecordSchema = z.record(z.string(), z.unknown());

export type SeedStepId = string;

/** One seed batch: a collection insert with optional ordering constraints. */
export type SeedMutationStep = {
	readonly id: SeedStepId;
	readonly collection: string;
	readonly records: ReadonlyArray<Record<string, unknown>>;
	readonly dependsOn?: ReadonlyArray<SeedStepId>;
};

/** Flat execution plan derived from a {@link SeedManifest} at bootstrap time. */
export type CompiledSeedPlan = {
	readonly version: 1;
	readonly clearBefore?: ReadonlyArray<string>;
	readonly mutations: ReadonlyArray<{
		/**
		 * The authoring step this batch came from, carried through purely so the executor can name it
		 * when it refuses a payload. Optional because a plan may be assembled by hand.
		 */
		readonly step_id?: SeedStepId;
		readonly collection_name: string;
		readonly payloads: ReadonlyArray<Record<string, unknown>>;
	}>;
};

/** Author-time seed definition exported from the optional `src/+seed.ts` role. */
export type WorkspaceSeedDefinition = {
	readonly steps: readonly SeedMutationStep[];
	readonly manifest: SeedManifest;
};

export function defineSeed(
	steps: readonly SeedMutationStep[],
	options?: { readonly clearBefore?: readonly string[] }
): WorkspaceSeedDefinition {
	return {
		steps,
		manifest: compileSeedManifest(steps, options)
	};
}

/** Opaque ref resolved at compile time to a seeded record id. */
export type SeedRecordRef = {
	readonly __seedRef: SeedStepId;
	readonly recordId?: string;
};

export function seedStep<const T extends SeedMutationStep>(step: T): T {
	return step;
}

/** Reference a record id from another seed step (defaults to that step's first record). */
export function seedRef(stepId: SeedStepId, recordId?: string): SeedRecordRef {
	return recordId ? { __seedRef: stepId, recordId } : { __seedRef: stepId };
}

const SeedRecordRefSchema = z.object({
	__seedRef: z.string(),
	recordId: z.string().optional()
});

// stupidity:allow R5b -- canonical Zod-backed guard for recursive seed payload traversal
function isSeedRecordRef(value: unknown): value is SeedRecordRef {
	return typeGuard(SeedRecordRefSchema, value);
}

function resolveRefValue(value: unknown, idByStep: ReadonlyMap<SeedStepId, string>): unknown {
	if (isSeedRecordRef(value)) {
		const resolved = idByStep.get(value.__seedRef);
		if (!resolved) {
			throw new Error(`Seed ref "${value.__seedRef}" is not defined or not yet resolved`);
		}
		return value.recordId ?? resolved;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => resolveRefValue(entry, idByStep));
	}
	if (typeGuard(looseRecordSchema, value)) {
		const out: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value)) {
			out[key] = resolveRefValue(nested, idByStep);
		}
		return out;
	}
	return value;
}

function primaryRecordId(step: SeedMutationStep): string | null {
	for (const record of step.records) {
		const id = record.norbital_id;
		if (typeof id === 'string' && id.length > 0) return id;
	}
	return null;
}

function assertUniqueStepIds(steps: ReadonlyArray<SeedMutationStep>): void {
	const seen = new Set<string>();
	for (const step of steps) {
		if (seen.has(step.id)) {
			throw new Error(`Duplicate seed step id "${step.id}"`);
		}
		seen.add(step.id);
	}
}

/** Topological sort of seed steps; throws on unknown deps or cycles. */
export function sortSeedSteps(steps: ReadonlyArray<SeedMutationStep>): SeedMutationStep[] {
	assertUniqueStepIds(steps);
	const byId = new Map(steps.map((step) => [step.id, step]));
	const sorted: SeedMutationStep[] = [];
	const visiting = new Set<string>();
	const visited = new Set<string>();

	const visit = (stepId: string) => {
		if (visited.has(stepId)) return;
		if (visiting.has(stepId)) {
			throw new Error(`Seed plan cycle detected at step "${stepId}"`);
		}
		const step = byId.get(stepId);
		if (!step) {
			throw new Error(`Seed step "${stepId}" is not defined`);
		}
		visiting.add(stepId);
		for (const dep of step.dependsOn ?? []) {
			if (!byId.has(dep)) {
				throw new Error(`Seed step "${stepId}" depends on unknown step "${dep}"`);
			}
			visit(dep);
		}
		visiting.delete(stepId);
		visited.add(stepId);
		sorted.push(step);
	};

	for (const step of steps) {
		visit(step.id);
	}
	return sorted;
}

/** Compile DAG seed manifest; resolves seedRef markers while preserving step metadata. */
export function compileSeedManifest(
	steps: ReadonlyArray<SeedMutationStep>,
	options?: { readonly clearBefore?: readonly string[] }
): SeedManifest {
	const sorted = sortSeedSteps(steps);
	const idByStep = new Map<SeedStepId, string>();
	const manifestSteps: SeedManifestStep[] = [];

	for (const step of sorted) {
		const payloads = step.records.map((record) => resolveRefValue(record, idByStep)) as Record<
			string,
			unknown
		>[];
		manifestSteps.push({
			id: step.id,
			collection: step.collection,
			...(step.dependsOn?.length ? { dependsOn: [...step.dependsOn] } : {}),
			payloads
		});
		const primaryId = primaryRecordId({ ...step, records: payloads });
		if (primaryId) {
			idByStep.set(step.id, primaryId);
		}
	}

	return {
		version: 1,
		...(options?.clearBefore?.length ? { clearBefore: [...options.clearBefore] } : {}),
		steps: manifestSteps
	};
}

/** Flatten a seed manifest into ordered createMany mutation batches for runtime seeding. */
export function compiledSeedPlanFromManifest(manifest: SeedManifest): CompiledSeedPlan {
	return {
		version: 1,
		...(manifest.clearBefore?.length ? { clearBefore: [...manifest.clearBefore] } : {}),
		mutations: manifest.steps.map((step) => ({
			step_id: step.id,
			collection_name: step.collection,
			payloads: [...step.payloads]
		}))
	};
}

// ── Seed row helpers ──────────────────────────────────────────────

/** System columns required on every seed insert row. */
export type SeedSystemFields = Pick<
	SystemRecordFields,
	'norbital_id' | 'norbital_created_at' | 'norbital_updated_at'
>;

/** Seed insert row — workspace record shape plus required system columns. */
export type SeedInsertRecord<TRecord extends Record<string, unknown> = Record<string, unknown>> =
	TRecord & SeedSystemFields;

export function seedRow<TRecord extends Record<string, unknown>>(
	row: SeedInsertRecord<TRecord>
): SeedInsertRecord<TRecord> {
	return row;
}

export function seedRows<TRecord extends Record<string, unknown>>(
	rows: ReadonlyArray<SeedInsertRecord<TRecord>>
): ReadonlyArray<SeedInsertRecord<TRecord>> {
	return rows;
}

export type SeedRelationRow = {
	readonly from_id: string;
	readonly to_id: string;
};
