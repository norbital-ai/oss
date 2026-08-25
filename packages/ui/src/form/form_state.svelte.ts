/**
 * @fileoverview Reactive Form State Manager
 *
 * Implements the Merged State Model with clear distinction between data sources:
 *
 * DATA SOURCES:
 * - Server State (S): Authoritative data from database, immutable during session
 * - Default State (D): Static fallback structure, used only if S is null/undefined
 * - Working Copy (W): Current UI state, synchronized to localStorage via draft storage
 * - Delta (Δ): Computed diff between baseline (S or D) and working copy (W)
 *
 * LIFECYCLE:
 * - Phase A (Hydration): W = draft ?? S ?? D
 * - Phase B (Interaction): User modifies W → persist to draft → compute Δ
 * - Phase C (Visualization): Render W, use Δ to highlight dirty fields
 * - Phase D (Commitment): On save, S ← W, clear draft, Δ becomes empty
 */

import { debounce } from 'es-toolkit/function';
import { cloneDeep } from 'es-toolkit/object';
import get from 'es-toolkit/compat/get';
import merge from 'es-toolkit/compat/merge';
import set from 'es-toolkit/compat/set';
import { Cause, Effect, Predicate } from 'effect';
import type { JsonPatchOperation } from '@norbital-ai/std/json';
import type { MessageVars } from '@norbital-ai/std/i18n';
import { toast } from 'svelte-sonner';
import type { Get } from '#lib/form/path';
import {
	fieldAndFormErrorsFromStandardIssues,
	type StandardSchemaIssue
} from '#lib/form/standard_schema_form_errors';
import { SubmissionHandledExternallyError } from '#lib/form/submission_handled_externally_error';
import {
	compareWithIdentity,
	getChangesForPath,
	hasChangesForPath
} from '#lib/form/utilities/diff_engine';
import {
	DraftStorage,
	type DraftStorage as DraftStorageType
} from './utilities/draft_storage.svelte';

/** Catalog-backed translation handle, threaded in so this state class never renders hardcoded copy. */
export type TranslateFn = (key: string, vars?: MessageVars) => string;

// ============================================================================
// TYPES
// ============================================================================

/**
 * Structural constraint satisfied by any Standard Schema v1 schema, read through `~standard`.
 */
export type FormSchema = {
	readonly ['~standard']: {
		readonly validate: (data: unknown) => unknown;
	};
};

/** Extract the output type from a Standard Schema v1-compatible schema. */
export type InferSchema<S extends FormSchema> = S extends {
	readonly _output: infer T extends object;
}
	? T
	: object;

/**
 * The two shapes a `~standard.validate` answer takes: the issued failures, or the validated value.
 *
 * Narrowing happens once here, at the boundary where the adapter's `unknown` result enters the
 * state class — everything below this line works with the discriminated shape, not with
 * `Reflect.get` probes of a widened value.
 */
type StandardSchemaValidationResult =
	{ readonly issues: readonly StandardSchemaIssue[] } | { readonly value: unknown };

/**
 * Plain submit handler (sync or async). Framework-specific remote callables that
 * share this shape remain compatible at runtime.
 */
export type FormSubmitFn<Schema extends FormSchema, TReturn> = (
	data: InferSchema<Schema>
) => Effect.Effect<TReturn, unknown>;

type RemoteFnGetter<Schema extends FormSchema, TReturn> = () => FormSubmitFn<
	Schema,
	TReturn
> | null;

export type AutoSubmitConfig = {
	/** Enable auto-submit on data change */
	enabled: boolean;
	/** Debounce delay in milliseconds (default: 500) */
	debounceMs?: number;
	/** If true, don't show success toast on auto-submit */
	silent?: boolean;
};

export type SubmitSuccessBehavior = 'none' | 'commit' | 'reset';

/** Helper type: value or getter function */
type MaybeGetter<T> = T | (() => T);

