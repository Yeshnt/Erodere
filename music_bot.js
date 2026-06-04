const {
  Client, GatewayIntentBits, Events,
  REST, Routes, SlashCommandBuilder, EmbedBuilder
} = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState, getVoiceConnection
} = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const ytSearch = require('yt-search');
const SpotifyWebApi = require('spotify-web-api-node');

const DISCORD_TOKEN     = process.env.DISCORD_TOKEN;
const CLIENT_ID         = process.env.CLIENT_ID;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_SECRET    = process.env.SPOTIFY_SECRET;

// ─── Spotify setup ────────────────────────────────────────────────────────────
const spotify = new SpotifyWebApi({
  clientId: SPOTIFY_CLIENT_ID,
  clientSecret: SPOTIFY_SECRET,
});

async function refreshSpotify() {
  const data = await spotify.clientCredentialsGrant();
  spotify.setAccessToken(data.body.access_token);
  setTimeout(refreshSpotify, (data.body.expires_in - 60) * 1000);
}

// ─── Queue system (per guild) ─────────────────────────────────────────────────
const queues = new Map();

function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, {
      tracks: [],
      player: null,
      connection: null,
      volume: 50,
      loop: false,
      shuffle: false,
      current: null,
    });
  }
  return queues.get(guildId);
}

// ─── Resolve Spotify track → YouTube search ───────────────────────────────────
async function resolveSpotify(url) {
  const trackId = url.match(/track\/([A-Za-z0-9]+)/)?.[1];
  const playlistId = url.match(/playlist\/([A-Za-z0-9]+)/)?.[1];

  if (trackId) {
    const data = await spotify.getTrack(trackId);
    const t = data.body;
    return [{ title: `${t.name} - ${t.artists[0].name}`, query: `${t.name} ${t.artists[0].name}` }];
  }

  if (playlistId) {
    const data = await spotify.getPlaylistTracks(playlistId, { limit: 50 });
    return data.body.items
      .filter(i => i.track)
      .map(i => ({
        title: `${i.track.name} - ${i.track.artists[0].name}`,
        query: `${i.track.name} ${i.track.artists[0].name}`
      }));
  }

  throw new Error('Invalid Spotify URL');
}

// ─── Resolve YouTube URL or search query → track info ────────────────────────
async function resolveYouTube(input) {
  const isUrl = input.startsWith('http');
  if (isUrl) {
    const info = await ytdl.getInfo(input);
    return [{ title: info.videoDetails.title, url: input }];
  }
  const result = await ytSearch(input);
  const video = result.videos[0];
  if (!video) throw new Error('No results found!');
  return [{ title: video.title, url: video.url }];
}

// ─── Play next track ──────────────────────────────────────────────────────────
async function playNext(guildId, channel) {
  const q = getQueue(guildId);
  if (!q.tracks.length) {
    q.current = null;
    return;
  }

  if (q.shuffle) {
    const idx = Math.floor(Math.random() * q.tracks.length);
    [q.tracks[0], q.tracks[idx]] = [q.tracks[idx], q.tracks[0]];
  }

  const track = q.tracks.shift();
  q.current = track;

  // Resolve YouTube URL if needed
  let url = track.url;
  if (!url) {
    const results = await resolveYouTube(track.query);
    url = results[0].url;
    track.url = url;
    track.title = results[0].title;
  }

  const stream = ytdl(url, {
    filter: 'audioonly',
    quality: 'highestaudio',
    highWaterMark: 1 << 25,
  });

  const resource = createAudioResource(stream, { inlineVolume: true });
  resource.volume.setVolume(q.volume / 100);
  q.player.play(resource);

  if (channel) {
    const embed = new EmbedBuilder()
      .setColor(0x1DB954)
      .setTitle('🎵 Now Playing')
      .setDescription(`**${track.title}**`)
      .setFooter({ text: `Volume: ${q.volume}% | Loop: ${q.loop ? 'ON' : 'OFF'} | Shuffle: ${q.shuffle ? 'ON' : 'OFF'}` });
    channel.send({ embeds: [embed] });
  }

  q.player.once(AudioPlayerStatus.Idle, () => {
    if (q.loop) q.tracks.unshift(track);
    playNext(guildId, channel);
  });
}

// ─── Join voice channel ───────────────────────────────────────────────────────
function joinVoice(member, guildId, adapterCreator) {
  const channelId = member.voice?.channel?.id;
  if (!channelId) throw new Error('You need to be in a voice channel!');

  const q = getQueue(guildId);
  if (!q.player) q.player = createAudioPlayer();

  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator,
  });

  connection.subscribe(q.player);
  q.connection = connection;
  return connection;
}

