FROM node:20

WORKDIR /app

COPY server.js ./server.js

EXPOSE 10000

CMD ["node", "server.js"]
