import { app } from '../../../../../../src/index.ts';

export default app({
	title: 'Clock',
	description: 'Clock in',
	icon: 'clock',
	audience: 'members',
	shell: 'kiosk',
	policies: ['kiosk_reader'],
	pages: { clock: { title: 'Clock' } }
});