// ─── Commands ─────────────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('play').setDescription('Play a song or playlist')
    .addStringOption(o => o.setName('query').setDescription('YouTube URL, Spotify URL, or search term').setRequired(true)),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip current track'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop and clear queue'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the queue'),
  new SlashCommandBuilder().setName('volume').setDescription('Set volume (0-100)')
    .addIntegerOption(o => o.setName('level').setDescription('Volume level').setRequired(true).setMinValue(0).setMaxValue(100)),
  new SlashCommandBuilder().setName('loop').setDescription('Toggle loop for current track'),
  new SlashCommandBuilder().setName('shuffle').setDescription('Toggle shuffle mode'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show current track'),
  new SlashCommandBuilder().setName('remove').setDescription('Remove a track from queue')
    .addIntegerOption(o => o.setName('position').setDescription('Position in queue').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('clear').setDescription('Clear the queue'),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  console.log('Registering commands...');
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('Commands registered!');
}

// ─── Discord client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

client.once(Events.ClientReady, () => {
  console.log('🎵 Music bot online as ' + client.user.tag);
  client.user.setActivity('music 🎵', { type: 2 }); // "Listening to"
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId, member, channel } = interaction;
  const q = getQueue(guildId);

  await interaction.deferReply();

  try {
    // ── /play ──────────────────────────────────────────────────────────────────
    if (commandName === 'play') {
      const query = interaction.options.getString('query');
      const isSpotify = query.includes('spotify.com');

      let tracks = [];
      if (isSpotify) {
        const resolved = await resolveSpotify(query);
        tracks = resolved;
      } else {
        const resolved = await resolveYouTube(query);
        tracks = resolved;
      }

      joinVoice(member, guildId, interaction.guild.voiceAdapterCreator);

      q.tracks.push(...tracks);

      const embed = new EmbedBuilder()
        .setColor(0x1DB954)
        .setTitle(tracks.length > 1 ? '📋 Playlist Added' : '✅ Added to Queue')
        .setDescription(tracks.length > 1
          ? `Added **${tracks.length} tracks** to the queue`
          : `**${tracks[0].title}**`)
        .setFooter({ text: `Queue length: ${q.tracks.length}` });

      await interaction.editReply({ embeds: [embed] });

      if (!q.current) playNext(guildId, channel);
      return;
    }

    // ── /pause ─────────────────────────────────────────────────────────────────
    if (commandName === 'pause') {
      q.player?.pause();
      return interaction.editReply('⏸️ Paused!');
    }

    // ── /resume ────────────────────────────────────────────────────────────────
    if (commandName === 'resume') {
      q.player?.unpause();
      return interaction.editReply('▶️ Resumed!');
    }

    // ── /skip ──────────────────────────────────────────────────────────────────
    if (commandName === 'skip') {
      q.player?.stop();
      return interaction.editReply('⏭️ Skipped!');
    }

    // ── /stop ──────────────────────────────────────────────────────────────────
    if (commandName === 'stop') {
      q.tracks = [];
      q.current = null;
      q.player?.stop();
      q.connection?.destroy();
      queues.delete(guildId);
      return interaction.editReply('⏹️ Stopped and queue cleared!');
    }

    // ── /queue ─────────────────────────────────────────────────────────────────
    if (commandName === 'queue') {
      if (!q.current && !q.tracks.length) return interaction.editReply('📭 Queue is empty!');
      const list = q.tracks.slice(0, 15).map((t, i) => `**${i + 1}.** ${t.title}`).join('\n');
      const embed = new EmbedBuilder()
        .setColor(0x1DB954)
        .setTitle('📋 Queue')
        .setDescription(`**Now Playing:** ${q.current?.title || 'Nothing'}\n\n${list || 'Nothing up next'}`)
        .setFooter({ text: `${q.tracks.length} tracks in queue` });
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /volume ────────────────────────────────────────────────────────────────
    if (commandName === 'volume') {
      const level = interaction.options.getInteger('level');
      q.volume = level;
      return interaction.editReply(`🔊 Volume set to **${level}%**`);
    }

    // ── /loop ──────────────────────────────────────────────────────────────────
    if (commandName === 'loop') {
      q.loop = !q.loop;
      return interaction.editReply(`🔁 Loop is now **${q.loop ? 'ON' : 'OFF'}**`);
    }

    // ── /shuffle ───────────────────────────────────────────────────────────────
    if (commandName === 'shuffle') {
      q.shuffle = !q.shuffle;
      return interaction.editReply(`🔀 Shuffle is now **${q.shuffle ? 'ON' : 'OFF'}**`);
    }

    // ── /nowplaying ────────────────────────────────────────────────────────────
    if (commandName === 'nowplaying') {
      if (!q.current) return interaction.editReply('Nothing is playing right now!');
      const embed = new EmbedBuilder()
        .setColor(0x1DB954)
        .setTitle('🎵 Now Playing')
        .setDescription(`**${q.current.title}**`)
        .setFooter({ text: `Volume: ${q.volume}% | Loop: ${q.loop ? 'ON' : 'OFF'} | Shuffle: ${q.shuffle ? 'ON' : 'OFF'}` });
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /remove ────────────────────────────────────────────────────────────────
    if (commandName === 'remove') {
      const pos = interaction.options.getInteger('position') - 1;
      if (pos >= q.tracks.length) return interaction.editReply('Invalid position!');
      const removed = q.tracks.splice(pos, 1);
      return interaction.editReply(`🗑️ Removed **${removed[0].title}** from queue`);
    }

    // ── /clear ─────────────────────────────────────────────────────────────────
    if (commandName === 'clear') {
      q.tracks = [];
      return interaction.editReply('🗑️ Queue cleared!');
    }

  } catch (err) {
    console.error(err);
    return interaction.editReply('❌ Error: ' + err.message);
  }
});

(async () => {
  await refreshSpotify().catch(console.error);
  await registerCommands();
  await client.login(DISCORD_TOKEN);
})();
