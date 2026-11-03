import { expect, test } from "bun:test";
import { handleJiraOAuthCallback } from "./callback";

const base = "https://roamgate.example/api/integrations/jira/oauth/callback";

test("a valid callback completes sign-in", async () => {
  const calls: [string | null, string | null][] = [];
  const response = await handleJiraOAuthCallback(
    new Request(`${base}?code=c1&state=s1`),
    {
      completeOAuth: async (code, state) => {
        calls.push([code, state]);
        return { account: "Ada", site_url: "https://acme.atlassian.net" };
      },
    },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toContain("close this window");
  expect(calls).toEqual([["c1", "s1"]]);
});

test("failures are shown escaped and refuse with 400", async () => {
  const response = await handleJiraOAuthCallback(
    new Request(`${base}?code=c1&state=bad`),
    {
      completeOAuth: async () => {
        throw new Error("<script>expired</script>");
      },
    },
  );
  expect(response.status).toBe(400);
  const body = await response.text();
  expect(body).not.toContain("<script>");
  expect(body).toContain("&lt;script&gt;");
});

test("an OAuth error consumes the state without a code", async () => {
  const calls: [string | null, string | null][] = [];
  const response = await handleJiraOAuthCallback(
    new Request(`${base}?error=access_denied&state=s1`),
    {
      completeOAuth: async (code, state) => {
        calls.push([code, state]);
        throw new Error("no code");
      },
    },
  );
  expect(response.status).toBe(400);
  expect(calls).toEqual([[null, "s1"]]);
});

test("only GET is allowed", async () => {
  const response = await handleJiraOAuthCallback(
    new Request(base, { method: "POST" }),
    {
      completeOAuth: async () => ({ account: "", site_url: "" }),
    },
  );
  expect(response.status).toBe(405);
});
