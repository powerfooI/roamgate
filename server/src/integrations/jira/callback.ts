import type { JiraService } from "./service";

const headers = {
  "cache-control": "no-store",
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

function page(title: string, message: string, status: number): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:15px system-ui,sans-serif;background:#1d1b19;color:#ece6dc;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.2rem}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`,
    { status, headers },
  );
}

/**
 * Atlassian redirects the browser here after sign-in. Called only after the
 * server's authentication gate, so a request without a Roamgate session never
 * reaches it; the single-use state binds it to a flow this server started.
 */
export async function handleJiraOAuthCallback(
  req: Request,
  service: Pick<JiraService, "completeOAuth">,
): Promise<Response> {
  if (req.method !== "GET")
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "GET", "cache-control": "no-store" },
    });
  const url = new URL(req.url);
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    // Consume the state so it cannot be replayed with a code later.
    await service.completeOAuth(null, url.searchParams.get("state")).catch(
      () => undefined,
    );
    return page(
      "Jira sign-in cancelled",
      url.searchParams.get("error_description") ?? oauthError,
      400,
    );
  }
  try {
    const result = await service.completeOAuth(
      url.searchParams.get("code"),
      url.searchParams.get("state"),
    );
    return page(
      "Jira connected",
      `Signed in${result.account ? ` as ${result.account}` : ""} to ${result.site_url}. You can close this window and return to Roamgate.`,
      200,
    );
  } catch (error) {
    return page("Jira sign-in failed", (error as Error).message, 400);
  }
}
