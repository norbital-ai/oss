import { defineAutomation } from '@norbital-ai/pod/authoring';
import type { Api } from './$types.js';

export default defineAutomation(
	{ trigger: { collection: 'user', event: 'created' } },
	async (api: Api, { scope }) => {
		const user = scope.incoming_record;
		await api.db.activities.create({
			regarding_type: 'accounts',
			regarding_id: user.norbital_id,
			type: 'note',
			subject: 'User onboarded',
			description: `New user ${user.name ?? user.email} joined the workspace.`,
			owner_id: user.norbital_id
		});
		return { user_id: user.norbital_id };
	}
);
