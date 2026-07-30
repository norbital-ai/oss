import { z } from 'zod';
import {
	ApprovalConfigSchema,
	ApprovalRequestLockedRecordRefSchema,
	ApprovalRequestStatusSchema,
	ApprovalRequestStepNodeSchema,
	type TApprovalRequest,
	type TApprovalRequestStepNode
} from '@norbital-ai/platform-utils/system/types';

const _TeamWithMembersZod = z.object({
	norbital_id: z.string(),
	name: z.string(),
	description: z.string().nullable(),
	is_active: z.boolean(),
	parent_id: z.string().nullable(),
	team_members: z.array(z.unknown())
});

export const ApprovalRequestResolvedSchema = z.object({
	norbital_id: z.string(),
	label: z.string(),
	approval_config_id: z.string(),
	collection_name: z.string(),
	requestor: z.string(),
	status: ApprovalRequestStatusSchema,
	approval_step_nodes: z.array(z.unknown()),
	locked_record_refs: z.array(ApprovalRequestLockedRecordRefSchema),
	organization_id: z.string().optional(),
	created_at: z.string().optional(),
	updated_at: z.string().optional(),
	approval_config: ApprovalConfigSchema,
	teams: z.array(_TeamWithMembersZod)
});

const ApprovalStepStackSchema = z.array(ApprovalRequestStepNodeSchema);
const ApprovalStepStacksSchema = z.array(ApprovalStepStackSchema);

const ApprovalStepNodesInputSchema = z
	.union([
		z.string().transform((raw, ctx) => {
			try {
				// stupidity:allow R6b -- the transform pipes parsed JSON into ApprovalStepStacksSchema.
				const parsed: unknown = JSON.parse(raw);
				return parsed;
			} catch {
				ctx.addIssue({ code: 'custom', message: 'Invalid approval_step_nodes JSON' });
				return z.NEVER;
			}
		}),
		z.unknown()
	])
	.pipe(ApprovalStepStacksSchema);

export function parseApprovalStepStacks(raw: unknown): TApprovalRequestStepNode[][] {
	return ApprovalStepNodesInputSchema.parse(raw);
}

/** PG drivers return timestamptz as Date; normalize before Zod validates. */
const approvalTimestampField = z.preprocess((value) => {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'string') return value;
	return value;
}, z.string());

export const ApprovalRequestRowSchema = z.object({
	norbital_id: z.string(),
	organization_id: z.string(),
	label: z.string(),
	approval_config_id: z.string(),
	collection_name: z.string(),
	status: ApprovalRequestStatusSchema,
	approval_step_nodes: ApprovalStepStacksSchema,
	locked_record_refs: z.array(ApprovalRequestLockedRecordRefSchema),
	closed_at: z.preprocess(
		(value) => (value instanceof Date ? value.toISOString() : value),
		z.string().nullable()
	),
	norbital_created_at: approvalTimestampField,
	norbital_updated_at: approvalTimestampField,
	norbital_sys_period: z.string(),
	norbital_row_version: z.number(),
	norbital_approval_id: z.string().nullable(),
	requestor: z.array(z.object({ record_id: z.string() }))
});

export function approvalRequestFromRow(row: unknown): TApprovalRequest {
	return ApprovalRequestRowSchema.parse(row);
}
