# Foundry Teams Bot — Okta as Control Plane

A Microsoft Teams bot fronting an **Azure AI Foundry agent**, gated behind Okta OAuth sign-in, with full **Cross-App Access (XAA / ID-JAG)** plumbing for issuing scoped, audited resource tokens that carry both the human user (`sub`) and the agent workload (`cid`) in a single Bearer.

**Architectural intent**: the *agent's brain* (instructions, model, tools, behavior) lives entirely in **Azure AI Foundry** — editable from the Foundry portal, no redeploy required. The *bot* is a deliberately thin relay whose only jobs are:

1. Bridge Teams ↔ Foundry agent.
2. Be the **Okta policy enforcement boundary** — sign the user in via Okta, then mint scoped resource tokens for the agent via Cross-App Access.

This separation is the demo's punchline: **Foundry runs the agent; the bot is the Okta control plane that decides what the agent is allowed to do, on whose behalf, and with what credentials.**

## Sequence diagram — full flow

```mermaid
sequenceDiagram
    autonumber
    participant U as User (Teams)
    participant BFS as Bot Framework / Bot Service
    participant Bot as Bot (Azure App Service)
    participant Foundry as Azure AI Foundry<br/>(Foundry-Okta-Agent)
    participant Okta as Okta (oktaforai.oktapreview.com)
    participant SN as ServiceNow (resource)

    rect rgba(200,220,255,0.25)
    Note over U,Okta: Sign-in (own OAuth flow, not BF connector)
    U->>BFS: First message
    BFS->>Bot: POST /api/messages
    Bot->>Bot: tokenStore.getTokens() = null
    Bot-->>BFS: HeroCard "Sign in with Okta"
    BFS-->>U: Renders card
    U->>Okta: Click → GET /oauth2/v1/authorize<br/>(client_id, redirect_uri, openid+profile+email+offline_access, state, nonce)
    Okta-->>U: Login + consent
    U-->>Okta: Authenticate
    Okta->>Bot: 302 → /api/okta-callback?code,state
    Bot->>Okta: POST /oauth2/v1/token<br/>grant_type=authorization_code
    Okta-->>Bot: id_token + access_token + refresh_token
    Bot->>Bot: tokenStore.setTokens(teamsUserId, {…})
    Bot-->>U: "You're signed in" page
    end

    rect rgba(220,255,220,0.25)
    Note over U,Foundry: Conversation turn (agent definition lives in Foundry)
    U->>BFS: "What can you do?"
    BFS->>Bot: POST /api/messages
    Bot->>Bot: tokenStore.getTokens() = ✓
    Bot->>Foundry: openai.conversations.create / .items.create<br/>responses.create with agent_reference="Foundry-Okta-Agent"
    Note right of Bot: AIProjectClient + DefaultAzureCredential<br/>(App Service managed identity)
    Foundry->>Foundry: Run Foundry-Okta-Agent<br/>(instructions edited in Foundry portal)
    Foundry-->>Bot: response.output_text
    Bot-->>BFS: sendActivity(reply)
    BFS-->>U: Renders reply
    end

    rect rgba(255,235,200,0.25)
    Note over U,SN: When the agent eventually calls a tool that needs ServiceNow
    U->>BFS: "List my open tickets"
    BFS->>Bot: POST /api/messages
    Bot->>Foundry: responses.create
    Foundry-->>Bot: tool call request: list_tickets

    Note over Bot,Okta: Step 1 — ID token → ID-JAG (RFC 8693 token exchange)
    Bot->>Bot: Sign client_assertion JWT<br/>(iss/sub=agent principal, aud=org token endpoint, kid)
    Bot->>Okta: POST /oauth2/v1/token<br/>grant_type=token-exchange<br/>subject_token=id_token<br/>audience=auth server URL<br/>requested_token_type=id-jag<br/>scope=mcp:read<br/>+client_assertion + actor_token
    Okta-->>Bot: oauth-id-jag+jwt<br/>{sub=user, client_id=agent, aud=auth server, scope=mcp:read}

    Note over Bot,Okta: Step 2 — ID-JAG → resource access token (RFC 7523 JWT-bearer)
    Bot->>Bot: Sign new client_assertion<br/>(aud = custom auth server token endpoint)
    Bot->>Okta: POST /oauth2/{authServerId}/v1/token<br/>grant_type=jwt-bearer<br/>assertion=id_jag<br/>audience=ServiceNow URL<br/>+client_assertion
    Okta-->>Bot: Bearer access_token<br/>{sub=user, cid=agent, aud=ServiceNow, scp=[mcp:read]}

    Bot->>SN: GET /api/now/table/incident<br/>Authorization: Bearer ${access_token}
    SN-->>Bot: Tickets JSON
    Bot->>Foundry: responses.submit_tool_outputs
    Foundry-->>Bot: Final response with ticket data integrated
    Bot-->>BFS: sendActivity(reply)
    BFS-->>U: Renders reply
    end
```