export type FormStateConfig<Schema extends FormSchema, TReturn> = {
	/** Schema for validation */
	schema: MaybeGetter<Schema>;

	/**
	 * Default State (D): Static fallback structure.
	 */
	defaultState?: MaybeGetter<InferSchema<Schema>>;

	/**
	 * Server State (S): Authoritative data from database.
	 */
	serverState?: MaybeGetter<InferSchema<Schema> | null>;

	/**
	 * Remote function to call on submit.
	 */
	remoteFn?: RemoteFnGetter<Schema, TReturn>;

	/** Called after successful submission */
	onSuccess?: (result: TReturn | null) => Effect.Effect<void, unknown> | void;

	/**
	 * Post-submit behavior after a successful submission.
	 * - none: keep current working copy as-is
	 * - commit: treat submitted payload as new baseline and clear dirty state
	 * - reset: reset to baseline and clear draft/errors
	 */
	submitSuccessBehavior?: MaybeGetter<SubmitSuccessBehavior>;

	/** Transform data before validation/submission */
	transform?: MaybeGetter<(data: InferSchema<Schema>) => InferSchema<Schema>>;

	/** Toast message on success. Set to null to disable. */
	successMessage?: MaybeGetter<string | null>;

	/**
	 * Catalog-backed translate handle for built-in copy (success toast, validation
	 * summary, generic failure). When omitted, English fallbacks are used.
	 */
	translate?: TranslateFn;

	/** Optional description for debugging */
	description?: MaybeGetter<string>;

	/**
	 * Whether the form is disabled. Can be a getter for reactivity.
	 */
	disabled?: MaybeGetter<boolean>;

	/**
	 * Key parts for draft persistence. If provided, enables automatic draft save/load.
	 * The draft storage IS the Working Copy (W) - persisted to localStorage.
	 * On hydration: W = draft ?? serverState ?? defaultState
	 *
	 * Can be a getter for reactivity.
	 * @example draftKey: ['create_form', collectionId]
	 * @example draftKey: () => ['unified_form', entityId]
	 */
	draftKey?: MaybeGetter<string[]>;

	/**
	 * Auto-submit configuration. When enabled, form auto-submits on data change.
	 * Can be a getter for reactivity.
	 */
	autoSubmit?: MaybeGetter<AutoSubmitConfig | undefined>;
};

/**
 * Hook callbacks for FormState lifecycle events
 */
export type FormStateHooks<T> = {
	/** Called after working copy changes (via setData or setValue) */
	onDataChange?: (workingCopy: T) => void;
	/** Called before form submission */
	onBeforeSubmit?: (data: T) => void;
	/** Called after successful submission */
	onAfterSubmit?: (data: T, result: unknown) => void;
};

// ============================================================================
// FORM STATE CLASS
// ============================================================================

/**
 * A reactive form state manager implementing the Merged State Model.
 *
 * `schema` is any Standard Schema, read through `~standard` — the Effect adapter
 * (`Schema.toStandardSchemaV1`) below, or anything else implementing the spec. Nothing here depends
 * on the library.
 *
 * @example
 * ```typescript
 * import { Schema } from 'effect';
 *
 * const form = new FormState({
 *   schema: Schema.toStandardSchemaV1(Schema.Struct({
 *     name: Schema.String,
 *     email: Schema.String
 *   })),
 *   defaultState: { name: '', email: '' },      // D - fallback
 *   serverState: existingUser,                   // S - from database (optional)
 *   draftKey: ['user_form', 'create'],          // enables W persistence
 *   remoteFn: () => saveUser,
 *   onSuccess: () => closeModal()
 * });
 *
 * // Hydration: W is initialized from draft ?? S ?? D
 *
 * // User interaction updates W (working copy)
 * form.setData({ name: 'John' });
 *
 * // Check dirty state (Δ is not empty)
 * if (form.isDirty) { ... }
 *
 * // Submit: validates W, sends to server, on success S ← W
 * await form.submit();
 *
 * // Cleanup on unmount
 * form.destroy();
 * ```
 */
/** Resolve MaybeGetter: call if zero-arg function (getter), return value otherwise */
function resolve<T>(v: MaybeGetter<T>): T {
	// Check if it's a getter (function with 0 declared params)
	// vs an actual function value (has params)
	if (typeof v === 'function' && v.length === 0) {
		return (v as () => T)();
	}
	return v as T;
}

