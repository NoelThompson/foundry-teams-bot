// =============================================================================
//  index.js — HTTP server (Bot Framework adapter + Okta-side gateway routes)
// =============================================================================
//
//  This file owns the HTTP surface of the bot. It exposes three routes,
//  each playing a distinct role in the demo's identity architecture:
//
//    POST /api/messages
//       Bot Framework's standard endpoint. Azure Bot Service POSTs Teams
//       activities here; we hand them to the CloudAdapter which dispatches
//       to bot.js's TeamsActivityHandler. Standard Bot Framework plumbing,
//       not interesting from a security-architecture perspective.
//
//    GET /api/okta-callback
//       The bot's own OAuth 2.0 redirect endpoint. We host this ourselves
//       (instead of letting Bot Framework handle the OAuth dance via its
//       built-in OAuth Connection feature) because Bot Framework's
//       connector only exposes the user's ACCESS TOKEN to the bot — it
//       hides the ID TOKEN. The XAA chain in bot.js requires the user's
//       ID token as the subject_token in the first leg, so we run the
//       OAuth code flow ourselves and stash all three tokens (id, access,
//       refresh) in oktaTokenStore.
//
//    GET /api/tools/list-incidents
//       The "tool gateway" — what Foundry calls when its agent decides to
//       use the list_recent_incidents tool. Foundry's OpenAPI tool
//       definition points at THIS URL (with X-Tool-Api-Key auth), not
//       directly at ServiceNow. The reason is the centerpiece of the
//       customer-facing architecture story: Foundry has no view of the
//       user's Okta identity, no access to the AI Agent's private key,
//       and isn't itself an Okta-registered identity. So Foundry can't
//       mint an XAA-scoped Bearer on behalf of the active user. This
//       endpoint is what does — making it the **policy enforcement
//       boundary** between the agent's intent and the resource call.
//
//  In other words: Foundry decides *what* tool to call; this endpoint
//  decides *as whom* and *with what scope*, then performs the actual
//  call to ServiceNow with a fresh, per-call, per-user, per-agent
//  Bearer token minted via Okta's Cross-App Access flow.
//
// =============================================================================

require('dotenv').config();
const restify = require('restify');
const {
  CloudAdapter,
  ConfigurationServiceClientCredentialFactory,
  createBotFrameworkAuthenticationFromConfiguration,
} = require('botbuilder');

// bot.js holds the EchoBot class which implements the Teams activity
// handlers AND owns the XAA token-minting logic. We instantiate it here
// because the tool gateway endpoint (below) reuses bot._toolListIncidents
// — keeping the XAA / ServiceNow call logic in one place rather than
// duplicating it between the gateway and the in-process tool dispatcher
// in bot.js.
const { EchoBot } = require('./bot');
const tokenStore = require('./oktaTokenStore');

const bot = new EchoBot();

// -----------------------------------------------------------------------------
// Bot Framework adapter setup. Standard. The bot authenticates to Azure
// Bot Service using the credentials registered when the bot resource was
// created (Microsoft App ID + Password + Tenant). Nothing demo-specific
// here.
// -----------------------------------------------------------------------------
const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
  MicrosoftAppId: process.env.MicrosoftAppId,
  MicrosoftAppPassword: process.env.MicrosoftAppPassword,
  MicrosoftAppType: process.env.MicrosoftAppType,
  MicrosoftAppTenantId: process.env.MicrosoftAppTenantId,
});

const botFrameworkAuthentication = createBotFrameworkAuthenticationFromConfiguration(
  null,
  credentialsFactory,
);

const adapter = new CloudAdapter(botFrameworkAuthentication);

adapter.onTurnError = async (context, error) => {
  console.error('[onTurnError]', error);
  await context.sendActivity('Sorry, something went wrong.');
};

const server = restify.createServer();
server.use(restify.plugins.queryParser());
server.use(restify.plugins.bodyParser());

// -----------------------------------------------------------------------------
// /api/messages — Bot Framework's standard messaging endpoint.
//
// Azure Bot Service POSTs Teams activities here. The CloudAdapter
// authenticates the request (verifies the Bot Service token), wraps the
// activity in a TurnContext, and dispatches to bot.run() which runs the
// TeamsActivityHandler defined in bot.js. From there, see bot.js for
// the full per-turn flow (auth gating → slash commands → Foundry relay).
// -----------------------------------------------------------------------------
server.post('/api/messages', async (req, res) => {
  await adapter.process(req, res, (context) => bot.run(context));
});

