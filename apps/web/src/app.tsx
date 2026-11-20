import type { Vibe } from "@vibe/sdk";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Bay } from "./components/bay.tsx";
import { Rail } from "./components/rail.tsx";
import { SignIn } from "./components/sign-in.tsx";
import { ThreadView } from "./components/thread.tsx";
import { canIn } from "./lib/access.ts";
import { formatPlace, parsePlace, type Place } from "./lib/route.ts";
import { useServices } from "./state/services.ts";
import { type Filters, useVibe } from "./state/use-vibe.ts";

type Session = "checking" | "out" | "in";

/** The page: who is asked first, and then the vibe. */
export function App() {
  const services = useServices();
  const [session, setSession] = useState<Session>("checking");
  const [vibes, setVibes] = useState<Vibe[]>([]);
  const [stillIn, setStillIn] = useState(false);

  // Whether the browser holds a session is something only the Vibe can say:
  // the page can't read the cookie, by design.
  const check = useCallback(async () => {
    try {
      setVibes(await services.connect("general").vibes());
      setSession("in");
    } catch (error) {
      // Signed out, or the Vibe can't be reached: either way, the way in is shown.
      void error;
      setSession("out");
    }
  }, [services]);

  useEffect(() => {
    void check();
  }, [check]);

  if (session === "checking") {
    return <main className="signin" aria-busy="true" aria-label="Loading" />;
  }
  if (session === "out") return <SignIn onSignedIn={check} />;
  return (
    <>
      {stillIn && (
        <p className="notice danger still-in" role="alert">
          You are still signed in: the Vibe could not be reached to sign you out. Try again before
          you leave this browser to someone else.
        </p>
      )}
      <Shell
        vibes={vibes}
        onSignOut={async () => {
          // The session is the Vibe's to end. Showing the way in while it
          // still stands would leave it open to whoever loads the page next.
          try {
            await services.signOut();
          } catch {
            setStillIn(true);
            return;
          }
          setStillIn(false);
          setSession("out");
        }}
        onSignedOut={() => setSession("out")}
      />
    </>
  );
}

const here = (): Place => parsePlace(window.location.pathname, window.location.search);

function Shell(props: { vibes: Vibe[]; onSignOut(): void; onSignedOut(): void }) {
  const services = useServices();
  const [place, setPlace] = useState<Place>(here);
  const [filters, setFilters] = useState<Filters>({ mentions: false, tasks: false });
  const [railOpen, setRailOpen] = useState(false);
  const handle = useMemo(() => services.connect(place.vibe), [services, place.vibe]);
  const data = useVibe(handle, place.channel, place.thread, filters, props.onSignedOut);

  const go = useCallback((next: Place) => {
    window.history.pushState(null, "", formatPlace(next));
    setPlace(next);
    setRailOpen(false);
  }, []);

  useEffect(() => {
    const back = () => setPlace(here());
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);

  // The drawer closes with Escape, as anything that covers the page does.
  useEffect(() => {
    if (!railOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRailOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [railOpen]);

  const title = place.channel ?? "All channels";
  const waiting = data.unseen.size;
  useEffect(() => {
    document.title = `${waiting > 0 ? `(${waiting}) ` : ""}${title} · ${place.vibe} · Vibe`;
    // The tab's icon says the same thing the title does, for a tab too narrow to read.
    document
      .querySelector<HTMLLinkElement>('link[rel="icon"]')
      ?.setAttribute("href", waiting > 0 ? "/favicon-unread.svg" : "/favicon.svg");
  }, [title, place.vibe, waiting]);

  const can = data.me?.can;
  // In the thread, the thread's own channel decides. In the bay, what is listed does.
  const inThread = canIn(can, data.thread?.message.channel ?? null);
  const inBay = canIn(can, place.channel);
  const openRoot = data.thread?.message.id ?? null;

  return (
    <div
      className="shell"
      data-pane={place.thread === null ? "bay" : "thread"}
      data-rail={railOpen ? "open" : "closed"}
    >
      <a className="skip" href="#main">
        Skip to the threads
      </a>
      <Rail
        vibes={props.vibes}
        vibe={place.vibe}
        channels={data.channels}
        selected={place.channel}
        unseen={data.unseenChannels}
        me={data.me}
        liveness={data.liveness}
        onVibe={(vibe) => go({ vibe, channel: null, thread: null })}
        onChannel={(channel) => go({ ...place, channel, thread: null })}
        onSignOut={props.onSignOut}
      />
      <button type="button" className="scrim" tabIndex={-1} onClick={() => setRailOpen(false)}>
        <span className="visually-hidden">Close the channels</span>
      </button>
      <main id="main" className="panes">
        <Bay
          handle={handle}
          channel={place.channel}
          channels={data.channels}
          actors={data.actors}
          threads={data.threads}
          open={openRoot ?? place.thread}
          unseen={data.unseen}
          filters={filters}
          canPost={inBay.has("post")}
          canLabel={inBay.has("label")}
          hrefOf={(thread) => formatPlace({ ...place, thread })}
          onOpen={(thread) => go({ ...place, thread })}
          onFilters={setFilters}
          onPosted={(thread) => {
            void data.refresh();
            go({ ...place, thread });
          }}
          onMenu={() => setRailOpen(true)}
        />
        {place.thread === null ? (
          <section className="thread" aria-label="Thread">
            <div className="thread-placeholder">
              <p>Pick a thread to read it here.</p>
              <p>
                A strip's first box is the state the agents see. The dot means it changed since you
                last looked.
              </p>
            </div>
          </section>
        ) : (
          <ThreadView
            handle={handle}
            thread={data.thread}
            error={data.threadError}
            me={data.me}
            actors={data.actors}
            can={inThread}
            onChanged={data.refresh}
            onClose={() => go({ ...place, thread: null })}
            channelHref={formatPlace({
              ...place,
              channel: data.thread?.message.channel ?? place.channel,
              thread: null,
            })}
            onChannel={(channel) => go({ ...place, channel, thread: null })}
            listed={place.channel !== null && !place.channel.endsWith("/") ? place.channel : null}
          />
        )}
      </main>
    </div>
  );
}
