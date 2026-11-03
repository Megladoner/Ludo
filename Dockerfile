FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY data/.gitkeep ./data/.gitkeep
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node","src/server/index.js"]
