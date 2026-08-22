<script
	lang="ts"
	generics="TCollections extends CollectionRegistry, TName extends CollectionFormName<TCollections>"
>
	import type {
		CollectionCreateInput,
		CollectionField,
		CollectionFieldName,
		CollectionRecordHistoryEntry,
		CollectionRegistry,
		CollectionRow,
		CollectionUpdateInput,
		RemoteQuery
	} from '@norbital-ai/std/collection';
	import { Button } from '#lib/button';
	import { FormState, maybeAsync, type FormSchema, type TranslateFn } from '#lib/form';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Cluster, Cover, Grid, Scroll, Stack } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { onDestroy } from 'svelte';
	import {
		deriveFormFieldNames,
		optionalCollectionRecordId,
		pickFieldNames
	} from '#lib/collection-table/collection-card-derivation';
	import CollectionFormField, {
		setCollectionFormFieldContext
	} from './collection-form-field.svelte';
	import CollectionFormSkeleton from './collection-form-skeleton.svelte';
	import {
		CollectionRecordMetadataView,
		collectionRecordRestriction,
		resolveCollectionRecordMetadata
	} from '#lib/collection-record-metadata';
	import type {
		CollectionFormFieldComponent,
		CollectionFormName,
		CollectionFormProps,
		CollectionFormValidation,
		CollectionFormValidationIssue
	} from '#lib/collection-form/collection-form.types';
	import { Effect } from 'effect';
	import {
		getCollectionClientForSurface,
		setCollectionClientContext
	} from '#lib/collection-runtime';

	function validateFieldValue(
		field: CollectionField,
		fieldName: string,
		value: unknown
	): readonly CollectionFormValidationIssue[] {
		if (!field.nullable && value == null) {
			return [{ message: t('form.requiredGeneric'), path: [fieldName] }];
		}
		if (value == null) return [];
		if (field.array && !Array.isArray(value)) {
			return [{ message: t('form.invalidList'), path: [fieldName] }];
		}

		const issues: CollectionFormValidationIssue[] = [];
		if (field.values) {
			const selected = Array.isArray(value) ? value : [value];
			if (selected.some((entry) => typeof entry !== 'string' || !field.values?.includes(entry))) {
				issues.push({ message: t('form.invalidOption'), path: [fieldName] });
			}
		}
		if (
			['integer', 'number', 'numeric'].includes(field.kind) &&
			(typeof value !== 'number' || !Number.isFinite(value))
		) {
			issues.push({ message: t('form.invalidNumber'), path: [fieldName] });
		}
		if (field.kind === 'boolean' && typeof value !== 'boolean') {
			issues.push({ message: t('form.invalidBoolean'), path: [fieldName] });
		}
		return issues;
	}

	/**
	 * Result of the runtime schema validation, in the Standard Schema v1 shape: either the issue
	 * list (validation failed) or the transformed candidate (validation passed).
	 */
	type RuntimeValidationResult =
		{ issues: CollectionFormValidationIssue[] } | { value: Record<string, unknown> };

	function validateRegisteredFields(
		fieldsByName: ReadonlyMap<string, CollectionField>,
		registeredFields: ReadonlySet<string>,
		candidate: Readonly<Record<string, unknown>>
	): CollectionFormValidationIssue[] {
		const issues: CollectionFormValidationIssue[] = [];
		for (const fieldName of registeredFields) {
			const field = fieldsByName.get(fieldName);
			if (!field || field.readOnly) continue;
			issues.push(...validateFieldValue(field, fieldName, candidate[fieldName]));
		}
		return issues;
	}

	function standardIssuePath(path: readonly unknown[] | undefined): readonly string[] | undefined {
		return path?.map((segment) => {
			const key =
				typeof segment === 'object' && segment !== null ? Reflect.get(segment, 'key') : segment;
			return String(key);
		});
	}

	/**
	 * Schema validation is an async boundary (a `~standard` validator), so its failure is modelled
	 * in the Effect error channel and folded into the issue list, never thrown.
	 */
	const applySchemaValidation = (
		candidate: Record<string, unknown>,
		validation: CollectionFormValidation | undefined,
		issues: CollectionFormValidationIssue[]
	): Effect.Effect<Record<string, unknown>> => {
		if (!validation?.schema) return Effect.succeed(candidate);
		return maybeAsync(() => validation.schema!['~standard'].validate(candidate)).pipe(
			Effect.catch((cause) =>
				Effect.sync(() => {
					issues.push({
						message: cause instanceof Error ? cause.message : String(cause),
						path: []
					});
					return candidate;
				})
			),
			Effect.map((result) => {
				// boundary-cast — standard-schema answers either a discriminable issue list or a
				// validated value; the catch above folds a thrown validation into the same answer as
				// the untouched candidate, so the map re-reads every runtime answer as that shape.
				const answer = result as RuntimeValidationResult;
				if ('issues' in answer) {
					issues.push(
						...answer.issues.map((issue) => ({
							message: issue.message,
							path: standardIssuePath(issue.path)
						}))
					);
					return candidate;
				}
				if (
					answer.value == null ||
					typeof answer.value !== 'object' ||
					Array.isArray(answer.value)
				) {
					issues.push({ message: t('form.valuesMustBeObject'), path: [] });
					return candidate;
				}
				return Object.fromEntries(Object.entries(answer.value));
			})
		);
	};

	/**
	 * Cross-field validation may perform asynchronous domain checks; its failure is a modelled
	 * issue with the same continuation the caller expects.
	 */
	const applySemanticValidation = (
		candidate: Readonly<Record<string, unknown>>,
		validation: CollectionFormValidation | undefined,
		issues: CollectionFormValidationIssue[]
	): Effect.Effect<void> => {
		if (issues.length > 0 || !validation?.semantic) return Effect.void;
		return validation.semantic(candidate).pipe(
			Effect.catch((cause) =>
				Effect.sync(() => {
					issues.push({
						message: cause instanceof Error ? cause.message : String(cause),
						path: []
					});
				})
			),
			Effect.map((semanticIssues) => {
				if (semanticIssues) issues.push(...semanticIssues);
			})
		);
	};

	let {
		client,
		collection,
		defaultValues,
		submitLabel,
		validation,
		onSubmit,
		deleteAction,
		recordMetadata = [],
		disabled = false,
		loading = false,
		skeletonRows = 4,
		class: className,
		onAfterSubmit,
		fields,
		children
	}: CollectionFormProps<TCollections, TName> = $props();
	// svelte-ignore state_referenced_locally -- a mounted collection surface keeps one generated client.
	const workspaceClient = getCollectionClientForSurface(client, 'CollectionForm');
	setCollectionClientContext(() => workspaceClient);
	// Field kinds whose form control spans the full intrinsic grid width (RFC IV.2 / V.4).
	const FULL_WIDTH_FORM_KINDS: ReadonlySet<string> = new Set(['text', 'json', 'matrix', 'file']);

	const { t } = useI18n<UiKeys>();

	// svelte-ignore state_referenced_locally
	const initialValues: Record<string, unknown> = { ...defaultValues };
	/**
	 * Create or update, decided from the record itself.
	 *
	 * A mounted form owns one record baseline (see `FormState` below), so this is read once from the
	 * same snapshot `initialValues` was taken from; a different record remounts the surface.
	 */
	// svelte-ignore state_referenced_locally
	const recordId = optionalCollectionRecordId(defaultValues);
	const resolvedRecordMetadata = $derived(
		resolveCollectionRecordMetadata(defaultValues, recordMetadata, {
			pendingApprovalLabel: t('recordMetadata.pendingApproval'),
			pendingApprovalReason: t('recordMetadata.pendingApprovalReason')
		})
	);
	const updateRestriction = $derived(
		recordId ? collectionRecordRestriction(resolvedRecordMetadata, 'update') : null
	);
	const deleteRestriction = $derived(
		recordId ? collectionRecordRestriction(resolvedRecordMetadata, 'delete') : null
	);
	const definition = $derived(workspaceClient.collections[String(collection)]);
	// Auto field emission (RFC V.4): a `fields` pick wins over the model-ordered writable set; both
	// are ignored when a `children` composition is provided.
	const autoFieldNames = $derived(
		fields && fields.length > 0
			? pickFieldNames(definition.fields, fields as readonly string[])
			: deriveFormFieldNames(definition.fields)
	);
	// One field lookup per definition, so validation never re-searches the field list per row.
	const fieldByName = $derived(
		new Map(definition.fields.map((field) => [field.name, field] as const))
	);
	const autoFields = $derived(
		autoFieldNames
			.map((name) => fieldByName.get(name))
			.filter((field): field is CollectionField => field != null)
	);
	const registeredFields = new Set<string>();
	let historyRequested = $state(false);
	const historyQuery = $derived.by(() => {
		if (!historyRequested || !recordId || !workspaceClient.history) return undefined;
		return workspaceClient.history.findMany(String(collection), recordId);
	});
	let deleting = $state(false);

	const validateCandidate = (data: unknown): Effect.Effect<RuntimeValidationResult> =>
		Effect.gen(function* () {
			if (data == null || typeof data !== 'object' || Array.isArray(data)) {
				return { issues: [{ message: t('form.formMustBeObject'), path: [] }] };
			}

			let candidate = Object.fromEntries(Object.entries(data));
			const issues = validateRegisteredFields(fieldByName, registeredFields, candidate);
			candidate = yield* applySchemaValidation(candidate, validation, issues);
			yield* applySemanticValidation(candidate, validation, issues);

			return issues.length > 0 ? { issues } : { value: candidate };
		});
	// The `~standard` adapter is the Standard Schema contract of `FormState`; the effect is the
	// validation body, adapted once at this framework boundary.
	const runtimeSchema = {
		'~standard': {
			validate: (data: unknown) => Effect.runPromise(validateCandidate(data))
		}
	} satisfies FormSchema;
	// svelte-ignore state_referenced_locally -- a mounted form owns one record baseline; record changes remount its representation.
	const form: FormState<typeof runtimeSchema, CollectionRow<TCollections[TName]>> = new FormState({
		schema: runtimeSchema,
		defaultState: initialValues,
		serverState: recordId ? initialValues : null,
		disabled: () => loading || disabled || updateRestriction != null,
		submitSuccessBehavior: 'commit',
		successMessage: null,
		translate: t as TranslateFn,
		remoteFn:
			() =>
			(data): Effect.Effect<CollectionRow<TCollections[TName]>, unknown> => {
				const operations = client.db[collection];
				const values = Object.fromEntries(Object.entries(data));
				if (onSubmit) return onSubmit(values);
				if (recordId) {
					if (!operations.update)
						return Effect.fail(new Error('This collection cannot be updated.'));
					const dirtyValues: Record<string, unknown> = Object.fromEntries(
						definition.fields
							.filter((field) => form.hasChangesForPath(field.name))
							.map((field) => [field.name, values[field.name]])
					);
					return Effect.tryPromise(() =>
						operations.update!(
							recordId,
							dirtyValues as CollectionUpdateInput<TCollections[TName]> // stupidity: boundary-cast — dirty rendered fields and validation constrain this dynamic update payload to the selected collection.
						)
					);
				}
				if (!operations.create) return Effect.fail(new Error('This collection cannot be created.'));
				return Effect.tryPromise(() =>
					operations.create!(
						values as CollectionCreateInput<TCollections[TName]> // stupidity: boundary-cast — rendered fields and validation constrain this dynamic form payload to the selected collection.
					)
				);
			},
		onSuccess: (record) => {
			if (record && onAfterSubmit) return onAfterSubmit(record);
		}
	});
	const dirtyFieldCount = $derived(
		definition.fields.filter((field) => form.hasChangesForPath(field.name)).length
	);

	function loadHistory(): void {
		if (!recordId || !workspaceClient.history) return;
		if (historyQuery?.error) void historyQuery.refresh();
		else historyRequested = true;
	}

	setCollectionFormFieldContext({
		collectionName: () => String(collection),
		field: (name) => definition.fields.find((candidate) => candidate.name === name),
		row: () => Object.fromEntries(Object.entries(form.getData())),
		value: (name) => Reflect.get(form.getData(), name),
		// Field values are schema-typed at FormState; collection fields pass unknown at the boundary.
		setValue: (name, value) => form.setValue(name, value as never),
		register: (name) => {
			registeredFields.add(name);
			return () => registeredFields.delete(name);
		},
		dirty: (name) => form.hasChangesForPath(name),
		errors: (name) => form.getFieldErrors(name),
		disabled: () => form.disabled || form.isSubmitting,
		historyAvailable: () => Boolean(recordId && workspaceClient.history),
		loadHistory,
		history: () => historyQuery?.current ?? [],
		historyLoading: () => historyQuery?.loading ?? false,
		historyError: () => historyQuery?.error
	});

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		Effect.runFork(
			form
				.submit()
				.pipe(
					Effect.catch((cause) =>
						Effect.logError(`[CollectionForm:${String(collection)}] submission failed`, cause)
					)
				)
		);
	}

	function clear(): void {
		form.reset();
	}

	function deleteRecord(): void {
		if (!deleteAction || deleting || deleteRestriction || disabled || loading) return;
		deleting = true;
		const deletion = deleteAction.onDelete();
		Effect.runFork(
			(deletion || Effect.void).pipe(
				Effect.onExit(() =>
					Effect.sync(() => {
						deleting = false;
					})
				)
			)
		);
	}

	onDestroy(() => form.destroy());
