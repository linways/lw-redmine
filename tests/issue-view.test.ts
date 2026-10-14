import { describe, expect, it } from 'vitest';
import { detectDbName } from '../src/commands/issue/view';

describe('detectDbName', () => {
  it.each([
    ['**Database and CHT Instance **->  test_ccm1013\r\n', 'test_ccm1013'],
    ['*Database and CHT Instance* -> cht9-v4 , test_sbcollegev463', 'test_sbcollegev463'],
    ['db : cht_iagi63', 'cht_iagi63'],
    ['db: test_sjcc_db0415', 'test_sjcc_db0415'],
    ['DB and CHT Instance - \r\n\r\n*Path* - Exam controller', undefined],
    ['the student_id column in the database: is wrong', undefined],
    [undefined, undefined],
  ])('%j → %s', (desc, want) => {
    expect(detectDbName(desc)).toBe(want);
  });
});
