import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

export const photoSourceSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('workspace_upload') }).strict(),
	z
		.object({
			kind: z.literal('channel'),
			provider: z.string().min(1),
			conversation_id: z.string().min(1),
			message_id: z.string().min(1),
			attachment_id: z.string().min(1),
			sender_id: z.string().min(1),
			sent_at: z.string().datetime().nullable()
		})
		.strict()
]);

export default defineCustomType({
	name: 'photo_source',
	description:
		'Where a photo came from: either a workspace upload, or the messaging conversation, message, attachment and sender that delivered it.',
	schema: photoSourceSchema
});