// Tiny helper for emitting JSON responses with explicit Content-Type.
// We use raw writeHead/end rather than restify's res.send because some
// restify versions stomp on the Content-Type header for short bodies,
// causing browsers to interpret the response as a download instead of
// JSON. Belt and suspenders.
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// =============================================================================
//  /api/tools/list-incidents — TOOL GATEWAY (the customer's interest)
// =============================================================================
//
//  This is the URL registered in the Foundry agent's OpenAPI tool config.
//  When the agent decides (per its instructions) that it needs to call
//  list_recent_incidents, Foundry's runtime makes an HTTPS GET to this
//  endpoint with the X-Tool-Api-Key header.
//
//  Three things happen here in order, each enforcing a layer of the
//  control-plane story:
//
//    1. Authentication of the CALLER (Foundry) via X-Tool-Api-Key.
//       Anyone hitting this endpoint must present the shared key. This
//       prevents random clients from invoking the gateway and triggering
//       Bearer mints on behalf of cached users.
//
//       (For production, this static API key should be replaced by
//        managed-identity-based auth between Foundry and the bot. See
//        README "Known limitations".)
//
//    2. Resolution of the active USER from the bot's token cache. The
//       gateway needs to know which signed-in user the agent is acting
//       on behalf of, because the XAA chain mints tokens specific to
//       that user. Today this uses a single-active-user heuristic
//       (getAnyValidTokens) which is fine for a demo with one
//       concurrent user. Production would plumb the user's identity
//       through the Foundry conversation context so multiple users can
//       use the bot simultaneously.
//
//    3. Per-call XAA token minting + ServiceNow call. The actual work
//       happens in bot._toolListIncidents (defined in bot.js):
//          a. Run the XAA chain (Step 1: ID token → ID-JAG; Step 2:
//             ID-JAG → resource access token addressed to ServiceNow).
//          b. The resulting Bearer carries sub=human + cid=agent + the
//             requested scope, evaluated against Okta's Resource
//             Connections at mint time.
//          c. GET ServiceNow's /api/now/table/incident with that Bearer.
//          d. Return the incident JSON to Foundry.
//
//       Foundry then incorporates the JSON into the agent's response to
//       the user — formatting, summarization, and reasoning about the
//       data are all the agent's job (instructions in Foundry).
//
//  Critical point for customer conversations: this endpoint is NOT
//  the agent. The agent decides whether to call this tool and what to
//  do with its result; this endpoint enforces the security policy that
//  every such call goes through Okta with the right per-user, per-agent
//  credentials. Pointing the Foundry tool directly at ServiceNow would
//  remove this layer and lose the per-user audit trail.
// =============================================================================
server.get('/api/tools/list-incidents', async (req, res) => {
  // ---- Layer 1: caller auth ----
  // Verify the caller (Foundry) presented the shared API key. Without
  // it, anyone could trigger XAA token mints + ServiceNow calls on
  // behalf of cached users.
  const expectedKey = process.env.TOOL_API_KEY;
  if (!expectedKey) {
    return sendJson(res, 500, { error: 'TOOL_API_KEY not configured on server.' });
  }
  const presentedKey =
    req.headers['x-tool-api-key'] || req.headers['X-Tool-Api-Key'];
  if (presentedKey !== expectedKey) {
    return sendJson(res, 401, { error: 'Invalid or missing X-Tool-Api-Key.' });
  }

  // ---- Layer 2: who is the user? ----
  // Look up an active signed-in user's tokens. The Bearer we mint
  // below will be for THIS user. Demo uses a single-active-user
  // heuristic; production needs proper user routing.
  const tokens = tokenStore.getAnyValidTokens();
  if (!tokens || !tokens.idToken) {
    return sendJson(res, 503, {
      error:
        'No signed-in user available. Sign in via the Teams bot first, then retry.',
    });
  }

  // ---- Layer 3: mint XAA Bearer + call ServiceNow ----
  // Delegated to bot._toolListIncidents which is shared with the
  // in-process tool dispatcher. This is where the XAA chain runs:
  // see bot.js for the full security plumbing.
  const limit = req.query?.limit;
  const result = await bot._toolListIncidents(tokens.idToken, { limit });
  if (result.error) {
    // 502 = upstream (ServiceNow or Okta) returned an error.
    return sendJson(res, 502, result);
  }
  return sendJson(res, 200, result);
});

