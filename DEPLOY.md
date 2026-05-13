# Deployment walkthrough

This is the step-by-step build that was used to stand the demo up end-to-end. Run in order; each phase verifies before moving to the next.

## 1. Create the Azure Bot resource

1. [portal.azure.com](https://portal.azure.com) → search "Azure Bot" → Create.
2. Fill in:
   - **Bot handle**: unique name (e.g. `foundry-teams-bot`).
   - **Subscription / Resource group**: pick/create.
   - **Pricing tier**: Free (F0).
   - **Microsoft App ID → Type of App**: Single Tenant.
   - **Creation type**: Create new Microsoft App ID.
3. Review + Create → Create.
4. Once deployed, grab:
   - Microsoft App ID (Configuration blade).
   - Tenant ID (Configuration blade).
   - Client secret (Manage Password → opens Entra app → Certificates & secrets → New client secret → copy the Value immediately).

## 2. Create the App Service and deploy

Easiest path is Azure Cloud Shell (avoids local TLS / proxy issues on some corporate networks):

```bash
# From an unzipped checkout at ~/foundry-teams-bot
cd ~/foundry-teams-bot
az webapp up \
  --name <globally-unique-app-name> \
  --runtime NODE:22-lts \
  --sku F1 \
  --location westus3
```

Note the generated resource group name from the command's JSON output.

Then set the four Bot Framework settings:

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

Point the Azure Bot at the App Service:

- Azure Bot → **Settings → Configuration → Messaging endpoint**: `https://<app-name>.azurewebsites.net/api/messages`.
- Save.
- Test via **Test in Web Chat** → send "hi" → expect an echo (if still on the echo version of `bot.js`) or a gpt-4o reply (if Azure OpenAI is configured, see §3).

## 3. Wire Azure OpenAI

1. Create an Azure OpenAI resource in the portal (any region where gpt-4o is available).
2. Deploy a `gpt-4o` model in Azure AI Foundry / the OpenAI resource.
3. Grab the endpoint and Key 1 from the resource's **Keys and Endpoint** blade.
4. Add App Service settings:

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

Verify in Web Chat by asking a real question; gpt-4o should respond.

## 4. Teams installation

This requires a real work/school tenant with Teams licensing. A personal-MSA-owned "Default Directory" tenant **cannot** host work Teams. If you only have an MSA tenant, create an Entra-native user there and sign that user up for a Microsoft 365 Business Basic trial to get Teams licensing.

1. Enable the Microsoft Teams channel on the Azure Bot:
   - Bot resource → **Settings → Channels** → add **Microsoft Teams** → accept terms.
2. Enable custom app upload:
   - [admin.teams.microsoft.com](https://admin.teams.microsoft.com) → Teams apps → Setup policies → Global → turn on **Upload custom apps**.
3. In Teams (Chrome/Edge work; Safari does not) → Apps → Manage your apps → Upload an app → Upload a custom app → pick `teams-app-package.zip`.
4. "Add" → the bot appears as a personal chat. Verify gpt-4o responses.

## 5. Okta OAuth sign-in

1. In Okta admin (`https://<org>.okta.com/admin`) → Applications → Create App Integration → OIDC Web Application.
   - Grant types: Authorization Code + Refresh Token.
   - Sign-in redirect URI: `https://token.botframework.com/.auth/web/redirect`.
   - Assign the app to your test users (or "Allow everyone in your organization").
2. Note the Client ID, Client Secret, and (if using a custom authorization server) the auth-server ID.
3. Azure Bot → Settings → Configuration → OAuth Connection Settings → **+ Add**.
   - Name: `Okta Oauth` (referenced by the bot's `OAUTH_CONNECTION_NAME` setting).
   - Service Provider: **Oauth 2 Generic Provider**.
   - Client ID, Client Secret: from Okta.
   - Scopes: `openid profile email offline_access`.
   - **Authorization URL template**: `https://<org>.okta.com/oauth2/<auth-server-id>/v1/authorize`
   - **Authorization URL query string template**: `?client_id={ClientId}&response_type=code&redirect_uri={RedirectUrl}&scope={Scopes}&state={State}`
   - **Token URL template**: `https://<org>.okta.com/oauth2/<auth-server-id>/v1/token`
   - **Token URL query string template**: `?` *(single question mark — the field is marked required but we need an empty query string so Bot Service POSTs the body)*
   - **Token Body Template**: `code={Code}&grant_type=authorization_code&redirect_uri={RedirectUrl}&client_id={ClientId}&client_secret={ClientSecret}`
   - **Refresh URL template**: `https://<org>.okta.com/oauth2/<auth-server-id>/v1/token`
   - **Refresh URL query string template**: `?`
   - **Refresh Body Template**: `refresh_token={RefreshToken}&grant_type=refresh_token&client_id={ClientId}&client_secret={ClientSecret}`
4. Save → click the connection → **Test Connection**. An Okta login should pop; signing in should show a success page.
5. Add the connection name to App Service settings:

```bash
az webapp config appsettings set \
  --name <app-name> \
  --resource-group <rg-name> \
  --settings "OAUTH_CONNECTION_NAME=Okta Oauth"
```

6. Update the Teams manifest's `validDomains` to include `oktaforai.oktapreview.com` (or your Okta domain) and `token.botframework.com`, rebuild `teams-app-package.zip`, and re-upload in Teams (Update or Remove-and-reinstall).

7. Chat the bot → expect a sign-in card → Okta login → "You're signed in with Okta" → subsequent messages hit gpt-4o.

## Gotchas we hit

- **Corporate DNS filters / TLS interception** break `az cli` and `devtunnel` locally. Work in Azure Cloud Shell to avoid these.
- **Personal MSA tenants ("Default Directory")** can't host Teams for Work. You need a native Entra user and a Teams-licensed SKU.
- **M365 Developer Program** now requires Visual Studio subscription / MPN partner status. Business Basic trial ($0 for 30 days, credit card required, auto-renews) is the realistic free path.
- **Teams channel is off by default** on new Azure Bots. Enable it under Settings → Channels or you'll get `AddAppBotToChatRosterFailed` on sideload.
- **Bot Service's "Oauth 2 Generic Provider"** marks the Token URL query string template as required even though we want it empty. Use `?` to satisfy the validator without breaking the POST flow.
- **`handleTeamsSigninVerifyState`** must pass `query.state` as the `magicCode` argument to `userTokenClient.getUserToken()`. Without it, the token lookup returns null after a successful sign-in and the bot shows "Sign-in didn't complete."
