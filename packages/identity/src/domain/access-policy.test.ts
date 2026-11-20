import { describe, expect, test } from "bun:test";

import { DomainError, parseChannelPattern } from "@vibe/kernel";

import { AccessPolicy } from "./access-policy.ts";
import { type Can, DEFAULT_GRANTS, type Grant, type GrantPrincipal, parseCan } from "./grant.ts";
import type { Permission, Role } from "./role.ts";

const alice = "vibe:user:u_alice";
const bob = "vibe:user:u_bob";
const user = (id: string): GrantPrincipal => ({ kind: "user", id });
const everyone: GrantPrincipal = { kind: "everyone" };
const allUsers: GrantPrincipal = { kind: "all-users" };
const ci = "vibe:service:s_ci";
const service = (id: string): GrantPrincipal => ({ kind: "service", id });
const allServices: GrantPrincipal = { kind: "all-services" };

let n = DEFAULT_GRANTS.length;
const grant = (principals: GrantPrincipal[], can: Record<string, unknown>): Grant => ({
  n: ++n,
  principals,
  can: parseCan(can),
});
const access = (grants: readonly Grant[], principal: string, role: Role = "member") =>
  new AccessPolicy(grants).for({ principal, role });
const can = (grants: readonly Grant[], principal: string, channel: string, role?: Role) =>
  [...access(grants, principal, role).in(channel).can].sort();
const ALL: Permission[] = ["label", "manage", "post", "react", "read", "sync"];

describe("access policy", () => {
  test("a new vibe lets the whole team in, as far as each role allows", () => {
    expect(can(DEFAULT_GRANTS, alice, "dev")).toEqual(ALL);
    expect(can(DEFAULT_GRANTS, alice, "dev", "viewer")).toEqual(["react", "read"]);
    expect(access(DEFAULT_GRANTS, alice).in("dev")).toMatchObject({ pattern: "*", grants: ["g1"] });
    expect(access(DEFAULT_GRANTS, alice).scope("read").all).toBe(true);
    expect(access(DEFAULT_GRANTS, alice, "viewer").scope("post").allows("dev")).toBe(false);
  });

  test("the most specific pattern wins: exact, then the longest subtree, then *", () => {
    const grants = [
      ...DEFAULT_GRANTS,
      grant([everyone], { "security/": "none" }),
      grant([everyone], { "security/public/": "read" }),
      grant([everyone], { "security/public/faq": "read,post" }),
    ];
    expect(can(grants, bob, "dev")).toEqual(ALL);
    expect(can(grants, bob, "security/incidents")).toEqual([]);
    expect(can(grants, bob, "security/public/news")).toEqual(["read"]);
    expect(can(grants, bob, "security/public/faq")).toEqual(["post", "read"]);
    // A subtree holds what is under it, not the channel of the same name.
    expect(can(grants, bob, "security")).toEqual(ALL);
  });

  test("at one pattern the closest principal wins, so a grant at * doesn't get you into a closed subtree", () => {
    const grants = [
      ...DEFAULT_GRANTS,
      grant([user(bob)], { "*": "all" }),
      grant([user(alice)], { "security/": "all" }),
      grant([everyone], { "security/": "none" }),
    ];
    expect(can(grants, alice, "security/incidents")).toEqual(ALL);
    expect(can(grants, bob, "security/incidents")).toEqual([]);
    expect(access(grants, bob).in("security/incidents")).toMatchObject({
      pattern: "security/",
      grants: [`g${grants.at(-1)?.n}`],
    });
    // A group is closer than everyone, and further than the person.
    const team = [...grants, grant([allUsers], { "security/": "read" })];
    expect(can(team, bob, "security/incidents")).toEqual(["read"]);
    expect(can(team, alice, "security/incidents")).toEqual(ALL);
  });

  test("grants tied at the pattern and the principal add up", () => {
    const grants = [
      grant([user(bob)], { "ops/": "read" }),
      grant([user(bob), user(alice)], { "ops/": ["react", "label"] }),
      grant([everyone], { "ops/": "all" }),
    ];
    const decision = access(grants, bob).in("ops/deploys");
    expect([...decision.can].sort()).toEqual(["label", "react", "read"]);
    expect(decision.grants).toHaveLength(2);
  });

  test("the role caps the result, and grants never give more than it allows", () => {
    const grants = [grant([user(bob)], { "ops/": "all" })];
    const decision = access(grants, bob, "viewer").in("ops/deploys");
    expect(decision.granted).toEqual(["read", "post", "react", "label", "sync", "manage"]);
    expect([...decision.can].sort()).toEqual(["react", "read"]);
  });

  test("no grant, no access: everyone alone names whoever is on the team, nothing names an outsider", () => {
    expect(can([grant([user(alice)], { "*": "all" })], bob, "dev")).toEqual([]);
    expect(can([grant([allUsers], { "*": "all" })], "vibe:service:s_ci", "dev")).toEqual([]);
    expect(access([], bob).scope("read").allows("dev")).toBe(false);
  });

  test("a service starts with reading, writing and syncing everywhere, and no say over grants", () => {
    expect(can(DEFAULT_GRANTS, ci, "dev", "service")).toEqual([
      "label",
      "post",
      "react",
      "read",
      "sync",
    ]);
    expect(access(DEFAULT_GRANTS, ci, "service").in("dev")).toMatchObject({
      pattern: "*",
      grants: ["g2"],
    });
    // What names every person names no service, and the other way round.
    expect(can([grant([allServices], { "*": "all" })], bob, "dev")).toEqual([]);
  });

  test("sync is a permission like the others: a viewer's role doesn't allow it, and a grant can take it away", () => {
    expect(can(DEFAULT_GRANTS, alice, "dev")).toContain("sync");
    expect(can(DEFAULT_GRANTS, alice, "dev", "viewer")).toEqual(["react", "read"]);
    const grants = [...DEFAULT_GRANTS, grant([allServices], { "private/": "read,post" })];
    expect(can(grants, ci, "private/notes", "service")).toEqual(["post", "read"]);
    expect(can(grants, ci, "dev", "service")).toContain("sync");
  });

  test("a grant names one service, closer than every service, and its role caps nothing", () => {
    const grants = [
      ...DEFAULT_GRANTS,
      grant([everyone], { "deploys/": "none" }),
      grant([allServices], { "deploys/": "read" }),
      grant([service(ci)], { "deploys/": "all" }),
    ];
    expect(can(grants, ci, "deploys/www", "service")).toEqual(ALL);
    expect(can(grants, "vibe:service:s_other", "deploys/www", "service")).toEqual(["read"]);
    expect(can(grants, bob, "deploys/www")).toEqual([]);
  });

  test("access at a pattern ignores grants for channels inside it", () => {
    const grants = [
      ...DEFAULT_GRANTS,
      grant([everyone], { "security/": "none" }),
      grant([user(alice)], { "security/": "all" }),
    ];
    const at = (principal: string, pattern: string) =>
      access(grants, principal).at(parseChannelPattern(pattern)).can.has("manage");
    expect(at(bob, "*")).toBe(true);
    expect(at(bob, "dev/")).toBe(true);
    expect(at(bob, "security/")).toBe(false);
    expect(at(bob, "security/incidents")).toBe(false);
    expect(at(alice, "security/incidents/")).toBe(true);
  });

  test("a scope excludes exactly the channels closed to the subject", () => {
    const grants = [...DEFAULT_GRANTS, grant([everyone], { secret: "none", "secret/": "none" })];
    const scope = access(grants, bob).scope("read");
    expect(scope.all).toBe(false);
    expect(["dev", "secret", "secret/plans", "secrets"].map((c) => scope.allows(c))).toEqual([
      true,
      false,
      false,
      true,
    ]);
    expect(access(grants, bob).anywhere("post")).toBe(true);
    // What is closed to him isn't named to him.
    expect(access(grants, bob).map()).toEqual({
      "*": ["read", "post", "react", "label", "sync", "manage"],
    });
  });
});

