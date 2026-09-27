/// <reference types="node" />
// Telemetry (§5.12): one invocation's `sys_event` rows. Each event is a stdout JSON line when it happens and a buffered
// row. The act's own statement takes the buffer as a piece (`take` + `eventsPiece`); otherwise the host writes it as one
// INSERT after the invocation (`end`). While a long invocation runs, `slice` writes what is buffered every 10 s or 200
// events, called between crossings only, so it is never a piece of an act statement nor inside a guest call.
import type { Json } from '../../decl/values.ts';
import type { Sql, TenantDb } from '../contracts.ts';

export type Severity = 'info' | 'warn' | 'error';
export type SysEvent = { at: string; severity: Severity; event: string; invocation: string; run: string | null;
	conversation: string | null; turn: string | null; attributes: { readonly [key: string]: Json } };
export type EventIds = { invocation: string; run?: string; conversation?: string; turn?: string };

export const SLICE = { ms: 10_000, events: 200 } as const;

/** `INSERT INTO sys_event … FROM jsonb_to_recordset($n)`: the rows as one parameter, usable as a statement piece. */
export function eventsPiece(param: number): string {
	return `INSERT INTO sys_event (at, severity, event, invocation, run, conversation, turn, attributes) SELECT e.at, e.severity, e.event, e.invocation, e.run, e.conversation, e.turn, e.attributes FROM jsonb_to_recordset($${param}::jsonb) AS e(at timestamptz, severity text, event text, invocation text, run text, conversation text, turn text, attributes jsonb)`;
}
export const insertEvents = (events: readonly SysEvent[]): Sql => ({ text: eventsPiece(1), params: [JSON.stringify(events)] });

export class EventLog {
	#buffer: SysEvent[] = [];
	#flushedAt: number;
	readonly #ids: EventIds;
	readonly #db: Pick<TenantDb, 'write'> | undefined;
	readonly #line: (line: string) => void;
	readonly #clock: () => number;

	constructor(ids: EventIds, db?: Pick<TenantDb, 'write'>, line: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
		clock: () => number = Date.now) {
		this.#ids = ids; this.#db = db; this.#line = line; this.#clock = clock;
		this.#flushedAt = clock();
	}

	/** Secrets, tokens and masked values never go in `attributes` (the caller's duty; §5.12). */
	emit(severity: Severity, event: string, attributes: { readonly [key: string]: Json } = {}): void {
		const e: SysEvent = { at: new Date(this.#clock()).toISOString(), severity, event, invocation: this.#ids.invocation,
			run: this.#ids.run ?? null, conversation: this.#ids.conversation ?? null, turn: this.#ids.turn ?? null, attributes };
		this.#line(JSON.stringify(e));
		this.#buffer.push(e);
	}

	/** Hands the buffer to the act's statement (rule 20). */
	take(): SysEvent[] {
		const out = this.#buffer;
		this.#buffer = [];
		this.#flushedAt = this.#clock();
		return out;
	}

	/** Between crossings: one INSERT when 10 s passed or 200 events wait. */
	async slice(): Promise<void> {
		if (this.#buffer.length >= SLICE.events || (this.#buffer.length > 0 && this.#clock() - this.#flushedAt >= SLICE.ms)) await this.end();
	}

	/** After an invocation whose events no act statement took. */
	async end(): Promise<void> {
		const rows = this.take();
		if (rows.length > 0 && this.#db !== undefined) await this.#db.write(insertEvents(rows));
	}
}
