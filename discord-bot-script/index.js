try {
  require('dotenv').config();
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
}

const fs = require('fs');
const net = require('net');
const path = require('path');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const HEARTBEAT_DIR = process.env.HEARTBEAT_DIR
  ? path.resolve(process.env.HEARTBEAT_DIR)
  : path.resolve(__dirname, '..', 'heartbeat');
const HEARTBEAT_TTL_MS = Number.parseInt(process.env.HEARTBEAT_TTL_MS || '60000', 10);
const HEARTBEAT_REFRESH_MS = 30000;
const RELAY_HOST = process.env.RELAY_HOST || '127.0.0.1';
const RELAY_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.RELAY_REQUEST_TIMEOUT_MS || '60000', 10);
const SPECIAL_ACCESS_ROLE_IDS = (process.env.SPECIAL_ACCESS_ROLE_IDS || '')
  .split(',')
  .map((roleId) => roleId.trim())
  .filter(Boolean);

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in .env');
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
      .setDescription('Post the raw relay response without formatting (restricted by role)')
      .setRequired(false),
  );
}

function addDifficultyOptionWithRequired(commandBuilder, required) {
  return commandBuilder.addStringOption((option) =>
    option
      .setName('difficulty')
      .setDescription('Difficulty from active relay heartbeat files.')
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
      .setDescription('Send a server info request to the matching relay'),
  ))),
  addRawOption(addHiddenOption(
    new SlashCommandBuilder()
      .setName('perk')
      .setDescription('Send a perk request to the first active relay')
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
    .setDescription('Send a VIP info request to the first active relay')
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
      .setDescription('Send a rank request to the matching relay')
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
      .setDescription('Preview a response payload without using a relay')
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
          .setDescription('Text to treat as the relay response payload')
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

function scanActiveRelays() {
  if (!fs.existsSync(HEARTBEAT_DIR)) {
    return [];
  }

  const now = Date.now();
  const relays = [];

  for (const fileName of fs.readdirSync(HEARTBEAT_DIR)) {
    if (!fileName.toLowerCase().endsWith('.json')) {
      continue;
    }

    const filePath = path.join(HEARTBEAT_DIR, fileName);

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const heartbeat = JSON.parse(raw);

      if (typeof heartbeat.difficulty !== 'string' || heartbeat.difficulty.trim() === '') {
        continue;
      }

      if (heartbeat.difficulty === '0') {
        continue;
      }

      if (typeof heartbeat.updatedAt !== 'number') {
        continue;
      }

      if (now - heartbeat.updatedAt > HEARTBEAT_TTL_MS) {
        continue;
      }

      const discordBotPort = Number.isInteger(heartbeat.discordBotPort)
        ? heartbeat.discordBotPort
        : null;

      if (!discordBotPort) {
        continue;
      }

      relays.push({
        difficulty: heartbeat.difficulty.trim(),
        port: heartbeat.port,
        discordBotPort,
        updatedAt: heartbeat.updatedAt,
      });
    } catch (error) {
      console.warn(`Skipping invalid heartbeat file: ${filePath}`, error.message);
    }
  }

  return relays;
}

function refreshActiveRelays() {
  const relays = scanActiveRelays();
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
        prestige: Number.isNaN(Number.parseInt(player.prestige, 10)) ? 0 : Number.parseInt(player.prestige, 10),
        level: Number.isNaN(Number.parseInt(player.level, 10)) ? 0 : Number.parseInt(player.level, 10),
        role: typeof player.role === 'string' ? player.role.trim() : 'Unknown',
        perk: findPerkDefinition(typeof player.role === 'string' ? player.role : ''),
      }));

    if (playerEntries.length > 0) {
      lines.push('Players:');
    }

    const longestNameLength = Math.max(1, ...playerEntries.map((player) => player.name.length));
    const longestPrestigeLength = Math.max(1, ...playerEntries.map((player) => String(player.prestige).length));
    const longestLevelLength = Math.max(1, ...playerEntries.map((player) => String(player.level).length));

    for (const player of playerEntries) {
      const prefix = player.perk
        ? resolveGuildEmoji(interaction, player.perk.emojiName)
        : `\`${player.role}\``;
      const statusEmoji = player.status === 'dead' ? '💀' : '❤️';
      const rowParts = [player.name.padEnd(longestNameLength, ' '), statusEmoji, player.country];
      const paddedPrestige = String(player.prestige).padStart(longestPrestigeLength, ' ');
      const paddedLevel = String(player.level).padStart(longestLevelLength, ' ');
      rowParts.push(`${paddedPrestige}-${paddedLevel}`);

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
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: RELAY_HOST,
      port: relay.discordBotPort,
    });

    let buffer = '';
    let settled = false;

    const fail = (message) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      reject(new Error(message));
    };

    socket.setTimeout(RELAY_REQUEST_TIMEOUT_MS);

    socket.once('connect', () => {
      const requestLine = JSON.stringify({ payload });
      socket.write(`${requestLine}\n`);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newlineIndex = buffer.indexOf('\n');

      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      if (!line) {
        fail('Relay returned an empty response.');
        return;
      }

      try {
        const response = JSON.parse(line);

        if (response.error) {
          fail(response.error);
          return;
        }

        if (typeof response.payload !== 'string' || response.payload.trim() === '') {
          fail('Relay returned an invalid payload.');
          return;
        }

        if (!settled) {
          settled = true;
          socket.end();
          resolve(response.payload.trim());
        }
      } catch (error) {
        fail('Relay returned malformed JSON.');
      }
    });

    socket.on('timeout', () => {
      fail('Timed out waiting for the relay response.');
    });

    socket.on('error', (error) => {
      fail(`Failed to connect to relay on port ${relay.discordBotPort}: ${error.message}`);
    });

    socket.on('close', () => {
      if (!settled) {
        fail('Relay closed the connection before sending a response.');
      }
    });
  });
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
          `Sent to relay "${difficulty}" and posted the response.`,
        );
      } catch (error) {
        console.error(`Failed to process command: ${error.message || error}`);
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

  console.log(
    `Registered commands: ${commandDefinitions.map((command) => `/${command.name}`).join(', ')}`,
  );
  console.log(`Heartbeat directory: ${HEARTBEAT_DIR}`);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Active difficulties: ${activeDifficulties.join(', ') || 'none'}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    if (KNOWN_COMMANDS.includes(interaction.commandName)) {
      await handleAutocomplete(interaction).catch((error) => {
        console.error(`Failed to handle autocomplete: ${error.message || error}`);
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
      console.error(`Failed to process command: ${error.message || error}`);
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
  refreshActiveRelays();
  setInterval(refreshActiveRelays, HEARTBEAT_REFRESH_MS);
  await registerCommands();
  await client.login(TOKEN);
})();
