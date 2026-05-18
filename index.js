require('dotenv').config();
const restify = require('restify');
const {
  CloudAdapter,
  ConfigurationServiceClientCredentialFactory,
  createBotFrameworkAuthenticationFromConfiguration,
} = require('botbuilder');
const { EchoBot } = require('./bot');
const tokenStore = require('./oktaTokenStore');

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

const bot = new EchoBot();

const server = restify.createServer();
server.use(restify.plugins.queryParser());
server.use(restify.plugins.bodyParser());

server.post('/api/messages', async (req, res) => {
  await adapter.process(req, res, (context) => bot.run(context));
});

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

server.get('/api/okta-callback', async (req, res) => {
  const { code, state, error, error_description } = req.query || {};

  if (error) {
    return sendHtml(
      res,
      400,
      `<html><body><h2>Sign-in error</h2><p>${error}: ${error_description || ''}</p></body></html>`,
    );
  }
  if (!code || !state) {
    return sendHtml(res, 400, '<html><body><h2>Missing code or state</h2></body></html>');
  }

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

  let tokenJson;
  try {
    const tokenRes = await fetch(`${oktaDomain}/oauth2/v1/token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
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

  if (!tokenJson.id_token) {
    return sendHtml(
      res,
      500,
      '<html><body><h2>Sign-in incomplete</h2><p>Okta did not return an id_token. Check the OIDC app scope configuration.</p></body></html>',
    );
  }

  tokenStore.setTokens(pending.teamsUserId, {
    idToken: tokenJson.id_token,
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token,
    expiresIn: tokenJson.expires_in,
  });

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
