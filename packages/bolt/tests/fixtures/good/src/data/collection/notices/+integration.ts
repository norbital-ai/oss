import { integration } from '../../../../../../../src/index.ts';

export default integration('notices', { direction: 'one_way', source: { channel: 'mail', inbound: true }, identity: 'message_id', fields: { subject: 'subject' }, policies: ['sales_rep'] });
