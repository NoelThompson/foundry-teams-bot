const crypto = require('crypto');

class OktaTokenStore {
  constructor() {
    this.pending = new Map();
    this.tokens = new Map();
  }

  createPendingState(teamsUserId, extra = {}) {
    const state = crypto.randomBytes(24).toString('hex');
    this.pending.set(state, {
      teamsUserId,
      createdAt: Date.now(),
      ...extra,
    });
    this._gcPending();
    return state;
  }

  consumePendingState(state) {
    const entry = this.pending.get(state);
    if (entry) this.pending.delete(state);
    return entry;
  }

  setTokens(teamsUserId, { idToken, accessToken, refreshToken, expiresIn }) {
    this.tokens.set(teamsUserId, {
      idToken,
      accessToken,
      refreshToken,
      expiresAt: Date.now() + (Number(expiresIn) || 0) * 1000,
    });
  }

  getTokens(teamsUserId) {
    const entry = this.tokens.get(teamsUserId);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now() + 30_000) {
      return null;
    }
    return entry;
  }

  clearTokens(teamsUserId) {
    this.tokens.delete(teamsUserId);
  }

  getAnyValidTokens() {
    for (const [, entry] of this.tokens) {
      if (!entry.expiresAt || entry.expiresAt > Date.now() + 30_000) {
        return entry;
      }
    }
    return null;
  }

  _gcPending() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [state, entry] of this.pending) {
      if (entry.createdAt < cutoff) this.pending.delete(state);
    }
  }
}

const singleton = new OktaTokenStore();
module.exports = singleton;
