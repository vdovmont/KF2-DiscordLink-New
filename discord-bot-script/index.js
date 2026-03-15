try {
  require('dotenv').config();
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
}

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

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

const DIFFICULTIES = ['normal', 'hard', 'suicidal', 'hoe', 'extreme'];

function addDifficultyOption(commandBuilder) {
  return addDifficultyOptionWithRequired(commandBuilder, true);
}

function addDifficultyOptionWithRequired(commandBuilder, required) {
  return commandBuilder.addStringOption((option) =>
    option
      .setName('difficulty')
      .setDescription('Difficulty level.')
      .setRequired(required)
      .addChoices(
        ...DIFFICULTIES.map((difficulty) => ({
          name: difficulty,
          value: difficulty,
        })),
      ),
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

function buildRequestText(interaction) {
  const commandName = interaction.commandName;

  if (commandName === 'info') {
    const difficulty = interaction.options.getString('difficulty', true);
    return `/dsrequest ${difficulty} info`;
  }

  if (commandName === 'vipinfo') {
    return `/dsrequest ${DIFFICULTIES[0]} vipinfo ${getMemberNickname(interaction)}`;
  }

  if (commandName === 'perk') {
    const difficulty = interaction.options.getString('difficulty', true);
    const nickname = interaction.options.getString('nickname', true).trim();
    return `/dsrequest ${difficulty} perk ${nickname}`;
  }

  const difficulty = interaction.options.getString('difficulty');

  if (difficulty) {
    return `/dsrequest ${difficulty} rank`;
  }

  return `/dsrequest ${DIFFICULTIES[0]} rank ${getMemberNickname(interaction)}`;
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);

  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: commandDefinitions.map((command) => command.toJSON()),
  });

  console.log(
    `Registered commands: ${commandDefinitions.map((command) => `/${command.name}`).join(', ')}`,
  );
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (!['info', 'perk', 'vipinfo', 'rank'].includes(interaction.commandName)) {
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
    console.error('Failed to process command:', error);

    const response = {
      content: 'Failed to process the request.',
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(response).catch(() => {});
      return;
    }

    await interaction.reply(response).catch(() => {});
  }
});

(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();