/** Run a possibly-synchronous callback and await its result through Effect. */
export function maybeAsync<A>(evaluate: () => A): Effect.Effect<Awaited<A>, Cause.UnknownError> {
	return Effect.try(evaluate).pipe(
		Effect.flatMap((value) =>
			Predicate.isPromise(value) ? Effect.tryPromise(() => value) : Effect.succeed(value)
		)
	) as Effect.Effect<Awaited<A>, Cause.UnknownError>;
}

type SubmissionState<TReturn> =
	| { status: 'idle' }
	| { status: 'submitting' }
	| { status: 'success'; result: TReturn }
	| { status: 'error'; message: string };

export class FormState<Schema extends FormSchema, TReturn = unknown> {
	// ============================================================================
	// CONFIG (stored as MaybeGetter, resolved reactively in $derived)
	// ============================================================================

	private _disabledConfig: MaybeGetter<boolean> = false;
	private _remoteFnConfig: RemoteFnGetter<Schema, TReturn> = () => null;
	private _autoSubmitConfig: MaybeGetter<AutoSubmitConfig | undefined> = undefined;
	private _draftKeyConfig: MaybeGetter<string[] | undefined> = undefined;
	private _schemaConfig!: MaybeGetter<Schema>;
	private _serverStateConfig: MaybeGetter<InferSchema<Schema> | null> = null;
	private readonly _submitSuccessBehaviorConfig: MaybeGetter<SubmitSuccessBehavior> = 'none';
	private _successMessageConfig: MaybeGetter<string | null> = 'Saved successfully';
	private readonly _translate?: TranslateFn;

	// ============================================================================
	// DATA SOURCES (following the Merged State Model)
	// ============================================================================

	/**
	 * Server State (S): Derived from config. Authoritative data from database.
	 * Reactive - if config is a getter, tracks whatever reactive state it reads.
	 */
	private _serverState = $derived(resolve(this._serverStateConfig));

	/**
	 * Default State (D): Mutable for per-field defaults set by authored form runtimes.
	 * Initialized from config, then can be mutated via setDefaultState().
	 */
	private _defaultState = $state<InferSchema<Schema>>({} as InferSchema<Schema>);

	/**
	 * Working Copy (W): Current form data in the UI.
	 * Mutable - represents the "Right-Hand Side" of diff.
	 * Synchronized to localStorage via draft storage.
	 */
	private _workingCopy = $state({}) as InferSchema<Schema>;

	// ============================================================================
	// REACTIVE DERIVED STATE
	// ============================================================================

	/** Whether the form is disabled (reactive) */
	disabled = $derived(resolve(this._disabledConfig));
	private schema = $derived(resolve(this._schemaConfig));

	/** Submission state machine. */
	private submissionState = $state<SubmissionState<TReturn>>({
		status: 'idle'
	});

	/** Whether a submission is in progress */
	isSubmitting: boolean = $derived(this.submissionState.status === 'submitting');

	/** Result from last successful submission */
	lastResult: TReturn | undefined = $derived(
		this.submissionState.status === 'success' ? this.submissionState.result : undefined
	);

	/** Error message from last failed submission */
	errorMessage: string | null = $derived(
		this.submissionState.status === 'error' ? this.submissionState.message : null
	);

	/** Success message text while the last submission is in the success state (before commit/reset). */
	submitSuccessMessage: string | null = $derived(
		this.submissionState.status === 'success' ? resolve(this._successMessageConfig) : null
	);

	/** Validation errors */
	errors = $state({
		fieldErrors: {} as Record<string, string[]>,
		formErrors: [] as string[]
	});

	/** Whether client-side validation failed on the last submit attempt */
	hasValidationErrors: boolean = $derived(
		Object.keys(this.errors.fieldErrors).length > 0 || this.errors.formErrors.length > 0
	);

	/** First validation error message, when {@link hasValidationErrors} is true */
	validationErrorMessage: string | null = $derived.by((): string | null => {
		if (!this.hasValidationErrors) return null;
		const fieldMessages = Object.values(this.errors.fieldErrors).flat();
		if (fieldMessages.length > 0) return fieldMessages[0];
		return (
			this.errors.formErrors[0] ??
			this._translate?.('form.fixErrors') ??
			'Please fix the highlighted errors.'
		);
	});

	// ============================================================================
	// PRIVATE MEMBERS
	// ============================================================================

