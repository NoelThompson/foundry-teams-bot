const {
  TeamsActivityHandler,
  MessageFactory,
  CardFactory,
} = require('botbuilder');
const { AIProjectClient } = require('@azure/ai-projects');
const { DefaultAzureCredential } = require('@azure/identity');
const { SignJWT, importJWK } = require('jose');
const tokenStore = require('./oktaTokenStore');

class EchoBot extends TeamsActivityHandler {
  constructor() {
    super();

    this.agentName = process.env.FOUNDRY_AGENT_NAME || 'Foundry-Okta-Agent';
    this.foundryConversations = new Map();

    this.onMessage(async (context, next) => {
      const userId = context.activity.from.id;
      const tokens = tokenStore.getTokens(userId);

      if (!tokens) {
        await this._sendOktaSignInCard(context);
        return next();
      }

      const text = (context.activity.text || '').trim();
      if (text === '/testjag') {
        const result = await this._testIdJagExchange(tokens.idToken);
        await context.sendActivity(
          MessageFactory.text(`**ID-JAG exchange test**\n\n\`\`\`\n${result}\n\`\`\``),
        );
        return next();
      }

      if (text === '/testresource') {
        const result = await this._testFullChain(tokens.idToken);
        await context.sendActivity(
          MessageFactory.text(`**Full XAA chain (ID-JAG → resource token)**\n\n\`\`\`\n${result}\n\`\`\``),
        );
        return next();
      }

      if (text === '/whoami') {
        const claims = this._decodeJwt(tokens.idToken);
        await context.sendActivity(
          MessageFactory.text(
            `Signed in via Okta as **${claims.email || claims.sub || 'unknown'}**.`,
          ),
        );
        return next();
      }

      if (text === '/logout') {
        tokenStore.clearTokens(userId);
        await context.sendActivity(
          MessageFactory.text('Signed out (local token cleared). Send another message to sign in again. Note: your Okta browser session is still active, so re-sign-in will be silent. Use `/logout-okta` for full sign-out.'),
        );
        return next();
      }

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

      await this._respondWithFoundryAgent(context);
      await next();
    });

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

  async _sendOktaSignInCard(context) {
    const userId = context.activity.from.id;
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

    const authUrl = new URL(`${oktaDomain}/oauth2/v1/authorize`);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid profile email offline_access');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('nonce', state);

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

  _decodeJwt(jwt) {
    try {
      return JSON.parse(
        Buffer.from(jwt.split('.')[1], 'base64').toString('utf8'),
      );
    } catch {
      return {};
    }
  }

  _oktaConfig() {
    const oktaDomain = process.env.OKTA_DOMAIN || 'https://oktaforai.oktapreview.com';
    const authServerId =
      process.env.OKTA_AUTHORIZATION_SERVER_ID || 'ausyrbiuzeYR2sAeu1d7';
    const principalId =
      process.env.OKTA_AGENT_PRINCIPAL_ID || 'wlpykxnap92EyB40F1d7';
    const requestedScope = process.env.OKTA_REQUESTED_SCOPE || 'mcp:read';
    const resourceAudience = process.env.OKTA_RESOURCE_AUDIENCE || '';
    const tokenUrl = `${oktaDomain}/oauth2/v1/token`;
    return { oktaDomain, authServerId, principalId, requestedScope, resourceAudience, tokenUrl };
  }

  async _signClientAssertion(jwk, principalId, tokenUrl, jtiPrefix) {
    const key = await importJWK(jwk, jwk.alg || 'RS256');
    return new SignJWT({})
      .setProtectedHeader({ alg: jwk.alg || 'RS256', kid: jwk.kid, typ: 'JWT' })
      .setIssuer(principalId)
      .setSubject(principalId)
      .setAudience(tokenUrl)
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti(`${jtiPrefix}-${Date.now()}`)
      .sign(key);
  }

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

  async _respondWithFoundryAgent(context) {
    const teamsConvId = context.activity.conversation.id;
    const userText = context.activity.text;
    const userId = context.activity.from.id;
    const userTokens = tokenStore.getTokens(userId);

    try {
      const openai = this._getOpenAIFromProject();
      let foundryConvId = this.foundryConversations.get(teamsConvId);

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

      let response = await openai.responses.create(
        { conversation: foundryConvId },
        { body: { agent_reference: { type: 'agent_reference', name: this.agentName } } },
      );

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
      this.foundryConversations.delete(teamsConvId);
      await context.sendActivity(
        MessageFactory.text(`Error talking to the agent: ${err.message}`),
      );
    }
  }

  async _mintResourceAccessToken(idToken) {
    if (!idToken) return { error: 'No user ID token cached.' };
    const cfg = this._oktaConfig();
    if (!cfg.resourceAudience) {
      return { error: 'OKTA_RESOURCE_AUDIENCE not configured.' };
    }

    const idJag = await this._exchangeForIdJag(idToken);
    if (idJag.error) return { error: `ID-JAG: ${idJag.error}` };
    if (idJag.status !== 200) {
      return { error: `ID-JAG ${idJag.status}: ${JSON.stringify(idJag.body)}` };
    }

    const resourceTokenUrl = `${cfg.oktaDomain}/oauth2/${cfg.authServerId}/v1/token`;
    const { jwk, error } = this._loadAgentJwk();
    if (error) return { error };
    let clientAssertion;
    try {
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

  async _toolListIncidents(idToken, args = {}) {
    const tokenResult = await this._mintResourceAccessToken(idToken);
    if (tokenResult.error) return { error: tokenResult.error };

    const instance =
      process.env.SERVICENOW_INSTANCE_URL || 'https://ven04722.service-now.com';
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 5, 1), 25);
    const fields = 'number,short_description,state,priority,sys_created_on';
    const url = `${instance}/api/now/table/incident?sysparm_limit=${limit}&sysparm_fields=${fields}`;

    let resp;
    try {
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
    return { incidents: json.result || [] };
  }

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
