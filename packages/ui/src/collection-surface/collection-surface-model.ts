import { Schema } from 'effect';
import { isSystemCollectionField, type CollectionField } from '@norbital-ai/std/collection';
import { humanize } from '@norbital-ai/std/string';
import type { Translate } from '#lib/data-renderer/data-renderer.utils';
import {
	resolveCollectionRecordMetadata,
	type CollectionRecordMetadataResolver,
	type ResolvedCollectionRecordMetadata
} from '#lib/collection-record-metadata/collection-record-metadata';

const TEXT_LIKE_KINDS: ReadonlySet<string> = new Set(['text', 'phone', 'email', 'url', 'markdown']);

function isTextLike(field: CollectionField): boolean {
	return !field.array && TEXT_LIKE_KINDS.has(field.kind);
}

const cardRoleHintsSchema = Schema.Struct({
	title: Schema.optionalKey(Schema.String),
	subtitle: Schema.optionalKey(Schema.Array(Schema.String)),
	badge: Schema.optionalKey(Schema.String)
});
type CardRoleHints = typeof cardRoleHintsSchema.Type;

const cardTitleSourceSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal('field'), name: Schema.String }),
	Schema.Struct({ kind: Schema.Literal('collection') })
]);
type CardTitleSource = typeof cardTitleSourceSchema.Type;

const isString = Schema.is(Schema.String);

const autoCardModelSchema = Schema.Struct({
	title: cardTitleSourceSchema,
	subtitles: Schema.Array(Schema.String),
	badge: Schema.optionalKey(Schema.String)
});
export type AutoCardModel = typeof autoCardModelSchema.Type;

/** Derive card roles only from the surface's explicit field order. */
export function deriveAutoCard(
	fields: readonly CollectionField[],
	fieldOrder: readonly string[],
	options: { roles?: CardRoleHints }
): AutoCardModel {
	const { roles } = options;
	const fieldByName = new Map(fields.map((field) => [field.name, field] as const));
	const visible = fieldOrder.flatMap((name) => {
		const field = fieldByName.get(name);
		return field && !isSystemCollectionField(field.name) ? [field] : [];
	});
	const titleName =
		roles?.title ??
		visible.find((field) => !field.nullable && isTextLike(field))?.name ??
		visible[0]?.name;
	const title: CardTitleSource = titleName
		? { kind: 'field', name: titleName }
		: { kind: 'collection' };
	const titleFieldName = title.kind === 'field' ? title.name : undefined;
	const badgeName = roles?.badge ?? visible.find((field) => field.kind === 'enum')?.name;
	const badge = badgeName === titleFieldName ? undefined : badgeName;
	const subtitleSource =
		roles?.subtitle && roles.subtitle.length > 0
			? roles.subtitle
			: visible
					.filter((field) => isTextLike(field) || field.relation != null)
					.map((field) => field.name);
	const subtitles = [...new Set(subtitleSource)]
		.filter((name) => name !== titleFieldName && name !== badge)
		.slice(0, 2);
	return { title, subtitles, ...(badge ? { badge } : {}) };
}

export function optionalCollectionRecordId(record: object | undefined | null): string | undefined {
	if (record == null) return undefined;
	const value = Reflect.get(record, 'id');
	return isString(value) && value.length > 0 ? value : undefined;
}

function singularizeWord(word: string): string {
	if (/ies$/i.test(word)) return word.replace(/ies$/i, 'y');
	if (/(ses|xes|zes|ches|shes)$/i.test(word)) return word.replace(/es$/i, '');
	if (/ss$/i.test(word)) return word;
	if (/s$/i.test(word)) return word.replace(/s$/i, '');
	return word;
}

export function createCollectionActionLabel(collectionName: string, t: Translate): string {
	const parts = humanize(collectionName).split(' ');
	if (parts.length > 0) parts[parts.length - 1] = singularizeWord(parts[parts.length - 1]);
	return `${t('common.new')} ${parts.join(' ') || collectionName}`;
}

export function resolvedCollectionRecordMetadata<TRow extends object>(
	record: TRow,
	metadata: CollectionRecordMetadataResolver<TRow> | undefined,
	t: Translate
): readonly ResolvedCollectionRecordMetadata[] {
	return resolveCollectionRecordMetadata(record, metadata?.(record), {
		pendingApprovalLabel: t('recordMetadata.pendingApproval'),
		pendingApprovalReason: t('recordMetadata.pendingApprovalReason')
	});
}
