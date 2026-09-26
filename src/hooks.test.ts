import { describe, expect, it } from 'vitest';
import { describeTool, firstLine, hookSince, ingestHook, promptedAfter, summaryFor } from './hooks.js';

const ev = (sid: string, name: string, o: Record<string, unknown>, at: number) => ingestHook({ session_id: sid, hook_event_name: name, ...o }, at);

describe('one-line summary', () => {
  it('takes the first meaningful line without markdown', () => {
    expect(firstLine('\n\n## 結論\n\n本文')).toBe('結論');
    expect(firstLine('```ts\ncode\n```')).toBe('code');
    expect(firstLine('製品名は **whatnext** です。\n2行目')).toBe('製品名は whatnext です。');
    expect(firstLine(undefined)).toBe('');
  });
  it('describes the tool a permission prompt is about', () => {
    expect(describeTool('Bash', { command: 'curl -sI https://example.com\necho 2', description: 'x' })).toBe('Bash: curl -sI https://example.com');
    expect(describeTool('Edit', { file_path: '/r/a.ts', old_string: 'a' })).toBe('Edit: /r/a.ts');
    expect(describeTool('mcp__x__y', { a: 1 })).toBe('mcp__x__y: {"a":1}');
  });
  it('shows the prompt while Working and the last message after Stop', () => {
    ev('s1', 'UserPromptSubmit', { prompt: 'Write an essay about tea' }, 100);
    expect(summaryFor('s1', 'Working')).toBe('→ Write an essay about tea');
    expect(summaryFor('s1', 'Review')).toBeUndefined();
    ev('s1', 'Stop', { last_assistant_message: '茶の歴史\n\n本文' }, 200);
    expect(summaryFor('s1', 'Review')).toBe('茶の歴史');
  });
  it('does not show a message from an earlier turn', () => {
    ev('s2', 'UserPromptSubmit', { prompt: 'a' }, 100);
    ev('s2', 'Stop', { last_assistant_message: 'old' }, 200);
    ev('s2', 'UserPromptSubmit', { prompt: 'b' }, 300);
    expect(summaryFor('s2', 'Review')).toBeUndefined();
  });
  it('shows the permission request and the question', () => {
    ev('s3', 'UserPromptSubmit', { prompt: 'a' }, 100);
    ev('s3', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'terraform apply' } }, 150);
    expect(summaryFor('s3', 'Permission')).toBe('Bash: terraform apply');
    ev('s3', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which DB?' }] } }, 160);
    expect(summaryFor('s3', 'Question')).toBe('Which DB?');
    ev('s3', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }, 170);
    expect(hookSince('s3', 'Question')).toBe(160);
  });
});

describe('waiting time from hooks', () => {
  it('uses the prompt time while Working and the last waiting event otherwise', () => {
    ev('t1', 'UserPromptSubmit', { prompt: 'a' }, 1000);
    expect(hookSince('t1', 'Working')).toBe(1000);
    expect(hookSince('t1', 'Review')).toBeUndefined();
    ev('t1', 'Stop', { last_assistant_message: 'done' }, 5000);
    expect(hookSince('t1', 'Review')).toBe(5000);
    expect(promptedAfter('t1', 500)).toBe(true);
    expect(promptedAfter('t1', 2000)).toBe(false);
  });
  it('knows nothing about sessions without hooks', () => {
    expect(hookSince('none', 'Review')).toBeUndefined();
    expect(summaryFor('none', 'Review')).toBeUndefined();
  });
});
