import { cp } from 'node:fs/promises';

await cp('src/public', 'dist/public', { recursive: true });
console.log('Copied src/public → dist/public');
