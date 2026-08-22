import { createContext } from 'svelte';
import type { CalendarEvent, CreateSlot } from '#lib/event-calendar/types';
import { dateToPixels, pixelsToDate, snapToMinutes } from '#lib/event-calendar/utils';

type DragState =
	| { mode: 'idle' }
	| {
			mode: 'move';
			event: CalendarEvent;
			column: number;
			initialTop: number;
			initialHeight: number;
	  }
	| {
			mode: 'resize';
			event: CalendarEvent;
			column: number;
			initialTop: number;
			initialHeight: number;
	  }
	| {
			mode: 'create';
			column: number;
			initialTop: number;
	  };

interface DragResult {
	mode: 'move' | 'resize' | 'create';
	event?: CalendarEvent;
	column: number;
	newStart?: Date;
	newEnd?: Date;
	slot?: CreateSlot;
}

interface OverlayRect {
	top: number;
	height: number;
}

interface DragStateApi {
	getDragState(): DragState;
	isDragging(): boolean;
	beginMove(event: CalendarEvent, column: number, initialTop: number, initialHeight: number): void;
	beginResize(
		event: CalendarEvent,
		column: number,
		initialTop: number,
		initialHeight: number
	): void;
	beginCreate(column: number, initialTop: number): void;
	updateDrag(dy: number, column?: number): void;
	endDrag(
		columnDate: Date,
		hourHeight: number,
		startHour: number,
		snapMinutes: number
	): DragResult | null;
	cancelDrag(): void;
	getOverlayRect(): OverlayRect | null;
}

const [useDragStateContext, provideDragStateContext] = createContext<DragStateApi>();

// One drag session per calendar instance; the lifetime belongs to the root
// component that renders the day/week views, not to module scope.
function createDragState(): DragStateApi {
	let dragState = $state<DragState>({ mode: 'idle' });
	let currentTop = $state(0);

	return {
		getDragState: () => dragState,

		isDragging: () => dragState.mode !== 'idle',

		beginMove(event, column, initialTop, initialHeight) {
			dragState = { mode: 'move', event, column, initialTop, initialHeight };
			currentTop = initialTop;
		},

		beginResize(event, column, initialTop, initialHeight) {
			dragState = { mode: 'resize', event, column, initialTop, initialHeight };
			currentTop = initialTop;
		},

		beginCreate(column, initialTop) {
			dragState = { mode: 'create', column, initialTop };
			currentTop = initialTop;
		},

		updateDrag(dy, column) {
			if (dragState.mode === 'idle') return;
			currentTop = dragState.initialTop + dy;
			if (column != null && dragState.mode === 'move') dragState = { ...dragState, column };
		},

		endDrag(columnDate, hourHeight, startHour, snapMinutes) {
			const ds = dragState;
			dragState = { mode: 'idle' };

			switch (ds.mode) {
				case 'idle':
					return null;

				case 'move': {
					const newStart = snapToMinutes(
						pixelsToDate(currentTop, columnDate, hourHeight, startHour, snapMinutes),
						snapMinutes
					);
					const duration = ds.event.end.getTime() - ds.event.start.getTime();
					return {
						mode: 'move',
						event: ds.event,
						column: ds.column,
						newStart,
						newEnd: new Date(newStart.getTime() + duration)
					};
				}

				case 'resize': {
					const newBottom = currentTop + ds.initialHeight;
					const newEnd = snapToMinutes(
						pixelsToDate(newBottom, columnDate, hourHeight, startHour, snapMinutes),
						snapMinutes
					);
					if (newEnd.getTime() <= ds.event.start.getTime()) return null;
					return {
						mode: 'resize',
						event: ds.event,
						column: ds.column,
						newStart: ds.event.start,
						newEnd
					};
				}

				case 'create': {
					const top = Math.min(ds.initialTop, currentTop);
					const bottom = Math.max(ds.initialTop, currentTop);
					const start = snapToMinutes(
						pixelsToDate(top, columnDate, hourHeight, startHour, snapMinutes),
						snapMinutes
					);
					const end = snapToMinutes(
						pixelsToDate(bottom, columnDate, hourHeight, startHour, snapMinutes),
						snapMinutes
					);
					if (end.getTime() <= start.getTime()) return null;
					return { mode: 'create', column: ds.column, slot: { start, end } };
				}
			}
		},

		cancelDrag() {
			dragState = { mode: 'idle' };
		},

		getOverlayRect() {
			switch (dragState.mode) {
				case 'idle':
					return null;
				case 'move':
					return { top: Math.max(0, currentTop), height: dragState.initialHeight };
				case 'resize':
					return {
						top: dragState.initialTop,
						height: Math.max(12, currentTop - dragState.initialTop + dragState.initialHeight)
					};
				case 'create': {
					const top = Math.min(dragState.initialTop, currentTop);
					return { top, height: Math.max(12, Math.abs(currentTop - dragState.initialTop)) };
				}
			}
		}
	};
}

export function provideDragState(): void {
	provideDragStateContext(createDragState());
}

export function useDragState(): DragStateApi {
	return useDragStateContext();
}
