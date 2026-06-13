FROM node:20-alpine
WORKDIR /app
COPY package.json index.js ./
RUN mkdir -p /data
VOLUME ["/data"]
CMD ["node", "index.js"]
