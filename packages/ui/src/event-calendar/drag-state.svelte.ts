import type { CalendarEvent, CreateSlot } from './types.js';
import { dateToPixels, pixelsToDate, snapToMinutes } from './utils.js';

export type DragState =
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

let dragState = $state<DragState>({ mode: 'idle' });

let currentTop = $state(0);

export function getDragState(): DragState {
	return dragState;
}

export function isDragging(): boolean {
	return dragState.mode !== 'idle';
}

export function beginMove(
	event: CalendarEvent,
	column: number,
	initialTop: number,
	initialHeight: number
): void {
	dragState = { mode: 'move', event, column, initialTop, initialHeight };
	currentTop = initialTop;
}

export function beginResize(
	event: CalendarEvent,
	column: number,
	initialTop: number,
	initialHeight: number
): void {
	dragState = { mode: 'resize', event, column, initialTop, initialHeight };
	currentTop = initialTop;
}

export function beginCreate(column: number, initialTop: number): void {
	dragState = { mode: 'create', column, initialTop };
	currentTop = initialTop;
}

export function updateDrag(dy: number, column?: number): void {
	if (dragState.mode === 'idle') return;
	currentTop = dragState.initialTop + dy;
	if (column != null && dragState.mode === 'move') dragState = { ...dragState, column };
}

export interface DragResult {
	mode: 'move' | 'resize' | 'create';
	event?: CalendarEvent;
	column: number;
	newStart?: Date;
	newEnd?: Date;
	slot?: CreateSlot;
}

export function endDrag(
	columnDate: Date,
	hourHeight: number,
	startHour: number,
	snapMinutes: number
): DragResult | null {
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
}

export function cancelDrag(): void {
	dragState = { mode: 'idle' };
}

export interface OverlayRect {
	top: number;
	height: number;
}

export function getOverlayRect(): OverlayRect | null {
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
