import { type DeviceLogin, VibeError } from "@vibe/sdk";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { useServices } from "../state/services.ts";

/** What a refusal says, in the words the API gave it. */
function said(error: unknown): string {
  if (error instanceof VibeError)
    return error.hint ? `${error.message} ${error.hint}` : error.message;
  return "Vibe could not be reached. Check that it is running, and try again.";
}

/**
 * Signing in. A token is pasted once and traded for a session the page can't
 * read. Where the Vibe has a GitHub app, a code is shown to enter at GitHub
 * instead, and no token is involved at all.
 */
export function SignIn({ onSignedIn }: { onSignedIn(): void }) {
  const services = useServices();
  const [github, setGitHub] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<DeviceLogin | null>(null);
  const waiting = useRef<AbortController | null>(null);

  useEffect(() => {
    services
      .ways()
      .then((ways) => setGitHub(ways.github))
      .catch(() => {});
    return () => waiting.current?.abort();
  }, [services]);

  async function withToken(event: FormEvent) {
    event.preventDefault();
    if (token.trim() === "") {
      setError("Paste a token to sign in.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await services.signIn(token);
      setToken("");
      onSignedIn();
    } catch (failure) {
      setError(said(failure));
    } finally {
      setBusy(false);
    }
  }

  async function withGitHub() {
    waiting.current?.abort();
    const stop = new AbortController();
    waiting.current = stop;
    setError(null);
    setBusy(true);
    try {
      await services.signInWithGitHub({ onCode: setCode, signal: stop.signal });
      onSignedIn();
    } catch (failure) {
      if (!stop.signal.aborted) setError(said(failure));
    } finally {
      setCode(null);
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <div className="signin-sheet">
        <h1 className="wordmark">Vibe</h1>
        <p className="signin-lede">
          A place where people and coding agents work in the same threads. Sign in to read and
          answer.
        </p>

        {code ? (
          <section className="signin-code" aria-live="polite">
            <h2>Enter this code at GitHub</h2>
            <p className="code-figure">{code.userCode}</p>
            <p>
              <a href={code.verificationUri} target="_blank" rel="noreferrer noopener">
                Open {new URL(code.verificationUri).host}
              </a>{" "}
              in any browser, enter the code, and approve. This page signs you in as soon as you
              have.
            </p>
            <button
              type="button"
              className="button"
              onClick={() => {
                waiting.current?.abort();
                setCode(null);
                setBusy(false);
              }}
            >
              Cancel
            </button>
          </section>
        ) : (
          <>
            {github && (
              <>
                <button
                  type="button"
                  className="button primary wide"
                  onClick={withGitHub}
                  disabled={busy}
                >
                  Sign in with GitHub
                </button>
                <p className="signin-or">or with a token</p>
              </>
            )}
            <form onSubmit={withToken} noValidate>
              <label htmlFor="token">Token</label>
              <input
                id="token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                aria-describedby="token-help"
                aria-invalid={error !== null}
              />
              <p id="token-help" className="hint">
                The <code>VIBE_TOKEN</code> that <code>vibe serve</code> printed, or one a team
                owner gave you. It is sent once and not kept: this browser gets a session instead.
              </p>
              <button
                type="submit"
                className={github ? "button wide" : "button primary wide"}
                disabled={busy}
              >
                {busy && !github ? "Signing in…" : "Sign in"}
              </button>
            </form>
          </>
        )}

        {error !== null && (
          <p className="notice danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
