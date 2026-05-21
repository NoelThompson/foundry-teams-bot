// =============================================================================
//  bot.js — Okta Policy Enforcement Boundary (NOT the agent)
// =============================================================================
//
//  This file is intentionally NOT the agent. Where the agent's behavior lives:
//
//    - Instructions / system prompt           → Foundry portal (editable there)
//    - Model selection                        → Foundry portal
//    - Conversation memory / chat history     → Foundry's Conversations API
//                                               (server-side, no chat history
//                                                stored in this bot)
//    - Tool definitions                       → Foundry portal (OpenAPI tools)
//    - Tool dispatch decisions                → Foundry agent (decides when
//                                               to call a tool based on user
//                                               input)
//
//  What this bot DOES is everything Foundry can't do because Foundry has no
//  view of the user's Okta identity:
//
//    1. Be the Teams adapter (receive activities, render replies via Bot
//       Framework's CloudAdapter).
//    2. Run an OAuth code flow against Okta to capture the user's ID token.
//       (Bot Framework's built-in OAuth Connection only exposes the access
//       token, not the ID token, so we run our own flow — see
//       _sendOktaSignInCard.)
//    3. Mint per-call, per-user, per-agent **Cross-App Access (XAA)** tokens
//       on the agent's behalf, signed by the Okta AI Agent's private key.
//       These tokens carry sub=human and cid=agent — the "human in the
//       loop + agent workload" claim shape that lets downstream resources
//       audit who is acting and on whose behalf.
//
//  In other words: Foundry decides WHAT to do; this bot decides AS WHOM and
//  WITH WHAT SCOPE. That separation is the whole point of the demo. Moving
//  XAA / token logic into Foundry would lose it, because Foundry isn't an
//  Okta-registered identity and has no path to the user's ID token.
//
//  Sister file: index.js exposes /api/tools/list-incidents — the HTTP gateway
//  that Foundry's OpenAPI tool calls into. Tool calls always flow:
//
//    user (Teams) → Foundry agent → bot's tool gateway → mint XAA token
//                                                      → call ServiceNow
//                                                      → return data to agent
//
// =============================================================================

const {
  TeamsActivityHandler,
  MessageFactory,
  CardFactory,
} = require('botbuilder');

// Foundry SDK — this is how the bot calls into the Foundry agent (which
// owns the agent's behavior). The bot is a CLIENT of Foundry, not the agent.
const { AIProjectClient } = require('@azure/ai-projects');

// Used for App Service managed-identity auth into Foundry. No static keys.
const { DefaultAzureCredential } = require('@azure/identity');

// JOSE — used to sign JWT bearer assertions with the AI Agent's private key.
// These assertions authenticate the AGENT itself to Okta when we ask Okta to
// mint a downstream-resource access token (the XAA flow).
const { SignJWT, importJWK } = require('jose');

// In-memory cache of per-user Okta tokens. The cache is keyed by Teams user
// id; each entry holds {idToken, accessToken, refreshToken, expiresAt}. This
// is what lets the bot mint XAA tokens on behalf of a specific signed-in
// user — without it, we'd have nothing to prove identity to Okta.
//
// (For production this needs to be persistent — see README "Known
// limitations". For the demo, in-memory is acceptable.)
const tokenStore = require('./oktaTokenStore');

