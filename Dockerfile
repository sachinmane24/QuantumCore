FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Build the frontend
ENV NODE_ENV=production
RUN npm run build

# Start the server
CMD ["npm", "start"]
