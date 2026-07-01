let dotenv = null;

try {
  dotenv = require('dotenv');
  dotenv.config();
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
}

const fs = require('fs');
const net = require('net');
const path = require('path');
const stringWidthModule = require('string-width');
const stringWidth = stringWidthModule.default || stringWidthModule;

const ENV_FILE_PATH = path.resolve(__dirname, '.env');
const USER_TOKENS_FILE_PATH = path.resolve(__dirname, 'user_tokens.json');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const STEAM_API_KEY = process.env.STEAM_API_KEY || '';
let activeSteamApiKey = STEAM_API_KEY;
const KF2_SERVER_MESSAGE_STEAM_ID = '0x011000010A2A86B6';
const KF2_SERVER_COUNT = 5;
const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const initialRuntimeConfig = loadRuntimeConfig(process.env);
let CDA_AVATAR_URL = initialRuntimeConfig.cdaAvatarUrl;
let KF2_RECONNECT_DELAY_MS = initialRuntimeConfig.kf2ReconnectDelayMs;
let KF2_CONNECT_TIMEOUT_MS = initialRuntimeConfig.kf2ConnectTimeoutMs;
let KF2_REQUEST_TIMEOUT_MS = initialRuntimeConfig.kf2RequestTimeoutMs;
let KF2_KICK_VOTE_DISCORD_CHANNEL_IDS = initialRuntimeConfig.kf2KickVoteDiscordChannelIds;
let KF2_PAUSE_SKIP_VOTE_DISCORD_CHANNEL_IDS = initialRuntimeConfig.kf2PauseSkipVoteDiscordChannelIds;
let KF2_MONTHLY_REWARD_DISCORD_CHANNEL_IDS = initialRuntimeConfig.kf2MonthlyRewardDiscordChannelIds;
let KF2_VOTE_TIMEOUT_MS = initialRuntimeConfig.kf2VoteTimeoutMs;
let KF2_KICK_VOTE_PASS_PERCENT = initialRuntimeConfig.kf2KickVotePassPercent;
let KF2_PAUSE_VOTE_PASS_PERCENT = initialRuntimeConfig.kf2PauseVotePassPercent;
let KF2_SKIP_VOTE_PASS_PERCENT = initialRuntimeConfig.kf2SkipVotePassPercent;
let KF2_CONSOLE_LOGS_ENABLED = initialRuntimeConfig.kf2ConsoleLogsEnabled;
let DISCORD_WEBHOOK_RATE_LIMIT_RETRY_LIMIT = initialRuntimeConfig.discordWebhookRateLimitRetryLimit;
let DISCORD_WEBHOOK_RETRY_INTERVAL_MS = initialRuntimeConfig.discordWebhookRetryIntervalMs;
let DISCORD_RETRY_QUEUE_MAX_AGE_MS = initialRuntimeConfig.discordRetryQueueMaxAgeMs;
let SPECIAL_ACCESS_ROLE_IDS = initialRuntimeConfig.specialAccessRoleIds;
let COMMAND_PUBLIC_TOKEN_LIMIT = initialRuntimeConfig.commandPublicTokenLimit;
let COMMAND_PRIVATE_TOKEN_LIMIT = initialRuntimeConfig.commandPrivateTokenLimit;
let COMMAND_TOKEN_RESET_SECONDS = initialRuntimeConfig.commandTokenResetSeconds;
let COMMAND_TOKEN_RESET_ANCHOR = initialRuntimeConfig.commandTokenResetAnchor;
let COMMAND_COOLDOWN_ROLE_MODE = initialRuntimeConfig.commandCooldownRoleMode;
let COMMAND_COOLDOWN_ROLE_IDS = initialRuntimeConfig.commandCooldownRoleIds;

function formatLogTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${year}.${month}.${day} ${hours}:${minutes}:${seconds}`;
}

function logWithTimestamp(level, message) {
  console[level](`[${formatLogTimestamp()}] ${message}`);
}

function logInfo(message) {
  logWithTimestamp('log', message);
}

function logWarn(message) {
  logWithTimestamp('warn', message);
}

function logError(message) {
  logWithTimestamp('error', message);
}

function logInfoConfig(message) {
  if (KF2_CONSOLE_LOGS_ENABLED) {
    logInfo(message);
  }
}

function logWarnConfig(message) {
  if (KF2_CONSOLE_LOGS_ENABLED) {
    logWarn(message);
  }
}

function logErrorConfig(message) {
  if (KF2_CONSOLE_LOGS_ENABLED) {
    logError(message);
  }
}

function getDiscordTextWidth(value) {
  return stringWidth(String(value).normalize('NFKC'));
}

function normalizeDiscordTableText(value) {
  return String(value).normalize('NFKC');
}

function padEndByDiscordTextWidth(value, targetWidth) {
  const text = String(value);
  const padding = Math.max(0, targetWidth - getDiscordTextWidth(text));
  return text + ' '.repeat(padding);
}

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  logError('Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in .env');
  process.exit(1);
}

process.on('unhandledRejection', (reason) => {
  logError(`Unhandled promise rejection: ${reason?.stack || reason?.message || reason}`);
});

const {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

const KNOWN_COMMANDS = ['info', 'perk', 'vipinfo', 'overdrives', 'rank', 'rankings', 'example', 'help'];
const FORMAT_RESPONSE_ERROR_MESSAGE = 'Oh-oh: something went wrong with response from KF2 server. Please use "raw" option for detailed response.';
const NO_DIFFICULTY_VALUE = '__no_active_difficulties__';
const DISCORD_MESSAGE_MAX_LENGTH = 2000;
const DISCORD_ZERO_WIDTH_SPACE = '\u200B';
const MONTHLY_RANKING_REWARD_CHUNK_PREFIX = `${DISCORD_ZERO_WIDTH_SPACE}\n`;
const DIFFICULTY_ORDER = ['normal', 'hard', 'suicidal', 'hoe', 'extreme'];
const RANK_DISPLAY_ORDER = [
  { key: 'normal', label: 'Normal' },
  { key: 'hard', label: 'Hard' },
  { key: 'suicidal', label: 'Suicidal' },
  { key: 'hoe', label: 'HoE' },
  { key: 'extreme', label: 'Extreme' },
];

function withSuppressedEmbeds(options) {
  const messageOptions = typeof options === 'string'
    ? { content: options }
    : { ...options };
  messageOptions.flags = (messageOptions.flags || 0) | MessageFlags.SuppressEmbeds;
  return messageOptions;
}

function splitDiscordMessage(content, maxLength = DISCORD_MESSAGE_MAX_LENGTH) {
  const chunks = [];
  let currentChunk = '';

  for (const line of String(content).split('\n')) {
    if (line.length > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = '';
      }

      for (let index = 0; index < line.length; index += maxLength) {
        chunks.push(line.slice(index, index + maxLength));
      }
      continue;
    }

    const nextLine = currentChunk ? `\n${line}` : line;
    if (currentChunk && currentChunk.length + nextLine.length > maxLength) {
      chunks.push(currentChunk);
      currentChunk = line;
      continue;
    }

    currentChunk += nextLine;
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function splitDiscordMessageOptions(options, maxLength = DISCORD_MESSAGE_MAX_LENGTH) {
  const messageOptions = withSuppressedEmbeds(options);

  if (typeof messageOptions.content !== 'string' || messageOptions.content.length <= maxLength) {
    return [messageOptions];
  }

  return splitDiscordMessage(messageOptions.content, maxLength)
    .map((content) => ({
      ...messageOptions,
      content,
    }));
}

function withInteractionFollowUpVisibility(interaction, options) {
  if (!interaction.ephemeral || ((options.flags || 0) & MessageFlags.Ephemeral)) {
    return options;
  }

  return {
    ...options,
    flags: (options.flags || 0) | MessageFlags.Ephemeral,
  };
}

async function sendDiscordMessage(channel, options) {
  const messages = [];

  for (const messageOptions of splitDiscordMessageOptions(options)) {
    messages.push(await channel.send(messageOptions));
  }

  return messages[0] || null;
}

function editDiscordMessage(message, options) {
  return message.edit(withSuppressedEmbeds(options));
}

function getDiscordErrorStatus(error) {
  const status = Number.parseInt(error?.status || error?.httpStatus, 10);
  return Number.isInteger(status) ? status : null;
}

function isRetriableDiscordError(error) {
  const status = getDiscordErrorStatus(error);

  if (status === null) {
    return true;
  }

  return status === 429 || status >= 500;
}

async function replyDiscordInteraction(interaction, options) {
  const [firstOptions, ...followUpOptions] = splitDiscordMessageOptions(options);
  const response = await interaction.reply(firstOptions);

  for (const followUpOptionsItem of followUpOptions) {
    await interaction.followUp(withInteractionFollowUpVisibility(interaction, followUpOptionsItem));
  }

  return response;
}

async function editDiscordReply(interaction, options) {
  const [firstOptions, ...followUpOptions] = splitDiscordMessageOptions(options);
  const response = await interaction.editReply(firstOptions);

  for (const followUpOptionsItem of followUpOptions) {
    await interaction.followUp(withInteractionFollowUpVisibility(interaction, followUpOptionsItem));
  }

  return response;
}

async function followUpDiscordInteraction(interaction, options) {
  const responses = [];

  for (const messageOptions of splitDiscordMessageOptions(options)) {
    responses.push(await interaction.followUp(withInteractionFollowUpVisibility(interaction, messageOptions)));
  }

  return responses[0] || null;
}

function deferDiscordReply(interaction, options) {
  return interaction.deferReply(withSuppressedEmbeds(options));
}

const PERK_DISPLAY_ORDER = [
  { key: 'berserker', label: 'Berserker', emojiName: 'KFZerker', aliases: ['berserker'] },
  { key: 'commando', label: 'Commando', emojiName: 'KFMando', aliases: ['commando'] },
  { key: 'fieldmedic', label: 'Medic', emojiName: 'KFMed', aliases: ['medic', 'field medic', 'fieldmedic'] },
  { key: 'support', label: 'Support', emojiName: 'KFSupp', aliases: ['support', 'support specialist', 'supportspecialist'] },
  { key: 'firebug', label: 'Firebug', emojiName: 'KFFB', aliases: ['firebug'] },
  { key: 'demolitionist', label: 'Demolitionist', emojiName: 'KFDemo', aliases: ['demolitionist', 'demolitionnist'] },
  { key: 'gunslinger', label: 'Gunslinger', emojiName: 'KFSlinger', aliases: ['gunslinger'] },
  { key: 'sharpshooter', label: 'Sharpshooter', emojiName: 'KFSharpy', aliases: ['sharpshooter'] },
  { key: 'swat', label: 'SWAT', emojiName: 'KFSWAT', aliases: ['swat'] },
  { key: 'engineer', label: 'Engineer', emojiName: 'KFEngy', aliases: ['engineer'] },
  { key: 'survivalist', label: 'Survivalist', emojiName: 'KFSurv', aliases: ['survivalist'] },
];
const OVERDRIVE_DISPLAY_ORDER = [
  { key: 'unstable', label: 'Unstable', emoji: '⬜', aliases: ['unstable'] },
  { key: 'balanced', label: 'Balanced', emoji: '🟩', aliases: ['balanced'] },
  { key: 'good', label: 'Good', emoji: '🟦', aliases: ['good'] },
  { key: 'special', label: 'Special', emoji: '🟪', aliases: ['special'] },
  { key: 'epic', label: 'Epic', emoji: '🟥', aliases: ['epic'] },
  { key: 'legendary', label: 'Legendary', emoji: '🟨', aliases: ['legendary'] },
];
let activeRelayMap = new Map();
let activeDifficulties = [];
const relayQueues = new Map();
const processingDifficulties = new Set();
const webhookSendQueues = new Map();
let webhookRetryQueue = [];
let webhookRetryTimer = null;
let webhookRetryProcessing = false;
const webhookRetryLoggedErrorKeys = new Set();
let webhookRetryQueuePaused = false;
let discordMessageRetryQueue = [];
let discordMessageRetryTimer = null;
let discordMessageRetryProcessing = false;
let discordMessageRetryQueuePaused = false;
const discordMessageRetryLoggedErrorKeys = new Set();
const kf2Connections = [];
const activeVotes = new Map();
let envReloadTimer = null;
let commandTokenState = new Map();
let commandTokenResetTimer = null;
let commandTokenRestartAnchorMs = Date.now();
let envFileSnapshot = null;

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseInteger(value, defaultValue) {
  const parsedValue = Number.parseInt(value || String(defaultValue), 10);
  return Number.isInteger(parsedValue) ? parsedValue : defaultValue;
}

function parsePositiveInteger(value, defaultValue) {
  const parsedValue = parseInteger(value, defaultValue);
  return parsedValue > 0 ? parsedValue : defaultValue;
}

function parseNonNegativeInteger(value, defaultValue) {
  const parsedValue = parseInteger(value, defaultValue);
  return parsedValue >= 0 ? parsedValue : defaultValue;
}

function parsePercent(value, defaultValue) {
  const parsedValue = parseInteger(value, defaultValue);
  if (!Number.isInteger(parsedValue)) {
    return defaultValue;
  }

  return Math.min(100, Math.max(0, parsedValue));
}

function secondsToMilliseconds(seconds) {
  return seconds * MILLISECONDS_PER_SECOND;
}

function parseSecondsToMilliseconds(value, defaultSeconds) {
  return secondsToMilliseconds(parsePositiveInteger(value, defaultSeconds));
}

function minutesToMilliseconds(minutes) {
  return secondsToMilliseconds(minutes * SECONDS_PER_MINUTE);
}

function parseMinutesToMilliseconds(value, defaultMinutes) {
  return minutesToMilliseconds(parseNonNegativeInteger(value, defaultMinutes));
}

function parseRoleIds(value) {
  return (value || '')
    .split(',')
    .map((roleId) => roleId.trim())
    .filter(Boolean);
}

function parseChannelIds(value) {
  return (value || '')
    .split(',')
    .map((channelId) => channelId.trim())
    .filter(Boolean);
}

function parseChoice(value, choices, defaultValue) {
  const normalizedValue = String(value || defaultValue).trim().toLowerCase();
  return choices.includes(normalizedValue) ? normalizedValue : defaultValue;
}

function loadRuntimeConfig(env = process.env) {
  return {
    cdaAvatarUrl: env.CDA_AVATAR_URL || '',
    kf2ReconnectDelayMs: parseSecondsToMilliseconds(env.KF2_RECONNECT_DELAY_SECONDS, 30),
    kf2ConnectTimeoutMs: parseSecondsToMilliseconds(env.KF2_CONNECT_TIMEOUT_SECONDS, 5),
    kf2RequestTimeoutMs: parseSecondsToMilliseconds(env.KF2_REQUEST_TIMEOUT_SECONDS, 60),
    kf2KickVoteDiscordChannelIds: parseChannelIds(env.KF2_KICK_VOTE_DISCORD_CHANNEL_IDS),
    kf2PauseSkipVoteDiscordChannelIds: parseChannelIds(env.KF2_PAUSE_SKIP_VOTE_DISCORD_CHANNEL_IDS),
    kf2MonthlyRewardDiscordChannelIds: parseChannelIds(env.KF2_MONTHLY_REWARD_DISCORD_CHANNEL_IDS),
    kf2VoteTimeoutMs: parseSecondsToMilliseconds(env.KF2_VOTE_TIMEOUT_SECONDS, 30),
    kf2KickVotePassPercent: parsePercent(env.KF2_KICK_VOTE_PASS_PERCENT, 66),
    kf2PauseVotePassPercent: parsePercent(env.KF2_PAUSE_VOTE_PASS_PERCENT, 66),
    kf2SkipVotePassPercent: parsePercent(env.KF2_SKIP_VOTE_PASS_PERCENT, 100),
    kf2ConsoleLogsEnabled: parseBoolean(env.KF2_CONSOLE_LOGS_ENABLED, false),
    discordWebhookRateLimitRetryLimit: parsePositiveInteger(env.DISCORD_WEBHOOK_RATE_LIMIT_RETRY_LIMIT, 5),
    discordWebhookRetryIntervalMs: parseSecondsToMilliseconds(env.DISCORD_WEBHOOK_RETRY_INTERVAL_SECONDS, 30),
    discordRetryQueueMaxAgeMs: parseMinutesToMilliseconds(env.DISCORD_RETRY_QUEUE_MAX_AGE_MINUTES, 60),
    specialAccessRoleIds: parseRoleIds(env.SPECIAL_ACCESS_ROLE_IDS),
    commandPublicTokenLimit: parsePositiveInteger(env.COMMAND_PUBLIC_TOKEN_LIMIT, 5),
    commandPrivateTokenLimit: parsePositiveInteger(env.COMMAND_PRIVATE_TOKEN_LIMIT, 10),
    commandTokenResetSeconds: parsePositiveInteger(env.COMMAND_TOKEN_RESET_SECONDS, 600),
    commandTokenResetAnchor: parseChoice(env.COMMAND_TOKEN_RESET_ANCHOR, ['restart', 'day'], 'day'),
    commandCooldownRoleMode: parseChoice(env.COMMAND_COOLDOWN_ROLE_MODE, ['blacklist', 'whitelist'], 'blacklist'),
    commandCooldownRoleIds: parseRoleIds(env.COMMAND_COOLDOWN_ROLE_IDS),
  };
}

function applyRuntimeConfig(config) {
  CDA_AVATAR_URL = config.cdaAvatarUrl;
  KF2_RECONNECT_DELAY_MS = config.kf2ReconnectDelayMs;
  KF2_CONNECT_TIMEOUT_MS = config.kf2ConnectTimeoutMs;
  KF2_REQUEST_TIMEOUT_MS = config.kf2RequestTimeoutMs;
  KF2_KICK_VOTE_DISCORD_CHANNEL_IDS = config.kf2KickVoteDiscordChannelIds;
  KF2_PAUSE_SKIP_VOTE_DISCORD_CHANNEL_IDS = config.kf2PauseSkipVoteDiscordChannelIds;
  KF2_MONTHLY_REWARD_DISCORD_CHANNEL_IDS = config.kf2MonthlyRewardDiscordChannelIds;
  KF2_VOTE_TIMEOUT_MS = config.kf2VoteTimeoutMs;
  KF2_KICK_VOTE_PASS_PERCENT = config.kf2KickVotePassPercent;
  KF2_PAUSE_VOTE_PASS_PERCENT = config.kf2PauseVotePassPercent;
  KF2_SKIP_VOTE_PASS_PERCENT = config.kf2SkipVotePassPercent;
  KF2_CONSOLE_LOGS_ENABLED = config.kf2ConsoleLogsEnabled;
  DISCORD_WEBHOOK_RATE_LIMIT_RETRY_LIMIT = config.discordWebhookRateLimitRetryLimit;
  DISCORD_WEBHOOK_RETRY_INTERVAL_MS = config.discordWebhookRetryIntervalMs;
  DISCORD_RETRY_QUEUE_MAX_AGE_MS = config.discordRetryQueueMaxAgeMs;
  SPECIAL_ACCESS_ROLE_IDS = config.specialAccessRoleIds;
  COMMAND_PUBLIC_TOKEN_LIMIT = config.commandPublicTokenLimit;
  COMMAND_PRIVATE_TOKEN_LIMIT = config.commandPrivateTokenLimit;
  COMMAND_TOKEN_RESET_SECONDS = config.commandTokenResetSeconds;
  COMMAND_TOKEN_RESET_ANCHOR = config.commandTokenResetAnchor;
  COMMAND_COOLDOWN_ROLE_MODE = config.commandCooldownRoleMode;
  COMMAND_COOLDOWN_ROLE_IDS = config.commandCooldownRoleIds;
  pruneCommandTokenState();
  saveCommandTokenState();
  scheduleCommandTokenReset();
  scheduleWebhookRetryQueue();
  scheduleDiscordMessageRetryQueue();
}

function isReloadableEnvKey(key) {
  return !isStartupOnlyEnvKey(key);
}

function isStartupOnlyEnvKey(key) {
  return [
    'DISCORD_TOKEN',
    'CLIENT_ID',
    'GUILD_ID',
    'STEAM_API_KEY',
  ].includes(key);
}

function getEnvSnapshot(env) {
  return Object.fromEntries(Object.entries(env));
}

function maskEnvValueForLog(value) {
  const text = String(value);
  if (text.length <= 8) {
    return '<set>';
  }

  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function formatEnvValueForLog(key, value) {
  if (value === undefined) {
    return '<unset>';
  }

  if (value === '') {
    return '<empty>';
  }

  if (isStartupOnlyEnvKey(key)) {
    return JSON.stringify(maskEnvValueForLog(value));
  }

  return JSON.stringify(String(value));
}

function logReloadedEnvChanges(previousSnapshot, nextSnapshot) {
  const keys = new Set([
    ...Object.keys(previousSnapshot || {}),
    ...Object.keys(nextSnapshot || {}),
  ]);
  const changedKeys = [...keys]
    .filter((key) => previousSnapshot?.[key] !== nextSnapshot?.[key])
    .sort((left, right) => left.localeCompare(right));

  if (changedKeys.length === 0) {
    logInfo(`Reloaded runtime config from ${ENV_FILE_PATH}; no settings changed.`);
    return;
  }

  logInfo(`Reloaded runtime config from ${ENV_FILE_PATH}; changed settings:`);

  for (const key of changedKeys) {
    const startupOnlyNote = isStartupOnlyEnvKey(key) ? ' (restart required; not applied)' : '';
    logInfo(
      `  ${key}${startupOnlyNote}: ${formatEnvValueForLog(key, previousSnapshot?.[key])} -> ${formatEnvValueForLog(key, nextSnapshot?.[key])}`,
    );
  }
}

function readEnvSnapshotFromFile() {
  if (!dotenv || !fs.existsSync(ENV_FILE_PATH)) {
    return {};
  }

  const parsedEnv = dotenv.parse(fs.readFileSync(ENV_FILE_PATH, 'utf8'));
  return getEnvSnapshot(parsedEnv);
}

function readServerConfig(index, env = process.env) {
  const prefix = `KF2_SERVER_${index}_`;
  const enabled = parseBoolean(env[`${prefix}ENABLED`], false);
  const port = Number.parseInt(env[`${prefix}PORT`] || '', 10);
  const difficulty = (env[`${prefix}DIFFICULTY`] || '').trim();
  const name = (env[`${prefix}NAME`] || difficulty || `server-${index}`).trim();

  if (!enabled) {
    return null;
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${prefix}PORT must be a valid TCP port when ${prefix}ENABLED=true.`);
  }

  if (!difficulty) {
    throw new Error(`${prefix}DIFFICULTY is required when ${prefix}ENABLED=true.`);
  }

  return {
    index,
    name,
    difficulty,
    host: env[`${prefix}HOST`] || '127.0.0.1',
    port,
    channelIds: parseChannelIds(env[`${prefix}DISCORD_CHANNEL_IDS`]),
    kickVoteChannelIds: parseChannelIds(env[`${prefix}KICK_VOTE_DISCORD_CHANNEL_IDS`]),
    pauseSkipVoteChannelIds: parseChannelIds(env[`${prefix}PAUSE_SKIP_VOTE_DISCORD_CHANNEL_IDS`]),
    webhookUrl: (env[`${prefix}WEBHOOK_URL`] || '').trim(),
    forwardKf2ToDiscord: parseBoolean(env[`${prefix}FORWARD_KF2_TO_DISCORD`], true),
    forwardDiscordToKf2: parseBoolean(env[`${prefix}FORWARD_DISCORD_TO_KF2`], true),
    commandsEnabled: parseBoolean(env[`${prefix}COMMANDS_ENABLED`], true),
  };
}

