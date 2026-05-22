# Configuring ServiceNow to Accept Okta-Issued OAuth Tokens for AI Agents

A platform-agnostic guide for ServiceNow administrators integrating with **any** AI agent that authenticates via Okta and presents JWT Bearer tokens scoped through Cross-App Access (CAA / ID-JAG / OAuth Token Exchange).

This guide is written generically. It does not assume Microsoft Teams, Azure AI Foundry, or any specific agent platform. It applies to any host application that:

- Has a user signed in via Okta OIDC.
- Mints downstream resource tokens on the user's behalf, using its own machine identity (an Okta AI Agent or equivalent OAuth client) and an OAuth 2.0 Token Exchange flow.
- Sends those tokens to ServiceNow's REST API as `Authorization: Bearer <token>`.

---

## 1. Overview — what you're configuring and why

ServiceNow needs to accept inbound JWT Bearer tokens that:

- Were issued by your Okta authorization server.
- Carry the user's identity in the `sub` claim (so ServiceNow can map to a SN user).
- Carry the agent's identity in the `cid` claim (for audit / control-plane purposes).
- Have an `aud` (audience) claim matching what's registered on your Okta resource server.
- Include a `scp` (scope) claim authorizing the agent for the specific operations being requested.

ServiceNow's job is to:

1. Validate the JWT signature against your Okta auth server's public keys (via the JWKS URL exposed in OIDC discovery).
2. Validate the issuer, audience, expiration, and any custom claim checks.
3. Confirm the requested scope is one ServiceNow trusts on this entity.
4. Resolve the `sub` claim to a real ServiceNow user record.
5. Apply ACLs / roles for that user when authorizing API access.

Once this trust is configured, ServiceNow effectively acts as a resource server in the OAuth 2.0 sense, and any agent that can mint tokens with the right shape can call it.

---

## 2. Prerequisites

Before starting in ServiceNow, gather these values from your Okta and agent-host configuration:

| Item | Example | Notes |
|---|---|---|
| Okta org domain | `https://example.okta.com` | Your Okta tenant (production or preview). |
| Authorization server ID | `aus1ab2cdEFGHIJK3l4` | The custom auth server hosting your XAA / cross-app policies. **Not** the org-level `default` server unless that's specifically where your tokens come from. |
| OIDC discovery URL | `<okta-domain>/oauth2/<authServerId>/.well-known/openid-configuration` | Public; you can `curl` it from any network that can reach Okta. ServiceNow will fetch this during validation. |
| Resource audience URI | `https://api.your-resource.example.com` | The string you registered as an audience on the auth server, and what your agent's host puts in the token's `aud` claim. **Will be the Client ID of the ServiceNow OIDC entity.** |
| Scope name(s) | `mcp:read`, `inventory:write`, etc. | Whatever scopes the agent is granted via Okta Resource Connections. Each must be registered separately on the ServiceNow side. |
| ServiceNow instance URL | `https://yourinstance.service-now.com` | The instance you'll be calling. |
| Admin access to ServiceNow | — | You'll need permission to create Application Registry records and manage the trust configuration. |
| One or more existing SN users with email matching the `sub` claim | `noel.thompson@okta.com` | If the SN user doesn't exist, validation will succeed but the user lookup fails and you get a 401. |

If you don't yet have any of these, get them sorted on the Okta / agent side first — ServiceNow can't validate what hasn't been issued.

---

## 3. Setup steps in ServiceNow

### Step 3.1: Open the right Application Registry form

Navigate to **System OAuth → Application Registry → New**.

You'll see a type-picker page with several options. **Pick this one**:

> **`[Deprecated UI] Configure an OIDC provider to verify ID tokens`**

The "deprecated" label is misleading — the form is fully functional and is currently the most direct path for inbound JWT validation against an external IdP.

**Do NOT pick** these (they look similar but are wrong for our purpose):

- *Connect to a third party OAuth Provider* — this is for ServiceNow acting as an OAuth client (outbound), not as a resource server (inbound).
- *Configure a Client ID Metadata Document (CIMD) client* — same direction, different mechanism.
- *[Deprecated UI] Create an OAuth API endpoint for external clients* — works, but uses a different (and harder to configure) signature validation path.
- *New Inbound Integration Experience* — newer wizard; works but adds layers of indirection that obscure what's happening.

### Step 3.2: Configure the parent record

