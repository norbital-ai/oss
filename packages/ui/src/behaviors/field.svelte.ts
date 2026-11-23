// Composable form field accessibility wiring: links label, input, description and error via
// deterministic ids (`for`, `aria-describedby`, `aria-invalid`, `aria-required`, `data-invalid`).

let nextFieldId = 0;

/** Options for `create_field`. */
export type FieldBehaviorOptions = {
	/** Optional stable id prefix; auto-generated when omitted. */
	id?: string;
	/** Whether a helper description element is rendered. */
	has_description?: () => boolean;
	/** Current validation error message (non-empty marks the control invalid). */
	error?: () => string | undefined | null;
	/** Whether the field is required. */
	required?: () => boolean;
	/** Whether the field is disabled. */
	disabled?: () => boolean;
	/** Whether the field is read-only. */
	readonly?: () => boolean;
};

/** Return value of `create_field`. */
export type FieldBehavior = ReturnType<typeof create_field>;

/**
 * Headless field ARIA wiring (`label_attrs`, `control_attrs`, `description_attrs`, `error_attrs`).
 */
export function create_field(options: FieldBehaviorOptions = {}) {
	const id = options.id ?? `nb-field-${++nextFieldId}`;
	const descriptionId = `${id}-desc`;
	const errorId = `${id}-err`;

	const error = $derived(options.error?.() ?? undefined);
	const invalid = $derived(error !== undefined && error !== '');
	const required = $derived(options.required?.() ?? false);
	const disabled = $derived(options.disabled?.() ?? false);
	const readonly = $derived(options.readonly?.() ?? false);

	const describedBy = $derived.by(() => {
		const ids: string[] = [];
		if (options.has_description?.()) ids.push(descriptionId);
		if (invalid) ids.push(errorId);
		return ids.length > 0 ? ids.join(' ') : undefined;
	});

	return {
		get id() {
			return id;
		},
		get invalid() {
			return invalid;
		},
		get error() {
			return error;
		},
		label_attrs() {
			return {
				for: id,
				'data-required': required ? '' : undefined,
				'data-invalid': invalid ? '' : undefined,
				'data-disabled': disabled ? '' : undefined
			};
		},
		control_attrs() {
			return {
				id,
				'aria-describedby': describedBy,
				'aria-invalid': invalid ? (true as const) : undefined,
				'aria-required': required ? (true as const) : undefined,
				disabled: disabled || undefined,
				readonly: readonly || undefined
			};
		},
		description_attrs() {
			return { id: descriptionId };
		},
		error_attrs() {
			return { id: errorId, role: 'alert' as const };
		}
	};
}