function loadServerConfigs(env = process.env) {
  const configs = [];

  for (let index = 1; index <= KF2_SERVER_COUNT; index += 1) {
    const config = readServerConfig(index, env);
    if (config) {
      configs.push(config);
    }
  }

  const duplicateDifficulty = configs.find((config, index) =>
    configs.some((otherConfig, otherIndex) =>
      otherIndex !== index && otherConfig.difficulty === config.difficulty,
    ),
  );
  if (duplicateDifficulty) {
    throw new Error(`Duplicate KF2 difficulty "${duplicateDifficulty.difficulty}". Each enabled server needs a unique difficulty.`);
  }

  return configs;
}

function removeConnection(connection) {
  const connectionIndex = kf2Connections.indexOf(connection);
  if (connectionIndex !== -1) {
    kf2Connections.splice(connectionIndex, 1);
  }

  connection.stop();
}

function requiresSocketRestart(currentConfig, nextConfig) {
  return currentConfig.host !== nextConfig.host
    || currentConfig.port !== nextConfig.port;
}

function applyServerConfigs(serverConfigs) {
  const nextConfigByIndex = new Map(serverConfigs.map((config) => [config.index, config]));

  for (const connection of [...kf2Connections]) {
    const nextConfig = nextConfigByIndex.get(connection.config.index);

    if (!nextConfig) {
      logInfo(`Disabling KF2 server "${connection.config.name}".`);
      removeConnection(connection);
      continue;
    }

    if (requiresSocketRestart(connection.config, nextConfig)) {
      logInfo(`Restarting KF2 server "${nextConfig.name}" connection because host or port changed.`);
      removeConnection(connection);

      const nextConnection = new Kf2Connection(nextConfig);
      kf2Connections.push(nextConnection);
      nextConnection.start();
      continue;
    }

    connection.config = nextConfig;
    logInfo(
      `Updated KF2 server "${nextConfig.name}" settings; `
      + `KF2->Discord=${nextConfig.forwardKf2ToDiscord ? 'on' : 'off'}, `
      + `Discord->KF2=${nextConfig.forwardDiscordToKf2 ? 'on' : 'off'}, `
      + `commands=${nextConfig.commandsEnabled ? 'on' : 'off'}`,
    );
  }

  const existingIndexes = new Set(kf2Connections.map((connection) => connection.config.index));

  for (const config of serverConfigs) {
    if (existingIndexes.has(config.index)) {
      continue;
    }

    const connection = new Kf2Connection(config);
    kf2Connections.push(connection);
    connection.start();

    logInfo(
      `Configured KF2 server "${config.name}" (${config.difficulty}) at ${config.host}:${config.port}; `
      + `KF2->Discord=${config.forwardKf2ToDiscord ? 'on' : 'off'}, `
      + `Discord->KF2=${config.forwardDiscordToKf2 ? 'on' : 'off'}, `
      + `commands=${config.commandsEnabled ? 'on' : 'off'}`,
    );
  }

  refreshActiveRelays();
}

function readEnvFileForRuntimeConfigs() {
  if (!dotenv) {
    throw new Error('dotenv is required for live .env reloads.');
  }

  const rawEnv = fs.readFileSync(ENV_FILE_PATH, 'utf8');
  const parsedEnv = dotenv.parse(rawEnv);
  const configEnv = { ...process.env };

  for (const key of Object.keys(configEnv)) {
    if (isReloadableEnvKey(key)) {
      delete configEnv[key];
    }
  }

  for (const key of Object.keys(parsedEnv)) {
    if (!isReloadableEnvKey(key)) {
      delete parsedEnv[key];
    }
  }

  return {
    ...configEnv,
    ...parsedEnv,
  };
}

function reloadRuntimeConfigsFromEnvFile() {
  try {
    const nextEnvFileSnapshot = readEnvSnapshotFromFile();
    const env = readEnvFileForRuntimeConfigs();
    applyRuntimeConfig(loadRuntimeConfig(env));
    const serverConfigs = loadServerConfigs(env);
    applyServerConfigs(serverConfigs);
    logReloadedEnvChanges(envFileSnapshot, nextEnvFileSnapshot);
    envFileSnapshot = nextEnvFileSnapshot;
  } catch (error) {
    logError(`Failed to reload runtime config: ${error.message || error}`);
  }
}

function watchEnvFileForServerConfigChanges() {
  if (!fs.existsSync(ENV_FILE_PATH)) {
    logWarn(`Cannot watch ${ENV_FILE_PATH}; file does not exist.`);
    return;
  }

  try {
    fs.watch(ENV_FILE_PATH, () => {
      if (envReloadTimer) {
        clearTimeout(envReloadTimer);
      }

      envReloadTimer = setTimeout(() => {
        envReloadTimer = null;
        reloadRuntimeConfigsFromEnvFile();
      }, 500);
    });
  } catch (error) {
    logWarn(`Cannot watch ${ENV_FILE_PATH}: ${error.message || error}`);
    return;
  }

  logInfo(`Watching ${ENV_FILE_PATH} for KF2 server config changes.`);
}

function addDifficultyOption(commandBuilder) {
  return addDifficultyOptionWithRequired(commandBuilder, true);
}

function addHiddenOption(commandBuilder) {
  return commandBuilder.addBooleanOption((option) =>
    option
      .setName('hidden')
      .setDescription('If true, only you will see the response')
      .setRequired(false),
  );
}

function addRawOption(commandBuilder) {
  return commandBuilder.addBooleanOption((option) =>
    option
      .setName('raw')
      .setDescription('Post the raw KF2 response without formatting (restricted by role)')
      .setRequired(false),
  );
}

function addTargetOption(commandBuilder) {
  return commandBuilder.addStringOption((option) =>
    option
      .setName('target')
      .setDescription('Nickname, SteamID64 or Steam profile link')
      .setRequired(true),
  );
}

function addDifficultyOptionWithRequired(commandBuilder, required) {
  return commandBuilder.addStringOption((option) =>
    option
      .setName('difficulty')
      .setDescription('Difficulty from connected KF2 servers.')
      .setRequired(required)
      .setAutocomplete(true),
  );
}

function canUseRawOption(interaction) {
  return hasAnyAllowedRole(interaction, SPECIAL_ACCESS_ROLE_IDS);
}

function hasAnyAllowedRole(interaction, allowedRoleIds) {
  if (allowedRoleIds.length === 0) {
    return false;
  }

  const memberRoles = interaction.member?.roles;
  if (!memberRoles) {
    return false;
  }

  if (memberRoles.cache) {
    return allowedRoleIds.some((roleId) => memberRoles.cache.has(roleId));
  }

  if (Array.isArray(memberRoles)) {
    return allowedRoleIds.some((roleId) => memberRoles.includes(roleId));
  }

  return false;
}

function getCommandTokenPeriodMs() {
  return secondsToMilliseconds(COMMAND_TOKEN_RESET_SECONDS);
}

function getLocalDayStartMs(nowMs = Date.now()) {
  const now = new Date(nowMs);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function getCommandTokenWindowStartMs(nowMs = Date.now()) {
  const periodMs = getCommandTokenPeriodMs();
  const anchorMs = COMMAND_TOKEN_RESET_ANCHOR === 'day'
    ? getLocalDayStartMs(nowMs)
    : commandTokenRestartAnchorMs;

  if (nowMs <= anchorMs) {
    return anchorMs;
  }

  return anchorMs + Math.floor((nowMs - anchorMs) / periodMs) * periodMs;
}

function getNextCommandTokenResetMs(nowMs = Date.now()) {
  return getCommandTokenWindowStartMs(nowMs) + getCommandTokenPeriodMs();
}

function formatDurationUntilReset(durationMs) {
  let remainingSeconds = Math.max(1, Math.ceil(durationMs / MILLISECONDS_PER_SECOND));
  const days = Math.floor(remainingSeconds / 86400);
  remainingSeconds %= 86400;
  const hours = Math.floor(remainingSeconds / 3600);
  remainingSeconds %= 3600;
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  const parts = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0 || parts.length > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || parts.length > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);

  return parts.join('');
}

function getCommandTokenLimitMessage(nowMs = Date.now()) {
  const waitTime = formatDurationUntilReset(getNextCommandTokenResetMs(nowMs) - nowMs);
  return `You reached command use limit. Please wait ${waitTime} until you can use commands again.`;
}

function normalizeTokenRecord(record, currentWindowStartMs) {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const userId = String(record.userId || '').trim();
  const timestampMs = Number.parseInt(record.epochTimestampMs ?? record.timestampMs, 10);

  if (!userId || !Number.isFinite(timestampMs) || timestampMs < currentWindowStartMs) {
    return null;
  }

  return {
    userId,
    username: String(record.username || 'Unknown'),
    timestampMs,
    publicSpent: Math.max(0, Number.parseInt(record.publicSpent, 10) || 0),
    privateSpent: Math.max(0, Number.parseInt(record.privateSpent, 10) || 0),
  };
}

function loadCommandTokenState() {
  const currentWindowStartMs = getCommandTokenWindowStartMs();
  commandTokenState = new Map();

  if (!fs.existsSync(USER_TOKENS_FILE_PATH)) {
    return;
  }

  try {
    const rawState = fs.readFileSync(USER_TOKENS_FILE_PATH, 'utf8').trim();
    const parsedState = rawState ? JSON.parse(rawState) : {};
    const records = Array.isArray(parsedState)
      ? parsedState
      : Array.isArray(parsedState.users) ? parsedState.users : [];

    for (const record of records) {
      const normalizedRecord = normalizeTokenRecord(record, currentWindowStartMs);
      if (normalizedRecord) {
        commandTokenState.set(normalizedRecord.userId, normalizedRecord);
      }
    }
  } catch (error) {
    logWarn(`Failed to load ${USER_TOKENS_FILE_PATH}; starting with empty command token state: ${error.message || error}`);
    commandTokenState = new Map();
  }

  saveCommandTokenState();
}

function saveCommandTokenState() {
  const users = [...commandTokenState.values()]
    .sort((left, right) => left.userId.localeCompare(right.userId))
    .map((record) => ({
      userId: record.userId,
      username: record.username,
      epochTimestampMs: record.timestampMs,
      publicSpent: record.publicSpent,
      privateSpent: record.privateSpent,
    }));

  if (users.length === 0 && !fs.existsSync(USER_TOKENS_FILE_PATH)) {
    return;
  }

  fs.writeFileSync(
    USER_TOKENS_FILE_PATH,
    `${JSON.stringify({ users }, null, 2)}\n`,
    'utf8',
  );
}

function pruneCommandTokenState() {
  const currentWindowStartMs = getCommandTokenWindowStartMs();

  for (const [userId, record] of commandTokenState.entries()) {
    if (!normalizeTokenRecord(record, currentWindowStartMs)) {
      commandTokenState.delete(userId);
    }
  }
}

function resetCommandTokenState() {
  commandTokenState.clear();
  saveCommandTokenState();
}

function scheduleCommandTokenReset() {
  if (commandTokenResetTimer) {
    clearTimeout(commandTokenResetTimer);
  }

  const delayMs = Math.max(MILLISECONDS_PER_SECOND, getNextCommandTokenResetMs() - Date.now());
  commandTokenResetTimer = setTimeout(() => {
    resetCommandTokenState();
    scheduleCommandTokenReset();
  }, delayMs);
}

function getCommandTokenUsername(interaction) {
  const displayName = getMemberNickname(interaction);
  const username = interaction.user?.tag || interaction.user?.username || displayName;
  return displayName && displayName !== username ? `${displayName} (${username})` : username;
}

