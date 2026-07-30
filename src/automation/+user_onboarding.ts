import { defineAutomation } from '@norbital-ai/pod/authoring';

export default defineAutomation(
	{ trigger: { collection: 'user', event: 'created' } },
	async (api, { scope }) => {
		const user = scope.incoming_record;
		await api.db.activities.create({
			regarding_type: 'accounts',
			regarding_id: user.norbital_id,
			type: 'note',
			subject: 'User onboarded',
			description: `New user ${user.name ?? user.email} joined the workspace.`,
			owner_id: user.norbital_id
		});
		await api.sendNotification({
			recipient_user_id: user.norbital_id,
			subject: 'Welcome to the workspace',
			message: `Hi ${user.name ?? user.email}, your CRM workspace is ready and your first activity has been logged for you.`,
			notification_category: 'onboarding'
		});
		return { user_id: user.norbital_id };
	}
);
