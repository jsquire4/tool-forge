/**
 * User Preferences API — per-user model + HITL preferences.
 *
 * GET  /agent-api/user/preferences — read preferences + effective values
 * PUT  /agent-api/user/preferences — update preferences (gated by config)
 */

import { readBody, sendJson } from '../http-utils.js';

const VALID_HITL_LEVELS = ['autonomous', 'cautious', 'standard', 'paranoid'];

/**
 * GET /agent-api/user/preferences
 */
export async function handleGetPreferences(req, res, ctx) {
  const { auth, preferenceStore, config, env } = ctx;

  const authResult = auth.authenticate(req);
  if (!authResult.authenticated) {
    sendJson(res, 401, { error: authResult.error ?? 'Unauthorized' });
    return;
  }

  const userId = authResult.userId;
  const prefs = preferenceStore.getUserPreferences(userId);
  const effective = await preferenceStore.resolveEffective(userId, config, env);

  sendJson(res, 200, {
    preferences: prefs ?? { model: null, hitlLevel: null },
    effective: { model: effective.model, hitlLevel: effective.hitlLevel, provider: effective.provider },
    permissions: {
      canChangeModel: !!config.allowUserModelSelect,
      canChangeHitl: !!config.allowUserHitlConfig
    },
    options: {
      hitlLevels: VALID_HITL_LEVELS
    }
  });
}

/**
 * PUT /agent-api/user/preferences
 */
export async function handlePutPreferences(req, res, ctx) {
  const { auth, preferenceStore, config } = ctx;

  const authResult = auth.authenticate(req);
  if (!authResult.authenticated) {
    sendJson(res, 401, { error: authResult.error ?? 'Unauthorized' });
    return;
  }

  const userId = authResult.userId;
  const body = await readBody(req);

  // Validate and apply model change
  if (body.model !== undefined && !config.allowUserModelSelect) {
    sendJson(res, 403, { error: 'Model selection is not allowed by app configuration' });
    return;
  }

  // Validate and apply HITL change
  if (body.hitl_level !== undefined) {
    if (!config.allowUserHitlConfig) {
      sendJson(res, 403, { error: 'HITL level configuration is not allowed by app configuration' });
      return;
    }
    if (!VALID_HITL_LEVELS.includes(body.hitl_level)) {
      sendJson(res, 400, { error: `Invalid hitl_level. Must be one of: ${VALID_HITL_LEVELS.join(', ')}` });
      return;
    }
  }

  const prefs = {};
  if (body.model !== undefined) prefs.model = body.model;
  if (body.hitl_level !== undefined) prefs.hitlLevel = body.hitl_level;

  preferenceStore.setUserPreferences(userId, prefs);

  sendJson(res, 200, { ok: true, updated: prefs });
}