class EchoBot extends TeamsActivityHandler {
  constructor() {
    super();

    // Name of the Foundry agent we relay turns to. The actual agent
    // definition (instructions, model, tools) is in the Foundry portal —
    // editable there without redeploying the bot.
    this.agentName = process.env.FOUNDRY_AGENT_NAME || 'Foundry-Okta-Agent';

    // Map: Teams conversation id → Foundry conversation id. Foundry holds
    // the actual conversation state server-side; we just need to remember
    // which Foundry conversation belongs to which Teams thread so the user's
    // chat history persists across turns.
    this.foundryConversations = new Map();

    // -------------------------------------------------------------------
    //  onMessage — every user-typed message in Teams comes through here.
    //
    //  This is where the policy enforcement boundary sits. Before any agent
    //  call happens, we check: is this user signed in to Okta? If not, we
    //  send a sign-in card and stop. Only signed-in users get to interact
    //  with the agent at all — that's policy decision #1, made by the bot,
    //  not Foundry.
    // -------------------------------------------------------------------
    this.onMessage(async (context, next) => {
      const userId = context.activity.from.id;
      const tokens = tokenStore.getTokens(userId);

      // Gate #1: must be signed in to Okta. If not, prompt for sign-in
      // and bail. The agent never sees the message.
      if (!tokens) {
        await this._sendOktaSignInCard(context);
        return next();
      }

      const text = (context.activity.text || '').trim();

      // ---- Diagnostic / demo-instrumentation slash commands ----
      //
      // These slash commands let an operator inspect the XAA chain at
      // each layer without going through the full agent → tool flow.
      // They aren't part of the user-facing experience; they exist to
      // make the security plumbing observable for debugging and demos.

      // /testjag: run only the FIRST leg of the XAA flow (ID token → ID-JAG)
      // and dump the response with decoded claims. Useful for proving the
      // user's identity propagates correctly into the delegation token.
      if (text === '/testjag') {
        const result = await this._testIdJagExchange(tokens.idToken);
        await context.sendActivity(
          MessageFactory.text(`**ID-JAG exchange test**\n\n\`\`\`\n${result}\n\`\`\``),
        );
        return next();
      }

      // /testresource: run the FULL XAA chain (ID token → ID-JAG → resource
      // access token) and dump each leg's response. The final token's claims
      // are the "money shot" that the demo hinges on: aud=resource server,
      // sub=human, cid=agent, scope=mcp:read.
      if (text === '/testresource') {
        const result = await this._testFullChain(tokens.idToken);
        await context.sendActivity(
          MessageFactory.text(`**Full XAA chain (ID-JAG → resource token)**\n\n\`\`\`\n${result}\n\`\`\``),
        );
        return next();
      }

      // /whoami: prove that the bot has captured the user's Okta identity.
      // This decodes the ID token (which Bot Framework's built-in OAuth
      // Connection would not have given us — see _sendOktaSignInCard).
      if (text === '/whoami') {
        const claims = this._decodeJwt(tokens.idToken);
        await context.sendActivity(
          MessageFactory.text(
            `Signed in via Okta as **${claims.email || claims.sub || 'unknown'}**.`,
          ),
        );
        return next();
      }

      // /logout: clear the bot's local token cache for this user. Note
      // this does NOT end the user's Okta browser session; the next
      // sign-in will be silent because Okta still has SSO state.
      if (text === '/logout') {
        tokenStore.clearTokens(userId);
        await context.sendActivity(
          MessageFactory.text('Signed out (local token cleared). Send another message to sign in again. Note: your Okta browser session is still active, so re-sign-in will be silent. Use `/logout-okta` for full sign-out.'),
        );
        return next();
      }

      // /logout-okta: full sign-out — clear the bot's local cache AND
      // present a button that takes the user through Okta's
      // /oauth2/v1/logout endpoint with their id_token as a session hint.
      // Used in demos to force the actual Okta login screen on next
      // sign-in (instead of a silent SSO redirect).
      if (text === '/logout-okta') {
        const oktaDomain = process.env.OKTA_DOMAIN || 'https://oktaforai.oktapreview.com';
        const logoutUrl = new URL(`${oktaDomain}/oauth2/v1/logout`);
        logoutUrl.searchParams.set('id_token_hint', tokens.idToken);
        tokenStore.clearTokens(userId);
        const card = CardFactory.heroCard(
          'Sign out of Okta',
          "Local token cleared. Click below to also end your Okta browser session — next sign-in will show the actual Okta login page.",
          undefined,
          [
            {
              type: 'openUrl',
              title: 'Complete Okta sign-out',
              value: logoutUrl.toString(),
            },
          ],
        );
        await context.sendActivity({ attachments: [card] });
        return next();
      }

      // ---- Normal turn: relay the message to the Foundry agent ----
      //
      // This is the only path that actually reaches Foundry. Everything
      // above is gating, identity, or instrumentation; the agent's
      // intelligence lives in Foundry, called via _respondWithFoundryAgent.
      await this._respondWithFoundryAgent(context);
      await next();
    });

    // -------------------------------------------------------------------
    //  onMembersAdded — first-touch greeting when the bot is added to
    //  a chat. Tells the user they need to sign in to Okta before
    //  anything else will work.
    // -------------------------------------------------------------------
    this.onMembersAdded(async (context, next) => {
      for (const member of context.activity.membersAdded) {
        if (member.id !== context.activity.recipient.id) {
          await context.sendActivity(
            MessageFactory.text(
              "Hi! Please sign in with Okta to start chatting with me.",
            ),
          );
        }
      }
      await next();
    });
  }

