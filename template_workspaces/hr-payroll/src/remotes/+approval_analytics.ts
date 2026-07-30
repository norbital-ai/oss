import { defineQueryHandler } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

/**
 * Year-to-date approval counters and a five-year application trend for the three subjects the HR
 * Controller pages summarise.
 *
 * There is no approval column anywhere in this workspace: `norbital_approval_id IS NULL` is the
 * ONLY definition of a live row, and a non-null id means the row is still held by an approval
 * request. Every counter below is expressed in those terms.
 *
 * - `PAYROLL` counts `payroll_runs`.
 * - `LEAVE`   counts `leave_requests`, dated by `from_date`.
 * - `CLAIM`   counts `component_entries` whose `origin` variant is `CLAIM`, dated by the origin's
 *   `incurred_on` — a claim's economic date, not the row's creation date.
 */
const subjectSchema = z.enum(['CLAIM', 'LEAVE', 'PAYROLL']);
type Subject = z.infer<typeof subjectSchema>;

const COLLECTION_FOR_SUBJECT: Record<Subject, string> = {
	PAYROLL: 'payroll_runs',
	LEAVE: 'leave_requests',
	CLAIM: 'component_entries'
};

type LockedRecordRef = {
	collection_name: string;
	record_id: string;
};

function parseLockedRecordRefs(value: unknown): LockedRecordRef[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (typeof entry !== 'object' || entry === null) return [];
		const collectionName = Reflect.get(entry, 'collection_name');
		const recordId = Reflect.get(entry, 'record_id');
		return typeof collectionName === 'string' && typeof recordId === 'string'
			? [{ collection_name: collectionName, record_id: recordId }]
			: [];
	});
}

function linearTrend(values: readonly number[]): number[] {
	if (values.length === 0) return [];
	if (values.length === 1) return [values[0] ?? 0];
	const xMean = (values.length - 1) / 2;
	const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
	let numerator = 0;
	let denominator = 0;
	for (const [index, value] of values.entries()) {
		const xDelta = index - xMean;
		numerator += xDelta * (value - yMean);
		denominator += xDelta * xDelta;
	}
	const slope = denominator === 0 ? 0 : numerator / denominator;
	const intercept = yMean - slope * xMean;
	return values.map((_value, index) => Math.max(0, intercept + slope * index));
}

function approvalDurationHours(
	approvals: readonly unknown[],
	collectionName: string,
	ytdStart: Date,
	recordIds?: ReadonlySet<string>
): { average: number | null; sampleSize: number } {
	const durations = approvals.flatMap((approval) => {
		if (typeof approval !== 'object' || approval === null) return [];
		const closedAt = Reflect.get(approval, 'closed_at');
		const createdAt = Reflect.get(approval, 'norbital_created_at');
		if (
			Reflect.get(approval, 'collection_name') !== collectionName ||
			Reflect.get(approval, 'status') !== 'APPROVED' ||
			!(closedAt instanceof Date) ||
			!(createdAt instanceof Date) ||
			createdAt < ytdStart
		)
			return [];
		const matches = parseLockedRecordRefs(Reflect.get(approval, 'locked_record_refs')).some(
			(ref) =>
				ref.collection_name === collectionName && (!recordIds || recordIds.has(ref.record_id))
		);
		if (!matches) return [];
		const duration = closedAt.getTime() - createdAt.getTime();
		return Number.isFinite(duration) && duration >= 0 ? [duration / 3_600_000] : [];
	});
	return {
		average:
			durations.length === 0
				? null
				: durations.reduce((sum, duration) => sum + duration, 0) / durations.length,
		sampleSize: durations.length
	};
}

