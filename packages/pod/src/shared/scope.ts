import { z } from 'zod';

export type {
	TBaseScope,
	TNorbitalDBRecord,
	TScopeOrganization,
	TScopeRequestor,
	TUserInfo
} from '@norbital-ai/platform-utils/scope/types';

const stackItemExpandSchema = z.object({}).passthrough();
export const ContextNavStackItemSchema = z.object({
	collection_name: z.string(),
	record_id: z.string(),
	node_id: z.string(),
	with: stackItemExpandSchema.optional()
});

export const BreadcrumbItemSchema = z.object({
	label: z.string(),
	warn: z.boolean().optional()
});

export type ContextNavStackItem = z.infer<typeof ContextNavStackItemSchema>;
export type TBreadcrumbItem = z.infer<typeof BreadcrumbItemSchema>;
