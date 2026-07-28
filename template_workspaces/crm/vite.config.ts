import { defineConfig } from 'vite';
import { pod } from '@norbital-ai/pod/vite';

export default defineConfig({ plugins: [pod()] });
