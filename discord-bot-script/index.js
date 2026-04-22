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

const ENV_FILE_PATH = path.resolve(__dirname, '.env');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const STEAM_API_KEY = process.env.STEAM_API_KEY || '';
const CDA_AVATAR_URL = process.env.CDA_AVATAR_URL || '';
const KF2_SERVER_MESSAGE_STEAM_ID = '0x011000010A2A86B6';
const KF2_SERVER_COUNT = 5;
const KF2_RECONNECT_DELAY_MS = Number.parseInt(process.env.KF2_RECONNECT_DELAY_MS || '30000', 10);
const KF2_CONNECT_TIMEOUT_MS = Number.parseInt(process.env.KF2_CONNECT_TIMEOUT_MS || '5000', 10);
const KF2_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.KF2_REQUEST_TIMEOUT_MS || '60000', 10);
const SPECIAL_ACCESS_ROLE_IDS = (process.env.SPECIAL_ACCESS_ROLE_IDS || '')
  .split(',')
  .map((roleId) => roleId.trim())
  .filter(Boolean);

function formatLogTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${year}.${month}.${day} ${hours}:${minutes}`;
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

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  logError('Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in .env');
  process.exit(1);
}

const {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

const KNOWN_COMMANDS = ['info', 'perk', 'vipinfo', 'rank', 'example'];
const NO_DIFFICULTY_VALUE = '__no_active_difficulties__';
const DIFFICULTY_ORDER = ['normal', 'hard', 'suicidal', 'hoe', 'extreme'];
const RANK_DISPLAY_ORDER = [
  { key: 'normal', label: 'Normal' },
  { key: 'hard', label: 'Hard' },
  { key: 'suicidal', label: 'Suicidal' },
  { key: 'hoe', label: 'HoE' },
  { key: 'extreme', label: 'Extreme' },
];
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
let activeRelayMap = new Map();
let activeDifficulties = [];
const relayQueues = new Map();
const processingDifficulties = new Set();
const kf2Connections = [];
let envReloadTimer = null;

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
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
    channelId: (env[`${prefix}DISCORD_CHANNEL_ID`] || '').trim(),
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

function readEnvFileForServerConfigs() {
  if (!dotenv) {
    throw new Error('dotenv is required for live .env reloads.');
  }

  const rawEnv = fs.readFileSync(ENV_FILE_PATH, 'utf8');
  const parsedEnv = dotenv.parse(rawEnv);
  const configEnv = { ...process.env };

  for (const key of Object.keys(configEnv)) {
    if (/^KF2_SERVER_\d+_/.test(key)) {
      delete configEnv[key];
    }
  }

  return {
    ...configEnv,
    ...parsedEnv,
  };
}

function reloadServerConfigsFromEnvFile() {
  try {
    const serverConfigs = loadServerConfigs(readEnvFileForServerConfigs());
    applyServerConfigs(serverConfigs);
    logInfo(`Reloaded KF2 server config from ${ENV_FILE_PATH}`);
  } catch (error) {
    logError(`Failed to reload KF2 server config: ${error.message || error}`);
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
        reloadServerConfigsFromEnvFile();
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
    new SlashCommandBuilder()
      .setName('perk')
      .setDescription('Send a perk request to the first connected KF2 server')
      .addStringOption((option) =>
        option
          .setName('nickname')
          .setDescription('Discord nickname or Steam nickname')
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('steamid')
          .setDescription('Steam ID64')
          .setRequired(false),
      ),
  )),
  addRawOption(addHiddenOption(new SlashCommandBuilder()
    .setName('vipinfo')
    .setDescription('Send a VIP info request to the first connected KF2 server')
    .addStringOption((option) =>
      option
        .setName('nickname')
        .setDescription('Discord nickname or Steam nickname')
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('steamid')
        .setDescription('Steam ID64')
        .setRequired(false),
    ))),
  addRawOption(addHiddenOption(addDifficultyOptionWithRequired(
    new SlashCommandBuilder()
      .setName('rank')
      .setDescription('Send a rank request to the matching KF2 server')
      .addStringOption((option) =>
        option
          .setName('nickname')
          .setDescription('Steam nickname')
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('steamid')
          .setDescription('Steam ID64')
          .setRequired(false),
      ),
    false,
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
            { name: 'rank', value: 'rank' },
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
          .setDescription('Difficulty to mimic for commands like /rank or /info')
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
          .setDescription('Player label to show in formatted examples like /perk')
          .setRequired(false),
      ),
  )),
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
  if (!STEAM_API_KEY || !steamId) {
    return '';
  }

  try {
    const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/');
    url.searchParams.set('key', STEAM_API_KEY);
    url.searchParams.set('steamids', steamId);

    const response = await fetch(url);
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

async function sendWebhookMessage(webhookUrl, payload) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
}

async function forwardKf2ChatToDiscord(config, chatMessage) {
  if (!config.forwardKf2ToDiscord || !config.channelId) {
    return;
  }

  const avatarUrl = chatMessage.avatarUrl || await resolveSteamAvatarUrl(chatMessage.steamId, chatMessage.username);

  try {
    if (config.webhookUrl) {
      if (!avatarUrl) {
        logWarn(`Posting webhook message for ${chatMessage.username} without avatar_url.`);
      }

      await sendWebhookMessage(config.webhookUrl, {
        username: chatMessage.username,
        avatar_url: avatarUrl || undefined,
        content: chatMessage.content,
      });
      return;
    }

    const channel = await client.channels.fetch(config.channelId);
    if (!channel || typeof channel.send !== 'function') {
      logWarn(`Cannot find Discord channel ${config.channelId} for ${config.name}.`);
      return;
    }

    await channel.send(`[${config.name}] ${chatMessage.username}: ${chatMessage.content}`);
  } catch (error) {
    logWarn(`Failed to forward KF2 chat from ${config.name} to Discord: ${error.message || error}`);
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
        logWarn(`Lost connection to KF2 server "${this.config.name}". Retrying in ${Math.round(KF2_RECONNECT_DELAY_MS / 1000)} seconds...`);
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
      logWarn(`Failed to decode KF2 message from "${this.config.name}": ${error.message || error}`);
      return;
    }

    if (this.tryHandleDsResponse(message)) {
      return;
    }

    try {
      const chatMessage = parseKf2ChatPayload(message, this.config);
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

function buildRelayRequest(interaction) {
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
    const relay = getDefaultRelay();

    if (!relay) {
      throw new Error('No active difficulties are available right now.');
    }

    const nickname = interaction.options.getString('nickname');
    const steamId = interaction.options.getString('steamid');

    if (!nickname && !steamId) {
      throw new Error('Provide either nickname or steamid for /vipinfo.');
    }

    if (nickname && steamId) {
      throw new Error('Use either nickname or steamid for /vipinfo, not both.');
    }

    if (steamId && !isValidSteamId64(steamId)) {
      throw new Error('Invalid steamid. Provide a valid SteamID64.');
    }

    return {
      commandName,
      difficulty: relay.difficulty,
      payload: nickname
        ? `/dsrequest vipinfo nickname:${nickname.trim()}`
        : `/dsrequest vipinfo steamid:${steamId.trim()}`,
      hidden,
      raw,
    };
  }

  if (commandName === 'perk') {
    const relay = getDefaultRelay();

    if (!relay) {
      throw new Error('No active difficulties are available right now.');
    }

    const nickname = interaction.options.getString('nickname');
    const steamId = interaction.options.getString('steamid');

    if (!nickname && !steamId) {
      throw new Error('Provide either nickname or steamid for /perk.');
    }

    if (nickname && steamId) {
      throw new Error('Use either nickname or steamid for /perk, not both.');
    }

    if (steamId && !isValidSteamId64(steamId)) {
      throw new Error('Invalid steamid. Provide a valid SteamID64.');
    }

    return {
      commandName,
      difficulty: relay.difficulty,
      requestedTarget: nickname ? nickname.trim() : steamId.trim(),
      payload: nickname
        ? `/dsrequest perk nickname:${nickname.trim()}`
        : `/dsrequest perk steamid:${steamId.trim()}`,
      hidden,
      raw,
    };
  }

  const selectedDifficulty = interaction.options.getString('difficulty');
  const nickname = interaction.options.getString('nickname');
  const steamId = interaction.options.getString('steamid');
  const providedOptions = [selectedDifficulty, nickname, steamId].filter(Boolean).length;

  if (providedOptions !== 1) {
    throw new Error('Use exactly one option for /rank: difficulty, nickname, or steamid.');
  }

  if (steamId && !isValidSteamId64(steamId)) {
    throw new Error('Invalid steamid. Provide a valid SteamID64.');
  }

  if (selectedDifficulty) {
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

  const relay = getDefaultRelay();

  if (!relay) {
    throw new Error('No active difficulties are available right now.');
  }

  return {
    commandName,
    difficulty: relay.difficulty,
    payload: nickname
      ? `/dsrequest rank nickname:${nickname.trim()}`
      : `/dsrequest rank steamid:${steamId.trim()}`,
    hidden,
    raw,
  };
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
    return responsePayload;
  }

  const entriesByKey = new Map(perkEntries.map((entry) => [entry.key, entry]));
  const lines = [request.requestedTarget || 'Player'];
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

  const vipInfo = parseVipInfo(responsePayload);
  if (!vipInfo) {
    return responsePayload;
  }

  if (vipInfo.type.toLowerCase() === 'none' || vipInfo.daysLeft <= 0) {
    return `You don't have VIP or your VIP already expired`;
  }

  const dayLabel = vipInfo.daysLeft === 1 ? 'day' : 'days';
  return `You have ${vipInfo.daysLeft} ${dayLabel} of ${vipInfo.type} VIP left`;
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

