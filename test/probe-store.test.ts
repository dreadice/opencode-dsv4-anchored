import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  createProbeStore,
  loadProbeStore,
  saveProbeStore,
  captureProbeSystem,
  type ProbeStore,
} from '@/probe';

let dir = '';
const file = () => join(dir, 'probe-cache.json');
const yesterday = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.getTime();
};

test.before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'probe-cache-'));
});

test.after(async () => {
  await rm(dir, {recursive: true, force: true});
});

test('save 只写当天条目（旧日期自动清理）', async () => {
  const store = createProbeStore();
  captureProbeSystem(store, 'today-key', 'sys');
  store.map.set('old-key', {status: 'ok', system: 'old', ts: yesterday()});
  store.map.set('old-failed', {status: 'failed', error: 'x', ts: yesterday()});
  await saveProbeStore(store, file());
  const saved = JSON.parse(await readFile(file(), 'utf8')) as Array<
    [string, unknown]
  >;
  const keys = saved.map(([k]) => k);
  assert.deepEqual(keys, ['today-key'], '只应保留当天条目');
});

test('load 跳过旧日期条目（跨天自动失效）', async () => {
  const store = createProbeStore();
  captureProbeSystem(store, 'today-key', 'sys');
  await saveProbeStore(store, file());
  // 模拟跨天后：文件里混入昨天的条目
  const raw = JSON.parse(await readFile(file(), 'utf8')) as Array<
    [string, {status: string; system: string; ts: number}]
  >;
  raw.push(['old-key', {status: 'ok', system: 'old', ts: yesterday()}]);
  const fs = await import('node:fs/promises');
  await fs.writeFile(file(), JSON.stringify(raw));
  const loaded: ProbeStore = await loadProbeStore(file());
  assert.ok(loaded.map.has('today-key'));
  assert.ok(!loaded.map.has('old-key'), '旧日期条目不应加载');
});
