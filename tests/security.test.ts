import { describe, expect, it } from 'vitest';
import { safeAttachmentBasename } from '../src/foundation/attachments';
import { isAllowedRedmineUrl, assertAllowedRedmineUrl } from '../src/foundation/url';
import { LwrError } from '../src/foundation/errors';

describe('safeAttachmentBasename', () => {
  it('passes a clean leaf name through unchanged', () => {
    expect(safeAttachmentBasename('screenshot.png')).toBe('screenshot.png');
  });

  it('strips POSIX directory components', () => {
    expect(safeAttachmentBasename('../../etc/passwd')).toBe('passwd');
    expect(safeAttachmentBasename('/abs/path/file.txt')).toBe('file.txt');
  });

  it('strips Windows backslash components even on POSIX hosts', () => {
    expect(safeAttachmentBasename('..\\..\\Windows\\System32\\evil.dll')).toBe('evil.dll');
    expect(safeAttachmentBasename('C:\\Users\\victim\\notes.txt')).toBe('notes.txt');
  });

  it('rejects empty / dot / dotdot results', () => {
    for (const bad of ['', '.', '..', '../', '/', '/..', '../../']) {
      expect(() => safeAttachmentBasename(bad)).toThrow(LwrError);
    }
  });

  it('rejects names containing NUL or control chars', () => {
    expect(() => safeAttachmentBasename('inno\0cuous.png')).toThrow(LwrError);
    expect(() => safeAttachmentBasename('bell\x07.png')).toThrow(LwrError);
  });

  it('throws a typed ValidationError with stable code', () => {
    try {
      safeAttachmentBasename('../../etc');
      // last segment 'etc' is leaf — does NOT throw. Use a path that resolves to '..'
      safeAttachmentBasename('..');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(LwrError);
      expect((e as LwrError).code).toBe('VALIDATION_BAD_VALUE');
    }
  });
});

describe('isAllowedRedmineUrl', () => {
  it('accepts https URLs to any host', () => {
    expect(isAllowedRedmineUrl('https://redmine.linways.com')).toBe(true);
    expect(isAllowedRedmineUrl('https://redmine.example.org:8443/sub/path')).toBe(true);
  });

  it('accepts http only for loopback hosts', () => {
    expect(isAllowedRedmineUrl('http://localhost')).toBe(true);
    expect(isAllowedRedmineUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isAllowedRedmineUrl('http://[::1]')).toBe(true);
  });

  it('rejects http for non-loopback hosts', () => {
    expect(isAllowedRedmineUrl('http://redmine.linways.com')).toBe(false);
    expect(isAllowedRedmineUrl('http://169.254.169.254')).toBe(false);
    expect(isAllowedRedmineUrl('http://internal.corp')).toBe(false);
  });

  it('rejects non-http(s) schemes outright', () => {
    expect(isAllowedRedmineUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedRedmineUrl('gopher://evil.example.com')).toBe(false);
    expect(isAllowedRedmineUrl('ftp://files.example.com')).toBe(false);
    expect(isAllowedRedmineUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects malformed input', () => {
    expect(isAllowedRedmineUrl('not a url')).toBe(false);
    expect(isAllowedRedmineUrl('')).toBe(false);
  });
});

describe('assertAllowedRedmineUrl', () => {
  it('returns the URL unchanged on success', () => {
    expect(assertAllowedRedmineUrl('https://redmine.linways.com', 'flag')).toBe(
      'https://redmine.linways.com',
    );
  });

  it('throws ValidationError with stable code on rejection', () => {
    try {
      assertAllowedRedmineUrl('file:///etc/passwd', 'flag');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(LwrError);
      expect((e as LwrError).code).toBe('VALIDATION_BAD_VALUE');
      expect((e as LwrError).message).toContain('flag');
    }
  });

  it('names the source in the error message for diagnostics', () => {
    for (const src of ['flag', 'env', 'config'] as const) {
      try {
        assertAllowedRedmineUrl('http://attacker.example', src);
        throw new Error('expected throw');
      } catch (e) {
        expect((e as LwrError).message).toContain(src);
      }
    }
  });
});
