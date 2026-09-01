import { defineModel, text } from '@norbital-ai/bolt/authoring';

export default defineModel({ subject: text().notNull() }, { recordLabel: 'subject' });
