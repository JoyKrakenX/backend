const test = require('node:test');
const assert = require('node:assert/strict');

const SERVICE_PATH = require.resolve('../services/contentModerationService');
const CONFIG_PATH = require.resolve('../utils/contentModerationConfig');
const MODEL_PATH = require.resolve('../models/ContentModerationLog');
const ContentModerationLog = require(MODEL_PATH);

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'CONTENT_MODERATION_ENABLED',
  'CONTENT_MODERATION_MODE',
  'CONTENT_MODERATION_CHAT_ENABLED',
  'CONTENT_MODERATION_SURVEY_COMMENTS_ENABLED',
  'CONTENT_MODERATION_OPENAI_MODEL',
  'CONTENT_MODERATION_OPENAI_TIMEOUT_MS',
  'CONTENT_MODERATION_OPENAI_COOLDOWN_MS',
  'CONTENT_MODERATION_CACHE_TTL_MS',
  'CONTENT_MODERATION_LOG_ALLOW_DECISIONS',
];

function loadModerationHarness({ env = {}, openAiCtor = null, logCreateImpl = null } = {}) {
  const previousEnv = {};
  for (const key of ENV_KEYS) {
    previousEnv[key] = process.env[key];
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      process.env[key] = String(env[key]);
    } else {
      delete process.env[key];
    }
  }

  delete require.cache[SERVICE_PATH];
  delete require.cache[CONFIG_PATH];

  const originalCreate = ContentModerationLog.create;
  ContentModerationLog.create =
    logCreateImpl ||
    (async (payload) => ({
      _id: 'moderation-log-1',
      ...payload,
    }));

  const service = require(SERVICE_PATH);
  const config = require(CONFIG_PATH);

  service.__test__.resetModerationTestState();
  service.__test__.setOpenAiClientCtorForTests(openAiCtor);

  return {
    service,
    config,
    restore() {
      ContentModerationLog.create = originalCreate;
      service.__test__.resetModerationTestState();
      service.__test__.setOpenAiClientCtorForTests(null);
      for (const key of ENV_KEYS) {
        if (previousEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previousEnv[key];
        }
      }
      delete require.cache[SERVICE_PATH];
      delete require.cache[CONFIG_PATH];
    },
  };
}

function createOpenAiCtor(responseFactory) {
  return class FakeOpenAI {
    constructor() {
      this.moderations = {
        create: async (payload) => responseFactory(payload),
      };
    }
  };
}

test('loadWordlistForLocale loads LDNOOBW datasets for fr/en/es/de', () => {
  const harness = loadModerationHarness();
  try {
    const { loadWordlistForLocale } = harness.service;
    for (const locale of ['fr', 'en', 'es', 'de']) {
      const wordlist = loadWordlistForLocale(locale);
      assert.equal(wordlist.locale, locale);
      assert.ok(wordlist.terms.length > 0);
      assert.ok(wordlist.termSet.size > 0);
    }
  } finally {
    harness.restore();
  }
});

test('loadProfanityCsvWordlistForLocale loads profanity.csv datasets for en/fr/es', () => {
  const harness = loadModerationHarness();
  try {
    const { loadProfanityCsvWordlistForLocale } = harness.service;
    for (const locale of ['fr', 'en', 'es']) {
      const wordlist = loadProfanityCsvWordlistForLocale(locale);
      assert.equal(wordlist.locale, locale);
      assert.ok(wordlist.terms.length > 0);
      assert.ok(wordlist.termSet.size > 0);
    }
    assert.ok(loadProfanityCsvWordlistForLocale('fr').termSet.has('baise'));
  } finally {
    harness.restore();
  }
});

test('normalizeForLexicalMatch removes accents and simple obfuscation', () => {
  const harness = loadModerationHarness();
  try {
    const { normalizeForLexicalMatch } = harness.service.__test__;
    assert.equal(normalizeForLexicalMatch('  M3RDé  '), 'merde');
    assert.equal(normalizeForLexicalMatch('h@te-speech'), 'hate speech');
  } finally {
    harness.restore();
  }
});

test('collectLexicalMatches avoids substring false positives but scans all supported locales', () => {
  const harness = loadModerationHarness();
  try {
    const { collectLexicalMatches } = harness.service.__test__;

    const falsePositive = collectLexicalMatches({
      text: 'conscience professionnelle',
      locale: 'fr',
    });
    assert.deepEqual(falsePositive.matches, []);

    const crossLocale = collectLexicalMatches({
      text: 'this is shit',
      locale: 'fr',
    });
    assert.ok(crossLocale.matches.some((match) => match.locale === 'en' && match.term === 'shit'));

    const profanityCsvMatch = collectLexicalMatches({
      text: 'baise',
      locale: 'fr',
    });
    assert.ok(
      profanityCsvMatch.matches.some(
        (match) =>
          match.locale === 'fr' &&
          match.term === 'baise' &&
          match.source === 'profanity_csv',
      ),
    );
  } finally {
    harness.restore();
  }
});

