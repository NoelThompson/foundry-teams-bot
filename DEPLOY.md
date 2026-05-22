# Deployment walkthrough

End-to-end build of the demo. Follow in order; each phase verifies before moving to the next.

## 0. Prereqs check

- [ ] Azure subscription with permission to create resources.
- [ ] Entra tenant with **Teams licensing** (M365 Business Basic / E-series). MSA-owned default directories don't qualify; create a native Entra user + grab a Business Basic trial if you have only an MSA.
- [ ] Okta org (Okta Preview works). Admin access.
- [ ] Node.js 20+ locally.

## 1. Azure Bot resource

1. portal.azure.com → search "Azure Bot" → Create.
2. Bot handle: globally unique (e.g., `foundry-teams-bot-<suffix>`); pricing tier `Free (F0)`; **Single Tenant**; **Create new Microsoft App ID**.
3. After deploy, capture from the resource:
   - **Microsoft App ID** (Configuration blade)
   - **Tenant ID** (Configuration blade)
   - **Client secret** (Manage Password → Entra app → Certificates & secrets → New client secret → copy the value once).
4. **Settings → Channels → + Microsoft Teams** → accept terms (this is what allows the Teams app to install — easy to miss; without it sideload fails with `AddAppBotToChatRosterFailed`).

## 2. App Service + initial deploy

Easiest from Azure Cloud Shell (avoids local TLS / corp-DNS issues):

```bash
# From an unzipped checkout in the home directory
cd ~/foundry-teams-bot
az webapp up \
  --name <globally-unique-app-name> \
  --runtime NODE:22-lts \
  --sku F1 \
  --location westus3
```

Note the resource group name from the JSON output. Then bot Framework settings:

```bash
az webapp config appsettings set \
  --name <app-name> \
  --resource-group <rg-name> \
  --settings \
    MicrosoftAppType=SingleTenant \
    MicrosoftAppId=<bot-app-id> \
    MicrosoftAppPassword='<bot-secret>' \
    MicrosoftAppTenantId=<tenant-id>
```

Point the Azure Bot's **Messaging endpoint** to `https://<app-name>.azurewebsites.net/api/messages`. Test in the bot's **Test in Web Chat** — should echo or, after the next phase, hit gpt-4o.

## 3. Azure AI Foundry — agent + identity

This replaces the older "direct Azure OpenAI API call from bot" pattern. Agent definition lives in Foundry; bot uses managed identity to invoke it.

### 3a. Create the Foundry agent

