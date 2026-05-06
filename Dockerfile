FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Build the frontend
RUN npm run build

EXPOSE 3000

# Metadata for labels
LABEL org.opencontainers.image.source=https://github.com/sachinmane24/QuantumCore

# Start the server
CMD ["npm", "start"]
