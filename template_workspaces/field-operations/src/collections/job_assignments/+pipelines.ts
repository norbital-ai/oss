import { isCalendarDate } from '@norbital-ai/std/date';
import { z } from 'zod';
import { shiftCalendarDate } from '../../lib/calendar.js';
import {
	contractorSatisfiesCertificationRequirements,
	missingCertificationIds
} from '../../lib/certification-eligibility.js';
import type { Pipelines } from './$types.js';

const rowSchema = z.object({
	site_name: z.string().trim().min(1),
	scheduled_for: z.string().trim().min(1),
	job_title: z.string().trim().min(1),
	contractor_company: z.string().trim().min(1),
	summary: z.string().optional()
});

const importSchema = z.object({
	week_start: z.string().trim().min(1),
	rows: z.array(rowSchema).min(1)
});

const QUERY_LIMIT = 5_000;

function formatNamedList(items: readonly string[]): string {
	return items.map((item) => `• ${item}`).join('\n');
}

function normalizeKey(value: string): string {
	return value.trim().toLowerCase();
}

function dateInWeek(scheduledFor: string, weekStart: string, weekEnd: string): boolean {
	return scheduledFor >= weekStart && scheduledFor <= weekEnd;
}

function rowLabel(row: z.infer<typeof rowSchema>, index: number): string {
	return `Row ${index + 1}: ${row.job_title} at ${row.site_name} on ${row.scheduled_for}`;
}