// HTML response helper — used by the OAuth callback endpoint below to
// render simple status pages back to the user's browser. Same Content-
// Type-safety motivation as sendJson.
function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// =============================================================================
//  /api/okta-callback — Path B OAuth callback
// =============================================================================
//
//  Why this endpoint exists at all:
//
//    Bot Framework has a built-in "OAuth Connection" feature where Azure
//    Bot Service performs the full OAuth code flow on behalf of the bot
//    and exposes a `token` field via the SDK's UserTokenClient. Easy,
//    works for many scenarios.
//
//    BUT: that flow returns the user's ACCESS TOKEN only. The ID TOKEN
//    (which is what the XAA chain in bot.js needs as its subject_token)
//    is never exposed. We empirically verified this earlier in the
//    project; tokenResponse.properties is empty, and tokenResponse.token
//    is the access token.
//
//    Without the ID token, no XAA chain. So the bot runs its own OAuth
//    code flow against Okta — using a HeroCard sign-in button in
//    bot._sendOktaSignInCard, redirecting back to THIS endpoint with
//    the authorization code. Here we exchange the code at Okta's token
//    endpoint with our client_id + client_secret, capture all three
//    tokens (id_token + access_token + refresh_token), and store them
//    in oktaTokenStore for the XAA flow to pick up.
//
//  Security notes:
//
//    - Client secret authentication for the code exchange uses HTTP
//      Basic per the OAuth spec. The secret is stored in the
//      OKTA_OIDC_CLIENT_SECRET App Setting (encrypted at rest in
//      App Service; production should use Key Vault).
//
//    - The `state` parameter ties the callback back to a Teams user.
//      It's generated in tokenStore.createPendingState (called when
//      the sign-in card is shown), validated and consumed here. State
//      values that don't match a pending entry are rejected — this is
//      the standard CSRF defense for OAuth code flows.
// =============================================================================
server.get('/api/okta-callback', async (req, res) => {
  const { code, state, error, error_description } = req.query || {};

  // Okta returned an error (user declined consent, etc.).
  if (error) {
    return sendHtml(
      res,
      400,
      `<html><body><h2>Sign-in error</h2><p>${error}: ${error_description || ''}</p></body></html>`,
    );
  }
  // Malformed callback (no code or state) — possibly a refresh of
  // a stale tab, possibly an attacker. Refuse either way.
  if (!code || !state) {
    return sendHtml(res, 400, '<html><body><h2>Missing code or state</h2></body></html>');
  }

  // CSRF defense: the state must match a pending sign-in we initiated.
  // consumePendingState atomically removes the state on lookup so it
  // can't be replayed.
  const pending = tokenStore.consumePendingState(state);
  if (!pending) {
    return sendHtml(
      res,
      400,
      '<html><body><h2>Unknown or expired sign-in request</h2><p>Please return to Teams and try signing in again.</p></body></html>',
    );
  }

  const oktaDomain = process.env.OKTA_DOMAIN || 'https://oktaforai.oktapreview.com';
  const clientId = process.env.OKTA_OIDC_CLIENT_ID;
  const clientSecret = process.env.OKTA_OIDC_CLIENT_SECRET;
  const redirectUri = process.env.OKTA_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return sendHtml(
      res,
      500,
      '<html><body><h2>Server misconfigured</h2><p>OKTA_OIDC_CLIENT_ID, OKTA_OIDC_CLIENT_SECRET, and OKTA_REDIRECT_URI must be set.</p></body></html>',
    );
  }

  // Exchange the authorization code for tokens. Hits Okta's ORG auth
  // server token endpoint (no auth-server ID in the path) because that's
  // what issues real OIDC ID tokens. Custom auth servers don't issue
  // ID tokens for this OAuth flow — they're used later in the XAA
  // chain instead.
  let tokenJson;
  try {
    const tokenRes = await fetch(`${oktaDomain}/oauth2/v1/token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        // HTTP Basic with client_id:client_secret per OAuth 2.0
        // standard. Don't put the secret in the body where it'd
        // be more visible in logs.
        Authorization:
          'Basic ' +
          Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });
    tokenJson = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('[okta-callback] token exchange failed', tokenJson);
      return sendHtml(
        res,
        400,
        `<html><body><h2>Sign-in failed</h2><pre>${JSON.stringify(tokenJson, null, 2)}</pre></body></html>`,
      );
    }
  } catch (err) {
    console.error('[okta-callback] token exchange error', err);
    return sendHtml(
      res,
      500,
      `<html><body><h2>Server error</h2><p>${err.message}</p></body></html>`,
    );
  }

  // Sanity check: did Okta actually return an id_token? If not, the
  // OIDC scope wasn't granted (check OIDC app config in Okta) and
  // the XAA chain won't work — fail loudly here rather than silently
  // storing only the access token.
  if (!tokenJson.id_token) {
    return sendHtml(
      res,
      500,
      '<html><body><h2>Sign-in incomplete</h2><p>Okta did not return an id_token. Check the OIDC app scope configuration.</p></body></html>',
    );
  }

  // Store the full token bundle keyed by Teams user. The XAA chain in
  // bot.js will look these up by user id when the agent's tools need
  // to be called.
  tokenStore.setTokens(pending.teamsUserId, {
    idToken: tokenJson.id_token,
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token,
    expiresIn: tokenJson.expires_in,
  });

  // Render the user a friendly "you can return to Teams" page. They
  // close this tab and go back to Teams; the next message they send
  // will find their tokens cached and proceed normally.
  sendHtml(
    res,
    200,
    `<html><body style="font-family: sans-serif; max-width: 480px; margin: 80px auto; text-align: center;">
      <h2>You're signed in</h2>
      <p>Return to Microsoft Teams and send another message to continue.</p>
    </body></html>`,
  );
});

const port = process.env.PORT || 3978;
server.listen(port, () => {
  console.log(`Bot listening on http://localhost:${port}`);
});
