// A form's draft as data (§5.10 behaviour, rule 67): what the form is, what it sends, and how an outcome settles it.
// Pure, so the Svelte state around it stays a thin shell and every rule here has a test.
import type { CollectionExposure } from '../kinds/context.js';
import { initial, problems, untag, type Fields, type Json, type Kind } from '../kinds/kind.js';

/** A row's values by field name. */
export type Row = { readonly [field: string]: Json };
/** A write outcome as a form settles it: committed, pending approval, refused, conflict or unknown. */
export type Outcome =
	| { kind: 'committed'; output: Json; records: readonly { collection: string; id: string; revision: number }[] }
	| { kind: 'pendingApproval'; requestId: string; records: readonly { collection: string; id: string; revision: number }[] }
	| { kind: 'refused'; code: string; message: string; field?: string; row?: number }
	| { kind: 'conflict'; records: readonly { collection: string; id: string; fields: readonly string[] }[] }
	| { kind: 'unknown'; invocation: string };

/** What a `Form` edits: a collection's create or update allowlist, or an action's `input` literal. */
export type FormTarget =
	| { of: 'collection'; collection: string; mode: 'create' | 'update'; id?: string }
	| { of: 'action'; collection: string; action: string; record: boolean; id?: string };
export type FormSpec = {
	target: FormTarget;
	/** Editable fields in order, each with its kind (a relation FK carries its targets). */
	fields: readonly { name: string; kind: Kind; relation?: { targets: readonly string[] } }[];
	callable: string;
	/** An update the caller may read but not make: every field shown locked, no submit. */
	readonly?: true;
};

/** The form one `of` describes, from the collection's exposure; `null` when the caller has no such verb. An update the
 * caller cannot make but can read is the read-only form of the readable fields. */
export function formSpec(of: string | { action: string }, exposure: CollectionExposure | undefined, mode: 'create' | 'update', id?: string): FormSpec | null {
	if (exposure === undefined) return null;
	if (typeof of !== 'string') {
		const dot = of.action.lastIndexOf('.');
		const collection = of.action.slice(0, dot), action = of.action.slice(dot + 1);
		const spec = exposure.actions?.[action];
		if (spec === undefined) return null;
		return {
			target: { of: 'action', collection, action, record: spec.target === 'record', ...(id === undefined ? {} : { id }) },
			fields: Object.entries(spec.input).map(([name, kind]) => ({ name, kind })),
			callable: of.action
		};
	}
	const readOnly = exposure[mode] === undefined && mode === 'update';
	const allow = readOnly ? { columns: [...Object.keys(exposure.fields), ...Object.keys(exposure.relations ?? {})] } : exposure[mode];
	if (allow === undefined) return null;
	return {
		...(readOnly ? { readonly: true as const } : {}),
		target: { of: 'collection', collection: of, mode, ...(id === undefined ? {} : { id }) },
		fields: allow.columns.flatMap((name) => {
			const relation = exposure.relations?.[name];
			if (relation !== undefined) return [{ name, kind: { kind: 'id', of: relation.targets[0]!, ...(relation.optional ? { optional: true as const } : {}), ...(relation.label === undefined ? {} : { label: relation.label }) } as Kind, relation }];
			const kind = exposure.fields[name];
			return kind === undefined ? [] : [{ name, kind }];
		}),
		callable: `${of}.${mode}`
	};
}

/** A draft's starting values: the stored row (untagged) in update mode, else each field's default over `prefill`. */
export function startValues(spec: FormSpec, record: Row | null, prefill: Row = {}): Record<string, Json> {
	if (record !== null) return Object.fromEntries(spec.fields.map((f) => [f.name, untag(record[f.name])]));
	return Object.fromEntries(spec.fields.map((f) => [f.name, prefill[f.name] === undefined ? initial(f.kind) : untag(prefill[f.name])]));
}

