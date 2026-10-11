# forbiz-mcp — container for MCP introspection checks (Glama and similar).
# Starts the stdio server; tools/list works with no credential.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY index.js ./
ENV NODE_ENV=production
CMD ["node", "index.js"]