	private readonly _transformConfig?: MaybeGetter<
		(data: InferSchema<Schema>) => InferSchema<Schema>
	>;
	private readonly onSuccess?: (result: TReturn | null) => Effect.Effect<void, unknown> | void;
	private readonly description: MaybeGetter<string>;
	private draftStorage: DraftStorageType<InferSchema<Schema>> | null = null;
	private debouncedSaveDraft: (() => void) | null = null;
	private debouncedAutoSubmit: (() => void) | null = null;
	private hooks: FormStateHooks<InferSchema<Schema>> = {};

	// ============================================================================
	// DERIVED STATE
	// ============================================================================

	/**
	 * Baseline: The reference point for diff calculation.
	 * Formula: baseline = serverState ?? defaultState
	 * This is what W is compared against to compute Δ.
	 */
	baseline = $derived.by<InferSchema<Schema>>(() => this._serverState ?? this._defaultState);

	/**
	 * Delta (Δ): RFC 6902 JSON Patch operations from baseline to working copy.
	 * Represents the "distance traveled" from S (or D) to W.
	 * Uses identity-aware comparison for arrays with 'id' or 'id' keys.
	 */
	delta = $derived.by(() => {
		const snapshotEffect = Effect.try(() => {
			const b = $state.snapshot(this.baseline);
			const w = $state.snapshot(this._workingCopy);
			return compareWithIdentity(b, w);
		});
		return Effect.runSync(
			snapshotEffect.pipe(
				Effect.match({
					onFailure: (error) => {
						Effect.runSync(Effect.logError('[FormState] Error calculating delta:', error));
						return [] as JsonPatchOperation[];
					},
					onSuccess: (operations) => operations
				})
			)
		);
	});

	/**
	 * isDirty: Whether the working copy differs from baseline.
	 * True when Δ contains any operations.
	 */
	isDirty = $derived(this.delta.length > 0);

	/**
	 * hasDraft: Whether a persisted draft exists in localStorage.
	 * Only relevant when draftKey is configured.
	 */
	hasDraft = $derived(this.draftStorage?.exists ?? false);

	/**
	 * hasServerState: Whether we have authoritative server data.
	 * false when creating new entity, true when editing existing.
	 */
	hasServerState = $derived(this._serverState !== null);

	// ============================================================================
	// CONSTRUCTOR
	// ============================================================================

	constructor(config: FormStateConfig<Schema, TReturn>) {
		this._schemaConfig = config.schema;
		this.onSuccess = config.onSuccess;
		this._submitSuccessBehaviorConfig = config.submitSuccessBehavior ?? 'none';
		this._transformConfig = config.transform;
		this._translate = config.translate;
		this._successMessageConfig =
			config.successMessage !== undefined
				? config.successMessage
				: () => config.translate?.('form.savedSuccessfully') ?? 'Saved successfully';
		this.description = config.description ?? 'unnamed form';

		// Store config as MaybeGetter (resolved reactively or at point of use)
		this._disabledConfig = config.disabled ?? false;
		this._remoteFnConfig = config.remoteFn ?? (() => null);
		this._autoSubmitConfig = config.autoSubmit;
		this._draftKeyConfig = config.draftKey;
		this._serverStateConfig = config.serverState ?? null;

		// Read initial values
		const initialServerState = resolve(this._serverStateConfig);
		const initialDefaultState = config.defaultState ? resolve(config.defaultState) : undefined;
		const initialDraftKey = resolve(this._draftKeyConfig);
		const initialAutoSubmit = resolve(this._autoSubmitConfig);

		// Initialize default state (can be mutated later via setDefaultState for per-field defaults)
		const effectiveDefaultState = initialDefaultState ?? initialServerState;
		if (effectiveDefaultState == null) {
			throw new Error('[FormState] Either defaultState or serverState must be provided');
		}
		this._defaultState = cloneDeep(effectiveDefaultState);

		// Initialize draft storage if key provided
		this.initDraftStorage(initialDraftKey);

		// ============================================================
		// PHASE A: HYDRATION
		// Formula: W = draft ?? S ?? D
		// ============================================================
		const draft = this.draftStorage?.load() ?? null;
		if (draft !== null) {
			this._workingCopy = draft;
		} else if (initialServerState !== null) {
			this._workingCopy = cloneDeep(initialServerState);
		} else {
			this._workingCopy = cloneDeep(this._defaultState);
		}

		// Initialize auto-submit if configured
		this.initAutoSubmit(initialAutoSubmit);
	}

