import { defineModel, enums, file, text, timestamp, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		quote_id: uuid().notNull(),
		variant: enums(['advance', 'credit']),
		status: enums(['unstamped', 'counterparty_stamped', 'acknowledged', 'voided']),
		binding_hash: text({ search: true }).notNull(),
		generated_file: file({ mimeTypes: ['application/pdf'] }),
		counterparty_file: file({
			mimeTypes: ['application/pdf', 'image/jpeg', 'image/png']
		}),
		share_token_hash: text(),
		share_expires_at: timestamp(),
		share_revoked_at: timestamp(),
		acknowledged_at: timestamp(),
		void_reason: text(),
		owner_id: uuid().notNull()
	},
	{
		description:
			'The contract lifecycle of a confirmed quote: the workspace generates the document, the counterparty returns a stamped copy, and the owner acknowledges it. `binding_hash` fingerprints the quote substance at generation, so a quote edited afterwards can never silently ride under an acknowledged contract. One active signing per quote; re-signing voids the predecessor.',
		recordLabel: 'binding_hash',
		icon: 'lucide:file-signature',
		indexes: [{ columns: ['quote_id'] }, { columns: ['status'] }]
	}
);
