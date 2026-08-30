// jf-ai-dlc frontend build config. Builds upstream/collab/frontend unchanged
// except for one swap: the Cognito/Amplify auth module is redirected to our
// Keycloak/OIDC implementation (overlay/frontend/auth.ts). upstream/ stays
// pristine — no patch, no edited source.
//
//   vite build --config overlay/frontend/vite.config.jf.ts --outDir <dir>
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Run from the frontend dir (`cd upstream/collab/frontend && vite --config …`).
// Paths are derived from cwd so this config works whether it is loaded from
// overlay/ or copied into the frontend dir (the Docker build copies it in so
// its `vite` / `@vitejs/plugin-react` imports resolve against node_modules).
const frontendDir = process.cwd();
const authOverlay = path.resolve(frontendDir, '../../../overlay/frontend/auth.ts');

// Redirect every import that resolves to the frontend's services/auth module
// to our overlay — regardless of how it's specified. We let Vite resolve the
// import normally, then swap when the absolute target is the real auth.ts.
const AUTH_TARGET = path.resolve(frontendDir, 'src/services/auth.ts').replace(/\\/g, '/');
const swapAuthModule = (): Plugin => ({
  name: 'jf-swap-auth-module',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!importer || source === authOverlay) return null;
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    if (resolved && resolved.id.replace(/\\/g, '/') === AUTH_TARGET) return authOverlay;
    return null;
  },
});

export default defineConfig({
  root: frontendDir,
  plugins: [swapAuthModule(), react()],
  build: { target: 'es2022', emptyOutDir: true },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(process.env.VITE_APP_VERSION || '0.0.0'),
  },
  resolve: {
    alias: {
      '@': path.resolve(frontendDir, 'src'),
    },
  },
});
