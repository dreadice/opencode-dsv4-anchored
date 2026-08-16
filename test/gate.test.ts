import {test} from 'node:test';
import assert from 'node:assert/strict';
import {matchesModel, gateModel} from '@/gate';

const PATTERNS = ['deepseek*v4*'];

test('TC-1-1: deepseek/deepseek-v4-pro 命中（功能匹配所有 v4 含 pro）', () => {
  assert.equal(
    gateModel({providerID: 'deepseek', modelID: 'deepseek-v4-pro'}, PATTERNS),
    true
  );
});

test('TC-1-2: 无 provider 前缀的 modelID 命中', () => {
  assert.equal(matchesModel('deepseek-v4-flash-free', PATTERNS), true);
});

test('TC-1-3: 其他 provider 不命中', () => {
  assert.equal(
    gateModel(
      {providerID: 'anthropic', modelID: 'claude-3.5-sonnet'},
      PATTERNS
    ),
    false
  );
});

test('TC-1-4: v3 不命中', () => {
  assert.equal(
    gateModel({providerID: 'deepseek', modelID: 'deepseek-v3'}, PATTERNS),
    false
  );
});

test('TC-1-5: 空 patterns 不命中', () => {
  assert.equal(matchesModel('deepseek/deepseek-v4-pro', []), false);
});

test('opencode provider 前缀下的 flash-free 命中', () => {
  assert.equal(
    gateModel(
      {providerID: 'opencode', modelID: 'deepseek-v4-flash-free'},
      PATTERNS
    ),
    true
  );
});

test('拼接串直接匹配 pattern（provider/model 全串）', () => {
  assert.equal(
    matchesModel('deepseek/deepseek-v4-pro', ['deepseek/deepseek-v4-pro']),
    true
  );
});

test('pattern 仅匹配 modelID 部分（拼接串不匹配但 modelID 匹配）', () => {
  assert.equal(
    gateModel({providerID: 'deepseek', modelID: 'deepseek-v4-pro'}, [
      'deepseek-v4-pro',
    ]),
    true
  );
});

test('通配符在中间：deepseek-v4-flash-free 命中 deepseek*v4*', () => {
  assert.equal(matchesModel('deepseek-v4-flash-free', ['deepseek*v4*']), true);
});
