import { z } from 'zod';
import { ApprovalRequestStepActionSchema } from '@norbital-ai/platform-utils/system/types';

export const ProcessApprovalRequestActionInputSchema = z.object({
	approval_request_id: z.string(),
	action: ApprovalRequestStepActionSchema,
	comments: z.string().nullable(),
	isSupercede: z.boolean()
});

export const WithdrawApprovalRequestInputSchema = z.object({
	approval_request_id: z.string()
});
