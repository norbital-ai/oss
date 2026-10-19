import { defineApp } from '@norbital-ai/app-shell';

/**
 * A stakeholder app on a shared workspace: cleaners open straight into the workspace's `cleaner` app. Sibling apps
 * (customers, supervisors) are separate directories with their own id, icon and `workspace` path.
 */
export default defineApp({
	id: 'com.mericlean.cleaner',
	name: 'Mericlean Cleaner',
	description: 'Today’s jobs, routes and check-ins for Mericlean cleaners.',
	version: '1.0.0',
	build: 1,
	icon: './icon.png',
	splash: { color: '#0B6E4F' },
	themeColor: '#0B6E4F',
	host: 'https://apps.norbital.ai',
	workspace: 'https://apps.norbital.ai/mericlean/apps/cleaner',
	capabilities: {
		location: {
			background: true,
			purpose:
				'Share your location with Mericlean while you are on a job, including when the phone is locked.'
		},
		notifications: true,
		camera: { purpose: 'Photograph completed work and scan check-in codes.' }
	},
	ios: { teamId: 'ABCDE12345', apsEnvironment: 'production' },
	android: {}
});
