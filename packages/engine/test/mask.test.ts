import { describe, expect, it } from 'vitest';
import { Vault, findPlaceholders, mask, restore } from '../src/index.js';
import { fakeToken } from './helpers.js';

const key = 'sk-proj-' + fakeToken(40);
const message = [
  'Hi, I am Jane (jane.doe@example.org, +33 6 12 34 56 78).',
  `My OpenAI key is ${key} and my IBAN is DE89 3704 0044 0532 0130 00.`,
  'Please reply to jane.doe@example.org.',
].join('\n');

describe('mask', () => {
  it('removes every sensitive value from the text', () => {
    const { text } = mask(message);
    for (const secret of ['jane.doe@example.org', '+33 6 12 34 56 78', key, 'DE89 3704 0044 0532 0130 00']) {
      expect(text).not.toContain(secret);
    }
  });

  it('gives the same value the same placeholder', () => {
    const { text } = mask(message);
    expect(text.match(/\[EMAIL_1\]/g)).toHaveLength(2);
    expect(text).toContain('[PHONE_1]');
    expect(text).toContain('[API_KEY_1]');
    expect(text).toContain('[IBAN_1]');
  });

  it('numbers different values of one kind separately', () => {
    expect(mask('a@example.org and b@example.org').text).toBe('[EMAIL_1] and [EMAIL_2]');
  });

  it('keeps placeholders stable across messages that share a vault', () => {
    const vault = new Vault();
    mask('first: a@example.org', { vault });
    expect(mask('again a@example.org, new b@example.org', { vault }).text).toBe('again [EMAIL_1], new [EMAIL_2]');
  });
});

describe('restore', () => {
  it('round-trips a masked message exactly', () => {
    const { text, vault } = mask(message);
    expect(restore(text, vault)).toBe(message);
  });

  it('restores placeholders inside an AI answer', () => {
    const { vault } = mask(message);
    const answer = 'Sure! I will email [EMAIL_1] and charge [IBAN_1].';
    expect(restore(answer, vault)).toBe(
      'Sure! I will email jane.doe@example.org and charge DE89 3704 0044 0532 0130 00.',
    );
  });

  it('restores markdown-escaped placeholders', () => {
    const { vault } = mask(message);
    expect(restore('Write to \\[EMAIL\\_1\\] using [API\\_KEY\\_1]', vault)).toBe(
      `Write to jane.doe@example.org using ${key}`,
    );
  });

  it('leaves unknown placeholders untouched', () => {
    const { vault } = mask(message);
    expect(restore('See [EMAIL_9] and [NOTE_1]', vault)).toBe('See [EMAIL_9] and [NOTE_1]');
  });
});

describe('findPlaceholders', () => {
  it('locates plain and escaped placeholders and normalizes them', () => {
    const text = 'Mail [EMAIL_1], key \\[API\\_KEY\\_2\\] and [NOTE].';
    expect(findPlaceholders(text)).toEqual([
      { start: 5, end: 14, placeholder: '[EMAIL_1]' },
      { start: 20, end: 35, placeholder: '[API_KEY_2]' },
    ]);
    expect(text.slice(20, 35)).toBe('\\[API\\_KEY\\_2\\]');
  });
});

describe('vault', () => {
  it('survives serialization and keeps numbering', () => {
    const { vault } = mask('a@example.org, b@example.org');
    const revived = Vault.fromJSON(JSON.parse(JSON.stringify(vault)));
    expect(revived.valueOf('[EMAIL_2]')).toBe('b@example.org');
    expect(mask('c@example.org, a@example.org', { vault: revived }).text).toBe('[EMAIL_3], [EMAIL_1]');
  });
});
