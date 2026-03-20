try {
  require('dotenv').config();
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
}

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const HEARTBEAT_DIR = process.env.HEARTBEAT_DIR
  ? path.resolve(process.env.HEARTBEAT_DIR)
  : path.resolve(__dirname, '..', 'heartbeat');
const HEARTBEAT_TTL_MS = Number.parseInt(process.env.HEARTBEAT_TTL_MS || '60000', 10);
const HEARTBEAT_REFRESH_MS = 30000;

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
let activeDifficulties = [];

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
      .setDescription('Post a request to see server information'),
  ),
  addDifficultyOption(
    new SlashCommandBuilder()
      .setName('perk')
      .setDescription('Post a request to see your perks information'),
  ).addStringOption((option) =>
    option
      .setName('nickname')
      .setDescription('Discord nickname or Steam nickname')
      .setRequired(true),
  ),
  new SlashCommandBuilder()
    .setName('vipinfo')
    .setDescription('Post a request to see your VIP information'),
  addDifficultyOptionWithRequired(
    new SlashCommandBuilder()
      .setName('rank')
      .setDescription('Post a request to see rank information (about yourself or general)'),
    false,
  ),
];

function getMemberNickname(interaction) {
  if (interaction.member && 'displayName' in interaction.member) {
    return interaction.member.displayName;
  }

  return interaction.user.globalName || interaction.user.username;
}

function scanActiveDifficulties() {
  if (!fs.existsSync(HEARTBEAT_DIR)) {
    return [];
  }

  const now = Date.now();
  const difficulties = new Set();

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

      difficulties.add(heartbeat.difficulty.trim());
    } catch (error) {
      console.warn(`Skipping invalid heartbeat file: ${filePath}`, error.message);
    }
  }

  return [...difficulties].sort((left, right) => left.localeCompare(right));
}

function refreshActiveDifficulties() {
  activeDifficulties = scanActiveDifficulties();
}

function getActiveDifficulties() {
  return activeDifficulties;
}

function getDefaultDifficulty() {
  const activeDifficulties = getActiveDifficulties();
  return activeDifficulties[0] || null;
}

function ensureValidDifficulty(difficulty) {
  if (!difficulty || difficulty === NO_DIFFICULTY_VALUE) {
    return false;
  }

  return getActiveDifficulties().includes(difficulty);
}

function buildRequestText(interaction) {
  const commandName = interaction.commandName;

  if (commandName === 'info') {
    const difficulty = interaction.options.getString('difficulty', true);

    if (!ensureValidDifficulty(difficulty)) {
      throw new Error('Selected difficulty is not active right now.');
    }

    return `/dsrequest ${difficulty} info`;
  }

  if (commandName === 'vipinfo') {
    const difficulty = getDefaultDifficulty();

    if (!difficulty) {
      throw new Error('No active difficulties are available right now.');
    }

    return `/dsrequest ${difficulty} vipinfo ${getMemberNickname(interaction)}`;
  }

  if (commandName === 'perk') {
    const difficulty = interaction.options.getString('difficulty', true);

    if (!ensureValidDifficulty(difficulty)) {
      throw new Error('Selected difficulty is not active right now.');
    }

    const nickname = interaction.options.getString('nickname', true).trim();
    return `/dsrequest ${difficulty} perk ${nickname}`;
  }

  const selectedDifficulty = interaction.options.getString('difficulty');

  if (selectedDifficulty) {
    if (!ensureValidDifficulty(selectedDifficulty)) {
      throw new Error('Selected difficulty is not active right now.');
    }

    return `/dsrequest ${selectedDifficulty} rank`;
  }

  const difficulty = getDefaultDifficulty();

  if (!difficulty) {
    throw new Error('No active difficulties are available right now.');
  }

  return `/dsrequest ${difficulty} rank ${getMemberNickname(interaction)}`;
}

async function handleAutocomplete(interaction) {
  const focusedOption = interaction.options.getFocused(true);

  if (focusedOption.name !== 'difficulty') {
    await interaction.respond([]);
    return;
  }

  const search = String(focusedOption.value || '').toLowerCase();
  const activeDifficulties = getActiveDifficulties();

  if (activeDifficulties.length === 0) {
    await interaction.respond([
      {
        name: 'No active difficulties found',
        value: NO_DIFFICULTY_VALUE,
      },
    ]);
    return;
  }

  const choices = activeDifficulties
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
        console.error('Failed to handle autocomplete:', error);
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

    const content = buildRequestText(interaction);

    await interaction.channel.send(content);
    await interaction.editReply({
      content: `Sent: \`${content}\``,
    });
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
  refreshActiveDifficulties();
  setInterval(refreshActiveDifficulties, HEARTBEAT_REFRESH_MS);
  await registerCommands();
  await client.login(TOKEN);
})();
