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
	import { FormState, type FormSchema, type TranslateFn } from '#lib/form';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Cluster, Cover, Grid, Scroll, Stack } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { onDestroy } from 'svelte';
	import {
		deriveFormFieldNames,
		isFullWidthFormField,
		optionalCollectionRecordId,
		pickFieldNames
	} from '../collection-table/collection-card-derivation.js';
	import CollectionFormField, {
		setCollectionFormFieldContext
	} from './collection-form-field.svelte';
	import CollectionFormSkeleton from './collection-form-skeleton.svelte';
	import {
		CollectionRecordMetadataView,
		collectionRecordRestriction,
		resolveCollectionRecordMetadata
	} from '../collection-record-metadata/index.js';
	import type {
		CollectionFormFieldComponent,
		CollectionFormName,
		CollectionFormProps,
		CollectionFormValidation,
		CollectionFormValidationIssue
	} from './collection-form.types.js';
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

	function validateRegisteredFields(
		fields: readonly CollectionField[],
		registeredFields: ReadonlySet<string>,
		candidate: Readonly<Record<string, unknown>>
	): CollectionFormValidationIssue[] {
		const issues: CollectionFormValidationIssue[] = [];
		for (const fieldName of registeredFields) {
			const field = fields.find((entry) => entry.name === fieldName);
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

	async function applySchemaValidation(
		candidate: Record<string, unknown>,
		validation: CollectionFormValidation | undefined,
		issues: CollectionFormValidationIssue[]
	): Promise<Record<string, unknown>> {
		if (!validation?.schema) return candidate;
		const result = await validation.schema['~standard'].validate(candidate);
		if (result.issues) {
			issues.push(
				...result.issues.map((issue) => ({
					message: issue.message,
					path: standardIssuePath(issue.path)
				}))
			);
			return candidate;
		}
		if (result.value == null || typeof result.value !== 'object' || Array.isArray(result.value)) {
			issues.push({ message: t('form.valuesMustBeObject'), path: [] });
			return candidate;
		}
		return Object.fromEntries(Object.entries(result.value));
	}

	async function applySemanticValidation(
		candidate: Readonly<Record<string, unknown>>,
		validation: CollectionFormValidation | undefined,
		issues: CollectionFormValidationIssue[]
	): Promise<void> {
		if (issues.length > 0 || !validation?.semantic) return;
		try {
			const semanticIssues = await validation.semantic(candidate);
			if (semanticIssues) issues.push(...semanticIssues);
		} catch (cause) {
			issues.push({ message: cause instanceof Error ? cause.message : String(cause), path: [] });
		}
	}

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
	const autoFields = $derived(
		autoFieldNames
			.map((name) => definition.fields.find((field) => field.name === name))
			.filter((field): field is NonNullable<typeof field> => field != null)
	);
	const registeredFields = new Set<string>();
	let historyQuery = $state<RemoteQuery<readonly CollectionRecordHistoryEntry[]>>();
	let deleting = $state(false);
	const runtimeSchema = {
		'~standard': {
			validate: async (data: unknown) => {
				if (data == null || typeof data !== 'object' || Array.isArray(data)) {
					return { issues: [{ message: t('form.formMustBeObject'), path: [] }] };
				}

				let candidate = Object.fromEntries(Object.entries(data));
				const issues = validateRegisteredFields(definition.fields, registeredFields, candidate);
				candidate = await applySchemaValidation(candidate, validation, issues);
				await applySemanticValidation(candidate, validation, issues);

				return issues.length > 0 ? { issues } : { value: candidate };
			}
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
			async (data): Promise<CollectionRow<TCollections[TName]>> => {
				const operations = client.db[collection];
				const values = Object.fromEntries(Object.entries(data));
				if (onSubmit) return onSubmit(values);
				if (recordId) {
					if (!operations.update) throw new Error('This collection cannot be updated.');
					const dirtyValues: Record<string, unknown> = Object.fromEntries(
						definition.fields
							.filter((field) => form.hasChangesForPath(field.name))
							.map((field) => [field.name, values[field.name]])
					);
					return operations.update(
						recordId,
						dirtyValues as CollectionUpdateInput<TCollections[TName]> // stupidity: boundary-cast — dirty rendered fields and validation constrain this dynamic update payload to the selected collection.
					);
				}
				if (!operations.create) throw new Error('This collection cannot be created.');
				return operations.create(
					values as CollectionCreateInput<TCollections[TName]> // stupidity: boundary-cast — rendered fields and validation constrain this dynamic form payload to the selected collection.
				);
			},
		onSuccess: async (record) => {
			if (record && onAfterSubmit) await onAfterSubmit(record);
		}
	});
	const dirtyFieldCount = $derived(
		definition.fields.filter((field) => form.hasChangesForPath(field.name)).length
	);

	function loadHistory(): void {
		if (!recordId || !workspaceClient.history) return;
		if (historyQuery) {
			if (historyQuery.error) void historyQuery.refresh();
			return;
		}
		historyQuery = workspaceClient.history.findMany(String(collection), recordId);
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

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		try {
			await form.submit();
		} catch (cause) {
			console.error(`[CollectionForm:${String(collection)}] submission failed`, cause);
		}
	}

	function clear(): void {
		form.reset();
	}

	async function deleteRecord(): Promise<void> {
		if (!deleteAction || deleting || deleteRestriction || disabled || loading) return;
		deleting = true;
		try {
			await deleteAction.onDelete();
		} finally {
			deleting = false;
		}
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
						<div class={isFullWidthFormField(field.kind) ? 'col-span-full' : ''}>
							<CollectionFormField name={field.name} />
						</div>
					{/each}
				</Grid>
			{/if}
		</div>
	</Scroll>
</Cover>