	/**
	 * Initialize or reinitialize draft storage.
	 */
	private initDraftStorage(draftKey: string[] | undefined): void {
		if (draftKey && draftKey.length > 0) {
			this.draftStorage = new DraftStorage<InferSchema<Schema>>({
				keyParts: draftKey,
				schema: this.schema,
				onSchemaMismatch: 'evict'
			});

			// Setup debounced draft save - persists W to localStorage
			this.debouncedSaveDraft = debounce(() => {
				if (this.draftStorage) {
					if (this.isDirty) {
						this.draftStorage.save(this._workingCopy);
					} else {
						// W equals baseline, no need to persist
						this.draftStorage.clear();
					}
				}
			}, 300);
		} else {
			this.draftStorage = null;
			this.debouncedSaveDraft = null;
		}
	}

	/**
	 * Initialize or reinitialize auto-submit.
	 */
	private initAutoSubmit(autoSubmit: AutoSubmitConfig | undefined): void {
		if (autoSubmit?.enabled) {
			this.debouncedAutoSubmit = debounce(() => {
				if (!this.disabled && this.isDirty && !this.isSubmitting) {
					Effect.runFork(this.submit({ silent: autoSubmit.silent ?? false }));
				}
			}, autoSubmit.debounceMs ?? 500);
		} else {
			this.debouncedAutoSubmit = null;
		}
	}

	// ============================================================================
	// HOOKS
	// ============================================================================

	/**
	 * Register a hook callback for lifecycle events.
	 */
	setHook = <K extends keyof FormStateHooks<InferSchema<Schema>>>(
		hookName: K,
		callback: FormStateHooks<InferSchema<Schema>>[K]
	): void => {
		this.hooks[hookName] = callback;
	};

	/**
	 * Remove a hook callback.
	 */
	removeHook = <K extends keyof FormStateHooks<InferSchema<Schema>>>(hookName: K): void => {
		delete this.hooks[hookName];
	};

	// ============================================================================
	// PHASE B: INTERACTION - Working Copy (W) Mutations
	// ============================================================================

	/**
	 * Update working copy with deep merge support.
	 * Pass `replace: true` to replace entirely instead of merging.
	 * Automatically persists to draft storage and triggers auto-submit.
	 *
	 * @param data - Partial data to merge, or full data if replacing
	 * @param options.replace - Whether to replace instead of merge
	 * @param options.triggerHooks - Whether to trigger onDataChange hook (default: true)
	 * @param options.force - Bypass disabled check for programmatic updates (e.g., streaming)
	 */
	setData = (
		data: Partial<InferSchema<Schema>>,
		options?: { replace?: boolean; triggerHooks?: boolean; force?: boolean }
	): void => {
		if (this.disabled && !options?.force) return;

		const triggerHooks = options?.triggerHooks !== false;

		if (options?.replace) {
			// Clear and Object.assign to maintain the proxy reference
			for (const key in this._workingCopy) Reflect.deleteProperty(this._workingCopy, key);
			Object.assign(this._workingCopy, data);
		} else {
			// Mutate working copy in place using deep merge
			merge(this._workingCopy, data);
		}
		this.finalizeWorkingCopyMutation(triggerHooks, Object.keys(data as object));
	};

	private replaceWorkingCopy = (next: InferSchema<Schema>): void => {
		for (const key in this._workingCopy) Reflect.deleteProperty(this._workingCopy, key);
		Object.assign(this._workingCopy, cloneDeep(next));
	};

	private commitSubmittedData = (submitted: InferSchema<Schema>): void => {
		const committed = cloneDeep(submitted);
		// Move baseline forward so the form becomes clean without remounting.
		// `_serverState` is derived from initial config; updating config alone
		// won't reliably move baseline. Mutate the active baseline object in place.
		if (this._serverState && typeof this._serverState === 'object') {
			for (const key in this._serverState) Reflect.deleteProperty(this._serverState, key);
			Object.assign(this._serverState, cloneDeep(committed));
		}
		this._defaultState = cloneDeep(committed);
		this.replaceWorkingCopy(committed);
		this.submissionState = { status: 'idle' };
		this.clearErrors();
	};

