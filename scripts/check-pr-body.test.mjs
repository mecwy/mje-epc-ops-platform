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
