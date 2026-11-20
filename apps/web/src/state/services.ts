import {
  type BrowserSession,
  type DeviceLogin,
  signIn,
  signInWays,
  signInWithGitHub,
  signOut,
  vibe,
  type VibeHandle,
} from "@vibe/sdk";
import { createContext, useContext } from "react";

/**
 * Everything the page asks of the outside world, which is one thing: the Vibe
 * that served it, through the SDK. A test hands the page a Vibe of its own here.
 */
export interface Services {
  /** A handle on one of the team's vibes. It carries no token: the browser's session speaks for it. */
  connect(name: string): VibeHandle;
  /** Whether this Vibe has GitHub sign-in beside the token. */
  ways(): Promise<{ github: boolean }>;
  signIn(token: string): Promise<BrowserSession>;
  signInWithGitHub(options: {
    onCode(code: DeviceLogin): void;
    signal: AbortSignal;
  }): Promise<BrowserSession>;
  signOut(): Promise<void>;
}

/** The services of the Vibe at an origin: the page's own, unless a test says otherwise. */
export function servicesAt(
  url: string,
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>,
  /** `live: false` waits for news with long-polls only, where there is no socket to listen on. */
  how: { live?: boolean } = {},
): Services {
  const options = { url, fetch: fetcher };
  return {
    connect: (name) => vibe({ url, name, fetch: fetcher, profile: null, live: how.live }),
    ways: () => signInWays(options),
    signIn: (token) => signIn(token, options),
    signInWithGitHub: ({ onCode, signal }) => signInWithGitHub({ ...options, onCode, signal }),
    signOut: () => signOut(options),
  };
}

const Context = createContext<Services | null>(null);

export const ServicesProvider = Context.Provider;

export function useServices(): Services {
  const services = useContext(Context);
  if (!services) throw new Error("The page has no Vibe to talk to.");
  return services;
}
