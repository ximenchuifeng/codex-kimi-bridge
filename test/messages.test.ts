import { describe, expect, it } from 'vitest';
import { selectLatestMeaningfulMessage } from '../src/messages.js';

describe('selectLatestMeaningfulMessage', () => {
  it('selects the first meaningful assistant message from newest-first input', () => {
    const messages = [
      { role: 'assistant', content: 'new final report' },
      { role: 'tool', content: '' },
      { role: 'assistant', content: '   ' },
      { role: 'assistant', content: 'old report' },
    ];
    expect(selectLatestMeaningfulMessage(messages, 'assistant')).toBe('new final report');
  });

  it('skips internal messages and redacts the configured token', () => {
    const messages = [
      { role: 'assistant', content: '<system-reminder>ignore me</system-reminder>' },
      { role: 'assistant', content: 'finished with secret-token' },
    ];
    expect(selectLatestMeaningfulMessage(messages, 'assistant', 'secret-token'))
      .toBe('finished with [redacted]');
  });

  it('returns undefined when no meaningful message exists', () => {
    expect(selectLatestMeaningfulMessage([
      { role: 'assistant', content: '' },
      { role: 'user', content: 'not an assistant result' },
    ], 'assistant')).toBeUndefined();
  });
});
