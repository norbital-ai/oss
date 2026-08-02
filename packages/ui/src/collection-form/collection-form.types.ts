import type {
	CollectionDbClient,
	CollectionCreateInput,
	CollectionField,
	CollectionFieldName,
	CollectionQuery,
	CollectionRecord,
	CollectionRelationOptions,
	CollectionRegistry,
	CollectionRow,
	CollectionUpdateInput
} from '@norbital-ai/platform-utils/collection';
import type { StandardSchemaV1 } from '@norbital-ai/std/schema';
import type { Component, Snippet } from 'svelte';

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
	/** Standard Schema validation, including Zod refinements and superRefine rules. */
	readonly schema?: StandardSchemaV1;
	/** Cross-field or domain validation that may perform asynchronous checks. */
	readonly semantic?: (
		values: CollectionFormValidationValues
	) =>
		| readonly CollectionFormValidationIssue[]
		| void
		| Promise<readonly CollectionFormValidationIssue[] | void>;
}

export interface CollectionFormFieldProps<TFieldName extends string = string> {
	name: TFieldName;
	label?: string;
	class?: string;
	renderer?: Component<CollectionFormRendererProps>;
	rendererProps?: CollectionFormRendererOptions;
}

export interface CollectionFormRendererOptions {
	readonly?: boolean;
	disabled?: boolean;
	placeholder?: string;
	relationOptions?: CollectionRelationOptions;
	[key: string]: unknown;
}

export interface CollectionFormRendererProps extends CollectionFormRendererOptions {
	value: unknown;
	field: CollectionField;
	/** Current form record, including unsaved sibling-field values. */
	row: Record<string, unknown>;
	onValueChange: (value: unknown) => void;
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
	Field: Component<CollectionFormFieldProps<CollectionFieldName<TCollections[TName]>>>;
	form: CollectionFormController;
}

export interface CollectionFormProps<
	TCollections extends CollectionRegistry,
	TName extends CollectionFormName<TCollections>
> {
	client: CollectionDbClient<TCollections>;
	collection: TName;
	defaultValues?:
		| Partial<CollectionRow<TCollections[TName]>>
		| Partial<CollectionCreateInput<TCollections[TName]>>
		| Partial<CollectionUpdateInput<TCollections[TName]>>;
	recordId?: string;
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
