<script
	lang="ts"
	generics="TCollections extends CollectionRegistry, TName extends CollectionFormName<TCollections>"
>
	import { getErrorMessage } from '@norbital-ai/std';
	import type {
		CollectionField,
		CollectionFieldName,
		CollectionRecordHistoryEntry,
		CollectionRegistry,
		CollectionRow,
		RemoteQuery
	} from '@norbital-ai/std/collection';
	import { Button } from '#lib/button';
	import { FormState, maybeAsync, type FormSchema } from '#lib/form';
	import { useI18n } from '#lib/i18n';
	import { Cluster, Cover, Scroll, Stack } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { onDestroy } from 'svelte';
	import { optionalCollectionRecordId } from '#lib/collection-surface';
	import {
		assertCollectionFormFieldRegistration,
		collectionFormMutationFieldNames,
		pickCollectionFormValues,
		pickWritableFormValues
	} from './collection-form-values';
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
		CollectionFormComposition,
		CollectionFormName,
		CollectionFormProps,
		CollectionFormValidation,
		CollectionFormValidationIssue
	} from '#lib/collection-form/collection-form.types';
	import { Cause, Effect } from 'effect';
	import { toast } from 'svelte-sonner';
	import {
		getCollectionClientForSurface,
		setCollectionClientContext
	} from '#lib/collection-runtime';
	import {
		submitCollectionMutation,
		type CollectionMutationSubmission
	} from './collection-mutation-outcome';

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
						message: getErrorMessage(cause),
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
						message: getErrorMessage(cause),
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
		children
	}: CollectionFormProps<TCollections, TName> = $props();
	// svelte-ignore state_referenced_locally -- a mounted collection surface keeps one generated client.
	const workspaceClient = getCollectionClientForSurface(client, 'CollectionForm');
	setCollectionClientContext(() => workspaceClient);
	const definition = $derived(workspaceClient.collections[String(collection)]);
	const { t } = useI18n();
	/**
	 * Pending approval is not a live commit. The form stays open with its draft so the operator can
	 * still see what they submitted; `commit` would pretend the live collection already held it.
	 */
	let lastSubmissionKind = $state<'committed' | 'pendingApproval' | undefined>(undefined);

	// svelte-ignore state_referenced_locally
	const initialValues: Record<string, unknown> = pickCollectionFormValues(
		definition.fields,
		defaultValues ?? {}
	);
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
	// One field lookup per definition, so validation never re-searches the field list per row.
	const fieldByName = $derived(
		new Map(definition.fields.map((field) => [field.name, field] as const))
	);
	const operations = $derived(client.db[collection]);
	const registeredFields = new Map<string, number>();
	const hiddenFields = new Set<string>();
	const mutationFieldNames = $derived(collectionFormMutationFieldNames(definition.fields));
	let historyRequested = $state(false);
	const historyQuery = $derived.by(() => {
		const currentRecordId = optionalCollectionRecordId(defaultValues);
		if (!historyRequested || !currentRecordId || !workspaceClient.history) return undefined;
		return workspaceClient.history.findMany(String(collection), currentRecordId);
	});
	let deleting = $state(false);

	const validateCandidate = (data: unknown): Effect.Effect<RuntimeValidationResult> =>
		Effect.gen(function* () {
			if (data == null || typeof data !== 'object' || Array.isArray(data)) {
				return { issues: [{ message: t('form.formMustBeObject'), path: [] }] };
			}

			let candidate = Object.fromEntries(Object.entries(data));
			// Hidden declarations prove composition completeness but mount no operator control. They
			// therefore leave value derivation to the caller or collection hook and do not run the
			// interactive required-value check that belongs to a visible input.
			const visibleMutationFields = new Set(
				mutationFieldNames.filter((fieldName) => !hiddenFields.has(fieldName))
			);
			const issues = validateRegisteredFields(fieldByName, visibleMutationFields, candidate);
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
	const form: FormState<typeof runtimeSchema, CollectionMutationSubmission | void> = new FormState({
		schema: runtimeSchema,
		defaultState: initialValues,
		serverState: recordId ? initialValues : null,
		disabled: () => loading || disabled || updateRestriction != null,
		submitSuccessBehavior: () => (lastSubmissionKind === 'pendingApproval' ? 'none' : 'commit'),
		successMessage: null,
		translate: t,
		remoteFn:
			() =>
			(data): Effect.Effect<CollectionMutationSubmission | void, Cause.UnknownError> => {
				const values = Object.fromEntries(Object.entries(data));
				if (onSubmit) return onSubmit(values);
				const writableValues = pickWritableFormValues(definition.fields, values);
				return submitCollectionMutation(() =>
					operations.mutate(recordId ? { id: recordId, ...writableValues } : writableValues)
				).pipe(
					Effect.tap((submission) => {
						lastSubmissionKind =
							submission.kind === 'pendingApproval' ? 'pendingApproval' : 'committed';
					})
				);
			},
		onSuccess: (submission) => {
			if (submission?.kind === 'pendingApproval') {
				toast.success(t('form.submittedForApproval'));
				return;
			}
			return onAfterSubmit?.();
		}
	});
	const submissionPending = $derived(onSubmit ? form.isSubmitting : operations.pending > 0);
	const dirtyFieldCount = $derived(
		definition.fields.filter((field) => form.hasChangesForPath(field.name)).length
	);

	function loadHistory(): void {
		if (!recordId || !workspaceClient.history) return;
		historyRequested = true;
	}

	setCollectionFormFieldContext({
		collectionName: () => String(collection),
		field: (name) => definition.fields.find((candidate) => candidate.name === name),
		row: () => Object.fromEntries(Object.entries(form.getData())),
		value: (name) => Reflect.get(form.getData(), name),
		// Field values are schema-typed at FormState; collection fields pass unknown at the boundary.
		setValue: (name, value) => form.setValue(name, value as never),
		register: (name, hidden) => {
			registeredFields.set(name, (registeredFields.get(name) ?? 0) + 1);
			if (hidden) hiddenFields.add(name);
			return () => {
				const count = registeredFields.get(name) ?? 0;
				if (count <= 1) registeredFields.delete(name);
				else registeredFields.set(name, count - 1);
				if (hidden) hiddenFields.delete(name);
			};
		},
		dirty: (name) => form.hasChangesForPath(name),
		errors: (name) => form.getFieldErrors(name),
		disabled: () => form.disabled || submissionPending,
		historyAvailable: () => Boolean(recordId && workspaceClient.history),
		loadHistory,
		history: () => historyQuery?.current ?? [],
		historyLoading: () => historyQuery?.loading ?? false,
		historyError: () => historyQuery?.error
	});

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		assertCollectionFormFieldRegistration(String(collection), definition.fields, registeredFields);
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

	$effect(() => {
		if (loading) return;
		assertCollectionFormFieldRegistration(String(collection), definition.fields, registeredFields);
	});
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
						submissionPending ||
						Boolean(recordId && !form.isDirty)}
				>
					{submissionPending
						? t('form.saving')
						: (submitLabel ?? (recordId ? t('form.save') : t('common.create')))}
				</Button>
				<Button
					type="button"
					variant="outline"
					disabled={loading || form.disabled || submissionPending || !form.isDirty}
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
						submissionPending ||
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
	aria-busy={loading || submissionPending}
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
			{:else}
				{@render children({
					Field: CollectionFormField as unknown as CollectionFormComposition<
						TCollections,
						TName
					>['Field'],
					form: {
						values: () => Object.fromEntries(Object.entries(form.getData())),
						setValues: (values) => {
							for (const [name, value] of Object.entries(values)) {
								form.setValue(name, value as never);
							}
						}
					}
				})}
			{/if}
		</div>
	</Scroll>
</Cover>
