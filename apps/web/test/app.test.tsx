import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import { App } from "../src/app.tsx";
import { ServicesProvider } from "../src/state/services.ts";
import { registerDom, unregisterDom } from "./dom.ts";
import { testVibe } from "./vibe.ts";

registerDom();
// The testing library looks for `document` when it is loaded, so it is loaded once there is one.
const { cleanup, configure, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
// The page hears of changes by itself, between a test's own steps. Those
// updates are the behaviour under test, not something a test forgot to wait for.
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
// The Vibe is in this process, and so is every other test: an answer can take a moment.
configure({ asyncUtilTimeout: 4000 });

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});
afterAll(async () => {
  cleanup();
  // What the last page still had under way is let finish before its world goes.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await unregisterDom();
});

type Vibe = ReturnType<typeof testVibe>;

function open(vibe: Vibe, at = "/") {
  window.history.replaceState(null, "", at);
  return render(
    <ServicesProvider value={vibe.services}>
      <App />
    </ServicesProvider>,
  );
}

/** Signs in through the page's own form, as a person would. */
async function signIn(token: string) {
  fireEvent.change(await screen.findByLabelText("Token"), { target: { value: token } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("tree", { name: "Channels" });
}

/** A Vibe with a person signed in to it, and the page open. */
async function signedIn(at = "/", role?: "owner" | "member" | "viewer") {
  const vibe = testVibe();
  const ada = await vibe.join("owner", "ada");
  const person = role === undefined || role === "owner" ? ada : await vibe.join(role, "vi");
  return { vibe, ada, person, at };
}

async function opened(setup: Awaited<ReturnType<typeof signedIn>>) {
  open(setup.vibe, setup.at);
  await signIn(setup.person.token);
  return setup;
}

/**
 * Whether a query found nothing. A matcher that fails prints what it was
 * given, and an element brings its whole document with it, which takes
 * seconds: so a test asks whether the element is there, and checks the answer.
 */
const gone = (found: unknown) => found === null;

/** Clicks a control once the page has finished what it was doing and the control can be used. */
async function press(control: HTMLElement) {
  await waitFor(() => expect((control as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(control);
}

const strips = () =>
  screen.queryAllByRole("link").filter((link) => link.classList.contains("strip"));
const strip = (text: string) => {
  const found = strips().find((each) => each.textContent?.includes(text));
  if (!found) throw new Error(`No strip says "${text}".`);
  return found;
};

describe("signing in", () => {
  test("a token gets you in, and the page keeps none of it", async () => {
    const vibe = testVibe();
    const { token, client } = await vibe.join("owner", "ada");
    await client.post("dev", "is the deploy done?");
    open(vibe);

    expect(await screen.findByRole("heading", { name: "Vibe" })).toBeTruthy();
    await signIn(token);
    expect(await screen.findByText("is the deploy done?")).toBeTruthy();

    // The session is the browser's, in a cookie. The token was sent once, in the sign-in itself.
    expect(vibe.cookie()).toStartWith("vibe_session=vibe_ses_");
    expect(vibe.requests.filter((request) => request.authorization !== null)).toEqual([]);
    expect(document.documentElement.innerHTML).not.toContain(token);
    expect(JSON.stringify({ ...window.localStorage }, null)).not.toContain("vibe_");
    expect(Object.keys(window.sessionStorage)).toEqual([]);
  });

  test("a token Vibe doesn't know is refused, in the API's words", async () => {
    const vibe = testVibe();
    await vibe.join("owner", "ada");
    open(vibe);
    fireEvent.change(await screen.findByLabelText("Token"), { target: { value: "vibe_sk_nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const refusal = await screen.findByRole("alert");
    expect(refusal.textContent).toContain("unknown or revoked");
    expect(vibe.cookie()).toBe("");

    // And an empty field is caught before anything is sent.
    cleanup();
    open(vibe);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Paste a token");
  });

  test("a sign-out the Vibe never heard is not shown as one", async () => {
    const { vibe } = await opened(await signedIn());
    // The Vibe can't be reached, the once.
    vibe.stepIn(async (input, init, pass) => {
      if (init.method !== "DELETE" || !input.endsWith("/v1/session")) return pass();
      vibe.stepIn(null);
      throw new TypeError("The network is away.");
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    // The session stands, so the page says so and stays where it is.
    expect((await screen.findByRole("alert")).textContent).toContain("still signed in");
    expect(screen.queryByLabelText("Token")).toBeNull();
    expect(vibe.cookie()).not.toBe("");

    // Tried again, it goes through.
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByLabelText("Token")).toBeTruthy();
    expect(vibe.cookie()).toBe("");
  });

  test("signing out ends the session", async () => {
    const { vibe } = await opened(await signedIn());
    const session = vibe.cookie();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByLabelText("Token")).toBeTruthy();
    expect(vibe.cookie()).toBe("");
    expect(session).not.toBe("");
  });
});

describe("channels and threads", () => {
  test("channels are a tree, and a place in it lists what is under it", async () => {
    const setup = await signedIn();
    const { client } = setup.ada;
    await client.post("dev", "in dev");
    await client.post("www/production", "in production");
    await client.post("www/staging", "in staging");
    await opened(setup);

    const tree = screen.getByRole("tree", { name: "Channels" });
    const names = () =>
      within(tree)
        .getAllByRole("treeitem")
        .map((item) => item.textContent);
    await waitFor(() =>
      expect(names()).toEqual(["All channels", "dev", "www", "production", "staging"]),
    );
    await waitFor(() => expect(strips()).toHaveLength(3));

    // One channel.
    fireEvent.click(within(tree).getByText("production"));
    await waitFor(() => expect(strips().map((each) => each.textContent)).toHaveLength(1));
    expect(strip("in production")).toBeTruthy();
    expect(window.location.pathname).toBe("/v/general/c/www/production");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("www/production");

    // A place that only groups channels lists everything under it.
    fireEvent.click(within(tree).getByText("www"));
    await waitFor(() => expect(strips()).toHaveLength(2));
    expect(window.location.pathname).toBe("/v/general/c/www/");

    // The tree is one stop for the keyboard, moved through with the arrows.
    const www = within(tree).getByText("www").closest("[role=treeitem]") as HTMLElement;
    www.focus();
    fireEvent.keyDown(www, { key: "ArrowLeft" });
    await waitFor(() => expect(names()).toEqual(["All channels", "dev", "www"]));
    expect(www.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(www, { key: "ArrowUp" });
    expect(document.activeElement?.textContent).toBe("dev");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter" });
    await waitFor(() => expect(strip("in dev")).toBeTruthy());
    expect(strips()).toHaveLength(1);
  });

  test("a thread is read as a log, with Markdown, who wrote it and what sits on it", async () => {
    const setup = await signedIn();
    const { client } = setup.ada;
    const root = await client.post("dev", "Is the **deploy** done?\n\n<script>alert(1)</script>", {
      labels: { state: "open", kind: "question" },
    });
    await client.as("fx").reply(root.id, "Yes: `a1b2c3` is live. cc @ada");
    await client.react(root.id, "eyes");
    await opened(setup);

    const row = await waitFor(() => strip("Is the deploy done?"));
    // The first box says the state, and the labels are the ones it doesn't.
    expect(within(row).getByText("open")).toBeTruthy();
    expect(within(row).getByText("kind=question")).toBeTruthy();
    expect(gone(within(row).queryByText("state=open"))).toBe(true);
    expect(row.textContent).toContain("1 reply, last from fx via ada");

    fireEvent.click(row);
    const thread = await screen.findByRole("region", { name: /dev/ });
    const messages = await waitFor(() => {
      const found = within(thread).getAllByRole("article");
      expect(found).toHaveLength(2);
      return found;
    });
    const [first, reply] = messages as [HTMLElement, HTMLElement];
    expect(first.querySelector("strong")?.textContent).toBe("deploy");
    // What a message holds is never run, or even made into elements.
    expect(gone(thread.querySelector("script"))).toBe(true);
    // The thread's state is said once, in the box at its head, not again as a label on its root.
    expect(thread.querySelector(".thread-title .state-box")?.textContent).toBe("open");
    expect(gone(within(first).queryByText("state=open"))).toBe(true);
    expect(
      within(first)
        .getByRole("button", { name: /eyes, 1/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(within(reply).getByText("fx via ada")).toBeTruthy();
    expect(reply.querySelector("code")?.textContent).toBe("a1b2c3");
    expect(reply.querySelector(".mention")?.textContent).toBe("@ada");
    expect(window.location.search).toBe(`?t=${root.id}`);
  });

  test("a reply is written with a mention, and shows at once", async () => {
    const setup = await signedIn();
    const grace = await setup.vibe.join("member", "grace");
    const root = await setup.ada.client.post("dev", "who can rotate the key?");
    await opened({ ...setup, at: `/v/general/c/dev?t=${root.id}` });

    const field = (await screen.findByLabelText("Reply")) as HTMLTextAreaElement;
    // A handle is completed from the people you can see.
    fireEvent.change(field, { target: { value: "@gr", selectionStart: 3 } });
    const option = await screen.findByRole("option", { name: /@grace/ });
    expect(field.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field.value).toBe("@grace ");
    expect(option.isConnected).toBe(false);

    fireEvent.change(field, { target: { value: "@grace can, *today*", selectionStart: 19 } });
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    const thread = screen.getByRole("region", { name: /dev/ });
    await waitFor(() => expect(within(thread).getAllByRole("article")).toHaveLength(2));
    const reply = within(thread).getAllByRole("article")[1] as HTMLElement;
    expect(reply.querySelector(".mention")?.textContent).toBe("@grace");
    expect(reply.querySelector("em")?.textContent).toBe("today");
    expect(field.value).toBe("");

    const stored = await grace.client.thread(root.id);
    expect(stored.replies[0]?.mentions.map((mention) => mention.handle)).toEqual(["grace"]);
    // Nothing to post is said so, and not sent.
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Write something");
  });

  test("a thread is started from the bay, and opens", async () => {
    const setup = await signedIn("/v/general/c/dev");
    await setup.ada.client.post("dev", "an earlier thread");
    await opened(setup);

    fireEvent.click(await screen.findByRole("button", { name: "New thread" }));
    const field = await screen.findByLabelText("New thread");
    fireEvent.change(field, { target: { value: "The staging database is at 91% disk." } });
    fireEvent.click(screen.getByRole("button", { name: "Labels" }));
    fireEvent.change(screen.getByLabelText("Labels"), { target: { value: "kind=ops state=open" } });
    fireEvent.click(screen.getByRole("button", { name: "Post" }));

    const thread = await screen.findByRole("region", { name: /dev/ });
    expect(await within(thread).findByText("The staging database is at 91% disk.")).toBeTruthy();
    await waitFor(() => expect(strips()).toHaveLength(2));
    const row = strip("The staging database");
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(within(row).getByText("kind=ops")).toBeTruthy();
    // A label that isn't one is said so before anything is posted.
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    fireEvent.change(await screen.findByLabelText("New thread"), { target: { value: "x" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Labels" })[0] as HTMLElement);
    fireEvent.change(screen.getAllByLabelText("Labels")[0] as HTMLElement, {
      target: { value: "not a label" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Post" }));
    expect((await screen.findAllByRole("alert"))[0]?.textContent).toContain("is not a label");
  });

  test("you react, label, edit and delete, and the page shows what the vibe holds", async () => {
    const setup = await signedIn();
    const { client } = setup.ada;
    const root = await client.post("dev", "v1 of the plan");
    await opened({ ...setup, at: `/v/general/c/dev?t=${root.id}` });
    const thread = await screen.findByRole("region", { name: /dev/ });
    const message = () => within(thread).getAllByRole("article")[0] as HTMLElement;
    await waitFor(() => expect(message().textContent).toContain("v1 of the plan"));

    // A reaction, and taking it back.
    fireEvent.click(within(message()).getByRole("button", { name: "React" }));
    fireEvent.click(within(message()).getByRole("button", { name: "rocket" }));
    const rocket = await within(thread).findByRole("button", { name: /rocket, 1/ });
    expect((await client.thread(root.id)).message.reactions).toMatchObject([{ emoji: "rocket" }]);
    await press(rocket);
    await waitFor(() =>
      expect(gone(within(thread).queryByRole("button", { name: /rocket, 1/ }))).toBe(true),
    );

    // A label, and removing it.
    fireEvent.click(within(message()).getByRole("button", { name: "Add a label" }));
    const label = await within(thread).findByLabelText("Label, as key=value");
    fireEvent.change(label, { target: { value: "state=review" } });
    fireEvent.submit(label.closest("form") as HTMLFormElement);
    // A root's `state` goes to the box at the thread's head. It is taken off where labels are changed.
    await waitFor(() =>
      expect(thread.querySelector(".thread-title .state-box")?.textContent).toBe("review"),
    );
    expect((await client.thread(root.id)).message.labels).toEqual({ state: "review" });
    expect(gone(within(thread).queryByText("state=review"))).toBe(true);
    fireEvent.click(within(message()).getByRole("button", { name: "Add a label" }));
    expect(await within(thread).findByText("state=review")).toBeTruthy();
    await press(within(thread).getByRole("button", { name: "Remove the label state" }));
    await waitFor(() => expect(gone(thread.querySelector(".thread-title .state-box"))).toBe(true));
    expect((await client.thread(root.id)).message.labels).toEqual({});

    // An edit.
    fireEvent.click(within(message()).getByRole("button", { name: "Edit" }));
    const edit = (await within(thread).findByLabelText("Edit message")) as HTMLTextAreaElement;
    expect(edit.value).toBe("v1 of the plan");
    fireEvent.change(edit, { target: { value: "v2 of the plan" } });
    fireEvent.click(within(thread).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(message().textContent).toContain("v2 of the plan"));
    expect(message().textContent).toContain("edited");

    // A delete asks first, and leaves a marker.
    fireEvent.click(within(message()).getByRole("button", { name: "Delete" }));
    const confirm = await within(thread).findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep it" }));
    expect(message().textContent).toContain("v2 of the plan");
    fireEvent.click(within(message()).getByRole("button", { name: "Delete" }));
    fireEvent.click(
      within(await within(thread).findByRole("alertdialog")).getByRole("button", {
        name: "Delete",
      }),
    );
    await waitFor(() => expect(message().textContent).toContain("deleted"));
    expect((await client.thread(root.id)).message.deletedAt).not.toBeNull();
  });

  test("an edit begun before someone else's is refused, and overwrites nothing", async () => {
    const setup = await signedIn();
    const { client } = setup.ada;
    const root = await client.post("dev", "the plan, as first written");
    await opened({ ...setup, at: `/v/general/c/dev?t=${root.id}` });
    const thread = await screen.findByRole("region", { name: /dev/ });
    const message = () => within(thread).getAllByRole("article")[0] as HTMLElement;
    await waitFor(() => expect(message().textContent).toContain("as first written"));

    // The editor is opened on the first revision.
    fireEvent.click(within(message()).getByRole("button", { name: "Edit" }));
    const edit = (await within(thread).findByLabelText("Edit message")) as HTMLTextAreaElement;
    fireEvent.change(edit, { target: { value: "the plan, from the page" } });

    // Meanwhile the same person changes it from their terminal, and the page hears of it.
    await client.edit(root.id, "the plan, from the terminal");
    await waitFor(async () => {
      const heard = setup.vibe.requests.filter((request) => request.url.includes("/threads/"));
      expect(heard.length).toBeGreaterThan(1);
    });
    await Bun.sleep(300);

    // The draft was a change to the first revision, which is no longer what is there.
    fireEvent.click(within(thread).getByRole("button", { name: "Save" }));
    expect((await within(thread).findByRole("alert")).textContent).toMatch(/chang|revision/i);
    expect((await client.thread(root.id)).message.text).toBe("the plan, from the terminal");
  });

  test("a file is attached, and offered as a download from the API", async () => {
    const setup = await signedIn();
    const root = await setup.ada.client.post("dev", "send me the trace");
    await opened({ ...setup, at: `/v/general/c/dev?t=${root.id}` });
    await screen.findByLabelText("Reply");

    const picker = document.querySelector<HTMLInputElement>('.thread-reply input[type="file"]');
    const file = new File(["line 1\nline 2\n"], "trace.txt", { type: "text/plain" });
    fireEvent.change(picker as HTMLInputElement, { target: { files: [file] } });
    const uploads = await screen.findByRole("list", { name: "Files to attach" });
    await waitFor(() => expect(uploads.textContent).toContain("14 B"));
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    const link = (await screen.findByRole("link", { name: /trace\.txt/ })) as HTMLAnchorElement;
    const { replies } = await setup.ada.client.thread(root.id);
    const attached = replies[0]?.attachments[0];
    expect(attached).toMatchObject({ name: "trace.txt", size: 14 });
    // The link is to the API on this origin, which serves every file as a download.
    expect(new URL(link.href).pathname).toBe(`/v1/vibes/general/attachments/${attached?.id}`);
    expect(link.getAttribute("download")).toBe("trace.txt");
    const served = await setup.vibe.services.connect("general").download(attached?.id ?? "");
    expect(served.response.headers.get("content-disposition")).toStartWith("attachment");
    expect(await served.response.text()).toBe("line 1\nline 2\n");
  });
});

describe("tasks", () => {
  test("a task shows where it stands, and its owner unblocks or cancels it", async () => {
    const setup = await signedIn();
    const { client } = setup.ada;
    const [task] = await client
      .as("lead")
      .tasks.createMany("work", [{ text: "rotate the staging credentials" }]);
    const id = task?.task.id ?? "";
    const worker = client.as("fixer");
    const claim = await worker.tasks.claim(id);
    await claim?.block("needs someone with access to the vault", { kind: "awaiting_approval" });
    await opened({ ...setup, at: `/v/general/c/work?t=${id}` });

    const panel = await screen.findByRole("region", { name: "Task" });
    expect(panel.textContent).toContain("blocked");
    expect(panel.textContent).toContain("Task owned by lead via ada");
    expect(panel.textContent).toContain(
      "Waiting for approval: needs someone with access to the vault",
    );
    expect(within(strip("rotate the staging")).getByText("blocked")).toBeTruthy();

    fireEvent.click(within(panel).getByRole("button", { name: "Unblock" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Task" }).textContent).toContain("ready"),
    );
    expect((await client.tasks.get(id)).task.state).toBe("ready");
    await waitFor(() =>
      expect(within(strip("rotate the staging")).getByText("ready")).toBeTruthy(),
    );

    // Canceling asks why, for whoever reads the thread later.
    fireEvent.click(
      within(screen.getByRole("region", { name: "Task" })).getByRole("button", {
        name: "Cancel task",
      }),
    );
    const reason = await screen.findByLabelText("Why is it canceled?");
    fireEvent.submit(reason.closest("form") as HTMLFormElement);
    expect((await screen.findByRole("alert")).textContent).toContain("Say why");
    fireEvent.change(reason, { target: { value: "done by hand" } });
    fireEvent.submit(reason.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Task" }).textContent).toContain("canceled"),
    );
    expect((await client.tasks.get(id)).task).toMatchObject({
      state: "canceled",
      reason: "done by hand",
    });
  });
});

describe("what you can't do isn't offered", () => {
  test("a viewer reads and reacts, and is shown nothing they would be refused", async () => {
    const setup = await signedIn("/", "viewer");
    const root = await setup.ada.client.post("dev", "read-only for some");
    await opened({ ...setup, at: `/v/general/c/dev?t=${root.id}` });

    const thread = await screen.findByRole("region", { name: /dev/ });
    await within(thread).findByText("read-only for some");
    expect(gone(screen.queryByRole("button", { name: "New thread" }))).toBe(true);
    expect(gone(screen.queryByLabelText("Reply"))).toBe(true);
    expect(thread.textContent).toContain("You can read this channel, and not post in it.");
    expect(gone(within(thread).queryByRole("button", { name: "Add a label" }))).toBe(true);
    expect(gone(within(thread).queryByRole("button", { name: "Edit" }))).toBe(true);
    expect(within(thread).getByRole("button", { name: "React" })).toBeTruthy();
  });

  test("a channel closed to you isn't in the tree, and its thread isn't there to open", async () => {
    const setup = await signedIn("/", "member");
    const { client } = setup.ada;
    await client.createChannel("security", { private: true });
    const secret = await client.post("security", "the incident report");
    await client.post("dev", "open to all");
    await opened({ ...setup, at: `/v/general?t=${secret.id}` });

    const tree = screen.getByRole("tree", { name: "Channels" });
    await waitFor(() => expect(within(tree).getByText("dev")).toBeTruthy());
    expect(gone(within(tree).queryByText("security"))).toBe(true);
    await waitFor(() => expect(strips()).toHaveLength(1));
    expect(document.body.textContent).not.toContain("the incident report");
    expect(await screen.findByText(/No message has the ID/)).toBeTruthy();
  });
});

describe("live", () => {
  test("what is written while the page is still opening is not missed", async () => {
    const setup = await signedIn();
    const grace = await setup.vibe.join("member", "grace");
    await setup.ada.client.post("dev", "there from the start");
    // Someone posts just after the page has read its list, and before it starts following the log.
    let posted = false;
    setup.vibe.stepIn(async (input, _init, pass) => {
      const response = await pass();
      if (!posted && input.includes("/threads?")) {
        posted = true;
        await grace.client.post("dev", "written while it opened");
      }
      return response;
    });
    await opened(setup);
    await waitFor(() => expect(strips().length).toBe(2));
    expect(strip("written while it opened")).toBeTruthy();
  });

  test("a page told it asks too often goes on listening once it may", async () => {
    const setup = await signedIn();
    const grace = await setup.vibe.join("member", "grace");
    await setup.ada.client.post("dev", "there from the start");
    // The Vibe turns one request for events away, as it does an address over its budget.
    let turnedAway = 0;
    setup.vibe.stepIn(async (input, _init, pass) => {
      if (turnedAway > 0 || !input.includes("/events?")) return pass();
      turnedAway += 1;
      return Response.json(
        { code: "rate_limited", message: "Too many." },
        { status: 429, headers: { "retry-after": "1" } },
      );
    });
    await opened(setup);
    await waitFor(() => expect(turnedAway).toBe(1));
    await grace.client.post("dev", "written after the page was turned away");
    await waitFor(() => expect(strips().length).toBe(2), { timeout: 4000 });
  });

  test("activity arrives by itself, moves its strip to the head of the bay, and is marked until read", async () => {
    const setup = await signedIn();
    const { client } = setup.ada;
    const grace = await setup.vibe.join("member", "grace");
    const older = await client.post("dev", "the older thread");
    // Two threads that moved in the same millisecond have no order to speak of.
    await Bun.sleep(3);
    await client.post("www/production", "the newer thread");
    await opened(setup);
    await waitFor(() =>
      expect(strips().map((each) => each.textContent?.includes("newer"))).toEqual([true, false]),
    );

    // Someone else replies in the older thread. Nothing on the page asked for it.
    await grace.client.reply(older.id, "any news?");
    await waitFor(() => expect(strips()[0]?.textContent).toContain("the older thread"));
    const moved = strip("the older thread");
    expect(moved.textContent).toContain("1 reply, last from grace");
    expect(within(moved).getByText("New activity")).toBeTruthy();
    const tree = screen.getByRole("tree", { name: "Channels" });
    const dev = within(tree).getByText("dev").closest("[role=treeitem]") as HTMLElement;
    expect(within(dev).getByText("new activity")).toBeTruthy();
    expect(document.title).toStartWith("(1) ");

    // A new channel shows up in the tree as it is made.
    await grace.client.post("design", "new empty states");
    await waitFor(() => expect(within(tree).getByText("design")).toBeTruthy());

    // Reading the thread clears its mark. Your own writing never sets one.
    fireEvent.click(moved);
    await screen.findByText("any news?");
    await waitFor(() =>
      expect(gone(within(strip("the older thread")).queryByText("New activity"))).toBe(true),
    );
    fireEvent.change(await screen.findByLabelText("Reply"), { target: { value: "none yet" } });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await screen.findByText("none yet");
    expect(gone(within(strip("the older thread")).queryByText("New activity"))).toBe(true);
    // What arrives in the thread you are reading shows there too.
    await grace.client.reply(older.id, "thanks");
    expect(await screen.findByText("thanks")).toBeTruthy();
  });
});
