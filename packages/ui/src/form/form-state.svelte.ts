// The draft of one mounted `Form`, shared with its `Field`s by context. A field reads and writes the draft; unmounting
// a field (a lazy tab, a collapsed section) never drops its value, because the value lives here (§5.10).
import { getContext, setContext } from 'svelte';
import type { Json } from '../kinds/kind.js';
import type { IdOf } from '../views/bolt.js';
import { changed, check, payload, settle, startValues, type FormSpec, type NoticeText, type Outcome, type Row } from './draft.js';

/** Narrows string ids to a collection's id type (e.g. for `where: { id: { in: … } }`). */
export function idsOf<C extends string>(ids: readonly string[]): readonly IdOf<C>[] {
	return ids as readonly IdOf<C>[];
}

export type Act = (callable: string, input: Json, options?: { key?: string }) => Promise<Outcome>;

/**
 * The draft of one mounted `Form`: values, errors, notice and pending state, shared with its `Field`s; values survive a field unmounting.
 */
export class FormState {
	spec: FormSpec;
	base = $state<Record<string, Json>>({});
	values = $state<Record<string, Json>>({});
	errors = $state<Map<string, string>>(new Map());
	notice = $state<{ tone: 'info' | 'danger' | 'warning'; text: string } | null>(null);
	pending = $state(false);
	/** Fields the row's state lock leaves read-only (advice; the host enforces). */
	locked: (field: string) => boolean;
	readonly dirty = $derived(Object.keys(changed(this.base, this.values)).length > 0);
	/** The draft over the row it starts from (the record, else the prefill): a money field reads its currency sibling here even when that is no input. */
	#around: Row = {};
	readonly row: Row = $derived({ ...this.#around, ...this.values });
	/** The client-minted idempotency key of this draft's act: reused only to retry an `unknown` outcome (rule 31). */
	#key: string;
	#act: Act;
	#text: NoticeText;
	/** Uploads in flight (a file field's bytes going to the host): a submit waits for them. */
	#uploads = new Set<Promise<unknown>>();

	constructor(spec: FormSpec, record: Row | null, prefill: Row, act: Act, text: NoticeText, locked: (field: string) => boolean = () => false) {
		this.spec = spec;
		this.#around = record ?? prefill;
		this.base = startValues(spec, record, prefill);
		this.values = { ...this.base };
		this.#act = act;
		this.#text = text;
		this.locked = locked;
		this.#key = crypto.randomUUID();
	}

	get(name: string): Json {
		return this.values[name] ?? null;
	}
	id<C extends string>(name: string): IdOf<C> | null {
		const v = this.get(name);
		return typeof v === 'string' ? (v as IdOf<C>) : null;
	}
	set(name: string, value: Json): void {
		this.values[name] = value;
		// a field's own problem clears as it is edited; the rest stay until the next submit
		if (this.errors.size > 0) this.errors = new Map([...this.errors].filter(([k]) => k !== name && !k.startsWith(`${name}.`)));
	}
	/** Holds a submit until `work` (an upload writing its ref into the draft) settles. */
	track(work: Promise<unknown>): void {
		const done = () => this.#uploads.delete(work);
		this.#uploads.add(work);
		work.then(done, done);
	}
	/** Sends the draft; the draft stays until the outcome settles it (rule 67). Resolves `null` when nothing was sent. */
	async submit(): Promise<Outcome | null> {
		if (this.pending) return null;
		if (this.#uploads.size > 0) {
			this.pending = true;
			while (this.#uploads.size > 0) await Promise.allSettled([...this.#uploads]);
			this.pending = false;
		}
		const problems = check(this.spec, this.values);
		if (problems.size > 0) { this.errors = problems; return null; }
		const input = payload(this.spec, this.base, this.values);
		if (input === null) return null;
		this.pending = true;
		this.notice = null;
		const sent = { ...this.values };
		try {
			const outcome = await this.#act(this.spec.callable, input, { key: this.#key });
			const s = settle(this.spec, this.base, sent, outcome, this.#text);
			this.base = s.base;
			if (s.draft !== null) this.values = s.draft;
			this.errors = s.errors;
			this.notice = s.notice;
			if (s.newKey) this.#key = crypto.randomUUID();
			return outcome;
		} finally {
			this.pending = false;
		}
	}
	reset(): void {
		this.values = { ...this.base };
		this.errors = new Map();
		this.notice = null;
	}
}

const KEY = Symbol.for('norbital.ui.form');
export const provideForm = (form: FormState) => setContext(KEY, form);
/** The enclosing `Form`'s state, or `undefined` outside a form. */
export const useForm = (): FormState | undefined => getContext<FormState | undefined>(KEY);
