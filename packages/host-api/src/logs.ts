// The runtime log: events a release writes as they happen, held and queried by the host, never the tenant database.
import type { Schema } from 'effect';
import type { Json } from '@norbital-ai/store';

/** A runtime event's severity. */
export type LogLevel = 'info' | 'warn' | 'error';
/** One runtime event as it happens: the host writes it to its log pipe, never to the workspace's database. */
export type LogEvent = {
	readonly at: string;
	readonly severity: LogLevel;
	readonly event: string;
	readonly invocation: string;
	readonly run: string | null;
	readonly conversation: string | null;
	readonly turn: string | null;
	readonly attributes: { readonly [key: string]: Json };
};
/** A stored event as the host's log store answers it; `id` is the store's own cursor. */
export type LogRow = Omit<LogEvent, 'attributes'> & {
	readonly id: string;
	readonly attributes: Json;
};
/** A filter over the tenant's stored log events; every given condition must hold. */
export type LogQuery = {
	/** rows older than this id */
	readonly before?: string;
	/** rows newer than this id (the tail) */
	readonly after?: string;
	/** exactly this severity */
	readonly level?: LogLevel;
	/** this severity or worse */
	readonly min?: LogLevel;
	/** the event name or its attributes */
	readonly text?: string;
	readonly conversation?: string;
	readonly run?: string;
	/** events naming this automation */
	readonly automation?: string;
	/** instants bounding `at`: `since` inclusive, `until` exclusive */
	readonly since?: string;
	readonly until?: string;
	/** rows per page, 1 to 200 (default 200) */
	readonly limit?: number;
};
/**
 * The workspace's log facility, held by the host: each event written as it happens, and pages queried back newest first.
 * The host owns identity, time, caps and scope: an event names no tenant, and a query reads only this workspace's log.
 */
export interface LogPort {
	write(event: LogEvent): void;
	query(query: LogQuery, signal: AbortSignal): Promise<readonly LogRow[]>;
}
