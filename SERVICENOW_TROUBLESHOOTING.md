# ServiceNow trust troubleshooting

> **RESOLVED 2026-05-20.** Root cause was a missing **OAuth Scope** record on the OIDC Provider entity. ServiceNow validates the `scp` claim against registered scopes; without `mcp:read` registered, validation failed with the misleading error `BadJWSException: failed to verify signature` — which sounds like a cryptography problem but was actually a scope-authorization failure inside the same validator. Adding `mcp:read` as an OAuth Scope on the OIDC Provider record (just Name + Description) resolved it instantly.
>
> **Lesson**: when ServiceNow returns persistent `BadJWSException` and your signature actually verifies externally (try jwt.io against the JWKS), check the OIDC entity's Scopes related list before anything else. SN's error reporting bundles signature + scope validation under the same exception name.

---

# Original troubleshooting log (kept for reference)


The bot's Cross-App Access (XAA / ID-JAG) flow works end-to-end through Okta — `/testjag` and `/testresource` slash commands both produce a properly-formed access token signed by our Okta auth server, with correct `iss`, `aud`, `sub` (human user), `cid` (agent workload), and scope claims. Foundry agent calls our tool endpoint; tool endpoint mints the XAA-scoped Bearer; bot fires `GET /api/now/table/incident` against ServiceNow.

**ServiceNow `ven04722.service-now.com` rejects the token with `401 / BadJWSException: failed to verify signature`** despite the signature actually being valid (we can verify it locally against the JWKS). This is a ServiceNow-side trust configuration issue we haven't been able to resolve from outside that instance.

## What we know

- Tokens are signed by Okta auth server `oktaforai.oktapreview.com/oauth2/ausyrbiuzeYR2sAeu1d7` (kid `zGODBjWYfedLVOH_qPpJtIiEj7SaB6kei5TFiF2dvW4`).
- `aud = https://oktademo.mcp.servicenow.com` (notebook's audience), `sub = noel.thompson@okta.com`, `cid = wlpykxnap92EyB40F1d7`, scope `mcp:read`.
- Same SN instance accepts tokens minted by colleague's `ijtestcustom.oktapreview.com/oauth2/ausy1yy7clDP5aO6s1d7` (different Okta tenant) using the same Client ID.
- ServiceNow outbound HTTP log confirms SN successfully reaches our `oktaforai` discovery + JWKS endpoints (200 responses).
- Discovery doc and JWKS responses are valid; we verified externally with curl that the kid in our token is in the JWKS.

## What we tried (and why each didn't fix it)

| Attempt | Result |
|---|---|
| OAuth JWT API endpoint (deprecated UI) with manual JWT Verifier Map + Sys Certificate (X.509-wrapped Okta public key) | `Cannot find oauth_oidc_entity` then `Invalid JWT Signature`. Cert may have failed chain trust. |
| OIDC Provider entry (deprecated UI) + OIDC Provider Configuration with our metadata URL | Got past `oauth_oidc_entity` lookup; signature still fails. |
| Adding OAuth JWT Claim Validations for `aud` and `iss` | No effect; signature errors persist. |
| Setting User Claim to `sub` on the OIDC Provider Configuration | Cleared a separate user-mapping issue but signature error remained. |
| Removing all manual cert / verifier map / claim validations to rely on OIDC discovery | Same signature errors — though this is what colleague's working setup does. |
| Disabling JTI verification | Cleared "duplicate JTI" replay errors; signature failure was next. |
| Using a unique Client ID (`https://foundry-okta-demo.noel`) to avoid colliding with colleague's `https://oktademo.mcp.servicenow.com` Client ID | Same errors. |
| Re-creating the OIDC Provider record fresh | Same errors. |
| Refreshing metadata, deleting cached entries | Same errors. |

## Suspected root causes (not yet confirmed)

1. **JWKS cache** — Cache Lifespan was set to 720 (likely minutes = 12 hours). SN may be serving a stale or empty cached JWKS for our `oktaforai` issuer. Need to confirm whether the cache can be force-cleared from outside SN admin.
2. **Implicit instance trust** — `ven04722` may have been provisioned with an explicit allowlist of trusted Okta tenants (e.g., only `ijtestcustom`), and our `oktaforai` is reaching the JWKS endpoint but being rejected at a higher trust layer.
3. **Client ID collision matching quirk** — even with unique Client IDs registered now, an earlier collision may have left state in SN.

## Verification we can offer

- `/testresource` in Teams returns a 200 with full token + decoded claims.
- The token at https://jwt.io/#token=&lt;paste&gt; verifies with the public key from `https://oktaforai.oktapreview.com/oauth2/ausyrbiuzeYR2sAeu1d7/v1/keys`.

## Asks for the colleague

- A diff of their working OIDC Provider record, OIDC Provider Configuration, and any related lists vs. ours — particularly anything we might be missing.
- Whether the SN instance has an admin-controlled allowlist for inbound IDPs.
- Whether they can clear / refresh the SN-side JWKS cache for `oktaforai.oktapreview.com`.
- Failing all of the above: an alternative downstream resource (different ServiceNow instance, different API) we could target with the same XAA flow.
