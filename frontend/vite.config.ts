import { defineConfig } from 'vite';

// Two pages, not one app: index.html is the landing page and app.html is the
// wallet. Naming both as inputs is what stops Vite treating index.html as the
// only entry and silently dropping the wallet from a production build.
//
// No node: imports here on purpose — it keeps @types/node off the dependency
// list, so `tsc --noEmit` runs against the DOM lib alone and this config stays
// type-checked with everything else.
export default defineConfig({
  // Relative asset URLs, not root-absolute. The extension loads app.html from
  // a chrome-extension:// origin where a leading "/" means the extension root,
  // which happens to work — but only by luck, and it breaks the moment the
  // hosted build moves to a subpath. Relative is correct in both.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { landing: 'index.html', app: 'app.html' },
    },
  },
  server: {
    port: 5173,
    // The UI runs standalone; this is only live once `npm run api` is up in a
    // second terminal. Proxying rather than pointing the browser straight at
    // :8402 keeps everything same-origin, so there is no CORS to configure.
    proxy: { '/api': 'http://localhost:8402' },
  },
});
