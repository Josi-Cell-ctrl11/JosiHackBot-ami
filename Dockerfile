FROM node:20-alpine

# yt-dlp (zipapp Python) + ffmpeg (fusion bestvideo+bestaudio) pour le
# téléchargement natif YouTube / Instagram côté serveur.
RUN apk add --no-cache python3 ffmpeg ca-certificates \
    && ln -s /usr/bin/python3 /usr/local/bin/python

# Use an unprivileged user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Create app directory
WORKDIR /app

# Install dependencies based on package.json (no native addons required)
COPY package*.json ./
# Le postinstall applique le correctif de Baileys (mode fantôme) : son script
# doit exister avant `npm install`.
COPY scripts/patch-baileys.js ./scripts/patch-baileys.js
RUN npm install --omit=dev

# Bundle app source
COPY . .

# Change ownership of the app directory to the new user
RUN chown -R appuser:appgroup /app

USER appuser

# Run the bot
CMD ["node", "index.js"]