const same = (a: Json | undefined, b: Json | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** Only changed fields are sent (§5.10): a field no one touched never overwrites a concurrent change. */
export const changed = (base: Row, draft: Row): Record<string, Json> =>
	Object.fromEntries(Object.entries(draft).filter(([k, v]) => !same(base[k], v)));

/** The act's input for the draft; `null` when an update has nothing to send. */
export function payload(spec: FormSpec, base: Row, draft: Row): Json | null {
	const t = spec.target;
	// an absent optional input and a null are the same to decode; absent lets a default apply
	const present = (row: Row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null));
	if (t.of === 'collection') {
		if (t.mode === 'create') return present(draft);
		const set = changed(base, draft);
		return Object.keys(set).length === 0 ? null : { target: t.id ?? null, set };
	}
	const input = present(draft);
	return t.record ? { target: t.id ?? null, input } : input;
}

/** Advisory problems before sending, keyed by dotted path: the host decides, this only saves a refused round trip. */
export function check(spec: FormSpec, draft: Row): Map<string, string> {
	const out = new Map<string, string>();
	// a hidden field has no editor: the host fills or refuses it, never a problem the viewer cannot see or fix
	for (const f of spec.fields) if (!f.kind.hidden) for (const [path, message] of problems(f.kind, draft[f.name], f.name)) out.set(path, message);
	return out;
}

/** Where a refusal belongs: the field it names (a decode path `lines.0.amount` keeps its path), else the form. */
export function refusalPlace(spec: FormSpec, outcome: Extract<Outcome, { kind: 'refused' }>): string | null {
	const f = outcome.field;
	if (f === undefined) return null;
	const head = f.split('.')[0]!;
	return spec.fields.some((x) => x.name === head) ? f : null;
}

export type Settled = {
	/** The draft after the outcome: fresh after a create or action settles, `null` to keep the current draft (edits made
	 * while the act was in flight included). */
	draft: Record<string, Json> | null;
	/** What "changed" is measured against next: the sent values once an update settles. */
	base: Record<string, Json>;
	errors: Map<string, string>;
	/** Form-level text: a refusal no field owns, a conflict, an unknown outcome, a held write. */
	notice: { tone: 'info' | 'danger' | 'warning'; text: string } | null;
	/** Whether the next submit mints a new idempotency key: only `unknown` retries the same invocation (rule 31). */
	newKey: boolean;
};
export type NoticeText = { pendingApproval: string; conflict: string; unknown: string };

/** Settles a draft by the outcome of sending `sent` over `base`. */
export function settle(spec: FormSpec, base: Row, sent: Row, outcome: Outcome, text: NoticeText): Settled {
	const reset = spec.target.of === 'action' || spec.target.mode === 'create';
	const fresh = startValues(spec, null);
	const done = (notice: Settled['notice']): Settled =>
		reset ? { draft: fresh, base: fresh, errors: new Map(), notice, newKey: true } : { draft: null, base: { ...base, ...sent }, errors: new Map(), notice, newKey: true };
	switch (outcome.kind) {
		case 'committed': return done(null);
		case 'pendingApproval': return done({ tone: 'info', text: text.pendingApproval });
		case 'refused': {
			const place = refusalPlace(spec, outcome);
			return { draft: null, base: { ...base }, errors: place === null ? new Map() : new Map([[place, outcome.message]]),
				notice: place === null ? { tone: 'danger', text: outcome.message } : null, newKey: true };
		}
		case 'conflict': {
			const fields = outcome.records.flatMap((r) => r.fields);
			return { draft: null, base: { ...base }, errors: new Map(fields.filter((f) => f in sent).map((f) => [f, text.conflict])),
				notice: { tone: 'warning', text: text.conflict }, newKey: true };
		}
		case 'unknown': return { draft: null, base: { ...base }, errors: new Map(), notice: { tone: 'warning', text: text.unknown }, newKey: false };
	}
}

/** The fields a state lock leaves editable (advice from the model's `state.edit`; the host enforces it, rule 40). */
export function locked(fields: Fields, record: Row | null): (field: string) => boolean {
	if (record === null) return () => false;
	const state = Object.entries(fields).find(([, k]) => k.kind === 'state');
	if (state === undefined) return () => false;
	const [name, kind] = state as [string, Extract<Kind, { kind: 'state' }>];
	const e = kind.states[String(untag(record[name]))]?.edit ?? 'all';
	// the state field itself moves along `to` whatever `edit` says, as the host's rule 40 check exempts it
	return (field) => field !== name && (e === 'none' || (e !== 'all' && !e.includes(field)));
}