The XAA chain (orange band) is wired but currently exposed via `/testjag` and `/testresource` slash commands; tool-call interception will hook the same chain into normal conversation turns once tools are registered with the Foundry agent.

## Architecture (block view)

```
                       +--------------------+
  user in Teams ─────► |  Bot Framework /   | ─── messaging endpoint ───+
                       |   Bot Service      |                            │
                       +--------------------+                            │
                              │                                          │
                       OAuth card (sign in)                              │
                              ▼                                          │
                       +--------------------+                            │
                       |        Okta        |  OIDC + RFC 8693 + RFC 7523│
                       |  (identity +       |   (id_token → id-jag →     │
                       |   policy + XAA)    |    resource access token)  │
                       +--------------------+                            │
                              ▲                                          │
                          tokens                                         │
                              │                                          ▼
                       +--------------------+        +-----------------------------+
                       | Azure App Service  | ─────► |  Azure AI Foundry           |
                       |  (Node.js bot —    |  MI    |  Foundry-Okta-Agent         |
                       |   thin relay only) |        |  (instructions, model,      |
                       +--------------------+        |   tools — edit in portal)   |
                              │                      +-----------------------------+
                       Bearer access token
                              ▼
                       +--------------------+
                       |  ServiceNow / MCP  |
                       |   (resource API)   |
                       +--------------------+
```

- **Identity control plane**: Okta. Two distinct Okta identities ride together — the user's OIDC sign-in identity (`Foundry Agent App`) and the agent's machine identity (`Foundry Agent` AI-Agent object), bridged via Cross-App Access policy on a custom Authorization Server.
- **Sign-in surface**: HeroCard openUrl button to Okta's OIDC authorize endpoint. The bot hosts its own `/api/okta-callback` to exchange code for tokens — no Bot Framework OAuth Connection involved.
- **Agent runtime**: Azure AI Foundry. The bot calls the agent by name via `responses.create({conversation}, {body: {agent_reference: {type: 'agent_reference', name}}})`. Agent instructions, model, and tools are edited in the Foundry portal.
- **Bot ↔ Foundry auth**: App Service system-assigned managed identity, granted `Azure AI User` on the Foundry resource. No API keys.

## Slash commands

| Command | Effect |
|---|---|
| `/whoami` | Decode the cached Okta ID token; show the user's email/sub. |
| `/logout` | Clear the bot's local token cache for this user. Okta browser session unaffected. |
| `/logout-okta` | Clear local cache **and** present a button to hit Okta's `/oauth2/v1/logout` (next sign-in shows the actual Okta login page). |
| `/testjag` | Run leg 1 of the XAA chain (ID token → ID-JAG) and print the response + decoded claims. |
| `/testresource` | Run both legs (ID token → ID-JAG → resource access token) and print each response with decoded claims. |

Any other text routes to the Foundry agent for a normal conversation turn.

## Repository layout

```
.
├── index.js                # Restify server: /api/messages + /api/okta-callback
├── bot.js                  # TeamsActivityHandler: token gating, /commands, Foundry relay
├── oktaTokenStore.js       # In-memory state + token cache (per Teams user)
├── build-manifest.js       # Pure-Node script that generates Teams app icons (PNG)
├── manifest/
│   ├── manifest.json       # Teams app manifest (v1.17)
│   ├── color.png           # 192×192 color icon (generated)
│   └── outline.png         # 32×32 outline icon (generated)
├── package.json
├── .env.sample             # Template — copy to .env for local use
├── README.md               # You're here
└── DEPLOY.md               # Step-by-step setup walkthrough
```

