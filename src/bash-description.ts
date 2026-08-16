/** dsh persistent-bash 描述（`minimal/agent.cordis.yml:36-45` 逐字）——
 * Anchored Standard 首轮工具 schema 需与 dsh minimal 一致（工具 schema 是
 * 锚定决定变量，issue #11）；opencode 原生 bash 描述含 opencode 特有内容。 */
export const DSH_BASH_DESCRIPTION = [
  'Run commands in a bash shell',
  '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
  "You don't have access to the internet via this tool.",
  'You do have access to a mirror of common linux and python packages via apt and pip.',
  'State is persistent across command calls and discussions with the user.',
  "To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.",
  'Please avoid commands that may produce a very large amount of output.',
  "Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.",
].join('\n');
