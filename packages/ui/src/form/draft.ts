// A form's draft as data (§5.10 behaviour, rule 67): what the form is, what it sends, and how an outcome settles it.
// Pure, so the Svelte state around it stays a thin shell and every rule here has a test.
import type { AutomationExposure, ModelExposure } from '../kinds/context.js';
import type { ChildInput } from '../kinds/context.js';
import { initial, problems, type Fields, type Value, type Kind } from '../kinds/kind.js';
import { encodeWire } from '@norbital-ai/std/wire';
import type { Where } from '@norbital-ai/std/kind';
import { Equal } from 'effect';

/** A row's values by field name. */
export type Row = { readonly [field: string]: Value };
/** A write outcome as a form settles it: committed, pending approval, refused, conflict, unknown or still running. */
export type Outcome =
	| {
			kind: 'committed';
			output: Value;
			records: readonly { model: string; id: string; revision: number }[];
	  }
	| {
			kind: 'pendingApproval';
			requestId: string;
			records: readonly { model: string; id: string; revision: number }[];
	  }
	| { kind: 'refused'; code: string; message: string; field?: string; row?: number }
	| {
			kind: 'conflict';
			records: readonly { model: string; id: string; fields: readonly string[] }[];
	  }
	| { kind: 'unknown'; invocation: string }
	| { kind: 'running'; run: string };

/** What a `Form` edits: a model's create or update allowlist, or an automation's input. */
type FormTarget =
	| { of: 'model'; model: string; mode: 'create' | 'update'; id?: string }
	| { of: 'automation'; automation: string };
export type FormSpec = {
	target: FormTarget;
	/** Editable fields in order, each with its kind (a relation FK carries its targets). */
	fields: readonly {
		name: string;
		kind: Kind;
		readonly?: true;
		reason?: 'syncOwned' | 'ownedParent';
		relation?: { targets: readonly string[]; where?: Where | undefined };
	}[];
	callable: string;
	/** An update the caller may read but not make: every field shown locked, no submit. */
	readonly?: true;
	proposalOnly?: true;
	children?: Readonly<Record<string, ChildInput>>;
};

/** The form one `of` describes, from the model's exposure; `null` when the caller has no such verb. An update the
 * caller cannot make but can read is the read-only form of the readable fields. */
export function formSpec(
	of: string | { automation: string },
	exposure: ModelExposure | undefined,
	mode: 'create' | 'update',
	id?: string,
	automation?: AutomationExposure
): FormSpec | null {
	if (typeof of !== 'string') {
		if (automation === undefined) return null;
		return {
			target: { of: 'automation', automation: of.automation },
			fields: Object.entries(automation.input).map(([name, kind]) => ({ name, kind })),
			callable: of.automation
		};
	}
	if (exposure === undefined) return null;
	const readOnly = exposure[mode] === undefined && mode === 'update';
	const allow = readOnly
		? { columns: [...Object.keys(exposure.fields), ...Object.keys(exposure.relations ?? {})] }
		: exposure[mode];
	if (allow === undefined) return null;
	const children = exposure[mode]?.with;
	return {
		...(readOnly ? { readonly: true as const } : {}),
		target: { of: 'model', model: of, mode, ...(id === undefined ? {} : { id }) },
		fields: [
			...allow.columns,
			...(mode === 'update'
				? [...Object.keys(exposure.fields), ...Object.keys(exposure.relations ?? {})].filter(
						(name) => !allow.columns.includes(name)
					)
				: [])
		].flatMap<FormSpec['fields'][number]>((name) => {
			const reason = mode === 'update' ? exposure.readonlyFields?.[name] : undefined;
			const readonly =
				mode === 'update' && (readOnly || !allow.columns.includes(name) || reason !== undefined)
					? { readonly: true as const, ...(reason === undefined ? {} : { reason }) }
					: {};
			const filled = mode === 'create' && exposure.create?.filled?.includes(name) === true;
			const relation = exposure.relations?.[name];
			if (relation !== undefined)
				return [
					{
						name,
						...readonly,
						kind: {
							kind: 'id',
							of: relation.targets[0] ?? '',
							...(relation.optional || filled ? { optional: true as const } : {}),
							...(relation.label === undefined ? {} : { label: relation.label }),
							...(relation.where === undefined ? {} : { where: relation.where })
						} satisfies Kind,
						relation
					}
				];
			const kind = exposure.fields[name];
			return kind === undefined
				? []
				: [{ name, ...readonly, kind: filled ? { ...kind, optional: true as const } : kind }];
		}),
		callable: `${of}.${mode}`,
		...(children === undefined ? {} : { children }),
		...(mode === 'create' && exposure.create?.proposalOnly === true
			? { proposalOnly: true as const }
			: {})
	};
}

/** A draft's starting values: the stored row (decoded) in update mode, else each field's default over `prefill`. */
export function startValues(
	spec: FormSpec,
	record: Row | null,
	prefill: Row = {}
): Record<string, Value> {
	if (record !== null)
		return Object.fromEntries(
			spec.fields.filter((f) => !f.readonly).map((f) => [f.name, record[f.name] ?? null])
		);
	return Object.fromEntries(
		spec.fields
			.filter((f) => !f.readonly)
			.map((f) => [
				f.name,
				prefill[f.name] === undefined ? initial(f.kind) : (prefill[f.name] ?? null)
			])
	);
}

const same = (a: Value | undefined, b: Value | undefined) =>
	// Equal caches object comparisons; wire snapshots keep mutable drafts and exact decimals current.
	Equal.equals(encodeWire(a ?? null), encodeWire(b ?? null));