function formatInfoResponse(interaction, request, responsePayload) {
  if (request.commandName !== 'info') {
    return responsePayload;
  }

  const info = parseInfoResponse(responsePayload);
  if (!info) {
    return responsePayload;
  }

  const difficultyLabel = getDifficultyLabel(request.difficulty || 'server');
  const lines = [`Info of ${difficultyLabel} server:`];

  if (typeof info.mapName === 'string' && info.mapName.trim() !== '') {
    const mapParts = [`Map: ${info.mapName.trim()}`];
    const mapXp = Number.parseInt(info.mapXP, 10);

    if (!Number.isNaN(mapXp)) {
      mapParts.push(`+${mapXp}% XP`);
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
    const longestNameLength = Math.max(1, ...playerEntries.map((player) => player.name.length));
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
      const rowParts = [player.name.padEnd(longestNameLength, ' '), statusEmoji, player.country];
      const rankParts = [];
      if (usesMastery) {
        rankParts.push(String(Number.parseInt(player.mastery, 10)).padStart(longestMasteryLength, ' '));
      }
      const paddedPrestige = String(player.prestige).padStart(longestPrestigeLength, ' ');
      const paddedLevel = String(player.level).padStart(longestLevelLength, ' ');
      rankParts.push(paddedPrestige, paddedLevel);
      rowParts.push(rankParts.join('-'));

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
  if (request.commandName !== 'rank') {
    return responsePayload;
  }

  const rankings = parseRankings(responsePayload);
  if (rankings.length > 0) {
    const difficultyLabel = getDifficultyLabel(request.difficulty || 'server');
    const longestPlayerNameLength = Math.max(
      1,
      ...rankings.map((entry) => entry.playerName.length),
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
      const paddedPlayerName = entry.playerName.padEnd(longestPlayerNameLength, ' ');
      const paddedRank = String(entry.rank).padStart(longestRankLength, ' ');
      const paddedPoints = String(entry.points).padStart(longestPointsLength, ' ');
      lines.push(`\`${paddedPlayerName}: ${paddedRank} with ${paddedPoints} points\``);
    }

    return lines.join('\n');
  }

  const rankEntries = parseRankEntries(responsePayload);
  if (rankEntries.length === 0) {
    return responsePayload;
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
    (totalDays, entry) => totalDays + Math.max(11 - entry.rank, 0),
    0,
  );

  const lines = rankEntries.map((entry) => {
    const paddedLabel = entry.label.padEnd(longestLabelLength, ' ');
    const paddedRank = String(entry.rank).padStart(longestRankLength, ' ');
    const paddedPoints = String(entry.points).padStart(longestPointsLength, ' ');
    return `\`${paddedLabel}: Rank ${paddedRank} with ${paddedPoints} points\``;
  });

  if (projectedVipDays > 0) {
    const dayLabel = projectedVipDays === 1 ? 'day' : 'days';
    lines.push(`Based on your current rank, at the end of the month you can recieve ${projectedVipDays} VIP ${dayLabel}!`);
  }

  return lines.join('\n');
}

function formatResponse(interaction, request, responsePayload) {
  if (request.raw) {
    return responsePayload;
  }

  const parsedPayload = parseRelayJsonPayload(responsePayload);
  if (parsedPayload && typeof parsedPayload.error === 'string' && parsedPayload.error.trim() !== '') {
    return parsedPayload.error.trim();
  }

  if (request.commandName === 'perk') {
    return formatPerkResponse(interaction, request, responsePayload);
  }

  if (request.commandName === 'info') {
    return formatInfoResponse(interaction, request, responsePayload);
  }

  if (request.commandName === 'vipinfo') {
    return formatVipInfoResponse(request, responsePayload);
  }

  if (request.commandName === 'rank') {
    return formatRankResponse(request, responsePayload);
  }

  return responsePayload;
}

function wrapFormattedResponse(request, responseText) {
  const separator = '-----------------------------------------------';
  return `${separator}\n${responseText}\n${separator}`;
}

async function postResponse(interaction, request, responsePayload, successMessage) {
  const formattedResponse = wrapFormattedResponse(
    request,
    formatResponse(interaction, request, responsePayload),
  );

  if (request.hidden) {
    await interaction.editReply({
      content: formattedResponse,
    });
    return;
  }

  await interaction.channel.send(formattedResponse);
  await interaction.editReply({
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
          await job.interaction.editReply({
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
        await job.interaction.editReply({
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
    await interaction.editReply({
      content: `Please wait until the previous request for "${request.difficulty}" is done. Your request is queued${queuePosition > 1 ? ` (position ${queuePosition})` : ''}.`,
    });
  }

  void processRelayQueue(request.difficulty);
}

async function handleExampleCommand(interaction) {
  ensureExampleAccess(interaction);

  const commandName = interaction.options.getString('command', true);
  const difficulty = interaction.options.getString('difficulty');
  const requestedTarget = interaction.options.getString('target')?.trim();
  const responsePayload = interaction.options.getString('response', true).trim();
  const hidden = interaction.options.getBoolean('hidden') || false;
  const raw = resolveRawOption(interaction);

  if (!responsePayload) {
    throw new Error('Provide a response payload for /example.');
  }

  await postResponse(
    interaction,
    {
      commandName,
      difficulty,
      requestedTarget,
      hidden,
      raw,
    },
    responsePayload,
    `Posted example response for "/${commandName}".`,
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

client.once(Events.ClientReady, (readyClient) => {
  logInfo(`Logged in as ${readyClient.user.tag}`);
  try {
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
    && connection.config.channelId === message.channelId,
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
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    if (interaction.commandName === 'example') {
      await handleExampleCommand(interaction);
      return;
    }

    const request = buildRelayRequest(interaction);
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
      await interaction.editReply({
        content: response.content,
      }).catch(() => {});
      return;
    }

    if (interaction.replied) {
      await interaction.followUp(response).catch(() => {});
      return;
    }

    await interaction.reply(response).catch(() => {});
  }
});

(async () => {
  await registerCommands();
  await client.login(TOKEN);
})().catch((error) => {
  logError(error.message || error);
  process.exit(1);
});
