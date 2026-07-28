import { z } from 'zod';
import { typeGuard } from '@norbital-ai/std/schema';
import type { SeedStepId } from './plan.js';

const looseRecordSchema = z.record(z.string(), z.unknown());

export const SEED_MANIFEST_CONTRACT_VERSION = 1 as const;

export type SeedManifestStep = {
	readonly id: SeedStepId;
	readonly collection: string;
	readonly dependsOn?: readonly SeedStepId[];
	readonly payloads: readonly Record<string, unknown>[];
};

/** DAG-bearing seed artifact emitted at build time (separate from build manifest). */
export type SeedManifest = {
	readonly version: typeof SEED_MANIFEST_CONTRACT_VERSION;
	readonly clearBefore?: readonly string[];
	readonly steps: readonly SeedManifestStep[];
};

export function parseSeedManifest(raw: unknown): SeedManifest {
	if (!typeGuard(looseRecordSchema, raw)) {
		throw new Error('Seed manifest must be a JSON object');
	}
	const record = raw;
	if (record.version !== SEED_MANIFEST_CONTRACT_VERSION) {
		throw new Error(
			`Unsupported seed manifest version ${String(record.version)} (expected ${SEED_MANIFEST_CONTRACT_VERSION})`
		);
	}
	if (!Array.isArray(record.steps)) {
		throw new Error('Seed manifest missing required field: steps');
	}
	return record as SeedManifest;
}

export function seedManifestJson(manifest: SeedManifest): string {
	return `${JSON.stringify(manifest, null, 2)}\n`;
}