/** Only changed fields are sent (§5.10): a field no one touched never overwrites a concurrent change. */
export const changed = (base: Row, draft: Row): Record<string, Value> =>
	Object.fromEntries(Object.entries(draft).filter(([k, v]) => !same(base[k], v)));

/** The act's input for the draft; `null` when an update has nothing to send. */
export function payload(spec: FormSpec, base: Row, draft: Row): Value | null {
	const t = spec.target;
	// an absent optional input and a null are the same to decode; absent lets a default apply
	const present = (row: Row) =>
		Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null));
	if (t.of === 'model') {
		if (t.mode === 'create') return present(draft);
		const set = Object.fromEntries(
			Object.entries(changed(base, draft)).filter(([name]) =>
				spec.fields.some((f) => f.name === name && !f.readonly)
			)
		);
		return Object.keys(set).length === 0 ? null : { target: t.id ?? null, set };
	}
	return present(draft);
}

/** Advisory problems before sending, keyed by dotted path: the host decides, this only saves a refused round trip. */
export function check(spec: FormSpec, draft: Row): Map<string, string> {
	const out = new Map<string, string>();
	// a hidden field has no editor: the host fills or refuses it, never a problem the viewer cannot see or fix
	for (const f of spec.fields)
		if (!f.kind.hidden && !f.readonly)
			for (const [path, message] of problems(f.kind, draft[f.name], f.name)) out.set(path, message);
	return out;
}

/** Where a refusal belongs: the field it names (a decode path `lines.0.amount` keeps its path), else the form. */
function refusalPlace(
	spec: FormSpec,
	outcome: Extract<Outcome, { kind: 'refused' }>
): string | null {
	const f = outcome.field;
	if (f === undefined) return null;
	const head = f.split('.')[0] ?? '';
	return spec.fields.some((x) => x.name === head) ? f : null;
}

type Settled = {
	/** The draft after the outcome: fresh after a create or automation start settles, `null` to keep the current draft (edits made
	 * while the act was in flight included). */
	draft: Record<string, Value> | null;
	/** What "changed" is measured against next: the sent values once an update settles. */
	base: Record<string, Value>;
	errors: Map<string, string>;
	/** Form-level text: a refusal no field owns, a conflict, an unknown outcome, a held write, or the `run` still writing. */
	notice: Notice | null;
	/** Whether the next submit mints a new idempotency key: `unknown` and `running` retry the same invocation (rule 31). */
	newKey: boolean;
};
export type Notice = { tone: 'info' | 'danger' | 'warning'; text: string; run?: string };
export type NoticeText = {
	pendingApproval: string;
	conflict: string;
	unknown: string;
	running: string;
};

/** Settles a draft by the outcome of sending `sent` over `base`. */
export function settle(
	spec: FormSpec,
	base: Row,
	sent: Row,
	outcome: Outcome,
	text: NoticeText
): Settled {
	const reset = spec.target.of === 'automation' || spec.target.mode === 'create';
	const fresh = startValues(spec, null);
	const done = (notice: Settled['notice']): Settled =>
		reset
			? { draft: fresh, base: fresh, errors: new Map(), notice, newKey: true }
			: { draft: null, base: { ...base, ...sent }, errors: new Map(), notice, newKey: true };
	switch (outcome.kind) {
		case 'committed':
			return done(null);
		case 'pendingApproval':
			return reset
				? done({ tone: 'info', text: text.pendingApproval })
				: {
						draft: { ...base },
						base: { ...base },
						errors: new Map(),
						notice: { tone: 'info', text: text.pendingApproval },
						newKey: true
					};
		case 'refused': {
			const place = refusalPlace(spec, outcome);
			return {
				draft: null,
				base: { ...base },
				errors: place === null ? new Map() : new Map([[place, outcome.message]]),
				notice: place === null ? { tone: 'danger', text: outcome.message } : null,
				newKey: true
			};
		}
		case 'conflict': {
			const fields = outcome.records.flatMap((r) => r.fields);
			return {
				draft: null,
				base: { ...base },
				errors: new Map(fields.filter((f) => f in sent).map((f) => [f, text.conflict])),
				notice: { tone: 'warning', text: text.conflict },
				newKey: true
			};
		}
		case 'unknown':
			return {
				draft: null,
				base: { ...base },
				errors: new Map(),
				notice: { tone: 'warning', text: text.unknown },
				newKey: false
			};
		// the write goes on as a run: the draft stays, and the notice follows the run to its end
		case 'running':
			return {
				draft: null,
				base: { ...base },
				errors: new Map(),
				notice: { tone: 'info', text: text.running, run: outcome.run },
				newKey: false
			};
	}
}

/** The fields a state lock leaves editable (advice from the model's `state.edit`; the host enforces it, rule 40). */
export function locked(fields: Fields, record: Row | null): (field: string) => boolean {
	if (record === null) return () => false;
	const state = Object.entries(fields).find(([, k]) => k.kind === 'state');
	if (state === undefined) return () => false;
	const [name, kind] = state;
	if (kind.kind !== 'state') return () => false;
	const at = kind.states[String(record[name] ?? null)];
	const e = at?.edit ?? 'all';
	// the state field itself moves along `to` whatever `edit` says (the host's rule 40 check exempts it); a final state has
	// no move left, so it is read-only
	return (field) =>
		field === name
			? (at?.to ?? []).length === 0
			: e === 'none' || (e !== 'all' && !e.includes(field));
}