	private finalizeWorkingCopyMutation(triggerHooks: boolean, changedPaths: string[] = []): void {
		for (const path of changedPaths) {
			this.clearFieldError(path);
		}
		if (changedPaths.length > 0 && this.errors.formErrors.length > 0) {
			this.errors = { ...this.errors, formErrors: [] };
		}
		if (changedPaths.length > 0 && this.submissionState.status === 'error') {
			this.submissionState = { status: 'idle' };
		}
		this.debouncedSaveDraft?.();
		this.debouncedAutoSubmit?.();
		if (triggerHooks) {
			this.hooks.onDataChange?.(this._workingCopy);
		}
	}

	/**
	 * Get the current working copy.
	 */
	getData = (): InferSchema<Schema> => {
		return this._workingCopy;
	};

	/**
	 * Get a field value from working copy by dot-notation path.
	 */
	getValue = <K extends string>(path: K): Get<InferSchema<Schema>, K> => {
		return get(this._workingCopy, path) as Get<InferSchema<Schema>, K>;
	};

	/**
	 * Set a field value in working copy by dot-notation path.
	 * Automatically persists to draft storage and triggers auto-submit.
	 * Pass triggerHooks: false to skip onDataChange (e.g. when writing derived values).
	 */
	setValue = <K extends string>(
		path: K,
		value: Get<InferSchema<Schema>, K>,
		options?: { triggerHooks?: boolean; force?: boolean }
	): void => {
		if (this.disabled && !options?.force) return;

		const triggerHooks = options?.triggerHooks !== false;

		// Mutate working copy in place
		set(this._workingCopy, path, value);
		this.finalizeWorkingCopyMutation(triggerHooks, [path]);
	};

	setValueAtPath = <K extends string>(
		path: K,
		value: Get<InferSchema<Schema>, K>,
		options?: { triggerHooks?: boolean; force?: boolean }
	): void => {
		this.setValue(path, value, options);
	};

	/**
	 * Reset working copy to baseline (S or D) and clear draft.
	 * After reset: W = baseline, Δ becomes empty.
	 */
	reset = (): void => {
		const b = cloneDeep(this.baseline);
		for (const key in this._workingCopy) Reflect.deleteProperty(this._workingCopy, key);
		Object.assign(this._workingCopy, b);

		this.submissionState = { status: 'idle' };
		this.clearErrors();
		this.draftStorage?.clear();
	};

	/**
	 * Load draft data without applying it.
	 * Returns the raw draft for custom merging, or null if no draft.
	 */
	loadDraft = (): InferSchema<Schema> | null => {
		return this.draftStorage?.load() ?? null;
	};

	/**
	 * Apply draft to working copy if one exists.
	 * Returns true if draft was applied.
	 */
	applyDraft = (): boolean => {
		const draft = this.loadDraft();
		if (draft !== null) {
			this.setData(draft, { replace: true });
			return true;
		}
		return false;
	};

	/**
	 * Explicitly clear the draft from storage.
	 */
	clearDraft = (): void => {
		this.draftStorage?.clear();
	};

	/**
	 * Cleanup draft storage listeners and pending tasks.
	 * Call this when the form component is destroyed.
	 */
	destroy = (): void => {
		this.debouncedSaveDraft?.();
		this.debouncedAutoSubmit?.();
		this.draftStorage?.destroy();
	};

	/**
	 * Get the current server state (S).
	 * Derived from the getter - parent controls this value.
	 */
	getServerState = (): InferSchema<Schema> | null => {
		return this._serverState;
	};

	// ============================================================================
	// DEFAULT STATE (D) MANAGEMENT
	// ============================================================================