describe("a narrowed access", () => {
  const whole = () =>
    access(
      [
        ...DEFAULT_GRANTS,
        grant([everyone], { "security/": "none" }),
        grant([everyone], { "dev/quiet": "read" }),
      ],
      bob,
    );
  const sorted = (permissions: ReadonlySet<Permission>) => [...permissions].sort();

  test("leaves, in every channel, what both the access and the limit allow there", () => {
    const narrowed = whole().narrowedTo(parseCan({ "dev/": "read,post", "security/": "all" }));
    expect(sorted(narrowed.in("dev/bugs").can)).toEqual(["post", "read"]);
    // The access's own more specific pattern still decides inside the limit's.
    expect(sorted(narrowed.in("dev/quiet").can)).toEqual(["read"]);
    // What the limit names and the access lacks stays closed.
    expect(sorted(narrowed.in("security/incidents").can)).toEqual([]);
    // What the limit doesn't name is closed, whatever the access says.
    expect(sorted(narrowed.in("ops").can)).toEqual([]);
    expect(narrowed.scope("read").all).toBe(false);
    expect(narrowed.anywhere("manage")).toBe(false);
    expect(narrowed.map()).toEqual({ "dev/": ["read", "post"], "dev/quiet": ["read"] });
  });

  test("is decided by the limit's most specific pattern too", () => {
    const narrowed = whole().narrowedTo(
      parseCan({ "*": "read", "dev/": "all", "dev/locked": "none" }),
    );
    expect(sorted(narrowed.in("ops").can)).toEqual(["read"]);
    expect(sorted(narrowed.in("dev/bugs").can)).toEqual(ALL);
    expect(sorted(narrowed.in("dev/locked").can)).toEqual([]);
    expect(sorted(narrowed.in("dev/quiet").can)).toEqual(["read"]);
    expect(narrowed.at(parseChannelPattern("dev/")).can.has("manage")).toBe(true);
    expect(narrowed.at(parseChannelPattern("*")).can.has("manage")).toBe(false);
  });

  test("narrows again, and never widens", () => {
    const once = whole().narrowedTo(parseCan({ "dev/": "read,post" }));
    const twice = once.narrowedTo(parseCan({ "*": "all" }));
    expect(twice.map()).toEqual(once.map());
    const less = once.narrowedTo(parseCan({ "dev/bugs": "read" }));
    expect(less.map()).toEqual({ "dev/bugs": ["read"] });
    expect(
      whole()
        .narrowedTo(parseCan({ "*": "all" }))
        .map(),
    ).toEqual(whole().map());
  });
});

describe("what a grant gives", () => {
  test("is all, none, or a list of permissions, at patterns in one spelling", () => {
    const parsed: Can = parseCan({ "*": "all", "www/": "read, post", dev: ["label"], x: "none" });
    expect(parsed).toEqual({
      "*": ["read", "post", "react", "label", "sync", "manage"],
      "www/": ["read", "post"],
      dev: ["label"],
      x: [],
    });
  });

  test("is refused when it isn't that", () => {
    for (const bad of [
      {},
      { "": "all" },
      { "Not A Channel": "all" },
      { dev: "sink" },
      { dev: 5 },
    ]) {
      expect(() => parseCan(bad)).toThrow(DomainError);
    }
  });
});
