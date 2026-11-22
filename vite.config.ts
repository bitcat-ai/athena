import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ command }) => ({
  root: 'src/renderer',
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'workbench-development-csp',
      transformIndexHtml(html) {
        return command === 'serve'
          ? html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
          : html;
      },
    },
  ],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'src/renderer/index.html'),
        share: resolve(import.meta.dirname, 'src/renderer/share.html'),
        terminal: resolve(import.meta.dirname, 'src/renderer/terminal.html'),
      },
    },
  },
}));