1. [ai.azure.com](https://ai.azure.com) → open or create a project (parent: an `AIServices`-kind Cognitive Services account).
2. Left nav **Agents → + New agent** (the new agent surface, NOT the old "Assistants" panel that produces `asst_...` IDs).
3. Fill in:
   - **Name**: e.g. `Foundry-Okta-Agent` (this becomes `agent_reference.name`).
   - **Instructions**: your system prompt — this is what the demo audience will edit live to prove the agent's behavior comes from Foundry.
   - **Model**: select an existing gpt-4o (or newer) deployment in the project.
   - Tools: leave empty for now; ServiceNow tool comes later.
4. Save.
5. Capture the project's **endpoint URL** from the project overview (format: `https://<resource>.services.ai.azure.com/api/projects/<project>`).

### 3b. Enable managed identity on the bot + grant role

```bash
# Enable system-assigned MI on the App Service
az webapp identity assign \
  --name <app-name> \
  --resource-group <bot-rg-name>

# Grab the principalId from output, then:
az role assignment create \
  --assignee <principalId-from-above> \
  --role "Azure AI User" \
  --scope "/subscriptions/<sub-id>/resourceGroups/<foundry-rg>/providers/Microsoft.CognitiveServices/accounts/<foundry-account-name>"
```

If `"Azure AI User"` isn't recognized, fall back to `"Cognitive Services User"`. Note that the Foundry resource's RG may differ from the bot's RG — `az resource list --query "[?name=='<account-name>']"` finds it.

### 3c. App settings

```bash
az webapp config appsettings set \
  --name <app-name> \
  --resource-group <bot-rg-name> \
  --settings \
    FOUNDRY_PROJECT_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project> \
    FOUNDRY_AGENT_NAME=Foundry-Okta-Agent
```

After deploying the bot (later phases), Web Chat / Teams should respond using the agent's Foundry-defined instructions. Edit the instructions in the Foundry portal — changes take effect on next message, no redeploy.

## 4. Teams app installation

1. **Teams admin center → Teams apps → Setup policies → Global → Upload custom apps: On** (admin permission required).
2. In Teams (Chrome/Edge — Safari has known issues with Teams web): **Apps → Manage your apps → Upload an app → Upload a custom app** → pick `teams-app-package.zip` → Add.
3. Send "hi" → bot should reply via gpt-4o.

## 5. Okta OIDC application (user sign-in)

1. Okta admin (`https://<org>.okta.com/admin`) → Applications → Create App Integration → **OIDC Web Application**.
   - Grant types: **Authorization Code** + **Refresh Token**.
   - Sign-in redirect URI: `https://<app-name>.azurewebsites.net/api/okta-callback` (this is the bot's own callback endpoint; it must be hosted before sign-in works).
   - Sign-out redirect URIs: optional; if you set one, it lets `/logout-okta` post-redirect somewhere clean.
   - Assignments: pick a group or "Everyone in the organization" for testing.
2. Capture **Client ID** and **Client Secret** from the new app's General tab.

## 6. Custom Authorization Server (XAA target)

This is where Cross-App Access policy lives. **Don't reuse the org default auth server**; spin up a clean one for the demo.

1. Okta admin → **Security → API → Authorization Servers → + Add Authorization Server**.
   - Name: e.g. `Foundry Demo Auth Server`.
   - Audience: a placeholder URI you'll register resources under (e.g. `api://foundry-demo`); doesn't have to match anything yet.
   - Note the resulting **Authorization Server ID** (e.g. `ausyrbiuzeYR2sAeu1d7`).
2. **Scopes tab** → add `mcp:read` (or whatever scopes you'll grant the agent).
3. **Audiences tab / Settings** → register the resource URI you intend to address tokens to (e.g. `https://oktademo.mcp.servicenow.com`).
4. **Access Policies tab** → add a policy allowing the OIDC app from step 5 to use this auth server (with grant types including Token Exchange).

## 7. Okta AI Agent (agent machine identity)

1. Okta admin → **Directory → AI Agents → Register AI agent → Register manually**.
   - Name: e.g. `Foundry Agent`.
   - Description: short.
   - Application: **link** the OIDC app from step 5.
   - **Save** → on the agent's detail:
     - **Owners** tab: assign yourself or a group with ≥2 members.
     - **Credentials** tab: **Add public key → Generate new key**. **Copy the JSON immediately and store it in a vault** — Okta only shows the private half once.
     - **... → Activate**.
2. **Resource Connections** tab → **+ Add connection** → **Authorization Server** → pick the one from step 6 → allow scope `mcp:read` (or "Allow all" for a demo).

## 8. Bot — Path B (own OAuth flow) settings

The bot doesn't use Bot Service's Generic OAuth Connection; instead it runs its own OAuth code flow and its own callback endpoint, so it can capture the **ID token** Bot Service hides from generic-OAuth callers.

```bash
az webapp config appsettings set \
  --name <app-name> \
  --resource-group <rg-name> \
  --settings \
    OKTA_DOMAIN=https://<your-org>.okta.com \
    OKTA_OIDC_CLIENT_ID=<client-id-from-step-5> \
    OKTA_REDIRECT_URI=https://<app-name>.azurewebsites.net/api/okta-callback \
    OKTA_AUTHORIZATION_SERVER_ID=<authServerId-from-step-6> \
    OKTA_AGENT_PRINCIPAL_ID=<agentId-from-step-7> \
    OKTA_REQUESTED_SCOPE=mcp:read \
    OKTA_RESOURCE_AUDIENCE=https://oktademo.mcp.servicenow.com \
    'OKTA_OIDC_CLIENT_SECRET=<secret-from-step-5>' \
    'OKTA_AGENT_PRIVATE_JWK=<full JWK JSON from step 7>'
```

Both `OKTA_OIDC_CLIENT_SECRET` and `OKTA_AGENT_PRIVATE_JWK` are sensitive. Type the command in Cloud Shell with the values pasted directly from your vault — don't share them anywhere else. Single quotes preserve special chars / JSON braces.

Deploy the bot zip:

```bash
az webapp deploy \
  --resource-group <rg-name> \
  --name <app-name> \
  --src-path ~/foundry-teams-bot.zip \
  --type zip
```

## 9. ServiceNow tool wiring (downstream resource)

This is the part that actually lets the agent fetch real data. Has two halves: registering the tool with the Foundry agent, and configuring ServiceNow to trust your Okta tokens.

### 9a. Register the OpenAPI tool on the Foundry agent

The agent declares the function it can call; Foundry's runtime makes the HTTP call when the agent decides to use it.

1. Foundry portal → your agent (`Foundry-Okta-Agent`) → **Tools** → **+ Add tool** → **Custom function** (or **OpenAPI tool** — naming varies). The form will require an OpenAPI 3.0+ spec.
2. **Authentication method**: pick **API Key** (header). Header name `X-Tool-Api-Key`. Value: a 32+ byte hex string you generate (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Save the value — you'll paste it into the bot's App Settings as `TOOL_API_KEY`.
3. **OpenAPI spec** (paste verbatim, replacing the URL with your App Service hostname):

```json
{
  "openapi": "3.0.0",
  "info": { "title": "Foundry Bot tool gateway", "version": "1.0.0" },
  "servers": [{ "url": "https://<your-app-name>.azurewebsites.net" }],
  "paths": {
    "/api/tools/list-incidents": {
      "get": {
        "operationId": "list_recent_incidents",
        "summary": "List the user's recent ServiceNow incidents",
        "description": "Returns a brief summary of recent ServiceNow incidents the user has access to.",
        "parameters": [
          {
            "name": "limit",
            "in": "query",
            "description": "Maximum number of incidents to return (default 5, max 25)",
            "required": false,
            "schema": { "type": "integer", "default": 5, "minimum": 1, "maximum": 25 }
          }
        ],
        "responses": {
          "200": {
            "description": "OK",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "incidents": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "number": { "type": "string" },
                          "short_description": { "type": "string" },
                          "state": { "type": "string" },
                          "priority": { "type": "string" },
                          "sys_created_on": { "type": "string" }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  "components": {
    "securitySchemes": {
      "ApiKeyAuth": { "type": "apiKey", "in": "header", "name": "X-Tool-Api-Key" }
    }
  },
  "security": [{ "ApiKeyAuth": [] }]
}
```

4. **Update the agent's instructions** to tell it about the tool — paste this paragraph alongside whatever else is in the Instructions field:

```
You have one tool: `list_recent_incidents`. When the user asks about
ServiceNow incidents, tickets, or open issues, call this tool to fetch
real data. After the tool returns, summarize the incidents in a short
readable list. Don't fabricate incident details — only use what the
tool returns.
```

5. Add the bot's App Settings for the tool gateway:

```bash
az webapp config appsettings set \
  --name <app-name> \
  --resource-group <rg-name> \
  --settings \
    TOOL_API_KEY=<the-key-you-generated-in-step-2> \
    SERVICENOW_INSTANCE_URL=https://<your-instance>.service-now.com
```

### 9b. Configure ServiceNow to trust your Okta tokens

ServiceNow needs to validate inbound JWTs against your Okta auth server's JWKS, accept the audience your tokens use, and resolve the `sub` claim to a real ServiceNow user. This is configured under **System OAuth → Application Registry**.

> ⚠️ **Important**: ServiceNow's OAuth setup has *many* form types in the same place. Pick the right one. We learned this the hard way; see `SERVICENOW_TROUBLESHOOTING.md` for the full debugging journey.

1. **System OAuth → Application Registry → New** → on the type-picker page, choose **`[Deprecated UI] Configure an OIDC provider to verify ID tokens`**. This is the inbound-validation path. **Do NOT** pick:
   - `Connect to a third party OAuth Provider` (outbound — wrong direction).
   - `[Deprecated UI] Create an OAuth API endpoint for external clients` (older/different validation chain).
   - `New Inbound Integration Experience` (newer wizard; works but adds layers).

2. Fill the parent OAuth API endpoint form:

   | Field | Value |
   |---|---|
   | Name | `Okta-Foundry-XAA-OIDC` |
   | **Client ID** | the audience URI your tokens carry, e.g. `https://oktademo.mcp.servicenow.com`. ServiceNow uses this to match incoming tokens to this entity by `aud`. **Cannot be changed later** — pick a value unique to this integration. |
   | Client Secret | leave the auto-generated value; not used for inbound JWT validation |
   | User field | **Email** — ServiceNow will look up users by matching the `sub` claim to this column |
   | Token Format | **JWT** (NOT Opaque — JWT bearers won't validate against the opaque-token table) |
   | Active | checked |

   Save.

3. Open the saved record and create the **OIDC Provider Configuration** sub-record (look for a reference field with the same label, click the magnifying glass → New):

   | Field | Value |
   |---|---|
   | OIDC Provider | `Okta-Foundry-XAA` (any descriptive label) |
   | OIDC Metadata URL | `https://<okta-org>/oauth2/<auth-server-id>/.well-known/openid-configuration` |
   | User claim | **`sub`** — must be filled in. ServiceNow uses this to extract the user identifier from the validated token. |

   Save.

4. **Register the scope** that your tokens carry. On the parent record, find the **OAuth Entity Scopes** related list → **New**:

   | Field | Value |
   |---|---|
   | Name | `mcp:read` (must match exactly what your bot's `OKTA_REQUESTED_SCOPE` requests) |
   | Description | "Read access for AI agent / Cross-App Access tokens" |

   Save.

   > ⚠️ **This is the step that's easiest to miss and the hardest to diagnose.** Without `mcp:read` registered as an OAuth Entity Scope, ServiceNow rejects tokens with `BadJWSException: failed to verify signature` — a misleading error that sounds cryptographic but is actually a scope-authorization failure. Don't skip it.

5. **What NOT to add**: leave these alone. Adding them can break OIDC-discovery-based key resolution.
   - JWT Verifier Maps (the parent record auto-fetches keys via the metadata URL)
   - Sys Certificates with manually wrapped public keys
   - OAuth JWT Claim Validations (only needed if you want extra defensive checks beyond what the OIDC entity already enforces)

6. **User mapping**: confirm there's a ServiceNow user record with `Email` matching the `sub` of the tokens you'll mint (e.g., `noel.thompson@okta.com`). If absent, the validator passes but ServiceNow returns 401 with no user resolved.

7. **User permissions**: the matched ServiceNow user needs roles for the resources you'll touch. For the `/api/now/table/incident` GET, the user typically needs `itil` (or admin) on `ven04722`-style demo instances.

### 9c. Smoke test from outside the bot

Before testing through the agent, prove ServiceNow trusts your tokens directly:

```bash
# In Teams: run /testresource and copy the access_token value from the response
# Then in Cloud Shell:
curl -i -H "Authorization: Bearer <paste-access-token>" \
  "https://<your-instance>.service-now.com/api/now/table/incident?sysparm_limit=1"
```

- **`200 OK` with incident JSON** → ServiceNow trust is configured correctly. Move on to step 10.
- **`401 User is not authenticated`** → check **System Logs** filtered for `OIDC` or `JWT` keywords for the actual cause. Common culprits ranked by frequency:
  1. Missing OAuth Entity Scope (`mcp:read` not registered).
  2. `User claim` field on OIDC Provider Configuration is empty.
  3. ServiceNow user with that email doesn't exist.
  4. JTI replay protection is enabled and you're reusing a token (uncheck "Enable JTI Verification" or mint a fresh token).
  5. Two OIDC entities with the same Client ID — ServiceNow can match the wrong one.
  6. Token `aud` doesn't match the entity's Client ID.

## 10. Verify the chain

In Teams:

1. Send "hi" → bot replies with HeroCard "Sign in with Okta".
2. Click → browser → Okta login → "You're signed in" page.
3. Return to Teams.
4. `/whoami` → bot prints your Okta email.
5. `/testjag` → status 200 with `issued_token_type: ...id-jag` and an ID-JAG JWT.
6. `/testresource` → both legs return 200; final token decoded shows `aud=<resource>`, `sub=<your-email>`, `cid=<agent-principal-id>`, `scp=["mcp:read"]`.
7. Normal chat (anything that's not a command) → reply generated by the **Foundry agent** based on the instructions you set in 3a.
8. **Editing proof point**: edit the agent's instructions in the Foundry portal (e.g., "Always end replies with 🎉"), save, send another message — change should be visible immediately, no redeploy.

## Common errors + fixes (Foundry agent path)

| Error | Cause | Fix |
|---|---|---|
| `401` / `403` calling agent | Managed identity role not assigned (or not propagated yet — wait 5–10 min). | Verify `az role assignment list --assignee <principalId>` shows the role on the Foundry account. |
| `400 The 'agent' property is deprecated` | Old SDK shape. | Use `body: { agent_reference: { type: 'agent_reference', name } }`. |
| `400 Required properties ['type'] are not present` | Missing `type` on `agent_reference`. | Add `type: 'agent_reference'` inside the agent_reference object. |
| `agent not found` | Name mismatch (case-sensitive). | Confirm `FOUNDRY_AGENT_NAME` matches Foundry portal exactly. |

## Common errors + fixes (ServiceNow trust)

| Error / symptom | Cause | Fix |
|---|---|---|
| `401 User is not authenticated` (with no SN log entry) | OIDC entity not active, or token `aud` doesn't match any entity's Client ID. | Check **Active** flag; verify Client ID on the entity matches the `aud` of your tokens. |
| `BadJWSException: failed to verify signature` | **Most often: `mcp:read` not registered as an OAuth Entity Scope** (misleading error). Less commonly: stale JWKS cache. | Add `mcp:read` to **OAuth Entity Scopes** on the OIDC entity. If that doesn't fix it, force JWKS refresh by saving the OIDC Provider Configuration record. |
| `Cannot find oauth_oidc_entity for issuer X with client_ids Y` | No matching OIDC entity for the token's issuer + audience pair. | Create the OIDC entity (step 9b.1) with Client ID matching your token's `aud`. |
| `JTI claim 'jti' verification failed, duplicated JTI found` | JTI replay protection enabled; you're reusing a token. | Either uncheck "Enable JTI Verification" on the parent record (fine for testing), or always mint fresh tokens (`/testresource` in Teams gives a new one each call). |
| `OIDC token verification failed : Invalid JWT Signature` (after correct OAuth Entity Scope is registered) | Two OIDC entities have the same Client ID; ServiceNow matched the wrong one. | Make Client ID unique. The parent record's Client ID is immutable after creation — delete and recreate with a unique value if needed. |
| `403` instead of `401` | Token validates, but the resolved ServiceNow user lacks role for the table. | Grant `itil` (or appropriate role) to the user matching the `sub` claim. |

## Common errors + fixes (XAA chain)

| Error | Cause | Fix |
|---|---|---|
| `invalid_client: kid is invalid` | JWK in App Settings doesn't match agent's currently-active public key. | Regenerate key in Okta, paste new JWK into `OKTA_AGENT_PRIVATE_JWK`. |
| `actor_token is missing` | Subject is access_token; Okta requires actor_token on access-token-as-subject paths. | The bot already sends actor_token; this should not appear in the current code. |
| `actor_token_type is invalid or not supported` | Wrong literal. | Must be exactly `urn:ietf:params:oauth:token-type:access_token`. |
| `subject_token is invalid` | Access token (not id_token) sent as subject when policy requires id_token. | Use Path B (real ID token), not the access token from Bot Framework. |
| `subject_token_type is invalid or not supported` | Asking for `id-jag` while subject is `access_token`. | Use ID token as subject when `requested_token_type=id-jag`. |
| `invalid_target` | No Resource Connection on the AI Agent permitting this audience. | Configure step 7's Resource Connection. |
| `requested_token_type is invalid or not supported` (custom server endpoint) | Custom auth servers don't issue ID-JAGs directly. | Hit ORG token endpoint for leg 1; only hit custom server for leg 2 (jwt-bearer). |
| `id-jag request must not include a 'scope' parameter` | Leg 2 with redundant `scope`. | Drop `scope` from the jwt-bearer request; it's already in the ID-JAG. |
| `grant was issued for another authorization server` | Leg 2 sent to org token endpoint instead of custom auth server endpoint. | Use `${OKTA_DOMAIN}/oauth2/${authServerId}/v1/token` for leg 2. |

## Other gotchas

- **Corp networks** with TLS interception or strict DNS filtering may block `az` CLI and `devtunnel` locally. Use Azure Cloud Shell.
- **MSA-owned tenants** can't host Teams for Work. Create a native Entra user + Business Basic trial.
- **M365 Developer Program** now requires Visual Studio subscription / MPN. Use Business Basic trial instead.
- **In-memory token store**: every App Service restart forces re-auth. Acceptable for demos, not for prod.
- **Safari + Teams**: Teams web doesn't always work in Safari (especially private mode). Chrome/Edge are reliable.
