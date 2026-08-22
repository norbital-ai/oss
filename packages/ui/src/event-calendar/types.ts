import { Schema } from 'effect';

const CalendarViewSchema = Schema.Literals(['day', 'week', 'month']);
export type CalendarView = typeof CalendarViewSchema.Type;

const CalendarEventSchema = Schema.StructWithRest(
	Schema.Struct({
		id: Schema.mutableKey(Schema.Union([Schema.String, Schema.Number])),
		start: Schema.mutableKey(Schema.Date),
		end: Schema.mutableKey(Schema.Date),
		title: Schema.mutableKey(Schema.String),
		allDay: Schema.mutableKey(Schema.optionalKey(Schema.Boolean)),
		color: Schema.mutableKey(Schema.optionalKey(Schema.String)),
		editable: Schema.mutableKey(Schema.optionalKey(Schema.Boolean)),
		lockedReason: Schema.mutableKey(Schema.optionalKey(Schema.String))
	}),
	[Schema.Record(Schema.String, Schema.Unknown)]
);
export type CalendarEvent = typeof CalendarEventSchema.Type;

const EventRenderContextSchema = Schema.Struct({
	view: Schema.mutableKey(CalendarViewSchema),
	mode: Schema.mutableKey(Schema.Literals(['box', 'bar', 'pill'])),
	isMultiDay: Schema.mutableKey(Schema.Boolean),
	column: Schema.mutableKey(Schema.Number),
	lane: Schema.mutableKey(Schema.Number),
	totalLanes: Schema.mutableKey(Schema.Number)
});
export type EventRenderContext = typeof EventRenderContextSchema.Type;

export interface EditorAPI {
	event: CalendarEvent;
	save(): void;
	cancel(): void;
	delete(): void;
}

const CreateSlotSchema = Schema.Struct({
	start: Schema.mutableKey(Schema.Date),
	end: Schema.mutableKey(Schema.Date),
	allDay: Schema.mutableKey(Schema.optionalKey(Schema.Boolean))
});
export type CreateSlot = typeof CreateSlotSchema.Type;

const LaneAssignmentSchema = Schema.Struct({
	event: Schema.mutableKey(CalendarEventSchema),
	lane: Schema.mutableKey(Schema.Number),
	totalLanes: Schema.mutableKey(Schema.Number)
});
export type LaneAssignment = typeof LaneAssignmentSchema.Type;

const EventChunkSchema = Schema.Struct({
	id: Schema.mutableKey(Schema.String),
	event: Schema.mutableKey(CalendarEventSchema),
	start: Schema.mutableKey(Schema.Date),
	end: Schema.mutableKey(Schema.Date),
	column: Schema.mutableKey(Schema.Number),
	isEdgeStart: Schema.mutableKey(Schema.Boolean),
	isEdgeEnd: Schema.mutableKey(Schema.Boolean)
});
export type EventChunk = typeof EventChunkSchema.Type;
