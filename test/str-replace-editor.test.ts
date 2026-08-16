import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, mkdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {strReplaceEditor, TRUNCATED_MESSAGE} from '@/str-replace-editor';

const ctx = {
  sessionID: 'ses_1',
  messageID: 'msg_1',
  agent: 'build',
  directory: '/',
  worktree: '/',
  abort: new AbortController().signal,
  metadata() {},
  async ask() {},
} as never;

let dir = '';

test.before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sre-'));
});

test.after(async () => {
  await rm(dir, {recursive: true, force: true});
});

test('TC-2-21: create 写新文件 + 已存在报错', async () => {
  const p = join(dir, 'a.txt');
  const r1 = await strReplaceEditor.execute(
    {command: 'create', path: p, file_text: 'hello'},
    ctx
  );
  assert.ok(String(r1).includes('created'));
  assert.equal(await readFile(p, 'utf8'), 'hello');
  await assert.rejects(
    strReplaceEditor.execute(
      {command: 'create', path: p, file_text: 'again'},
      ctx
    ),
    /already exists/
  );
});

test('TC-2-20: view 文件行号格式 + view_range', async () => {
  const p = join(dir, 'b.txt');
  await writeFile(p, 'l1\nl2\nl3\nl4\n', 'utf8');
  const full = String(
    await strReplaceEditor.execute({command: 'view', path: p}, ctx)
  );
  assert.ok(full.includes('    1\tl1'));
  assert.ok(full.includes('    4\tl4'));
  const ranged = String(
    await strReplaceEditor.execute(
      {command: 'view', path: p, view_range: [2, 3]},
      ctx
    )
  );
  assert.ok(ranged.includes('    2\tl2'));
  assert.ok(ranged.includes('    3\tl3'));
  assert.ok(!ranged.includes('l1'));
  const toEnd = String(
    await strReplaceEditor.execute(
      {command: 'view', path: p, view_range: [3, -1]},
      ctx
    )
  );
  assert.ok(
    toEnd.includes('l3') && toEnd.includes('l4') && !toEnd.includes('l1')
  );
});

test('TC-2-20b: view 16000 截断 + <response clipped>', async () => {
  const p = join(dir, 'big.txt');
  await writeFile(p, 'x'.repeat(20000), 'utf8');
  const out = String(
    await strReplaceEditor.execute({command: 'view', path: p}, ctx)
  );
  assert.ok(out.length < 20000);
  assert.ok(out.endsWith(TRUNCATED_MESSAGE));
});

test('TC-2-20c: view 目录列出（非隐藏，2 层）', async () => {
  const d = join(dir, 'tree');
  await mkdir(join(d, 'sub'), {recursive: true});
  await writeFile(join(d, 'f.txt'), 'x', 'utf8');
  await writeFile(join(d, '.hidden'), 'x', 'utf8');
  const out = String(
    await strReplaceEditor.execute({command: 'view', path: d}, ctx)
  );
  assert.ok(out.includes('f.txt'));
  assert.ok(!out.includes('.hidden'));
});

test('TC-2-22: str_replace 唯一替换 + 多/无匹配报错', async () => {
  const p = join(dir, 'c.txt');
  await writeFile(p, 'one\ntwo\nthree\n', 'utf8');
  const ok = await strReplaceEditor.execute(
    {command: 'str_replace', path: p, old_str: 'two', new_str: 'TWO'},
    ctx
  );
  assert.ok(String(ok).includes('edited'));
  assert.equal(await readFile(p, 'utf8'), 'one\nTWO\nthree\n');
  await assert.rejects(
    strReplaceEditor.execute(
      {command: 'str_replace', path: p, old_str: 'zzz', new_str: 'x'},
      ctx
    ),
    /No matches/
  );
  const dup = join(dir, 'dup.txt');
  await writeFile(dup, 'same\nsame\n', 'utf8');
  await assert.rejects(
    strReplaceEditor.execute(
      {command: 'str_replace', path: dup, old_str: 'same', new_str: 'x'},
      ctx
    ),
    /not unique|matched/
  );
});

test('TC-2-23: insert 行插入', async () => {
  const p = join(dir, 'd.txt');
  await writeFile(p, 'a\nb\nc\n', 'utf8');
  await strReplaceEditor.execute(
    {command: 'insert', path: p, insert_line: 1, new_str: 'X'},
    ctx
  );
  assert.equal(await readFile(p, 'utf8'), 'a\nX\nb\nc\n');
});

test('相对路径拒绝', async () => {
  await assert.rejects(
    strReplaceEditor.execute({command: 'view', path: 'relative.txt'}, ctx),
    /absolute/
  );
});
