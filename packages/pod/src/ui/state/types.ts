import type { ManifestCollectionEntry } from '@norbital-ai/platform-utils/manifest/types';
import type {
	TApprovalConfig,
	TApprovalConfigStepNode,
	TApprovalRequest,
	TApprovalRequestStepNode,
	TChatSession,
	TMutationActionKey,
	TPolicy
} from '@norbital-ai/platform-utils/system/types';
import {
	BreadcrumbItemSchema,
	ContextNavStackItemSchema,
	type TBaseScope,
	type TNorbitalDBRecord,
	type TScopeOrganization,
	type TScopeRequestor,
	type TUserInfo
} from '$lib/shared/scope.js';
import { z } from 'zod';

export type {
	TApprovalConfig,
	TApprovalConfigStepNode,
	TApprovalRequest,
	TApprovalRequestStepNode,
	TChatSession,
	TMutationActionKey
};
export type { TBaseScope, TNorbitalDBRecord, TScopeOrganization, TScopeRequestor, TUserInfo };

export const ViewModeSchema = z.enum(['page', 'sidesheet']);
const stackItemExpandSchema = z.object({}).passthrough();
export const NavStackItemSchema = z.object({
	collection_name: z.string(),
	record_id: z.string(),
	node_id: z.string(),
	viewMode: ViewModeSchema,
	with: stackItemExpandSchema.optional()
});

export { ContextNavStackItemSchema, BreadcrumbItemSchema };

type TNavStateShape = {
	stack: Array<z.infer<typeof NavStackItemSchema>>;
};

const _NorbitalDBRecordZod = z.record(z.string(), z.unknown());

export const DynamicApplicationContextResolvedSchema = z.object({
	selected_record: _NorbitalDBRecordZod.nullable(),
	bread_crumbs: z.array(BreadcrumbItemSchema)
});

const _BaseNavStateZod = z.object({
	stack: z.array(NavStackItemSchema)
});

function validateNavStateSemantics(nav: TNavStateShape): void {
	if (nav.stack.length === 0) {
		throw new Error('Navigation stack must contain at least one item.');
	}
}

export const NavStateSchema = _BaseNavStateZod.superRefine((data, ctx) => {
	try {
		validateNavStateSemantics(data);
	} catch (err) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: err instanceof Error ? err.message : 'Invalid nav state'
		});
	}
});

export type { TBreadcrumbItem, ContextNavStackItem } from '$lib/shared/scope.js';
export type ViewMode = z.infer<typeof ViewModeSchema>;
export type NavStackItem = z.infer<typeof NavStackItemSchema>;
export type NavState = z.infer<typeof NavStateSchema>;
export type TDynamicApplicationContextResolvedState = z.infer<
	typeof DynamicApplicationContextResolvedSchema
>;

export type TDynamicApplicationScopeData = TBaseScope & TDynamicApplicationContextResolvedState;

export function isSameNavStackItem(a: NavStackItem, b: NavStackItem): boolean {
	return (
		a.collection_name === b.collection_name &&
		a.record_id === b.record_id &&
		a.node_id === b.node_id
	);
}
