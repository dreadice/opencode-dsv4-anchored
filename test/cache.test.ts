import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cacheKey} from '@/cache';

test('TC-1-35: key 稳定可复现', () => {
  const a = cacheKey('/proj', 'build', 'deepseek-v4-flash-free', '2026-08-16');
  const b = cacheKey('/proj', 'build', 'deepseek-v4-flash-free', '2026-08-16');
  assert.equal(a, b);
});

test('TC-1-36: 日期变化 → 不同 key（跨天重探）', () => {
  assert.notEqual(
    cacheKey('/proj', 'build', 'deepseek-v4-flash-free', '2026-08-16'),
    cacheKey('/proj', 'build', 'deepseek-v4-flash-free', '2026-08-17')
  );
});

test('TC-1-37: agent 变化 → 不同 key', () => {
  assert.notEqual(
    cacheKey('/proj', 'build', 'deepseek-v4-flash-free', '2026-08-16'),
    cacheKey('/proj', 'explore', 'deepseek-v4-flash-free', '2026-08-16')
  );
});

test('directory 变化 → 不同 key（跨目录会话）', () => {
  assert.notEqual(
    cacheKey('/projA', 'build', 'deepseek-v4-flash-free', '2026-08-16'),
    cacheKey('/projB', 'build', 'deepseek-v4-flash-free', '2026-08-16')
  );
});