| Field | What to put | Why |
|---|---|---|
| **Name** | Descriptive label, e.g. `Okta-AgentTrust-Production` | Human readable; not used for validation. |
| **Client ID** | The exact audience URI your agent's tokens carry, e.g. `https://api.your-resource.example.com` | ServiceNow looks up which entity to use for an inbound token by matching the token's `aud` claim against this field. **This field is immutable after save** — pick a value you're confident in. |
| **Client Secret** | Leave the auto-generated value; not used for inbound JWT validation | Required by the form, ignored at runtime for our flow. |
| **User field** | `Email` | ServiceNow will match the `sub` claim from the token against this column on the User table. Set to whatever User column holds the same identifier the token carries (often Email or User ID). |
| **Token Format** | `JWT` (NOT `Opaque`) | JWT bearers will be parsed and validated; opaque tokens get looked up against ServiceNow's local opaque-token table and will fail. |
| **Active** | Checked | Inactive entities are skipped at request time. |
| **Enable JTI Verification** | Unchecked, *unless* you're issuing single-use tokens | If checked, ServiceNow rejects any token whose `jti` it has seen before. This breaks reuse of legitimately-still-valid access tokens within their lifetime. Leave off for typical agent use; turn on only if you've explicitly designed the flow for single-use tokens. |

Save the record. Several related lists will appear at the bottom — the next steps populate them.

### Step 3.3: Create the OIDC Provider Configuration

Look for a reference field on the parent record labeled **OAuth OIDC provider configuration** (or similar). Click the magnifying-glass / lookup icon → **New** to open a sub-form.

| Field | What to put |
|---|---|
| **OIDC Provider** | Descriptive name (e.g., `Okta-AgentTrust`). Cosmetic. |
| **OIDC Metadata URL** | `<okta-domain>/oauth2/<authServerId>/.well-known/openid-configuration` |
| **User claim** | `sub` |

> **Critical**: the `User claim` field is sometimes left empty by accident. If it's empty, ServiceNow's user-resolution step fails silently and you get an unhelpful 401. Always fill it in.

Save the sub-record. ServiceNow will fetch the metadata document at request time and use it to:

- Confirm the issuer matches.
- Locate the JWKS URL for signature verification keys.
- Determine supported signing algorithms.

You don't need to manually upload public keys, certificates, or a JWKS-cache record — the OIDC discovery flow handles it automatically.

### Step 3.4: Register the OAuth Entity Scope (the most-missed step)

On the parent record's **OAuth Entity Scopes** related list → **New**:

| Field | What to put |
|---|---|
| **Name** | The exact scope string the agent's tokens carry (e.g., `mcp:read`). |
| **Description** | Anything readable. |

Repeat for each scope your tokens may include.

> ⚠️ **This is the trap.** Without scopes registered here, ServiceNow rejects perfectly valid tokens with the misleading error `BadJWSException: failed to verify signature`. The error sounds cryptographic but is actually a scope-authorization failure inside the same validator. Always check this first when you see signature-related errors.

### Step 3.5: What NOT to add (skip these or remove if present)

Some related lists look relevant but actively interfere with the OIDC-discovery validation chain. Leave them empty:

- **JWT Verifier Maps** — for manual key management. The OIDC Metadata URL handles key fetching automatically; manual entries can pre-empt and conflict with discovery.
- **Sys Certificates** — for manually wrapping public keys in X.509. Not needed; skip.
- **OAuth JWT Claim Validations** — only useful for adding *additional* defensive claim checks beyond what the OIDC entity already enforces. For most setups, the entity's built-in validation is sufficient.

### Step 3.6: Verify the ServiceNow user

Confirm there's a ServiceNow user record where `Email` (or whichever User column you specified in step 3.2) matches the `sub` claim of the tokens you'll mint. **System Definition → Users** → search.

If the user doesn't exist, create them:

- Email: matches the `sub` claim.
- Active: yes.
- Roles: assign at minimum the role required to access whichever tables the agent will read or write (e.g., `itil` for the `incident` table). Without the right roles, validation will succeed but the API call will return 403.

### Step 3.7: Smoke-test outside the agent

Before integrating end-to-end through the agent, isolate the ServiceNow trust by hitting the API directly:

```bash
# Mint a fresh token via your agent's host application's mechanism
# (e.g., a CLI test tool, a debug endpoint, or a script).
# Then:
curl -i \
  -H "Authorization: Bearer <your-fresh-token>" \
  "https://yourinstance.service-now.com/api/now/table/incident?sysparm_limit=1"
```

**Expected outcomes:**

- `200 OK` with JSON body → ServiceNow trust is correctly configured. Move on.
- `401 User is not authenticated` → see the troubleshooting table below.
- `403 Forbidden` → trust validation passed, but the resolved user lacks roles. Add the required role.

For any failure, immediately check **System Logs → All** with a filter on keywords like `OIDC`, `JWT`, `OAuth`, or your token's `aud` value. The on-platform error message is more specific than the HTTP response.

