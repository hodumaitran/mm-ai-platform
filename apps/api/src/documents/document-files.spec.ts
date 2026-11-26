import {
  attachmentDisposition,
  kindFromFilename,
  sanitizeFilename,
  signatureMatches,
} from './document-files';

describe('sanitizeFilename', () => {
  it.each([
    ['../../etc/passwd.txt', 'passwd.txt'],
    ['..\\..\\windows\\system32\\evil.docx', 'evil.docx'],
    ['C:\\temp\\report.pdf', 'report.pdf'],
    ['/abs/olute/ghi chú.txt', 'ghi chú.txt'],
    ['ev<i>l|?*.txt', 'evil.txt'],
    ['  ..hidden.pdf  ', 'hidden.pdf'],
    ['trailing dots...', 'trailing dots'],
    ['', 'document'],
    ['.pdf', 'pdf'],
    ['Báo cáo quý 3.PDF', 'Báo cáo quý 3.PDF'],
  ])('%j -> %j', (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it('removes control characters, composes diacritics and bounds the length', () => {
    const cleaned = sanitizeFilename(`a${String.fromCharCode(0)}b${String.fromCharCode(7)}c.txt`);
    expect(cleaned).toBe('abc.txt');
    expect(sanitizeFilename('e\u0302\u0301.txt')).toBe('\u1ebf.txt');
    const long = sanitizeFilename(`${'x'.repeat(500)}.docx`);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith('.docx')).toBe(true);
  });
});

describe('kindFromFilename and signatureMatches', () => {
  it('accepts only pdf, docx and txt extensions (case-insensitive)', () => {
    expect(kindFromFilename('a.PDF')).toBe('PDF');
    expect(kindFromFilename('a.b.docx')).toBe('DOCX');
    expect(kindFromFilename('a.Txt')).toBe('TXT');
    for (const name of ['a.exe', 'a.doc', 'a.pdf.exe', 'pdf', '.pdf', 'a.']) {
      expect(kindFromFilename(name)).toBeNull();
    }
  });

  it('checks content, not the declared type', () => {
    expect(signatureMatches('PDF', Buffer.from('%PDF-1.7\n...'))).toBe(true);
    expect(signatureMatches('PDF', Buffer.from('<html>not a pdf</html>'))).toBe(false);
    expect(signatureMatches('DOCX', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]))).toBe(true);
    expect(signatureMatches('DOCX', Buffer.from('%PDF-1.7'))).toBe(false);
    expect(signatureMatches('DOCX', Buffer.alloc(2))).toBe(false);
    expect(signatureMatches('TXT', Buffer.from('Xin chào'))).toBe(true);
    expect(signatureMatches('TXT', Buffer.from([65, 0, 66]))).toBe(false);
  });
});

describe('attachmentDisposition', () => {
  it('always forces a download and encodes non-ASCII names safely', () => {
    const header = attachmentDisposition('Hợp đồng "mẫu"\r\nX: 1.pdf');
    expect(header.startsWith('attachment; filename="')).toBe(true);
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toContain("filename*=UTF-8''H%E1%BB%A3p");
    expect(header.split('"')).toHaveLength(3); // no stray quotes can break out of the header value
  });
});
