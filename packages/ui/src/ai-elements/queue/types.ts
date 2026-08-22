import { Schema } from 'effect';

const QueueMessagePartSchema = Schema.Struct({
	type: Schema.mutableKey(Schema.String),
	text: Schema.mutableKey(Schema.optionalKey(Schema.String)),
	url: Schema.mutableKey(Schema.optionalKey(Schema.String)),
	filename: Schema.mutableKey(Schema.optionalKey(Schema.String)),
	mediaType: Schema.mutableKey(Schema.optionalKey(Schema.String))
});
export type QueueMessagePart = typeof QueueMessagePartSchema.Type;

const QueueMessageSchema = Schema.Struct({
	id: Schema.mutableKey(Schema.String),
	parts: Schema.mutableKey(Schema.Array(QueueMessagePartSchema))
});
export type QueueMessage = typeof QueueMessageSchema.Type;

const QueueTodoSchema = Schema.Struct({
	id: Schema.mutableKey(Schema.String),
	title: Schema.mutableKey(Schema.String),
	description: Schema.mutableKey(Schema.optionalKey(Schema.String)),
	status: Schema.mutableKey(Schema.optionalKey(Schema.Literals(['pending', 'completed'])))
});
export type QueueTodo = typeof QueueTodoSchema.Type;
