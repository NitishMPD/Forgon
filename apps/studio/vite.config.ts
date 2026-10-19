import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: { studio: 'index.html', play: 'play.html' } } },
  server: { port: 5173, strictPort: true, cors: { origin: ['null', 'http://127.0.0.1:5173', 'http://localhost:5173'] } },
});