test('evaluateContentModeration keeps shadow mode non-blocking while preserving recommended verdict', async () => {
  const harness = loadModerationHarness({
    env: {
      CONTENT_MODERATION_MODE: 'shadow',
      CONTENT_MODERATION_ENABLED: 'true',
      CONTENT_MODERATION_CHAT_ENABLED: 'true',
    },
  });

  try {
    const { evaluateContentModeration } = harness.service.__test__;
    const { CONTENT_MODERATION_SURFACES, CONTENT_MODERATION_VERDICTS } = harness.config;
    const decision = await evaluateContentModeration({
      text: 'Quel con',
      surface: CONTENT_MODERATION_SURFACES.CHAT,
      locale: 'fr',
    });

    assert.equal(decision.recommendedVerdict, CONTENT_MODERATION_VERDICTS.AUTO_REMOVE_CHAT);
    assert.equal(decision.appliedVerdict, CONTENT_MODERATION_VERDICTS.ALLOW);
    assert.equal(decision.enforced, false);
    assert.equal(decision.source, 'ldnoobw');
    assert.ok(decision.reasonCodes.includes(harness.service.EXACT_LEXICAL_REASON));
    assert.equal(decision.providerStatus, 'skipped');
  } finally {
    harness.restore();
  }
});

test('evaluateContentModeration enforces lexical blocks for survey comments in enforce mode', async () => {
  const harness = loadModerationHarness({
    env: {
      CONTENT_MODERATION_MODE: 'enforce',
      CONTENT_MODERATION_ENABLED: 'true',
      CONTENT_MODERATION_SURVEY_COMMENTS_ENABLED: 'true',
    },
  });

  try {
    const { evaluateContentModeration } = harness.service.__test__;
    const { CONTENT_MODERATION_SURFACES, CONTENT_MODERATION_VERDICTS } = harness.config;
    const decision = await evaluateContentModeration({
      text: 'This is shit',
      surface: CONTENT_MODERATION_SURFACES.SURVEY_COMMENT,
      locale: 'en',
    });

    assert.equal(decision.recommendedVerdict, CONTENT_MODERATION_VERDICTS.AUTO_HIDE_COMMENT);
    assert.equal(decision.appliedVerdict, CONTENT_MODERATION_VERDICTS.AUTO_HIDE_COMMENT);
    assert.equal(decision.enforced, true);
    assert.ok(['ldnoobw', 'hybrid'].includes(decision.source));
    assert.ok(decision.reasonCodes.includes(harness.service.EXACT_LEXICAL_REASON));
    assert.equal(decision.providerStatus, 'skipped');
  } finally {
    harness.restore();
  }
});

test('evaluateContentModeration blocks profanity.csv-only french terms like baise', async () => {
  const harness = loadModerationHarness({
    env: {
      CONTENT_MODERATION_MODE: 'enforce',
      CONTENT_MODERATION_ENABLED: 'true',
      CONTENT_MODERATION_CHAT_ENABLED: 'true',
    },
  });

  try {
    const { evaluateContentModeration } = harness.service.__test__;
    const { CONTENT_MODERATION_SURFACES, CONTENT_MODERATION_VERDICTS } = harness.config;
    const decision = await evaluateContentModeration({
      text: 'baise',
      surface: CONTENT_MODERATION_SURFACES.CHAT,
      locale: 'fr',
    });

    assert.equal(decision.recommendedVerdict, CONTENT_MODERATION_VERDICTS.AUTO_REMOVE_CHAT);
    assert.equal(decision.appliedVerdict, CONTENT_MODERATION_VERDICTS.AUTO_REMOVE_CHAT);
    assert.equal(decision.source, 'profanity_csv');
    assert.ok(decision.reasonCodes.includes(harness.service.PROFANITY_CSV_REASON));
    assert.equal(decision.providerStatus, 'skipped');
  } finally {
    harness.restore();
  }
});

test('evaluateContentModeration enters cooldown on OpenAI rate limit and falls back quickly', async () => {
  let calls = 0;
  const harness = loadModerationHarness({
    env: {
      OPENAI_API_KEY: 'test-key',
      CONTENT_MODERATION_MODE: 'enforce',
      CONTENT_MODERATION_ENABLED: 'true',
      CONTENT_MODERATION_OPENAI_COOLDOWN_MS: '60000',
    },
    openAiCtor: createOpenAiCtor(async () => {
      calls += 1;
      const error = new Error('429 Too Many Requests');
      error.status = 429;
      throw error;
    }),
  });

  try {
    const { evaluateContentModeration } = harness.service.__test__;
    const { CONTENT_MODERATION_SURFACES } = harness.config;

    const firstDecision = await evaluateContentModeration({
      text: 'ordinary first sentence',
      surface: CONTENT_MODERATION_SURFACES.CHAT,
      locale: 'en',
    });
    const secondDecision = await evaluateContentModeration({
      text: 'ordinary second sentence',
      surface: CONTENT_MODERATION_SURFACES.CHAT,
      locale: 'en',
    });

    assert.equal(calls, 1);
    assert.equal(firstDecision.source, 'fallback');
    assert.ok(firstDecision.reasonCodes.includes(harness.service.OPENAI_RATE_LIMIT_REASON));
    assert.ok(secondDecision.reasonCodes.includes(harness.service.OPENAI_COOLDOWN_REASON));
    assert.equal(secondDecision.source, 'fallback');
  } finally {
    harness.restore();
  }
});

