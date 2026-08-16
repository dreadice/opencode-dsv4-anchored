import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyText} from '@/verify';

test('TC-1-17: We need 先出现 → 通过', () => {
  assert.equal(verifyText('We need to modify the build first.'), true);
});

test('TC-1-18: Let me 先出现 → 不通过', () => {
  assert.equal(verifyText('Let me check the files.'), false);
});

test('TC-1-19: Let me 先于 We need → 不通过', () => {
  assert.equal(verifyText('Let me start. We need to...'), false);
});

test('TC-1-20: We need 先、let 在后 → 通过（容忍）', () => {
  assert.equal(verifyText('We need... but let me also verify.'), true);
});

test('TC-1-21: 仅 let 无 we → 不通过', () => {
  assert.equal(verifyText('Let me first look around.'), false);
});

test('TC-1-22: 仅 we 无 let → 通过（let 缺失 = +∞）', () => {
  assert.equal(verifyText('We should start by reading the config.'), true);
});

test('TC-1-23: 无任何标记 → 不通过（giveup 语义）', () => {
  assert.equal(verifyText('先确认一下需求。'), false);
});

test('TC-1-26: 大小写不敏感', () => {
  assert.equal(verifyText('WE NEED to do this.'), true);
  assert.equal(verifyText('Let Me check this.'), false);
});

test("TC-1-27: 词边界——weave/we've 不算 we，let them 不算 let 系", () => {
  assert.equal(verifyText("we've got a problem"), false);
  assert.equal(verifyText('the weaver will fix it'), false);
  assert.equal(verifyText('let them handle it'), false);
});

test('TC-1-27b: 词边界——正常 we 仍命中', () => {
  assert.equal(verifyText('we have a problem'), true);
});

test("TC-1-28b: let's 不是失败信号（round-11：dsh 实测 let's 大量出现仍锚定成功）", () => {
  assert.equal(verifyText("Let's start by checking. We need to fix it."), true);
  assert.equal(verifyText("Let's try again."), false);
});

test('reasoning + text 拼接语义：thinking 内 we 先出现即通过', () => {
  const thinking = 'We need to inspect the repo structure.';
  const text = 'Let me get started.';
  assert.equal(verifyText(`${thinking}\n${text}`), true);
});
