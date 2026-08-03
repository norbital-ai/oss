import type { BeforeApi } from '../workspace/hook-api.js';
import { z } from 'zod';

export type TFileAttachment =
	| { name: string; contentType: 'HTML'; content: string }
	| { name: string; contentType: 'PDF'; content: string }
	| { name: string; contentType: 'CSV'; content: unknown }
	| { name: string; contentType: 'XLSX'; content: number[] }
	| { name: string; contentType: 'JSON'; content: unknown }
	| { name: string; contentType: 'TEXT'; content: string }
	| { name: string; contentType: 'BINARY'; content: number[] };

export type TExportAction = {
	label: string;
	attachments: TFileAttachment[];
	metadata?: Record<string, unknown>;
};

export type TExportManifest = TExportAction[];

const attachmentNameSchema = z.string().trim().min(1);
const unknownAttachmentContentSchema: z.ZodType<unknown> = z
	.unknown()
	.refine((content) => content !== undefined, 'Attachment content is required');

export const FileAttachmentSchema: z.ZodType<TFileAttachment> = z.discriminatedUnion(
	'contentType',
	[
		z.object({ name: attachmentNameSchema, contentType: z.literal('HTML'), content: z.string() }),
		z.object({ name: attachmentNameSchema, contentType: z.literal('PDF'), content: z.string() }),
		z.object({
			name: attachmentNameSchema,
			contentType: z.literal('CSV'),
			content: unknownAttachmentContentSchema
		}),
		z.object({
			name: attachmentNameSchema,
			contentType: z.literal('XLSX'),
			content: z.array(z.number().int().min(0).max(255))
		}),
		z.object({
			name: attachmentNameSchema,
			contentType: z.literal('JSON'),
			content: unknownAttachmentContentSchema
		}),
		z.object({ name: attachmentNameSchema, contentType: z.literal('TEXT'), content: z.string() }),
		z.object({
			name: attachmentNameSchema,
			contentType: z.literal('BINARY'),
			content: z.array(z.number().int().min(0).max(255))
		})
	]
);

export const ExportActionSchema: z.ZodType<TExportAction> = z.object({
	label: z.string().trim().min(1),
	attachments: z.array(FileAttachmentSchema),
	metadata: z.record(z.string(), z.unknown()).optional()
});

export const ExportManifestSchema: z.ZodType<TExportManifest> = z.array(ExportActionSchema);

export type CollectionExportPipeline = {
	params: {
		scope: { records: Record<string, unknown>[] };
		collection: { name: string };
	};
	return: Promise<TExportManifest>;
};

export type CollectionImportPipeline = {
	params: {
		scope: { import_data: unknown };
		collection: { name: string };
	};
	return: Promise<Record<string, unknown>[]>;
};

export type CollectionPipelinesDef = {
	readonly import?: (
		ctx: CollectionImportPipeline['params'],
		capabilities: BeforeApi
	) => CollectionImportPipeline['return'];
	readonly export?: (
		ctx: CollectionExportPipeline['params'],
		capabilities: BeforeApi
	) => CollectionExportPipeline['return'];
};