---

## 4. Troubleshooting

The errors below are ranked roughly by how often we've seen each one in real setups.

| Error / symptom | Most likely cause | Fix |
|---|---|---|
| `BadJWSException: failed to verify signature` (signature actually verifies externally) | Missing OAuth Entity Scope. | Add the scope from the token's `scp` claim to the entity's **OAuth Entity Scopes** related list. |
| `401 User is not authenticated` (no specific error in System Logs) | Token's `aud` doesn't match any active OIDC entity's Client ID. | Compare the token's `aud` value against the Client ID on your entity. Remember Client ID is immutable; if mismatched, recreate the entity. |
| `Cannot find oauth_oidc_entity for issuer X with client_ids Y` (System Logs) | No OIDC entity matching the (issuer, audience) pair. | Create the entity per step 3.2 with Client ID = your token's `aud`, and ensure the OIDC Metadata URL points at the correct issuer. |
| `JTI claim verification failed, duplicated JTI found` | JTI replay protection is enabled and you're reusing a token. | Either uncheck "Enable JTI Verification" (if access tokens are intentionally reusable in your design) or always mint a fresh token per call. |
| `OIDC token verification failed: Invalid JWT Signature` (after correct scope is registered) | Two OIDC entities have the same Client ID; ServiceNow matched the wrong one. | Make Client ID unique to this integration. Recreate the entity if necessary. |
| `User claim is empty` or silent 401 with no specific error | The `User claim` field on the OIDC Provider Configuration sub-record is empty. | Set it to `sub` (or whatever claim your tokens carry). |
| `403` instead of `401` | Trust validates, user resolves, but the user lacks roles for the requested resource. | Grant the appropriate role (e.g., `itil` for incident access) to the user matching the `sub` claim. |
| ServiceNow attempts but doesn't seem to fetch metadata | Outbound network egress restriction (rare, but happens on some shared / locked-down instances). | Check **System Logs → Outbound HTTP Log** for calls to your Okta domain. If absent, work with your SN account team on egress allowlisting. |

---

## 5. Validation checklist

Before declaring the integration complete, confirm:

- [ ] OIDC entity exists, **Active**, with Client ID = your token audience and Token Format = JWT.
- [ ] OIDC Provider Configuration sub-record references the correct Metadata URL and has User claim = `sub` (or your equivalent).
- [ ] All scopes that your tokens may request are registered on **OAuth Entity Scopes**.
- [ ] No extraneous JWT Verifier Maps or Sys Certificates are linked (they can interfere).
- [ ] A ServiceNow user exists with the email matching the `sub` claim of your test tokens.
- [ ] That user has the roles required to access the API tables the agent will use.
- [ ] A direct curl with a freshly minted token returns 200 against the target table.

If all seven boxes are checked, your agent's tokens — regardless of what platform mints them — should now flow through to ServiceNow.

---

## 6. Out of scope for this guide

- **Configuring Okta itself** (creating the AI Agent object, the custom authorization server, Resource Connections, OIDC apps, etc.). This guide assumes those are already in place and producing tokens you can validate externally with `jwt.io` against the JWKS at `<okta-domain>/oauth2/<authServerId>/v1/keys`.
- **The agent host's token-minting code.** Different agent platforms (Azure AI Foundry, custom Node/Python services, MCP gateways, etc.) implement the Token Exchange flow differently. This guide is concerned only with what ServiceNow needs to receive on its end.
- **Production-grade hardening.** The setup above is functional. Production should additionally consider: rate limiting, claim validation rules beyond what OIDC discovery enforces, alerting on validation failures, and a documented response procedure for revoked or compromised tokens.

---

## Appendix: Quick-reference field map

If you're filling out the forms next to this doc:

```
Application Registry record (parent):
  Name                : <descriptive>
  Client ID           : <your audience URI>      ← matches token's aud
  Client Secret       : (auto)                   ← unused for inbound JWT
  User field          : Email                    ← which SN user column to match
  Token Format        : JWT                      ← NOT Opaque
  Active              : ☑
  Enable JTI Verify   : ☐ (unless single-use)

OIDC Provider Configuration (sub-record):
  OIDC Provider       : <descriptive>
  OIDC Metadata URL   : <okta>/oauth2/<authServer>/.well-known/openid-configuration
  User claim          : sub                      ← do not leave empty

OAuth Entity Scopes (one record per scope):
  Name                : <exact scope string>     ← e.g., mcp:read
  Description         : <readable>

Skip (do not populate):
  JWT Verifier Maps
  Sys Certificates
  OAuth JWT Claim Validations
```
