import assert from 'node:assert/strict';
import test from 'node:test';
import { missingSections } from './check-pr-body.mjs';

const full = `## 需求映射与最终行为
U2.1 规则 3。

## 测试命令与结果
pnpm check：通过。

## 未测项
真实手机。

## 迁移与回退
不适用。`;

test('a description with the four sections passes, in either language', () => {
  assert.deepEqual(missingSections(full), []);
  const english = full
    .replace('需求映射与最终行为', 'Requirement mapping and final behaviour')
    .replace('测试命令与结果', 'Tests (commands and results)')
    .replace('未测项', 'Not tested')
    .replace('迁移与回退', 'Migration and rollback');
  assert.deepEqual(missingSections(english), []);
});

test('missing or empty sections are reported; comments do not count as content', () => {
  assert.equal(missingSections('').length, 4);
  assert.deepEqual(
    missingSections(full.replace('## 未测项\n真实手机。\n', '')),
    ['not tested / 未测项'],
  );
  assert.deepEqual(
    missingSections(full.replace('不适用。', '<!-- fill in -->')),
    ['migration and rollback / 迁移与回退'],
  );
});

test('a mention in body text is not a heading', () => {
  assert.deepEqual(
    missingSections('Rollback: revert.\nNot tested: phones.\n## Tests\nok'),
    [
      'requirement mapping and final behaviour / 需求映射与最终行为',
      'not tested / 未测项',
      'migration and rollback / 迁移与回退',
    ],
  );
});

test('fenced or commented-out headings do not count; multiline comments are not content', () => {
  assert.equal(missingSections('```\n' + full + '\n```').length, 4);
  assert.equal(missingSections('<!--\n' + full + '\n-->').length, 4);
  assert.deepEqual(
    missingSections(full.replace('不适用。', '<!--\nfill in\nlater\n-->')),
    ['migration and rollback / 迁移与回退'],
  );
});

test('an untested section never satisfies the tests section', () => {
  const noTests = full.replace('## 测试命令与结果\npnpm check：通过。\n', '');
  assert.deepEqual(
    missingSections(noTests.replace('## 未测项', '## 未测试项')),
    ['tests (commands and results) / 测试命令与结果'],
  );
});

test('subsection content belongs to its parent section; CRLF is accepted', () => {
  const nested = full.replace(
    '## 测试命令与结果\npnpm check：通过。',
    '## Tests\n### Unit suite\nnode --test: passed',
  );
  assert.deepEqual(missingSections(nested), []);
  assert.deepEqual(missingSections(full.replace(/\n/g, '\r\n')), []);
});
