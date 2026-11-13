// Bolt's concept icons (brand): one line glyph per concept the product teaches, on a 24px grid at stroke 2. `base` is
// drawn in the current colour, `accent` in the brand accent (`--product-icon-accent`), so each glyph
// carries exactly one accented stroke and follows the theme through the token.

/** A Bolt concept: the workspace, its building blocks, and the four groups they sit in (`data` … `interface`). */
export type ConceptName = keyof typeof CONCEPT_ICONS;

/** Each concept's SVG children on a 24×24 grid: `base` in `currentColor`, `accent` in the brand accent. */
export const CONCEPT_ICONS = {
	workspace: {
		base: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z"/><path d="M12 12v9"/>',
		accent: '<path d="M4 7.5 12 12l8-4.5"/>'
	},
	models: {
		base: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14.5h18M9 9.5V20"/>',
		accent: '<path d="M3 9.5h18"/>'
	},
	reading: {
		base: '<path d="M4 8h14M14 4l4 4-4 4"/>',
		accent: '<path d="M20 16H6M10 12l-4 4 4 4"/>'
	},
	policies: {
		base: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 10.5-4"/>',
		accent: '<path d="M17.5 11 21 12.4v2.4c0 2.2-1.4 3.6-3.5 4.7-2.1-1.1-3.5-2.5-3.5-4.7v-2.4Z"/>'
	},
	approvals: {
		base: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
		accent: '<path d="m9 14.5 2 2 4-4.5"/>'
	},
	automations: {
		base: '<path d="M20 12a8 8 0 1 1-2.3-5.7L20 8.5"/><path d="M20 4v4.5h-4.5"/>',
		accent: '<path d="M10.5 9.5v5l4-2.5Z"/>'
	},
	effects: {
		base: '<circle cx="6" cy="18" r="2"/><path d="M6 5a13 13 0 0 1 13 13"/>',
		accent: '<path d="M6 11a7 7 0 0 1 7 7"/>'
	},
	apps: {
		base: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
		accent: '<rect x="14" y="14" width="7" height="7" rx="1.5"/>'
	},
	integrations: {
		base: '<rect x="2" y="8" width="5" height="8" rx="1.5"/><rect x="17" y="8" width="5" height="8" rx="1.5"/>',
		accent: '<path d="M7 10.5h9.5M14 8.5l2 2M17 13.5H7.5M10 15.5l-2-2"/>'
	},
	agents: {
		base: '<circle cx="12" cy="12" r="3"/>',
		accent: '<ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(-24 12 12)"/>'
	},
	studio: {
		base: '<path d="m8 6-6 6 6 6M16 6l6 6-6 6"/>',
		accent: '<path d="m9 12.5 2 2 4-4.5"/>'
	},
	data: {
		base: '<path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
		accent: '<ellipse cx="12" cy="5.5" rx="8" ry="3"/>'
	},
	security: {
		base: '<path d="M12 3 19 6v5c0 4.5-2.7 7.6-7 10-4.3-2.4-7-5.5-7-10V6Z"/>',
		accent: '<path d="m9.5 12 1.7 1.7 3.6-3.7"/>'
	},
	logic: {
		base: '<circle cx="6" cy="18" r="2.5"/><path d="M6 3v12.5M18 8.5A9.5 9.5 0 0 1 8.5 18"/>',
		accent: '<circle cx="18" cy="6" r="2.5"/>'
	},
	interface: {
		base: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
		accent: '<path d="M7 13.5h10M7 16.5h6"/>'
	}
} as const satisfies { readonly [name: string]: { readonly base: string; readonly accent: string } };

const is_concept = (name: string): name is ConceptName => Object.hasOwn(CONCEPT_ICONS, name);

/** The concept a `concept:<name>` icon reference names, or `null` for any other reference. */
export const concept_of = (reference: string): ConceptName | null => {
	const name = reference.startsWith('concept:') ? reference.slice('concept:'.length) : '';
	return is_concept(name) ? name : null;
};
