// A complete process-local audit facility for tests. Production hosts must supply a durable separate store.
import { Schema } from 'effect';
import { canonical, sha256Hex } from '@norbital-ai/store';
import { FacilityFailure } from '../decl/errors.ts';
import {
	AuditEvent,
	type AuditPort,
	type AuditRecord,
	type AuditSummary
} from '../protocol/audit.ts';
const Cursor = Schema.Tuple([Schema.String, Schema.String]);
/** A complete process-local audit facility for tests; production hosts must supply a durable separate store. */
export const memoryAudit = () => {
	const records = new Map<string, AuditRecord>();
	const summary = (record: AuditRecord): AuditSummary => {
		const { payload: _payload, ...row } = record;
		return row;
	};
	const cursor = (after: string | undefined, query: unknown) => {
		const hash = sha256Hex(canonical(query));
		if (after === undefined) return { hash, id: undefined };
		try {
			const [bound, id] = Schema.decodeUnknownSync(Schema.fromJsonString(Cursor))(
				decodeURIComponent(after)
			);
			if (bound === hash) return { hash, id };
		} catch {
			// Malformed and changed-filter cursors are both caller errors.
		}
		throw new FacilityFailure({
			kind: 'invalid',
			message: 'The audit cursor is invalid or belongs to different filters.'
		});
	};
	const page = <A extends { id: string }>(
		rows: readonly A[],
		limit: number,
		after: string | undefined,
		query: unknown,
		key: (row: A) => string,
		direction: 1 | -1
	) => {
		const bound = cursor(after, query);
		const available =
			bound.id === undefined
				? rows
				: rows.filter((row) => key(row).localeCompare(bound.id ?? '') * direction > 0);
		const take = available.slice(0, limit);
		const last = take.at(-1);
		return {
			rows: take,
			next:
				limit < available.length && last !== undefined
					? encodeURIComponent(JSON.stringify([bound.hash, key(last)]))
					: null
		};
	};
	const abort = (signal: AbortSignal) => {
		if (signal.aborted) throw signal.reason ?? new Error('aborted');
	};
	const port: AuditPort = {
		mode: 'durable',
		append: async (events, signal) => {
			abort(signal);
			const prepared = events.map((event) =>
				Schema.decodeUnknownSync(AuditEvent)(structuredClone(event))
			);
			for (const event of prepared) {
				const previous = records.get(event.id);
				if (previous !== undefined) {
					const { recordedAt: _at, payloadBytes: _bytes, ...old } = previous;
					if (canonical(old) !== canonical(event))
						throw new Error('Audit event id reused for changed content.');
				}
			}
			for (const event of prepared)
				if (!records.has(event.id))
					records.set(event.id, {
						...event,
						recordedAt: new Date().toISOString(),
						payloadBytes: new TextEncoder().encode(JSON.stringify(event.payload)).length
					});
		},
		query: async (query, signal) => {
			abort(signal);
			const { after, ...filters } = query;
			const text = query.text?.toLowerCase();
			const rows = [...records.values()]
				.filter(
					(row) =>
						(query.since === undefined || row.at >= query.since) &&
						(query.until === undefined || row.at <= query.until) &&
						(query.actorKind === undefined || row.actor.kind === query.actorKind) &&
						(query.actorId === undefined || row.actor.id === query.actorId) &&
						(query.category === undefined || row.category === query.category) &&
						(query.action === undefined || row.action === query.action) &&
						(query.status === undefined || row.status === query.status) &&
						(query.model === undefined || row.subject?.model === query.model) &&
						(query.record === undefined || row.subject?.id === query.record) &&
						(query.invocation === undefined || row.invocation === query.invocation) &&
						(query.run === undefined || row.run === query.run) &&
						(text === undefined || JSON.stringify(row).toLowerCase().includes(text))
				)
				.sort(
					(a, b) =>
						(a.at.localeCompare(b.at) || a.id.localeCompare(b.id)) *
						(query.order === 'oldest' ? 1 : -1)
				);
			return page(
				rows.map(summary),
				query.limit ?? 50,
				after,
				filters,
				(row) => `${row.at}\u0000${row.id}`,
				query.order === 'oldest' ? 1 : -1
			);
		},
		detail: async (id, signal) => {
			abort(signal);
			return records.get(id) ?? null;
		},
		pending: async (query, signal) => {
			abort(signal);
			const { after, ...filters } = query;
			const rows = [...records.values()]
				.flatMap((row) => {
					const terminal = records.get(`${row.operationId}:terminal`);
					return row.status === 'prepared' &&
						(terminal === undefined ||
							terminal.status === 'unknown' ||
							terminal.status === 'prepared')
						? [{ ...row, status: 'prepared' as const }]
						: [];
				})
				.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
			return page(
				rows,
				query.limit ?? 200,
				after,
				filters,
				(row) => `${row.recordedAt}\u0000${row.id}`,
				1
			);
		}
	};
	return { port, records };
};