</script>

{#snippet formFooter()}
	<Stack as="footer" gap="sm" class="border-t" aria-label={t('form.actionsLabel')}>
		{#if form.errorMessage}
			<p class="text-sm text-destructive" role="alert">{form.errorMessage}</p>
		{/if}
		{#each form.errors.formErrors as message, index (`${index}:${message}`)}
			<p class="text-sm text-destructive" role="alert">{message}</p>
		{/each}
		{#if Object.keys(form.errors.fieldErrors).length > 0}
			<p class="text-sm text-destructive" role="alert">{t('form.fixErrors')}</p>
		{/if}
		<Cluster gap="xs" align="center">
			{#if updateRestriction}
				<span class="text-meta">{t('recordMetadata.readOnly')}</span>
			{:else}
				<Button
					type="submit"
					disabled={loading ||
						form.disabled ||
						form.isSubmitting ||
						Boolean(recordId && !form.isDirty)}
				>
					{form.isSubmitting
						? t('form.saving')
						: (submitLabel ?? (recordId ? t('form.save') : t('common.create')))}
				</Button>
				<Button
					type="button"
					variant="outline"
					disabled={loading || form.disabled || form.isSubmitting || !form.isDirty}
					onclick={clear}>{t('common.clear')}</Button
				>
				{#if form.isDirty}
					<span class="text-meta" role="status">
						{dirtyFieldCount === 1
							? t('form.unsavedField', { count: dirtyFieldCount })
							: t('form.unsavedFields', { count: dirtyFieldCount })}
					</span>
				{/if}
			{/if}
			{#if deleteAction}
				<Button
					type="button"
					variant="destructive"
					class="sm:ml-auto"
					disabled={loading ||
						disabled ||
						form.isSubmitting ||
						deleting ||
						Boolean(deleteRestriction) ||
						deleteAction.disabled}
					onclick={() => void deleteRecord()}
				>
					{deleting ? t('form.deleting') : (deleteAction.label ?? t('common.delete'))}
				</Button>
			{/if}
		</Cluster>
	</Stack>
{/snippet}

<Cover
	as="form"
	gap="md"
	class={className}
	aria-busy={loading || form.isSubmitting}
	onsubmit={submit}
	bottom={formFooter}
>
	<CollectionRecordMetadataView metadata={resolvedRecordMetadata} display="notice" class="mx-1" />
	<Scroll name={t('form.fieldsRegion', { name: String(collection) })}>
		<div class="flex min-h-full min-w-0 flex-col pb-4">
			{#if loading}
				<Stack gap="md" aria-label={t('form.loadingForm')}>
					<CollectionFormSkeleton rows={skeletonRows} />
				</Stack>
			{:else if children}
				{@render children({
					// Runtime Field is TFieldName-only; composition exposes a per-usage renderer generic.
					Field: CollectionFormField as CollectionFormFieldComponent<
						CollectionFieldName<TCollections[TName]>
					>,
					form: {
						values: () => Object.fromEntries(Object.entries(form.getData())),
						setValues: (values) => {
							for (const [name, value] of Object.entries(values)) {
								form.setValue(name, value as never);
							}
						}
					}
				})}
			{:else}
				<!-- Auto field emission (RFC V.4a): intrinsic Grid, full-width spans per field kind. -->
				<Grid minimum="card">
					{#each autoFields as field (field.name)}
						<div class={FULL_WIDTH_FORM_KINDS.has(field.kind) ? 'col-span-full' : ''}>
							<CollectionFormField name={field.name} />
						</div>
					{/each}
				</Grid>
			{/if}
		</div>
	</Scroll>
</Cover>