## Prerequisites

- **Azure subscription** with permission to create Bot Service, App Service, and Azure AI Foundry resources.
- **Entra tenant with Teams licensing** (Microsoft 365 Business Basic / E-series). MSA-owned "Default Directory" tenants cannot host Teams for Work.
- **Okta org** (Okta Preview is fine). Ability to create OIDC apps, AI Agent objects, custom Authorization Servers, and Resource Connections.
- **Node.js 20+** locally for builds.

## Configuration (App Service settings)

| Variable | Description |
|---|---|
| `MicrosoftAppType` | `SingleTenant` or `MultiTenant`. |
| `MicrosoftAppId` / `MicrosoftAppPassword` / `MicrosoftAppTenantId` | Bot's Entra app registration (created with Azure Bot resource). |
| `FOUNDRY_PROJECT_ENDPOINT` | e.g. `https://<resource>.services.ai.azure.com/api/projects/<project>`. |
| `FOUNDRY_AGENT_NAME` | Name of the agent in Foundry, e.g. `Foundry-Okta-Agent`. Used as `agent_reference.name`. |
| `OKTA_DOMAIN` | e.g. `https://oktaforai.oktapreview.com`. |
| `OKTA_OIDC_CLIENT_ID` / `OKTA_OIDC_CLIENT_SECRET` | The OIDC web app in Okta (user sign-in). |
| `OKTA_REDIRECT_URI` | `https://<app-name>.azurewebsites.net/api/okta-callback` (also registered on the OIDC app). |
| `OKTA_AUTHORIZATION_SERVER_ID` | Custom auth server hosting XAA policies. |
| `OKTA_AGENT_PRINCIPAL_ID` | The AI Agent object's ID (used as `iss`/`sub` of client assertions). |
| `OKTA_AGENT_PRIVATE_JWK` | The AI Agent's private key (full JWK as JSON). Generated once in Okta. |
| `OKTA_REQUESTED_SCOPE` | Default `mcp:read`. |
| `OKTA_RESOURCE_AUDIENCE` | The resource server URI (e.g. `https://oktademo.mcp.servicenow.com`). |

The App Service must have **system-assigned managed identity enabled** with `Azure AI User` role on the Foundry resource — no API keys for the agent path.

## Build

```bash
npm install
node build-manifest.js
zip -j teams-app-package.zip manifest/manifest.json manifest/color.png manifest/outline.png
zip -r foundry-teams-bot.zip . -x 'node_modules/*' '.env' '.git/*' 'manifest/*' '*.zip' 'build-manifest.js'
```

## Deploy

See [DEPLOY.md](DEPLOY.md) for the full end-to-end walkthrough.

## Editing the agent

Once deployed, agent behavior is controlled entirely from the Foundry portal:

1. Go to [ai.azure.com](https://ai.azure.com) → your project → **Agents** → `Foundry-Okta-Agent`.
2. Edit **Instructions**, change the **Model** deployment, add **Tools**, etc.
3. Save. Changes take effect on the next message — no redeploy.

## Known limitations (demo scope)

- **Tokens live in process memory** (`oktaTokenStore.js`). Every App Service restart wipes them and forces re-auth. Production should swap to Cosmos / Storage.
- **Foundry conversation IDs are also in-memory.** Bot restart loses the mapping; the Foundry-side conversation persists, but a new one will be started for the user.
- **No actual ServiceNow tool yet** — `/testresource` produces a valid Bearer; tool-call interception is the next iteration.
- **Single-tenant bot.** Runs in one Entra tenant.
- **No step-up auth.** Demo relies on Okta's baseline policy for the OIDC app.

## Built with

- Bot Framework SDK v4 (Node.js) — TeamsActivityHandler + CloudAdapter
- `@azure/ai-projects` — Foundry agent invocation via Conversations + Responses API
- `@azure/identity` — DefaultAzureCredential / managed identity
- `restify` — HTTP server
- `jose` — JWT signing for client assertions and actor tokens
- Okta — OIDC, custom Authorization Servers, AI Agents, Cross-App Access (ID-JAG)
