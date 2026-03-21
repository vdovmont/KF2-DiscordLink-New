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

const KNOWN_COMMANDS = ['info', 'perk', 'vipinfo', 'rank'];
const NO_DIFFICULTY_VALUE = '__no_active_difficulties__';
const DIFFICULTY_ORDER = ['normal', 'hard', 'suicidal', 'hoe', 'extreme'];
let activeRelayMap = new Map();
let activeDifficulties = [];
const relayQueues = new Map();
const processingDifficulties = new Set();

function addDifficultyOption(commandBuilder) {
  return addDifficultyOptionWithRequired(commandBuilder, true);
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

const commandDefinitions = [
  addDifficultyOption(
    new SlashCommandBuilder()
      .setName('info')
      .setDescription('Send a server info request to the matching relay'),
  ),
  addDifficultyOption(
    new SlashCommandBuilder()
      .setName('perk')
      .setDescription('Send a perk request to the matching relay'),
  ).addStringOption((option) =>
    option
      .setName('nickname')
      .setDescription('Discord nickname or Steam nickname')
      .setRequired(true),
  ),
  new SlashCommandBuilder()
    .setName('vipinfo')
    .setDescription('Send a VIP info request to the first active relay'),
  addDifficultyOptionWithRequired(
    new SlashCommandBuilder()
      .setName('rank')
      .setDescription('Send a rank request to the matching relay'),
    false,
  ),
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

function buildRelayRequest(interaction) {
  const commandName = interaction.commandName;

  if (commandName === 'info') {
    const difficulty = interaction.options.getString('difficulty', true);

    if (!ensureValidDifficulty(difficulty)) {
      throw new Error('Selected difficulty is not active right now.');
    }

    return {
      difficulty,
      payload: '/dsrequest info',
    };
  }

  if (commandName === 'vipinfo') {
    const relay = getDefaultRelay();

    if (!relay) {
      throw new Error('No active difficulties are available right now.');
    }

    return {
      difficulty: relay.difficulty,
      payload: `/dsrequest vipinfo ${getMemberNickname(interaction)}`,
    };
  }

  if (commandName === 'perk') {
    const difficulty = interaction.options.getString('difficulty', true);

    if (!ensureValidDifficulty(difficulty)) {
      throw new Error('Selected difficulty is not active right now.');
    }

    const nickname = interaction.options.getString('nickname', true).trim();
    return {
      difficulty,
      payload: `/dsrequest perk ${nickname}`,
    };
  }

  const selectedDifficulty = interaction.options.getString('difficulty');

  if (selectedDifficulty) {
    if (!ensureValidDifficulty(selectedDifficulty)) {
      throw new Error('Selected difficulty is not active right now.');
    }

    return {
      difficulty: selectedDifficulty,
      payload: '/dsrequest rank',
    };
  }

  const relay = getDefaultRelay();

  if (!relay) {
    throw new Error('No active difficulties are available right now.');
  }

  return {
    difficulty: relay.difficulty,
    payload: `/dsrequest rank ${getMemberNickname(interaction)}`,
  };
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
        await job.interaction.channel.send(responsePayload);
        await job.interaction.editReply({
          content: `Sent to relay "${difficulty}" and posted the response.`,
        });
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

    const request = buildRelayRequest(interaction);
    await enqueueRelayRequest(interaction, request);
  } catch (error) {
    console.error(`Failed to process command: ${error.message || error}`);

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
