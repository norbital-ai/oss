import { kiosk } from '../../../../../../src/index.ts';

export default kiosk('clock', { title: 'Clock', description: 'Clock in', icon: 'clock', auth: 'members', policies: ['kiosk_reader'], pages: { clock: { title: 'Clock' } } });
