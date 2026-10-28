import { describe, expect, it } from 'vitest';
import { fakeToken, found } from './helpers.js';

describe('emails', () => {
  it('finds an address in a sentence', () => {
    expect(found('Contact me at jane.doe@example.org please')).toEqual([['EMAIL', 'jane.doe@example.org']]);
  });
  it('ignores retina asset names', () => {
    expect(found('<img src="logo@2x.png">')).toEqual([]);
  });
});

describe('IBANs', () => {
  it('finds a spaced German IBAN without swallowing the next words', () => {
    expect(found('IBAN: DE89 3704 0044 0532 0130 00 thanks')).toEqual([['IBAN', 'DE89 3704 0044 0532 0130 00']]);
  });
  it('finds compact French and British IBANs', () => {
    expect(found('FR1420041010050500013M02606')).toEqual([['IBAN', 'FR1420041010050500013M02606']]);
    expect(found('pay to GB82 WEST 1234 5698 7654 32.')).toEqual([['IBAN', 'GB82 WEST 1234 5698 7654 32']]);
  });
  it('rejects a wrong checksum', () => {
    expect(found('DE89 3704 0044 0532 0130 01').filter(([t]) => t === 'IBAN')).toEqual([]);
  });
});

describe('payment cards', () => {
  it('finds Luhn-valid Visa and Amex numbers', () => {
    expect(found('card 4111 1111 1111 1111 please')).toEqual([['CARD', '4111 1111 1111 1111']]);
    expect(found('amex 3782 822463 10005')).toEqual([['CARD', '3782 822463 10005']]);
  });
  it('stops at the card when an expiry date follows', () => {
    expect(found('4111111111111111 12 26')).toEqual([['CARD', '4111111111111111']]);
  });
  it('rejects a failing Luhn checksum', () => {
    expect(found('4111 1111 1111 1112')).toEqual([]);
  });
});

describe('phone numbers', () => {
  it.each([
    '+33 6 12 34 56 78',
    '06 12 34 56 78',
    '+49 681 302-0',
    '0171 1234567',
    '(415) 555-0132',
  ])('finds %s', (phone) => {
    expect(found(`call ${phone} today`)).toEqual([['PHONE', phone]]);
  });
  it('ignores dates, times, versions and year ranges', () => {
    expect(found('Released 2026-10-28 at 10:30, version 1.2.3, covering 2019-2024.')).toEqual([]);
  });
});

describe('IP addresses', () => {
  it('finds a private address but not loopback', () => {
    expect(found('db at 192.168.1.20, cache at 127.0.0.1')).toEqual([['IP', '192.168.1.20']]);
  });
  it('ignores five-part version strings', () => {
    expect(found('build 1.2.3.4.5')).toEqual([]);
  });
});

describe('API keys and tokens', () => {
  it.each([
    ['AWS', 'AKIAIOSFODNN7EXAMPLE'],
    ['GitHub', 'ghp_' + fakeToken(36)],
    ['OpenAI', 'sk-proj-' + fakeToken(40)],
    ['Anthropic', 'sk-ant-api03-' + fakeToken(60)],
    ['Stripe', 'sk_live_' + fakeToken(24)],
    ['Google', 'AIza' + fakeToken(35)],
    ['Slack', 'xoxb-123456789012-' + fakeToken(24)],
  ])('finds a %s key', (_vendor, key) => {
    expect(found(`key: ${key}`)).toEqual([['API_KEY', key]]);
  });
  it('ignores a long lowercase slug that starts with sk-', () => {
    expect(found('use sk-learn-style-long-identifier-name here')).toEqual([]);
  });
  it('finds a JWT', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + fakeToken(43);
    expect(found(`Authorization: Bearer ${token}`)).toEqual([['JWT', token]]);
  });
  it('finds a whole private key block', () => {
    const block = '-----BEGIN ' + 'RSA PRIVATE KEY-----\n' + fakeToken(64) + '\n-----END RSA PRIVATE KEY-----';
    expect(found(`here:\n${block}\n`)).toEqual([['PRIVATE_KEY', block]]);
  });
});

describe('secrets in assignments and prose', () => {
  it('masks only the password of a connection string', () => {
    expect(found('postgres://admin:S3cr3tPass@db.internal:5432/app')).toEqual([['SECRET', 'S3cr3tPass']]);
  });
  it('finds values assigned to secret-named keys', () => {
    expect(found('DB_PASSWORD=hunter22x')).toEqual([['SECRET', 'hunter22x']]);
    expect(found('{"client_secret": "abc123DEF456"}')).toEqual([['SECRET', 'abc123DEF456']]);
  });
  it.each([
    'password = process.env.DB_PASSWORD',
    'token = getToken()',
    'API_KEY=<YOUR_KEY>',
    'password: ********',
    'max_tokens = 4096',
    'secret_name = config.secretName',
  ])('leaves references and placeholders alone: %s', (line) => {
    expect(found(line)).toEqual([]);
  });
  it.each([
    ['my password is Soleil2024!', 'Soleil2024!'],
    ['mon mot de passe : Lyon#2026', 'Lyon#2026'],
    ['Das Passwort ist Saar-2026', 'Saar-2026'],
  ])('finds a password written in prose: %s', (text, secret) => {
    expect(found(text)).toEqual([['SECRET', secret]]);
  });
  it('ignores ordinary sentences about passwords', () => {
    expect(found('A password is required. Reset your password tomorrow.')).toEqual([]);
  });
});

describe('high-entropy tokens', () => {
  it('finds an unknown random token', () => {
    const token = fakeToken(40);
    expect(found(`here you go: ${token}`)).toEqual([['SECRET', token]]);
  });
  it('ignores git hashes, UUIDs, identifiers and paths', () => {
    const text = [
      'commit 3f786850e387550fdab836ed7e6dc881de23001b',
      'id 123e4567-e89b-12d3-a456-426614174000',
      'call handleUserProfileUpdateRequest2024 now',
      'see src/components/UserProfileCard2.tsx',
    ].join('\n');
    expect(found(text)).toEqual([]);
  });
});

describe('no false positives on ordinary text', () => {
  it('leaves prose and code untouched', () => {
    const text = [
      'We shipped version 2.4.1 on 2026-10-28 at 14:30, three days late.',
      'Le budget est de 12 500 € pour 7 personnes, livraison le 15/11.',
      'Die Besprechung beginnt um 9 Uhr in Raum 2.14.',
      'for (let i = 0; i < 1000000; i++) { total += prices[i] * 1.2; }',
    ].join('\n');
    expect(found(text)).toEqual([]);
  });
});
