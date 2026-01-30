FROM node:20-alpine

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy app source
COPY . .

# Cloud Run uses PORT env var
ENV PORT=8080

EXPOSE 8080

# Start the server
CMD ["npm", "start"]
