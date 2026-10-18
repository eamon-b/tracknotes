import { describe, expect, it } from 'vitest';
import { linkifyText } from './linkify-text';

describe('linkifyText', () => {
  it('links URLs, email addresses and phone numbers, escaping the rest', () => {
    const html = linkifyText('See https://henro.org/a. Mail inn@example.jp or Tel: 0885-42-4655 <b>');
    expect(html).toBe(
      'See <a href="https://henro.org/a" target="_blank" rel="noopener noreferrer">https://henro.org/a</a>. ' +
        'Mail <a href="mailto:inn@example.jp">inn@example.jp</a> or ' +
        'Tel: <a href="tel:0885-42-4655">0885-42-4655</a> &lt;b&gt;',
    );
  });

  it('keeps a quote out of the href', () => {
    const html = linkifyText('http://evil.test/"onmouseover="xss()');
    const div = document.createElement('div');
    div.innerHTML = html;
    const links = div.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('http://evil.test/');
    expect(div.querySelector('[onmouseover]')).toBeNull();
    expect(div.textContent).toBe('http://evil.test/"onmouseover="xss()');
  });

  it('leaves ids, dates and ranges as plain text', () => {
    expect(linkifyText('Open 0800-1700 since 2026-09-21, node 123456789')).not.toContain('<a');
  });
});
