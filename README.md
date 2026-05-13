# Foundry Teams Bot — Okta as Control Plane

A reference architecture demo: a Microsoft Teams bot backed by an Azure AI Foundry / Azure OpenAI model, gated behind Okta OAuth sign-in. Users chatting with the bot in Teams are prompted to authenticate with Okta before they can talk to the agent. Okta policies on the OIDC application become the control plane for who can access the agent and under what conditions.

## Architecture

```
                   +---------------------+
  user in Teams -> |   Azure Bot Service  | <- messaging endpoint -+
                   +---------------------+                         |
                          |                                        |
                   OAuth card (sign in)                            |
                          v                                        |
                   +---------------------+                         |
                   |        Okta         |  OIDC (auth code + PKCE)
                   |   (identity + policy)|                        |
                   +---------------------+                         |
                          ^                                        |
                       token                                       |
                          |                                        v
                   +---------------------+       +-----------------------+
                   |  Azure App Service  | ----> |  Azure OpenAI (GPT-4o) |
                   |  (Node.js bot)      |       +-----------------------+
                   +---------------------+
```

- **Identity control plane**: Okta OIDC application. Access policies, MFA, group assignment all live here.
- **Sign-in surface**: OAuth card in Teams, handled by Azure Bot Service's token service. No Entra ↔ Okta federation required — the bot obtains its own per-user Okta token.
- **Agent runtime**: Azure OpenAI (gpt-4o) called directly from the bot. Foundry agents are supported by swapping `bot.js`'s OpenAI call for a Foundry Agent SDK call once the new-schema agent is defined.

## Repository layout

```
.
├── index.js              # Restify server + Bot Framework CloudAdapter
├── bot.js                # TeamsActivityHandler: OAuth gating + gpt-4o call
├── build-manifest.js     # Pure-Node script that generates Teams app icons (PNG) and zips the app package
├── manifest/
│   ├── manifest.json     # Teams app manifest (v1.17)
│   ├── color.png         # 192×192 color icon (generated)
│   └── outline.png       # 32×32 outline icon (generated)
├── package.json
├── .env.sample           # Template — copy to .env and fill in locally
├── README.md             # You're here
└── DEPLOY.md             # Step-by-step build/deploy walkthrough
```

## Prerequisites

- **Azure subscription** with permission to create Bot Service, App Service, and Azure OpenAI resources.
- **Entra tenant** with Teams licensing (Microsoft 365 Business Basic / E-series / Dev Program). A native Entra admin user (not a personal Microsoft account / MSA) — personal MSAs in Azure "Default Directory" tenants cannot hold Teams licenses.
- **Okta org** (or Okta Preview org). Ability to create OIDC applications.
- **Node.js 20+** locally.

## Configuration

Copy `.env.sample` to `.env` and fill in (for local reference only — the deployed bot reads these from App Service settings, not from `.env`):

| Variable | Description |
|---|---|
| `MicrosoftAppType` | `SingleTenant` or `MultiTenant` — depends on Azure Bot registration. |
| `MicrosoftAppId` | Client ID of the bot's Entra app registration. |
| `MicrosoftAppPassword` | Client secret of the bot's Entra app registration. |
| `MicrosoftAppTenantId` | Tenant ID (for `SingleTenant` only). |
| `AZURE_OPENAI_ENDPOINT` | e.g. `https://<resource>.openai.azure.com/` |
| `AZURE_OPENAI_API_KEY` | Key from the Azure OpenAI resource's "Keys and Endpoint" blade. |
| `AZURE_OPENAI_DEPLOYMENT` | Deployment name (e.g. `gpt-4o`). |
| `AZURE_OPENAI_API_VERSION` | e.g. `2024-10-21`. |
| `OAUTH_CONNECTION_NAME` | Name of the Azure Bot's OAuth Connection Setting (e.g. `Okta Oauth`). |
| `PORT` | Local dev port (unused on App Service). |

## Build

```bash
npm install
node build-manifest.js    # regenerate icons
zip -j teams-app-package.zip manifest/manifest.json manifest/color.png manifest/outline.png
zip -r foundry-teams-bot.zip . -x 'node_modules/*' '.env' '.git/*' 'manifest/*' '*.zip' 'build-manifest.js'
```

## Deploy

See [DEPLOY.md](DEPLOY.md) for the full step-by-step, including Azure Bot resource creation, Azure OpenAI setup, Okta OIDC application config, and the OAuth Connection Settings required on the Azure Bot.

Quick deploy once the resources exist (from Azure Cloud Shell):

```bash
az webapp deploy \
  --resource-group <rg-name> \
  --name <app-name> \
  --src-path ~/foundry-teams-bot.zip \
  --type zip
```

## Known limitations (demo scope)

- **API key auth** to Azure OpenAI rather than managed identity. Rotate key / migrate to MI before sharing as a real demo.
- **No downstream tool calls.** The agent is a chat model, not a tool-using agent. Phase 6 of the build is wiring Okta-scoped tokens into tool invocations.
- **Single-tenant bot.** Runs in one Entra tenant. Multi-tenant distribution requires flipping the Entra app registration's sign-in audience.
- **In-memory conversation history.** Restarting the App Service clears per-user chat history. A real deployment should use Azure Storage / Cosmos.
- **No step-up auth / device trust.** Demo relies on Okta's baseline policy for the app.
