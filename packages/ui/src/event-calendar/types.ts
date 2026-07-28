export interface CalendarEvent {
	id: string | number;
	start: Date;
	end: Date;
	title: string;
	allDay?: boolean;
	color?: string;
	editable?: boolean;
	lockedReason?: string;
	[key: string]: unknown;
}

export type CalendarView = 'day' | 'week' | 'month';

export interface EventRenderContext {
	view: CalendarView;
	mode: 'box' | 'bar' | 'pill';
	isMultiDay: boolean;
	column: number;
	lane: number;
	totalLanes: number;
}

export interface EditorAPI {
	event: CalendarEvent;
	save(): void;
	cancel(): void;
	delete(): void;
}

export interface CreateSlot {
	start: Date;
	end: Date;
	allDay?: boolean;
}

export interface LaneAssignment {
	event: CalendarEvent;
	lane: number;
	totalLanes: number;
}

export interface EventChunk {
	id: string;
	event: CalendarEvent;
	start: Date;
	end: Date;
	column: number;
	isEdgeStart: boolean;
	isEdgeEnd: boolean;
}