function isCommandCooldownEnabledForMember(interaction) {
  const hasConfiguredRole = hasAnyAllowedRole(interaction, COMMAND_COOLDOWN_ROLE_IDS);

  if (COMMAND_COOLDOWN_ROLE_MODE === 'whitelist') {
    return hasConfiguredRole;
  }

  return !hasConfiguredRole;
}

function resolveCommandTokenResult(interaction, requestedHidden, consume) {
  if (!isCommandCooldownEnabledForMember(interaction)) {
    return {
      allowed: true,
      hidden: requestedHidden,
    };
  }

  pruneCommandTokenState();

  const userId = interaction.user?.id;
  if (!userId) {
    return {
      allowed: false,
      message: getCommandTokenLimitMessage(),
    };
  }

  const currentWindowStartMs = getCommandTokenWindowStartMs();
  const record = commandTokenState.get(userId) || {
    userId,
    username: getCommandTokenUsername(interaction),
    timestampMs: currentWindowStartMs,
    publicSpent: 0,
    privateSpent: 0,
  };

  record.username = getCommandTokenUsername(interaction);
  record.timestampMs = currentWindowStartMs;

  let tokenType = requestedHidden ? 'private' : 'public';
  let hidden = requestedHidden;

  if (tokenType === 'public' && record.publicSpent >= COMMAND_PUBLIC_TOKEN_LIMIT) {
    tokenType = 'private';
    hidden = true;
  }

  const spentKey = tokenType === 'public' ? 'publicSpent' : 'privateSpent';
  const limit = tokenType === 'public' ? COMMAND_PUBLIC_TOKEN_LIMIT : COMMAND_PRIVATE_TOKEN_LIMIT;

  if (record[spentKey] >= limit) {
    return {
      allowed: false,
      message: getCommandTokenLimitMessage(),
    };
  }

  if (!consume) {
    return {
      allowed: true,
      hidden,
    };
  }

  record[spentKey] += 1;
  commandTokenState.set(userId, record);
  saveCommandTokenState();

  return {
    allowed: true,
    hidden,
  };
}

function checkCommandTokenAvailability(interaction, requestedHidden) {
  return resolveCommandTokenResult(interaction, requestedHidden, false);
}

function consumeCommandToken(interaction, requestedHidden) {
  return resolveCommandTokenResult(interaction, requestedHidden, true);
}

function buildHelpMessage() {
  return [
    '**Commands**',
    '`/info` - Show current status of a selected KF2 server (current map, xp, players etc).',
    '`/perk` - Show perk levels for a target player.',
    '`/vipinfo` - Show VIP status for a target player.',
    '`/overdrives` - Show overdrives information for a target player.',
    '`/rank` - Show rank information for a target player (rank for each server difficulty).',
    '`/rankings` - Show server rankings for a selected difficulty (first 10 players).',
    '`/example` - Preview formatted output from a response payload without using a KF2 server. Not available for public use (devs only).',
    '',
    '**Shared Options**',
    '`target` - Nickname, SteamID64, or Steam profile link. Used by `/perk`, `/vipinfo`, `/overdrives`, and `/rank`.',
    '`difficulty` - Shows currently online KF2 servers. Used by `/info` and `/rankings`.',
    '`hidden` - If true, only you will see the response. By default is false. Available for every command.',
    '`raw` - Post the raw KF2 response without formatting. Not available for public use (devs only).',
  ].join('\n');
}

function resolveRawOption(interaction) {
  const rawRequested = interaction.options.getBoolean('raw') || false;
  if (!rawRequested) {
    return false;
  }

  if (!canUseRawOption(interaction)) {
    const error = new Error('You are not allowed to use the raw response option.');
    error.suppressConsoleLog = true;
    throw error;
  }

  return true;
}

function ensureExampleAccess(interaction) {
  if (hasAnyAllowedRole(interaction, SPECIAL_ACCESS_ROLE_IDS)) {
    return;
  }

  const error = new Error('You are not allowed to use the /example command.');
  error.suppressConsoleLog = true;
  throw error;
}

const commandDefinitions = [
  addRawOption(addHiddenOption(addDifficultyOption(
    new SlashCommandBuilder()
      .setName('info')
      .setDescription('Send a server info request to the matching KF2 server'),
  ))),
  addRawOption(addHiddenOption(
    addTargetOption(new SlashCommandBuilder()
      .setName('perk')
      .setDescription('Send a perk request to the first connected KF2 server')),
  )),
  addRawOption(addHiddenOption(addTargetOption(new SlashCommandBuilder()
    .setName('vipinfo')
    .setDescription('Send a VIP info request to the first connected KF2 server')))),
  addRawOption(addHiddenOption(addTargetOption(new SlashCommandBuilder()
    .setName('overdrives')
    .setDescription('Send an overdrives request to the first connected KF2 server')))),
  addRawOption(addHiddenOption(addTargetOption(
    new SlashCommandBuilder()
      .setName('rank')
      .setDescription('Send a player rank request to the first connected KF2 server'),
  ))),
  addRawOption(addHiddenOption(addDifficultyOption(
    new SlashCommandBuilder()
      .setName('rankings')
      .setDescription('Send a server rankings request to the matching KF2 server'),
  ))),
  addRawOption(addHiddenOption(
    new SlashCommandBuilder()
      .setName('example')
      .setDescription('Preview a response payload without using a KF2 server')
      .addStringOption((option) =>
        option
          .setName('command')
          .setDescription('Command type to mimic when formatting the response')
          .setRequired(true)
          .addChoices(
            { name: 'info', value: 'info' },
            { name: 'perk', value: 'perk' },
            { name: 'vipinfo', value: 'vipinfo' },
            { name: 'overdrives', value: 'overdrives' },
            { name: 'rank', value: 'rank' },
            { name: 'rankings', value: 'rankings' },
            { name: 'month-ranking-rewards', value: 'month-ranking-rewards' },
            { name: 'target', value: 'target' },
            { name: 'vote', value: 'vote' },
          ),
      )
      .addStringOption((option) =>
        option
          .setName('response')
          .setDescription('Text to treat as the KF2 response payload')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('difficulty')
          .setDescription('Difficulty to mimic for commands like /rank, /info, or vote')
          .setRequired(false)
          .addChoices(
            { name: 'Normal', value: 'normal' },
            { name: 'Hard', value: 'hard' },
            { name: 'Suicidal', value: 'suicidal' },
            { name: 'HoE', value: 'hoe' },
            { name: 'Extreme', value: 'extreme' },
          ),
      )
      .addStringOption((option) =>
        option
          .setName('target')
          .setDescription('SteamID64, Steam profile link, or nickname to show in formatted examples')
          .setRequired(false),
      ),
  )),
  addHiddenOption(new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show descriptions of bot commands and their options')),
];

function getMemberNickname(interaction) {
  if (interaction.member && 'displayName' in interaction.member) {
    return interaction.member.displayName;
  }

  return interaction.user.globalName || interaction.user.username;
}

function sortDifficulties(difficulties) {
  const orderedKnown = [];
  const unknown = [];

  for (const difficulty of difficulties) {
    if (DIFFICULTY_ORDER.includes(difficulty)) {
      orderedKnown.push(difficulty);
    } else {
      unknown.push(difficulty);
    }
  }

  orderedKnown.sort(
    (left, right) => DIFFICULTY_ORDER.indexOf(left) - DIFFICULTY_ORDER.indexOf(right),
  );
  unknown.sort((left, right) => left.localeCompare(right));

  return [...orderedKnown, ...unknown];
}

function refreshActiveRelays() {
  const relays = kf2Connections
    .filter((connection) => connection.config.commandsEnabled && connection.isConnected())
    .map((connection) => ({
      difficulty: connection.config.difficulty,
      name: connection.config.name,
      host: connection.config.host,
      port: connection.config.port,
      connection,
    }));
  const orderedDifficulties = sortDifficulties(relays.map((relay) => relay.difficulty));

  activeRelayMap = new Map(
    relays.map((relay) => [
      relay.difficulty,
      relay,
    ]),
  );
  activeDifficulties = orderedDifficulties;
}

function getActiveDifficulties() {
  return activeDifficulties;
}

function getRelayByDifficulty(difficulty) {
  return activeRelayMap.get(difficulty) || null;
}

function getDefaultRelay() {
  const defaultDifficulty = getActiveDifficulties()[0];
  if (!defaultDifficulty) {
    return null;
  }

  return getRelayByDifficulty(defaultDifficulty);
}

function ensureValidDifficulty(difficulty) {
  if (!difficulty || difficulty === NO_DIFFICULTY_VALUE) {
    return false;
  }

  return activeRelayMap.has(difficulty);
}

function getRelayQueue(difficulty) {
  if (!relayQueues.has(difficulty)) {
    relayQueues.set(difficulty, []);
  }

  return relayQueues.get(difficulty);
}

function unicodeConvert(message) {
  return message
    .split('/')
    .map((value) => {
      const codePoint = Number.parseInt(value, 10);
      if (!Number.isInteger(codePoint)) {
        throw new Error(`Invalid character code "${value}"`);
      }

      return String.fromCharCode(codePoint);
    })
    .join('');
}

function parseKf2ChatPayload(message, config) {
  const parts = message.split('^$');
  if (parts.length < 3) {
    throw new Error(`Unexpected KF2 payload: ${message}`);
  }

  if (parts[0] === 'CDC') {
    return {
      steamId: '1',
      username: parts[1],
      content: parts.slice(2).join('^$'),
      avatarUrl: CDA_AVATAR_URL,
      serverName: config.name,
    };
  }

  if (
    parts[0].trim().toLowerCase() === KF2_SERVER_MESSAGE_STEAM_ID.toLowerCase()
    && parts[1].trim().replace(/:$/, '').toLowerCase() === 'server'
  ) {
    return {
      steamId: '',
      username: parts[1],
      content: parts.slice(2).join('^$'),
      avatarUrl: CDA_AVATAR_URL,
      serverName: config.name,
    };
  }

  return {
    steamId: normalizeSteamId(parts[0]),
    username: parts[1],
    content: parts.slice(2).join('^$'),
    avatarUrl: '',
    serverName: config.name,
  };
}

function normalizeSteamId(rawSteamId) {
  const value = String(rawSteamId || '').trim();
  if (!value) {
    return '';
  }

  try {
    if (/^[+-]?0x[0-9a-f]+$/i.test(value)) {
      return BigInt(value).toString(10);
    }

    if (/^[+-]?\d+$/.test(value)) {
      return BigInt(value).toString(10);
    }
  } catch (error) {
    logWarn(`Could not normalize SteamID "${value}": ${error.message || error}`);
  }

  return value;
}

async function resolveSteamAvatarUrl(steamId, username) {
  if (!activeSteamApiKey || !steamId) {
    return '';
  }

  try {
    const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/');
    url.searchParams.set('key', activeSteamApiKey);
    url.searchParams.set('steamids', steamId);

    const response = await fetch(url);
    if (response.status === 401 || response.status === 403) {
      activeSteamApiKey = '';
      logWarn('STEAM_API_KEY was rejected by Steam API; Steam lookups are disabled until restart.');
      return '';
    }

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const avatarUrl = data?.response?.players?.[0]?.avatar || '';
    if (!avatarUrl) {
      logWarn(`Steam API returned no avatar for ${username} (${steamId}).`);
    }

    return avatarUrl;
  } catch (error) {
    logWarn(`Could not retrieve ${username}'s avatar: ${error.message || error}`);
    return '';
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function getWebhookErrorStatus(error) {
  const status = Number.parseInt(error?.status, 10);
  return Number.isInteger(status) ? status : null;
}

function isRetriableWebhookError(error) {
  const status = getWebhookErrorStatus(error);

  if (status === null) {
    return true;
  }

  return status === 429 || status >= 500;
}

function getWebhookErrorLogKey(error) {
  const status = getWebhookErrorStatus(error);
  if (status !== null) {
    return `${status}:${error?.statusText || ''}`;
  }

  return `network:${error?.message || String(error || '')}`;
}

function logWebhookQueueErrorOnce(error, buildMessage) {
  const errorKey = getWebhookErrorLogKey(error);

  if (webhookRetryLoggedErrorKeys.has(errorKey)) {
    return;
  }

  webhookRetryLoggedErrorKeys.add(errorKey);
  logWarn(buildMessage(error));
}

function createWebhookSendError(response, responseBody) {
  const error = new Error(`${response.status} ${response.statusText}${responseBody ? `: ${responseBody}` : ''}`);
  error.status = response.status;
  error.statusText = response.statusText;
  error.responseBody = responseBody;
  return error;
}

function isRetryEntryExpired(entry) {
  return DISCORD_RETRY_QUEUE_MAX_AGE_MS > 0
    && Date.now() - (entry.createdAtMs || Date.now()) >= DISCORD_RETRY_QUEUE_MAX_AGE_MS;
}

function formatRetryQueueMaxAgeMinutes() {
  return Math.ceil(DISCORD_RETRY_QUEUE_MAX_AGE_MS / minutesToMilliseconds(1));
}

function enqueueWebhookRetry(webhookUrl, payloads, options = {}) {
  if (webhookRetryQueuePaused) {
    return;
  }

  const nowMs = Date.now();
  const payloadList = Array.isArray(payloads) ? payloads : [payloads];
  const retryAfterMs = Math.max(0, Number.parseInt(options.retryAfterMs, 10) || 0);

  for (const payload of payloadList) {
    webhookRetryQueue.push({
      webhookUrl,
      payload,
      attempts: 0,
      createdAtMs: nowMs,
      nextAttemptMs: nowMs + retryAfterMs,
    });
  }

  scheduleWebhookRetryQueue();
}

function clearWebhookRetryQueueForMaxAge() {
  if (webhookRetryQueue.length === 0) {
    return false;
  }

  const droppedCount = webhookRetryQueue.length;
  webhookRetryQueue = [];
  webhookRetryQueuePaused = true;
  webhookRetryLoggedErrorKeys.clear();
  logWarn(
    `Dropped ${droppedCount} queued Discord webhook message(s) after `
    + `${formatRetryQueueMaxAgeMinutes()}m without successful webhook delivery. `
    + 'Webhook queueing will resume after webhook delivery succeeds again.',
  );
  return true;
}

function scheduleWebhookRetryQueue() {
  if (webhookRetryTimer) {
    clearTimeout(webhookRetryTimer);
    webhookRetryTimer = null;
  }

  if (webhookRetryQueue.length === 0) {
    webhookRetryLoggedErrorKeys.clear();
    return;
  }

  const nextAttemptMs = webhookRetryQueue[0].nextAttemptMs;
  const delayMs = Math.max(MILLISECONDS_PER_SECOND, nextAttemptMs - Date.now());

  webhookRetryTimer = setTimeout(() => {
    webhookRetryTimer = null;
    processWebhookRetryQueue().catch((error) => {
      logError(`Webhook retry queue worker failed: ${error.message || error}`);
      scheduleWebhookRetryQueue();
    });
  }, delayMs);
}

async function processWebhookRetryQueue() {
  if (webhookRetryProcessing) {
    return;
  }

  webhookRetryProcessing = true;

  try {
    let deliveredCount = 0;
    let deliveryAttemptCount = 0;

    while (webhookRetryQueue.length > 0 && webhookRetryQueue[0].nextAttemptMs <= Date.now()) {
      const entry = webhookRetryQueue[0];
      if (isRetryEntryExpired(entry) && clearWebhookRetryQueueForMaxAge()) {
        break;
      }

      try {
        await sendWebhookMessage(entry.webhookUrl, entry.payload, { queueOnFailure: false });
        webhookRetryQueue.shift();
        deliveredCount += 1;
        deliveryAttemptCount += entry.attempts + 1;
      } catch (error) {
        if (!isRetriableWebhookError(error)) {
          webhookRetryQueue.shift();
          logError(`Dropping queued Discord webhook message after permanent error: ${error.message || error}`);
          continue;
        }

        entry.attempts += 1;
        entry.nextAttemptMs = Date.now() + DISCORD_WEBHOOK_RETRY_INTERVAL_MS;
        logWebhookQueueErrorOnce(
          error,
          () => `Discord webhook retry queue is still blocked; will retry in `
            + `${Math.ceil(DISCORD_WEBHOOK_RETRY_INTERVAL_MS / MILLISECONDS_PER_SECOND)}s: ${error.message || error}`,
        );
        break;
      }
    }

    if (deliveredCount > 0) {
      logInfo(
        `Delivered ${deliveredCount} queued Discord webhook message(s) `
        + `after ${deliveryAttemptCount} total delivery attempt(s).`,
      );
    }
  } finally {
    webhookRetryProcessing = false;
    scheduleWebhookRetryQueue();
  }
}

function getDiscordMessageRetryErrorLogKey(error) {
  const status = getDiscordErrorStatus(error);
  if (status !== null) {
    return `${status}:${error?.message || ''}`;
  }

  return `network:${error?.message || String(error || '')}`;
}

function logDiscordMessageQueueErrorOnce(error, buildMessage) {
  const errorKey = getDiscordMessageRetryErrorLogKey(error);

  if (discordMessageRetryLoggedErrorKeys.has(errorKey)) {
    return;
  }

  discordMessageRetryLoggedErrorKeys.add(errorKey);
  logWarn(buildMessage(error));
}

function createQueuedDiscordMessage(entry) {
  return {
    queued: true,
    edit(nextOptions) {
      entry.optionsProvider = () => withSuppressedEmbeds(nextOptions);
      if (entry.message && typeof entry.message.edit === 'function') {
        return editDiscordMessage(entry.message, nextOptions);
      }

      return Promise.resolve(this);
    },
  };
}

function enqueueDiscordMessageRetry(entry) {
  if (discordMessageRetryQueuePaused) {
    return null;
  }

  const nowMs = Date.now();
  const queuedEntry = {
    ...entry,
    attempts: 0,
    createdAtMs: nowMs,
    nextAttemptMs: nowMs + Math.max(0, Number.parseInt(entry.retryAfterMs, 10) || 0),
  };

  if (queuedEntry.operation === 'send' && !queuedEntry.queuedMessage) {
    queuedEntry.queuedMessage = createQueuedDiscordMessage(queuedEntry);
  }

  discordMessageRetryQueue.push(queuedEntry);
  scheduleDiscordMessageRetryQueue();
  return queuedEntry;
}

function clearDiscordMessageRetryQueueForMaxAge() {
  if (discordMessageRetryQueue.length === 0) {
    return false;
  }

  const droppedCount = discordMessageRetryQueue.length;
  discordMessageRetryQueue = [];
  discordMessageRetryQueuePaused = true;
  discordMessageRetryLoggedErrorKeys.clear();
  logWarn(
    `Dropped ${droppedCount} queued Discord bot message operation(s) after `
    + `${formatRetryQueueMaxAgeMinutes()}m without successful Discord message delivery. `
    + 'Bot message queueing will resume after Discord message delivery succeeds again.',
  );
  return true;
}

function scheduleDiscordMessageRetryQueue() {
  if (discordMessageRetryTimer) {
    clearTimeout(discordMessageRetryTimer);
    discordMessageRetryTimer = null;
  }

  if (discordMessageRetryQueue.length === 0) {
    discordMessageRetryLoggedErrorKeys.clear();
    return;
  }

  const nextAttemptMs = discordMessageRetryQueue[0].nextAttemptMs;
  const delayMs = Math.max(MILLISECONDS_PER_SECOND, nextAttemptMs - Date.now());

  discordMessageRetryTimer = setTimeout(() => {
    discordMessageRetryTimer = null;
    processDiscordMessageRetryQueue().catch((error) => {
      logError(`Discord bot message retry queue worker failed: ${error.message || error}`);
      scheduleDiscordMessageRetryQueue();
    });
  }, delayMs);
}

async function runDiscordMessageRetryEntry(entry) {
  const options = entry.optionsProvider();

  if (entry.operation === 'send') {
    const channel = await client.channels.fetch(entry.channelId);
    if (!channel || typeof channel.send !== 'function') {
      const error = new Error(`Cannot find Discord channel ${entry.channelId}.`);
      error.status = 404;
      throw error;
    }

    entry.message = await sendDiscordMessage(channel, options);
    if (entry.queuedMessage) {
      entry.queuedMessage.message = entry.message;
    }
    discordMessageRetryQueuePaused = false;
    return;
  }

  if (entry.operation === 'edit') {
    await editDiscordMessage(entry.message, options);
    discordMessageRetryQueuePaused = false;
    return;
  }

  throw new Error(`Unknown Discord message retry operation "${entry.operation}".`);
}

async function processDiscordMessageRetryQueue() {
  if (discordMessageRetryProcessing) {
    return;
  }

  discordMessageRetryProcessing = true;

  try {
    let deliveredCount = 0;
    let deliveryAttemptCount = 0;

    while (discordMessageRetryQueue.length > 0 && discordMessageRetryQueue[0].nextAttemptMs <= Date.now()) {
      const entry = discordMessageRetryQueue[0];
      if (isRetryEntryExpired(entry) && clearDiscordMessageRetryQueueForMaxAge()) {
        break;
      }

      try {
        await runDiscordMessageRetryEntry(entry);
        discordMessageRetryQueue.shift();
        deliveredCount += 1;
        deliveryAttemptCount += entry.attempts + 1;
      } catch (error) {
        if (!isRetriableDiscordError(error)) {
          discordMessageRetryQueue.shift();
          logError(`Dropping queued Discord bot message operation after permanent error: ${error.message || error}`);
          continue;
        }

        entry.attempts += 1;
        entry.nextAttemptMs = Date.now() + DISCORD_WEBHOOK_RETRY_INTERVAL_MS;
        logDiscordMessageQueueErrorOnce(
          error,
          () => `Discord bot message retry queue is still blocked; will retry in `
            + `${Math.ceil(DISCORD_WEBHOOK_RETRY_INTERVAL_MS / MILLISECONDS_PER_SECOND)}s: ${error.message || error}`,
        );
        break;
      }
    }

    if (deliveredCount > 0) {
      logInfo(
        `Delivered ${deliveredCount} queued Discord bot message operation(s) `
        + `after ${deliveryAttemptCount} total delivery attempt(s).`,
      );
    }
  } finally {
    discordMessageRetryProcessing = false;
    scheduleDiscordMessageRetryQueue();
  }
}

async function sendDiscordMessageWithRetry(channelId, options, label) {
  if (!discordMessageRetryQueuePaused && discordMessageRetryQueue.length > 0) {
    const entry = enqueueDiscordMessageRetry({
      operation: 'send',
      channelId,
      optionsProvider: () => withSuppressedEmbeds(options),
      retryAfterMs: 0,
    });
    return entry?.queuedMessage || null;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || typeof channel.send !== 'function') {
      logWarn(`Cannot find Discord channel ${channelId}${label ? ` for ${label}` : ''}.`);
      return null;
    }

    const message = await sendDiscordMessage(channel, options);
    discordMessageRetryQueuePaused = false;
    return message;
  } catch (error) {
    if (isRetriableDiscordError(error) && !discordMessageRetryQueuePaused) {
      const entry = enqueueDiscordMessageRetry({
        operation: 'send',
        channelId,
        optionsProvider: () => withSuppressedEmbeds(options),
        retryAfterMs: DISCORD_WEBHOOK_RETRY_INTERVAL_MS,
      });
      logDiscordMessageQueueErrorOnce(
        error,
        () => `Discord bot message retry queue started${label ? ` for ${label}` : ''}: ${error.message || error}`,
      );
      return entry?.queuedMessage || null;
    }

    throw error;
  }
}

async function editDiscordMessageWithRetry(message, optionsProvider, label) {
  if (message?.queued && typeof message.edit === 'function') {
    return message.edit(optionsProvider());
  }

  if (!discordMessageRetryQueuePaused && discordMessageRetryQueue.length > 0) {
    enqueueDiscordMessageRetry({
      operation: 'edit',
      message,
      optionsProvider: () => withSuppressedEmbeds(optionsProvider()),
      retryAfterMs: 0,
    });
    return;
  }

  try {
    await editDiscordMessage(message, optionsProvider());
    discordMessageRetryQueuePaused = false;
  } catch (error) {
    if (isRetriableDiscordError(error) && !discordMessageRetryQueuePaused) {
      enqueueDiscordMessageRetry({
        operation: 'edit',
        message,
        optionsProvider: () => withSuppressedEmbeds(optionsProvider()),
        retryAfterMs: DISCORD_WEBHOOK_RETRY_INTERVAL_MS,
      });
      logDiscordMessageQueueErrorOnce(
        error,
        () => `Discord bot message edit retry queue started${label ? ` for ${label}` : ''}: ${error.message || error}`,
      );
      return;
    }

    throw error;
  }
}

function getDiscordRateLimitRetryMs(response, responseBody) {
  try {
    const parsedBody = responseBody ? JSON.parse(responseBody) : null;
    const retryAfterSeconds = Number.parseFloat(parsedBody?.retry_after);

    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      return Math.ceil(retryAfterSeconds * MILLISECONDS_PER_SECOND) + 100;
    }
  } catch (error) {
    // Fall back to the response header below.
  }

  const retryAfterHeader = Number.parseFloat(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfterHeader) && retryAfterHeader >= 0) {
    return Math.ceil(retryAfterHeader * MILLISECONDS_PER_SECOND) + 100;
  }

  return MILLISECONDS_PER_SECOND;
}

