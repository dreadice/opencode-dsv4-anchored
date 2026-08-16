import {stat, readdir, readFile, writeFile} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {tool} from '@opencode-ai/plugin';

const z = tool.schema;

/** dsh 原版截断标记（`tool-str-replace-editor/src/index.ts:17` 逐字）。 */
export const TRUNCATED_MESSAGE =
  '<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>';

/** dsh 原版描述（`:19-30` 逐字）。 */
export const DEFAULT_DESCRIPTION = `
Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\`
`.trim();

const MAX_OUTPUT_CHARS = 16000;

function maybeTruncate(content: string): string {
  return content.length <= MAX_OUTPUT_CHARS
    ? content
    : content.slice(0, MAX_OUTPUT_CHARS) + TRUNCATED_MESSAGE;
}

function requireAbsolute(path: string): void {
  if (!isAbsolute(path)) throw new Error(`path must be absolute: ${path}`);
}

async function readWithLines(
  path: string,
  viewRange?: number[]
): Promise<string> {
  const content = await readFile(path, 'utf8');
  const lines = content.split('\n');
  let from = 1;
  let to = lines.length;
  if (viewRange && viewRange.length >= 2) {
    from = Math.max(1, viewRange[0]!);
    to =
      viewRange[1]! === -1
        ? lines.length
        : Math.min(lines.length, viewRange[1]!);
  }
  const numbered: string[] = [];
  for (let i = from; i <= to; i++) {
    numbered.push(`${String(i).padStart(5, ' ')}\t${lines[i - 1] ?? ''}`);
  }
  return numbered.join('\n');
}

async function listDir(path: string, depth: number): Promise<string[]> {
  const entries = await readdir(path, {withFileTypes: true});
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      out.push(`${e.name}/`);
      if (depth > 1) {
        for (const sub of await listDir(join(path, e.name), depth - 1)) {
          out.push(`  ${sub}`);
        }
      }
    } else {
      out.push(e.name);
    }
  }
  return out;
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const idx = content.indexOf(search, offset);
    if (idx < 0) return count;
    count++;
    offset = idx + search.length;
  }
}

export const strReplaceEditor = tool({
  description: DEFAULT_DESCRIPTION,
  args: {
    command: z.enum(['view', 'create', 'str_replace', 'insert']),
    path: z.string(),
    file_text: z.string().optional(),
    insert_line: z.number().int().optional(),
    new_str: z.string().optional(),
    old_str: z.string().optional(),
    view_range: z.array(z.number().int()).optional(),
  },
  async execute(args) {
    requireAbsolute(args.path);
    switch (args.command) {
      case 'view': {
        const s = await stat(args.path);
        if (s.isDirectory()) {
          const listing = await listDir(args.path, 2);
          return maybeTruncate(listing.join('\n'));
        }
        return maybeTruncate(await readWithLines(args.path, args.view_range));
      }
      case 'create': {
        try {
          const s = await stat(args.path);
          if (s.isFile())
            throw new Error(`File already exists at: ${args.path}`);
        } catch (e) {
          if (e instanceof Error && e.message.includes('already exists'))
            throw e;
        }
        await writeFile(args.path, args.file_text ?? '', 'utf8');
        return `File created successfully at: ${args.path}`;
      }
      case 'str_replace': {
        if (args.old_str === undefined)
          throw new Error('old_str is required for str_replace');
        const content = await readFile(args.path, 'utf8');
        const count = countOccurrences(content, args.old_str);
        if (count === 0)
          throw new Error(`No matches found for old_str in ${args.path}`);
        if (count > 1)
          throw new Error(
            `old_str matched ${count} times in ${args.path}. Please ensure it is unique`
          );
        const updated = content.replace(args.old_str, args.new_str ?? '');
        await writeFile(args.path, updated, 'utf8');
        return 'The file has been edited successfully.';
      }
      case 'insert': {
        if (args.insert_line === undefined)
          throw new Error('insert_line is required for insert');
        if (args.new_str === undefined)
          throw new Error('new_str is required for insert');
        const content = await readFile(args.path, 'utf8');
        const lines = content.split('\n');
        const idx = Math.min(Math.max(0, args.insert_line), lines.length);
        lines.splice(idx, 0, args.new_str);
        await writeFile(args.path, lines.join('\n'), 'utf8');
        return 'The file has been edited successfully.';
      }
    }
  },
});
