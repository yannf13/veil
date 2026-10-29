import { detect } from '@veil/engine';
import { describe, expect, it } from 'vitest';
import { combine, EMPTY_USER } from '../src/settings';
import { parsePatterns } from '../src/popup-patterns';

const kinds = (text: string, s = combine(EMPTY_USER, null)) => detect(text, s.policy.options).map((f) => f.type);

describe('settings', () => {
  it('your organization can lock Veil on', () => {
    const user = { ...EMPTY_USER, off: ['claude.ai'], disabled: ['EMAIL'] };
    const locked = combine(user, { allowTurningOff: false });
    expect(locked.isOn('claude.ai')).toBe(true);
    expect(kinds('jane@acme.com', locked)).toEqual(['EMAIL']);
    const free = combine(user, null);
    expect(free.isOn('claude.ai')).toBe(false);
    expect(kinds('jane@acme.com', free)).toEqual([]);
  });

  it("adds your organization's patterns and allowed values to yours", () => {
    const s = combine(
      { ...EMPTY_USER, patterns: [{ type: 'MINE', pattern: 'MINE-\\d+' }] },
      { patterns: [{ type: 'CLIENT', pattern: 'CL-\\d{5}' }], allow: ['*@acme.com'] },
    );
    expect(kinds('CL-12345 MINE-7 jane@acme.com bob@other.org', s)).toEqual(['CLIENT', 'MINE', 'EMAIL']);
  });

  it('reads pattern lines from the popup', () => {
    expect(parsePatterns('project PRJ-\\d{4}\n\n  TICKET  SEC-\\d+ \nBROKEN')).toEqual([
      { type: 'PROJECT', pattern: 'PRJ-\\d{4}' },
      { type: 'TICKET', pattern: 'SEC-\\d+' },
      { type: 'BROKEN', pattern: '' },
    ]);
  });
});