async function sendWebhookMessageNow(webhookUrl, payload) {
  const body = JSON.stringify(withSuppressedEmbeds(payload));

  for (let attempt = 0; attempt <= DISCORD_WEBHOOK_RATE_LIMIT_RETRY_LIMIT; attempt += 1) {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
    });

    if (response.ok) {
      webhookRetryQueuePaused = false;
      return;
    }

    const responseBody = await response.text().catch(() => '');
    if (response.status === 429 && attempt < DISCORD_WEBHOOK_RATE_LIMIT_RETRY_LIMIT) {
      const retryMs = getDiscordRateLimitRetryMs(response, responseBody);
      logWarnConfig(`Discord webhook rate limited; retrying in ${retryMs}ms.`);
      await wait(retryMs);
      continue;
    }

    throw createWebhookSendError(response, responseBody);
  }
}

async function sendWebhookMessage(webhookUrl, payload, options = {}) {
  const payloadChunks = splitDiscordMessageOptions(payload);
  const previousSend = webhookSendQueues.get(webhookUrl) || Promise.resolve();
  const nextSend = previousSend
    .catch(() => {})
    .then(async () => {
      if (options.queueOnFailure && webhookRetryQueue.length > 0) {
        enqueueWebhookRetry(
          webhookUrl,
          payloadChunks,
          { retryAfterMs: 0 },
        );
        return { queued: true };
      }

      for (let index = 0; index < payloadChunks.length; index += 1) {
        try {
          await sendWebhookMessageNow(webhookUrl, payloadChunks[index]);
        } catch (error) {
          if (options.queueOnFailure && isRetriableWebhookError(error)) {
            enqueueWebhookRetry(
              webhookUrl,
              payloadChunks.slice(index),
              { retryAfterMs: DISCORD_WEBHOOK_RETRY_INTERVAL_MS },
            );
          }
          throw error;
        }
      }
    });

  const queuedSend = nextSend
    .catch(() => {})
    .finally(() => {
      if (webhookSendQueues.get(webhookUrl) === queuedSend) {
        webhookSendQueues.delete(webhookUrl);
      }
    });

  webhookSendQueues.set(webhookUrl, queuedSend);
  return nextSend;
}

async function forwardKf2ChatToDiscord(config, chatMessage) {
  if (!config.forwardKf2ToDiscord || config.channelIds.length === 0) {
    return;
  }

  const avatarUrl = chatMessage.avatarUrl || await resolveSteamAvatarUrl(chatMessage.steamId, chatMessage.username);

  try {
    if (config.webhookUrl) {
      if (!avatarUrl) {
        logWarn(`Posting webhook message for ${chatMessage.username} without avatar_url.`);
      }

      const payload = {
        username: chatMessage.username,
        avatar_url: avatarUrl || undefined,
        content: chatMessage.content,
      };

      try {
        await sendWebhookMessage(config.webhookUrl, payload, { queueOnFailure: true });
      } catch (error) {
        if (isRetriableWebhookError(error)) {
          if (webhookRetryQueuePaused) {
            logWebhookQueueErrorOnce(
              error,
              () => `Discord webhook delivery is still unavailable after queue expiry; KF2 chat from ${config.name} was not queued: ${error.message || error}`,
            );
          } else {
            logWebhookQueueErrorOnce(
              error,
              () => `Discord webhook retry queue started after failed KF2 chat from ${config.name}: ${error.message || error}`,
            );
          }
          return;
        } else {
          logError(`Discord webhook send failed with permanent error; message was not queued: ${error.message || error}`);
          logError(`Payload was: ${JSON.stringify(payload)}`);
          return;
        }
      }
      return;
    }

    for (const channelId of config.channelIds) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || typeof channel.send !== 'function') {
          logWarn(`Cannot find Discord channel ${channelId} for ${config.name}.`);
          continue;
        }

        const payload = {
          content: `[${config.name}] ${chatMessage.username}: ${chatMessage.content}`,
        };

        try {
          await sendDiscordMessage(channel, payload);
        } catch (error) {
          logWarn(`Failed to forward KF2 chat from ${config.name} to Discord channel ${channelId}: ${error.message || error}`);
          logWarn(`Payload was: ${JSON.stringify(payload)}`);
        }
      } catch (error) {
        logWarn(`Failed to forward KF2 chat from ${config.name} to Discord channel ${channelId}: ${error.message || error}`);
      }
    }
  } catch (error) {
    logWarn(`Failed to forward KF2 chat from ${config.name} to Discord: ${error.message || error}`);
  }
}

function parseVotePayload(message) {
  const parsedPayload = parseRelayJsonPayload(message);
  if (!parsedPayload || parsedPayload.type !== 'vote' || typeof parsedPayload.subtype !== 'string') {
    return null;
  }

  return parsedPayload;
}

function parseMonthRankingRewardsPayload(message) {
  const parsedPayload = parseRelayJsonPayload(message);
  if (!parsedPayload || parsedPayload.type !== 'month-ranking-rewards') {
    return null;
  }

  return parsedPayload;
}

function isVoteStartSubtype(subtype) {
  return ['kick', 'pause', 'skip'].includes(subtype);
}

function formatVoteBoolean(value) {
  return value ? '✅' : '❌';
}

function normalizeVotePlayerName(value) {
  return String(value || '').trim();
}

function quoteVotePlayerName(value) {
  return `"${normalizeVotePlayerName(value) || 'Unknown'}"`;
}

function getVotePlayerKey(playerName) {
  return normalizeVotePlayerName(playerName).toLowerCase();
}

function getVoteStateKey(config) {
  return config.difficulty;
}

function clearVoteState(difficulty) {
  const state = activeVotes.get(difficulty);
  if (!state) {
    return;
  }

  if (state.timeout) {
    clearTimeout(state.timeout);
  }

  activeVotes.delete(difficulty);
}

function buildVoteHeader(state) {
  const difficultyLabel = state.difficultyLabel || getDifficultyLabel(state.difficulty);
  const initiator = quoteVotePlayerName(state.initiator);

  if (state.subtype === 'kick') {
    const target = quoteVotePlayerName(state.target);
    return `${difficultyLabel} - ${initiator} initiated kick of ${target}:`;
  }

  return `${difficultyLabel} - ${initiator} initiated ${state.subtype} vote:`;
}

function getVoteChannelIds(config, subtype) {
  if (subtype === 'kick') {
    return config.kickVoteChannelIds.length > 0
      ? config.kickVoteChannelIds
      : KF2_KICK_VOTE_DISCORD_CHANNEL_IDS;
  }

  return config.pauseSkipVoteChannelIds.length > 0
    ? config.pauseSkipVoteChannelIds
    : KF2_PAUSE_SKIP_VOTE_DISCORD_CHANNEL_IDS;
}

function getVotePassThreshold(state) {
  if (state.subtype === 'skip') {
    return KF2_SKIP_VOTE_PASS_PERCENT;
  }

  if (state.subtype === 'pause') {
    return KF2_PAUSE_VOTE_PASS_PERCENT;
  }

  return KF2_KICK_VOTE_PASS_PERCENT;
}

function getVotePassStats(state) {
  const targetKey = state.targetKey || '';
  const countedCurrentKeys = [...state.currentPlayerKeys]
    .filter((key) => state.initialPlayerKeys.has(key) && key !== targetKey);
  const countedLeftVotedKeys = [...state.leftPlayerKeys]
    .filter((key) => state.initialPlayerKeys.has(key) && key !== targetKey && state.votes.has(key));
  const denominator = Math.max(1, countedCurrentKeys.length);
  const positiveVoteKeys = new Set([...countedCurrentKeys, ...countedLeftVotedKeys]);
  const positiveCount = [...positiveVoteKeys]
    .filter((key) => state.votes.get(key) === true)
    .length;

  return {
    positivePercent: Math.min(100, Math.floor((positiveCount / denominator) * 100)),
    requiredPercent: getVotePassThreshold(state),
  };
}

function getVoteMark(state, player, options = {}) {
  if (options.fixedMark) {
    return options.fixedMark;
  }

  if (options.forceUnknown) {
    return '❔';
  }

  const voteValue = state.votes.get(player.key);
  return voteValue === true ? '✅' : voteValue === false ? '❌' : '❔';
}

function appendVotePlayerSection(lines, title, players, state, options = {}) {
  if (players.length === 0) {
    return;
  }

  if (lines.length > 0 && lines[lines.length - 1] !== '') {
    lines.push('');
  }

  lines.push(`\`${title}\``);
  for (const player of players) {
    lines.push(`${getVoteMark(state, player, options)}\t${player.name}`);
  }
}

function sortVotePlayersByOriginalOrder(state, players) {
  return [...players].sort((left, right) =>
    (state.playerOrder.get(left.key) ?? Number.MAX_SAFE_INTEGER)
      - (state.playerOrder.get(right.key) ?? Number.MAX_SAFE_INTEGER));
}

function getCurrentVotePlayers(state) {
  const targetKey = state.targetKey || '';
  return sortVotePlayersByOriginalOrder(
    state,
    state.players.filter((player) =>
      state.currentPlayerKeys.has(player.key)
      && state.initialPlayerKeys.has(player.key)
      && player.key !== targetKey),
  );
}

function getLeftVotePlayers(state) {
  const targetKey = state.targetKey || '';
  return sortVotePlayersByOriginalOrder(
    state,
    state.players.filter((player) =>
      state.leftPlayerKeys.has(player.key)
      && state.initialPlayerKeys.has(player.key)
      && player.key !== targetKey),
  );
}

function getJoinedVotePlayers(state) {
  const targetKey = state.targetKey || '';
  return sortVotePlayersByOriginalOrder(
    state,
    state.players.filter((player) =>
      state.joinedPlayerKeys.has(player.key)
      && player.key !== targetKey),
  );
}

function getTargetVotePlayer(state) {
  if (!state.targetKey) {
    return null;
  }

  return state.players.find((player) => player.key === state.targetKey)
    || { key: state.targetKey, name: state.target || 'Unknown' };
}

