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

## 3. Azure OpenAI / gpt-4o

1. Create an Azure OpenAI resource; deploy a `gpt-4o` model in Azure AI Foundry.
2. Grab Endpoint + Key 1 from "Keys and Endpoint".
3. Add settings:

```bash
az webapp config appsettings set \
  --name <app-name> \
  --resource-group <rg-name> \
  --settings \
    AZURE_OPENAI_ENDPOINT=https://<openai-resource>.openai.azure.com/ \
    AZURE_OPENAI_API_KEY=<key1> \
    AZURE_OPENAI_DEPLOYMENT=gpt-4o \
    AZURE_OPENAI_API_VERSION=2024-10-21
```

Web Chat now responds with real model output.

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

## 9. Verify the chain

In Teams:

1. Send "hi" → bot replies with HeroCard "Sign in with Okta".
2. Click → browser → Okta login → "You're signed in" page.
3. Return to Teams.
4. `/whoami` → bot prints your Okta email.
5. `/testjag` → status 200 with `issued_token_type: ...id-jag` and an ID-JAG JWT.
6. `/testresource` → both legs return 200; final token decoded shows `aud=<resource>`, `sub=<your-email>`, `cid=<agent-principal-id>`, `scp=["mcp:read"]`.
7. Normal chat (anything that's not a command) → gpt-4o reply.

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
