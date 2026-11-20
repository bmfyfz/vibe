/** A GitHub account, as GitHub's API describes it. */
export interface StubAccount {
  id: number;
  login: string;
  name?: string | null;
  email?: string | null;
}

interface Device {
  userCode: string;
  state: "pending" | "approved" | "denied" | "expired";
  /** How many times GitHub will say it is being asked too often before it answers. */
  slowDowns: number;
  account?: StubAccount;
}

/**
 * GitHub's device flow, as much of it as Vibe speaks, in memory. It answers
 * the three requests Vibe makes, and passes everything else on to the real
 * `fetch`. What a person would do in a browser, a test does by calling
 * `approve` or `deny`.
 */
export function githubStub(clientId: string) {
  const devices = new Map<string, Device>();
  const tokens = new Map<string, StubAccount>();
  /** Every request Vibe made to GitHub, to check what it sent and what it kept to itself. */
  const requests: { url: string; body: string; authorization: string | null }[] = [];
  let made = 0;

  const byUserCode = (userCode: string) => {
    const device = [...devices.values()].find((each) => each.userCode === userCode);
    if (!device) throw new Error(`The stub gave out no code ${userCode}.`);
    return device;
  };
  const json = (body: unknown, status = 200) => Response.json(body, { status });

  return {
    clientId,
    requests,
    /** The person enters the code in a browser, signed in as this account, and approves. */
    approve(userCode: string, account: StubAccount) {
      Object.assign(byUserCode(userCode), { state: "approved", account });
    },
    /** The person enters the code and says no. */
    deny(userCode: string) {
      byUserCode(userCode).state = "denied";
    },
    /** The code runs out before anyone enters it. */
    expire(userCode: string) {
      byUserCode(userCode).state = "expired";
    },
    /** GitHub will say it is asked too often, this many times, before it answers. */
    slowDown(userCode: string, times = 1) {
      byUserCode(userCode).slowDowns = times;
    },

    async fetch(url: string, init: RequestInit = {}): Promise<Response> {
      const { hostname, pathname } = new URL(url);
      if (hostname !== "github.com" && hostname !== "api.github.com") return fetch(url, init);

      const headers = new Headers(init.headers);
      const body = typeof init.body === "string" ? init.body : "";
      requests.push({ url, body, authorization: headers.get("authorization") });
      const form = new URLSearchParams(body);

      if (hostname === "github.com" && pathname === "/login/device/code") {
        if (form.get("client_id") !== clientId)
          return json({ error: "incorrect_client_credentials" });
        const n = ++made;
        const device: Device = {
          userCode: `STUB-${String(n).padStart(4, "0")}`,
          state: "pending",
          slowDowns: 0,
        };
        devices.set(`device-code-${n}-${crypto.randomUUID()}`, device);
        const [deviceCode] = [...devices].find(([, each]) => each === device) ?? [];
        return json({
          device_code: deviceCode,
          user_code: device.userCode,
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        });
      }

      if (hostname === "github.com" && pathname === "/login/oauth/access_token") {
        const device = devices.get(form.get("device_code") ?? "");
        if (form.get("client_id") !== clientId)
          return json({ error: "incorrect_client_credentials" });
        if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:device_code") {
          return json({ error: "unsupported_grant_type" });
        }
        if (!device) return json({ error: "incorrect_device_code" });
        if (device.slowDowns > 0) {
          device.slowDowns -= 1;
          return json({ error: "slow_down", interval: 10 });
        }
        if (device.state === "pending") return json({ error: "authorization_pending" });
        if (device.state === "denied") return json({ error: "access_denied" });
        if (device.state === "expired" || !device.account) return json({ error: "expired_token" });
        // A code is good for one token, as at GitHub.
        device.state = "expired";
        const token = `gho_stub_${crypto.randomUUID()}`;
        tokens.set(token, device.account);
        return json({ access_token: token, token_type: "bearer", scope: "" });
      }

      if (hostname === "api.github.com" && pathname === "/user") {
        const account = tokens.get((headers.get("authorization") ?? "").replace(/^Bearer /, ""));
        if (!account) return json({ message: "Bad credentials" }, 401);
        return json({ name: null, email: null, ...account });
      }
      return json({ message: "Not Found" }, 404);
    },
  };
}

export type GitHubStub = ReturnType<typeof githubStub>;