function getTargetVotePlayers(state) {
  const targetPlayer = getTargetVotePlayer(state);
  return targetPlayer ? [targetPlayer] : [];
}

function formatVoteMessage(state) {
  const separator = '-----------------------------------------------';
  const lines = [
    separator,
    buildVoteHeader(state),
    '',
  ];

  appendVotePlayerSection(lines, 'Current players:', getCurrentVotePlayers(state), state);
  appendVotePlayerSection(lines, 'Players who left:', getLeftVotePlayers(state), state);
  appendVotePlayerSection(lines, 'Newly joined players:', getJoinedVotePlayers(state), state, {
    forceUnknown: true,
  });

  appendVotePlayerSection(lines, 'Target player:', getTargetVotePlayers(state), state, {
    fixedMark: '❌',
  });

  if (typeof state.result === 'boolean') {
    const stats = getVotePassStats(state);
    if (lines.length > 0 && lines[lines.length - 1] !== '') {
      lines.push('');
    }
    lines.push(`Result: (${stats.positivePercent}%/${stats.requiredPercent}%) ${formatVoteBoolean(state.result)}`);
  }

  lines.push(separator);
  return lines.join('\n');
}

function queueVoteMessageEdit(state) {
  if (!Array.isArray(state.messages) || state.messages.length === 0) {
    return;
  }

  state.editPromise = (state.editPromise || Promise.resolve())
    .then(() => Promise.all(state.messages
      .filter((message) => message && typeof message.edit === 'function')
      .map((message) => editDiscordMessageWithRetry(
        message,
        () => ({ content: formatVoteMessage(state) }),
        `vote "${state.difficulty}"`,
      ))))
    .catch((error) => {
      logWarnConfig(`Failed to edit vote message for "${state.difficulty}": ${error.message || error}`);
    });
}

function addVotePlayerIfMissing(state, playerName) {
  const name = normalizeVotePlayerName(playerName);
  if (!name) {
    return null;
  }

  const key = getVotePlayerKey(name);
  const existingPlayer = state.players.find((player) => player.key === key);
  if (existingPlayer) {
    return existingPlayer;
  }

  const player = { key, name };
  state.players.push(player);
  state.playerOrder.set(key, state.playerOrder.size);
  return player;
}

function getVotePayloadPlayerNames(payload) {
  if (!Array.isArray(payload.players)) {
    return [];
  }

  return payload.players
    .map((player) => normalizeVotePlayerName(player?.name || player))
    .filter(Boolean);
}

function syncVotePlayerSnapshot(state, payload, options = {}) {
  const playerNames = getVotePayloadPlayerNames(payload);
  if (playerNames.length === 0) {
    return;
  }

  const snapshotKeys = new Set();
  for (const playerName of playerNames) {
    const player = addVotePlayerIfMissing(state, playerName);
    if (player) {
      snapshotKeys.add(player.key);
    }
  }

  if (state.target) {
    const targetPlayer = addVotePlayerIfMissing(state, state.target);
    state.targetKey = targetPlayer?.key || getVotePlayerKey(state.target);
  }

  if (options.initial) {
    state.initialPlayerKeys = new Set(snapshotKeys);
    state.currentPlayerKeys = new Set(snapshotKeys);
    state.leftPlayerKeys = new Set();
    state.joinedPlayerKeys = new Set();
    return;
  }

  state.currentPlayerKeys = snapshotKeys;

  for (const key of state.initialPlayerKeys) {
    if (snapshotKeys.has(key)) {
      state.leftPlayerKeys.delete(key);
    } else {
      state.leftPlayerKeys.add(key);
    }
  }

  for (const key of snapshotKeys) {
    if (!state.initialPlayerKeys.has(key) && key !== state.targetKey) {
      state.joinedPlayerKeys.add(key);
    }
  }
}

function parseVotePlayerConnectionLog(content) {
  const text = String(content || '').trim();
  const leftMatch = text.match(/^(.+?) left the game\.$/i);
  if (leftMatch) {
    return {
      action: 'left',
      playerName: normalizeVotePlayerName(leftMatch[1]),
    };
  }

  const joinedMatch = text.match(/^(.+?) entered the game\.$/i);
  if (joinedMatch) {
    return {
      action: 'joined',
      playerName: normalizeVotePlayerName(joinedMatch[1]),
    };
  }

  return null;
}

function updateVotePlayerConnectionFromChat(config, chatMessage) {
  const difficulty = getVoteStateKey(config);
  const state = activeVotes.get(difficulty);
  if (!state) {
    return;
  }

  const connectionLog = parseVotePlayerConnectionLog(chatMessage.content);
  if (!connectionLog?.playerName) {
    return;
  }

  const player = addVotePlayerIfMissing(state, connectionLog.playerName);
  if (!player) {
    return;
  }

  if (connectionLog.action === 'left') {
    state.currentPlayerKeys.delete(player.key);
    if (state.initialPlayerKeys.has(player.key)) {
      state.leftPlayerKeys.add(player.key);
    }
  } else if (connectionLog.action === 'joined') {
    state.currentPlayerKeys.add(player.key);
    if (state.initialPlayerKeys.has(player.key)) {
      state.leftPlayerKeys.delete(player.key);
    } else if (player.key !== state.targetKey) {
      state.joinedPlayerKeys.add(player.key);
    }
  }

  queueVoteMessageEdit(state);
}

async function startVoteState(config, payload) {
  const difficulty = getVoteStateKey(config);
  clearVoteState(difficulty);

  const initiator = normalizeVotePlayerName(payload.initiator) || 'Unknown';
  const state = {
    difficulty,
    difficultyLabel: getDifficultyLabel(difficulty),
    subtype: payload.subtype,
    initiator,
    target: normalizeVotePlayerName(payload.target),
    targetKey: '',
    players: [],
    playerOrder: new Map(),
    initialPlayerKeys: new Set(),
    currentPlayerKeys: new Set(),
    leftPlayerKeys: new Set(),
    joinedPlayerKeys: new Set(),
    votes: new Map(),
    result: null,
    messages: [],
    timeout: null,
    editPromise: Promise.resolve(),
  };

  syncVotePlayerSnapshot(state, payload, { initial: true });

  if (state.target) {
    const targetPlayer = addVotePlayerIfMissing(state, state.target);
    state.targetKey = targetPlayer?.key || getVotePlayerKey(state.target);
  }

  const initiatorPlayer = addVotePlayerIfMissing(state, initiator);
  if (initiatorPlayer && state.initialPlayerKeys.size === 0) {
    state.initialPlayerKeys.add(initiatorPlayer.key);
    state.currentPlayerKeys.add(initiatorPlayer.key);
  } else if (initiatorPlayer && !state.joinedPlayerKeys.has(initiatorPlayer.key)) {
    state.initialPlayerKeys.add(initiatorPlayer.key);
    state.currentPlayerKeys.add(initiatorPlayer.key);
  }
  state.votes.set(getVotePlayerKey(initiator), true);

  state.timeout = setTimeout(() => {
    clearVoteState(difficulty);
    logInfoConfig(`Cleared timed-out vote state for "${difficulty}".`);
  }, KF2_VOTE_TIMEOUT_MS);

  activeVotes.set(difficulty, state);

  const channelIds = getVoteChannelIds(config, payload.subtype);
  if (channelIds.length === 0) {
    const channelConfigName = payload.subtype === 'kick'
      ? `KF2_SERVER_${config.index}_KICK_VOTE_DISCORD_CHANNEL_IDS or KF2_KICK_VOTE_DISCORD_CHANNEL_IDS`
      : `KF2_SERVER_${config.index}_PAUSE_SKIP_VOTE_DISCORD_CHANNEL_IDS or KF2_PAUSE_SKIP_VOTE_DISCORD_CHANNEL_IDS`;
    logWarnConfig(`Cannot post vote message for "${config.name}"; set ${channelConfigName}.`);
    return;
  }

  try {
    for (const channelId of channelIds) {
      try {
        const message = await sendDiscordMessageWithRetry(channelId, {
          content: formatVoteMessage(state),
        }, `vote from ${config.name}`);
        if (message) {
          state.messages.push(message);
        }
      } catch (error) {
        logWarnConfig(`Failed to post vote message for ${config.name} to channel ${channelId}: ${error.message || error}`);
      }
    }

    if (state.messages.length > 0) {
      queueVoteMessageEdit(state);
    }
  } catch (error) {
    logWarnConfig(`Failed to post vote message for ${config.name}: ${error.message || error}`);
  }
}

function updateVoteState(config, payload) {
  const difficulty = getVoteStateKey(config);
  const state = activeVotes.get(difficulty);
  if (!state) {
    logWarnConfig(`Received vote update for "${difficulty}" without an active vote.`);
    return;
  }

  syncVotePlayerSnapshot(state, payload);
  const player = addVotePlayerIfMissing(state, payload.player);
  if (!player || typeof payload.value !== 'boolean') {
    logWarnConfig(`Received invalid vote update for "${difficulty}".`);
    return;
  }

  if (!state.initialPlayerKeys.has(player.key) && player.key !== state.targetKey) {
    state.joinedPlayerKeys.add(player.key);
    state.currentPlayerKeys.add(player.key);
  }

  state.votes.set(player.key, payload.value);
  queueVoteMessageEdit(state);
}

function finishVoteState(config, payload) {
  const difficulty = getVoteStateKey(config);
  const state = activeVotes.get(difficulty);
  if (!state) {
    logWarnConfig(`Received vote result for "${difficulty}" without an active vote.`);
    return;
  }

  if (typeof payload.value !== 'boolean') {
    logWarnConfig(`Received invalid vote result for "${difficulty}".`);
    return;
  }

  syncVotePlayerSnapshot(state, payload);
  state.result = payload.value;
  queueVoteMessageEdit(state);
  clearVoteState(difficulty);
}

async function handleKf2VotePayload(config, payload) {
  if (isVoteStartSubtype(payload.subtype)) {
    await startVoteState(config, payload);
    return;
  }

  if (payload.subtype === 'vote') {
    updateVoteState(config, payload);
    return;
  }

  if (payload.subtype === 'result') {
    finishVoteState(config, payload);
    return;
  }

  logWarnConfig(`Received unknown vote subtype "${payload.subtype}" from ${config.name}.`);
}

function formatRankNumber(value) {
  const numberValue = Number.parseInt(value, 10);
  if (!Number.isInteger(numberValue)) {
    return String(value || '');
  }

  return String(numberValue);
}

function getMonthlyVipDaysForRank(rank) {
  const rankValue = Number.parseInt(rank, 10);
  if (!Number.isInteger(rankValue)) {
    return 0;
  }

  return Math.max(11 - rankValue, 0);
}

function normalizeSteamIdText(value) {
  return String(value || '').trim();
}

async function resolveResponseTargetDisplay(target, cache = new Map()) {
  const normalizedTarget = String(target || '').trim();
  if (!normalizedTarget) {
    return '';
  }

  if (isValidSteamId64(normalizedTarget)) {
    return resolveSteamIdDisplayName(normalizedTarget, cache);
  }

  return normalizedTarget;
}

async function resolveSteamIdDisplayName(steamId, cache) {
  const normalizedSteamId = normalizeSteamIdText(steamId);
  if (!normalizedSteamId) {
    return 'Unknown';
  }

  if (cache.has(normalizedSteamId)) {
    return cache.get(normalizedSteamId);
  }

  let displayName = normalizedSteamId;
  if (isValidSteamId64(normalizedSteamId) && activeSteamApiKey) {
    try {
      const player = await ensureSteamIdExists(normalizedSteamId);
      displayName = formatSteamProfileDisplay(normalizedSteamId, player);
    } catch (error) {
      logWarn(`Could not resolve Steam profile ${normalizedSteamId}: ${error.message || error}`);
    }
  }

  cache.set(normalizedSteamId, displayName);
  return displayName;
}

async function buildMonthlyRewardDisplayCache(payload) {
  const cache = new Map();
  const steamIds = new Set();

  for (const difficulty of Object.values(payload.difficulties || {})) {
    if (!Array.isArray(difficulty?.players)) {
      continue;
    }

    for (const player of difficulty.players) {
      steamIds.add(normalizeSteamIdText(player?.steamid));
    }
  }

  for (const player of payload.rewards?.players || []) {
    steamIds.add(normalizeSteamIdText(player?.steamid));
  }

  for (const steamId of steamIds) {
    if (steamId) {
      await resolveSteamIdDisplayName(steamId, cache);
    }
  }

  return cache;
}

function getMonthlyRewardDifficultyEntries(payload) {
  const difficultyEntries = Object.entries(payload.difficulties || {})
    .filter(([, difficulty]) => Array.isArray(difficulty?.players))
    .sort(([left], [right]) => {
      const leftIndex = DIFFICULTY_ORDER.indexOf(left);
      const rightIndex = DIFFICULTY_ORDER.indexOf(right);
      if (leftIndex !== -1 || rightIndex !== -1) {
        return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex)
          - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
      }

      return left.localeCompare(right);
    });

  return difficultyEntries;
}

async function buildMonthlyRankingRewardBlocks(payload) {
  const displayCache = await buildMonthlyRewardDisplayCache(payload);
  const intro = [
    'Time UP ! Monthly VIP rewards have been delivered and a new month has started. Monthly rank score is now reset',
    'Sum up for Scores, ranks and rewards:',
  ].join('\n');
  const difficultySections = [];
  const difficultyEntries = getMonthlyRewardDifficultyEntries(payload);

  for (const [difficultyKey, difficulty] of difficultyEntries) {
    const lines = [`${getDifficultyLabel(difficultyKey)}:`];
    const players = difficulty.players
      .map((player) => ({
        steamId: normalizeSteamIdText(player?.steamid),
        rank: Number.parseInt(player?.rank, 10),
        points: Number.parseInt(player?.points, 10),
      }))
      .filter((player) => player.steamId && Number.isInteger(player.rank))
      .sort((left, right) => left.rank - right.rank);

    if (players.length === 0) {
      lines.push('No ranked players.');
      difficultySections.push(lines.join('\n'));
      continue;
    }

    const rows = await Promise.all(players.map(async (player) => {
      const rewardDays = getMonthlyVipDaysForRank(player.rank);
      return {
        rank: formatRankNumber(player.rank),
        points: `${Number.isInteger(player.points) ? player.points : 0} points`,
        rewardDays: rewardDays === 0 ? '' : `+${rewardDays}`,
        dayLabel: rewardDays === 0 ? '' : rewardDays === 1 ? 'day' : 'days',
        player: await resolveSteamIdDisplayName(player.steamId, displayCache),
      };
    }));
    const rankWidth = Math.max(...rows.map((row) => getDiscordTextWidth(row.rank)));
    const pointsWidth = Math.max(...rows.map((row) => getDiscordTextWidth(row.points)));
    const rewardDaysWidth = Math.max(...rows.map((row) => getDiscordTextWidth(row.rewardDays)));
    const dayLabelWidth = Math.max(...rows.map((row) => getDiscordTextWidth(row.dayLabel)));

    for (const row of rows) {
      const statText = `${padEndByDiscordTextWidth(row.rank, rankWidth)}  `
        + `${padEndByDiscordTextWidth(row.points, pointsWidth)}  `
        + `${padEndByDiscordTextWidth(row.rewardDays, rewardDaysWidth)} `
        + padEndByDiscordTextWidth(row.dayLabel, dayLabelWidth);
      lines.push(`\`${statText}\` ${row.player}`);
    }

    difficultySections.push(lines.join('\n'));
  }

  const rewardLines = [];
  const rewardPlayers = Array.isArray(payload.rewards?.players) ? payload.rewards.players : [];
  rewardLines.push('VIP days delivered to players:');

  if (rewardPlayers.length === 0) {
    rewardLines.push('No VIP rewards delivered.');
  } else {
    const rows = await Promise.all(rewardPlayers.map(async (player) => {
      const days = Math.max(0, Number.parseInt(player?.days, 10) || 0);
      return {
        days: `+${days}`,
        dayLabel: days === 1 ? 'Day' : 'Days',
        player: await resolveSteamIdDisplayName(player?.steamid, displayCache),
      };
    }));
    const daysWidth = Math.max(...rows.map((row) => getDiscordTextWidth(row.days)));
    const dayLabelWidth = Math.max(...rows.map((row) => getDiscordTextWidth(row.dayLabel)));

    for (const row of rows) {
      const statText = `${padEndByDiscordTextWidth(row.days, daysWidth)} `
        + padEndByDiscordTextWidth(row.dayLabel, dayLabelWidth);
      rewardLines.push(`\`${statText}\` ${row.player}`);
    }
  }

  const note = 'Note: Delivered VIP are acting as Extension to current VIP applied. If you have no VIP running then delivered reward will act as a Special Bronze VIP. The Special Bronze VIP act as bronze VIP with a server level limitation bypass (Designated with a <3 near your name in game)';

  return {
    intro,
    difficultySections,
    rewards: rewardLines.join('\n'),
    note,
  };
}

function splitMonthlyRankingRewardCombinedGroup(primarySection, secondarySection, maxLength = DISCORD_MESSAGE_MAX_LENGTH) {
  const primary = String(primarySection || '').trim();
  const secondary = String(secondarySection || '').trim();

  if (!primary) {
    return splitDiscordMessage(secondary, maxLength);
  }

  if (!secondary) {
    return splitDiscordMessage(primary, maxLength);
  }

  const combined = `${primary}\n\n${secondary}`;
  if (combined.length <= maxLength) {
    return [combined];
  }

  return [
    ...splitDiscordMessage(primary, maxLength),
    ...splitDiscordMessage(secondary, maxLength),
  ];
}

