import { describe, expect, it } from 'vitest';
import { found } from './helpers.js';

/** Everyday material people paste into AI tools. None of it should be masked except where noted. */
const samples: Record<string, string> = {
  'stack trace': `TypeError: Cannot read properties of undefined (reading 'map')
    at UserList (webpack-internal:///./src/components/UserList.tsx:42:18)
    at renderWithHooks (node_modules/react-dom/cjs/react-dom.development.js:16305:18)`,
  'package.json with an integrity hash': `{
  "name": "my-app", "version": "1.4.12",
  "dependencies": { "react": "^18.3.1", "next": "14.2.15" },
  "integrity": "sha512-Zw2Pm8zR7aPrbHqU5JvOjFvXhC0bD0fPpZq3l1oQ8z2Q0Gz1c8X5bY3W3l6dq2HhYkA3pN9w1b0cM9a4d1Fv7Q=="
}`,
  'docker compose with an env reference': `services:
  db:
    image: postgres:16.4
    ports: ["5432:5432"]
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}`,
  css: `.btn { color: #1a2b3c; padding: 0.75rem 1.5rem; transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1); }`,
  'markdown price table': `| Plan | Price | Seats |\n|---|---|---|\n| Pro | 12,99 € | 1 |\n| Team | 1 299,00 € | 25 |`,
  'French letter': `Bonjour Madame, suite à notre échange du 03/10/2026, je vous confirme le rendez-vous du 12 novembre à 14h30, salle 204. Référence dossier : 2026-AX-00417.`,
  'German invoice': `Rechnung Nr. 2026-1043 vom 28.10.2026, Betrag 1.249,90 EUR, zahlbar bis 11.11.2026.`,
  URLs: `See https://github.com/vercel/next.js/blob/canary/packages/next/src/server/base-server.ts#L1290 and https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s`,
  'TypeScript imports': `import { useCallback, useMemo } from 'react';\nconst QUERY_KEY_USER_PROFILE_SETTINGS = ['user', 'profile', 'settings'] as const;`,
};

describe('realistic content', () => {
  it.each(Object.entries(samples))('leaves %s untouched', (_name, text) => {
    expect(found(text)).toEqual([]);
  });

  it('masks only the internal IP in a log line', () => {
    const log =
      '2026-10-28T19:14:04.001Z WARN retry attempt=2 backoff=1500ms upstream=10.0.3.17:8080 request=7f3a9c2e-1b4d-4e8f-9a6b-2c5d8e1f0a3b';
    expect(found(log)).toEqual([['IP', '10.0.3.17']]);
  });
});
