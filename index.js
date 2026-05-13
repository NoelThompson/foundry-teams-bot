require('dotenv').config();
const restify = require('restify');
const {
  CloudAdapter,
  ConfigurationServiceClientCredentialFactory,
  createBotFrameworkAuthenticationFromConfiguration,
} = require('botbuilder');
const { EchoBot } = require('./bot');

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
server.use(restify.plugins.bodyParser());

server.post('/api/messages', async (req, res) => {
  await adapter.process(req, res, (context) => bot.run(context));
});

const port = process.env.PORT || 3978;
server.listen(port, () => {
  console.log(`Bot listening on http://localhost:${port}`);
});
