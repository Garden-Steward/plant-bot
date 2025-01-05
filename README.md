# Plant Bot 🌿

A Telegram bot for documenting and analyzing plants, part of the Garden Steward project.

## Features

- 📸 Plant photo documentation
- 🤖 AI-powered plant analysis using Google's Gemini
- 📍 Location tracking for plants
- 🗄️ Data storage in Strapi CMS

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure environment variables in `.env`:
   ```env
   # Telegram Bot Configuration
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token

   # Google AI Configuration
   GOOGLE_AI_API_KEY=your_google_ai_api_key

   # Strapi Configuration
   STRAPI_API_URL=your_strapi_url
   STRAPI_API_TOKEN=your_strapi_api_token
   ```

3. Start the bot:
   ```bash
   node bot.js
   ```

## Usage

1. Start a chat with the bot using `/start`
2. Follow the prompts to:
   - Enter plant name
   - Upload a photo
   - Share location
3. The bot will analyze the plant and save the information

## Development

- Built with Node.js
- Uses Telegram Bot API
- Integrates with Strapi CMS
- Powered by Google's Gemini AI

## License

ISC 