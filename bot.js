process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit the process
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
  // Don't exit the process
});

const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const { 
  STATES,
  analyzeImage, 
  saveToStrapi, 
  initSession, 
  sendSummary,
  handlePhotoUpload,
  findUserByChatId,
  findUserByPhone,
  updateUserChatId,
  sendCommandOptions,
  askForPlantName,
  handleLocation
} = require('./helpers/botHelpers');

// At the top after requires
console.log('Application starting...');
console.log('Environment:', process.env.NODE_ENV);
console.log('Server Port:', 8080);

// Move isProd declaration to the top, after the initial console.logs
const isProd = process.env.NODE_ENV === 'production';
console.log('Running in', isProd ? 'production' : 'development', 'mode');

// Initialize Express first
const express = require('express');
const app = express();
const PORT = 8080;
const HOST = '0.0.0.0';

// Add JSON parsing middleware BEFORE routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Google AI
const genAI = config.genAI;

// Simple in-memory session store (consider using Redis for production)
const userSessions = new Map();

// In-memory storage (consider using Redis/DB for production)
const userPhoneNumbers = new Map();

// Add at the top level, after middleware setup
app.use((req, res, next) => {
  console.log('Incoming request:', {
    method: req.method,
    path: req.path,
    body: req.body,
    headers: req.headers
  });
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  console.log(`Health check received on port ${PORT}`);
  res.status(200).send('OK');
});

// Move bot initialization after isProd is defined
const bot = startBot();

// Start Express with more detailed logging
const server = app.listen(PORT, HOST, () => {
  console.log(`Server started and listening on http://${HOST}:${PORT}`);
  console.log(`Health check available at http://${HOST}:${PORT}/health`);
  console.log('Starting bot...');
}).on('error', (error) => {
  console.error(`Express Server Error on port ${PORT}:`, error);
});

// Add shutdown handling
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Add catch-all route LAST, after server is started
app.use((req, res) => {
  console.log('❌ 404 - Not Found:', {
    method: req.method,
    path: req.path,
    body: req.body
  });
  res.status(404).send('Not Found');
});

