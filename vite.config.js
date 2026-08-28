import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  base: './',
  plugins: [basicSsl()],
  server: {
    host: true,
    port: 5173
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 5000
  },
  optimizeDeps: {
    include: ['aframe']
  }
});
