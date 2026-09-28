#!/bin/bash
# =======================================================
# Deployment Script for Linux Server (ai.jecrcuniversity.edu.in)
# =======================================================

echo "--- Deploying DirectorBot on Linux Server ---"

# 1. Copy Linux environment file if .env does not exist
if [ ! -f .env ]; then
    echo "Creating .env from .env.linux..."
    cp .env.linux .env
fi

# 2. Install dependencies
echo "Installing Node.js dependencies..."
npm install --production

# 3. Create storage directories if needed
mkdir -p storage/auth_director
mkdir -p storage/auth_bot
mkdir -p storage/briefings

# 4. Start or restart with PM2
if command -v pm2 &> /dev/null; then
    echo "Starting application with PM2 process manager..."
    pm2 delete directorbot 2>/dev/null || true
    pm2 start server.js --name "directorbot"
    pm2 save
    echo "DirectorBot successfully started with PM2!"
    pm2 status directorbot
else
    echo "PM2 not found. Starting with standard node server.js..."
    echo "Tip: Run 'sudo npm install -g pm2' to keep it running 24/7."
    node server.js
fi
