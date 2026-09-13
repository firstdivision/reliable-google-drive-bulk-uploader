import { defineConfig } from 'vite';

export default defineConfig({
  root: 'phase4',
  base: '/app/',
  plugins: [{
    name: 'local-development-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
        .replace('connect-src https:', "connect-src 'self' ws://127.0.0.1:* ws://localhost:* https:");
    },
  }],
  build: { outDir: '../dist/app', emptyOutDir: true, target: 'es2022' },
});