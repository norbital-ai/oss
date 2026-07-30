/**
 * @fileoverview Per-Form Draft Storage
 *
 * A reactive draft storage instance for a single form with:
 * - Auto-generated storage key from key parts
 * - Auto-generated schema hash for staleness detection
 * - Cross-tab synchronization via storage events
 * - Automatic cleanup on destruction
 */

import { safeParse } from '@norbital-ai/std';
import { z } from 'zod';
import { scopedStorageKey } from '../../storage-scope/index.js';
import type { FormSchema } from '../form_state.svelte';

/**
 * Draft data structure stored in localStorage
 */
export interface DraftData<T = Record<string, unknown>> {
	data: T;
	lastModified: number;
	schemaHash: string;
}

/**
 * Configuration for creating a DraftStorage instance
 */
export interface DraftStorageConfig {
	keyParts: string[];
	schema: FormSchema;
	discriminator?: string;
	onSchemaMismatch?: 'evict' | 'keep';
}

const DRAFT_PREFIX = 'draft_';

const draftEnvelopeSchema = z.object({
	data: z.unknown(),
	lastModified: z.number(),
	schemaHash: z.string()
});

/**
 * Validate the localStorage envelope (without trusting the inner `data`,
 * which is arbitrary form state that cannot be runtime-validated here).
 * Returns the parsed envelope, or `null` if the shape is wrong.
 */
function parseDraftEnvelope(stored: string): DraftData<unknown> | null {
	const result = draftEnvelopeSchema.safeParse(safeParse(stored));
	return result.success ? result.data : null;
}

async function generateHash(str: string): Promise<string> {
	const data = new TextEncoder().encode(str);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

async function hashSchema(schema: FormSchema): Promise<string> {
	const jsonSchema = schema['~standard'] as Record<string, unknown> & {
		jsonSchema?: {
			input: (options: { readonly target: string }) => Record<string, unknown>;
		};
	};
	const str = JSON.stringify(jsonSchema.jsonSchema?.input({ target: 'draft-2020-12' }) ?? {});
	return generateHash(str);
}

export class DraftStorage<T = Record<string, unknown>> {
	readonly key: string;

	schemaHash = $state<string | null>(null);

	exists = $state(false);

	hadSchemaMismatch = $state(false);

	private readonly onSchemaMismatch: 'evict' | 'keep';
	private storageListener: ((event: StorageEvent) => void) | null = null;

	constructor(config: DraftStorageConfig) {
		const { keyParts, schema, onSchemaMismatch = 'evict' } = config;

		// Scoped to the active tenant. Two organizations created from the same template have
		// identically named collections, so an unscoped key would hand one tenant's unsaved form
		// back to another.
		this.key = scopedStorageKey(DRAFT_PREFIX + keyParts.filter(Boolean).join('_'));
		this.onSchemaMismatch = onSchemaMismatch;

		hashSchema(schema)
			.then((hash) => {
				this.schemaHash = hash;
				this.init();
			})
			.catch(() => {
				this.init();
			});
	}

	private init(): void {
		if (typeof window === 'undefined') return;

		this.checkExisting();

		this.storageListener = (event: StorageEvent) => {
			if (event.key === this.key) {
				if (event.newValue === null) {
					this.exists = false;
				} else {
					this.checkExisting();
				}
			}
		};
		window.addEventListener('storage', this.storageListener);
	}

	private checkExisting(): void {
		if (typeof window === 'undefined') return;
		if (!this.schemaHash) return;

		try {
			const stored = localStorage.getItem(this.key);
			if (!stored) {
				this.exists = false;
				this.hadSchemaMismatch = false;
				return;
			}

			const parsed = parseDraftEnvelope(stored);
			if (!parsed) {
				this.exists = false;
				return;
			}
			const schemaMatches = parsed.schemaHash === this.schemaHash;

			if (!schemaMatches) {
				this.hadSchemaMismatch = true;
				if (this.onSchemaMismatch === 'evict') {
					console.warn(`[DraftStorage] Evicting stale draft (schema changed): ${this.key}`);
					this.clear();
					return;
				}
			}

			this.exists = true;
		} catch {
			this.exists = false;
		}
	}

	save(data: T): void {
		if (typeof window === 'undefined') return;
		if (!this.schemaHash) return;

		const draftData: DraftData<T> = {
			data,
			lastModified: Date.now(),
			schemaHash: this.schemaHash
		};

		try {
			localStorage.setItem(this.key, JSON.stringify(draftData));
			this.exists = true;
			this.hadSchemaMismatch = false;
		} catch (error) {
			console.warn('[DraftStorage] Failed to save draft:', error);
		}
	}

	load(): T | null {
		if (typeof window === 'undefined') return null;
		if (!this.schemaHash) return null;

		try {
			const stored = localStorage.getItem(this.key);
			if (!stored) return null;

			const parsed = parseDraftEnvelope(stored);
			if (!parsed) return null;

			if (parsed.schemaHash !== this.schemaHash) {
				this.hadSchemaMismatch = true;
				if (this.onSchemaMismatch === 'evict') {
					this.clear();
					return null;
				}
			}

			return parsed.data as T;
		} catch (error) {
			console.warn('[DraftStorage] Failed to load draft:', error);
			return null;
		}
	}

	getMetadata(): { lastModified: number; schemaMatch: boolean } | null {
		if (typeof window === 'undefined') return null;
		if (!this.schemaHash) return null;

		try {
			const stored = localStorage.getItem(this.key);
			if (!stored) return null;

			const parsed = parseDraftEnvelope(stored);
			if (!parsed) return null;
			return {
				lastModified: parsed.lastModified,
				schemaMatch: parsed.schemaHash === this.schemaHash
			};
		} catch {
			return null;
		}
	}

	clear(): void {
		if (typeof window === 'undefined') return;

		try {
			localStorage.removeItem(this.key);
			this.exists = false;
			this.hadSchemaMismatch = false;
		} catch (error) {
			console.warn('[DraftStorage] Failed to clear draft:', error);
		}
	}

	destroy(): void {
		if (this.storageListener && typeof window !== 'undefined') {
			window.removeEventListener('storage', this.storageListener);
			this.storageListener = null;
		}
	}
}