export default defineQueryHandler({
	schema: z.object({ subject: subjectSchema }),
	handler: async ({ subject }: { subject: Subject }, api) => {
		const now = new Date();
		const currentYear = now.getUTCFullYear();
		const ytdStart = new Date(Date.UTC(currentYear, 0, 1));
		const ytdStartKey = `${currentYear}-01-01`;
		const ytdEndKey = `${currentYear + 1}-01-01`;
		const historyYears = Array.from({ length: 5 }, (_value, index) => currentYear - 5 + index);
		const collectionName = COLLECTION_FOR_SUBJECT[subject];

		const approvalQuery = api.db.query.approval_request.findMany({
			orderBy: { norbital_created_at: 'desc' },
			limit: 5000
		});

		if (subject === 'PAYROLL') {
			const [pending, approved, total, approvalRows] = await Promise.all([
				api.db.payroll_runs.count({
					where: {
						norbital_created_at: { gte: ytdStart },
						OR: [{ lifecycle: { eq: 'DRAFT' } }, { norbital_approval_id: { isNotNull: true } }]
					}
				}),
				api.db.payroll_runs.count({
					where: {
						norbital_created_at: { gte: ytdStart },
						lifecycle: { eq: 'PAID' },
						norbital_approval_id: { isNull: true }
					}
				}),
				api.db.payroll_runs.count(),
				approvalQuery
			]);
			const duration = approvalDurationHours(approvalRows, collectionName, ytdStart);
			return {
				subject,
				as_of_date: now.toISOString().slice(0, 10),
				total,
				summary: {
					ytd_pending: pending,
					ytd_approved: approved,
					average_approval_hours: duration.average,
					approval_sample_size: duration.sampleSize
				},
				annual_trend: []
			};
		}

		if (subject === 'LEAVE') {
			const [pending, approved, total, ytdRows, approvalRows, ...yearCounts] = await Promise.all([
				api.db.leave_requests.count({
					where: {
						norbital_approval_id: { isNotNull: true },
						from_date: { gte: ytdStartKey, lt: ytdEndKey }
					}
				}),
				api.db.leave_requests.count({
					where: {
						norbital_approval_id: { isNull: true },
						from_date: { gte: ytdStartKey, lt: ytdEndKey }
					}
				}),
				api.db.leave_requests.count(),
				api.db.query.leave_requests.findMany({
					where: { from_date: { gte: ytdStartKey, lt: ytdEndKey } },
					columns: { norbital_id: true },
					limit: 5000
				}),
				approvalQuery,
				...historyYears.map((year) =>
					api.db.leave_requests.count({
						where: { from_date: { gte: `${year}-01-01`, lt: `${year + 1}-01-01` } }
					})
				)
			]);
			const recordIds = new Set(ytdRows.map((row) => row.norbital_id));
			const duration = approvalDurationHours(approvalRows, collectionName, ytdStart, recordIds);
			const trendValues = yearCounts.map(Number);
			const fittedValues = linearTrend(trendValues);
			return {
				subject,
				as_of_date: now.toISOString().slice(0, 10),
				total,
				summary: {
					ytd_pending: pending,
					ytd_approved: approved,
					average_approval_hours: duration.average,
					approval_sample_size: duration.sampleSize
				},
				annual_trend: historyYears.map((year, index) => ({
					year: String(year),
					applications: trendValues[index] ?? 0,
					regression: fittedValues[index] ?? 0
				}))
			};
		}

		const [pending, approved, total, ytdRows, approvalRows, ...yearCounts] = await Promise.all([
			api.db.component_entries.count({
				where: {
					norbital_approval_id: { isNotNull: true },
					RAW: (table, { sql }) =>
						sql`${table.origin}->>'kind' = 'CLAIM' AND (${table.origin}->>'incurred_on')::date >= ${ytdStartKey}::date AND (${table.origin}->>'incurred_on')::date < ${ytdEndKey}::date`
				}
			}),
			api.db.component_entries.count({
				where: {
					norbital_approval_id: { isNull: true },
					RAW: (table, { sql }) =>
						sql`${table.origin}->>'kind' = 'CLAIM' AND (${table.origin}->>'incurred_on')::date >= ${ytdStartKey}::date AND (${table.origin}->>'incurred_on')::date < ${ytdEndKey}::date`
				}
			}),
			api.db.component_entries.count({
				where: { RAW: (table, { sql }) => sql`${table.origin}->>'kind' = 'CLAIM'` }
			}),
			api.db.query.component_entries.findMany({
				where: {
					RAW: (table, { sql }) =>
						sql`${table.origin}->>'kind' = 'CLAIM' AND (${table.origin}->>'incurred_on')::date >= ${ytdStartKey}::date AND (${table.origin}->>'incurred_on')::date < ${ytdEndKey}::date`
				},
				columns: { norbital_id: true },
				limit: 5000
			}),
			approvalQuery,
			...historyYears.map((year) =>
				api.db.component_entries.count({
					where: {
						RAW: (table, { sql }) =>
							sql`${table.origin}->>'kind' = 'CLAIM' AND (${table.origin}->>'incurred_on')::date >= ${`${year}-01-01`}::date AND (${table.origin}->>'incurred_on')::date < ${`${year + 1}-01-01`}::date`
					}
				})
			)
		]);
		const recordIds = new Set(ytdRows.map((row) => row.norbital_id));
		const duration = approvalDurationHours(approvalRows, collectionName, ytdStart, recordIds);
		const trendValues = yearCounts.map(Number);
		const fittedValues = linearTrend(trendValues);

		return {
			subject,
			as_of_date: now.toISOString().slice(0, 10),
			total,
			summary: {
				ytd_pending: pending,
				ytd_approved: approved,
				average_approval_hours: duration.average,
				approval_sample_size: duration.sampleSize
			},
			annual_trend: historyYears.map((year, index) => ({
				year: String(year),
				applications: trendValues[index] ?? 0,
				regression: fittedValues[index] ?? 0
			}))
		};
	}
});
