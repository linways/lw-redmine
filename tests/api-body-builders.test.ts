/**
 * Contract tests for the camelCase → snake_case body builders. These
 * pin the wire-format shape and — paired with the type-checked field
 * maps in the api modules — close the "dry-run lies because the
 * preview re-implements the body and drifts" class entirely.
 *
 * If anyone adds a field to UpdateIssueInput / UpdateTimeEntryInput etc.
 * but forgets to map it, the typecheck breaks before tests even run.
 * If they map it but with the wrong snake_case name, the tests below
 * fail with a clear diff.
 */

import { describe, expect, it } from 'vitest';
import {
  toIssueCreateBody,
  toIssueUpdateBody,
  type CreateIssueInput,
  type UpdateIssueInput,
} from '../src/api/issues';
import {
  toTimeEntryCreateBody,
  toTimeEntryUpdateBody,
  type CreateTimeEntryInput,
  type UpdateTimeEntryInput,
} from '../src/api/time-entries';

describe('toIssueUpdateBody', () => {
  it('maps every UpdateIssueInput field to its snake_case key', () => {
    const input: Required<Omit<UpdateIssueInput, 'customFields'>> = {
      subject: 'Sub',
      description: 'Desc',
      trackerId: 4,
      statusId: 78,
      priorityId: 5,
      assignedToId: 232,
      parentIssueId: 100,
      startDate: '2026-05-01',
      dueDate: '2026-05-15',
      estimatedHours: 2.5,
      doneRatio: 50,
      notes: 'Hi',
      privateNotes: true,
    };
    expect(toIssueUpdateBody(input)).toEqual({
      subject: 'Sub',
      description: 'Desc',
      tracker_id: 4,
      status_id: 78,
      priority_id: 5,
      assigned_to_id: 232,
      parent_issue_id: 100,
      start_date: '2026-05-01',
      due_date: '2026-05-15',
      estimated_hours: 2.5,
      done_ratio: 50,
      notes: 'Hi',
      private_notes: true,
    });
  });

  it('omits undefined fields (partial update semantics)', () => {
    expect(toIssueUpdateBody({ statusId: 78 })).toEqual({ status_id: 78 });
  });

  it('preserves null on assignedToId (Redmine convention for unassign)', () => {
    expect(toIssueUpdateBody({ assignedToId: null })).toEqual({ assigned_to_id: null });
  });

  it('transforms customFields into [{id,value}] under custom_fields', () => {
    const out = toIssueUpdateBody({
      customFields: [{ id: 79, value: '232' }, { id: 80, value: ['a', 'b'] }],
    });
    expect(out).toEqual({
      custom_fields: [{ id: 79, value: '232' }, { id: 80, value: ['a', 'b'] }],
    });
  });

  it('omits custom_fields entirely when input.customFields is empty', () => {
    expect(toIssueUpdateBody({ customFields: [] })).toEqual({});
  });
});

describe('toIssueCreateBody', () => {
  it('maps every CreateIssueInput field including projectId', () => {
    const input: Required<Omit<CreateIssueInput, 'customFields'>> = {
      projectId: 51,
      subject: 'New issue',
      description: 'Body',
      trackerId: 4,
      statusId: 1,
      priorityId: 5,
      assignedToId: 232,
      parentIssueId: 100,
      startDate: '2026-05-01',
      dueDate: '2026-05-15',
      estimatedHours: 2.5,
      doneRatio: 0,
    };
    expect(toIssueCreateBody(input)).toEqual({
      project_id: 51,
      subject: 'New issue',
      description: 'Body',
      tracker_id: 4,
      status_id: 1,
      priority_id: 5,
      assigned_to_id: 232,
      parent_issue_id: 100,
      start_date: '2026-05-01',
      due_date: '2026-05-15',
      estimated_hours: 2.5,
      done_ratio: 0,
    });
  });

  it('does not emit notes/privateNotes (those are update-only)', () => {
    // `notes` is not a key of CreateIssueInput; the type system already
    // enforces this, but pin the runtime contract too: a stray @ts-expect-
    // error-style attempt should produce no `notes` key.
    const input = { projectId: 1, subject: 'x', notes: 'should-be-ignored' } as unknown as CreateIssueInput;
    expect(toIssueCreateBody(input)).not.toHaveProperty('notes');
  });
});

describe('toTimeEntryUpdateBody', () => {
  it('maps every UpdateTimeEntryInput field', () => {
    const input: Required<Omit<UpdateTimeEntryInput, 'customFields'>> = {
      hours: 1.5,
      activityId: 9,
      spentOn: '2026-05-10',
      comments: 'Pairing',
      issueId: 125415,
      projectId: 51,
    };
    expect(toTimeEntryUpdateBody(input)).toEqual({
      hours: 1.5,
      activity_id: 9,
      spent_on: '2026-05-10',
      comments: 'Pairing',
      issue_id: 125415,
      project_id: 51,
    });
  });

  it('omits undefined fields', () => {
    expect(toTimeEntryUpdateBody({ hours: 2 })).toEqual({ hours: 2 });
  });

  it('handles customFields the same way as issues', () => {
    expect(toTimeEntryUpdateBody({ customFields: [{ id: 5, value: 'x' }] })).toEqual({
      custom_fields: [{ id: 5, value: 'x' }],
    });
  });
});

describe('toTimeEntryCreateBody', () => {
  it('maps every CreateTimeEntryInput field including userId', () => {
    const input: Required<Omit<CreateTimeEntryInput, 'customFields'>> = {
      issueId: 125415,
      projectId: 51,
      hours: 2.5,
      activityId: 9,
      spentOn: '2026-05-10',
      comments: 'Sprint planning',
      userId: 232,
    };
    expect(toTimeEntryCreateBody(input)).toEqual({
      issue_id: 125415,
      project_id: 51,
      hours: 2.5,
      activity_id: 9,
      spent_on: '2026-05-10',
      comments: 'Sprint planning',
      user_id: 232,
    });
  });
});
