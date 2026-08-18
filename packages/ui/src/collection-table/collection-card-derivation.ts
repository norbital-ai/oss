import type { CollectionField } from '@norbital-ai/std/collection';
import { humanize } from '@norbital-ai/std/string';
import { formatDataValue, type Translate } from '../data-renderer/data-renderer.utils.js';

/**
 * Shared, framework-owned derivation for the collection-view auto-defaults (RFC V.2–V.4).
 *
 * Every function here is pure — it maps runtime schema metadata (`CollectionField[]`, field kinds,
 * values, relations) to a view shape (column set, mobile/kanban card model, kanban lanes, form
 * field order). The table, board, and form components each read the same helpers so a model drives
 * every surface identically, and the logic stays unit-testable without a Svelte renderer.
 *
 * Derivation is intentionally structural (declaration order / kind / nullability / relation / enum),
 * never dependent on authored display metadata: sections, help, and labels are not part of the
 * pipeline. Point-of-use control comes from authored `<Column>` snippets, form `fields` props, view
 * lane overrides, and `<Column card="…">` role hints.
 */

/** System fields are framework-managed (`norbital_*`) and never authored into a view. */
export function isSystemField(name: string): boolean {
	return name.startsWith('norbital_');
}

/**
 * The framework row key, when the value is a persisted row rather than a draft.
 *
 * This is the single place the framework reads `norbital_id` off a caller-supplied object, so an
 * authored surface never has to: it hands over the record it already has and the framework tells
 * create and update apart from the presence of the key.
 */