  // =====================================================================
  //  Okta sign-in (Path B: own OAuth flow)
  // =====================================================================
  //
  //  Bot Framework has a built-in "OAuth Connection" feature where Azure
  //  Bot Service runs the OAuth flow on your behalf and exposes a single
  //  "user token" via the SDK. We DELIBERATELY do not use that here.
  //
  //  Why: Bot Framework's OAuth Connection only surfaces the **access
  //  token** to the bot — not the ID token. The XAA chain (RFC 8693
  //  token exchange) requires the user's **ID token** as the subject
  //  token in the first leg. Without the ID token, we couldn't mint
  //  ID-JAG tokens and the entire control-plane story falls apart.
  //
  //  So: the bot runs its own OAuth code flow against Okta, captures all
  //  three tokens (id_token + access_token + refresh_token) at the
  //  /api/okta-callback endpoint in index.js, and stashes them in
  //  oktaTokenStore.js for use by the XAA chain.
  // =====================================================================
  async _sendOktaSignInCard(context) {
    const userId = context.activity.from.id;

    // The state value links a redirect callback back to this Teams user.
    // It's also reused as the OIDC nonce. Generated by tokenStore so its
    // lifetime can be GC'd if the user abandons the sign-in flow.
    const state = tokenStore.createPendingState(userId);

    const oktaDomain = process.env.OKTA_DOMAIN || 'https://oktaforai.oktapreview.com';
    const clientId = process.env.OKTA_OIDC_CLIENT_ID;
    const redirectUri = process.env.OKTA_REDIRECT_URI;

    if (!clientId || !redirectUri) {
      await context.sendActivity(
        MessageFactory.text(
          'OKTA_OIDC_CLIENT_ID and OKTA_REDIRECT_URI app settings must be set.',
        ),
      );
      return;
    }

    // Hits the **org** auth server (no auth-server ID in the path).
    // Org auth server is what issues real OIDC ID tokens; custom auth
    // servers issue scoped resource tokens. We need the ID token for
    // the XAA flow's subject_token.
    const authUrl = new URL(`${oktaDomain}/oauth2/v1/authorize`);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid profile email offline_access');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('nonce', state);

    // HeroCard with openUrl so the sign-in opens in the user's browser
    // (Bot Framework's OAuthCard would invoke their built-in connector,
    // which we're not using — see the §Path B explanation above).
    const card = CardFactory.heroCard(
      'Sign in with Okta',
      'Click the button below to sign in. After authenticating, return to Teams and send another message.',
      undefined,
      [
        {
          type: 'openUrl',
          title: 'Sign in with Okta',
          value: authUrl.toString(),
        },
      ],
    );
    await context.sendActivity({ attachments: [card] });
  }

  // Tiny helper. Just base64-decodes the JWT payload — does NOT verify
  // the signature. Only used for displaying claims for debugging /
  // demo purposes (e.g., /whoami, /testresource output). Real signature
  // verification happens at the resource server (ServiceNow), not here.
  _decodeJwt(jwt) {
    try {
      return JSON.parse(
        Buffer.from(jwt.split('.')[1], 'base64').toString('utf8'),
      );
    } catch {
      return {};
    }
  }

  // Centralized config helper. All Okta-related identifiers live in app
  // settings; this is the one place the bot reads them. Keeps the rest
  // of the file readable.
  _oktaConfig() {
    const oktaDomain = process.env.OKTA_DOMAIN || 'https://oktaforai.oktapreview.com';

    // The custom authorization server hosting the XAA / cross-app
    // policies, scopes, and resource registrations. NOT the org auth
    // server (which only issues ID tokens for sign-in).
    const authServerId =
      process.env.OKTA_AUTHORIZATION_SERVER_ID || 'ausyrbiuzeYR2sAeu1d7';

    // The Okta AI Agent object's id. This is the agent's own machine
    // identity in Okta — distinct from the OIDC app the user signs in
    // through. JWT bearer assertions are issued AS this principal.
    const principalId =
      process.env.OKTA_AGENT_PRINCIPAL_ID || 'wlpykxnap92EyB40F1d7';

    // Scope requested in the XAA exchange. Must be registered on the
    // custom auth server AND granted to this AI Agent via a Resource
    // Connection in Okta.
    const requestedScope = process.env.OKTA_REQUESTED_SCOPE || 'mcp:read';

    // Audience URI for the eventual resource access token (the final
    // token the agent uses to call ServiceNow). Must be registered as
    // an audience on the custom auth server.
    const resourceAudience = process.env.OKTA_RESOURCE_AUDIENCE || '';

    // Token endpoint of the **org** auth server. The first leg of the
    // XAA exchange (ID token → ID-JAG) hits this URL; the second leg
    // (ID-JAG → resource access token) hits the CUSTOM auth server's
    // token endpoint instead. Different endpoints handle different
    // grant types.
    const tokenUrl = `${oktaDomain}/oauth2/v1/token`;

    return { oktaDomain, authServerId, principalId, requestedScope, resourceAudience, tokenUrl };
  }