test('evaluateContentModeration can block on OpenAI moderation alone', async () => {
  const harness = loadModerationHarness({
    env: {
      OPENAI_API_KEY: 'test-key',
      CONTENT_MODERATION_MODE: 'enforce',
      CONTENT_MODERATION_ENABLED: 'true',
    },
    openAiCtor: createOpenAiCtor(async () => ({
      results: [
        {
          flagged: true,
          categories: { hate: true },
          category_scores: { hate: 0.99 },
        },
      ],
    })),
  });

  try {
    const { evaluateContentModeration } = harness.service.__test__;
    const { CONTENT_MODERATION_SURFACES, CONTENT_MODERATION_VERDICTS } = harness.config;
    const decision = await evaluateContentModeration({
      text: 'ordinary sentence with no lexical match',
      surface: CONTENT_MODERATION_SURFACES.CHAT,
      locale: 'en',
    });

    assert.equal(decision.appliedVerdict, CONTENT_MODERATION_VERDICTS.AUTO_REMOVE_CHAT);
    assert.equal(decision.source, 'openai');
    assert.ok(decision.reasonCodes.includes('OPENAI_HATE'));
    assert.equal(decision.providerStatus, 'available');
  } finally {
    harness.restore();
  }
});

test('evaluateContentModeration short-circuits exact lexical matches without waiting for OpenAI', async () => {
  const harness = loadModerationHarness({
    env: {
      OPENAI_API_KEY: 'test-key',
      CONTENT_MODERATION_MODE: 'enforce',
      CONTENT_MODERATION_ENABLED: 'true',
    },
    openAiCtor: createOpenAiCtor(async () => ({
      results: [
        {
          flagged: true,
          categories: { harassment: true },
          category_scores: { harassment: 0.92 },
        },
      ],
    })),
  });

  try {
    const { evaluateContentModeration } = harness.service.__test__;
    const { CONTENT_MODERATION_SURFACES } = harness.config;
    const decision = await evaluateContentModeration({
      text: 'Quel con',
      surface: CONTENT_MODERATION_SURFACES.CHAT,
      locale: 'fr',
    });

    assert.equal(decision.source, 'ldnoobw');
    assert.ok(decision.reasonCodes.includes(harness.service.EXACT_LEXICAL_REASON));
    assert.equal(decision.providerStatus, 'skipped');
  } finally {
    harness.restore();
  }
});

test('moderateChatMessage creates a moderation log and rejects the message in enforce mode', async () => {
  const captured = [];
  const harness = loadModerationHarness({
    env: {
      CONTENT_MODERATION_MODE: 'enforce',
      CONTENT_MODERATION_ENABLED: 'true',
      CONTENT_MODERATION_CHAT_ENABLED: 'true',
    },
    logCreateImpl: async (payload) => {
      captured.push(payload);
      return { _id: 'log-chat-1', ...payload };
    },
  });

  try {
    const result = await harness.service.moderateChatMessage({
      text: 'shit',
      locale: 'en',
      surveyId: 'survey-1',
      surveyType: 'binary',
      surveyModel: 'Survey',
      userId: 'user-1',
      userPseudoSnapshot: 'Neo',
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.decision.appliedVerdict,
      harness.config.CONTENT_MODERATION_VERDICTS.AUTO_REMOVE_CHAT,
    );
    assert.equal(result.logEntry._id, 'log-chat-1');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].surface, harness.config.CONTENT_MODERATION_SURFACES.CHAT);
    assert.equal(captured[0].surveyId, 'survey-1');
    assert.equal(captured[0].userPseudoSnapshot, 'Neo');
  } finally {
    harness.restore();
  }
});

test('moderateChatMessage skips allow logs by default for faster safe-path decisions', async () => {
  const captured = [];
  const harness = loadModerationHarness({
    env: {
      CONTENT_MODERATION_MODE: 'enforce',
      CONTENT_MODERATION_ENABLED: 'true',
      CONTENT_MODERATION_CHAT_ENABLED: 'true',
    },
    openAiCtor: createOpenAiCtor(async () => ({
      results: [
        {
          flagged: false,
          categories: {},
          category_scores: {},
        },
      ],
    })),
    logCreateImpl: async (payload) => {
      captured.push(payload);
      return { _id: 'log-chat-allow', ...payload };
    },
  });

  try {
    const result = await harness.service.moderateChatMessage({
      text: 'bonjour calme',
      locale: 'fr',
      surveyId: 'survey-1',
      surveyType: 'binary',
      surveyModel: 'Survey',
      userId: 'user-1',
      userPseudoSnapshot: 'Neo',
    });

    assert.equal(result.ok, true);
    assert.equal(result.logEntry, null);
    assert.equal(captured.length, 0);
  } finally {
    harness.restore();
  }
});
