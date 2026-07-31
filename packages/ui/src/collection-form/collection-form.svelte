<script
	lang="ts"
	generics="TCollections extends CollectionRegistry, TName extends CollectionFormName<TCollections>"
>
	import type {
		CollectionCreateInput,
		CollectionField,
		CollectionRecordHistoryEntry,
		CollectionRegistry,
		CollectionRow,
		CollectionUpdateInput,
		RemoteQuery
	} from '@norbital-ai/platform-utils/collection';
	import { Button } from '#lib/button';
	import { FormState, type FormSchema } from '#lib/form';
	import { Cluster, Cover, Grid, Scroll, Stack } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { onDestroy } from 'svelte';
	import {
		deriveFormFieldNames,
		isFullWidthFormField,
		pickFieldNames
	} from '../collection-table/collection-card-derivation.js';
	import CollectionFormField, {
		setCollectionFormFieldContext
	} from './collection-form-field.svelte';
	import CollectionFormSkeleton from './collection-form-skeleton.svelte';
	import type {
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
			return [{ message: 'This field is required.', path: [fieldName] }];
		}
		if (value == null) return [];
		if (field.array && !Array.isArray(value)) {
			return [{ message: 'Enter a list of values.', path: [fieldName] }];
		}

		const issues: CollectionFormValidationIssue[] = [];
		if (field.values) {
			const selected = Array.isArray(value) ? value : [value];
			if (selected.some((entry) => typeof entry !== 'string' || !field.values?.includes(entry))) {
				issues.push({ message: 'Select a valid option.', path: [fieldName] });
			}
		}
		if (
			['integer', 'number', 'numeric'].includes(field.kind) &&
			(typeof value !== 'number' || !Number.isFinite(value))
		) {
			issues.push({ message: 'Enter a valid number.', path: [fieldName] });
		}
		if (field.kind === 'boolean' && typeof value !== 'boolean') {
			issues.push({ message: 'Choose a valid boolean value.', path: [fieldName] });
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
			issues.push({ message: 'Validated form values must be an object.', path: [] });
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
		recordId,
		submitLabel,
		validation,
		onSubmit,
		deleteAction,
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

	// svelte-ignore state_referenced_locally
	const initialValues: Record<string, unknown> = { ...defaultValues };
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
					return { issues: [{ message: 'Form values must be an object.', path: [] }] };
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
		disabled: () => loading || disabled,
		submitSuccessBehavior: 'commit',
		successMessage: null,
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
		if (!deleteAction || deleting) return;
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
	<Stack as="footer" gap="sm" class="border-t" aria-label="Form actions">
		{#if form.errorMessage}
			<p class="text-sm text-destructive" role="alert">{form.errorMessage}</p>
		{/if}
		{#each form.errors.formErrors as message, index (`${index}:${message}`)}
			<p class="text-sm text-destructive" role="alert">{message}</p>
		{/each}
		{#if Object.keys(form.errors.fieldErrors).length > 0}
			<p class="text-sm text-destructive" role="alert">
				Fix the highlighted fields before saving.
			</p>
		{/if}
		<Cluster gap="xs" align="center">
			<Button
				type="submit"
				disabled={loading ||
					form.disabled ||
					form.isSubmitting ||
					Boolean(recordId && !form.isDirty)}
			>
				{form.isSubmitting ? 'Saving…' : (submitLabel ?? (recordId ? 'Save changes' : 'Create'))}
			</Button>
			<Button
				type="button"
				variant="outline"
				disabled={loading || form.disabled || form.isSubmitting || !form.isDirty}
				onclick={clear}>Clear</Button
			>
			{#if form.isDirty}
				<span class="text-xs text-muted-foreground" role="status">
					{dirtyFieldCount} unsaved {dirtyFieldCount === 1 ? 'field' : 'fields'}
				</span>
			{/if}
			{#if deleteAction}
				<Button
					type="button"
					variant="destructive"
					class="sm:ml-auto"
					disabled={loading ||
						form.disabled ||
						form.isSubmitting ||
						deleting ||
						deleteAction.disabled}
					onclick={() => void deleteRecord()}
				>
					{deleting ? 'Deleting…' : (deleteAction.label ?? 'Delete')}
				</Button>
			{/if}
		</Cluster>
	</Stack>
{/snippet}

<Cover
	as="form"
	gap="md"
	class={cn('max-h-full min-w-0 overflow-clip', className)}
	aria-busy={loading || form.isSubmitting}
	onsubmit={submit}
	bottom={formFooter}
>
	<Scroll name={`${String(collection)} form fields`}>
		<div class="min-w-0 pb-4">
			{#if loading}
				<Stack gap="md" aria-label="Loading form">
					<CollectionFormSkeleton rows={skeletonRows} />
				</Stack>
			{:else if children}
				{@render children({
					Field: CollectionFormField,
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
