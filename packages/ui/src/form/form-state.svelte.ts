// The draft of one mounted `Form`, shared with its `Field`s by context. A field reads and writes the draft; unmounting
// a field (a lazy tab, a collapsed section) never drops its value, because the value lives here (§5.10).
import { Effect, Fiber, FiberSet } from 'effect';
import { flushSync, getContext, setContext } from 'svelte';
import { encodeWire, reviveWire } from '@norbital-ai/std/wire';
import { valueObject, type Value } from '../kinds/kind.js';
import type { IdOf } from '../model/types.js';
import type { RecordCapabilities, RecordRestriction } from '../record/types.js';
import type { RunHandle, ViewBolt } from '../client/contract.js';
import {
	changed,
	check,
	payload,
	settle,
	startValues,
	type FormSpec,
	type Notice,
	type NoticeText,
	type Outcome,
	type Row
} from './draft.js';
import { childOperations, type ChildOperation } from './child-operations.js';
import { resubmits } from '../approval/row.js';

/** Narrows string ids to a model's id type (e.g. for `where: { id: { in: … } }`). */
export function idsOf<C extends string>(ids: readonly string[]): readonly IdOf<C>[] {
	return ids as readonly IdOf<C>[];
}

export type Act = ViewBolt['act'];
type ViewTransitionDocument = Document & {
	startViewTransition?: (callback: () => void) => unknown;
};
let inLayoutUpdate = false;
let layoutChanges: (() => void)[] = [];
let layoutFrame: number | undefined;
/** One layout change (edit/read-only) with the browser's own crossfade; reduced motion and older browsers change at once. */
function transitionLayout(change: () => void): void {
	// Nested forms follow the outer form in the same update; a second transition would cancel this one.
	if (inLayoutUpdate) {
		change();
		return;
	}
	const start =
		typeof document === 'undefined'
			? undefined
			: (document as ViewTransitionDocument).startViewTransition;
	if (
		start === undefined ||
		(typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
	) {
		change();
		return;
	}
	layoutChanges.push(change);
	if (layoutFrame !== undefined) return;
	// One form action can update several mounted forms (the record and its child grids): one transition for all of them.
	layoutFrame = requestAnimationFrame(() => {
		layoutFrame = undefined;
		const changes = layoutChanges;
		layoutChanges = [];
		const run = () => {
			inLayoutUpdate = true;
			try {
				for (const update of changes) update();
			} finally {
				inLayoutUpdate = false;
			}
		};
		try {
			start.call(document, () => flushSync(run));
		} catch {
			run();
		}
	});
}

/** One invariant a registered rule finds broken: `field` is any key the rule chooses (`repayments.3.amount`). */
export type SemanticIssue = { readonly field: string; readonly message: string };

/**
 * The draft of one mounted `Form`: values, errors, notice and pending state, shared with its `Field`s; values survive a field unmounting.
 */
export class FormState {
	spec: FormSpec;
	mode = $state<'view' | 'edit' | 'create'>('edit');
	base = $state<Record<string, Value>>({});
	values = $state<Record<string, Value>>({});
	errors = $state<Map<string, string>>(new Map());
	notice = $state<Notice | null>(null);
	/** The native automation start, whose run status is followed independently of queue admission. */
	run = $state.raw<RunHandle | null>(null);
	pending = $state(false);
	capabilities = $state<RecordCapabilities | null | undefined>(undefined);
	children = $state<Record<string, readonly ChildOperation[]>>({});
	/** Native child controllers survive a custom body or historical snapshot unmounting. */
	childForms = new Map<string, FormState>();
	/** A draft restored from this browser's storage, so a page does not replace it with fresh defaults. */
	restored = false;
	readonly #childSeeds: Readonly<Record<string, readonly Row[]>>;
	readonly #storageKey: string | undefined;
	#capabilitiesRequired = false;
	/** Fields the row's state lock leaves read-only (advice; the host enforces). */
	locked: (field: string) => boolean;
	readonly dirty = $derived(
		Object.keys(changed(this.base, this.values)).length > 0 ||
			Object.values(this.children).some((operations) => operations.length > 0)
	);
	/** The draft over the row it starts from (the record, else the prefill): a money field reads its currency sibling here even when that is no input. */
	#around = $state.raw<Row>({});
	readonly row: Row = $derived({ ...this.#around, ...this.values });
	/** The client-minted idempotency key of this draft's act: reused only to retry an `unknown` outcome (rule 31). */
	#key: string;
	#revision = $state<number | undefined>(undefined);
	#act: Act;
	#start: ViewBolt['run'] | undefined;
	#startAttempt:
		{ readonly key: string; readonly input: string; readonly handle: RunHandle } | undefined;
	#text: NoticeText;
	/** Uploads in flight (a file field's bytes going to the host): a submit waits for them. */
	#uploads = new Set<FiberSet.FiberSet<unknown, Error>>();
	#outcomes = new Set<(outcome: Outcome) => void>();
	#beforeOutcomes = new Set<(outcome: Outcome) => void>();
	#resets = new Set<() => void>();
	#validators = new Set<() => Effect.Effect<boolean>>();
	#confirms = new Set<() => Effect.Effect<boolean>>();
	#rules = $state.raw<readonly (() => readonly SemanticIssue[])[]>([]);
	/** Every registered rule's current issues; kept apart from `errors` so fixing a value clears its issue at once. */
	readonly semanticErrors: readonly SemanticIssue[] = $derived(
		this.#rules.flatMap((rule) => rule())
	);
	/** Explicit check/refusal errors take precedence over semantic issues on the same field. */
	readonly fieldErrors: ReadonlyMap<string, string> = $derived.by(() => {
		if (this.semanticErrors.length === 0) return this.errors;
		const all = new Map(this.errors);
		for (const issue of this.semanticErrors)
			if (!all.has(issue.field)) all.set(issue.field, issue.message);
		return all;
	});

	constructor(
		spec: FormSpec,
		record: Row | null,
		prefill: Row,
		act: Act,
		text: NoticeText,
		locked: (field: string) => boolean = () => false,
		start?: ViewBolt['run'],
		storageKey?: string
	) {
		this.spec = spec;
		this.mode =
			spec.target.of === 'automation' || spec.target.mode === 'create' ? 'create' : 'edit';
		this.#around = record ?? prefill;
		this.#revision = typeof record?.['revision'] === 'number' ? record['revision'] : undefined;
		this.base = startValues(spec, record, prefill);
		this.values = { ...this.base };
		this.#act = act;
		this.#start = start;
		this.#text = text;
		this.#storageKey = storageKey;
		// a create form's child rows can be seeded from values (`components`), the same way its scalar fields are
		this.#childSeeds =
			spec.target.of === 'model' && spec.target.mode === 'create'
				? Object.fromEntries(
						Object.entries(spec.children ?? {}).flatMap(([relation]) => {
							const seeded = prefill[relation];
							return Array.isArray(seeded) ? [[relation, seeded.filter(valueObject)] as const] : [];
						})
					)
				: {};
		this.locked = (field) =>
			locked(field) ||
			(this.#capabilitiesRequired &&
				(this.capabilities == null ||
					!this.canSubmit ||
					!(
						this.capabilities.fields[field]?.writable || this.capabilities.fields[field]?.proposal
					)));
		this.#key = crypto.randomUUID();
		this.#restore();
	}

	/** The storage key for one child row's draft: the parent form's key, the relation and the row id. */
	childStorageKey(relation: string, key: string): string | undefined {
		return this.#storageKey === undefined ? undefined : `${this.#storageKey}/${relation}/${key}`;
	}

	/** The child rows a create form was opened with (the previous trial's pigments, say). */
	childSeeds(relation: string): readonly Row[] {
		return this.#childSeeds[relation] ?? [];
	}

	#storage(): Storage | null {
		try {
			return typeof localStorage === 'undefined' ? null : localStorage;
		} catch {
			return null;
		}
	}

	#restore(): void {
		if (this.#storageKey === undefined || this.spec.readonly === true || this.mode === 'view')
			return;
		const raw = this.#storage()?.getItem(this.#storageKey);
		if (raw == null) return;
		try {
			const saved: unknown = JSON.parse(raw, reviveWire);
			if (!valueObject(saved)) return;
			const values = valueObject(saved['values']) ? saved['values'] : {};
			this.values = {
				...this.values,
				...Object.fromEntries(
					Object.entries(values).filter(([name]) =>
						this.spec.fields.some((field) => field.name === name && !field.readonly)
					)
				)
			};
			const children = saved['children'];
			if (valueObject(children))
				this.children = Object.fromEntries(
					Object.entries(children).filter(([relation, operations]) => {
						return (
							this.spec.children?.[relation] !== undefined &&
							Array.isArray(operations) &&
							operations.every(
								(operation) => valueObject(operation) && typeof operation['action'] === 'string'
							)
						);
					})
				) as Record<string, readonly ChildOperation[]>;
			this.restored = true;
		} catch {
			// a draft from an older build or another origin: ignore it rather than break the form
		}
	}

	#persist(): void {
		if (this.#storageKey === undefined || this.spec.readonly === true || this.mode === 'view')
			return;
		const storage = this.#storage();
		if (storage === null) return;
		try {
			const values = changed(this.base, this.values);
			const children = Object.fromEntries(
				Object.entries(this.children).filter(([, operations]) => operations.length > 0)
			);
			if (
				Object.keys(values).length === 0 &&
				Object.keys(children).length === 0 &&
				Object.keys(this.#childSeeds).length === 0
			) {
				storage.removeItem(this.#storageKey);
				return;
			}
			storage.setItem(
				this.#storageKey,
				JSON.stringify({ values: encodeWire(values), children: encodeWire(children) })
			);
		} catch {
			// storage full or denied: the form still works, the draft is simply not remembered
		}
	}

	/** A view refreshes from the current row; editing keeps its original revision and draft. */
	refresh(record: Row): void {
		this.#around = record;
		if (this.mode !== 'view') return;
		this.base = startValues(this.spec, record);
		this.values = { ...this.base };
		this.#revision = typeof record['revision'] === 'number' ? record['revision'] : undefined;
	}
	/** A custom create body's presets fill untouched defaults once. */
	prefill(values: Row): void {
		if (this.mode !== 'create') return;
		const edited = changed(this.base, this.values);
		for (const [field, value] of Object.entries(values))
			if (
				!(field in this.#around) &&
				!(field in edited) &&
				this.spec.fields.some((f) => f.name === field && !f.readonly)
			) {
				this.#around = { ...this.#around, [field]: value };
				this.base[field] = value;
				this.values[field] = value;
			}
	}
	edit(): void {
		if (!this.spec.readonly && this.mode === 'view') transitionLayout(() => (this.mode = 'edit'));
	}
	view(): void {
		transitionLayout(() => {
			this.reset();
			this.mode = 'view';
			if (this.spec.target.of === 'model' && this.spec.target.mode === 'update')
				this.refresh(this.#around);
		});
	}
	/** Whether this one field differs from what the form opened with (the row, else the defaults). */
	fieldDirty(name: string): boolean {
		return (
			this.mode !== 'view' &&
			Object.keys(
				changed({ [name]: this.base[name] ?? null }, { [name]: this.values[name] ?? null })
			).length > 0
		);
	}
	expectCapabilities(): void {
		this.#capabilitiesRequired = true;
		this.capabilities = undefined;
	}
	get canSubmit(): boolean {
		return (
			!this.#capabilitiesRequired ||
			this.capabilities?.update.allowed === true ||
			this.capabilities?.update.proposal === true
		);
	}
	/** Permission plus validity: Save stays disabled while any error or broken invariant remains. */
	get canSave(): boolean {
		return (
			this.canSubmit && !this.pending && this.errors.size === 0 && this.semanticErrors.length === 0
		);
	}
	/** Registers a synchronous invariant rule, re-evaluated reactively; returns its unregister. */
	addValidation(rule: () => readonly SemanticIssue[]): () => void {
		this.#rules = [...this.#rules, rule];
		return () => {
			this.#rules = this.#rules.filter((r) => r !== rule);
		};
	}
	/** The first broken invariant's message for exactly this key. */
	semanticError(field: string): string | undefined {
		return this.semanticErrors.find((issue) => issue.field === field)?.message;
	}
	/** The row's request asks for changes and this draft is its requester's: saving resubmits it (Save reads "Resubmit"). */
	get resubmitting(): boolean {
		return this.canSubmit && resubmits(this.#around);
	}
	get requestingApproval(): boolean {
		if (this.spec.proposalOnly === true) return true;
		if (
			Object.values(this.children).some((operations) =>
				operations.some((operation) => operation.proposal === true)
			)
		)
			return true;
		const capabilities = this.capabilities;
		if (!this.#capabilitiesRequired || capabilities == null) return false;
		return (
			(!capabilities.update.allowed && capabilities.update.proposal) ||
			Object.keys(changed(this.base, this.values)).some(
				(field) =>
					capabilities.fields[field]?.writable === false &&
					capabilities.fields[field]?.proposal === true
			)
		);
	}
	readable(field: string): boolean {
		return (
			!this.#capabilitiesRequired ||
			this.capabilities === undefined ||
			(this.capabilities !== null && Object.hasOwn(this.capabilities.fields, field))
		);
	}
	restrictions(field: string): readonly RecordRestriction[] {
		return this.capabilities?.fields[field]?.reasons ?? [];
	}

	get(name: string): Value {
		return this.spec.fields.find((f) => f.name === name)?.readonly ||
			this.restrictions(name).includes('syncOwned')
			? (this.#around[name] ?? null)
			: (this.values[name] ?? null);
	}
	id<C extends string>(name: string): IdOf<C> | null {
		const v = this.get(name);
		return typeof v === 'string' ? (v as IdOf<C>) : null;
	}
	set(name: string, value: Value): void {
		if (
			this.spec.readonly ||
			this.spec.fields.find((f) => f.name === name)?.readonly ||
			this.locked(name)
		)
			return;
		this.values[name] = value;
		// a field's own problem clears as it is edited; the rest stay until the next submit
		if (this.errors.size > 0)
			this.errors = new Map(
				[...this.errors].filter(([k]) => k !== name && !k.startsWith(`${name}.`))
			);
		this.#persist();
	}
	/** Holds a submit until `work` (an upload writing its ref into the draft) settles. */
	track<A, E extends Error>(work: Effect.Effect<A, E>): Effect.Effect<A, E> {
		return Effect.scoped(
			Effect.gen({ self: this }, function* () {
				const uploads = yield* FiberSet.make<unknown, Error>();
				this.#uploads.add(uploads);
				const fiber = yield* FiberSet.run(uploads, work);
				return yield* Fiber.join(fiber).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							this.#uploads.delete(uploads);
						})
					)
				);
			})
		);
	}
	#drain = Effect.gen({ self: this }, function* () {
		while (this.#uploads.size > 0) {
			const pending = [...this.#uploads];
			yield* Effect.forEach(pending, (uploads) => FiberSet.awaitEmpty(uploads), {
				discard: true
			});
			for (const uploads of pending) this.#uploads.delete(uploads);
		}
	});

	onOutcome(receive: (outcome: Outcome) => void): () => void {
		this.#outcomes.add(receive);
		return () => this.#outcomes.delete(receive);
	}
	onReset(reset: () => void): () => void {
		this.#resets.add(reset);
		return () => this.#resets.delete(reset);
	}
	beforeOutcome(receive: (outcome: Outcome) => void): () => void {
		this.#beforeOutcomes.add(receive);
		return () => this.#beforeOutcomes.delete(receive);
	}
	beforeSubmit(validate: () => Effect.Effect<boolean>): () => void {
		this.#validators.add(validate);
		return () => this.#validators.delete(validate);
	}
	/** Asked once the draft is valid, before it is sent: `false` (the person declined) sends nothing. */
	confirmSubmit(ask: () => Effect.Effect<boolean>): () => void {
		this.#confirms.add(ask);
		return () => this.#confirms.delete(ask);
	}
	get revision(): number | undefined {
		return this.#revision;
	}
	queueChildren(relation: string, operations: readonly ChildOperation[]): void {
		const input = this.spec.children?.[relation];
		if (
			input === undefined ||
			operations.some((operation) => input[operation.action] === undefined)
		)
			throw new Error('This child operation is not declared by the parent input.');
		this.children = { ...this.children, [relation]: operations };
		this.#persist();
	}
	validate(): boolean {
		this.errors = check(this.spec, this.values);
		return this.errors.size === 0 && this.semanticErrors.length === 0;
	}
	prepare(): Effect.Effect<boolean> {
		return Effect.gen({ self: this }, function* () {
			this.pending = true;
			yield* this.#drain;
			return this.canSubmit && this.validate();
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					this.pending = false;
				})
			)
		);
	}

	/** A parent transaction settles the same native child draft without submitting it separately. */
	accept(outcome: Outcome, sent: Row = this.values): void {
		const target = this.spec.target;
		if (
			target.of === 'model' &&
			(outcome.kind === 'committed' || outcome.kind === 'pending_approval')
		) {
			const own = outcome.records.find(
				(record) => record.model === target.model && record.id === target.id
			);
			if (own !== undefined) {
				this.#revision = own.revision;
				if (outcome.kind === 'committed')
					this.#around = { ...this.#around, ...changed(this.base, sent), revision: own.revision };
			}
		}
		const settled = settle(this.spec, this.base, sent, outcome, this.#text);
		this.base = settled.base;
		if (settled.draft !== null) this.values = settled.draft;
		this.errors = settled.errors;
		this.notice = settled.notice;
		if (settled.newKey) this.#key = crypto.randomUUID();
		if (outcome.kind === 'committed' || outcome.kind === 'pending_approval') this.children = {};
		this.#persist();
		for (const receive of this.#beforeOutcomes) receive(outcome);
		for (const receive of this.#outcomes) receive(outcome);
	}
	/** Sends the draft; the draft stays until the outcome settles it (rule 67). Resolves `null` when nothing was sent. */
	submit(): Effect.Effect<Outcome | null> {
		return Effect.gen({ self: this }, function* () {
			if (this.pending) return null;
			if (!this.canSubmit) return null;
			this.pending = true;
			yield* this.#drain;
			const valid = yield* Effect.forEach([...this.#validators], (validate) => validate(), {
				concurrency: 'unbounded'
			});
			if (!this.validate() || valid.some((value) => !value)) return null;
			for (const ask of this.#confirms) if (!(yield* ask())) return null;
			const scalar = payload(this.spec, this.base, this.values);
			const target = this.spec.target;
			if (target.of === 'automation') {
				if (scalar === null) return null;
				const start = this.#start;
				if (start === undefined)
					throw new Error('An automation form requires a start implementation.');
				this.notice = null;
				const sent = { ...this.values };
				const input = JSON.stringify(encodeWire(scalar));
				const handle =
					this.#startAttempt?.key === this.#key && this.#startAttempt.input === input
						? this.#startAttempt.handle
						: start(target.automation, scalar);
				this.#startAttempt = { key: this.#key, input, handle };
				const outcome = yield* handle;
				this.run =
					outcome.kind === 'committed' || outcome.kind === 'running' || outcome.kind === 'unknown'
						? handle
						: null;
				this.accept(outcome, sent);
				if (outcome.kind === 'committed')
					this.notice = { tone: 'info', text: this.#text.running, run: handle.id };
				return outcome;
			}
			const nested = childOperations(this.children);
			const hasChildren = Object.keys(nested.set).length > 0;
			const input = !hasChildren
				? scalar
				: target.of === 'model' && target.mode === 'create'
					? { ...(valueObject(scalar) ? scalar : {}), ...nested.set }
					: {
							target: target.id ?? null,
							set: {
								...(valueObject(scalar) && valueObject(scalar['set']) ? scalar['set'] : {}),
								...nested.set
							}
						};
			if (input === null) return null;
			this.notice = null;
			const sent = { ...this.values };
			const observed = {
				...nested.observed,
				...(target.of === 'model' &&
				target.mode === 'update' &&
				target.id !== undefined &&
				this.#revision !== undefined
					? { [target.id]: this.#revision }
					: {})
			};
			const result = yield* Effect.result(
				this.#act(this.spec.callable, [input], {
					key: this.#key,
					...(Object.keys(observed).length === 0 ? {} : { observed })
				})
			);
			const outcome: Outcome =
				result._tag === 'Success'
					? result.success
					: result.failure._tag === 'ActRefused'
						? {
								kind: 'refused',
								code: result.failure.code,
								message: result.failure.message,
								...(result.failure.field === undefined ? {} : { field: result.failure.field })
							}
						: result.failure._tag === 'ActConflict'
							? { kind: 'conflict', records: result.failure.records }
							: { kind: 'unknown', invocation: result.failure.invocation };
			this.accept(outcome, sent);
			return outcome;
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					this.pending = false;
				})
			)
		);
	}
	reset(): void {
		this.#key = crypto.randomUUID();
		this.values = { ...this.base };
		this.errors = new Map();
		this.notice = null;
		this.run = null;
		this.#startAttempt = undefined;
		this.children = {};
		this.restored = false;
		for (const form of this.childForms.values()) form.reset();
		this.childForms.clear();
		this.#clearStorage();
		for (const reset of this.#resets) reset();
	}

	#clearStorage(): void {
		if (this.#storageKey === undefined) return;
		try {
			const storage = this.#storage();
			if (storage === null) return;
			storage.removeItem(this.#storageKey);
			for (let i = storage.length - 1; i >= 0; i--) {
				const key = storage.key(i);
				if (key?.startsWith(`${this.#storageKey}/`)) storage.removeItem(key);
			}
		} catch {
			// storage denied: nothing to clear
		}
	}
}

const KEY = Symbol.for('norbital.ui.form');
export const provideForm = (form: FormState) => setContext(KEY, form);
/** The enclosing `Form`'s state, or `undefined` outside a form. */
export const useForm = (): FormState | undefined => getContext<FormState | undefined>(KEY);

const RECORD_CONTROLLER = Symbol.for('norbital.ui.recordController');
/** The enclosing record's shared form state and historical-view guard. */
export type RecordControllerScope = {
	readonly current: FormState | null;
	readonly historical?: boolean;
};
export const provideRecordController = (scope: RecordControllerScope) =>
	setContext(RECORD_CONTROLLER, scope);
/** The enclosing native record controller; check `historical` before refreshing or entering edit mode after an action. */
export const useRecordController = () =>
	getContext<RecordControllerScope | undefined>(RECORD_CONTROLLER);
