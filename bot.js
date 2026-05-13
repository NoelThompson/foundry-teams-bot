const {
  TeamsActivityHandler,
  MessageFactory,
  CardFactory,
} = require('botbuilder');
const { AzureOpenAI } = require('openai');

const SYSTEM_PROMPT =
  'You are a helpful assistant in a Microsoft Teams chat. Keep replies concise and conversational.';
const MAX_HISTORY_MESSAGES = 20;

class EchoBot extends TeamsActivityHandler {
  constructor() {
    super();

    this.connectionName = process.env.OAUTH_CONNECTION_NAME || 'Okta Oauth';
    this.deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
    this.histories = new Map();

    this.onMessage(async (context, next) => {
      const tokenResponse = await this._getUserToken(context);

      if (!tokenResponse || !tokenResponse.token) {
        await this._sendSignInCard(context);
        return next();
      }

      await this._respondWithGpt(context);
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

    this.onTokenResponseEvent(async (context, next) => {
      await context.sendActivity(
        MessageFactory.text("You're signed in with Okta. Ask me anything."),
      );
      await next();
    });
  }

  async handleTeamsSigninVerifyState(context, query) {
    const magicCode = query?.state;
    console.log('[FoundryBot] signin/verifyState received, magicCode present:', !!magicCode);
    await this._confirmSignIn(context, magicCode);
  }

  async handleTeamsSigninTokenExchange(context, query) {
    const magicCode = query?.state;
    console.log('[FoundryBot] signin/tokenExchange received');
    await this._confirmSignIn(context, magicCode);
  }

  async _confirmSignIn(context, magicCode) {
    const tokenResponse = await this._getUserToken(context, magicCode);
    if (tokenResponse && tokenResponse.token) {
      await context.sendActivity(
        MessageFactory.text("You're signed in with Okta. Ask me anything."),
      );
    } else {
      await context.sendActivity(
        MessageFactory.text("Sign-in didn't complete. Please try again."),
      );
    }
  }

  async _getUserToken(context, magicCode = null) {
    try {
      const userTokenClient = context.turnState.get(
        context.adapter.UserTokenClientKey,
      );
      if (!userTokenClient) return null;
      return await userTokenClient.getUserToken(
        context.activity.from.id,
        this.connectionName,
        context.activity.channelId,
        magicCode,
      );
    } catch (err) {
      console.error('[FoundryBot] getUserToken error:', err);
      return null;
    }
  }

  async _sendSignInCard(context) {
    try {
      const userTokenClient = context.turnState.get(
        context.adapter.UserTokenClientKey,
      );
      const signInResource = await userTokenClient.getSignInResource(
        this.connectionName,
        context.activity,
        null,
      );

      const card = CardFactory.oauthCard(
        this.connectionName,
        'Sign in with Okta',
        'You need to sign in to chat with the agent.',
        signInResource.signInLink,
        signInResource.tokenExchangeResource,
      );
      await context.sendActivity({ attachments: [card] });
    } catch (err) {
      console.error('[FoundryBot] sendSignInCard error:', err);
      await context.sendActivity(
        MessageFactory.text(`Sign-in setup error: ${err.message}`),
      );
    }
  }

  async _respondWithGpt(context) {
    const convId = context.activity.conversation.id;
    const history = this.histories.get(convId) || [];
    history.push({ role: 'user', content: context.activity.text });

    try {
      const client = this._getClient();
      const response = await client.chat.completions.create({
        model: this.deployment,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
        temperature: 0.3,
      });

      const reply = response.choices?.[0]?.message?.content || '(no reply)';
      history.push({ role: 'assistant', content: reply });

      while (history.length > MAX_HISTORY_MESSAGES) history.shift();
      this.histories.set(convId, history);

      await context.sendActivity(MessageFactory.text(reply));
    } catch (err) {
      console.error('[FoundryBot] error calling Azure OpenAI:', err);
      await context.sendActivity(
        MessageFactory.text(`Error talking to the model: ${err.message}`),
      );
    }
  }

  _getClient() {
    if (this._client) return this._client;
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    if (!endpoint || !apiKey) {
      throw new Error(
        'AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY must be set as app settings.',
      );
    }
    this._client = new AzureOpenAI({
      endpoint,
      apiKey,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
    });
    return this._client;
  }
}

module.exports = { EchoBot };
