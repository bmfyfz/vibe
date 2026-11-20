/** One place in the tree of channels: a channel, a group of channels, or both at once. */
export interface ChannelNode {
  /** The last segment of its path, which is what the tree shows. */
  name: string;
  /** Its whole path, such as `www/production`. */
  path: string;
  /** Whether a channel has this exact path. A node that only groups others has none. */
  isChannel: boolean;
  children: ChannelNode[];
}

/**
 * Builds the tree that channel paths spell out. `www/production` and
 * `www/staging` hang under `www`, whether or not `www` is a channel itself.
 */
export function channelTree(paths: readonly string[]): ChannelNode[] {
  const roots: ChannelNode[] = [];
  const byPath = new Map<string, ChannelNode>();
  for (const path of [...paths].sort()) {
    let siblings = roots;
    let prefix = "";
    for (const name of path.split("/")) {
      prefix = prefix === "" ? name : `${prefix}/${name}`;
      let node = byPath.get(prefix);
      if (!node) {
        node = { name, path: prefix, isChannel: false, children: [] };
        byPath.set(prefix, node);
        siblings.push(node);
      }
      siblings = node.children;
    }
    const leaf = byPath.get(path);
    if (leaf) leaf.isChannel = true;
  }
  return roots;
}

/** The nodes of a tree in the order they are shown, leaving out what a closed node holds. */
export function visibleNodes(
  nodes: readonly ChannelNode[],
  closed: ReadonlySet<string>,
  depth = 0,
): { node: ChannelNode; depth: number }[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(closed.has(node.path) ? [] : visibleNodes(node.children, closed, depth + 1)),
  ]);
}

/**
 * What to ask the API for when a node is chosen: the channel itself, or for a
 * node that only groups others, everything under it.
 */
export function patternOf(node: ChannelNode): string {
  return node.isChannel ? node.path : `${node.path}/`;
}

/** Whether a channel falls under a pattern: `*` or nothing for all, `www/` for a subtree, `dev` for one. */
export function matchesPattern(pattern: string | null, channel: string): boolean {
  if (pattern === null || pattern === "" || pattern === "*") return true;
  return pattern.endsWith("/") ? channel.startsWith(pattern) : channel === pattern;
}
