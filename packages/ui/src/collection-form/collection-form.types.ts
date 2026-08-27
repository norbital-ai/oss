import type {
	CollectionDbClient,
	CollectionField,
	CollectionFieldName,
	CollectionRelationOptions,
	CollectionRegistry,
	CollectionRow,
	SystemCollectionFieldName
} from '@norbital-ai/std/collection';
import { Effect, Schema } from 'effect';
import type { StandardSchemaOf } from '#lib/form/standard_schema_form_errors';
import type { CollectionRecordMetadata } from '#lib/collection-record-metadata';
import type {
	FieldRendererCallerProps,
	FieldRendererProps,
	FieldRendererPropsOf
} from '#lib/data-renderer';
import type {
	Component,
	ComponentConstructorOptions,
	ComponentInternals,
	Snippet,
	SvelteComponent
} from 'svelte';

export type CollectionFormName<TCollections extends CollectionRegistry> = Extract<
	keyof TCollections,
	string
>;

export type CollectionFormValidationValues = Readonly<Record<string, unknown>>;

const collectionFormValidationIssueSchema = Schema.Struct({
	message: Schema.String,
	path: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, Schema.Number])))
});
export type CollectionFormValidationIssue = typeof collectionFormValidationIssueSchema.Type;

export interface CollectionFormValidation {
	/** Effect schema validation, read through the schema's `~standard` adapter. */
	readonly schema?: StandardSchemaOf<Schema.Codec<unknown, unknown>>;
	/** Cross-field or domain validation that may perform asynchronous checks. */
	readonly semantic?: (
		values: CollectionFormValidationValues
	) => Effect.Effect<readonly CollectionFormValidationIssue[] | void, unknown>;
}

export interface CollectionFormRendererProps extends FieldRendererProps {
	value: unknown;
	field: CollectionField;
	/** Current form record, including unsaved sibling-field values. */
	row: Record<string, unknown>;
	onValueChange: (value: unknown) => void;
}

export interface CollectionFormFieldProps<
	TFieldName extends string = string,
	TRenderer extends Component<never> = Component<CollectionFormRendererProps>
> {
	name: TFieldName;
	label?: string;
	class?: string;
	/** Registered without a visual control; custom composition or a collection hook owns the value. */
	hidden?: boolean;
	readonly?: boolean;
	disabled?: boolean;
	placeholder?: string;
	/** Contextual option-set configuration for the automatic relationship renderer. */
	relationOptions?: CollectionRelationOptions;
	renderer?: TRenderer;
	rendererProps?: FieldRendererCallerProps<
		FieldRendererPropsOf<TRenderer, CollectionFormRendererProps>
	>;
}

/**
 * `Field` as handed to form composition snippets. Callable shape, so svelte-check accepts it as a
 * component; the generic lets each usage instantiate `TRendererProps` from `renderer={...}` so
 * `rendererProps` stays typed.
 */
export interface CollectionFormFieldComponent<TFieldName extends string = string> {
	new <TRenderer extends Component<never> = Component<CollectionFormRendererProps>>(
		options: ComponentConstructorOptions<CollectionFormFieldProps<TFieldName, TRenderer>> // repository-health:allow LEGACY2 -- Svelte 5.56's checker lowers component calls through a constructor shape; this type-only arm preserves renderer inference while the call signature below remains the runtime API.
	): SvelteComponent<CollectionFormFieldProps<TFieldName, TRenderer>>;
	<TRenderer extends Component<never> = Component<CollectionFormRendererProps>>(
		this: void,
		internals: ComponentInternals,
		props: CollectionFormFieldProps<TFieldName, TRenderer>
	): ReturnType<Component<CollectionFormFieldProps<TFieldName, TRenderer>>>;
	element?: typeof HTMLElement;
	z_$$bindings?: string;
}

export interface CollectionFormController {
	readonly values: () => CollectionFormValidationValues;
	readonly setValues: (values: CollectionFormValidationValues) => void;
}

export interface CollectionFormDeleteAction {
	readonly label?: string;
	readonly disabled?: boolean;
	readonly onDelete: () => void | Effect.Effect<void, unknown>;
}

export interface CollectionFormComposition<
	TCollections extends CollectionRegistry,
	TName extends CollectionFormName<TCollections>
> {
	Field: CollectionFormFieldComponent<
		Exclude<CollectionFieldName<TCollections[TName]>, SystemCollectionFieldName>
	>;
	form: CollectionFormController;
}

export interface CollectionFormProps<
	TCollections extends CollectionRegistry,
	TName extends CollectionFormName<TCollections>
> {
	client: CollectionDbClient<TCollections>;
	collection: TName;
	/**
	 * The row being edited, or a partial seed for a new one.
	 *
	 * This alone decides create vs. update: a value carrying the framework's row key is an existing
	 * record, anything else is a draft. There is deliberately no `recordId` prop — it was always the
	 * same id the caller had just dug out of this record, and every authored `+representation.svelte`
	 * threaded it back by hand. An optional override would be an escape hatch that silently
	 * re-legalises reaching into framework-owned fields from authored source.
	 */
	defaultValues?: Partial<CollectionRow<TCollections[TName]>>;
	submitLabel?: string;
	validation?: CollectionFormValidation;
	onSubmit?: (values: CollectionFormValidationValues) => Effect.Effect<void, unknown>;
	deleteAction?: CollectionFormDeleteAction;
	/** Application-authored behaviour and flags for this record. System metadata is injected. */
	recordMetadata?: readonly CollectionRecordMetadata[];
	disabled?: boolean;
	loading?: boolean;
	skeletonRows?: number;
	class?: string;
	onAfterSubmit?: () => void | Effect.Effect<void, unknown>;
	/** Every writable collection field must be declared exactly once; use `hidden` to conceal one. */
	children: Snippet<[CollectionFormComposition<TCollections, TName>]>;
}
