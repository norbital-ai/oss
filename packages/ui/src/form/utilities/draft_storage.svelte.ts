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
import { Cause, Clock, Effect, Schema } from 'effect';
import { scopedStorageKey } from '#lib/storage-scope';
import type { FormSchema } from '../schema.js';

/**
 * The localStorage envelope a draft is persisted in. The inner `data` stays schemaless because it
 * is arbitrary form state that cannot be runtime-validated here — the envelope is the boundary.
 */
const draftDataSchema = Schema.Struct({
	data: Schema.Unknown,
	lastModified: Schema.Finite,
	schemaHash: Schema.String
});

/** Draft data structure stored in localStorage */
type DraftData<T = Record<string, unknown>> = Omit<typeof draftDataSchema.Type, 'data'> & {
	data: T;
};

/**
 * Configuration for creating a DraftStorage instance
 */
interface DraftStorageConfig {
	keyParts: string[];
	schema: FormSchema;
	discriminator?: string;
	onSchemaMismatch?: 'evict' | 'keep';
}

const DRAFT_PREFIX = 'draft_';

const decodeDraftEnvelope = Schema.decodeUnknownResult(draftDataSchema);

/**
 * Validate the localStorage envelope (without trusting the inner `data`,
 * which is arbitrary form state that cannot be runtime-validated here).
 * Returns the parsed envelope, or `null` if the shape is wrong.
 */
function parseDraftEnvelope(stored: string): DraftData<unknown> | null {
	const result = decodeDraftEnvelope(safeParse(stored));
	return result._tag === 'Success' ? result.success : null;
}

const generateHash = (str: string): Effect.Effect<string, Cause.UnknownError> =>
	Effect.tryPromise(() => crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))).pipe(
		Effect.map((hashBuffer) =>
			Array.from(new Uint8Array(hashBuffer))
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('')
		)
	);

const hashSchema = (schema: FormSchema): Effect.Effect<string, Cause.UnknownError> => {
	const jsonSchema = schema['~standard'] as Record<string, unknown> & {
		jsonSchema?: {
			input: (options: { readonly target: string }) => Record<string, unknown>;
		};
	};
	const str = JSON.stringify(jsonSchema.jsonSchema?.input({ target: 'draft-2020-12' }) ?? {});
	return generateHash(str);
};

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

		const hashEffect = hashSchema(schema).pipe(
			Effect.match({
				onSuccess: (hash) => {
					this.schemaHash = hash;
					this.init();
				},
				onFailure: () => {
					this.init();
				}
			})
		);
		Effect.runFork(
			hashEffect.pipe(
				Effect.ignoreCause({
					log: true,
					message: `[DraftStorage] Failed to initialize draft storage: ${this.key}`
				})
			)
		);
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

		Effect.runSync(
			Effect.try(() => {
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
						// Eviction is a structured log, not a console side channel: the storage
						// failure it reports belongs to the draft lifecycle, not to the browser.
						Effect.runSync(
							Effect.logWarning(`[DraftStorage] Evicting stale draft (schema changed): ${this.key}`)
						);
						this.clear();
						return;
					}
				}

				this.exists = true;
			}).pipe(
				Effect.catch(() =>
					Effect.sync(() => {
						this.exists = false;
					})
				)
			)
		);
	}

	save(data: T): void {
		if (typeof window === 'undefined') return;
		if (!this.schemaHash) return;

		const schemaHash = this.schemaHash;

		Effect.runSync(
			// The stamp comes from the runtime's clock rather than the ambient one, so a test can
			// pin what a saved draft claims about when it was written.
			Clock.currentTimeMillis.pipe(
				Effect.flatMap((lastModified) =>
					Effect.try(() => {
						const draftData: DraftData<T> = { data, lastModified, schemaHash };
						localStorage.setItem(this.key, JSON.stringify(draftData));
						this.exists = true;
						this.hadSchemaMismatch = false;
					})
				),
				Effect.catch((error) => Effect.logWarning('[DraftStorage] Failed to save draft:', error))
			)
		);
	}

	load(): T | null {
		if (typeof window === 'undefined') return null;
		if (!this.schemaHash) return null;

		return Effect.runSync(
			Effect.try(() => {
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
			}).pipe(
				Effect.match({
					onFailure: (error) => {
						Effect.runSync(Effect.logWarning('[DraftStorage] Failed to load draft:', error));
						return null;
					},
					onSuccess: (draft) => draft
				})
			)
		);
	}

	getMetadata(): { lastModified: number; schemaMatch: boolean } | null {
		if (typeof window === 'undefined') return null;
		if (!this.schemaHash) return null;

		return Effect.runSync(
			Effect.try(() => {
				const stored = localStorage.getItem(this.key);
				if (!stored) return null;

				const parsed = parseDraftEnvelope(stored);
				if (!parsed) return null;
				return {
					lastModified: parsed.lastModified,
					schemaMatch: parsed.schemaHash === this.schemaHash
				};
			}).pipe(
				Effect.match({
					onFailure: () => null,
					onSuccess: (metadata) => metadata
				})
			)
		);
	}

	clear(): void {
		if (typeof window === 'undefined') return;

		Effect.runSync(
			Effect.try(() => {
				localStorage.removeItem(this.key);
				this.exists = false;
				this.hadSchemaMismatch = false;
			}).pipe(
				Effect.catch((error) => Effect.logWarning('[DraftStorage] Failed to clear draft:', error))
			)
		);
	}

	destroy(): void {
		if (this.storageListener && typeof window !== 'undefined') {
			window.removeEventListener('storage', this.storageListener);
			this.storageListener = null;
		}
	}
}