function startBot() {
  console.log('Bot starting...');
  const botConfig = isProd ? {} : { polling: true };
  const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, botConfig);
  console.log('Bot initialized with', isProd ? 'webhook' : 'polling');

  if (isProd) {
    console.log('Bot instance check:', {
      hasProcessUpdate: typeof bot.processUpdate === 'function',
      botToken: !!bot.token, // Will log true/false for token presence
    });
    
    // Define webhook path
    const webhookPath = `/${config.TELEGRAM_BOT_TOKEN}`;
    const webhookUrl = `https://steward-plant-bot.fly.dev${webhookPath}`;
    
    // Log all registered routes
    console.log('Current Express routes:');
    app._router.stack.forEach(r => {
      if (r.route && r.route.path) {
        console.log(r.route.path);
      }
    });

    // Add webhook route with explicit logging
    console.log('Registering webhook route:', webhookPath);
    app.post(webhookPath, (req, res) => {
      console.log('⚡️ Webhook hit:', {
        path: req.path,
        body: JSON.stringify(req.body, null, 2)
      });
      
      try {
        bot.processUpdate(req.body);
        console.log('✅ Update handled successfully');
        res.sendStatus(200);
      } catch (error) {
        console.error('❌ Error handling webhook:', error);
        res.sendStatus(500);
      }
    });

    // Delete and set webhook with better error handling
    (async () => {
      try {
        console.log('Deleting old webhook...');
        await bot.deleteWebHook();
        console.log('Old webhook deleted');
        
        console.log('Setting new webhook to:', webhookUrl);
        const result = await bot.setWebHook(webhookUrl);
        console.log('Webhook set result:', result);
        
        // Verify webhook
        const webhookInfo = await bot.getWebhookInfo();
        console.log('Webhook info:', webhookInfo);
      } catch (error) {
        console.error('Failed to setup webhook:', error);
      }
    })();
  }

  // Add error handler for the bot
  bot.on('error', (error) => {
    console.error('Bot error:', error);
  });

  bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
  });

  bot.onText(/\/start/, async (msg) => {
    console.log('Received /start command from:', msg.chat.id);
    const chatId = msg.chat.id;
    const session = initSession(chatId, userSessions, STATES);
    
    try {
      // Check if user exists in Strapi
      const existingUser = await findUserByChatId(chatId);
      
      if (existingUser) {
        console.log(`Found existing user for chatId: ${chatId}`);
        session.phoneNumber = existingUser.phoneNumber;
        session.userId = existingUser.id;
        session.username = existingUser.username;
        session.state = STATES.WAITING_FOR_PLANT_NAME;
        await askForPlantName(chatId, session, bot);
      } else {
        console.log(`No user found for chatId: ${chatId}, asking for phone`);
        await askForPhone(chatId);
      }
    } catch (error) {
      console.error('Error checking user:', error);
      await bot.sendMessage(chatId, 'An error occurred. Please try again later.');
    }
  });

  bot.onText(/\/newplanting/, async (msg) => {
    console.log('Received /newplanting command from:', msg.chat.id);
    const chatId = msg.chat.id;
    const session = initSession(chatId, userSessions, STATES);
    session.isNewPlanting = true;
    
    try {
      const existingUser = await findUserByChatId(chatId);
      
      if (existingUser) {
        console.log(`Found existing user for chatId: ${chatId}`);
        session.phoneNumber = existingUser.phoneNumber;
        session.userId = existingUser.id;
        session.username = existingUser.username;
        session.state = STATES.WAITING_FOR_PLANT_NAME;
        await askForPlantName(chatId, session, bot);
      } else {
        console.log(`No user found for chatId: ${chatId}, asking for phone`);
        await askForPhone(chatId);
      }
    } catch (error) {
      console.error('Error checking user:', error);
      await bot.sendMessage(chatId, error.message);
    }
  });

  bot.onText(/\/addplant/, async (msg) => {
    console.log('Received /addplant command from:', msg.chat.id);
    const chatId = msg.chat.id;
    const session = initSession(chatId, userSessions, STATES);
    session.isNewPlanting = false;
    
    try {
      const existingUser = await findUserByChatId(chatId);
      
      if (existingUser) {
        console.log(`Found existing user for chatId: ${chatId}`);
        session.phoneNumber = existingUser.phoneNumber;
        session.userId = existingUser.id;
        session.username = existingUser.username;
        session.state = STATES.WAITING_FOR_PLANT_NAME;
        await askForPlantName(chatId, session, bot);
      } else {
        console.log(`No user found for chatId: ${chatId}, asking for phone`);
        await askForPhone(chatId);
      }
    } catch (error) {
      console.error('Error checking user:', error);
      await bot.sendMessage(chatId, error.message);
    }
  });

  // Message handler
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const session = userSessions.get(chatId) || initSession(chatId, userSessions, STATES);

    try {
      // console.log(`Processing message in state: ${session.state}`);
      switch (session.state) {
        case STATES.IDLE:
          if (msg.contact && msg.contact.phone_number) {
            try {
              // Format phone number to ensure it has country code
              const phoneNumber = msg.contact.phone_number.startsWith('+') 
                ? msg.contact.phone_number 
                : `+${msg.contact.phone_number}`;
              
              // Look up user by phone number
              const existingUser = await findUserByPhone(phoneNumber);
              
              if (existingUser) {
                console.log(`Found existing user with phone: ${phoneNumber}`);
                
                // Update the user's chatId
                try {
                  await updateUserChatId(existingUser.id, chatId);
                  console.log(`Updated chatId for user: ${existingUser.id}`);
                } catch (updateError) {
                  console.error('Failed to update chatId:', updateError);
                  // Continue with the flow even if update fails
                }
                
                session.phoneNumber = phoneNumber;
                session.userId = existingUser.id;
                session.username = existingUser.username;
                session.state = STATES.WAITING_FOR_PLANT_NAME;
                await askForPlantName(chatId, session, bot);
              } else {
                console.log(`No user found with phone: ${phoneNumber}`);
                await bot.sendMessage(chatId, 'Sorry, I couldn\'t find your account. Please contact support.');
                session.state = STATES.IDLE;
              }
            } catch (error) {
              console.error('Error processing phone number:', error);
              await bot.sendMessage(chatId, 'An error occurred. Please try /start again.');
              session.state = STATES.IDLE;
            }
          }
          break;

        case STATES.WAITING_FOR_PLANT_NAME:
          if (msg.text && msg.text !== '/start' && msg.text !== '/cancel') {
            session.plantName = msg.text;
            session.state = STATES.WAITING_FOR_IMAGE;
            await askForImage(chatId);
          }
          break;

        case STATES.WAITING_FOR_IMAGE:
          if (msg.photo) {
            const { fileId, fileUrl } = await handlePhotoUpload(msg, session, bot, config);
            session.imageId = fileId;
            await analyzeImage(session, fileUrl);
            session.state = STATES.WAITING_FOR_LOCATION;
            await askForLocation(chatId);
          } else if (msg.text !== '/cancel') {
            await bot.sendMessage(chatId, 'Please send a photo of the plant.');
          }
          break;

        case STATES.WAITING_FOR_LOCATION:
          if (msg.location) {
            await handleLocation(msg, session);
            await sendSummary(bot, chatId, session);
          } else if (msg.text !== '/cancel') {
            await askForLocation(chatId);
          }
          break;
      }
    } catch (error) {
      console.error('Message Handler Error:', error);
      await bot.sendMessage(chatId, 'An error occurred. Please try again or use /cancel to restart.');
    }
  });

  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    
    switch (query.data) {
      case 'add_plant':
        initSession(chatId, userSessions, STATES);
        askForPhone(chatId);
        break;
      case 'view_map':
        // Handle map view
        break;
    }
    
    // Answer the callback query to remove the loading state
    await bot.answerCallbackQuery(query.id);
  });

  async function askForImage(chatId) {
    await bot.sendMessage(
      chatId,
      'Great! Now please send me a photo of the plant.'
    );
  }

  async function askForLocation(chatId) {
    const locationKeyboard = {
      reply_markup: {
        keyboard: [[{
          text: '📍 Share Location',
          request_location: true
        }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    };
    
    await bot.sendMessage(
      chatId,
      'Please share the location where this plant is growing.',
      locationKeyboard
    );
  }

  async function askForPhone(chatId) {
    const phoneKeyboard = {
      reply_markup: {
        keyboard: [[{
          text: '📱 Share Phone Number',
          request_contact: true
        }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    };
    await bot.sendMessage(
      chatId,
      'Please share your phone number to get started. Minimizing the keyboard will give you a share button',
      phoneKeyboard
    );
  }

  // Cancel command handler
  bot.onText(/\/cancel/, async (msg) => {
    const chatId = msg.chat.id;
    initSession(chatId, userSessions, STATES);
    await bot.sendMessage(chatId, 'Operation cancelled.');
    await sendCommandOptions(bot, chatId);
  });

  // Add error handler for the bot
  bot.on('error', (error) => {
    console.error('Bot error:', error);
  });

  bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
  });

  return bot;  // Return the bot instance
}