  // =====================================================================
  //  _signClientAssertion — the AGENT proves its own identity to Okta.
  // =====================================================================
  //
  //  Every XAA exchange request needs TWO things:
  //
  //    1. The user's identity (passed as the subject_token).
  //    2. The agent's identity (passed as the client_assertion).
  //
  //  This method handles #2: produce a short-lived JWT signed with the
  //  AI Agent's private key. Okta validates this JWT against the public
  //  key registered on the AI Agent object — that's how Okta knows
  //  it's actually OUR agent asking, not someone impersonating it.
  //
  //  The private key is held in the OKTA_AGENT_PRIVATE_JWK App Setting.
  //  In a production deployment this should move to Azure Key Vault
  //  (see README "Known limitations").
  // =====================================================================
  async _signClientAssertion(jwk, principalId, tokenUrl, jtiPrefix) {
    const key = await importJWK(jwk, jwk.alg || 'RS256');
    return new SignJWT({})
      .setProtectedHeader({ alg: jwk.alg || 'RS256', kid: jwk.kid, typ: 'JWT' })
      // iss + sub = the AI Agent's principal id. Okta uses this to look
      // up which public key to verify with.
      .setIssuer(principalId)
      .setSubject(principalId)
      // aud = the token endpoint we're calling. Different per leg of
      // the XAA flow (org server in leg 1, custom server in leg 2).
      .setAudience(tokenUrl)
      .setIssuedAt()
      // 5-min lifetime. Assertions are single-use, ideally; freshness
      // matters more than length.
      .setExpirationTime('5m')
      // Unique per call — required by some Okta validation paths.
      .setJti(`${jtiPrefix}-${Date.now()}`)
      .sign(key);
  }

  // Loads the AI Agent's private key (JWK) from app settings. This key
  // is sensitive — it's the agent's machine credential to Okta. In
  // production this should be a Key Vault reference, not a raw env var.
  _loadAgentJwk() {
    const jwkJson = process.env.OKTA_AGENT_PRIVATE_JWK;
    if (!jwkJson) {
      return { error: 'OKTA_AGENT_PRIVATE_JWK app setting is not set.' };
    }
    try {
      return { jwk: JSON.parse(jwkJson) };
    } catch (err) {
      return { error: `OKTA_AGENT_PRIVATE_JWK is not valid JSON: ${err.message}` };
    }
  }

