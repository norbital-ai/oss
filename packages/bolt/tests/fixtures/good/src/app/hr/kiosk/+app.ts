import { app } from '../../../../../../../src/index.ts';

export default app({
	title: 'Kiosk',
	description: 'Clock in',
	icon: 'clock',
	pages: { clock: { title: 'Clock', portal: true } }
});
