import {
  type DeviceAuthorizer,
  type DeviceCheck,
  type DeviceCode,
  githubUnavailable,
} from "../application/sign-in.ts";

/** How this adapter reaches GitHub. `fetch`, unless a test stands in for it. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const DEVICE_CODE = "https://github.com/login/device/code";
const ACCESS_TOKEN = "https://github.com/login/oauth/access_token";
const USER = "https://api.github.com/user";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * GitHub's device flow, for an OAuth app that has it enabled. It needs the
 * app's client ID and no secret. It asks for no scopes: all Vibe wants is to
 * know which account approved, and the token GitHub issues is used for that
 * one question and then dropped.
 */
export class GitHubDeviceFlow implements DeviceAuthorizer {
  constructor(
    private readonly clientId: string,
    private readonly send: Fetch,
  ) {}

  async begin(): Promise<DeviceCode> {
    const body = await this.form(DEVICE_CODE, { client_id: this.clientId });
    const { device_code, user_code, verification_uri, expires_in, interval } = body;
    if (typeof device_code !== "string" || typeof user_code !== "string") {
      throw githubUnavailable(describe(body) ?? "it gave no code to show.");
    }
    return {
      deviceCode: device_code,
      userCode: user_code,
      verificationUri:
        typeof verification_uri === "string" ? verification_uri : "https://github.com/login/device",
      expiresIn: typeof expires_in === "number" ? expires_in : 900,
      interval: typeof interval === "number" ? interval : 5,
    };
  }

  async check(deviceCode: string): Promise<DeviceCheck> {
    const body = await this.form(ACCESS_TOKEN, {
      client_id: this.clientId,
      device_code: deviceCode,
      grant_type: DEVICE_GRANT,
    });
    if (typeof body["access_token"] === "string") {
      return { status: "authorized", account: await this.account(body["access_token"]) };
    }
    switch (body["error"]) {
      case "authorization_pending":
        return { status: "pending", interval: null };
      // GitHub says by how much to slow down, and counts every early ask against the device.
      case "slow_down":
        return {
          status: "pending",
          interval: typeof body["interval"] === "number" ? body["interval"] : 10,
        };
      case "access_denied":
        return { status: "denied" };
      case "expired_token":
      case "incorrect_device_code":
        return { status: "expired" };
      default:
        throw githubUnavailable(describe(body) ?? "it gave no answer about the sign-in.");
    }
  }

  /** Asks GitHub who a token belongs to. */
  private async account(token: string) {
    const response = await this.request(USER, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "vibe",
      },
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || typeof body?.["id"] !== "number" || typeof body["login"] !== "string") {
      throw githubUnavailable(`it would not say who signed in (${response.status}).`);
    }
    return {
      id: body["id"],
      login: body["login"],
      name: typeof body["name"] === "string" ? body["name"] : null,
      email: typeof body["email"] === "string" ? body["email"] : null,
    };
  }

  private async form(
    url: string,
    fields: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const response = await this.request(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "vibe",
      },
      body: new URLSearchParams(fields).toString(),
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (body === null || typeof body !== "object") {
      throw githubUnavailable(`it answered ${response.status}, with nothing to read.`);
    }
    return body;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.send(url, { ...init, signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      throw githubUnavailable(error instanceof Error ? error.message : String(error));
    }
  }
}

/** What GitHub said went wrong, such as that the app has no device flow, in its own words. */
function describe(body: Record<string, unknown>): string | null {
  const said = body["error_description"] ?? body["error"];
  return typeof said === "string" ? said : null;
}
