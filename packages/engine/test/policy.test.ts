import { describe, expect, it } from 'vitest';
import { auditTotals, compilePolicy, describeFindings, detect, mask, recordAudit, restore } from '../src/index.js';
import type { AuditLog } from '../src/index.js';

const types = (text: string, policy = compilePolicy()) => detect(text, policy.options).map((f) => [f.type, f.value]);

describe('policy', () => {
  it('turns kinds off', () => {
    const policy = compilePolicy({ disabled: ['ip', 'NAME'] });
    expect(types('Jane Doe at 10.1.2.3, jane@acme.com', policy)).toEqual([['EMAIL', 'jane@acme.com']]);
  });

  it('leaves allowed values visible: exact (any case), wildcard and regex', () => {
    const policy = compilePolicy({ allow: ['support@acme.com', '*@example.org', '/^10\\.0\\./'] });
    const text = 'Write to SUPPORT@acme.com or bob@example.org, not jane@acme.com; hosts 10.0.0.7 and 192.168.1.9';
    expect(types(text, policy)).toEqual([
      ['EMAIL', 'jane@acme.com'],
      ['IP', '192.168.1.9'],
    ]);
  });

  it('adds custom patterns with their own placeholders and labels', () => {
    const policy = compilePolicy({
      patterns: [
        { type: 'PROJECT', pattern: 'PRJ-\\d{4}', label: ['project code', 'project codes'] },
        { type: 'CUSTOMER_ID', pattern: 'cust(?:omer)?[ #:]+(\\d{6})', flags: 'i', group: 1 },
      ],
    });
    const { text, findings, vault } = mask('PRJ-1234 for Customer #445566', policy.options);
    expect(text).toBe('[PROJECT_1] for Customer #[CUSTOMER_ID_1]');
    expect(describeFindings(findings, policy.labels)).toBe('1 project code and 1 customer id');
    expect(restore(text, vault)).toBe('PRJ-1234 for Customer #445566');
  });

  it('merges a team config and a personal one', () => {
    const team = { disabled: ['IP'], patterns: [{ type: 'TICKET', pattern: 'SEC-\\d+' }] };
    const me = { allow: ['jane@acme.com'] };
    const policy = compilePolicy(team, me, null);
    expect(types('SEC-42 from jane@acme.com via 10.1.2.3, cc bob@acme.com', policy)).toEqual([
      ['TICKET', 'SEC-42'],
      ['EMAIL', 'bob@acme.com'],
    ]);
  });

  it('reports config mistakes instead of throwing', () => {
    const policy = compilePolicy({
      allow: ['/([/'],
      patterns: [
        { type: 'lower', pattern: 'x' },
        { type: 'OK', pattern: '(' },
        { type: 'EMPTY', pattern: 'a*' },
      ],
    });
    expect(policy.problems).toHaveLength(4);
    expect(types('jane@acme.com', policy)).toEqual([['EMAIL', 'jane@acme.com']]);
  });

  it('an allowed value is not re-found as a fragment by a weaker rule', () => {
    const key = 'sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z';
    const policy = compilePolicy({ allow: [key] });
    expect(types(`key ${key}`, policy)).toEqual([]);
  });
});

describe('audit log', () => {
  it('counts per kind and day, without values', () => {
    const log: AuditLog = {};
    const day1 = new Date(2026, 9, 27, 12);
    const day2 = new Date(2026, 9, 28, 9);
    recordAudit(log, detect('jane@acme.com, bob@acme.com'), day1);
    recordAudit(log, detect('key sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345'), day2);
    expect(log).toEqual({ '2026-10-27': { EMAIL: 2 }, '2026-10-28': { API_KEY: 1 } });
    expect(JSON.stringify(log)).not.toContain('acme');
    expect(auditTotals(log, 1, day2)).toEqual({ API_KEY: 1 });
    expect(auditTotals(log, 30, day2)).toEqual({ EMAIL: 2, API_KEY: 1 });
  });

  it('drops old days', () => {
    const log: AuditLog = { '2025-01-01': { EMAIL: 1 } };
    recordAudit(log, [], new Date(2026, 9, 28));
    expect(log).toEqual({});
  });
});