export function optionalCollectionRecordId(record: object | undefined | null): string | undefined {
	if (record == null) return undefined;
	const value = Reflect.get(record, 'norbital_id');
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Resolve a required runtime row key before issuing a selection-scoped mutation. */
export function collectionRecordId(record: object): string {
	const value = optionalCollectionRecordId(record);
	if (value === undefined) throw new Error('Cannot mutate a record without a norbital_id.');
	return value;
}

/** Field kinds whose form control spans the full intrinsic grid width (RFC IV.2 / V.4). */
const FULL_WIDTH_FORM_KINDS: ReadonlySet<string> = new Set(['text', 'json', 'matrix', 'file']);

/** Textual kinds that read well as a card title / subtitle line. */
const TEXT_LIKE_KINDS: ReadonlySet<string> = new Set(['text', 'phone', 'email', 'url', 'markdown']);

/** A short textual field (never an array), suitable for a title or subtitle line. */
function isTextLike(field: CollectionField): boolean {
	return !field.array && TEXT_LIKE_KINDS.has(field.kind);
}

/** A relation field, whose target `record_label` renders as a readable subtitle. */
function isRelationLike(field: CollectionField): boolean {
	return field.relation != null;
}

/** An enum-backed field. */
export function isEnumField(field: CollectionField): boolean {
	return field.kind === 'enum';
}

/**
 * Ordered non-system field names in declaration order. Used by kanban auto-card derivation when no
 * authored column order is available — table columns are always authored via a `columns` snippet.
 */
export function deriveColumnFieldNames(fields: readonly CollectionField[]): string[] {
	return fields.filter((field) => !isSystemField(field.name)).map((field) => field.name);
}

/** Ordered pick of existing field names, preserving the requested order (RFC V.2b `fields`). */
export function pickFieldNames(
	fields: readonly CollectionField[],
	names: readonly string[]
): string[] {
	const known = new Set(fields.map((field) => field.name));
	return names.filter((name) => known.has(name));
}

/** Card-role hints contributed by `<Column card="…">` (RFC V.2c); board passes none. */
export interface CardRoleHints {
	title?: string;
	subtitle?: readonly string[];
	badge?: string;
}

/**
 * How a card title resolves: a specific field's value, or the collection's runtime
 * `record_label` (CEL) — which only the caller can evaluate per record.
 */
export type CardTitleSource =
	{ readonly kind: 'field'; readonly name: string } | { readonly kind: 'record-label' };

/** The derived mobile-card / kanban-card shape (RFC V.2d / V.3). */
export interface AutoCardModel {
	readonly title: CardTitleSource;
	/** Secondary field names, capped at two, title excluded. */
	readonly subtitles: readonly string[];
	/** Badge field name, if any. */
	readonly badge?: string;
}

/**
 * The auto card model derived from column card-role hints and, where a role is unfilled, the
 * field structure (RFC V.2d / V.3).
 *
 * - title: `card:'title'` → the first non-nullable text-ish field → the first visible column →
 *   the collection `record_label` (when present).
 * - subtitle: `card:'subtitle'` columns → the next text-ish / relation fields (title excluded),
 *   capped at two.
 * - badge: `card:'badge'` → the first enum-backed field.
 *
 * `columnOrder` is the visible column key order used for the title fallback.
 */
export function deriveAutoCard(
	fields: readonly CollectionField[],
	columnOrder: readonly string[],
	options: { roles?: CardRoleHints; hasRecordLabel: boolean }
): AutoCardModel {
	const { roles, hasRecordLabel } = options;
	const visible = fields.filter((field) => !isSystemField(field.name));

	const titleName =
		roles?.title ??
		visible.find((field) => !field.nullable && isTextLike(field))?.name ??
		columnOrder[0] ??
		(hasRecordLabel ? undefined : visible[0]?.name);
	const title: CardTitleSource = titleName
		? { kind: 'field', name: titleName }
		: { kind: 'record-label' };

	const titleFieldName = title.kind === 'field' ? title.name : undefined;

	const subtitleSource =
		roles?.subtitle && roles.subtitle.length > 0
			? roles.subtitle
			: visible
					.filter((field) => isTextLike(field) || isRelationLike(field))
					.map((field) => field.name);
	const subtitles = subtitleSource.filter((name) => name !== titleFieldName).slice(0, 2);

	const badge = roles?.badge ?? visible.find((field) => isEnumField(field))?.name;

	return { title, subtitles, badge };
}

/**
 * Format one field from an auto-card model without coupling the view to a renderer component.
 *
 * This is the schema's answer, and the default `CardText` for a surface that has no other. A
 * surface with authored columns has a better one: see `CardText`.
 */
export function formatAutoCardField(
	fields: readonly CollectionField[],
	name: string,
	record: object,
	t?: Translate
): string {
	const field = fields.find((candidate) => candidate.name === name);
	return field ? formatDataValue(field, Reflect.get(record, name), undefined, t) : '';
}

/**
 * How one record's field becomes a line of card text.
 *
 * A card role names a field, but only the surface knows how that field reads: the table has the
 * authored `<Column render>` that turns `leave_type_id` into `MEDICAL_LEAVE · Medical leave`, while
 * the kanban derives its card from field structure alone and has nothing but the schema formatter.
 * Passing the resolution in keeps that difference at the call site instead of teaching this module
 * about columns.
 */
export type CardText = (name: string) => string;

/** Join the non-empty subtitle values selected by an auto-card model. */
export function formatAutoCardSubtitle(model: AutoCardModel, text: CardText): string {
	return model.subtitles
		.map(text)
		.filter((value) => value && value !== '—')
		.join(' · ');
}

/**
 * Resolve the optional badge selected by an auto-card model.
 *
 * The record is still read directly: a badge is dropped when the field is empty, which is not the
 * same as a resolver that formats an empty value into a dash.
 */
export function formatAutoCardBadge(
	model: AutoCardModel,
	record: object,
	text: CardText
): { label: string } | null {
	if (!model.badge) return null;
	const value = Reflect.get(record, model.badge);
	if (value == null || value === '') return null;
	const label = text(model.badge);
	return label && label !== '—' ? { label } : null;
}

/** A kanban lane derived from a groupBy field's enum values in model order (RFC V.3). */
export interface DerivedLane {
	readonly value: string;
	readonly label: string;
	readonly color?: string;
}

/** Authored lane pick/order with optional presentation overrides (RFC V.3). */
export interface AuthoredLane {
	readonly value: string;
	readonly label?: string;
	readonly color?: string;
}

export type AuthoredLaneInput = string | AuthoredLane;

export function normalizeAuthoredLane(lane: AuthoredLaneInput): AuthoredLane {
	if (typeof lane === 'string') return { value: lane };
	return { value: String(lane.value), label: lane.label, color: lane.color };
}

/** Lane values in authored order — accepts `{ value, label?, color? }[]` or `string[]`. */
export function parseAuthoredLaneValues(lanes: readonly AuthoredLaneInput[]): string[] {
	return lanes.map((lane) => normalizeAuthoredLane(lane).value);
}

/**
 * Kanban lanes derived from the groupBy field's bare `values`, in model order (RFC V.3).
 * Labels humanize the value; colours are supplied by view `lanes`, not schema.
 */
export function deriveLanes(field: CollectionField | undefined): DerivedLane[] {
	if (!field?.values || field.values.length === 0) return [];
	return field.values.map((value) => ({ value, label: humanize(value) }));
}

/**
 * Merge schema-derived lane metadata with authored view lanes. Authored labels/colours override
 * schema-derived lanes; string lanes inherit derived metadata when present.
 */
export function mergeAuthoredLanes(
	derived: readonly DerivedLane[],
	authored?: readonly AuthoredLaneInput[]
): Map<string, DerivedLane> {
	const meta = new Map(derived.map((lane) => [lane.value, lane]));
	if (!authored?.length) return meta;
	for (const entry of authored) {
		const lane = normalizeAuthoredLane(entry);
		const existing = meta.get(lane.value);
		meta.set(lane.value, {
			value: lane.value,
			label: lane.label ?? existing?.label ?? humanize(lane.value),
			color: lane.color ?? existing?.color
		});
	}
	return meta;
}

/** Naive English singularization for auto create-action labels; last word only. */
function singularizeWord(word: string): string {
	if (/ies$/i.test(word)) return word.replace(/ies$/i, 'y');
	if (/(ses|xes|zes|ches|shes)$/i.test(word)) return word.replace(/es$/i, '');
	if (/ss$/i.test(word)) return word;
	if (/s$/i.test(word)) return word.replace(/s$/i, '');
	return word;
}

/** Humanized, singular collection name for the auto "New …" create button (RFC V.2f). */
export function humanizedSingular(collectionName: string): string {
	const parts = humanize(collectionName).split(' ');
	if (parts.length === 0) return collectionName;
	parts[parts.length - 1] = singularizeWord(parts[parts.length - 1]);
	return parts.join(' ');
}

/** The create-action label: an explicit override, else `New <humanized singular collection>`. */
export function createActionLabel(
	collectionName: string,
	override?: string,
	t?: Translate
): string {
	const singular = humanizedSingular(collectionName);
	if (override) return override;
	return t ? `${t('common.new')} ${singular}` : `New ${singular}`;
}

/**
 * Ordered field names for an auto-emitted form (RFC V.4a): every writable field in declaration
 * order. System (`norbital_*`) and read-only fields are excluded. The `fields` prop narrows this.
 */
export function deriveFormFieldNames(fields: readonly CollectionField[]): string[] {
	return fields
		.filter((field) => !isSystemField(field.name) && !field.readOnly)
		.map((field) => field.name);
}

/** True when a field kind's form control spans the full intrinsic-grid width (RFC V.4a). */
export function isFullWidthFormField(kind: string): boolean {
	return FULL_WIDTH_FORM_KINDS.has(kind);
}
