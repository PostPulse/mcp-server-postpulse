# Build stage
FROM node:23-slim AS builder

WORKDIR /app

# Copy package files and install ALL dependencies (including dev)
COPY package*.json ./
RUN npm install

# Copy source and build
COPY . .
RUN npm run build

# Production stage
FROM node:23-slim

WORKDIR /app

# Copy package files and install only production dependencies
COPY package*.json ./
RUN npm install --production

# Copy compiled code from builder
COPY --from=builder /app/build ./build

# The server listens on 3000
EXPOSE 3000

# Start the server
CMD ["node", "build/index.js"]