export default {
	import: {
		input: importSchema,
		handler: async ({ input }, api) => {
			const { week_start: weekStart, rows } = importSchema.parse(input);

			if (!isCalendarDate(weekStart)) {
				throw new Error('week_start must be a calendar date (YYYY-MM-DD).');
			}

			const weekEnd = shiftCalendarDate(weekStart, 6);
			const invalidDates = [
				...new Set(
					rows.filter((row) => !isCalendarDate(row.scheduled_for)).map((row) => row.scheduled_for)
				)
			];
			if (invalidDates.length > 0) {
				throw new Error(
					`These scheduled_for values are not valid calendar days (YYYY-MM-DD):\n${formatNamedList(invalidDates)}`
				);
			}

			const outsideWeek = rows
				.filter((row) => !dateInWeek(row.scheduled_for, weekStart, weekEnd))
				.map((row, index) => rowLabel(row, index));
			if (outsideWeek.length > 0) {
				throw new Error(
					`Every scheduled_for must fall within the week starting ${weekStart}:\n${formatNamedList(outsideWeek)}`
				);
			}

			const scheduledDates = [...new Set(rows.map((row) => row.scheduled_for))];
			const [sites, contractors, jobs, existingAssignments] = await Promise.all([
				api.db.query.sites.findMany({
					columns: { norbital_id: true, name: true },
					limit: QUERY_LIMIT
				}),
				api.db.query.contractor_profiles.findMany({
					columns: { norbital_id: true, company_name: true },
					limit: QUERY_LIMIT
				}),
				api.db.query.jobs.findMany({
					where: { scheduled_for: { in: scheduledDates } },
					columns: {
						norbital_id: true,
						site_id: true,
						title: true,
						scheduled_for: true,
						status: true
					},
					limit: QUERY_LIMIT
				}),
				api.db.query.job_assignments.findMany({
					columns: { norbital_id: true, job_id: true },
					limit: QUERY_LIMIT
				})
			]);

			const siteByName = new Map(sites.map((site) => [normalizeKey(site.name), site]));
			const contractorByCompany = new Map(
				contractors.map((contractor) => [normalizeKey(contractor.company_name), contractor])
			);
			const assignmentByJobId = new Map(
				existingAssignments.map((assignment) => [assignment.job_id, assignment])
			);
			const jobsByMatchKey = new Map<string, (typeof jobs)[number][]>();
			for (const job of jobs) {
				const key = `${job.site_id}\t${job.scheduled_for}\t${normalizeKey(job.title)}`;
				const matches = jobsByMatchKey.get(key) ?? [];
				matches.push(job);
				jobsByMatchKey.set(key, matches);
			}

			const problems: string[] = [];
			const resolvedRows: Array<{
				row: z.infer<typeof rowSchema>;
				jobId: string;
				contractorId: string;
			}> = [];
			const seenJobIds = new Set<string>();

			for (const [index, row] of rows.entries()) {
				const label = rowLabel(row, index);
				const site = siteByName.get(normalizeKey(row.site_name));
				if (site == null) {
					problems.push(`${label}: unknown site "${row.site_name}".`);
					continue;
				}

				const contractor = contractorByCompany.get(normalizeKey(row.contractor_company));
				if (contractor == null) {
					problems.push(`${label}: unknown contractor "${row.contractor_company}".`);
					continue;
				}

				const matchKey = `${site.norbital_id}\t${row.scheduled_for}\t${normalizeKey(row.job_title)}`;
				const matchingJobs = (jobsByMatchKey.get(matchKey) ?? []).filter(
					(job) => job.status === 'unassigned' && !assignmentByJobId.has(job.norbital_id)
				);
				if (matchingJobs.length === 0) {
					problems.push(
						`${label}: no unassigned job found. Create the job first, then import again.`
					);
					continue;
				}
				if (matchingJobs.length > 1) {
					problems.push(
						`${label}: more than one unassigned job matches this site, date, and title.`
					);
					continue;
				}

				const job = matchingJobs[0]!;
				if (seenJobIds.has(job.norbital_id)) {
					problems.push(`${label}: this job appears more than once in the import.`);
					continue;
				}
				seenJobIds.add(job.norbital_id);
				resolvedRows.push({
					row,
					jobId: job.norbital_id,
					contractorId: contractor.norbital_id
				});
			}

			if (problems.length > 0) {
				throw new Error(`The roster could not be imported:\n${formatNamedList(problems)}`);
			}

			const jobIds = resolvedRows.map((entry) => entry.jobId);
			const contractorIds = [...new Set(resolvedRows.map((entry) => entry.contractorId))];
			const [requirements, holdings, certificationTypes] = await Promise.all([
				api.db.query.job_certification_requirements.findMany({
					where: { job_id: { in: jobIds } },
					limit: QUERY_LIMIT
				}),
				api.db.query.contractor_certifications.findMany({
					where: { contractor_profile_id: { in: contractorIds } },
					limit: QUERY_LIMIT
				}),
				api.db.query.certification_types.findMany({
					columns: { norbital_id: true, name: true },
					limit: QUERY_LIMIT
				})
			]);
			const requirementsByJob = new Map<string, typeof requirements>();
			for (const requirement of requirements) {
				const jobRequirements = requirementsByJob.get(requirement.job_id) ?? [];
				jobRequirements.push(requirement);
				requirementsByJob.set(requirement.job_id, jobRequirements);
			}
			const holdingsByContractor = new Map<string, typeof holdings>();
			for (const holding of holdings) {
				const contractorHoldings = holdingsByContractor.get(holding.contractor_profile_id) ?? [];
				contractorHoldings.push(holding);
				holdingsByContractor.set(holding.contractor_profile_id, contractorHoldings);
			}
			const certificationNameById = new Map(
				certificationTypes.map((certification) => [certification.norbital_id, certification.name])
			);

			const certificationProblems: string[] = [];
			for (const [index, entry] of resolvedRows.entries()) {
				const jobRequirements = requirementsByJob.get(entry.jobId) ?? [];
				const contractorHoldings = holdingsByContractor.get(entry.contractorId) ?? [];
				if (contractorSatisfiesCertificationRequirements(contractorHoldings, jobRequirements)) {
					continue;
				}
				const missingIds = missingCertificationIds(contractorHoldings, jobRequirements);
				const missingNames = missingIds.map(
					(certificationId) => certificationNameById.get(certificationId) ?? '—'
				);
				certificationProblems.push(
					`${rowLabel(entry.row, index)}: ${entry.row.contractor_company} is missing ${missingNames.join(', ')}.`
				);
			}
			if (certificationProblems.length > 0) {
				throw new Error(
					`These contractors are not certified for their assigned jobs:\n${formatNamedList(certificationProblems)}`
				);
			}

			return resolvedRows.map((entry) => ({
				job_id: entry.jobId,
				contractor_profile_id: entry.contractorId,
				status: 'dispatched' as const,
				site_identity_unverified: true,
				...(entry.row.summary ? { summary: entry.row.summary } : {})
			}));
		}
	}
} satisfies Pipelines;
