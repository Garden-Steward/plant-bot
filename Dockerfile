FROM node:20-slim

WORKDIR /app

# Add tini for proper signal handling
RUN apt-get update && apt-get install -y tini

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080

# Use tini as entrypoint
ENTRYPOINT ["/usr/bin/tini", "--"]

# Start with more verbose Node.js logging
CMD ["node", "--trace-warnings", "--unhandled-rejections=strict", "bot.js"]

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080 