  // =====================================================================
  //  _exchangeForIdJag — XAA Step 1 (ID token → ID-JAG)
  // =====================================================================
  //
  //  RFC 8693 OAuth Token Exchange. Inputs:
  //    - subject_token: the user's Okta ID token (proves WHO they are)
  //    - client_assertion: agent's signed JWT (proves WHICH AGENT is asking)
  //    - audience: the custom auth server URL (which auth server should
  //                 issue the ID-JAG and apply policy)
  //    - requested_token_type: id-jag (Okta-specific identity assertion
  //                                    authorization grant)
  //
  //  Output: an ID-JAG token. This is a single-use, short-lived
  //  delegation grant that says "user X has authorized agent Y to act
  //  on their behalf." It's NOT directly usable on a resource — it
  //  feeds into Step 2 (resource access token mint).
  //
  //  The whole point of separating Step 1 and Step 2 is that Okta's
  //  policy engine evaluates BETWEEN them: "is this user allowed to
  //  delegate to this agent? is this agent allowed to act for this
  //  user? are there step-up auth requirements?" If any check fails,
  //  no resource token gets issued.
  // =====================================================================
  async _exchangeForIdJag(idToken) {
    const cfg = this._oktaConfig();
    const { jwk, error } = this._loadAgentJwk();
    if (error) return { error };

    let clientAssertion;
    try {
      clientAssertion = await this._signClientAssertion(
        jwk,
        cfg.principalId,
        cfg.tokenUrl,
        'jag-ca',
      );
    } catch (err) {
      return { error: `Failed to sign client assertion: ${err.message}` };
    }

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: idToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      audience: `${cfg.oktaDomain}/oauth2/${cfg.authServerId}`,
      requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
      scope: cfg.requestedScope,
      client_assertion_type:
        'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: clientAssertion,
    });

    let resp;
    try {
      resp = await fetch(cfg.tokenUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
    } catch (err) {
      return { error: `Request failed: ${err.message}` };
    }
    const text = await resp.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { error: `Non-JSON response (${resp.status}): ${text}` };
    }
    return { status: resp.status, body: json, raw: text, jwk };
  }

  // /testjag command implementation. Runs only Step 1 of the chain
  // and returns a human-readable dump for the chat. Useful for
  // demonstrating that the user's identity is propagating into the
  // ID-JAG correctly.
  async _testIdJagExchange(idToken) {
    const cfg = this._oktaConfig();
    const result = await this._exchangeForIdJag(idToken);
    if (result.error) return result.error;
    const idClaims = this._decodeJwt(idToken);
    const header =
      `subject id_token iss: ${idClaims.iss}\n` +
      `subject id_token aud: ${idClaims.aud}\n` +
      `subject id_token sub: ${idClaims.sub}\n` +
      `assertion kid: ${result.jwk.kid}\n` +
      `exchange audience: ${cfg.oktaDomain}/oauth2/${cfg.authServerId}\n`;
    return `${header}\nPOST ${cfg.tokenUrl}\nstatus: ${result.status}\n\n${JSON.stringify(result.body, null, 2)}`;
  }

  // /testresource command implementation. Runs BOTH legs of the chain
  // sequentially and decodes the final access token's claims to show
  // sub=human + cid=agent — the audit-trail proof point that the
  // demo hinges on.
  async _testFullChain(idToken) {
    const cfg = this._oktaConfig();
    if (!cfg.resourceAudience) {
      return 'OKTA_RESOURCE_AUDIENCE app setting must be set (the resource server URI you registered in Okta, e.g. https://servicenow.example.com).';
    }

    const lines = [];
    lines.push(`Step 1: ID token → ID-JAG`);
    const idJag = await this._exchangeForIdJag(idToken);
    if (idJag.error) {
      lines.push(`  error: ${idJag.error}`);
      return lines.join('\n');
    }
    if (idJag.status !== 200) {
      lines.push(`  status ${idJag.status}: ${JSON.stringify(idJag.body, null, 2)}`);
      return lines.join('\n');
    }
    const idJagToken = idJag.body.access_token;
    const jagClaims = this._decodeJwt(idJagToken);
    lines.push(`  status 200, issued_token_type: ${idJag.body.issued_token_type}`);
    lines.push(`  ID-JAG sub: ${jagClaims.sub}`);
    lines.push(`  ID-JAG client_id: ${jagClaims.client_id}`);
    lines.push(`  ID-JAG scope: ${jagClaims.scope}`);
    lines.push('');

    // Step 2 hits the CUSTOM auth server's token endpoint (not the
    // org server's) because the ID-JAG was issued by the custom auth
    // server and only that server can redeem it. Different URL than
    // Step 1.
    const resourceTokenUrl = `${cfg.oktaDomain}/oauth2/${cfg.authServerId}/v1/token`;
    lines.push(`Step 2: ID-JAG → resource access token (audience: ${cfg.resourceAudience})`);
    const { jwk, error } = this._loadAgentJwk();
    if (error) {
      lines.push(`  error: ${error}`);
      return lines.join('\n');
    }
    let clientAssertion;
    try {
      clientAssertion = await this._signClientAssertion(
        jwk,
        cfg.principalId,
        resourceTokenUrl,
        'res-ca',
      );
    } catch (err) {
      lines.push(`  error signing client assertion: ${err.message}`);
      return lines.join('\n');
    }

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: idJagToken,
      audience: cfg.resourceAudience,
      client_assertion_type:
        'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: clientAssertion,
    });

    let resp;
    try {
      resp = await fetch(resourceTokenUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
    } catch (err) {
      lines.push(`  request failed: ${err.message}`);
      return lines.join('\n');
    }
    const text = await resp.text();
    lines.push(`  POST ${resourceTokenUrl}`);
    lines.push(`  status: ${resp.status}`);
    let resJson;
    try {
      resJson = JSON.parse(text);
      lines.push(`  ${JSON.stringify(resJson, null, 2).split('\n').join('\n  ')}`);
      if (resp.status === 200 && resJson.access_token) {
        const resClaims = this._decodeJwt(resJson.access_token);
        lines.push('');
        lines.push(`  resource access token claims:`);
        lines.push(`    iss: ${resClaims.iss}`);
        lines.push(`    aud: ${resClaims.aud}`);
        lines.push(`    sub: ${resClaims.sub}     (human in the loop)`);
        lines.push(`    cid: ${resClaims.cid || resClaims.client_id}     (agent workload)`);
        lines.push(`    scp: ${JSON.stringify(resClaims.scp || resClaims.scope)}`);
      }
    } catch {
      lines.push(`  body (non-JSON): ${text}`);
    }
    return lines.join('\n');
  }

  // =====================================================================
  //  _respondWithFoundryAgent — relay a Teams turn to the Foundry agent.
  // =====================================================================
  //
  //  This is the "thin relay" — the bot's ONLY job here is to:
  //
  //    1. Append the user's message to the Foundry conversation (so
  //       Foundry maintains chat history server-side).
  //    2. Ask Foundry to generate a response using the named agent.
  //    3. If the agent emits tool calls in its response, dispatch them
  //       (currently only list_recent_incidents — see _toolListIncidents).
  //    4. Loop until no more tool calls, then return the final text to
  //       Teams.
  //
  //  Notice what the bot DOESN'T do:
  //    - No system prompt construction (Foundry owns it).
  //    - No conversation memory (Foundry owns it).
  //    - No model selection (Foundry owns it).
  //    - No reasoning about user intent (the agent decides).
  //
  //  In practice the function-call interception path below is rarely
  //  hit because Foundry's UI funnels custom tools through OpenAPI
  //  rather than function calls, and our list_recent_incidents tool is
  //  registered as OpenAPI (Foundry HTTP-calls the bot's
  //  /api/tools/list-incidents endpoint directly — see index.js). The
  //  function-call branch is kept here as a defensive fallback in case
  //  Foundry ever emits a function_call we need to fulfill in-process.
  // =====================================================================
  async _respondWithFoundryAgent(context) {
    const teamsConvId = context.activity.conversation.id;
    const userText = context.activity.text;
    const userId = context.activity.from.id;
    const userTokens = tokenStore.getTokens(userId);

    try {
      const openai = this._getOpenAIFromProject();
      let foundryConvId = this.foundryConversations.get(teamsConvId);

      // First turn for this Teams conversation: create a Foundry
      // conversation. Subsequent turns reuse the same Foundry conv id
      // so the agent keeps memory across messages.
      if (!foundryConvId) {
        const conv = await openai.conversations.create({
          items: [{ type: 'message', role: 'user', content: userText }],
        });
        foundryConvId = conv.id;
        this.foundryConversations.set(teamsConvId, foundryConvId);
      } else {
        await openai.conversations.items.create(foundryConvId, {
          items: [{ type: 'message', role: 'user', content: userText }],
        });
      }

      // Tell Foundry to run the named agent against the conversation.
      // The agent's instructions, model, and tools are what determine
      // the response — none of that lives in this file.
      let response = await openai.responses.create(
        { conversation: foundryConvId },
        { body: { agent_reference: { type: 'agent_reference', name: this.agentName } } },
      );

      // Defensive in-process tool dispatcher (rarely hit — see comment
      // block above). Bounded loop guards against infinite tool-call
      // ping-pong.
      const MAX_TOOL_ITERATIONS = 5;
      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        const fnCalls = (response.output || []).filter(
          (o) => o.type === 'function_call' || o.type === 'tool_call',
        );
        if (fnCalls.length === 0) break;

        console.log(`[FoundryBot] dispatching ${fnCalls.length} tool call(s)`);
        const outputs = [];
        for (const fc of fnCalls) {
          const fnName = fc.name || fc.function?.name;
          const argsRaw = fc.arguments || fc.function?.arguments || '{}';
          let args = {};
          try { args = JSON.parse(argsRaw); } catch {}

          let result;
          if (fnName === 'list_recent_incidents') {
            result = await this._toolListIncidents(userTokens?.idToken, args);
          } else {
            result = { error: `Unknown tool: ${fnName}` };
          }
          outputs.push({
            type: 'function_call_output',
            call_id: fc.call_id || fc.id,
            output: JSON.stringify(result),
          });
        }

        response = await openai.responses.create(
          { previous_response_id: response.id, input: outputs },
          { body: { agent_reference: { type: 'agent_reference', name: this.agentName } } },
        );
      }

      // Extract the final assistant text. Foundry's response shape
      // varies between SDK versions; check output_text first, then
      // fall back to digging into the structured output items.
      let reply = response.output_text;
      if (!reply) {
        const msgItem = (response.output || []).find((o) => o.type === 'message');
        const textPart = msgItem?.content?.find?.((c) => c.type === 'output_text' || c.type === 'text');
        reply = textPart?.text || msgItem?.content?.[0]?.text;
      }
      if (!reply) reply = '(no reply)';

      await context.sendActivity(MessageFactory.text(reply));
    } catch (err) {
      console.error('[FoundryBot] error calling Foundry agent:', err);
      // If something went wrong, drop the Foundry conversation mapping
      // so the next turn starts fresh rather than retrying a broken
      // conversation forever.
      this.foundryConversations.delete(teamsConvId);
      await context.sendActivity(
        MessageFactory.text(`Error talking to the agent: ${err.message}`),
      );
    }
  }

  // =====================================================================
  //  _mintResourceAccessToken — full XAA chain, returns a Bearer token.
  // =====================================================================
  //
  //  This is what the tool gateway endpoint (index.js) calls when a
  //  Foundry tool needs a credential to talk to ServiceNow. It runs
  //  Step 1 + Step 2 of the XAA chain and returns just the final
  //  access token string, ready to put in an Authorization: Bearer
  //  header for the downstream resource.
  //
  //  Why this lives in the bot, not in Foundry:
  //
  //    - The user's ID token is the input. It's stored in this bot's
  //      session (oktaTokenStore.js) and is NOT available to Foundry.
  //      Foundry has no way to obtain it without us plumbing it
  //      through, and even then it shouldn't hold it (sensitive
  //      credential, scope-of-trust mismatch).
  //
  //    - The AI Agent's private key signs the client_assertion. That
  //      key is the agent's MACHINE identity to Okta; if it leaked,
  //      anyone could impersonate the agent. Keeping it here behind
  //      the bot's policy boundary is the whole point of having an
  //      agent identity in the first place.
  //
  //    - Per-call token minting means Okta evaluates policy ON EVERY
  //      tool call, with the live user identity and the live agent
  //      identity in the request. This is the "control plane" — it's
  //      not just authentication, it's authorization for each
  //      individual action. Static credentials on the Foundry side
  //      can't do this.
  // =====================================================================
  async _mintResourceAccessToken(idToken) {
    if (!idToken) return { error: 'No user ID token cached.' };
    const cfg = this._oktaConfig();
    if (!cfg.resourceAudience) {
      return { error: 'OKTA_RESOURCE_AUDIENCE not configured.' };
    }

    // Step 1: get the ID-JAG (delegation grant) from the org auth server.
    const idJag = await this._exchangeForIdJag(idToken);
    if (idJag.error) return { error: `ID-JAG: ${idJag.error}` };
    if (idJag.status !== 200) {
      return { error: `ID-JAG ${idJag.status}: ${JSON.stringify(idJag.body)}` };
    }

    // Step 2: redeem the ID-JAG at the CUSTOM auth server's token
    // endpoint. This is where Okta actually applies resource policy
    // (scopes, audiences, the AI Agent's Resource Connections) and
    // either issues a Bearer for the requested audience or rejects.
    const resourceTokenUrl = `${cfg.oktaDomain}/oauth2/${cfg.authServerId}/v1/token`;
    const { jwk, error } = this._loadAgentJwk();
    if (error) return { error };
    let clientAssertion;
    try {
      // Note the assertion's audience must be the CUSTOM token
      // endpoint URL, not the org one — Step 2 hits a different
      // server than Step 1.
      clientAssertion = await this._signClientAssertion(
        jwk,
        cfg.principalId,
        resourceTokenUrl,
        'res-ca',
      );
    } catch (err) {
      return { error: `Sign assertion: ${err.message}` };
    }

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: idJag.body.access_token,
      audience: cfg.resourceAudience,
      // No `scope` parameter on this leg — the scope is already baked
      // into the ID-JAG and sending it again causes Okta to reject
      // ("id-jag request must not include a 'scope' parameter").
      client_assertion_type:
        'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: clientAssertion,
    });

    let resp;
    try {
      resp = await fetch(resourceTokenUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
    } catch (err) {
      return { error: `Resource exchange: ${err.message}` };
    }
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch {
      return { error: `Non-JSON resource response (${resp.status}): ${text.slice(0, 200)}` };
    }
    if (resp.status !== 200) {
      return { error: `Resource exchange ${resp.status}: ${JSON.stringify(json)}` };
    }
    return { accessToken: json.access_token };
  }

  // =====================================================================
  //  _toolListIncidents — the actual tool implementation called by the
  //  /api/tools/list-incidents gateway endpoint (in index.js).
  // =====================================================================
  //
  //  The agent doesn't call this directly. The flow is:
  //
  //    Foundry agent decides to call tool
  //          ↓
  //    Foundry HTTPS-calls our /api/tools/list-incidents endpoint
  //          ↓
  //    index.js validates the API key and locates the active user's
  //    cached ID token
  //          ↓
  //    index.js calls bot._toolListIncidents (this method)
  //          ↓
  //    This method mints a fresh, user-scoped, agent-asserted Bearer
  //    via the XAA chain and uses it to call ServiceNow.
  //
  //  The reason the data fetch is here (and not in Foundry directly):
  //  Foundry has no view of the user's identity, no access to the AI
  //  Agent's private key, and is itself an Entra workload (not
  //  Okta-registered). Moving this call into Foundry's tool definition
  //  would make every call go to ServiceNow as a generic service
  //  account — losing the per-user audit trail (sub=human) and the
  //  per-agent scoping (cid=agent) that Okta's control plane provides.
  // =====================================================================
  async _toolListIncidents(idToken, args = {}) {
    // Mint a fresh resource access token for THIS call. Tokens are
    // not cached across tool invocations — each call gets its own
    // policy evaluation at Okta.
    const tokenResult = await this._mintResourceAccessToken(idToken);
    if (tokenResult.error) return { error: tokenResult.error };

    const instance =
      process.env.SERVICENOW_INSTANCE_URL || 'https://ven04722.service-now.com';
    // Bound the limit so the agent can't request a 10,000-row dump.
    // 25 is plenty for a Teams chat reply.
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 5, 1), 25);
    const fields = 'number,short_description,state,priority,sys_created_on';
    const url = `${instance}/api/now/table/incident?sysparm_limit=${limit}&sysparm_fields=${fields}`;

    let resp;
    try {
      // The Bearer here is the per-call XAA-minted token. ServiceNow
      // validates it (signature against Okta JWKS, aud against its
      // OIDC entity, scope against its registered scopes) AND uses
      // the `sub` claim to identify the acting user. The agent's
      // identity rides along in `cid` for audit purposes.
      resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${tokenResult.accessToken}`,
          Accept: 'application/json',
        },
      });
    } catch (err) {
      return { error: `ServiceNow request failed: ${err.message}` };
    }
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch {
      return { error: `Non-JSON from ServiceNow (${resp.status}): ${text.slice(0, 300)}` };
    }
    if (resp.status !== 200) {
      return { error: `ServiceNow ${resp.status}: ${JSON.stringify(json).slice(0, 500)}` };
    }
    // Hand the raw incident list back to the agent. The agent's
    // instructions in Foundry tell it how to summarize for the user
    // (state code translation, priority labeling, etc.). Formatting
    // is the agent's job, not the bot's.
    return { incidents: json.result || [] };
  }

  // Lazily creates the AIProjectClient (memoized). Uses
  // DefaultAzureCredential which, in App Service, picks up the
  // system-assigned managed identity. The identity must have the
  // `Azure AI User` (or higher) role on the Foundry resource. No
  // static API keys for the Foundry path.
  _getOpenAIFromProject() {
    if (this._openai) return this._openai;
    const endpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
    if (!endpoint) {
      throw new Error(
        'FOUNDRY_PROJECT_ENDPOINT must be set as an app setting.',
      );
    }
    if (!this._project) {
      this._project = new AIProjectClient(endpoint, new DefaultAzureCredential());
    }
    this._openai = this._project.getOpenAIClient();
    return this._openai;
  }
}

module.exports = { EchoBot };