function splitMonthlyRankingRewardBlocks(blocks, maxLength = 2000) {
  const [firstDifficultySection, ...remainingDifficultySections] = blocks.difficultySections;
  const chunks = [
    ...splitMonthlyRankingRewardCombinedGroup(blocks.intro, firstDifficultySection, maxLength),
  ];

  for (const difficultySection of remainingDifficultySections) {
    chunks.push(...splitDiscordMessage(String(difficultySection || '').trim(), maxLength));
  }

  chunks.push(...splitMonthlyRankingRewardCombinedGroup(blocks.rewards, blocks.note, maxLength));

  return chunks.filter((chunk) => String(chunk || '').trim());
}

async function splitMonthlyRankingRewardsMessage(payload) {
  const blocks = await buildMonthlyRankingRewardBlocks(payload);
  const monthlyChunkMaxLength = DISCORD_MESSAGE_MAX_LENGTH
    - MONTHLY_RANKING_REWARD_CHUNK_PREFIX.length;

  return splitMonthlyRankingRewardBlocks(blocks, monthlyChunkMaxLength)
    .map((chunk, index) => (index === 0 ? chunk : `${MONTHLY_RANKING_REWARD_CHUNK_PREFIX}${chunk}`));
}

async function postMonthlyRankingRewards(config, payload) {
  if (KF2_MONTHLY_REWARD_DISCORD_CHANNEL_IDS.length === 0) {
    logWarn(`Cannot post monthly ranking rewards for "${config.name}"; set KF2_MONTHLY_REWARD_DISCORD_CHANNEL_IDS.`);
    return;
  }

  const chunks = await splitMonthlyRankingRewardsMessage(payload);

  for (const channelId of KF2_MONTHLY_REWARD_DISCORD_CHANNEL_IDS) {
    try {
      for (const chunk of chunks) {
        await sendDiscordMessageWithRetry(channelId, {
          content: chunk,
        }, `monthly ranking rewards from ${config.name}`);
      }
    } catch (error) {
      logWarn(`Failed to post monthly ranking rewards from ${config.name} to Discord channel ${channelId}: ${error.message || error}`);
    }
  }
}

class Kf2Connection {
  constructor(config) {
    this.config = config;
    this.socket = null;
    this.buffer = '';
    this.connected = false;
    this.reconnectTimer = null;
    this.pendingRequest = null;
    this.manuallyStopped = false;
  }

  start() {
    this.manuallyStopped = false;
    this.connect();
  }

  isConnected() {
    return this.connected && this.socket && !this.socket.destroyed;
  }

