import { z } from 'zod';
import { NorbitalManifestSchema, type NorbitalManifest } from './types.js';

export const MANIFEST_VERSION = 1 as const;

export function parseNorbitalManifest(input: unknown): NorbitalManifest {
	const parsed = NorbitalManifestSchema.safeParse(input);
	if (parsed.success) return parsed.data;
	throw new Error(`NorbitalManifest: ${z.prettifyError(parsed.error)}`);
}
