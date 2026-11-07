import { describe, expect, it } from 'vitest';
import { severeFindings, type AuditJson } from './dependency-audit';

describe('severeFindings', () => {
  const audit: AuditJson = {
    vulnerabilities: {
      undici: {
        name: 'undici',
        severity: 'high',
        isDirect: false,
        via: [{ title: 'TLS certificate check bypass' }],
        fixAvailable: true,
      },
      '@expo/cli': {
        name: '@expo/cli',
        severity: 'high',
        isDirect: false,
        via: ['zod'],
        fixAvailable: { name: 'expo', version: '52.0.49', isSemVerMajor: true },
      },
      eslint: { name: 'eslint', severity: 'moderate', isDirect: true, via: ['ajv'], fixAvailable: true },
      lone: { name: 'lone', severity: 'critical', isDirect: true, via: [{ url: 'https://x' }], fixAvailable: false },
    },
  };

  it('keeps high and critical advisories only, sorted by name', () => {
    expect(severeFindings(audit).map(f => f.name)).toEqual(['@expo/cli', 'lone', 'undici']);
  });

  it('marks only a non-breaking fix as fixable, and names a breaking one', () => {
    const [expoCli, lone, undici] = severeFindings(audit);
    expect(undici).toMatchObject({ fixable: true, breakingFix: null, via: ['TLS certificate check bypass'] });
    expect(expoCli).toMatchObject({ fixable: false, breakingFix: 'expo@52.0.49', via: ['zod'] });
    expect(lone).toMatchObject({ fixable: false, breakingFix: null, via: ['https://x'] });
  });

  it('handles an audit with nothing found', () => {
    expect(severeFindings({})).toEqual([]);
  });
});
