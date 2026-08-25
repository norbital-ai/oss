/**
 * @file mention-item.ts
 * @description The mention data contract shared by the configured mention extension and the
 * node views that render mentions, defined here so neither side imports the other.
 */

import { Schema } from 'effect';

export const MentionItemSchema = Schema.Struct({
	id: Schema.mutableKey(Schema.String),
	type: Schema.mutableKey(
		Schema.Literals([
			'collection',
			'column',
			'route',
			'template',
			'workspace',
			'folder',
			'file',
			'user'
		])
	),
	label: Schema.mutableKey(Schema.String),
	description: Schema.mutableKey(Schema.String),
	icon: Schema.mutableKey(Schema.String),
	metadata: Schema.mutableKey(Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))),
	parentId: Schema.mutableKey(Schema.optionalKey(Schema.String))
});
export type MentionItem = typeof MentionItemSchema.Type;
