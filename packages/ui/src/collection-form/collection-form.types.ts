import type {
	CollectionDbClient,
	CollectionCreateInput,
	CollectionField,
	CollectionFieldName,
	CollectionRelationOptions,
	CollectionRegistry,
	CollectionRow,
	CollectionUpdateInput
} from '@norbital-ai/std/collection';
import type { Schema } from 'effect';
import type { StandardSchemaOf } from '../form/standard_schema_form_errors.js';
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

export interface CollectionFormValidationIssue {
	readonly message: string;
	readonly path?: readonly (string | number)[];
}

export interface CollectionFormValidation {
	/** Effect schema validation, read through the schema's `~standard` adapter. */
	readonly schema?: StandardSchemaOf<Schema.Codec<unknown, unknown>>;
	/** Cross-field or domain validation that may perform asynchronous checks. */
	readonly semantic?: (
		values: CollectionFormValidationValues
	) =>
		| readonly CollectionFormValidationIssue[]
		| void
		| Promise<readonly CollectionFormValidationIssue[] | void>;
}

/** Props CollectionFormField always injects; callers supply the rest via `rendererProps`. */
export type CollectionFormInjectedRendererKey = 'value' | 'field' | 'row' | 'onValueChange';

/** Re-map so interface prop bags satisfy Svelte's `Component` props bound without writing `any`. */
type CollectionFormSvelteProps<T> = {
	[K in keyof T]: T[K];
};

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

export interface CollectionFormFieldProps<
	TFieldName extends string = string,
	TRendererProps = CollectionFormRendererProps
> {
	name: TFieldName;
	label?: string;
	class?: string;
	renderer?: Component<CollectionFormSvelteProps<TRendererProps>>;
	rendererProps?: CollectionFormCallerRendererProps<TRendererProps>;
}

/**
 * `Field` as handed to form composition snippets. Isomorphic (construct + call) so svelte-check
 * accepts it as a component; the generic lets each usage instantiate `TRendererProps` from
 * `renderer={...}` so `rendererProps` stays typed.
 */
export interface CollectionFormFieldComponent<TFieldName extends string = string> {
	new <TRendererProps = CollectionFormRendererProps>(
		options: ComponentConstructorOptions<CollectionFormFieldProps<TFieldName, TRendererProps>>
	): SvelteComponent<CollectionFormFieldProps<TFieldName, TRendererProps>>;
	<TRendererProps = CollectionFormRendererProps>(
		this: void,
		internals: ComponentInternals,
		props: CollectionFormFieldProps<TFieldName, TRendererProps>
	): {
		$on?(type: string, callback: (e: unknown) => void): () => void;
		$set?(props: Partial<CollectionFormFieldProps<TFieldName, TRendererProps>>): void;
	};
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
	readonly onDelete: () => void | Promise<void>;
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
	 * re-legalises reaching into `norbital_*` from authored source.
	 */
	defaultValues?:
		| Partial<CollectionRow<TCollections[TName]>>
		| Partial<CollectionCreateInput<TCollections[TName]>>
		| Partial<CollectionUpdateInput<TCollections[TName]>>;
	submitLabel?: string;
	validation?: CollectionFormValidation;
	onSubmit?: (
		values: CollectionFormValidationValues
	) => CollectionRow<TCollections[TName]> | Promise<CollectionRow<TCollections[TName]>>;
	deleteAction?: CollectionFormDeleteAction;
	disabled?: boolean;
	loading?: boolean;
	skeletonRows?: number;
	class?: string;
	onAfterSubmit?: (record: CollectionRow<TCollections[TName]>) => void | Promise<void>;
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
