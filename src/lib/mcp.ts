/** Setting up an MCP client to start `dataliq mcp`. */

/** How an MCP client starts DataLiq, in Claude Desktop's config format. */
export function desktopConfig(command: string): string {
  return JSON.stringify({ mcpServers: { dataliq: { command, args: ["mcp"] } } }, null, 2);
}

/** The same for Claude Code's command line. */
export function claudeCodeCommand(command: string): string {
  return `claude mcp add dataliq -- "${command}" mcp`;
}
