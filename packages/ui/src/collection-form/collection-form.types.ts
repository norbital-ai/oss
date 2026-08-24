import type {
	CollectionDbClient,
	CollectionField,
	CollectionFieldName,
	CollectionMutationInput,
	CollectionRelationOptions,
	CollectionRegistry,
	CollectionRow
} from '@norbital-ai/std/collection';
import { Effect, Schema } from 'effect';
import type { StandardSchemaOf } from '#lib/form/standard_schema_form_errors';
import type { CollectionRecordMetadata } from '#lib/collection-record-metadata';
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

const collectionFormInjectedRendererKeySchema = Schema.Literals([
	'value',
	'field',
	'row',
	'onValueChange'
]);
/** Props CollectionFormField always injects; callers supply the rest via `rendererProps`. */
export type CollectionFormInjectedRendererKey = typeof collectionFormInjectedRendererKeySchema.Type;

export type CollectionFormCallerRendererProps<TRendererProps> = Omit<
	TRendererProps,
	CollectionFormInjectedRendererKey
>;

export interface CollectionFormRendererOptions {
	readonly?: boolean;
	disabled?: boolean;
	placeholder?: string;
	relationOptions?: CollectionRelationOptions;
}

export interface CollectionFormRendererProps extends CollectionFormRendererOptions {
	value: unknown;
	field: CollectionField;
	/** Current form record, including unsaved sibling-field values. */
	row: Record<string, unknown>;
	onValueChange: (value: unknown) => void;
}

type RendererProps<TRenderer> =
	TRenderer extends Component<infer TProps>
		? TProps extends never
			? CollectionFormRendererProps
			: TProps
		: CollectionFormRendererProps;

export interface CollectionFormFieldProps<
	TFieldName extends string = string,
	TRenderer extends Component<never> = Component<CollectionFormRendererProps>
> {
	name: TFieldName;
	label?: string;
	class?: string;
	renderer?: TRenderer;
	rendererProps?: CollectionFormCallerRendererProps<RendererProps<TRenderer>>;
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
	Field: CollectionFormFieldComponent<CollectionFieldName<TCollections[TName]>>;
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
	defaultValues?:
		| Partial<CollectionRow<TCollections[TName]>>
		| Partial<CollectionMutationInput<TCollections[TName]>>;
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
	/**
	 * Ordered field-name pick for the auto-emitted form (RFC V.4b). Wins over auto field emission;
	 * ignored when a `children` composition is provided.
	 */
	fields?: readonly CollectionFieldName<TCollections[TName]>[];
	/**
	 * Field composition. Omit to auto-emit a `Field` per writable field in declaration order and
	 * laid out with the intrinsic `Grid` (RFC V.4a).
	 */
	children?: Snippet<[CollectionFormComposition<TCollections, TName>]>;
}