	/**
	 * Update default state at a specific path.
	 * Auto-merges to workingCopy if the path has no value (null/undefined).
	 * Used by authored form runtimes to register per-field defaults (defaultValue callbacks).
	 *
	 * @param path - Dot-notation path to set
	 * @param value - Default value for that path
	 */
	setDefaultState = <K extends string>(path: K, value: Get<InferSchema<Schema>, K>): void => {
		// Update defaultState
		set(this._defaultState, path, cloneDeep(value));

		// Auto-merge to workingCopy if no existing value
		const existing = get(this._workingCopy, path);
		if (existing == null) {
			set(this._workingCopy, path, cloneDeep(value));
		}
	};

	setDefaultValueAtPath = (path: string, value: unknown): void => {
		this.setDefaultState(path as never, value as never);
	};

	/**
	 * Get the current default state (D).
	 */
	getDefaultState = (): InferSchema<Schema> => {
		return this._defaultState;
	};

	/**
	 * Get the item template for an array path (for ListBlock new items).
	 * Returns the first item from defaultState array, or empty object.
	 *
	 * @param arrayPath - Dot-notation path to the array
	 */
	getArrayItemTemplate = (arrayPath: string): unknown => {
		const arr = get(this._defaultState, arrayPath);
		if (Array.isArray(arr) && arr.length > 0) {
			return cloneDeep(arr[0]);
		}
		return {};
	};

	/**
	 * Push a new item to an array in workingCopy, using defaultState template.
	 * Triggers onDataChange hook for derived value recalculation.
	 *
	 * @param arrayPath - Dot-notation path to the array
	 * @param item - Optional custom item (defaults to array item template from defaultState)
	 */
	pushArrayItem = (arrayPath: string, item?: unknown): void => {
		if (this.disabled) return;

		const template = item ?? this.getArrayItemTemplate(arrayPath);
		const arr = get(this._workingCopy, arrayPath);

		if (Array.isArray(arr)) {
			arr.push(cloneDeep(template));
		} else {
			// Initialize array if it doesn't exist
			set(this._workingCopy, arrayPath, [cloneDeep(template)]);
		}
		this.finalizeWorkingCopyMutation(true, [arrayPath]);
	};

	/**
	 * Remove an item from an array in workingCopy by index.
	 * Triggers onDataChange hook for derived value recalculation.
	 *
	 * @param arrayPath - Dot-notation path to the array
	 * @param index - Index of item to remove
	 */
	removeArrayItem = (arrayPath: string, index: number): void => {
		if (this.disabled) return;

		const arr = get(this._workingCopy, arrayPath);

		if (Array.isArray(arr) && index >= 0 && index < arr.length) {
			arr.splice(index, 1);
			this.finalizeWorkingCopyMutation(true, [arrayPath]);
		}
	};

	// ============================================================================
	// PHASE C: VISUALIZATION - Delta (Δ) Queries
	// ============================================================================

	/**
	 * Get delta operations for a specific field path.
	 * Useful for highlighting changed fields in the UI.
	 */
	getDeltaForPath = (path: string): JsonPatchOperation[] => {
		return getChangesForPath(this.delta, path, this.baseline);
	};

	/**
	 * Check if a specific field path has changes in delta.
	 * Useful for conditionally styling dirty fields.
	 *
	 * NOTE: Since Δ is computed on normalized data (where arrays with IDs are objects),
	 * we need to handle both positional and identity-based paths.
	 */
	hasChangesForPath = (path: string): boolean => {
		return hasChangesForPath(this.delta, path, this.baseline);
	};

	// ============================================================================
	// ERROR METHODS
	// ============================================================================

	clearErrors = (): void => {
		this.errors = { fieldErrors: {}, formErrors: [] };
	};

	clearFieldError = (path: string): void => {
		const descendantPrefix = `${path}.`;
		const nextFieldErrors = Object.fromEntries(
			Object.entries(this.errors.fieldErrors).filter(
				([key]) => key !== path && !key.startsWith(descendantPrefix)
			)
		);
		if (Object.keys(nextFieldErrors).length !== Object.keys(this.errors.fieldErrors).length) {
			this.errors = { ...this.errors, fieldErrors: nextFieldErrors };
		}
	};

	setFieldError = (path: string, messages: string[] | string): void => {
		const msgs = Array.isArray(messages) ? messages : [messages];
		this.errors = {
			...this.errors,
			fieldErrors: { ...this.errors.fieldErrors, [path]: msgs }
		};
	};

