import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/.superpowers/**',
      '**/artifacts/**',
      '**/output/**',
      '**/.playwright-cli/**',
      '**/public/screen-codecs/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['infra/cloudflare-observability/**/*.mjs'],
    languageOptions: {
      globals: Object.fromEntries([
        'URL', 'AbortSignal', 'Request', 'Response', 'Headers', 'TextEncoder',
        'TextDecoder', 'crypto', 'fetch', 'console', 'setTimeout', 'clearTimeout',
        'WebSocketPair', 'WebSocketRequestResponsePair'
      ].map(name => [name, 'readonly']))
    },
    rules: { 'no-empty': ['error', { allowEmptyCatch: true }] }
  },
  {
    files: ['**/*.{test,spec}.{ts,tsx}'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        expect: 'readonly',
        it: 'readonly'
      }
    }
  }
);
