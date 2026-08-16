import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeLogger} from '@/logger';
import {createFakeClient} from './fake-client.ts';

test('TC-2-24: debug 关闭时 debug() 短路（不调用 log）', () => {
  const client = createFakeClient();
  const logger = makeLogger(client.app.log.bind(client.app), {
    debugEnabled: false,
  });
  logger.debug('system.transform', {full: 'x'.repeat(1000)});
  logger.info('chat.message', {stage: 'seeded'});
  assert.equal(client._logs.filter(l => l.level === 'debug').length, 0);
  assert.equal(client._logs.filter(l => l.level === 'info').length, 1);
});

test('debug 开启时 debug() 落日志', () => {
  const client = createFakeClient();
  const logger = makeLogger(client.app.log.bind(client.app), {
    debugEnabled: true,
  });
  logger.debug('system.transform', {full: 'payload'});
  assert.equal(client._logs.filter(l => l.level === 'debug').length, 1);
  assert.ok(client._logs[0]!.msg.startsWith('dsv4-anchored'));
});
