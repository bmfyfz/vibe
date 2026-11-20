import type { Channel, Vibe, Whoami } from "@vibe/sdk";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";

import { type ChannelNode, channelTree, patternOf, visibleNodes } from "../lib/channel-tree.ts";
import type { Liveness } from "../state/use-vibe.ts";
import { ChevronIcon, SignOutIcon } from "./icons.tsx";

interface RailProps {
  vibes: Vibe[];
  vibe: string;
  channels: Channel[];
  /** The pattern that is listed: a channel, a subtree, or `null` for all. */
  selected: string | null;
  unseen: ReadonlySet<string>;
  me: Whoami | null;
  liveness: Liveness;
  onVibe(name: string): void;
  onChannel(pattern: string | null): void;
  onSignOut(): void;
}

const LIVE: Record<Liveness, string> = {
  connecting: "Connecting…",
  live: "Live",
  retrying: "Reconnecting…",
};

/**
 * The rail: which vibe, its channels as the tree their paths spell, and who
 * you are. The tree is one tab stop, moved through with the arrow keys, the
 * way a tree is everywhere else.
 */
export function Rail(props: RailProps) {
  const { channels, selected, unseen, me } = props;
  const tree = useMemo(() => channelTree(channels.map((channel) => channel.path)), [channels]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const rows = visibleNodes(tree, closed);
  const items = useRef(new Map<string, HTMLElement>());
  // The row the arrow keys are on. It starts at what is selected.
  const [cursor, setCursor] = useState<string | null>(null);
  const current = cursor ?? selected ?? ALL;

  const toggle = (path: string, open?: boolean) =>
    setClosed((before) => {
      const after = new Set(before);
      if (open ?? after.has(path)) after.delete(path);
      else after.add(path);
      return after;
    });

  const hasUnseen = (node: ChannelNode): boolean =>
    unseen.has(node.path) || node.children.some(hasUnseen);

  function move(to: string) {
    setCursor(to);
    items.current.get(to)?.focus();
  }

  function onKey(event: KeyboardEvent, key: string, node: ChannelNode | null) {
    const order = [ALL, ...rows.map((row) => row.node.path)];
    const at = order.indexOf(key);
    const step = (by: number) => {
      const next = order[Math.min(order.length - 1, Math.max(0, at + by))];
      if (next !== undefined) move(next);
    };
    switch (event.key) {
      case "ArrowDown":
        step(1);
        break;
      case "ArrowUp":
        step(-1);
        break;
      case "Home":
        move(ALL);
        break;
      case "End":
        step(order.length);
        break;
      case "ArrowRight":
        if (node && node.children.length > 0) {
          if (closed.has(node.path)) toggle(node.path, true);
          else step(1);
        }
        break;
      case "ArrowLeft":
        if (node && node.children.length > 0 && !closed.has(node.path)) toggle(node.path, false);
        else if (node?.path.includes("/")) move(node.path.slice(0, node.path.lastIndexOf("/")));
        break;
      case "Enter":
      case " ":
        props.onChannel(node ? patternOf(node) : null);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  const remember = (key: string) => (element: HTMLElement | null) => {
    if (element) items.current.set(key, element);
    else items.current.delete(key);
  };

  return (
    <div className="rail">
      <header className="rail-head">
        <span className="wordmark small" data-lit={unseen.size > 0 || undefined}>
          Vibe
        </span>
        <label className="visually-hidden" htmlFor="vibe-picker">
          Vibe
        </label>
        <select
          id="vibe-picker"
          className="vibe-picker"
          value={props.vibe}
          onChange={(event) => props.onVibe(event.target.value)}
        >
          {props.vibes.map((each) => (
            <option key={each.id} value={each.name}>
              {each.name}
            </option>
          ))}
          {!props.vibes.some((each) => each.name === props.vibe) && (
            <option value={props.vibe}>{props.vibe}</option>
          )}
        </select>
      </header>

      <nav className="rail-channels" aria-label="Channels">
        <div role="tree" aria-label="Channels" className="tree">
          <div
            role="treeitem"
            ref={remember(ALL)}
            tabIndex={current === ALL ? 0 : -1}
            aria-selected={selected === null}
            className="tree-row"
            onClick={() => props.onChannel(null)}
            onKeyDown={(event) => onKey(event, ALL, null)}
            onFocus={() => setCursor(ALL)}
          >
            <span className="tree-name">All channels</span>
            {unseen.size > 0 && <Unseen />}
          </div>
          {rows.map(({ node, depth }) => {
            const pattern = patternOf(node);
            const parent = node.children.length > 0;
            const open = !closed.has(node.path);
            return (
              <div
                key={node.path}
                role="treeitem"
                ref={remember(node.path)}
                tabIndex={current === node.path ? 0 : -1}
                aria-selected={selected === pattern}
                aria-expanded={parent ? open : undefined}
                aria-level={depth + 1}
                className="tree-row"
                data-depth={Math.min(depth, 6)}
                data-group={node.isChannel ? undefined : true}
                onClick={() => props.onChannel(pattern)}
                onKeyDown={(event) => onKey(event, node.path, node)}
                onFocus={() => setCursor(node.path)}
              >
                {parent ? (
                  // The row itself opens and closes with the arrow keys. This is for a pointer.
                  <span
                    className="tree-twist"
                    data-open={open}
                    aria-hidden="true"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggle(node.path);
                    }}
                  >
                    <ChevronIcon />
                  </span>
                ) : (
                  <span className="tree-twist" aria-hidden="true" />
                )}
                <span className="tree-name">{node.name}</span>
                {hasUnseen(node) && (!open || !parent || unseen.has(node.path)) && <Unseen />}
              </div>
            );
          })}
        </div>
        {channels.length === 0 && (
          <p className="rail-empty">No channels yet. The first post in a channel creates it.</p>
        )}
      </nav>

      <footer className="rail-foot">
        <div className="rail-who">
          <span className="rail-name">{me?.actor.name ?? "…"}</span>
          <span className="rail-role">{me ? `${me.role} · ${me.team.name}` : ""}</span>
        </div>
        <span className="live" data-state={props.liveness} role="status">
          {LIVE[props.liveness]}
        </span>
        <button type="button" className="icon-button on-rail" onClick={props.onSignOut}>
          <SignOutIcon />
          <span className="visually-hidden">Sign out</span>
        </button>
      </footer>
    </div>
  );
}

const ALL = "*";

function Unseen() {
  return (
    <span className="unseen">
      <span className="visually-hidden">new activity</span>
    </span>
  );
}