	getFieldErrors = (path: string): string[] => {
		const descendantPrefix = `${path}.`;
		return Object.entries(this.errors.fieldErrors).flatMap(([key, messages]) =>
			key === path || key.startsWith(descendantPrefix) ? messages : []
		);
	};

	// ============================================================================
	// PHASE D: COMMITMENT - Submission
	// ============================================================================

	/**
	 * Submit the form.
	 * Validates W, calls remoteFn if provided, and handles success/error states.
	 *
	 * On success:
	 * - S ← W (working copy becomes new server state)
	 * - Clear draft storage
	 * - Δ becomes empty (since S now equals W)
	 *
	 * @param options - { silent?: boolean } - If true, don't show success toast
	 */
	submit = (options?: { silent?: boolean }): Effect.Effect<TReturn | null, unknown> => {
		if (this.disabled || this.isSubmitting) {
			return Effect.succeed(null);
		}

		const silent = options?.silent ?? false;

		this.submissionState = { status: 'submitting' };
		this.clearErrors();

		return Effect.gen({ self: this }, function* () {
			const transformFn = this._transformConfig ? resolve(this._transformConfig) : undefined;
			const payloadRaw = transformFn ? transformFn(this._workingCopy) : this._workingCopy;

			// Call before submit hook
			this.hooks.onBeforeSubmit?.(payloadRaw);

			const rawResult = yield* maybeAsync(() => this.schema['~standard'].validate(payloadRaw));
			const validation = rawResult as StandardSchemaValidationResult;
			const issues = 'issues' in validation ? validation.issues : undefined;

			if (Array.isArray(issues)) {
				this.setValidationIssuesFromStandardSchema(issues);
				this.submissionState = { status: 'idle' };
				if (!silent) {
					toast.error(this._translate?.('form.fixErrors') ?? 'Please fix the highlighted errors.');
					yield* Effect.logError('[FormState] Validation issues:', issues);
				}
				return null;
			}

			const validated =
				'value' in validation
					? (validation.value as InferSchema<Schema>)
					: (validation as InferSchema<Schema>);

			const remoteFn = this._remoteFnConfig();

			if (!remoteFn) {
				this.draftStorage?.clear();
				this.hooks.onAfterSubmit?.(validated, null);
				const success = this.onSuccess?.(null);
				if (success) yield* success;
				this.submissionState = { status: 'idle' };
				return null;
			}

			const remoteReturn = yield* remoteFn(validated);
			this.submissionState = {
				status: 'success',
				result: remoteReturn
			};

			this.draftStorage?.clear();

			switch (resolve(this._submitSuccessBehaviorConfig)) {
				case 'commit':
					this.commitSubmittedData(validated);
					break;
				case 'reset':
					this.reset();
					break;
				case 'none':
				default:
					break;
			}

			const successMessage = resolve(this._successMessageConfig);
			if (successMessage !== null && !silent) {
				toast.success(successMessage);
			}

			this.hooks.onAfterSubmit?.(validated, remoteReturn);
			const success = this.onSuccess?.(remoteReturn);
			if (success) yield* success;
			return remoteReturn;
		}).pipe(
			Effect.catch((error) => {
				if (error instanceof SubmissionHandledExternallyError) {
					this.submissionState = { status: 'idle' };
					return Effect.succeed(null);
				}
				const message =
					error instanceof Error && error.message.trim().length > 0
						? error.message
						: (this._translate?.('misc.toastError') ?? 'An error occurred');
				this.submissionState = { status: 'error', message };
				return Effect.fail(error);
			}),
			Effect.onExit(() =>
				Effect.sync(() => {
					if (this.submissionState.status === 'submitting') {
						this.submissionState = { status: 'idle' };
					}
				})
			)
		);
	};

	/**
	 * Handle form submit event.
	 */
	handleSubmit = (event: Event): void => {
		event.preventDefault();
		Effect.runFork(this.submit());
	};

	// ============================================================================
	// PRIVATE METHODS
	// ============================================================================

	private setValidationIssuesFromStandardSchema = (
		issues: readonly StandardSchemaIssue[]
	): void => {
		this.errors = fieldAndFormErrorsFromStandardIssues(issues);
	};
}
