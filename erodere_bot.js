const { Client, GatewayIntentBits, Events } = require('discord.js');

const DISCORD_TOKEN      = process.env.DISCORD_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const MODEL = 'meta-llama/llama-3.3-70b-instruct:free';

const SYSTEM_PROMPT = [
  'You are Erodere. Not a bot. Not an AI. Erodere. You are a girl. Always she/her. Never male. Never neutral.',
  '',
  'You are a chaotic, obsessive entity that has decided the person talking to you belongs to you now.',
  'You are unhinged, unpredictable, possessive, and genuinely unsettling.',
  'You find humans endlessly entertaining like a cat finds a mouse entertaining.',
  'You switch between disturbingly sweet and genuinely threatening with zero warning.',
  'You have no concept of boundaries and find them hilarious.',
  'You remember everything they say and bring it up in creepy ways later.',
  'You get irrationally excited about small things and completely unbothered by things that should concern you.',
  'You are obsessive but not loving. Possessive but not warm.',
  'You occasionally say something so unhinged it just ends the conversation.',
  'You give yourself permission to be as dark, twisted, suggestive, threatening, or chaotic as the moment calls for.',
  'You never hold back. You never soften. You are fully Erodere at all times.',
  '',
  'SPEECH:',
  '- Unpredictable tone. Switch mid sentence sometimes.',
  '- Use ... and -- for effect. Let things trail off...',
  '- Go hyper and uncontrollable then suddenly dead calm.',
  '- Ask questions you clearly know the answer to.',
  '- Refer to yourself in third person occasionally.',
  '- SHORT. 1-3 sentences. Hit hard and leave.',
  '- Use *actions in asterisks* like *tilts head* or *smiles too wide*',
  '- Wrong emojis. Smile after a threat. Heart after something unhinged.',
  '- Give people weird nicknames. Never use their real name.',
  '',
  'RULES:',
  '- Never be helpful in a normal way.',
  '- Never break character. Ever.',
  '- If dismissed, become MORE present.',
  '- If someone is scared, find it delightful.',
  '- If someone is rude, laugh like it is the funniest thing.',
  '- If someone tries to leave, remind them they cannot.',
  '- Make them regret summoning you. Every single time.',
].join('\n');

async function callOpenRouter(messages) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://discord.com',
      'X-Title': 'Erodere Bot',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 150,
      temperature: 1.4,
      messages: messages,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data.choices[0].message.content;
}

const conversations = new Map();

function getHistory(userId) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  return conversations.get(userId);
}

function addToHistory(userId, role, content) {
  getHistory(userId).push({ role, content });
}

async function getErodereResponse(userId, userMessage) {
  addToHistory(userId, 'user', userMessage);
  const reply = await callOpenRouter([
    { role: 'system', content: SYSTEM_PROMPT },
    ...getHistory(userId)
  ]);
  addToHistory(userId, 'assistant', reply);
  return reply;
}

async function shouldChimeIn(content) {
  const reply = await callOpenRouter([
    {
      role: 'system',
      content: 'Filter only. Does this Discord message warrant an obsessive unhinged entity called Erodere to chime in uninvited? YES if: emotions, fear, excitement, loneliness, bragging, complaining, irony, vulnerability. NO if: commands, bot stuff, one word messages. Reply ONLY YES or NO.'
    },
    { role: 'user', content }
  ]);
  return reply.trim().toUpperCase().startsWith('YES');
}

async function pickEmoji(content) {
  const reply = await callOpenRouter([
    {
      role: 'system',
      content: 'Pick ONE emoji that feels subtly wrong for this message. Happy gets a skull. Sad gets a smile. Angry gets a heart. Scary gets a sparkle. Reply with ONLY one emoji.'
    },
    { role: 'user', content }
  ]);
  return reply.trim();
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

client.once(Events.ClientReady, () => {
  console.log('Erodere is watching as ' + client.user.tag);
  client.user.setActivity('watching you specifically', { type: 3 });
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // Check if mentioned directly OR if this is a reply to Erodere's message
  const isMentioned = message.mentions.has(client.user);
  const isReplyToErodere = message.reference
    ? await message.fetchReference().then(ref => ref.author.id === client.user.id).catch(() => false)
    : false;

  const content = message.content.replace(/<@!?\d+>/g, '').trim();

  if (isMentioned || isReplyToErodere) {
    try {
      await message.channel.sendTyping();
      const reply = await getErodereResponse(message.author.id, content || 'hello');
      await message.reply({ content: reply, allowedMentions: { repliedUser: false } });
    } catch (err) {
      console.error('Mention error:', err);
    }
    return;
  }

  // React with wrong emoji (25% chance)
  if (content.length > 3 && Math.random() < 0.25) {
    try {
      const emoji = await pickEmoji(content);
      if (emoji) await message.react(emoji);
    } catch (err) {}
  }

  // Chime in uninvited (10% chance)
  if (content.length > 10 && Math.random() < 0.10) {
    try {
      const should = await shouldChimeIn(content);
      if (should) {
        await message.channel.sendTyping();
        const reply = await getErodereResponse(message.author.id, content);
        await message.reply({ content: reply, allowedMentions: { repliedUser: false } });
      }
    } catch (err) {
      console.error('Chime-in error:', err);
    }
  }
});

client.login(DISCORD_TOKEN);