  connect() {
    if (this.socket || this.manuallyStopped) {
      return;
    }

    const socket = net.createConnection({
      host: this.config.host,
      port: this.config.port,
    });

    this.socket = socket;
    socket.setTimeout(KF2_CONNECT_TIMEOUT_MS);

    socket.once('connect', () => {
      socket.setTimeout(0);
      this.connected = true;
      logInfo(`Connected to KF2 server "${this.config.name}" at ${this.config.host}:${this.config.port}`);
      refreshActiveRelays();
    });

    socket.on('data', (chunk) => {
      this.handleData(chunk);
    });

    socket.on('timeout', () => {
      socket.destroy(new Error('Connection timed out'));
    });

    socket.on('error', (error) => {
      logWarn(`KF2 server "${this.config.name}" socket error: ${error.message}`);
    });

    socket.on('close', () => {
      const wasConnected = this.connected;
      this.socket = null;
      this.buffer = '';
      this.connected = false;
      this.failPendingRequest('KF2 socket disconnected before sending a response.');
      refreshActiveRelays();

      if (wasConnected) {
        logWarn(`Lost connection to KF2 server "${this.config.name}". Retrying in ${Math.round(KF2_RECONNECT_DELAY_MS / MILLISECONDS_PER_SECOND)} seconds...`);
      }

      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.manuallyStopped || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, KF2_RECONNECT_DELAY_MS);
  }

  handleData(chunk) {
    this.buffer += chunk.toString('utf8');

    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }

      const rawLine = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (rawLine) {
        this.handleRawLine(rawLine);
      }
    }
  }

  handleRawLine(rawLine) {
    let message;

    try {
      message = unicodeConvert(rawLine);
    } catch (error) {
      const votePayload = parseVotePayload(rawLine);
      if (votePayload) {
        void handleKf2VotePayload(this.config, votePayload);
        return;
      }

      const monthRankingRewardsPayload = parseMonthRankingRewardsPayload(rawLine);
      if (monthRankingRewardsPayload) {
        void postMonthlyRankingRewards(this.config, monthRankingRewardsPayload);
        return;
      }

      logWarn(`Failed to decode KF2 message from "${this.config.name}": ${error.message || error}`);
      return;
    }

    const votePayload = parseVotePayload(message);
    if (votePayload) {
      void handleKf2VotePayload(this.config, votePayload);
      return;
    }

    const monthRankingRewardsPayload = parseMonthRankingRewardsPayload(message);
    if (monthRankingRewardsPayload) {
      void postMonthlyRankingRewards(this.config, monthRankingRewardsPayload);
      return;
    }

    if (this.tryHandleDsResponse(message)) {
      return;
    }

    try {
      const chatMessage = parseKf2ChatPayload(message, this.config);
      updateVotePlayerConnectionFromChat(this.config, chatMessage);
      void forwardKf2ChatToDiscord(this.config, chatMessage);
    } catch (error) {
      logWarn(`Failed to process KF2 message from "${this.config.name}": ${error.message || error}`);
    }
  }

  tryHandleDsResponse(content) {
    const prefix = '/dsresponse ';
    if (!content.startsWith(prefix)) {
      return false;
    }

    if (this.pendingRequest) {
      const pendingRequest = this.pendingRequest;
      this.pendingRequest = null;
      clearTimeout(pendingRequest.timeout);
      pendingRequest.resolve(content);
    }

    return true;
  }

  sendMessage(message) {
    if (!this.isConnected()) {
      throw new Error(`KF2 server "${this.config.name}" is not connected.`);
    }

    this.socket.write(`${message}\n`);
  }

  sendRequest(payload) {
    if (this.pendingRequest) {
      return Promise.reject(new Error(`KF2 server "${this.config.name}" is already processing another request.`));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingRequest) {
          this.pendingRequest = null;
          reject(new Error('Timed out waiting for /dsresponse.'));
        }
      }, KF2_REQUEST_TIMEOUT_MS);

      this.pendingRequest = {
        resolve,
        reject,
        timeout,
      };

      try {
        this.sendMessage(payload);
      } catch (error) {
        this.pendingRequest = null;
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  failPendingRequest(message) {
    if (!this.pendingRequest) {
      return;
    }

    const pendingRequest = this.pendingRequest;
    this.pendingRequest = null;
    clearTimeout(pendingRequest.timeout);
    pendingRequest.reject(new Error(message));
  }

  stop() {
    this.manuallyStopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}

function isValidSteamId64(steamId) {
  if (typeof steamId !== 'string') {
    return false;
  }

  const trimmedSteamId = steamId.trim();
  if (!/^\d{17}$/.test(trimmedSteamId)) {
    return false;
  }

  try {
    const value = BigInt(trimmedSteamId);
    return value >= 76561197960265728n && value <= 99999999999999999n;
  } catch (error) {
    return false;
  }
}

function parseSteamProfileTarget(rawTarget) {
  const target = String(rawTarget || '').trim();
  if (!target) {
    return null;
  }

  let urlText = target;
  if (/^(?:www\.)?steamcommunity\.com(?:[/?#]|$)/i.test(urlText)) {
    urlText = `https://${urlText}`;
  }

  let url;
  try {
    url = new URL(urlText);
  } catch (error) {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname !== 'steamcommunity.com' && hostname !== 'www.steamcommunity.com') {
    return null;
  }

  let pathParts;
  try {
    pathParts = url.pathname
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch (error) {
    return { type: 'invalid' };
  }

  if (pathParts.length < 2) {
    return { type: 'invalid' };
  }

  const profileType = pathParts[0].toLowerCase();
  if (profileType === 'profiles') {
    return {
      type: 'steamid',
      steamId: pathParts[1],
    };
  }

  if (profileType === 'id') {
    return {
      type: 'vanity',
      vanityName: pathParts[1],
    };
  }

  return { type: 'invalid' };
}

async function getSteamPlayerSummary(steamId) {
  if (!activeSteamApiKey) {
    return null;
  }

  const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/');
  url.searchParams.set('key', activeSteamApiKey);
  url.searchParams.set('steamids', steamId);

  const response = await fetch(url);
  if (response.status === 401 || response.status === 403) {
    activeSteamApiKey = '';
    logWarn('STEAM_API_KEY was rejected by Steam API; Steam lookups are disabled until restart.');
    return null;
  }

  if (!response.ok) {
    throw new Error(`Steam API request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data?.response?.players?.[0] || null;
}

async function ensureSteamIdExists(steamId) {
  if (!isValidSteamId64(steamId)) {
    throw new Error('Invalid Steam target. Provide a valid nickname, SteamID64 or Steam profile link.');
  }

  if (!activeSteamApiKey) {
    return null;
  }

  const player = await getSteamPlayerSummary(steamId);
  if (!activeSteamApiKey) {
    return null;
  }

  if (!player) {
    throw new Error(`Steam profile not found for SteamID64 ${steamId}.`);
  }

  return player;
}

function escapeDiscordMarkdownLinkText(value) {
  return String(value || '').replace(/([\\[\]])/g, '\\$1');
}

function getSteamProfileUrl(steamId, player) {
  return player?.profileurl || `https://steamcommunity.com/profiles/${steamId}/`;
}

function formatSteamProfileDisplay(steamId, player) {
  if (!player) {
    return steamId;
  }

  const label = player?.personaname || steamId;
  return `[${escapeDiscordMarkdownLinkText(label)}](${getSteamProfileUrl(steamId, player)})`;
}

async function resolveSteamVanityUrl(vanityName) {
  if (!activeSteamApiKey) {
    throw new Error('Steam vanity profile links require STEAM_API_KEY to resolve.');
  }

  const url = new URL('https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/');
  url.searchParams.set('key', activeSteamApiKey);
  url.searchParams.set('vanityurl', vanityName);

  const response = await fetch(url);
  if (response.status === 401 || response.status === 403) {
    activeSteamApiKey = '';
    logWarn('STEAM_API_KEY was rejected by Steam API; Steam lookups are disabled until restart.');
    throw new Error('Steam vanity profile links require a valid STEAM_API_KEY to resolve.');
  }

  if (!response.ok) {
    throw new Error(`Steam API request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const steamId = data?.response?.steamid;
  if (data?.response?.success !== 1 || !steamId) {
    throw new Error(`Steam vanity profile "${vanityName}" was not found.`);
  }

  const player = await ensureSteamIdExists(steamId);
  return {
    steamId,
    steamApiChecked: Boolean(player),
    player,
  };
}

async function resolvePlayerTarget(rawTarget) {
  const target = String(rawTarget || '').trim();
  if (!target) {
    throw new Error('Provide a target.');
  }

  const steamProfileTarget = parseSteamProfileTarget(target);
  if (steamProfileTarget) {
    if (steamProfileTarget.type === 'steamid') {
      const player = await ensureSteamIdExists(steamProfileTarget.steamId);
      return {
        type: 'steamid',
        value: steamProfileTarget.steamId,
        display: formatSteamProfileDisplay(steamProfileTarget.steamId, player),
        source: 'profile-link',
        steamApiChecked: Boolean(player),
      };
    }

    if (steamProfileTarget.type === 'vanity') {
      const { steamId, steamApiChecked, player } = await resolveSteamVanityUrl(steamProfileTarget.vanityName);
      return {
        type: 'steamid',
        value: steamId,
        display: formatSteamProfileDisplay(steamId, player),
        source: 'vanity-link',
        steamApiChecked,
      };
    }

    throw new Error('Invalid Steam profile link. Use steamcommunity.com/profiles/<steamid64> or steamcommunity.com/id/<name>.');
  }

  if (/^\d{17}$/.test(target)) {
    const player = await ensureSteamIdExists(target);
    return {
      type: 'steamid',
      value: target,
      display: formatSteamProfileDisplay(target, player),
      source: 'steamid',
      steamApiChecked: Boolean(player),
    };
  }

  return {
    type: 'nickname',
    value: target,
    display: target,
    source: 'nickname',
    steamApiChecked: false,
  };
}

function buildPlayerTargetPayload(commandName, target) {
  return `/dsrequest ${commandName} ${target.type}:${target.value}`;
}

function suppressDiscordLinkEmbeds(text) {
  return String(text).replace(/(^|[^\w<])(https?:\/\/[^\s<>]+)/gi, (match, prefix, url) => `${prefix}<${url}>`);
}

function formatTargetResolutionExample(input, target) {
  const steamApiStatus = target.type === 'nickname'
    ? 'not used for nicknames'
    : target.steamApiChecked
      ? 'checked and found'
      : 'skipped because STEAM_API_KEY is not configured';

  return [
    `Input: ${suppressDiscordLinkEmbeds(input)}`,
    `Detected as: ${target.type}`,
    `Source: ${target.source}`,
    `Value sent to KF2: ${target.type}:${target.value}`,
    `Display in responses: ${target.display}`,
    `Example KF2 request: ${buildPlayerTargetPayload('perk', target)}`,
    `Steam API validation: ${steamApiStatus}`,
  ].join('\n');
}

async function formatResponseTargetResolutionExample(responsePayload) {
  const parsedPayload = parseRelayJsonPayload(responsePayload);
  if (!parsedPayload || !Object.prototype.hasOwnProperty.call(parsedPayload, 'target')) {
    throw new Error('Provide response JSON with a target field.');
  }

  const responseTarget = String(parsedPayload.target || '').trim();
  if (!responseTarget) {
    return [
      `Response: ${suppressDiscordLinkEmbeds(responsePayload)}`,
      'Response target is empty.',
      'Result: previous request target would be used.',
    ].join('\n');
  }

  const display = await resolveResponseTargetDisplay(responseTarget);
  const detectedAs = isValidSteamId64(responseTarget) ? 'steamid' : 'nickname';

  return [
    `Response: ${suppressDiscordLinkEmbeds(responsePayload)}`,
    `Response target: ${responseTarget}`,
    `Detected as: ${detectedAs}`,
    `Display in formatted responses: ${display}`,
  ].join('\n');
}

async function buildTargetRelayRequest(interaction, commandName, hidden, raw) {
  const relay = getDefaultRelay();

  if (!relay) {
    throw new Error('No active difficulties are available right now.');
  }

  const target = await resolvePlayerTarget(interaction.options.getString('target', true));

  return {
    commandName,
    difficulty: relay.difficulty,
    requestedTarget: target.display,
    payload: buildPlayerTargetPayload(commandName, target),
    hidden,
    raw,
  };
}

async function buildRelayRequest(interaction) {
  const commandName = interaction.commandName;
  const hidden = interaction.options.getBoolean('hidden') || false;
  const raw = resolveRawOption(interaction);

  if (commandName === 'info') {
    const difficulty = interaction.options.getString('difficulty', true);

    if (!ensureValidDifficulty(difficulty)) {
      throw new Error('Selected difficulty is not active right now.');
    }

    return {
      commandName,
      difficulty,
      payload: '/dsrequest info',
      hidden,
      raw,
    };
  }

  if (commandName === 'vipinfo') {
    return buildTargetRelayRequest(interaction, commandName, hidden, raw);
  }

  if (commandName === 'perk') {
    return buildTargetRelayRequest(interaction, commandName, hidden, raw);
  }

  if (commandName === 'overdrives') {
    return buildTargetRelayRequest(interaction, commandName, hidden, raw);
  }

  if (commandName === 'rank') {
    return buildTargetRelayRequest(interaction, commandName, hidden, raw);
  }

  if (commandName === 'rankings') {
    const selectedDifficulty = interaction.options.getString('difficulty', true);
    if (!ensureValidDifficulty(selectedDifficulty)) {
      throw new Error('Selected difficulty is not active right now.');
    }

    return {
      commandName,
      difficulty: selectedDifficulty,
      payload: '/dsrequest rank',
      hidden,
      raw,
    };
  }

  throw new Error(`Unsupported command: /${commandName}`);
}

function normalizePerkName(value) {
  return value.toLowerCase().replace(/[^a-z]/g, '');
}

function findPerkDefinition(value) {
  const normalizedValue = normalizePerkName(value);
  return PERK_DISPLAY_ORDER.find((perk) =>
    perk.aliases.some((alias) => normalizePerkName(alias) === normalizedValue),
  ) || null;
}

function extractRelayResponseText(responsePayload) {
  const responseText = responsePayload.replace(/^\/dsresponse\s*/i, '').trim();
  const jsonStartIndex = responseText.search(/[\[{]/);

  if (jsonStartIndex > 0) {
    return responseText.slice(jsonStartIndex).trim();
  }

  return responseText;
}

function parseRelayJsonPayload(responsePayload) {
  const responseText = extractRelayResponseText(responsePayload);

  try {
    return JSON.parse(responseText);
  } catch (error) {
    return null;
  }
}

function parsePerkEntries(responsePayload) {
  const parsedPayload = parseRelayJsonPayload(responsePayload);
  if (!parsedPayload) {
    return [];
  }

  if (!parsedPayload || !Array.isArray(parsedPayload.perks)) {
    return [];
  }

  const entries = [];

  for (const rawPerk of parsedPayload.perks) {
    if (!rawPerk || typeof rawPerk.name !== 'string') {
      continue;
    }

    const perk = findPerkDefinition(rawPerk.name);
    if (!perk) {
      continue;
    }

    const prestige = Number.parseInt(rawPerk.prestige, 10);
    const level = Number.parseInt(rawPerk.level, 10);

    entries.push({
      key: perk.key,
      label: perk.label,
      emojiName: perk.emojiName,
      prestige: Number.isNaN(prestige) ? 0 : prestige,
      level: Number.isNaN(level) ? 0 : level,
    });
  }

  return entries;
}

function parseVipInfo(responsePayload) {
  const parsedPayload = parseRelayJsonPayload(responsePayload);
  if (!parsedPayload) {
    return null;
  }

  if (!parsedPayload || typeof parsedPayload.vip !== 'object' || parsedPayload.vip === null) {
    return null;
  }

  const vipType = typeof parsedPayload.vip.type === 'string' ? parsedPayload.vip.type.trim() : '';
  const daysLeft = Number.parseInt(parsedPayload.vip.daysLeft, 10);

  if (!vipType || Number.isNaN(daysLeft)) {
    return null;
  }

  return {
    type: vipType,
    daysLeft,
  };
}

function resolveOverdriveDefinition(value) {
  const normalizedValue = String(value || '').trim().toLowerCase();
  return OVERDRIVE_DISPLAY_ORDER.find((overdrive) =>
    overdrive.aliases.includes(normalizedValue),
  ) || null;
}

function normalizeOverdriveValue(value) {
  if (Array.isArray(value)) {
    return normalizeOverdriveValue(value.find((item) => item && typeof item === 'object'));
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const max = Number.parseInt(value.max, 10);
  const current = Number.parseInt(value.current, 10);

  if (Number.isNaN(max) || Number.isNaN(current)) {
    return null;
  }

  return {
    max,
    current,
  };
}

function parseOverdriveEntries(responsePayload) {
  const parsedPayload = parseRelayJsonPayload(responsePayload);
  if (!parsedPayload) {
    return [];
  }

  const rawOverdrives = parsedPayload.overdrives;
  const entriesByKey = new Map();

  if (Array.isArray(rawOverdrives)) {
    for (const rawEntry of rawOverdrives) {
      if (!rawEntry || typeof rawEntry !== 'object') {
        continue;
      }

      for (const [rawKey, rawValue] of Object.entries(rawEntry)) {
        const definition = resolveOverdriveDefinition(rawKey);
        const value = normalizeOverdriveValue(rawValue);
        if (definition && value) {
          entriesByKey.set(definition.key, {
            ...definition,
            ...value,
          });
        }
      }
    }
  } else if (rawOverdrives && typeof rawOverdrives === 'object') {
    for (const [rawKey, rawValue] of Object.entries(rawOverdrives)) {
      const definition = resolveOverdriveDefinition(rawKey);
      const value = normalizeOverdriveValue(rawValue);
      if (definition && value) {
        entriesByKey.set(definition.key, {
          ...definition,
          ...value,
        });
      }
    }
  }

  return OVERDRIVE_DISPLAY_ORDER
    .map((overdrive) => entriesByKey.get(overdrive.key))
    .filter(Boolean);
}

function parseRankEntries(responsePayload) {
  const parsedPayload = parseRelayJsonPayload(responsePayload);
  if (!parsedPayload || typeof parsedPayload.ranks !== 'object' || parsedPayload.ranks === null) {
    return [];
  }

  const entries = [];

  for (const difficulty of RANK_DISPLAY_ORDER) {
    const rankData = parsedPayload.ranks[difficulty.key];
    if (!rankData || typeof rankData !== 'object') {
      continue;
    }

    const rank = Number.parseInt(rankData.rank, 10);
    const points = Number.parseInt(rankData.points, 10);

    if (Number.isNaN(rank) || Number.isNaN(points)) {
      continue;
    }

    entries.push({
      key: difficulty.key,
      label: difficulty.label,
      rank,
      points,
    });
  }

  return entries;
}

function parseRankings(responsePayload) {
  const parsedPayload = parseRelayJsonPayload(responsePayload);
  if (!parsedPayload || !Array.isArray(parsedPayload.rankings)) {
    return [];
  }

  const entries = [];

  for (const ranking of parsedPayload.rankings) {
    if (!ranking || typeof ranking.playerName !== 'string') {
      continue;
    }

    const rank = Number.parseInt(ranking.rank, 10);
    const points = Number.parseInt(ranking.points, 10);
    const playerName = ranking.playerName.trim();

    if (!playerName || Number.isNaN(rank) || Number.isNaN(points)) {
      continue;
    }

    entries.push({
      rank,
      playerName,
      displayPlayerName: normalizeDiscordTableText(playerName),
      points,
    });
  }

  return entries;
}

function parseInfoResponse(responsePayload) {
  const parsedPayload = parseRelayJsonPayload(responsePayload);
  if (!parsedPayload || typeof parsedPayload.info !== 'object' || parsedPayload.info === null) {
    return null;
  }

  return parsedPayload.info;
}

function getDifficultyLabel(difficultyKey) {
  const relay = getRelayByDifficulty(difficultyKey);
  if (relay?.name) {
    return relay.name;
  }

  return RANK_DISPLAY_ORDER.find((difficulty) => difficulty.key === difficultyKey)?.label || difficultyKey;
}

function resolveCustomEmoji(interaction, emojiName, fallbackText) {
  const normalizedEmojiName = typeof emojiName === 'string' ? emojiName.trim().toLowerCase() : '';
  const emoji = interaction.guild?.emojis?.cache?.find(
    (guildEmoji) => typeof guildEmoji.name === 'string' && guildEmoji.name.toLowerCase() === normalizedEmojiName,
  );
  return emoji ? emoji.toString() : fallbackText;
}

function resolveGuildEmoji(interaction, emojiName) {
  return resolveCustomEmoji(interaction, emojiName, `:${emojiName}:`);
}

function formatPerkResponse(interaction, request, responsePayload) {
  if (request.commandName !== 'perk') {
    return responsePayload;
  }

  const perkEntries = parsePerkEntries(responsePayload);
  if (perkEntries.length === 0) {
    return null;
  }

  const entriesByKey = new Map(perkEntries.map((entry) => [entry.key, entry]));
  const lines = [];
  const longestLabelLength = PERK_DISPLAY_ORDER.reduce(
    (maxLength, perk) => Math.max(maxLength, perk.label.length),
    0,
  );
  const longestPrestigeLength = Math.max(
    1,
    ...perkEntries.map((entry) => String(entry.prestige).length),
  );
  const longestLevelLength = Math.max(
    1,
    ...perkEntries.map((entry) => String(entry.level).length),
  );

  for (const perk of PERK_DISPLAY_ORDER) {
    const entry = entriesByKey.get(perk.key);
    if (!entry) {
      continue;
    }

    const paddedLabel = perk.label.padEnd(longestLabelLength, ' ');
    const paddedPrestige = String(entry.prestige).padStart(longestPrestigeLength, ' ');
    const paddedLevel = String(entry.level).padStart(longestLevelLength, ' ');
    lines.push(`${resolveGuildEmoji(interaction, perk.emojiName)} \`${paddedLabel}: ${paddedPrestige}-${paddedLevel}\``);
  }

  return lines.join('\n');
}

function formatVipInfoResponse(request, responsePayload) {
  if (request.commandName !== 'vipinfo') {
    return responsePayload;
  }

  const target = formatResponseTargetDisplay(request.requestedTarget || 'User');
  const vipInfo = parseVipInfo(responsePayload);
  if (!vipInfo) {
    return null;
  }

  if (vipInfo.type.toLowerCase() === 'none' || vipInfo.daysLeft <= 0) {
    return `${target} doesn't have VIP or his VIP has already expired`;
  }

  const dayLabel = vipInfo.daysLeft === 1 ? 'day' : 'days';
  return `${target} has ${vipInfo.daysLeft} ${dayLabel} of ${vipInfo.type} VIP left`;
}

function formatOverdrivesResponse(request, responsePayload) {
  if (request.commandName !== 'overdrives') {
    return responsePayload;
  }

  const entries = parseOverdriveEntries(responsePayload);
  if (entries.length === 0) {
    return null;
  }

  const total = entries.reduce((totals, entry) => ({
    current: totals.current + entry.current,
    max: totals.max + entry.max,
  }), { current: 0, max: 0 });
  const labelWidth = Math.max(
    getDiscordTextWidth('🚩 Total'),
    ...entries.map((entry) => getDiscordTextWidth(`${entry.emoji} ${entry.label}`)),
  );
  const currentWidth = Math.max(
    String(total.current).length,
    ...entries.map((entry) => String(entry.current).length),
  );
  const maxWidth = Math.max(
    String(total.max).length,
    ...entries.map((entry) => String(entry.max).length),
  );
  const formatRow = (label, current, max) =>
    `${padEndByDiscordTextWidth(label, labelWidth)}: ${String(current).padStart(currentWidth)} / ${String(max).padStart(maxWidth)}`;
  const rowWidth = getDiscordTextWidth(formatRow('✅ Total', total.current, total.max));
  const title = 'Overdrives';
  const titlePadding = Math.max(0, Math.floor((rowWidth - getDiscordTextWidth(title)) / 2));
  const titleLine = padEndByDiscordTextWidth(`${' '.repeat(titlePadding)}${title}`, rowWidth);
  const lines = entries.map((entry) => formatRow(`${entry.emoji} ${entry.label}`, entry.current, entry.max));

  lines.unshift(titleLine);
  lines.push('', formatRow('🚩 Total', total.current, total.max));

  return lines
    .map((line) => (line ? `\`${line}\`` : ''))
    .join('\n');
}

function formatWaveTypeLabel(waveType) {
  if (!waveType) {
    return '';
  }

  const normalizedType = waveType.trim().toLowerCase();
  if (normalizedType === 'normal') {
    return 'Normal';
  }
  if (normalizedType === 'special') {
    return 'Special';
  }
  if (normalizedType === 'boss') {
    return 'Boss';
  }

  return waveType.trim();
}

function formatSignedPercent(value) {
  const numberValue = Number.parseInt(value, 10);

  if (Number.isNaN(numberValue)) {
    return null;
  }

  return `${numberValue > 0 ? '+' : ''}${numberValue}%`;
}

function formatInfoResponse(interaction, request, responsePayload) {
  if (request.commandName !== 'info') {
    return responsePayload;
  }

  const info = parseInfoResponse(responsePayload);
  if (!info) {
    return null;
  }

  const difficultyLabel = getDifficultyLabel(request.difficulty || 'server');
  const lines = [`Info of ${difficultyLabel} server:`];

  if (typeof info.mapName === 'string' && info.mapName.trim() !== '') {
    const mapParts = [`Map: ${info.mapName.trim()}`];
    const mapXp = formatSignedPercent(info.mapXP);

    if (mapXp) {
      mapParts.push(`${mapXp} XP`);
    }

    lines.push(mapParts.join(' | '));
  }

  const currentWave = Number.parseInt(info.currentWave, 10);
  const maxWaves = Number.parseInt(info.maxWaves, 10);
  const waveType = typeof info.wave?.type === 'string' ? formatWaveTypeLabel(info.wave.type) : '';
  const waveName = typeof info.wave?.name === 'string' ? info.wave.name.trim() : '';
  const waveParts = [];

  if (!Number.isNaN(currentWave) && !Number.isNaN(maxWaves)) {
    waveParts.push(`${currentWave}/${maxWaves}`);
  }
  if (waveType) {
    waveParts.push(waveType);
  }
  if (waveName) {
    waveParts.push(waveName);
  }
  if (waveParts.length > 0) {
    lines.push(`Wave: ${waveParts.join(' | ')}`);
  }

  const zedsLeft = Number.parseInt(info.zedsLeft, 10);
  const teamValue = Number.parseInt(info.teamValue, 10);
  const timeText = typeof info.time === 'string' ? info.time.trim() : '';
  const combatParts = [];

  if (!Number.isNaN(zedsLeft)) {
    combatParts.push(`Zeds left: ${zedsLeft}`);
  }
  if (timeText) {
    combatParts.push(`Time: ${timeText}`);
  }
  if (!Number.isNaN(teamValue)) {
    combatParts.push(`Team value: ${teamValue}`);
  }
  if (combatParts.length > 0) {
    lines.push(combatParts.join(' | '));
  }

  const playersAlive = Number.parseInt(info.playersAlive, 10);
  const playersDead = Number.parseInt(info.playersDead, 10);
  const playerCountParts = [];

  if (!Number.isNaN(playersAlive)) {
    playerCountParts.push(`${playersAlive} alive`);
  }
  if (!Number.isNaN(playersDead)) {
    playerCountParts.push(`${playersDead} dead`);
  }
  if (playerCountParts.length > 0) {
    lines.push(`Players: ${playerCountParts.join(', ')}`);
  }

  const multipliers = [
    typeof info.zedsHpMultiplier === 'number' ? `Zed HP x${info.zedsHpMultiplier}` : null,
    typeof info.zedsXpMultiplier === 'number' ? `Zed XP x${info.zedsXpMultiplier}` : null,
  ].filter(Boolean);
  if (multipliers.length > 0) {
    lines.push(multipliers.join(' | '));
  }

  if (Array.isArray(info.players) && info.players.length > 0) {
    const playerEntries = info.players
      .filter((player) => player && typeof player.name === 'string' && player.name.trim() !== '')
      .map((player) => ({
        name: player.name.trim(),
        displayName: normalizeDiscordTableText(player.name.trim()),
        status: typeof player.status === 'string' ? player.status.trim().toLowerCase() : 'unknown',
        country: typeof player.country === 'string' && player.country.trim() ? player.country.trim() : '--',
        hasMastery: Object.prototype.hasOwnProperty.call(player, 'mastery'),
        mastery: player.mastery,
        prestige: Number.isNaN(Number.parseInt(player.prestige, 10)) ? 0 : Number.parseInt(player.prestige, 10),
        level: Number.isNaN(Number.parseInt(player.level, 10)) ? 0 : Number.parseInt(player.level, 10),
        role: typeof player.role === 'string' ? player.role.trim() : 'Unknown',
        perk: findPerkDefinition(typeof player.role === 'string' ? player.role : ''),
      }));

    if (playerEntries.length > 0) {
      lines.push('Players:');
    }

    const usesMastery = playerEntries.length > 0 && playerEntries.every((player) =>
      player.hasMastery && !Number.isNaN(Number.parseInt(player.mastery, 10)),
    );
    const longestMasteryLength = usesMastery
      ? Math.max(1, ...playerEntries.map((player) => String(Number.parseInt(player.mastery, 10)).length))
      : 1;
    const longestPrestigeLength = Math.max(1, ...playerEntries.map((player) => String(player.prestige).length));
    const longestLevelLength = Math.max(1, ...playerEntries.map((player) => String(player.level).length));

    for (const player of playerEntries) {
      const prefix = player.perk
        ? resolveGuildEmoji(interaction, player.perk.emojiName)
        : `\`${player.role}\``;
      const statusEmoji = player.status === 'dead' ? '💀' : '❤️';
      const rankParts = [];
      if (usesMastery) {
        rankParts.push(String(Number.parseInt(player.mastery, 10)).padStart(longestMasteryLength, ' '));
      }
      const paddedPrestige = String(player.prestige).padStart(longestPrestigeLength, ' ');
      const paddedLevel = String(player.level).padStart(longestLevelLength, ' ');
      rankParts.push(paddedPrestige, paddedLevel);
      const rowParts = [rankParts.join('-'), statusEmoji, player.country, player.displayName];

      lines.push(`${prefix ? `${prefix} ` : ''}\`${rowParts.join(' | ')}\``);
    }
  }

  const bossSections = [];
  if (Array.isArray(info.bosses?.onMap)) {
    bossSections.push({
      label: 'On map',
      values: info.bosses.onMap,
    });
  }
  if (Array.isArray(info.bosses?.waitingRoom)) {
    bossSections.push({
      label: 'Waiting room',
      values: info.bosses.waitingRoom,
    });
  }

  if (bossSections.length > 0) {
    lines.push('Bosses:');

    const longestBossLabelLength = Math.max(...bossSections.map((section) => section.label.length));

    for (const section of bossSections) {
      const paddedLabel = section.label.padEnd(longestBossLabelLength, ' ');
      const bossText = section.values.length > 0 ? section.values.join(', ') : 'None';
      lines.push(`\`${paddedLabel}: ${bossText}\``);
    }
  }

  return lines.join('\n');
}

function formatRankResponse(request, responsePayload) {
  if (request.commandName !== 'rank' && request.commandName !== 'rankings') {
    return responsePayload;
  }

  const rankings = parseRankings(responsePayload);
  if (rankings.length > 0) {
    const difficultyLabel = getDifficultyLabel(request.difficulty || 'server');
    const longestPlayerNameLength = Math.max(
      1,
      ...rankings.map((entry) => getDiscordTextWidth(entry.displayPlayerName)),
    );
    const longestRankLength = Math.max(
      1,
      ...rankings.map((entry) => String(entry.rank).length),
    );
    const longestPointsLength = Math.max(
      1,
      ...rankings.map((entry) => String(entry.points).length),
    );

    const lines = [`Ranking of ${difficultyLabel} server:`];

    for (const entry of rankings) {
      const paddedPlayerName = padEndByDiscordTextWidth(entry.displayPlayerName, longestPlayerNameLength);
      const paddedRank = String(entry.rank).padStart(longestRankLength, ' ');
      const paddedPoints = String(entry.points).padStart(longestPointsLength, ' ');
      lines.push(`\`${paddedPlayerName}: ${paddedRank} with ${paddedPoints} points\``);
    }

    return lines.join('\n');
  }

  const rankEntries = parseRankEntries(responsePayload);
  if (rankEntries.length === 0) {
    return null;
  }

  const longestLabelLength = RANK_DISPLAY_ORDER.reduce(
    (maxLength, difficulty) => Math.max(maxLength, difficulty.label.length),
    0,
  );
  const longestRankLength = Math.max(
    1,
    ...rankEntries.map((entry) => String(entry.rank).length),
  );
  const longestPointsLength = Math.max(
    1,
    ...rankEntries.map((entry) => String(entry.points).length),
  );
  const projectedVipDays = rankEntries.reduce(
    (totalDays, entry) => totalDays + (entry.rank > 0 ? Math.max(11 - entry.rank, 0) : 0),
    0,
  );

  const lines = [];

  lines.push(...rankEntries.map((entry) => {
    const paddedLabel = entry.label.padEnd(longestLabelLength, ' ');
    if (entry.rank === 0) {
      return `\`${paddedLabel}: Unranked\``;
    }

    const paddedRank = String(entry.rank).padStart(longestRankLength, ' ');
    const paddedPoints = String(entry.points).padStart(longestPointsLength, ' ');
    return `\`${paddedLabel}: Rank ${paddedRank} with ${paddedPoints} points\``;
  }));

  if (projectedVipDays > 0) {
    const dayLabel = projectedVipDays === 1 ? 'day' : 'days';
    lines.push(`Based on your current rank, at the end of the month you can recieve ${projectedVipDays} VIP ${dayLabel}!`);
  }

  return lines.join('\n');
}

function formatResponseTargetDisplay(target) {
  return `"${String(target || '').trim()}"`;
}

function prependRequestedTargetHeader(request, responseText) {
  if (!request.requestedTarget) {
    return responseText;
  }

  return `Information for ${formatResponseTargetDisplay(request.requestedTarget)}:\n${responseText}`;
}

async function formatResponse(interaction, request, responsePayload) {
  let formattedResponse = responsePayload;
  const parsedPayload = parseRelayJsonPayload(responsePayload);
  const responseTarget = parsedPayload && Object.prototype.hasOwnProperty.call(parsedPayload, 'target')
    ? await resolveResponseTargetDisplay(parsedPayload.target)
    : '';
  const effectiveRequest = responseTarget
    ? { ...request, requestedTarget: responseTarget }
    : request;

  if (request.raw) {
    return prependRequestedTargetHeader(effectiveRequest, responsePayload);
  }

  if (!parsedPayload) {
    return prependRequestedTargetHeader(effectiveRequest, FORMAT_RESPONSE_ERROR_MESSAGE);
  }

  if (parsedPayload && typeof parsedPayload.error === 'string' && parsedPayload.error.trim() !== '') {
    if (effectiveRequest.commandName === 'vipinfo') {
      const target = formatResponseTargetDisplay(effectiveRequest.requestedTarget || 'User');
      return prependRequestedTargetHeader(effectiveRequest, `${target}: ${parsedPayload.error.trim()}`);
    }
    return prependRequestedTargetHeader(effectiveRequest, parsedPayload.error.trim());
  }

  if (effectiveRequest.commandName === 'perk') {
    formattedResponse = formatPerkResponse(interaction, effectiveRequest, responsePayload);
  } else if (effectiveRequest.commandName === 'info') {
    formattedResponse = formatInfoResponse(interaction, effectiveRequest, responsePayload);
  } else if (effectiveRequest.commandName === 'vipinfo') {
    formattedResponse = formatVipInfoResponse(effectiveRequest, responsePayload);
  } else if (effectiveRequest.commandName === 'overdrives') {
    formattedResponse = formatOverdrivesResponse(effectiveRequest, responsePayload);
  } else if (effectiveRequest.commandName === 'rank' || effectiveRequest.commandName === 'rankings') {
    formattedResponse = formatRankResponse(effectiveRequest, responsePayload);
  }

  if (!formattedResponse) {
    return prependRequestedTargetHeader(effectiveRequest, FORMAT_RESPONSE_ERROR_MESSAGE);
  }

  return prependRequestedTargetHeader(effectiveRequest, formattedResponse);
}

function getInteractionUserMention(interaction) {
  return interaction.user?.id ? `<@${interaction.user.id}>` : '@unknown-user';
}

function wrapFormattedResponse(interaction, request, responseText) {
  const separator = '-----------------------------------------------';
  return `${separator}\n${getInteractionUserMention(interaction)}\n${responseText}\n${separator}`;
}

async function postResponse(interaction, request, responsePayload, successMessage) {
  const formattedResponse = wrapFormattedResponse(
    interaction,
    request,
    await formatResponse(interaction, request, responsePayload),
  );

  if (request.hidden) {
    await editDiscordReply(interaction, {
      content: formattedResponse,
    });
    return;
  }

  await sendDiscordMessage(interaction.channel, {
    content: formattedResponse,
  });
  await editDiscordReply(interaction, {
    content: successMessage,
  });
}

function sendPayloadToRelay(relay, payload) {
  if (!relay.connection) {
    return Promise.reject(new Error(`No KF2 connection is available for "${relay.difficulty}".`));
  }

  return relay.connection.sendRequest(payload);
}

async function processRelayQueue(difficulty) {
  if (processingDifficulties.has(difficulty)) {
    return;
  }

  processingDifficulties.add(difficulty);
  const queue = getRelayQueue(difficulty);

  try {
    while (queue.length > 0) {
      const job = queue[0];

      try {
        const relay = getRelayByDifficulty(difficulty);

        if (!relay) {
          throw new Error('Selected difficulty is not active right now.');
        }

        if (job.wasQueued) {
          await editDiscordReply(job.interaction, {
            content: `Your request for "${difficulty}" is now being processed...`,
          });
        }

        const responsePayload = await sendPayloadToRelay(relay, job.request.payload);
        await postResponse(
          job.interaction,
          job.request,
          responsePayload,
          `Sent to KF2 server "${difficulty}" and posted the response.`,
        );
      } catch (error) {
        logError(`Failed to process command: ${error.message || error}`);
        await editDiscordReply(job.interaction, {
          content: error.message || 'Failed to process the request.',
        }).catch(() => {});
      } finally {
        queue.shift();
      }
    }
  } finally {
    processingDifficulties.delete(difficulty);

    if (queue.length === 0) {
      relayQueues.delete(difficulty);
    }
  }
}

async function enqueueRelayRequest(interaction, request) {
  const queue = getRelayQueue(request.difficulty);
  const isAlreadyBusy = processingDifficulties.has(request.difficulty) || queue.length > 0;

  queue.push({
    interaction,
    request,
    wasQueued: isAlreadyBusy,
  });

  const queuePosition = queue.length + (processingDifficulties.has(request.difficulty) ? 1 : 0);

  if (isAlreadyBusy) {
    await editDiscordReply(interaction, {
      content: `Please wait until the previous request for "${request.difficulty}" is done. Your request is queued${queuePosition > 1 ? ` (position ${queuePosition})` : ''}.`,
    });
  }

  void processRelayQueue(request.difficulty);
}

function buildExampleVoteConfig(difficulty) {
  const selectedDifficulty = difficulty || getActiveDifficulties()[0] || 'normal';
  const relay = getRelayByDifficulty(selectedDifficulty);

  if (relay?.connection?.config) {
    return relay.connection.config;
  }

  return {
    index: 'example',
    name: getDifficultyLabel(selectedDifficulty),
    difficulty: selectedDifficulty,
    kickVoteChannelIds: KF2_KICK_VOTE_DISCORD_CHANNEL_IDS,
    pauseSkipVoteChannelIds: KF2_PAUSE_SKIP_VOTE_DISCORD_CHANNEL_IDS,
  };
}

async function buildExampleRequest(interaction) {
  ensureExampleAccess(interaction);

  const commandName = interaction.options.getString('command', true);
  const difficulty = interaction.options.getString('difficulty');
  const targetInput = interaction.options.getString('target')?.trim();
  const responsePayload = interaction.options.getString('response', true).trim();
  const hidden = interaction.options.getBoolean('hidden') || false;
  const raw = resolveRawOption(interaction);

  if (!responsePayload) {
    throw new Error('Provide a response payload for /example.');
  }

  if (commandName === 'vote') {
    const votePayload = parseVotePayload(responsePayload);
    if (!votePayload) {
      throw new Error('Provide a valid vote JSON payload for /example vote.');
    }

    return {
      commandName,
      difficulty,
      responsePayload,
      hidden,
      raw,
      votePayload,
    };
  }

  if (commandName === 'target') {
    const resolutionInput = targetInput || responsePayload;
    return {
      commandName,
      targetInput: resolutionInput,
      responsePayload,
      hidden,
      raw,
    };
  }

  if (commandName === 'month-ranking-rewards') {
    const monthRankingRewardsPayload = parseMonthRankingRewardsPayload(responsePayload);
    if (!monthRankingRewardsPayload) {
      throw new Error('Provide a valid month-ranking-rewards JSON payload for /example.');
    }

    return {
      commandName,
      responsePayload,
      hidden,
      raw,
      monthRankingRewardsPayload,
    };
  }

  const resolvedTarget = targetInput
    ? await resolvePlayerTarget(targetInput)
    : null;

  return {
    commandName,
    difficulty,
    requestedTarget: resolvedTarget?.display || null,
    responsePayload,
    hidden,
    raw,
  };
}

async function handleExampleCommand(interaction, request) {
  if (request.commandName === 'month-ranking-rewards') {
    const chunks = await splitMonthlyRankingRewardsMessage(request.monthRankingRewardsPayload);

    if (request.hidden) {
      await editDiscordReply(interaction, {
        content: chunks.shift() || 'No monthly reward summary was generated.',
      });

      for (const chunk of chunks) {
        await followUpDiscordInteraction(interaction, {
          content: chunk,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    for (const chunk of chunks) {
      await sendDiscordMessage(interaction.channel, {
        content: chunk,
      });
    }

    await editDiscordReply(interaction, {
      content: 'Posted example response for "/month-ranking-rewards".',
    });
    return;
  }

  if (request.commandName === 'target') {
    const parsedResponsePayload = parseRelayJsonPayload(request.responsePayload);
    if (parsedResponsePayload && Object.prototype.hasOwnProperty.call(parsedResponsePayload, 'target')) {
      try {
        await editDiscordReply(interaction, {
          content: await formatResponseTargetResolutionExample(request.responsePayload),
        });
      } catch (error) {
        await editDiscordReply(interaction, {
          content: [
            `Response: ${suppressDiscordLinkEmbeds(request.responsePayload)}`,
            'Response target resolution failed.',
            `Reason: ${error.message || error}`,
          ].join('\n'),
        });
      }
      return;
    }

    try {
      const target = await resolvePlayerTarget(request.targetInput);
      await editDiscordReply(interaction, {
        content: formatTargetResolutionExample(request.targetInput, target),
      });
    } catch (error) {
      await editDiscordReply(interaction, {
        content: [
          `Input: ${suppressDiscordLinkEmbeds(request.targetInput)}`,
          'Target resolution failed.',
          `Reason: ${error.message || error}`,
        ].join('\n'),
      });
    }
    return;
  }

  if (request.commandName === 'vote') {
    await handleKf2VotePayload(buildExampleVoteConfig(request.difficulty), request.votePayload);
    await editDiscordReply(interaction, {
      content: `Processed example vote response for "${getDifficultyLabel(request.difficulty || getActiveDifficulties()[0] || 'normal')}".`,
    });
    return;
  }

  await postResponse(
    interaction,
    {
      commandName: request.commandName,
      difficulty: request.difficulty,
      requestedTarget: request.requestedTarget,
      hidden: request.hidden,
      raw: request.raw,
    },
    request.responsePayload,
    `Posted example response for "/${request.commandName}".`,
  );
}

async function handleAutocomplete(interaction) {
  const focusedOption = interaction.options.getFocused(true);

  if (focusedOption.name !== 'difficulty') {
    await interaction.respond([]);
    return;
  }

  const search = String(focusedOption.value || '').toLowerCase();
  const availableDifficulties = getActiveDifficulties();

  if (availableDifficulties.length === 0) {
    await interaction.respond([
      {
        name: 'No active difficulties found',
        value: NO_DIFFICULTY_VALUE,
      },
    ]);
    return;
  }

  const choices = availableDifficulties
    .filter((difficulty) => difficulty.toLowerCase().includes(search))
    .slice(0, 25)
    .map((difficulty) => ({
      name: difficulty,
      value: difficulty,
    }));

  await interaction.respond(choices);
}

async function validateSteamApiKeyOnStartup() {
  if (!activeSteamApiKey) {
    return;
  }

  try {
    const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/');
    url.searchParams.set('key', activeSteamApiKey);
    url.searchParams.set('steamids', '76561197960265728');

    const response = await fetch(url);
    if (response.status === 401 || response.status === 403) {
      activeSteamApiKey = '';
      logWarn('STEAM_API_KEY is invalid; continuing with Steam lookups disabled.');
      return;
    }

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    logInfo('STEAM_API_KEY validated successfully.');
  } catch (error) {
    logWarn(`Could not validate STEAM_API_KEY: ${error.message || error}`);
  }
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);

  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: commandDefinitions.map((command) => command.toJSON()),
  });

  logInfo(
    `Registered commands: ${commandDefinitions.map((command) => `/${command.name}`).join(', ')}`,
  );
}

function getMessageDisplayName(message) {
  return message.member?.displayName || message.author.globalName || message.author.username;
}

function initializeKf2Connections() {
  const serverConfigs = loadServerConfigs();

  if (serverConfigs.length === 0) {
    logWarn('No KF2 servers are enabled. Set KF2_SERVER_1_ENABLED=true and related settings in .env.');
  }

  applyServerConfigs(serverConfigs);
  watchEnvFileForServerConfigChanges();
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (readyClient) => {
  logInfo(`Logged in as ${readyClient.user.tag}`);
  try {
    await validateSteamApiKeyOnStartup();
    initializeKf2Connections();
  } catch (error) {
    logError(error.message || error);
    process.exit(1);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) {
    return;
  }

  const matchingConnections = kf2Connections.filter((connection) =>
    connection.config.forwardDiscordToKf2
    && connection.config.channelIds.includes(message.channelId),
  );

  if (matchingConnections.length === 0) {
    return;
  }

  const payload = `[Discord] ${getMessageDisplayName(message)}: ${message.content}`;

  for (const connection of matchingConnections) {
    try {
      connection.sendMessage(payload);
    } catch (error) {
      logWarn(`Failed to forward Discord message to "${connection.config.name}": ${error.message || error}`);
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    if (KNOWN_COMMANDS.includes(interaction.commandName)) {
      await handleAutocomplete(interaction).catch((error) => {
        logError(`Failed to handle autocomplete: ${error.message || error}`);
      });
    }
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (!KNOWN_COMMANDS.includes(interaction.commandName)) {
    return;
  }

  try {
    if (interaction.commandName === 'help') {
      const requestedHidden = interaction.options.getBoolean('hidden') || false;
      const availabilityResult = checkCommandTokenAvailability(interaction, requestedHidden);
      if (!availabilityResult.allowed) {
        await replyDiscordInteraction(interaction, {
          content: availabilityResult.message,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const tokenResult = consumeCommandToken(interaction, requestedHidden);
      if (!tokenResult.allowed) {
        await replyDiscordInteraction(interaction, {
          content: tokenResult.message,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await replyDiscordInteraction(interaction, {
        content: wrapFormattedResponse(interaction, {}, buildHelpMessage()),
        flags: tokenResult.hidden ? MessageFlags.Ephemeral : undefined,
      });
      return;
    }

    await deferDiscordReply(interaction, {
      flags: MessageFlags.Ephemeral,
    });

    if (interaction.commandName === 'example') {
      const requestedHidden = interaction.options.getBoolean('hidden') || false;
      const availabilityResult = checkCommandTokenAvailability(interaction, requestedHidden);
      if (!availabilityResult.allowed) {
        await editDiscordReply(interaction, {
          content: availabilityResult.message,
        });
        return;
      }

      const request = await buildExampleRequest(interaction);
      const tokenResult = consumeCommandToken(interaction, request.hidden);
      if (!tokenResult.allowed) {
        await editDiscordReply(interaction, {
          content: tokenResult.message,
        });
        return;
      }

      request.hidden = tokenResult.hidden;
      await handleExampleCommand(interaction, request);
      return;
    }

    const requestedHidden = interaction.options.getBoolean('hidden') || false;
    const availabilityResult = checkCommandTokenAvailability(interaction, requestedHidden);
    if (!availabilityResult.allowed) {
      await editDiscordReply(interaction, {
        content: availabilityResult.message,
      });
      return;
    }

    const request = await buildRelayRequest(interaction);
    const tokenResult = consumeCommandToken(interaction, request.hidden);
    if (!tokenResult.allowed) {
      await editDiscordReply(interaction, {
        content: tokenResult.message,
      });
      return;
    }

    request.hidden = tokenResult.hidden;
    await enqueueRelayRequest(interaction, request);
  } catch (error) {
    if (!error?.suppressConsoleLog) {
      logError(`Failed to process command: ${error.message || error}`);
    }

    const response = {
      content: error.message || 'Failed to process the request.',
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.deferred) {
      await editDiscordReply(interaction, {
        content: response.content,
      }).catch(() => {});
      return;
    }

    if (interaction.replied) {
      await followUpDiscordInteraction(interaction, response).catch(() => {});
      return;
    }

    await replyDiscordInteraction(interaction, response).catch(() => {});
  }
});

envFileSnapshot = readEnvSnapshotFromFile();
loadCommandTokenState();
scheduleCommandTokenReset();
scheduleWebhookRetryQueue();

(async () => {
  await registerCommands();
  await client.login(TOKEN);
})().catch((error) => {
  logError(error.message || error);
  process.exit(1);
});
