// ESLint flat config (no plugins needed): catches undefined names and dead imports.
const browser = Object.fromEntries([
  'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'indexedDB', 'fetch', 'URL', 'URLSearchParams',
  'Blob', 'File', 'FormData', 'Image', 'ImageData', 'TextEncoder', 'TextDecoder', 'AbortController', 'DataView', 'crypto',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'console',
  'Worker', 'self', 'caches', 'createImageBitmap', 'ResizeObserver', 'MutationObserver', 'Node', 'HTMLElement', 'performance',
  'devicePixelRatio', 'globalThis', 'structuredClone', 'queueMicrotask', 'getComputedStyle', 'matchMedia', 'alert', 'atob', 'btoa',
].map((k) => [k, 'readonly']));
const node = Object.fromEntries(['process', 'Buffer', '__dirname'].map((k) => [k, 'readonly']));

export default [
  { ignores: ['node_modules/**', 'server/**'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...browser, ...node } },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-const-assign': 'error',
      'no-use-before-define': ['error', { functions: false, classes: false, variables: false }],
      eqeqeq: ['error', 'smart'],
    },
  },
];
